import { describe, expect, it } from "vitest";
import {
  actualFocalLength,
  equivalentFocalLength,
  ev100,
  horizontalFieldOfView,
  isoForExposure,
  mapEquivalentFocalRange,
  ndAdjustedShutter,
  resolveIsoForExposure,
  safeHandheldShutter,
  shutterForExposure,
} from "./index.js";

const lens = { id: "24-70", name: "24-70mm F4", focalLength: { min: 24, max: 70 }, maximumAperture: { min: 4, max: 4 }, minimumAperture: 22 };

describe("焦段与视角", () => {
  it("换算 APS-C 等效焦段", () => {
    expect(equivalentFocalLength(35, 1.5)).toBe(52.5);
    expect(actualFocalLength(52.5, 1.5)).toBe(35);
  });
  it("计算全画幅 50mm 水平视角", () => expect(horizontalFieldOfView(36, 50)).toBeCloseTo(39.6, 1));
  it("映射可实现与最近可行焦段", () => {
    expect(mapEquivalentFocalRange({ min: 50, max: 70 }, 1, [lens]).actual).toEqual({ min: 50, max: 70 });
    const result = mapEquivalentFocalRange({ min: 100, max: 135 }, 1, [lens]);
    expect(result.achievable).toBe(false);
    expect(result.actual).toEqual({ min: 70, max: 70 });
  });
});

describe("曝光规则", () => {
  it("EV100 与 ISO 使用已知组合", () => {
    const measured = ev100(8, 1 / 125);
    expect(measured).toBeCloseTo(12.966, 3);
    expect(isoForExposure(measured, 8, 1 / 125)).toBeCloseTo(100, 5);
  });
  it("安全快门考虑裁切、保守系数与主体运动", () => {
    expect(safeHandheldShutter(50, 1.5, { stabilityFactor: 1 })).toBeCloseTo(1 / 75);
    expect(safeHandheldShutter(24, 1, { motion: "significant" })).toBe(1 / 500);
  });
  it("ND 档位按 2 的幂延长快门", () => expect(ndAdjustedShutter(1 / 125, 6)).toBeCloseTo(64 / 125));
  it("ND 零档和二十档仍保持确定性的 2 的幂关系", () => {
    expect(ndAdjustedShutter(1 / 125, 0)).toBeCloseTo(1 / 125);
    expect(ndAdjustedShutter(1 / 125, 20)).toBeCloseTo(2 ** 20 / 125);
  });
  it("ISO 超出范围时保留所需值与曝光差", () => {
    const result = resolveIsoForExposure(8, 8, 1 / 125, { min: 100, max: 1600 });
    expect(result.requiredIso).toBe(3200);
    expect(result.selectedIso).toBe(1600);
    expect(result.withinRange).toBe(false);
    expect(result.differenceEv).toBeCloseTo(1);
  });
  it("可在已知 EV、光圈与 ISO 时反算快门", () => expect(shutterForExposure(13, 8, 100)).toBeCloseTo(1 / 128));
  it("拒绝非法边界和非有限防抖输入", () => {
    expect(() => safeHandheldShutter(0, 1)).toThrow();
    expect(() => safeHandheldShutter(50, 1, { stabilizationStops: Number.NaN })).toThrow();
    expect(() => safeHandheldShutter(50, 1, { stabilizationStops: Number.POSITIVE_INFINITY })).toThrow();
  });
});
