import { lookup, Resolver } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

import type { FetchLike } from "../lib/http.js";
import { HttpError } from "../lib/http.js";
import type { DigestCandidate } from "./candidates.js";
import { parseAndValidateDigest, type DigestOutput } from "./validate.js";

const LINK_PROBE_TIMEOUT_MS = 15_000;
const MAX_LINK_REDIRECTS = 5;
const PUBLIC_DNS_SERVERS = ["1.1.1.1", "8.8.8.8"] as const;
const REQUIRED_SOURCE_URLS = 13;
const URL_IN_DIGEST = /https?:\/\/[^\s<>"']+/gu;
const TRAILING_URL_PUNCTUATION = /[，。；：！？、]+$/u;

export type DigestLinkProbe = (
  url: string,
  signal?: AbortSignal,
) => Promise<boolean>;

export type PublicHostnameResolver = (
  hostname: string,
  signal?: AbortSignal,
) => Promise<readonly string[]>;

export type PinnedLinkRequest = (
  url: URL,
  addresses: readonly string[],
  init: RequestInit,
) => Promise<Response>;

export interface DefaultHostnameResolverDependencies {
  readonly systemLookup?: PublicHostnameResolver;
  readonly createPublicDnsResolver?: () => PublicDnsResolver;
}

export interface PublicDnsResolver {
  setServers(servers: string[]): void;
  resolve4(hostname: string): Promise<readonly string[]>;
  resolve6(hostname: string): Promise<readonly string[]>;
  cancel(): void;
}

export interface DigestLinkAccessibilityOptions {
  readonly date: string;
  readonly allowedUrls: readonly string[];
  readonly signal?: AbortSignal;
  readonly probe?: DigestLinkProbe;
  readonly fetch?: FetchLike;
  readonly resolveHostname?: PublicHostnameResolver;
}

export class DigestLinkAccessibilityError extends Error {
  override readonly name = "DigestLinkAccessibilityError";

  constructor() {
    super("Digest source-link accessibility gate failed");
  }
}

function abortedError(): HttpError {
  return new HttpError({ kind: "aborted", retryable: false });
}

function signalIsAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}

function isPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split(".").map(Number);
  const first = octets[0] ?? -1;
  const second = octets[1] ?? -1;
  const third = octets[2] ?? -1;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && third === 0) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 192 && second === 168) ||
    isSurgeFakeIpv4(hostname) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  );
}

function isSurgeFakeIpv4(address: string): boolean {
  if (isIP(address) !== 4) {
    return false;
  }
  const octets = address.split(".").map(Number);
  return octets[0] === 198 && (octets[1] === 18 || octets[1] === 19);
}

function isPrivateIpv6(hostname: string): boolean {
  const normalized = hostname.toLocaleLowerCase("en-US");
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("::ffff:") ||
    /^fe[89abcdef]/u.test(normalized) ||
    normalized.startsWith("2001:2:") ||
    normalized.startsWith("2001:db8:") ||
    normalized.startsWith("ff")
  );
}

function isPublicHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== ""
    ) {
      return false;
    }
    const hostname = url.hostname
      .replace(/^\[/u, "")
      .replace(/\]$/u, "")
      .replace(/\.$/u, "")
      .toLocaleLowerCase("en-US");
    if (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal") ||
      hostname.endsWith(".lan")
    ) {
      return false;
    }
    const ipVersion = isIP(hostname);
    if (ipVersion === 4) {
      return !isPrivateIpv4(hostname);
    }
    if (ipVersion === 6) {
      return !isPrivateIpv6(hostname);
    }
    return hostname.includes(".");
  } catch {
    return false;
  }
}

function normalizedHostname(url: URL): string {
  return url.hostname
    .replace(/^\[/u, "")
    .replace(/\]$/u, "")
    .replace(/\.$/u, "")
    .toLocaleLowerCase("en-US");
}

function isPublicIpAddress(address: string): boolean {
  const ipVersion = isIP(address);
  if (ipVersion === 4) {
    return !isPrivateIpv4(address);
  }
  if (ipVersion === 6) {
    return !isPrivateIpv6(address);
  }
  return false;
}

async function systemHostnameResolver(
  hostname: string,
): Promise<readonly string[]> {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map(({ address }) => address);
}

function createNodePublicDnsResolver(): PublicDnsResolver {
  return new Resolver();
}

