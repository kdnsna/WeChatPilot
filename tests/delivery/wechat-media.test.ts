import { createDecipheriv, createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

import {
  WechatDeliveryIndeterminateError,
  WechatDeliveryRejectedError,
  sendWechatImage,
  type VendorWechatAdapter,
} from "../../src/delivery/wechat.js";
import { WechatMediaPreparationError } from "../../src/delivery/wechat-media.js";

const roots: string[] = [];
const OWNER_ID = "fixture-owner";
const CONTEXT_TOKEN = "fixture-context-not-secret";
const BOT_TOKEN = "fixture-bot-token-not-secret";

function crc32(data: Buffer): number {
  let crc = 0xffff_ffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function realReportPng(width = 1_080, height = 1_440): Buffer {
  const signature = Buffer.from("89504e470d0a1a0a", "hex");
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const scanlines = Buffer.alloc((width + 1) * height);
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function writePrivateJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function projectWithBoundOwner(): { root: string; imagePath: string; png: Buffer } {
  const root = mkdtempSync(join(tmpdir(), "daily-tech-wechat-media-"));
  roots.push(root);
  const state = join(root, ".state", "wechat");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  chmodSync(state, 0o700);
  writePrivateJson(join(state, "credentials.json"), {
    botToken: BOT_TOKEN,
    baseUrl: "https://ilinkai.weixin.qq.com",
    ilinkBotId: "fixture-bot",
    ilinkUserId: OWNER_ID,
  });
  writePrivateJson(join(state, "binding.json"), {
    version: 1,
    allowedUsers: [OWNER_ID],
  });
  writePrivateJson(join(state, "context.json"), {
    version: 1,
    status: "ready",
    userId: OWNER_ID,
    contextToken: CONTEXT_TOKEN,
    capturedAt: "2026-07-20T00:00:00.000Z",
    initializationMessageId: 1,
    initializationCreateTimeMs: 1,
    seenInitializationMessageIds: [1],
  });
  const png = realReportPng();
  const imagePath = join(root, "output", "report.png");
  mkdirSync(join(root, "output"), { recursive: true });
  writeFileSync(imagePath, png);
  return { root, imagePath, png };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function adapter(
  responses: readonly (Response | Error)[],
): VendorWechatAdapter & {
  readonly requests: Array<{ readonly url: string; readonly init?: RequestInit }>;
} {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  let index = 0;
  return {
    requests,
    login: async () => {
      throw new Error("login must not be called");
    },
    generateWechatUin: () => "fixture-uin",
    async fetchWithRetry(url, init) {
      requests.push({ url, ...(init === undefined ? {} : { init }) });
      const response = responses[index++];
      if (response instanceof Error) {
        throw response;
      }
      if (response === undefined) {
        throw new Error("unexpected test request");
      }
      return response;
    },
  };
}

async function preparationFailure(
  root: string,
  imagePath: string,
  vendor: VendorWechatAdapter,
): Promise<WechatMediaPreparationError> {
  try {
    await sendWechatImage({ projectRoot: root, imagePath, vendor });
  } catch (error) {
    expect(error).toBeInstanceOf(WechatMediaPreparationError);
    expect(error).toMatchObject({
      message: "微信报告图片准备失败，未尝试发送图片消息",
    });
    const message = error instanceof Error ? error.message : String(error);
    for (const sensitive of [
      BOT_TOKEN,
      OWNER_ID,
      CONTEXT_TOKEN,
      imagePath,
      "fixture-upload-param",
      "fixture-download-param",
      "response-body-secret",
    ]) {
      expect(message).not.toContain(sensitive);
    }
    return error as WechatMediaPreparationError;
  }
  throw new Error("expected preparation failure");
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("WeChat report image delivery", () => {
  it("encrypts and uploads a real 1080x1440 PNG before one owner-bound image send", async () => {
    const { root, imagePath, png } = projectWithBoundOwner();
    const fileKeyBytes = Buffer.alloc(16, 0x11);
    const aesKey = Buffer.alloc(16, 0x22);
    const randomValues = [fileKeyBytes, aesKey];
    const vendor = adapter([
      jsonResponse({ ret: 0, upload_param: "fixture-upload-param" }),
      new Response(null, {
        status: 200,
        headers: { "x-encrypted-param": "fixture-download-param" },
      }),
      jsonResponse({ ret: 0 }),
    ]);

    const result = await sendWechatImage({
      projectRoot: root,
      imagePath,
      vendor,
      randomBytes: (size) => {
        expect(size).toBe(16);
        const value = randomValues.shift();
        if (value === undefined) {
          throw new Error("unexpected random request");
        }
        return value;
      },
      clientId: () => "fixture-client-id",
    });

    expect(result).toEqual({ status: "sent" });
    expect(randomValues).toHaveLength(0);
    expect(vendor.requests).toHaveLength(3);

    const getUpload = vendor.requests[0]!;
    expect(getUpload.url).toBe(
      "https://ilinkai.weixin.qq.com/ilink/bot/getuploadurl",
    );
    expect(getUpload.init).toMatchObject({
      method: "POST",
      retries: 0,
      headers: {
        "Content-Type": "application/json",
        AuthorizationType: "ilink_bot_token",
        Authorization: `Bearer ${BOT_TOKEN}`,
        "X-WECHAT-UIN": "fixture-uin",
      },
    });
    const getUploadBody = JSON.parse(String(getUpload.init?.body));
    const paddedSize = Math.ceil((png.length + 1) / 16) * 16;
    expect(getUploadBody).toEqual({
      filekey: fileKeyBytes.toString("hex"),
      media_type: 1,
      to_user_id: OWNER_ID,
      rawsize: png.length,
      rawfilemd5: createHash("md5").update(png).digest("hex"),
      filesize: paddedSize,
      aeskey: aesKey.toString("hex"),
      no_need_thumb: true,
      base_info: { channel_version: "1.0.2" },
    });

    const cdnUpload = vendor.requests[1]!;
    expect(cdnUpload.url).toBe(
      "https://novac2c.cdn.weixin.qq.com/c2c/upload?encrypted_query_param=fixture-upload-param&filekey=11111111111111111111111111111111",
    );
    expect(cdnUpload.init).toMatchObject({
      method: "POST",
      retries: 0,
      headers: { "Content-Type": "application/octet-stream" },
    });
    const ciphertext = Buffer.from(
      cdnUpload.init?.body as Uint8Array<ArrayBuffer>,
    );
    expect(ciphertext).toHaveLength(paddedSize);
    const decipher = createDecipheriv("aes-128-ecb", aesKey, null);
    expect(Buffer.concat([decipher.update(ciphertext), decipher.final()])).toEqual(
      png,
    );

    const finalSend = vendor.requests[2]!;
    expect(finalSend.url).toBe(
      "https://ilinkai.weixin.qq.com/ilink/bot/sendmessage",
    );
    expect(finalSend.init).toMatchObject({ method: "POST", retries: 0 });
    const finalBody = JSON.parse(String(finalSend.init?.body));
    expect(finalBody).toEqual({
      msg: {
        from_user_id: "",
        to_user_id: OWNER_ID,
        client_id: "fixture-client-id",
        message_type: 2,
        message_state: 2,
        context_token: CONTEXT_TOKEN,
        item_list: [
          {
            type: 2,
            image_item: {
              media: {
                encrypt_query_param: "fixture-download-param",
                aes_key: Buffer.from(aesKey.toString("hex"), "ascii").toString(
                  "base64",
                ),
                encrypt_type: 1,
              },
              mid_size: paddedSize,
            },
          },
        ],
      },
      base_info: { channel_version: "1.0.2" },
    });
  });

  it("rejects an image outside the project before any request", async () => {
    const bound = projectWithBoundOwner();
    const outside = projectWithBoundOwner();
    const vendor = adapter([]);

    await preparationFailure(bound.root, outside.imagePath, vendor);

    expect(vendor.requests).toHaveLength(0);
  });

  it("rejects a symlink before any request", async () => {
    const { root, imagePath } = projectWithBoundOwner();
    const linkPath = join(root, "output", "linked-report.png");
    symlinkSync(imagePath, linkPath);
    const vendor = adapter([]);

    await preparationFailure(root, linkPath, vendor);

    expect(vendor.requests).toHaveLength(0);
  });

  it("rejects non-PNG bytes before any request", async () => {
    const { root, imagePath } = projectWithBoundOwner();
    writeFileSync(imagePath, Buffer.from("not a png", "utf8"));
    const vendor = adapter([]);

    await preparationFailure(root, imagePath, vendor);

    expect(vendor.requests).toHaveLength(0);
  });

  it("rejects a PNG with the wrong IHDR dimensions before any request", async () => {
    const { root, imagePath } = projectWithBoundOwner();
    writeFileSync(imagePath, realReportPng(1_079, 1_440));
    const vendor = adapter([]);

    await preparationFailure(root, imagePath, vendor);

    expect(vendor.requests).toHaveLength(0);
  });

  it("rejects a file over 5 MiB using metadata before reading or requesting", async () => {
    const { root, imagePath, png } = projectWithBoundOwner();
    const oversized = Buffer.alloc(5 * 1_024 * 1_024 + 1);
    png.copy(oversized);
    writeFileSync(imagePath, oversized);
    const vendor = adapter([]);

    await preparationFailure(root, imagePath, vendor);

    expect(vendor.requests).toHaveLength(0);
  });

  it("turns expired upload authorization into a fixed preparation error", async () => {
    const { root, imagePath } = projectWithBoundOwner();
    const vendor = adapter([
      jsonResponse({
        errcode: -14,
        upload_param: "response-body-secret",
      }),
    ]);

    await preparationFailure(root, imagePath, vendor);

    expect(vendor.requests).toHaveLength(1);
  });

  it("rejects a missing upload_param without attempting CDN or final send", async () => {
    const { root, imagePath } = projectWithBoundOwner();
    const vendor = adapter([
      jsonResponse({ ret: 0, response: "response-body-secret" }),
    ]);

    await preparationFailure(root, imagePath, vendor);

    expect(vendor.requests).toHaveLength(1);
  });

  it("rejects a missing x-encrypted-param without attempting final send", async () => {
    const { root, imagePath } = projectWithBoundOwner();
    const vendor = adapter([
      jsonResponse({ ret: 0, upload_param: "fixture-upload-param" }),
      new Response("response-body-secret", { status: 200 }),
    ]);

    await preparationFailure(root, imagePath, vendor);

    expect(vendor.requests).toHaveLength(2);
  });

  it("uses the existing rejected-send error for an explicit final ret", async () => {
    const { root, imagePath } = projectWithBoundOwner();
    const vendor = adapter([
      jsonResponse({ ret: 0, upload_param: "fixture-upload-param" }),
      new Response(null, {
        status: 200,
        headers: { "x-encrypted-param": "fixture-download-param" },
      }),
      jsonResponse({ ret: -2, errmsg: "response-body-secret" }),
    ]);

    await expect(
      sendWechatImage({ projectRoot: root, imagePath, vendor }),
    ).rejects.toBeInstanceOf(WechatDeliveryRejectedError);
    expect(vendor.requests).toHaveLength(3);
    expect(vendor.requests[2]?.init).toMatchObject({ retries: 0 });
  });

  it("uses the existing indeterminate error when the final response is lost", async () => {
    const { root, imagePath } = projectWithBoundOwner();
    const vendor = adapter([
      jsonResponse({ ret: 0, upload_param: "fixture-upload-param" }),
      new Response(null, {
        status: 200,
        headers: { "x-encrypted-param": "fixture-download-param" },
      }),
      new Error("response-body-secret"),
    ]);

    await expect(
      sendWechatImage({ projectRoot: root, imagePath, vendor }),
    ).rejects.toBeInstanceOf(WechatDeliveryIndeterminateError);
    expect(vendor.requests).toHaveLength(3);
    expect(vendor.requests[2]?.init).toMatchObject({ retries: 0 });
  });
});
