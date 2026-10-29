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

- [x] `bash support/audit-prod.sh` 后端/共享 0 条告警，退出码 0。
- [x] `pnpm build` 与 `pnpm lint` 通过，无新增失败。
- [x] zod v4 迁移后 TS 编译通过；运行期冒烟 87/87 通过；后端完整进程启动与 HTTP 烟测留待 Phase B dry-run 隔离栈 38 项回归闭环。
- [x] `pnpm install` 后锁文件更新且可复现，无新增无关依赖。
- [x] 提交推送 origin 后 CI 结论为 success。
- [x] 未改 0.10.7 版本号，未夹带页脚与任务归档内容。

## Notes

- 审计明细与依赖来源见 `.trellis/tasks/10-29-release-footer-0.10.7/research/phase-a-preflight.md` 第 3 节。
- 这是子任务：父任务 `10-29-release-footer-0.10.7` 在依赖清零后继续 Phase A 剩余步骤与 Phase B 发布。

## 执行与验证结果（2026-10-29）

- 提交 `2a8f38c` 已推送 origin，CI run [40881034838](https://github.com/zhemed/picsur/actions/runs/40881034838) conclusion 为 success。
- audit：后端/共享 15 条 → 0 条，浏览器侧 0 条，退出码 0；15 条逐项清零，解析版本 zod 4.6.7、fastify 5.12.7、fast-uri 3.1.9、undici 7.30.1、body-parser 生产 2.4.0。
- build 30s 通过、lint 0 error / 9 存量 warning、`pnpm install --frozen-lockfile` 通过。
- zod v4 迁移改 6 个文件：`AnyZodObject` 泛型、`errorMap` → `error`、信封类型显式化，以及两处运行期阻断修复：`EUserSchema.hashedPassword` 与 `ImageMetaResponse.fileTypes.original` 显式 optional，避免 JSON 丢键后响应校验 500。
- 计划外发现：`@nestjs/platform-fastify@12.1.3` 把 fastify 精确钉在 5.12.5，必须加范围限定 override 才能清掉最后一条 low。
- 运行期冒烟 `/tmp` 脚本直跑三包 dist 与真实校验管道：87/87 通过；独立验证另写 20 条探针通过。
- 独立验证结论为通过但需修正：唯一证据缺口是后端完整进程启动与 HTTP 烟测未做，交由 Phase B dry-run 隔离栈 38 项回归闭环，不跳步。
- spec 已同步：`build-and-deploy.md` §8.1 zod 版本底线、§8.2 overrides 清单、§8.4 残留风险、§9 发布机制从旧的 tag 触发 CI 改为 `support/release-local.sh`。
