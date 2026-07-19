import { resolve } from "node:path";

import {
  deliverDailyDigest,
  publicDailyDeliveryError,
} from "../delivery/digest-delivery.js";
import {
  prepareWechatTextSender,
  publicWechatError,
} from "../delivery/wechat.js";
import { readProjectText } from "../lib/project-file.js";
import { resolveProjectPath } from "../lib/paths.js";
import { shanghaiDateKey } from "../lib/time.js";
import { loadDigestHistoryManifest } from "../history/digest-manifest.js";
import { recordSentReferences } from "../history/store.js";

const MAX_DIGEST_BYTES = 128 * 1_024;

function requestedDate(args: readonly string[]): string {
  if (args.length === 0) {
    return shanghaiDateKey(new Date());
  }
  if (
    args.length !== 2 ||
    args[0] !== "--date" ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(args[1] ?? "")
  ) {
    throw new RangeError("用法：npm run send:digest -- --date YYYY-MM-DD");
  }
  return args[1]!;
}

async function main(): Promise<void> {
  const projectRoot = resolve(process.cwd());
  const date = requestedDate(process.argv.slice(2));
  const digestPath = resolveProjectPath(
    projectRoot,
    "output",
    `${date}-digest.txt`,
  );
  const digest = readProjectText(projectRoot, digestPath, MAX_DIGEST_BYTES);
  if (digest === null || digest.trim() === "") {
    throw new Error("指定日期的日报不存在");
  }
  const historyItems = loadDigestHistoryManifest(projectRoot, date, digest.trim());
  // Validate private state and the pinned vendor runtime before claiming a
  // delivery attempt. Local preflight failures must not consume retries.
  const send = await prepareWechatTextSender({ projectRoot });
  const result = await deliverDailyDigest({
    projectRoot,
    date,
    digest,
    send,
    onConfirmedSend: (sentAt) =>
      recordSentReferences(projectRoot, historyItems, sentAt),
  });
  console.log(
    `微信日报已发送（${result.chunks} 个安全分段，第 ${result.attempt} 次尝试）。`,
  );
}

main().catch((error: unknown) => {
  console.error(publicDailyDeliveryError(error) ?? publicWechatError(error));
  process.exitCode = 1;
});
