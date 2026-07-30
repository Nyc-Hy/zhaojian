using System.Text.Json;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Options;
using Zhaojian.Api.Contracts;
using Zhaojian.Api.Infrastructure;

namespace Zhaojian.Api.Skills;

internal sealed record SkillReleaseProof(
    string EvaluationId,
    string EvaluationReportHash,
    string Phase,
    string Evaluator,
    string EvaluationReason,
    DateTimeOffset EvaluatedAt);

internal sealed class SkillReleaseGate(
    IOptions<SkillRegistryOptions> options,
    IHostEnvironment environment)
{
    private static readonly HashSet<string> RequiredGateCodes =
    [
        "provenance_complete",
        "dataset_comparable",
        "skill_content_integrity",
        "historical_compatibility",
        "fixed_regression",
        "holdout_regression",
        "serious_failure_regression",
        "cost_limit",
        "latency_limit",
        "rollback_ready",
        "shadow_observation"
    ];
    private static readonly HashSet<string> RequiredMetricDimensions =
    [
        "json_parse_rate",
        "serious_hallucination_rate",
        "intent_response_rate",
        "direction_difference_rate",
        "grounding_rate",
        "clarification_effectiveness_rate",
        "field_executability_rate",
        "gear_feasibility_rate",
        "judge_language_rate"
    ];
    private static readonly IReadOnlyDictionary<string, string> MetricDirections =
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["json_parse_rate"] = "higher",
            ["serious_hallucination_rate"] = "lower",
            ["intent_response_rate"] = "higher",
            ["direction_difference_rate"] = "higher",
            ["grounding_rate"] = "higher",
            ["clarification_effectiveness_rate"] = "higher",
            ["field_executability_rate"] = "higher",
            ["gear_feasibility_rate"] = "higher",
            ["judge_language_rate"] = "lower"
        };
    private static readonly IReadOnlyDictionary<string, int> RequiredSplitCounts =
        new Dictionary<string, int>(StringComparer.Ordinal)
        {
            ["training"] = 36,
            ["regression"] = 12,
            ["holdout"] = 12
        };
    private readonly SkillRegistryOptions _options = options.Value;
    private static readonly Regex IdentifierRegex = new(
        @"^[a-zA-Z0-9][a-zA-Z0-9_-]{2,127}$",
        RegexOptions.CultureInvariant);
    private static readonly Regex SemanticVersionRegex = new(
        @"^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$",
        RegexOptions.CultureInvariant);
    private static readonly Regex ContentHashRegex = new(
        @"^sha256:[0-9a-f]{64}$",
        RegexOptions.CultureInvariant);

    public SkillReleaseProof Validate(
        string reportPath,
        SkillHandle target,
        SkillHandle baseline,
        string requiredPhase)
    {
        var root = ResolveRootPath();
        if (!Directory.Exists(root))
        {
            throw new SkillRegistryException($"Skill 评测目录不存在：{root}");
        }
        RejectPathChain(root, root);
        var path = Path.IsPathRooted(reportPath)
            ? Path.GetFullPath(reportPath)
            : Path.GetFullPath(Path.Combine(root, reportPath));
        RejectPathChain(root, path);
        if (!File.Exists(path)) throw new SkillRegistryException($"Skill 评测报告不存在：{path}");
        var bytes = ReadCheckedFile(root, path);
        if (bytes.Length is <= 0 || bytes.Length > _options.MaxEvaluationReportBytes)
        {
            throw new SkillRegistryException("Skill 评测报告大小超出范围。");
        }
        string text;
        try
        {
            text = new UTF8Encoding(false, true).GetString(bytes);
        }
        catch (DecoderFallbackException error)
        {
            throw new SkillRegistryException("Skill 评测报告必须是有效 UTF-8 文本。", error);
        }
        if (Regex.IsMatch(
            text,
            @"data:image|base64,|(?:authorization|bearer|api[_-]?key|password|secret)\s*[:=]|(?:latitude|longitude|gps)\s*[:=]",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant))
        {
            throw new SkillRegistryException("Skill 评测报告包含禁止持久化的敏感内容。");
        }

        SkillEvaluationReportContract report;
        try
        {
            report = JsonSerializer.Deserialize<SkillEvaluationReportContract>(
                bytes,
                SceneJson.Provider) ?? throw new JsonException("报告为空");
        }
        catch (JsonException error)
        {
            throw new SkillRegistryException("Skill 评测报告无法读取。", error);
        }

        if (report.SchemaVersion != "1.0") throw new SkillRegistryException("未知 Skill 评测报告版本。");
        if (report.BaselineSkill is null
            || report.CandidateSkill is null
            || report.Source is null
            || report.Dataset is null
            || report.ComparisonConfig is null
            || report.Metrics is null
            || report.SplitResults is null
            || report.Gates is null
            || report.Failures is null
            || report.Telemetry is null)
        {
            throw new SkillRegistryException("Skill 评测报告缺少必填对象。");
        }
        if (report.Phase != requiredPhase) throw new SkillRegistryException($"需要 {requiredPhase} 阶段的 Skill 评测报告。");
        if (report.Status != "passed" || report.ValidationStatus != "passed")
        {
            throw new SkillRegistryException("Skill 评测报告没有通过发布门禁。");
        }
        var expectedEligibility = requiredPhase == "candidate"
            ? report.EligibleForShadow
                && !report.EligibleForActivation
                && report.ShadowObservationId is null
            : !report.EligibleForShadow
                && report.EligibleForActivation
                && report.ShadowObservationId is not null
                && IdentifierRegex.IsMatch(report.ShadowObservationId)
                && report.ShadowObservationId == report.Source.CandidateRunId;
        if (!expectedEligibility) throw new SkillRegistryException("Skill 评测报告不允许当前生命周期切换。");
        if (report.CandidateSkill.Id != target.Definition.SkillId
            || report.CandidateSkill.Version != target.Definition.SkillVersion
            || report.CandidateSkill.ContentHash != target.Definition.ContentHash)
        {
            throw new SkillRegistryException("Skill 评测报告与目标资源包不匹配。");
        }
        if (report.BaselineSkill.Id != baseline.Definition.SkillId
            || report.BaselineSkill.Version != baseline.Definition.SkillVersion
            || report.BaselineSkill.ContentHash != baseline.Definition.ContentHash
            || !baseline.Active
            || baseline.Definition.SkillId != target.Definition.SkillId
            || baseline.Definition.SkillVersion == target.Definition.SkillVersion)
        {
            throw new SkillRegistryException("Skill 评测报告基线不是当前活动 Skill。");
        }
        if (!IdentifierRegex.IsMatch(report.EvaluationId)
            || !IdentifierRegex.IsMatch(report.Source.BaselineReportId)
            || !IdentifierRegex.IsMatch(report.Source.BaselineRunId)
            || !ContentHashRegex.IsMatch(report.Source.BaselineReportHash)
            || !IdentifierRegex.IsMatch(report.Source.CandidateReportId)
            || !IdentifierRegex.IsMatch(report.Source.CandidateRunId)
            || !ContentHashRegex.IsMatch(report.Source.CandidateReportHash)
            || report.Source.BaselineReportId == report.Source.CandidateReportId
            || report.Source.BaselineRunId == report.Source.CandidateRunId
            || report.Source.BaselineReportHash == report.Source.CandidateReportHash
            || string.IsNullOrWhiteSpace(report.Source.Provider)
            || string.IsNullOrWhiteSpace(report.Source.Model)
            || !SemanticVersionRegex.IsMatch(report.Source.PromptVersion)
            || !SemanticVersionRegex.IsMatch(report.Source.SchemaVersion)
            || string.IsNullOrWhiteSpace(report.Source.PricingVersion)
            || !SemanticVersionRegex.IsMatch(report.Source.EvaluationSetVersion)
            || report.Source.EvaluationSetVersion != target.Definition.EvaluationSetVersion
            || report.Dataset.Id != _options.EvaluationDatasetId
            || report.Dataset.Version != _options.EvaluationDatasetVersion
            || report.Dataset.ContentHash != _options.EvaluationDatasetContentHash
            || !ContentHashRegex.IsMatch(report.Dataset.SelectionHash)
            || !SemanticVersionRegex.IsMatch(report.ComparisonConfig.RuntimeVersion)
            || report.ComparisonConfig.RuntimeVersion != _options.RuntimeVersion
            || !InRange(report.ComparisonConfig.MaxCostIncreaseRatio, 0, 10)
            || !InRange(report.ComparisonConfig.MaxAverageLatencyIncreaseRatio, 0, 10)
            || !InRange(report.ComparisonConfig.MaxLatencyIncreaseRatio, 0, 10)
            || !report.ComparisonConfig.RequireAllSplits)
        {
            throw new SkillRegistryException("Skill 评测报告缺少完整来源或固定分区要求。");
        }
        if (!IdentifierRegex.IsMatch(report.Actor)
            || string.IsNullOrWhiteSpace(report.Reason)
            || report.Reason.Length is < 8 or > 300)
        {
            throw new SkillRegistryException("Skill 评测报告的评测者或原因不正确。");
        }
        if (report.EvaluatedAt < target.Definition.CreatedAt
            || report.EvaluatedAt > DateTimeOffset.UtcNow.AddMinutes(5))
        {
            throw new SkillRegistryException("Skill 评测时间早于候选资源或超出允许时钟偏差。");
        }
        if (report.Failures.Count != 0) throw new SkillRegistryException("通过的 Skill 评测报告不能保留阻断失败。");
        if (report.Gates.Select(value => value.Code).Distinct(StringComparer.Ordinal).Count() != report.Gates.Count
            || !RequiredGateCodes.SetEquals(report.Gates.Select(value => value.Code))
            || report.Gates.Any(value =>
                !value.Passed
                || string.IsNullOrWhiteSpace(value.Evidence)
                || value.Evidence.Length > 300))
        {
            throw new SkillRegistryException("Skill 评测报告门禁不完整或未全部通过。");
        }
        if (report.Metrics.Select(value => value.Dimension).Distinct(StringComparer.Ordinal).Count() != report.Metrics.Count
            || !RequiredMetricDimensions.SetEquals(report.Metrics.Select(value => value.Dimension))
            || report.Metrics.Any(value => !MetricComparisonPassed(value)))
        {
            throw new SkillRegistryException("Skill 评测报告九维指标不完整或存在退化。");
        }
        if (report.SplitResults.Select(value => value.Split).Distinct(StringComparer.Ordinal).Count() != 3
            || !RequiredSplitCounts.Keys.ToHashSet(StringComparer.Ordinal)
                .SetEquals(report.SplitResults.Select(value => value.Split))
            || report.SplitResults.Any(value =>
                !value.Passed
                || value.NewBlockingFailures != 0
                || !RequiredSplitCounts.TryGetValue(value.Split, out var count)
                || value.AssetCount != count))
        {
            throw new SkillRegistryException("Skill 评测报告固定分区不完整或存在新增阻断失败。");
        }
        if (!TelemetryIsValid(report.Telemetry.Baseline)
            || !TelemetryIsValid(report.Telemetry.Candidate)
            || !WithinIncrease(
                report.Telemetry.Candidate.CostPerSuccessfulCall,
                report.Telemetry.Baseline.CostPerSuccessfulCall,
                report.ComparisonConfig.MaxCostIncreaseRatio)
            || !WithinIncrease(
                report.Telemetry.Candidate.AverageLatencyMs,
                report.Telemetry.Baseline.AverageLatencyMs,
                report.ComparisonConfig.MaxAverageLatencyIncreaseRatio,
                250)
            || !WithinIncrease(
                report.Telemetry.Candidate.MaxLatencyMs,
                report.Telemetry.Baseline.MaxLatencyMs,
                report.ComparisonConfig.MaxLatencyIncreaseRatio,
                500))
        {
            throw new SkillRegistryException("Skill 评测报告成本或延迟超过显式门槛。");
        }
        var computedHash = SkillContentHasher.ComputeDocument(bytes);
        if (computedHash != report.ContentHash)
        {
            throw new SkillRegistryException("Skill 评测报告内容哈希不匹配。");
        }
        return new SkillReleaseProof(
            report.EvaluationId,
            report.ContentHash,
            report.Phase,
            report.Actor,
            report.Reason,
            report.EvaluatedAt);
    }

    private static bool MetricComparisonPassed(SkillEvaluationMetric metric)
    {
        if (!metric.Passed
            || !MetricDirections.TryGetValue(metric.Dimension, out var direction)
            || metric.Direction != direction
            || !InRange(metric.BaselineValue, 0, 1)
            || !InRange(metric.CandidateValue, 0, 1)
            || !InRange(metric.Delta, -1, 1)
            || !InRange(metric.Threshold, 0, 1)
            || Math.Abs(metric.Delta - (metric.CandidateValue - metric.BaselineValue)) > 0.000001)
        {
            return false;
        }
        return direction == "higher"
            ? metric.CandidateValue >= metric.Threshold
                && metric.CandidateValue >= metric.BaselineValue
            : metric.CandidateValue <= metric.Threshold
                && metric.CandidateValue <= metric.BaselineValue;
    }

    private static bool WithinIncrease(decimal candidate, decimal baseline, decimal ratio, decimal allowance = 0) =>
        baseline == 0
            ? candidate == 0
            : candidate <= baseline * (1 + ratio) + allowance;

    private static bool TelemetryIsValid(SkillEvaluationTelemetrySnapshot telemetry) =>
        telemetry.EstimatedCost >= 0
        && telemetry.CostPerSuccessfulCall >= 0
        && telemetry.AverageLatencyMs >= 0
        && telemetry.MaxLatencyMs >= telemetry.AverageLatencyMs;

    private static bool InRange(decimal value, decimal minimum, decimal maximum) =>
        value >= minimum && value <= maximum;

    private static bool InRange(double value, double minimum, double maximum) =>
        !double.IsNaN(value) && !double.IsInfinity(value) && value >= minimum && value <= maximum;

    private string ResolveRootPath()
    {
        if (Path.IsPathRooted(_options.EvaluationRootPath))
        {
            return Path.GetFullPath(_options.EvaluationRootPath);
        }
        return Path.GetFullPath(Path.Combine(environment.ContentRootPath, _options.EvaluationRootPath));
    }

    private static void RejectPathChain(string root, string path)
    {
        var fullRoot = Path.GetFullPath(root);
        var fullPath = Path.GetFullPath(path);
        var relative = Path.GetRelativePath(fullRoot, fullPath);
        if (Path.IsPathRooted(relative)
            || relative == ".."
            || relative.StartsWith($"..{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
            || relative.StartsWith($"..{Path.AltDirectorySeparatorChar}", StringComparison.Ordinal))
        {
            throw new SkillRegistryException($"Skill 评测路径越出允许目录：{path}");
        }

        FileSystemInfo current = Directory.Exists(fullPath)
            ? new DirectoryInfo(fullPath)
            : new FileInfo(fullPath);
        while (true)
        {
            current.Refresh();
            if (current.LinkTarget is not null || current.Attributes.HasFlag(FileAttributes.ReparsePoint))
            {
                throw new SkillRegistryException($"Skill 评测路径不能使用符号链接：{current.FullName}");
            }
            if (string.Equals(
                current.FullName.TrimEnd(Path.DirectorySeparatorChar),
                fullRoot.TrimEnd(Path.DirectorySeparatorChar),
                StringComparison.Ordinal))
            {
                break;
            }
            current = current switch
            {
                FileInfo file => file.Directory ?? throw new SkillRegistryException("Skill 评测报告缺少父目录。"),
                DirectoryInfo directory => directory.Parent ?? throw new SkillRegistryException("Skill 评测目录缺少父目录。"),
                _ => throw new SkillRegistryException("Skill 评测路径类型不受支持。")
            };
        }
    }

    private static byte[] ReadCheckedFile(string root, string path)
    {
        RejectPathChain(root, path);
        var before = new FileInfo(path);
        before.Refresh();
        var expectedLength = before.Length;
        var expectedWriteTime = before.LastWriteTimeUtc;
        byte[] bytes;
        using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            if (stream.Length > int.MaxValue) throw new SkillRegistryException("Skill 评测报告过大。");
            bytes = new byte[checked((int)stream.Length)];
            stream.ReadExactly(bytes);
        }
        RejectPathChain(root, path);
        var after = new FileInfo(path);
        after.Refresh();
        if (expectedLength != bytes.Length
            || after.Length != bytes.Length
            || after.LastWriteTimeUtc != expectedWriteTime)
        {
            throw new SkillRegistryException("Skill 评测报告在读取期间发生变化。");
        }
        return bytes;
    }
}
