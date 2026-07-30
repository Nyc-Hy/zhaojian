import type { ReferenceImageInfo } from "./image";

export function buildPhotoTechnicalContext(imageInfo?: ReferenceImageInfo) {
  if (!imageInfo) return undefined;
  return {
    originalWidth: imageInfo.originalWidth,
    originalHeight: imageInfo.originalHeight,
    analysisWidth: imageInfo.analysisWidth,
    analysisHeight: imageInfo.analysisHeight,
    aspectRatio: imageInfo.originalAspectRatio,
    orientation: imageInfo.originalWidth >= imageInfo.originalHeight ? "landscape" : "portrait",
    compositionPreserved: imageInfo.compositionPreserved,
    metadataConsent: false,
  };
}
