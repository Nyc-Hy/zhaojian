import { readLocalPhotoMetadata, type LocalPhotoMetadata } from "./photoMetadata";

export const IMAGE_LIMITS = {
  sourceBytes: 60 * 1024 * 1024,
  sourcePixels: 60_000_000,
  analysisBytes: 2 * 1024 * 1024,
  analysisMaxEdge: 2048,
  thumbnailMaxEdge: 480,
} as const;

export type ReferenceImageInfo = {
  originalBytes: number;
  originalWidth: number;
  originalHeight: number;
  analysisBytes: number;
  analysisWidth: number;
  analysisHeight: number;
  originalAspectRatio: string;
  analysisAspectRatio: string;
  compositionPreserved: boolean;
  scalePercent: number;
  metadata?: LocalPhotoMetadata;
};

export type PreparedReferenceImage = {
  blob: Blob;
  preview: string;
  thumbnail: Blob;
  info: ReferenceImageInfo;
};

export type NormalizedCrop = readonly [number, number, number, number];

export type PreviewCropDirection = {
  viewWidth: string;
  orientation: "landscape" | "portrait" | "square" | "keep" | "unknown";
  groundingElements: string[];
};

export type PreviewCropCandidate = {
  label: string;
  confidence: number;
  region?: NormalizedCrop;
};

export type CropPreviewGeometry = {
  cropped: boolean;
  aspectRatio: number;
  imageStyle?: { left: string; top: string; width: string; height: string };
};

const supportedTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const analysisEdges = [IMAGE_LIMITS.analysisMaxEdge, 1920, 1792, 1600, 1400, 1280];
const analysisQualities = [0.9, 0.84, 0.78, 0.72, 0.66];
const previewCropScales: Record<string, number> = {
  very_wide: 0.94,
  wide: 0.84,
  normal: 0.68,
  narrow: 0.52,
  detail: 0.36,
};

