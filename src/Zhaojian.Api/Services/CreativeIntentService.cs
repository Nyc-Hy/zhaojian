using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Zhaojian.Api.Contracts;
using Zhaojian.Api.Data;
using Zhaojian.Api.Infrastructure;

namespace Zhaojian.Api.Services;

public sealed class CreativeIntentService(ZhaojianDbContext database)
{
    private const int MaxCreativeIntentsPerUser = 5000;
    public async Task<CreativeIntentContract> CreateAsync(
        string userId,
        string taskId,
        string selectedInterpretationId,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(selectedInterpretationId) || selectedInterpretationId.Length > 128)
        {
            throw new ApiException(StatusCodes.Status400BadRequest, "INVALID_CREATIVE_INTENT", "请选择这次想保留的创作方向。");
        }

        var task = await database.AnalysisTasks
            .SingleOrDefaultAsync(value => value.Id == taskId && value.UserId == userId, cancellationToken)
            ?? throw new ApiException(StatusCodes.Status404NotFound, "ANALYSIS_TASK_NOT_FOUND", "这次分析不存在，或不属于当前账号。");
        if (string.IsNullOrWhiteSpace(task.ResultJson))
        {
            throw new ApiException(StatusCodes.Status409Conflict, "ANALYSIS_RESULT_UNAVAILABLE", "分析尚未形成可保存的方向。");
        }

        var existing = await database.CreativeIntents.AsNoTracking().SingleOrDefaultAsync(
            value => value.UserId == userId
                && value.SourceAnalysisTaskId == taskId
                && value.SelectedInterpretationId == selectedInterpretationId,
            cancellationToken);
        if (existing is not null) return Parse(existing);
        if (await database.CreativeIntents.CountAsync(value => value.UserId == userId, cancellationToken) >= MaxCreativeIntentsPerUser)
        {
            throw new ApiException(
                StatusCodes.Status413PayloadTooLarge,
                "CREATIVE_INTENT_QUOTA_EXCEEDED",
                "这个账号的创作意图已达到当前上限，请先导出或整理已有记录。");
        }

        var response = JsonSerializer.Deserialize<AnalysisResponse>(task.ResultJson, SceneJson.Provider)
            ?? throw new ApiException(StatusCodes.Status409Conflict, "ANALYSIS_RESULT_UNAVAILABLE", "历史分析结果暂时无法读取。");
        var selected = response.Analysis.Interpretations.SingleOrDefault(
            value => string.Equals(value.Id, selectedInterpretationId, StringComparison.Ordinal))
            ?? throw new ApiException(StatusCodes.Status400BadRequest, "DIRECTION_NOT_FOUND", "所选方向不在这次分析中。");
        var skillVersions = ParseSkillVersions(task.SkillSnapshotsJson);
        if (skillVersions.Count == 0)
        {
            throw new ApiException(
                StatusCodes.Status409Conflict,
                "SKILL_SNAPSHOT_UNAVAILABLE",
                "这条旧分析没有完整的 Skill 版本快照，仍可查看，但不能生成可追溯的创作意图。");
        }

        var now = DateTimeOffset.UtcNow;
        var intent = new CreativeIntentContract(
            "1.0",
            $"intent_{Guid.NewGuid():N}",
            BuildSubjectRelations(response.Analysis, selected),
            BuildAttentionPath(response.Analysis),
            NormalizeList(selected.Keep, 1, 8, 120, "保留所选方向中的主体关系"),
            NormalizeList(selected.Reduce, 0, 8, 120),
            Clip(selected.FramingPlan, 300, "保留所选方向的取景关系。"),
            ClipNullable(selected.HighlightShadowIntent, 300),
            null,
            ClipNullable(selected.MotionIntent, 300),
            ClipNullable(selected.DepthOfFieldIntent, 300),
            null,
            NormalizeList(
                [selected.Uncertainty, .. response.Analysis.Observations.Uncertainties],
                0,
                8,
                300),
            NormalizeList([selected.Tradeoffs], 1, 8, 300, "不同处理会带来不同的观看重心。"),
            task.Id,
            selected.Id,
            skillVersions,
            ParseGearSnapshot(task.GearSnapshotJson),
            now);

