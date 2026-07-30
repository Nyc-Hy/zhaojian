import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { auditTrainingRun } from "./training-run-audit.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultPlanPath = path.join(repositoryRoot, "config", "skill-live-evaluation-campaign.json");
const planSchemaPath = path.join(repositoryRoot, "schemas", "skill-live-evaluation-campaign.schema.json");
const reportSchemaPath = path.join(repositoryRoot, "schemas", "skill-training-report.schema.json");
const trainerPath = path.join(repositoryRoot, "scripts", "skill-trainer.mjs");
const defaultTrainingRoot = path.join(repositoryRoot, ".local", "skill-training");
const roles = ["observer", "direction_generator", "critic", "red_team", "curator"];
const expectedStageIds = ["smoke1", "smoke3", "development12", "full60"];
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

const [command = "", ...rawOptions] = process.argv.slice(2);
if (!["plan", "next", "verify", "execute"].includes(command)) {
  fail("用法：node scripts/live-evaluation-campaign.mjs <plan|next|verify|execute> [--plan path] [--training-root path] [--stage id --report path] [--report stage=path] [--allow-network]");
}

const options = parseOptions(rawOptions);
const trainingRoot = safeTrainingRoot(options.trainingRoot ?? defaultTrainingRoot);
const planPath = options.plan ? safeRepositoryFile(options.plan, "评测计划") : defaultPlanPath;
const plan = readValidatedJson(planPath, compile(planSchemaPath), "分级真实评测计划");
const manifestPath = safeRepositoryFile(plan.dataset.manifest_path, "数据集清单");
const manifest = readJson(manifestPath);
const splitsPath = safeRepositoryFile(plan.dataset.splits_path, "数据集固定分区");
const splits = readJson(splitsPath);
validatePlanBusiness(plan, manifest, splits);

if (command === "plan") {
  const authorized = plan.authorization.status === "authorized";
  print({
    status: authorized ? "planned" : "authorization_required",
    campaign_id: plan.campaign_id,
    authorization: plan.authorization,
    dataset: plan.dataset,
    stages: plan.stages.map((stage) => stageSummary(plan, manifest, stage)),
    next_stage: authorized ? plan.stages[0].stage_id : null,
    next_command: authorized ? commandForStage(plan, manifest, plan.stages[0]) : null,
  });
} else if (command === "verify") {
  const stageId = options.stage;
  const reportPath = options.singleReport;
  assert(stageId && reportPath, "verify 必须同时提供 --stage 与 --report。");
  const stage = plan.stages.find((candidate) => candidate.stage_id === stageId);
  assert(stage, `未知评测阶段：${stageId}`);
  const report = loadTrainingReport(reportPath);
  const result = validateStageReport(plan, manifest, stage, report);
  print(result);
} else if (command === "next") {
  assertAuthorized(plan);
  let nextStage = null;
  const verified = [];
  for (const stage of plan.stages) {
    const reportPath = path.join(trainingRoot, stage.run_id, "report.json");
    if (!existsSync(reportPath)) {
      nextStage = stage;
      break;
    }
    const report = loadTrainingReport(reportPath);
    verified.push(validateStageReport(plan, manifest, stage, report));
  }
  print(nextStage
    ? {
      status: "ready_for_next_stage",
      campaign_id: plan.campaign_id,
      verified_stages: verified,
      next_stage: nextStage.stage_id,
      next_command: commandForStage(plan, manifest, nextStage),
      authorization: plan.authorization,
    }
    : {
      status: "campaign_passed",
      campaign_id: plan.campaign_id,
      verified_stages: verified,
      next_stage: null,
      next_command: null,
      authorization: plan.authorization,
    });
} else {
  executeStage(plan, manifest, options);
}

