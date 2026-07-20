import { describe, expect, it } from "vitest";

import { isValidPng, pngDimensions } from "../../src/lib/png.js";

function crc32(bytes: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function chunk(type: string, data = Buffer.alloc(0)): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length, 0);
  typeBytes.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(
    crc32(Buffer.concat([typeBytes, data])),
    8 + data.length,
  );
  return result;
}

function reportPng(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1_080, 0);
  ihdr.writeUInt32BE(1_440, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", ihdr),
    chunk("IDAT"),
    chunk("IEND"),
  ]);
}

const constraints = {
  width: 1_080,
  height: 1_440,
  maximumBytes: 5 * 1_024 * 1_024,
} as const;

describe("structural PNG validation", () => {
  it("returns dimensions only after validating the complete PNG structure", () => {
    expect(pngDimensions(reportPng())).toEqual({ width: 1_080, height: 1_440 });
  });

  it("accepts bounded chunks with valid CRCs, IDAT, and terminal empty IEND", () => {
    expect(isValidPng(reportPng(), constraints)).toBe(true);
  });

  it.each([
    [
      "bad CRC",
      () => {
        const png = reportPng();
        png[29] = (png[29] ?? 0) ^ 0xff;
        return png;
      },
    ],
    ["trailing data", () => Buffer.concat([reportPng(), Buffer.from([0])])],
    [
      "no IDAT",
      () => {
        const png = reportPng();
        return Buffer.concat([png.subarray(0, 33), chunk("IEND")]);
      },
    ],
  ])("rejects %s", (_case, invalid) => {
    expect(isValidPng(invalid(), constraints)).toBe(false);
    expect(pngDimensions(invalid())).toBeNull();
  });

  it("rejects a duplicate IHDR even when both chunks have valid CRCs", () => {
    const png = reportPng();
    const duplicate = Buffer.concat([
      png.subarray(0, 33),
      png.subarray(8, 33),
      png.subarray(33),
    ]);

    expect(pngDimensions(duplicate)).toBeNull();
  });
});