        var record = new CreativeIntentRecord
        {
            Id = intent.CreativeIntentId,
            UserId = userId,
            SourceAnalysisTaskId = task.Id,
            SelectedInterpretationId = selected.Id,
            PayloadJson = JsonSerializer.Serialize(intent, SceneJson.Provider),
            CreatedAt = now,
            CreatedAtUnixMs = now.ToUnixTimeMilliseconds(),
            UpdatedAt = now,
            UpdatedAtUnixMs = now.ToUnixTimeMilliseconds()
        };
        database.CreativeIntents.Add(record);
        try
        {
            await database.SaveChangesAsync(cancellationToken);
            return intent;
        }
        catch (DbUpdateException)
        {
            database.Entry(record).State = EntityState.Detached;
            var concurrent = await database.CreativeIntents.AsNoTracking().SingleOrDefaultAsync(
                value => value.UserId == userId
                    && value.SourceAnalysisTaskId == taskId
                    && value.SelectedInterpretationId == selectedInterpretationId,
                cancellationToken);
            if (concurrent is null) throw;
            return Parse(concurrent);
        }
    }

    public async Task<IReadOnlyList<CreativeIntentContract>> ListAsync(string userId, int limit, CancellationToken cancellationToken)
    {
        var records = await database.CreativeIntents.AsNoTracking()
            .Where(value => value.UserId == userId)
            .OrderByDescending(value => value.UpdatedAtUnixMs)
            .Take(Math.Clamp(limit, 1, 200))
            .ToListAsync(cancellationToken);
        return records.Select(Parse).ToArray();
    }

    public async Task<CreativeIntentContract?> FindAsync(string userId, string intentId, CancellationToken cancellationToken)
    {
        var record = await database.CreativeIntents.AsNoTracking()
            .SingleOrDefaultAsync(value => value.Id == intentId && value.UserId == userId, cancellationToken);
        return record is null ? null : Parse(record);
    }

    public async Task DeleteAsync(string userId, string intentId, CancellationToken cancellationToken)
    {
        var record = await database.CreativeIntents
            .SingleOrDefaultAsync(value => value.Id == intentId && value.UserId == userId, cancellationToken)
            ?? throw new ApiException(StatusCodes.Status404NotFound, "CREATIVE_INTENT_NOT_FOUND", "这条创作意图不存在，或不属于当前账号。");
        database.CreativeIntents.Remove(record);
        await database.SaveChangesAsync(cancellationToken);
    }

    public static CreativeIntentContract Parse(CreativeIntentRecord record)
    {
        try
        {
            return JsonSerializer.Deserialize<CreativeIntentContract>(record.PayloadJson, SceneJson.Provider)
                ?? throw new JsonException("创作意图为空");
        }
        catch (JsonException)
        {
            throw new ApiException(
                StatusCodes.Status500InternalServerError,
                "CREATIVE_INTENT_INVALID",
                "这条创作意图暂时无法读取。");
        }
    }

    private static IReadOnlyList<string> BuildSubjectRelations(SceneAnalysis analysis, Interpretation selected)
    {
        var relations = analysis.Observations.VisualRelations
            .Select(value => $"{string.Join("、", value.Elements)}：{value.Relation}")
            .ToArray();
        if (relations.Length == 0)
        {
            relations = [$"{string.Join("、", selected.Grounding.Elements)}：{selected.Grounding.Relationship}"];
        }
        return NormalizeList(relations, 1, 8, 120, "保留所选方向中的主体关系");
    }

    private static IReadOnlyList<string> BuildAttentionPath(SceneAnalysis analysis)
    {
        var path = analysis.Observations.AttentionCandidates.Select(value => value.Label);
        return NormalizeList(path, 1, 8, 120, Clip(analysis.Observations.Summary, 120, "观察画面中的主要关系"));
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

    private static CreativeIntentGearSnapshot? ParseGearSnapshot(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return null;
        try
        {
            var gear = JsonSerializer.Deserialize<ResolvedGearContext>(json, SceneJson.Provider);
            return gear is null ? null : new CreativeIntentGearSnapshot(
                gear.Id,
                gear.Name,
                gear.Camera,
                gear.Lens,
                gear.SensorWidth,
                gear.SensorHeight,
                gear.CropFactor,
                gear.FocalMin,
                gear.FocalMax,
                gear.MaximumAperture,
                gear.MinimumAperture,
                gear.MinIso,
                gear.MaxIso);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static IReadOnlyList<string> NormalizeList(
        IEnumerable<string?> values,
        int min,
        int max,
        int maxLength,
        string? fallback = null)
    {
        var normalized = values
            .Where(value => !string.IsNullOrWhiteSpace(value))
            .Select(value => Clip(value!, maxLength, fallback ?? "保留现场观察"))
            .Distinct(StringComparer.Ordinal)
            .Take(max)
            .ToList();
        if (normalized.Count < min && !string.IsNullOrWhiteSpace(fallback)) normalized.Add(Clip(fallback, maxLength, fallback));
        return normalized;
    }

    private static string Clip(string value, int maxLength, string fallback)
    {
        var normalized = string.IsNullOrWhiteSpace(value) ? fallback : value.Trim();
        return normalized[..Math.Min(normalized.Length, maxLength)];
    }

    private static string? ClipNullable(string? value, int maxLength) =>
        string.IsNullOrWhiteSpace(value) ? null : Clip(value, maxLength, value);
}