function validatePlanBusiness(value, dataset, splits) {
  assert(value.dataset.id === dataset.dataset_id, "评测计划的数据集 ID 与清单不一致。");
  assert(value.dataset.version === dataset.dataset_version, "评测计划的数据集版本与清单不一致。");
  assert(value.dataset.content_hash === dataset.content_hash, "评测计划的数据集哈希与清单不一致。");
  assert(value.dataset.id === splits.dataset_id
    && value.dataset.version === splits.dataset_version
    && splits.frozen === true,
  "评测计划与冻结分区快照不一致。");
  assert(dataset.assets.length === 60, "真实评测必须基于冻结的 60 图清单。");
  const holdoutAssetIds = new Set(splits.partitions?.holdout ?? []);

  const stageIds = value.stages.map((stage) => stage.stage_id);
  assert(JSON.stringify(stageIds) === JSON.stringify(expectedStageIds), "评测阶段顺序必须固定为 smoke1 → smoke3 → development12 → full60。");
  const plannedBudget = roundCurrency(value.stages.reduce(
    (sum, stage) => sum + stage.budget_limit_cny,
    0,
  ));
  if (value.authorization.status === "authorized") {
    assert(approximately(value.authorization.authorized_total_cny, plannedBudget),
      "授权总额必须与四阶段本地预算上限之和一致。");
    assert(typeof value.authorization.authorization_id === "string"
      && value.authorization.authorization_id.length > 0
      && typeof value.authorization.authorized_at === "string",
    "已授权计划必须保留授权记录 ID 与时间。");
  }
  const assetsById = new Map(dataset.assets.map((asset) => [asset.asset_id, asset]));
  for (let index = 0; index < value.stages.length; index += 1) {
    const stage = value.stages[index];
    const expectedDependency = index === 0 ? [] : [value.stages[index - 1].stage_id];
    assert(JSON.stringify(stage.requires) === JSON.stringify(expectedDependency), `${stage.stage_id} 的前置阶段不正确。`);
    const theoreticalSuccesses = stage.selection.selected_asset_count * roles.length;
    assert(stage.max_provider_calls === theoreticalSuccesses + stage.max_controlled_repairs,
      `${stage.stage_id} 的调用上限必须等于五角色成功调用数加受控修复上限。`);
    assert(stage.budget_limit_cny >= value.pricing.max_cost_per_call_cny,
      `${stage.stage_id} 的预算必须至少覆盖一次保守调用租约。`);
    if (stage.selection.mode === "full_dataset") {
      assert(stage.stage_id === "full60"
        && stage.selection.asset_ids.length === 0
        && stage.selection.selected_asset_count === dataset.assets.length,
      "只有 full60 可以使用完整数据集选择。");
      continue;
    }
    assert(stage.selection.asset_ids.length === stage.selection.selected_asset_count,
      `${stage.stage_id} 的显式资产数量不一致。`);
    for (const assetId of stage.selection.asset_ids) {
      assert(assetsById.has(assetId), `${stage.stage_id} 引用了清单外资产 ${assetId}。`);
      assert(!holdoutAssetIds.has(assetId), `${stage.stage_id} 不得提前暴露新保留集 ${assetId}。`);
    }
  }
}

