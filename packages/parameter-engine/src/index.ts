export type Range = { min: number; max: number };

export type LensCapability = {
  id: string;
  name: string;
  focalLength: Range;
  maximumAperture: Range;
  minimumAperture: number;
};

export type FocalMapping = {
  lensId: string;
  lensName: string;
  requestedEquivalent: Range;
  actual: Range;
  achievable: boolean;
  note: string;
};

export type ExposureResolution = {
  requiredIso: number;
  selectedIso: number;
  withinRange: boolean;
  differenceEv: number;
};

const assertPositive = (value: number, name: string) => {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} 必须是大于 0 的有限数值`);
};

export function equivalentFocalLength(actualMm: number, cropFactor: number): number {
  assertPositive(actualMm, "实际焦段");
  assertPositive(cropFactor, "裁切系数");
  return actualMm * cropFactor;
}

export function actualFocalLength(equivalentMm: number, cropFactor: number): number {
  assertPositive(equivalentMm, "等效焦段");
  assertPositive(cropFactor, "裁切系数");
  return equivalentMm / cropFactor;
}

export function horizontalFieldOfView(sensorWidthMm: number, focalLengthMm: number): number {
  assertPositive(sensorWidthMm, "传感器宽度");
  assertPositive(focalLengthMm, "焦段");
  return (2 * Math.atan(sensorWidthMm / (2 * focalLengthMm)) * 180) / Math.PI;
}

export function mapEquivalentFocalRange(
  requested: Range,
  cropFactor: number,
  lenses: LensCapability[],
): FocalMapping {
  if (requested.min > requested.max) throw new RangeError("等效焦段范围顺序不正确");
  if (lenses.length === 0) throw new RangeError("至少需要一支镜头");
  const desired = {
    min: actualFocalLength(requested.min, cropFactor),
    max: actualFocalLength(requested.max, cropFactor),
  };

  const candidates = lenses.map((lens) => {
    const min = Math.max(desired.min, lens.focalLength.min);
    const max = Math.min(desired.max, lens.focalLength.max);
    const overlap = Math.max(0, max - min);
    const center = (desired.min + desired.max) / 2;
    const nearest = Math.min(Math.max(center, lens.focalLength.min), lens.focalLength.max);
    return { lens, min, max, overlap, nearest, distance: Math.abs(center - nearest) };
  });
  candidates.sort((a, b) => b.overlap - a.overlap || a.distance - b.distance);
  const best = candidates[0]!;
  const achievable = best.min <= best.max;
  const actual = achievable ? { min: best.min, max: best.max } : { min: best.nearest, max: best.nearest };
  return {
    lensId: best.lens.id,
    lensName: best.lens.name,
    requestedEquivalent: requested,
    actual,
    achievable,
    note: achievable
      ? "当前器材可以覆盖这段视角。"
      : `当前器材无法完整覆盖，${best.nearest}mm 是最近可尝试的实际焦段。`,
  };
}

export function safeHandheldShutter(
  focalLengthMm: number,
  cropFactor: number,
  options: { stabilityFactor?: number; stabilizationStops?: number; motion?: "static" | "subtle" | "significant" | "unknown" } = {},
): number {
  assertPositive(focalLengthMm, "焦段");
  assertPositive(cropFactor, "裁切系数");
  const stability = options.stabilityFactor ?? 1.25;
  assertPositive(stability, "稳定保守系数");
  if (options.stabilizationStops !== undefined && !Number.isFinite(options.stabilizationStops)) throw new Error("防抖档位必须是有限数值");
  const creditedStops = Math.max(0, Math.min(options.stabilizationStops ?? 0, 3));
  const cameraShakeDenominator = (focalLengthMm * cropFactor * stability) / 2 ** creditedStops;
  const motionMaximum = options.motion === "significant" ? 1 / 500 : options.motion === "subtle" ? 1 / 125 : Number.POSITIVE_INFINITY;
  return Math.min(1 / cameraShakeDenominator, motionMaximum);
}

export function ev100(aperture: number, shutterSeconds: number): number {
  assertPositive(aperture, "光圈");
  assertPositive(shutterSeconds, "快门秒数");
  return Math.log2(aperture ** 2 / shutterSeconds);
}

export function isoForExposure(ev: number, aperture: number, shutterSeconds: number): number {
  assertPositive(aperture, "光圈");
  assertPositive(shutterSeconds, "快门秒数");
  if (!Number.isFinite(ev)) throw new RangeError("EV 必须是有限数值");
  return (100 * aperture ** 2) / (shutterSeconds * 2 ** ev);
}

export function shutterForExposure(ev: number, aperture: number, iso: number): number {
  assertPositive(aperture, "光圈");
  assertPositive(iso, "ISO");
  if (!Number.isFinite(ev)) throw new RangeError("EV 必须是有限数值");
  return (100 * aperture ** 2) / (iso * 2 ** ev);
}

export function resolveIsoForExposure(
  ev: number,
  aperture: number,
  shutterSeconds: number,
  isoRange: Range,
): ExposureResolution {
  assertPositive(isoRange.min, "最低 ISO");
  assertPositive(isoRange.max, "最高 ISO");
  if (isoRange.min > isoRange.max) throw new RangeError("ISO 范围顺序不正确");
  const rawIso = isoForExposure(ev, aperture, shutterSeconds);
  const thirdStopIso = 100 * 2 ** (Math.round(Math.log2(rawIso / 100) * 3) / 3);
  const requiredIso = Math.max(1, Math.round(thirdStopIso));
  const selectedIso = Math.min(isoRange.max, Math.max(isoRange.min, requiredIso));
  return {
    requiredIso,
    selectedIso,
    withinRange: requiredIso >= isoRange.min && requiredIso <= isoRange.max,
    differenceEv: Math.abs(Math.log2(requiredIso / selectedIso)),
  };
}

export function ndAdjustedShutter(baseSeconds: number, ndStops: number): number {
  assertPositive(baseSeconds, "基础快门");
  if (!Number.isFinite(ndStops) || ndStops < 0 || ndStops > 20) throw new RangeError("ND 档位必须在 0～20 之间");
  return baseSeconds * 2 ** ndStops;
}

export function formatShutter(seconds: number): string {
  assertPositive(seconds, "快门秒数");
  if (seconds >= 1) return `${Number(seconds.toFixed(1))}s`;
  return `1/${Math.max(1, Math.round(1 / seconds))}s`;
}
