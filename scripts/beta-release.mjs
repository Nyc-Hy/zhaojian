import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditTrainingRun } from "./training-run-audit.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageDocument = readJson(path.join(repositoryRoot, "package.json"));
const releaseVersion = packageDocument.version;
const defaultReleaseRoot = path.join(repositoryRoot, ".local", "beta-release", releaseVersion);
const knownLimitationsPath = "docs/06-operations/beta-1.0.0-beta.1-known-limitations.md";
const browserRecordPath = "docs/06-operations/beta-browser-smoke-record.md";
const releaseEvidencePath = "docs/06-operations/beta-release-evidence.md";
const defaultLiveTrainingRoot = path.join(repositoryRoot, ".local", "skill-training");
const liveCampaignPath = path.join(repositoryRoot, "config", "skill-live-evaluation-campaign.json");
const liveCampaign = readJson(liveCampaignPath);
const full60Stage = liveCampaign.stages.find((stage) => stage.stage_id === "full60");
if (!full60Stage) throw new Error("真实评测计划缺少 full60 阶段。");
const liveTrainingRoot = resolveLiveTrainingRoot();
const expectedLiveReportPath = path.join(liveTrainingRoot, full60Stage.run_id, "report.json");
const frozenDatasetDirectory = path.join(repositoryRoot, "datasets/photography-skill-v3");
const frozenDatasetManifestPath = path.join(frozenDatasetDirectory, "manifest.json");
const frozenDatasetSplitsPath = path.join(frozenDatasetDirectory, "splits.json");
const expectedCommandIds = [
  "skill_validate",
  "mock_full60",
  "budget_cap_drill",
  "registry_rollback_kill_switch_drill",
  "account_data_lifecycle_drill",
  "offline_verify",
  "fixed_evaluation",
  "skill_registry_audit",
  "release_publish",
  "package_release",
];
const requiredArtifactIds = ["release_bundle", "mock_full60_report"];
const versionFiles = [
  "package.json",
  "apps/web/package.json",
  "packages/parameter-engine/package.json",
  "src/Zhaojian.Api/Zhaojian.Api.csproj",
];

const [command = "", ...rawOptions] = process.argv.slice(2);
if (!["verify", "report"].includes(command)) {
  console.error("用法：node scripts/beta-release.mjs <verify|report> [--output-dir path] [--live-report path] [--live-status missing|not_authorized] [--allow-pending-live]");
  process.exit(2);
}

const options = parseOptions(rawOptions);
const releaseRoot = options["--output-dir"]
  ? path.resolve(repositoryRoot, options["--output-dir"])
  : defaultReleaseRoot;
assertSafeReleaseRoot(releaseRoot);
mkdirSync(releaseRoot, { recursive: true });

let commandResults;
if (command === "verify") {
  verifyVersions();
  commandResults = runOfflineVerification(releaseRoot);
  writeJson(path.join(releaseRoot, "command-results.json"), commandResults);
} else {
  const resultsPath = path.join(releaseRoot, "command-results.json");
  if (!existsSync(resultsPath)) {
    console.error(`缺少离线验证结果：${relative(resultsPath)}。请先运行 npm run beta:prepare。`);
    process.exit(2);
  }
  commandResults = readJson(resultsPath);
}

const liveReportPath = options["--live-report"]
  ? path.resolve(repositoryRoot, options["--live-report"])
  : null;
if (liveReportPath) assertSafeLiveReportPath(liveReportPath);
const liveStatus = options["--live-status"] ?? "missing";
if (!["missing", "not_authorized"].includes(liveStatus)) {
  console.error("--live-status 只支持 missing 或 not_authorized。");
  process.exit(2);
}

const evidence = createEvidence(commandResults, liveReportPath, liveStatus);
const evidencePath = path.join(releaseRoot, "evidence.json");
writeJson(evidencePath, evidence);
console.log(JSON.stringify({
  status: evidence.status,
  release_version: releaseVersion,
  evidence_path: relative(evidencePath),
  blocked_gates: evidence.gates.filter((gate) => gate.status === "blocked").map((gate) => gate.id),
}, null, 2));

const offlineFailed = commandResults.commands.some((entry) => entry.status === "failed");
if (offlineFailed) process.exit(1);
if (evidence.status !== "ready" && !options["--allow-pending-live"]) process.exit(3);