export function fitWithinMaxEdge(width: number, height: number, maxEdge: number): { width: number; height: number } {
  if (![width, height, maxEdge].every((value) => Number.isFinite(value) && value > 0)) throw new Error("图片尺寸不正确。");
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export function referenceImageAspectRatio(width: number, height: number): string {
  if (![width, height].every((value) => Number.isFinite(value) && value > 0)) return "4 / 3";
  return `${width} / ${height}`;
}

export function formatAspectRatio(width: number, height: number): string {
  if (![width, height].every((value) => Number.isFinite(value) && value > 0)) return "未知";
  const ratio = width / height;
  const commonRatios = [
    { label: "1:1", value: 1 },
    { label: "5:4", value: 5 / 4 },
    { label: "4:3", value: 4 / 3 },
    { label: "3:2", value: 3 / 2 },
    { label: "16:10", value: 16 / 10 },
    { label: "16:9", value: 16 / 9 },
    { label: "2:1", value: 2 },
  ];
  const match = commonRatios.find((candidate) => Math.abs(candidate.value - ratio) / candidate.value < 0.006);
  return match?.label ?? `${ratio.toFixed(2)}:1`;
}

export function compositionIsPreserved(originalWidth: number, originalHeight: number, analysisWidth: number, analysisHeight: number): boolean {
  if (![originalWidth, originalHeight, analysisWidth, analysisHeight].every((value) => Number.isFinite(value) && value > 0)) return false;
  const expectedHeight = originalHeight * analysisWidth / originalWidth;
  return Math.abs(expectedHeight - analysisHeight) <= 1;
}

function percent(value: number): string {
  return `${Number(value.toFixed(4))}%`;
}

export function createCropPreviewGeometry(crop: NormalizedCrop | undefined, imageWidth: number, imageHeight: number): CropPreviewGeometry {
  const safeWidth = Number.isFinite(imageWidth) && imageWidth > 0 ? imageWidth : 4;
  const safeHeight = Number.isFinite(imageHeight) && imageHeight > 0 ? imageHeight : 3;
  const originalAspectRatio = safeWidth / safeHeight;
  if (!crop) return { cropped: false, aspectRatio: originalAspectRatio };

  const [x, y, width, height] = crop;
  const valid = [x, y, width, height].every(Number.isFinite)
    && x >= 0 && y >= 0 && width > 0 && height > 0
    && x + width <= 1 && y + height <= 1;
  if (!valid) return { cropped: false, aspectRatio: originalAspectRatio };

  return {
    cropped: true,
    aspectRatio: (safeWidth * width) / (safeHeight * height),
    imageStyle: {
      left: percent((-x / width) * 100),
      top: percent((-y / height) * 100),
      width: percent((1 / width) * 100),
      height: percent((1 / height) * 100),
    },
  };
}

function validNormalizedCrop(crop: NormalizedCrop | undefined): crop is NormalizedCrop {
  if (!crop) return false;
  const [x, y, width, height] = crop;
  return [x, y, width, height].every(Number.isFinite)
    && x >= 0 && y >= 0 && width > 0 && height > 0
    && x + width <= 1 && y + height <= 1;
}

function normalizeMatchingText(value: string): string {
  return value.toLocaleLowerCase("zh-CN").replace(/[\s\p{P}\p{S}]+/gu, "");
}

function candidateMatchesGrounding(candidate: PreviewCropCandidate, groundingElements: string[]): boolean {
  const candidateLabel = normalizeMatchingText(candidate.label);
  if (!candidateLabel) return false;
  return groundingElements.some((element) => {
    const normalizedElement = normalizeMatchingText(element);
    return normalizedElement.length > 0
      && (candidateLabel.includes(normalizedElement) || normalizedElement.includes(candidateLabel));
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function roundCrop(value: number): number {
  return Number(value.toFixed(4));
}

/**
 * 模型缺少 suggested_crop 时，在浏览器本地生成可解释的取景范围模拟。
 * 它只使用结构化视角、画幅方向和已有关注区域，不改变原图，也不推断新画面内容。
 */
export function derivePreviewCrop(
  direction: PreviewCropDirection,
  candidates: PreviewCropCandidate[],
  imageWidth: number,
  imageHeight: number,
): NormalizedCrop {
  const safeWidth = Number.isFinite(imageWidth) && imageWidth > 0 ? imageWidth : 4;
  const safeHeight = Number.isFinite(imageHeight) && imageHeight > 0 ? imageHeight : 3;
  const sourceAspectRatio = safeWidth / safeHeight;
  const targetAspectRatio = direction.orientation === "landscape"
    ? 3 / 2
    : direction.orientation === "portrait"
      ? 2 / 3
      : direction.orientation === "square"
        ? 1
        : sourceAspectRatio;
  const normalizedAspectRatio = targetAspectRatio / sourceAspectRatio;
  const scale = previewCropScales[direction.viewWidth] ?? previewCropScales.normal;
  const cropWidth = normalizedAspectRatio >= 1 ? scale : scale * normalizedAspectRatio;
  const cropHeight = normalizedAspectRatio >= 1 ? scale / normalizedAspectRatio : scale;

  const usableCandidates = candidates
    .filter((candidate) => validNormalizedCrop(candidate.region))
    .sort((left, right) => right.confidence - left.confidence);
  const anchorCandidate = usableCandidates.find((candidate) => candidateMatchesGrounding(candidate, direction.groundingElements))
    ?? usableCandidates[0];
  const anchorX = anchorCandidate?.region ? anchorCandidate.region[0] + anchorCandidate.region[2] / 2 : 0.5;
  const anchorY = anchorCandidate?.region ? anchorCandidate.region[1] + anchorCandidate.region[3] / 2 : 0.5;
  const x = clamp(anchorX - cropWidth / 2, 0, 1 - cropWidth);
  const y = clamp(anchorY - cropHeight / 2, 0, 1 - cropHeight);

  return [roundCrop(x), roundCrop(y), roundCrop(cropWidth), roundCrop(cropHeight)];
}

export function formatImageBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "未知大小";
  if (bytes < 1024) return `${Math.round(bytes)}B`;
  const kilobytes = bytes / 1024;
  if (kilobytes < 1024) return `${kilobytes.toFixed(kilobytes >= 100 ? 0 : 1)}KB`;
  const megabytes = kilobytes / 1024;
  return `${megabytes.toFixed(megabytes >= 10 ? 1 : 2)}MB`;
}

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function drawBitmap(bitmap: ImageBitmap, maxEdge: number): HTMLCanvasElement {
  const target = fitWithinMaxEdge(bitmap.width, bitmap.height, maxEdge);
  const canvas = createCanvas(target.width, target.height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("浏览器无法处理这张图片。", { cause: "INVALID_IMAGE" });
  context.drawImage(bitmap, 0, 0, target.width, target.height);
  return canvas;
}

function canvasToBlob(canvas: HTMLCanvasElement, quality: number, failureMessage: string): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(
    (value) => value ? resolve(value) : reject(new Error(failureMessage, { cause: "INVALID_IMAGE" })),
    "image/jpeg",
    quality,
  ));
}

async function encodeAnalysisImage(bitmap: ImageBitmap): Promise<{ blob: Blob; canvas: HTMLCanvasElement }> {
  let smallest: { blob: Blob; canvas: HTMLCanvasElement } | undefined;
  for (const maxEdge of analysisEdges) {
    const canvas = drawBitmap(bitmap, maxEdge);
    for (const quality of analysisQualities) {
      const blob = await canvasToBlob(canvas, quality, "图片压缩失败。");
      if (!smallest || blob.size < smallest.blob.size) smallest = { blob, canvas };
      if (blob.size <= IMAGE_LIMITS.analysisBytes) return { blob, canvas };
    }
  }
  if (smallest) return smallest;
  throw new Error("无法生成适合分析的图片。", { cause: "INVALID_IMAGE" });
}

export async function prepareReferenceImage(file: File): Promise<PreparedReferenceImage> {
  if (!supportedTypes.has(file.type)) throw new Error("请选择 JPEG、PNG 或 WebP 图片。", { cause: "INVALID_IMAGE" });
  if (file.size > IMAGE_LIMITS.sourceBytes) throw new Error("原图超过 60MB，请先在相册中导出较小版本。", { cause: "INVALID_IMAGE" });

  const metadataPromise = readLocalPhotoMetadata(file);
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error("这张图片无法解码，请尝试导出为 JPEG 后重试。", { cause: "INVALID_IMAGE" });
  }

  try {
    if (bitmap.width * bitmap.height > IMAGE_LIMITS.sourcePixels) {
      throw new Error("原图超过 6000 万像素，请先在相册中导出较小版本。", { cause: "INVALID_IMAGE" });
    }
    const { blob, canvas } = await encodeAnalysisImage(bitmap);
    if (blob.size > IMAGE_LIMITS.analysisBytes) throw new Error("分析图仍超过 2 MiB，请先导出较小版本。", { cause: "INVALID_IMAGE" });

    const thumbnailSize = fitWithinMaxEdge(canvas.width, canvas.height, IMAGE_LIMITS.thumbnailMaxEdge);
    const thumbnailCanvas = createCanvas(thumbnailSize.width, thumbnailSize.height);
    const thumbnailContext = thumbnailCanvas.getContext("2d");
    if (!thumbnailContext) throw new Error("浏览器无法生成参考缩略图。", { cause: "INVALID_IMAGE" });
    thumbnailContext.drawImage(canvas, 0, 0, thumbnailCanvas.width, thumbnailCanvas.height);
    const thumbnail = await canvasToBlob(thumbnailCanvas, 0.7, "缩略图生成失败。");

    const metadata = await metadataPromise;
    return {
      blob,
      preview: canvas.toDataURL("image/jpeg", 0.76),
      thumbnail,
      info: {
        originalBytes: file.size,
        originalWidth: bitmap.width,
        originalHeight: bitmap.height,
        analysisBytes: blob.size,
        analysisWidth: canvas.width,
        analysisHeight: canvas.height,
        originalAspectRatio: formatAspectRatio(bitmap.width, bitmap.height),
        analysisAspectRatio: formatAspectRatio(canvas.width, canvas.height),
        compositionPreserved: compositionIsPreserved(bitmap.width, bitmap.height, canvas.width, canvas.height),
        scalePercent: Math.round((canvas.width / bitmap.width) * 100),
        metadata,
      },
    };
  } finally {
    bitmap.close();
  }
}
