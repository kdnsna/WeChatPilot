import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

const SecurityProfileDocumentSchema = z.object({
  version: z.literal(1),
  digestCodex: z.unknown(),
  imageCodex: z.unknown(),
}).strict();

export interface SecurityProfileDocument {
  readonly version: 1;
  readonly digestCodex: unknown;
  readonly imageCodex: unknown;
}

export function loadSecurityProfile(projectRoot: string): SecurityProfileDocument {
  try {
    return SecurityProfileDocumentSchema.parse(
      parse(readFileSync(join(projectRoot, "config", "security-profile.yaml"), "utf8")),
    );
  } catch (error) {
    throw new Error("Invalid security profile", { cause: error });
  }
}
