using System.Diagnostics.CodeAnalysis;
using System.Text.RegularExpressions;
using Zhaojian.Api.Infrastructure;

namespace Zhaojian.Api.Contracts;

public sealed partial class SceneContractValidator
{
    private static readonly HashSet<string> RelationValues = ["overlap", "separation", "continuation", "repetition", "directional_contrast", "scale_contrast", "tonal_contrast", "color_contrast", "frame_tension", "depth_layering"];
    private static readonly HashSet<string> StrategyValues = ["depth_occlusion", "scale_context", "rhythm_line", "light_color", "negative_space", "frame_edge"];
    private static readonly HashSet<string> ViewWidthValues = ["very_wide", "wide", "normal", "narrow", "detail"];
    private static readonly HashSet<string> HeightValues = ["lower", "similar", "higher", "unknown"];
    private static readonly HashSet<string> LateralValues = ["left", "similar", "right", "unknown"];
    private static readonly HashSet<string> DistanceValues = ["closer", "similar", "farther", "unknown"];
    private static readonly HashSet<string> OrientationValues = ["landscape", "portrait", "square", "keep", "unknown"];
    private static readonly HashSet<string> LightDirectionValues = ["front", "side", "back", "top", "diffuse", "mixed", "unknown"];
    private static readonly HashSet<string> LightLevelValues = ["low", "medium", "high", "unknown"];

    public void ValidateRequest(SceneRequest request)
    {
        Length(request.Intent, 240, "吸引点");
        Length(request.AttentionOption, 40, "关注选项");
        Length(request.SceneDescription, 300, "现场内容");
        Length(request.EnvironmentNotes, 240, "现场环境");
        Length(request.MustKeep, 180, "保留内容");
        Length(request.CanReduce, 180, "弱化内容");
        Length(request.DesiredMood, 120, "希望感受");
        Length(request.ClarificationQuestion, 160, "澄清问题");
        Length(request.ClarificationAnswer, 240, "澄清回答");
        if (string.IsNullOrWhiteSpace(request.GearKitId) || request.GearKitId.Length > 64) throw new ApiException(400, "INVALID_REQUEST", "请选择当前账号中的摄影包。");
        if (request.PhotoTechnicalContext is { } photo) ValidatePhotoContext(photo);
    }

    private static void ValidatePhotoContext(PhotoTechnicalContext value)
    {
        if (value.OriginalWidth is <= 0 or > 30000 || value.OriginalHeight is <= 0 or > 30000 ||
            value.AnalysisWidth is <= 0 or > 4096 || value.AnalysisHeight is <= 0 or > 4096 ||
            value.AspectRatio.Length > 24 || value.Orientation.Length > 32)
            throw new ApiException(400, "INVALID_PHOTO_CONTEXT", "图片技术信息范围不正确。");
        var originalRatio = (double)value.OriginalWidth / value.OriginalHeight;
        var analysisRatio = (double)value.AnalysisWidth / value.AnalysisHeight;
        if (!value.CompositionPreserved || Math.Abs(originalRatio - analysisRatio) / originalRatio > 0.002)
            throw new ApiException(400, "COMPOSITION_CHANGED", "分析图必须保持原图比例与构图。");
        if (!value.MetadataConsent && value.OriginalExif is not null)
            throw new ApiException(400, "METADATA_CONSENT_REQUIRED", "发送原图技术信息前需要明确同意。");
        if (value.OriginalExif is { } exif &&
            (exif.CameraMake?.Length > 80 || exif.CameraModel?.Length > 120 || exif.LensModel?.Length > 120 || exif.CapturedAt?.Length > 40 ||
             exif.FocalLengthMm is < 0 or > 3000 || exif.FocalLength35Mm is < 0 or > 3000 || exif.Aperture is < 0.5 or > 128 ||
             exif.ExposureSeconds is <= 0 or > 86400 || exif.Iso is < 1 or > 10_000_000 || exif.ExposureCompensationEv is < -20 or > 20))
            throw new ApiException(400, "INVALID_PHOTO_CONTEXT", "原图 EXIF 白名单字段范围不正确。");
        if (value.CurrentMetering is { } metering && (metering.Ev100 is < -20 or > 30 || metering.Source is not ("manual_meter" or "camera_meter")))
            throw new ApiException(400, "INVALID_METERING", "当前测光信息来源或范围不正确。");
    }