function runOfflineVerification(outputRoot) {
  const logsRoot = path.join(outputRoot, "logs");
  const mockOutput = path.join(outputRoot, "mock-training");
  const publishRoot = path.join(outputRoot, "bundle");
  const archivePath = path.join(outputRoot, `zhaojian-${releaseVersion}.tar.gz`);
  mkdirSync(logsRoot, { recursive: true });
  assertSafeReleasePath(mockOutput);
  rmSync(mockOutput, { recursive: true, force: true });

  const commands = [];
  commands.push(runCommand(
    "skill_validate",
    "npm",
    ["run", "skill:validate"],
    logsRoot,
  ));
  commands.push(runCommand(
    "mock_full60",
    "npm",
    [
      "run",
      "skill:train:mock",
      "--",
      "--manifest",
      frozenDatasetManifestPath,
      "--splits",
      frozenDatasetSplitsPath,
      "--output-dir",
      mockOutput,
      "--run-id",
      `beta_mock_full60_${releaseVersion.replaceAll(".", "_")}`,
    ],
    logsRoot,
  ));
  commands.push(runCommand(
    "budget_cap_drill",
    "npx",
    ["vitest", "run", "tests/skill-trainer.test.ts", "-t", "本地 Live Fixture 按调用租约耗尽预算并保留结构化输出与报告"],
    logsRoot,
    { NODE_ENV: "test", ZHAOJIAN_ENABLE_TRAINING_FIXTURE: "1" },
  ));
  commands.push(runCommand(
    "registry_rollback_kill_switch_drill",
    "dotnet",
    [
      "test",
      "Zhaojian.slnx",
      "-v:minimal",
      "--filter",
      "FullyQualifiedName=Zhaojian.Api.Tests.SkillRegistryTests.Lifecycle_Transitions_Are_Atomic_And_Persisted|FullyQualifiedName=Zhaojian.Api.Tests.SkillRegistryTests.Mutation_Rebases_On_The_Latest_Cross_Process_State",
    ],
    logsRoot,
  ));
  commands.push(runCommand(
    "account_data_lifecycle_drill",
    "dotnet",
    [
      "test",
      "Zhaojian.slnx",
      "-v:minimal",
      "--filter",
      "FullyQualifiedName=Zhaojian.Api.Tests.ApiIntegrationTests.Account_Deletion_Cascades_Personalization_Candidates_Intents_And_Journals|FullyQualifiedName=Zhaojian.Api.Tests.ApiIntegrationTests.Retention_Sweep_Removes_Expired_Image_But_Keeps_Structured_Result|FullyQualifiedName=Zhaojian.Api.Tests.ApiIntegrationTests.Database_Claim_Allows_Only_One_Worker_To_Start_A_Queued_Task",
    ],
    logsRoot,
  ));
  commands.push(runCommand(
    "offline_verify",
    "npm",
    ["run", "verify"],
    logsRoot,
  ));
  commands.push(runCommand(
    "fixed_evaluation",
    "npm",
    ["run", "evaluate:fixed"],
    logsRoot,
  ));
  commands.push(runCommand(
    "skill_registry_audit",
    "npm",
    ["run", "skill:audit"],
    logsRoot,
  ));

  if (commands.some((entry) => entry.status === "failed")) {
    commands.push(skippedCommand("release_publish", "前置离线验证失败，未生成发布目录。", logsRoot));
    commands.push(skippedCommand("package_release", "前置离线验证失败，未打包发布制品。", logsRoot));
    return { commands, artifacts: [], source_content_hash: sourceContentHash() };
  }

  assertSafeReleasePath(publishRoot);
  assertSafeReleasePath(archivePath);
  rmSync(publishRoot, { recursive: true, force: true });
  mkdirSync(path.join(publishRoot, "api"), { recursive: true });
  mkdirSync(path.join(publishRoot, "web"), { recursive: true });
  mkdirSync(path.join(publishRoot, "release-notes"), { recursive: true });
  commands.push(runCommand(
    "release_publish",
    "dotnet",
    [
      "publish",
      "src/Zhaojian.Api/Zhaojian.Api.csproj",
      "-c",
      "Release",
      "--no-restore",
      "-v:minimal",
      "-o",
      path.join(publishRoot, "api"),
    ],
    logsRoot,
  ));
  if (commands.at(-1).status === "passed") {
    cpSync(path.join(repositoryRoot, "apps", "web", "dist"), path.join(publishRoot, "web"), {
      recursive: true,
      force: true,
    });
    for (const documentationPath of [knownLimitationsPath, browserRecordPath, releaseEvidencePath]) {
      const source = path.join(repositoryRoot, documentationPath);
      if (!existsSync(source)) {
        failCommand(commands.at(-1), `缺少发布文档 ${documentationPath}`);
        continue;
      }
      copyFileSync(source, path.join(publishRoot, "release-notes", path.basename(documentationPath)));
    }
    writeFileSync(path.join(publishRoot, "VERSION"), `${releaseVersion}\n`, "utf8");
  }

  let packagedSourceContentHash = sourceContentHash();
  if (commands.at(-1).status === "passed") {
    writeFileSync(path.join(publishRoot, "SOURCE_CONTENT_HASH"), `${packagedSourceContentHash}\n`, "utf8");
    assertSafeReleasePath(archivePath);
    rmSync(archivePath, { force: true });
    commands.push(runCommand(
      "package_release",
      "tar",
      ["-czf", archivePath, "-C", publishRoot, "."],
      logsRoot,
    ));
  } else {
    commands.push(skippedCommand("package_release", "发布目录生成失败，未打包发布制品。", logsRoot));
  }

  const artifacts = [];
  if (existsSync(archivePath) && statSync(archivePath).size > 0) {
    artifacts.push(artifact("release_bundle", archivePath));
  }
  const mockReport = path.join(
    mockOutput,
    `beta_mock_full60_${releaseVersion.replaceAll(".", "_")}`,
    "report.json",
  );
  if (existsSync(mockReport) && statSync(mockReport).size > 0) {
    artifacts.push(artifact("mock_full60_report", mockReport));
  }
  return { commands, artifacts, source_content_hash: packagedSourceContentHash };
}

