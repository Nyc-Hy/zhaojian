# AI 模型策略

最后核验：2026-07-21

## 结论

中国大陆 MVP 的质量基线使用阿里云百炼 `qwen3.7-plus`。当评测集和提示词稳定后，以相同数据对比 `qwen3.6-flash`；若质量达标，则将 Flash 作为默认低成本模型，Plus 处理复杂场景。

截至 2026-07-21，阿里云百炼官方模型发布与 Function Calling 支持列表包含 `qwen3.7-plus`，未列出可调用的 `qwen3.8` 模型 ID。因此配置继续使用 `qwen3.7-plus`，不得仅凭非官方名称猜测并写入生产配置。后续切换模型前先用官方模型列表与最小 API 调用核验准确 ID。

```text
开发质量基线：qwen3.7-plus
规模化默认：qwen3.6-flash（评测通过后）
复杂场景兜底：qwen3.7-plus
国际版候选：GPT-5.6 系列
曝光参数：确定性程序，不交给模型
```

## 为什么选择 Qwen 基线

阿里云官方视觉理解文档当前建议从 `qwen3.7-plus` 开始，并说明其支持：

- 文本、图片和视频输入。
- 结构化输出。
- 函数调用。
- 大上下文。
- 中国内地服务部署。

官方同时建议在应用稳定后使用 `qwen3.6-flash` 降低成本。

参考：

- [阿里云视觉理解模型](https://help.aliyun.com/en/model-studio/vision-model/)
- [阿里云模型价格](https://help.aliyun.com/zh/model-studio/model-pricing)
- [阿里云 OpenAI 兼容接口](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions)

## OpenAI 的位置

国际版本或内部质量对照可以评估 GPT-5.6 家族：

- `gpt-5.6-sol`：旗舰质量基准。
- `gpt-5.6-terra`：质量与成本平衡。
- `gpt-5.6-luna`：高频工作负载。

OpenAI 图像接口支持图像理解及不同 detail 级别，但其官方 API 支持地区列表当前不包含中国大陆，因此不能作为大陆首发唯一生产依赖。

参考：

- [OpenAI 最新模型说明](https://developers.openai.com/api/docs/guides/latest-model)
- [OpenAI 图像与视觉](https://developers.openai.com/api/docs/guides/images-vision)
- [OpenAI API 支持地区](https://help.openai.com/en/articles/5347006-openai-api-supported-countries-and-territories)

## 模型职责

模型可以：

- 描述画面中可见的关系。
- 理解用户关注的对象和情绪意图。
- 先提供一份可核验的结构化画面理解，再在至少两种方向成立时提供 2～5 种具有不同具体取舍的观看方向，并为每项给出 2～3 条可执行、可观察的现场步骤；不足两种时明确返回没有可靠方向。
- 当关键识别不确定性会改变建议时，提出一个与当前照片相关的澄清问题。
- 建议大致视角类别或等效焦段提示。
- 判断画面中是否存在明显运动、高反差与高光风险。
- 明确不确定性。

模型不可以：

- 宣布最佳构图。
- 输出审美总分。
- 直接给出最终光圈、快门和 ISO。
- 编造不可见的太阳位置、未来天气或遮挡后内容。
- 假设用户拥有未配置的镜头或附件。

## 请求策略

MVP 将一次现场分析拆成两个隔离角色，仍由同一供应商适配器编排：

```text
压缩参考图
+ 用户原话/快速选项
+ 用户可选确认的画面内容、保留/弱化关系、目标感受与机位自由度
→ SceneUnderstanding JSON（只观察，不给构图方向）

SceneUnderstanding JSON
+ 用户原话与已确认上下文
+ 摄影包能力摘要
+ 产品原则
→ SceneAnalysis JSON（追问、2～5 个具体方向，或没有足够可靠方向）
```

第二阶段不再次发送图片。若返回澄清问题，用户回答后重新执行两阶段分析，并把问题与回答作为明确的用户确认信息传入。这样会增加调用时间与成本，必须由固定照片评测集证明质量收益；若没有收益，应回退而不是长期保留复杂度。

两阶段均通过 `tools` 定义一个专用函数，并用精确 `tool_choice` 强制调用：第一阶段为 `submit_scene_understanding`，第二阶段为 `submit_shot_options`。完整 JSON Schema 放在函数 `parameters`，不再重复粘贴到系统提示词。返回的 `tool_calls[0].function.arguments` 仍必须经过反序列化、Schema/枚举/范围校验和业务 Hook；Function Call 不是信任边界。

请求只提交摄影包 ID。服务端按登录账号读取摄影包完整能力后，才把清洗后的相机、镜头、传感器、焦段、光圈、ISO、防抖、三脚架与 ND 信息传入第二阶段。图片尺寸、比例、方向和用户同意的 EXIF 白名单进入第一阶段；`original_exif` 只解释原照片，只有带来源与时间的 `current_metering` 才能进入确定性参数引擎。

建议：

- 参考图常规分析长边最多 2048 像素，在不上传原图的前提下控制等待时间与成本。
- 不上传 RAW 原图。
- 两个阶段都使用独立 JSON Schema；结构化输出使用百炼兼容接口支持的 `json_object` 非思考模式，应用层继续强校验，失败时只修复对应阶段一次。
- 输出保持在满足 UI 的最小长度。
- 静态系统提示词使用缓存能力（供应商支持时）。
- 不进行逐帧推理。
- 对超时最多自动重试一次，并使用幂等请求 ID。

## 模型路由

初期路由保持简单：

```text
单图 + 一句话 → 默认模型
多图/短视频/复杂多轮 → 高能力模型
默认模型 Schema 校验连续失败 → 高能力模型重试一次
```

不得根据用户付费等级降低到不满足产品质量底线的模型。

## 供应商抽象

业务层只依赖统一接口：

```text
analyzeScene(request) -> SceneAnalysis
```

供应商适配器负责：

- 图片消息格式。
- 结构化输出参数。
- Token 与费用统计。
- 超时、限流和错误映射。
- 供应商模型 ID。

数据层保存逻辑模型角色，如 `quality_baseline`、`default_vision`，不要在业务代码中散落具体模型名。

## 不微调的理由

MVP 先使用提示词、少量示例和评测集。只有在积累经过用户明确授权的高质量样例，并确认问题无法通过提示词、结构校验或规则解决后，才考虑视觉微调。

模型微调不能修复：

- 错误的产品边界。
- 不可靠的曝光计算。
- 缺失的用户意图。
- 糟糕的交互结构。
