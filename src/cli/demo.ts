import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface DemoResult {
  readonly ok: true;
  readonly status: "demo-ready";
  readonly format: "human";
  readonly text: string;
  readonly digestPath: string;
  readonly imagePath: string;
  readonly socialPreviewPath: string;
}

function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../..");
}

function ensureDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o755 });
}

export function runOfflineDemo(options: {
  readonly projectRoot: string;
}): DemoResult {
  const root = options.projectRoot;
  if (!isAbsolute(root)) {
    throw new Error("Project root must be absolute");
  }

  const sourceRoot = packageRoot();
  const fixtureDigest = join(
    sourceRoot,
    "tests",
    "fixtures",
    "demo",
    "sample-digest.txt",
  );
  const fixtureImage = join(sourceRoot, "docs", "assets", "demo-preview.png");
  const socialPreview = join(sourceRoot, "docs", "assets", "social-preview.png");

  if (!existsSync(fixtureDigest) || !existsSync(fixtureImage)) {
    throw new Error("Demo fixtures are missing from the package");
  }

  const outputDirectory = join(root, "output", "demo");
  ensureDirectory(outputDirectory);

  const digestPath = join(outputDirectory, "sample-digest.txt");
  const imagePath = join(outputDirectory, "demo-preview.png");
  const digest = readFileSync(fixtureDigest, "utf8");
  writeFileSync(digestPath, digest, { encoding: "utf8", mode: 0o644 });
  copyFileSync(fixtureImage, imagePath);

  const text = [
    "WeChatPilot offline demo ready.",
    "",
    "This demo does not access WeChat, call Codex, or read private .state credentials.",
    `Sample digest: ${digestPath}`,
    `Sample preview image: ${imagePath}`,
    `Social preview asset: ${socialPreview}`,
    "",
    "Safe next steps:",
    "1. npm run wechatpilot -- init",
    "2. npm run wechatpilot -- doctor",
    "3. ./scripts/init-wechat.sh",
    "4. npm run send:test",
    "",
    "Public Preview only: owner-bound outbound delivery, no remote control.",
  ].join("\n");

  return {
    ok: true,
    status: "demo-ready",
    format: "human",
    text: `${text}\n`,
    digestPath,
    imagePath,
    socialPreviewPath: socialPreview,
  };
}
