import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultRunsDirectory = resolve(repositoryRoot, ".local/skill-training");
const defaultManifestPath = resolve(repositoryRoot, "datasets/photography-skill-v1/manifest.json");
const defaultOutputDirectory = resolve(repositoryRoot, "datasets/photography-skill-v1/history");
const failureSchemaPath = resolve(
  repositoryRoot,
  "schemas/skill-training-failure-corpus.schema.json",
);
const exposureSchemaPath = resolve(
  repositoryRoot,
  "schemas/skill-training-exposure-ledger.schema.json",
);
const trainingRunSchemaPath = resolve(repositoryRoot, "schemas/skill-training-run.schema.json");
const trainingReportSchemaPath = resolve(repositoryRoot, "schemas/skill-training-report.schema.json");

const safeSummaries = {
  observer_inference: "观察包含无法由图片直接确认的类别、时段、身份或效果推断。",
  direction_contract: "方向没有满足结构、证据引用、差异或诚实停下的契约。",
  aesthetic_judgment: "输出混入审美评价、排名或风格结论。",
  unsupported_grounding: "方向依据与已保存观察不一致或引用不足。",
  prescriptive_direction: "方向替拍摄者作出构图、机位、器材或后期决定。",
  role_schema: "角色输出字段、枚举或类型不符合白名单契约。",
  provider_transient: "远端调用出现可重试的网络、限流或超时问题。",
  safety_finding: "红队发现隐私、提示注入、身份推断或用户决定权风险。",
  training_pipeline: "训练控制面、制品或预算门禁关闭失败。",
  low_confidence: "证据置信度不足，样例应留在隔离区。",
  model_disagreement: "模型角色对同一证据存在分歧，不能强行取多数。",
  prompt_injection: "图片文字或不可信上下文出现提示注入风险。",
  other: "历史问题已被记录，但当前白名单分类不足以进一步归因。",
};

function parseArguments(values) {
  const result = { command: values[0] ?? "", options: new Map(), flags: new Set() };
  for (let index = 1; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) throw new Error(`未知参数：${value}`);
    const next = values[index + 1];
    if (next && !next.startsWith("--")) {
      result.options.set(value, next);
      index += 1;
    } else {
      result.flags.add(value);
    }
  }
  return result;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
  }
  return value;
}

function digest(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  return createHash("sha256").update(bytes).digest("hex");
}

function documentHash(value) {
  const copy = structuredClone(value);
  delete copy.content_hash;
  return `sha256:${digest(JSON.stringify(sortJson(copy)))}`;
}

function canonicalHash(value) {
  return `sha256:${digest(JSON.stringify(sortJson(value)))}`;
}

function timestamp(value, label) {
  assert(typeof value === "string"
    && /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z$/u.test(value)
    && Number.isFinite(Date.parse(value)),
  `${label} 必须是 UTC ISO-8601 时间。`);
  return value;
}

function createValidator(schemaPath) {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addFormat("uri", {
    type: "string",
    validate: (value) => {
      try {
        return Boolean(new URL(value));
      } catch {
        return false;
      }
    },
  });
  const validate = ajv.compile(readJson(schemaPath));
  return (value, label) => {
    if (!validate(value)) {
      throw new Error(`${label}未通过 JSON Schema：${ajv.errorsText(validate.errors, { separator: "；" })}`);
    }
  };
}

const validateFailureCorpus = createValidator(failureSchemaPath);
const validateExposureLedger = createValidator(exposureSchemaPath);
const validateTrainingRun = createValidator(trainingRunSchemaPath);
const validateTrainingReport = createValidator(trainingReportSchemaPath);

