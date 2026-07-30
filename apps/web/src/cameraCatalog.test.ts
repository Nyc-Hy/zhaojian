import { describe, expect, it } from "vitest";
import { cameraCatalog, searchCameras } from "./cameraCatalog";

describe("相机目录模糊搜索", () => {
  it("匹配中文品牌和常见中文型号别名", () => expect(searchCameras("索尼 a7m4")[0]?.id).toBe("sony-a7-iv"));
  it("匹配省略连接符的英文型号", () => expect(searchCameras("xt5")[0]?.id).toBe("fujifilm-x-t5"));
  it("匹配用户常用的代际简称", () => expect(searchCameras("z63")[0]?.id).toBe("nikon-z6-iii"));
  it("输入为空时只返回有限数量的常见示例", () => expect(searchCameras("", 5)).toHaveLength(5));

  it("明确区分已核验规格与仅型号条目", () => {
    expect(searchCameras("a7m4")[0]?.specs?.source.url).toContain("sony.com");
    expect(searchCameras("a7r5")[0]?.specs).toBeUndefined();
  });

  it("每条已核验规格都带官方来源、日期和有效计算字段", () => {
    const verified = cameraCatalog.filter((camera) => camera.specs);
    expect(verified).toHaveLength(4);
    for (const camera of verified) {
      const specs = camera.specs!;
      expect(specs.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(specs.source.url).toMatch(/^https:\/\/(www\.)?(sony\.com|usa\.canon\.com|nikonusa\.com|fujifilm-x\.com)\//);
      expect(specs.sensor.width).toBeGreaterThan(0);
      expect(specs.sensor.height).toBeGreaterThan(0);
      expect(specs.sensor.cropFactor).toBeGreaterThan(0);
      expect(specs.iso.nativeMax).toBeGreaterThanOrEqual(specs.iso.nativeMin);
      expect(specs.shutter.mechanicalShortestSeconds).toBeGreaterThan(0);
      expect(specs.shutter.longestSeconds).toBeGreaterThan(specs.shutter.mechanicalShortestSeconds);
    }
  });
});
