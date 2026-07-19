import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";

import { z } from "zod";

import type { DigestCandidate } from "../digest/candidates.js";
import type { DigestOutput } from "../digest/validate.js";
import { readProjectText, writeProjectTextAtomic } from "../lib/project-file.js";
import {
  assertNoSymlinkComponents,
  resolveProjectPath,
} from "../lib/paths.js";
import {
  sanitizeCandidateString,
  sanitizeCandidateUrl,
} from "../normalizers/sanitize.js";
import type { SentHistoryReference } from "./store.js";

const MAX_MANIFEST_BYTES = 256 * 1_024;

const ReferenceSchema = z
  .object({
    title: z.string().min(1).max(512),
    url: z
      .string()
      .max(4_096)
      .url()
      .refine((value) => ["http:", "https:"].includes(new URL(value).protocol)),
    source: z.string().min(1).max(128),
  })
  .strict();

const ManifestSchema = z
  .object({
    version: z.literal(1),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    digestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    items: z.array(ReferenceSchema).min(1).max(24),
  })
  .strict();

function digestHash(digest: string): string {
  return createHash("sha256").update(digest.trim(), "utf8").digest("hex");
}

function manifestPath(projectRoot: string, date: string): string {
  return resolveProjectPath(projectRoot, "output", `${date}-history.json`);
}

function historyReferences(
  output: DigestOutput,
  candidates: readonly DigestCandidate[],
): readonly SentHistoryReference[] {
  const references: SentHistoryReference[] = [];
  for (const selectedUrl of output.sourceUrls) {
    const candidate = candidates.find(
      (entry) =>
        entry.url === selectedUrl || entry.relatedUrls.includes(selectedUrl),
    );
    if (candidate === undefined) {
      throw new Error("日报历史清单包含无法对应候选的来源");
    }
    references.push(
      ReferenceSchema.parse({
        title: sanitizeCandidateString(candidate.title),
        url: sanitizeCandidateUrl(selectedUrl),
        source: sanitizeCandidateString(candidate.source),
      }),
    );
  }
  return references;
}

export function writeDigestHistoryManifest(
  projectRoot: string,
  output: DigestOutput,
  candidates: readonly DigestCandidate[],
): string {
  const value = ManifestSchema.parse({
    version: 1,
    date: output.date,
    digestSha256: digestHash(output.digest),
    items: historyReferences(output, candidates),
  });
  const path = manifestPath(projectRoot, output.date);
  writeProjectTextAtomic(projectRoot, path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

export function loadDigestHistoryManifest(
  projectRoot: string,
  date: string,
  digest: string,
): readonly SentHistoryReference[] {
  const path = manifestPath(projectRoot, date);
  const raw = readProjectText(projectRoot, path, MAX_MANIFEST_BYTES);
  if (raw === null) {
    throw new Error("日报历史清单不存在");
  }
  const stat = lstatSync(assertNoSymlinkComponents(projectRoot, path));
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
    throw new Error("日报历史清单权限无效");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("日报历史清单格式无效");
  }
  const manifest = ManifestSchema.safeParse(parsed);
  if (
    !manifest.success ||
    manifest.data.date !== date ||
    manifest.data.digestSha256 !== digestHash(digest)
  ) {
    throw new Error("日报历史清单与待发送日报不匹配");
  }
  return manifest.data.items;
}
