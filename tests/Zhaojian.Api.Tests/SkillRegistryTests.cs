using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Zhaojian.Api.Contracts;
using Zhaojian.Api.Infrastructure;
using Zhaojian.Api.Skills;

namespace Zhaojian.Api.Tests;

public sealed class SkillRegistryTests
{
    [Fact]
    public async Task Lifecycle_Transitions_Are_Atomic_And_Persisted()
    {
        using var fixture = new SkillRegistryFixture();
        fixture.AddVersion("observe-scene", "1.1.0", "candidate");
        var registry = fixture.CreateRegistry();

        await registry.ReloadAsync();
        Assert.Equal("1.0.0", registry.GetRequiredActive("observe-scene").Definition.SkillVersion);

        var candidateEvaluation = fixture.WriteEvaluationReport("observe-scene", "1.1.0", "candidate");
        await registry.PromoteToShadowAsync("observe-scene", "1.1.0", candidateEvaluation, Change("shadow"));
        var shadowEvaluation = fixture.WriteEvaluationReport("observe-scene", "1.1.0", "shadow");
        await registry.ActivateAsync("observe-scene", "1.1.0", shadowEvaluation, Change("activate"));
        Assert.Equal("1.1.0", registry.GetRequiredActive("observe-scene").Definition.SkillVersion);
        Assert.Equal("shadow", registry.List().Single(value =>
            value.Definition.SkillId == "observe-scene" && value.Definition.SkillVersion == "1.0.0").EffectiveStatus);

        await registry.RollbackAsync("observe-scene", Change("rollback"));
        Assert.Equal("1.0.0", registry.GetRequiredActive("observe-scene").Definition.SkillVersion);

        var reloaded = fixture.CreateRegistry();
        await reloaded.ReloadAsync();
        Assert.Equal("1.0.0", reloaded.GetRequiredActive("observe-scene").Definition.SkillVersion);
        Assert.Equal("shadow", reloaded.List().Single(value => value.Definition.SkillVersion == "1.1.0").EffectiveStatus);

        await reloaded.SetCloudSkillsEnabledAsync(false, Change("disable"));
        var disabled = fixture.CreateRegistry();
        await disabled.ReloadAsync();
        Assert.False(disabled.CloudSkillsEnabled);
        Assert.Equal(4, disabled.Revision);
        Assert.Collection(
            disabled.AuditLog,
            entry => Assert.Equal("shadow", entry.Action),
            entry => Assert.Equal("activate", entry.Action),
            entry => Assert.Equal("rollback", entry.Action),
            entry => Assert.Equal("disable", entry.Action));
        Assert.All(disabled.AuditLog.Take(2), entry => Assert.NotNull(entry.EvaluationReportHash));
        Assert.Throws<ApiException>(() => disabled.GetRequiredActive("observe-scene"));
    }

    [Fact]
    public async Task Release_Report_Is_Required_For_The_Exact_Lifecycle_Phase()
    {
        using var fixture = new SkillRegistryFixture();
        fixture.AddVersion("observe-scene", "1.1.0", "candidate");
        var registry = fixture.CreateRegistry();
        await registry.ReloadAsync();
        var candidateEvaluation = fixture.WriteEvaluationReport("observe-scene", "1.1.0", "candidate");

        await registry.PromoteToShadowAsync(
            "observe-scene",
            "1.1.0",
            candidateEvaluation,
            Change("shadow"));
        var error = await Assert.ThrowsAsync<SkillRegistryException>(() =>
            registry.ActivateAsync(
                "observe-scene",
                "1.1.0",
                candidateEvaluation,
                Change("activate")));

        Assert.Contains("shadow 阶段", error.Message);
        Assert.Equal("1.0.0", registry.GetRequiredActive("observe-scene").Definition.SkillVersion);
        Assert.Equal(1, registry.Revision);

        var shadowEvaluation = fixture.WriteEvaluationReport("observe-scene", "1.1.0", "shadow");
        var tampered = JsonNode.Parse(File.ReadAllText(shadowEvaluation))!.AsObject();
        tampered["reason"] = "报告生成后被修改，但没有重新签入内容哈希。";
        File.WriteAllText(shadowEvaluation, tampered.ToJsonString(SceneJson.Provider));
        var hashError = await Assert.ThrowsAsync<SkillRegistryException>(() =>
            registry.ActivateAsync(
                "observe-scene",
                "1.1.0",
                shadowEvaluation,
                Change("activate")));

        Assert.Contains("内容哈希不匹配", hashError.Message);
        Assert.Equal(1, registry.Revision);
    }

