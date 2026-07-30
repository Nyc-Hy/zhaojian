using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Options;
using Zhaojian.Api.Contracts;
using Zhaojian.Api.Infrastructure;
using Zhaojian.Api.Services;
using Zhaojian.Api.Skills;

namespace Zhaojian.Api.Providers;

public sealed class QwenProvider : IVisionProvider
{
    public const string HttpClientName = "qwen";
    private const string PromptVersionValue = "skill-runtime-v1";
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly IAfterUnderstandingHook _afterUnderstanding;
    private readonly IAfterShotOptionsHook _afterShotOptions;
    private readonly QwenOptions _options;
    private readonly ILogger<QwenProvider> _logger;
    private readonly ConcurrentDictionary<string, CacheEntry> _understandingCache = new(StringComparer.Ordinal);
    private readonly object _cacheLock = new();

    public QwenProvider(IHttpClientFactory httpClientFactory, IAfterUnderstandingHook afterUnderstanding, IAfterShotOptionsHook afterShotOptions, IOptions<ModelOptions> options, ILogger<QwenProvider> logger)
    {
        _httpClientFactory = httpClientFactory;
        _afterUnderstanding = afterUnderstanding;
        _afterShotOptions = afterShotOptions;
        _options = options.Value.Qwen;
        _logger = logger;
    }

    public string Name => "qwen";
    public string Model => _options.Model;
    public string PromptVersion => PromptVersionValue;
    public ProviderStatusResponse Status => string.IsNullOrWhiteSpace(_options.ApiKey)
        ? new(false, "mock", "context-demo-v3", "mock", "真实模型暂不可用，已降级为本地示例：Qwen 密钥未配置。")
        : new(true, Name, Model, "live", "千问视觉服务已配置，将结合参考图与用户补充进行观察。");

    public async Task<ProviderResult> AnalyzeAsync(VisionInput input, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(_options.ApiKey))
        {
            throw new ApiException(StatusCodes.Status503ServiceUnavailable, "MODEL_NOT_CONFIGURED", "Qwen 密钥未配置。");
        }

