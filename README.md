# 照见 Zhaojian

> 摄影观看与技术随行助手。先看见，再拍下。

照见不是替用户判断“最佳构图”的 AI 相机，也不把摄影者变成执行算法指令的人。它帮助用户辨认自己为何被一个场景吸引，提供几种不同的观看可能，再结合用户真实拥有的相机、镜头和附件，把选中的表达翻译成可尝试的焦段与曝光起点。

## 当前阶段

当前工程版本为 `1.0.0-beta.1`，已经包含可本地运行的 Web 核心闭环、版本化摄影 Skill、60 图数据清单、自动 Trainer、发布回滚、个人创作记忆和可追溯 `CreativeIntent`。工程 Beta 不代表已经完成真实设备、商店、备案、支付或公开运营准备。

当前已经确定：

- 以风景与日常环境摄影为首要场景，不以人像摆位为中心。
- 人负责感受和选择，AI 负责观察、解释和提供可能。
- 构图建议不评分、不排名，不使用“正确”“最佳”“必须”等绝对表达。
- 视觉模型不直接编造光圈、快门和 ISO；参数由确定性引擎计算。
- 第一版作为真实相机的手机伴侣，不直接遥控各品牌相机。
- 中国大陆 MVP 优先评估阿里云百炼视觉模型；保留模型供应商切换能力。

## 开源与公开仓库边界

照见自有源码、文档、Schema、示例、测试和 Skill 模块采用 [Apache License 2.0](LICENSE)。贡献与分发时还应阅读：

- [第三方软件、摄影数据与服务说明](THIRD_PARTY_NOTICES.md)
- [贡献指南](CONTRIBUTING.md)
- [安全策略](SECURITY.md)
- [工程 Beta 隐私说明](PRIVACY.md)
- [支持边界](SUPPORT.md)
- [社区行为准则](CODE_OF_CONDUCT.md)

摄影数据集只提交来源清单、逐项许可、冻结分区和脱敏训练审计元数据；真实照片文件位于已忽略的 `.assets/`，不会进入 Git，也不受根目录 Apache-2.0 重新授权。清单中的 CC BY/CC BY-SA 图片仍须逐项署名并履行适用的相同方式共享、隐私和肖像权义务。

公开源码不等于照见已经提供在线服务。当前工程 Beta 尚未完成面向公众运营所需的正式隐私政策、备案、支付、客服、生产部署和持续值守；自行部署者需要对自己的数据流、模型供应商、内容与地区合规负责。

## 文档入口

- [文档地图](docs/README.md)
- [项目简报](docs/00-overview/project-brief.md)
- [产品原则](docs/01-product/vision-and-principles.md)
- [MVP 产品需求](docs/01-product/prd.md)
- [照见 1.0 Skill 基础版开发范围](docs/01-product/v1-skill-foundation-scope.md)
- [核心用户流程](docs/02-design/core-user-flows.md)
- [AI 模型策略](docs/03-ai/model-strategy.md)
- [系统架构](docs/04-technical/system-architecture.md)
- [摄影参数引擎](docs/04-technical/parameter-engine.md)
- [开发路线图](docs/05-development/roadmap.md)
- [照见 1.0 Skill 基础版开发计划](docs/05-development/v1-skill-foundation-plan.md)
- [商业模式](docs/06-operations/business-model.md)
- [`1.0.0-beta.1` 已知限制](docs/06-operations/beta-1.0.0-beta.1-known-limitations.md)
- [发布检查表](docs/06-operations/launch-checklist.md)
- [数据集公开边界](datasets/README.md)
- [开源许可证](LICENSE)
- [第三方说明](THIRD_PARTY_NOTICES.md)

## 本地运行

环境要求：.NET SDK 10、Node.js 20 或更高版本、npm 10 或更高版本。

```bash
npm install
npm run dev
```

打开 <http://127.0.0.1:5173>。本地 API 默认位于 <http://127.0.0.1:8787>。默认使用 Mock，不需要模型密钥，也不会向外部模型发送图片。Mock 只验证流程，不会识别上传图片，页面会明确标记这一限制；配置 Qwen 后才会进行真实图像分析。

