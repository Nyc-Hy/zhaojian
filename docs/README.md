# 照见文档地图

本文档集按“为什么做 → 做什么 → 如何体验 → 如何实现 → 如何交付与运营”的顺序组织。

## 00 概览

- [项目简报](00-overview/project-brief.md)：一句话定义、价值、边界和阶段目标。
- [决策记录](00-overview/decisions.md)：已经确定的关键决定与仍需验证的问题。

## 01 产品

- [愿景与产品原则](01-product/vision-and-principles.md)
- [用户与待办任务](01-product/personas-and-jobs.md)
- [MVP 范围](01-product/mvp-scope.md)
- [照见 1.0 Skill 基础版开发范围](01-product/v1-skill-foundation-scope.md)
- [产品需求文档 PRD](01-product/prd.md)

## 02 设计

- [信息架构](02-design/information-architecture.md)
- [核心用户流程](02-design/core-user-flows.md)
- [交互与内容设计](02-design/interaction-and-content.md)
- [低保真线框](02-design/wireframes.md)
- [视觉方向](02-design/visual-direction.md)

## 03 AI

- [模型策略](03-ai/model-strategy.md)
- [场景分析契约](03-ai/scene-analysis-contract.md)
- [提示词规范](03-ai/prompt-spec.md)
- [AI 评测计划](03-ai/evaluation-plan.md)

## 04 技术

- [系统架构](04-technical/system-architecture.md)
- [摄影参数引擎](04-technical/parameter-engine.md)
- [器材档案](04-technical/gear-profile.md)
- [数据模型](04-technical/data-model.md)
- [API 设计](04-technical/api-design.md)
- [隐私与安全](04-technical/privacy-and-security.md)

## 05 开发

- [技术路线选择](05-development/technology-options.md)
- [路线图](05-development/roadmap.md)
- [照见 1.0 Skill 基础版开发计划](05-development/v1-skill-foundation-plan.md)
- [任务拆分](05-development/task-breakdown.md)
- [测试策略](05-development/test-strategy.md)
- [完成定义](05-development/definition-of-done.md)

## 06 运营

- [商业模式](06-operations/business-model.md)
- [中国大陆合规](06-operations/china-compliance.md)
- [风险清单](06-operations/risk-register.md)
- [发布检查表](06-operations/launch-checklist.md)
- [`1.0.0-beta.1` 已知限制](06-operations/beta-1.0.0-beta.1-known-limitations.md)
- [`1.0.0-beta.1` 浏览器核心闭环记录](06-operations/beta-browser-smoke-record.md)
- [`1.0.0-beta.1` 工程发布证据](06-operations/beta-release-evidence.md)

## 公开仓库治理

- [Apache License 2.0](../LICENSE)
- [第三方软件、摄影数据与服务说明](../THIRD_PARTY_NOTICES.md)
- [数据集公开边界](../datasets/README.md)
- [贡献指南](../CONTRIBUTING.md)
- [安全策略](../SECURITY.md)
- [工程 Beta 隐私说明](../PRIVACY.md)
- [支持边界](../SUPPORT.md)
- [社区行为准则](../CODE_OF_CONDUCT.md)

## 可执行契约

- [`scene-understanding.schema.json`](../schemas/scene-understanding.schema.json)：第一阶段画面理解契约。
- [`scene-analysis.schema.json`](../schemas/scene-analysis.schema.json)：第二阶段澄清或观看方向输出契约。
- [`gear-profile.schema.json`](../schemas/gear-profile.schema.json)：用户器材档案契约。
- [`skill-definition.schema.json`](../schemas/skill-definition.schema.json)：版本化摄影 Skill 定义。
- [`skill-training-dataset.schema.json`](../schemas/skill-training-dataset.schema.json)：训练图片来源与分区清单。
- [`skill-training-role-output.schema.json`](../schemas/skill-training-role-output.schema.json)：脱敏的真实训练角色结构化结果与单次用量。
- [`skill-training-run.schema.json`](../schemas/skill-training-run.schema.json)：训练选择范围、状态、逐调用审计与恢复检查点。
- [`skill-training-report.schema.json`](../schemas/skill-training-report.schema.json)：自动训练角色、指标、失败、Token/费用/延迟与预算报告。
- [`skill-evaluation-report.schema.json`](../schemas/skill-evaluation-report.schema.json)：候选/Shadow 新旧对比、分区、门禁与发布资格报告。
- [`skill-registry-state.schema.json`](../schemas/skill-registry-state.schema.json)：Skill 状态、活动/回滚指针、revision 与发布审计。
- [`creative-intent.schema.json`](../schemas/creative-intent.schema.json)：拍摄选择与摄影日记之间的创作意图快照。
- [`final-photo-observation.schema.json`](../schemas/final-photo-observation.schema.json)：最终照片可见事实观察草案。
- [`post-process-plan.schema.json`](../schemas/post-process-plan.schema.json)：可选择、可解释、可逆的后期思路草案。
- [`beta-release-evidence.schema.json`](../schemas/beta-release-evidence.schema.json)：Beta 版本、命令、制品、演练、真实 60 图评测和逐门禁证据。
- [`scene-understanding.example.json`](../examples/scene-understanding.example.json)：画面理解示例。
- [`scene-analysis.example.json`](../examples/scene-analysis.example.json)：场景分析示例。
- [`gear-profile.example.json`](../examples/gear-profile.example.json)：器材档案示例。
- [`skill-definition.example.json`](../examples/skill-definition.example.json)：Skill 定义示例。
- [`skill-training-dataset.example.json`](../examples/skill-training-dataset.example.json)：最小三分区数据清单示例。
- [`skill-training-role-output.example.json`](../examples/skill-training-role-output.example.json)：真实观察角色的脱敏输出示例。
- [`skill-training-run.example.json`](../examples/skill-training-run.example.json)：包含选择范围与调用审计的训练运行示例。
- [`skill-training-report.example.json`](../examples/skill-training-report.example.json)：包含选择范围与遥测汇总的多角色训练报告示例。
- [`skill-evaluation-report.example.json`](../examples/skill-evaluation-report.example.json)：通过 candidate 阶段门禁的多维评测报告示例。
- [`skill-registry-state.example.json`](../examples/skill-registry-state.example.json)：包含 Shadow 发布审计的注册表状态示例。
- [`creative-intent.example.json`](../examples/creative-intent.example.json)：创作意图示例。
- [`final-photo-observation.example.json`](../examples/final-photo-observation.example.json)：最终照片观察草案示例。
- [`post-process-plan.example.json`](../examples/post-process-plan.example.json)：后期思路草案示例。
- [`beta-release-evidence.example.json`](../examples/beta-release-evidence.example.json)：真实评测尚未授权时保持阻断的 Beta 证据示例。

## 文档状态规则

- `已决定`：可以进入实现，除非出现新证据。
- `待验证`：必须通过原型、用户测试或技术实验后才能锁定。
- `不在 MVP`：不得在第一版实现中顺带加入。
- 涉及价格、模型版本、平台政策和法规的内容必须记录核验日期。
