# 依赖安全修复：清 15 条后端/共享 advisory 与 zod v4 迁移

## Goal

0.10.7 发版被依赖审计硬阻断：后端/共享 15 条新 advisory，其中 fastify、fast-uri、body-parser、undici 可补丁级清掉，zod 需要 v3 到 v4 的破坏性迁移。本任务作为 `10-29-release-footer-0.10.7` 的发版前置子任务，目标是让 `support/audit-prod.sh` 的后端/共享口径清零，并让构建、lint、CI 重新变绿。

## Requirements

- R1 补丁级升级按调研结论执行：`fastify` 升到 `^5.12.6`；根 `pnpm.overrides` 中 `fast-uri` 升到 `^3.1.9`，新增 `undici: ^7.30.1`，`body-parser` 必要时覆盖到 `^2.4.0`；以锁文件实际解析到修复版本为准，不修改业务逻辑。
- R2 zod 从 v3 升到 v4：`backend`、`shared`、`frontend` 三处依赖与锁文件同步；按 zod v4 迁移指南处理破坏性变更，包括类型泛型签名、错误格式、`z.record`、`.merge`、错误定制、`z.string().email()` 等着色点；修复全部 TS 编译错误并确认运行期行为未回退。
- R3 校验必须全绿：`pnpm install` 后 `pnpm build`、`pnpm lint`、`bash support/audit-prod.sh` 均通过，其中 audit 后端/共享口径必须为 0 条；浏览器侧存量不计阻断。
- R4 运行期验证：除构建外，至少做一次后端启动与基础 API 烟测，确认 zod 校验器、DTO 生成与错误返回仍正常；如仓库有测试脚本一并执行。
- R5 变更边界：只改依赖清单、锁文件与 zod 兼容所需的代码修复；不夹带 0.10.7 版本号、页脚改动或任务归档内容。
- R6 提交带 `[task:10-29-dep-security-v4]` 锚点并推送 origin，CI 必须恢复绿色；完成后回到父任务继续发版。

## Acceptance Criteria

- [ ] `bash support/audit-prod.sh` 后端/共享 0 条告警，退出码 0。
- [ ] `pnpm build` 与 `pnpm lint` 通过，无新增失败。
- [ ] zod v4 迁移后 TS 编译通过，后端启动与基础 API 烟测通过。
- [ ] `pnpm install` 后锁文件更新且可复现，无新增无关依赖。
- [ ] 提交推送 origin 后 CI 结论为 success。
- [ ] 未改 0.10.7 版本号，未夹带页脚与任务归档内容。

## Notes

- 审计明细与依赖来源见 `.trellis/tasks/10-29-release-footer-0.10.7/research/phase-a-preflight.md` 第 3 节。
- 这是子任务：父任务 `10-29-release-footer-0.10.7` 在依赖清零后继续 Phase A 剩余步骤与 Phase B 发布。
