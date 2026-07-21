import {
  createCipheriv,
  createHash,
  randomBytes as nodeRandomBytes,
} from "node:crypto";
import fs, {
  constants,
  type Stats,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { pngDimensions } from "../lib/png.js";

const MAX_IMAGE_BYTES = 5 * 1_024 * 1_024;
const PREPARATION_ERROR_MESSAGE =
  "微信报告图片准备失败，未尝试发送图片消息";
const REPORT_FILE_NAME =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.png$/u;

export interface PrepareWechatImageMediaOptions {
  readonly projectRoot: string;
  readonly imagePath: string;
  readonly randomBytes?: (size: number) => Buffer;
}

export interface PreparedWechatImageMedia {
  readonly fileKey: string;
  readonly aesKey: Buffer;
  readonly rawSize: number;
  readonly rawMd5: string;
  readonly encryptedSize: number;
  readonly encrypted: Uint8Array<ArrayBuffer>;
}

export class WechatMediaPreparationError extends Error {
  override readonly name = "WechatMediaPreparationError";

  constructor() {
    super(PREPARATION_ERROR_MESSAGE);
  }
}

interface FileSnapshot {
  readonly device: number;
  readonly inode: number;
  readonly size: number;
  readonly modifiedMs: number;
  readonly changedMs: number;
}

function validDateDirectory(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (match === null) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function fileSnapshot(metadata: Stats): FileSnapshot {
  return {
    device: metadata.dev,
    inode: metadata.ino,
    size: metadata.size,
    modifiedMs: metadata.mtimeMs,
    changedMs: metadata.ctimeMs,
  };
}

function sameSnapshot(
  metadata: Stats,
  snapshot: FileSnapshot,
): boolean {
  return (
    metadata.dev === snapshot.device &&
    metadata.ino === snapshot.inode &&
    metadata.size === snapshot.size &&
    metadata.mtimeMs === snapshot.modifiedMs &&
    metadata.ctimeMs === snapshot.changedMs
  );
}

function containedReportPath(projectRoot: string, imagePath: string): {
  readonly path: string;
  readonly snapshot: FileSnapshot;
} {
  const root = fs.realpathSync(projectRoot);
  if (!isAbsolute(imagePath) || resolve(imagePath) !== imagePath) {
    throw new Error("invalid report image path");
  }
  const candidate = resolve(projectRoot, imagePath);
  const lexicalRelative = relative(resolve(projectRoot), candidate);
  const segments = lexicalRelative.split(sep);
  if (
    segments.length !== 4 ||
    segments[0] !== "output" ||
    segments[1] !== "run-reports" ||
    segments[2] === undefined ||
    !validDateDirectory(segments[2]) ||
    segments[3] === undefined ||
    !REPORT_FILE_NAME.test(segments[3])
  ) {
    throw new Error("invalid report image path");
  }
  const metadata = fs.lstatSync(candidate);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("unsafe image file");
  }
  if (metadata.size > MAX_IMAGE_BYTES) {
    throw new Error("image too large");
  }
  const actual = fs.realpathSync(candidate);
  const actualRelative = relative(root, actual);
  if (
    actualRelative === ".." ||
    actualRelative.startsWith(`..${sep}`) ||
    isAbsolute(actualRelative) ||
    actual !== resolve(root, ...segments)
  ) {
    throw new Error("unsafe image path");
  }
  return { path: candidate, snapshot: fileSnapshot(metadata) };
}

function readReportPng(projectRoot: string, imagePath: string): Buffer {
  const report = containedReportPath(projectRoot, imagePath);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      report.path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const opened = fs.fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== report.snapshot.device ||
      opened.ino !== report.snapshot.inode ||
      !sameSnapshot(opened, report.snapshot)
    ) {
      throw new Error("unsafe image file");
    }
    const buffer = Buffer.alloc(MAX_IMAGE_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = fs.readSync(
        descriptor,
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        null,
      );
      if (count === 0) {
        break;
      }
      bytesRead += count;
      // Re-check path identity mid-read so same-size rewrites are observed even
      // when the open file descriptor still reports stale timestamps.
      const midPath = fs.lstatSync(report.path);
      if (
        midPath.isSymbolicLink() ||
        !midPath.isFile() ||
        !sameSnapshot(midPath, report.snapshot)
      ) {
        throw new Error("image changed while reading");
      }
    }
    const after = fs.fstatSync(descriptor);
    const finalPath = fs.lstatSync(report.path);
    if (bytesRead > MAX_IMAGE_BYTES) {
      throw new Error("image too large");
    }
    if (
      bytesRead !== report.snapshot.size ||
      !sameSnapshot(after, report.snapshot) ||
      finalPath.isSymbolicLink() ||
      !finalPath.isFile() ||
      !sameSnapshot(finalPath, report.snapshot)
    ) {
      throw new Error("image changed while reading");
    }
    const image = buffer.subarray(0, bytesRead);
    const dimensions = pngDimensions(image);
    if (
      dimensions?.width !== 1_080 ||
      (dimensions.height !== 1_440 && dimensions.height !== 2_400)
    ) {
      throw new Error("invalid report png");
    }
    return Buffer.from(image);
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
}

function exactRandom16(
  random: (size: number) => Buffer,
): Buffer {
  const value = random(16);
  if (!Buffer.isBuffer(value) || value.length !== 16) {
    throw new Error("invalid random bytes");
  }
  return Buffer.from(value);
}

export function prepareWechatImageMedia(
  options: PrepareWechatImageMediaOptions,
): PreparedWechatImageMedia {
  const image = readReportPng(options.projectRoot, options.imagePath);
  const random = options.randomBytes ?? nodeRandomBytes;
  const fileKey = exactRandom16(random).toString("hex");
  const aesKey = exactRandom16(random);
  const encryptedSize = Math.ceil((image.length + 1) / 16) * 16;
  const cipher = createCipheriv("aes-128-ecb", aesKey, null);
  const encrypted = Buffer.concat([cipher.update(image), cipher.final()]);
  if (encrypted.length !== encryptedSize) {
    throw new Error("invalid encrypted size");
  }
  return {
    fileKey,
    aesKey,
    rawSize: image.length,
    rawMd5: createHash("md5").update(image).digest("hex"),
    encryptedSize,
    encrypted: new Uint8Array(encrypted),
  };
}
