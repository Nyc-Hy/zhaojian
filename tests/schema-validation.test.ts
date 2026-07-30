import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

const cases = [
  ["器材档案", "schemas/gear-profile.schema.json", "examples/gear-profile.example.json"],
  ["画面理解", "schemas/scene-understanding.schema.json", "examples/scene-understanding.example.json"],
  ["场景分析", "schemas/scene-analysis.schema.json", "examples/scene-analysis.example.json"],
  ["无可靠方向", "schemas/scene-analysis.schema.json", "examples/scene-analysis-no-options.example.json"],
  ["Mock 场景分析", "schemas/scene-analysis.schema.json", "examples/mock-scene-analysis.example.json"],
  ["Skill 定义", "schemas/skill-definition.schema.json", "examples/skill-definition.example.json"],
  ["Skill 候选评测报告", "schemas/skill-evaluation-report.schema.json", "examples/skill-evaluation-report.example.json"],
  ["Skill 注册表状态", "schemas/skill-registry-state.schema.json", "examples/skill-registry-state.example.json"],
  ["Skill 训练数据", "schemas/skill-training-dataset.schema.json", "examples/skill-training-dataset.example.json"],
  ["正式摄影训练数据", "schemas/skill-training-dataset.schema.json", "datasets/photography-skill-v1/manifest.json"],
  ["Skill 训练固定分区", "schemas/skill-training-splits.schema.json", "examples/skill-training-splits.example.json"],
  ["正式摄影训练固定分区", "schemas/skill-training-splits.schema.json", "datasets/photography-skill-v1/splits.json"],
  ["第二版摄影训练数据", "schemas/skill-training-dataset.schema.json", "datasets/photography-skill-v2/manifest.json"],
  ["第二版摄影训练固定分区", "schemas/skill-training-splits.schema.json", "datasets/photography-skill-v2/splits.json"],
  ["第三版摄影训练数据", "schemas/skill-training-dataset.schema.json", "datasets/photography-skill-v3/manifest.json"],
  ["第三版摄影训练固定分区", "schemas/skill-training-splits.schema.json", "datasets/photography-skill-v3/splits.json"],
  ["Skill 训练样例制品", "schemas/skill-training-artifact.schema.json", "examples/skill-training-artifact.example.json"],
  ["Skill 训练角色输出", "schemas/skill-training-role-output.schema.json", "examples/skill-training-role-output.example.json"],
  ["Skill 分级真实评测计划", "schemas/skill-live-evaluation-campaign.schema.json", "config/skill-live-evaluation-campaign.json"],
  ["Skill 训练历史失败语料", "schemas/skill-training-failure-corpus.schema.json", "datasets/photography-skill-v1/history/failure-corpus.json"],
  ["Skill 训练样本暴露账本", "schemas/skill-training-exposure-ledger.schema.json", "datasets/photography-skill-v1/history/exposure-ledger.json"],
  ["第三版 Skill 训练历史失败语料", "schemas/skill-training-failure-corpus.schema.json", "datasets/photography-skill-v3/history/failure-corpus.json"],
  ["第三版 Skill 训练样本暴露账本", "schemas/skill-training-exposure-ledger.schema.json", "datasets/photography-skill-v3/history/exposure-ledger.json"],
  ["Skill 训练运行", "schemas/skill-training-run.schema.json", "examples/skill-training-run.example.json"],
  ["Skill 训练报告", "schemas/skill-training-report.schema.json", "examples/skill-training-report.example.json"],
  ["Beta 发布证据", "schemas/beta-release-evidence.schema.json", "examples/beta-release-evidence.example.json"],
  ["创作意图", "schemas/creative-intent.schema.json", "examples/creative-intent.example.json"],
  ["最终照片观察草案", "schemas/final-photo-observation.schema.json", "examples/final-photo-observation.example.json"],
  ["后期思路草案", "schemas/post-process-plan.schema.json", "examples/post-process-plan.example.json"],
] as const;