function createEvidence(results, liveReportPath, pendingStatus) {
  verifyVersions();
  const sourceCommit = git(["rev-parse", "HEAD"]).trim();
  const worktreeDirty = git(["status", "--porcelain"]).trim().length > 0;
  const currentSourceContentHash = sourceContentHash();
  const sourceMatchesArtifacts = results.source_content_hash === currentSourceContentHash;
  const commands = results.commands ?? [];
  const artifactValidation = validateArtifacts(results.artifacts ?? [], results.source_content_hash);
  const artifacts = artifactValidation.artifacts;
  const byId = new Map(commands.map((entry) => [entry.id, entry]));
  const commandPassed = (id) => byId.get(id)?.status === "passed";
  const live = evaluateLiveReport(liveReportPath, pendingStatus);
  const commandIdsValid = commands.length === expectedCommandIds.length
    && commands.every((entry, index) => entry.id === expectedCommandIds[index])
    && new Set(commands.map((entry) => entry.id)).size === expectedCommandIds.length;
  const commandIntegrity = commandIdsValid && commands.every((entry) => {
    const logPath = path.resolve(repositoryRoot, entry.log_path);
    return ((entry.status === "passed") === (entry.exit_code === 0))
      && isWithin(logPath, releaseRoot)
      && existsSync(logPath)
      && !pathHasSymbolicLink(logPath)
      && readFileSync(logPath, "utf8").startsWith(`$ ${entry.command}\n`);
  });
  const allOfflinePassed = commandIdsValid
    && commands.every((entry) => entry.status === "passed")
    && commandIntegrity
    && artifactValidation.valid
    && requiredArtifactIds.every((id) => artifacts.some((entry) => entry.id === id));

  const drills = [
    evidenceItem(
      "budget_cap",
      commandPassed("budget_cap_drill"),
      "本地 Live Fixture 以费用租约耗尽预算，停止新调用并保留结构化角色输出、检查点和终态报告。",
    ),
    evidenceItem(
      "skill_rollback",
      commandPassed("registry_rollback_kill_switch_drill"),
      "候选进入活动版本后可原子回滚；状态重载仍指向旧活动版本，审计 revision 连续。",
    ),
    evidenceItem(
      "cloud_kill_switch",
      commandPassed("registry_rollback_kill_switch_drill"),
      "云端 Skill kill switch 持久化后阻止新的核心 Skill 解析；账号数据与历史制品没有被删除。",
    ),
    evidenceItem(
      "account_data_lifecycle",
      commandPassed("account_data_lifecycle_drill") && commandPassed("offline_verify"),
      "账号注销级联、分析图留存清理、任务原子认领、导出和跨账号资源隔离由 ASP.NET Core 集成测试覆盖。",
    ),
    evidenceItem(
      "fixed_regression",
      commandPassed("fixed_evaluation"),
      "12 个合成固定场景继续验证不凑数、不评分、边界诚实停下和参数守界。",
    ),
  ];

  const gates = [
    evidenceItem("version_consistency", true, `${versionFiles.join("、")} 均为 ${releaseVersion}。`),
    evidenceItem("source_artifact_consistency", sourceMatchesArtifacts, sourceMatchesArtifacts
      ? `发布制品对应当前源码快照 ${currentSourceContentHash}。`
      : "当前源码与生成发布制品时的快照不一致，必须重新运行 beta:prepare。"),
    evidenceItem("offline_engineering", allOfflinePassed, allOfflinePassed
      ? "离线全量验证、60 项 Mock、发布制品打包和注册表只读审计均通过。"
      : "至少一项离线验证、日志完整性、制品哈希或发布打包失败，详见 commands 与 artifacts。"),
    evidenceItem("runtime_drills", drills.every((entry) => entry.status === "passed"), "预算、回滚、kill switch、数据生命周期和固定回归演练必须全部通过。"),
    evidenceItem("real_model_full60", live.status === "passed", live.status === "passed"
      ? `真实运行 ${live.run_id} 覆盖 60 图与 ${live.provider_calls} 次角色调用，九维门禁全部通过。`
      : "60 图真实模型评测尚未形成通过报告；不会用 3 图烟测或 Mock 报告替代。"),
    evidenceItem("single_instance_boundary", true, "制品、状态接口、个人中心和发布说明统一声明 SQLite + 进程内队列 + 内存额度 + SQLite Blob 的单实例边界。"),
  ];
  const status = gates.every((gate) => gate.status === "passed") ? "ready" : "blocked";

  const evidence = {
    schema_version: "1.0",
    release_version: releaseVersion,
    release_scope: "engineering_beta",
    status,
    generated_at: new Date().toISOString(),
    source: {
      git_commit: sourceCommit,
      worktree_dirty: worktreeDirty,
      source_content_hash: currentSourceContentHash,
      version_files: versionFiles,
    },
    deployment: {
      mode: "single_instance",
      database: "sqlite",
      task_queue: "in_process_channel",
      quota_store: "in_memory",
      image_store: "sqlite_blob",
      multi_instance_ready: false,
    },
    commands,
    artifacts,
    drills,
    real_model_evaluation: live,
    manual_records: [
      {
        id: "browser_core_loop",
        status: existsSync(path.join(repositoryRoot, browserRecordPath)) ? "passed" : "deferred",
        evidence: existsSync(path.join(repositoryRoot, browserRecordPath))
          ? `${browserRecordPath} 记录本地 Mock 的真实浏览器账号闭环和 0 条控制台错误。`
          : `缺少 ${browserRecordPath}。`,
      },
      {
        id: "public_store_launch",
        status: "deferred",
        evidence: "真实设备、户外可读性、商店、备案、隐私政策、支付和 72 小时值守属于公开发布 Go/No-Go，不属于工程 Beta；本报告不能代替这些外部签字。",
      },
    ],
    gates,
    known_limitations_path: knownLimitationsPath,
  };
  evidence.content_hash = documentHash(evidence);
  return evidence;
}

