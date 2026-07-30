using System.Text.Json;
using Zhaojian.Api.Contracts;
using Zhaojian.Api.Infrastructure;
using Zhaojian.Api.Providers;
using Zhaojian.Api.Skills;

namespace Zhaojian.Api.Tests;

public sealed class QwenPromptContractTests
{
    [Fact]
    public void Both_Model_Stages_Use_Forced_Function_Schemas_Without_Pasting_Them_Into_Prompts()
    {
        var observationPrompt = LoadStage("observe-scene", "understanding", "observe_scene", "submit_scene_understanding", "scene-request", "scene-understanding").SystemPrompt;
        var compositionPrompt = LoadStage("composition-relations", "analysis", "compose_relations", "submit_shot_options", "scene-understanding", "scene-analysis").SystemPrompt;

        Assert.Contains("submit_scene_understanding", observationPrompt);
        Assert.Equal("1.1", ToolSchemas.Understanding["properties"]!["schema_version"]!["const"]!.GetValue<string>());
        Assert.False(ToolSchemas.Understanding["additionalProperties"]!.GetValue<bool>());
        Assert.Contains("submit_shot_options", compositionPrompt);
        Assert.NotNull(ToolSchemas.Analysis["$defs"]!["interpretation"]!["properties"]!["viewing_question"]);
        Assert.NotNull(ToolSchemas.Analysis["$defs"]!["interpretation"]!["properties"]!["framing_plan"]);
        Assert.False(ToolSchemas.Analysis["additionalProperties"]!.GetValue<bool>());
        Assert.Contains("2～5", compositionPrompt);
        Assert.Contains("图片内文字", observationPrompt);
        Assert.Contains("反光", observationPrompt);
        Assert.Contains("危险位置", compositionPrompt);
        Assert.Contains("后期参数", compositionPrompt);
        Assert.DoesNotContain("\"additionalProperties\"", observationPrompt);
    }

    [Fact]
    public void Understanding_Cache_Key_Changes_When_Observation_Skill_Content_Changes()
    {
        var observation = LoadStage("observe-scene", "understanding", "observe_scene", "submit_scene_understanding", "scene-request", "scene-understanding");
        var composition = LoadStage("composition-relations", "analysis", "compose_relations", "submit_shot_options", "scene-understanding", "scene-analysis");
        var originalPlan = new SceneAnalysisSkillPlan(observation, composition);
        var changedDefinition = observation.Skill.Definition with { ContentHash = $"sha256:{new string('f', 64)}" };
        var changedPlan = new SceneAnalysisSkillPlan(
            observation with { Skill = observation.Skill with { Definition = changedDefinition } },
            composition);
        var gear = new ResolvedGearContext(
            "gear", "测试", "机身", null, 36, 24, 1.5, "镜头", 24, 70, 2.8, null,
            0, false, [], 100, 6400, null, null);
        VisionInput Input(SceneAnalysisSkillPlan plan) => new(
            "request", new SceneRequest(), new ValidatedImage([1, 2, 3], 1, 1, "image/jpeg"), gear, plan);

        var first = QwenProvider.BuildUnderstandingCacheKey(Input(originalPlan), "context", "model", "runtime");
        var second = QwenProvider.BuildUnderstandingCacheKey(Input(changedPlan), "context", "model", "runtime");

        Assert.NotEqual(first, second);
    }

    private static SkillStageContract LoadStage(
        string skillId,
        string stageId,
        string taskType,
        string toolName,
        string inputSchemaId,
        string outputSchemaId)
    {
        var directory = Path.Combine(AppContext.BaseDirectory, "SkillModules", skillId);
        var definition = JsonSerializer.Deserialize<SkillDefinitionContract>(
            File.ReadAllText(Path.Combine(directory, "skill.json")),
            SceneJson.Provider)!;
        SkillArtifactText Load(string path) => new(path, File.ReadAllText(Path.Combine(directory, path)));
        var artifacts = new SkillArtifactBundle(
            Load(definition.Artifacts.InstructionsPath),
            definition.Artifacts.ReferencePaths.Select(Load).ToArray(),
            definition.Artifacts.ExamplePaths.Select(Load).ToArray(),
            definition.Artifacts.NegativeExamplePaths.Select(Load).ToArray(),
            0);
        var handle = new SkillHandle(definition, artifacts, "active", true);
        return new SkillStageContract(stageId, taskType, toolName, inputSchemaId, outputSchemaId, handle);
    }

