# 发版 0.10.7：发布页脚改动

## Goal

按用户 2026-10-29 指令「确认授权，发版吧」以及弹窗确认口径：把页脚来源行清空改动发布为 0.10.7 补丁版，包含 ghcr 镜像与 git tag 发布、发布后 34 项回归验证、以及把本机 `127.0.0.1:8080` all-in-one 实例升级到 0.10.7。

## Requirements

- R1 版本号从 0.10.6 升到 0.10.7：根、`backend`、`frontend`、`shared` 四个 `package.json` 同步；不改其它业务代码。版本提交带 `[task:10-29-release-footer-0.10.7]` 锚点并推送 origin。
- R2 发布前校验按 Node 20 + pnpm 9.6.0 契约执行，最小必跑清单以 runbook 为准：构建、lint、以及发布前必需的安全审计。
- R3 按 `support/release-local.sh` 契约发布 `ghcr.io/zhemed/picsur` 的 `:0.10.7`、`:v0.10.7`、`:0.10`、`:latest`、`:allinone` 五个标签，并自动打 `v0.10.7` tag 推送到 origin；发布前确认 ghcr 已登录，未登录或网络受阻立即停止报告。
- R4 发布后按 spec 要求 `docker pull` 新镜像并起隔离栈跑 34 项回归验证，记录命令、退出码与结果；回归失败则停止，不升级实例。
- R5 回归通过后升级本机 `127.0.0.1:8080` all-in-one 实例到 0.10.7，验证实例版本号与新页脚空白生效；保留旧镜像与回滚命令。
- R6 全程留痕：命令与关键输出写入任务 research 或 PRD；发布提交与任务留痕分提交；部署动作仅在用户已授权范围内执行。

## Acceptance Criteria

- [ ] 四处 `package.json` 版本均为 0.10.7，版本提交已推送 origin。
- [ ] 发布前构建、lint 与审计结果符合契约，无新增失败。
- [ ] `ghcr.io/zhemed/picsur` 五个标签推送成功，远端存在 `v0.10.7` tag 且指向本次发布提交。
- [ ] 发布后 34 项回归在隔离栈上全部通过，证据完整。
- [ ] 本机实例升级到 0.10.7，页面版本显示 0.10.7、页脚区域为空白且主界面无位移；回滚命令已记录。
- [ ] 除版本号外无业务代码改动，所有提交带任务锚点。

## Notes

- 当前版本 0.10.6，远端 tag 只到 v0.9.0 附近，v0.10.7 未被占用；`support/release-local.sh` 自带四道发布守卫。
- 本次发版内容是上一任务 `10-29-footer-line-blank` 的页脚清空改动，该提交 `d8d1802` 已在 origin。
- 发版 runbook 见 `research/release-runbook.md`。
- 首次 Phase A 停在审计门禁，证据见 `research/phase-a-preflight.md`。

## 依赖前置修复（2026-10-29）

- Phase A 首次尝试被 `support/audit-prod.sh` 阻断：后端/共享 15 条新 advisory，CI 自 2026-10-25 起红。用户选择「先修依赖再发版」，已由子任务 `10-29-dep-security-v4` 完成。
- 子任务提交 `2a8f38c`：audit 后端/共享 15 → 0 条，`pnpm build` 与 `pnpm lint` 通过，CI run [40881034838](https://github.com/zhemed/picsur/actions/runs/40881034838) 为 success；同轮完成 zod v3 → v4 迁移，补丁级清掉 fastify、fast-uri、undici、body-parser。
- spec 已同步 `df54a50`，子任务归档 `f6c81f6`。现状：四个 `package.json` 版本仍为 0.10.6，等待本轮升 0.10.7 并继续发布。