function evaluateLiveReport(reportPath, pendingStatus) {
  const empty = {
    status: pendingStatus,
    report_path: null,
    run_id: null,
    provider: null,
    model: null,
    dataset_id: null,
    dataset_version: null,
    dataset_content_hash: null,
    report_content_hash: null,
    selection_content_hash: null,
    selected_asset_count: 0,
    provider_calls: 0,
    successful_calls: 0,
    failed_calls: 0,
    repaired_calls: 0,
    unresolved_failed_calls: 0,
    uncertain_calls: 0,
    recovered_uncertain_calls: 0,
    unresolved_uncertain_calls: 0,
    quarantined_assets: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    estimated_cost_cny: 0,
    average_latency_ms: 0,
    max_latency_ms: 0,
    metric_count: 0,
    metrics_passed: false,
    pricing_version: null,
    prompt_version: null,
    schema_version: null,
    independence_level: null,
    role_count: 0,
    skill_snapshots: [],
  };
  if (!reportPath) return empty;
  if (!existsSync(reportPath)) return { ...empty, status: "failed", report_path: relative(reportPath) };

  const report = readJson(reportPath);
  const telemetry = report.telemetry ?? {};
  const budget = report.budget ?? {};
  const selection = report.selection ?? {};
  const counts = report.counts ?? {};
  const configuration = report.run_configuration ?? {};
  const metrics = Array.isArray(report.metrics) ? report.metrics : [];
  const roleRuns = Array.isArray(report.role_runs) ? report.role_runs : [];
  const runAudit = evaluateLiveRunAudit(reportPath, report);
  const skillSnapshots = Array.isArray(report.skills) ? report.skills.map((skill) => ({
    id: skill.id,
    version: skill.version,
    content_hash: skill.content_hash,
  })) : [];
  const expectedSkillSnapshots = ["observe-scene", "composition-relations"].map((skillId) => {
    const definition = readJson(path.join(repositoryRoot, "skill-modules", skillId, "skill.json"));
    return {
      id: definition.skill_id,
      version: definition.skill_version,
      content_hash: definition.content_hash,
    };
  });
  const skillsMatchRelease = expectedSkillSnapshots.every((expected) =>
    skillSnapshots.some((actual) => actual.id === expected.id
      && actual.version === expected.version
      && actual.content_hash === expected.content_hash));
  const requiredMetrics = new Set([
    "json_parse_rate",
    "serious_hallucination_rate",
    "intent_response_rate",
    "direction_difference_rate",
    "grounding_rate",
    "clarification_effectiveness_rate",
    "field_executability_rate",
    "gear_feasibility_rate",
    "judge_language_rate",
  ]);
  const metricNames = new Set(metrics.map((metric) => metric.dimension));
  const lowerIsBetterMetrics = new Set([
    "serious_hallucination_rate",
    "judge_language_rate",
  ]);
  const metricsPassed = metrics.length === requiredMetrics.size
    && [...requiredMetrics].every((dimension) => metricNames.has(dimension))
    && metrics.every((metric) => {
      const expectedPassed = lowerIsBetterMetrics.has(metric.dimension)
        ? metric.measured_value <= metric.threshold
        : metric.measured_value >= metric.threshold;
      return metric.passed === expectedPassed && metric.passed === true;
    });
  const expectedRoles = new Set(["observer", "direction_generator", "critic", "red_team", "curator"]);
  const roleNames = new Set(roleRuns.map((role) => role.role));
  const rolesPassed = roleRuns.length === expectedRoles.size
    && [...expectedRoles].every((role) => roleNames.has(role))
    && roleRuns.every((role) => role.status === "completed"
      && role.successful_calls === 60
      && role.failed_calls >= 0
      && role.failed_calls <= 15
      && role.uncertain_calls >= 0
      && role.uncertain_calls <= 1
      && role.provider_calls === role.successful_calls + role.failed_calls + role.uncertain_calls
      && role.attempts === role.provider_calls
    );
  const reportHashValid = typeof report.content_hash === "string"
    && report.content_hash === trainingContentHash(report);
  const selectionHashValid = typeof selection.content_hash === "string"
    && selection.content_hash === trainingContentHash(selection)
    && configuration.selection_hash === selection.content_hash;
  const frozenDataset = readJson(frozenDatasetManifestPath);
  const frozenAssetIds = frozenDataset.assets.map((asset) => asset.asset_id).sort();
  const selectedAssetIds = Array.isArray(selection.asset_ids) ? [...selection.asset_ids].sort() : [];
  const selectionMatchesFrozenDataset = selectedAssetIds.length === frozenAssetIds.length
    && selectedAssetIds.every((assetId, index) => assetId === frozenAssetIds[index])
    && ["training", "regression", "holdout"].every(
      (split) => selection.split_counts?.[split] === frozenDataset.split_counts?.[split],
    );
  const rolesMatchConfiguration = roleRuns.every((role) =>
    role.provider === configuration.provider
      && role.model === configuration.model
      && role.prompt_version === configuration.prompt_version
      && role.schema_version === configuration.schema_version
      && role.independence_level === configuration.independence_level
      && role.attempts <= 60 * configuration.max_attempts);
  const controlledRepairLimit = configuration.max_attempts === 1 ? 0 : 15;
  const passed = report.status === "completed"
    && report.validation_status === "passed"
    && path.resolve(reportPath) === expectedLiveReportPath
    && report.run_id === full60Stage.run_id
    && configuration.mode === "live"
    && configuration.provider === liveCampaign.provider.id
    && configuration.model === liveCampaign.provider.model
    && configuration.prompt_version === liveCampaign.contract.prompt_version
    && configuration.schema_version === liveCampaign.contract.schema_version
    && configuration.max_attempts === full60Stage.max_attempts
    && configuration.timeout_ms === 120000
    && configuration.concurrency === 1
    && configuration.fail_fast === true
    && configuration.max_provider_calls === full60Stage.max_provider_calls
    && report.dataset?.id === frozenDataset.dataset_id
    && report.dataset?.version === frozenDataset.dataset_version
    && report.dataset?.content_hash === frozenDataset.content_hash
    && reportHashValid
    && selectionHashValid
    && selection.source_asset_count === 60
    && selection.selected_asset_count === 60
    && Array.isArray(selection.asset_ids)
    && selection.asset_ids.length === 60
    && new Set(selection.asset_ids).size === 60
    && selectionMatchesFrozenDataset
    && counts.total === 60
    && counts.completed + counts.quarantined === 60
    && counts.failed === 0
    && counts.cancelled === 0
    && telemetry.provider_calls >= 300
    && telemetry.provider_calls <= 315
    && telemetry.successful_calls === 300
    && telemetry.provider_calls === budget.provider_calls
    && telemetry.uncertain_calls === budget.uncertain_calls
    && telemetry.failed_calls >= 0
    && telemetry.failed_calls <= controlledRepairLimit
    && telemetry.uncertain_calls >= 0
    && telemetry.uncertain_calls <= 1
    && telemetry.failed_calls + telemetry.uncertain_calls <= controlledRepairLimit
    && telemetry.provider_calls === telemetry.successful_calls
      + telemetry.failed_calls
      + telemetry.uncertain_calls
    && budget.stopped_new_work === false
    && budget.estimated_spend === telemetry.estimated_cost
    && approximately(budget.limit, full60Stage.budget_limit_cny)
    && budget.estimated_spend <= budget.limit
    && budget.pricing_version === liveCampaign.pricing.version
    && budget.pricing_effective_at === liveCampaign.pricing.effective_at
    && approximately(budget.input_per_million_cny, liveCampaign.pricing.input_per_million_cny)
    && approximately(budget.output_per_million_cny, liveCampaign.pricing.output_per_million_cny)
    && approximately(budget.max_cost_per_call, liveCampaign.pricing.max_cost_per_call_cny)
    && metricsPassed
    && rolesPassed
    && rolesMatchConfiguration
    && runAudit.valid
    && runAudit.repairedCalls === telemetry.failed_calls
    && runAudit.unresolvedFailedCalls === 0
    && runAudit.recoveredUncertainCalls === telemetry.uncertain_calls
    && runAudit.unresolvedUncertainCalls === 0
    && skillSnapshots.length === 2
    && skillsMatchRelease;

  return {
    status: passed ? "passed" : "failed",
    report_path: relative(reportPath),
    run_id: report.run_id ?? null,
    provider: configuration.provider ?? null,
    model: configuration.model ?? null,
    dataset_id: report.dataset?.id ?? null,
    dataset_version: report.dataset?.version ?? null,
    dataset_content_hash: report.dataset?.content_hash ?? null,
    report_content_hash: report.content_hash ?? null,
    selection_content_hash: selection.content_hash ?? null,
    selected_asset_count: selection.selected_asset_count ?? 0,
    provider_calls: telemetry.provider_calls ?? 0,
    successful_calls: telemetry.successful_calls ?? 0,
    failed_calls: telemetry.failed_calls ?? 0,
    repaired_calls: runAudit.repairedCalls,
    unresolved_failed_calls: runAudit.unresolvedFailedCalls,
    uncertain_calls: telemetry.uncertain_calls ?? 0,
    recovered_uncertain_calls: runAudit.recoveredUncertainCalls,
    unresolved_uncertain_calls: runAudit.unresolvedUncertainCalls,
    quarantined_assets: counts.quarantined ?? 0,
    prompt_tokens: telemetry.prompt_tokens ?? 0,
    completion_tokens: telemetry.completion_tokens ?? 0,
    estimated_cost_cny: telemetry.estimated_cost ?? 0,
    average_latency_ms: telemetry.average_latency_ms ?? 0,
    max_latency_ms: telemetry.max_latency_ms ?? 0,
    metric_count: metrics.length,
    metrics_passed: metricsPassed,
    pricing_version: budget.pricing_version ?? null,
    prompt_version: configuration.prompt_version ?? null,
    schema_version: configuration.schema_version ?? null,
    independence_level: configuration.independence_level ?? null,
    role_count: roleRuns.length,
    skill_snapshots: skillSnapshots,
  };
}