若本机已有一套服务占用默认端口，可以分别启动 `dotnet run --project src/Zhaojian.Api --no-launch-profile --urls http://127.0.0.1:8788` 和 `VITE_API_TARGET=http://127.0.0.1:8788 npm run dev -w @zhaojian/web -- --port 5174`；这不会改变生产构建的请求路径。

常用验证命令：

```bash
npm run validate:schema  # 校验 schemas/ 与 examples/ 契约
npm run skill:validate   # 离线校验 Skill 定义、资源与内容哈希
npm test                 # Web、参数引擎与 Schema 测试
npm run test:api         # ASP.NET Core 集成测试
npm run build            # 构建 Web、参数引擎与 .NET API
npm run verify           # 测试、构建并发布 .NET API
npm run beta:prepare     # 无网络生成 Beta 离线证据、演练和可回滚制品
```

`npm run verify` 默认使用 Mock，不读取模型密钥，也不访问外部模型。ASP.NET Core 集成测试会经过真实 multipart 路由、2 MiB 文件限制、JPEG 文件头与尺寸校验、请求白名单、Provider、契约校验、幂等控制和用量记录；真实模型验证仍通过本地 Web 页面完成，不被 CI 自动调用，避免产生远端费用。

`npm run evaluate:fixed` 单独检查版本化固定场景契约集。目前仓库含 12 个合成场景定义；它用于守住结构、诚实停下和非评分边界，不冒充 1.0 计划建设的 60 张来源明确真实摄影图片。

Skill 发布状态只允许本机维护，不开放远程写 API。候选版本先进入 shadow，再激活；所有变更必须提供操作者、原因和对应评测报告：

```bash
npm run skill:shadow -- --skill observe-scene --version 1.1.0 --report .local/skill-evaluations/<candidate>.json --actor maintainer --reason "候选阶段门禁通过"
npm run skill:promote -- --skill observe-scene --version 1.1.0 --report .local/skill-evaluations/<shadow>.json --actor maintainer --reason "独立 shadow 观察通过"
npm run skill:rollback -- --skill observe-scene --actor maintainer --reason "新版本发生可复现退化"
npm run skill:disable -- --actor maintainer --reason "关闭新的云端分析"
```

`npm run beta:prepare` 不访问模型，也允许 60 图真实门禁暂时保持阻断。取得明确费用授权并单独生成完整真实报告后，使用 `npm run beta:verify -- --live-report .local/skill-training/<run-id>/report.json`；3 图烟测和 Mock 报告不能使发布状态进入 `ready`。

默认防护为每个账号/IP 每分钟 6 次、每个账号每天 30 次分析，同时最多运行 4 个模型分析；均可通过 `ApiProtection` 配置调整。账号、任务、结果与分析图已由 ASP.NET Core Identity、资源所有权策略和 EF Core SQLite 持久化隔离；每日额度与跨请求幂等仍是单实例实现，多实例和可靠计费阶段需迁移 PostgreSQL/Redis。

## Klari 项目查询

项目使用 Klari 在 `.klari/` 中维护本机代码知识库。该目录已从 Git 排除，但会保留在当前工作区，供开发者和编码 Agent 查询代码位置、API 调用链、符号关系、业务流与项目规则。

首次生成知识库：

```bash
npm run klari:setup
```

日常查询示例：

```bash
npm run klari -- ask "修改场景分析的异步任务恢复" --json
npm run klari -- logic search "场景分析 观看方向 图片理解" --json
npm run klari -- logic anchors <flow-id> --json
npm run klari -- rules query "场景分析 API Schema 校验" --json
npm run klari -- semantic evidence "摄影日记 同步 账号 缩略图" --json
npm run klari -- trace-api "POST /v1/scene-analyses"
npm run klari -- trace-symbol SceneAnalysisService
npm run klari -- trace-symbol saveStoredNote
npm run klari -- route-file apps/web/src/App.tsx
```

