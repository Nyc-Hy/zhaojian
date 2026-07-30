import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

type JsonObject = Record<string, unknown>;

const scriptPath = resolve("scripts/skill-trainer.mjs");
const forbiddenKeys = new Set([
  "image",
  "image_data",
  "base64",
  "full_user_text",
  "reasoning",
  "chain_of_thought",
  "gps",
  "aesthetic_score",
]);

function runTrainer(args: string[], environment = process.env) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: resolve("."),
    encoding: "utf8",
    env: environment,
  });
}

function readJson(path: string): JsonObject {
  return JSON.parse(readFileSync(path, "utf8")) as JsonObject;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as JsonObject)
        .sort()
        .map((key) => [key, sortJson((value as JsonObject)[key])]),
    );
  }
  return value;
}

function refreshContentHash(value: JsonObject): void {
  const copy = structuredClone(value);
  delete copy.content_hash;
  value.content_hash = `sha256:${createHash("sha256")
    .update(JSON.stringify(sortJson(copy)), "utf8")
    .digest("hex")}`;
}

function assertWhitelisted(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertWhitelisted);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as JsonObject)) {
    expect(forbiddenKeys).not.toContain(key);
    assertWhitelisted(child);
  }
}

describe("AI Skill Trainer Mock 控制面", () => {
  it("完整编排 60 项五角色流程并隔离困难样例", () => {
    const outputDirectory = mkdtempSync(resolve(tmpdir(), "zhaojian-trainer-"));
    try {
      const result = runTrainer([
        "run",
        "--mode",
        "mock",
        "--output-dir",
        outputDirectory,
        "--run-id",
        "mock_complete_001",
        "--concurrency",
        "4",
      ]);

      expect(result.status, result.stderr).toBe(0);
      const response = JSON.parse(result.stdout) as JsonObject;
      expect(response.status).toBe("ok");
      const report = readJson(resolve(outputDirectory, "mock_complete_001", "report.json"));
      expect(report.status).toBe("completed");
      expect(report.counts).toEqual({
        total: 60,
        completed: 57,
        quarantined: 3,
        failed: 0,
        cancelled: 0,
      });
      const roleRuns = report.role_runs as JsonObject[];
      expect(roleRuns.map((roleRun) => [roleRun.role, roleRun.attempts])).toEqual([
        ["observer", 60],
        ["direction_generator", 61],
        ["critic", 60],
        ["red_team", 60],
        ["curator", 60],
      ]);
      expect(report.failures).toHaveLength(3);
      expect((report.checkpoint as JsonObject).artifact_count).toBe(60);
      const artifactsDirectory = resolve(outputDirectory, "mock_complete_001", "artifacts");
      expect(readdirSync(artifactsDirectory)).toHaveLength(60);

      const trainingArtifact = readJson(resolve(artifactsDirectory, "photo-v1-landscape-001.json"));
      expect(trainingArtifact.mock_only).toBe(true);
      expect(trainingArtifact.eligible_for_training).toBe(false);
      expect((trainingArtifact.skill_improvement_candidates as unknown[]).length).toBeGreaterThan(0);
      const holdoutArtifact = readJson(resolve(artifactsDirectory, "photo-v3-landscape-001.json"));
      expect(holdoutArtifact.dataset_split).toBe("holdout");
      expect(holdoutArtifact.skill_improvement_candidates).toEqual([]);
      assertWhitelisted(report);
      assertWhitelisted(trainingArtifact);

      const terminalCancel = runTrainer([
        "cancel",
        "--output-dir",
        outputDirectory,
        "--run-id",
        "mock_complete_001",
      ]);
      expect(terminalCancel.status, terminalCancel.stderr).toBe(0);
      const terminalCancelResponse = JSON.parse(terminalCancel.stdout) as JsonObject;
      expect(terminalCancelResponse.status).toBe("completed");
      expect(terminalCancelResponse.already_terminal).toBe(true);
      expect((terminalCancelResponse.report as JsonObject).content_hash).toBe(report.content_hash);
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  });

  it("从角色级检查点恢复且不重复已完成尝试", () => {
    const outputDirectory = mkdtempSync(resolve(tmpdir(), "zhaojian-trainer-"));
    try {
      const interrupted = runTrainer([
        "run",
        "--mode",
        "mock",
        "--output-dir",
        outputDirectory,
        "--run-id",
        "mock_resume_001",
        "--concurrency",
        "1",
        "--interrupt-after",
        "7",
      ]);
      expect(interrupted.status, interrupted.stderr).toBe(0);
      expect(JSON.parse(interrupted.stdout).status).toBe("interrupted");
      expect(existsSync(resolve(outputDirectory, "mock_resume_001", "report.json"))).toBe(false);

      const mismatchedResume = runTrainer([
        "run",
        "--mode",
        "mock",
        "--output-dir",
        outputDirectory,
        "--run-id",
        "mock_resume_001",
        "--max-attempts",
        "3",
      ]);
      expect(mismatchedResume.status).not.toBe(0);
      expect(mismatchedResume.stderr).toContain("恢复参数 --max-attempts 与已有检查点配置不一致");

      const mismatchedSelection = runTrainer([
        "run",
        "--mode",
        "mock",
        "--output-dir",
        outputDirectory,
        "--run-id",
        "mock_resume_001",
        "--asset-ids",
        "photo-v1-landscape-001",
      ]);
      expect(mismatchedSelection.status).not.toBe(0);
      expect(mismatchedSelection.stderr).toContain("恢复参数 --asset-ids 与已有检查点选择范围不一致");

      const resumed = runTrainer([
        "run",
        "--mode",
        "mock",
        "--output-dir",
        outputDirectory,
        "--run-id",
        "mock_resume_001",
      ]);
      expect(resumed.status, resumed.stderr).toBe(0);
      expect(JSON.parse(resumed.stdout).resumed).toBe(true);
      const report = readJson(resolve(outputDirectory, "mock_resume_001", "report.json"));
      expect((report.role_runs as JsonObject[]).map((roleRun) => roleRun.attempts)).toEqual([60, 61, 60, 60, 60]);
      expect((report.counts as JsonObject).completed).toBe(57);
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  });

  it("取消中断运行并保留可验证终态报告", () => {
    const outputDirectory = mkdtempSync(resolve(tmpdir(), "zhaojian-trainer-"));
    try {
      const interrupted = runTrainer([
        "run",
        "--mode",
        "mock",
        "--output-dir",
        outputDirectory,
        "--run-id",
        "mock_cancel_001",
        "--concurrency",
        "1",
        "--interrupt-after",
        "3",
      ]);
      expect(interrupted.status, interrupted.stderr).toBe(0);

      const cancelled = runTrainer([
        "cancel",
        "--output-dir",
        outputDirectory,
        "--run-id",
        "mock_cancel_001",
      ]);
      expect(cancelled.status, cancelled.stderr).toBe(0);
      const report = readJson(resolve(outputDirectory, "mock_cancel_001", "report.json"));
      expect(report.status).toBe("cancelled");
      expect(report.counts).toEqual({
        total: 60,
        completed: 0,
        quarantined: 0,
        failed: 0,
        cancelled: 60,
      });
      expect((report.budget as JsonObject).stop_reason).toBe("cancelled");

      const repeatedCancel = runTrainer([
        "cancel",
        "--output-dir",
        outputDirectory,
        "--run-id",
        "mock_cancel_001",
      ]);
      expect(repeatedCancel.status, repeatedCancel.stderr).toBe(0);
      expect(readJson(resolve(outputDirectory, "mock_cancel_001", "report.json")).content_hash).toBe(report.content_hash);
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  });

  it("有限重试耗尽后拒绝运行但不丢失其他样例", () => {
    const outputDirectory = mkdtempSync(resolve(tmpdir(), "zhaojian-trainer-"));
    try {
      const result = runTrainer([
        "run",
        "--mode",
        "mock",
        "--output-dir",
        outputDirectory,
        "--run-id",
        "mock_retry_limit_001",
        "--max-attempts",
        "1",
      ]);
      expect(result.status, result.stderr).toBe(0);
      const report = readJson(resolve(outputDirectory, "mock_retry_limit_001", "report.json"));
      expect(report.status).toBe("rejected");
      expect(report.counts).toEqual({
        total: 60,
        completed: 56,
        quarantined: 3,
        failed: 1,
        cancelled: 0,
      });
      expect((report.failures as JsonObject[]).some((failure) =>
        failure.asset_id === "photo-v1-difficult-004"
        && failure.dimension === "mock_transient_failure")).toBe(true);
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  });

  it("相同快照与配置生成相同可比较键", () => {
    const outputDirectory = mkdtempSync(resolve(tmpdir(), "zhaojian-trainer-"));
    try {
      for (const runId of ["mock_compare_001", "mock_compare_002"]) {
        const result = runTrainer([
          "run",
          "--mode",
          "mock",
          "--output-dir",
          outputDirectory,
          "--run-id",
          runId,
          "--concurrency",
          "3",
        ]);
        expect(result.status, result.stderr).toBe(0);
      }
      const first = readJson(resolve(outputDirectory, "mock_compare_001", "report.json"));
      const second = readJson(resolve(outputDirectory, "mock_compare_002", "report.json"));
      expect((first.checkpoint as JsonObject).comparable_run_key)
        .toBe((second.checkpoint as JsonObject).comparable_run_key);
      expect(first.run_id).not.toBe(second.run_id);
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  }, 10_000);

  it("真实训练缺少显式联网授权时在创建运行前关闭失败", () => {
    const outputDirectory = mkdtempSync(resolve(tmpdir(), "zhaojian-trainer-"));
    try {
      const result = runTrainer([
        "run",
        "--mode",
        "live",
        "--provider",
        "qwen",
        "--model",
        "qwen-test",
        "--budget",
        "1",
        "--output-dir",
        outputDirectory,
        "--run-id",
        "live_guard_001",
      ]);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("必须显式传入 --allow-network");
      expect(existsSync(resolve(outputDirectory, "live_guard_001"))).toBe(false);
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  });

  it("真实训练拒绝把 Qwen 密钥发送到未冻结 Base URL", () => {
    const outputDirectory = mkdtempSync(resolve(tmpdir(), "zhaojian-trainer-"));
    try {
      const result = runTrainer([
        "run",
        "--mode",
        "live",
        "--allow-network",
        "--provider",
        "qwen",
        "--model",
        "qwen3.7-plus-2026-05-26",
        "--base-url",
        "https://example.invalid/compatible-mode/v1",
        "--asset-ids",
        "photo-v1-landscape-001",
        "--max-attempts",
        "1",
        "--max-provider-calls",
        "5",
        "--budget",
        "1",
        "--pricing-version",
        "fixture-pricing",
        "--pricing-effective-at",
        "2026-07-27T00:00:00Z",
        "--input-per-million",
        "2",
        "--output-per-million",
        "8",
        "--max-cost-per-call",
        "0.545",
        "--output-dir",
        outputDirectory,
        "--run-id",
        "live_bad_base_url_001",
      ], {
        ...process.env,
        Model__Qwen__ApiKey: "test-key-never-sent",
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("必须使用冻结的官方兼容端点");
      expect(existsSync(resolve(outputDirectory, "live_bad_base_url_001"))).toBe(false);
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  });

  it("小样本 Live Fixture 只处理显式选择并完整记录调用审计", () => {
    const outputDirectory = mkdtempSync(resolve(tmpdir(), "zhaojian-trainer-"));
    const selectedAssetIds = [
      "photo-v1-landscape-001",
      "photo-v1-portrait-007",
      "photo-v3-difficult-001",
    ];
    try {
      const result = runTrainer([
        "run",
        "--mode",
        "live",
        "--allow-network",
        "--provider",
        "test-fixture",
        "--model",
        "fixture-live-v1",
        "--asset-ids",
        selectedAssetIds.join(","),
        "--max-attempts",
        "1",
        "--max-provider-calls",
        "15",
        "--budget",
        "0.03",
        "--pricing-version",
        "fixture-2026-07",
        "--pricing-effective-at",
        "2026-07-27T00:00:00Z",
        "--input-per-million",
        "1",
        "--output-per-million",
        "1",
        "--max-cost-per-call",
        "0.002",
        "--concurrency",
        "1",
        "--output-dir",
        outputDirectory,
        "--run-id",
        "live_smoke_fixture_001",
      ], {
        ...process.env,
        NODE_ENV: "test",
        ZHAOJIAN_ENABLE_TRAINING_FIXTURE: "1",
      });

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).status).toBe("ok");
      const run = readJson(resolve(outputDirectory, "live_smoke_fixture_001", "run.json"));
      expect(run.schema_version).toBe("1.1");
      expect(run.selection).toMatchObject({
        strategy: "explicit_asset_ids",
        source_asset_count: 60,
        selected_asset_count: 3,
        asset_ids: selectedAssetIds,
        split_counts: { training: 1, regression: 1, holdout: 1 },
      });
      expect((run.configuration as JsonObject).max_provider_calls).toBe(15);
      expect((run.configuration as JsonObject).selection_hash)
        .toBe((run.selection as JsonObject).content_hash);
      expect((run.items as JsonObject[]).map((item) => item.asset_id)).toEqual(selectedAssetIds);
      expect(run.budget).toMatchObject({
        estimated_spend: 0.03,
        provider_calls: 15,
        uncertain_calls: 0,
      });
      const callRecords = run.call_records as JsonObject[];
      expect(callRecords).toHaveLength(15);
      expect(callRecords.every((record) =>
        record.status === "successful"
        && Number(record.latency_ms) >= 0
        && (record.usage as JsonObject).prompt_tokens === 1000
        && (record.usage as JsonObject).completion_tokens === 1000)).toBe(true);

      const report = readJson(resolve(outputDirectory, "live_smoke_fixture_001", "report.json"));
      expect(report.schema_version).toBe("1.5");
      expect(report.status).toBe("completed");
      expect(report.counts).toEqual({
        total: 3,
        completed: 3,
        quarantined: 0,
        failed: 0,
        cancelled: 0,
      });
      expect(report.telemetry).toMatchObject({
        provider_calls: 15,
        successful_calls: 15,
        failed_calls: 0,
        uncertain_calls: 0,
        prompt_tokens: 15000,
        completion_tokens: 15000,
        estimated_cost: 0.03,
      });
      expect((report.metrics as JsonObject[]).map((metric) => metric.dimension)).toEqual([
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
      expect((report.role_runs as JsonObject[]).every((roleRun) =>
        roleRun.provider_calls === 3
        && roleRun.successful_calls === 3
        && roleRun.failed_calls === 0
        && roleRun.uncertain_calls === 0)).toBe(true);
      expect((report.checkpoint as JsonObject).artifact_count).toBe(3);
      assertWhitelisted(run);
      assertWhitelisted(report);
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  });

  it("多个改进候选复用同一证据时确定性去重而不中断整批训练", () => {
    const outputDirectory = mkdtempSync(resolve(tmpdir(), "zhaojian-trainer-"));
    try {
      const result = runTrainer([
        "run",
        "--mode",
        "live",
        "--allow-network",
        "--provider",
        "test-fixture",
        "--model",
        "training-fixture-duplicate-candidate-evidence-v1",
        "--asset-ids",
        "photo-v1-landscape-001",
        "--max-attempts",
        "1",
        "--max-provider-calls",
        "5",
        "--budget",
        "0.01",
        "--pricing-version",
        "fixture-2026-07",
        "--pricing-effective-at",
        "2026-07-27T00:00:00Z",
        "--input-per-million",
        "1",
        "--output-per-million",
        "1",
        "--max-cost-per-call",
        "0.002",
        "--concurrency",
        "1",
        "--output-dir",
        outputDirectory,
        "--run-id",
        "live_duplicate_candidate_evidence_001",
      ], {
        ...process.env,
        NODE_ENV: "test",
        ZHAOJIAN_ENABLE_TRAINING_FIXTURE: "1",
      });

      expect(result.status, result.stderr).toBe(0);
      const artifact = readJson(resolve(
        outputDirectory,
        "live_duplicate_candidate_evidence_001",
        "artifacts",
        "photo-v1-landscape-001.json",
      ));
      const candidates = artifact.skill_improvement_candidates as JsonObject[];
      expect(candidates).toHaveLength(2);
      expect(candidates.map((candidate) => candidate.summary)).not.toContain(
        "Fixture 使用同一证据形成第二个关系校验候选。",
      );
      const flattenedKeys = candidates.flatMap((candidate) =>
        (candidate.evidence_ids as string[]).map(
          (evidenceId) => `${candidate.skill_id}:${candidate.artifact_type}:${evidenceId}`,
        ));
      expect(new Set(flattenedKeys).size).toBe(flattenedKeys.length);
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  });

  it("角色门禁失败保留实际用量并区别于不确定调用", () => {
    const outputDirectory = mkdtempSync(resolve(tmpdir(), "zhaojian-trainer-"));
    try {
      const result = runTrainer([
        "run",
        "--mode",
        "live",
        "--allow-network",
        "--provider",
        "test-fixture",
        "--model",
        "training-fixture-known-failure-v1",
        "--asset-ids",
        "photo-v1-landscape-001",
        "--max-attempts",
        "1",
        "--max-provider-calls",
        "5",
        "--budget",
        "0.02",
        "--pricing-version",
        "fixture-2026-07",
        "--pricing-effective-at",
        "2026-07-27T00:00:00Z",
        "--input-per-million",
        "1",
        "--output-per-million",
        "1",
        "--max-cost-per-call",
        "0.01",
        "--concurrency",
        "1",
        "--output-dir",
        outputDirectory,
        "--run-id",
        "live_known_failure_fixture_001",
      ], {
        ...process.env,
        NODE_ENV: "test",
        ZHAOJIAN_ENABLE_TRAINING_FIXTURE: "1",
      });

      expect(result.status, result.stderr).toBe(0);
      const run = readJson(resolve(outputDirectory, "live_known_failure_fixture_001", "run.json"));
      expect(run.budget).toMatchObject({
        estimated_spend: 0.002,
        provider_calls: 1,
        uncertain_calls: 0,
      });
      expect(run.call_records).toMatchObject([{
        status: "failed",
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 1000,
          calls: 1,
          estimated_cost: 0.002,
        },
        error: {
          code: "TRAINING_PROVIDER_INVALID_OUTPUT",
        },
      }]);
      const report = readJson(resolve(outputDirectory, "live_known_failure_fixture_001", "report.json"));
      expect(report.telemetry).toMatchObject({
        provider_calls: 1,
        successful_calls: 0,
        failed_calls: 1,
        uncertain_calls: 0,
        estimated_cost: 0.002,
      });
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  });

  it("fail-fast 在首个样例重试耗尽后停止后续 Provider 调用", () => {
    const outputDirectory = mkdtempSync(resolve(tmpdir(), "zhaojian-trainer-"));
    try {
      const result = runTrainer([
        "run",
        "--mode",
        "live",
        "--allow-network",
        "--provider",
        "test-fixture",
        "--model",
        "training-fixture-known-failure-v1",
        "--asset-ids",
        "photo-v1-landscape-001,photo-v1-landscape-002",
        "--max-attempts",
        "1",
        "--fail-fast",
        "--max-provider-calls",
        "10",
        "--budget",
        "0.03",
        "--pricing-version",
        "fixture-2026-07",
        "--pricing-effective-at",
        "2026-07-27T00:00:00Z",
        "--input-per-million",
        "1",
        "--output-per-million",
        "1",
        "--max-cost-per-call",
        "0.01",
        "--concurrency",
        "1",
        "--output-dir",
        outputDirectory,
        "--run-id",
        "live_fail_fast_fixture_001",
      ], {
        ...process.env,
        NODE_ENV: "test",
        ZHAOJIAN_ENABLE_TRAINING_FIXTURE: "1",
      });

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).status).toBe("item_failure");
      const run = readJson(resolve(outputDirectory, "live_fail_fast_fixture_001", "run.json"));
      expect(run.stop_reason).toBe("item_failure");
      expect(run.configuration).toMatchObject({ fail_fast: true, concurrency: 1 });
      expect(run.call_records).toHaveLength(1);
      const report = readJson(resolve(outputDirectory, "live_fail_fast_fixture_001", "report.json"));
      expect(report).toMatchObject({
        status: "rejected",
        validation_status: "needs_review",
        counts: {
          total: 2,
          completed: 0,
          quarantined: 0,
          failed: 1,
          cancelled: 1,
        },
        budget: {
          stopped_new_work: true,
          stop_reason: "item_failure",
          provider_calls: 1,
        },
      });
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  });

  it("Provider 调用上限在下一次派发前停止小样本运行", () => {
    const outputDirectory = mkdtempSync(resolve(tmpdir(), "zhaojian-trainer-"));
    try {
      const result = runTrainer([
        "run",
        "--mode",
        "live",
        "--allow-network",
        "--provider",
        "test-fixture",
        "--model",
        "fixture-live-v1",
        "--asset-ids",
        "photo-v1-landscape-001,photo-v1-portrait-007",
        "--max-provider-calls",
        "3",
        "--budget",
        "0.02",
        "--pricing-version",
        "fixture-2026-07",
        "--pricing-effective-at",
        "2026-07-27T00:00:00Z",
        "--input-per-million",
        "1",
        "--output-per-million",
        "1",
        "--max-cost-per-call",
        "0.002",
        "--concurrency",
        "1",
        "--output-dir",
        outputDirectory,
        "--run-id",
        "live_call_limit_fixture_001",
      ], {
        ...process.env,
        NODE_ENV: "test",
        ZHAOJIAN_ENABLE_TRAINING_FIXTURE: "1",
      });

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).status).toBe("provider_call_limit_reached");
      const report = readJson(resolve(outputDirectory, "live_call_limit_fixture_001", "report.json"));
      expect(report.status).toBe("rejected");
      expect(report.counts).toEqual({
        total: 2,
        completed: 0,
        quarantined: 0,
        failed: 0,
        cancelled: 2,
      });
      expect(report.telemetry).toMatchObject({
        provider_calls: 3,
        successful_calls: 3,
        failed_calls: 0,
        uncertain_calls: 0,
      });
      expect(report.budget).toMatchObject({
        stopped_new_work: true,
        stop_reason: "provider_call_limit_reached",
      });
      expect((report.failures as JsonObject[]).every((failure) =>
        failure.failure_code === "TRAINING_PROVIDER_CALL_LIMIT_REACHED"
        && failure.retryable === false)).toBe(true);
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  });

  it("在创建运行前拒绝未知或重复的小样本资产", () => {
    const outputDirectory = mkdtempSync(resolve(tmpdir(), "zhaojian-trainer-"));
    try {
      const unknown = runTrainer([
        "run",
        "--mode",
        "mock",
        "--asset-ids",
        "photo-v1-not-found-001",
        "--output-dir",
        outputDirectory,
        "--run-id",
        "unknown_selection_001",
      ]);
      expect(unknown.status).not.toBe(0);
      expect(unknown.stderr).toContain("不在正式清单中的资产");
      expect(existsSync(resolve(outputDirectory, "unknown_selection_001"))).toBe(false);

      const duplicate = runTrainer([
        "run",
        "--mode",
        "mock",
        "--asset-ids",
        "photo-v1-landscape-001,photo-v1-landscape-001",
        "--output-dir",
        outputDirectory,
        "--run-id",
        "duplicate_selection_001",
      ]);
      expect(duplicate.status).not.toBe(0);
      expect(duplicate.stderr).toContain("--asset-ids存在重复项");
      expect(existsSync(resolve(outputDirectory, "duplicate_selection_001"))).toBe(false);
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  });

  it("本地 Live Fixture 按调用租约耗尽预算并保留结构化输出与报告", () => {
    const outputDirectory = mkdtempSync(resolve(tmpdir(), "zhaojian-trainer-"));
    try {
      const result = runTrainer([
        "run",
        "--mode",
        "live",
        "--allow-network",
        "--provider",
        "test-fixture",
        "--model",
        "fixture-live-v1",
        "--budget",
        "0.006",
        "--pricing-version",
        "fixture-2026-07",
        "--pricing-effective-at",
        "2026-07-27T00:00:00Z",
        "--input-per-million",
        "1",
        "--output-per-million",
        "1",
        "--max-cost-per-call",
        "0.002",
        "--max-provider-calls",
        "300",
        "--concurrency",
        "1",
        "--output-dir",
        outputDirectory,
        "--run-id",
        "live_budget_fixture_001",
      ], {
        ...process.env,
        NODE_ENV: "test",
        ZHAOJIAN_ENABLE_TRAINING_FIXTURE: "1",
      });

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).status).toBe("budget_exhausted");
      const run = readJson(resolve(outputDirectory, "live_budget_fixture_001", "run.json"));
      expect(run.status).toBe("rejected");
      expect(run.stop_reason).toBe("budget_exhausted");
      expect(run.budget).toMatchObject({
        limit: 0.006,
        reserved: 0,
        reserved_calls: 0,
        estimated_spend: 0.006,
        provider_calls: 3,
        uncertain_calls: 0,
      });
      const firstItem = (run.items as JsonObject[])[0];
      expect(firstItem.attempts).toEqual({
        observer: 1,
        direction_generator: 1,
        critic: 1,
        red_team: 0,
        curator: 0,
      });
      const report = readJson(resolve(outputDirectory, "live_budget_fixture_001", "report.json"));
      expect(report.status).toBe("rejected");
      expect(report.counts).toEqual({
        total: 60,
        completed: 0,
        quarantined: 0,
        failed: 0,
        cancelled: 60,
      });
      expect(report.budget).toMatchObject({
        estimated_spend: 0.006,
        provider_calls: 3,
        stopped_new_work: true,
        stop_reason: "budget_exhausted",
      });
      const observerOutput = readJson(resolve(
        outputDirectory,
        "live_budget_fixture_001",
        "role-outputs",
        "photo-v1-landscape-001",
        "observer.json",
      ));
      expect(observerOutput.role).toBe("observer");
      expect(observerOutput.content_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
      assertWhitelisted(observerOutput);
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  });

  it("恢复时把中断中的费用租约保守结算为不确定调用", () => {
    const outputDirectory = mkdtempSync(resolve(tmpdir(), "zhaojian-trainer-"));
    const environment = {
      ...process.env,
      NODE_ENV: "test",
      ZHAOJIAN_ENABLE_TRAINING_FIXTURE: "1",
    };
    const commonArguments = [
      "run",
      "--mode",
      "live",
      "--allow-network",
      "--provider",
      "test-fixture",
      "--model",
      "fixture-live-v1",
      "--budget",
      "0.01",
      "--pricing-version",
      "fixture-2026-07",
      "--pricing-effective-at",
      "2026-07-27T00:00:00Z",
      "--input-per-million",
      "1",
      "--output-per-million",
      "1",
      "--max-cost-per-call",
      "0.002",
      "--max-provider-calls",
      "300",
      "--concurrency",
      "1",
      "--output-dir",
      outputDirectory,
      "--run-id",
      "live_lease_resume_001",
    ];
    try {
      const interrupted = runTrainer([
        ...commonArguments,
        "--interrupt-after",
        "1",
      ], environment);
      expect(interrupted.status, interrupted.stderr).toBe(0);
      expect(JSON.parse(interrupted.stdout).status).toBe("interrupted");

      const runPath = resolve(outputDirectory, "live_lease_resume_001", "run.json");
      const checkpoint = readJson(runPath);
      const budget = checkpoint.budget as JsonObject;
      budget.reserved = 0.002;
      budget.reserved_calls = 1;
      refreshContentHash(checkpoint);
      writeFileSync(runPath, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");

      const resumed = runTrainer(commonArguments, environment);
      expect(resumed.status, resumed.stderr).toBe(0);
      expect(JSON.parse(resumed.stdout).status).toBe("budget_exhausted");
      const report = readJson(resolve(outputDirectory, "live_lease_resume_001", "report.json"));
      expect(report.budget).toMatchObject({
        estimated_spend: 0.01,
        provider_calls: 5,
        uncertain_calls: 1,
        stopped_new_work: true,
      });
      const finalRun = readJson(runPath);
      expect(finalRun.budget).toMatchObject({
        reserved: 0,
        reserved_calls: 0,
        uncertain_calls: 1,
      });
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  });

  it("拒绝通过符号链接把运行写到输出目录之外", () => {
    const outputDirectory = mkdtempSync(resolve(tmpdir(), "zhaojian-trainer-"));
    const externalDirectory = mkdtempSync(resolve(tmpdir(), "zhaojian-trainer-outside-"));
    try {
      symlinkSync(externalDirectory, resolve(outputDirectory, "linked_run_001"), "dir");
      const result = runTrainer([
        "run",
        "--mode",
        "mock",
        "--output-dir",
        outputDirectory,
        "--run-id",
        "linked_run_001",
      ]);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("训练运行目录不能是符号链接");
      expect(existsSync(resolve(externalDirectory, "run.json"))).toBe(false);
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true });
      rmSync(externalDirectory, { recursive: true, force: true });
    }
  });

  it("拒绝第二个进程并发执行同一 run_id", () => {
    const outputDirectory = mkdtempSync(resolve(tmpdir(), "zhaojian-trainer-"));
    const runDirectory = resolve(outputDirectory, "active_lock_001");
    try {
      mkdirSync(runDirectory, { recursive: true });
      writeFileSync(
        resolve(runDirectory, ".trainer.lock"),
        `${JSON.stringify({ pid: process.pid, token: "active-test-token" })}\n`,
        "utf8",
      );
      const result = runTrainer([
        "run",
        "--mode",
        "mock",
        "--output-dir",
        outputDirectory,
        "--run-id",
        "active_lock_001",
      ]);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("同一 run_id 已有活动训练进程");
      expect(existsSync(resolve(runDirectory, "run.json"))).toBe(false);
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  });

  it("活动运行的取消命令只写请求，不并发覆盖检查点", () => {
    const outputDirectory = mkdtempSync(resolve(tmpdir(), "zhaojian-trainer-"));
    try {
      const interrupted = runTrainer([
        "run",
        "--mode",
        "mock",
        "--output-dir",
        outputDirectory,
        "--run-id",
        "active_cancel_001",
        "--concurrency",
        "1",
        "--interrupt-after",
        "1",
      ]);
      expect(interrupted.status, interrupted.stderr).toBe(0);
      const runDirectory = resolve(outputDirectory, "active_cancel_001");
      const before = readJson(resolve(runDirectory, "run.json")).content_hash;
      writeFileSync(
        resolve(runDirectory, ".trainer.lock"),
        `${JSON.stringify({ pid: process.pid, token: "active-cancel-token" })}\n`,
        "utf8",
      );

      const cancellation = runTrainer([
        "cancel",
        "--output-dir",
        outputDirectory,
        "--run-id",
        "active_cancel_001",
      ]);

      expect(cancellation.status, cancellation.stderr).toBe(0);
      expect(JSON.parse(cancellation.stdout)).toMatchObject({
        status: "cancellation_requested",
        active: true,
      });
      expect(existsSync(resolve(runDirectory, ".cancel-requested"))).toBe(true);
      expect(readJson(resolve(runDirectory, "run.json")).content_hash).toBe(before);
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  });

  it("即使重算内容哈希也拒绝不一致的业务计数", () => {
    const outputDirectory = mkdtempSync(resolve(tmpdir(), "zhaojian-trainer-"));
    try {
      const interrupted = runTrainer([
        "run",
        "--mode",
        "mock",
        "--output-dir",
        outputDirectory,
        "--run-id",
        "tampered_counts_001",
        "--concurrency",
        "1",
        "--interrupt-after",
        "2",
      ]);
      expect(interrupted.status, interrupted.stderr).toBe(0);

      const runPath = resolve(outputDirectory, "tampered_counts_001", "run.json");
      const run = readJson(runPath);
      (run.counts as JsonObject).terminal = 1;
      refreshContentHash(run);
      writeFileSync(runPath, `${JSON.stringify(run, null, 2)}\n`, "utf8");

      const resumed = runTrainer([
        "run",
        "--mode",
        "mock",
        "--output-dir",
        outputDirectory,
        "--run-id",
        "tampered_counts_001",
      ]);
      expect(resumed.status).not.toBe(0);
      expect(resumed.stderr).toContain("terminal 计数不一致");
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  });
});
