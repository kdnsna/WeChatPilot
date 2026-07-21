import { describe, expect, it, vi } from "vitest";

import type { DigestCandidate } from "../../src/digest/candidates.js";
import * as digestLinks from "../../src/digest/links.js";
import {
  DigestLinkAccessibilityError,
  createPublicLinkProbe,
  ensureAccessibleDigestLinks,
  type PublicHostnameResolver,
} from "../../src/digest/links.js";
import type { DigestOutput } from "../../src/digest/validate.js";
import type { FetchLike } from "../../src/lib/http.js";
import { validEditorial } from "../helpers/editorial.js";

const DATE = "2026-07-18";
const TITLE = "《科技与灵感日报｜2026年07月18日》";
const PRIMARY_URLS = Array.from(
  { length: 13 },
  (_, index) => `https://source-${index + 1}.test/article`,
);
const publicResolver: PublicHostnameResolver = async () => ["93.184.216.34"];

function testPublicDnsResolver(
  ipv4: () => Promise<readonly string[]>,
  ipv6: () => Promise<readonly string[]>,
) {
  return {
    setServers: vi.fn((_servers: string[]): void => undefined),
    resolve4: vi.fn(async (_hostname: string) => await ipv4()),
    resolve6: vi.fn(async (_hostname: string) => await ipv6()),
    cancel: vi.fn((): void => undefined),
  };
}