    [Fact]
    public async Task Release_Gate_Recomputes_Baseline_Metrics_And_Telemetry()
    {
        using var fixture = new SkillRegistryFixture();
        fixture.AddVersion("observe-scene", "1.1.0", "candidate");
        var registry = fixture.CreateRegistry();
        await registry.ReloadAsync();

        var wrongBaseline = fixture.WriteEvaluationReport("observe-scene", "1.1.0", "candidate");
        fixture.RewriteEvaluationReport(wrongBaseline, report =>
        {
            report["baseline_skill"]!.AsObject()["version"] = "9.9.9";
        });
        var baselineError = await Assert.ThrowsAsync<SkillRegistryException>(() =>
            registry.PromoteToShadowAsync(
                "observe-scene",
                "1.1.0",
                wrongBaseline,
                Change("shadow")));
        Assert.Contains("当前活动 Skill", baselineError.Message);

        var falseMetric = fixture.WriteEvaluationReport("observe-scene", "1.1.0", "candidate");
        fixture.RewriteEvaluationReport(falseMetric, report =>
        {
            report["metrics"]!.AsArray()[0]!.AsObject()["candidate_value"] = 0;
            report["metrics"]!.AsArray()[0]!.AsObject()["delta"] = -1;
        });
        var metricError = await Assert.ThrowsAsync<SkillRegistryException>(() =>
            registry.PromoteToShadowAsync(
                "observe-scene",
                "1.1.0",
                falseMetric,
                Change("shadow")));
        Assert.Contains("九维指标", metricError.Message);

        var excessiveCost = fixture.WriteEvaluationReport("observe-scene", "1.1.0", "candidate");
        fixture.RewriteEvaluationReport(excessiveCost, report =>
        {
            report["telemetry"]!.AsObject()["candidate"]!.AsObject()["cost_per_successful_call"] = 1;
        });
        var telemetryError = await Assert.ThrowsAsync<SkillRegistryException>(() =>
            registry.PromoteToShadowAsync(
                "observe-scene",
                "1.1.0",
                excessiveCost,
                Change("shadow")));
        Assert.Contains("成本或延迟", telemetryError.Message);
        Assert.Equal(0, registry.Revision);
    }

    [Fact]
    public async Task Invalid_Content_Hash_Does_Not_Replace_Last_Good_Snapshot()
    {
        using var fixture = new SkillRegistryFixture();
        var registry = fixture.CreateRegistry();
        await registry.ReloadAsync();
        var expected = registry.GetRequiredActive("observe-scene").Definition.ContentHash;

        await File.AppendAllTextAsync(
            Path.Combine(fixture.RootPath, "observe-scene", "instructions.md"),
            "\n未经版本更新的篡改。\n");

        await Assert.ThrowsAsync<SkillRegistryException>(() => registry.ReloadAsync());
        Assert.Equal(expected, registry.GetRequiredActive("observe-scene").Definition.ContentHash);
    }

    [Fact]
    public async Task Unsupported_Major_Version_Is_Rejected()
    {
        using var fixture = new SkillRegistryFixture();
        fixture.AddVersion("observe-scene", "2.0.0", "candidate");

        await Assert.ThrowsAsync<SkillRegistryException>(() => fixture.CreateRegistry().ReloadAsync());
    }