const invalidCases = [
  {
    name: "Skill 分级真实评测计划拒绝没有授权证据的已授权状态",
    schemaPath: "schemas/skill-live-evaluation-campaign.schema.json",
    examplePath: "config/skill-live-evaluation-campaign.json",
    mutate: (value: Record<string, unknown>) => {
      const authorization = value.authorization as Record<string, unknown>;
      authorization.status = "authorized";
      authorization.authorized_total_cny = 9;
      authorization.authorization_id = null;
      authorization.authorized_at = null;
    },
  },
  {
    name: "Beta 发布证据拒绝审美总分字段",
    schemaPath: "schemas/beta-release-evidence.schema.json",
    examplePath: "examples/beta-release-evidence.example.json",
    mutate: (value: Record<string, unknown>) => {
      value.aesthetic_score = 100;
    },
  },
  {
    name: "Beta 发布证据必须保留固定单实例边界",
    schemaPath: "schemas/beta-release-evidence.schema.json",
    examplePath: "examples/beta-release-evidence.example.json",
    mutate: (value: Record<string, unknown>) => {
      const deployment = value.deployment as Record<string, unknown>;
      deployment.multi_instance_ready = true;
    },
  },
  {
    name: "Beta 发布证据必须保留固定命令顺序与集合",
    schemaPath: "schemas/beta-release-evidence.schema.json",
    examplePath: "examples/beta-release-evidence.example.json",
    mutate: (value: Record<string, unknown>) => {
      const commands = value.commands as Array<Record<string, unknown>>;
      commands[0].id = "offline_verify";
    },
  },
  {
    name: "Beta 发布证据不能删除必需门禁",
    schemaPath: "schemas/beta-release-evidence.schema.json",
    examplePath: "examples/beta-release-evidence.example.json",
    mutate: (value: Record<string, unknown>) => {
      const gates = value.gates as Array<Record<string, unknown>>;
      gates.splice(1, 1);
    },
  },
  {
    name: "Skill 候选评测报告拒绝审美总分字段",
    schemaPath: "schemas/skill-evaluation-report.schema.json",
    examplePath: "examples/skill-evaluation-report.example.json",
    mutate: (value: Record<string, unknown>) => {
      value.aesthetic_score = 98;
    },
  },
  {
    name: "通过的 Skill 候选评测不能保留未通过门禁",
    schemaPath: "schemas/skill-evaluation-report.schema.json",
    examplePath: "examples/skill-evaluation-report.example.json",
    mutate: (value: Record<string, unknown>) => {
      const gates = value.gates as Array<Record<string, unknown>>;
      gates[0].passed = false;
    },
  },
  {
    name: "candidate 评测不能伪造 shadow 观察 ID",
    schemaPath: "schemas/skill-evaluation-report.schema.json",
    examplePath: "examples/skill-evaluation-report.example.json",
    mutate: (value: Record<string, unknown>) => {
      value.shadow_observation_id = "shadow_observation_forged";
    },
  },
  {
    name: "Skill 候选评测必须保持冻结的 36/12/12 分区",
    schemaPath: "schemas/skill-evaluation-report.schema.json",
    examplePath: "examples/skill-evaluation-report.example.json",
    mutate: (value: Record<string, unknown>) => {
      const splits = value.split_results as Array<Record<string, unknown>>;
      splits[0].asset_count = 35;
    },
  },
  {
    name: "Skill 注册表审计必须保留 actor 与 reason",
    schemaPath: "schemas/skill-registry-state.schema.json",
    examplePath: "examples/skill-registry-state.example.json",
    mutate: (value: Record<string, unknown>) => {
      const entries = value.audit_log as Array<Record<string, unknown>>;
      delete entries[0].actor;
    },
  },
  {
    name: "Skill 定义拒绝未知字段",
    schemaPath: "schemas/skill-definition.schema.json",
    examplePath: "examples/skill-definition.example.json",
    mutate: (value: Record<string, unknown>) => {
      value.aesthetic_score = 98;
    },
  },
  {
    name: "Skill 定义拒绝无效生命周期",
    schemaPath: "schemas/skill-definition.schema.json",
    examplePath: "examples/skill-definition.example.json",
    mutate: (value: Record<string, unknown>) => {
      value.status = "published_directly";
    },
  },
  {
    name: "训练数据拒绝未知许可状态",
    schemaPath: "schemas/skill-training-dataset.schema.json",
    examplePath: "examples/skill-training-dataset.example.json",
    mutate: (value: Record<string, unknown>) => {
      const assets = value.assets as Array<Record<string, unknown>>;
      assets[0].status = "license_unknown";
    },
  },
  {
    name: "训练报告拒绝审美总分字段",
    schemaPath: "schemas/skill-training-report.schema.json",
    examplePath: "examples/skill-training-report.example.json",
    mutate: (value: Record<string, unknown>) => {
      value.aesthetic_score = 0.92;
    },
  },
  {
    name: "训练运行拒绝内部推理字段",
    schemaPath: "schemas/skill-training-run.schema.json",
    examplePath: "examples/skill-training-run.example.json",
    mutate: (value: Record<string, unknown>) => {
      value.reasoning = "不应保存的模型内部推理";
    },
  },
  {
    name: "训练报告拒绝定位字段变体",
    schemaPath: "schemas/skill-training-report.schema.json",
    examplePath: "examples/skill-training-report.example.json",
    mutate: (value: Record<string, unknown>) => {
      value.gps_coordinates = "31.2,121.5";
    },
  },
  {
    name: "1.1 训练运行拒绝缺失选择范围",
    schemaPath: "schemas/skill-training-run.schema.json",
    examplePath: "examples/skill-training-run.example.json",
    mutate: (value: Record<string, unknown>) => {
      delete value.selection;
    },
  },
  {
    name: "1.4 训练报告拒绝缺失调用遥测",
    schemaPath: "schemas/skill-training-report.schema.json",
    examplePath: "examples/skill-training-report.example.json",
    mutate: (value: Record<string, unknown>) => {
      delete value.telemetry;
    },
  },
  {
    name: "1.4 训练报告失败项必须保留失败原因",
    schemaPath: "schemas/skill-training-report.schema.json",
    examplePath: "examples/skill-training-report.example.json",
    mutate: (value: Record<string, unknown>) => {
      const failures = value.failures as Array<Record<string, unknown>>;
      delete failures[0].failure_reason;
    },
  },
  {
    name: "1.4 训练报告必须区分已知失败调用",
    schemaPath: "schemas/skill-training-report.schema.json",
    examplePath: "examples/skill-training-report.example.json",
    mutate: (value: Record<string, unknown>) => {
      const telemetry = value.telemetry as Record<string, unknown>;
      delete telemetry.failed_calls;
    },
  },
  {
    name: "1.5 训练报告必须保留完整九维指标",
    schemaPath: "schemas/skill-training-report.schema.json",
    examplePath: "examples/skill-training-report.example.json",
    mutate: (value: Record<string, unknown>) => {
      const metrics = value.metrics as Array<Record<string, unknown>>;
      metrics.pop();
    },
  },
  {
    name: "Mock 训练制品不能标记为可用于正式训练",
    schemaPath: "schemas/skill-training-artifact.schema.json",
    examplePath: "examples/skill-training-artifact.example.json",
    mutate: (value: Record<string, unknown>) => {
      value.eligible_for_training = true;
    },
  },
  {
    name: "创作意图拒绝缺失来源分析",
    schemaPath: "schemas/creative-intent.schema.json",
    examplePath: "examples/creative-intent.example.json",
    mutate: (value: Record<string, unknown>) => {
      delete value.source_analysis_id;
    },
  },
  {
    name: "最终照片观察拒绝裁判结论字段",
    schemaPath: "schemas/final-photo-observation.schema.json",
    examplePath: "examples/final-photo-observation.example.json",
    mutate: (value: Record<string, unknown>) => {
      value.best_composition = "居中构图";
    },
  },
  {
    name: "后期思路拒绝像素执行参数",
    schemaPath: "schemas/post-process-plan.schema.json",
    examplePath: "examples/post-process-plan.example.json",
    mutate: (value: Record<string, unknown>) => {
      const alternatives = value.alternatives as Array<Record<string, unknown>>;
      alternatives[0].hsl = { blue: -20 };
    },
  },
] as const;

