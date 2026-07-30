import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import Ajv2020 from "ajv/dist/2020.js";

const repositoryRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
const defaultDatasetDirectory = resolve(repositoryRoot, "datasets/photography-skill-v1");
const defaultManifestPath = resolve(defaultDatasetDirectory, "manifest.json");
const defaultSplitsPath = resolve(defaultDatasetDirectory, "splits.json");
const defaultAssetsDirectory = resolve(defaultDatasetDirectory, ".assets");
const defaultExposureLedgerPath = resolve(defaultDatasetDirectory, "history/exposure-ledger.json");
const defaultV2DatasetDirectory = resolve(repositoryRoot, "datasets/photography-skill-v2");
const defaultV2ManifestPath = resolve(defaultV2DatasetDirectory, "manifest.json");
const defaultV2SplitsPath = resolve(defaultV2DatasetDirectory, "splits.json");
const defaultV2AssetsDirectory = resolve(defaultV2DatasetDirectory, ".assets");
const defaultV2ExposureLedgerPath = resolve(defaultV2DatasetDirectory, "history/exposure-ledger.json");
const defaultV3DatasetDirectory = resolve(repositoryRoot, "datasets/photography-skill-v3");
const datasetSchemaPath = resolve(repositoryRoot, "schemas/skill-training-dataset.schema.json");
const splitsSchemaPath = resolve(repositoryRoot, "schemas/skill-training-splits.schema.json");
const userAgent = "ZhaojianDatasetBuilder/1.0 (https://zhaojian.app; photography Skill dataset)";
const allowedLicenses = new Set([
  "CC0 1.0",
  "CC BY 2.0",
  "CC BY 2.5",
  "CC BY 3.0",
  "CC BY 4.0",
  "CC BY-SA 2.0",
  "CC BY-SA 2.5",
  "CC BY-SA 3.0",
  "CC BY-SA 4.0",
]);
const categoryPolicy = {
  landscape_nature: { total: 25, training: 15, regression: 5, holdout: 5, personalData: "none", privacyReview: "not_applicable" },
  urban_everyday: { total: 15, training: 9, regression: 3, holdout: 3, personalData: "potential_sensitive", privacyReview: "public_context_only" },
  environmental_portrait: { total: 10, training: 6, regression: 2, holdout: 2, personalData: "person_visible", privacyReview: "public_context_only" },
  ordinary_difficult: { total: 10, training: 6, regression: 2, holdout: 2, personalData: "potential_sensitive", privacyReview: "public_context_only" },
};
const acquisitionGroups = [
  {
    category: "landscape_nature",
    count: 25,
    prefix: "landscape",
    queries: [{ query: 'filetype:bitmap incategory:"Quality images of landscapes"', count: 25 }],
  },
  {
    category: "urban_everyday",
    count: 15,
    prefix: "urban",
    queries: [{ query: 'filetype:bitmap incategory:"Quality images of streets"', count: 15 }],
  },
  {
    category: "environmental_portrait",
    count: 10,
    prefix: "portrait",
    queries: [{ query: 'filetype:bitmap incategory:"People at work"', count: 10 }],
  },
  {
    category: "ordinary_difficult",
    count: 10,
    prefix: "difficult",
    queries: [
      { query: "filetype:bitmap fog photograph", count: 3 },
      { query: "filetype:bitmap motion blur photograph", count: 3 },
      { query: "filetype:bitmap low light photograph", count: 2 },
      { query: "filetype:bitmap rain window photograph", count: 2 },
    ],
  },
];
const holdoutV2Groups = [
  {
    category: "landscape_nature",
    count: 5,
    prefix: "landscape",
    queries: [{ query: 'filetype:bitmap incategory:"Quality images of landscapes"', count: 5 }],
  },
  {
    category: "urban_everyday",
    count: 3,
    prefix: "urban",
    queries: [{ query: 'filetype:bitmap incategory:"Quality images of streets"', count: 3 }],
  },
  {
    category: "environmental_portrait",
    count: 2,
    prefix: "portrait",
    queries: [{ query: 'filetype:bitmap incategory:"People at work"', count: 2 }],
  },
  {
    category: "ordinary_difficult",
    count: 2,
    prefix: "difficult",
    queries: [
      { query: "filetype:bitmap fog photograph", count: 1 },
      { query: "filetype:bitmap \"night street\" photograph", count: 1 },
    ],
  },
];
const rejectedCandidateTitles = new Set([
  "File:Exposicion individual.jpg",
  "File:Street in Tumbes 02.jpg",
  "File:The Low Light - geograph.org.uk - 6108348.jpg",
]);
const rejectedPortraitTitles = new Set([
  "File:Geräuschemacher.jpg",
  "File:Iacobus de Cessolis, Libro di giuocho di scacchi, incunabolo, per maestro antonio miscomini, firenze 1 marzo 1493, 09 lavoratore.jpg",
  "File:Working with hammer on gravel hill.jpg",
]);

