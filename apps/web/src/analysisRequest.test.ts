import { describe, expect, it } from "vitest";
import { buildPhotoTechnicalContext } from "./analysisRequest";

describe("分析请求隐私边界", () => {
  it("只发送尺寸校验上下文，不发送本地 EXIF", () => {
    const context = buildPhotoTechnicalContext({
      originalBytes: 1000,
      originalWidth: 4000,
      originalHeight: 3000,
      originalAspectRatio: "4:3",
      analysisBytes: 500,
      analysisWidth: 1600,
      analysisHeight: 1200,
      analysisAspectRatio: "4:3",
      compositionPreserved: true,
      scalePercent: 40,
      metadata: { exifPresent: true, gpsPresent: true, cameraModel: "私有机身", iso: 800 },
    });

    expect(context).toMatchObject({ originalWidth: 4000, analysisWidth: 1600, metadataConsent: false });
    expect(context).not.toHaveProperty("originalExif");
  });
});
