import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

type JsonObject = Record<string, unknown>;

const scriptPath = resolve("scripts/dataset-tools.mjs");
const manifestPath = resolve("datasets/photography-skill-v1/manifest.json");
const splitsPath = resolve("datasets/photography-skill-v1/splits.json");
const v2ManifestPath = resolve("datasets/photography-skill-v2/manifest.json");
const v2SplitsPath = resolve("datasets/photography-skill-v2/splits.json");
const v3ManifestPath = resolve("datasets/photography-skill-v3/manifest.json");
const v3SplitsPath = resolve("datasets/photography-skill-v3/splits.json");
const v2ExposureLedgerPath = resolve("datasets/photography-skill-v2/history/exposure-ledger.json");

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as JsonObject)
        .sort()
        .map((key) => [key, sortJson((value as JsonObject)[key])]),
    );
  }
  return value;
}

function refreshDocumentHash(value: JsonObject): void {
  const copy = structuredClone(value);
  delete copy.content_hash;
  const payload = JSON.stringify(sortJson(copy));
  value.content_hash = `sha256:${createHash("sha256").update(payload, "utf8").digest("hex")}`;
}

function runValidator(manifest: string, splits: string, exposureLedger?: string) {
  const args = [scriptPath, "validate", "--manifest", manifest, "--splits", splits, "--manifest-only"];
  if (exposureLedger) args.push("--exposure-ledger", exposureLedger);
  return spawnSync(
    process.execPath,
    args,
    { cwd: resolve("."), encoding: "utf8" },
  );
}

