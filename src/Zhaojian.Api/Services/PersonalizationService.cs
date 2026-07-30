using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Zhaojian.Api.Contracts;
using Zhaojian.Api.Data;
using Zhaojian.Api.Infrastructure;

namespace Zhaojian.Api.Services;

public sealed class PersonalizationService(ZhaojianDbContext database, FeedbackSyncGate feedbackSyncGate)
{
    private const int MaxFeedbackRecordsPerUser = 5000;
    private static readonly HashSet<string> AnalysisValues = new(StringComparer.Ordinal)
    {
        "helpful", "too_generic", "recognition_wrong"
    };
    private static readonly HashSet<string> DirectionValues = new(StringComparer.Ordinal)
    {
        "worth_trying", "too_generic", "recognition_wrong"
    };
    private static readonly HashSet<string> VisualStrategies = new(StringComparer.Ordinal)
    {
        "depth_occlusion", "scale_context", "rhythm_line", "light_color", "negative_space", "frame_edge"
    };

    public async Task<PersonalizationSnapshotResponse> GetSnapshotAsync(string userId, CancellationToken cancellationToken)
    {
        var settings = await GetOrCreateSettingsAsync(userId, cancellationToken);
        var preferences = await database.CreativePreferences.AsNoTracking()
            .Where(value => value.UserId == userId)
            .OrderByDescending(value => value.UpdatedAtUnixMs)
            .ToListAsync(cancellationToken);
        var feedback = await database.FeedbackRecords.AsNoTracking()
            .Where(value => value.UserId == userId)
            .OrderByDescending(value => value.CreatedAtUnixMs)
            .Take(100)
            .ToListAsync(cancellationToken);
        var candidateCount = await database.GlobalExperienceCandidates.AsNoTracking()
            .CountAsync(value => value.SourceFeedback != null && value.SourceFeedback.UserId == userId, cancellationToken);
        return new PersonalizationSnapshotResponse(
            ToSettings(settings),
            preferences.Select(ToPreference).ToArray(),
            feedback.Select(ToFeedback).ToArray(),
            candidateCount);
    }

    public async Task<PersonalizationSettingsResponse> UpdateSettingsAsync(
        string userId,
        UpdatePersonalizationSettingsRequest request,
        CancellationToken cancellationToken)
    {
        var settings = await GetOrCreateSettingsAsync(userId, cancellationToken);
        settings.MemoryEnabled = request.MemoryEnabled;
        settings.FeedbackSyncConsent = request.FeedbackSyncConsent;
        settings.UpdatedAt = DateTimeOffset.UtcNow;
        await database.SaveChangesAsync(cancellationToken);
        return ToSettings(settings);
    }