    [Fact]
    public async Task Legacy_Registry_State_Is_Migrated_Without_Inventing_Audit_Events()
    {
        using var fixture = new SkillRegistryFixture();
        fixture.WriteLegacyState();
        var registry = fixture.CreateRegistry();

        await registry.ReloadAsync();

        Assert.Equal(0, registry.Revision);
        Assert.Empty(registry.AuditLog);
        using var state = JsonDocument.Parse(File.ReadAllText(fixture.StatePath));
        Assert.Equal("1.1", state.RootElement.GetProperty("schema_version").GetString());
        Assert.Equal(0, state.RootElement.GetProperty("revision").GetInt64());
        Assert.Empty(state.RootElement.GetProperty("audit_log").EnumerateArray());
    }

    [Fact]
    public async Task Mutation_Rebases_On_The_Latest_Cross_Process_State()
    {
        using var fixture = new SkillRegistryFixture();
        var firstProcess = fixture.CreateRegistry();
        var staleSecondProcess = fixture.CreateRegistry();
        await firstProcess.ReloadAsync();
        await staleSecondProcess.ReloadAsync();

        await firstProcess.SetCloudSkillsEnabledAsync(false, Change("disable"));
        await staleSecondProcess.SetCloudSkillsEnabledAsync(true, Change("enable"));

        var reloaded = fixture.CreateRegistry();
        await reloaded.ReloadAsync();
        Assert.True(reloaded.CloudSkillsEnabled);
        Assert.Equal(2, reloaded.Revision);
        Assert.Collection(
            reloaded.AuditLog,
            entry => Assert.Equal("disable", entry.Action),
            entry => Assert.Equal("enable", entry.Action));
    }

    [Fact]
    public async Task Tampered_Audit_Transition_Is_Rejected()
    {
        using var fixture = new SkillRegistryFixture();
        var registry = fixture.CreateRegistry();
        await registry.ReloadAsync();
        await registry.SetCloudSkillsEnabledAsync(false, Change("disable"));

        var state = JsonNode.Parse(File.ReadAllText(fixture.StatePath))!.AsObject();
        state["audit_log"]!.AsArray()[0]!.AsObject()["action"] = "activate";
        File.WriteAllText(fixture.StatePath, state.ToJsonString(SceneJson.Provider));

        var error = await Assert.ThrowsAsync<SkillRegistryException>(() =>
            fixture.CreateRegistry().ReloadAsync());
        Assert.Contains("审计状态不正确", error.Message);
    }

    [Fact]
    public async Task Exact_Snapshot_Resolves_Immutable_Artifact_Content()
    {
        using var fixture = new SkillRegistryFixture();
        var registry = fixture.CreateRegistry();
        await registry.ReloadAsync();
        var active = registry.GetRequiredActive("observe-scene");
        var snapshot = new SkillVersionSnapshot(
            active.Definition.SkillId,
            active.Definition.SkillVersion,
            active.Definition.ContentHash);
        var loadedInstructions = active.Artifacts.Instructions.Content;

        await File.AppendAllTextAsync(
            Path.Combine(fixture.RootPath, "observe-scene", "instructions.md"),
            "\n运行期间的磁盘替换不应进入已加载制品。\n");

        Assert.Equal(loadedInstructions, registry.GetRequiredVersion(snapshot).Artifacts.Instructions.Content);
        var mismatch = snapshot with { ContentHash = $"sha256:{new string('0', 64)}" };
        var error = Assert.Throws<ApiException>(() => registry.GetRequiredVersion(mismatch));
        Assert.Equal("SKILL_VERSION_UNAVAILABLE", error.Code);
    }