function evaluateLiveRunAudit(reportPath, report) {
  const frozenDataset = readJson(frozenDatasetManifestPath);
  return auditTrainingRun({
    reportPath,
    report,
    expectedAssetIds: frozenDataset.assets.map((asset) => asset.asset_id),
    expectedRunId: full60Stage.run_id,
    expectedConfiguration: {
      provider: liveCampaign.provider.id,
      model: liveCampaign.provider.model,
      prompt_version: liveCampaign.contract.prompt_version,
      schema_version: liveCampaign.contract.schema_version,
      max_attempts: full60Stage.max_attempts,
      timeout_ms: 120000,
      concurrency: 1,
      fail_fast: true,
      max_provider_calls: full60Stage.max_provider_calls,
      budget_limit: full60Stage.budget_limit_cny,
      pricing_version: liveCampaign.pricing.version,
      pricing_effective_at: liveCampaign.pricing.effective_at,
      input_per_million_cny: liveCampaign.pricing.input_per_million_cny,
      output_per_million_cny: liveCampaign.pricing.output_per_million_cny,
      max_cost_per_call: liveCampaign.pricing.max_cost_per_call_cny,
      base_url: liveCampaign.provider.base_url,
    },
    maxFailedCalls: full60Stage.max_controlled_repairs,
    maxUncertainCalls: Math.min(1, full60Stage.max_controlled_repairs),
    maxRepairCalls: full60Stage.max_controlled_repairs,
  });
}

