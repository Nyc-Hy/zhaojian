# API 设计

> 场景分析采用异步任务：`POST /v1/scene-analyses` 在图片和请求持久化后返回 `202` 与任务 ID；客户端轮询 `GET /v1/analysis-tasks/{taskId}`。状态依次为 `queued`、`understanding`、`generating`，终态为 `completed`、`needs_input`、`failed` 或 `canceled`。

> 分析请求必须包含 `gearKitId` 与可选 `photoTechnicalContext`。服务端不接受客户端拼装的器材能力。`POST /v1/capture-plans` 以任务 ID、方向 ID、三脚架状态和可选的可靠当前测光生成确定性参数起点，并再次检查账号资源所有权。

## 原则

- 移动端只调用照见后端，不直接调用模型供应商。
- 分析创建通过 `Idempotency-Key` 防止重复模型调用；摄影包与日记以客户端生成的资源 ID 幂等保存。
- 错误对用户友好，对开发可诊断。
- 云端分析要求个人账号；不登录时仍可使用不依赖云端的本地器材、参数与笔记能力。

## 当前端点

### `POST /v1/scene-analyses`

创建一次场景分析。

请求采用 `multipart/form-data`：

- `image`: 浏览器重新编码后的 JPEG 分析图，最长边不超过 2048px，文件不超过 2 MiB；不得上传原图、PNG、WebP 或带原始 EXIF 的文件。
- `request`: JSON，包含用户意图、关注选项、可选现场语境、机位自由度和器材摘要；用户回答澄清问题时还包含 `clarificationQuestion` 与 `clarificationAnswer`。
- Header `Idempotency-Key`。

成功响应固定为异步接受结果：

```json
{
  "analysis_id": "scene_123",
  "status": "queued",
  "image_id": "image_123",
  "created_at": "2026-07-22T10:00:00+08:00"
}
```

任务进入终态后，`GET /v1/analysis-tasks/{taskId}` 的 `result` 才包含经过校验的分析。关键不确定性会让任务以 `needs_input` 结束；客户端保留图片和输入，把用户选择或自填答案连同原问题再次提交。模型不得在已有答案时重复提出同一澄清问题。

可选现场语境包括：用户确认的画面内容、现场环境、无论如何想保留的关系、愿意弱化的内容、希望接近的感受，以及是否允许前后、左右或高度变化。服务端必须校验模型返回的机位建议没有超出这些自由度。现场环境是用户明确输入的最多 240 字简短事实，不接收 GPS 或完整 EXIF，不作为精确曝光输入。

### `GET /v1/analysis-tasks/{taskId}`

查询本人的异步任务、输入快照、终态结果和脱敏用量。任务摘要中的 `skillVersions` 保存该次执行使用的 Skill ID、语义版本和内容哈希；活动版本之后切换时，历史任务不重算。升级前的旧任务返回空数组。列表使用 `GET /v1/analysis-tasks?imageId=&limit=`。

`POST /v1/analysis-tasks/{taskId}/cancel` 请求取消本人仍在排队或执行的任务。终态为 `canceled`，错误码为 `TASK_CANCELLED`；已完成任务返回冲突，不会被改写。单个任务还受服务端租约超时限制，默认 360 秒。

`DELETE /v1/analysis-tasks/{taskId}` 删除本人任务；当同一分析图不再关联其他任务时同步删除图片。任务关联的白名单反馈同时删除，并确定性重建受影响的个人偏好；已保存 `CreativeIntent` 保留契约内来源快照，数据库来源外键置空。

### 个人创作记忆与受控反馈

- `GET /v1/personalization`：读取当前账号的记忆开关、反馈同步同意、结构化偏好、最近同步反馈和隔离候选数量。
- `PUT /v1/personalization/settings`：分别设置个人记忆和反馈同步同意；撤回同意后新同步立即返回冲突。
- `POST /v1/personalization/feedback/sync`：批量同步当前账号设备队列中的枚举反馈。服务端按任务所有权重新取得方向、视觉策略和 Skill 快照，不信任客户端 Skill 内容。
- `DELETE /v1/personalization/feedback/{feedbackId}`：删除本人反馈并重建受影响偏好。
- `PUT /v1/personalization/preferences/{preferenceId}`：启用或停用本人结构化偏好。
- `DELETE /v1/personalization/preferences/{preferenceId}`：删除本人偏好。
- `DELETE /v1/personalization`：清空本人反馈与偏好，并关闭个人记忆；不删除分析任务和摄影日记。

同步请求只允许分析任务 ID、方向 ID、视觉策略、固定反馈类型/值、客户端幂等 ID 和时间。图片、完整标题、用户原话、GPS、设备序列号、模型推理或 Skill 正文均不是契约字段。全局候选没有远程读取或发布端点。

