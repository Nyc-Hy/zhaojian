import { describe, expect, it } from "vitest";
import { formatExposureSeconds, parseJpegExif } from "./photoMetadata";

function minimalExifJpeg(): ArrayBuffer {
  const tiff = new Uint8Array(128);
  const view = new DataView(tiff.buffer);
  tiff.set([0x49, 0x49]);
  view.setUint16(2, 42, true);
  view.setUint32(4, 8, true);
  view.setUint16(8, 5, true);
  const entry = (index: number, tag: number, type: number, count: number, value: number) => {
    const offset = 10 + index * 12;
    view.setUint16(offset, tag, true);
    view.setUint16(offset + 2, type, true);
    view.setUint32(offset + 4, count, true);
    if (type === 3 && count === 1) view.setUint16(offset + 8, value, true);
    else view.setUint32(offset + 8, value, true);
  };
  entry(0, 0x010f, 2, 9, 74);
  entry(1, 0x0110, 2, 5, 83);
  entry(2, 0x0112, 3, 1, 6);
  entry(3, 0x8769, 4, 1, 90);
  entry(4, 0x8825, 4, 1, 120);
  tiff.set(new TextEncoder().encode("FUJIFILM\0"), 74);
  tiff.set(new TextEncoder().encode("X-T5\0"), 83);
  view.setUint16(90, 1, true);
  view.setUint16(92, 0x8827, true);
  view.setUint16(94, 3, true);
  view.setUint32(96, 1, true);
  view.setUint16(100, 125, true);

  const payload = new Uint8Array(6 + tiff.length);
  payload.set([0x45, 0x78, 0x69, 0x66, 0, 0]);
  payload.set(tiff, 6);
  const jpeg = new Uint8Array(2 + 4 + payload.length + 2);
  jpeg.set([0xff, 0xd8, 0xff, 0xe1]);
  const segmentLength = payload.length + 2;
  jpeg[4] = segmentLength >> 8;
  jpeg[5] = segmentLength & 0xff;
  jpeg.set(payload, 6);
  jpeg.set([0xff, 0xd9], 6 + payload.length);
  return jpeg.buffer;
}

describe("原图本地 EXIF 摘要", () => {
  it("读取常见设备、方向、ISO 和 GPS 存在性", () => {
    expect(parseJpegExif(minimalExifJpeg())).toMatchObject({
      exifPresent: true,
      cameraMake: "FUJIFILM",
      cameraModel: "X-T5",
      orientation: "顺时针旋转 90°",
      iso: 125,
      gpsPresent: true,
    });
  });

  it("无法读取时安全降级，快门使用摄影常见格式", () => {
    expect(parseJpegExif(new Uint8Array([1, 2, 3]).buffer)).toEqual({ exifPresent: false, gpsPresent: false });
    expect(formatExposureSeconds(1 / 250)).toBe("1/250s");
    expect(formatExposureSeconds(2)).toBe("2s");
  });
});