function validateArtifacts(entries, sourceContentHash) {
  let valid = true;
  const ids = entries.map((entry) => entry.id);
  if (ids.length !== requiredArtifactIds.length
    || new Set(ids).size !== requiredArtifactIds.length
    || !requiredArtifactIds.every((id) => ids.includes(id))) {
    valid = false;
  }
  const artifacts = entries.map((entry) => {
    const artifactPath = path.resolve(repositoryRoot, entry.path);
    if (!isWithin(artifactPath, releaseRoot)
      || !existsSync(artifactPath)
      || pathHasSymbolicLink(artifactPath)
      || !statSync(artifactPath).isFile()) {
      valid = false;
      return entry;
    }
    const current = artifact(entry.id, artifactPath);
    if (current.sha256 !== entry.sha256 || current.bytes !== entry.bytes) valid = false;
    if (entry.id === "release_bundle" && !releaseBundleMatchesSource(artifactPath, sourceContentHash)) {
      valid = false;
    }
    return current;
  });
  return { valid, artifacts };
}

function runCommand(id, executable, args, logsRoot, extraEnvironment = {}) {
  const started = Date.now();
  const result = spawnSync(executable, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, Model__Provider: "mock", ...extraEnvironment },
    maxBuffer: 64 * 1024 * 1024,
  });
  const exitCode = Number.isInteger(result.status) ? result.status : 1;
  const logPath = path.join(logsRoot, `${id}.log`);
  writeFileSync(
    logPath,
    [
      `$ ${[executable, ...args].map(shellDisplay).join(" ")}`,
      "",
      result.stdout ?? "",
      result.stderr ?? "",
      result.error ? `启动错误：${result.error.message}` : "",
    ].join("\n"),
    "utf8",
  );
  return {
    id,
    command: [executable, ...args].map(shellDisplay).join(" "),
    status: exitCode === 0 ? "passed" : "failed",
    exit_code: exitCode,
    duration_ms: Date.now() - started,
    log_path: relative(logPath),
  };
}