async function resolveWithPublicDns(
  hostname: string,
  signal: AbortSignal | undefined,
  createResolver: () => PublicDnsResolver,
): Promise<readonly string[]> {
  const resolver = createResolver();
  resolver.setServers([...PUBLIC_DNS_SERVERS]);
  if (signalIsAborted(signal)) {
    resolver.cancel();
    throw abortedError();
  }
  const cancel = (): void => resolver.cancel();
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    const results = await Promise.allSettled([
      resolver.resolve4(hostname),
      resolver.resolve6(hostname),
    ]);
    if (signalIsAborted(signal)) {
      throw abortedError();
    }
    return results.flatMap((result) =>
      result.status === "fulfilled" ? result.value : [],
    );
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

export function createDefaultHostnameResolver(
  dependencies: DefaultHostnameResolverDependencies = {},
): PublicHostnameResolver {
  const systemLookup = dependencies.systemLookup ?? systemHostnameResolver;
  const createResolver =
    dependencies.createPublicDnsResolver ?? createNodePublicDnsResolver;
  return async (hostname, signal) => {
    const systemAddresses = await systemLookup(hostname, signal);
    if (signalIsAborted(signal)) {
      throw abortedError();
    }
    if (
      systemAddresses.length === 0 ||
      !systemAddresses.every(isSurgeFakeIpv4)
    ) {
      return systemAddresses;
    }
    return await resolveWithPublicDns(hostname, signal, createResolver);
  };
}

async function resolvePublicAddresses(
  url: URL,
  resolver: PublicHostnameResolver,
  signal: AbortSignal,
): Promise<readonly string[] | null> {
  const hostname = normalizedHostname(url);
  if (isIP(hostname) !== 0) {
    return isPublicIpAddress(hostname) ? [hostname] : null;
  }
  let addresses: readonly string[];
  try {
    addresses = await resolver(hostname, signal);
  } catch {
    return null;
  }
  if (signal.aborted) {
    throw abortedError();
  }
  return addresses.length > 0 && addresses.every(isPublicIpAddress)
    ? [...new Set(addresses)]
    : null;
}

export const pinnedLinkRequest: PinnedLinkRequest = async (
  url,
  addresses,
  init,
) => await new Promise<Response>((resolve, reject) => {
  const selected = addresses[0];
  const family = selected === undefined ? 0 : isIP(selected);
  if (selected === undefined || family === 0) {
    reject(new Error("No validated address"));
    return;
  }
  const headers = new Headers(init.headers);
  headers.delete("authorization");
  headers.delete("cookie");
  const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
    method: init.method ?? "GET",
    headers: Object.fromEntries(headers.entries()),
    signal: init.signal ?? undefined,
    servername: url.protocol === "https:" && isIP(url.hostname) === 0
      ? url.hostname
      : undefined,
    lookup: (_hostname, options, callback) => {
      if (typeof options === "object" && options.all === true) {
        callback(null, [{ address: selected, family }]);
      } else {
        callback(null, selected, family);
      }
    },
  }, (incoming) => {
    const responseHeaders = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (Array.isArray(value)) {
        for (const entry of value) responseHeaders.append(name, entry);
      } else if (value !== undefined) {
        responseHeaders.set(name, value);
      }
    }
    incoming.destroy();
    resolve(new Response(null, {
      status: incoming.statusCode ?? 500,
      statusText: incoming.statusMessage ?? "",
      headers: responseHeaders,
    }));
  });
  request.once("error", reject);
  request.end();
});

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Link checks never consume response bodies; cancellation is best-effort.
  }
}