function parseArguments(values) {
  const result = { command: values[0] ?? "", flags: new Set(), options: new Map() };
  for (let index = 1; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) throw new Error(`未知参数：${value}`);
    const next = values[index + 1];
    if (next && !next.startsWith("--")) {
      result.options.set(value, next);
      index += 1;
    } else {
      result.flags.add(value);
    }
  }
  return result;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function digest(bytes, algorithm = "sha256") {
  return createHash(algorithm).update(bytes).digest("hex");
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
  }
  return value;
}

function documentHash(value) {
  const copy = structuredClone(value);
  delete copy.content_hash;
  return `sha256:${digest(Buffer.from(JSON.stringify(sortJson(copy)), "utf8"))}`;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function validateSchema(value, schemaPath, label) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(readJson(schemaPath));
  if (!validate(value)) {
    throw new Error(`${label}未通过 JSON Schema：${ajv.errorsText(validate.errors, { separator: "；" })}`);
  }
}

function safeHttpsUrl(raw, label, allowedHosts) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label}不是有效 URL。`);
  }
  assert(url.protocol === "https:", `${label}必须使用 HTTPS。`);
  assert(!url.username && !url.password, `${label}不能包含凭据。`);
  if (allowedHosts) {
    assert(allowedHosts.has(url.hostname), `${label}使用了未允许的主机：${url.hostname}`);
  }
  return url;
}

function verifyJpegHasNoPrivateMetadata(bytes, label) {
  assert(bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8, `${label}不是完整 JPEG。`);
  let offset = 2;
  while (offset + 1 < bytes.length) {
    assert(bytes[offset] === 0xff, `${label}包含无效 JPEG 标记。`);
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd9) return;
    if (marker === 0xda) {
      assert(bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9, `${label}缺少 JPEG 结束标记。`);
      return;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    assert(offset + 2 <= bytes.length, `${label}包含截断 JPEG 段。`);
    const length = bytes.readUInt16BE(offset);
    assert(length >= 2 && offset + length <= bytes.length, `${label}包含无效 JPEG 段长度。`);
    const privateMetadata = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;
    assert(!privateMetadata, `${label}仍包含 APP/COM 元数据段。`);
    offset += length;
  }
  throw new Error(`${label}缺少 JPEG 图像数据。`);
}

function sanitizeJpeg(bytes) {
  assert(bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8, "下载内容不是 JPEG。");
  const chunks = [bytes.subarray(0, 2)];
  let offset = 2;
  while (offset + 1 < bytes.length) {
    const markerStart = offset;
    assert(bytes[offset] === 0xff, "JPEG 标记不正确。");
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd9) {
      chunks.push(bytes.subarray(markerStart, offset));
      break;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      chunks.push(bytes.subarray(markerStart, offset));
      continue;
    }
    assert(offset + 2 <= bytes.length, "JPEG 段被截断。");
    const length = bytes.readUInt16BE(offset);
    assert(length >= 2 && offset + length <= bytes.length, "JPEG 段长度不正确。");
    if (marker === 0xda) {
      chunks.push(bytes.subarray(markerStart));
      break;
    }
    const privateMetadata = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;
    if (!privateMetadata) chunks.push(bytes.subarray(markerStart, offset + length));
    offset += length;
  }
  const sanitized = Buffer.concat(chunks);
  verifyJpegHasNoPrivateMetadata(sanitized, "清洗副本");
  return sanitized;
}

function rotatedDatasetValidationContext(manifest) {
  if (manifest.dataset_id === "photography-skill-v2") {
    return {
      label: "v2",
      baselineManifestPath: defaultManifestPath,
      priorManifestPaths: [defaultManifestPath],
    };
  }
  if (manifest.dataset_id === "photography-skill-v3") {
    return {
      label: "v3",
      baselineManifestPath: defaultV2ManifestPath,
      priorManifestPaths: [defaultManifestPath, defaultV2ManifestPath],
    };
  }
  return null;
}

function validateRotatedHoldoutDisjointness(manifest, exposureLedgerPath) {
  const context = rotatedDatasetValidationContext(manifest);
  if (!context) return;
  assert(existsSync(exposureLedgerPath), `${context.label} 未见保留集缺少历史暴露账本。`);
  const ledger = readJson(exposureLedgerPath);
  const baseManifest = readJson(context.baselineManifestPath);
  assert(ledger.dataset?.id === baseManifest.dataset_id
    && ledger.dataset?.version === baseManifest.dataset_version
    && ledger.dataset?.content_hash === baseManifest.content_hash,
  `${context.label} 的历史暴露账本与上一版冻结数据集不一致。`);
  assert(ledger.summary?.holdout_exposed_count === 12
    && ledger.summary?.unseen_holdout_count === 0,
  `${context.label} 建集前必须先确认上一版 12 张 holdout 已全部暴露。`);
  const historicalSourceUrls = new Set(ledger.assets.map((asset) => asset.source_url));
  const historicalContentHashes = new Set(ledger.assets.map((asset) => asset.content_hash));
  const historicalSourceSha1 = new Set();
  for (const priorManifestPath of context.priorManifestPaths) {
    for (const asset of readJson(priorManifestPath).assets) {
      historicalSourceUrls.add(asset.source_url);
      historicalContentHashes.add(asset.content_hash);
      historicalSourceSha1.add(asset.source_file_sha1);
    }
  }
  const baseById = new Map(baseManifest.assets.map((asset) => [asset.asset_id, asset]));
  const holdoutAssets = manifest.assets.filter((asset) => asset.dataset_split === "holdout");
  assert(holdoutAssets.length === 12, `${context.label} 必须包含 12 张新保留集图片。`);
  for (const asset of manifest.assets.filter((candidate) => candidate.dataset_split !== "holdout")) {
    const base = baseById.get(asset.asset_id);
    assert(base
      && base.dataset_split === asset.dataset_split
      && base.source_url === asset.source_url
      && base.content_hash === asset.content_hash,
    `${context.label} 的训练或回归资产必须保持上一版冻结快照：${asset.asset_id}`);
  }
  for (const asset of holdoutAssets) {
    assert(!historicalSourceUrls.has(asset.source_url),
      `${context.label} holdout 来源已在历史数据或暴露账本中出现：${asset.asset_id}`);
    assert(!historicalContentHashes.has(asset.content_hash),
      `${context.label} holdout 内容已在历史数据或暴露账本中出现：${asset.asset_id}`);
    assert(!historicalSourceSha1.has(asset.source_file_sha1),
      `${context.label} holdout 源文件已在历史数据集中出现：${asset.asset_id}`);
  }
}

function validateDataset(
  manifestPath,
  splitsPath,
  assetsDirectory,
  requireAssets,
  exposureLedgerPath = defaultExposureLedgerPath,
) {
  const manifest = readJson(manifestPath);
  const splits = readJson(splitsPath);
  validateSchema(manifest, datasetSchemaPath, "数据清单");
  validateSchema(splits, splitsSchemaPath, "固定分区");
  assert(manifest.content_hash === documentHash(manifest), "数据清单内容哈希不匹配。");
  assert(splits.content_hash === documentHash(splits), "固定分区内容哈希不匹配。");
  assert(manifest.dataset_id === splits.dataset_id && manifest.dataset_version === splits.dataset_version, "清单与固定分区版本不一致。");
  assert(manifest.assets.length === 60 && manifest.split_counts.total === 60, "正式摄影数据集必须恰好包含 60 项。");
  assert(manifest.split_counts.training === 36 && manifest.split_counts.regression === 12 && manifest.split_counts.holdout === 12, "正式摄影数据集必须固定为 36/12/12。");

  const ids = new Set();
  const sourceUrls = new Set();
  const hashes = new Set();
  const splitCounts = { training: 0, regression: 0, holdout: 0 };
  const categoryCounts = Object.fromEntries(Object.keys(categoryPolicy).map((key) => [key, 0]));
  const assetsById = new Map();
  for (const asset of manifest.assets) {
    assert(asset.status === "approved", `${asset.asset_id} 尚未通过来源许可门禁。`);
    assert(allowedLicenses.has(asset.license), `${asset.asset_id} 使用了未批准许可：${asset.license}`);
    safeHttpsUrl(asset.source_url, `${asset.asset_id} source_url`, new Set(["commons.wikimedia.org"]));
    safeHttpsUrl(asset.download_url, `${asset.asset_id} download_url`, new Set(["upload.wikimedia.org"]));
    safeHttpsUrl(asset.license_url, `${asset.asset_id} license_url`);
    assert(!/(unknown|anonymous|不详|未知)/iu.test(asset.author), `${asset.asset_id} 的作者信息不明确。`);
    assert(asset.attribution.includes(asset.author) && asset.attribution.includes(asset.license), `${asset.asset_id} 的署名没有包含作者与许可。`);
    assert(!ids.has(asset.asset_id), `asset_id 重复：${asset.asset_id}`);
    assert(!sourceUrls.has(asset.source_url), `来源 URL 重复：${asset.source_url}`);
    assert(!hashes.has(asset.content_hash), `清洗副本内容重复：${asset.content_hash}`);
    ids.add(asset.asset_id);
    sourceUrls.add(asset.source_url);
    hashes.add(asset.content_hash);
    assetsById.set(asset.asset_id, asset);
    splitCounts[asset.dataset_split] += 1;
    categoryCounts[asset.category] += 1;

    const expectedPolicy = categoryPolicy[asset.category];
    assert(asset.portrait_or_personal_data === expectedPolicy.personalData, `${asset.asset_id} 的人物信息标记与类别策略不一致。`);
    assert(asset.privacy_review === expectedPolicy.privacyReview, `${asset.asset_id} 的隐私复核状态与类别策略不一致。`);
    assert(asset.derivative_path === `.assets/${asset.asset_id}.jpg`, `${asset.asset_id} 的清洗副本路径不稳定。`);
    if (asset.dataset_split === "training") {
      assert(asset.allowed_usage === "training", `${asset.asset_id} 的训练用途标记不正确。`);
    } else {
      assert(asset.allowed_usage === "evaluation", `${asset.asset_id} 的评测用途标记不正确。`);
    }

    if (requireAssets) {
      const assetPath = resolve(assetsDirectory, `${asset.asset_id}.jpg`);
      const relativePath = relative(assetsDirectory, assetPath);
      assert(!relativePath.startsWith(`..${sep}`) && relativePath !== "..", `${asset.asset_id} 的本地路径越界。`);
      assert(existsSync(assetPath), `${asset.asset_id} 缺少本地清洗副本。`);
      const bytes = readFileSync(assetPath);
      verifyJpegHasNoPrivateMetadata(bytes, asset.asset_id);
      assert(`sha256:${digest(bytes)}` === asset.content_hash, `${asset.asset_id} 的本地文件哈希不匹配。`);
    }
  }

  for (const [category, policy] of Object.entries(categoryPolicy)) {
    assert(categoryCounts[category] === policy.total, `${category} 必须包含 ${policy.total} 项。`);
  }
  assert(splitCounts.training === 36 && splitCounts.regression === 12 && splitCounts.holdout === 12, "清单实际分区不是 36/12/12。");

  const frozenIds = new Set();
  for (const [split, expectedCount] of Object.entries({ training: 36, regression: 12, holdout: 12 })) {
    const partition = splits.partitions[split];
    assert(partition.length === expectedCount, `固定分区 ${split} 数量不正确。`);
    for (const assetId of partition) {
      assert(!frozenIds.has(assetId), `固定分区重复包含 ${assetId}。`);
      frozenIds.add(assetId);
      assert(assetsById.has(assetId), `固定分区引用未知资产 ${assetId}。`);
      assert(assetsById.get(assetId).dataset_split === split, `${assetId} 的清单与固定分区不一致。`);
    }
  }
  assert(frozenIds.size === 60, "固定分区没有覆盖全部 60 项。");
  validateRotatedHoldoutDisjointness(manifest, exposureLedgerPath);

  const datasetDirectory = dirname(manifestPath);
  const trackedPaths = [".assets", "raw", "downloads"].map((name) =>
    relative(repositoryRoot, resolve(datasetDirectory, name)));
  const tracked = spawnSync("git", ["ls-files", "--", ...trackedPaths], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert(tracked.status === 0, "无法检查训练图片的 Git 跟踪状态。");
  assert(tracked.stdout.trim() === "", "训练图片或原始下载文件不得进入 Git。");
  return { assetCount: manifest.assets.length, localAssetsVerified: requireAssets, contentHash: manifest.content_hash };
}

function decodeHtml(value) {
  return String(value ?? "")
    .replace(/<[^>]*>/gu, " ")
    .replace(/&#x([0-9a-f]+);/giu, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#([0-9]+);/gu, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&quot;/giu, "\"")
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizeAuthor(raw) {
  let author = decodeHtml(raw).replace(/\(\s*more photos\s*\)/giu, "").replace(/\s+/gu, " ").trim();
  const userMatch = author.match(/(?:w:)?User:([^\s)]+)/iu);
  if (/^me\b/iu.test(author) && userMatch) author = userMatch[1];
  author = author.replace(/^User:/iu, "").trim();
  return author;
}

function normalizeLicenseUrl(raw) {
  if (!raw) return null;
  const value = raw.startsWith("//") ? `https:${raw}` : raw.replace(/^http:/u, "https:");
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

async function fetchWithRetry(url, options, attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, options);
      if (response.ok || (response.status !== 429 && response.status < 500)) return response;
      lastError = new Error(`远端返回 ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500 * attempt));
    }
  }
  throw lastError ?? new Error("网络请求失败。");
}