function failedSyntheticCommand(id, message, logsRoot) {
  const logPath = path.join(logsRoot, `${id}.log`);
  writeFileSync(logPath, `${message}\n`, "utf8");
  return {
    id,
    command: message,
    status: "failed",
    exit_code: 1,
    duration_ms: 0,
    log_path: relative(logPath),
  };
}

function skippedCommand(id, message, logsRoot) {
  return failedSyntheticCommand(id, message, logsRoot);
}

function failCommand(commandEntry, message) {
  commandEntry.status = "failed";
  commandEntry.exit_code = 1;
  const logPath = path.resolve(repositoryRoot, commandEntry.log_path);
  writeFileSync(logPath, `${readFileSync(logPath, "utf8")}\n${message}\n`, "utf8");
}

function evidenceItem(id, passed, evidence) {
  return { id, status: passed ? "passed" : "blocked", evidence };
}

function approximately(actual, expected) {
  return Number.isFinite(actual)
    && Number.isFinite(expected)
    && Math.abs(actual - expected) <= 1e-9;
}

function artifact(id, artifactPath) {
  const bytes = statSync(artifactPath).size;
  return {
    id,
    path: relative(artifactPath),
    sha256: `sha256:${createHash("sha256").update(readFileSync(artifactPath)).digest("hex")}`,
    bytes,
  };
}

function verifyVersions() {
  if (releaseVersion !== "1.0.0-beta.1") {
    throw new Error(`根工程版本必须为 1.0.0-beta.1，当前为 ${releaseVersion}。`);
  }
  for (const packagePath of ["apps/web/package.json", "packages/parameter-engine/package.json"]) {
    const value = readJson(path.join(repositoryRoot, packagePath));
    if (value.version !== releaseVersion) {
      throw new Error(`${packagePath} 版本 ${value.version} 与 ${releaseVersion} 不一致。`);
    }
  }
  const project = readFileSync(path.join(repositoryRoot, "src/Zhaojian.Api/Zhaojian.Api.csproj"), "utf8");
  if (!project.includes(`<Version>${releaseVersion}</Version>`)
    || !project.includes(`<InformationalVersion>${releaseVersion}</InformationalVersion>`)) {
    throw new Error(".NET 发布版本与根工程版本不一致。");
  }
}

function parseOptions(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--allow-pending-live") {
      parsed[option] = true;
      continue;
    }
    if (!["--output-dir", "--live-report", "--live-status"].includes(option) || index + 1 >= args.length) {
      console.error(`未知或缺值参数：${option}`);
      process.exit(2);
    }
    parsed[option] = args[index + 1];
    index += 1;
  }
  return parsed;
}

function assertSafeReleaseRoot(candidate) {
  const allowedRoot = path.resolve(repositoryRoot, ".local", "beta-release");
  mkdirSync(allowedRoot, { recursive: true });
  const relativeCandidate = path.relative(allowedRoot, candidate);
  if (relativeCandidate === "" || relativeCandidate.startsWith("..") || path.isAbsolute(relativeCandidate)) {
    throw new Error(`Beta 输出目录必须位于 ${relative(allowedRoot)} 的具体子目录。`);
  }
  if (pathHasSymbolicLink(allowedRoot) || pathHasSymbolicLink(candidate)) {
    throw new Error("Beta 输出目录路径不得经过符号链接。");
  }
  const existingParent = nearestExistingPath(candidate);
  if (!isWithinOrSame(realpathSync(existingParent), realpathSync(allowedRoot))) {
    throw new Error("Beta 输出目录的真实路径越出允许范围。");
  }
}

function assertSafeReleasePath(candidate) {
  if (!isWithin(candidate, releaseRoot) || pathHasSymbolicLink(candidate)) {
    throw new Error(`发布制品路径不安全：${relative(candidate)}。`);
  }
}