async function probeRedirectChain(
  initialUrl: string,
  fetchImplementation: FetchLike | undefined,
  resolver: PublicHostnameResolver,
  signal: AbortSignal,
  pinnedRequest: PinnedLinkRequest,
): Promise<boolean> {
  let currentUrl = initialUrl;
  for (
    let redirectCount = 0;
    redirectCount <= MAX_LINK_REDIRECTS;
    redirectCount += 1
  ) {
    if (signal.aborted || !isPublicHttpUrl(currentUrl)) {
      return false;
    }
    const parsedUrl = new URL(currentUrl);
    const addresses = await resolvePublicAddresses(parsedUrl, resolver, signal);
    if (addresses === null) {
      return false;
    }
    if (signal.aborted) {
      return false;
    }

    const init: RequestInit = {
      method: "GET",
      credentials: "omit",
      redirect: "manual",
      signal,
    };
    const response = fetchImplementation === undefined
      ? await pinnedRequest(parsedUrl, addresses, init)
      : await fetchImplementation(currentUrl, init);
    const isRedirect = response.status >= 300 && response.status < 400;
    const location = isRedirect ? response.headers.get("location") : null;
    const isAccepted = response.status >= 200 && response.status < 400;
    await discardBody(response);
    if (!isAccepted) {
      return false;
    }
    if (location === null) {
      return true;
    }
    if (redirectCount >= MAX_LINK_REDIRECTS) {
      return false;
    }
    try {
      currentUrl = new URL(location, parsedUrl).toString();
    } catch {
      return false;
    }
  }
  return false;
}

export function createPublicLinkProbe(
  fetchImplementation?: FetchLike,
  resolveHostname: PublicHostnameResolver = createDefaultHostnameResolver(),
  pinnedRequest: PinnedLinkRequest = pinnedLinkRequest,
): DigestLinkProbe {
  return async (url, signal) => {
    if (signalIsAborted(signal)) {
      throw abortedError();
    }
    if (!isPublicHttpUrl(url)) {
      return false;
    }

    const controller = new AbortController();
    const timeoutMarker = Symbol("link probe timeout");
    const abortMarker = Symbol("link probe abort");
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let removeAbortListener: (() => void) | undefined;

    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(timeoutMarker);
      }, LINK_PROBE_TIMEOUT_MS);
    });
    const abortPromise = new Promise<never>((_resolve, reject) => {
      if (signal === undefined) {
        return;
      }
      const abort = (): void => {
        controller.abort();
        reject(abortMarker);
      };
      signal.addEventListener("abort", abort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", abort);
    });

    try {
      return await Promise.race([
        probeRedirectChain(
          url,
          fetchImplementation,
          resolveHostname,
          controller.signal,
          pinnedRequest,
        ),
        timeoutPromise,
        abortPromise,
      ]);
    } catch (error) {
      if (error === abortMarker || signalIsAborted(signal)) {
        throw abortedError();
      }
      return false;
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      removeAbortListener?.();
    }
  };
}

function strictHackerNewsDiscussionUrl(
  candidate: DigestCandidate,
): string | undefined {
  if (
    candidate.source !== "hacker-news" &&
    !candidate.source.startsWith("hacker-news:")
  ) {
    return undefined;
  }
  const hnId = candidate.rawMetrics.hnId;
  const discussionUrl = candidate.rawMetrics.discussionUrl;
  if (
    typeof hnId !== "number" ||
    !Number.isSafeInteger(hnId) ||
    hnId <= 0 ||
    typeof discussionUrl !== "string"
  ) {
    return undefined;
  }
  const expected = `https://news.ycombinator.com/item?id=${hnId}`;
  if (
    discussionUrl !== expected ||
    (candidate.url !== expected && !candidate.relatedUrls.includes(expected))
  ) {
    return undefined;
  }
  return expected;
}

function associatedCandidates(
  url: string,
  candidates: readonly DigestCandidate[],
): readonly DigestCandidate[] {
  return candidates.filter(
    (candidate) =>
      candidate.url === url || candidate.relatedUrls.includes(url),
  );
}

function fallbackUrls(
  candidates: readonly DigestCandidate[],
): readonly string[] {
  const prioritized = [
    ...candidates.map(strictHackerNewsDiscussionUrl),
    ...candidates.map((candidate) => candidate.url),
    ...candidates.flatMap((candidate) => candidate.relatedUrls),
  ];
  return [
    ...new Set(
      prioritized.filter((url): url is string => url !== undefined),
    ),
  ];
}

function replaceDigestUrls(
  digest: string,
  replacements: ReadonlyMap<string, string>,
): string {
  return digest.replace(URL_IN_DIGEST, (rawUrl) => {
    const punctuation = TRAILING_URL_PUNCTUATION.exec(rawUrl)?.[0] ?? "";
    const url =
      punctuation === "" ? rawUrl : rawUrl.slice(0, -punctuation.length);
    const replacement = replacements.get(url);
    return replacement === undefined ? rawUrl : `${replacement}${punctuation}`;
  });
}

