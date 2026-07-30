import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

type JsonObject = Record<string, unknown>;

const scriptPath = resolve("scripts/training-history.mjs");
const trainerPath = resolve("scripts/skill-trainer.mjs");
const corpusPath = resolve("datasets/photography-skill-v1/history/failure-corpus.json");
const ledgerPath = resolve("datasets/photography-skill-v1/history/exposure-ledger.json");
const v3LedgerPath = resolve("datasets/photography-skill-v3/history/exposure-ledger.json");

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

describe("Skill 训练历史与暴露审计", () => {
  it("重放当前 249 条脱敏历史失败并核对原报告哈希", () => {
    const result = spawnSync(
      process.execPath,
      [scriptPath, "replay", "--corpus", corpusPath],
      { cwd: resolve("."), encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "passed",
      corpus_id: "photography_skill_failure_corpus_v1",
      replayed: 249,
    });
  });

  it("把方向字段的 Schema 类型失败归入角色契约而不是替用户决定", () => {
    const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as JsonObject;
    const records = corpus.records as JsonObject[];
    const record = records.find((candidate) =>
      candidate.run_id === "run_live_contract2_smoke1_v2_20260728_001"
      && candidate.role === "direction_generator");

    expect(record).toMatchObject({
      failure_code: "TRAINING_PROVIDER_INVALID_OUTPUT",
      category: "role_schema",
      repair_reason_code: "schema_invalid",
    });
  });

  it("把确定性排除和 fail-fast 停止记录归入对应白名单类别", async () => {
    const { classifyHistoricalFailure } = await import("../scripts/training-history.mjs");
    expect(classifyHistoricalFailure({
      failure_code: "deterministic_observation_exclusion",
      failure_reason: "确定性可见事实门禁排除 1 条观察候选。",
    })).toBe("observer_inference");
    expect(classifyHistoricalFailure({
      failure_code: "TRAINING_FAIL_FAST_STOPPED",
      failure_reason: "前序样例失败，当前样例停止。",
    })).toBe("training_pipeline");
  });

  it("确认旧 holdout 已全部暴露且没有剩余未见样本", () => {
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as JsonObject;
    expect(ledger.summary).toEqual({
      asset_count: 60,
      selected_exposed_count: 60,
      provider_exposed_count: 30,
      holdout_count: 12,
      holdout_exposed_count: 12,
      unseen_holdout_count: 0,
    });
    const assets = ledger.assets as JsonObject[];
    expect(assets.filter((asset) => asset.dataset_split === "holdout")).toHaveLength(12);
    expect(assets
      .filter((asset) => asset.dataset_split === "holdout")
      .every((asset) => asset.unseen_eligible === false)).toBe(true);
  });

  it("确认 v3 的 12 张轮换 holdout 已由通过的 full60 完整评测", () => {
    const ledger = JSON.parse(readFileSync(v3LedgerPath, "utf8")) as JsonObject;
    expect(ledger.summary).toEqual({
      asset_count: 60,
      selected_exposed_count: 60,
      provider_exposed_count: 60,
      holdout_count: 12,
      holdout_exposed_count: 12,
      unseen_holdout_count: 0,
    });
    const holdoutAssets = (ledger.assets as JsonObject[])
      .filter((asset) => asset.dataset_split === "holdout");
    expect(holdoutAssets).toHaveLength(12);
    expect(holdoutAssets.every((asset) => asset.unseen_eligible === false)).toBe(true);
  });

  it("即使重算语料哈希也拒绝被改写的历史分类", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "zhaojian-history-"));
    try {
      const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as JsonObject;
      const records = corpus.records as JsonObject[];
      const replacement = "历史问题已被记录，但当前白名单分类不足以进一步归因。";
      records[0].safe_summary = records[0].safe_summary === replacement
        ? "方向没有满足结构、证据引用、差异或诚实停下的契约。"
        : replacement;
      refreshContentHash(corpus);
      const tamperedPath = resolve(directory, "failure-corpus.json");
      writeFileSync(tamperedPath, `${JSON.stringify(corpus, null, 2)}\n`, "utf8");

      const result = spawnSync(
        process.execPath,
        [scriptPath, "replay", "--corpus", tamperedPath],
        { cwd: resolve("."), encoding: "utf8" },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("当前分类与历史语料不一致");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("建账前拒绝损坏哈希以及 run/report 身份、状态和配置不一致", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "zhaojian-history-input-"));
    try {
      const runsDirectory = resolve(directory, "source-runs");
      const runId = "history_validation_fixture_001";
      const generated = spawnSync(process.execPath, [
        trainerPath,
        "run",
        "--mode",
        "mock",
        "--output-dir",
        runsDirectory,
        "--run-id",
        runId,
        "--asset-ids",
        "photo-v1-landscape-001",
        "--concurrency",
        "1",
      ], { cwd: resolve("."), encoding: "utf8" });
      expect(generated.status, generated.stderr).toBe(0);
      const sourceDirectory = resolve(runsDirectory, runId);
      const originalRun = JSON.parse(readFileSync(resolve(sourceDirectory, "run.json"), "utf8")) as JsonObject;
      const originalReport = JSON.parse(readFileSync(resolve(sourceDirectory, "report.json"), "utf8")) as JsonObject;
      const cases = [
        {
          name: "hash",
          expected: "run.json 内容哈希不匹配",
          mutate(run: JsonObject) {
            run.completed_at = "2026-07-30T00:00:00Z";
          },
        },
        {
          name: "run-id",
          expected: "run/report run_id 不一致",
          mutate(_run: JsonObject, report: JsonObject) {
            report.run_id = "history_validation_fixture_other";
            refreshContentHash(report);
          },
        },
        {
          name: "status",
          expected: "run/report 状态不一致",
          mutate(_run: JsonObject, report: JsonObject) {
            report.status = "rejected";
            report.validation_status = "needs_review";
            refreshContentHash(report);
          },
        },
        {
          name: "configuration",
          expected: "配置字段 model 不一致",
          mutate(_run: JsonObject, report: JsonObject) {
            const configuration = report.run_configuration as JsonObject;
            configuration.model = "tampered-model";
            refreshContentHash(report);
          },
        },
      ];

      for (const candidate of cases) {
        const caseRoot = resolve(directory, candidate.name);
        const caseRunDirectory = resolve(caseRoot, runId);
        mkdirSync(caseRunDirectory, { recursive: true });
        const run = structuredClone(originalRun);
        const report = structuredClone(originalReport);
        candidate.mutate(run, report);
        writeFileSync(resolve(caseRunDirectory, "run.json"), `${JSON.stringify(run, null, 2)}\n`, "utf8");
        writeFileSync(resolve(caseRunDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
        const result = spawnSync(process.execPath, [
          scriptPath,
          "build",
          "--runs-dir",
          caseRoot,
          "--output-dir",
          resolve(directory, `output-${candidate.name}`),
          "--created-at",
          "2026-07-30T00:00:00Z",
        ], { cwd: resolve("."), encoding: "utf8" });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(candidate.expected);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
