# 数据模型

## 核心实体

### ApplicationUser

- `id`
- `email_normalized`
- `display_name`
- Identity 密码哈希、锁定与安全戳字段
- `created_at`

账号不直接包含业务权限判断；使用 `Member` / `Admin` 角色与授权策略。

### ReferenceImage

服务端只保存浏览器重新编码、去除 EXIF/GPS 的 JPEG 分析图：

- `id`
- `user_id`
- `sha256`
- `content_type`
- `width` / `height` / `byte_length`
- `content`
- `created_at`

同一用户的同一 SHA-256 只保存一份；不同用户之间不复用图片行或授权。

### AnalysisTask

- `id`
- `user_id`
- `reference_image_id`
- `idempotency_key`
- `status`: queued / understanding / generating / completed / needs_input / failed / canceled
- `request_json`
- `result_json`
- `skill_snapshots_json`：可空的 Skill ID、版本和内容哈希数组；旧任务读取为空数组
- `gear_snapshot_json`：新任务创建时保存的摄影包能力快照；旧任务可空
- `provider` / `model`
- `prompt_tokens` / `completion_tokens` / `provider_calls`
- `estimated_cost_cny`
- `duration_ms` / `understanding_ms` / `direction_ms` / `understanding_cache_hit`
- `error_code`
- `created_at` / `completed_at` / `completed_at_unix_ms`（后者只用于可索引的图片留存扫描）

一张 `ReferenceImage` 可以关联多条 `AnalysisTask`。历史结果只追加，不因为同图再次分析而覆盖或排序。

新任务在进入队列前记录两个活动 Skill 的不可变快照。幂等重放已完成任务时保留原快照；失败或过期任务重新执行时更新为本次将使用的活动版本。快照不保存提示词正文或密钥，说明与参考资料的版本由对应 `SkillDefinition` 的内容哈希追溯。

### GearKit

用户的一套摄影包，包含一个机身、多个镜头、附件和偏好。

- `id` / `user_id`
- 机身、传感器、镜头、焦段、光圈、防抖、ISO、三脚架与 ND 摘要
- 官方规格来源与核验时间（若有）
- `created_at` / `updated_at`

所有查询和修改必须同时限定当前 `user_id`；API 不直接返回持久化实体。

### PhotoNote

一次从现场观察到最终照片的记录，是产品核心聚合对象。

建议字段：

- `id`
- `created_at` / `updated_at`
- `status`: draft / analyzed / planned / completed
- `gear_kit_snapshot`
- `reference_image_local_uri`
- `uploaded_image_id`
- `user_intent_text`
- `attention_option`
- `scene_analysis`
- `selected_interpretation_id`
- `shooting_plan`
- `final_photos`
- `reflection_text`

保存器材快照而不是只保存器材 ID，避免用户日后修改摄影包后改变历史笔记。

当前纵向切片将其落地为账号级 `JournalEntry`：保存意图、方向、焦段、试拍方法、个人感受、摄影包名称快照、去元数据 JPEG 缩略图、`thumbnail_byte_length` 和可空 `creative_intent_id`。字节数字段用于账号额度和导出预检，迁移时从已有 BLOB 回填；日记删除不级联删除分析任务，分析任务删除也不改变已有日记文字或关联创作意图。删除 `CreativeIntent` 时日记外键置空，旧记录继续按无意图兼容路径显示。

### SceneAnalysis

模型返回并通过校验的场景分析。必须保存：

- Schema 版本。
- 逻辑模型角色。
- 实际模型版本。
- 提示词版本。
- 请求 ID。
- 经过校验的响应。

### SkillTrainingRun / SkillTrainingArtifact / SkillTrainingReport

三者属于开发者离线训练控制面，不进入账号数据库：

- `SkillTrainingRun` 保存完整数据集与显式选择范围的不可变快照、Skill 快照、五角色状态、有限尝试、角色输出引用与哈希、逐调用次数/Token/费用/延迟/错误审计、预算租约汇总、困难证据、取消/失败终态和原子检查点哈希。
- `SkillTrainingRoleOutput` 保存单个真实角色的脱敏结构化结果、Provider/模型、尝试次数与 Token/费用估算；观察、方向、问题和候选各自有字段上限，禁止原图、Base64、完整提示词和内部推理。
- `SkillTrainingArtifact` 保存单个资产的 `model_suggested` 制品摘要；Mock 制品永远不可用于正式训练，回归集和保留集也不能产生 Skill 改进候选。
- `SkillTrainingReport` 只保存白名单元数据、选择范围与哈希、分维度指标、失败与隔离证据、按角色和全局汇总的调用次数/Token/费用/延迟、预算、制品数量和可比较运行键，不保存图片、Base64、完整用户文字、GPS 或模型内部推理。

这些文件默认位于 Git 忽略的 `.local/skill-training/`。同一数据集、选择范围、Skill、模型、计价快照和配置产生相同 `comparable_run_key`；运行 ID、开始时间和报告内容哈希仍分别保留。真实角色输出和最终候选保持 `model-suggested`，在 WP6 固定回归、保留集对比与 shadow 通过前不可激活。

### SkillEvaluationReport / SkillRegistryState

二者把离线评测证据与运行时状态迁移分开：