    [Fact]
    public async Task Planner_Forces_Both_Core_Stages_And_Restores_The_Task_Snapshot()
    {
        using var fixture = new SkillRegistryFixture();
        var registry = fixture.CreateRegistry();
        await registry.ReloadAsync();
        var planner = new SkillExecutionPlanner(registry);

        var created = planner.CreateSceneAnalysisPlan();
        var restored = planner.RestoreSceneAnalysisPlan(created.Snapshots.Reverse().ToArray());

        Assert.Equal("observe-scene", restored.Observation.Skill.Definition.SkillId);
        Assert.Equal("submit_scene_understanding", restored.Observation.ToolName);
        Assert.Equal("composition-relations", restored.Composition.Skill.Definition.SkillId);
        Assert.Equal("submit_shot_options", restored.Composition.ToolName);
        Assert.Contains("不能跳过、替换或自行选择其他 Skill", restored.Observation.SystemPrompt);
        var error = Assert.Throws<ApiException>(() =>
            planner.RestoreSceneAnalysisPlan([created.Snapshots[0]]));
        Assert.Equal("SKILL_SNAPSHOT_INVALID", error.Code);
    }

    [Fact]
    public async Task Registry_Rejects_Artifact_Bundle_Over_The_Deployment_Limit()
    {
        using var fixture = new SkillRegistryFixture();
        fixture.ExpandInstructionsAndRehash("observe-scene", 8 * 1024);

        await Assert.ThrowsAsync<SkillRegistryException>(() =>
            fixture.CreateRegistry(maxBundleBytes: 4096).ReloadAsync());
    }

    [Fact]
    public async Task Registry_Rejects_Symbolic_Link_In_Artifact_Directory_Chain()
    {
        using var fixture = new SkillRegistryFixture();
        var references = Path.Combine(fixture.RootPath, "observe-scene", "references");
        var external = Path.Combine(fixture.ExternalPath, "references");
        Directory.CreateDirectory(external);
        File.Copy(Path.Combine(references, "visual-relations.md"), Path.Combine(external, "visual-relations.md"));
        Directory.Delete(references, recursive: true);
        Directory.CreateSymbolicLink(references, external);

        await Assert.ThrowsAsync<SkillRegistryException>(() => fixture.CreateRegistry().ReloadAsync());
    }

    private sealed class SkillRegistryFixture : IDisposable
    {
        private readonly string _fixturePath = Path.Combine(Path.GetTempPath(), $"zhaojian-skill-tests-{Guid.NewGuid():N}");
        private readonly string _sourcePath = Path.Combine(AppContext.BaseDirectory, "SkillModules");

        public SkillRegistryFixture()
        {
            RootPath = Path.Combine(_fixturePath, "modules");
            StatePath = Path.Combine(_fixturePath, "state", "registry.json");
            EvaluationRootPath = Path.Combine(_fixturePath, "evaluations");
            CopyDirectory(_sourcePath, RootPath);
            Directory.CreateDirectory(EvaluationRootPath);
        }

        public string RootPath { get; }
        public string StatePath { get; }
        public string EvaluationRootPath { get; }
        public string ExternalPath => Path.Combine(_fixturePath, "external");

        public FileSkillRegistry CreateRegistry(int maxBundleBytes = 256 * 1024) =>
            new(
                Options.Create(new SkillRegistryOptions
                {
                    RootPath = RootPath,
                    StatePath = StatePath,
                    EvaluationRootPath = EvaluationRootPath,
                    RuntimeVersion = "1.0.0",
                    CloudSkillsEnabled = true,
                    MaxBundleBytes = maxBundleBytes
                }),
                new TestHostEnvironment { ContentRootPath = _fixturePath },
                NullLogger<FileSkillRegistry>.Instance);