    public void ValidateUnderstanding(SceneUnderstanding value)
    {
        if (value is null || value.Observations is null || value.TechnicalObservations is null) Invalid("画面理解包含空的必填对象。");
        if (value.SchemaVersion != "1.1" || value.Language != "zh-CN") Invalid("画面理解契约版本不正确。");
        ValidateObservations(value.Observations);
        ValidateTechnical(value.TechnicalObservations);
    }

    public void ValidateAnalysis(SceneAnalysis value, SceneRequest request)
    {
        if (value is null || value.Observations is null || value.TechnicalObservations is null || value.Interpretations is null) Invalid("场景分析包含空的必填对象。");
        if (value.Interpretations.Any(item => item is null || item.Grounding is null || item.Viewpoint is null || item.Keep is null || item.Reduce is null || item.FieldSteps is null))
            Invalid("观看方向包含空的必填对象。");
        if (value.SchemaVersion != "4.3" || value.Language != "zh-CN") Invalid("场景分析契约版本不正确。");
        ValidateObservations(value.Observations);
        ValidateTechnical(value.TechnicalObservations);
        if (value.Outcome == "clarification")
        {
            var clarification = value.Clarification;
            if (clarification is null || clarification.Options is null || value.NoOptions is not null || value.Interpretations.Count != 0 || clarification.Options.Count is < 2 or > 3) Invalid("澄清响应结构不正确。");
            Text(clarification!.Question, 4, 160, "澄清问题");
            Text(clarification.Reason, 2, 200, "澄清原因");
            return;
        }
        if (value.Outcome == "no_options")
        {
            var noOptions = value.NoOptions;
            if (value.Clarification is not null || noOptions is null || noOptions.Evidence is null || value.Interpretations.Count != 0 || noOptions.Evidence.Count is < 1 or > 4) Invalid("无可靠方向响应结构不正确。");
            Text(noOptions!.Reason, 4, 240, "无可靠方向原因");
            foreach (var evidence in noOptions.Evidence) Text(evidence, 2, 180, "无可靠方向依据");
            if (noOptions.NextStep is not null) Text(noOptions.NextStep, 2, 180, "下一步提示");
            return;
        }
        if (value.Outcome != "analysis" || value.Clarification is not null || value.NoOptions is not null || value.Interpretations.Count is < 2 or > 5) Invalid("场景分析必须包含 2～5 个方向。");
        var distinctStrategyCount = Math.Min(3, value.Interpretations.Count);
        if (value.Interpretations.Take(distinctStrategyCount).Select(item => item.VisualStrategy).Distinct().Count() < distinctStrategyCount) Invalid("前三个观看方向（不足三个时为全部方向）必须使用不同视觉策略。");
        if (value.Interpretations.Select(item => item.Title.Trim()).Distinct(StringComparer.Ordinal).Count() != value.Interpretations.Count) Invalid("观看方向标题不得重复。");
        var directionSignatures = value.Interpretations.Select(item => string.Join('|',
            item.VisualStrategy,
            item.ViewWidth,
            item.Viewpoint.Orientation,
            string.Join(',', item.Grounding.Elements.Order(StringComparer.Ordinal))));
        if (directionSignatures.Distinct(StringComparer.Ordinal).Count() != value.Interpretations.Count) Invalid("观看方向必须有不同的画面依据或取景变量，不得重复凑数。");

        foreach (var item in value.Interpretations)
        {
            if (item is null || item.Grounding is null || item.Viewpoint is null || item.Keep is null || item.Reduce is null || item.FieldSteps is null) Invalid("观看方向包含空的必填对象。");
            Text(item.Id, 3, 40, "方向编号");
            if (!IdPattern().IsMatch(item.Id)) Invalid("方向编号格式不正确。");
            Text(item.Title, 2, 40, "方向标题");
            Text(item.Intention, 2, 160, "方向意图");
            Text(item.ViewingQuestion, 6, 180, "观看问题");
            if (!StrategyValues.Contains(item.VisualStrategy) || !ViewWidthValues.Contains(item.ViewWidth)) Invalid("观看方向枚举不正确。");
            if (item.Grounding.Elements.Count is < 2 or > 4 || item.Grounding.Elements.Distinct().Count() != item.Grounding.Elements.Count) Invalid("观看方向必须包含 2～4 个不同画面元素。");
            foreach (var element in item.Grounding.Elements) Text(element, 1, 80, "画面元素");
            Text(item.Grounding.Relationship, 4, 180, "元素关系");
            Text(item.Grounding.IntentConnection, 4, 180, "吸引点联系");
            if (item.Grounding.Elements.Count(element => item.Grounding.Relationship.Contains(element, StringComparison.Ordinal)) < 2) Invalid("元素关系必须直接点名至少两个画面元素。");
            if (item.Grounding.Elements.Count(element => item.ViewingQuestion.Contains(element, StringComparison.Ordinal)) < 2 || !item.ViewingQuestion.Contains('？')) Invalid("观看问题必须点名至少两个画面元素并使用问句。");
            if (item.Keep.Count is < 1 or > 6 || item.Reduce.Count > 6 || item.FieldSteps.Count is < 2 or > 3) Invalid("方向的保留、弱化或现场步骤数量不正确。");
            foreach (var text in item.Keep) Text(text, 1, 80, "保留内容");
            foreach (var text in item.Reduce) Text(text, 1, 80, "弱化内容");
            ValidateViewpoint(item.Viewpoint, request.MovementFreedom);
            foreach (var step in item.FieldSteps)
            {
                if (step is null) Invalid("现场步骤不能为空。");
                Text(step.Action, 4, 100, "现场动作");
                Text(step.Check, 4, 120, "现场检查");
                if (TechnicalInstruction().IsMatch(step.Action + step.Check)) Invalid("现场步骤不得包含具体相机或曝光设置。");
            }
            Text(item.FramingPlan, 4, 180, "构图与取景方案");
            Text(item.DepthOfFieldIntent, 2, 160, "景深意图");
            Text(item.MotionIntent, 2, 160, "运动意图");
            Text(item.HighlightShadowIntent, 2, 180, "高光阴影意图");
            Text(item.Uncertainty, 2, 180, "方向不确定性");
            Text(item.VisualEffect, 2, 240, "可见效果");
            Text(item.Tradeoffs, 2, 240, "方向取舍");
            if (item.EquivalentFocalHintMm is { } focal && (focal.Min is < 8 or > 800 || focal.Max is < 8 or > 800 || focal.Min > focal.Max)) Invalid("等效焦段范围不正确。");
            if (item.SuggestedCrop is { } crop && (crop.Length != 4 || crop.Any(number => number is < 0 or > 1) || crop[2] <= 0 || crop[3] <= 0 || crop[0] + crop[2] > 1.000001 || crop[1] + crop[3] > 1.000001)) Invalid("建议取景框不正确。");
            var userText = string.Join(' ', item.Title, item.Intention, item.ViewingQuestion, item.VisualEffect, item.Tradeoffs, item.Grounding.Relationship, item.Grounding.IntentConnection);
            if (JudgeLanguage().IsMatch(userText)) Invalid("观看方向包含裁判式、公式化或无依据叙事语言。");
        }
    }

