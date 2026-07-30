export type SensorPreset = "full_frame" | "aps_c" | "micro_four_thirds" | "custom";

export type VerifiedCameraSpecs = {
  verifiedAt: string;
  source: { label: string; url: string };
  mount: string;
  effectiveMegapixels: number;
  sensor: {
    preset: SensorPreset;
    formatLabel: string;
    width: number;
    height: number;
    cropFactor: number;
  };
  iso: {
    nativeMin: number;
    nativeMax: number;
    extendedMin?: number;
    extendedMax?: number;
  };
  shutter: {
    mechanicalShortestSeconds: number;
    electronicShortestSeconds?: number;
    longestSeconds: number;
    bulb: boolean;
    note?: string;
  };
  stabilization: {
    kind: "ibis" | "none";
    axes?: number;
    claimedStops?: number;
    note: string;
  };
};

export type CameraCatalogItem = {
  id: string;
  label: string;
  aliases: string[];
  /**
   * 只有逐项对照厂商官方规格页的数据才放入 specs。
   * 没有 specs 的条目只用于型号搜索，不能自动参与参数计算。
   */
  specs?: VerifiedCameraSpecs;
};

const verifiedAt = "2026-07-16";

export const cameraCatalog: CameraCatalogItem[] = [
  {
    id: "sony-a7-iv",
    label: "Sony α7 IV",
    aliases: ["sony a7 iv", "索尼 a7m4", "索尼 a74", "alpha 7 iv", "ilce-7m4"],
    specs: {
      verifiedAt,
      source: { label: "Sony 官方规格", url: "https://www.sony.com/electronics/support/e-mount-body-ilce-7-series/ilce-7m4/specifications" },
      mount: "Sony E 卡口",
      effectiveMegapixels: 33,
      sensor: { preset: "full_frame", formatLabel: "全画幅", width: 35.9, height: 23.9, cropFactor: 1 },
      iso: { nativeMin: 100, nativeMax: 51200, extendedMin: 50, extendedMax: 204800 },
      shutter: { mechanicalShortestSeconds: 1 / 8000, longestSeconds: 30, bulb: true },
      stabilization: { kind: "ibis", axes: 5, claimedStops: 5.5, note: "厂商标称 5.5 档，基于指定镜头与 CIPA 测试条件。" },
    },
  },
  {
    id: "canon-r6-mark-ii",
    label: "Canon EOS R6 Mark II",
    aliases: ["佳能 r6m2", "佳能 r62", "eos r6 ii", "r6 mark 2"],
    specs: {
      verifiedAt,
      source: { label: "Canon 官方支持页", url: "https://www.usa.canon.com/support/p/eos-r6-mark-ii" },
      mount: "Canon RF 卡口",
      effectiveMegapixels: 24.2,
      sensor: { preset: "full_frame", formatLabel: "全画幅", width: 36, height: 24, cropFactor: 1 },
      iso: { nativeMin: 100, nativeMax: 102400, extendedMin: 50, extendedMax: 204800 },
      shutter: { mechanicalShortestSeconds: 1 / 8000, electronicShortestSeconds: 1 / 16000, longestSeconds: 30, bulb: true },
      stabilization: { kind: "ibis", note: "官方确认具备机身防抖；本目录未找到可脱离镜头与测试条件使用的统一档数，因此不自动计入安全快门。" },
    },
  },
  {
    id: "nikon-z6-iii",
    label: "Nikon Z6III",
    aliases: ["nikon z6 iii", "尼康 z63", "尼康 z6三代", "z6 3", "z6 mark 3"],
    specs: {
      verifiedAt,
      source: { label: "Nikon 官方规格", url: "https://www.nikonusa.com/p/z6iii/1892/overview" },
      mount: "Nikon Z 卡口",
      effectiveMegapixels: 24.5,
      sensor: { preset: "full_frame", formatLabel: "FX 全画幅", width: 35.9, height: 23.9, cropFactor: 1 },
      iso: { nativeMin: 100, nativeMax: 64000, extendedMin: 50, extendedMax: 204800 },
      shutter: { mechanicalShortestSeconds: 1 / 8000, electronicShortestSeconds: 1 / 16000, longestSeconds: 900, bulb: true, note: "900 秒需要在 M 模式启用扩展快门范围。" },
      stabilization: { kind: "ibis", axes: 5, claimedStops: 8, note: "厂商标称最高 8 档，依赖焦点 VR、镜头与 CIPA 测试条件。" },
    },
  },
  {
    id: "fujifilm-x-t5",
    label: "Fujifilm X-T5",
    aliases: ["富士 xt5", "富士 x-t5", "fuji xt5"],
    specs: {
      verifiedAt,
      source: { label: "Fujifilm 官方规格", url: "https://www.fujifilm-x.com/en-us/products/cameras/x-t5/specifications/" },
      mount: "Fujifilm X 卡口",
      effectiveMegapixels: 40.2,
      sensor: { preset: "aps_c", formatLabel: "APS-C", width: 23.5, height: 15.7, cropFactor: 1.5 },
      iso: { nativeMin: 125, nativeMax: 12800, extendedMin: 64, extendedMax: 51200 },
      shutter: { mechanicalShortestSeconds: 1 / 8000, electronicShortestSeconds: 1 / 180000, longestSeconds: 900, bulb: true, note: "不同曝光模式与快门类型的可用范围不同。" },
      stabilization: { kind: "ibis", axes: 5, claimedStops: 7, note: "厂商标称 7 档，基于指定镜头与 CIPA 测试条件。" },
    },
  },

  // 以下条目只帮助找到常见型号；未逐项核验的技术字段绝不自动带入。
  { id: "sony-a1-ii", label: "Sony α1 II", aliases: ["sony a1 ii", "索尼 a1m2", "ilce-1m2"] },
  { id: "sony-a9-iii", label: "Sony α9 III", aliases: ["sony a9 iii", "索尼 a9m3", "ilce-9m3"] },
  { id: "sony-a7r-v", label: "Sony α7R V", aliases: ["sony a7r v", "索尼 a7r5", "ilce-7rm5"] },
  { id: "sony-a7c-ii", label: "Sony α7C II", aliases: ["sony a7c ii", "索尼 a7c2", "ilce-7cm2"] },
  { id: "sony-a7cr", label: "Sony α7CR", aliases: ["索尼 a7cr", "ilce-7cr"] },
  { id: "sony-a7-iii", label: "Sony α7 III", aliases: ["sony a7 iii", "索尼 a7m3", "ilce-7m3"] },
  { id: "sony-a6700", label: "Sony α6700", aliases: ["索尼 a6700", "索尼 6700", "ilce-6700"] },
  { id: "sony-a6600", label: "Sony α6600", aliases: ["索尼 a6600", "索尼 6600", "ilce-6600"] },
  { id: "sony-a6400", label: "Sony α6400", aliases: ["索尼 a6400", "索尼 6400", "ilce-6400"] },
  { id: "canon-r5-mark-ii", label: "Canon EOS R5 Mark II", aliases: ["佳能 r5m2", "eos r5 ii", "r5 mark 2"] },
  { id: "canon-r5", label: "Canon EOS R5", aliases: ["佳能 r5", "eosr5"] },
  { id: "canon-r6", label: "Canon EOS R6", aliases: ["佳能 r6", "eosr6"] },
  { id: "canon-r8", label: "Canon EOS R8", aliases: ["佳能 r8", "eosr8"] },
  { id: "canon-rp", label: "Canon EOS RP", aliases: ["佳能 rp", "eosrp"] },
  { id: "canon-r7", label: "Canon EOS R7", aliases: ["佳能 r7", "eosr7"] },
  { id: "canon-r10", label: "Canon EOS R10", aliases: ["佳能 r10", "eosr10"] },
  { id: "canon-r50", label: "Canon EOS R50", aliases: ["佳能 r50", "eosr50"] },
  { id: "nikon-z9", label: "Nikon Z9", aliases: ["尼康 z9"] },
  { id: "nikon-z8", label: "Nikon Z8", aliases: ["尼康 z8"] },
  { id: "nikon-z7-ii", label: "Nikon Z7II", aliases: ["nikon z7 ii", "尼康 z72", "z7 2"] },
  { id: "nikon-z6-ii", label: "Nikon Z6II", aliases: ["nikon z6 ii", "尼康 z62", "z6 2"] },
  { id: "nikon-z5", label: "Nikon Z5", aliases: ["尼康 z5"] },
  { id: "nikon-zf", label: "Nikon Z f", aliases: ["尼康 zf", "nikon zf"] },
  { id: "nikon-z50-ii", label: "Nikon Z50II", aliases: ["nikon z50 ii", "尼康 z50m2", "z50 2"] },
  { id: "nikon-d850", label: "Nikon D850", aliases: ["尼康 d850"] },
  { id: "fujifilm-x-t50", label: "Fujifilm X-T50", aliases: ["富士 xt50", "fuji xt50"] },
  { id: "fujifilm-x-t30-ii", label: "Fujifilm X-T30 II", aliases: ["富士 xt30二代", "fuji xt30 ii"] },
  { id: "fujifilm-x-h2", label: "Fujifilm X-H2", aliases: ["富士 xh2", "fuji xh2"] },
  { id: "fujifilm-x-h2s", label: "Fujifilm X-H2S", aliases: ["富士 xh2s", "fuji xh2s"] },
  { id: "fujifilm-x-s20", label: "Fujifilm X-S20", aliases: ["富士 xs20", "fuji xs20"] },
  { id: "fujifilm-x100vi", label: "Fujifilm X100VI", aliases: ["富士 x100vi", "富士 x100六代", "x100v6"] },
  { id: "panasonic-s5-ii", label: "Panasonic Lumix S5II", aliases: ["松下 s5m2", "lumix s5 ii"] },
  { id: "panasonic-s5-iix", label: "Panasonic Lumix S5IIX", aliases: ["松下 s5m2x", "lumix s5 iix"] },
  { id: "panasonic-g9-ii", label: "Panasonic Lumix G9II", aliases: ["松下 g9m2", "lumix g9 ii"] },
  { id: "panasonic-gh7", label: "Panasonic Lumix GH7", aliases: ["松下 gh7", "lumix gh7"] },
  { id: "om-system-om1-ii", label: "OM System OM-1 Mark II", aliases: ["奥之心 om1m2", "奥林巴斯 om1二代", "om1 ii"] },
  { id: "om-system-om5", label: "OM System OM-5", aliases: ["奥之心 om5", "奥林巴斯 om5"] },
  { id: "ricoh-gr-iii", label: "Ricoh GR III", aliases: ["理光 gr3", "gr iii", "gr mark 3"] },
  { id: "ricoh-gr-iiix", label: "Ricoh GR IIIx", aliases: ["理光 gr3x", "gr iiix", "gr mark 3x"] },
];

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/[^a-z0-9\u3400-\u9fff]+/g, "");
}