async function searchCommons(query) {
  const url = new URL("https://commons.wikimedia.org/w/api.php");
  const parameters = {
    action: "query",
    format: "json",
    generator: "search",
    gsrnamespace: "6",
    gsrsearch: query,
    gsrlimit: "50",
    prop: "imageinfo",
    iiprop: "url|extmetadata|mime|size|sha1",
    iiurlwidth: "1600",
    iiextmetadatalanguage: "en",
    origin: "*",
  };
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
  const response = await fetchWithRetry(url, { headers: { "User-Agent": userAgent } });
  assert(response.ok, `Wikimedia Commons API 返回 ${response.status}。`);
  const body = await response.json();
  return Object.values(body.query?.pages ?? {}).sort((left, right) => (left.index ?? left.pageid) - (right.index ?? right.pageid));
}

function candidateMetadata(page, category) {
  const info = page.imageinfo?.[0];
  if (!info
    || rejectedCandidateTitles.has(page.title)
    || info.mime !== "image/jpeg"
    || !info.thumburl
    || !info.descriptionurl
    || !/^[a-f0-9]{40}$/u.test(info.sha1 ?? "")) return null;
  if ((info.width ?? 0) < 640 || (info.height ?? 0) < 480) return null;
  const metadata = info.extmetadata ?? {};
  const license = decodeHtml(metadata.LicenseShortName?.value);
  const licenseUrl = normalizeLicenseUrl(metadata.LicenseUrl?.value);
  const author = normalizeAuthor(metadata.Artist?.value);
  if (!allowedLicenses.has(license) || !licenseUrl || !author || author.length > 500 || /(unknown|anonymous|不详|未知)/iu.test(author)) return null;
  if (category === "environmental_portrait"
    && (rejectedPortraitTitles.has(page.title)
      || /Dr296.*Hällestad.*16000300013174/iu.test(page.title)
      || /(painting|drawing|statue|sculpture|poster|map|diagram|logo|incunabolo)/iu.test(page.title))) return null;
  safeHttpsUrl(info.descriptionurl, "Commons 来源", new Set(["commons.wikimedia.org"]));
  safeHttpsUrl(info.thumburl, "Commons 下载地址", new Set(["upload.wikimedia.org"]));
  return {
    sourceUrl: info.descriptionurl,
    downloadUrl: info.thumburl,
    author,
    license,
    licenseUrl,
    sourceFileSha1: info.sha1,
  };
}