- `SkillEvaluationReport` 保存 candidate 或 shadow 阶段、基线与候选训练报告/Skill 的版本和内容哈希、Provider/模型/提示词/Schema/计价/数据集来源、九个分维度对比、36/12/12 分区结果、严重新增失败、成本和延迟门禁、操作者、原因、命令、生成时间与报告内容哈希。它不包含审美总分，也不会自行修改注册表。
- `SkillRegistryState` 1.1 保存每个 Skill 版本状态、活动与回滚指针、云端能力开关、单调 revision 和有限审计日志。审计包含动作、Skill、版本、前后状态、操作者、原因、命令，以及适用时的评测报告 ID 与内容哈希。

评测报告默认位于 Git 忽略的 `.local/skill-evaluations/`。发布门禁按内容哈希重新读取报告，candidate 报告只能授权进入 shadow，带独立观察 ID 的 shadow 报告只能授权进入 active；任何校验失败都不能产生新 revision。状态迁移与审计由同一次原子文件替换完成，避免出现“状态已变但证据未记”的中间态。

### PersonalizationSettings / FeedbackRecord / CreativePreferenceRecord

三者都是当前账号的数据：

- `PersonalizationSettings` 以 `user_id` 为主键，保存 `memory_enabled`、`feedback_sync_consent` 和更新时间；默认两个开关均为关闭。
- `FeedbackRecord` 保存服务端复核后的 `analysis_task_id`、可空方向 ID、视觉策略、反馈类型和值、任务 Skill 快照、客户端幂等 ID、创建与同步时间。字段只允许固定枚举，不保存图片、完整标题、自由文字或推理。
- `CreativePreferenceRecord` 保存当前账号的偏好类型、视觉策略、来自不同任务的证据数量、启用状态与时间。只有至少两个不同分析任务的明确反馈才会生成；删除源反馈会确定性重建。

账号查询必须限定 `user_id`。任务删除会级联删除对应反馈并重建受影响偏好；“清空创作记忆”删除反馈和偏好，但不删除摄影日记或分析任务。

### GlobalExperienceCandidate

全局候选不保存 `user_id`，只保存来源反馈外键、候选类型、白名单载荷、隔离状态和时间。它不能被 `ISkillRegistry`、`SkillExecutionPlanner` 或 Provider 读取；后续若要使用，必须经过重新分析、固定回归、保留集与 shadow，并形成新的 Skill 版本。删除反馈或注销账号会级联删除对应候选。

### CreativeIntent

- `id` / `user_id`
- 可空 `source_analysis_task_id` 外键
- `selected_interpretation_id`
- `payload_json`
- `created_at` / `updated_at` 与可索引 Unix 毫秒字段

`payload_json` 通过 `CreativeIntent` 契约保存：

- 主题关系、注意路径、保留/减少、画框、明暗、色彩、运动、景深和纹理意图。
- 不确定性与取舍。
- 原始 `source_analysis_id` 和方向 ID。
- Skill ID、版本与内容哈希。
- 分析任务创建时的摄影包快照。

同一账号的“来源分析 + 方向”唯一，重复保存幂等返回已有记录。删除分析任务时数据库外键置空，但契约内的来源 ID、Skill 和摄影包快照继续保留；删除意图时关联摄影日记外键置空。

### BetaReleaseEvidence

Beta 发布证据不进入账号数据库，默认位于 `.local/beta-release/<version>/`：

- `command-results.json` 保存离线验证、演练、日志路径和退出码。
- `bundle/` 与压缩包保存 API/Web 可回滚制品及版本说明。
- `evidence.json` 保存发布版本、Git 来源、单实例边界、制品 SHA-256、演练、人工记录、真实 60 图摘要和逐门禁状态。

报告只引用真实训练报告中的白名单摘要，不复制角色输出、图片、完整提示词或内部推理。缺少 60 图真实报告时状态必须为 `blocked`。

### ShootingPlan

参数引擎产生的确定性结果：

- 选中解释 ID。
- 使用镜头与焦段。
- 方案列表。
- 计算假设。
- 测光来源。
- 参数引擎版本。

### FinalPhoto

- 本地 URI。
- EXIF 快照。
- 用户选择的最终参数。
- 是否作为笔记封面。

## 本地优先与账号同步

- GearKit 与 JournalEntry 在登录后以账号数据库为跨设备事实来源。
- 浏览器按账号 ID 隔离摄影包和笔记设备副本，退出后不继续展示上一账号数据；离线新增内容先写本地，恢复连接后以稳定资源 ID 幂等补传。
- 首次升级时，旧版全局 `localStorage` 摄影包和 IndexedDB 笔记只能由首个认领账号迁移一次；迁移成功后删除未分区旧副本，其他账号不得再次读取或迁移。迁移不包含原图。
- 图片与结构化数据分开存储。
- 精确 GPS、完整 EXIF 和原图始终不进入账号同步。

## 删除语义

- 删除笔记不等于只隐藏。
- 若存在云端同步，删除需要进入待同步队列。
- 参考图短期对象与笔记元数据使用不同生命周期。
- 用户通过删除分析任务控制云端副本；同一图片关联的最后一条任务删除后，分析图同步删除，本地日记不受影响。

## 版本字段

所有长期数据对象至少包含：

- `schema_version`
- `created_at`
- `updated_at`
- `source_version`

模型、提示词和参数引擎分别版本化，便于追踪建议变化。