function subsequenceScore(query: string, target: string): number {
  let queryIndex = 0;
  let gaps = 0;
  for (let index = 0; index < target.length && queryIndex < query.length; index += 1) {
    if (target[index] === query[queryIndex]) queryIndex += 1;
    else if (queryIndex > 0) gaps += 1;
  }
  if (queryIndex !== query.length) return 0;
  return 55 + Math.min(20, query.length * 2) - Math.min(15, gaps);
}

function matchScore(query: string, item: CameraCatalogItem): number {
  const candidates = [item.label, ...item.aliases].map(normalize);
  let best = 0;
  for (const candidate of candidates) {
    if (candidate === query) best = Math.max(best, 100);
    else if (candidate.startsWith(query)) best = Math.max(best, 90 - Math.min(10, candidate.length - query.length));
    else if (candidate.includes(query)) best = Math.max(best, 78 - Math.min(10, candidate.length - query.length));
    else best = Math.max(best, subsequenceScore(query, candidate));
  }
  return best;
}

export function searchCameras(query: string, limit = 7): CameraCatalogItem[] {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return cameraCatalog.slice(0, limit);
  return cameraCatalog
    .map((item, index) => ({ item, index, score: matchScore(normalizedQuery, item) }))
    .filter((result) => result.score > 0)
    .sort((left, right) => right.score - left.score || Number(Boolean(right.item.specs)) - Number(Boolean(left.item.specs)) || left.index - right.index)
    .slice(0, limit)
    .map((result) => result.item);
}