    public async Task<FeedbackSyncResponse> SyncFeedbackAsync(
        string userId,
        FeedbackSyncRequest request,
        CancellationToken cancellationToken)
    {
        if (request.Items.Count is < 1 or > 100)
        {
            throw new ApiException(StatusCodes.Status400BadRequest, "INVALID_FEEDBACK_BATCH", "每次可同步 1～100 条明确反馈。");
        }
        await using var syncLease = await feedbackSyncGate.EnterAsync(userId, cancellationToken);
        var settings = await GetOrCreateSettingsAsync(userId, cancellationToken);
        if (!settings.FeedbackSyncConsent)
        {
            throw new ApiException(
                StatusCodes.Status409Conflict,
                "FEEDBACK_SYNC_NOT_CONSENTED",
                "尚未开启反馈同步；设备中的反馈不会上传。");
        }

        var accepted = new List<string>(request.Items.Count);
        var acceptedSet = new HashSet<string>(StringComparer.Ordinal);
        var affectedStrategies = new HashSet<string>(StringComparer.Ordinal);
        var existingCount = await database.FeedbackRecords.CountAsync(value => value.UserId == userId, cancellationToken);
        foreach (var item in request.Items)
        {
            ValidateFeedback(item);
            if (!acceptedSet.Add(item.ClientFeedbackId))
            {
                accepted.Add(item.ClientFeedbackId);
                continue;
            }
            var duplicate = await database.FeedbackRecords.AsNoTracking().AnyAsync(
                value => value.UserId == userId && value.ClientFeedbackId == item.ClientFeedbackId,
                cancellationToken);
            if (duplicate)
            {
                accepted.Add(item.ClientFeedbackId);
                continue;
            }
            if (existingCount >= MaxFeedbackRecordsPerUser)
            {
                throw new ApiException(
                    StatusCodes.Status413PayloadTooLarge,
                    "FEEDBACK_QUOTA_EXCEEDED",
                    "这个账号的明确反馈已达到当前上限，请先导出或整理已有记录。");
            }

            var task = await database.AnalysisTasks.AsNoTracking()
                .SingleOrDefaultAsync(
                    value => value.Id == item.AnalysisTaskId && value.UserId == userId,
                    cancellationToken)
                ?? throw new ApiException(StatusCodes.Status404NotFound, "ANALYSIS_TASK_NOT_FOUND", "反馈对应的分析不存在，或不属于当前账号。");
            var (directionId, strategy) = ResolveDirection(task, item);
            var now = DateTimeOffset.UtcNow;
            var record = new FeedbackRecord
            {
                Id = $"feedback_{Guid.NewGuid():N}",
                UserId = userId,
                ClientFeedbackId = item.ClientFeedbackId,
                AnalysisTaskId = task.Id,
                DirectionId = directionId,
                VisualStrategy = strategy,
                FeedbackType = item.FeedbackType,
                Value = item.Value,
                SkillSnapshotsJson = NormalizeSkillSnapshots(task.SkillSnapshotsJson),
                CreatedAt = item.CreatedAt,
                CreatedAtUnixMs = item.CreatedAt.ToUnixTimeMilliseconds(),
                SyncedAt = now,
                SyncedAtUnixMs = now.ToUnixTimeMilliseconds()
            };
            database.FeedbackRecords.Add(record);
            existingCount += 1;
            if (strategy is not null)
            {
                affectedStrategies.Add(strategy);
                database.GlobalExperienceCandidates.Add(new GlobalExperienceCandidateRecord
                {
                    Id = $"candidate_{Guid.NewGuid():N}",
                    SourceFeedbackId = record.Id,
                    CandidateType = "direction_feedback",
                    PayloadJson = JsonSerializer.Serialize(
                        new
                        {
                            visual_strategy = strategy,
                            feedback_value = item.Value,
                            skill_versions = ParseSkillVersions(record.SkillSnapshotsJson)
                        },
                        SceneJson.Provider),
                    Status = "isolated",
                    CreatedAt = now
                });
            }
            accepted.Add(item.ClientFeedbackId);
        }
        await database.SaveChangesAsync(cancellationToken);

        if (settings.MemoryEnabled)
        {
            foreach (var strategy in affectedStrategies)
            {
                await RebuildPreferenceAsync(userId, strategy, cancellationToken);
            }
        }
        var preferences = await database.CreativePreferences.AsNoTracking()
            .Where(value => value.UserId == userId)
            .OrderByDescending(value => value.UpdatedAtUnixMs)
            .ToListAsync(cancellationToken);
        return new FeedbackSyncResponse(accepted, preferences.Select(ToPreference).ToArray());
    }

    public async Task DeleteFeedbackAsync(string userId, string feedbackId, CancellationToken cancellationToken)
    {
        var record = await database.FeedbackRecords
            .SingleOrDefaultAsync(value => value.Id == feedbackId && value.UserId == userId, cancellationToken)
            ?? throw new ApiException(StatusCodes.Status404NotFound, "FEEDBACK_NOT_FOUND", "这条反馈不存在，或不属于当前账号。");
        var strategy = record.VisualStrategy;
        database.FeedbackRecords.Remove(record);
        await database.SaveChangesAsync(cancellationToken);
        if (strategy is not null) await RebuildPreferenceAsync(userId, strategy, cancellationToken);
    }

    public async Task<CreativePreferenceResponse> UpdatePreferenceAsync(
        string userId,
        string preferenceId,
        UpdateCreativePreferenceRequest request,
        CancellationToken cancellationToken)
    {
        var record = await database.CreativePreferences
            .SingleOrDefaultAsync(value => value.Id == preferenceId && value.UserId == userId, cancellationToken)
            ?? throw new ApiException(StatusCodes.Status404NotFound, "PREFERENCE_NOT_FOUND", "这条创作记忆不存在，或不属于当前账号。");
        record.Enabled = request.Enabled;
        record.UpdatedAt = DateTimeOffset.UtcNow;
        record.UpdatedAtUnixMs = record.UpdatedAt.ToUnixTimeMilliseconds();
        await database.SaveChangesAsync(cancellationToken);
        return ToPreference(record);
    }

