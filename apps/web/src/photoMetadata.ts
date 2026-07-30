export type LocalPhotoMetadata = {
  exifPresent: boolean;
  cameraMake?: string;
  cameraModel?: string;
  lensModel?: string;
  focalLengthMm?: number;
  focalLength35Mm?: number;
  aperture?: number;
  exposureSeconds?: number;
  iso?: number;
  exposureCompensationEv?: number;
  capturedAt?: string;
  orientation?: string;
  gpsPresent: boolean;
};

type IfdEntry = { type: number; count: number; valueOffset: number };

const orientationLabels: Record<number, string> = {
  1: "正常",
  2: "水平镜像",
  3: "旋转 180°",
  4: "垂直镜像",
  5: "镜像并旋转 90°",
  6: "顺时针旋转 90°",
  7: "镜像并旋转 270°",
  8: "逆时针旋转 90°",
};

function findExifTiffOffset(bytes: Uint8Array): number | undefined {
  if (bytes.length < 12 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1];
    if (marker === 0xda || marker === 0xd9) return undefined;
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (length < 2 || offset + 2 + length > bytes.length) return undefined;
    const payload = offset + 4;
    if (marker === 0xe1
      && length >= 8
      && bytes[payload] === 0x45 && bytes[payload + 1] === 0x78 && bytes[payload + 2] === 0x69 && bytes[payload + 3] === 0x66
      && bytes[payload + 4] === 0 && bytes[payload + 5] === 0) return payload + 6;
    offset += 2 + length;
  }
  return undefined;
}

function parseIfd(view: DataView, tiffOffset: number, relativeOffset: number, littleEndian: boolean): Map<number, IfdEntry> {
  const entries = new Map<number, IfdEntry>();
  const start = tiffOffset + relativeOffset;
  if (start < tiffOffset || start + 2 > view.byteLength) return entries;
  const count = view.getUint16(start, littleEndian);
  for (let index = 0; index < count; index += 1) {
    const entry = start + 2 + index * 12;
    if (entry + 12 > view.byteLength) break;
    const tag = view.getUint16(entry, littleEndian);
    const type = view.getUint16(entry + 2, littleEndian);
    const valueCount = view.getUint32(entry + 4, littleEndian);
    const unitSize = type === 1 || type === 2 || type === 7 ? 1 : type === 3 ? 2 : type === 4 || type === 9 ? 4 : type === 5 || type === 10 ? 8 : 0;
    if (!unitSize || valueCount > 1_000_000) continue;
    const byteLength = unitSize * valueCount;
    const valueOffset = byteLength <= 4 ? entry + 8 : tiffOffset + view.getUint32(entry + 8, littleEndian);
    if (valueOffset < tiffOffset || valueOffset + byteLength > view.byteLength) continue;
    entries.set(tag, { type, count: valueCount, valueOffset });
  }
  return entries;
}

function readAscii(view: DataView, entry: IfdEntry | undefined): string | undefined {
  if (!entry || entry.type !== 2) return undefined;
  const bytes = new Uint8Array(view.buffer, view.byteOffset + entry.valueOffset, entry.count);
  const value = new TextDecoder("ascii").decode(bytes).replace(/\0+$/g, "").trim();
  return value || undefined;
}

function readShort(view: DataView, entry: IfdEntry | undefined, littleEndian: boolean): number | undefined {
  if (!entry || entry.type !== 3 || entry.count < 1) return undefined;
  return view.getUint16(entry.valueOffset, littleEndian);
}

function readLong(view: DataView, entry: IfdEntry | undefined, littleEndian: boolean): number | undefined {
  if (!entry || entry.type !== 4 || entry.count < 1) return undefined;
  return view.getUint32(entry.valueOffset, littleEndian);
}

function readRational(view: DataView, entry: IfdEntry | undefined, littleEndian: boolean): number | undefined {
  if (!entry || entry.type !== 5 || entry.count < 1) return undefined;
  const numerator = view.getUint32(entry.valueOffset, littleEndian);
  const denominator = view.getUint32(entry.valueOffset + 4, littleEndian);
  return denominator ? numerator / denominator : undefined;
}

function readSignedRational(view: DataView, entry: IfdEntry | undefined, littleEndian: boolean): number | undefined {
  if (!entry || entry.type !== 10 || entry.count < 1) return undefined;
  const numerator = view.getInt32(entry.valueOffset, littleEndian);
  const denominator = view.getInt32(entry.valueOffset + 4, littleEndian);
  return denominator ? numerator / denominator : undefined;
}

export function parseJpegExif(buffer: ArrayBuffer): LocalPhotoMetadata {
  const empty: LocalPhotoMetadata = { exifPresent: false, gpsPresent: false };
  try {
    const bytes = new Uint8Array(buffer);
    const tiffOffset = findExifTiffOffset(bytes);
    if (tiffOffset === undefined || tiffOffset + 8 > bytes.length) return empty;
    const view = new DataView(buffer);
    const byteOrder = String.fromCharCode(bytes[tiffOffset], bytes[tiffOffset + 1]);
    const littleEndian = byteOrder === "II";
    if (!littleEndian && byteOrder !== "MM") return empty;
    if (view.getUint16(tiffOffset + 2, littleEndian) !== 42) return empty;

    const ifd0 = parseIfd(view, tiffOffset, view.getUint32(tiffOffset + 4, littleEndian), littleEndian);
    const exifPointer = readLong(view, ifd0.get(0x8769), littleEndian);
    const exif = exifPointer === undefined ? new Map<number, IfdEntry>() : parseIfd(view, tiffOffset, exifPointer, littleEndian);
    const orientation = readShort(view, ifd0.get(0x0112), littleEndian);
    return {
      exifPresent: true,
      cameraMake: readAscii(view, ifd0.get(0x010f)),
      cameraModel: readAscii(view, ifd0.get(0x0110)),
      lensModel: readAscii(view, exif.get(0xa434)),
      focalLengthMm: readRational(view, exif.get(0x920a), littleEndian),
      focalLength35Mm: readShort(view, exif.get(0xa405), littleEndian),
      aperture: readRational(view, exif.get(0x829d), littleEndian),
      exposureSeconds: readRational(view, exif.get(0x829a), littleEndian),
      iso: readShort(view, exif.get(0x8827), littleEndian),
      exposureCompensationEv: readSignedRational(view, exif.get(0x9204), littleEndian),
      capturedAt: readAscii(view, exif.get(0x9003)) ?? readAscii(view, ifd0.get(0x0132)),
      orientation: orientation === undefined ? undefined : orientationLabels[orientation] ?? `方向值 ${orientation}`,
      gpsPresent: readLong(view, ifd0.get(0x8825), littleEndian) !== undefined,
    };
  } catch {
    return empty;
  }
}

export async function readLocalPhotoMetadata(file: File): Promise<LocalPhotoMetadata> {
  if (file.type !== "image/jpeg") return { exifPresent: false, gpsPresent: false };
  return parseJpegExif(await file.slice(0, 512 * 1024).arrayBuffer());
}

export function formatExposureSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "未知";
  if (seconds >= 1) return `${Number(seconds.toFixed(2))}s`;
  const denominator = Math.round(1 / seconds);
  return `1/${denominator}s`;
}
