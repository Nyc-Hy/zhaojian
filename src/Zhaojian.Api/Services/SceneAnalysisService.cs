using System.Security.Cryptography;
using System.Text.Json;
using Zhaojian.Api.Contracts;
using Zhaojian.Api.Data;
using Zhaojian.Api.Infrastructure;
using Zhaojian.Api.Providers;
using Zhaojian.Api.Skills;

namespace Zhaojian.Api.Services;

public sealed class SceneAnalysisService(
    IVisionProvider provider,
    AnalysisConcurrencyGate concurrencyGate,
    IAnalysisQuotaService quotaService,
    IAnalysisTaskStore taskStore,
    IUsageRecorder usageRecorder,
    IModelBillingService billingService,
    IBeforeVisionHook beforeVision,
    IAnalysisTaskQueue queue,
    AnalysisTaskCancellation taskCancellation,
    ISkillExecutionPlanner skillExecutionPlanner,
    ILogger<SceneAnalysisService> logger)
{
    public ProviderStatusResponse Status => provider.Status;

    public async Task<AnalysisAcceptedResponse> EnqueueAsync(string userId, string idempotencyKey, SceneRequest request, ValidatedImage image, CancellationToken cancellationToken)
    {
        var gear = await beforeVision.PrepareAsync(userId, request, image, cancellationToken);
        var skillPlan = skillExecutionPlanner.CreateSceneAnalysisPlan();
        var prepared = await taskStore.BeginAsync(
            userId,
            idempotencyKey,
            Fingerprint(request, image.Bytes),
            request,
            image,
            skillPlan.Snapshots,
            gear,
            cancellationToken);
        if (prepared.ShouldProcess) await queue.EnqueueAsync(prepared.Task.Id, cancellationToken);
        return new AnalysisAcceptedResponse(prepared.Task.Id, prepared.Task.Status, prepared.Image.Id, prepared.Task.CreatedAt);
    }

    public async Task ProcessAsync(string taskId, CancellationToken cancellationToken)
    {
        var task = await taskStore.ClaimQueuedAsync(taskId, cancellationToken);
        if (task?.ReferenceImage is null) return;
        var request = JsonSerializer.Deserialize<SceneRequest>(task.RequestJson, SceneJson.Request)
            ?? throw new InvalidOperationException("后台任务请求无法读取。");
        var storedImage = task.ReferenceImage;
        if (storedImage.Content is null) throw new InvalidOperationException("后台任务的分析图已经过期。");
        var image = new ValidatedImage(storedImage.Content, storedImage.Width, storedImage.Height, storedImage.ContentType);

        try
        {
            var skillSnapshots = ParseSkillSnapshots(task.SkillSnapshotsJson);
            var skillPlan = skillExecutionPlanner.RestoreSceneAnalysisPlan(skillSnapshots);
            var gear = await RestoreGearAsync(task, request, image, cancellationToken);
            var quota = await quotaService.TryReserveAsync(task.UserId, cancellationToken)
                ?? throw new ApiException(429, "DAILY_QUOTA_EXCEEDED", "今天的分析次数已用完，请明天再试。");
            await using (quota)
            {
                await using var lease = await concurrencyGate.TryEnterAsync(cancellationToken)
                    ?? throw new ApiException(429, "TOO_MANY_ANALYSES", "当前正在进行的分析较多，请稍后再试。");
                var result = await provider.AnalyzeAsync(new VisionInput(task.Id, request, image, gear, skillPlan,
                    (status, token) => taskStore.SetStatusAsync(task, status, token)), cancellationToken);
                var status = result.Analysis.Outcome switch
                {
                    "clarification" => AnalysisTaskStatuses.NeedsInput,
                    _ => AnalysisTaskStatuses.Completed
                };
                var response = new AnalysisResponse(
                    task.Id, status, result.Analysis,
                    new AnalysisProviderResponse(result.Provider, result.Model, result.Provider == "mock" ? "mock" : "live", result.Degraded,
                        new AnalysisTimingResponse(result.DurationMs, result.Timing.UnderstandingMs, result.Timing.DirectionMs, result.Timing.UnderstandingCacheHit), result.Usage),
                    storedImage.Id, task.CreatedAt);
                quota.Commit();
                usageRecorder.Record(new UsageRecord(task.Id, task.UserId, result.Provider, result.Model, result.Usage, result.DurationMs,
                    result.Timing.UnderstandingCacheHit, result.Analysis.Outcome, DateTimeOffset.UtcNow));
                await taskStore.CompleteAsync(task, response, billingService.Describe(result.Provider, result.Usage), cancellationToken);
                logger.LogInformation("后台场景分析结束 {TaskId} {Provider}/{Model} {Outcome} {DirectionCount} 个方向，耗时 {DurationMs}ms",
                    task.Id, result.Provider, result.Model, result.Analysis.Outcome, result.Analysis.Interpretations.Count, result.DurationMs);
            }
        }
        catch (Exception error)
        {
            var errorCode = error is ApiException api ? api.Code : error is OperationCanceledException
                ? taskCancellation.WasRequested(task.Id) ? "TASK_CANCELLED" : "TASK_TIMEOUT"
                : "INTERNAL_ERROR";
            try
            {
                if (errorCode == "TASK_CANCELLED") await taskStore.CancelAsync(task, errorCode, CancellationToken.None);
                else await taskStore.FailAsync(task, errorCode, CancellationToken.None);
            }
            catch (Exception persistenceError) { logger.LogError(persistenceError, "无法记录失败分析任务 {TaskId}", task.Id); }
            logger.LogError(error, "后台场景分析失败 {TaskId} {ErrorCode}", task.Id, errorCode);
        }
    }

    private static string Fingerprint(SceneRequest request, byte[] image)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        hash.AppendData(JsonSerializer.SerializeToUtf8Bytes(request, SceneJson.Request));
        hash.AppendData(image);
        return Convert.ToHexString(hash.GetHashAndReset());
    }

    private static IReadOnlyList<SkillVersionSnapshot> ParseSkillSnapshots(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return [];
        try
        {
            return JsonSerializer.Deserialize<List<SkillVersionSnapshot>>(json, SceneJson.Provider) ?? [];
        }
        catch (JsonException)
        {
            throw new ApiException(
                StatusCodes.Status503ServiceUnavailable,
                "SKILL_SNAPSHOT_INVALID",
                "分析任务的 Skill 快照无法读取，请重新提交分析。");
        }
    }

    private async Task<ResolvedGearContext> RestoreGearAsync(
        AnalysisTaskRecord task,
        SceneRequest request,
        ValidatedImage image,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(task.GearSnapshotJson))
        {
            return await beforeVision.PrepareAsync(task.UserId, request, image, cancellationToken);
        }
        try
        {
            return JsonSerializer.Deserialize<ResolvedGearContext>(task.GearSnapshotJson, SceneJson.Provider)
                ?? throw new JsonException("摄影包快照为空");
        }
        catch (JsonException)
        {
            throw new ApiException(
                StatusCodes.Status503ServiceUnavailable,
                "GEAR_SNAPSHOT_INVALID",
                "分析任务的摄影包快照无法读取，请重新提交分析。");
        }
    }
}
