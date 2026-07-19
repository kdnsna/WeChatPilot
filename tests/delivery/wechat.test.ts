import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as wechatDelivery from "../../src/delivery/wechat.js";

import {
  WechatLoginExpiredError,
  WechatDeliveryIndeterminateError,
  WechatDeliveryRejectedError,
  WechatMediaPreparationError,
  WechatPartialDeliveryError,
  initializeWechat,
  prepareWechatImageSender,
  sendWechatText,
  publicWechatError,
  splitWechatText,
  wechatHealth,
  type VendorWechatAdapter,
  type WechatCredentials,
} from "../../src/delivery/wechat.js";

const roots: string[] = [];
const credentials: WechatCredentials = {
  botToken: "test-only-bot-token",
  baseUrl: "https://ilinkai.weixin.qq.com",
  ilinkBotId: "bot-self",
  ilinkUserId: "user-self",
};
const ENROLLMENT_TIME = new Date("2026-07-18T13:00:00.000Z");

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "daily-tech-wechat-"));
  roots.push(root);
  return root;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function adapter(
  responses: readonly Response[],
  login = async () => credentials,
): VendorWechatAdapter & { requests: Array<{ url: string; init?: RequestInit }> } {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  let index = 0;
  return {
    requests,
    login,
    generateWechatUin: () => "123456789",
    async fetchWithRetry(url, init) {
      requests.push({ url, ...(init === undefined ? {} : { init }) });
      const response = responses[index++];
      if (response === undefined) {
        throw new Error("unexpected test request");
      }
      return response;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("WeChat enrollment", () => {
  it("writes a private project-local SVG for clients that hide terminal output", () => {
    const root = project();
    const writeQrSvg = (
      wechatDelivery as unknown as {
        writeWechatQrSvg?: (
          projectRoot: string,
          modules: readonly (readonly boolean[])[],
        ) => string;
      }
    ).writeWechatQrSvg;
    expect(writeQrSvg).toBeTypeOf("function");
    if (writeQrSvg === undefined) {
      return;
    }
    const modules = Array.from({ length: 21 }, (_, row) =>
      Array.from({ length: 21 }, (_, column) =>
        row === 0 || column === 0 || row === column,
      ),
    );

    const imagePath = writeQrSvg(root, modules);
    const svg = readFileSync(imagePath, "utf8");

    expect(imagePath).toBe(join(root, ".state", "wechat", "login-qr.svg"));
    expect(statSync(imagePath).mode & 0o777).toBe(0o600);
    expect(svg).toMatch(/^<svg[^>]+viewBox="0 0 29 29"/u);
    expect(svg).toContain("<path d=");
    expect(svg).not.toMatch(/<script|\bhref=/iu);
  });

  it("binds only the scanned owner and saves a private context token after plain 初始化", async () => {
    const root = project();
    const vendor = adapter([
      jsonResponse({
        ret: 0,
        get_updates_buf: "cursor-1",
        msgs: [
          {
            message_id: 1,
            create_time_ms: ENROLLMENT_TIME.getTime() + 1_000,
            from_user_id: "not-owner",
            message_type: 1,
            context_token: "wrong-token",
            item_list: [{ type: 1, text_item: { text: "初始化" } }],
          },
        ],
      }),
      jsonResponse({
        ret: 0,
        get_updates_buf: "cursor-2",
        msgs: [
          {
            message_id: 2,
            create_time_ms: ENROLLMENT_TIME.getTime() + 2_000,
            from_user_id: "user-self",
            message_type: 1,
            context_token: "owner-context-token",
            item_list: [{ type: 1, text_item: { text: "初始化" } }],
          },
        ],
      }),
    ]);
    const rendered: string[] = [];

    const result = await initializeWechat({
      projectRoot: root,
      vendor,
      renderQr: (content) => rendered.push(content),
      now: () => ENROLLMENT_TIME,
      deadlineMs: 10_000,
    });

    expect(result).toEqual({ status: "initialized", ownerBound: true });
    expect(rendered).toEqual([]);
    expect(wechatHealth(root)).toEqual({
      credentialsReady: true,
      ownerBound: true,
      contextReady: true,
    });
    const stateDir = join(root, ".state", "wechat");
    expect(statSync(stateDir).mode & 0o777).toBe(0o700);
    for (const file of [
      "credentials.json",
      "binding.json",
      "context.json",
      "poll-cursor.txt",
    ]) {
      expect(statSync(join(stateDir, file)).mode & 0o777).toBe(0o600);
    }
    expect(readFileSync(join(stateDir, "binding.json"), "utf8")).toContain(
      '"allowedUsers": [',
    );
    expect(readFileSync(join(stateDir, "context.json"), "utf8")).not.toContain(
      "wrong-token",
    );
  });

  it("surfaces an expired login once instead of polling forever", async () => {
    const root = project();
    const vendor = adapter([
      jsonResponse({ ret: 1, errcode: -14, errmsg: "expired", msgs: [] }),
    ]);

    await expect(
      initializeWechat({
        projectRoot: root,
        vendor,
        renderQr: () => undefined,
        deadlineMs: 10_000,
        now: () => ENROLLMENT_TIME,
      }),
    ).rejects.toBeInstanceOf(WechatLoginExpiredError);
    expect(vendor.requests).toHaveLength(1);
  });

  it("ignores a replayed 初始化 from before the current enrollment", async () => {
    const root = project();
    const vendor = adapter([
      jsonResponse({
        ret: 0,
        get_updates_buf: "cursor-old",
        msgs: [
          {
            message_id: 20,
            create_time_ms: ENROLLMENT_TIME.getTime() - 1,
            from_user_id: "user-self",
            message_type: 1,
            context_token: "stale-context",
            item_list: [{ type: 1, text_item: { text: "初始化" } }],
          },
        ],
      }),
      jsonResponse({
        ret: 0,
        get_updates_buf: "cursor-new",
        msgs: [
          {
            message_id: 21,
            create_time_ms: ENROLLMENT_TIME.getTime() + 1,
            from_user_id: "user-self",
            message_type: 1,
            context_token: "fresh-context",
            item_list: [{ type: 1, text_item: { text: "初始化" } }],
          },
        ],
      }),
    ]);

    await initializeWechat({
      projectRoot: root,
      vendor,
      renderQr: () => undefined,
      deadlineMs: 10_000,
      now: () => ENROLLMENT_TIME,
    });

    expect(vendor.requests).toHaveLength(2);
    const context = readFileSync(
      join(root, ".state", "wechat", "context.json"),
      "utf8",
    );
    expect(context).toContain("fresh-context");
    expect(context).not.toContain("stale-context");
  });

  it("rejects a credential-bearing API host outside the exact audited endpoint", async () => {
    const root = project();
    const vendor = adapter([], async () => ({
      ...credentials,
      baseUrl: "https://attacker.weixin.qq.com:444",
    }));

    await expect(
      initializeWechat({
        projectRoot: root,
        vendor,
        renderQr: () => undefined,
        deadlineMs: 10_000,
        now: () => ENROLLMENT_TIME,
      }),
    ).rejects.toThrow(/invalid|无效/u);
    expect(vendor.requests).toHaveLength(0);
  });

  it("rejects an initialization message ID already accepted by an earlier binding", async () => {
    const root = project();
    const first = adapter([
      jsonResponse({
        ret: 0,
        get_updates_buf: "cursor-first",
        msgs: [
          {
            message_id: 30,
            create_time_ms: ENROLLMENT_TIME.getTime() + 1,
            from_user_id: "user-self",
            message_type: 1,
            context_token: "first-context",
            item_list: [{ type: 1, text_item: { text: "初始化" } }],
          },
        ],
      }),
    ]);
    await initializeWechat({
      projectRoot: root,
      vendor: first,
      renderQr: () => undefined,
      deadlineMs: 10_000,
      now: () => ENROLLMENT_TIME,
    });

    const secondStart = new Date(ENROLLMENT_TIME.getTime() + 10_000);
    const second = adapter([
      jsonResponse({
        ret: 0,
        get_updates_buf: "cursor-replay",
        msgs: [
          {
            message_id: 30,
            create_time_ms: secondStart.getTime() + 1,
            from_user_id: "user-self",
            message_type: 1,
            context_token: "replayed-context",
            item_list: [{ type: 1, text_item: { text: "初始化" } }],
          },
        ],
      }),
      jsonResponse({
        ret: 0,
        get_updates_buf: "cursor-fresh",
        msgs: [
          {
            message_id: 31,
            create_time_ms: secondStart.getTime() + 2,
            from_user_id: "user-self",
            message_type: 1,
            context_token: "second-context",
            item_list: [{ type: 1, text_item: { text: "初始化" } }],
          },
        ],
      }),
    ]);
    await initializeWechat({
      projectRoot: root,
      vendor: second,
      renderQr: () => undefined,
      deadlineMs: 10_000,
      now: () => secondStart,
    });

    expect(second.requests).toHaveLength(2);
    const context = readFileSync(
      join(root, ".state", "wechat", "context.json"),
      "utf8",
    );
    expect(context).toContain("second-context");
    expect(context).not.toContain("replayed-context");
  });

  it("resumes a pending owner binding without another QR login", async () => {
    const root = project();
    const first = adapter([
      jsonResponse({
        ret: 0,
        get_updates_buf: "cursor-first",
        msgs: [
          {
            message_id: 40,
            create_time_ms: ENROLLMENT_TIME.getTime() + 1,
            from_user_id: "user-self",
            message_type: 1,
            context_token: "first-context",
            item_list: [{ type: 1, text_item: { text: "初始化" } }],
          },
        ],
      }),
    ]);
    await initializeWechat({
      projectRoot: root,
      vendor: first,
      renderQr: () => undefined,
      deadlineMs: 10_000,
      now: () => ENROLLMENT_TIME,
    });
    const resumedAt = ENROLLMENT_TIME.getTime() + 20_000;
    const contextPath = join(root, ".state", "wechat", "context.json");
    writeFileSync(
      contextPath,
      `${JSON.stringify({
        version: 1,
        status: "pending",
        userId: "user-self",
        enrollmentStartedAtMs: resumedAt,
        seenInitializationMessageIds: [40],
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    chmodSync(contextPath, 0o600);
    const resumed = adapter(
      [
        jsonResponse({
          ret: 0,
          get_updates_buf: "cursor-invalid",
          msgs: [
            {
              message_id: "not-a-number",
              create_time_ms: resumedAt + 1,
              from_user_id: "user-self",
              message_type: 1,
              context_token: "invalid-context",
              item_list: [{ type: 1, text_item: { text: "初始化" } }],
            },
          ],
        }),
        jsonResponse({
          ret: 0,
          get_updates_buf: "cursor-resumed",
          msgs: [
            {
              message_id: Number.MAX_SAFE_INTEGER + 1,
              create_time_ms: resumedAt + 1,
              from_user_id: "user-self",
              message_type: 1,
              context_token: "resumed-context",
              item_list: [{ type: 1, text_item: { text: "初始化" } }],
            },
          ],
        }),
      ],
      async () => {
        throw new Error("resume must not invoke QR login");
      },
    );
    const pollSummaries: unknown[] = [];
    const resumeWechatInitialization = (
      wechatDelivery as unknown as {
        resumeWechatInitialization?: (options: {
          projectRoot: string;
          vendor: VendorWechatAdapter;
          deadlineMs: number;
          now: () => Date;
          onPollSummary: (summary: unknown) => void;
        }) => Promise<{ status: "initialized"; ownerBound: true }>;
      }
    ).resumeWechatInitialization;
    expect(resumeWechatInitialization).toBeTypeOf("function");
    if (resumeWechatInitialization === undefined) {
      return;
    }

    await expect(
      resumeWechatInitialization({
        projectRoot: root,
        vendor: resumed,
        deadlineMs: 10_000,
        now: () => new Date(resumedAt),
        onPollSummary: (summary) => pollSummaries.push(summary),
      }),
    ).resolves.toEqual({ status: "initialized", ownerBound: true });
    expect(resumed.requests).toHaveLength(2);
    expect(pollSummaries).toEqual([
      {
        totalMessages: 1,
        invalidMessages: 1,
        invalidFields: ["message_id"],
        wrongMessageType: 0,
        wrongOwner: 0,
        beforeEnrollment: 0,
        replayedInitialization: 0,
        notPlainInitialization: 0,
        accepted: 0,
      },
      {
        totalMessages: 1,
        invalidMessages: 0,
        invalidFields: [],
        wrongMessageType: 0,
        wrongOwner: 0,
        beforeEnrollment: 0,
        replayedInitialization: 0,
        notPlainInitialization: 0,
        accepted: 1,
      },
    ]);
    expect(readFileSync(contextPath, "utf8")).toContain("resumed-context");
  });
});

describe("WeChat proactive send", () => {
  it("uses the upstream paragraph-first 2000-unit segmentation behavior", () => {
    const text = `${"甲".repeat(1_500)}\n\n${"乙".repeat(1_500)}`;
    const chunks = splitWechatText(text);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe("甲".repeat(1_500));
    expect(chunks[1]).toBe("乙".repeat(1_500));
    expect(chunks.every((chunk) => chunk.length <= 2_000)).toBe(true);
  });

  it("sends only to the bound owner without exposing target selection", async () => {
    const root = project();
    const enroll = adapter([
      jsonResponse({
        ret: 0,
        get_updates_buf: "cursor",
        msgs: [
          {
            message_id: 3,
            create_time_ms: ENROLLMENT_TIME.getTime() + 3_000,
            from_user_id: "user-self",
            message_type: 1,
            context_token: "owner-context-token",
            item_list: [{ type: 1, text_item: { text: "初始化" } }],
          },
        ],
      }),
    ]);
    await initializeWechat({
      projectRoot: root,
      vendor: enroll,
      renderQr: () => undefined,
      deadlineMs: 10_000,
      now: () => ENROLLMENT_TIME,
    });
    const sender = adapter([jsonResponse({ ret: 0 }), jsonResponse({ ret: 0 })]);

    const result = await sendWechatText({
      projectRoot: root,
      text: `${"甲".repeat(1_500)}\n\n${"乙".repeat(1_500)}`,
      vendor: sender,
      sleep: async () => undefined,
    });

    expect(result).toEqual({ status: "sent", chunks: 2 });
    expect(sender.requests).toHaveLength(2);
    for (const request of sender.requests) {
      const body = JSON.parse(String(request.init?.body));
      expect(body.msg.to_user_id).toBe("user-self");
      expect(body.msg.context_token).toBe("owner-context-token");
      expect(request.init?.headers).toMatchObject({
        Authorization: "Bearer test-only-bot-token",
      });
    }
  });

  it("returns an image closure that keeps the already-validated owner session", async () => {
    const root = project();
    const enroll = adapter([
      jsonResponse({
        ret: 0,
        get_updates_buf: "cursor",
        msgs: [
          {
            message_id: 31,
            create_time_ms: ENROLLMENT_TIME.getTime() + 3_100,
            from_user_id: "user-self",
            message_type: 1,
            context_token: "owner-context-token",
            item_list: [{ type: 1, text_item: { text: "初始化" } }],
          },
        ],
      }),
    ]);
    await initializeWechat({
      projectRoot: root,
      vendor: enroll,
      renderQr: () => undefined,
      deadlineMs: 10_000,
      now: () => ENROLLMENT_TIME,
    });
    const sender = adapter([
      jsonResponse({ ret: 0, upload_param: "upload-param" }),
      new Response(null, {
        status: 200,
        headers: { "x-encrypted-param": "download-param" },
      }),
      jsonResponse({ ret: 0 }),
    ]);
    const prepared = await prepareWechatImageSender({
      projectRoot: root,
      vendor: sender,
      randomBytes: () => Buffer.alloc(16, 0x44),
      clientId: () => "image-client-id",
    });
    const stateDir = join(root, ".state", "wechat");
    writeFileSync(
      join(stateDir, "credentials.json"),
      `${JSON.stringify({
        ...credentials,
        botToken: "replacement-fixture-value",
        ilinkUserId: "replacement-user",
      })}\n`,
    );
    writeFileSync(
      join(stateDir, "context.json"),
      `${JSON.stringify({
        version: 1,
        status: "ready",
        userId: "replacement-user",
        contextToken: "replacement-context",
        capturedAt: ENROLLMENT_TIME.toISOString(),
        initializationMessageId: 31,
        initializationCreateTimeMs: ENROLLMENT_TIME.getTime() + 3_100,
        seenInitializationMessageIds: [31],
      })}\n`,
    );
    const imagePath = join(root, "report.png");
    const pngHeader = Buffer.alloc(33);
    Buffer.from("89504e470d0a1a0a", "hex").copy(pngHeader);
    pngHeader.writeUInt32BE(13, 8);
    pngHeader.write("IHDR", 12, "ascii");
    pngHeader.writeUInt32BE(1_080, 16);
    pngHeader.writeUInt32BE(1_440, 20);
    writeFileSync(imagePath, pngHeader);

    await expect(prepared(imagePath)).resolves.toEqual({ status: "sent" });

    expect(sender.requests).toHaveLength(3);
    const uploadBody = JSON.parse(String(sender.requests[0]?.init?.body));
    const sendBody = JSON.parse(String(sender.requests[2]?.init?.body));
    expect(uploadBody.to_user_id).toBe("user-self");
    expect(sendBody.msg.to_user_id).toBe("user-self");
    expect(sendBody.msg.context_token).toBe("owner-context-token");
    expect(sender.requests[2]?.init?.headers).toMatchObject({
      Authorization: "Bearer test-only-bot-token",
    });
  });

  it("refuses insecure or tampered owner binding before any network call", async () => {
    const root = project();
    const enroll = adapter([
      jsonResponse({
        ret: 0,
        get_updates_buf: "cursor",
        msgs: [
          {
            message_id: 4,
            create_time_ms: ENROLLMENT_TIME.getTime() + 4_000,
            from_user_id: "user-self",
            message_type: 1,
            context_token: "owner-context-token",
            item_list: [{ type: 1, text_item: { text: "初始化" } }],
          },
        ],
      }),
    ]);
    await initializeWechat({
      projectRoot: root,
      vendor: enroll,
      renderQr: () => undefined,
      deadlineMs: 10_000,
      now: () => ENROLLMENT_TIME,
    });
    const bindingPath = join(root, ".state", "wechat", "binding.json");
    chmodSync(bindingPath, 0o644);
    const sender = adapter([]);

    await expect(
      sendWechatText({ projectRoot: root, text: "test", vendor: sender }),
    ).rejects.toThrow(/private|permission/i);
    expect(sender.requests).toHaveLength(0);
  });

  it("turns API session expiry into a bounded rescan instruction", async () => {
    const root = project();
    const enroll = adapter([
      jsonResponse({
        ret: 0,
        get_updates_buf: "cursor",
        msgs: [
          {
            message_id: 5,
            create_time_ms: ENROLLMENT_TIME.getTime() + 5_000,
            from_user_id: "user-self",
            message_type: 1,
            context_token: "owner-context-token",
            item_list: [{ type: 1, text_item: { text: "初始化" } }],
          },
        ],
      }),
    ]);
    await initializeWechat({
      projectRoot: root,
      vendor: enroll,
      renderQr: () => undefined,
      deadlineMs: 10_000,
      now: () => ENROLLMENT_TIME,
    });
    const sender = adapter([
      jsonResponse({ ret: 1, errcode: -13, errmsg: "do not leak" }),
    ]);

    await expect(
      sendWechatText({ projectRoot: root, text: "test", vendor: sender }),
    ).rejects.toBeInstanceOf(WechatLoginExpiredError);
    expect(sender.requests).toHaveLength(1);
  });

  it("classifies explicit service rejection separately from lost responses", async () => {
    const root = project();
    const enroll = adapter([
      jsonResponse({
        ret: 0,
        get_updates_buf: "cursor",
        msgs: [
          {
            message_id: 51,
            create_time_ms: ENROLLMENT_TIME.getTime() + 5_100,
            from_user_id: "user-self",
            message_type: 1,
            context_token: "owner-context-token",
            item_list: [{ type: 1, text_item: { text: "初始化" } }],
          },
        ],
      }),
    ]);
    await initializeWechat({
      projectRoot: root,
      vendor: enroll,
      renderQr: () => undefined,
      deadlineMs: 10_000,
      now: () => ENROLLMENT_TIME,
    });
    const sender = adapter([jsonResponse({ ret: -2, errmsg: "rate limited" })]);

    await expect(
      sendWechatText({ projectRoot: root, text: "test", vendor: sender }),
    ).rejects.toBeInstanceOf(WechatDeliveryRejectedError);
  });

  it("reports an uncertain partial delivery instead of inviting a full retry", async () => {
    const root = project();
    const enroll = adapter([
      jsonResponse({
        ret: 0,
        get_updates_buf: "cursor",
        msgs: [
          {
            message_id: 6,
            create_time_ms: ENROLLMENT_TIME.getTime() + 6_000,
            from_user_id: "user-self",
            message_type: 1,
            context_token: "owner-context-token",
            item_list: [{ type: 1, text_item: { text: "初始化" } }],
          },
        ],
      }),
    ]);
    await initializeWechat({
      projectRoot: root,
      vendor: enroll,
      renderQr: () => undefined,
      deadlineMs: 10_000,
      now: () => ENROLLMENT_TIME,
    });
    const sender = adapter([
      jsonResponse({ ret: 0 }),
      jsonResponse({ ret: 1, errcode: -13 }),
    ]);

    await expect(
      sendWechatText({
        projectRoot: root,
        text: `${"甲".repeat(1_500)}\n\n${"乙".repeat(1_500)}`,
        vendor: sender,
        sleep: async () => undefined,
      }),
    ).rejects.toMatchObject({
      name: "WechatPartialDeliveryError",
      sentChunks: 1,
      loginExpired: true,
    });
    expect(sender.requests).toHaveLength(2);
    expect(publicWechatError(new WechatPartialDeliveryError(1, true))).toMatch(
      /重新.*初始化|扫码/u,
    );
  });

  it("treats a lost first response as indeterminate and does not retry the POST", async () => {
    const root = project();
    const enroll = adapter([
      jsonResponse({
        ret: 0,
        get_updates_buf: "cursor",
        msgs: [
          {
            message_id: 7,
            create_time_ms: ENROLLMENT_TIME.getTime() + 7_000,
            from_user_id: "user-self",
            message_type: 1,
            context_token: "owner-context-token",
            item_list: [{ type: 1, text_item: { text: "初始化" } }],
          },
        ],
      }),
    ]);
    await initializeWechat({
      projectRoot: root,
      vendor: enroll,
      renderQr: () => undefined,
      deadlineMs: 10_000,
      now: () => ENROLLMENT_TIME,
    });
    const sender = adapter([]);

    await expect(
      sendWechatText({ projectRoot: root, text: "test", vendor: sender }),
    ).rejects.toBeInstanceOf(WechatDeliveryIndeterminateError);
    expect(sender.requests).toHaveLength(1);
    expect(sender.requests[0]?.init).toMatchObject({ retries: 0 });
  });

  it("publishes only the fixed media preparation error", () => {
    expect(publicWechatError(new WechatMediaPreparationError())).toBe(
      "微信报告图片准备失败，未尝试发送图片消息",
    );
  });
});
