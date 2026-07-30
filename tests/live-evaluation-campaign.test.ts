import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const scriptPath = resolve("scripts/live-evaluation-campaign.mjs");
const trainerPath = resolve("scripts/skill-trainer.mjs");
const smokeRunId = "run_live_contract202_smoke1_v3_test_fixture_001";
let trainingRoot = "";
let smokeRunDirectory = "";
const temporaryDirectories: string[] = [];

beforeEach(() => {
  trainingRoot = mkdtempSync(resolve(".local", "campaign-training-test-"));
  smokeRunDirectory = resolve(trainingRoot, smokeRunId);
  temporaryDirectories.push(trainingRoot);
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("分级真实评测控制面", () => {
  it("未授权时不放行任何阶段，也不输出可执行命令", () => {
    const result = run(["plan"]);

    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.authorization).toEqual({
      required: true,
      status: "not_authorized",
      authorized_total_cny: null,
      authorization_id: null,
      authorized_at: null,
    });
    expect(output.status).toBe("authorization_required");
    expect(output.next_stage).toBeNull();
    expect(output.next_command).toBeNull();
    expect(output.stages.every(
      (stage: Record<string, unknown>) => stage.executable === false && stage.command === null,
    )).toBe(true);
    expect(JSON.stringify(output)).not.toContain("ApiKey");
    expect(output.stages.reduce(
      (sum: number, stage: Record<string, number>) => sum + stage.budget_limit_cny,
      0,
    )).toBe(7.571352);
    expect(output.stages.find((stage: Record<string, unknown>) => stage.stage_id === "full60"))
      .toMatchObject({ exposes_new_holdout: true, selected_asset_count: 60 });
  });

  it("未授权时 next 与 execute 都在联网前关闭失败", () => {
    const next = run(["next"]);
    const execute = run(["execute", "--stage", "smoke1", "--allow-network"]);

    expect(next.status).not.toBe(0);
    expect(next.stderr).toContain("尚未获得显式费用授权");
    expect(execute.status).not.toBe(0);
    expect(execute.stderr).toContain("尚未获得显式费用授权");
    expect(existsSync(smokeRunDirectory)).toBe(false);
  });

  it("拒绝前三阶段提前使用新的 v3 保留集", () => {
    const directory = mkdtempSync(resolve(".local", "campaign-plan-test-"));
    temporaryDirectories.push(directory);
    const plan = JSON.parse(readFileSync(resolve("config/skill-live-evaluation-campaign.json"), "utf8"));
    plan.stages[0].run_id = smokeRunId;
    plan.authorization = {
      required: true,
      status: "not_authorized",
      authorized_total_cny: null,
      authorization_id: null,
      authorized_at: null,
    };
    plan.stages[0].selection.asset_ids = ["photo-v3-landscape-001"];
    const planPath = resolve(directory, "campaign.json");
    writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);

    const result = run(["plan", "--plan", planPath]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("不得提前暴露新保留集");
  });

  it("拒绝训练目录之外的报告", () => {
    const result = run([
      "verify",
      "--stage",
      "smoke1",
      "--report",
      "examples/skill-training-report.example.json",
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("必须位于 .local/campaign-training-test-");
  });

  it("只接受固定 run_id、逐调用审计闭合的阶段报告", () => {
    const reportPath = createValidSmokeReport();

    const result = run([
      "verify",
      "--stage",
      "smoke1",
      "--report",
      reportPath,
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "passed",
      stage_id: "smoke1",
      run_id: smokeRunId,
      selected_asset_count: 1,
      provider_calls: 5,
      controlled_repairs: 0,
      run_audit: {
        valid: true,
      },
    });
  });

  it("拒绝重复角色、错误 run_id 和伪造通过状态的指标", () => {
    const reportPath = createValidSmokeReport();
    const original = JSON.parse(readFileSync(reportPath, "utf8"));
    const cases = [
      {
        expected: "角色运行必须恰好五项且角色唯一",
        mutate(report: Record<string, any>) {
          report.role_runs.push({
            ...structuredClone(report.role_runs[0]),
            attempts: 2,
          });
        },
      },
      {
        expected: "未绑定冻结运行 ID",
        mutate(report: Record<string, any>) {
          report.run_id = "run_live_contract2_smoke1_wrong";
        },
      },
      {
        expected: "九维门禁未全部通过",
        mutate(report: Record<string, any>) {
          const metric = report.metrics.find(
            (candidate: Record<string, unknown>) =>
              candidate.dimension === "serious_hallucination_rate",
          );
          metric.measured_value = 1;
          metric.threshold = 0;
          metric.passed = true;
        },
      },
    ];

    for (const testCase of cases) {
      const report = structuredClone(original);
      testCase.mutate(report);
      report.content_hash = contentHash(report);
      writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

      const result = run([
        "verify",
        "--stage",
        "smoke1",
        "--report",
        reportPath,
      ]);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(testCase.expected);
    }
  });

  it("授权后只从固定报告推进下一阶段，并锁定累计失败运行后的剩余额度", () => {
    createValidSmokeReport();
    const planPath = writeAuthorizedPlan();

    const result = run(["next", "--plan", planPath]);

    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output).toMatchObject({
      status: "ready_for_next_stage",
      next_stage: "smoke3",
      authorization: {
        status: "authorized",
        authorized_total_cny: 7.571352,
      },
    });
    expect(output.verified_stages).toHaveLength(1);
    expect(output.next_command).toContain("--fail-fast");
    expect(output.next_command).toContain("https://dashscope.aliyuncs.com/compatible-mode/v1");

    const noNetworkAuthorization = run([
      "execute",
      "--plan",
      planPath,
      "--stage",
      "smoke3",
    ]);
    expect(noNetworkAuthorization.status).not.toBe(0);
    expect(noNetworkAuthorization.stderr).toContain("必须再次显式传入 --allow-network");

    const underfundedPlan = JSON.parse(readFileSync(planPath, "utf8"));
    underfundedPlan.authorization.authorized_total_cny = 8.411732;
    writeFileSync(planPath, `${JSON.stringify(underfundedPlan, null, 2)}\n`);
    const rejected = run(["next", "--plan", planPath]);
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain("授权总额必须与四阶段本地预算上限之和一致");
  });
});

function run(args: string[]) {
  let effectiveArgs = args.includes("--plan")
    ? args
    : [...args, "--plan", writeFixturePlan(false)];
  if (!effectiveArgs.includes("--training-root")) {
    effectiveArgs = [...effectiveArgs, "--training-root", trainingRoot];
  }
  return spawnSync(process.execPath, [scriptPath, ...effectiveArgs], {
    cwd: resolve("."),
    encoding: "utf8",
  });
}

function createValidSmokeReport() {
  rmSync(smokeRunDirectory, { recursive: true, force: true });
  const result = spawnSync(process.execPath, [
    trainerPath,
    "run",
    "--mode",
    "live",
    "--allow-network",
    "--provider",
    "test-fixture",
    "--model",
    "fixture-live-v1",
    "--manifest",
    "datasets/photography-skill-v3/manifest.json",
    "--splits",
    "datasets/photography-skill-v3/splits.json",
    "--asset-ids",
    "photo-v1-landscape-001",
    "--run-id",
    smokeRunId,
    "--output-dir",
    trainingRoot,
    "--max-attempts",
    "2",
    "--fail-fast",
    "--timeout-ms",
    "120000",
    "--concurrency",
    "1",
    "--max-provider-calls",
    "6",
    "--budget",
    "0.65",
    "--pricing-version",
    "aliyun-cn-beijing-qwen3.7-plus-2026-05-26-observed-2026-07-27",
    "--pricing-effective-at",
    "2026-07-27T05:12:55Z",
    "--input-per-million",
    "2",
    "--output-per-million",
    "8",
    "--max-cost-per-call",
    "0.545",
  ], {
    cwd: resolve("."),
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_ENV: "test",
      ZHAOJIAN_ENABLE_TRAINING_FIXTURE: "1",
    },
  });
  expect(result.status, result.stderr).toBe(0);

  const runPath = resolve(smokeRunDirectory, "run.json");
  const reportPath = resolve(smokeRunDirectory, "report.json");
  const runDocument = JSON.parse(readFileSync(runPath, "utf8"));
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  runDocument.configuration.provider = "qwen";
  runDocument.configuration.model = "qwen3.7-plus-2026-05-26";
  runDocument.configuration.base_url =
    "https://dashscope.aliyuncs.com/compatible-mode/v1";
  runDocument.configuration.config_hash = configurationHash(runDocument.configuration);
  runDocument.content_hash = contentHash(runDocument);

  report.run_configuration.provider = "qwen";
  report.run_configuration.model = "qwen3.7-plus-2026-05-26";
  report.run_configuration.config_hash = runDocument.configuration.config_hash;
  for (const roleRun of report.role_runs) {
    roleRun.provider = "qwen";
    roleRun.model = "qwen3.7-plus-2026-05-26";
  }
  report.checkpoint.run_content_hash = runDocument.content_hash;
  report.content_hash = contentHash(report);
  writeFileSync(runPath, `${JSON.stringify(runDocument, null, 2)}\n`);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return reportPath;
}

function writeAuthorizedPlan() {
  return writeFixturePlan(true);
}

function writeFixturePlan(authorized: boolean) {
  const directory = mkdtempSync(resolve(".local", "campaign-plan-test-"));
  temporaryDirectories.push(directory);
  const plan = JSON.parse(readFileSync(resolve("config/skill-live-evaluation-campaign.json"), "utf8"));
  plan.stages[0].run_id = smokeRunId;
  plan.stages[1].run_id = "run_live_contract202_smoke3_v3_test_fixture_001";
  plan.stages[2].run_id = "run_live_contract202_development12_v3_test_fixture_001";
  plan.stages[3].run_id = "run_live_contract202_full60_v3_test_fixture_001";
  plan.authorization = authorized
    ? {
        required: true,
        status: "authorized",
        authorized_total_cny: 7.571352,
        authorization_id: "user_authorization_20260729_001",
        authorized_at: "2026-07-29T02:00:00Z",
      }
    : {
        required: true,
        status: "not_authorized",
        authorized_total_cny: null,
        authorization_id: null,
        authorized_at: null,
      };
  const planPath = resolve(directory, "campaign.json");
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  return planPath;
}

function configurationHash(configuration: Record<string, unknown>) {
  const pending = structuredClone(configuration);
  delete pending.config_hash;
  return canonicalHash(pending);
}

function contentHash(value: Record<string, unknown>) {
  const pending = structuredClone(value);
  delete pending.content_hash;
  return canonicalHash(pending);
}

function canonicalHash(value: Record<string, unknown>) {
  return `sha256:${createHash("sha256").update(JSON.stringify(sortJson(value))).digest("hex")}`;
}

function sortJson(value: any): any {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
  }
  return value;
}