代码或文档发生变化后刷新并校验：

```bash
npm run klari:stale
npm run klari:refresh
npm run klari:validate
```

启动脚本优先使用已安装的 `klari` 命令；本机未安装时会尝试兄弟目录 `../klari` 的 Release 构建。其他目录布局可通过 `KLARI_CLI=/绝对路径/klari` 指定。当前知识库还保存了“场景分析”“摄影日记同步”和“确定性参数起点”三组已校验语义候选，中文业务词可以通过 `logic search` 返回对应代码锚点；这些候选仍标记为 `ai-suggested`，用于导航而不是代替项目事实。

Klari 的 `partial`、`unresolved` 和低置信度结果只是进一步点验的线索，不能直接替代源码与运行验证。仓库存在未提交改动时，`refresh` 会按当前文件重新生成知识，但基于 Git 的 `stale`/`validate` 仍可能持续报告漂移；此时应保留告警，并结合刚刷新的锚点、确切源码和项目测试判断，而不是把 `.klari/` 加入版本控制。

## 模型配置

模型只能由 ASP.NET Core 服务端调用。开发密钥使用 .NET User Secrets，不写入仓库、前端环境变量或 `appsettings.json`。

默认 Mock：

```bash
dotnet user-secrets set "Model:Provider" "mock" --project src/Zhaojian.Api
dotnet user-secrets remove "Model:Qwen:ApiKey" --project src/Zhaojian.Api
```

启用阿里云百炼千问兼容接口：

```bash
dotnet user-secrets set "Model:Provider" "qwen" --project src/Zhaojian.Api
dotnet user-secrets set "Model:Qwen:ApiKey" "你的服务端密钥" --project src/Zhaojian.Api
```

“画面理解 → 观看方向”两阶段共用最多 5 分钟的请求预算。图片只发送给第一阶段；第二阶段只接收已校验的结构化画面理解与用户上下文。任一阶段输出不合规时最多进行一次结构修复，已有候选时不会重复发送图片。默认在内存中短时保留 10 分钟、最多 12 份已经校验的结构化画面理解，不缓存图片；可通过 `Model:Qwen:UnderstandingCacheSeconds` 调整或关闭。

若选择 `qwen` 但缺少密钥，API 会明确标记降级并使用 Mock；若运行中的远端模型调用失败，页面保留图片与输入，提供重试，器材换算与设备离线副本仍可使用。登录后的摄影包与摄影日记按账号同步，日记只同步去元数据缩略图与结构化文字。日志不记录图片、Base64、GPS、密钥或用户原话。

## 原型能力