        var totalStarted = Stopwatch.GetTimestamp();
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(_options.TimeoutSeconds));
        try
        {
            var observationContext = BuildObservationContext(input.Request);
            var observationStage = input.SkillPlan.Observation;
            var observationSystem = observationStage.SystemPrompt;
            var cacheKey = BuildUnderstandingCacheKey(input, observationContext, Model, PromptVersion);
            var understandingStarted = Stopwatch.GetTimestamp();
            var cacheHit = TryReadUnderstanding(cacheKey, out var understanding);
            var usage = ProviderUsageZero();
            if (!cacheHit)
            {
                var understandingCompletion = await CompleteAsync(
                    observationSystem,
                    BuildImageMessage(input.Image, observationContext),
                    0.1,
                    observationStage.ToolName,
                    ToolSchemas.Understanding,
                    timeout.Token);
                usage = AddUsage(usage, understandingCompletion.Usage);
                understanding = await ParseValidateRepairAsync<SceneUnderstanding>(
                    understandingCompletion.Content,
                    "understanding",
                    observationSystem,
                    observationStage.ToolName,
                    ToolSchemas.Understanding,
                    timeout.Token,
                    _afterUnderstanding.Apply,
                    usageHolder => usage = AddUsage(usage, usageHolder),
                    "保持画面观察事实与不确定性不变。仅使用 Schema 允许的字段。");
                understanding.RequestId = input.RequestId;
                CacheUnderstanding(cacheKey, understanding);
            }
            var understandingMs = (long)Stopwatch.GetElapsedTime(understandingStarted).TotalMilliseconds;

            var directionStarted = Stopwatch.GetTimestamp();
            if (input.ReportStatus is not null) await input.ReportStatus(Data.AnalysisTaskStatuses.Generating, timeout.Token);
            var directionText = BuildDirectionText(understanding!, input.Request, input.Gear);
            var compositionStage = input.SkillPlan.Composition;
            var compositionSystem = compositionStage.SystemPrompt;
            var directionCompletion = await CompleteAsync(
                compositionSystem,
                TextMessage(directionText),
                0.2,
                compositionStage.ToolName,
                ToolSchemas.Analysis,
                timeout.Token);
            usage = AddUsage(usage, directionCompletion.Usage);
            var analysis = await ParseValidateRepairAsync<SceneAnalysis>(
                directionCompletion.Content,
                "analysis",
                compositionSystem,
                compositionStage.ToolName,
                ToolSchemas.Analysis,
                timeout.Token,
                candidate =>
                {
                    _afterShotOptions.Apply(candidate, understanding!, input.Request);
                },
                usageHolder => usage = AddUsage(usage, usageHolder),
                $"机位约束：{MovementRules(input.Request)}。保持已校验画面理解中的元素与关系，不新增画面事实。");
            analysis.RequestId = input.RequestId;
            analysis.Observations = understanding!.Observations;
            analysis.TechnicalObservations = understanding.TechnicalObservations;
            _afterShotOptions.Apply(analysis, understanding!, input.Request);

            var directionMs = (long)Stopwatch.GetElapsedTime(directionStarted).TotalMilliseconds;
            var durationMs = (long)Stopwatch.GetElapsedTime(totalStarted).TotalMilliseconds;
            return new ProviderResult(analysis, Name, Model, durationMs, false, new ProviderTiming(understandingMs, directionMs, cacheHit), usage);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw new ApiException(StatusCodes.Status504GatewayTimeout, "MODEL_TIMEOUT", $"真实模型在 {_options.TimeoutSeconds} 秒内没有完成，可以稍后重试。");
        }
        catch (ProviderOutputException)
        {
            throw new ApiException(StatusCodes.Status502BadGateway, "MODEL_INVALID_OUTPUT", "模型连续两次返回了无法安全使用的结构，请稍后重试。");
        }
        catch (JsonException)
        {
            throw new ApiException(StatusCodes.Status502BadGateway, "MODEL_INVALID_OUTPUT", "模型供应商响应格式不完整，请稍后重试。");
        }
        catch (HttpRequestException)
        {
            throw new ApiException(StatusCodes.Status503ServiceUnavailable, "MODEL_UPSTREAM_ERROR", "暂时无法连接模型供应商，请稍后重试。");
        }
    }

    private async Task<T> ParseValidateRepairAsync<T>(string content, string stage, string system, string toolName, JsonNode toolSchema, CancellationToken cancellationToken, Action<T> validate, Action<ProviderUsage> addUsage, string repairConstraints)
    {
        try
        {
            var value = Deserialize<T>(content, stage);
            validate(value);
            return value;
        }
        catch (Exception error) when (error is JsonException or ProviderOutputException)
        {
            var feedback = error.Message.Length > 500 ? error.Message[..500] : error.Message;
            _logger.LogWarning("Qwen {Stage} 首轮输出未通过契约：{ValidationReason}", stage, feedback);
            var candidate = content.Length > 100_000 ? content[..100_000] : content;
            var repairText = $"""
                下面的 {stage} JSON 没有通过契约校验。只修复结构、必填字段、枚举、范围和明确指出的业务规则；不要增加图片中无法确认的事实。
                必须严格使用指定函数参数 Schema 的字段名，不得输出额外字段。
                校验原因：{feedback}
                不可更改约束：{repairConstraints}
                待修复候选 JSON：
                {candidate}
                """;
            var repair = await CompleteAsync(system, TextMessage(repairText), 0, toolName, toolSchema, cancellationToken);
            addUsage(repair.Usage);
            try
            {
                var repaired = Deserialize<T>(repair.Content, stage);
                validate(repaired);
                return repaired;
            }
            catch (Exception repairError) when (repairError is JsonException or ProviderOutputException)
            {
                var repairFeedback = repairError.Message.Length > 500 ? repairError.Message[..500] : repairError.Message;
                _logger.LogWarning("Qwen {Stage} 修复输出仍未通过契约：{ValidationReason}", stage, repairFeedback);
                throw new ProviderOutputException($"{stage} 修复后仍未通过契约：{repairFeedback}", stage: stage);
            }
        }
    }

    private T Deserialize<T>(string content, string stage)
    {
        try
        {
            return JsonSerializer.Deserialize<T>(content, SceneJson.Provider)
                ?? throw new ProviderOutputException($"{stage} 返回为空。", content, stage);
        }
        catch (JsonException error)
        {
            var escaped = EscapeControlCharactersInsideStrings(content);
            if (!string.Equals(escaped, content, StringComparison.Ordinal))
            {
                try
                {
                    return JsonSerializer.Deserialize<T>(escaped, SceneJson.Provider)
                        ?? throw new ProviderOutputException($"{stage} 返回为空。", content, stage);
                }
                catch (JsonException) { }
            }
            throw new ProviderOutputException($"{stage} 不是符合契约的 JSON：{error.Message}", content, stage);
        }
    }

    private static string EscapeControlCharactersInsideStrings(string json)
    {
        var builder = new StringBuilder(json.Length + 32);
        var inString = false;
        var escaped = false;
        foreach (var character in json)
        {
            if (!inString)
            {
                builder.Append(character);
                if (character == '"') inString = true;
                continue;
            }
            if (escaped) { builder.Append(character); escaped = false; continue; }
            if (character == '\\') { builder.Append(character); escaped = true; continue; }
            if (character == '"') { builder.Append(character); inString = false; continue; }
            builder.Append(character switch { '\n' => "\\n", '\r' => "\\r", '\t' => "\\t", _ => character.ToString() });
        }
        return builder.ToString();
    }

    private async Task<Completion> CompleteAsync(string system, object userContent, double temperature, string toolName, JsonNode toolSchema, CancellationToken cancellationToken)
    {
        var client = _httpClientFactory.CreateClient(HttpClientName);
        using var request = new HttpRequestMessage(HttpMethod.Post, $"{_options.BaseUrl.TrimEnd('/')}/chat/completions");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _options.ApiKey);
        request.Content = JsonContent.Create(new
        {
            model = _options.Model,
            temperature,
            enable_thinking = false,
            tools = new object[] { new { type = "function", function = new { name = toolName, description = "提交经过约束的结构化结果", parameters = toolSchema } } },
            tool_choice = new { type = "function", function = new { name = toolName } },
            messages = new object[]
            {
                new { role = "system", content = system },
                new { role = "user", content = userContent }
            }
        });
        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            throw new ApiException(StatusCodes.Status503ServiceUnavailable, "MODEL_UPSTREAM_ERROR", $"模型供应商返回 {(int)response.StatusCode}，请稍后重试。");
        }
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
        var root = document.RootElement;
        var message = root.GetProperty("choices")[0].GetProperty("message");
        if (!message.TryGetProperty("tool_calls", out var calls) || calls.GetArrayLength() != 1)
            throw new ProviderOutputException($"模型没有调用指定函数 {toolName}。");
        var function = calls[0].GetProperty("function");
        if (!string.Equals(function.GetProperty("name").GetString(), toolName, StringComparison.Ordinal))
            throw new ProviderOutputException($"模型调用了未允许的函数，预期 {toolName}。");
        var content = function.GetProperty("arguments").GetString();
        if (string.IsNullOrWhiteSpace(content)) throw new ProviderOutputException("模型函数参数为空。");
        var promptTokens = root.TryGetProperty("usage", out var usageNode) && usageNode.TryGetProperty("prompt_tokens", out var promptNode) ? promptNode.GetInt32() : 0;
        var completionTokens = root.TryGetProperty("usage", out usageNode) && usageNode.TryGetProperty("completion_tokens", out var completionNode) ? completionNode.GetInt32() : 0;
        var estimated = promptTokens / 1_000_000m * _options.InputPerMillionCny + completionTokens / 1_000_000m * _options.OutputPerMillionCny;
        return new Completion(content, new ProviderUsage(promptTokens, completionTokens, 1, decimal.Round(estimated, 6)));
    }

    internal static string BuildUnderstandingCacheKey(
        VisionInput input,
        string observationContext,
        string model,
        string promptVersion)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        void Add(string value) => hash.AppendData(Encoding.UTF8.GetBytes(value + "\0"));
        Add("scene-understanding@1.1");
        Add(promptVersion);
        Add(model);
        Add(input.SkillPlan.Observation.Skill.Definition.SkillId);
        Add(input.SkillPlan.Observation.Skill.Definition.SkillVersion);
        Add(input.SkillPlan.Observation.Skill.Definition.InstructionVersion);
        Add(input.SkillPlan.Observation.Skill.Definition.ContentHash);
        Add(input.Image.MimeType);
        Add(observationContext);
        hash.AppendData(input.Image.Bytes);
        return Convert.ToHexString(hash.GetHashAndReset());
    }

    private bool TryReadUnderstanding(string key, out SceneUnderstanding? understanding)
    {
        understanding = null;
        if (_options.UnderstandingCacheSeconds == 0) return false;
        var now = DateTimeOffset.UtcNow;
        foreach (var pair in _understandingCache) if (pair.Value.ExpiresAt <= now) _understandingCache.TryRemove(pair.Key, out _);
        if (!_understandingCache.TryGetValue(key, out var cached)) return false;
        understanding = JsonSerializer.Deserialize<SceneUnderstanding>(JsonSerializer.Serialize(cached.Value, SceneJson.Provider), SceneJson.Provider);
        return understanding is not null;
    }

    private void CacheUnderstanding(string key, SceneUnderstanding understanding)
    {
        if (_options.UnderstandingCacheSeconds == 0) return;
        lock (_cacheLock)
        {
            _understandingCache[key] = new CacheEntry(DateTimeOffset.UtcNow.AddSeconds(_options.UnderstandingCacheSeconds), understanding);
            foreach (var oldest in _understandingCache.OrderBy(pair => pair.Value.ExpiresAt).Take(Math.Max(0, _understandingCache.Count - 12)).ToArray()) _understandingCache.TryRemove(oldest.Key, out _);
        }
    }

    private static string BuildObservationContext(SceneRequest request) => JsonSerializer.Serialize(new
    {
        attention = request.Intent,
        attention_option = request.AttentionOption,
        scene_description = request.SceneDescription,
        environment_notes = request.EnvironmentNotes,
        clarification_question = request.ClarificationQuestion,
        clarification_answer = request.ClarificationAnswer,
        photo_technical_context = request.PhotoTechnicalContext
    }, SceneJson.Provider);

    private static string BuildDirectionText(SceneUnderstanding understanding, SceneRequest request, ResolvedGearContext gear) => $"""
        下面是已经通过校验的画面理解：
        {JsonSerializer.Serialize(understanding, SceneJson.Provider)}

        用户创作取舍：{JsonSerializer.Serialize(new { request.MustKeep, request.CanReduce, request.DesiredMood }, SceneJson.Provider)}
        当前账号摄影包（服务端已核对归属）：{JsonSerializer.Serialize(gear, SceneJson.Provider)}
        机位约束：{MovementRules(request)}
        """;

    private static string MovementRules(SceneRequest request)
    {
        var movement = request.MovementFreedom;
        if (movement is null) return "所有高度、左右和距离维度按 similar 或 unknown 处理";
        return string.Join('；',
            movement.ForwardBackward ? "允许前后移动" : "距离必须是 similar 或 unknown",
            movement.Lateral ? "允许左右移动" : "左右必须是 similar 或 unknown",
            movement.Height ? "允许改变高度" : "高度必须是 similar 或 unknown");
    }

    private static object BuildImageMessage(ValidatedImage image, string context) => new object[]
    {
        new { type = "image_url", image_url = new { url = $"data:{image.MimeType};base64,{Convert.ToBase64String(image.Bytes)}" } },
        new { type = "text", text = context }
    };

    private static object TextMessage(string text) => new object[] { new { type = "text", text } };
    private static ProviderUsage ProviderUsageZero() => new(0, 0, 0, 0);
    private static ProviderUsage AddUsage(ProviderUsage left, ProviderUsage right) => new(left.PromptTokens + right.PromptTokens, left.CompletionTokens + right.CompletionTokens, left.Calls + right.Calls, left.EstimatedCostCny + right.EstimatedCostCny);
    private sealed record CacheEntry(DateTimeOffset ExpiresAt, SceneUnderstanding Value);
    private sealed record Completion(string Content, ProviderUsage Usage);
}