### CreativeIntent

- `POST /v1/analysis-tasks/{taskId}/creative-intents`：以方向 ID 从已完成且通过校验的本人任务确定性生成意图；来源分析、方向、Skill 和摄影包快照都由服务端取得。
- `GET /v1/creative-intents?limit=`：列出本人的可追溯创作意图。
- `GET /v1/creative-intents/{intentId}`：读取本人一条意图。
- `DELETE /v1/creative-intents/{intentId}`：删除本人意图；关联摄影日记回到可空兼容状态。

`POST /v1/journal-entries` 接受可空 `creativeIntentId`。非空时必须属于当前账号；响应和账号导出同时包含关联意图。旧摄影日记返回空意图，不会自动重算。

### `GET /v1/models/status`

返回服务是否可用和客户端应显示的降级状态，不暴露供应商密钥或内部容量。

### `GET /v1/skills/status`

要求已登录且具有 `analysis:create` 权限。返回 Skill 运行时版本、云端 Skill 总开关，以及每个已加载版本的 ID、版本、生命周期状态、活动标记、内容哈希和创建时间。不返回模块正文、训练图片、状态文件路径或模型密钥，也不提供远程发布写操作。

### `GET /v1/operations/status`

要求已登录。返回应用 `releaseVersion`、数据库、任务队列、额度存储、图片存储、分析图保留天数、计价状态、密码恢复交付状态和多实例前置项。`1.0.0-beta.1` 固定返回单实例边界，不暴露连接串、密钥、容量或内部路径。

## 错误码

| 代码 | 含义 | 客户端处理 |
|---|---|---|
| `INVALID_IMAGE` | 图片无法解码或超限 | 提示重新选择 |
| `REQUEST_TOO_LARGE` | multipart 请求或图片超过服务端硬限制 | 前端重新压缩，不自动重试 |
| `RATE_LIMITED` | 当前客户端或 IP 请求过于频繁 | 按 `Retry-After` 等待 |
| `TOO_MANY_ANALYSES` | 同时进行的模型分析超过保护阈值 | 保留草稿，稍后重试 |
| `UNSUPPORTED_SCHEMA` | 客户端契约版本过旧 | 提示升级 |
| `MODEL_TIMEOUT` | 模型超时 | 保留草稿，可重试 |
| `MODEL_OUTPUT_INVALID` | 重试后仍未通过校验 | 不渲染部分错误结果 |
| `QUOTA_EXCEEDED` | 免费或付费配额不足 | 显示清晰配额说明 |
| `SERVICE_UNAVAILABLE` | 服务暂不可用 | 启用离线能力 |
| `SKILLS_DISABLED` | 维护者已停用云端摄影 Skill | 保留输入，继续使用本地器材与笔记 |
| `SKILL_UNAVAILABLE` | 分析所需的活动 Skill 不可用 | 保留输入，等待服务恢复 |

真实视觉模型在本地验证期使用“画面理解 → 观看方向”两阶段，两阶段共用 5 分钟等待预算。参考图只进入第一阶段；第二阶段只接收通过 `scene-understanding.schema.json` 校验的结构化理解和必要的用户上下文。仅当某阶段输出未通过 Schema 或业务规则校验时才允许一次修复；已有可读取候选时，修复只携带候选、校验原因和最小不可更改约束，不重复上传图片。机位自由度必须在方向生成及修复请求中逐项重申。超时后返回 `MODEL_TIMEOUT`，不得把底层 `AbortError` 或英文运行时消息直接展示给用户。5 分钟用于收集真实耗时，不代表最终产品可接受的同步等待时间。

Provider 可以在配置的短时窗口内，以分析图内容、观察提示词版本、模型和观察上下文的摘要作为键，复用已经通过 Schema 与业务校验的 `SceneUnderstanding`。缓存值只包含结构化理解，不包含图片、Base64 或密钥；想保留、愿意弱化和希望感受等创作取舍不参与观察缓存键，因此修改这些字段只重新生成方向。API 响应的 `provider.timing` 返回总耗时、画面理解耗时、方向生成耗时和是否复用画面理解，供本地性能验证。

## 供应商适配器

```text
interface VisionModelAdapter {
  analyze(request, contracts, promptVersion): Promise<ProviderResult>
  estimateCost(usage): Money
  normalizeError(error): ModelError
}
```

适配器内部先完成画面理解校验，再把结构化结果交给方向生成；供应商响应统一映射为内部 `ProviderResult`，经 Schema 和业务校验后才返回客户端。业务层不得依赖供应商的消息或多模态字段格式。

## 前后端职责与安全