function validateStageReport(value, dataset, stage, report) {
  const expectedAssetIds = selectedAssetIds(dataset, stage);
  const selectedAssetIdsActual = report.selection?.asset_ids ?? [];
  assert(report.content_hash === contentHash(report), `${stage.stage_id} 报告内容哈希不匹配。`);
  assert(report.run_id === stage.run_id, `${stage.stage_id} 报告未绑定冻结运行 ID。`);
  assert(report.status === "completed" && report.validation_status === "passed",
    `${stage.stage_id} 报告未达到 completed/passed。`);
  assert(report.dataset?.id === value.dataset.id
    && report.dataset?.version === value.dataset.version
    && report.dataset?.content_hash === value.dataset.content_hash,
  `${stage.stage_id} 报告的数据集快照不匹配。`);
  assert(sameSet(selectedAssetIdsActual, expectedAssetIds)
    && selectedAssetIdsActual.length === expectedAssetIds.length,
  `${stage.stage_id} 报告的资产选择不匹配。`);
  assert(report.selection.selected_asset_count === expectedAssetIds.length
    && report.counts.total === expectedAssetIds.length,
  `${stage.stage_id} 报告的选择数量不匹配。`);
  assert(report.selection.content_hash === contentHash(report.selection)
    && report.run_configuration.selection_hash === report.selection.content_hash,
  `${stage.stage_id} 报告的选择哈希不匹配。`);

  const configuration = report.run_configuration;
  assert(configuration.mode === "live"
    && configuration.provider === value.provider.id
    && configuration.model === value.provider.model
    && configuration.prompt_version === value.contract.prompt_version
    && configuration.schema_version === value.contract.schema_version
    && configuration.fail_fast === true,
  `${stage.stage_id} 报告的模型或契约快照不匹配。`);
  assert(configuration.max_attempts === stage.max_attempts
    && configuration.max_provider_calls === stage.max_provider_calls,
  `${stage.stage_id} 报告的重试或调用上限不匹配。`);
  assert(approximately(report.budget.limit, stage.budget_limit_cny)
    && report.budget.pricing_version === value.pricing.version
    && approximately(report.budget.max_cost_per_call, value.pricing.max_cost_per_call_cny),
  `${stage.stage_id} 报告的预算或计价快照不匹配。`);

  const expectedSuccesses = expectedAssetIds.length * roles.length;
  const repairs = report.telemetry.failed_calls + report.telemetry.uncertain_calls;
  assert(report.telemetry.successful_calls === expectedSuccesses,
    `${stage.stage_id} 未完成全部五角色成功调用。`);
  assert(repairs <= stage.max_controlled_repairs
    && report.telemetry.provider_calls === expectedSuccesses + repairs,
  `${stage.stage_id} 的修复调用超过上限或遥测不一致。`);
  assert(report.budget.provider_calls === report.telemetry.provider_calls
    && report.budget.uncertain_calls === report.telemetry.uncertain_calls
    && report.budget.stopped_new_work === false
    && report.budget.stop_reason === null
    && report.budget.estimated_spend <= report.budget.limit,
  `${stage.stage_id} 的预算门禁未闭合。`);
  assert(report.counts.completed + report.counts.quarantined === expectedAssetIds.length
    && report.counts.failed === 0
    && report.counts.cancelled === 0,
  `${stage.stage_id} 存在失败、取消或丢失样例。`);

  const metricNames = new Set(report.metrics.map((metric) => metric.dimension));
  assert(report.metrics.length === metricDirections.size
    && metricNames.size === metricDirections.size
    && report.metrics.every((metric) => {
      const direction = metricDirections.get(metric.dimension);
      if (!direction) return false;
      const expectedPassed = direction === "higher"
        ? metric.measured_value >= metric.threshold
        : metric.measured_value <= metric.threshold;
      return metric.passed === expectedPassed && metric.passed === true;
    }),
    `${stage.stage_id} 的九维门禁未全部通过。`);
  assert(report.role_runs.length === roles.length
    && new Set(report.role_runs.map((roleRun) => roleRun.role)).size === roles.length,
  `${stage.stage_id} 的角色运行必须恰好五项且角色唯一。`);
  const roleRuns = new Map(report.role_runs.map((roleRun) => [roleRun.role, roleRun]));
  assert(roleRuns.size === roles.length, `${stage.stage_id} 的角色运行不完整。`);
  for (const role of roles) {
    const roleRun = roleRuns.get(role);
    assert(roleRun
      && roleRun.status === "completed"
      && roleRun.successful_calls === expectedAssetIds.length
      && roleRun.provider === value.provider.id
      && roleRun.model === value.provider.model
      && roleRun.prompt_version === value.contract.prompt_version
      && roleRun.schema_version === value.contract.schema_version,
    `${stage.stage_id} 的 ${role} 角色门禁未闭合。`);
  }
  const reportPath = path.join(trainingRoot, stage.run_id, "report.json");
  const runAudit = auditTrainingRun({
    reportPath,
    report,
    expectedAssetIds,
    expectedRunId: stage.run_id,
    expectedConfiguration: {
      provider: value.provider.id,
      model: value.provider.model,
      prompt_version: value.contract.prompt_version,
      schema_version: value.contract.schema_version,
      max_attempts: stage.max_attempts,
      max_provider_calls: stage.max_provider_calls,
      budget_limit: stage.budget_limit_cny,
      base_url: value.provider.base_url,
      fail_fast: true,
    },
    maxFailedCalls: stage.max_controlled_repairs,
    maxUncertainCalls: Math.min(1, stage.max_controlled_repairs),
    maxRepairCalls: stage.max_controlled_repairs,
  });
  assert(runAudit.valid, `${stage.stage_id} 的逐调用运行审计未闭合：${runAudit.reason}。`);

  return {
    status: "passed",
    stage_id: stage.stage_id,
    run_id: report.run_id,
    report_content_hash: report.content_hash,
    selected_asset_count: expectedAssetIds.length,
    provider_calls: report.telemetry.provider_calls,
    controlled_repairs: repairs,
    run_audit: runAudit,
    estimated_cost_cny: report.telemetry.estimated_cost,
  };
}