internal static partial class ModelOutputNormalizer
{
    private const int RelationshipMaxLength = 180;
    private const int ViewingQuestionMaxLength = 180;

    private static readonly (string From, string To)[] NeutralLanguage =
    [
        ("最佳", "可尝试的"),
        ("必须", "可以"),
        ("构图错误", "画面关系"),
        ("三分法", "元素关系"),
        ("黄金分割", "元素关系"),
        ("九宫格", "元素关系"),
        ("视觉中心", "关注元素"),
        ("生命力", "动态关系"),
        ("压迫感", "紧凑感"),
        ("电影感", "明暗层次"),
        ("故事感", "叙事联想")
    ];

    public static void Normalize(SceneAnalysis analysis, SceneRequest request)
    {
        if (analysis.Outcome != "analysis") return;
        if (analysis.Interpretations is null) throw new ProviderOutputException("观看方向不能为空。");

        foreach (var interpretation in analysis.Interpretations)
        {
            if (interpretation is null || interpretation.Viewpoint is null || interpretation.Grounding?.Elements is null || interpretation.FieldSteps is null
                || interpretation.Title is null || interpretation.Intention is null || interpretation.ViewingQuestion is null
                || interpretation.Grounding.Relationship is null || interpretation.Grounding.IntentConnection is null
                || interpretation.VisualEffect is null || interpretation.Tradeoffs is null)
                throw new ProviderOutputException("观看方向包含空的必填对象。");
            ApplyMovementConstraints(interpretation, request.MovementFreedom);
            var elements = interpretation.Grounding.Elements
                .Where(element => !string.IsNullOrWhiteSpace(element))
                .Distinct(StringComparer.Ordinal)
                .Take(2)
                .ToArray();
            if (elements.Length < 2) continue;

            if (CountMentions(interpretation.Grounding.Relationship, elements) < 2)
            {
                interpretation.Grounding.Relationship = PrefixElements(
                    interpretation.Grounding.Relationship,
                    elements,
                    RelationshipMaxLength,
                    "的关系是");
            }

            if (CountMentions(interpretation.ViewingQuestion, elements) < 2 || !interpretation.ViewingQuestion.Contains('？'))
            {
                var question = PrefixElements(
                    interpretation.ViewingQuestion.TrimEnd('?', '？', '。'),
                    elements,
                    ViewingQuestionMaxLength - 1,
                    "之间，");
                interpretation.ViewingQuestion = question + "？";
            }

            interpretation.Title = Neutralize(interpretation.Title);
            interpretation.Intention = Neutralize(interpretation.Intention);
            interpretation.ViewingQuestion = Neutralize(interpretation.ViewingQuestion);
            interpretation.Grounding.Relationship = Neutralize(interpretation.Grounding.Relationship);
            interpretation.Grounding.IntentConnection = Neutralize(interpretation.Grounding.IntentConnection);
            interpretation.VisualEffect = Neutralize(interpretation.VisualEffect);
            interpretation.Tradeoffs = Neutralize(interpretation.Tradeoffs);
        }
    }

