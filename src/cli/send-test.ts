import { resolve } from "node:path";

import { publicWechatError, sendWechatText } from "../delivery/wechat.js";

async function main(): Promise<void> {
  const result = await sendWechatText({
    projectRoot: resolve(process.cwd()),
    text: "【每日科技情报】微信主动推送测试成功。此消息仅用于本地部署验收。",
  });
  console.log(`微信测试消息已发送（${result.chunks} 个安全分段）。`);
}

main().catch((error: unknown) => {
  console.error(publicWechatError(error));
  process.exitCode = 1;
});