function stageSummary(value, dataset, stage) {
  return {
    stage_id: stage.stage_id,
    requires: stage.requires,
    selected_asset_count: selectedAssetIds(dataset, stage).length,
    exposes_new_holdout: stage.stage_id === "full60",
    max_provider_calls: stage.max_provider_calls,
    budget_limit_cny: stage.budget_limit_cny,
    max_controlled_repairs: stage.max_controlled_repairs,
    executable: value.authorization.status === "authorized",
    command: value.authorization.status === "authorized"
      ? commandForStage(value, dataset, stage)
      : null,
  };
}

function commandForStage(value, dataset, stage) {
  const args = [
    "npm", "run", "skill:train:live", "--",
    "--allow-network",
    "--provider", value.provider.id,
    "--model", value.provider.model,
    "--base-url", value.provider.base_url,
    "--manifest", value.dataset.manifest_path,
    "--splits", value.dataset.splits_path,
  ];
  if (stage.selection.mode === "explicit_asset_ids") {
    args.push("--asset-ids", selectedAssetIds(dataset, stage).join(","));
  }
  if (trainingRoot !== defaultTrainingRoot) {
    args.push("--output-dir", path.relative(repositoryRoot, trainingRoot));
  }
  args.push(
    "--run-id", stage.run_id,
    "--max-attempts", String(stage.max_attempts),
    "--fail-fast",
    "--timeout-ms", "120000",
    "--concurrency", "1",
    "--max-provider-calls", String(stage.max_provider_calls),
    "--budget", String(stage.budget_limit_cny),
    "--pricing-version", value.pricing.version,
    "--pricing-effective-at", value.pricing.effective_at,
    "--input-per-million", String(value.pricing.input_per_million_cny),
    "--output-per-million", String(value.pricing.output_per_million_cny),
    "--max-cost-per-call", String(value.pricing.max_cost_per_call_cny),
  );
  return args;
}