async function downloadSanitizedJpeg(url) {
  safeHttpsUrl(url, "Commons 下载地址", new Set(["upload.wikimedia.org"]));
  const response = await fetchWithRetry(url, { headers: { "User-Agent": userAgent }, redirect: "error" });
  assert(response.ok, `图片下载返回 ${response.status}。`);
  const contentType = response.headers.get("content-type")?.split(";")[0].trim();
  assert(contentType === "image/jpeg", `图片响应类型不是 JPEG：${contentType}`);
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  assert(!declaredLength || declaredLength <= 8 * 1024 * 1024, "图片响应超过 8 MiB 上限。");
  const bytes = Buffer.from(await response.arrayBuffer());
  assert(bytes.length <= 8 * 1024 * 1024, "图片内容超过 8 MiB 上限。");
  return sanitizeJpeg(bytes);
}

function splitForIndex(category, index) {
  const policy = categoryPolicy[category];
  if (index < policy.training) return "training";
  if (index < policy.training + policy.regression) return "regression";
  return "holdout";
}

async function seedDataset(manifestPath, splitsPath, assetsDirectory, datasetVersion) {
  mkdirSync(assetsDirectory, { recursive: true });
  const cachedBySource = existsSync(manifestPath)
    ? new Map(readJson(manifestPath).assets.map((asset) => [asset.source_url, asset]))
    : new Map();
  const usedSources = new Set();
  const usedHashes = new Set();
  const assets = [];
  const timestamp = new Date().toISOString();

  for (const group of acquisitionGroups) {
    let groupIndex = 0;
    for (const query of group.queries) {
      const pages = await searchCommons(query.query);
      let acceptedForQuery = 0;
      for (const page of pages) {
        if (acceptedForQuery >= query.count || groupIndex >= group.count) break;
        const source = candidateMetadata(page, group.category);
        if (!source || usedSources.has(source.sourceUrl)) continue;
        try {
          const assetId = `photo-v1-${group.prefix}-${String(groupIndex + 1).padStart(3, "0")}`;
          const cached = cachedBySource.get(source.sourceUrl);
          const cachedPath = resolve(assetsDirectory, `${assetId}.jpg`);
          let bytes;
          if (cached?.asset_id === assetId
            && cached.source_file_sha1 === source.sourceFileSha1
            && existsSync(cachedPath)) {
            bytes = readFileSync(cachedPath);
            verifyJpegHasNoPrivateMetadata(bytes, assetId);
            assert(`sha256:${digest(bytes)}` === cached.content_hash, `${assetId} 的缓存哈希不匹配。`);
          } else {
            bytes = await downloadSanitizedJpeg(source.downloadUrl);
          }
          const contentHash = `sha256:${digest(bytes)}`;
          if (usedHashes.has(contentHash)) continue;
          const split = splitForIndex(group.category, groupIndex);
          const policy = categoryPolicy[group.category];
          writeFileSync(resolve(assetsDirectory, `${assetId}.jpg`), bytes);
          assets.push({
            asset_id: assetId,
            source_url: source.sourceUrl,
            download_url: source.downloadUrl,
            author: source.author,
            license: source.license,
            license_url: source.licenseUrl,
            source_kind: "open_license",
            allowed_usage: split === "training" ? "training" : "evaluation",
            attribution: `${source.author} · ${source.license} · ${source.sourceUrl}`,
            source_file_sha1: source.sourceFileSha1,
            content_hash: contentHash,
            downloaded_at: timestamp,
            rights_verified_at: timestamp,
            portrait_or_personal_data: policy.personalData,
            privacy_review: policy.privacyReview,
            derivative_path: `.assets/${assetId}.jpg`,
            dataset_split: split,
            category: group.category,
            status: "approved",
          });
          usedSources.add(source.sourceUrl);
          usedHashes.add(contentHash);
          groupIndex += 1;
          acceptedForQuery += 1;
          process.stdout.write(`已获取 ${assetId}\n`);
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 75));
        } catch (error) {
          process.stderr.write(`跳过一个不满足门禁的候选：${error.message}\n`);
        }
      }
      assert(acceptedForQuery === query.count, `${group.category} 的查询未获得足够合格图片。`);
    }
    assert(groupIndex === group.count, `${group.category} 未达到 ${group.count} 张。`);
  }

  const manifest = {
    schema_version: "1.1",
    dataset_id: "photography-skill-v1",
    dataset_version: datasetVersion,
    description: "照见 1.0 的 60 张来源明确真实摄影图片清单；图片副本仅保存在本地忽略目录。",
    created_at: timestamp,
    content_hash: "sha256:pending",
    split_counts: { training: 36, regression: 12, holdout: 12, total: 60 },
    assets,
  };
  manifest.content_hash = documentHash(manifest);
  const splits = {
    schema_version: "1.0",
    dataset_id: manifest.dataset_id,
    dataset_version: manifest.dataset_version,
    frozen: true,
    frozen_at: timestamp,
    content_hash: "sha256:pending",
    partitions: {
      training: assets.filter((asset) => asset.dataset_split === "training").map((asset) => asset.asset_id),
      regression: assets.filter((asset) => asset.dataset_split === "regression").map((asset) => asset.asset_id),
      holdout: assets.filter((asset) => asset.dataset_split === "holdout").map((asset) => asset.asset_id),
    },
  };
  splits.content_hash = documentHash(splits);
  writeJson(manifestPath, manifest);
  writeJson(splitsPath, splits);
  return validateDataset(manifestPath, splitsPath, assetsDirectory, true);
}