function assertSafeLiveReportPath(candidate) {
  if (candidate !== expectedLiveReportPath) {
    throw new Error(`真实评测报告必须绑定冻结 full60 路径 ${relative(expectedLiveReportPath)}。`);
  }
  if (!isWithin(candidate, liveTrainingRoot) || pathHasSymbolicLink(candidate)) {
    throw new Error(`真实评测报告必须位于 ${relative(liveTrainingRoot)} 且路径不得经过符号链接。`);
  }
  if (existsSync(candidate)) {
    mkdirSync(liveTrainingRoot, { recursive: true });
    if (!isWithin(realpathSync(candidate), realpathSync(liveTrainingRoot))) {
      throw new Error("真实评测报告的真实路径越出允许范围。");
    }
  }
}

function resolveLiveTrainingRoot() {
  const fixtureEnabled = process.env.NODE_ENV === "test"
    && process.env.ZHAOJIAN_ENABLE_BETA_FIXTURE === "1";
  if (!fixtureEnabled || !process.env.ZHAOJIAN_BETA_LIVE_ROOT) {
    return defaultLiveTrainingRoot;
  }
  const fixtureRoot = path.resolve(repositoryRoot, process.env.ZHAOJIAN_BETA_LIVE_ROOT);
  const allowedFixtureRoot = path.join(repositoryRoot, ".local", "beta-fixtures");
  if (!isWithin(fixtureRoot, allowedFixtureRoot)) {
    throw new Error("Beta 测试真实运行目录必须位于 .local/beta-fixtures 的具体子目录。");
  }
  return fixtureRoot;
}

function pathHasSymbolicLink(candidate) {
  const relativeCandidate = path.relative(repositoryRoot, candidate);
  if (relativeCandidate.startsWith("..") || path.isAbsolute(relativeCandidate)) return true;
  let current = repositoryRoot;
  for (const segment of relativeCandidate.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!existsSync(current)) break;
    if (lstatSync(current).isSymbolicLink()) return true;
  }
  return false;
}

function nearestExistingPath(candidate) {
  let current = candidate;
  while (!existsSync(current)) current = path.dirname(current);
  return current;
}

function isWithinOrSame(candidate, parent) {
  return candidate === parent || isWithin(candidate, parent);
}

function releaseBundleMatchesSource(archivePath, sourceContentHash) {
  if (typeof sourceContentHash !== "string") return false;
  const listing = spawnSync("tar", ["-tzf", archivePath], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (listing.status !== 0) return false;
  const files = new Set(listing.stdout.split("\n").filter(Boolean));
  const requiredFiles = [
    "./VERSION",
    "./SOURCE_CONTENT_HASH",
    "./api/Zhaojian.Api.dll",
    "./web/index.html",
    `./release-notes/${path.basename(knownLimitationsPath)}`,
    `./release-notes/${path.basename(browserRecordPath)}`,
    `./release-notes/${path.basename(releaseEvidencePath)}`,
  ];
  if (!requiredFiles.every((file) => files.has(file))) return false;
  const version = spawnSync("tar", ["-xOzf", archivePath, "./VERSION"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  const sourceHash = spawnSync("tar", ["-xOzf", archivePath, "./SOURCE_CONTENT_HASH"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  return version.status === 0
    && sourceHash.status === 0
    && version.stdout.trim() === releaseVersion
    && sourceHash.stdout.trim() === sourceContentHash;
}

function git(args) {
  const result = spawnSync("git", args, { cwd: repositoryRoot, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} 失败。`);
  return result.stdout;
}

function sourceContentHash() {
  const files = git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter(Boolean)
    .sort();
  const hasher = createHash("sha256");
  for (const file of files) {
    const absolutePath = path.join(repositoryRoot, file);
    hasher.update(file);
    hasher.update("\0");
    hasher.update(existsSync(absolutePath) ? readFileSync(absolutePath) : Buffer.from("<deleted>", "utf8"));
    hasher.update("\0");
  }
  return `sha256:${hasher.digest("hex")}`;
}

function documentHash(document) {
  const pending = structuredClone(document);
  delete pending.content_hash;
  return `sha256:${createHash("sha256").update(JSON.stringify(pending)).digest("hex")}`;
}

function trainingContentHash(document) {
  const pending = structuredClone(document);
  delete pending.content_hash;
  return `sha256:${createHash("sha256").update(JSON.stringify(sortJson(pending))).digest("hex")}`;
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
  }
  return value;
}

function isWithin(candidate, parent) {
  const relativePath = path.relative(parent, candidate);
  return relativePath !== "" && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}

function relative(absolutePath) {
  return path.relative(repositoryRoot, absolutePath).split(path.sep).join("/");
}

function shellDisplay(value) {
  return /^[A-Za-z0-9_./:=|~-]+$/.test(value) ? value : JSON.stringify(value);
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
