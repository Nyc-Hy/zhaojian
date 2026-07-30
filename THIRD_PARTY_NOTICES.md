# 第三方软件、数据与服务说明

本文用于说明照见仓库中不由根目录 `Apache-2.0` 统一重新授权的内容。它不替代第三方许可证原文；发生冲突时，以对应依赖、素材或服务的原始许可和条款为准。

## 源码许可证边界

除文件内另有声明外，本仓库自有的源码、文档、Schema、示例、测试和 Skill 模块适用根目录 [Apache License 2.0](LICENSE)。

以下内容不因进入本仓库而改用 Apache-2.0：

- npm、NuGet 及系统依赖；
- 外部摄影作品、其缩略图或衍生副本；
- 外部模型、API 和托管服务；
- 第三方商标、名称和标识；
- 在文件内明确标注其他许可证的内容。

## 直接软件依赖

依赖版本以 `package-lock.json`、各 `package.json`、`.csproj` 和 NuGet 还原结果为准。当前主要直接依赖包括：

| 依赖 | 许可证 |
| --- | --- |
| React、React DOM、Vite、Vitest、AJV、Concurrently、React/Vite 类型与插件 | MIT |
| TypeScript、fake-indexeddb | Apache-2.0 |
| Microsoft ASP.NET Core Identity、Entity Framework Core | MIT |
| SkiaSharp 及其 Linux 原生资源 | MIT |
| SQLitePCLRaw.bundle_e_sqlite3 | Apache-2.0 |

转发、打包或分发编译产物时，仍须检查完整的传递依赖树并保留其许可证和署名。锁文件用于冻结版本，不表示项目作者为第三方依赖提供额外担保。

## 摄影数据集

`datasets/photography-skill-v1`、`v2` 和 `v3` 只提交来源清单、冻结分区和脱敏训练审计元数据，不提交照片文件。真实图片位于本地 `.assets/`，该目录由 `.gitignore` 排除。

每个 `manifest.json` 条目分别记录：

- 来源页面和原始文件地址；
- 作者或署名文本；
- 具体的 Creative Commons 许可证及链接；
- 来源文件与清洗副本哈希；
- 允许用途和人物/隐私复核标记。

当前清单包含 CC BY 与 CC BY-SA 的多个版本。使用者必须逐项履行署名、许可证链接、修改说明和适用的相同方式共享义务。根目录 Apache-2.0 不覆盖这些摄影作品，也不消除肖像权、隐私权、平台条款或其他地域性义务。

`privacy_review: public_context_only` 仅代表数据整理时没有加入身份或故事标签，不代表人物同意书，也不是法律保证。下载、训练、发布模型或再分发图片前，应重新核对对应来源页、许可状态和适用法律。

数据集 `history/` 中的暴露账本和失败语料是工程审计元数据，可能包含 Provider、模型、运行 ID、时间、哈希、失败分类和费用估算；它们不应包含图片、Base64、密钥、用户原话或模型内部推理。发现不符合该边界的内容时，不得提交。

## 外部模型与服务

Qwen/阿里云百炼等 Provider 仅通过适配器接入。Apache-2.0 不授予任何外部模型、API、模型输出或服务的权利，也不替代供应商条款、数据保留规则和计费规则。启用真实 Provider 前，使用者须自行确认账号、地区、隐私、内容和费用责任。

## 报告问题

如果发现遗漏署名、错误许可证、权利争议或隐私风险，请按照 [SECURITY.md](SECURITY.md) 的私密渠道报告；在问题核实前应暂停获取和使用相关资产。