function executeStage(value, dataset, executionOptions) {
  assertAuthorized(value);
  assert(executionOptions.allowNetwork, "执行真实评测必须再次显式传入 --allow-network。");
  const requestedStage = value.stages.find((stage) => stage.stage_id === executionOptions.stage);
  assert(requestedStage, "execute 必须通过 --stage 指定已冻结阶段。");

  const verified = [];
  let nextStage = null;
  for (const stage of value.stages) {
    const reportPath = path.join(trainingRoot, stage.run_id, "report.json");
    if (!existsSync(reportPath)) {
      nextStage = stage;
      break;
    }
    const report = loadTrainingReport(reportPath);
    verified.push(validateStageReport(value, dataset, stage, report));
  }
  assert(nextStage, "四个真实评测阶段已经全部通过，不得重复计费执行。");
  assert(requestedStage.stage_id === nextStage.stage_id,
    `当前只允许执行 ${nextStage.stage_id}，不得跳阶段或重复运行。`);

  const spentBefore = roundCurrency(verified.reduce(
    (sum, result) => sum + result.estimated_cost_cny,
    0,
  ));
  assert(spentBefore + requestedStage.budget_limit_cny
    <= value.authorization.authorized_total_cny + 0.000001,
  "已完成阶段费用加本阶段本地上限会超过授权总额。");

  const apiKey = loadQwenApiKey();
  const childEnvironment = {
    ...process.env,
    Model__Qwen__ApiKey: apiKey,
  };
  delete childEnvironment.QWEN_API_KEY;
  const commandPreview = commandForStage(value, dataset, requestedStage);
  const trainerArguments = [
    trainerPath,
    "run",
    "--mode",
    "live",
    ...commandPreview.slice(4),
  ];
  const result = spawnSync(process.execPath, trainerArguments, {
    cwd: repositoryRoot,
    env: childEnvironment,
    stdio: "inherit",
  });
  if (result.error) fail(`真实评测进程启动失败：${result.error.message}`);
  assert(result.status === 0, `${requestedStage.stage_id} 真实评测未通过，后续阶段已停止。`);

  const reportPath = path.join(trainingRoot, requestedStage.run_id, "report.json");
  const report = loadTrainingReport(reportPath);
  const stageResult = validateStageReport(value, dataset, requestedStage, report);
  const cumulativeSpend = roundCurrency(spentBefore + stageResult.estimated_cost_cny);
  assert(cumulativeSpend <= value.authorization.authorized_total_cny + 0.000001,
    "真实评测累计费用超过授权总额。");
  print({
    status: "stage_passed",
    campaign_id: value.campaign_id,
    authorization_id: value.authorization.authorization_id,
    stage: stageResult,
    cumulative_spend_cny: cumulativeSpend,
    authorized_total_cny: value.authorization.authorized_total_cny,
    next_stage: value.stages[value.stages.indexOf(requestedStage) + 1]?.stage_id ?? null,
  });
}

function assertAuthorized(value) {
  assert(value.authorization.required === true
    && value.authorization.status === "authorized"
    && Number(value.authorization.authorized_total_cny) > 0,
  "分级真实评测尚未获得显式费用授权。");
}

