const PNG_SIGNATURE = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

export interface PngConstraints {
  readonly width: number;
  readonly height: number;
  readonly maximumBytes: number;
}

export interface PngDimensions {
  readonly width: number;
  readonly height: number;
}

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffff_ffff;
  for (let index = start; index < end; index += 1) {
    crc ^= bytes[index] ?? 0;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

export function pngDimensions(png: Uint8Array): PngDimensions | null {
  if (png.byteLength < 45) {
    return null;
  }
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (png[index] !== PNG_SIGNATURE[index]) {
      return null;
    }
  }

  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let offset = PNG_SIGNATURE.length;
  let chunkIndex = 0;
  let sawImageData = false;
  let dimensions: PngDimensions | null = null;
  while (offset < png.byteLength) {
    if (png.byteLength - offset < 12) {
      return null;
    }
    const dataLength = view.getUint32(offset);
    const typeOffset = offset + 4;
    const dataOffset = typeOffset + 4;
    if (dataLength > png.byteLength - dataOffset - 4) {
      return null;
    }
    const crcOffset = dataOffset + dataLength;
    const nextOffset = crcOffset + 4;
    const typeBytes = png.subarray(typeOffset, dataOffset);
    if (
      !typeBytes.every(
        (byte) =>
          (byte >= 0x41 && byte <= 0x5a) ||
          (byte >= 0x61 && byte <= 0x7a),
      )
    ) {
      return null;
    }
    const type = String.fromCharCode(...typeBytes);
    if (view.getUint32(crcOffset) !== crc32(png, typeOffset, crcOffset)) {
      return null;
    }
    if (chunkIndex === 0) {
      if (type !== "IHDR" || dataLength !== 13) {
        return null;
      }
      const width = view.getUint32(dataOffset);
      const height = view.getUint32(dataOffset + 4);
      if (width === 0 || height === 0) {
        return null;
      }
      dimensions = { width, height };
    } else if (type === "IHDR") {
      return null;
    }
    if (type === "IDAT") {
      sawImageData = true;
    }
    if (type === "IEND") {
      return dataLength === 0 && sawImageData && nextOffset === png.byteLength
        ? dimensions
        : null;
    }
    offset = nextOffset;
    chunkIndex += 1;
  }
  return null;
}

export function isValidPng(
  png: Uint8Array,
  constraints: PngConstraints,
): boolean {
  if (
    !Number.isSafeInteger(constraints.width) ||
    constraints.width <= 0 ||
    !Number.isSafeInteger(constraints.height) ||
    constraints.height <= 0 ||
    !Number.isSafeInteger(constraints.maximumBytes) ||
    constraints.maximumBytes <= 0 ||
    png.byteLength > constraints.maximumBytes
  ) {
    return false;
  }
  const dimensions = pngDimensions(png);
  return (
    dimensions?.width === constraints.width &&
    dimensions.height === constraints.height
  );
}