async function seedRotatedHoldout(
  manifestPath,
  splitsPath,
  assetsDirectory,
  datasetVersion,
  exposureLedgerPath,
  rotation,
) {
  assert(datasetVersion === rotation.expectedVersion,
    `${rotation.label} 未见保留集版本固定为 ${rotation.expectedVersion}。`);
  assert(!existsSync(manifestPath) && !existsSync(splitsPath),
    `${rotation.label} 冻结清单已经存在；不得原地重建或调换保留集。`);
  const baseManifest = readJson(rotation.baseManifestPath);
  const baseSplits = readJson(rotation.baseSplitsPath);
  validateDataset(
    rotation.baseManifestPath,
    rotation.baseSplitsPath,
    rotation.baseAssetsDirectory,
    false,
    rotation.baseValidationExposureLedgerPath,
  );
  const ledger = readJson(exposureLedgerPath);
  assert(ledger.dataset?.id === baseManifest.dataset_id
    && ledger.dataset?.version === baseManifest.dataset_version
    && ledger.dataset?.content_hash === baseManifest.content_hash
    && ledger.summary?.holdout_exposed_count === 12
    && ledger.summary?.unseen_holdout_count === 0,
  `只有在上一版 12 张 holdout 已全部暴露时才能建立 ${rotation.label} 未见集。`);

  mkdirSync(assetsDirectory, { recursive: true });
  const timestamp = new Date().toISOString();
  const assets = [];
  const retainedIds = [
    ...baseSplits.partitions.training,
    ...baseSplits.partitions.regression,
  ];
  const baseById = new Map(baseManifest.assets.map((asset) => [asset.asset_id, asset]));
  for (const assetId of retainedIds) {
    const asset = baseById.get(assetId);
    assert(asset, `上一版固定分区引用未知资产：${assetId}`);
    const sourcePath = resolve(rotation.baseAssetsDirectory, `${assetId}.jpg`);
    let bytes;
    if (existsSync(sourcePath)) {
      bytes = readFileSync(sourcePath);
      verifyJpegHasNoPrivateMetadata(bytes, assetId);
      assert(`sha256:${digest(bytes)}` === asset.content_hash, `${assetId} 的上一版本地哈希不匹配。`);
    } else {
      bytes = await downloadSanitizedJpeg(asset.download_url);
      assert(`sha256:${digest(bytes)}` === asset.content_hash, `${assetId} 的远端副本与上一版冻结哈希不一致。`);
    }
    writeFileSync(resolve(assetsDirectory, `${assetId}.jpg`), bytes);
    assets.push(structuredClone(asset));
  }

  const usedSources = new Set();
  const usedSourceSha1 = new Set();
  const usedHashes = new Set();
  for (const priorManifestPath of rotation.priorManifestPaths) {
    for (const asset of readJson(priorManifestPath).assets) {
      usedSources.add(asset.source_url);
      usedSourceSha1.add(asset.source_file_sha1);
      usedHashes.add(asset.content_hash);
    }
  }
  const holdoutAssets = [];
  for (const group of holdoutV2Groups) {
    let groupIndex = 0;
    for (const query of group.queries) {
      const pages = await searchCommons(query.query);
      let acceptedForQuery = 0;
      for (const page of pages) {
        if (acceptedForQuery >= query.count || groupIndex >= group.count) break;
        const source = candidateMetadata(page, group.category);
        if (!source
          || usedSources.has(source.sourceUrl)
          || usedSourceSha1.has(source.sourceFileSha1)) continue;
        try {
          const bytes = await downloadSanitizedJpeg(source.downloadUrl);
          const contentHash = `sha256:${digest(bytes)}`;
          if (usedHashes.has(contentHash)) continue;
          const assetId = `photo-${rotation.assetPrefix}-${group.prefix}-${String(groupIndex + 1).padStart(3, "0")}`;
          const policy = categoryPolicy[group.category];
          writeFileSync(resolve(assetsDirectory, `${assetId}.jpg`), bytes);
          holdoutAssets.push({
            asset_id: assetId,
            source_url: source.sourceUrl,
            download_url: source.downloadUrl,
            author: source.author,
            license: source.license,
            license_url: source.licenseUrl,
            source_kind: "open_license",
            allowed_usage: "evaluation",
            attribution: `${source.author} · ${source.license} · ${source.sourceUrl}`,
            source_file_sha1: source.sourceFileSha1,
            content_hash: contentHash,
            downloaded_at: timestamp,
            rights_verified_at: timestamp,
            portrait_or_personal_data: policy.personalData,
            privacy_review: policy.privacyReview,
            derivative_path: `.assets/${assetId}.jpg`,
            dataset_split: "holdout",
            category: group.category,
            status: "approved",
          });
          usedSources.add(source.sourceUrl);
          usedSourceSha1.add(source.sourceFileSha1);
          usedHashes.add(contentHash);
          groupIndex += 1;
          acceptedForQuery += 1;
          process.stdout.write(`已获取未见保留集 ${assetId}\n`);
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 75));
        } catch (error) {
          process.stderr.write(`跳过一个不满足未见集门禁的候选：${error.message}\n`);
        }
      }
      assert(acceptedForQuery === query.count, `${group.category} 的未见集查询未获得足够合格图片。`);
    }
    assert(groupIndex === group.count, `${group.category} 的 ${rotation.label} holdout 数量不足。`);
  }
  assert(holdoutAssets.length === 12, `${rotation.label} 必须获得 12 张新 holdout。`);
  assets.push(...holdoutAssets);

  const manifest = {
    schema_version: "1.1",
    dataset_id: rotation.datasetId,
    dataset_version: datasetVersion,
    description: rotation.description,
    created_at: timestamp,
    content_hash: "sha256:pending",
    split_counts: { training: 36, regression: 12, holdout: 12, total: 60 },
    assets,
  };
  manifest.content_hash = documentHash(manifest);
  const splits = {
    schema_version: "1.0",
    dataset_id: manifest.dataset_id,
    dataset_version: manifest.dataset_version,
    frozen: true,
    frozen_at: timestamp,
    content_hash: "sha256:pending",
    partitions: {
      training: [...baseSplits.partitions.training],
      regression: [...baseSplits.partitions.regression],
      holdout: holdoutAssets.map((asset) => asset.asset_id),
    },
  };
  splits.content_hash = documentHash(splits);
  writeJson(manifestPath, manifest);
  writeJson(splitsPath, splits);
  return validateDataset(
    manifestPath,
    splitsPath,
    assetsDirectory,
    true,
    exposureLedgerPath,
  );
}

