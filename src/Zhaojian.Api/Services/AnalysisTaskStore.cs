using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Zhaojian.Api.Contracts;
using Zhaojian.Api.Data;
using Zhaojian.Api.Infrastructure;

namespace Zhaojian.Api.Services;

public sealed record BeginAnalysisResult(AnalysisTaskRecord Task, ReferenceImageRecord Image, AnalysisResponse? ExistingResponse, bool ShouldProcess);

public interface IAnalysisTaskStore
{
    Task<BeginAnalysisResult> BeginAsync(
        string userId,
        string idempotencyKey,
        string fingerprint,
        SceneRequest request,
        ValidatedImage image,
        IReadOnlyList<SkillVersionSnapshot> skillVersions,
        ResolvedGearContext gear,
        CancellationToken cancellationToken);
    Task CompleteAsync(AnalysisTaskRecord task, AnalysisResponse response, ModelBilling billing, CancellationToken cancellationToken);
    Task FailAsync(AnalysisTaskRecord task, string errorCode, CancellationToken cancellationToken);
    Task CancelAsync(AnalysisTaskRecord task, string errorCode, CancellationToken cancellationToken);
    Task SetStatusAsync(AnalysisTaskRecord task, string status, CancellationToken cancellationToken);
    Task<AnalysisTaskRecord?> ClaimQueuedAsync(string taskId, CancellationToken cancellationToken);
    Task<IReadOnlyList<AnalysisTaskSummaryResponse>> ListAsync(string userId, string? imageId, int limit, CancellationToken cancellationToken);
    Task<AnalysisTaskRecord?> FindTaskAsync(string taskId, CancellationToken cancellationToken);
    Task<ReferenceImageRecord?> FindImageAsync(string imageId, CancellationToken cancellationToken);
    AnalysisTaskDetailResponse ToDetail(AnalysisTaskRecord task);
    Task DeleteAsync(AnalysisTaskRecord task, CancellationToken cancellationToken);
}

