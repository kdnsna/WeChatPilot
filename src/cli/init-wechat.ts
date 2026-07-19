import { resolve } from "node:path";

import {
  initializeWechat,
  publicWechatError,
  renderWechatQr,
} from "../delivery/wechat.js";

async function main(): Promise<void> {
  const projectRoot = resolve(process.cwd());
  console.log("即将显示微信 Chatbot 登录二维码。");
  console.log("请扫码并在手机确认；随后向该 Chatbot 发送纯文本：初始化");
  const result = await initializeWechat({
    projectRoot,
    renderQr: (content) => renderWechatQr(projectRoot, content),
  });
  if (result.status === "initialized") {
    console.log("微信初始化完成：本人绑定与上下文已安全保存（未显示任何令牌）。");
  }
}

main().catch((error: unknown) => {
  console.error(publicWechatError(error));
  process.exitCode = 1;
});
