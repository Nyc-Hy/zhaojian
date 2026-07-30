import { describe, expect, it } from "vitest";
import { compositionIsPreserved, createCropPreviewGeometry, derivePreviewCrop, fitWithinMaxEdge, formatAspectRatio, formatImageBytes, IMAGE_LIMITS, referenceImageAspectRatio } from "./image";

describe("参考图预处理", () => {
  it("把发往后端的分析图限制为 2 MiB", () => {
    expect(IMAGE_LIMITS.analysisBytes).toBe(2 * 1024 * 1024);
  });

  it("把常见相机横图等比缩到 2048px 长边", () => {
    expect(fitWithinMaxEdge(6000, 4000, IMAGE_LIMITS.analysisMaxEdge)).toEqual({ width: 2048, height: 1365 });
  });

  it("保持竖图方向且不放大小图", () => {
    expect(fitWithinMaxEdge(4000, 6000, 2048)).toEqual({ width: 1365, height: 2048 });
    expect(fitWithinMaxEdge(1200, 800, 2048)).toEqual({ width: 1200, height: 800 });
  });

  it("构图示意沿用分析图宽高比，不强制裁成固定画幅", () => {
    expect(referenceImageAspectRatio(2048, 1365)).toBe("2048 / 1365");
    expect(referenceImageAspectRatio(1365, 2048)).toBe("1365 / 2048");
    expect(referenceImageAspectRatio(0, 2048)).toBe("4 / 3");
  });

  it("把常见画幅比例转换为可读标签，并允许缩放取整误差", () => {
    expect(formatAspectRatio(6000, 4000)).toBe("3:2");
    expect(formatAspectRatio(2048, 1365)).toBe("3:2");
    expect(compositionIsPreserved(6000, 4000, 2048, 1365)).toBe(true);
    expect(compositionIsPreserved(6000, 4000, 2048, 1200)).toBe(false);
  });

  it("把归一化取景框转换为不改变原图比例的裁切预览", () => {
    const geometry = createCropPreviewGeometry([0.25, 0.1, 0.5, 0.5], 1365, 2048);
    expect(geometry.cropped).toBe(true);
    expect(geometry.aspectRatio).toBeCloseTo(1365 / 2048);
    expect(geometry.imageStyle).toEqual({ left: "-50%", top: "-20%", width: "200%", height: "200%" });
  });

  it("没有取景框或坐标越界时保持完整原图", () => {
    expect(createCropPreviewGeometry(undefined, 2048, 1365)).toEqual({ cropped: false, aspectRatio: 2048 / 1365 });
    expect(createCropPreviewGeometry([0.8, 0.2, 0.4, 0.5], 2048, 1365)).toEqual({ cropped: false, aspectRatio: 2048 / 1365 });
  });

  it("模型缺少取景框时按视角宽窄生成不同的本地范围模拟", () => {
    const common = { orientation: "keep" as const, groundingElements: [] };
    expect(derivePreviewCrop({ ...common, viewWidth: "normal" }, [], 1365, 2048)).toEqual([0.16, 0.16, 0.68, 0.68]);
    expect(derivePreviewCrop({ ...common, viewWidth: "wide" }, [], 1365, 2048)).toEqual([0.08, 0.08, 0.84, 0.84]);
  });

  it("优先把范围模拟锚定到该方向点名的关注区域", () => {
    const crop = derivePreviewCrop({
      viewWidth: "detail",
      orientation: "square",
      groundingElements: ["白色樱花", "深色钢结构"],
    }, [
      { label: "黄色限高杆", confidence: 0.95, region: [0.1, 0.7, 0.12, 0.1] },
      { label: "樱花", confidence: 0.82, region: [0.75, 0.1, 0.1, 0.2] },
    ], 2048, 1365);

    expect(crop[0]).toBeCloseTo(0.68, 3);
    expect(crop[1]).toBeCloseTo(0.02, 3);
    expect(crop[2]).toBeCloseTo(0.24, 3);
    expect(crop[3]).toBeCloseTo(0.36, 3);
  });

  it("按建议画幅调整模拟范围的宽高比", () => {
    const crop = derivePreviewCrop({ viewWidth: "normal", orientation: "landscape", groundingElements: [] }, [], 1365, 2048);
    const geometry = createCropPreviewGeometry(crop, 1365, 2048);
    expect(geometry.aspectRatio).toBeCloseTo(3 / 2, 3);
  });

  it("拒绝无效尺寸", () => {
    expect(() => fitWithinMaxEdge(0, 800, 2048)).toThrow("图片尺寸不正确");
  });

  it("以便于用户理解的单位显示文件体积", () => {
    expect(formatImageBytes(860)).toBe("860B");
    expect(formatImageBytes(1536)).toBe("1.5KB");
    expect(formatImageBytes(1.5 * 1024 * 1024)).toBe("1.50MB");
  });
});