public sealed class EfAnalysisTaskStore(
    ZhaojianDbContext database,
    PersonalizationService personalization) : IAnalysisTaskStore
{
    public async Task<BeginAnalysisResult> BeginAsync(
        string userId,
        string idempotencyKey,
        string fingerprint,
        SceneRequest request,
        ValidatedImage image,
        IReadOnlyList<SkillVersionSnapshot> skillVersions,
        ResolvedGearContext gear,
        CancellationToken cancellationToken)
    {
        var existingTask = await database.AnalysisTasks
            .Include(value => value.ReferenceImage)
            .SingleOrDefaultAsync(value => value.UserId == userId && value.IdempotencyKey == idempotencyKey, cancellationToken);
        if (existingTask is not null)
        {
            if (!string.Equals(existingTask.Fingerprint, fingerprint, StringComparison.Ordinal))
            {
                throw new ApiException(StatusCodes.Status409Conflict, "IDEMPOTENCY_CONFLICT", "同一幂等键不能用于不同分析内容。");
            }
            if (existingTask.ResultJson is not null)
            {
                var response = JsonSerializer.Deserialize<AnalysisResponse>(existingTask.ResultJson, SceneJson.Provider)
                    ?? throw new ApiException(StatusCodes.Status500InternalServerError, "STORED_RESULT_INVALID", "历史结果暂时无法读取。");
                return new BeginAnalysisResult(existingTask, existingTask.ReferenceImage!, response, false);
            }
            if (existingTask.Status is AnalysisTaskStatuses.Queued or AnalysisTaskStatuses.Understanding or AnalysisTaskStatuses.Generating
                && existingTask.CreatedAt > DateTimeOffset.UtcNow.AddMinutes(-10))
            {
                return new BeginAnalysisResult(existingTask, existingTask.ReferenceImage!, null, false);
            }
            existingTask.Status = AnalysisTaskStatuses.Queued;
            existingTask.ErrorCode = null;
            existingTask.CreatedAt = DateTimeOffset.UtcNow;
            existingTask.CreatedAtUnixMs = existingTask.CreatedAt.ToUnixTimeMilliseconds();
            existingTask.CompletedAt = null;
            existingTask.CompletedAtUnixMs = null;
            existingTask.SkillSnapshotsJson = JsonSerializer.Serialize(skillVersions, SceneJson.Provider);
            existingTask.GearSnapshotJson ??= JsonSerializer.Serialize(gear, SceneJson.Provider);
            await database.SaveChangesAsync(cancellationToken);
            return new BeginAnalysisResult(existingTask, existingTask.ReferenceImage!, null, true);
        }

        var imageHash = Convert.ToHexString(SHA256.HashData(image.Bytes));
        var storedImage = await database.ReferenceImages.SingleOrDefaultAsync(
            value => value.UserId == userId && value.Sha256 == imageHash,
            cancellationToken);
        if (storedImage is null)
        {
            storedImage = new ReferenceImageRecord
            {
                Id = $"image_{Guid.NewGuid():N}",
                UserId = userId,
                Sha256 = imageHash,
                ContentType = image.MimeType,
                Content = image.Bytes,
                Width = image.Width,
                Height = image.Height,
                ByteLength = image.Bytes.Length,
                CreatedAt = DateTimeOffset.UtcNow
            };
            database.ReferenceImages.Add(storedImage);
            try
            {
                await database.SaveChangesAsync(cancellationToken);
            }
            catch (DbUpdateException)
            {
                database.Entry(storedImage).State = EntityState.Detached;
                storedImage = await database.ReferenceImages.SingleOrDefaultAsync(
                    value => value.UserId == userId && value.Sha256 == imageHash,
                    cancellationToken);
                if (storedImage is null) throw;
            }
        }
        else if (storedImage.Content is null)
        {
            storedImage.Content = image.Bytes;
            storedImage.ContentType = image.MimeType;
            storedImage.Width = image.Width;
            storedImage.Height = image.Height;
            storedImage.ByteLength = image.Bytes.Length;
            storedImage.PurgedAt = null;
            await database.SaveChangesAsync(cancellationToken);
        }

        var task = new AnalysisTaskRecord
        {
            Id = $"scene_{Guid.NewGuid():N}",
            UserId = userId,
            ReferenceImageId = storedImage.Id,
            IdempotencyKey = idempotencyKey,
            Fingerprint = fingerprint,
            Status = AnalysisTaskStatuses.Queued,
            RequestJson = JsonSerializer.Serialize(request, SceneJson.Request),
            SkillSnapshotsJson = JsonSerializer.Serialize(skillVersions, SceneJson.Provider),
            GearSnapshotJson = JsonSerializer.Serialize(gear, SceneJson.Provider),
            CreatedAt = DateTimeOffset.UtcNow,
            ReferenceImage = storedImage
        };
        task.CreatedAtUnixMs = task.CreatedAt.ToUnixTimeMilliseconds();
        database.AnalysisTasks.Add(task);
        try
        {
            await database.SaveChangesAsync(cancellationToken);
        }
        catch (DbUpdateException)
        {
            database.ChangeTracker.Clear();
            var concurrentTask = await database.AnalysisTasks
                .Include(value => value.ReferenceImage)
                .SingleOrDefaultAsync(value => value.UserId == userId && value.IdempotencyKey == idempotencyKey, cancellationToken);
            if (concurrentTask is null) throw;
            return await ResolveExistingAsync(concurrentTask, fingerprint, cancellationToken);
        }
        return new BeginAnalysisResult(task, storedImage, null, true);
    }

    public async Task CompleteAsync(AnalysisTaskRecord task, AnalysisResponse response, ModelBilling billing, CancellationToken cancellationToken)
    {
        await database.Entry(task).ReloadAsync(CancellationToken.None);
        if (task.Status == AnalysisTaskStatuses.Canceled) return;
        task.Status = response.Status == "needs_input" ? AnalysisTaskStatuses.NeedsInput : AnalysisTaskStatuses.Completed;
        task.ResultJson = JsonSerializer.Serialize(response, SceneJson.Provider);
        task.Provider = response.Provider.Name;
        task.Model = response.Provider.Model;
        task.PromptTokens = response.Provider.Usage.PromptTokens;
        task.CompletionTokens = response.Provider.Usage.CompletionTokens;
        task.ProviderCalls = response.Provider.Usage.Calls;
        task.EstimatedCostCny = response.Provider.Usage.EstimatedCostCny;
        task.PricingVersion = billing.PricingVersion;
        task.ChargeDisposition = billing.ChargeDisposition;
        task.DurationMs = response.Provider.Timing.TotalMs;
        task.UnderstandingMs = response.Provider.Timing.UnderstandingMs;
        task.DirectionMs = response.Provider.Timing.DirectionMs;
        task.UnderstandingCacheHit = response.Provider.Timing.UnderstandingCacheHit;
        task.CompletedAt = DateTimeOffset.UtcNow;
        task.CompletedAtUnixMs = task.CompletedAt.Value.ToUnixTimeMilliseconds();
        task.ErrorCode = null;
        await database.SaveChangesAsync(cancellationToken);
    }

    public async Task FailAsync(AnalysisTaskRecord task, string errorCode, CancellationToken cancellationToken)
    {
        await database.Entry(task).ReloadAsync(CancellationToken.None);
        if (task.Status == AnalysisTaskStatuses.Canceled) return;
        task.Status = AnalysisTaskStatuses.Failed;
        task.ErrorCode = errorCode;
        task.ChargeDisposition = "not_charged";
        task.CompletedAt = DateTimeOffset.UtcNow;
        task.CompletedAtUnixMs = task.CompletedAt.Value.ToUnixTimeMilliseconds();
        try
        {
            await database.SaveChangesAsync(cancellationToken);
        }
        catch (OperationCanceledException)
        {
            await database.SaveChangesAsync(CancellationToken.None);
        }
    }

    public async Task CancelAsync(AnalysisTaskRecord task, string errorCode, CancellationToken cancellationToken)
    {
        await database.Entry(task).ReloadAsync(CancellationToken.None);
        if (task.Status is AnalysisTaskStatuses.Completed or AnalysisTaskStatuses.NeedsInput or AnalysisTaskStatuses.Failed or AnalysisTaskStatuses.Canceled) return;
        task.Status = AnalysisTaskStatuses.Canceled;
        task.ErrorCode = errorCode;
        task.ChargeDisposition = "not_charged";
        task.CompletedAt = DateTimeOffset.UtcNow;
        task.CompletedAtUnixMs = task.CompletedAt.Value.ToUnixTimeMilliseconds();
        await database.SaveChangesAsync(cancellationToken);
    }

    public async Task SetStatusAsync(AnalysisTaskRecord task, string status, CancellationToken cancellationToken)
    {
        task.Status = status;
        await database.SaveChangesAsync(cancellationToken);
    }

    public async Task<AnalysisTaskRecord?> ClaimQueuedAsync(string taskId, CancellationToken cancellationToken)
    {
        var claimed = await database.AnalysisTasks
            .Where(value => value.Id == taskId && value.Status == AnalysisTaskStatuses.Queued)
            .ExecuteUpdateAsync(update => update.SetProperty(value => value.Status, AnalysisTaskStatuses.Understanding), cancellationToken);
        if (claimed != 1) return null;
        return await database.AnalysisTasks
            .Include(value => value.ReferenceImage)
            .SingleAsync(value => value.Id == taskId, cancellationToken);
    }

    public async Task<IReadOnlyList<AnalysisTaskSummaryResponse>> ListAsync(string userId, string? imageId, int limit, CancellationToken cancellationToken)
    {
        var query = database.AnalysisTasks.AsNoTracking().Include(value => value.ReferenceImage).Where(value => value.UserId == userId);
        if (!string.IsNullOrWhiteSpace(imageId)) query = query.Where(value => value.ReferenceImageId == imageId);
        var records = await query.OrderByDescending(value => value.CreatedAtUnixMs).Take(Math.Clamp(limit, 1, 50)).ToListAsync(cancellationToken);
        return records.Select(ToSummary).ToArray();
    }

    public Task<AnalysisTaskRecord?> FindTaskAsync(string taskId, CancellationToken cancellationToken) =>
        database.AnalysisTasks
            .Include(value => value.ReferenceImage)
            .Include(value => value.CreativeIntents)
            .SingleOrDefaultAsync(value => value.Id == taskId, cancellationToken);

    public Task<ReferenceImageRecord?> FindImageAsync(string imageId, CancellationToken cancellationToken) =>
        database.ReferenceImages.SingleOrDefaultAsync(value => value.Id == imageId, cancellationToken);

    public AnalysisTaskDetailResponse ToDetail(AnalysisTaskRecord task)
    {
        using var request = JsonDocument.Parse(task.RequestJson);
        JsonElement? result = null;
        if (task.ResultJson is not null)
        {
            using var resultDocument = JsonDocument.Parse(task.ResultJson);
            result = resultDocument.RootElement.Clone();
        }
        return new AnalysisTaskDetailResponse(
            ToSummary(task),
            request.RootElement.Clone(),
            result,
            task.ErrorCode,
            task.CreativeIntents
                .OrderByDescending(value => value.UpdatedAt)
                .Select(ParseCreativeIntent)
                .ToArray());
    }

    public async Task DeleteAsync(AnalysisTaskRecord task, CancellationToken cancellationToken)
    {
        var imageId = task.ReferenceImageId;
        var affectedStrategies = await database.FeedbackRecords.AsNoTracking()
            .Where(value => value.AnalysisTaskId == task.Id && value.VisualStrategy != null)
            .Select(value => value.VisualStrategy!)
            .Distinct()
            .ToListAsync(cancellationToken);
        database.AnalysisTasks.Remove(task);
        await database.SaveChangesAsync(cancellationToken);
        await personalization.RebuildStrategiesAsync(task.UserId, affectedStrategies, cancellationToken);
        if (!await database.AnalysisTasks.AnyAsync(value => value.ReferenceImageId == imageId, cancellationToken))
        {
            var image = await database.ReferenceImages.SingleOrDefaultAsync(value => value.Id == imageId, cancellationToken);
            if (image is not null)
            {
                database.ReferenceImages.Remove(image);
                await database.SaveChangesAsync(cancellationToken);
            }
        }
    }

    private static AnalysisTaskSummaryResponse ToSummary(AnalysisTaskRecord task)
    {
        var request = JsonSerializer.Deserialize<SceneRequest>(task.RequestJson, SceneJson.StoredRequest);
        var directionCount = 0;
        if (task.ResultJson is not null)
        {
            try
            {
                using var result = JsonDocument.Parse(task.ResultJson);
                if (result.RootElement.TryGetProperty("analysis", out var analysis)
                    && analysis.TryGetProperty("interpretations", out var interpretations)
                    && interpretations.ValueKind == JsonValueKind.Array) directionCount = interpretations.GetArrayLength();
            }
            catch (JsonException) { }
        }
        var intent = request?.Intent?.Trim();
        if (string.IsNullOrWhiteSpace(intent)) intent = request?.AttentionOption?.Trim();
        if (string.IsNullOrWhiteSpace(intent)) intent = "未填写吸引点";
        var image = task.ReferenceImage ?? throw new InvalidOperationException("任务缺少参考图。");
        return new AnalysisTaskSummaryResponse(
            task.Id,
            task.ReferenceImageId,
            task.Status,
            intent,
            directionCount,
            task.Provider,
            task.Model,
            task.PromptTokens,
            task.CompletionTokens,
            task.ProviderCalls,
            task.EstimatedCostCny,
            task.PricingVersion,
            task.ChargeDisposition ?? (task.Provider == "mock" ? "not_billable" : task.Status is AnalysisTaskStatuses.Completed or AnalysisTaskStatuses.NeedsInput ? "unpriced" : "not_charged"),
            task.DurationMs,
            image.Width,
            image.Height,
            image.ByteLength,
            image.Content is not null,
            task.CreatedAt,
            task.CompletedAt,
            ParseSkillVersions(task.SkillSnapshotsJson),
            $"/api/v1/reference-images/{image.Id}");
    }

    private static IReadOnlyList<SkillVersionSnapshot> ParseSkillVersions(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return [];
        try
        {
            return JsonSerializer.Deserialize<List<SkillVersionSnapshot>>(json, SceneJson.Provider) ?? [];
        }
        catch (JsonException)
        {
            return [];
        }
    }

    private static JsonElement ParseCreativeIntent(CreativeIntentRecord value)
    {
        using var document = JsonDocument.Parse(value.PayloadJson);
        return document.RootElement.Clone();
    }

    private async Task<BeginAnalysisResult> ResolveExistingAsync(AnalysisTaskRecord task, string fingerprint, CancellationToken cancellationToken)
    {
        if (!string.Equals(task.Fingerprint, fingerprint, StringComparison.Ordinal))
        {
            throw new ApiException(StatusCodes.Status409Conflict, "IDEMPOTENCY_CONFLICT", "同一幂等键不能用于不同分析内容。");
        }
        if (task.ResultJson is not null)
        {
            var response = JsonSerializer.Deserialize<AnalysisResponse>(task.ResultJson, SceneJson.Provider)
                ?? throw new ApiException(StatusCodes.Status500InternalServerError, "STORED_RESULT_INVALID", "历史结果暂时无法读取。");
            return new BeginAnalysisResult(task, task.ReferenceImage!, response, false);
        }
        if (task.Status is AnalysisTaskStatuses.Queued or AnalysisTaskStatuses.Understanding or AnalysisTaskStatuses.Generating
            && task.CreatedAt > DateTimeOffset.UtcNow.AddMinutes(-10))
        {
            return new BeginAnalysisResult(task, task.ReferenceImage!, null, false);
        }
        task.Status = AnalysisTaskStatuses.Queued;
        task.ErrorCode = null;
        task.CreatedAt = DateTimeOffset.UtcNow;
        task.CreatedAtUnixMs = task.CreatedAt.ToUnixTimeMilliseconds();
        task.CompletedAt = null;
        task.CompletedAtUnixMs = null;
        await database.SaveChangesAsync(cancellationToken);
        return new BeginAnalysisResult(task, task.ReferenceImage!, null, true);
    }
}