async function seedHoldoutV2(
  manifestPath,
  splitsPath,
  assetsDirectory,
  datasetVersion,
  exposureLedgerPath,
) {
  return seedRotatedHoldout(
    manifestPath,
    splitsPath,
    assetsDirectory,
    datasetVersion,
    exposureLedgerPath,
    {
      label: "v2",
      expectedVersion: "2.0.0",
      datasetId: "photography-skill-v2",
      assetPrefix: "v2",
      baseManifestPath: defaultManifestPath,
      baseSplitsPath: defaultSplitsPath,
      baseAssetsDirectory: defaultAssetsDirectory,
      baseValidationExposureLedgerPath: defaultExposureLedgerPath,
      priorManifestPaths: [defaultManifestPath],
      description: "照见 2.0 的 60 张冻结评测清单：沿用 v1 的 36 张训练与 12 张回归，并加入 12 张未进入历史运行的新保留集。",
    },
  );
}

async function seedHoldoutV3(
  manifestPath,
  splitsPath,
  assetsDirectory,
  datasetVersion,
  exposureLedgerPath,
) {
  return seedRotatedHoldout(
    manifestPath,
    splitsPath,
    assetsDirectory,
    datasetVersion,
    exposureLedgerPath,
    {
      label: "v3",
      expectedVersion: "3.0.0",
      datasetId: "photography-skill-v3",
      assetPrefix: "v3",
      baseManifestPath: defaultV2ManifestPath,
      baseSplitsPath: defaultV2SplitsPath,
      baseAssetsDirectory: defaultV2AssetsDirectory,
      baseValidationExposureLedgerPath: defaultExposureLedgerPath,
      priorManifestPaths: [defaultManifestPath, defaultV2ManifestPath],
      description: "照见 3.0 的 60 张冻结评测清单：沿用 v2 的 36 张训练与 12 张回归，并轮换 12 张未进入历史运行的新保留集。",
    },
  );
}

