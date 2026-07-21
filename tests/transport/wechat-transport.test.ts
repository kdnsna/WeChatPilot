import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchWithRetry } from "../../src/transport/wechat-transport.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WeChat transport redirects", () => {
  it.each([301, 302, 307, 308])(
    "rejects %i without following an authenticated request to another origin",
    async (status) => {
      const fetchMock = vi.fn(async () => new Response(null, {
        status,
        headers: { location: "https://untrusted.example/collect" },
      }));
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        fetchWithRetry("https://ilinkai.weixin.qq.com/ilink/bot/sendmessage", {
          headers: {
            Authorization: "Bearer test-token",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ context_token: "test-context", to_user_id: "test-user" }),
          method: "POST",
          retries: 0,
        }),
      ).rejects.toThrow(/redirect/i);

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock).toHaveBeenCalledWith(
        "https://ilinkai.weixin.qq.com/ilink/bot/sendmessage",
        expect.objectContaining({ redirect: "manual" }),
      );
    },
  );

  it("uses an explicit no-follow policy for an unauthenticated QR request", async () => {
    const fetchMock = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);

    await fetchWithRetry("https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode", {
      retries: 0,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode",
      expect.objectContaining({ redirect: "manual" }),
    );
  });
});