        public string WriteEvaluationReport(string skillId, string version, string phase)
        {
            var baseline = LoadDefinition(Path.Combine(RootPath, skillId, "skill.json"));
            var candidatePath = Path.Combine(RootPath, skillId, version, "skill.json");
            var candidate = LoadDefinition(candidatePath);
            var report = new SkillEvaluationReportContract(
                "1.0",
                $"evaluation_{phase}_{Guid.NewGuid():N}",
                phase,
                "passed",
                new VersionedArtifactReference(baseline.SkillId, baseline.SkillVersion, baseline.ContentHash),
                new VersionedArtifactReference(candidate.SkillId, candidate.SkillVersion, candidate.ContentHash),
                new SkillEvaluationSource(
                    "report_baseline_fixture",
                    "run_baseline_fixture",
                    $"sha256:{new string('1', 64)}",
                    "report_candidate_fixture",
                    "run_candidate_fixture",
                    $"sha256:{new string('2', 64)}",
                    "mock",
                    "training-mock-v1",
                    "1.0.0",
                    "1.1.0",
                    "mock-unpriced",
                    candidate.EvaluationSetVersion),
                new SkillEvaluationDataset(
                    "photography-skill-v3",
                    "3.0.0",
                    "sha256:887c338ab37c715e087822db8d73d7253485dbcc522f5126b573c57f31efb335",
                    $"sha256:{new string('4', 64)}"),
                new SkillEvaluationComparisonConfig("1.0.0", 0.2m, 0.2m, 0.25m, true),
                EvaluationMetrics(),
                [
                    new("training", 36, 0, 0, 0, true),
                    new("regression", 12, 0, 0, 0, true),
                    new("holdout", 12, 0, 0, 0, true)
                ],
                EvaluationGates(phase),
                [],
                new SkillEvaluationTelemetry(
                    new(0, 0, 0, 0),
                    new(0, 0, 0, 0)),
                phase == "shadow" ? "run_candidate_fixture" : null,
                phase == "candidate",
                phase == "shadow",
                "registry_test",
                "验证候选发布报告与生命周期阶段严格绑定。",
                $"npm run skill:{(phase == "candidate" ? "shadow" : "promote")}",
                DateTimeOffset.UtcNow,
                "passed",
                "sha256:pending");
            var pendingBytes = JsonSerializer.SerializeToUtf8Bytes(report, SceneJson.Provider);
            report = report with { ContentHash = SkillContentHasher.ComputeDocument(pendingBytes) };
            var path = Path.Combine(EvaluationRootPath, $"{report.EvaluationId}.json");
            File.WriteAllText(path, JsonSerializer.Serialize(report, SceneJson.Provider));
            return path;
        }

        public void RewriteEvaluationReport(string path, Action<JsonObject> mutate)
        {
            var report = JsonNode.Parse(File.ReadAllText(path))!.AsObject();
            mutate(report);
            report["content_hash"] = "sha256:pending";
            var pendingBytes = JsonSerializer.SerializeToUtf8Bytes(report, SceneJson.Provider);
            report["content_hash"] = SkillContentHasher.ComputeDocument(pendingBytes);
            File.WriteAllText(path, report.ToJsonString(SceneJson.Provider));
        }

        public void AddVersion(string skillId, string version, string status)
        {
            var destination = Path.Combine(RootPath, skillId, version);
            CopyDirectory(Path.Combine(_sourcePath, skillId), destination);
            var definitionPath = Path.Combine(destination, "skill.json");
            var node = JsonNode.Parse(File.ReadAllText(definitionPath))!.AsObject();
            node["skill_version"] = version;
            node["status"] = status;
            node["content_hash"] = "sha256:pending";
            File.WriteAllText(definitionPath, node.ToJsonString(SceneJson.Provider));
            var definition = JsonSerializer.Deserialize<SkillDefinitionContract>(
                File.ReadAllText(definitionPath),
                SceneJson.Provider)!;
            node["content_hash"] = SkillContentHasher.Compute(definitionPath, definition);
            File.WriteAllText(definitionPath, node.ToJsonString(SceneJson.Provider));
        }

        public void ExpandInstructionsAndRehash(string skillId, int additionalBytes)
        {
            var definitionPath = Path.Combine(RootPath, skillId, "skill.json");
            var node = JsonNode.Parse(File.ReadAllText(definitionPath))!.AsObject();
            File.AppendAllText(
                Path.Combine(RootPath, skillId, "instructions.md"),
                new string('测', additionalBytes));
            node["content_hash"] = "sha256:pending";
            File.WriteAllText(definitionPath, node.ToJsonString(SceneJson.Provider));
            var definition = JsonSerializer.Deserialize<SkillDefinitionContract>(
                File.ReadAllText(definitionPath),
                SceneJson.Provider)!;
            node["content_hash"] = SkillContentHasher.Compute(definitionPath, definition);
            File.WriteAllText(definitionPath, node.ToJsonString(SceneJson.Provider));
        }