    private static void ApplyMovementConstraints(Interpretation interpretation, MovementFreedom? movement)
    {
        var viewpoint = interpretation.Viewpoint;
        if (movement is null || !movement.Height) viewpoint.Height = "similar";
        if (movement is null || !movement.Lateral) viewpoint.Lateral = "similar";
        if (movement is null || !movement.ForwardBackward) viewpoint.Distance = "similar";

        var viewpointText = $"{viewpoint.Description} {viewpoint.ViewfinderCheck}";
        var viewpointConflicts = (movement is null || !movement.Lateral) && LateralMovement().IsMatch(viewpointText)
            || (movement is null || !movement.Height) && HeightMovement().IsMatch(viewpointText)
            || (movement is null || !movement.ForwardBackward) && DistanceMovement().IsMatch(viewpointText);
        if (viewpointConflicts)
        {
            viewpoint.Description = "保持当前机位，只调整取景范围";
            viewpoint.ViewfinderCheck = "观察画面元素的间隔、遮挡与边缘变化";
        }

        for (var index = 0; index < interpretation.FieldSteps.Count; index++)
        {
            var step = interpretation.FieldSteps[index];
            if (step is null) throw new ProviderOutputException("现场步骤不能为空。");
            var conflicts = (movement is null || !movement.Lateral) && LateralMovement().IsMatch(step.Action)
                || (movement is null || !movement.Height) && HeightMovement().IsMatch(step.Action)
                || (movement is null || !movement.ForwardBackward) && DistanceMovement().IsMatch(step.Action);
            if (conflicts)
            {
                interpretation.FieldSteps[index] = new FieldStep("保持当前机位，只调整取景范围", step.Check);
            }
        }
    }