    private static void ValidateObservations(SceneObservations observations)
    {
        if (observations is null || observations.AttentionCandidates is null || observations.VisualRelations is null || observations.SpatialLayers is null || observations.Uncertainties is null || observations.Light is null)
            Invalid("观察结果包含空的必填对象。");
        Text(observations.Summary, 1, 400, "观察摘要");
        if (observations.AttentionCandidates.Count is < 1 or > 6 || observations.VisualRelations.Count is < 1 or > 8 || observations.SpatialLayers.Count > 6 || observations.Uncertainties.Count > 8 || observations.FactualConfidence is < 0 or > 1) Invalid("观察字段范围不正确。");
        foreach (var candidate in observations.AttentionCandidates)
        {
            if (candidate is null) Invalid("关注元素不能为空。");
            Text(candidate.Label, 1, 80, "关注元素");
            Text(candidate.Evidence, 1, 240, "关注依据");
            if (candidate.Confidence is < 0 or > 1) Invalid("关注置信度不正确。");
            ValidateCrop(candidate.Region);
        }
        foreach (var relation in observations.VisualRelations)
        {
            if (relation is null || relation.Elements is null || relation.Elements.Count is < 2 or > 3 || relation.Elements.Distinct(StringComparer.Ordinal).Count() != relation.Elements.Count || !RelationValues.Contains(relation.Relation) || relation.Confidence is < 0 or > 1) Invalid("可见关系字段不正确。");
            foreach (var element in relation.Elements) Text(element, 1, 80, "可见关系元素");
            Text(relation.Evidence, 4, 220, "可见关系依据");
        }
        foreach (var layer in observations.SpatialLayers) Text(layer, 1, 100, "空间层次");
        foreach (var uncertainty in observations.Uncertainties) Text(uncertainty, 1, 180, "观察不确定性");
        if (!LightDirectionValues.Contains(observations.Light.Direction) || !LightLevelValues.Contains(observations.Light.Contrast) || !LightLevelValues.Contains(observations.Light.HighlightRisk))
            Invalid("光线观察枚举不正确。");
    }

