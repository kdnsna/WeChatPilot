import {
  createCipheriv,
  createHash,
  randomBytes as nodeRandomBytes,
} from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

const MAX_IMAGE_BYTES = 5 * 1_024 * 1_024;
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
const PREPARATION_ERROR_MESSAGE =
  "微信报告图片准备失败，未尝试发送图片消息";

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

function containedPath(projectRoot: string, imagePath: string): string {
  const root = realpathSync(projectRoot);
  const candidate = resolve(projectRoot, imagePath);
  const lexicalRelative = relative(resolve(projectRoot), candidate);
  if (
    lexicalRelative === ".." ||
    lexicalRelative.startsWith(`..${sep}`) ||
    isAbsolute(lexicalRelative)
  ) {
    throw new Error("outside project");
  }
  const stat = lstatSync(candidate);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("unsafe image file");
  }
  if (stat.size > MAX_IMAGE_BYTES) {
    throw new Error("image too large");
  }
  const actual = realpathSync(candidate);
  const actualRelative = relative(root, actual);
  if (
    actualRelative === ".." ||
    actualRelative.startsWith(`..${sep}`) ||
    isAbsolute(actualRelative) ||
    actual !== resolve(root, lexicalRelative)
  ) {
    throw new Error("unsafe image path");
  }
  return candidate;
}

function readReportPng(projectRoot: string, imagePath: string): Buffer {
  const safePath = containedPath(projectRoot, imagePath);
  const before = lstatSync(safePath);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      safePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.size > MAX_IMAGE_BYTES ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      throw new Error("unsafe image file");
    }
    const image = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (after.size !== image.length || after.size !== opened.size) {
      throw new Error("image changed while reading");
    }
    if (
      image.length < 33 ||
      !image.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ||
      image.readUInt32BE(8) !== 13 ||
      image.toString("ascii", 12, 16) !== "IHDR" ||
      image.readUInt32BE(16) !== 1_080 ||
      image.readUInt32BE(20) !== 1_440
    ) {
      throw new Error("invalid report png");
    }
    return image;
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
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
