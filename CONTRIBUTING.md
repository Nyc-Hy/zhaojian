# 为照见贡献

感谢你愿意帮助照见。项目欢迎代码、文档、测试、摄影知识和可复现问题报告，但人的感受与选择始终高于算法裁判。

## 贡献前提

- AI 提供可能性，不宣布唯一正确答案。
- 不为照片、构图或摄影者显示单一审美分数或排名。
- 曝光与器材参数必须来自可测试的确定性规则。
- 模型输出必须经过 Schema、枚举、范围和业务规则校验。
- 不提交无法确认授权的图片、人物隐私数据、密钥、数据库或真实用户内容。
- 新功能改变产品边界前，先更新范围或决策文档。

提交贡献即表示你有权提交相关内容。除非明确书面声明，提交给本项目并被接纳的贡献按 [Apache License 2.0](LICENSE) 第 5 节处理；第三方内容必须保留原许可证和署名。

## 本地开发

环境要求：.NET SDK 10、Node.js 20 或更高版本、npm 10 或更高版本。

```bash
npm install
npm run dev
```

默认开发和 CI 使用 Mock，不读取图片内容，也不会调用外部模型。请勿为了运行测试而配置真实模型密钥。

## 提交变更

1. 从最新默认分支创建短生命周期分支。
2. 保持一次提交聚焦一个可解释目标。
3. 新增界面文字、文档、提示词和注释默认使用中文。
4. Schema 变更同步更新 `examples/` 和测试。
5. 参数引擎变更补充边界值和摄影场景测试。
6. AI 提示词或 Skill 变更使用固定评测集比较，不以单个漂亮示例下结论。
7. Pull Request 说明问题、取舍、用户影响、验证结果和仍存在的限制。

常用验证：

```bash
npm run validate:schema
npm run skill:validate
npm test
npm run test:api
npm run verify
```

如果使用本机 Klari 知识库，代码或文档变化后运行：

```bash
npm run klari:refresh
npm run klari:validate
```

`.klari/` 是本机生成物，不得提交。工作树未提交时，Klari 可能继续报告 Git 基线 `stale`，请在 Pull Request 中如实说明。

## 隐私、密钥与真实模型

- `.env`、User Secrets、`App_Data/`、`.local/`、数据库和图片素材不得进入 Git。
- Issue、Pull Request、测试夹具和日志不得包含真实密钥、用户图片、GPS、完整 EXIF、用户原话或可识别个人信息。
- 真实模型调用必须由操作者明确授权费用和网络访问，不得作为普通测试或 CI 的隐含步骤。
- 数据集只提交清单、分区和符合边界的审计元数据；真实图片留在已忽略的 `.assets/`。
- 第三方图片和依赖遵循 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 问题分流

- 一般缺陷与功能建议：GitHub Issues。
- 安全、隐私和未公开漏洞：按 [SECURITY.md](SECURITY.md) 私密报告。
- 使用问题与支持边界：见 [SUPPORT.md](SUPPORT.md)。
- 社区互动：遵守 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。