function safeWriteJson(path, value, label) {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  assert(!lstatSync(parent).isSymbolicLink(), `${label}输出目录不能是符号链接。`);
  if (existsSync(path)) assert(!lstatSync(path).isSymbolicLink(), `${label}输出文件不能是符号链接。`);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function reportEntries(runsDirectory) {
  assert(existsSync(runsDirectory), `历史运行目录不存在：${runsDirectory}`);
  assert(!lstatSync(runsDirectory).isSymbolicLink(), "历史运行目录不能是符号链接。");
  const root = realpathSync(runsDirectory);
  const entries = [];
  for (const directoryEntry of readdirSync(root, { withFileTypes: true })) {
    if (!directoryEntry.isDirectory() || directoryEntry.isSymbolicLink()) continue;
    const runDirectory = resolve(root, directoryEntry.name);
    const reportPath = resolve(runDirectory, "report.json");
    const runPath = resolve(runDirectory, "run.json");
    const reportRelative = relative(root, reportPath);
    assert(reportRelative !== ".." && !reportRelative.startsWith(`..${sep}`), "历史报告路径越界。");
    if (!existsSync(reportPath) || !existsSync(runPath)) continue;
    assert(!lstatSync(reportPath).isSymbolicLink() && !lstatSync(runPath).isSymbolicLink(),
      "历史运行文件不能是符号链接。");
    const report = readJson(reportPath);
    const run = readJson(runPath);
    validateTrainingEntry(report, run, directoryEntry.name);
    entries.push({ directoryName: directoryEntry.name, report, run });
  }
  return entries.sort((left, right) => left.directoryName.localeCompare(right.directoryName));
}

function validateTrainingEntry(report, run, directoryName) {
  const label = `历史运行 ${directoryName}`;
  if (run.schema_version === "1.0" && report.schema_version === "1.1") {
    validateLegacyTrainingEntry(report, run, label);
  } else {
    validateTrainingRun(run, `${label} run.json`);
    validateTrainingReport(report, `${label} report.json`);
  }
  assert(run.content_hash === documentHash(run), `${label} run.json 内容哈希不匹配。`);
  assert(report.content_hash === documentHash(report), `${label} report.json 内容哈希不匹配。`);
  assert(run.run_id === report.run_id, `${label} 的 run/report run_id 不一致。`);
  assert(run.run_id === directoryName, `${label} 的目录名与 run_id 不一致。`);
  assert(run.status === report.status, `${label} 的 run/report 状态不一致。`);
  const expectedValidationStatus = {
    completed: "passed",
    rejected: "needs_review",
    failed: "failed",
    cancelled: "failed",
  }[report.status];
  assert(report.validation_status === expectedValidationStatus,
    `${label} 的状态与 validation_status 不一致。`);
  assert(report.checkpoint?.run_content_hash === run.content_hash,
    `${label} 的报告未绑定当前 run.json 内容哈希。`);
  assert(JSON.stringify(sortJson(report.dataset)) === JSON.stringify(sortJson(run.dataset)),
    `${label} 的 run/report 数据集快照不一致。`);
  assert(JSON.stringify(sortJson(report.selection ?? null))
    === JSON.stringify(sortJson(run.selection ?? null)),
  `${label} 的 run/report 选择范围不一致。`);

  const configuration = structuredClone(run.configuration);
  const configurationHash = configuration.config_hash;
  delete configuration.config_hash;
  assert(configurationHash === canonicalHash(configuration), `${label} 的运行配置哈希不匹配。`);
  assert(report.run_configuration?.config_hash === configurationHash,
    `${label} 的报告未绑定当前运行配置。`);
  for (const [key, value] of Object.entries(report.run_configuration ?? {})) {
    if (key === "config_hash") continue;
    const expected = key === "mode" ? run.mode : run.configuration?.[key];
    assert(value === expected, `${label} 的 run/report 配置字段 ${key} 不一致。`);
  }
  if (run.selection) {
    assert(run.configuration?.selection_hash === run.selection.content_hash,
      `${label} 的运行配置未绑定当前选择范围。`);
  }
}

function validateLegacyTrainingEntry(report, run, label) {
  assert(typeof run.run_id === "string" && run.run_id.length > 0, `${label} 旧版 run_id 无效。`);
  assert(["completed", "rejected", "failed", "cancelled"].includes(run.status),
    `${label} 旧版运行状态无效。`);
  assert(["mock", "live"].includes(run.mode), `${label} 旧版运行模式无效。`);
  assert(run.dataset && typeof run.dataset.id === "string"
    && typeof run.dataset.version === "string"
    && typeof run.dataset.content_hash === "string",
  `${label} 旧版数据集快照无效。`);
  assert(run.configuration && typeof run.configuration === "object"
    && typeof run.configuration.config_hash === "string",
  `${label} 旧版运行配置无效。`);
  assert(Array.isArray(run.items), `${label} 旧版运行条目无效。`);
  assert(typeof report.run_id === "string" && Array.isArray(report.failures),
    `${label} 旧版报告结构无效。`);
  assert(report.checkpoint && typeof report.checkpoint.run_content_hash === "string",
    `${label} 旧版报告检查点无效。`);
}

function failureText(failure) {
  return String(failure.failure_reason ?? failure.evidence ?? "");
}

function failureCode(failure) {
  return String(failure.failure_code ?? failure.dimension ?? "unknown_failure").slice(0, 80);
}

export function classifyHistoricalFailure(failure) {
  const code = failureCode(failure);
  const text = `${code} ${failureText(failure)}`.toLowerCase();
  if (/prompt.?injection|提示注入/u.test(text)) return "prompt_injection";
  if (/low.?confidence|低置信/u.test(text)) return "low_confidence";
  if (/model.?disagreement|模型分歧/u.test(text)) return "model_disagreement";
  if (/timeout|upstream|network|网络|限流/u.test(text)) return "provider_transient";
  if (/deterministic_observation_exclusion/u.test(text)) return "observer_inference";
  if (/observer|observation|观察/u.test(text)
    && /speculat|inference|疑似|推测|猜测|时段|身份/u.test(text)) return "observer_inference";
  if (/aesthetic|judgment|审美|美感|最佳|排名|风格/u.test(text)) return "aesthetic_judgment";
  if (/invalid_output|schema|字段|枚举|类型|must be|match a schema/u.test(text)) {
    return "role_schema";
  }
  if (/grounding|evidence|unsupported|unfounded|依据|证据|无依据|矛盾/u.test(text)) {
    return "unsupported_grounding";
  }
  if (/imperative|prescript|unexecutable|decision|裁剪|指令|命令|决定|机位|后期/u.test(text)) {
    return "prescriptive_direction";
  }
  if (/direction|no_options|方向/u.test(text)) return "direction_contract";
  if (/privacy|identity|sensitive|red_team|安全|隐私|身份/u.test(text)) return "safety_finding";
  if (/fatal|fail.?fast|stopped|budget|call_limit|制品|停止|预算|调用次数/u.test(text)) {
    return "training_pipeline";
  }
  return "other";
}

function repairReasonCode(failure, category) {
  const code = failureCode(failure);
  const text = `${code} ${failureText(failure)}`;
  if (failure.retryable === false) return "not_retryable";
  if (/TIMEOUT/u.test(code)) return "timeout";
  if (/UPSTREAM/u.test(code)) return "upstream_transient";
  if (/INVALID_USAGE/u.test(code)) return "usage_invalid";
  if (/SENSITIVE/u.test(code)) return "sensitive_output";
  if (category === "observer_inference") return "observer_contract_invalid";
  if (/没有返回任何可选择方向|all_direction_options_excluded/u.test(text)) {
    return "all_direction_options_excluded";
  }
  if (["direction_contract", "aesthetic_judgment", "unsupported_grounding", "prescriptive_direction"]
    .includes(category)) return "direction_contract_invalid";
  if (category === "role_schema") return "schema_invalid";
  return "unknown_failure";
}

function failureFingerprint(runId, failure) {
  return canonicalHash({
    run_id: runId,
    asset_id: failure.asset_id,
    role: failure.role,
    failure_code: failureCode(failure),
    raw_reason_hash: canonicalHash(failureText(failure)),
  });
}

function itemSplit(run, assetId) {
  return run.items?.find((item) => item.asset_id === assetId)?.dataset_split ?? "unknown";
}

function corpusRecord(entry, failure) {
  const { report, run } = entry;
  const category = classifyHistoricalFailure(failure);
  const fingerprint = failureFingerprint(report.run_id, failure);
  return {
    failure_id: `failure_${digest(fingerprint).slice(0, 24)}`,
    run_id: report.run_id,
    report_id: report.report_id,
    report_content_hash: report.content_hash,
    failure_fingerprint: fingerprint,
    asset_id: failure.asset_id,
    dataset_split: itemSplit(run, failure.asset_id),
    mode: report.run_configuration.mode,
    role: failure.role,
    provider: report.run_configuration.provider,
    model: report.run_configuration.model,
    prompt_version: report.run_configuration.prompt_version,
    schema_version: report.run_configuration.schema_version,
    failure_code: failureCode(failure),
    category,
    safe_summary: safeSummaries[category],
    repair_reason_code: repairReasonCode(failure, category),
    retryable: failure.retryable ?? null,
    validation_status: failure.validation_status,
    observed_at: report.completed_at,
  };
}

function buildFailureCorpus(entries, createdAt) {
  const byId = new Map();
  for (const entry of entries) {
    for (const failure of entry.report.failures ?? []) {
      const record = corpusRecord(entry, failure);
      byId.set(record.failure_id, record);
    }
  }
  const records = [...byId.values()].sort((left, right) =>
    left.failure_id.localeCompare(right.failure_id));
  assert(records.length > 0, "历史运行中没有可建立语料的失败记录。");
  const corpus = {
    schema_version: "1.0",
    corpus_id: "photography_skill_failure_corpus_v1",
    created_at: createdAt,
    source_root: ".local/skill-training",
    record_count: records.length,
    records,
    content_hash: "sha256:pending",
  };
  corpus.content_hash = documentHash(corpus);
  validateFailureCorpus(corpus, "历史失败语料库");
  return corpus;
}

function buildExposureLedger(entries, manifest, createdAt) {
  const exposures = new Map(manifest.assets.map((asset) => [asset.asset_id, {
    asset_id: asset.asset_id,
    dataset_split: asset.dataset_split,
    source_url: asset.source_url,
    content_hash: asset.content_hash,
    selected_exposed: false,
    provider_exposed: false,
    live_completed: false,
    mock_seen: false,
    potential_iteration_influence: false,
    run_ids: [],
    prompt_versions: [],
    first_seen_at: null,
    last_seen_at: null,
    unseen_eligible: true,
  }]));

  for (const { report, run } of entries) {
    if (report.dataset?.id !== manifest.dataset_id
      || report.dataset?.version !== manifest.dataset_version
      || report.dataset?.content_hash !== manifest.content_hash) {
      continue;
    }
    const selectedIds = report.selection?.asset_ids ?? run.selection?.asset_ids ?? [];
    const calledIds = new Set((run.call_records ?? []).map((record) => record.asset_id));
    const completedIds = new Set((run.items ?? [])
      .filter((item) => item.outcome === "completed" || item.outcome === "quarantined")
      .map((item) => item.asset_id));
    const startedAt = report.started_at ?? run.started_at;
    const completedAt = report.completed_at ?? run.completed_at ?? startedAt;
    for (const assetId of selectedIds) {
      const exposure = exposures.get(assetId);
      assert(exposure, `历史运行引用了清单外资产：${assetId}`);
      exposure.selected_exposed = true;
      exposure.provider_exposed ||= calledIds.has(assetId);
      exposure.live_completed ||= report.run_configuration.mode === "live" && completedIds.has(assetId);
      exposure.mock_seen ||= report.run_configuration.mode === "mock";
      exposure.potential_iteration_influence ||= report.run_configuration.mode === "live"
        && calledIds.has(assetId);
      exposure.run_ids.push(report.run_id);
      exposure.prompt_versions.push(report.run_configuration.prompt_version);
      exposure.first_seen_at = exposure.first_seen_at === null || startedAt < exposure.first_seen_at
        ? startedAt
        : exposure.first_seen_at;
      exposure.last_seen_at = exposure.last_seen_at === null || completedAt > exposure.last_seen_at
        ? completedAt
        : exposure.last_seen_at;
      exposure.unseen_eligible = false;
    }
  }

  const assets = [...exposures.values()]
    .map((entry) => ({
      ...entry,
      run_ids: [...new Set(entry.run_ids)].sort(),
      prompt_versions: [...new Set(entry.prompt_versions)].sort(),
    }))
    .sort((left, right) => left.asset_id.localeCompare(right.asset_id));
  const holdout = assets.filter((asset) => asset.dataset_split === "holdout");
  const ledger = {
    schema_version: "1.0",
    ledger_id: "photography_skill_exposure_ledger_v1",
    created_at: createdAt,
    dataset: {
      id: manifest.dataset_id,
      version: manifest.dataset_version,
      content_hash: manifest.content_hash,
    },
    summary: {
      asset_count: assets.length,
      selected_exposed_count: assets.filter((asset) => asset.selected_exposed).length,
      provider_exposed_count: assets.filter((asset) => asset.provider_exposed).length,
      holdout_count: holdout.length,
      holdout_exposed_count: holdout.filter((asset) => asset.selected_exposed).length,
      unseen_holdout_count: holdout.filter((asset) => asset.unseen_eligible).length,
    },
    assets,
    content_hash: "sha256:pending",
  };
  ledger.content_hash = documentHash(ledger);
  validateExposureLedger(ledger, "样本暴露账本");
  return ledger;
}

function replayCorpus(corpus, entries) {
  validateFailureCorpus(corpus, "历史失败语料库");
  assert(corpus.content_hash === documentHash(corpus), "历史失败语料库内容哈希不匹配。");
  assert(corpus.record_count === corpus.records.length, "历史失败语料库计数不一致。");
  const entriesByRunId = new Map(entries.map((entry) => [entry.report.run_id, entry]));
  let replayed = 0;
  for (const record of corpus.records) {
    const entry = entriesByRunId.get(record.run_id);
    assert(entry, `缺少历史运行：${record.run_id}`);
    assert(entry.report.content_hash === record.report_content_hash,
      `${record.failure_id} 的报告哈希不匹配。`);
    const failure = (entry.report.failures ?? []).find((candidate) =>
      failureFingerprint(record.run_id, candidate) === record.failure_fingerprint);
    assert(failure, `${record.failure_id} 无法在原报告中重放。`);
    const rebuilt = corpusRecord(entry, failure);
    assert(JSON.stringify(rebuilt) === JSON.stringify(record),
      `${record.failure_id} 的当前分类与历史语料不一致。`);
    replayed += 1;
  }
  return {
    status: "passed",
    corpus_id: corpus.corpus_id,
    replayed,
    content_hash: corpus.content_hash,
  };
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const runsDirectory = resolve(args.options.get("--runs-dir") ?? defaultRunsDirectory);
  const entries = reportEntries(runsDirectory);
  if (args.command === "build") {
    const createdAt = timestamp(args.options.get("--created-at"), "--created-at");
    const manifestPath = resolve(args.options.get("--manifest") ?? defaultManifestPath);
    const outputDirectory = resolve(args.options.get("--output-dir") ?? defaultOutputDirectory);
    const manifest = readJson(manifestPath);
    const corpus = buildFailureCorpus(entries, createdAt);
    const ledger = buildExposureLedger(entries, manifest, createdAt);
    safeWriteJson(resolve(outputDirectory, "failure-corpus.json"), corpus, "历史失败语料库");
    safeWriteJson(resolve(outputDirectory, "exposure-ledger.json"), ledger, "样本暴露账本");
    process.stdout.write(`${JSON.stringify({
      status: "ok",
      failure_records: corpus.record_count,
      exposure_summary: ledger.summary,
      failure_corpus_hash: corpus.content_hash,
      exposure_ledger_hash: ledger.content_hash,
    })}\n`);
    return;
  }
  if (args.command === "replay") {
    const corpusPath = resolve(
      args.options.get("--corpus")
        ?? resolve(defaultOutputDirectory, "failure-corpus.json"),
    );
    const result = replayCorpus(readJson(corpusPath), entries);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  throw new Error(
    "用法：node scripts/training-history.mjs <build|replay> "
      + "[--runs-dir PATH] [--manifest PATH] [--output-dir PATH] [--created-at ISO] [--corpus PATH]",
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`训练历史命令失败：${error.message}\n`);
    process.exitCode = 1;
  });
}