- 在浏览器本地创建、选择器材档案，并内置“旅行摄影包”示例。
- 相机名称支持中文俗称、英文型号与代际简称的模糊搜索；当前提供 43 个型号入口，其中 4 款已逐项对照厂商官方规格。只有已核验字段会自动带入，其他型号要求用户确认传感器与高级参数。
- 原图只在浏览器本地解码；支持不超过 60 MiB、6000 万像素的 JPEG、PNG 或 WebP，并生成最长边不超过 2048px、体积不超过 2 MiB 的 JPEG 分析图。页面会显示压缩前后尺寸，原图、EXIF 和 GPS 不会发送；ASP.NET Core API 不做常规二次压缩，只按账号保存去元数据分析图，供本人重复查看历史任务。
- 提供个人账号注册、登录与退出；分析任务列表会保留输入快照、结果、Token、耗时与估算费用，同一张分析图可以多次分析且结果互不覆盖。
- 用户可以选填画面内容、现场环境、希望保留/弱化的关系、目标感受和可改变的机位范围，帮助模型纠正误识别。现场环境只作为两阶段的文字上下文，不用于猜测精确曝光。
- 通过供应商适配器调用 Mock 或 Qwen，先返回并校验 `scene-understanding.schema.json`，再返回并校验 `scene-analysis.schema.json`；业务层不依赖供应商响应格式。
- 当关键不确定性会改变关注对象或取舍时，系统先提出一个具体澄清问题；否则只在至少两种方向成立时展示 2～5 个不评分、不排名的观看可能，不足两种时明确说明没有足够可靠方案。
- 每个方向必须点名至少两个画面元素，解释它们的关系、与用户吸引点的联系，提出一个只比较一个可见变量的开放观看问题，并给出相对机位、取景器核对方法和 2～3 条现场试法。
- 结果页显示本次总耗时和是否复用了画面理解，方便直接比较首轮识别与同图再次生成方向的速度。
- 画面理解会先记录可核验的遮挡、层次、尺度、重复、线条、明暗和色彩关系；前三个方向再分别采用不同的视觉组织策略，避免把同一对元素机械改写成“重叠、分离、相切”。
- 真实模型方向会经过最低质量门禁：拦截三分法等固定公式、可套用于任意照片的空话、无依据的“生命力/压迫”等叙事、内部字段泄漏和重复策略。用户明确关注两个对象时，至少一个方向必须直接回应两者；其他方向可以依据新的可见关系转换观看重心。门禁不替代摄影者对“是否有启发”的判断。
- 用户可以在结果页标记“有启发 / 太泛 / 识别不对”或方向级“值得试一次 / 还不够具体 / 画面依据不对”。反馈先进入当前账号的设备队列；只有用户明确同意后才同步分析 ID、方向 ID、视觉策略、Skill 快照、枚举和值，不保存图片、完整标题或输入文字。
- 个人中心允许开启/关闭个人创作记忆，查看、停用、删除和清空结构化偏好。至少两个不同分析任务的明确反馈才会形成稳定信号；全局候选处于隔离表，运行时 Skill 无法直接加载。
- 选中观看方向后可保存服务端生成的 `CreativeIntent`，同时保留来源分析、方向、Skill 版本和摄影包快照；摄影日记展示该快照，旧记录在缺少意图时继续正常读取。
- 使用独立确定性参数引擎完成等效焦段映射、最近可行焦段、安全快门、EV/ISO 和 ND 计算。
- 没有真实测光时只给条件、安全约束和试拍方法；填写真实 EV100 后才计算曝光起点。
- 摄影笔记和小尺寸参考缩略图先写入按账号隔离的 IndexedDB，再与账号数据库同步；器材设备副本和待同步反馈同样按账号隔离。

## 目录结构

```text
zhaojian/
├── apps/
│   └── web/                 React + Vite 中文界面、图片压缩与本地数据
├── src/
│   └── Zhaojian.Api/        ASP.NET Core 10 API、模型适配器与防护
├── packages/
│   └── parameter-engine/    前端离线可用的确定性摄影参数规则
├── skill-modules/           可版本化摄影 Skill、参考资料与正反例
├── docs/                    产品、设计、AI、技术、开发与运营文档
├── schemas/                 稳定的数据交换契约
├── examples/                契约示例和 Mock 场景分析
├── tests/
│   └── Zhaojian.Api.Tests/  ASP.NET Core 集成测试
├── Zhaojian.slnx            .NET 10 解决方案
├── AGENTS.md                后续协作约定
└── README.md                项目入口与运行说明
```

## 已跑通的纵向流程

第一项开发工作不是写完整 App，而是制作一条可验证的纵向切片：

```text
配置一套摄影器材
→ 拍摄或选择一张参考图
→ 说出“什么吸引了我”
→ 必要时回答一个澄清问题
→ 获得 2～5 种有充分依据的观看建议与现场试法；不足两种时明确告知没有可靠方案
→ 选择一种
→ 获得焦段框与参数起点
→ 保存摄影笔记
```

这条链路当前面向本地验证：器材与笔记在浏览器保存，场景分析默认使用 Mock；模型观察不能替代相机测光，参数建议也不是唯一答案。

## 名称状态

“照见 / Zhaojian”是当前工作名称。公开检索未发现明显同类摄影 App 冲突，但它不构成商标、企业名称、域名或应用商店名称的法律可用性结论。正式商业化前必须进行专项检索。
