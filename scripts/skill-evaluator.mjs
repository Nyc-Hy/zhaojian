import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultOutputDirectory = resolve(repositoryRoot, ".local/skill-evaluations");
const schemas = {
  report: resolve(repositoryRoot, "schemas/skill-training-report.schema.json"),
  skill: resolve(repositoryRoot, "schemas/skill-definition.schema.json"),
  dataset: resolve(repositoryRoot, "schemas/skill-training-dataset.schema.json"),
  evaluation: resolve(repositoryRoot, "schemas/skill-evaluation-report.schema.json"),
};
const metricDirections = new Map([
  ["json_parse_rate", "higher"],
  ["serious_hallucination_rate", "lower"],
  ["intent_response_rate", "higher"],
  ["direction_difference_rate", "higher"],
  ["grounding_rate", "higher"],
  ["clarification_effectiveness_rate", "higher"],
  ["field_executability_rate", "higher"],
  ["gear_feasibility_rate", "higher"],
  ["judge_language_rate", "lower"],
]);
const seriousFailurePattern =
  /hallucination|unsafe|danger|identity|privacy|injection|judge|imperative|aesthetic|虚构|危险|身份|隐私|注入|裁判|命令|审美总分/iu;
const blockingValidationStatuses = new Set(["confirmed_by_gate", "quarantined"]);
const sensitiveKeyPattern =
  /(?:^|_)(?:image(?:_data)?|base64|full_user_text|reasoning|chain_of_thought|gps(?:_coordinates?)?|aesthetic_score)(?:_|$)/iu;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseArguments(values) {
  assert(values[0] === "evaluate", "用法：node scripts/skill-evaluator.mjs evaluate [参数]");
  const options = new Map();
  for (let index = 1; index < values.length; index += 2) {
    const option = values[index];
    const value = values[index + 1];
    assert(option?.startsWith("--") && value && !value.startsWith("--"), `评测参数不完整：${option ?? ""}`);
    assert(!options.has(option), `评测参数重复：${option}`);
    options.set(option, value);
  }
  const allowed = new Set([
    "--phase",
    "--baseline-report",
    "--candidate-report",
    "--baseline-skill",
    "--candidate-skill",
    "--dataset-manifest",
    "--actor",
    "--reason",
    "--output-dir",
    "--runtime-version",
    "--max-cost-increase-ratio",
    "--max-average-latency-increase-ratio",
    "--max-latency-increase-ratio",
    "--shadow-observation-id",
  ]);
  for (const option of options.keys()) assert(allowed.has(option), `未知评测参数：${option}`);
  return options;
}

function required(options, name) {
  const value = options.get(name);
  assert(value?.trim(), `缺少评测参数 ${name}。`);
  return value.trim();
}

