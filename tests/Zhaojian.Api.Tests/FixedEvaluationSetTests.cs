using System.Text.Json;
using Zhaojian.Api.Contracts;
using Zhaojian.Api.Providers;

namespace Zhaojian.Api.Tests;

public sealed class FixedEvaluationSetTests
{
    [Fact]
    [Trait("Category", "FixedEvaluation")]
    public void Evaluation_Manifest_Is_Versioned_Diverse_And_Does_Not_Define_Aesthetic_Scores()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "fixtures", "evaluation", "evaluation-set.v1.json");
        using var document = JsonDocument.Parse(File.ReadAllText(path));
        var root = document.RootElement;
        Assert.StartsWith("evaluation-v1-", root.GetProperty("version").GetString());
        var cases = root.GetProperty("cases").EnumerateArray().ToArray();
        Assert.True(cases.Length >= 12);
        Assert.Equal(cases.Length, cases.Select(value => value.GetProperty("id").GetString()).Distinct(StringComparer.Ordinal).Count());
        Assert.Contains(cases, value => value.GetProperty("allowedOutcomes").EnumerateArray().Any(outcome => outcome.GetString() == "no_options"));
        Assert.Contains(cases, value => value.GetProperty("allowedOutcomes").EnumerateArray().Any(outcome => outcome.GetString() == "clarification"));
        foreach (var item in cases)
        {
            Assert.True(item.GetProperty("expectedElements").GetArrayLength() >= 1);
            Assert.DoesNotContain("score", item.GetRawText(), StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("最佳", item.GetRawText(), StringComparison.Ordinal);
        }
    }

    [Fact]
    [Trait("Category", "FixedEvaluation")]
    public void Every_Fixed_Case_Executes_The_Runtime_Normalizer_And_Contract_Rules()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "fixtures", "evaluation", "evaluation-set.v1.json");
        using var document = JsonDocument.Parse(File.ReadAllText(path));
        var validator = new SceneContractValidator();
        foreach (var item in document.RootElement.GetProperty("cases").EnumerateArray())
        {
            var allowed = item.GetProperty("allowedOutcomes").EnumerateArray().Select(value => value.GetString()).ToHashSet(StringComparer.Ordinal);
            var elements = item.GetProperty("expectedElements").EnumerateArray().Select(value => value.GetString()!).ToList();
            var request = new SceneRequest { MovementFreedom = Movement(item.GetProperty("movement")) };
            var analysis = allowed.Contains("analysis") ? AnalysisCandidate(item.GetProperty("id").GetString()!, elements) : NoOptionsCandidate(elements);

            ModelOutputNormalizer.Normalize(analysis, request);
            validator.ValidateAnalysis(analysis, request);

            if (analysis.Outcome == "analysis")
            {
                Assert.All(analysis.Interpretations, direction => Assert.Contains(elements[0], direction.Grounding.Elements));
            }
            else
            {
                Assert.Contains(analysis.Outcome, allowed);
            }
        }
    }

    private static MovementFreedom Movement(JsonElement values)
    {
        var allowed = values.EnumerateArray().Select(value => value.GetString()).ToHashSet(StringComparer.Ordinal);
        return new MovementFreedom(allowed.Contains("forwardBackward"), allowed.Contains("lateral"), allowed.Contains("height"));
    }

    private static SceneAnalysis AnalysisCandidate(string id, List<string> expected)
    {
        var first = expected[0];
        var second = expected.Skip(1).FirstOrDefault() ?? "画面边缘";
        var analysis = Base("analysis");
        analysis.Interpretations = [
            Direction($"{id}-a", "depth_occlusion", first, second, "观察层次"),
            Direction($"{id}-b", "negative_space", first, second, "观察疏密")
        ];
        return analysis;
    }

    private static SceneAnalysis NoOptionsCandidate(List<string> expected)
    {
        var analysis = Base("no_options");
        analysis.NoOptions = new NoOptionsResult
        {
            Reason = "当前不足以形成两种可靠且不同的观看方向。",
            Evidence = [$"目前只能确认{expected[0]}这一处具体依据。"],
            NextStep = "可以补充另一处能够确认的画面元素。"
        };
        return analysis;
    }

    private static SceneAnalysis Base(string outcome) => new()
    {
        SchemaVersion = "4.3", RequestId = "evaluation-runtime", Language = "zh-CN", Outcome = outcome,
        Observations = new SceneObservations
        {
            Summary = "固定评测场景",
            AttentionCandidates = [new AttentionCandidate { Label = "场景元素", Evidence = "评测清单明确给出", Confidence = 1 }],
            VisualRelations = [new VisualRelation { Elements = ["场景元素", "画面边缘"], Relation = "separation", Evidence = "两处关系可现场核对", Confidence = 1 }],
            SpatialLayers = [], Light = new LightObservation { Direction = "unknown", Contrast = "unknown", HighlightRisk = "unknown" },
            Uncertainties = [], FactualConfidence = 1
        },
        Interpretations = [],
        TechnicalObservations = new TechnicalObservations { Motion = "unknown", DynamicRange = "unknown", LightChange = "unknown", Confidence = 1 }
    };

    private static Interpretation Direction(string id, string strategy, string first, string second, string intention) => new()
    {
        Id = id, Title = $"{first}与{second}·{intention}", Intention = $"{intention}中的{first}",
        ViewingQuestion = $"{first}与{second}的间隔变化后，哪种关系更接近你的关注？",
        Grounding = new Grounding { Elements = [first, second], Relationship = $"{first}与{second}之间形成可观察的间隔", IntentConnection = $"直接回应对{first}的关注" },
        VisualStrategy = strategy, Keep = [first], Reduce = [second], ViewWidth = "normal",
        Viewpoint = new Viewpoint { Height = "similar", Lateral = "similar", Distance = "similar", Orientation = "keep", Description = "保持当前机位", ViewfinderCheck = $"观察{first}与{second}的关系" },
        FieldSteps = [new("保持当前机位并调整画框", $"观察{first}与{second}的间隔"), new("改变一次取景范围", $"检查{first}是否仍然回应关注")],
        FramingPlan = $"围绕{first}与{second}调整画框", DepthOfFieldIntent = "保持两处关系可辨", MotionIntent = "观察现场变化",
        HighlightShadowIntent = "保留可见层次", Uncertainty = "现场边缘关系仍需确认", VisualEffect = $"让{first}与{second}的关系更明确", Tradeoffs = $"可能减少{second}周围的环境"
    };
}