- 前端负责选择源图、纠正方向、重新编码为 JPEG、压缩到 2 MiB 以内、显示压缩前后信息、生成本地预览与缩略图；原图不进入请求。
- 服务端不信任前端声明，只接受 `image/jpeg`，并验证单文件不超过 2 MiB、JPEG 文件头与结束标记、量化表、编码表、扫描段、完整像素解码、最长边不超过 2048px、总像素不超过 4194304；进入持久化和模型前移除 EXIF/XMP、ICC、Photoshop 注释与 JPEG Comment 段，失败请求不得进入模型适配器。
- ASP.NET Core multipart 请求总长度只为 2 MiB 文件预留少量协议开销；`request` JSON 有独立字段数、长度、枚举和数组上限。
- 服务端使用 ProblemDetails 返回稳定错误码与请求 ID，不把异常堆栈、供应商响应、密钥或用户原文返回客户端。
- 同一入口应用请求超时、客户端/IP 频率限制和模型分析并发限制；CORS 只允许配置的 Web 来源。
- 不允许客户端指定任意模型名、系统提示词或供应商 Base URL。

每次 Provider 调用把模型、调用次数、Token、缓存命中、耗时、结果和估算费用写入当前账号的任务明细。当前按账号/IP 执行每分钟限流、每日额度和全局并发保护；账号、任务、分析幂等键、结果与图片使用 SQLite 持久化，每日额度和频率限制仍是单实例内存保护。扩展到多实例或真实付费扣次前，将主数据库迁移 PostgreSQL，并把跨实例限流与额度迁移 Redis；业务代码不得直接依赖具体存储实现。

## 个人账号与任务历史

浏览器先调用 `GET /v1/account/session` 获取当前会话和 CSRF Token。所有有副作用的 Cookie 认证请求都通过 `X-CSRF-TOKEN` 发送该 Token。

- `POST /v1/account/register`：注册个人账号并建立登录会话。
- `POST /v1/account/login`：登录；失败只返回统一凭据错误，不泄露账号是否存在。
- `POST /v1/account/logout`：退出当前会话。
- `PUT /v1/account/profile`：本人修改 2～40 字昵称；邮箱修改不在 MVP 范围。
- `GET /v1/gear-kits` / `POST /v1/gear-kits` / `DELETE /v1/gear-kits/{id}`：读取、新建和删除当前账号摄影包。
- `POST /v1/gear-kits` 同时承担本人摄影包的幂等保存与编辑；响应包含可选 `warnings`，用于指出可解析的镜头名称焦段与记录范围不一致，参数计算仍采用记录值。
- `GET /v1/journal-entries` / `POST /v1/journal-entries` / `DELETE /v1/journal-entries/{id}`：读取、新建和删除当前账号摄影日记；缩略图必须是可完整解码、最长边不超过 1024px、总像素不超过 1048576 且不超过 512 KiB 的 JPEG，并受账号存储额度约束。
- `POST /v1/account/change-password`、`POST /v1/account/request-password-reset`、`POST /v1/account/reset-password`：密码生命周期；只有显式开启本机恢复码选项、请求来自 loopback 且处于开发环境时，未配置邮件发送器的服务才会返回一次性恢复码。
- `GET /v1/account/export`：下载包含结构化记录、日记缩略图和仍在保留期内分析图的 ZIP；同一账号只允许一个导出并发，超出在线导出规模时拒绝并提示联系维护者。
- `POST /v1/account/delete`：再次校验当前密码后注销本人账号并级联删除账号数据。
- `GET /v1/account/usage`：返回当前月任务结果、Token、估算费用和未计价任务数。
- `GET /v1/operations/status`：只公开非敏感部署能力边界，明确当前是否达到多实例条件。
- `GET /v1/journal-entries/{id}/thumbnail`：读取本人日记缩略图，响应使用私有缓存。
- `GET /v1/analysis-tasks?imageId=&limit=`：只列出当前用户的分析任务，可按同一图片过滤。
- `GET /v1/analysis-tasks/{taskId}`：读取当前用户的一条输入快照、状态、结果和 Provider 用量明细。
- `GET /v1/reference-images/{imageId}`：只返回当前用户的去元数据 JPEG 分析图。
- `DELETE /v1/analysis-tasks/{taskId}`：删除任务；当该图片不再被任何任务引用时同步删除分析图。

`POST /v1/scene-analyses` 只允许具有 `analysis:create` 权限的已登录账号调用。任务、图片、摄影包和摄影日记都必须在查询层限定当前用户，并在单资源操作中使用资源所有权授权；管理员角色可以用于运营处置，但普通用户不能读取、修改或推断其他账号的数据。列表只返回摘要，完整模型 JSON 仅在详情接口返回。