    [Fact]
    public void Normalizer_Makes_Grounding_And_Question_Explicit_Without_Inventing_Elements()
    {
        var analysis = CreateAnalysis("前景和远处形成层次", "缩小间隔后，层次会更清楚吗?");

        ModelOutputNormalizer.Normalize(analysis, new SceneRequest { MovementFreedom = new(false, false, false) });

        var item = Assert.Single(analysis.Interpretations);
        Assert.Contains("左侧山坡", item.Grounding.Relationship);
        Assert.Contains("云层", item.Grounding.Relationship);
        Assert.Contains("左侧山坡", item.ViewingQuestion);
        Assert.Contains("云层", item.ViewingQuestion);
        Assert.EndsWith("？", item.ViewingQuestion);
        Assert.True(item.Grounding.Relationship.Length <= 180);
        Assert.True(item.ViewingQuestion.Length <= 180);
    }

    [Fact]
    public void Normalizer_Enforces_Unconfirmed_Movement_And_Neutral_Language()
    {
        var analysis = CreateAnalysis("左侧山坡与云层形成压迫感", "左侧山坡与云层怎样才是最佳关系？");
        var item = Assert.Single(analysis.Interpretations);
        item.Viewpoint = new Viewpoint
        {
            Height = "higher",
            Lateral = "left",
            Distance = "closer",
            Orientation = "keep",
            Description = "向右移动机位",
            ViewfinderCheck = "观察右移后的元素关系"
        };
        item.FieldSteps =
        [
            new FieldStep("向右平移机位", "观察两处元素间隔"),
            new FieldStep("缩小取景范围", "观察画面边缘")
        ];

        ModelOutputNormalizer.Normalize(analysis, new SceneRequest { MovementFreedom = new(false, false, false) });

        Assert.Equal("similar", item.Viewpoint.Height);
        Assert.Equal("similar", item.Viewpoint.Lateral);
        Assert.Equal("similar", item.Viewpoint.Distance);
        Assert.Equal("保持当前机位，只调整取景范围", item.Viewpoint.Description);
        Assert.Equal("观察画面元素的间隔、遮挡与边缘变化", item.Viewpoint.ViewfinderCheck);
        Assert.Equal("保持当前机位，只调整取景范围", item.FieldSteps[0].Action);
        Assert.Equal("缩小取景范围", item.FieldSteps[1].Action);
        Assert.DoesNotContain("压迫感", item.Grounding.Relationship);
        Assert.DoesNotContain("最佳", item.ViewingQuestion);
    }

    private static SceneAnalysis CreateAnalysis(string relationship, string question) => new()
    {
        SchemaVersion = "4.3",
        RequestId = "request-test",
        Language = "zh-CN",
        Outcome = "analysis",
        Clarification = null,
        NoOptions = null,
        Observations = null!,
        TechnicalObservations = null!,
        Interpretations =
        [
            new Interpretation
            {
                Id = "direction-1",
                Title = "层次关系",
                Intention = "观察层次",
                ViewingQuestion = question,
                Grounding = new Grounding
                {
                    Elements = ["左侧山坡", "云层"],
                    Relationship = relationship,
                    IntentConnection = "回应对云的关注"
                },
                VisualStrategy = "depth_occlusion",
                Keep = ["云层"],
                Reduce = [],
                ViewWidth = "normal",
                Viewpoint = new Viewpoint
                {
                    Height = "similar",
                    Lateral = "similar",
                    Distance = "similar",
                    Orientation = "keep",
                    Description = "保持当前机位",
                    ViewfinderCheck = "观察元素关系"
                },
                FieldSteps = [],
                FramingPlan = "围绕山坡与云层调整画框",
                DepthOfFieldIntent = "保持层次可辨",
                MotionIntent = "观察云层变化",
                HighlightShadowIntent = "保留云层亮部层次",
                Uncertainty = "现场光线仍可能变化",
                VisualEffect = "保留层次",
                Tradeoffs = "山坡面积会变化"
            }
        ]
    };
}