function loadQwenApiKey() {
  const direct = process.env.Model__Qwen__ApiKey?.trim();
  if (direct) return direct;
  const environmentPath = path.join(repositoryRoot, ".env");
  assert(existsSync(environmentPath)
    && lstatSync(environmentPath).isFile()
    && !pathHasSymbolicLink(environmentPath),
  "缺少安全的本地 .env 配置。");
  assert((lstatSync(environmentPath).mode & 0o077) === 0,
    "本地 .env 权限过宽，必须只允许当前用户读取。");
  const values = new Map();
  for (const rawLine of readFileSync(environmentPath, "utf8").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
    assert(match, ".env 只允许 KEY=VALUE 形式，不执行 shell 表达式。");
    let value = match[2].trim();
    if ((value.startsWith("\"") && value.endsWith("\""))
      || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values.set(match[1], value);
  }
  const apiKey = (values.get("Model__Qwen__ApiKey") ?? values.get("QWEN_API_KEY") ?? "").trim();
  assert(apiKey, "本地安全配置中缺少 Qwen API Key。");
  return apiKey;
}

function selectedAssetIds(dataset, stage) {
  return stage.selection.mode === "full_dataset"
    ? dataset.assets.map((asset) => asset.asset_id)
    : [...stage.selection.asset_ids];
}

function loadTrainingReport(candidate) {
  const reportPath = safeTrainingReport(candidate);
  return readValidatedJson(reportPath, compile(reportSchemaPath), "真实评测报告");
}

function safeTrainingReport(candidate) {
  const fullPath = path.resolve(repositoryRoot, candidate);
  assert(existsSync(fullPath), `真实评测报告不存在：${candidate}`);
  assert(!pathHasSymbolicLink(fullPath), "真实评测报告路径不得经过符号链接。");
  const relativePath = path.relative(trainingRoot, fullPath);
  assert(relativePath !== "" && !relativePath.startsWith("..") && !path.isAbsolute(relativePath),
    `真实评测报告必须位于 ${path.relative(repositoryRoot, trainingRoot)} 的具体运行目录。`);
  assert(path.basename(fullPath) === "report.json", "真实评测报告文件名必须为 report.json。");
  return fullPath;
}

function safeTrainingRoot(candidate) {
  const fullPath = path.resolve(repositoryRoot, candidate);
  const localRoot = path.join(repositoryRoot, ".local");
  const relativePath = path.relative(localRoot, fullPath);
  assert(relativePath !== "" && !relativePath.startsWith("..") && !path.isAbsolute(relativePath),
    "训练根目录必须位于项目 .local 目录内。");
  assert(!pathHasSymbolicLink(fullPath), "训练根目录路径不得经过符号链接。");
  if (existsSync(fullPath)) assert(lstatSync(fullPath).isDirectory(), "训练根目录必须是目录。");
  return fullPath;
}

function safeRepositoryFile(candidate, label) {
  const fullPath = path.resolve(repositoryRoot, candidate);
  const relativePath = path.relative(repositoryRoot, fullPath);
  assert(relativePath !== "" && !relativePath.startsWith("..") && !path.isAbsolute(relativePath),
    `${label}必须位于项目目录内。`);
  assert(existsSync(fullPath) && lstatSync(fullPath).isFile(), `${label}不存在或不是文件。`);
  assert(!pathHasSymbolicLink(fullPath), `${label}路径不得经过符号链接。`);
  return fullPath;
}

function pathHasSymbolicLink(candidate) {
  const relativePath = path.relative(repositoryRoot, candidate);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) return true;
  let current = repositoryRoot;
  for (const segment of relativePath.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!existsSync(current)) break;
    if (lstatSync(current).isSymbolicLink()) return true;
  }
  return false;
}

function readValidatedJson(filePath, validator, label) {
  const stats = lstatSync(filePath);
  assert(stats.isFile() && stats.size > 0 && stats.size <= 2 * 1024 * 1024, `${label}大小或类型不正确。`);
  const value = readJson(realpathSync(filePath));
  assert(validator.validate(value),
    `${label}未通过 Schema：${validator.ajv.errorsText(validator.validate.errors, { separator: "；" })}`);
  return value;
}

function compile(schemaPath) {
  const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: false });
  const validate = ajv.compile(readJson(schemaPath));
  return { ajv, validate };
}

function parseOptions(args) {
  const parsed = {
    plan: null,
    stage: null,
    singleReport: null,
    trainingRoot: null,
    allowNetwork: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--allow-network" && command === "execute") {
      parsed.allowNetwork = true;
      continue;
    }
    assert(index + 1 < args.length, `参数 ${option} 缺少值。`);
    const value = args[index + 1];
    if (option === "--plan") parsed.plan = value;
    else if (option === "--training-root") parsed.trainingRoot = value;
    else if (option === "--stage") parsed.stage = value;
    else if (option === "--report" && command === "verify") parsed.singleReport = value;
    else {
      fail(`未知参数：${option}`);
    }
    index += 1;
  }
  return parsed;
}

function contentHash(value) {
  const copy = structuredClone(value);
  delete copy.content_hash;
  return `sha256:${createHash("sha256").update(JSON.stringify(sortJson(copy))).digest("hex")}`;
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
  }
  return value;
}

function sameSet(left, right) {
  if (left.length !== right.length) return false;
  const values = new Set(left);
  return values.size === left.length && right.every((value) => values.has(value));
}

function approximately(left, right) {
  return Math.abs(Number(left) - Number(right)) <= 0.000001;
}

function roundCurrency(value) {
  return Math.round((Number(value) + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function fail(message) {
  console.error(`分级真实评测失败：${message}`);
  process.exit(1);
}