const skillModuleDefinitions = readdirSync(resolve("skill-modules"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => [`Skill 模块 ${entry.name}`, `skill-modules/${entry.name}/skill.json`] as const);

describe("JSON Schema 契约示例", () => {
  it.each(cases)("%s 示例通过对应契约", (_name, schemaPath, examplePath) => {
    const ajv = new Ajv2020({ allErrors: true });
    const schema = JSON.parse(readFileSync(resolve(schemaPath), "utf8"));
    const example = JSON.parse(readFileSync(resolve(examplePath), "utf8"));
    const validate = ajv.compile(schema);
    expect(validate(example), ajv.errorsText(validate.errors)).toBe(true);
  });

  it.each(cases)("%s 契约使用 Draft 2020-12 且关闭顶层额外字段", (_name, schemaPath) => {
    const schema = JSON.parse(readFileSync(resolve(schemaPath), "utf8"));
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.additionalProperties).toBe(false);
  });

  it.each(invalidCases)("$name", ({ schemaPath, examplePath, mutate }) => {
    const ajv = new Ajv2020({ allErrors: true });
    const schema = JSON.parse(readFileSync(resolve(schemaPath), "utf8"));
    const example = JSON.parse(readFileSync(resolve(examplePath), "utf8")) as Record<string, unknown>;
    mutate(example);
    const validate = ajv.compile(schema);
    expect(validate(example)).toBe(false);
  });

  it.each(skillModuleDefinitions)("%s 通过 SkillDefinition 契约", (_name, definitionPath) => {
    const ajv = new Ajv2020({ allErrors: true });
    const schema = JSON.parse(readFileSync(resolve("schemas/skill-definition.schema.json"), "utf8"));
    const definition = JSON.parse(readFileSync(resolve(definitionPath), "utf8"));
    const validate = ajv.compile(schema);
    expect(validate(definition), ajv.errorsText(validate.errors)).toBe(true);
  });
});