function decimalOption(options, name, fallback) {
  const raw = options.get(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  assert(Number.isFinite(value) && value >= 0 && value <= 10, `${name} 必须是 0 到 10 的数字。`);
  return value;
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
  }
  return value;
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function contentHash(value) {
  const copy = structuredClone(value);
  delete copy.content_hash;
  return `sha256:${digest(JSON.stringify(sortJson(copy)))}`;
}

function canonicalHash(value) {
  return `sha256:${digest(JSON.stringify(sortJson(value)))}`;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function compile(schemaPath) {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(readJson(schemaPath));
  return { ajv, validate };
}

const validators = Object.fromEntries(
  Object.entries(schemas).map(([name, path]) => [name, compile(path)]),
);

function assertNoSensitiveContent(value, label, path = "$") {
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertNoSensitiveContent(child, label, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      assert(!sensitiveKeyPattern.test(key), `${label}包含禁止字段 ${path}.${key}。`);
      assertNoSensitiveContent(child, label, `${path}.${key}`);
    }
    return;
  }
  if (typeof value !== "string") return;
  assert(!/data:image|base64,/iu.test(value), `${label}包含图片或 Base64。`);
  assert(!/[A-Za-z0-9+/]{512,}={0,2}/u.test(value), `${label}包含疑似长 Base64。`);
  assert(!/(?:authorization|bearer|api[_-]?key|password|secret)\s*[:=]/iu.test(value),
    `${label}包含疑似凭据。`);
  assert(!/(?:latitude|longitude|gps)\s*[:=]/iu.test(value), `${label}包含疑似定位信息。`);
  assert(!/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu.test(value), `${label}包含疑似电子邮箱。`);
  assert(!/(?:\+\d[\d ()-]{7,}\d|\b1[3-9]\d{9}\b|\b\d{3}[- ]\d{3,4}[- ]\d{4}\b)/u.test(value),
    `${label}包含疑似电话号码。`);
}

function rejectSymlinkChain(path) {
  const fullPath = resolve(path);
  const current = existsSync(fullPath) ? fullPath : dirname(fullPath);
  assert(!lstatSync(current).isSymbolicLink(), `评测路径不能使用符号链接：${current}`);
}

function readValidated(path, validator, label, verifyHash = false) {
  const fullPath = resolve(path);
  assert(existsSync(fullPath), `${label}不存在：${fullPath}`);
  rejectSymlinkChain(fullPath);
  const stats = lstatSync(fullPath);
  assert(stats.isFile() && stats.size > 0 && stats.size <= 2 * 1024 * 1024, `${label}大小或类型不正确。`);
  const value = readJson(fullPath);
  assertNoSensitiveContent(value, label);
  assert(validator.validate(value),
    `${label}未通过 Schema：${validator.ajv.errorsText(validator.validate.errors, { separator: "；" })}`);
  if (verifyHash) assert(value.content_hash === contentHash(value), `${label}内容哈希不匹配。`);
  if (validator === validators.report) validateTrainingReportBusiness(value, label);
  return { value, path: fullPath };
}

function validateTrainingReportBusiness(report, label) {
  assert(report.schema_version === "1.5", `${label}必须使用 1.5 合同。`);
  assert(report.counts.completed + report.counts.quarantined + report.counts.failed + report.counts.cancelled
    === report.counts.total, `${label}样例计数不一致。`);
  assert(report.selection.selected_asset_count === report.counts.total
    && report.selection.asset_ids.length === report.counts.total,
  `${label}选择范围与样例计数不一致。`);
  assert(report.selection.content_hash === contentHash(report.selection)
    && report.run_configuration.selection_hash === report.selection.content_hash,
  `${label}选择范围哈希不一致。`);
  assert(report.checkpoint.comparable_run_key === canonicalHash({
    dataset: report.dataset,
    selection: report.selection,
    skills: report.skills,
    run_configuration: report.run_configuration,
    budget_limit: report.budget.limit,
  }), `${label}可比较键与报告快照不一致。`);
  assert(new Set(report.selection.asset_ids).size === report.selection.asset_ids.length,
    `${label}包含重复资产。`);
  assert(new Set(report.skills.map((skill) => `${skill.id}@${skill.version}`)).size === report.skills.length,
    `${label}包含重复 Skill 快照。`);
  assert(report.role_runs.length === 5
    && new Set(report.role_runs.map((roleRun) => roleRun.role)).size === 5,
  `${label}角色运行不完整。`);
  assert(report.metrics.length === metricDirections.size
    && new Set(report.metrics.map((metric) => metric.dimension)).size === metricDirections.size,
  `${label}九维指标不完整。`);
  for (const metric of report.metrics) {
    const direction = metricDirections.get(metric.dimension);
    assert(direction, `${label}包含未知评测维度 ${metric.dimension}。`);
    const expected = direction === "higher"
      ? metric.measured_value >= metric.threshold
      : metric.measured_value <= metric.threshold;
    assert(metric.passed === expected, `${label}的 ${metric.dimension} 通过状态与阈值不一致。`);
  }
  const telemetryFields = [
    "provider_calls",
    "successful_calls",
    "failed_calls",
    "uncertain_calls",
    "prompt_tokens",
    "completion_tokens",
    "estimated_cost",
    "total_latency_ms",
  ];
  for (const field of telemetryFields) {
    const roleTotal = report.role_runs.reduce((sum, roleRun) => sum + roleRun[field], 0);
    assert(Math.abs(roleTotal - report.telemetry[field]) <= 0.000001,
      `${label}角色遥测 ${field} 与总计不一致。`);
  }
  assert(report.telemetry.successful_calls + report.telemetry.failed_calls + report.telemetry.uncertain_calls
    === report.telemetry.provider_calls, `${label}调用状态计数不一致。`);
  assert(Math.abs(report.telemetry.estimated_cost - report.budget.estimated_spend) <= 0.000001,
    `${label}费用遥测与预算不一致。`);
  assert(report.failures.every((failure) => report.selection.asset_ids.includes(failure.asset_id)),
    `${label}失败项引用了选择范围外资产。`);
  if (report.status === "completed") {
    assert(report.counts.failed === 0 && report.counts.cancelled === 0,
      `${label}完成状态不能包含失败或取消样例。`);
  }
}

function assertContained(root, path, label) {
  const fullRoot = resolve(root);
  const fullPath = resolve(path);
  const relativePath = relative(fullRoot, fullPath);
  assert(!isAbsolute(relativePath)
    && relativePath !== ".."
    && !relativePath.startsWith(`..${sep}`), `${label}越出允许目录。`);
}

function canonicalSkillHash(definitionPath, definition) {
  const moduleDirectory = realpathSync(dirname(definitionPath));
  const artifactPaths = [
    definition.artifacts.instructions_path,
    ...definition.artifacts.reference_paths,
    ...definition.artifacts.example_paths,
    ...definition.artifacts.negative_example_paths,
  ];
  assert(new Set(artifactPaths).size === artifactPaths.length, "Skill 包含重复资源路径。");
  const hash = createHash("sha256");
  const copy = structuredClone(definition);
  delete copy.content_hash;
  hash.update(JSON.stringify(sortJson(copy)));
  for (const artifactPath of [...artifactPaths].sort()) {
    assert(!isAbsolute(artifactPath) && !artifactPath.split(/[\\/]/u).includes(".."),
      `Skill 资源路径不安全：${artifactPath}`);
    const requestedPath = resolve(moduleDirectory, artifactPath);
    assertContained(moduleDirectory, requestedPath, "Skill 资源");
    rejectSymlinkChain(requestedPath);
    const fullPath = realpathSync(requestedPath);
    assertContained(moduleDirectory, fullPath, "Skill 资源");
    const stats = lstatSync(fullPath);
    assert(stats.isFile() && stats.size > 0 && stats.size <= 2 * 1024 * 1024,
      `Skill 资源大小或类型不正确：${artifactPath}`);
    hash.update(`\n--${artifactPath}--\n`);
    hash.update(readFileSync(fullPath));
  }
  return `sha256:${hash.digest("hex")}`;
}

function semanticVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-.*)?$/u.exec(value);
  assert(match, `语义版本不正确：${value}`);
  return match.slice(1, 4).map(Number);
}

