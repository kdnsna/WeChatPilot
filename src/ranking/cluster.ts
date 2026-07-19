import type { RankingConfig } from "../config/schema.js";
import type { NormalizedItem } from "../types/item.js";

type ClusteringConfig = RankingConfig["clustering"];

const TRACKING_PARAMETER_NAMES = new Set([
  "fbclid",
  "gclid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "ref_src",
  "vero_conv",
  "vero_id",
]);

function isTrackingParameter(name: string): boolean {
  const lower = name.toLocaleLowerCase("en-US");
  return lower.startsWith("utm_") || TRACKING_PARAMETER_NAMES.has(lower);
}

export function canonicalizeUrl(
  value: string,
  stripTrackingParameters: boolean,
): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError("ranking URLs must use HTTP or HTTPS");
  }
  parsed.hash = "";
  parsed.username = "";
  parsed.password = "";
  parsed.hostname = parsed.hostname.toLocaleLowerCase("en-US");
  if (parsed.pathname.length > 1) {
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  }

  const entries = [...parsed.searchParams.entries()]
    .filter(([name]) => !stripTrackingParameters || !isTrackingParameter(name))
    .sort(([leftName, leftValue], [rightName, rightValue]) =>
      leftName === rightName
        ? leftValue.localeCompare(rightValue)
        : leftName.localeCompare(rightName),
    );
  parsed.search = "";
  for (const [name, entryValue] of entries) {
    parsed.searchParams.append(name, entryValue);
  }
  return parsed.toString().replace(/\?$/, "");
}

function normalizedTitle(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function wordTokens(value: string): Set<string> {
  return new Set(
    normalizedTitle(value)
      .split(" ")
      .map((token) => token.trim())
      .filter((token) => token.length > 0),
  );
}

function characterBigrams(value: string): Set<string> {
  const compact = normalizedTitle(value).replace(/\s+/g, "");
  if (compact.length < 2) {
    return compact === "" ? new Set() : new Set([compact]);
  }
  const result = new Set<string>();
  const characters = [...compact];
  for (let index = 0; index < characters.length - 1; index += 1) {
    result.add(`${characters[index]}${characters[index + 1]}`);
  }
  return result;
}

function intersectionSize(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  let count = 0;
  for (const value of left) {
    if (right.has(value)) {
      count += 1;
    }
  }
  return count;
}

export interface TitleSimilarity {
  readonly token: number;
  readonly characterBigram: number;
  readonly maximum: number;
}

export function titleSimilarity(left: string, right: string): TitleSimilarity {
  const leftTokens = wordTokens(left);
  const rightTokens = wordTokens(right);
  const tokenIntersection = intersectionSize(leftTokens, rightTokens);
  const tokenUnion = new Set([...leftTokens, ...rightTokens]).size;
  const token = tokenUnion === 0 ? 0 : tokenIntersection / tokenUnion;

  const leftBigrams = characterBigrams(left);
  const rightBigrams = characterBigrams(right);
  const bigramIntersection = intersectionSize(leftBigrams, rightBigrams);
  const characterBigram =
    leftBigrams.size + rightBigrams.size === 0
      ? 0
      : (2 * bigramIntersection) / (leftBigrams.size + rightBigrams.size);

  return { token, characterBigram, maximum: Math.max(token, characterBigram) };
}

export interface ItemCluster {
  readonly items: readonly NormalizedItem[];
  readonly canonicalUrls: readonly string[];
}

function shouldCluster(
  left: NormalizedItem,
  right: NormalizedItem,
  leftUrl: string,
  rightUrl: string,
  config: ClusteringConfig,
): boolean {
  if (leftUrl === rightUrl) {
    return true;
  }
  const similarity = titleSimilarity(left.title, right.title);
  return (
    similarity.token >= config.titleTokenSimilarityThreshold ||
    similarity.characterBigram >= config.titleCharacterBigramThreshold
  );
}

export function clusterItems(
  items: readonly NormalizedItem[],
  config: ClusteringConfig,
): readonly ItemCluster[] {
  const canonicalUrls = items.map((item) =>
    canonicalizeUrl(item.url, config.stripTrackingParameters),
  );
  const parents = items.map((_, index) => index);

  function root(index: number): number {
    let current = index;
    while (parents[current] !== current) {
      const parent = parents[current];
      if (parent === undefined) {
        break;
      }
      current = parent;
    }
    let compress = index;
    while (parents[compress] !== current) {
      const next = parents[compress];
      parents[compress] = current;
      if (next === undefined) {
        break;
      }
      compress = next;
    }
    return current;
  }

  function union(left: number, right: number): void {
    const leftRoot = root(left);
    const rightRoot = root(right);
    if (leftRoot !== rightRoot) {
      parents[rightRoot] = leftRoot;
    }
  }

  for (let left = 0; left < items.length; left += 1) {
    for (let right = left + 1; right < items.length; right += 1) {
      const leftItem = items[left];
      const rightItem = items[right];
      const leftUrl = canonicalUrls[left];
      const rightUrl = canonicalUrls[right];
      if (
        leftItem !== undefined &&
        rightItem !== undefined &&
        leftUrl !== undefined &&
        rightUrl !== undefined &&
        shouldCluster(leftItem, rightItem, leftUrl, rightUrl, config)
      ) {
        union(left, right);
      }
    }
  }

  const grouped = new Map<number, number[]>();
  for (const index of items.keys()) {
    const parent = root(index);
    const indexes = grouped.get(parent) ?? [];
    indexes.push(index);
    grouped.set(parent, indexes);
  }

  return [...grouped.values()].map((indexes) => ({
    items: indexes.flatMap((index) => {
      const candidate = items[index];
      return candidate === undefined ? [] : [candidate];
    }),
    canonicalUrls: indexes.flatMap((index) => {
      const candidate = canonicalUrls[index];
      return candidate === undefined ? [] : [candidate];
    }),
  }));
}