    public async Task DeletePreferenceAsync(string userId, string preferenceId, CancellationToken cancellationToken)
    {
        var record = await database.CreativePreferences
            .SingleOrDefaultAsync(value => value.Id == preferenceId && value.UserId == userId, cancellationToken)
            ?? throw new ApiException(StatusCodes.Status404NotFound, "PREFERENCE_NOT_FOUND", "这条创作记忆不存在，或不属于当前账号。");
        database.CreativePreferences.Remove(record);
        await database.SaveChangesAsync(cancellationToken);
    }

    public async Task ClearAsync(string userId, CancellationToken cancellationToken)
    {
        await database.FeedbackRecords.Where(value => value.UserId == userId).ExecuteDeleteAsync(cancellationToken);
        await database.CreativePreferences.Where(value => value.UserId == userId).ExecuteDeleteAsync(cancellationToken);
        var settings = await GetOrCreateSettingsAsync(userId, cancellationToken);
        settings.MemoryEnabled = false;
        settings.UpdatedAt = DateTimeOffset.UtcNow;
        await database.SaveChangesAsync(cancellationToken);
    }

    public async Task RebuildStrategiesAsync(
        string userId,
        IEnumerable<string> strategies,
        CancellationToken cancellationToken)
    {
        foreach (var strategy in strategies.Where(VisualStrategies.Contains).Distinct(StringComparer.Ordinal))
        {
            await RebuildPreferenceAsync(userId, strategy, cancellationToken);
        }
    }

    private async Task<PersonalizationSettingsRecord> GetOrCreateSettingsAsync(string userId, CancellationToken cancellationToken)
    {
        var settings = await database.PersonalizationSettings.SingleOrDefaultAsync(
            value => value.UserId == userId,
            cancellationToken);
        if (settings is not null) return settings;
        settings = new PersonalizationSettingsRecord
        {
            UserId = userId,
            MemoryEnabled = false,
            FeedbackSyncConsent = false,
            UpdatedAt = DateTimeOffset.UtcNow
        };
        database.PersonalizationSettings.Add(settings);
        try
        {
            await database.SaveChangesAsync(cancellationToken);
            return settings;
        }
        catch (DbUpdateException)
        {
            database.Entry(settings).State = EntityState.Detached;
            return await database.PersonalizationSettings.SingleAsync(value => value.UserId == userId, cancellationToken);
        }
    }

    private async Task RebuildPreferenceAsync(string userId, string strategy, CancellationToken cancellationToken)
    {
        var evidence = await database.FeedbackRecords.AsNoTracking()
            .Where(value => value.UserId == userId && value.VisualStrategy == strategy)
            .Select(value => new { value.AnalysisTaskId, value.Value })
            .ToListAsync(cancellationToken);
        var positive = evidence.Where(value => value.Value == "worth_trying")
            .Select(value => value.AnalysisTaskId).Distinct(StringComparer.Ordinal).Count();
        var cautious = evidence.Where(value => value.Value is "too_generic" or "recognition_wrong")
            .Select(value => value.AnalysisTaskId).Distinct(StringComparer.Ordinal).Count();
        var existing = await database.CreativePreferences.SingleOrDefaultAsync(
            value => value.UserId == userId && value.VisualStrategy == strategy,
            cancellationToken);
        (string Kind, int Count)? winner = positive == cautious ? null : positive > cautious
            ? (Kind: "explore_more", Count: positive)
            : (Kind: "be_cautious", Count: cautious);
        if (winner is null || winner.Value.Count < 2)
        {
            if (existing is not null)
            {
                database.CreativePreferences.Remove(existing);
                await database.SaveChangesAsync(cancellationToken);
            }
            return;
        }

        var now = DateTimeOffset.UtcNow;
        if (existing is null)
        {
            database.CreativePreferences.Add(new CreativePreferenceRecord
            {
                Id = $"preference_{Guid.NewGuid():N}",
                UserId = userId,
                PreferenceKind = winner.Value.Kind,
                VisualStrategy = strategy,
                EvidenceCount = winner.Value.Count,
                Enabled = true,
                CreatedAt = now,
                CreatedAtUnixMs = now.ToUnixTimeMilliseconds(),
                UpdatedAt = now,
                UpdatedAtUnixMs = now.ToUnixTimeMilliseconds()
            });
        }
        else
        {
            existing.PreferenceKind = winner.Value.Kind;
            existing.EvidenceCount = winner.Value.Count;
            existing.UpdatedAt = now;
            existing.UpdatedAtUnixMs = now.ToUnixTimeMilliseconds();
        }
        await database.SaveChangesAsync(cancellationToken);
    }

