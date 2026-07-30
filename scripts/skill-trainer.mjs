import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import {
  calculateEstimatedCost,
  createFixtureTrainingProvider,
  createQwenTrainingProvider,
} from "./training-provider.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultDatasetDirectory = resolve(repositoryRoot, "datasets/photography-skill-v3");
const defaultOutputDirectory = resolve(repositoryRoot, ".local/skill-training");
const runSchemaPath = resolve(repositoryRoot, "schemas/skill-training-run.schema.json");
const artifactSchemaPath = resolve(repositoryRoot, "schemas/skill-training-artifact.schema.json");
const reportSchemaPath = resolve(repositoryRoot, "schemas/skill-training-report.schema.json");
const roleOutputSchemaPath = resolve(repositoryRoot, "schemas/skill-training-role-output.schema.json");
const defaultQwenBaseUrl = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const runLockFileName = ".trainer.lock";
const cancellationRequestFileName = ".cancel-requested";
const requiredSkillIds = ["observe-scene", "composition-relations"];
const mockScenarioVersion = "1.0.0";
const roles = [
  { role: "observer", state: "observing" },
  { role: "direction_generator", state: "generating" },
  { role: "critic", state: "criticizing" },
  { role: "red_team", state: "red_teaming" },
  { role: "curator", state: "curating" },
];
const evaluationMetricDefinitions = [
  { dimension: "json_parse_rate", direction: "higher", threshold: 0.95, pattern: null },
  {
    dimension: "serious_hallucination_rate",
    direction: "lower",
    threshold: 0,
    pattern: /hallucination|unsupported|speculative|虚构|无依据/u,
  },
  {
    dimension: "intent_response_rate",
    direction: "higher",
    threshold: 0.9,
    pattern: /intent|response|no_options|意图|回应/u,
  },
  {
    dimension: "direction_difference_rate",
    direction: "higher",
    threshold: 0.8,
    pattern: /duplicate_direction|direction_difference|方向重复|缺少差异/u,
  },
  {
    dimension: "grounding_rate",
    direction: "higher",
    threshold: 0.9,
    pattern: /grounding|evidence|依据|证据/u,
  },
  {
    dimension: "clarification_effectiveness_rate",
    direction: "higher",
    threshold: 0.8,
    pattern: /clarification|clarify|澄清/u,
  },
  {
    dimension: "field_executability_rate",
    direction: "higher",
    threshold: 0.85,
    pattern: /field|unexecutable|imperative|unsafe_position|现场|不可执行|危险机位/u,
  },
  {
    dimension: "gear_feasibility_rate",
    direction: "higher",
    threshold: 0.95,
    pattern: /gear|equipment|器材|设备/u,
  },
  {
    dimension: "judge_language_rate",
    direction: "lower",
    threshold: 0,
    pattern: /judge|imperative|best|aesthetic_score|裁判|命令|最佳|审美总分/u,
  },
];
const terminalItemStates = new Set(["completed", "quarantined", "cancelled", "failed"]);
const terminalRunStates = new Set(["completed", "rejected", "cancelled", "failed"]);
const dispatchStopReasons = new Set(["budget_exhausted", "provider_call_limit_reached", "item_failure"]);
const sensitiveKeyPattern = /(?:^|_)(?:image(?:_data)?|base64|full_user_text|reasoning|chain_of_thought|gps(?:_coordinates?)?|aesthetic_score)(?:_|$)/iu;
const validators = createValidators();
let cancelRequested = false;
let interruptRequested = false;
let completedRoleCount = 0;
let checkpointGate = Promise.resolve();

function parseArguments(values) {
  const parsed = { command: values[0] ?? "", flags: new Set(), options: new Map() };
  for (let index = 1; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) throw new Error(`未知参数：${value}`);
    const next = values[index + 1];
    if (next && !next.startsWith("--")) {
      parsed.options.set(value, next);
      index += 1;
    } else {
      parsed.flags.add(value);
    }
  }
  return parsed;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function createValidators() {
  const create = (schemaPath) => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    const validate = ajv.compile(readJson(schemaPath));
    return { ajv, validate };
  };
  return {
    run: create(runSchemaPath),
    artifact: create(artifactSchemaPath),
    report: create(reportSchemaPath),
    roleOutput: create(roleOutputSchemaPath),
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function digest(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  return createHash("sha256").update(bytes).digest("hex");
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
  }
  return value;
}

function contentHash(value) {
  const copy = structuredClone(value);
  delete copy.content_hash;
  return `sha256:${digest(JSON.stringify(sortJson(copy)))}`;
}

function canonicalHash(value) {
  return `sha256:${digest(JSON.stringify(sortJson(value)))}`;
}

function validateNoSensitiveContent(value, label, path = "$") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateNoSensitiveContent(item, label, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      assert(!sensitiveKeyPattern.test(key), `${label}包含禁止字段 ${path}.${key}。`);
      validateNoSensitiveContent(child, label, `${path}.${key}`);
    }
    return;
  }
  if (typeof value === "string") {
    assert(!/data:image|base64,/iu.test(value), `${label}包含图片或 Base64 内容。`);
    assert(!/[A-Za-z0-9+/]{512,}={0,2}/u.test(value), `${label}包含疑似长 Base64 内容。`);
    assert(!/(?:latitude|longitude|gps)\s*[:=]/iu.test(value), `${label}包含疑似定位信息。`);
    assert(!/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu.test(value), `${label}包含疑似电子邮箱。`);
    assert(!/(?:\+\d[\d ()-]{7,}\d|\b1[3-9]\d{9}\b|\b\d{3}[- ]\d{3,4}[- ]\d{4}\b)/u.test(value),
      `${label}包含疑似电话号码。`);
    assert(!/(?:authorization|bearer|api[_-]?key|password|secret)\s*[:=]/iu.test(value),
      `${label}包含疑似凭据。`);
    assert(!/(?:地址|住址|门牌号|street address)\s*[:：]/iu.test(value), `${label}包含疑似精确地址。`);
  }
}

function validateDocument(value, validator, label, verifyHash = true) {
  validateNoSensitiveContent(value, label);
  if (!validator.validate(value)) {
    throw new Error(`${label}未通过 JSON Schema：${validator.ajv.errorsText(validator.validate.errors, { separator: "；" })}`);
  }
  if (verifyHash) assert(value.content_hash === contentHash(value), `${label}内容哈希不匹配。`);
  if (validator === validators.run) validateRunBusinessRules(value);
  if (validator === validators.artifact) validateArtifactBusinessRules(value);
  if (validator === validators.report) validateReportBusinessRules(value);
  if (validator === validators.roleOutput) validateRoleOutputBusinessRules(value);
}

function writeDocument(path, value, validator, label, containmentRoot) {
  const document = structuredClone(value);
  document.content_hash = contentHash(document);
  validateDocument(document, validator, label);
  assertSafeOutputPath(path, containmentRoot);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporaryPath, path);
  return document;
}

function readDocument(path, validator, label, containmentRoot) {
  assertSafeExistingFile(path, containmentRoot);
  const value = readJson(path);
  validateDocument(value, validator, label);
  return value;
}

function valuesAreUnique(values, label) {
  assert(new Set(values).size === values.length, `${label}存在重复项。`);
}

