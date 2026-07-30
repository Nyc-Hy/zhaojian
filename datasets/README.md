# 摄影数据集公开边界

`photography-skill-v1`、`v2` 和 `v3` 是照见固定摄影评测集的三个冻结版本。仓库公开可复核的来源与训练审计，不公开照片文件。

## Git 中包含

- `manifest.json`：逐项来源、作者、许可、署名、哈希、用途和人物/隐私复核标记；
- `splits.json`：固定训练、回归和保留集分区；
- `history/exposure-ledger.json`：样本是否暴露给 Provider、是否可能影响迭代的审计；
- `history/failure-corpus.json`：脱敏失败分类、报告哈希和重放证据。

训练历史可能公开 Provider、模型、运行 ID、时间、失败分类和费用估算，以支持结果复核。它不得包含图片、Base64、密钥、用户原话、可识别个人信息或模型内部推理。

## Git 中不包含

- `.assets/` 下载和清洗后的真实图片；
- `raw/` 或 `downloads/` 临时文件；
- 用户上传图片、数据库、日志或模型密钥。

这些目录由 `.gitignore` 排除。不得使用 `git add -f` 绕过边界。

## 许可与人物边界

图片来自 Wikimedia Commons 等外部来源，每项分别适用 `manifest.json` 中记录的 Creative Commons 许可证。根目录 Apache-2.0 只覆盖项目自有代码和文档，不覆盖摄影作品。

使用者必须逐项：

1. 核对来源页和当前许可状态；
2. 保留作者署名、来源链接和许可证链接；
3. 标明修改或清洗；
4. 履行 CC BY-SA 的相同方式共享义务；
5. 单独判断隐私、肖像权、平台条款和所在地区法律。

`public_context_only` 不是人物同意书。清单包含人物的可见关系样本，但不应进行身份、健康、民族、住址或故事推断。发现权利争议时，应先隔离对应资产并产生新的冻结版本。

完整说明见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。