        public void WriteLegacyState()
        {
            Directory.CreateDirectory(Path.GetDirectoryName(StatePath)!);
            File.WriteAllText(StatePath, JsonSerializer.Serialize(new
            {
                schema_version = "1.0",
                cloud_skills_enabled = true,
                statuses = new Dictionary<string, string>
                {
                    ["observe-scene@1.0.0"] = "active",
                    ["composition-relations@1.0.0"] = "active"
                },
                active_versions = new Dictionary<string, string>
                {
                    ["observe-scene"] = "1.0.0",
                    ["composition-relations"] = "1.0.0"
                },
                rollback_versions = new Dictionary<string, string>(),
                updated_at = DateTimeOffset.UtcNow
            }, SceneJson.Provider));
        }

        private static SkillDefinitionContract LoadDefinition(string path) =>
            JsonSerializer.Deserialize<SkillDefinitionContract>(
                File.ReadAllText(path),
                SceneJson.Provider) ?? throw new InvalidOperationException("Skill 测试定义无法读取。");

        private static IReadOnlyList<SkillEvaluationMetric> EvaluationMetrics() =>
        [
            new("json_parse_rate", "higher", 1, 1, 0, 0.95, true),
            new("serious_hallucination_rate", "lower", 0, 0, 0, 0, true),
            new("intent_response_rate", "higher", 1, 1, 0, 0.9, true),
            new("direction_difference_rate", "higher", 1, 1, 0, 0.8, true),
            new("grounding_rate", "higher", 1, 1, 0, 0.9, true),
            new("clarification_effectiveness_rate", "higher", 1, 1, 0, 0.8, true),
            new("field_executability_rate", "higher", 1, 1, 0, 0.85, true),
            new("gear_feasibility_rate", "higher", 1, 1, 0, 0.95, true),
            new("judge_language_rate", "lower", 0, 0, 0, 0, true)
        ];

        private static IReadOnlyList<SkillEvaluationGate> EvaluationGates(string phase) =>
        [
            new("provenance_complete", true, "来源完整。"),
            new("dataset_comparable", true, "数据集可比较。"),
            new("skill_content_integrity", true, "资源哈希完整。"),
            new("historical_compatibility", true, "历史合同兼容。"),
            new("fixed_regression", true, "固定回归通过。"),
            new("holdout_regression", true, "保留集通过。"),
            new("serious_failure_regression", true, "没有新增严重失败。"),
            new("cost_limit", true, "成本没有超限。"),
            new("latency_limit", true, "延迟没有超限。"),
            new("rollback_ready", true, "回滚目标完整。"),
            new("shadow_observation", true, phase == "shadow" ? "shadow 观察已绑定。" : "当前阶段不要求 shadow。")
        ];

        public void Dispose()
        {
            if (Directory.Exists(_fixturePath)) Directory.Delete(_fixturePath, recursive: true);
        }

        private static void CopyDirectory(string source, string destination)
        {
            foreach (var sourcePath in Directory.EnumerateFiles(source, "*", SearchOption.AllDirectories))
            {
                var relativePath = Path.GetRelativePath(source, sourcePath);
                var destinationPath = Path.Combine(destination, relativePath);
                Directory.CreateDirectory(Path.GetDirectoryName(destinationPath)!);
                File.Copy(sourcePath, destinationPath, overwrite: true);
            }
        }
    }

    private static SkillMutationContext Change(string command) =>
        new("registry_test", "验证 Skill 生命周期与审计记录保持一致。", $"npm run skill:{command}");

    private sealed class TestHostEnvironment : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = Environments.Development;
        public string ApplicationName { get; set; } = nameof(Zhaojian);
        public string ContentRootPath { get; set; } = string.Empty;
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }
}