async function hydrateFrozenDataset(manifestPath, splitsPath, assetsDirectory) {
  assert(existsSync(manifestPath) && existsSync(splitsPath), "冻结清单不存在；首次建集请显式运行 seed 命令。");
  validateDataset(manifestPath, splitsPath, assetsDirectory, false);
  const manifest = readJson(manifestPath);
  mkdirSync(assetsDirectory, { recursive: true });

  for (const asset of manifest.assets) {
    const assetPath = resolve(assetsDirectory, `${asset.asset_id}.jpg`);
    let localIsValid = false;
    if (existsSync(assetPath)) {
      try {
        const bytes = readFileSync(assetPath);
        verifyJpegHasNoPrivateMetadata(bytes, asset.asset_id);
        localIsValid = `sha256:${digest(bytes)}` === asset.content_hash;
      } catch {
        localIsValid = false;
      }
    }
    if (localIsValid) {
      process.stdout.write(`已确认 ${asset.asset_id}\n`);
      continue;
    }

    const bytes = await downloadSanitizedJpeg(asset.download_url);
    assert(`sha256:${digest(bytes)}` === asset.content_hash, `${asset.asset_id} 的远端副本与冻结哈希不一致。`);
    writeFileSync(assetPath, bytes);
    process.stdout.write(`已恢复 ${asset.asset_id}\n`);
  }

  return validateDataset(manifestPath, splitsPath, assetsDirectory, true);
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const v2Command = args.command === "seed-holdout-v2";
  const v3Command = args.command === "seed-holdout-v3";
  const rotatedDatasetDirectory = v3Command
    ? defaultV3DatasetDirectory
    : defaultV2DatasetDirectory;
  const manifestPath = resolve(args.options.get("--manifest")
    ?? (v2Command || v3Command ? resolve(rotatedDatasetDirectory, "manifest.json") : defaultManifestPath));
  const splitsPath = resolve(args.options.get("--splits")
    ?? (v2Command || v3Command ? resolve(rotatedDatasetDirectory, "splits.json") : defaultSplitsPath));
  const assetsDirectory = resolve(args.options.get("--assets-dir")
    ?? (v2Command || v3Command ? resolve(rotatedDatasetDirectory, ".assets") : defaultAssetsDirectory));
  const usesV3Manifest = existsSync(manifestPath)
    && readJson(manifestPath).dataset_id === "photography-skill-v3";
  const exposureLedgerPath = resolve(
    args.options.get("--exposure-ledger")
      ?? (v3Command || usesV3Manifest ? defaultV2ExposureLedgerPath : defaultExposureLedgerPath),
  );
  if (args.command === "validate") {
    const requireAssets = !args.flags.has("--manifest-only") && existsSync(assetsDirectory);
    const result = validateDataset(
      manifestPath,
      splitsPath,
      assetsDirectory,
      requireAssets,
      exposureLedgerPath,
    );
    process.stdout.write(`${JSON.stringify({ status: "ok", ...result })}\n`);
    return;
  }
  if (args.command === "acquire") {
    assert(args.flags.has("--allow-download"), "下载必须显式传入 --allow-download。");
    const result = await hydrateFrozenDataset(manifestPath, splitsPath, assetsDirectory);
    process.stdout.write(`${JSON.stringify({ status: "ok", ...result })}\n`);
    return;
  }
  if (args.command === "seed") {
    assert(args.flags.has("--allow-download"), "下载必须显式传入 --allow-download。");
    assert(args.flags.has("--allow-reseed"), "重建冻结清单必须显式传入 --allow-reseed。");
    const datasetVersion = args.options.get("--dataset-version");
    assert(datasetVersion && /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(datasetVersion), "重建冻结清单必须显式传入有效的 --dataset-version。");
    if (existsSync(manifestPath)) {
      assert(readJson(manifestPath).dataset_version !== datasetVersion, "重建冻结清单必须使用新的数据集版本。");
    }
    const result = await seedDataset(manifestPath, splitsPath, assetsDirectory, datasetVersion);
    process.stdout.write(`${JSON.stringify({ status: "ok", ...result })}\n`);
    return;
  }
  if (args.command === "seed-holdout-v2") {
    assert(args.flags.has("--allow-download"), "下载未见保留集必须显式传入 --allow-download。");
    assert(args.flags.has("--allow-reseed"), "建立新冻结版本必须显式传入 --allow-reseed。");
    const datasetVersion = args.options.get("--dataset-version");
    assert(datasetVersion, "建立新保留集必须显式传入 --dataset-version 2.0.0。");
    const result = await seedHoldoutV2(
      manifestPath,
      splitsPath,
      assetsDirectory,
      datasetVersion,
      exposureLedgerPath,
    );
    process.stdout.write(`${JSON.stringify({ status: "ok", ...result })}\n`);
    return;
  }
  if (args.command === "seed-holdout-v3") {
    assert(args.flags.has("--allow-download"), "下载未见保留集必须显式传入 --allow-download。");
    assert(args.flags.has("--allow-reseed"), "建立新冻结版本必须显式传入 --allow-reseed。");
    const datasetVersion = args.options.get("--dataset-version");
    assert(datasetVersion, "建立新保留集必须显式传入 --dataset-version 3.0.0。");
    const result = await seedHoldoutV3(
      manifestPath,
      splitsPath,
      assetsDirectory,
      datasetVersion,
      exposureLedgerPath,
    );
    process.stdout.write(`${JSON.stringify({ status: "ok", ...result })}\n`);
    return;
  }
  throw new Error("用法：node scripts/dataset-tools.mjs <validate|acquire|seed|seed-holdout-v2|seed-holdout-v3> [--allow-download] [--allow-reseed] [--dataset-version x.y.z] [--manifest-only]");
}

main().catch((error) => {
  process.stderr.write(`数据集命令失败：${error.message}\n`);
  process.exitCode = 1;
});