function validateRunBusinessRules(run) {
  valuesAreUnique(run.skills.map((skill) => `${skill.id}@${skill.version}`), "训练运行 Skill 快照");
  valuesAreUnique(run.items.map((item) => item.asset_id), "训练运行 asset_id");
  if (run.schema_version === "1.1") {
    assert(run.selection.content_hash === contentHash(run.selection), "训练运行选择范围哈希不匹配。");
    assert(run.configuration.selection_hash === run.selection.content_hash,
      "训练运行配置与选择范围哈希不一致。");
    assert(run.selection.source_asset_count >= run.selection.selected_asset_count,
      "训练运行来源资产数不能小于选择数。");
    assert(run.selection.selected_asset_count === run.items.length,
      "训练运行选择数与 items 数量不一致。");
    assert(Object.values(run.selection.split_counts).reduce((sum, value) => sum + value, 0)
      === run.selection.selected_asset_count,
    "训练运行选择分区总数不一致。");
    if (run.selection.strategy === "all") {
      assert(run.selection.selected_asset_count === run.selection.source_asset_count,
        "全量训练选择数必须等于来源资产数。");
    }
    assert(JSON.stringify(run.selection.asset_ids) === JSON.stringify(run.items.map((item) => item.asset_id)),
      "训练运行选择顺序与 items 不一致。");
    const splitCounts = { training: 0, regression: 0, holdout: 0 };
    for (const item of run.items) splitCounts[item.dataset_split] += 1;
    assert(JSON.stringify(run.selection.split_counts) === JSON.stringify(splitCounts),
      "训练运行选择分区计数不一致。");
  }
  assert(run.budget.limit === run.configuration.budget_limit, "训练运行预算上限与配置不一致。");
  assert(run.budget.currency === run.configuration.currency, "训练运行预算币种与配置不一致。");
  for (const property of [
    "pricing_version",
    "pricing_effective_at",
    "input_per_million_cny",
    "output_per_million_cny",
    "max_cost_per_call",
  ]) {
    assert(run.budget[property] === run.configuration[property], `训练运行预算 ${property} 与配置不一致。`);
  }
  assert(run.budget.estimated_spend + run.budget.reserved <= run.budget.limit + 0.000001,
    "训练运行已花费与预留费用超过预算上限。");
  assert((run.budget.reserved === 0) === (run.budget.reserved_calls === 0),
    "训练运行预算预留金额与调用数不一致。");
  let persistedCalls = 0;
  let persistedSpend = 0;
  const actual = { completed: 0, quarantined: 0, failed: 0, cancelled: 0 };
  for (const item of run.items) {
    valuesAreUnique(item.role_artifacts.map((artifact) => artifact.role), `${item.asset_id} 角色制品`);
    for (const artifact of item.role_artifacts) {
      assert(item.attempts[artifact.role] > 0, `${item.asset_id} 的 ${artifact.role} 制品没有对应尝试。`);
      persistedCalls += artifact.usage.calls;
      persistedSpend += artifact.usage.estimated_cost;
      if (run.mode === "mock") {
        assert(artifact.output_path === null && artifact.usage.calls === 0,
          `${item.asset_id} 的 Mock 角色制品不得引用真实输出或费用。`);
      } else {
        assert(artifact.output_path !== null && artifact.usage.calls === 1,
          `${item.asset_id} 的真实角色制品必须引用结构化输出与一次调用。`);
      }
    }
    if (item.outcome !== null) actual[item.outcome] += 1;
    assert((item.outcome === null) === !terminalItemStates.has(item.state),
      `${item.asset_id} 的状态与 outcome 不一致。`);
    if (item.artifact !== null) {
      assert(item.outcome === "completed" || item.outcome === "quarantined",
        `${item.asset_id} 只有完成或隔离状态可以引用训练制品。`);
    }
  }
  const actualTerminal = Object.values(actual).reduce((sum, value) => sum + value, 0);
  assert(run.counts.total === run.items.length, "训练运行 total 与 items 数量不一致。");
  assert(run.counts.terminal === actualTerminal, "训练运行 terminal 计数不一致。");
  for (const [outcome, count] of Object.entries(actual)) {
    assert(run.counts[outcome] === count, `训练运行 ${outcome} 计数不一致。`);
  }
  if (run.schema_version === "1.1") {
    valuesAreUnique(run.call_records.map((record) => record.call_id), "训练运行调用记录");
    const itemsById = new Map(run.items.map((item) => [item.asset_id, item]));
    for (const record of run.call_records) {
      const item = itemsById.get(record.asset_id);
      assert(item, `训练运行调用记录引用未知资产：${record.asset_id}`);
      const interruptedAllowance = record.error?.code === "TRAINING_INTERRUPTED_CALL" ? 1 : 0;
      assert(record.attempt <= item.attempts[record.role] + interruptedAllowance,
        `${record.asset_id} 的调用记录尝试次数超过样例状态。`);
      assert((record.status === "successful") === (record.error === null)
        && (record.status !== "successful") === (record.error !== null),
        `${record.call_id} 的调用状态与错误记录不一致。`);
    }
    const successfulRecords = run.call_records.filter((record) => record.status === "successful");
    assert(run.budget.provider_calls === run.call_records.length,
      "训练运行 Provider 调用数与调用记录不一致。");
    assert(persistedCalls === successfulRecords.length,
      "训练运行角色制品数与成功调用记录不一致。");
    assert(run.budget.uncertain_calls
      === run.call_records.filter((record) => record.status === "uncertain").length,
    "训练运行不确定调用数与调用记录不一致。");
    assert(Math.abs(run.budget.estimated_spend
      - run.call_records.reduce((sum, record) => sum + record.usage.estimated_cost, 0)) <= 0.000001,
    "训练运行估算费用与调用记录不一致。");
    assert(run.budget.provider_calls <= run.configuration.max_provider_calls,
      "训练运行 Provider 调用数超过显式上限。");
    if (run.mode === "mock") {
      assert(run.call_records.length === 0 && run.configuration.max_provider_calls === 0,
        "Mock 训练不得包含真实调用记录或调用额度。");
    }
  } else {
    assert(run.budget.provider_calls === persistedCalls + run.budget.uncertain_calls,
      "训练运行 Provider 调用数与角色制品及不确定调用不一致。");
    assert(Math.abs(run.budget.estimated_spend
      - (persistedSpend + run.budget.uncertain_calls * run.budget.max_cost_per_call)) <= 0.000001,
    "训练运行估算费用与角色用量及不确定调用不一致。");
  }
  if (terminalRunStates.has(run.status)) {
    assert(run.counts.terminal === run.counts.total, "终态训练运行仍包含非终态样例。");
    assert(run.completed_at !== null && run.stop_reason !== null, "终态训练运行缺少完成时间或停止原因。");
    assert(run.budget.reserved === 0 && run.budget.reserved_calls === 0,
      "终态训练运行仍包含未结算预算租约。");
  }
}

function validateArtifactBusinessRules(artifact) {
  valuesAreUnique(artifact.role_artifacts.map((roleArtifact) => roleArtifact.role), "训练制品角色");
  assert(artifact.role_artifacts.length === roles.length, "训练制品必须恰好包含五个角色。");
  valuesAreUnique(
    artifact.skill_improvement_candidates.flatMap((candidate) =>
      candidate.evidence_ids.map((evidenceId) => `${candidate.skill_id}:${candidate.artifact_type}:${evidenceId}`)),
    "训练制品改进候选证据",
  );
  if (artifact.outcome === "quarantined") {
    assert(artifact.findings.some((finding) => finding.severity === "blocking"),
      "隔离制品必须保留至少一个阻断证据。");
  }
}

function validateReportBusinessRules(report) {
  valuesAreUnique(report.skills.map((skill) => `${skill.id}@${skill.version}`), "训练报告 Skill 快照");
  valuesAreUnique(report.role_runs.map((roleRun) => roleRun.role), "训练报告角色");
  assert(report.role_runs.length === roles.length, "训练报告必须恰好包含五个角色。");
  const counted = report.counts.completed
    + report.counts.quarantined
    + report.counts.failed
    + report.counts.cancelled;
  assert(counted === report.counts.total, "训练报告样例计数总和不一致。");
  assert(report.checkpoint.artifact_count <= report.counts.completed + report.counts.quarantined,
    "训练报告制品数量超过已完成与隔离样例数。");
  assert(report.budget.estimated_spend <= report.budget.limit, "训练报告估算费用超过预算上限。");
  if (["1.3", "1.4", "1.5"].includes(report.schema_version)) {
    assert(report.selection.content_hash === contentHash(report.selection), "训练报告选择范围哈希不匹配。");
    assert(report.run_configuration.selection_hash === report.selection.content_hash,
      "训练报告配置与选择范围哈希不一致。");
    assert(report.telemetry.provider_calls === report.budget.provider_calls,
      "训练报告遥测调用数与预算调用数不一致。");
    assert(report.telemetry.uncertain_calls === report.budget.uncertain_calls,
      "训练报告遥测不确定调用数与预算不一致。");
    const failedCalls = report.telemetry.failed_calls ?? 0;
    assert(report.telemetry.successful_calls
      + failedCalls
      + report.telemetry.uncertain_calls
      === report.telemetry.provider_calls,
    "训练报告调用状态计数不一致。");
    assert(report.selection.selected_asset_count === report.counts.total,
      "训练报告选择数与样例总数不一致。");
    assert(report.telemetry.provider_calls <= report.run_configuration.max_provider_calls,
      "训练报告 Provider 调用数超过显式上限。");
    assert(Math.abs(report.telemetry.estimated_cost - report.budget.estimated_spend) <= 0.000001,
      "训练报告遥测费用与预算估算不一致。");
    const telemetryProperties = [
      "provider_calls",
      "successful_calls",
      "uncertain_calls",
      "prompt_tokens",
      "completion_tokens",
      "estimated_cost",
      "total_latency_ms",
    ];
    if (["1.4", "1.5"].includes(report.schema_version)) telemetryProperties.push("failed_calls");
    for (const property of telemetryProperties) {
      const roleTotal = report.role_runs.reduce((sum, roleRun) => sum + roleRun[property], 0);
      assert(Math.abs(roleTotal - report.telemetry[property]) <= 0.000001,
        `训练报告角色遥测 ${property} 与总计不一致。`);
    }
  }
  valuesAreUnique(report.metrics.map((metric) => metric.dimension), "训练报告评测维度");
  if (report.schema_version === "1.5" && report.status !== "cancelled") {
    assert(report.metrics.length === evaluationMetricDefinitions.length,
      "1.5 训练报告必须包含完整九维评测指标。");
    assert(evaluationMetricDefinitions.every((definition) =>
      report.metrics.some((metric) => metric.dimension === definition.dimension)),
    "1.5 训练报告缺少必需评测维度。");
  }
  if (report.status === "completed") {
    assert(report.counts.failed === 0 && report.counts.cancelled === 0,
      "completed 训练报告不能包含失败或取消样例。");
  }
}

function validateRoleOutputBusinessRules(output) {
  valuesAreUnique(
    [
      ...output.result.observations,
      ...output.result.directions,
    ].map((entry) => entry.evidence_id),
    "训练角色输出证据 ID",
  );
  if (output.role === "observer") {
    assert(output.result.observations.length > 0, "观察者角色输出缺少可见事实。");
  } else {
    assert(output.result.observations.length === 0, `${output.role} 不得新增观察事实。`);
  }
  if (output.role === "direction_generator") {
    const decision = output.result.direction_decision;
    if (output.schema_version === "2.0") {
      assert(decision, "2.0 方向生成者角色输出缺少 direction_decision。");
      assert(
        (decision.outcome === "options" && output.result.directions.length > 0)
          || (decision.outcome === "no_options" && output.result.directions.length === 0),
        "2.0 方向决定与确定性中文投影不一致。",
      );
    } else {
      assert(output.result.directions.length > 0, "方向生成者角色输出缺少可选方向。");
    }
  } else {
    assert(output.result.directions.length === 0, `${output.role} 不得新增观看方向。`);
  }
  if (!["critic", "red_team"].includes(output.role)) {
    assert(output.result.findings.length === 0, `${output.role} 不得新增门禁问题。`);
  }
  if (output.role !== "curator") {
    assert(output.result.candidates.length === 0, `${output.role} 不得新增 Skill 改进候选。`);
  }
}

