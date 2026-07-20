import { z } from "zod";

import { DigestEditorialSchema } from "../report/editorial.js";

const DigestOutputSchema = z
  .object({
    title: z.string().min(16).max(40),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    digest: z.string().min(1_800).max(6_000),
    sourceUrls: z
      .array(
        z
          .string()
          .max(4_096)
          .url()
          .refine((value) => ["http:", "https:"].includes(new URL(value).protocol)),
      )
      .min(13)
      .max(24)
      .refine((values) => new Set(values).size === values.length),
    editorial: DigestEditorialSchema,
  })
  .strict();

export type DigestOutput = z.infer<typeof DigestOutputSchema>;

export interface DigestValidationOptions {
  readonly date: string;
  readonly allowedUrls: readonly string[];
}

export class DigestValidationError extends Error {
  override readonly name = "DigestValidationError";

  constructor(message = "Digest output failed schema or length validation") {
    super(message);
  }
}

function proseReadableCharacters(digest: string): number {
  return [
    ...digest
      .replace(/https?:\/\/[^\s<>"']+/gu, "")
      .replace(/\s/gu, ""),
  ].length;
}

const SECTIONS = [
  { heading: "一、今日技术社区热议", entries: 3 },
  { heading: "二、科技圈核心新闻", entries: 5 },
  { heading: "三、GitHub 今日发现", entries: 3 },
  { heading: "四、今日深度阅读", entries: 2 },
  { heading: "五、今日一句判断", entries: 0 },
] as const;

function expectedTitle(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(date);
  if (match === null) {
    throw new DigestValidationError("Digest date is invalid");
  }
  return `《科技与灵感日报｜${match[1]}年${match[2]}月${match[3]}日》`;
}

function validateSections(digest: string): void {
  const positions = SECTIONS.map(({ heading }) => digest.indexOf(heading));
  if (
    positions.some((position) => position < 0) ||
    positions.some(
      (position, index) => index > 0 && position <= (positions[index - 1] ?? -1),
    )
  ) {
    throw new DigestValidationError("Digest section order is invalid");
  }

  for (const [index, section] of SECTIONS.entries()) {
    if (section.entries === 0) {
      continue;
    }
    const start = positions[index] ?? 0;
    const end = positions[index + 1] ?? digest.length;
    const content = digest.slice(start, end);
    const markers = [...content.matchAll(/^【(\d+)】/gmu)].map(
      (match) => Number(match[1]),
    );
    const expected = Array.from(
      { length: section.entries },
      (_, markerIndex) => markerIndex + 1,
    );
    if (
      markers.length !== expected.length ||
      markers.some((marker, markerIndex) => marker !== expected[markerIndex])
    ) {
      throw new DigestValidationError(
        `Digest section ${index + 1} has an invalid entry count`,
      );
    }
  }
}

function validateUrls(
  output: DigestOutput,
  allowedUrls: readonly string[],
): void {
  const allowed = new Set(allowedUrls);
  for (const url of output.sourceUrls) {
    if (!allowed.has(url) || !output.digest.includes(url)) {
      throw new DigestValidationError("Digest contains an invalid source URL");
    }
  }
  const urlsInDigest = output.digest.match(/https?:\/\/[^\s<>"']+/gu) ?? [];
  for (const rawUrl of urlsInDigest) {
    const url = rawUrl.replace(/[，。；：！？、]+$/gu, "");
    if (!output.sourceUrls.includes(url)) {
      throw new DigestValidationError("Digest contains an unlisted source URL");
    }
  }
  for (const highlight of output.editorial.highlights) {
    for (const url of highlight.sourceUrls) {
      if (!allowed.has(url) || !output.sourceUrls.includes(url)) {
        throw new DigestValidationError("Digest editorial source URL is invalid");
      }
    }
  }
}

export function parseAndValidateDigest(
  serialized: string,
  options: DigestValidationOptions,
): DigestOutput {
  let value: unknown;
  try {
    value = JSON.parse(serialized.trim()) as unknown;
  } catch {
    throw new DigestValidationError("Digest output is not a single JSON object");
  }
  const parsed = DigestOutputSchema.safeParse(value);
  if (!parsed.success) {
    const issueSummary = parsed.error.issues
      .slice(0, 6)
      .map((issue) => `${issue.path.join(".") || "root"}:${issue.code}`)
      .join(",");
    throw new DigestValidationError(
      `Digest schema validation failed at ${issueSummary}`,
    );
  }
  const output = parsed.data;
  const title = expectedTitle(options.date);
  if (
    output.date !== options.date ||
    output.title !== title ||
    !output.digest.trimStart().startsWith(title)
  ) {
    throw new DigestValidationError("Digest title or date is invalid");
  }
  const readableCharacters = proseReadableCharacters(output.digest);
  if (readableCharacters < 2_000 || readableCharacters > 3_000) {
    throw new DigestValidationError(
      `Digest prose readable-character length ${readableCharacters} must be between 2000 and 3000`,
    );
  }
  validateSections(output.digest);
  validateUrls(output, options.allowedUrls);
  return output;
}
