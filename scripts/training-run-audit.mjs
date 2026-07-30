import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
} from "node:fs";
import path from "node:path";

const defaultRoles = ["observer", "direction_generator", "critic", "red_team", "curator"];

export function auditTrainingRun({
  reportPath,
  report,
  expectedAssetIds,
  expectedRunId = report?.run_id,
  expectedRoles = defaultRoles,
  expectedConfiguration = null,
  maxFailedCalls,
  maxUncertainCalls,
  maxRepairCalls,
}) {
  const failedResult = {
    valid: false,
    repairedCalls: 0,
    unresolvedFailedCalls: Number(report?.telemetry?.failed_calls ?? 0),
    recoveredUncertainCalls: 0,
    unresolvedUncertainCalls: Number(report?.telemetry?.uncertain_calls ?? 0),
    reason: "run_audit_failed",
  };
  if (!reportPath || path.basename(reportPath) !== "report.json") return failedResult;
  const runPath = path.join(path.dirname(reportPath), "run.json");
  if (!existsSync(runPath) || pathHasSymbolicLink(runPath)) {
    return { ...failedResult, reason: "run_missing_or_unsafe" };
  }

  let run;
  try {
    run = JSON.parse(readFileSync(runPath, "utf8"));
  } catch {
    return { ...failedResult, reason: "run_invalid_json" };
  }
  if (typeof run.content_hash !== "string"
    || run.content_hash !== trainingContentHash(run)
    || report.checkpoint?.run_content_hash !== run.content_hash
    || run.run_id !== report.run_id
    || run.run_id !== expectedRunId
    || run.mode !== "live"
    || run.status !== "completed") {
    return { ...failedResult, reason: "run_snapshot_mismatch" };
  }
  if (expectedConfiguration
    && Object.entries(expectedConfiguration).some(
      ([key, value]) => run.configuration?.[key] !== value,
    )) {
    return { ...failedResult, reason: "run_configuration_mismatch" };
  }
  const configurationForHash = structuredClone(run.configuration ?? {});
  const storedConfigurationHash = configurationForHash.config_hash;
  delete configurationForHash.config_hash;
  if (storedConfigurationHash !== canonicalHash(configurationForHash)
    || report.run_configuration?.config_hash !== storedConfigurationHash) {
    return { ...failedResult, reason: "configuration_hash_mismatch" };
  }
  if (!sameSet(run.selection?.asset_ids ?? [], expectedAssetIds)) {
    return { ...failedResult, reason: "run_selection_mismatch" };
  }

  const records = Array.isArray(run.call_records) ? run.call_records : [];
  const expectedKeys = new Set(expectedAssetIds.flatMap((assetId) =>
    expectedRoles.map((role) => `${assetId}:${role}`)));
  const groups = new Map();
  const recordKeys = new Set();
  const callIds = new Set();
  let duplicateRecordKey = false;
  let duplicateCallId = false;
  let unexpectedRecord = false;
  for (const record of records) {
    const groupKey = `${record.asset_id}:${record.role}`;
    const recordKey = `${groupKey}:${record.attempt}`;
    if (recordKeys.has(recordKey)) duplicateRecordKey = true;
    recordKeys.add(recordKey);
    if (typeof record.call_id !== "string" || callIds.has(record.call_id)) duplicateCallId = true;
    callIds.add(record.call_id);
    if (!expectedKeys.has(groupKey)) unexpectedRecord = true;
    const group = groups.get(groupKey) ?? [];
    group.push(record);
    groups.set(groupKey, group);
  }

  let callSequenceValid = !duplicateRecordKey
    && !duplicateCallId
    && !unexpectedRecord
    && groups.size === expectedKeys.size
    && [...expectedKeys].every((key) => groups.has(key));
  let repairedCalls = 0;
  let recoveredUncertainCalls = 0;
  for (const key of expectedKeys) {
    const group = [...(groups.get(key) ?? [])].sort((left, right) => left.attempt - right.attempt);
    if (group.length === 0
      || group.length > Number(run.configuration?.max_attempts ?? 0)
      || group.filter((record) => record.status === "successful").length !== 1
      || group.at(-1)?.status !== "successful") {
      callSequenceValid = false;
      continue;
    }
    for (let index = 0; index < group.length; index += 1) {
      const record = group[index];
      if (record.attempt !== index + 1) callSequenceValid = false;
      if (index === group.length - 1) continue;
      if (!["failed", "uncertain"].includes(record.status)
        || record.error?.retryable !== true) {
        callSequenceValid = false;
      } else if (record.status === "failed") {
        repairedCalls += 1;
      } else {
        recoveredUncertainCalls += 1;
      }
    }
  }

  const successful = records.filter((record) => record.status === "successful");
  const failed = records.filter((record) => record.status === "failed");
  const uncertain = records.filter((record) => record.status === "uncertain");
  const repairCalls = failed.length + uncertain.length;
  const telemetry = summarizeRecords(records);
  const telemetryMatches = telemetry !== null
    && [
      "provider_calls",
      "successful_calls",
      "failed_calls",
      "uncertain_calls",
      "prompt_tokens",
      "completion_tokens",
      "estimated_cost",
      "total_latency_ms",
    ].every((key) => approximately(telemetry[key], report.telemetry?.[key]));
  const budgetMatches = approximately(run.budget?.provider_calls, telemetry?.provider_calls)
    && approximately(run.budget?.uncertain_calls, telemetry?.uncertain_calls)
    && approximately(run.budget?.estimated_spend, telemetry?.estimated_cost)
    && Number(run.budget?.reserved ?? 0) === 0
    && Number(run.budget?.reserved_calls ?? 0) === 0;
  const valid = callSequenceValid
    && telemetryMatches
    && budgetMatches
    && records.length === report.telemetry?.provider_calls
    && successful.length === report.telemetry?.successful_calls
    && failed.length === report.telemetry?.failed_calls
    && uncertain.length === report.telemetry?.uncertain_calls
    && successful.length === expectedKeys.size
    && failed.length <= maxFailedCalls
    && uncertain.length <= maxUncertainCalls
    && repairCalls <= maxRepairCalls
    && repairedCalls === failed.length
    && recoveredUncertainCalls === uncertain.length;
  const closedFailedCalls = callSequenceValid ? repairedCalls : 0;
  const closedUncertainCalls = callSequenceValid ? recoveredUncertainCalls : 0;
  return {
    valid,
    repairedCalls: closedFailedCalls,
    unresolvedFailedCalls: failed.length - closedFailedCalls,
    recoveredUncertainCalls: closedUncertainCalls,
    unresolvedUncertainCalls: uncertain.length - closedUncertainCalls,
    reason: valid ? null : "call_sequence_mismatch",
  };
}