function digestWith(urls: readonly string[]): string {
  let urlIndex = 0;
  const entries = (count: number): string =>
    Array.from({ length: count }, (_, index) => {
      const url = urls[urlIndex] ?? urls[0]!;
      urlIndex += 1;
      return `【${index + 1}】候选标题\n事实：这是一段经过来源核验的技术事实。意义：解释技术机制、讨论热度和行业影响，并把事实与判断明确分开。依据：来源内百分位和发布时间衰减。\n原文链接：${url}`;
    }).join("\n\n");
  let digest = `${TITLE}\n\n一、今日技术社区热议\n${entries(3)}\n\n二、科技圈核心新闻\n${entries(5)}\n\n三、GitHub 今日发现\n${entries(3)}\n\n四、今日深度阅读\n${entries(2)}\n\n五、今日一句判断\n判断：当前变化值得持续观察，但不应把短期热度夸大为确定趋势。`;
  while (
    [
      ...digest
        .replace(/https?:\/\/[^\s<>"']+/gu, "")
        .replace(/\s/gu, ""),
    ].length < 2_100
  ) {
    digest += "需要继续用公开指标和后续事实验证这一判断。";
  }
  return digest;
}

function output(urls: readonly string[] = PRIMARY_URLS): DigestOutput {
  return {
    title: TITLE,
    date: DATE,
    digest: digestWith(urls),
    sourceUrls: [...urls],
    editorial: validEditorial(urls),
  };
}

function candidate(
  index: number,
  overrides: Partial<DigestCandidate> = {},
): DigestCandidate {
  return {
    id: `C${String(index + 1).padStart(3, "0")}`,
    lanes: ["news"],
    source: "rss:test",
    category: "news",
    title: `Candidate ${index + 1}`,
    url: PRIMARY_URLS[index]!,
    author: null,
    publishedAt: "2026-07-18T05:00:00.000Z",
    comments: null,
    score: null,
    stars: null,
    summary: null,
    rawMetrics: {},
    heatScore: 50,
    components: {
      engagement: 0.5,
      popularity: 0.5,
      velocity: 0.5,
      recency: 0.5,
      crossSource: 0,
      sourceQuality: 0.9,
    },
    historyFactor: 1,
    velocityMetric: "none",
    confirmedBy: ["rss:test"],
    relatedUrls: [PRIMARY_URLS[index]!],
    reason: "来源质量 90%",
    ...overrides,
  };
}

describe("digest source-link accessibility", () => {
  it("provides an injectable default hostname resolver seam", () => {
    expect(
      (digestLinks as Readonly<Record<string, unknown>>)[
        "createDefaultHostnameResolver"
      ],
    ).toBeTypeOf("function");
  });

  it("re-resolves an all-Fake-IP hostname through hardcoded public DNS", async () => {
    const systemLookup = vi.fn<PublicHostnameResolver>(async () => [
      "198.18.73.195",
    ]);
    const dns = testPublicDnsResolver(
      async () => ["104.18.12.123"],
      async () => ["2606:4700:4700::1111"],
    );
    const createPublicDnsResolver = vi.fn(() => dns);
    const resolver = digestLinks.createDefaultHostnameResolver({
      systemLookup,
      createPublicDnsResolver,
    });
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));

    await expect(
      createPublicLinkProbe(fetch, resolver)("https://public-name.test/article"),
    ).resolves.toBe(true);
    expect(dns.setServers).toHaveBeenCalledWith(["1.1.1.1", "8.8.8.8"]);
    expect(dns.resolve4).toHaveBeenCalledWith("public-name.test");
    expect(dns.resolve6).toHaveBeenCalledWith("public-name.test");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("accepts a nonempty public A result when public DNS has no AAAA result", async () => {
    const dns = testPublicDnsResolver(
      async () => ["104.18.12.123"],
      async () => {
        throw new Error("no AAAA answer");
      },
    );
    const resolver = digestLinks.createDefaultHostnameResolver({
      systemLookup: async () => ["198.19.4.7"],
      createPublicDnsResolver: () => dns,
    });

    await expect(
      createPublicLinkProbe(
        async () => new Response(null, { status: 200 }),
        resolver,
      )("https://public-name.test/article"),
    ).resolves.toBe(true);
  });

  it("rejects mixed public-DNS answers after an all-Fake-IP lookup", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));
    const dns = testPublicDnsResolver(
      async () => ["104.18.12.123", "10.0.0.7"],
      async () => [],
    );
    const createPublicDnsResolver = vi.fn(() => dns);
    const resolver = digestLinks.createDefaultHostnameResolver({
      systemLookup: async () => ["198.18.73.195"],
      createPublicDnsResolver,
    });

    await expect(
      createPublicLinkProbe(fetch, resolver)("https://public-name.test/article"),
    ).resolves.toBe(false);
    expect(createPublicDnsResolver).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an empty public-DNS result after an all-Fake-IP lookup", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));
    const dns = testPublicDnsResolver(async () => [], async () => []);
    const resolver = digestLinks.createDefaultHostnameResolver({
      systemLookup: async () => ["198.18.73.195"],
      createPublicDnsResolver: () => dns,
    });

    await expect(
      createPublicLinkProbe(fetch, resolver)("https://public-name.test/article"),
    ).resolves.toBe(false);
    expect(dns.resolve4).toHaveBeenCalledOnce();
    expect(dns.resolve6).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not use public DNS for mixed Fake-IP and public system answers", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));
    const createPublicDnsResolver = vi.fn(() =>
      testPublicDnsResolver(async () => ["104.18.12.123"], async () => []),
    );
    const resolver = digestLinks.createDefaultHostnameResolver({
      systemLookup: async () => ["198.18.73.195", "93.184.216.34"],
      createPublicDnsResolver,
    });

    await expect(
      createPublicLinkProbe(fetch, resolver)("https://public-name.test/article"),
    ).resolves.toBe(false);
    expect(createPublicDnsResolver).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects mixed real private and public system answers without fallback", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));
    const createPublicDnsResolver = vi.fn(() =>
      testPublicDnsResolver(async () => ["104.18.12.123"], async () => []),
    );
    const resolver = digestLinks.createDefaultHostnameResolver({
      systemLookup: async () => ["10.0.0.7", "93.184.216.34"],
      createPublicDnsResolver,
    });

    await expect(
      createPublicLinkProbe(fetch, resolver)("https://public-name.test/article"),
    ).resolves.toBe(false);
    expect(createPublicDnsResolver).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["10.0.0.7", "127.0.0.1", "169.254.1.2", "192.168.1.2"])(
    "does not use public DNS for another private system answer %s",
    async (privateAddress) => {
      const fetch = vi.fn(async () => new Response(null, { status: 200 }));
      const createPublicDnsResolver = vi.fn(() =>
        testPublicDnsResolver(async () => ["104.18.12.123"], async () => []),
      );
      const resolver = digestLinks.createDefaultHostnameResolver({
        systemLookup: async () => [privateAddress],
        createPublicDnsResolver,
      });

      await expect(
        createPublicLinkProbe(fetch, resolver)(
          "https://public-name.test/article",
        ),
      ).resolves.toBe(false);
      expect(createPublicDnsResolver).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("keeps a literal Fake-IP URL blocked without invoking either resolver", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));
    const systemLookup = vi.fn<PublicHostnameResolver>(async () => [
      "93.184.216.34",
    ]);
    const createPublicDnsResolver = vi.fn(() =>
      testPublicDnsResolver(async () => ["104.18.12.123"], async () => []),
    );
    const resolver = digestLinks.createDefaultHostnameResolver({
      systemLookup,
      createPublicDnsResolver,
    });

    await expect(
      createPublicLinkProbe(fetch, resolver)("http://198.18.73.195/private"),
    ).resolves.toBe(false);
    expect(systemLookup).not.toHaveBeenCalled();
    expect(createPublicDnsResolver).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("cancels in-flight public DNS resolution on external abort", async () => {
    const never = async (): Promise<readonly string[]> =>
      await new Promise<readonly string[]>(() => undefined);
    const dns = testPublicDnsResolver(never, never);
    const resolver = digestLinks.createDefaultHostnameResolver({
      systemLookup: async () => ["198.18.73.195"],
      createPublicDnsResolver: () => dns,
    });
    const controller = new AbortController();
    const pending = createPublicLinkProbe(
      async () => new Response(null, { status: 200 }),
      resolver,
    )("https://public-name.test/article", controller.signal);
    await vi.waitFor(() => expect(dns.resolve4).toHaveBeenCalledOnce());

    controller.abort("operator stop");

    await expect(pending).rejects.toMatchObject({ kind: "aborted" });
    expect(dns.cancel).toHaveBeenCalledOnce();
  });

  it("cancels in-flight public DNS resolution at the shared 15-second deadline", async () => {
    vi.useFakeTimers();
    try {
      const never = async (): Promise<readonly string[]> =>
        await new Promise<readonly string[]>(() => undefined);
      const dns = testPublicDnsResolver(never, never);
      const resolver = digestLinks.createDefaultHostnameResolver({
        systemLookup: async () => ["198.18.73.195"],
        createPublicDnsResolver: () => dns,
      });
      const pending = createPublicLinkProbe(
        async () => new Response(null, { status: 200 }),
        resolver,
      )("https://public-name.test/article");
      await vi.advanceTimersByTimeAsync(0);
      expect(dns.resolve4).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(15_000);

      await expect(pending).resolves.toBe(false);
      expect(dns.cancel).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([200, 204, 302, 399])(
    "uses a public redirect-following GET and accepts HTTP %i",
    async (status) => {
      let request: RequestInit | undefined;
      const fetch: FetchLike = async (_input, init) => {
        request = init;
        return new Response(null, { status });
      };

      await expect(
        createPublicLinkProbe(fetch, publicResolver)(PRIMARY_URLS[0]!),
      ).resolves.toBe(true);
      expect(request).toMatchObject({
        method: "GET",
        credentials: "omit",
        redirect: "manual",
      });
      const headers = new Headers(request?.headers);
      expect(headers.has("authorization")).toBe(false);
      expect(headers.has("cookie")).toBe(false);
    },
  );

  it("times out after 15 seconds and propagates an external abort", async () => {
    vi.useFakeTimers();
    try {
      const fetch: FetchLike = async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      const probe = createPublicLinkProbe(fetch, publicResolver);
      const timed = probe(PRIMARY_URLS[0]!);
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(timed).resolves.toBe(false);

      const controller = new AbortController();
      const aborted = probe(PRIMARY_URLS[0]!, controller.signal);
      controller.abort("operator stop");
      await expect(aborted).rejects.toMatchObject({ kind: "aborted" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves every public redirect hop before following it", async () => {
    const requested: string[] = [];
    const resolved: string[] = [];
    const fetch: FetchLike = async (input) => {
      const url = String(input);
      requested.push(url);
      return url === "https://start.test/article"
        ? new Response(null, {
            status: 302,
            headers: { location: "https://final.test/story" },
          })
        : new Response(null, { status: 204 });
    };
    const resolver: PublicHostnameResolver = async (hostname) => {
      resolved.push(hostname);
      return ["93.184.216.34"];
    };

    await expect(
      createPublicLinkProbe(fetch, resolver)("https://start.test/article"),
    ).resolves.toBe(true);
    expect(requested).toEqual([
      "https://start.test/article",
      "https://final.test/story",
    ]);
    expect(resolved).toEqual(["start.test", "final.test"]);
  });

  it("pins the validated address into the actual connection to close DNS rebinding", async () => {
    const resolver = vi.fn<PublicHostnameResolver>(async () => ["93.184.216.34"]);
    const pinned = vi.fn(async (
      url: URL,
      addresses: readonly string[],
      init: RequestInit,
    ) => {
      expect(url.hostname).toBe("public-name.test");
      expect(addresses).toEqual(["93.184.216.34"]);
      expect(init.redirect).toBe("manual");
      return new Response(null, { status: 204 });
    });

    await expect(
      createPublicLinkProbe(undefined, resolver, pinned)(
        "https://public-name.test/article",
      ),
    ).resolves.toBe(true);
    expect(resolver).toHaveBeenCalledOnce();
    expect(pinned).toHaveBeenCalledOnce();
  });

  it("blocks a hostname resolving to a private address before fetching", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(null, { status: 200 }));
    const resolver: PublicHostnameResolver = async () => ["10.0.0.7"];

    await expect(
      createPublicLinkProbe(fetch, resolver)("https://public-name.test/article"),
    ).resolves.toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("blocks a redirect to a private target before the second fetch", async () => {
    const requested: string[] = [];
    const fetch: FetchLike = async (input) => {
      requested.push(String(input));
      return new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/private" },
      });
    };

    await expect(
      createPublicLinkProbe(fetch, publicResolver)(
        "https://public-name.test/article",
      ),
    ).resolves.toBe(false);
    expect(requested).toEqual(["https://public-name.test/article"]);
  });

  it("keeps public IPv6 literal links compatible without DNS lookup", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));
    const resolver = vi.fn<PublicHostnameResolver>(async () => []);
    const url = "https://[2606:4700:4700::1111]/dns-query";

    await expect(createPublicLinkProbe(fetch, resolver)(url)).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
    expect(resolver).not.toHaveBeenCalled();
  });

  it("caps redirect traversal", async () => {
    let requestCount = 0;
    const fetch: FetchLike = async () => {
      requestCount += 1;
      return new Response(null, {
        status: 302,
        headers: { location: `/hop-${requestCount}` },
      });
    };

    await expect(
      createPublicLinkProbe(fetch, publicResolver)("https://start.test/hop-0"),
    ).resolves.toBe(false);
    expect(requestCount).toBe(6);
  });

  it("rejects a private selected URL before an injected probe can approve it", async () => {
    const privateUrl = "http://127.0.0.1/private?token=must-not-leak";
    const urls = [privateUrl, ...PRIMARY_URLS.slice(1)];
    const candidates = urls.map((url, index) =>
      candidate(index, { url, relatedUrls: [url] }),
    );
    const probe = vi.fn(async () => true);

    await expect(
      ensureAccessibleDigestLinks(output(urls), candidates, {
        date: DATE,
        allowedUrls: urls,
        probe,
      }),
    ).rejects.toBeInstanceOf(DigestLinkAccessibilityError);
    expect(probe).not.toHaveBeenCalledWith(privateUrl, undefined);
  });

  it("honors an external abort even when an injected probe ignores it", async () => {
    const controller = new AbortController();
    const pending = ensureAccessibleDigestLinks(
      output(),
      PRIMARY_URLS.map((_, index) => candidate(index)),
      {
        date: DATE,
        allowedUrls: PRIMARY_URLS,
        signal: controller.signal,
        probe: async () => await new Promise<boolean>(() => undefined),
      },
    );
    const outcome = pending.then(
      () => "resolved" as const,
      (error: unknown) => error,
    );

    controller.abort("operator stop");
    const settled = await Promise.race([
      outcome,
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 25)),
    ]);

    expect(settled).toMatchObject({ kind: "aborted" });
  });

  it("repairs an inaccessible primary with the strict associated HN discussion URL first", async () => {
    const discussionUrl = "https://news.ycombinator.com/item?id=42";
    const mirrorUrl = "https://mirror.test/article";
    const candidates = PRIMARY_URLS.map((_, index) => candidate(index));
    candidates[0] = candidate(0, {
      source: "hacker-news",
      category: "community",
      rawMetrics: { hnId: 42, discussionUrl },
      confirmedBy: ["hacker-news"],
      relatedUrls: [PRIMARY_URLS[0]!, mirrorUrl, discussionUrl],
    });
    const probe = vi.fn(async (url: string) => url !== PRIMARY_URLS[0]);

    const repaired = await ensureAccessibleDigestLinks(output(), candidates, {
      date: DATE,
      allowedUrls: [...PRIMARY_URLS, mirrorUrl, discussionUrl],
      probe,
    });

    expect(repaired.sourceUrls).toHaveLength(13);
    expect(new Set(repaired.sourceUrls)).toHaveLength(13);
    expect(repaired.sourceUrls[0]).toBe(discussionUrl);
    expect(repaired.digest).toContain(discussionUrl);
    expect(repaired.digest).not.toContain(PRIMARY_URLS[0]);
    expect(repaired.editorial.highlights[0]?.sourceUrls).toContain(discussionUrl);
    expect(repaired.editorial.highlights[0]?.sourceUrls).not.toContain(
      PRIMARY_URLS[0],
    );
    expect(probe).toHaveBeenCalledWith(discussionUrl, undefined);
    expect(probe).not.toHaveBeenCalledWith(mirrorUrl, undefined);
  });

  it("rejects an inaccessible link without an accessible associated fallback without leaking it", async () => {
    const secretUrl = "https://blocked.test/article?token=must-not-leak";
    const urls = [secretUrl, ...PRIMARY_URLS.slice(1)];
    const candidates = urls.map((url, index) =>
      candidate(index, { url, relatedUrls: [url] }),
    );

    let thrown: unknown;
    try {
      await ensureAccessibleDigestLinks(output(urls), candidates, {
        date: DATE,
        allowedUrls: urls,
        probe: async (url) => url !== secretUrl,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DigestLinkAccessibilityError);
    expect(String(thrown)).not.toContain("must-not-leak");
    expect(String(thrown)).not.toContain("blocked.test");
  });

  it("rejects a fallback that would duplicate and drop one of the required 13 links", async () => {
    const candidates = PRIMARY_URLS.map((_, index) => candidate(index));
    candidates[0] = candidate(0, {
      relatedUrls: [PRIMARY_URLS[0]!, PRIMARY_URLS[1]!],
    });

    await expect(
      ensureAccessibleDigestLinks(output(), candidates, {
        date: DATE,
        allowedUrls: PRIMARY_URLS,
        probe: async (url) => url !== PRIMARY_URLS[0],
      }),
    ).rejects.toBeInstanceOf(DigestLinkAccessibilityError);
  });
});