async function accessible(
  probe: DigestLinkProbe,
  url: string,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  if (signalIsAborted(signal)) {
    throw abortedError();
  }
  try {
    const result = await probe(url, signal);
    if (signalIsAborted(signal)) {
      throw abortedError();
    }
    return result;
  } catch (error) {
    if (
      signalIsAborted(signal) ||
      (error instanceof HttpError && error.kind === "aborted")
    ) {
      throw abortedError();
    }
    return false;
  }
}

async function repairAccessibleDigestLinks(
  output: DigestOutput,
  candidates: readonly DigestCandidate[],
  options: DigestLinkAccessibilityOptions,
): Promise<DigestOutput> {
  if (
    output.sourceUrls.length !== REQUIRED_SOURCE_URLS ||
    new Set(output.sourceUrls).size !== REQUIRED_SOURCE_URLS
  ) {
    throw new DigestLinkAccessibilityError();
  }

  const probe =
    options.probe ??
    createPublicLinkProbe(options.fetch, options.resolveHostname);
  const probeResults = new Map<string, Promise<boolean>>();
  const probeOnce = (url: string): Promise<boolean> => {
    const existing = probeResults.get(url);
    if (existing !== undefined) {
      return existing;
    }
    const result = isPublicHttpUrl(url)
      ? accessible(probe, url, options.signal)
      : Promise.resolve(false);
    probeResults.set(url, result);
    return result;
  };
  const initialAccessibility = await Promise.all(
    output.sourceUrls.map((url) => probeOnce(url)),
  );
  const occupied = new Set(output.sourceUrls);
  const allowed = new Set(options.allowedUrls);
  const replacements = new Map<string, string>();

  for (const [index, sourceUrl] of output.sourceUrls.entries()) {
    if (initialAccessibility[index] === true) {
      continue;
    }
    const alternatives = fallbackUrls(
      associatedCandidates(sourceUrl, candidates),
    ).filter(
      (url) =>
        url !== sourceUrl &&
        !occupied.has(url) &&
        allowed.has(url) &&
        isPublicHttpUrl(url),
    );
    let replacement: string | undefined;
    for (const alternative of alternatives) {
      if (await probeOnce(alternative)) {
        replacement = alternative;
        break;
      }
    }
    if (replacement === undefined) {
      throw new DigestLinkAccessibilityError();
    }
    replacements.set(sourceUrl, replacement);
    occupied.add(replacement);
  }

  const repaired = {
    ...output,
    digest: replaceDigestUrls(output.digest, replacements),
    sourceUrls: output.sourceUrls.map(
      (url) => replacements.get(url) ?? url,
    ),
    editorial: {
      ...output.editorial,
      highlights: output.editorial.highlights.map((highlight) => ({
        ...highlight,
        sourceUrls: highlight.sourceUrls.map(
          (url) => replacements.get(url) ?? url,
        ),
      })),
    },
  };
  if (
    repaired.sourceUrls.length !== REQUIRED_SOURCE_URLS ||
    new Set(repaired.sourceUrls).size !== REQUIRED_SOURCE_URLS
  ) {
    throw new DigestLinkAccessibilityError();
  }
  try {
    return parseAndValidateDigest(JSON.stringify(repaired), {
      date: options.date,
      allowedUrls: options.allowedUrls,
    });
  } catch {
    throw new DigestLinkAccessibilityError();
  }
}

export async function ensureAccessibleDigestLinks(
  output: DigestOutput,
  candidates: readonly DigestCandidate[],
  options: DigestLinkAccessibilityOptions,
): Promise<DigestOutput> {
  if (signalIsAborted(options.signal)) {
    throw abortedError();
  }
  if (options.signal === undefined) {
    return await repairAccessibleDigestLinks(output, candidates, options);
  }

  const abortMarker = Symbol("digest link gate abort");
  let removeAbortListener: (() => void) | undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    const abort = (): void => reject(abortMarker);
    options.signal?.addEventListener("abort", abort, { once: true });
    removeAbortListener = () =>
      options.signal?.removeEventListener("abort", abort);
  });
  try {
    return await Promise.race([
      repairAccessibleDigestLinks(output, candidates, options),
      abortPromise,
    ]);
  } catch (error) {
    if (error === abortMarker || signalIsAborted(options.signal)) {
      throw abortedError();
    }
    throw error;
  } finally {
    removeAbortListener?.();
  }
}
