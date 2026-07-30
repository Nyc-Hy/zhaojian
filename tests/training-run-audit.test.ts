import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditTrainingRun } from "../scripts/training-run-audit.mjs";

type JsonObject = Record<string, any>;

const roles = ["observer", "direction_generator", "critic", "red_team", "curator"];
const createdDirectories: string[] = [];

afterEach(() => {
  for (const directory of createdDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("真实训练逐调用审计", () => {
  it("接受每个资产角色恰好一次最终成功的连续调用链", () => {
    const fixture = createFixture();

    const result = audit(fixture);

    expect(result).toMatchObject({
      valid: true,
      repairedCalls: 0,
      unresolvedFailedCalls: 0,
      recoveredUncertainCalls: 0,
      unresolvedUncertainCalls: 0,
      reason: null,
    });
  });

  it("拒绝重复的 asset-role-attempt 让一次成功伪装修复两次", () => {
    const fixture = createFixture();
    const failed = failedRecord("observer", 1);
    const successful = fixture.run.call_records.find(
      (record: JsonObject) => record.role === "observer",
    );
    successful.attempt = 2;
    fixture.run.call_records.unshift(structuredClone(failed), structuredClone(failed));
    fixture.report.telemetry.failed_calls = 2;
    fixture.report.telemetry.provider_calls = 7;
    rewriteFixture(fixture);

    const result = audit(fixture, { maxFailedCalls: 2, maxRepairCalls: 2 });

    expect(result).toMatchObject({
      valid: false,
      repairedCalls: 0,
      unresolvedFailedCalls: 2,
      reason: "call_sequence_mismatch",
    });
  });

  it("拒绝缺号或出现多个成功结果的调用链", () => {
    const fixture = createFixture();
    const observer = fixture.run.call_records.find(
      (record: JsonObject) => record.role === "observer",
    );
    observer.attempt = 2;
    fixture.run.call_records.push(successfulRecord("observer", 3));
    fixture.report.telemetry.successful_calls = 6;
    fixture.report.telemetry.provider_calls = 6;
    rewriteFixture(fixture);

    const result = audit(fixture);

    expect(result).toMatchObject({
      valid: false,
      reason: "call_sequence_mismatch",
    });
  });

  it("拒绝运行配置哈希或报告配置引用被篡改", () => {
    const fixture = createFixture();
    fixture.report.run_configuration.config_hash =
      "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    rewriteFixture(fixture, { preserveReportConfigurationHash: true });

    const result = audit(fixture);

    expect(result).toMatchObject({
      valid: false,
      reason: "configuration_hash_mismatch",
    });
  });
});

function createFixture() {
  const auditRoot = resolve(".local", "skill-training");
  mkdirSync(auditRoot, { recursive: true });
  const directory = mkdtempSync(resolve(auditRoot, "audit-test-"));
  createdDirectories.push(directory);
  const configuration: JsonObject = {
    provider: "qwen",
    model: "qwen3.7-plus-2026-05-26",
    prompt_version: "2.0.0",
    schema_version: "2.0.0",
    max_attempts: 2,
    max_provider_calls: 6,
    budget_limit: 0.8,
    base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    fail_fast: true,
    config_hash: "sha256:pending",
  };
  configuration.config_hash = configurationHash(configuration);
  const assetId = "photo-v1-landscape-001";
  const run: JsonObject = {
    run_id: "run_live_contract2_smoke1_v2_20260728_001",
    mode: "live",
    status: "completed",
    selection: {
      asset_ids: [assetId],
    },
    configuration,
    call_records: roles.map((role) => successfulRecord(role, 1)),
    budget: {
      provider_calls: 5,
      uncertain_calls: 0,
      estimated_spend: 0.05,
      reserved: 0,
      reserved_calls: 0,
    },
    content_hash: "sha256:pending",
  };
  const report: JsonObject = {
    run_id: run.run_id,
    run_configuration: {
      config_hash: configuration.config_hash,
    },
    checkpoint: {
      run_content_hash: "sha256:pending",
    },
    telemetry: {
      provider_calls: 5,
      successful_calls: 5,
      failed_calls: 0,
      uncertain_calls: 0,
      prompt_tokens: 5000,
      completion_tokens: 5000,
      estimated_cost: 0.05,
      total_latency_ms: 50,
    },
  };
  const fixture = {
    directory,
    reportPath: resolve(directory, "report.json"),
    run,
    report,
    assetId,
  };
  rewriteFixture(fixture);
  return fixture;
}

function rewriteFixture(
  fixture: ReturnType<typeof createFixture>,
  options: { preserveReportConfigurationHash?: boolean } = {},
) {
  fixture.run.configuration.config_hash = configurationHash(fixture.run.configuration);
  fixture.run.content_hash = contentHash(fixture.run);
  fixture.report.checkpoint.run_content_hash = fixture.run.content_hash;
  if (!options.preserveReportConfigurationHash) {
    fixture.report.run_configuration.config_hash = fixture.run.configuration.config_hash;
  }
  writeFileSync(resolve(fixture.directory, "run.json"), `${JSON.stringify(fixture.run, null, 2)}\n`);
  writeFileSync(fixture.reportPath, `${JSON.stringify(fixture.report, null, 2)}\n`);
}

function audit(
  fixture: ReturnType<typeof createFixture>,
  limits: Partial<{
    maxFailedCalls: number;
    maxUncertainCalls: number;
    maxRepairCalls: number;
  }> = {},
) {
  return auditTrainingRun({
    reportPath: fixture.reportPath,
    report: fixture.report,
    expectedAssetIds: [fixture.assetId],
    expectedRunId: fixture.run.run_id,
    expectedConfiguration: {
      provider: "qwen",
      model: "qwen3.7-plus-2026-05-26",
      prompt_version: "2.0.0",
      schema_version: "2.0.0",
      max_attempts: 2,
      max_provider_calls: 6,
      budget_limit: 0.8,
      base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      fail_fast: true,
    },
    maxFailedCalls: limits.maxFailedCalls ?? 1,
    maxUncertainCalls: limits.maxUncertainCalls ?? 1,
    maxRepairCalls: limits.maxRepairCalls ?? 1,
  });
}

function successfulRecord(role: string, attempt: number): JsonObject {
  return {
    call_id: `call_${role}_${attempt}_successful`,
    asset_id: "photo-v1-landscape-001",
    role,
    attempt,
    status: "successful",
    latency_ms: 10,
    usage: {
      prompt_tokens: 1000,
      completion_tokens: 1000,
      calls: 1,
      estimated_cost: 0.01,
    },
    error: null,
  };
}

function failedRecord(role: string, attempt: number): JsonObject {
  return {
    call_id: `call_${role}_${attempt}_failed`,
    asset_id: "photo-v1-landscape-001",
    role,
    attempt,
    status: "failed",
    latency_ms: 10,
    usage: {
      prompt_tokens: 1000,
      completion_tokens: 1000,
      calls: 1,
      estimated_cost: 0.01,
    },
    error: {
      code: "TRAINING_PROVIDER_INVALID_OUTPUT",
      retryable: true,
    },
  };
}

function configurationHash(configuration: JsonObject) {
  const pending = structuredClone(configuration);
  delete pending.config_hash;
  return canonicalHash(pending);
}

function contentHash(value: JsonObject) {
  const pending = structuredClone(value);
  delete pending.content_hash;
  return canonicalHash(pending);
}

function canonicalHash(value: JsonObject) {
  return `sha256:${createHash("sha256").update(JSON.stringify(sortJson(value))).digest("hex")}`;
}

function sortJson(value: any): any {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
  }
  return value;
}