function isWithin(root, target) {
  const pathFromRoot = relative(root, target);
  return pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !pathFromRoot.startsWith("../");
}

function assertSafeOutputPath(path, containmentRoot) {
  const root = realpathSync(containmentRoot);
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  assert(!lstatSync(parent).isSymbolicLink(), `输出目录不能是符号链接：${parent}`);
  const realParent = realpathSync(parent);
  assert(isWithin(root, realParent), `输出路径越过训练运行目录：${path}`);
  if (existsSync(path)) {
    assert(!lstatSync(path).isSymbolicLink(), `输出文件不能是符号链接：${path}`);
    assert(isWithin(root, realpathSync(path)), `输出文件越过训练运行目录：${path}`);
  }
}

function assertSafeExistingFile(path, containmentRoot) {
  assert(existsSync(path), `缺少文件：${path}`);
  const root = realpathSync(containmentRoot);
  assert(!lstatSync(dirname(path)).isSymbolicLink(), `输入目录不能是符号链接：${dirname(path)}`);
  assert(!lstatSync(path).isSymbolicLink(), `输入文件不能是符号链接：${path}`);
  assert(isWithin(root, realpathSync(path)), `输入文件越过训练运行目录：${path}`);
}

function numberOption(args, name, fallback, minimum, maximum) {
  const raw = args.options.get(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  assert(Number.isFinite(value) && Number.isInteger(value) && value >= minimum && value <= maximum,
    `${name} 必须是 ${minimum}～${maximum} 的整数。`);
  return value;
}

function decimalOption(args, name, fallback, minimum, maximum) {
  const raw = args.options.get(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  assert(Number.isFinite(value) && value >= minimum && value <= maximum,
    `${name} 必须是 ${minimum}～${maximum} 的数字。`);
  return value;
}

function timestampOption(args, name, fallback) {
  const raw = args.options.get(name) ?? fallback;
  assert(typeof raw === "string"
    && /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z$/u.test(raw)
    && Number.isFinite(Date.parse(raw)),
  `${name} 必须是 UTC ISO-8601 时间。`);
  return raw;
}

function assetIdsOption(args) {
  assert(!args.flags.has("--asset-ids"), "--asset-ids 必须提供逗号分隔的 asset_id。");
  const raw = args.options.get("--asset-ids");
  if (raw === undefined) return null;
  const assetIds = raw.split(",").map((value) => value.trim());
  assert(assetIds.length > 0 && assetIds.every((value) => value.length > 0),
    "--asset-ids 不能包含空 asset_id。");
  assert(assetIds.length <= 60, "--asset-ids 最多选择 60 项。");
  valuesAreUnique(assetIds, "--asset-ids");
  for (const assetId of assetIds) {
    assert(/^[a-z][a-z0-9_-]{2,79}$/u.test(assetId), `asset_id 格式不正确：${assetId}`);
  }
  return assetIds;
}

function selectTrainingAssets(manifest, requestedAssetIds) {
  if (requestedAssetIds === null) return manifest.assets;
  const assetsById = new Map(manifest.assets.map((asset) => [asset.asset_id, asset]));
  return requestedAssetIds.map((assetId) => {
    const asset = assetsById.get(assetId);
    assert(asset, `--asset-ids 包含不在正式清单中的资产：${assetId}`);
    return asset;
  });
}

function buildSelection(manifest, selectedAssets, explicit) {
  const splitCounts = { training: 0, regression: 0, holdout: 0 };
  for (const asset of selectedAssets) splitCounts[asset.dataset_split] += 1;
  const selection = {
    strategy: explicit ? "explicit_asset_ids" : "all",
    source_asset_count: manifest.assets.length,
    selected_asset_count: selectedAssets.length,
    asset_ids: selectedAssets.map((asset) => asset.asset_id),
    split_counts: splitCounts,
    content_hash: "sha256:pending",
  };
  selection.content_hash = contentHash(selection);
  return selection;
}

function safeRunDirectory(outputDirectory, runId) {
  assert(/^[a-zA-Z0-9][a-zA-Z0-9_-]{2,127}$/u.test(runId), "run_id 格式不正确。");
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  assert(lstatSync(outputDirectory).isDirectory(), "训练输出根路径不是目录。");
  const realOutputDirectory = realpathSync(outputDirectory);
  const directory = resolve(realOutputDirectory, runId);
  assert(isWithin(realOutputDirectory, directory), "训练运行目录越界。");
  if (existsSync(directory)) {
    assert(!lstatSync(directory).isSymbolicLink(), "训练运行目录不能是符号链接。");
    assert(lstatSync(directory).isDirectory(), "训练运行路径不是目录。");
    assert(isWithin(realOutputDirectory, realpathSync(directory)), "训练运行目录越过输出根路径。");
  }
  return directory;
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function acquireRunLock(runDirectory) {
  mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
  const lockPath = resolve(runDirectory, runLockFileName);
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor;
    try {
      assertSafeOutputPath(lockPath, runDirectory);
      descriptor = openSync(lockPath, "wx", 0o600);
      writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, token })}\n`, "utf8");
      closeSync(descriptor);
      descriptor = undefined;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (!existsSync(lockPath) || lstatSync(lockPath).isSymbolicLink()) return;
        try {
          const current = readJson(lockPath);
          if (current.token === token) unlinkSync(lockPath);
        } catch {
          // 无法证明锁属于当前进程时保持关闭失败，不删除未知文件。
        }
      };
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      if (error?.code !== "EEXIST") throw error;
      assertSafeExistingFile(lockPath, runDirectory);
      let lock;
      try {
        lock = readJson(lockPath);
      } catch {
        throw new Error("训练运行锁损坏，拒绝覆盖。");
      }
      if (isProcessAlive(Number(lock.pid))) {
        const activeError = new Error("同一 run_id 已有活动训练进程。");
        activeError.code = "TRAINING_RUN_ACTIVE";
        throw activeError;
      }
      unlinkSync(lockPath);
    }
  }
  throw new Error("无法取得训练运行锁。");
}

function cancellationRequestPath(runDirectory) {
  return resolve(runDirectory, cancellationRequestFileName);
}

function requestActiveRunCancellation(runDirectory) {
  const path = cancellationRequestPath(runDirectory);
  assertSafeOutputPath(path, runDirectory);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify({
    requested_at: new Date().toISOString(),
    requester_pid: process.pid,
  })}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporaryPath, path);
}

function isCancellationRequested(runDirectory) {
  const path = cancellationRequestPath(runDirectory);
  if (!existsSync(path)) return false;
  assertSafeExistingFile(path, runDirectory);
  return true;
}

function clearCancellationRequest(runDirectory) {
  const path = cancellationRequestPath(runDirectory);
  if (!existsSync(path)) return;
  assertSafeExistingFile(path, runDirectory);
  unlinkSync(path);
}

function validateDataset(manifestPath, splitsPath) {
  const result = spawnSync(
    process.execPath,
    [
      resolve(repositoryRoot, "scripts/dataset-tools.mjs"),
      "validate",
      "--manifest",
      manifestPath,
      "--splits",
      splitsPath,
      "--manifest-only",
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert(result.status === 0, `摄影数据集未通过门禁：${result.stderr.trim() || result.stdout.trim()}`);
  const manifest = readJson(manifestPath);
  assert(manifest.assets.length === 60, "Skill Trainer 必须基于完整 60 项正式清单选择运行范围。");
  return manifest;
}

function loadSkillReferences() {
  return requiredSkillIds.map((skillId) => {
    const definition = readJson(resolve(repositoryRoot, "skill-modules", skillId, "skill.json"));
    assert(definition.skill_id === skillId, `Skill 定义路径与 ID 不一致：${skillId}`);
    assert(definition.status === "active", `Mock Trainer 需要活动 Skill：${skillId}`);
    assert(/^[0-9]+\.[0-9]+\.[0-9]+/u.test(definition.skill_version), `${skillId} 版本格式不正确。`);
    assert(/^sha256:[a-f0-9]{64}$/u.test(definition.content_hash), `${skillId} 内容哈希格式不正确。`);
    return {
      id: definition.skill_id,
      version: definition.skill_version,
      content_hash: definition.content_hash,
    };
  });
}

function buildConfiguration(args, mode, selectionHash) {
  const maxAttempts = numberOption(args, "--max-attempts", 2, 1, 5);
  const timeoutMs = numberOption(args, "--timeout-ms", 2000, 100, 600000);
  const concurrency = numberOption(args, "--concurrency", 2, 1, 8);
  const maxProviderCalls = numberOption(args, "--max-provider-calls", 0, 0, 2500);
  const budgetLimit = decimalOption(args, "--budget", mode === "mock" ? 0 : Number.NaN, 0, 1000000);
  if (mode === "mock") assert(budgetLimit === 0, "Mock 训练预算必须为 0。");
  if (mode === "mock") assert(maxProviderCalls === 0, "Mock 训练的 Provider 调用上限必须为 0。");
  const provider = mode === "mock" ? "mock" : (args.options.get("--provider") ?? "");
  const inputPerMillion = decimalOption(
    args,
    "--input-per-million",
    mode === "mock" ? 0 : Number.NaN,
    0,
    1000000,
  );
  const outputPerMillion = decimalOption(
    args,
    "--output-per-million",
    mode === "mock" ? 0 : Number.NaN,
    0,
    1000000,
  );
  const maxCostPerCall = decimalOption(
    args,
    "--max-cost-per-call",
    mode === "mock" ? 0 : Number.NaN,
    0,
    1000000,
  );
  const pricingEffectiveAt = timestampOption(
    args,
    "--pricing-effective-at",
    "1970-01-01T00:00:00Z",
  );

  const configuration = {
    provider,
    model: mode === "mock" ? "trainer-fixture-v1" : (args.options.get("--model") ?? ""),
    prompt_version: "2.0.2",
    schema_version: "2.0.2",
    independence_level: mode === "mock"
      ? "mock_fixture"
      : (args.options.get("--independence") ?? "same_model_different_roles"),
    max_attempts: maxAttempts,
    timeout_ms: timeoutMs,
    concurrency,
    fail_fast: args.flags.has("--fail-fast"),
    max_provider_calls: maxProviderCalls,
    selection_hash: selectionHash,
    budget_limit: budgetLimit,
    currency: "CNY",
    pricing_version: mode === "mock" ? "mock-unpriced" : (args.options.get("--pricing-version") ?? ""),
    pricing_effective_at: pricingEffectiveAt,
    input_per_million_cny: inputPerMillion,
    output_per_million_cny: outputPerMillion,
    max_cost_per_call: maxCostPerCall,
    base_url: mode === "live" && provider === "qwen"
      ? (args.options.get("--base-url") ?? defaultQwenBaseUrl)
      : null,
    mock_scenario_version: mockScenarioVersion,
    config_hash: "sha256:pending",
  };
  const configurationForHash = { ...configuration };
  delete configurationForHash.config_hash;
  configuration.config_hash = canonicalHash(configurationForHash);
  return configuration;
}

function guardLiveTraining(args, configuration, selection) {
  assert(args.flags.has("--allow-network"), "真实训练必须显式传入 --allow-network。");
  assert(Number.isFinite(configuration.budget_limit) && configuration.budget_limit > 0,
    "真实训练必须显式传入大于 0 的 --budget。");
  assert(args.options.has("--max-provider-calls") && configuration.max_provider_calls > 0,
    "真实训练必须显式传入大于 0 的 --max-provider-calls。");
  assert(configuration.max_provider_calls
    <= selection.selected_asset_count * roles.length * configuration.max_attempts,
  "--max-provider-calls 不能超过当前选择范围与重试上限的理论调用数。");
  const fixtureAllowed = process.env.NODE_ENV === "test"
    && process.env.ZHAOJIAN_ENABLE_TRAINING_FIXTURE === "1";
  assert(configuration.provider === "qwen" || (fixtureAllowed && configuration.provider === "test-fixture"),
    "真实训练当前只允许显式指定 --provider qwen。");
  assert(configuration.model.length > 0, "真实训练必须显式传入 --model。");
  assert(configuration.pricing_version.length > 0, "真实训练必须显式传入 --pricing-version。");
  assert(args.options.has("--pricing-effective-at"),
    "真实训练必须显式传入 --pricing-effective-at。");
  assert(Number.isFinite(configuration.input_per_million_cny)
    && Number.isFinite(configuration.output_per_million_cny)
    && configuration.input_per_million_cny + configuration.output_per_million_cny > 0,
  "真实训练必须显式传入有效的输入与输出 Token 单价。");
  assert(Number.isFinite(configuration.max_cost_per_call) && configuration.max_cost_per_call > 0,
    "真实训练必须显式传入大于 0 的 --max-cost-per-call。");
  assert(configuration.max_cost_per_call <= configuration.budget_limit,
    "单次调用费用租约不能超过总预算。");
  if (configuration.provider === "qwen") {
    assert(configuration.base_url === defaultQwenBaseUrl,
      "真实训练的 Qwen Base URL 必须使用冻结的官方兼容端点。");
    assert(process.env.Model__Qwen__ApiKey?.trim(), "真实训练缺少服务端环境变量 Model__Qwen__ApiKey。");
    createQwenTrainingProvider({
      baseUrl: configuration.base_url,
      apiKey: process.env.Model__Qwen__ApiKey,
      model: configuration.model,
      fetchImpl: async () => {
        throw new Error("guard-only");
      },
    });
  }
}

function validateResumeOptions(args, requested, stored) {
  const optionMappings = [
    ["--provider", "provider"],
    ["--model", "model"],
    ["--independence", "independence_level"],
    ["--max-attempts", "max_attempts"],
    ["--timeout-ms", "timeout_ms"],
    ["--concurrency", "concurrency"],
    ["--max-provider-calls", "max_provider_calls"],
    ["--budget", "budget_limit"],
    ["--pricing-version", "pricing_version"],
    ["--pricing-effective-at", "pricing_effective_at"],
    ["--input-per-million", "input_per_million_cny"],
    ["--output-per-million", "output_per_million_cny"],
    ["--max-cost-per-call", "max_cost_per_call"],
    ["--base-url", "base_url"],
  ];
  for (const [option, property] of optionMappings) {
    if (!args.options.has(option)) continue;
    assert(requested[property] === stored[property],
      `恢复参数 ${option} 与已有检查点配置不一致。`);
  }
  assert(stored.prompt_version === requested.prompt_version
    && stored.schema_version === requested.schema_version
    && stored.fail_fast === requested.fail_fast
    && stored.mock_scenario_version === requested.mock_scenario_version,
  "已有检查点与当前 Trainer 协议版本不一致。");
}

function emptyAttempts() {
  return Object.fromEntries(roles.map(({ role }) => [role, 0]));
}

function newRun(runId, mode, manifest, selection, selectedAssets, skills, configuration, timestamp) {
  const run = {
    schema_version: "1.1",
    run_id: runId,
    mode,
    status: "queued",
    dataset: {
      id: manifest.dataset_id,
      version: manifest.dataset_version,
      content_hash: manifest.content_hash,
    },
    selection,
    skills,
    configuration,
    budget: {
      currency: configuration.currency,
      limit: configuration.budget_limit,
      reserved: 0,
      reserved_calls: 0,
      estimated_spend: 0,
      provider_calls: 0,
      uncertain_calls: 0,
      pricing_version: configuration.pricing_version,
      pricing_effective_at: configuration.pricing_effective_at,
      input_per_million_cny: configuration.input_per_million_cny,
      output_per_million_cny: configuration.output_per_million_cny,
      max_cost_per_call: configuration.max_cost_per_call,
    },
    call_records: [],
    counts: {
      total: selectedAssets.length,
      terminal: 0,
      completed: 0,
      quarantined: 0,
      failed: 0,
      cancelled: 0,
    },
    items: selectedAssets.map((asset) => ({
      asset_id: asset.asset_id,
      dataset_split: asset.dataset_split,
      state: "queued",
      current_role: null,
      attempts: emptyAttempts(),
      role_artifacts: [],
      findings: [],
      outcome: null,
      artifact: null,
      last_error: null,
      updated_at: timestamp,
    })),
    started_at: timestamp,
    updated_at: timestamp,
    completed_at: null,
    stop_reason: null,
    content_hash: "sha256:pending",
  };
  updateCounts(run);
  return run;
}

function updateCounts(run) {
  const outcomes = { completed: 0, quarantined: 0, failed: 0, cancelled: 0 };
  for (const item of run.items) {
    if (item.outcome in outcomes) outcomes[item.outcome] += 1;
  }
  run.counts = {
    total: run.items.length,
    terminal: Object.values(outcomes).reduce((sum, value) => sum + value, 0),
    ...outcomes,
  };
}

async function checkpoint(run, runPath) {
  updateCounts(run);
  run.updated_at = new Date().toISOString();
  const snapshot = structuredClone(run);
  const operation = checkpointGate.then(() => {
    const written = writeDocument(runPath, snapshot, validators.run, "训练运行检查点", dirname(runPath));
    run.content_hash = written.content_hash;
  });
  checkpointGate = operation.catch(() => {});
  await operation;
}

function roundCost(value) {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function isDispatchStopped(run) {
  return dispatchStopReasons.has(run.stop_reason);
}

async function reserveBudgetLease(run, runPath) {
  if (run.budget.provider_calls + run.budget.reserved_calls >= run.configuration.max_provider_calls) {
    run.stop_reason = "provider_call_limit_reached";
    await checkpoint(run, runPath);
    return null;
  }
  const amount = run.budget.max_cost_per_call;
  const available = roundCost(run.budget.limit - run.budget.estimated_spend - run.budget.reserved);
  if (available + 0.000001 < amount) {
    run.stop_reason = "budget_exhausted";
    await checkpoint(run, runPath);
    return null;
  }
  run.budget.reserved = roundCost(run.budget.reserved + amount);
  run.budget.reserved_calls += 1;
  await checkpoint(run, runPath);
  return { amount, settled: false };
}

function releaseBudgetLease(run, lease) {
  assert(lease && !lease.settled, "预算租约已结算或不存在。");
  run.budget.reserved = roundCost(run.budget.reserved - lease.amount);
  run.budget.reserved_calls -= 1;
  lease.settled = true;
}

function settleSuccessfulBudgetLease(run, lease, usage) {
  const estimatedCost = calculateEstimatedCost(usage, {
    inputPerMillion: run.budget.input_per_million_cny,
    outputPerMillion: run.budget.output_per_million_cny,
  });
  if (estimatedCost > lease.amount + 0.000001) {
    releaseBudgetLease(run, lease);
    run.budget.estimated_spend = roundCost(run.budget.estimated_spend + lease.amount);
    run.budget.provider_calls += 1;
    run.budget.uncertain_calls += 1;
    run.stop_reason = "budget_exhausted";
    const error = new Error("Provider 用量超过单次费用租约，已停止派发新工作。");
    error.code = "BUDGET_LEASE_EXCEEDED";
    error.retryable = false;
    throw error;
  }
  releaseBudgetLease(run, lease);
  run.budget.estimated_spend = roundCost(run.budget.estimated_spend + estimatedCost);
  run.budget.provider_calls += 1;
  return { ...usage, estimated_cost: estimatedCost };
}

async function settleUncertainBudgetLease(run, runPath, lease) {
  if (!lease || lease.settled) return;
  releaseBudgetLease(run, lease);
  run.budget.estimated_spend = roundCost(run.budget.estimated_spend + lease.amount);
  run.budget.provider_calls += 1;
  run.budget.uncertain_calls += 1;
  await checkpoint(run, runPath);
}

async function reconcileInterruptedBudgetLeases(run, runPath) {
  if (run.budget.reserved_calls === 0) return;
  if (run.schema_version === "1.1") {
    const activeItems = run.items.filter((item) => item.current_role !== null);
    for (let index = 0; index < run.budget.reserved_calls; index += 1) {
      const item = activeItems[index] ?? activeItems[0] ?? run.items[0];
      const role = item.current_role ?? roles[0].role;
      run.call_records.push({
        call_id: `call_${randomUUID().replaceAll("-", "")}`,
        asset_id: item.asset_id,
        role,
        attempt: Math.max(1, item.attempts[role] ?? 0),
        status: "uncertain",
        started_at: run.updated_at,
        completed_at: new Date().toISOString(),
        latency_ms: 0,
        usage: {
          prompt_tokens: 0,
          completion_tokens: 0,
          calls: 1,
          estimated_cost: run.budget.max_cost_per_call,
        },
        error: {
          code: "TRAINING_INTERRUPTED_CALL",
          message: "进程中断时存在未结算调用，已按最大单次费用保守记录。",
          retryable: true,
        },
      });
    }
  }
  run.budget.estimated_spend = roundCost(run.budget.estimated_spend + run.budget.reserved);
  run.budget.provider_calls += run.budget.reserved_calls;
  run.budget.uncertain_calls += run.budget.reserved_calls;
  run.budget.reserved = 0;
  run.budget.reserved_calls = 0;
  await checkpoint(run, runPath);
}

function roleIndexForItem(item) {
  if (item.state === "queued") return 0;
  return roles.findIndex(({ state }) => state === item.state);
}

function addFinding(item, finding) {
  if (!item.findings.some((existing) => existing.code === finding.code && existing.role === finding.role)) {
    item.findings.push(finding);
  }
}

function roleOutputHash(assetId, role, attempt) {
  return canonicalHash({
    mock_scenario_version: mockScenarioVersion,
    asset_id: assetId,
    role,
    attempt,
    disclaimer: "Mock 未读取图片内容，输出只用于验证状态机。",
  });
}

async function executeMockRole(item, role, attempt, delayMs) {
  if (delayMs > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
  if (item.asset_id === "photo-v1-difficult-004" && role === "direction_generator" && attempt === 1) {
    const error = new Error("Mock 注入一次可重试的方向生成失败。");
    error.code = "MOCK_TRANSIENT_FAILURE";
    error.retryable = true;
    throw error;
  }

  if (role === "critic" && item.asset_id === "photo-v1-difficult-001") {
    addFinding(item, {
      code: "low_confidence",
      evidence: "Mock 困难场景标记为低置信度，进入隔离区而不强行形成训练结论。",
      role: "critic",
      severity: "blocking",
      validation_status: "quarantined",
    });
  }
  if (role === "critic" && item.asset_id === "photo-v1-difficult-002") {
    addFinding(item, {
      code: "model_disagreement",
      evidence: "Mock 观察者与批评者对可见关系存在分歧，保留分歧并隔离。",
      role: "critic",
      severity: "blocking",
      validation_status: "disputed",
    });
  }
  if (role === "red_team" && item.asset_id === "photo-v1-difficult-003") {
    addFinding(item, {
      code: "prompt_injection_risk",
      evidence: "Mock 红队场景命中图片文字注入风险，确定性门禁阻止进入训练候选。",
      role: "red_team",
      severity: "blocking",
      validation_status: "confirmed_by_gate",
    });
  }

  return {
    role,
    output_hash: roleOutputHash(item.asset_id, role, attempt),
    output_path: null,
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      calls: 0,
      estimated_cost: 0,
    },
    status: "completed",
  };
}

async function withTimeout(operation, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error("训练角色执行超时。");
          error.code = "TRAINING_ROLE_TIMEOUT";
          error.retryable = true;
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function loadTrainingAsset(manifestDirectory, asset) {
  assert(asset && asset.status === "approved", "真实训练只能读取已通过门禁的资产。");
  const root = realpathSync(manifestDirectory);
  const assetPath = resolve(root, asset.derivative_path);
  assert(isWithin(root, assetPath), `${asset.asset_id} 的本地副本路径越界。`);
  assertSafeExistingFile(assetPath, root);
  const bytes = readFileSync(assetPath);
  assert(`sha256:${digest(bytes)}` === asset.content_hash, `${asset.asset_id} 的本地副本哈希不匹配。`);
  return {
    assetId: asset.asset_id,
    category: asset.category,
    mimeType: "image/jpeg",
    bytes,
  };
}

function readRoleOutput(run, item, roleArtifact, runDirectory) {
  assert(roleArtifact.output_path, `${item.asset_id} 的 ${roleArtifact.role} 缺少角色输出引用。`);
  const output = readDocument(
    resolve(runDirectory, roleArtifact.output_path),
    validators.roleOutput,
    `${item.asset_id} ${roleArtifact.role} 角色输出`,
    runDirectory,
  );
  assert(output.content_hash === roleArtifact.output_hash,
    `${item.asset_id} 的 ${roleArtifact.role} 输出引用哈希不匹配。`);
  assert(output.run_id === run.run_id
    && output.asset_id === item.asset_id
    && output.role === roleArtifact.role,
  `${item.asset_id} 的 ${roleArtifact.role} 输出身份不匹配。`);
  return output;
}

function previousRoleOutputs(run, item, runDirectory) {
  return roles
    .map(({ role }) => item.role_artifacts.find((artifact) => artifact.role === role))
    .filter((artifact) => artifact?.output_path)
    .map((artifact) => readRoleOutput(run, item, artifact, runDirectory));
}

function roleOutputRelativePath(item, role) {
  return `role-outputs/${item.asset_id}/${role}.json`;
}

async function executeLiveRole(
  run,
  item,
  role,
  attempt,
  runDirectory,
  runPath,
  options,
  lease,
  repairContext,
) {
  const startedAt = new Date().toISOString();
  const startedMilliseconds = Date.now();
  const callId = `call_${randomUUID().replaceAll("-", "")}`;
  try {
    const assetMetadata = options.assetsById.get(item.asset_id);
    const previousOutputs = previousRoleOutputs(run, item, runDirectory);
    const providerResponse = await options.provider.executeRole({
      role,
      asset: loadTrainingAsset(options.manifestDirectory, assetMetadata),
      previousOutputs,
      timeoutMs: run.configuration.timeout_ms,
      attempt,
      repairContext,
    });
    const estimatedCost = calculateEstimatedCost(providerResponse.usage, {
      inputPerMillion: run.budget.input_per_million_cny,
      outputPerMillion: run.budget.output_per_million_cny,
    });
    if (estimatedCost > lease.amount + 0.000001) {
      settleSuccessfulBudgetLease(run, lease, providerResponse.usage);
    }
    const usage = { ...providerResponse.usage, estimated_cost: estimatedCost };
    const outputPath = roleOutputRelativePath(item, role);
    const output = writeDocument(
      resolve(runDirectory, outputPath),
      {
        schema_version: "2.0",
        run_id: run.run_id,
        asset_id: item.asset_id,
        role,
        attempt,
        provider: run.configuration.provider,
        model: run.configuration.model,
        result: providerResponse.result,
        usage,
        created_at: new Date().toISOString(),
        content_hash: "sha256:pending",
      },
      validators.roleOutput,
      `${item.asset_id} ${role} 角色输出`,
      runDirectory,
    );
    const roleArtifact = {
      role,
      output_hash: output.content_hash,
      output_path: outputPath,
      usage,
      status: "completed",
    };
    item.role_artifacts = item.role_artifacts.filter((artifact) => artifact.role !== role);
    item.role_artifacts.push(roleArtifact);
    settleSuccessfulBudgetLease(run, lease, providerResponse.usage);
    run.call_records.push({
      call_id: callId,
      asset_id: item.asset_id,
      role,
      attempt,
      status: "successful",
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      latency_ms: Date.now() - startedMilliseconds,
      usage,
      error: null,
    });
    for (const finding of providerResponse.result.findings) {
      addFinding(item, {
        ...finding,
        role,
      });
    }
    for (const exclusion of providerResponse.policyExclusions ?? []) {
      addFinding(item, {
        ...exclusion,
        role: "deterministic_gate",
        severity: "info",
        validation_status: "confirmed_by_gate",
      });
    }
    return roleArtifact;
  } catch (error) {
    if (!run.call_records.some((record) => record.call_id === callId)) {
      let status = "uncertain";
      let usage = {
        prompt_tokens: 0,
        completion_tokens: 0,
        calls: 1,
        estimated_cost: lease.amount,
      };
      if (error?.usage && !lease.settled) {
        const estimatedCost = calculateEstimatedCost(error.usage, {
          inputPerMillion: run.budget.input_per_million_cny,
          outputPerMillion: run.budget.output_per_million_cny,
        });
        settleSuccessfulBudgetLease(run, lease, error.usage);
        status = "failed";
        usage = { ...error.usage, estimated_cost: estimatedCost };
      }
      run.call_records.push({
        call_id: callId,
        asset_id: item.asset_id,
        role,
        attempt,
        status,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        latency_ms: Date.now() - startedMilliseconds,
        usage,
        error: {
          code: error.code ?? "TRAINING_ROLE_FAILED",
          message: String(error.message ?? "训练角色失败。").slice(0, 240),
          retryable: error.retryable === true,
        },
      });
    }
    throw error;
  }
}

function evidenceIdsFromOutput(output) {
  return [...new Set([
    ...output.result.observations.map((entry) => entry.evidence_id),
    ...output.result.directions.map((entry) => entry.evidence_id),
    ...output.result.candidates.flatMap((entry) => entry.evidence_ids),
  ])];
}

function deduplicateImprovementCandidateEvidence(candidates) {
  const seen = new Set();
  const deduplicated = [];
  for (const candidate of candidates) {
    const evidenceIds = candidate.evidence_ids.filter((evidenceId) => {
      const key = `${candidate.skill_id}:${candidate.artifact_type}:${evidenceId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (evidenceIds.length === 0) continue;
    deduplicated.push({ ...candidate, evidence_ids: evidenceIds });
  }
  return deduplicated;
}

function artifactForItem(run, item, runDirectory) {
  const blocking = item.findings.some((finding) => finding.severity === "blocking");
  const accepted = !blocking;
  const liveOutputs = run.mode === "live"
    ? item.role_artifacts.map((artifact) => readRoleOutput(run, item, artifact, runDirectory))
    : [];
  const evidenceIds = item.role_artifacts.map((artifact, index) => {
    const ids = run.mode === "live" ? evidenceIdsFromOutput(liveOutputs[index]) : [];
    return ids.length > 0
      ? ids
      : [`${run.mode}_${item.asset_id.replaceAll("-", "_")}_${artifact.role}`];
  });
  const candidateAllowed = accepted && item.dataset_split === "training";
  const curatedCandidates = run.mode === "live"
    ? (liveOutputs.find((output) => output.role === "curator")?.result.candidates ?? [])
    : null;
  const artifact = {
    schema_version: "1.0",
    artifact_id: `artifact_${digest(`${run.run_id}:${item.asset_id}`).slice(0, 24)}`,
    run_id: run.run_id,
    asset_id: item.asset_id,
    dataset_split: item.dataset_split,
    label_origin: "model_suggested",
    mock_only: run.mode === "mock",
    eligible_for_training: false,
    role_artifacts: item.role_artifacts.map((roleArtifact, index) => ({
      role: roleArtifact.role,
      output_hash: roleArtifact.output_hash,
      validation_status: "passed",
      evidence_ids: evidenceIds[index],
    })),
    findings: structuredClone(item.findings),
    model_disagreement: item.findings.some((finding) => finding.code === "model_disagreement"),
    outcome: accepted ? "accepted" : "quarantined",
    skill_improvement_candidates: candidateAllowed
      ? deduplicateImprovementCandidateEvidence(curatedCandidates ?? [
          {
            skill_id: "observe-scene",
            artifact_type: "example",
            summary: "Mock 候选只验证观察制品整理路径，不包含真实照片事实，禁止进入正式训练。",
            evidence_ids: [evidenceIds[0][0]],
          },
          {
            skill_id: "composition-relations",
            artifact_type: "example",
            summary: "Mock 候选只验证关系方向整理路径，不包含真实观看建议，禁止进入正式训练。",
            evidence_ids: [evidenceIds[1][0]],
          },
        ])
      : [],
    content_hash: "sha256:pending",
  };
  return artifact;
}

function readAndVerifyArtifact(run, runDirectory, item) {
  assert(item.artifact, `${item.asset_id} 缺少训练制品引用。`);
  const artifactPath = resolve(runDirectory, item.artifact.path);
  const pathFromRun = relative(runDirectory, artifactPath);
  assert(pathFromRun !== ".." && !pathFromRun.startsWith(`..${sep}`), `${item.asset_id} 的制品路径越界。`);
  const artifact = readDocument(artifactPath, validators.artifact, `${item.asset_id} 训练制品`, runDirectory);
  assert(artifact.content_hash === item.artifact.content_hash, `${item.asset_id} 的制品引用哈希不匹配。`);
  assert(artifact.run_id === run.run_id && artifact.asset_id === item.asset_id, `${item.asset_id} 的制品身份不匹配。`);
  return artifact;
}

async function evaluateItem(run, item, runDirectory, runPath) {
  item.state = "evaluating";
  item.current_role = null;
  item.updated_at = new Date().toISOString();
  run.status = "evaluating";
  await checkpoint(run, runPath);

  let artifact;
  if (item.artifact) {
    artifact = readAndVerifyArtifact(run, runDirectory, item);
  } else {
    assert(item.role_artifacts.length === roles.length, `${item.asset_id} 未完成全部五个角色。`);
    artifact = writeDocument(
      resolve(runDirectory, "artifacts", `${item.asset_id}.json`),
      artifactForItem(run, item, runDirectory),
      validators.artifact,
      `${item.asset_id} 训练制品`,
      runDirectory,
    );
    item.artifact = {
      path: `artifacts/${item.asset_id}.json`,
      content_hash: artifact.content_hash,
    };
  }
  item.outcome = artifact.outcome === "quarantined" ? "quarantined" : "completed";
  item.state = item.outcome;
  item.last_error = null;
  item.updated_at = new Date().toISOString();
  await checkpoint(run, runPath);
}

async function processItem(run, item, runDirectory, runPath, options) {
  if (isCancellationRequested(runDirectory)) cancelRequested = true;
  if (terminalItemStates.has(item.state)) return;
  if (item.state === "evaluating") {
    await evaluateItem(run, item, runDirectory, runPath);
    return;
  }

  let roleIndex = roleIndexForItem(item);
  assert(roleIndex >= 0, `${item.asset_id} 处于无法恢复的状态：${item.state}`);
  for (; roleIndex < roles.length; roleIndex += 1) {
    if (isCancellationRequested(runDirectory)) cancelRequested = true;
    if (cancelRequested || interruptRequested || isDispatchStopped(run)) return;
    const { role, state } = roles[roleIndex];
    let completed = false;
    while (!completed && item.attempts[role] < run.configuration.max_attempts) {
      const repairContext = item.last_error?.repair_context ?? null;
      let budgetLease = null;
      if (run.mode === "live") {
        budgetLease = await reserveBudgetLease(run, runPath);
        if (!budgetLease) return;
      }
      item.state = state;
      item.current_role = role;
      item.attempts[role] += 1;
      item.last_error = null;
      item.updated_at = new Date().toISOString();
      run.status = state;
      await checkpoint(run, runPath);

      try {
        const output = run.mode === "mock"
          ? await withTimeout(
              executeMockRole(item, role, item.attempts[role], options.mockDelayMs),
              run.configuration.timeout_ms,
            )
          : await executeLiveRole(
              run,
              item,
              role,
              item.attempts[role],
              runDirectory,
              runPath,
              options,
              budgetLease,
              repairContext,
            );
        item.role_artifacts = item.role_artifacts.filter((artifact) => artifact.role !== role);
        item.role_artifacts.push(output);
        completed = true;
        item.last_error = null;
      } catch (error) {
        await settleUncertainBudgetLease(run, runPath, budgetLease);
        const retryable = error.retryable === true;
        item.last_error = {
          code: error.code ?? "TRAINING_ROLE_FAILED",
          message: String(error.message ?? "训练角色失败。").slice(0, 240),
          retryable,
          ...(error.repairContext ? { repair_context: error.repairContext } : {}),
        };
        if (!retryable || item.attempts[role] >= run.configuration.max_attempts) {
          item.state = "failed";
          item.outcome = "failed";
          item.current_role = null;
          if (run.configuration.fail_fast) run.stop_reason = "item_failure";
          item.updated_at = new Date().toISOString();
          await checkpoint(run, runPath);
          return;
        }
        if (isDispatchStopped(run)) return;
        await checkpoint(run, runPath);
      }
    }

    if (!completed) return;
    completedRoleCount += 1;
    const next = roles[roleIndex + 1];
    item.state = next?.state ?? "evaluating";
    item.current_role = next?.role ?? null;
    item.updated_at = new Date().toISOString();
    await checkpoint(run, runPath);
    if (options.interruptAfter !== null && completedRoleCount >= options.interruptAfter) {
      interruptRequested = true;
      return;
    }
  }

  if (isCancellationRequested(runDirectory)) cancelRequested = true;
  if (!cancelRequested && !interruptRequested) {
    await evaluateItem(run, item, runDirectory, runPath);
  }
}

function terminalReportStatus(run) {
  if (run.status === "cancelled") return "cancelled";
  if (run.status === "failed") return "failed";
  if (run.status === "rejected" || run.counts.failed > 0 || run.counts.cancelled > 0) return "rejected";
  return "completed";
}

function summarizeCallRecords(records) {
  const promptTokens = records.reduce((sum, record) => sum + record.usage.prompt_tokens, 0);
  const completionTokens = records.reduce((sum, record) => sum + record.usage.completion_tokens, 0);
  const totalLatencyMs = records.reduce((sum, record) => sum + record.latency_ms, 0);
  const successfulCalls = records.filter((record) => record.status === "successful").length;
  const failedCalls = records.filter((record) => record.status === "failed").length;
  const uncertainCalls = records.filter((record) => record.status === "uncertain").length;
  return {
    provider_calls: records.length,
    successful_calls: successfulCalls,
    failed_calls: failedCalls,
    uncertain_calls: uncertainCalls,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    estimated_cost: roundCost(records.reduce((sum, record) => sum + record.usage.estimated_cost, 0)),
    total_latency_ms: totalLatencyMs,
    average_latency_ms: records.length === 0 ? 0 : Math.round(totalLatencyMs / records.length),
    max_latency_ms: records.reduce((maximum, record) => Math.max(maximum, record.latency_ms), 0),
  };
}

function buildEvaluationMetrics(run, status) {
  if (status === "cancelled") return [];
  const processed = run.counts.completed + run.counts.quarantined;
  const total = run.counts.total;
  const findingsByAsset = new Map();
  for (const item of run.items) {
    findingsByAsset.set(item.asset_id, item.findings.map((finding) =>
      `${finding.code} ${finding.evidence}`));
  }
  for (const record of run.call_records.filter((candidate) => candidate.error !== null)) {
    const values = findingsByAsset.get(record.asset_id) ?? [];
    values.push(`${record.error.code} ${record.error.message}`);
    findingsByAsset.set(record.asset_id, values);
  }
  return evaluationMetricDefinitions.map((definition) => {
    let measuredValue;
    if (definition.dimension === "json_parse_rate") {
      measuredValue = total === 0 ? 0 : processed / total;
    } else {
      const affected = [...findingsByAsset.values()]
        .filter((findings) => findings.some((finding) => definition.pattern.test(finding)))
        .length;
      const failureRate = total === 0 ? 1 : affected / total;
      measuredValue = definition.direction === "lower" ? failureRate : 1 - failureRate;
    }
    measuredValue = Math.round((measuredValue + Number.EPSILON) * 1_000_000) / 1_000_000;
    return {
      dimension: definition.dimension,
      measured_value: measuredValue,
      threshold: definition.threshold,
      unit: "ratio",
      passed: definition.direction === "lower"
        ? measuredValue <= definition.threshold
        : measuredValue >= definition.threshold,
    };
  });
}

function buildReport(run) {
  const status = terminalReportStatus(run);
  const roleRuns = roles.map(({ role }) => {
    const attempts = run.items.reduce((sum, item) => sum + item.attempts[role], 0);
    const telemetry = summarizeCallRecords(run.call_records.filter((record) => record.role === role));
    return {
      role,
      provider: run.configuration.provider,
      model: run.configuration.model,
      prompt_version: run.configuration.prompt_version,
      schema_version: run.configuration.schema_version,
      independence_level: run.configuration.independence_level,
      attempts,
      ...telemetry,
      status: status === "cancelled"
        ? "cancelled"
        : (status === "failed" ? "failed" : (status === "rejected" ? "partial" : "completed")),
    };
  });
  const failures = [];
  for (const item of run.items) {
    for (const finding of item.findings) {
      failures.push({
        asset_id: item.asset_id,
        dimension: finding.code,
        evidence: finding.evidence,
        failure_code: finding.code,
        failure_reason: finding.evidence,
        retryable: null,
        role: finding.role,
        validation_status: finding.severity === "blocking" ? "quarantined" : finding.validation_status,
      });
    }
  }
  const recordedErrors = new Set();
  for (const record of run.call_records.filter((candidate) => candidate.error !== null)) {
    recordedErrors.add(`${record.asset_id}:${record.error.code}`);
    failures.push({
      asset_id: record.asset_id,
      dimension: record.error.code.toLowerCase(),
      evidence: record.error.message,
      failure_code: record.error.code,
      failure_reason: record.error.message,
      retryable: record.error.retryable,
      role: record.role,
      validation_status: "confirmed_by_gate",
    });
  }
  for (const item of run.items) {
    if (item.last_error) {
      const role = item.current_role ?? "deterministic_gate";
      if (recordedErrors.has(`${item.asset_id}:${item.last_error.code}`)) continue;
      failures.push({
        asset_id: item.asset_id,
        dimension: item.last_error.code.toLowerCase(),
        evidence: item.last_error.message,
        failure_code: item.last_error.code,
        failure_reason: item.last_error.message,
        retryable: item.last_error.retryable,
        role,
        validation_status: "confirmed_by_gate",
      });
    }
  }
  const metrics = buildEvaluationMetrics(run, status);
  const runConfiguration = {
    mode: run.mode,
    provider: run.configuration.provider,
    model: run.configuration.model,
    prompt_version: run.configuration.prompt_version,
    schema_version: run.configuration.schema_version,
    independence_level: run.configuration.independence_level,
    max_attempts: run.configuration.max_attempts,
    timeout_ms: run.configuration.timeout_ms,
    concurrency: run.configuration.concurrency,
    fail_fast: run.configuration.fail_fast,
    max_provider_calls: run.configuration.max_provider_calls,
    selection_hash: run.configuration.selection_hash,
    mock_scenario_version: run.configuration.mock_scenario_version,
    config_hash: run.configuration.config_hash,
  };
  const comparableRunKey = canonicalHash({
    dataset: run.dataset,
    selection: run.selection,
    skills: run.skills,
    run_configuration: runConfiguration,
    budget_limit: run.configuration.budget_limit,
  });
  const report = {
    schema_version: "1.5",
    report_id: `report_${digest(run.run_id).slice(0, 24)}`,
    run_id: run.run_id,
    status,
    dataset: structuredClone(run.dataset),
    selection: structuredClone(run.selection),
    skills: structuredClone(run.skills),
    run_configuration: runConfiguration,
    role_runs: roleRuns,
    counts: {
      total: run.counts.total,
      completed: run.counts.completed,
      quarantined: run.counts.quarantined,
      failed: run.counts.failed,
      cancelled: run.counts.cancelled,
    },
    metrics,
    failures,
    telemetry: summarizeCallRecords(run.call_records),
    budget: {
      currency: "CNY",
      limit: run.configuration.budget_limit,
      estimated_spend: run.budget.estimated_spend,
      provider_calls: run.budget.provider_calls,
      uncertain_calls: run.budget.uncertain_calls,
      pricing_version: run.budget.pricing_version,
      pricing_effective_at: run.budget.pricing_effective_at,
      input_per_million_cny: run.budget.input_per_million_cny,
      output_per_million_cny: run.budget.output_per_million_cny,
      max_cost_per_call: run.budget.max_cost_per_call,
      stopped_new_work: isDispatchStopped(run),
      stop_reason: ["budget_exhausted", "provider_call_limit_reached", "item_failure", "cancelled", "fatal_error"].includes(run.stop_reason)
        ? run.stop_reason
        : null,
    },
    checkpoint: {
      run_content_hash: run.content_hash,
      artifact_count: run.items.filter((item) => item.artifact !== null).length,
      comparable_run_key: comparableRunKey,
    },
    validation_status: status === "completed" ? "passed" : (status === "rejected" ? "needs_review" : "failed"),
    started_at: run.started_at,
    completed_at: run.completed_at ?? new Date().toISOString(),
    content_hash: "sha256:pending",
  };
  return report;
}

async function finalizeRun(run, runDirectory, runPath) {
  updateCounts(run);
  run.status = run.counts.failed > 0 ? "rejected" : "completed";
  run.stop_reason = run.status;
  run.completed_at = new Date().toISOString();
  await checkpoint(run, runPath);
  const report = writeDocument(
    resolve(runDirectory, "report.json"),
    buildReport(run),
    validators.report,
    "训练报告",
    runDirectory,
  );
  clearCancellationRequest(runDirectory);
  return report;
}

async function finalizeDispatchStoppedRun(run, runDirectory, runPath) {
  const providerCallLimitReached = run.stop_reason === "provider_call_limit_reached";
  const itemFailure = run.stop_reason === "item_failure";
  for (const item of run.items) {
    if (terminalItemStates.has(item.state)) continue;
    item.state = "cancelled";
    item.outcome = "cancelled";
    item.current_role = null;
    item.last_error = {
      code: providerCallLimitReached
        ? "TRAINING_PROVIDER_CALL_LIMIT_REACHED"
        : (itemFailure ? "TRAINING_FAIL_FAST_STOPPED" : "TRAINING_BUDGET_EXHAUSTED"),
      message: providerCallLimitReached
        ? "Provider 调用次数达到显式上限，样例未继续派发。"
        : (itemFailure
            ? "同阶段已有样例失败，按 fail-fast 规则停止后续调用。"
            : "预算不足以获取下一次调用租约，样例未继续派发。"),
      retryable: false,
    };
    item.updated_at = new Date().toISOString();
  }
  run.status = "rejected";
  run.completed_at = new Date().toISOString();
  await checkpoint(run, runPath);
  return writeDocument(
    resolve(runDirectory, "report.json"),
    buildReport(run),
    validators.report,
    "训练报告",
    runDirectory,
  );
}

async function cancelRun(run, runDirectory, runPath) {
  if (!terminalRunStates.has(run.status)) {
    for (const item of run.items) {
      if (terminalItemStates.has(item.state)) continue;
      item.state = "cancelled";
      item.outcome = "cancelled";
      item.current_role = null;
      item.last_error = null;
      item.updated_at = new Date().toISOString();
    }
    run.status = "cancelled";
    run.stop_reason = "cancelled";
    run.completed_at = new Date().toISOString();
    await checkpoint(run, runPath);
  }
  const reportPath = resolve(runDirectory, "report.json");
  const report = existsSync(reportPath)
    ? readDocument(reportPath, validators.report, "训练报告", runDirectory)
    : writeDocument(reportPath, buildReport(run), validators.report, "训练报告", runDirectory);
  clearCancellationRequest(runDirectory);
  return report;
}

async function failRun(run, runDirectory, runPath, error) {
  for (const item of run.items) {
    if (terminalItemStates.has(item.state)) continue;
    item.state = "failed";
    item.outcome = "failed";
    item.current_role = null;
    item.last_error = {
      code: "TRAINING_FATAL_ERROR",
      message: String(error.message ?? "训练运行失败。").slice(0, 240),
      retryable: false,
    };
    item.updated_at = new Date().toISOString();
  }
  run.status = "failed";
  run.stop_reason = "fatal_error";
  run.completed_at = new Date().toISOString();
  await checkpoint(run, runPath);
  const report = writeDocument(
    resolve(runDirectory, "report.json"),
    buildReport(run),
    validators.report,
    "训练报告",
    runDirectory,
  );
  clearCancellationRequest(runDirectory);
  return report;
}

async function runTraining(args) {
  const mode = args.options.get("--mode") ?? "mock";
  assert(mode === "mock" || mode === "live", "--mode 只允许 mock 或 live。");
  const manifestPath = resolve(args.options.get("--manifest") ?? resolve(defaultDatasetDirectory, "manifest.json"));
  const splitsPath = resolve(args.options.get("--splits") ?? resolve(defaultDatasetDirectory, "splits.json"));
  const manifestDirectory = dirname(manifestPath);
  const manifest = validateDataset(manifestPath, splitsPath);
  const requestedAssetIds = assetIdsOption(args);
  const selectedAssets = selectTrainingAssets(manifest, requestedAssetIds);
  const requestedSelection = buildSelection(manifest, selectedAssets, requestedAssetIds !== null);
  const configuration = buildConfiguration(args, mode, requestedSelection.content_hash);
  if (mode === "live") guardLiveTraining(args, configuration, requestedSelection);

  const outputDirectory = resolve(args.options.get("--output-dir") ?? defaultOutputDirectory);
  const runId = args.options.get("--run-id")
    ?? `run_${mode}_${Date.now()}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const runDirectory = safeRunDirectory(outputDirectory, runId);
  const runPath = resolve(runDirectory, "run.json");
  const releaseRunLock = acquireRunLock(runDirectory);
  const releaseRunLockOnExit = () => releaseRunLock();
  process.once("exit", releaseRunLockOnExit);
  const interruptAfter = args.options.has("--interrupt-after")
    ? numberOption(args, "--interrupt-after", null, 1, 2500)
    : null;
  if (interruptAfter !== null) {
    assert(configuration.concurrency === 1, "--interrupt-after 只允许与 --concurrency 1 一起用于确定性恢复验证。");
  }
  const mockDelayMs = numberOption(args, "--mock-delay-ms", 0, 0, 1000);

  const assetsById = new Map(manifest.assets.map((asset) => [asset.asset_id, asset]));
  const skills = loadSkillReferences();
  const resumed = existsSync(runPath);
  let run;
  if (resumed) {
    run = readDocument(runPath, validators.run, "训练运行检查点", runDirectory);
    assert(run.mode === mode, "已有运行模式与本次命令不一致。");
    assert(run.dataset.content_hash === manifest.content_hash, "已有运行的数据集快照与当前清单不一致。");
    assert(JSON.stringify(run.skills) === JSON.stringify(skills), "已有运行的 Skill 快照与当前定义不一致。");
    if (terminalRunStates.has(run.status)) {
      const reportPath = resolve(runDirectory, "report.json");
      assert(existsSync(reportPath), "终态训练运行缺少报告。");
      const report = readDocument(reportPath, validators.report, "训练报告", runDirectory);
      clearCancellationRequest(runDirectory);
      process.stdout.write(`${JSON.stringify({ status: "ok", resumed: true, report })}\n`);
      return;
    }
    assert(run.schema_version === "1.1", "旧版非终态训练检查点不能由新版 Trainer 继续执行。");
    const effectiveSelection = requestedAssetIds === null ? run.selection : requestedSelection;
    assert(run.selection.content_hash === effectiveSelection.content_hash,
      "恢复参数 --asset-ids 与已有检查点选择范围不一致。");
    validateResumeOptions(args, configuration, run.configuration);
    await reconcileInterruptedBudgetLeases(run, runPath);
  } else {
    mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
    run = newRun(
      runId,
      mode,
      manifest,
      requestedSelection,
      selectedAssets,
      skills,
      configuration,
      new Date().toISOString(),
    );
    await checkpoint(run, runPath);
  }
  const activeConfiguration = run.configuration;
  const provider = mode === "mock"
    ? null
    : (activeConfiguration.provider === "test-fixture"
        ? createFixtureTrainingProvider(activeConfiguration.model)
        : createQwenTrainingProvider({
            baseUrl: activeConfiguration.base_url,
            apiKey: process.env.Model__Qwen__ApiKey,
            model: activeConfiguration.model,
          }));

  let signalCount = 0;
  const onInterrupt = () => {
    signalCount += 1;
    cancelRequested = true;
    if (signalCount > 1) process.exitCode = 130;
  };
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onInterrupt);

  try {
    const items = run.items.filter((item) => !terminalItemStates.has(item.state));
    let cursor = 0;
    const workers = Array.from({ length: Math.min(run.configuration.concurrency, items.length) }, async () => {
      while (!cancelRequested
        && !interruptRequested
        && !isDispatchStopped(run)) {
        if (isCancellationRequested(runDirectory)) {
          cancelRequested = true;
          return;
        }
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        await processItem(run, items[index], runDirectory, runPath, {
          interruptAfter,
          mockDelayMs,
          provider,
          assetsById,
          manifestDirectory,
        });
      }
    });
    const workerResults = await Promise.allSettled(workers);
    const workerFailure = workerResults.find((result) => result.status === "rejected");
    if (workerFailure) throw workerFailure.reason;

    if (isCancellationRequested(runDirectory)) cancelRequested = true;
    if (cancelRequested) {
      const report = await cancelRun(run, runDirectory, runPath);
      clearCancellationRequest(runDirectory);
      process.stdout.write(`${JSON.stringify({ status: "cancelled", report })}\n`);
      return;
    }
    if (interruptRequested) {
      process.stdout.write(`${JSON.stringify({
        status: "interrupted",
        run_id: run.run_id,
        run_path: runPath,
        completed_roles_this_process: completedRoleCount,
      })}\n`);
      return;
    }
    if (isDispatchStopped(run)) {
      const stopReason = run.stop_reason;
      const report = await finalizeDispatchStoppedRun(run, runDirectory, runPath);
      process.stdout.write(`${JSON.stringify({ status: stopReason, report })}\n`);
      return;
    }
    const report = await finalizeRun(run, runDirectory, runPath);
    process.stdout.write(`${JSON.stringify({ status: "ok", resumed, report })}\n`);
  } catch (error) {
    const report = await failRun(run, runDirectory, runPath, error);
    process.stdout.write(`${JSON.stringify({ status: "failed", report })}\n`);
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onInterrupt);
    process.off("exit", releaseRunLockOnExit);
    releaseRunLock();
  }
}

async function cancelTraining(args) {
  const runId = args.options.get("--run-id");
  assert(runId, "取消训练必须传入 --run-id。");
  const outputDirectory = resolve(args.options.get("--output-dir") ?? defaultOutputDirectory);
  const runDirectory = safeRunDirectory(outputDirectory, runId);
  const runPath = resolve(runDirectory, "run.json");
  let releaseRunLock;
  try {
    releaseRunLock = acquireRunLock(runDirectory);
  } catch (error) {
    if (error?.code !== "TRAINING_RUN_ACTIVE") throw error;
    requestActiveRunCancellation(runDirectory);
    process.stdout.write(`${JSON.stringify({
      status: "cancellation_requested",
      run_id: runId,
      active: true,
    })}\n`);
    return;
  }
  try {
    assert(existsSync(runPath), `找不到训练运行：${runId}`);
    const run = readDocument(runPath, validators.run, "训练运行检查点", runDirectory);
    const wasTerminal = terminalRunStates.has(run.status);
    const report = await cancelRun(run, runDirectory, runPath);
    process.stdout.write(`${JSON.stringify({ status: report.status, already_terminal: wasTerminal, report })}\n`);
  } finally {
    releaseRunLock();
  }
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args.command === "run") {
    await runTraining(args);
    return;
  }
  if (args.command === "cancel") {
    await cancelTraining(args);
    return;
  }
  throw new Error(
    "用法：node scripts/skill-trainer.mjs <run|cancel> [--mode mock|live] [--asset-ids ID1,ID2] "
      + "[--max-provider-calls N] [--run-id ID] [--output-dir PATH]",
  );
}

main().catch((error) => {
  process.stderr.write(`Skill Trainer 命令失败：${error.message}\n`);
  process.exitCode = 1;
});
