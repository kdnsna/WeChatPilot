import {
  V2exHotTopicsSchema,
  V2exTopicSchema,
  normalizeV2exTopic,
  v2exActivityUnix,
  type V2exTopic,
} from "../normalizers/v2ex.js";
import {
  sanitizeCandidateUrl,
  sanitizeEvidenceValue,
  sanitizeRawEvidence,
} from "../normalizers/sanitize.js";
import type {
  Collector,
  CollectorContext,
  CollectorResult,
  JsonValue,
  SourceStatus,
} from "../types/collector.js";
import { classifyCollectorError } from "./errors.js";

const DEFAULT_WINDOW_HOURS = 24;
const DEFAULT_EVIDENCE_LIMIT = 50;
const MAX_EVIDENCE_LIMIT = 100;

export interface V2exCollectorOptions {
  readonly endpoint: string;
  readonly technicalNodes: readonly string[];
  readonly technicalKeywords: readonly string[];
  readonly windowHours?: number;
  readonly evidenceLimit?: number;
}

function requireWebUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError("V2EX endpoint must use HTTP or HTTPS");
  }
  return parsed.toString();
}

function requirePositiveNumber(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be positive`);
  }
  return value;
}

function requirePositiveInteger(
  value: number,
  label: string,
  maximum: number,
): number {
  if (!Number.isInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`${label} must be a bounded positive integer`);
  }
  return value;
}

function normalizedFilterValues(
  values: readonly string[],
  label: string,
): readonly string[] {
  const normalized = values
    .map((value) => value.normalize("NFKC").trim().toLocaleLowerCase("en-US"))
    .filter((value) => value !== "");
  if (normalized.length === 0 || normalized.length !== values.length) {
    throw new TypeError(`${label} must contain non-empty strings`);
  }
  return [...new Set(normalized)];
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsKeyword(title: string, keyword: string): boolean {
  const normalizedTitle = title
    .normalize("NFKC")
    .toLocaleLowerCase("en-US");
  if (/^[a-z0-9]+$/i.test(keyword) && keyword.length <= 3) {
    return new RegExp(
      `(?:^|[^a-z0-9])${escapeRegularExpression(keyword)}(?:$|[^a-z0-9])`,
      "i",
    ).test(normalizedTitle);
  }
  return normalizedTitle.includes(keyword);
}

function requestWarning(status: SourceStatus): string {
  return `V2EX request failed: ${status}`;
}

function topicCounts(
  receivedTopics: number,
  validTopics: number,
  invalidTopics: number,
  selectedTopics: number,
  evidenceIncluded: number,
  invalidPayloads: number,
): JsonValue {
  return {
    requests: 0,
    invalidPayloads,
    receivedTopics,
    validTopics,
    invalidTopics,
    selectedTopics,
    evidenceIncluded,
    evidenceTruncated: Math.max(0, validTopics - evidenceIncluded),
  };
}

function collectionWarning(
  invalidTopics: number,
  selectedTopics: number,
  evidenceLimit: number,
): string | undefined {
  const warnings: string[] = [];
  if (invalidTopics > 0) {
    warnings.push(
      `V2EX skipped ${invalidTopics} invalid topic${invalidTopics === 1 ? "" : "s"}`,
    );
  }
  const omittedSelectedTopics = Math.max(0, selectedTopics - evidenceLimit);
  if (omittedSelectedTopics > 0) {
    warnings.push(
      `V2EX raw evidence truncated: ${omittedSelectedTopics} selected topic${omittedSelectedTopics === 1 ? "" : "s"} omitted`,
    );
  }
  if (selectedTopics === 0) {
    warnings.push("V2EX returned no technically relevant topics");
  }
  return warnings.length === 0 ? undefined : warnings.join("; ");
}

function topicEvidence(topic: V2exTopic): JsonValue {
  return sanitizeEvidenceValue({
    id: topic.id,
    title: topic.title,
    url: sanitizeCandidateUrl(topic.url),
    replies: topic.replies ?? null,
    member:
      topic.member === undefined || topic.member === null
        ? null
        : { username: topic.member.username },
    node: {
      name: topic.node.name,
      title: topic.node.title,
    },
    created: topic.created,
    lastModified: topic.last_modified ?? null,
    lastTouched: topic.last_touched ?? null,
  });
}

export function createV2exCollector(options: V2exCollectorOptions): Collector {
  const endpoint = requireWebUrl(options.endpoint);
  const technicalNodes = new Set(
    normalizedFilterValues(options.technicalNodes, "technicalNodes"),
  );
  const technicalKeywords = normalizedFilterValues(
    options.technicalKeywords,
    "technicalKeywords",
  );
  const windowHours = requirePositiveNumber(
    options.windowHours ?? DEFAULT_WINDOW_HOURS,
    "windowHours",
  );
  const evidenceLimit = requirePositiveInteger(
    options.evidenceLimit ?? DEFAULT_EVIDENCE_LIMIT,
    "evidenceLimit",
    MAX_EVIDENCE_LIMIT,
  );

  function isTechnical(topic: V2exTopic): boolean {
    const nodeName = topic.node.name
      .normalize("NFKC")
      .trim()
      .toLocaleLowerCase("en-US");
    return (
      technicalNodes.has(nodeName) ||
      technicalKeywords.some((keyword) => containsKeyword(topic.title, keyword))
    );
  }

  return {
    sourceId: "v2ex",
    async collect(context: CollectorContext): Promise<CollectorResult> {
      const collectedAtDate = context.now();
      const collectedAt = collectedAtDate.toISOString();
      let payload: unknown;
      try {
        payload = await context.http.getJson(endpoint, {
          signal: context.signal,
        });
      } catch (error) {
        const status = classifyCollectorError(error, context.signal);
        return {
          sourceId: "v2ex",
          status,
          fetchedAt: collectedAt,
          items: [],
          warning: requestWarning(status),
          rawEvidence: sanitizeRawEvidence({
            topics: [],
            failureCounts: {
              requests: 1,
              invalidPayloads: 0,
              receivedTopics: 0,
              validTopics: 0,
              invalidTopics: 0,
              selectedTopics: 0,
              evidenceIncluded: 0,
              evidenceTruncated: 0,
            },
          }),
        };
      }

      const envelope = V2exHotTopicsSchema.safeParse(payload);
      if (!envelope.success) {
        const receivedTopics = Array.isArray(payload) ? payload.length : 0;
        return {
          sourceId: "v2ex",
          status: "invalid",
          fetchedAt: collectedAt,
          items: [],
          warning: "V2EX returned an invalid payload",
          rawEvidence: sanitizeRawEvidence({
            topics: [],
            failureCounts: topicCounts(
              receivedTopics,
              0,
              0,
              0,
              0,
              1,
            ),
          }),
        };
      }

      const validTopics: V2exTopic[] = [];
      let invalidTopics = 0;
      for (const candidate of envelope.data) {
        const parsedTopic = V2exTopicSchema.safeParse(candidate);
        if (parsedTopic.success) {
          validTopics.push(parsedTopic.data);
        } else {
          invalidTopics += 1;
        }
      }
      if (envelope.data.length > 0 && validTopics.length === 0) {
        return {
          sourceId: "v2ex",
          status: "invalid",
          fetchedAt: collectedAt,
          items: [],
          warning: "V2EX returned an invalid payload",
          rawEvidence: sanitizeRawEvidence({
            topics: [],
            failureCounts: topicCounts(
              envelope.data.length,
              0,
              invalidTopics,
              0,
              0,
              1,
            ),
          }),
        };
      }

      const nowMs = collectedAtDate.getTime();
      const cutoffMs = nowMs - windowHours * 3_600_000;
      const selected = validTopics.filter((topic) => {
        const activityMs = v2exActivityUnix(topic) * 1_000;
        return (
          activityMs >= cutoffMs &&
          activityMs <= nowMs &&
          isTechnical(topic)
        );
      });
      const items = selected.map((topic) =>
        normalizeV2exTopic(topic, collectedAt),
      );
      const selectedTopics = new Set(selected);
      const evidenceTopics = [
        ...selected,
        ...validTopics.filter((topic) => !selectedTopics.has(topic)),
      ]
        .slice(0, evidenceLimit)
        .map(topicEvidence);
      const warning = collectionWarning(
        invalidTopics,
        selected.length,
        evidenceLimit,
      );

      return {
        sourceId: "v2ex",
        status: "ok",
        fetchedAt: collectedAt,
        lastSuccessfulAt: collectedAt,
        items,
        ...(warning === undefined ? {} : { warning }),
        rawEvidence: sanitizeRawEvidence({
          topics: evidenceTopics,
          failureCounts: topicCounts(
            envelope.data.length,
            validTopics.length,
            invalidTopics,
            selected.length,
            evidenceTopics.length,
            0,
          ),
        }),
      };
    },
  };
}