export function trainingContentHash(document) {
  const pending = structuredClone(document);
  delete pending.content_hash;
  return `sha256:${createHash("sha256").update(JSON.stringify(sortJson(pending))).digest("hex")}`;
}

function canonicalHash(document) {
  return `sha256:${createHash("sha256").update(JSON.stringify(sortJson(document))).digest("hex")}`;
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
  }
  return value;
}

function pathHasSymbolicLink(candidate) {
  let current = path.parse(candidate).root;
  for (const segment of candidate.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!existsSync(current)) break;
    if (lstatSync(current).isSymbolicLink()) return true;
  }
  return false;
}

function sameSet(left, right) {
  if (left.length !== right.length) return false;
  const values = new Set(left);
  return values.size === left.length && right.every((value) => values.has(value));
}

function summarizeRecords(records) {
  let promptTokens = 0;
  let completionTokens = 0;
  let estimatedCost = 0;
  let totalLatencyMs = 0;
  for (const record of records) {
    if (!record.usage
      || record.usage.calls !== 1
      || !Number.isInteger(record.usage.prompt_tokens)
      || !Number.isInteger(record.usage.completion_tokens)
      || !Number.isFinite(record.usage.estimated_cost)
      || !Number.isInteger(record.latency_ms)) {
      return null;
    }
    promptTokens += record.usage.prompt_tokens;
    completionTokens += record.usage.completion_tokens;
    estimatedCost += record.usage.estimated_cost;
    totalLatencyMs += record.latency_ms;
  }
  return {
    provider_calls: records.length,
    successful_calls: records.filter((record) => record.status === "successful").length,
    failed_calls: records.filter((record) => record.status === "failed").length,
    uncertain_calls: records.filter((record) => record.status === "uncertain").length,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    estimated_cost: roundCurrency(estimatedCost),
    total_latency_ms: totalLatencyMs,
  };
}

function approximately(left, right) {
  return Number.isFinite(Number(left))
    && Number.isFinite(Number(right))
    && Math.abs(Number(left) - Number(right)) <= 0.000001;
}

function roundCurrency(value) {
  return Math.round((Number(value) + Number.EPSILON) * 1_000_000) / 1_000_000;
}
