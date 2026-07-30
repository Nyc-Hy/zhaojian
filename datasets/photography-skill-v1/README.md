# 照见摄影 Skill 数据集 v1

本目录保存照见 1.0 首批 60 张真实摄影图片的来源清单与冻结分区，不保存图片内容。三个版本共同的公开与授权边界见 [`datasets/README.md`](../README.md) 和根目录 [`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md)。

## 固定范围

- 25 张风光与自然；
- 15 张城市与日常环境；
- 10 张人物与环境人物；
- 10 张普通或困难照片；
- 固定分为 36 张训练、12 张回归、12 张保留集。

仓库中的 12 个合成评测场景仍是独立 fixture，不计入这 60 张真实图片。人物样本只用于观察可见的位置、尺度、遮挡、姿态与环境关系，不包含身份或故事标签。

## 文件边界

- `manifest.json`：每项来源、作者、许可、许可链接、用途、署名、来源文件 SHA-1、清洗副本 SHA-256、人物信息标记与分区。
- `splits.json`：冻结的 36/12/12 资产 ID 分区。
- `.assets/`：本地下载并移除 JPEG APP1–APP15 与 COM 元数据段后的副本，已由 `.gitignore` 排除。
- `raw/`、`downloads/`：如果临时存在，也必须留在 Git 之外。

`privacy_review: public_context_only` 仅表示样本经内容适配复核、且没有加入身份或故事标签；它不是人物同意书，也不构成隐私或肖像权保证。发现权利争议、来源变更或不适合继续使用时，应先隔离或移除对应资产，再产生新数据集版本。

## 命令

离线校验清单、固定分区、数量、重复项、哈希、许可门禁和 Git 跟踪边界：

```bash
npm run dataset:validate
```

本机存在 `.assets/` 时，校验还会逐项检查文件存在性、清洗状态和 SHA-256；干净克隆中只验证已提交的清单与分区。

按冻结清单恢复同一批本地清洗副本：

```bash
npm run dataset:acquire
```

只有明确准备创建一个新的数据集版本时才运行：

```bash
npm run dataset:seed -- --dataset-version 1.1.0
```

`dataset:seed` 要求显式指定一个不同于当前清单的新版本；它会重新查询外部来源并改写清单和分区。运行后必须重新做内容适配抽查、权利核验并提交为新的数据集版本，不能把它当作日常恢复命令。

## 来源与再使用

首版清单由 Wikimedia Commons 文件页及其 API 元数据建立。每个文件有独立许可，使用者仍需逐项保留署名、许可链接，并履行相应的相同方式共享等条件：

- [Commons：在 Wikimedia 之外再使用内容](https://commons.wikimedia.org/wiki/Commons:Reusing_content_outside_Wikimedia/en)
- [MediaWiki Imageinfo API](https://www.mediawiki.org/wiki/API:Imageinfo)
- [Wikimedia Foundation User-Agent Policy](https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_User-Agent_Policy)

Commons 元数据是来源与权利核验的证据，不是法律保证。训练运行或对外分发衍生物前，仍须依据清单中的具体许可重新确认适用义务。