    private static void ValidateTechnical(TechnicalObservations value)
    {
        if (value is null) Invalid("技术观察不能为空。");
        if (!(new[] { "static", "subtle", "significant", "unknown" }).Contains(value.Motion)
            || !(new[] { "low", "medium", "high", "unknown" }).Contains(value.DynamicRange)
            || !(new[] { "stable", "changing", "unknown" }).Contains(value.LightChange)
            || value.Confidence is < 0 or > 1 || value.Notes?.Count > 6) Invalid("技术观察字段不正确。");
        if (value.Notes is not null) foreach (var note in value.Notes) Text(note, 1, 180, "技术观察说明");
    }

    private static void ValidateViewpoint(Viewpoint viewpoint, MovementFreedom? movement)
    {
        if (viewpoint is null) Invalid("机位信息不能为空。");
        if (!HeightValues.Contains(viewpoint.Height) || !LateralValues.Contains(viewpoint.Lateral) || !DistanceValues.Contains(viewpoint.Distance) || !OrientationValues.Contains(viewpoint.Orientation)) Invalid("机位枚举不正确。");
        Text(viewpoint.Description, 2, 180, "机位说明");
        Text(viewpoint.ViewfinderCheck, 2, 180, "取景器检查");
        if (movement is null || !movement.Height) if (viewpoint.Height is not ("similar" or "unknown")) Invalid("机位高度超出用户允许范围。");
        if (movement is null || !movement.Lateral) if (viewpoint.Lateral is not ("similar" or "unknown")) Invalid("左右机位超出用户允许范围。");
        if (movement is null || !movement.ForwardBackward) if (viewpoint.Distance is not ("similar" or "unknown")) Invalid("前后机位超出用户允许范围。");
    }

    private static void ValidateCrop(double[]? crop)
    {
        if (crop is null) return;
        if (crop.Length != 4 || crop.Any(number => number is < 0 or > 1) || crop[2] <= 0 || crop[3] <= 0 || crop[0] + crop[2] > 1.000001 || crop[1] + crop[3] > 1.000001) Invalid("观察区域不正确。");
    }

    private static void Length(string? value, int max, string label)
    {
        if (value?.Length > max) throw new ApiException(400, "INVALID_REQUEST", $"{label}不能超过 {max} 个字符。");
    }

    private static void Text(string? value, int min, int max, string label)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length < min || value.Length > max) Invalid($"{label}长度不正确。");
    }

    [DoesNotReturn]
    private static void Invalid(string message) => throw new ProviderOutputException(message);

    [GeneratedRegex("^[a-z0-9_-]{3,40}$")]
    private static partial Regex IdPattern();

    [GeneratedRegex("(?:F\\d|ISO|快门|光圈|白平衡|RAW|直方图|ND ?\\d|\\d+mm)", RegexOptions.IgnoreCase)]
    private static partial Regex TechnicalInstruction();

    [GeneratedRegex("(?:最佳|必须|构图错误|三分法|黄金分割|九宫格|视觉中心|生命力|压迫感|电影感|故事感)")]
    private static partial Regex JudgeLanguage();
}

public sealed class ProviderOutputException(string message, string? candidate = null, string stage = "analysis") : Exception(message)
{
    public string? Candidate { get; } = candidate;
    public string Stage { get; } = stage;
}