    private static (string? DirectionId, string? Strategy) ResolveDirection(
        AnalysisTaskRecord task,
        FeedbackSyncItemRequest item)
    {
        if (item.FeedbackType == "analysis") return (null, null);
        if (string.IsNullOrWhiteSpace(task.ResultJson))
        {
            throw new ApiException(StatusCodes.Status409Conflict, "ANALYSIS_RESULT_UNAVAILABLE", "方向反馈对应的分析结果尚不可用。");
        }
        AnalysisResponse response;
        try
        {
            response = JsonSerializer.Deserialize<AnalysisResponse>(task.ResultJson, SceneJson.Provider)
                ?? throw new JsonException("分析结果为空");
        }
        catch (JsonException)
        {
            throw new ApiException(StatusCodes.Status409Conflict, "ANALYSIS_RESULT_UNAVAILABLE", "方向反馈对应的分析结果暂时无法读取。");
        }
        var direction = response.Analysis.Interpretations.SingleOrDefault(
            value => string.Equals(value.Id, item.DirectionId, StringComparison.Ordinal))
            ?? throw new ApiException(StatusCodes.Status400BadRequest, "DIRECTION_NOT_FOUND", "反馈方向不在这次分析中。");
        if (!VisualStrategies.Contains(direction.VisualStrategy))
        {
            throw new ApiException(StatusCodes.Status409Conflict, "VISUAL_STRATEGY_UNSUPPORTED", "这条旧方向使用了当前无法归纳的视觉策略。");
        }
        return (direction.Id, direction.VisualStrategy);
    }

    private static void ValidateFeedback(FeedbackSyncItemRequest item)
    {
        var typeValid = item.FeedbackType switch
        {
            "analysis" => AnalysisValues.Contains(item.Value) && string.IsNullOrWhiteSpace(item.DirectionId),
            "direction" => DirectionValues.Contains(item.Value) && !string.IsNullOrWhiteSpace(item.DirectionId),
            _ => false
        };
        var now = DateTimeOffset.UtcNow;
        if (string.IsNullOrWhiteSpace(item.ClientFeedbackId)
            || item.ClientFeedbackId.Length > 96
            || string.IsNullOrWhiteSpace(item.AnalysisTaskId)
            || item.AnalysisTaskId.Length > 48
            || item.DirectionId?.Length > 128
            || !typeValid
            || item.CreatedAt == default
            || item.CreatedAt < now.AddDays(-90)
            || item.CreatedAt > now.AddMinutes(5))
        {
            throw new ApiException(StatusCodes.Status400BadRequest, "INVALID_FEEDBACK", "反馈字段不完整、不是允许的枚举，或已超出离线同步时限。");
        }
    }

    private static string NormalizeSkillSnapshots(string? json)
    {
        var snapshots = ParseSkillVersions(json);
        return JsonSerializer.Serialize(snapshots, SceneJson.Provider);
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

    private static PersonalizationSettingsResponse ToSettings(PersonalizationSettingsRecord value) =>
        new(value.MemoryEnabled, value.FeedbackSyncConsent, value.UpdatedAt);

    private static CreativePreferenceResponse ToPreference(CreativePreferenceRecord value) =>
        new(value.Id, value.PreferenceKind, value.VisualStrategy, value.EvidenceCount, value.Enabled, value.CreatedAt, value.UpdatedAt);

    private static FeedbackRecordResponse ToFeedback(FeedbackRecord value) =>
        new(
            value.Id,
            value.ClientFeedbackId,
            value.AnalysisTaskId,
            value.DirectionId,
            value.VisualStrategy,
            value.FeedbackType,
            value.Value,
            ParseSkillVersions(value.SkillSnapshotsJson),
            value.CreatedAt,
            value.SyncedAt);
}
