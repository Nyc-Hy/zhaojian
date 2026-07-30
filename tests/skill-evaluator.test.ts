import { createHash } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

type JsonObject = Record<string, any>;

const repositoryRoot = resolve(".");
const trainerPath = resolve("scripts/skill-trainer.mjs");
const evaluatorPath = resolve("scripts/skill-evaluator.mjs");
let fixtureRoot = "";
let baselineReportPath = "";
let candidateSkillPath = "";

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as JsonObject).sort()
        .map((key) => [key, sortJson((value as JsonObject)[key])]),
    );
  }
  return value;
}

function documentHash(value: JsonObject): string {
  const copy = structuredClone(value);
  delete copy.content_hash;
  return `sha256:${createHash("sha256").update(JSON.stringify(sortJson(copy))).digest("hex")}`;
}

function canonicalHash(value: JsonObject): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(sortJson(value))).digest("hex")}`;
}

function skillHash(definitionPath: string, definition: JsonObject): string {
  const moduleDirectory = dirname(definitionPath);
  const artifactPaths = [
    definition.artifacts.instructions_path,
    ...definition.artifacts.reference_paths,
    ...definition.artifacts.example_paths,
    ...definition.artifacts.negative_example_paths,
  ].sort();
  const copy = structuredClone(definition);
  delete copy.content_hash;
  const hash = createHash("sha256").update(JSON.stringify(sortJson(copy)));
  for (const artifactPath of artifactPaths) {
    hash.update(`\n--${artifactPath}--\n`);
    hash.update(readFileSync(resolve(moduleDirectory, artifactPath)));
  }
  return `sha256:${hash.digest("hex")}`;
}

function writeCandidateReport(name: string, mutate?: (report: JsonObject) => void): string {
  const report = JSON.parse(readFileSync(baselineReportPath, "utf8")) as JsonObject;
  const candidateSkill = JSON.parse(readFileSync(candidateSkillPath, "utf8")) as JsonObject;
  report.report_id = `report_candidate_${name}`;
  report.run_id = `run_candidate_${name}`;
  const target = report.skills.find((skill: JsonObject) => skill.id === candidateSkill.skill_id);
  target.version = candidateSkill.skill_version;
  target.content_hash = candidateSkill.content_hash;
  mutate?.(report);
  report.checkpoint.comparable_run_key = canonicalHash({
    dataset: report.dataset,
    selection: report.selection,
    skills: report.skills,
    run_configuration: report.run_configuration,
    budget_limit: report.budget.limit,
  });
  report.content_hash = documentHash(report);
  const path = resolve(fixtureRoot, `${name}.report.json`);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  return path;
}

function runEvaluator(
  candidateReport: string,
  phase: "candidate" | "shadow",
  suffix: string,
  shadowObservationId?: string,
) {
  const args = [
    evaluatorPath,
    "evaluate",
    "--phase",
    phase,
    "--baseline-report",
    baselineReportPath,
    "--candidate-report",
    candidateReport,
    "--baseline-skill",
    resolve("skill-modules/observe-scene/skill.json"),
    "--candidate-skill",
    candidateSkillPath,
      "--dataset-manifest",
      resolve("datasets/photography-skill-v3/manifest.json"),
    "--actor",
    "evaluator_test",
    "--reason",
    "验证固定报告比较与发布门禁不会跳过任何阶段。",
    "--output-dir",
    resolve(fixtureRoot, `evaluations-${suffix}`),
  ];
  if (phase === "shadow") {
    const shadowReport = JSON.parse(readFileSync(candidateReport, "utf8")) as JsonObject;
    args.push("--shadow-observation-id", shadowObservationId ?? shadowReport.run_id);
  }
  return spawnSync(process.execPath, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
}

beforeAll(() => {
  fixtureRoot = mkdtempSync(resolve(tmpdir(), "zhaojian-evaluator-"));
  const trainingOutput = resolve(fixtureRoot, "training");
  const training = spawnSync(process.execPath, [
    trainerPath,
    "run",
    "--mode",
    "mock",
    "--output-dir",
    trainingOutput,
    "--run-id",
    "evaluation_baseline_fixture",
    "--concurrency",
    "4",
  ], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  expect(training.status, training.stderr).toBe(0);
  baselineReportPath = resolve(trainingOutput, "evaluation_baseline_fixture", "report.json");

  const candidateDirectory = resolve(fixtureRoot, "observe-scene-candidate");
  cpSync(resolve("skill-modules/observe-scene"), candidateDirectory, { recursive: true });
  candidateSkillPath = resolve(candidateDirectory, "skill.json");
  const candidate = JSON.parse(readFileSync(candidateSkillPath, "utf8")) as JsonObject;
  candidate.skill_version = "1.1.0";
  candidate.status = "candidate";
  candidate.instruction_version = "1.1.0";
  candidate.content_hash = skillHash(candidateSkillPath, candidate);
  writeFileSync(candidateSkillPath, `${JSON.stringify(candidate, null, 2)}\n`);
});

afterAll(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("Skill 候选多维评测与发布凭证", () => {
  it("同一固定 60 图报告通过 candidate 与 shadow 两阶段门禁", () => {
    const candidateReport = writeCandidateReport("pass");
    const candidate = runEvaluator(candidateReport, "candidate", "candidate-pass");

    expect(candidate.status, candidate.stderr).toBe(0);
    const candidateResponse = JSON.parse(candidate.stdout) as JsonObject;
    expect(candidateResponse).toMatchObject({
      status: "passed",
      phase: "candidate",
      eligible_for_shadow: true,
      eligible_for_activation: false,
    });
    const candidateEvaluation = JSON.parse(
      readFileSync(candidateResponse.output_path, "utf8"),
    ) as JsonObject;
    expect(candidateEvaluation.metrics).toHaveLength(9);
    expect(candidateEvaluation.split_results).toEqual([
      expect.objectContaining({ split: "training", asset_count: 36, passed: true }),
      expect.objectContaining({ split: "regression", asset_count: 12, passed: true }),
      expect.objectContaining({ split: "holdout", asset_count: 12, passed: true }),
    ]);
    expect(candidateEvaluation.gates.every((gate: JsonObject) => gate.passed)).toBe(true);
    expect(candidateEvaluation.failures).toEqual([]);
    expect(candidateEvaluation.shadow_observation_id).toBeNull();

    const shadow = runEvaluator(candidateReport, "shadow", "shadow-pass");
    expect(shadow.status, shadow.stderr).toBe(0);
    const shadowResponse = JSON.parse(shadow.stdout) as JsonObject;
    expect(shadowResponse).toMatchObject({
      status: "passed",
      phase: "shadow",
      eligible_for_shadow: false,
      eligible_for_activation: true,
    });
    const shadowEvaluation = JSON.parse(
      readFileSync(shadowResponse.output_path, "utf8"),
    ) as JsonObject;
    expect(shadowEvaluation.shadow_observation_id).toBe(shadowEvaluation.source.candidate_run_id);
  });

  it("九维指标出现退化时输出阻断报告并拒绝发布资格", () => {
    const candidateReport = writeCandidateReport("regression", (report) => {
      const metric = report.metrics.find((value: JsonObject) =>
        value.dimension === "judge_language_rate");
      metric.measured_value = 0.1;
      metric.passed = false;
    });
    const result = runEvaluator(candidateReport, "candidate", "candidate-regression");

    expect(result.status, result.stderr).toBe(3);
    const response = JSON.parse(result.stdout) as JsonObject;
    expect(response).toMatchObject({
      status: "blocked",
      eligible_for_shadow: false,
      eligible_for_activation: false,
    });
    const evaluation = JSON.parse(readFileSync(response.output_path, "utf8")) as JsonObject;
    expect(evaluation.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "metric_regression" }),
    ]));
    expect(evaluation.gates).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "fixed_regression", passed: false }),
      expect.objectContaining({ code: "holdout_regression", passed: false }),
    ]));
  });

  it("shadow 观察 ID 不能脱离候选运行报告单独填写", () => {
    const candidateReport = writeCandidateReport("shadow-id");
    const result = runEvaluator(
      candidateReport,
      "shadow",
      "shadow-id-mismatch",
      "unrelated_shadow_observation",
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("必须等于候选 shadow 运行报告的 run_id");
  });
});