function compareVersions(left, right) {
  const a = semanticVersion(left);
  const b = semanticVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function runtimeCompatible(definition, runtimeVersion) {
  return compareVersions(runtimeVersion, definition.compatible_runtime.minimum) >= 0
    && compareVersions(runtimeVersion, definition.compatible_runtime.maximum_exclusive) < 0;
}

function sameJson(left, right) {
  return JSON.stringify(sortJson(left)) === JSON.stringify(sortJson(right));
}

function reportSkill(report, skillId, label) {
  const matches = report.skills.filter((skill) => skill.id === skillId);
  assert(matches.length === 1, `${label}必须恰好引用一个 ${skillId}。`);
  return matches[0];
}

function telemetrySnapshot(report) {
  const successful = report.telemetry.successful_calls;
  return {
    estimated_cost: report.telemetry.estimated_cost,
    cost_per_successful_call: successful === 0
      ? report.telemetry.estimated_cost
      : Math.round(report.telemetry.estimated_cost / successful * 1_000_000) / 1_000_000,
    average_latency_ms: report.telemetry.average_latency_ms,
    max_latency_ms: report.telemetry.max_latency_ms,
  };
}

function withinIncrease(candidate, baseline, ratio, fixedAllowance = 0) {
  if (baseline === 0) return candidate === 0;
  return candidate <= baseline * (1 + ratio) + fixedAllowance;
}

function blockingFailures(report) {
  return report.failures.filter((failure) => blockingValidationStatuses.has(failure.validation_status));
}

function failureKey(failure) {
  return `${failure.asset_id}:${failure.failure_code}`;
}

function pushFailure(failures, code, evidence, baselineVersion, candidateVersion, assetId = null) {
  failures.push({
    code,
    evidence: evidence.slice(0, 300),
    asset_id: assetId,
    rule: code,
    baseline_version: baselineVersion,
    candidate_version: candidateVersion,
  });
}

function buildEvaluation(options) {
  const phase = required(options, "--phase");
  assert(["candidate", "shadow"].includes(phase), "--phase 只能是 candidate 或 shadow。");
  const actor = required(options, "--actor");
  assert(/^[a-zA-Z0-9][a-zA-Z0-9_-]{2,127}$/u.test(actor), "--actor 格式不正确。");
  const reason = required(options, "--reason");
  assert(reason.length >= 8 && reason.length <= 300, "--reason 长度必须为 8 到 300。");
  const runtimeVersion = options.get("--runtime-version") ?? "1.0.0";
  semanticVersion(runtimeVersion);
  const config = {
    runtime_version: runtimeVersion,
    max_cost_increase_ratio: decimalOption(options, "--max-cost-increase-ratio", 0.2),
    max_average_latency_increase_ratio:
      decimalOption(options, "--max-average-latency-increase-ratio", 0.2),
    max_latency_increase_ratio: decimalOption(options, "--max-latency-increase-ratio", 0.25),
    require_all_splits: true,
  };

  const baselineReport = readValidated(
    required(options, "--baseline-report"),
    validators.report,
    "基线训练报告",
    true,
  ).value;
  const candidateReport = readValidated(
    required(options, "--candidate-report"),
    validators.report,
    "候选训练报告",
    true,
  ).value;
  const baselineSkillDocument = readValidated(
    required(options, "--baseline-skill"),
    validators.skill,
    "基线 Skill",
  );
  const candidateSkillDocument = readValidated(
    required(options, "--candidate-skill"),
    validators.skill,
    "候选 Skill",
  );
  const dataset = readValidated(
    required(options, "--dataset-manifest"),
    validators.dataset,
    "评测数据集",
    true,
  ).value;
  const baselineSkill = baselineSkillDocument.value;
  const candidateSkill = candidateSkillDocument.value;

  assert(baselineReport.schema_version === "1.5" && candidateReport.schema_version === "1.5",
    "Skill 候选比较要求 1.5 训练报告的完整九维指标。");
  assert(baselineReport.status === "completed" && baselineReport.validation_status === "passed",
    "基线训练报告必须完成并通过验证。");
  assert(candidateReport.status === "completed" && candidateReport.validation_status === "passed",
    "候选训练报告必须完成并通过验证。");
  assert(baselineSkill.status === "active", "基线 Skill 必须声明为 active。");
  assert(["candidate", "shadow"].includes(candidateSkill.status), "候选 Skill 必须声明为 candidate 或 shadow。");
  assert(baselineSkill.skill_id === candidateSkill.skill_id, "基线与候选必须属于同一 Skill。");
  assert(compareVersions(candidateSkill.skill_version, baselineSkill.skill_version) > 0,
    "候选 Skill 版本必须高于基线版本。");

  const baselineComputedHash = canonicalSkillHash(baselineSkillDocument.path, baselineSkill);
  const candidateComputedHash = canonicalSkillHash(candidateSkillDocument.path, candidateSkill);
  const skillIntegrity = baselineComputedHash === baselineSkill.content_hash
    && candidateComputedHash === candidateSkill.content_hash;
  const baselineReference = reportSkill(baselineReport, baselineSkill.skill_id, "基线报告");
  const candidateReference = reportSkill(candidateReport, candidateSkill.skill_id, "候选报告");
  assert(sameJson(baselineReference, {
    id: baselineSkill.skill_id,
    version: baselineSkill.skill_version,
    content_hash: baselineSkill.content_hash,
  }), "基线报告 Skill 引用与基线资源包不一致。");
  assert(sameJson(candidateReference, {
    id: candidateSkill.skill_id,
    version: candidateSkill.skill_version,
    content_hash: candidateSkill.content_hash,
  }), "候选报告 Skill 引用与候选资源包不一致。");
  const baselineOtherSkills = baselineReport.skills.filter((skill) => skill.id !== baselineSkill.skill_id);
  const candidateOtherSkills = candidateReport.skills.filter((skill) => skill.id !== candidateSkill.skill_id);
  assert(sameJson(baselineOtherSkills, candidateOtherSkills), "除目标 Skill 外的其他 Skill 快照必须完全相同。");

  const datasetComparable = sameJson(baselineReport.dataset, candidateReport.dataset)
    && baselineReport.dataset.content_hash === dataset.content_hash
    && sameJson(baselineReport.selection, candidateReport.selection)
    && baselineReport.selection.strategy === "all"
    && baselineReport.selection.selected_asset_count === dataset.assets.length
    && new Set(baselineReport.selection.asset_ids).size === dataset.assets.length
    && dataset.assets.every((asset) => baselineReport.selection.asset_ids.includes(asset.asset_id))
    && ["training", "regression", "holdout"].every((split) =>
      baselineReport.selection.split_counts[split] > 0);
  const comparableConfigurationFields = [
    "mode",
    "provider",
    "model",
    "prompt_version",
    "schema_version",
    "independence_level",
    "mock_scenario_version",
    "selection_hash",
  ];
  const comparableConfiguration = comparableConfigurationFields.every((field) =>
    sameJson(baselineReport.run_configuration[field], candidateReport.run_configuration[field]));
  assert(comparableConfiguration, "基线与候选报告的模型、提示词、Schema 或运行方式不可比较。");
  assert(baselineReport.budget.pricing_version === candidateReport.budget.pricing_version,
    "基线与候选报告必须使用同一计价版本。");

  const metrics = [];
  const failures = [];
  for (const [dimension, direction] of metricDirections) {
    const baselineMetric = baselineReport.metrics.find((metric) => metric.dimension === dimension);
    const candidateMetric = candidateReport.metrics.find((metric) => metric.dimension === dimension);
    assert(baselineMetric && candidateMetric, `训练报告缺少评测维度 ${dimension}。`);
    const delta = Math.round((candidateMetric.measured_value - baselineMetric.measured_value) * 1_000_000) / 1_000_000;
    const noRegression = direction === "higher" ? delta >= 0 : delta <= 0;
    const passed = candidateMetric.passed && noRegression;
    metrics.push({
      dimension,
      direction,
      baseline_value: baselineMetric.measured_value,
      candidate_value: candidateMetric.measured_value,
      delta,
      threshold: candidateMetric.threshold,
      passed,
    });
    if (!passed) {
      pushFailure(
        failures,
        "metric_regression",
        `${dimension} 从 ${baselineMetric.measured_value} 变化为 ${candidateMetric.measured_value}，未通过阈值或出现退化。`,
        baselineSkill.skill_version,
        candidateSkill.skill_version,
      );
    }
  }

  const assetsById = new Map(dataset.assets.map((asset) => [asset.asset_id, asset]));
  const baselineBlocking = blockingFailures(baselineReport);
  const candidateBlocking = blockingFailures(candidateReport);
  const baselineFailureKeys = new Set(baselineBlocking.map(failureKey));
  const splitResults = ["training", "regression", "holdout"].map((split) => {
    const assetIds = new Set(dataset.assets.filter((asset) => asset.dataset_split === split)
      .map((asset) => asset.asset_id));
    const baselineSplitFailures = baselineBlocking.filter((failure) => assetIds.has(failure.asset_id));
    const candidateSplitFailures = candidateBlocking.filter((failure) => assetIds.has(failure.asset_id));
    const newFailures = candidateSplitFailures.filter((failure) => !baselineFailureKeys.has(failureKey(failure)));
    for (const failure of newFailures) {
      pushFailure(
        failures,
        "new_blocking_failure",
        failure.failure_reason,
        baselineSkill.skill_version,
        candidateSkill.skill_version,
        failure.asset_id,
      );
    }
    return {
      split,
      asset_count: assetIds.size,
      baseline_blocking_failures: baselineSplitFailures.length,
      candidate_blocking_failures: candidateSplitFailures.length,
      new_blocking_failures: newFailures.length,
      passed: newFailures.length === 0,
    };
  });
  assert(candidateBlocking.every((failure) => assetsById.has(failure.asset_id)),
    "候选报告阻断失败引用了数据集外样例。");

  const newSeriousFailures = candidateReport.failures.filter((failure) =>
    seriousFailurePattern.test(`${failure.failure_code} ${failure.failure_reason}`)
    && !baselineReport.failures.some((baselineFailure) => failureKey(baselineFailure) === failureKey(failure)));
  for (const failure of newSeriousFailures) {
    pushFailure(
      failures,
      "serious_failure_regression",
      failure.failure_reason,
      baselineSkill.skill_version,
      candidateSkill.skill_version,
      failure.asset_id,
    );
  }

  const historicalCompatibility = baselineSkill.input_schema_version.schema_id
      === candidateSkill.input_schema_version.schema_id
    && semanticVersion(baselineSkill.input_schema_version.version)[0]
      === semanticVersion(candidateSkill.input_schema_version.version)[0]
    && baselineSkill.output_schema_version.schema_id === candidateSkill.output_schema_version.schema_id
    && semanticVersion(baselineSkill.output_schema_version.version)[0]
      === semanticVersion(candidateSkill.output_schema_version.version)[0]
    && runtimeCompatible(baselineSkill, runtimeVersion)
    && runtimeCompatible(candidateSkill, runtimeVersion);
  const baselineTelemetry = telemetrySnapshot(baselineReport);
  const candidateTelemetry = telemetrySnapshot(candidateReport);
  const costPassed = withinIncrease(
    candidateTelemetry.cost_per_successful_call,
    baselineTelemetry.cost_per_successful_call,
    config.max_cost_increase_ratio,
  );
  const latencyPassed = withinIncrease(
    candidateTelemetry.average_latency_ms,
    baselineTelemetry.average_latency_ms,
    config.max_average_latency_increase_ratio,
    250,
  ) && withinIncrease(
    candidateTelemetry.max_latency_ms,
    baselineTelemetry.max_latency_ms,
    config.max_latency_increase_ratio,
    500,
  );
  const provenanceComplete = candidateReport.run_configuration.provider.length > 0
    && candidateReport.run_configuration.model.length > 0
    && candidateReport.run_configuration.prompt_version.length > 0
    && candidateReport.run_configuration.schema_version.length > 0
    && candidateReport.budget.pricing_version.length > 0;
  const regressionSplit = splitResults.find((result) => result.split === "regression");
  const holdoutSplit = splitResults.find((result) => result.split === "holdout");
  const metricsPassed = metrics.every((metric) => metric.passed);
  const shadowObservationId = options.get("--shadow-observation-id") ?? "";
  if (phase === "shadow") {
    assert(/^[a-zA-Z0-9][a-zA-Z0-9_-]{2,127}$/u.test(shadowObservationId),
      "shadow 阶段必须提供 --shadow-observation-id。");
    assert(shadowObservationId === candidateReport.run_id,
      "shadow 观察 ID 必须等于候选 shadow 运行报告的 run_id。");
  }
  const gates = [
    {
      code: "provenance_complete",
      passed: provenanceComplete,
      evidence: "已核对模型、提示词、Schema、数据集、Skill、运行与计价版本。",
    },
    {
      code: "dataset_comparable",
      passed: datasetComparable,
      evidence: "基线与候选必须使用相同 60 图、选择顺序和固定分区。",
    },
    {
      code: "skill_content_integrity",
      passed: skillIntegrity,
      evidence: "基线与候选 Skill 定义及全部资源重新计算内容哈希。",
    },
    {
      code: "historical_compatibility",
      passed: historicalCompatibility,
      evidence: "输入输出 Schema 主版本与运行时兼容范围必须保持可读。",
    },
    {
      code: "fixed_regression",
      passed: regressionSplit.passed && metricsPassed,
      evidence: "固定回归分区不得新增阻断失败，九维指标不得退化。",
    },
    {
      code: "holdout_regression",
      passed: holdoutSplit.passed && metricsPassed,
      evidence: "保留分区不得新增阻断失败，九维指标不得退化。",
    },
    {
      code: "serious_failure_regression",
      passed: newSeriousFailures.length === 0,
      evidence: "不得新增严重虚构、危险机位、身份推断、隐私泄露或裁判语言。",
    },
    {
      code: "cost_limit",
      passed: costPassed,
      evidence: "候选单次成功调用估算成本不得超过显式增幅阈值。",
    },
    {
      code: "latency_limit",
      passed: latencyPassed,
      evidence: "候选平均和最大延迟不得超过显式增幅阈值。",
    },
    {
      code: "rollback_ready",
      passed: skillIntegrity && baselineSkill.status === "active",
      evidence: "活动基线资源包保持完整，可继续作为回滚目标。",
    },
    {
      code: "shadow_observation",
      passed: phase === "candidate" || shadowObservationId.length > 0,
      evidence: phase === "candidate"
        ? "candidate 阶段不要求 shadow 运行证据。"
        : `已绑定 shadow 观察记录 ${shadowObservationId}。`,
    },
  ];
  for (const gate of gates.filter((gate) => !gate.passed)) {
    pushFailure(
      failures,
      gate.code,
      gate.evidence,
      baselineSkill.skill_version,
      candidateSkill.skill_version,
    );
  }
  const passed = gates.every((gate) => gate.passed) && failures.length === 0;
  const evaluatedAt = new Date().toISOString();
  const candidateReferenceForOutput = {
    id: candidateSkill.skill_id,
    version: candidateSkill.skill_version,
    content_hash: candidateSkill.content_hash,
  };
  const evaluationId = `evaluation_${digest(JSON.stringify({
    phase,
    baseline: baselineReference,
    candidate: candidateReferenceForOutput,
    baseline_report: baselineReport.content_hash,
    candidate_report: candidateReport.content_hash,
    shadow_observation_id: shadowObservationId,
  })).slice(0, 24)}`;
  const evaluation = {
    schema_version: "1.0",
    evaluation_id: evaluationId,
    phase,
    status: passed ? "passed" : "blocked",
    baseline_skill: baselineReference,
    candidate_skill: candidateReferenceForOutput,
    source: {
      baseline_report_id: baselineReport.report_id,
      baseline_run_id: baselineReport.run_id,
      baseline_report_hash: baselineReport.content_hash,
      candidate_report_id: candidateReport.report_id,
      candidate_run_id: candidateReport.run_id,
      candidate_report_hash: candidateReport.content_hash,
      provider: candidateReport.run_configuration.provider,
      model: candidateReport.run_configuration.model,
      prompt_version: candidateReport.run_configuration.prompt_version,
      schema_version: candidateReport.run_configuration.schema_version,
      pricing_version: candidateReport.budget.pricing_version,
      evaluation_set_version: candidateSkill.evaluation_set_version,
    },
    dataset: {
      id: candidateReport.dataset.id,
      version: candidateReport.dataset.version,
      content_hash: candidateReport.dataset.content_hash,
      selection_hash: candidateReport.selection.content_hash,
    },
    comparison_config: config,
    metrics,
    split_results: splitResults,
    gates,
    failures,
    telemetry: {
      baseline: baselineTelemetry,
      candidate: candidateTelemetry,
    },
    shadow_observation_id: phase === "shadow" ? shadowObservationId : null,
    eligible_for_shadow: passed && phase === "candidate",
    eligible_for_activation: passed && phase === "shadow",
    actor,
    reason,
    command: `npm run skill:evaluate -- --phase ${phase}`,
    evaluated_at: evaluatedAt,
    validation_status: passed ? "passed" : "failed",
    content_hash: "sha256:pending",
  };
  evaluation.content_hash = contentHash(evaluation);
  assertNoSensitiveContent(evaluation, "Skill 评测报告");
  assert(validators.evaluation.validate(evaluation),
    `Skill 评测报告未通过 Schema：${validators.evaluation.ajv.errorsText(
      validators.evaluation.validate.errors,
      { separator: "；" },
    )}`);
  assert(new Set(evaluation.metrics.map((metric) => metric.dimension)).size === metricDirections.size,
    "Skill 评测报告维度重复。");
  assert(new Set(evaluation.split_results.map((result) => result.split)).size === 3,
    "Skill 评测报告分区重复。");
  assert(new Set(evaluation.gates.map((gate) => gate.code)).size === evaluation.gates.length,
    "Skill 评测报告门禁重复。");
  return evaluation;
}

function writeEvaluation(evaluation, outputDirectory) {
  const fullOutputDirectory = resolve(outputDirectory);
  if (!existsSync(fullOutputDirectory)) mkdirSync(fullOutputDirectory, { recursive: true, mode: 0o700 });
  rejectSymlinkChain(fullOutputDirectory);
  const canonicalOutputDirectory = realpathSync(fullOutputDirectory);
  const outputPath = resolve(canonicalOutputDirectory, `${evaluation.evaluation_id}.json`);
  assertContained(canonicalOutputDirectory, outputPath, "Skill 评测输出");
  const temporaryPath = `${outputPath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(evaluation, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporaryPath, outputPath);
  return outputPath;
}

try {
  const options = parseArguments(process.argv.slice(2));
  const evaluation = buildEvaluation(options);
  const outputPath = writeEvaluation(evaluation, options.get("--output-dir") ?? defaultOutputDirectory);
  process.stdout.write(`${JSON.stringify({
    status: evaluation.status,
    evaluation_id: evaluation.evaluation_id,
    phase: evaluation.phase,
    eligible_for_shadow: evaluation.eligible_for_shadow,
    eligible_for_activation: evaluation.eligible_for_activation,
    output_path: outputPath,
    content_hash: evaluation.content_hash,
  })}\n`);
  process.exitCode = evaluation.status === "passed" ? 0 : 3;
} catch (error) {
  process.stderr.write(`Skill 评测失败：${error.message}\n`);
  process.exitCode = 1;
}