describe("摄影 Skill 数据集门禁", () => {
  it("正式 60 图清单与冻结分区通过离线校验", () => {
    const result = runValidator(manifestPath, splitsPath);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "ok",
      assetCount: 60,
      localAssetsVerified: false,
    });
  });

  it("v2 沿用 48 张固定资产并保留 12 张历史不相交 holdout", () => {
    const result = runValidator(v2ManifestPath, v2SplitsPath);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "ok",
      assetCount: 60,
      localAssetsVerified: false,
    });

    const v1 = JSON.parse(readFileSync(manifestPath, "utf8")) as JsonObject;
    const v2 = JSON.parse(readFileSync(v2ManifestPath, "utf8")) as JsonObject;
    const v1Assets = v1.assets as JsonObject[];
    const v2Holdout = (v2.assets as JsonObject[])
      .filter((asset) => asset.dataset_split === "holdout");
    const historicalSources = new Set(v1Assets.map((asset) => asset.source_url));
    const historicalHashes = new Set(v1Assets.map((asset) => asset.content_hash));
    const historicalSha1 = new Set(v1Assets.map((asset) => asset.source_file_sha1));

    expect(v2Holdout).toHaveLength(12);
    expect(v2Holdout.every((asset) => !historicalSources.has(asset.source_url))).toBe(true);
    expect(v2Holdout.every((asset) => !historicalHashes.has(asset.content_hash))).toBe(true);
    expect(v2Holdout.every((asset) => !historicalSha1.has(asset.source_file_sha1))).toBe(true);
  });

  it("v3 沿用 v2 的 48 张开发资产并轮换 12 张再次未见的 holdout", () => {
    const result = runValidator(v3ManifestPath, v3SplitsPath, v2ExposureLedgerPath);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "ok",
      assetCount: 60,
      localAssetsVerified: false,
      contentHash: "sha256:887c338ab37c715e087822db8d73d7253485dbcc522f5126b573c57f31efb335",
    });

    const v1 = JSON.parse(readFileSync(manifestPath, "utf8")) as JsonObject;
    const v2 = JSON.parse(readFileSync(v2ManifestPath, "utf8")) as JsonObject;
    const v3 = JSON.parse(readFileSync(v3ManifestPath, "utf8")) as JsonObject;
    const v2ById = new Map(
      (v2.assets as JsonObject[]).map((asset) => [asset.asset_id, asset]),
    );
    const v3DevelopmentAssets = (v3.assets as JsonObject[])
      .filter((asset) => asset.dataset_split !== "holdout");
    const v3Holdout = (v3.assets as JsonObject[])
      .filter((asset) => asset.dataset_split === "holdout");
    const historicalAssets = [
      ...(v1.assets as JsonObject[]),
      ...(v2.assets as JsonObject[]),
    ];
    const historicalSources = new Set(historicalAssets.map((asset) => asset.source_url));
    const historicalHashes = new Set(historicalAssets.map((asset) => asset.content_hash));
    const historicalSha1 = new Set(historicalAssets.map((asset) => asset.source_file_sha1));

    expect(v3DevelopmentAssets).toHaveLength(48);
    for (const asset of v3DevelopmentAssets) {
      expect(asset).toMatchObject(v2ById.get(asset.asset_id) as JsonObject);
    }
    expect(v3Holdout).toHaveLength(12);
    expect(v3Holdout.every((asset) => !historicalSources.has(asset.source_url))).toBe(true);
    expect(v3Holdout.every((asset) => !historicalHashes.has(asset.content_hash))).toBe(true);
    expect(v3Holdout.every((asset) => !historicalSha1.has(asset.source_file_sha1))).toBe(true);
  });

  it("拒绝使用不同 asset_id 包装相同清洗图片", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "zhaojian-dataset-"));
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as JsonObject;
      const assets = manifest.assets as JsonObject[];
      assets[1].content_hash = assets[0].content_hash;
      refreshDocumentHash(manifest);
      const mutatedManifestPath = resolve(directory, "manifest.json");
      writeFileSync(mutatedManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

      const result = runValidator(mutatedManifestPath, splitsPath);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("清洗副本内容重复");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("拒绝清单与冻结分区发生漂移", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "zhaojian-dataset-"));
    try {
      const splits = JSON.parse(readFileSync(splitsPath, "utf8")) as JsonObject;
      const partitions = splits.partitions as Record<string, string[]>;
      [partitions.training[0], partitions.regression[0]] = [partitions.regression[0], partitions.training[0]];
      refreshDocumentHash(splits);
      const mutatedSplitsPath = resolve(directory, "splits.json");
      writeFileSync(mutatedSplitsPath, `${JSON.stringify(splits, null, 2)}\n`, "utf8");

      const result = runValidator(manifestPath, mutatedSplitsPath);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("清单与固定分区不一致");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("没有显式下载授权时不会进入外部获取流程", () => {
    const result = spawnSync(process.execPath, [scriptPath, "acquire"], {
      cwd: resolve("."),
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("下载必须显式传入 --allow-download");
  });

  it("重建清单必须显式提供新的数据集版本", () => {
    const result = spawnSync(
      process.execPath,
      [scriptPath, "seed", "--allow-download", "--allow-reseed"],
      { cwd: resolve("."), encoding: "utf8" },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("必须显式传入有效的 --dataset-version");
  });

  it("建立新 holdout 也必须显式授权下载与冻结版本", () => {
    const result = spawnSync(process.execPath, [scriptPath, "seed-holdout-v2"], {
      cwd: resolve("."),
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("下载未见保留集必须显式传入");
  });

  it("建立 v3 holdout 同样必须显式授权下载", () => {
    const result = spawnSync(process.execPath, [scriptPath, "seed-holdout-v3"], {
      cwd: resolve("."),
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("下载未见保留集必须显式传入");
  });

  it("v2 拒绝把历史来源重新包装成新 holdout", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "zhaojian-dataset-v2-"));
    try {
      const v1 = JSON.parse(readFileSync(manifestPath, "utf8")) as JsonObject;
      const v2 = JSON.parse(readFileSync(v2ManifestPath, "utf8")) as JsonObject;
      const oldHoldout = (v1.assets as JsonObject[])
        .find((asset) => asset.asset_id === "photo-v1-landscape-021") as JsonObject;
      const assets = v2.assets as JsonObject[];
      const newHoldout = assets.find(
        (asset) => asset.asset_id === "photo-v2-landscape-001",
      ) as JsonObject;
      for (const field of [
        "source_url",
        "download_url",
        "author",
        "license",
        "license_url",
        "attribution",
        "source_file_sha1",
        "content_hash",
      ]) {
        newHoldout[field] = oldHoldout[field];
      }
      refreshDocumentHash(v2);
      const mutatedManifestPath = resolve(directory, "manifest.json");
      writeFileSync(mutatedManifestPath, `${JSON.stringify(v2, null, 2)}\n`, "utf8");

      const result = runValidator(mutatedManifestPath, v2SplitsPath);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("holdout 来源已在历史数据或暴露账本中出现");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("人物样本不携带身份或故事标签", () => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as JsonObject;
    const assets = manifest.assets as JsonObject[];
    const personAssets = assets.filter((asset) => asset.category === "environmental_portrait");

    expect(personAssets).toHaveLength(10);
    for (const asset of personAssets) {
      expect(asset.portrait_or_personal_data).toBe("person_visible");
      expect(Object.keys(asset)).not.toContain("identity");
      expect(Object.keys(asset)).not.toContain("person_name");
      expect(Object.keys(asset)).not.toContain("story");
    }
  });
});