    private static string Neutralize(string text)
    {
        foreach (var (from, to) in NeutralLanguage)
        {
            text = text.Replace(from, to, StringComparison.Ordinal);
        }
        return text;
    }

    private static int CountMentions(string text, IReadOnlyCollection<string> elements) =>
        elements.Count(element => text.Contains(element, StringComparison.Ordinal));

    private static string PrefixElements(string text, IReadOnlyList<string> elements, int maxLength, string connector)
    {
        var prefix = $"{elements[0]}与{elements[1]}{connector}";
        if (prefix.Length >= maxLength) return prefix[..maxLength];
        var remaining = maxLength - prefix.Length;
        return prefix + (text.Length <= remaining ? text : text[..remaining]);
    }

    [GeneratedRegex("(?:向左|向右|左移|右移|左右).{0,8}(?:机位|移动|平移|挪动)")]
    private static partial Regex LateralMovement();

    [GeneratedRegex("(?:抬高|降低|升高|下蹲|俯身|上移|下移).{0,8}(?:机位|视角|拍摄位置)")]
    private static partial Regex HeightMovement();

    [GeneratedRegex("(?:靠近|远离|前移|后移|向前|向后).{0,8}(?:机位|移动|主体|拍摄位置)")]
    private static partial Regex DistanceMovement();
}

internal static class ToolSchemas
{
    private static readonly Lazy<JsonNode> UnderstandingSchema = new(() => Load("scene-understanding.schema.json"));
    private static readonly Lazy<JsonNode> AnalysisSchema = new(() => Load("scene-analysis.schema.json"));
    public static JsonNode Understanding => UnderstandingSchema.Value.DeepClone();
    public static JsonNode Analysis => AnalysisSchema.Value.DeepClone();

    private static JsonNode Load(string fileName)
    {
        var path = Path.Combine(AppContext.BaseDirectory, "Data", fileName);
        return JsonNode.Parse(File.ReadAllText(path, Encoding.UTF8))
            ?? throw new InvalidOperationException($"无法读取函数参数 Schema：{fileName}");
    }
}
