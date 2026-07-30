using System.Text.Json;
using Zhaojian.Api.Contracts;

namespace Zhaojian.Api.Tests;

public sealed class SkillContractResourceTests
{
    [Fact]
    public void Skill_Definition_Example_Deserializes_With_Strict_Snake_Case_Contract()
    {
        var value = Load<SkillDefinitionContract>("skill-definition.example.json");

        Assert.Equal("1.0", value.SchemaVersion);
        Assert.Equal("observe-scene", value.SkillId);
        Assert.Equal("candidate", value.Status);
        Assert.Contains("vision", value.ProviderRequirements.Capabilities);
        Assert.StartsWith("sha256:", value.ContentHash);
    }

    [Fact]
    public void Training_Examples_Keep_Traceability_And_Model_Roles()
    {
        var dataset = Load<SkillTrainingDatasetContract>("skill-training-dataset.example.json");
        var trainingRun = Load<SkillTrainingRunContract>("skill-training-run.example.json");
        var artifact = Load<SkillTrainingArtifactContract>("skill-training-artifact.example.json");
        var report = Load<SkillTrainingReportContract>("skill-training-report.example.json");
        var roleOutput = Load<SkillTrainingRoleOutputContract>("skill-training-role-output.example.json");
        var evaluation = Load<SkillEvaluationReportContract>("skill-evaluation-report.example.json");

        Assert.Equal(dataset.Assets.Count, dataset.SplitCounts.Total);
        Assert.All(dataset.Assets, asset =>
        {
            Assert.StartsWith("https://", asset.SourceUrl.AbsoluteUri);
            Assert.StartsWith("sha256:", asset.ContentHash);
        });
        Assert.Contains(report.RoleRuns, roleRun => roleRun.Role == "critic");
        Assert.Contains(report.RoleRuns, roleRun => roleRun.Role == "red_team");
        Assert.Equal("1.1", trainingRun.SchemaVersion);
        Assert.Equal("1.5", report.SchemaVersion);
        Assert.Equal(9, report.Metrics.Count);
        Assert.Equal(trainingRun.Selection.SelectedAssetCount, trainingRun.Items.Count);
        Assert.Equal(trainingRun.Selection.ContentHash, trainingRun.Configuration.SelectionHash);
        Assert.Empty(trainingRun.CallRecords);
        Assert.Equal(report.Selection.ContentHash, report.RunConfiguration.SelectionHash);
        Assert.Equal(report.Budget.ProviderCalls, report.Telemetry.ProviderCalls);
        Assert.Equal(5, trainingRun.Items[0].RoleArtifacts.Count);
        Assert.Equal("mock-unpriced", trainingRun.Budget.PricingVersion);
        Assert.All(trainingRun.Items[0].RoleArtifacts, role => Assert.Equal(0, role.Usage.Calls));
        Assert.True(artifact.MockOnly);
        Assert.False(artifact.EligibleForTraining);
        Assert.All(report.RoleRuns, roleRun => Assert.Equal("mock_fixture", roleRun.IndependenceLevel));
        Assert.Equal("direction_generator", roleOutput.Role);
        Assert.Equal("2.0", roleOutput.SchemaVersion);
        Assert.NotNull(roleOutput.Result.DirectionDecision);
        Assert.Equal("options", roleOutput.Result.DirectionDecision.Outcome);
        Assert.Single(roleOutput.Result.DirectionDecision.Options);
        Assert.Equal("light_color", roleOutput.Result.DirectionDecision.Options[0].Strategy);
        Assert.Equal(1, roleOutput.Usage.Calls);
        Assert.DoesNotContain(report.Metrics, metric => metric.Dimension.Contains("aesthetic", StringComparison.OrdinalIgnoreCase));
        Assert.Equal(9, evaluation.Metrics.Count);
        Assert.All(evaluation.Gates, gate => Assert.True(gate.Passed));
        Assert.Null(evaluation.ShadowObservationId);
        Assert.True(evaluation.EligibleForShadow);
        Assert.False(evaluation.EligibleForActivation);
    }

    [Fact]
    public void Creative_And_Post_Process_Contracts_Preserve_Human_Choice()
    {
        var intent = Load<CreativeIntentContract>("creative-intent.example.json");
        var observation = Load<FinalPhotoObservationDraftContract>("final-photo-observation.example.json");
        var plan = Load<PostProcessPlanDraftContract>("post-process-plan.example.json");

        Assert.NotEmpty(intent.Tradeoffs);
        Assert.All(intent.SkillVersions, version => Assert.StartsWith("sha256:", version.ContentHash));
        Assert.NotNull(intent.GearSnapshot);
        Assert.True(intent.GearSnapshot.CropFactor > 0);
        Assert.Equal("draft", observation.ContractStatus);
        Assert.Equal("draft", plan.ContractStatus);
        Assert.InRange(plan.Alternatives.Count, 1, 3);
        Assert.All(plan.Alternatives, alternative =>
        {
            Assert.True(alternative.Reversible);
            Assert.NotEmpty(alternative.Tradeoffs);
        });
    }

    [Theory]
    [InlineData("skill-definition.schema.json")]
    [InlineData("skill-evaluation-report.schema.json")]
    [InlineData("skill-registry-state.schema.json")]
    [InlineData("skill-training-dataset.schema.json")]
    [InlineData("skill-training-splits.schema.json")]
    [InlineData("skill-training-artifact.schema.json")]
    [InlineData("skill-training-run.schema.json")]
    [InlineData("skill-training-report.schema.json")]
    [InlineData("skill-training-role-output.schema.json")]
    [InlineData("creative-intent.schema.json")]
    [InlineData("final-photo-observation.schema.json")]
    [InlineData("post-process-plan.schema.json")]
    public void Skill_Schema_Resources_Are_Published_With_The_Api(string fileName)
    {
        var path = Path.Combine(AppContext.BaseDirectory, "Data", fileName);

        Assert.True(File.Exists(path), $"缺少已发布的契约资源：{path}");
        using var document = JsonDocument.Parse(File.ReadAllText(path));
        Assert.Equal("https://json-schema.org/draft/2020-12/schema", document.RootElement.GetProperty("$schema").GetString());
        Assert.False(document.RootElement.GetProperty("additionalProperties").GetBoolean());
    }

    private static T Load<T>(string fileName)
    {
        var path = Path.Combine(AppContext.BaseDirectory, "Data", fileName);
        return JsonSerializer.Deserialize<T>(File.ReadAllText(path), SceneJson.Provider)
            ?? throw new InvalidOperationException($"无法读取契约示例：{fileName}");
    }
}
