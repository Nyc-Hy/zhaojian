using System.Diagnostics;
using System.Text.Json;
using Zhaojian.Api.Contracts;
using Zhaojian.Api.Infrastructure;

namespace Zhaojian.Api.Providers;

public sealed class MockProvider(SceneContractValidator validator) : IVisionProvider
{
    public string Name => "mock";
    public string Model => "context-demo-v3";
    public string PromptVersion => "mock-context-v3";
    public ProviderStatusResponse Status => new(true, Name, Model, "mock", "本地 Mock 只演示流程，不会识别上传图片；内容来自固定示例和你填写的信息。配置 Qwen 后才会进行真实图像分析。");

    public async Task<ProviderResult> AnalyzeAsync(VisionInput input, CancellationToken cancellationToken)
    {
        var started = Stopwatch.GetTimestamp();
        EnsureStagePrompt(input.SkillPlan.Observation.SystemPrompt, input.SkillPlan.Observation.ToolName);
        EnsureStagePrompt(input.SkillPlan.Composition.SystemPrompt, input.SkillPlan.Composition.ToolName);
        var path = Path.Combine(AppContext.BaseDirectory, "Data", "mock-scene-analysis.example.json");
        await using var stream = File.OpenRead(path);
        var analysis = await JsonSerializer.DeserializeAsync<SceneAnalysis>(stream, SceneJson.Provider, cancellationToken)
            ?? throw new ProviderOutputException("Mock 场景分析示例无法读取。");
        var focus = FirstText(input.Request.Intent, input.Request.AttentionOption);
        var scene = Clean(input.Request.SceneDescription, 160);
        var environment = Clean(input.Request.EnvironmentNotes, 120);
        var mood = Clean(input.Request.DesiredMood, 60);
        var movement = input.Request.MovementFreedom;

        if (focus is not null)
        {
            analysis.Observations.AttentionCandidates[0] = new AttentionCandidate
            {
                Label = focus,
                Evidence = "依据来自用户填写的吸引点，不是图像识别。",
                Confidence = 0
            };
        }
        analysis.Observations.Summary = scene is not null
            ? $"你补充的现场内容是：“{scene}”。本地 Mock 不读取上传图片，无法核验这段描述；以下方向只用于演示流程。"
            : "本地 Mock 只演示产品流程，不读取上传图片的内容。以下方向来自固定示例，并会有限引用你填写的文字，不能视为对当前照片的识别结果。";
        if (environment is not null)
        {
            analysis.TechnicalObservations.Notes ??= [];
            AppendUnique(analysis.TechnicalObservations.Notes, $"用户补充的现场环境是“{environment}”；Mock 未从图片核验。");
        }

        var understanding = new SceneUnderstanding
        {
            SchemaVersion = "1.1",
            RequestId = input.RequestId,
            Language = "zh-CN",
            Observations = analysis.Observations,
            TechnicalObservations = analysis.TechnicalObservations
        };
        await Task.Delay(225, cancellationToken);
        validator.ValidateUnderstanding(understanding);
        if (input.ReportStatus is not null)
        {
            await input.ReportStatus(Data.AnalysisTaskStatuses.Generating, cancellationToken);
        }

        foreach (var item in analysis.Interpretations)
        {
            AppendUnique(item.Keep, Clean(input.Request.MustKeep, 80));
            if (item.Reduce.Count > 0) AppendUnique(item.Reduce, Clean(input.Request.CanReduce, 80));
            if (mood is not null) item.Intention = $"{item.Intention} 你希望接近的感受是“{mood}”。";
            if (focus is not null) item.Grounding.IntentConnection = $"这个演示方向从你填写的“{focus}”出发；Mock 无法确认它在图片中的真实关系。";
            if (item.Grounding.Elements.Count >= 2 && item.Grounding.Elements.Any(element => !item.Grounding.Relationship.Contains(element, StringComparison.Ordinal)))
            {
                item.Grounding.Relationship = $"{item.Grounding.Elements[0]}与{item.Grounding.Elements[1]}的可见关系是：{item.Grounding.Relationship}";
            }
        }

        var closer = analysis.Interpretations[1].Viewpoint;
        closer.Distance = movement?.ForwardBackward is true ? "closer" : "similar";
        closer.Description = movement?.ForwardBackward is true
            ? "在安全可达的前提下，可以相对参考图稍微靠近；高度和左右位置先保持相近，再用较窄视角观察。"
            : "你没有声明可以前后移动，因此保持与参考图相近的距离、高度和左右位置，只用较窄视角观察。";
        var layering = analysis.Interpretations[2].Viewpoint;
        layering.Height = movement?.Height is true ? "lower" : "unknown";
        layering.Lateral = movement?.Lateral is true ? "left" : "unknown";
        layering.Distance = movement?.ForwardBackward is true ? "farther" : "unknown";
        layering.Description = movement is { Height: true } or { Lateral: true } or { ForwardBackward: true }
            ? $"只在安全可达的位置尝试{(movement.Height ? "略低机位" : "相近高度")}、{(movement.Lateral ? "偏左观察" : "相近左右位置")}、{(movement.ForwardBackward ? "略微退远" : "相近距离")}，用来测试前后层次。"
            : "你没有声明可以改变机位，因此保持在参考图位置附近，只把层次方向作为取景练习。";

        analysis.RequestId = input.RequestId;
        await Task.Delay(225, cancellationToken);
        validator.ValidateAnalysis(analysis, input.Request);
        var duration = Stopwatch.GetElapsedTime(started).TotalMilliseconds;
        var timing = new ProviderTiming(0, (long)duration, false);
        return new ProviderResult(analysis, Name, Model, (long)duration, false, timing, new ProviderUsage(0, 0, 0, 0));
    }

    private static string? FirstText(params string?[] values) => values.Select(value => Clean(value, 80)).FirstOrDefault(value => value is not null);
    private static string? Clean(string? value, int max) => string.IsNullOrWhiteSpace(value) ? null : value.Trim()[..Math.Min(value.Trim().Length, max)];
    private static void AppendUnique(List<string> values, string? value)
    {
        if (value is not null && !values.Contains(value, StringComparer.Ordinal)) values.Add(value);
    }

    private static void EnsureStagePrompt(string prompt, string toolName)
    {
        if (string.IsNullOrWhiteSpace(prompt)
            || !prompt.Contains(toolName, StringComparison.Ordinal)
            || !prompt.Contains("不能跳过、替换或自行选择其他 Skill", StringComparison.Ordinal))
        {
            throw new ApiException(
                StatusCodes.Status503ServiceUnavailable,
                "SKILL_STAGE_INCOMPATIBLE",
                "Mock 无法执行不完整的 Skill 阶段计划。");
        }
    }
}
