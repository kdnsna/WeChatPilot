## 变更内容

<!-- 简要说明改了什么，以及为什么。 -->

## 风险与影响

- [ ] 不扩大微信单向发送边界
- [ ] 不引入凭据、Cookie、Token 或个人路径数据
- [ ] 不重新引入 `cli-in-wechat`、其他上游控制入口或任何 gitlink/submodule
- [ ] 不启用 Codex 高权限、危险沙箱参数或微信远程控制

## 验证

- [ ] `npm test`
- [ ] `npm run typecheck`
- [ ] `npm run build`
- [ ] 相关手动验收已记录
