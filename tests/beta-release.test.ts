import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { afterEach, describe, expect, it } from "vitest";

type JsonObject = Record<string, any>;

const scriptPath = resolve("scripts/beta-release.mjs");
const outputBase = resolve(".local/beta-release");
const liveOutputBase = resolve(".local/beta-fixtures/skill-training");
const manifest = JSON.parse(readFileSync(resolve("datasets/photography-skill-v3/manifest.json"), "utf8"));
const liveCampaign = JSON.parse(readFileSync(resolve("config/skill-live-evaluation-campaign.json"), "utf8"));
const full60Stage = liveCampaign.stages.find((stage: JsonObject) => stage.stage_id === "full60");
const createdDirectories: string[] = [];

afterEach(() => {
  for (const directory of createdDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Beta 发布证据控制面", () => {
  it("缺少 60 图真实报告时保持阻断，但允许准备离线证据", () => {
    const outputDirectory = prepareOutput();
    seedOfflineResults(outputDirectory);

    const result = runReport(outputDirectory, ["--allow-pending-live", "--live-status", "not_authorized"]);

    expect(result.status, result.stderr).toBe(0);
    const evidence = readEvidence(outputDirectory);
    expect(evidence.status).toBe("blocked");
    expect(evidence.real_model_evaluation.status).toBe("not_authorized");
    expect(evidence.gates).toContainEqual(expect.objectContaining({
      id: "real_model_full60",
      status: "blocked",
    }));
    expectSchema(evidence);
  });

  it("拒绝用 3 图烟测冒充 60 图真实评测", () => {
    const outputDirectory = prepareOutput();
    seedOfflineResults(outputDirectory);
    const liveReportPath = writeLiveReport(liveReport(3));

    const result = runReport(outputDirectory, ["--allow-pending-live", "--live-report", liveReportPath]);

    expect(result.status, result.stderr).toBe(0);
    const evidence = readEvidence(outputDirectory);
    expect(evidence.status).toBe("blocked");
    expect(evidence.real_model_evaluation.status).toBe("failed");
    expect(evidence.real_model_evaluation.selected_asset_count).toBe(3);
    expectSchema(evidence);
  });

  it("拒绝未绑定冻结 full60 路径的自洽 60 图报告", () => {
    const outputDirectory = prepareOutput();
    seedOfflineResults(outputDirectory);
    const wrongRunId = "run_live_other_full60_v2_20260729_001";
    const report = liveReport(60);
    report.run_id = wrongRunId;
    const liveReportPath = writeLiveReport(report, wrongRunId);

    const result = runReport(outputDirectory, [
      "--allow-pending-live",
      "--live-report",
      liveReportPath,
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("必须绑定冻结 full60 路径");
  });

  it("只有 60 图、九维门禁与可追溯用量全部通过时才标记 ready", () => {
    const outputDirectory = prepareOutput();
    seedOfflineResults(outputDirectory);
    const liveReportPath = writeLiveReport(liveReport(60));

    const result = runReport(outputDirectory, ["--live-report", liveReportPath]);

    expect(result.status, result.stderr).toBe(0);
    const evidence = readEvidence(outputDirectory);
    expect(evidence.status).toBe("ready");
    expect(evidence.real_model_evaluation).toMatchObject({
      status: "passed",
      selected_asset_count: 60,
      provider_calls: 300,
      successful_calls: 300,
      failed_calls: 0,
      repaired_calls: 0,
      unresolved_failed_calls: 0,
      uncertain_calls: 0,
      recovered_uncertain_calls: 0,
      unresolved_uncertain_calls: 0,
      metric_count: 9,
      metrics_passed: true,
    });
    expect(evidence.content_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expectSchema(evidence);
  });

  it("允许少量可追溯且已闭合的受控修复调用", () => {
    const outputDirectory = prepareOutput();
    seedOfflineResults(outputDirectory);
    const liveReportPath = writeLiveReport(liveReport(60, 1));

    const result = runReport(outputDirectory, ["--live-report", liveReportPath]);

    expect(result.status, result.stderr).toBe(0);
    const evidence = readEvidence(outputDirectory);
    expect(evidence.status).toBe("ready");
    expect(evidence.real_model_evaluation).toMatchObject({
      provider_calls: 301,
      successful_calls: 300,
      failed_calls: 1,
      repaired_calls: 1,
      unresolved_failed_calls: 0,
      uncertain_calls: 0,
    });
    expectSchema(evidence);
  });

  it("允许一个已保守计费且被下一次成功调用闭合的不确定调用", () => {
    const outputDirectory = prepareOutput();
    seedOfflineResults(outputDirectory);
    const liveReportPath = writeLiveReport(liveReport(60, 0, 1));

    const result = runReport(outputDirectory, ["--live-report", liveReportPath]);

    expect(result.status, result.stderr).toBe(0);
    const evidence = readEvidence(outputDirectory);
    expect(evidence.status).toBe("ready");
    expect(evidence.real_model_evaluation).toMatchObject({
      provider_calls: 301,
      successful_calls: 300,
      failed_calls: 0,
      uncertain_calls: 1,
      recovered_uncertain_calls: 1,
      unresolved_uncertain_calls: 0,
    });
    expectSchema(evidence);
  });

  it("拒绝用重复失败 attempt 让一次成功调用伪装成多次修复", () => {
    const outputDirectory = prepareOutput();
    seedOfflineResults(outputDirectory);
    const liveReportPath = writeLiveReport(liveReport(60, 1));
    const runPath = resolve(liveReportPath, "..", "run.json");
    const run = JSON.parse(readFileSync(runPath, "utf8"));
    const failedRecord = (run.call_records as JsonObject[]).find((record) => record.status === "failed");
    run.call_records.unshift(structuredClone(failedRecord));
    run.budget.provider_calls += 1;
    run.content_hash = contentHash(run);
    const report = JSON.parse(readFileSync(liveReportPath, "utf8"));
    report.telemetry.failed_calls += 1;
    report.telemetry.provider_calls += 1;
    report.budget.provider_calls += 1;
    const curator = (report.role_runs as JsonObject[]).find((roleRun) => roleRun.role === "curator");
    curator.failed_calls += 1;
    curator.provider_calls += 1;
    curator.attempts += 1;
    report.checkpoint.run_content_hash = run.content_hash;
    report.content_hash = contentHash(report);
    writeFileSync(runPath, `${JSON.stringify(run, null, 2)}\n`);
    writeFileSync(liveReportPath, `${JSON.stringify(report, null, 2)}\n`);

    const result = runReport(outputDirectory, [
      "--allow-pending-live",
      "--live-report",
      liveReportPath,
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(readEvidence(outputDirectory).real_model_evaluation).toMatchObject({
      status: "failed",
      unresolved_failed_calls: 2,
    });
  });

  it("离线命令集合缺项时保持阻断", () => {
    const outputDirectory = prepareOutput();
    seedOfflineResults(outputDirectory);
    mutateResults(outputDirectory, (results) => {
      results.commands = results.commands.filter((command: JsonObject) => command.id !== "fixed_evaluation");
    });

    const result = runReport(outputDirectory, ["--allow-pending-live"]);

    expect(result.status, result.stderr).toBe(0);
    expect(readEvidence(outputDirectory).gates).toContainEqual(expect.objectContaining({
      id: "offline_engineering",
      status: "blocked",
    }));
  });

  it("缺少 Mock 60 图制品时保持阻断", () => {
    const outputDirectory = prepareOutput();
    seedOfflineResults(outputDirectory);
    mutateResults(outputDirectory, (results) => {
      results.artifacts = results.artifacts.filter((artifact: JsonObject) => artifact.id !== "mock_full60_report");
    });

    const result = runReport(outputDirectory, ["--allow-pending-live"]);

    expect(result.status, result.stderr).toBe(0);
    expect(readEvidence(outputDirectory).gates).toContainEqual(expect.objectContaining({
      id: "offline_engineering",
      status: "blocked",
    }));
  });

  it("拒绝数量正确但不属于冻结清单的 60 个资产 ID", () => {
    const outputDirectory = prepareOutput();
    seedOfflineResults(outputDirectory);
    const report = liveReport(60);
    report.selection.asset_ids = Array.from({ length: 60 }, (_, index) => `fake-photo-${index + 1}`);
    report.selection.content_hash = contentHash(report.selection);
    report.run_configuration.selection_hash = report.selection.content_hash;
    report.content_hash = contentHash(report);
    const liveReportPath = writeLiveReport(report);

    const result = runReport(outputDirectory, ["--allow-pending-live", "--live-report", liveReportPath]);

    expect(result.status, result.stderr).toBe(0);
    expect(readEvidence(outputDirectory).real_model_evaluation.status).toBe("failed");
  });

  it("角色配置与运行配置不一致时拒绝通过", () => {
    const outputDirectory = prepareOutput();
    seedOfflineResults(outputDirectory);
    const report = liveReport(60);
    report.role_runs[2].model = "untracked-model";
    report.content_hash = contentHash(report);
    const liveReportPath = writeLiveReport(report);

    const result = runReport(outputDirectory, ["--allow-pending-live", "--live-report", liveReportPath]);

    expect(result.status, result.stderr).toBe(0);
    expect(readEvidence(outputDirectory).real_model_evaluation.status).toBe("failed");
  });

  it("拒绝读取训练目录之外的真实报告", () => {
    const outputDirectory = prepareOutput();
    seedOfflineResults(outputDirectory);
    const outsidePath = resolve(outputDirectory, "outside-report.json");
    writeFileSync(outsidePath, `${JSON.stringify(liveReport(60), null, 2)}\n`);

    const result = runReport(outputDirectory, ["--allow-pending-live", "--live-report", outsidePath]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("必须绑定冻结 full60 路径");
  });
});

function prepareOutput() {
  mkdirSync(outputBase, { recursive: true });
  const directory = mkdtempSync(resolve(outputBase, "test-"));
  createdDirectories.push(directory);
  return directory;
}

function seedOfflineResults(outputDirectory: string) {
  const currentSourceContentHash = sourceContentHash();
  const bundlePath = resolve(outputDirectory, "zhaojian-1.0.0-beta.1.tar.gz");
  const bundleRoot = resolve(outputDirectory, "bundle-fixture");
  for (const directory of ["api", "web", "release-notes"]) {
    mkdirSync(resolve(bundleRoot, directory), { recursive: true });
  }
  writeFileSync(resolve(bundleRoot, "VERSION"), "1.0.0-beta.1\n");
  writeFileSync(resolve(bundleRoot, "SOURCE_CONTENT_HASH"), `${currentSourceContentHash}\n`);
  writeFileSync(resolve(bundleRoot, "api/Zhaojian.Api.dll"), "fixture api");
  writeFileSync(resolve(bundleRoot, "web/index.html"), "<!doctype html>");
  for (const fileName of [
    "beta-1.0.0-beta.1-known-limitations.md",
    "beta-browser-smoke-record.md",
    "beta-release-evidence.md",
  ]) {
    writeFileSync(resolve(bundleRoot, "release-notes", fileName), "fixture release note");
  }
  const tar = spawnSync("tar", ["-czf", bundlePath, "-C", bundleRoot, "."], { encoding: "utf8" });
  expect(tar.status, tar.stderr).toBe(0);
  const mockReportPath = resolve(outputDirectory, "mock-training/report.json");
  mkdirSync(resolve(outputDirectory, "mock-training"), { recursive: true });
  writeFileSync(mockReportPath, "{\"status\":\"completed\"}\n");
  const ids = [
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
  const commands = ids.map((id) => ({
    id,
    command: `fixture-command ${id}`,
    status: "passed",
    exit_code: 0,
    duration_ms: 1,
    log_path: `.local/beta-release/test/logs/${id}.log`,
  }));
  for (const command of commands) {
    const logPath = resolve(outputDirectory, "logs", `${command.id}.log`);
    mkdirSync(resolve(outputDirectory, "logs"), { recursive: true });
    writeFileSync(logPath, `$ ${command.command}\n`);
    command.log_path = logPath;
  }
  const bundleBytes = readFileSync(bundlePath);
  const mockReportBytes = readFileSync(mockReportPath);
  const results = {
    source_content_hash: currentSourceContentHash,
    commands,
    artifacts: [
      {
        id: "release_bundle",
        path: bundlePath,
        sha256: `sha256:${createHash("sha256").update(bundleBytes).digest("hex")}`,
        bytes: bundleBytes.length,
      },
      {
        id: "mock_full60_report",
        path: mockReportPath,
        sha256: `sha256:${createHash("sha256").update(mockReportBytes).digest("hex")}`,
        bytes: mockReportBytes.length,
      },
    ],
  };
  writeFileSync(resolve(outputDirectory, "command-results.json"), `${JSON.stringify(results, null, 2)}\n`);
}

function mutateResults(outputDirectory: string, mutation: (results: JsonObject) => void) {
  const resultsPath = resolve(outputDirectory, "command-results.json");
  const results = JSON.parse(readFileSync(resultsPath, "utf8"));
  mutation(results);
  writeFileSync(resultsPath, `${JSON.stringify(results, null, 2)}\n`);
}

function writeLiveReport(report: JsonObject, directoryRunId = full60Stage.run_id) {
  mkdirSync(liveOutputBase, { recursive: true });
  const directory = resolve(liveOutputBase, directoryRunId);
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  createdDirectories.push(directory);
  const roles = ["observer", "direction_generator", "critic", "red_team", "curator"];
  const repairedCalls = Number(report.telemetry.failed_calls);
  const uncertainCalls = Number(report.telemetry.uncertain_calls);
  const repairKeys = new Set(
    report.selection.asset_ids.slice(0, repairedCalls).map((assetId: string) => `${assetId}:curator`),
  );
  const uncertainKeys = new Set(
    report.selection.asset_ids
      .slice(repairedCalls, repairedCalls + uncertainCalls)
      .map((assetId: string) => `${assetId}:curator`),
  );
  const callRecords = report.selection.asset_ids.flatMap((assetId: string) =>
    roles.flatMap((role) => {
      const key = `${assetId}:${role}`;
      const retried = repairKeys.has(key) || uncertainKeys.has(key);
      const successful = {
        asset_id: assetId,
        role,
        attempt: retried ? 2 : 1,
        status: "successful",
        error: null,
      };
      return retried
        ? [{
            asset_id: assetId,
            role,
            attempt: 1,
            status: repairKeys.has(key) ? "failed" : "uncertain",
            error: {
              code: repairKeys.has(key)
                ? "TRAINING_PROVIDER_INVALID_OUTPUT"
                : "TRAINING_PROVIDER_UPSTREAM_ERROR",
              retryable: true,
            },
          }, successful]
        : [successful];
    }));
  callRecords.forEach((record: JsonObject, index: number) => {
    record.call_id = `call_fixture_${String(index + 1).padStart(4, "0")}`;
    record.started_at = "2026-07-28T00:00:00Z";
    record.completed_at = "2026-07-28T00:00:01Z";
    record.latency_ms = index === 0 ? report.telemetry.total_latency_ms : 0;
    record.usage = {
      prompt_tokens: index === 0 ? report.telemetry.prompt_tokens : 0,
      completion_tokens: index === 0 ? report.telemetry.completion_tokens : 0,
      calls: 1,
      estimated_cost: index === 0 ? report.telemetry.estimated_cost : 0,
    };
  });
  const fullRunConfiguration: JsonObject = {
    ...report.run_configuration,
    budget_limit: full60Stage.budget_limit_cny,
    currency: "CNY",
    pricing_version: liveCampaign.pricing.version,
    pricing_effective_at: liveCampaign.pricing.effective_at,
    input_per_million_cny: liveCampaign.pricing.input_per_million_cny,
    output_per_million_cny: liveCampaign.pricing.output_per_million_cny,
    max_cost_per_call: liveCampaign.pricing.max_cost_per_call_cny,
    base_url: liveCampaign.provider.base_url,
  };
  delete fullRunConfiguration.config_hash;
  fullRunConfiguration.config_hash = canonicalHash(fullRunConfiguration);
  report.run_configuration.config_hash = fullRunConfiguration.config_hash;
  const run: JsonObject = {
    schema_version: "1.1",
    run_id: report.run_id,
    mode: "live",
    status: "completed",
    dataset: report.dataset,
    selection: report.selection,
    skills: report.skills,
    configuration: fullRunConfiguration,
    budget: {
      provider_calls: report.telemetry.provider_calls,
      uncertain_calls: report.telemetry.uncertain_calls,
      estimated_spend: report.telemetry.estimated_cost,
      reserved: 0,
      reserved_calls: 0,
    },
    call_records: callRecords,
    content_hash: "sha256:pending",
  };
  run.content_hash = contentHash(run);
  report.checkpoint = {
    run_content_hash: run.content_hash,
    artifact_count: report.selection.selected_asset_count,
    comparable_run_key: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  };
  report.content_hash = contentHash(report);
  writeFileSync(resolve(directory, "run.json"), `${JSON.stringify(run, null, 2)}\n`);
  const reportPath = resolve(directory, "report.json");
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return reportPath;
}

function runReport(outputDirectory: string, args: string[]) {
  return spawnSync(
    process.execPath,
    [scriptPath, "report", "--output-dir", outputDirectory, ...args],
    {
      cwd: resolve("."),
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "test",
        ZHAOJIAN_ENABLE_BETA_FIXTURE: "1",
        ZHAOJIAN_BETA_LIVE_ROOT: ".local/beta-fixtures/skill-training",
      },
    },
  );
}

function readEvidence(outputDirectory: string): JsonObject {
  return JSON.parse(readFileSync(resolve(outputDirectory, "evidence.json"), "utf8"));
}

function expectSchema(evidence: JsonObject) {
  const schema = JSON.parse(readFileSync(resolve("schemas/beta-release-evidence.schema.json"), "utf8"));
  const validate = new Ajv2020({ allErrors: true }).compile(schema);
  expect(validate(evidence), JSON.stringify(validate.errors)).toBe(true);
}

function liveReport(assetCount: number, repairedCalls = 0, uncertainCalls = 0): JsonObject {
  const successfulCalls = assetCount * 5;
  const providerCalls = successfulCalls + repairedCalls + uncertainCalls;
  const assetIds = manifest.assets.slice(0, assetCount).map((asset: JsonObject) => asset.asset_id);
  const selection: JsonObject = {
    strategy: assetCount === 60 ? "all" : "explicit_asset_ids",
    source_asset_count: 60,
    selected_asset_count: assetCount,
    asset_ids: assetIds,
    split_counts: assetCount === 60
      ? {
          training: manifest.split_counts.training,
          regression: manifest.split_counts.regression,
          holdout: manifest.split_counts.holdout,
        }
      : { training: assetCount, regression: 0, holdout: 0 },
    content_hash: "sha256:pending",
  };
  selection.content_hash = contentHash(selection);
  const runConfiguration: JsonObject = {
    mode: "live",
    provider: liveCampaign.provider.id,
    model: liveCampaign.provider.model,
    prompt_version: liveCampaign.contract.prompt_version,
    schema_version: liveCampaign.contract.schema_version,
    independence_level: "same_model_different_roles",
    selection_hash: selection.content_hash,
    max_attempts: full60Stage.max_attempts,
    timeout_ms: 120000,
    concurrency: 1,
    fail_fast: true,
    max_provider_calls: full60Stage.max_provider_calls,
    mock_scenario_version: "1.0.0",
    config_hash: "sha256:pending",
  };
  const report: JsonObject = {
    schema_version: "1.5",
    report_id: `report_live_${assetCount}`,
    run_id: full60Stage.run_id,
    status: "completed",
    dataset: {
      id: "photography-skill-v3",
      version: manifest.dataset_version,
      content_hash: manifest.content_hash,
    },
    selection,
    skills: [
      { id: "observe-scene", version: "1.0.0", content_hash: "sha256:482d2c317b756a62ca894275acf939a21cde9679e7f521b97b0a31f2804d279b" },
      { id: "composition-relations", version: "1.0.0", content_hash: "sha256:0dbd685c43742e19a0bfb365a8899847d57ab5fd11ec92d0fb3e4ca536348613" },
    ],
    run_configuration: runConfiguration,
    role_runs: ["observer", "direction_generator", "critic", "red_team", "curator"].map((role) => {
      const roleFailedCalls = role === "curator" ? repairedCalls : 0;
      const roleUncertainCalls = role === "curator" ? uncertainCalls : 0;
      return {
        role,
        provider: liveCampaign.provider.id,
        model: liveCampaign.provider.model,
        prompt_version: liveCampaign.contract.prompt_version,
        schema_version: liveCampaign.contract.schema_version,
        independence_level: "same_model_different_roles",
        attempts: assetCount + roleFailedCalls + roleUncertainCalls,
        provider_calls: assetCount + roleFailedCalls + roleUncertainCalls,
        successful_calls: assetCount,
        failed_calls: roleFailedCalls,
        uncertain_calls: roleUncertainCalls,
        status: "completed",
      };
    }),
    counts: {
      total: assetCount,
      completed: assetCount,
      quarantined: 0,
      failed: 0,
      cancelled: 0,
    },
    metrics: [
      "json_parse_rate",
      "serious_hallucination_rate",
      "intent_response_rate",
      "direction_difference_rate",
      "grounding_rate",
      "clarification_effectiveness_rate",
      "field_executability_rate",
      "gear_feasibility_rate",
      "judge_language_rate",
    ].map((dimension) => {
      const lowerIsBetter = [
        "serious_hallucination_rate",
        "judge_language_rate",
      ].includes(dimension);
      return {
        dimension,
        measured_value: lowerIsBetter ? 0 : 1,
        threshold: lowerIsBetter ? 0 : 0.9,
        unit: "ratio",
        passed: true,
      };
    }),
    telemetry: {
      provider_calls: providerCalls,
      successful_calls: successfulCalls,
      failed_calls: repairedCalls,
      uncertain_calls: uncertainCalls,
      prompt_tokens: assetCount * 10000,
      completion_tokens: assetCount * 2000,
      estimated_cost: assetCount * 0.04,
      total_latency_ms: assetCount * 30000,
      average_latency_ms: 6000,
      max_latency_ms: 15000,
    },
    budget: {
      provider_calls: providerCalls,
      uncertain_calls: uncertainCalls,
      stopped_new_work: false,
      pricing_version: liveCampaign.pricing.version,
      pricing_effective_at: liveCampaign.pricing.effective_at,
      input_per_million_cny: liveCampaign.pricing.input_per_million_cny,
      output_per_million_cny: liveCampaign.pricing.output_per_million_cny,
      estimated_spend: assetCount * 0.04,
      limit: full60Stage.budget_limit_cny,
      max_cost_per_call: liveCampaign.pricing.max_cost_per_call_cny,
    },
    validation_status: "passed",
    content_hash: "sha256:pending",
  };
  report.content_hash = contentHash(report);
  return report;
}

function contentHash(value: JsonObject) {
  const pending = structuredClone(value);
  delete pending.content_hash;
  return `sha256:${createHash("sha256").update(JSON.stringify(sortJson(pending))).digest("hex")}`;
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

function sourceContentHash() {
  const listing = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: resolve("."), encoding: "buffer" },
  );
  expect(listing.status).toBe(0);
  const files = listing.stdout.toString("utf8").split("\0").filter(Boolean).sort();
  const hasher = createHash("sha256");
  for (const file of files) {
    hasher.update(file);
    hasher.update("\0");
    hasher.update(existsSync(resolve(file)) ? readFileSync(resolve(file)) : Buffer.from("<deleted>", "utf8"));
    hasher.update("\0");
  }
  return `sha256:${hasher.digest("hex")}`;
}
