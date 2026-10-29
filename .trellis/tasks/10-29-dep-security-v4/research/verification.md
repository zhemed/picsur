# 独立验证报告：清 15 条后端/共享 advisory + zod v4 迁移（提交 `2a8f38c`）

- 任务：`10-29-dep-security-v4`，被验证提交 `2a8f38c2d7274637d46b0e947617dcc0a17f9e23`
- 验证人：release-executor，Trellis check 子代理，**未采信实现成员结论**
- 时间：2026-10-29 13:24 至 13:45 UTC
- 环境：Node `v20.20.2` + pnpm `9.6.0`，`export PATH="/root/picsur/.run/node20/bin:$PATH"`；审计强制官方 registry
- 只读验证：未改业务代码、未提交、未跑 `release-local.sh`、未触碰 `127.0.0.1:8080` 实例；仅新增本报告

## 结论

**通过但需修正。** 依赖目标、审计清零、构建、lint、CI 全部独立复核通过，zod v4 迁移的 5 个代码点语义等价、未见业务回退。唯一“修正项”不是代码，而是验收证据缺口：PRD R4 要求的**后端完整进程启动与基础 API 烟测未执行**，实现报告已如实披露，需在 Phase B 正式发布前的 dry-run 隔离栈 34 项回归中闭环，不得跳过。

## 1. diff 边界

`git show --stat 2a8f38c`：17 files changed, 327 insertions(+), 75 deletions(-)。

| 组 | 文件 | 判定 |
| --- | --- | --- |
| 依赖清单 | `package.json`（仅 overrides）、`backend/package.json`、`shared/package.json`、`frontend/package.json` | 范围内 |
| 锁文件 | `pnpm-lock.yaml` | 范围内 |
| zod 兼容代码 | `shared/src/dto/api/api.dto.ts`、`shared/src/dto/api/image.dto.ts`、`shared/src/entities/user.entity.ts`、`shared/src/validators/ms.validator.ts`、`frontend/src/app/services/api/api.service.ts` | 范围内 |
| 任务文档 | `.trellis/tasks/10-29-dep-security-v4/` 下 7 个文件 | 范围内 |

边界反证：

- 四个 `package.json` 的 `version` 仍为 `0.10.6`，diff 内无版本号变更。
- `support/` 变更文件数 0；`support/audit-prod.sh` 未被修改。
- `.trellis/tasks/archive/` 变更文件数 0。
- `frontend/src/app/components/app-footer/` 与 `frontend/src/assets/i18n/` 变更文件数 0。
- `git status --porcelain` 仅 `?? .trellis/tasks/10-29-release-footer-0.10.7/`，父任务目录按约定未提交；本报告新增后只多一条同目录下的 `?? .trellis/tasks/10-29-dep-security-v4/research/verification.md`，无已跟踪文件改动。
- 提交信息含 `[task:10-29-dep-security-v4]` 锚点；`HEAD`、`origin/master` 均为 `2a8f38c`。

## 2. 独立复跑（全部由本验证人重新执行）

| 命令 | 退出码 | 耗时 | 结果 |
| --- | --- | --- | --- |
| `node -v` / `pnpm -v` | 0 | 瞬时 | `v20.20.2` / `9.6.0` |
| `pnpm install --frozen-lockfile` | **0** | 2s | `Lockfile is up to date, resolution step is skipped`；执行后锁文件未变 |
| `bash support/audit-prod.sh` | **0** | 2s | 后端/共享 **0**，浏览器侧 **0**，闭包 477 个包 |
| `pnpm build` | **0** | 30s | 三包成功，`grep -c 'error TS'` 为 0 |
| `pnpm lint` | **0** | 3s | `0 errors, 9 warnings`，与基线同 |
| `/tmp/dep-security-v4-smoke.mjs` 重跑 | **0** | 少于 1s | `87/87 passed`，与实现报告一致 |
| 本验证人自写探针 `/tmp/verify-probe.mjs` | **0** | 少于 1s | `20 passed, 0 failed` |
| `pnpm audit --prod --json` 原始输出 | 0 | 2s | `advisories={}`，metadata 全 0，prod 依赖 502 |

`pnpm lint` 的 9 条 warning 与基线逐条一致，全部是 `@typescript-eslint/no-unused-vars` 存量。

## 3. 依赖口径与 15 条 advisory 清零

`pnpm-lock.yaml` 实际解析：

| 包 | 改动前 | 改动后 | advisory 修复线 | 判定 |
| --- | --- | --- | --- | --- |
| `zod` | `3.25.76` | `4.6.7`（workspace）；dev 快照 `4.6.6` | `>=4.6.6` | 清零；4.6.6 恰好达标 |
| `fastify` | `5.12.5` | `5.12.7` | `>=5.12.6` | 清零 |
| `fast-uri` | `3.1.8` | `3.1.9` | `>=3.1.9` | 清零 |
| `undici` | `7.29.1` / `7.30.0` | `7.30.1` | `>=7.30.1` | 清零 |
| `body-parser` | `2.3.0`（生产）/ `1.20.8`（dev） | `2.4.0`（生产）/ `1.20.8`（dev 保留） | `>=2.4.0` 或 `>=1.20.9` | 生产清零；dev 见残留 |

`phase-a-preflight.md` 第 3 节的 15 条逐项覆盖：zod high 1、body-parser high 1、undici high 4 与 moderate 4、fast-uri moderate 2 与 low 2、fastify low 1，全部随上述解析版本消失；原始 `pnpm audit --prod --json` 的 `advisories` 为空对象，无新增 advisory 顶替。

锁文件漂移独立核对（对比 `846f656:pnpm-lock.yaml` 的快照集合）：

- 移除：`body-parser@2.3.0`、`fast-uri@3.1.8`、`fastify@5.12.5`、`light-my-request@6.1.0`、`undici@7.29.1`、`undici@7.30.0`、`zod@3.25.76`，以及 `@nestjs/serve-static` 的 fastify peer 快照重键。
- 新增：`body-parser@2.4.0`、`fast-uri@3.1.9`、`fastify@5.12.7`、`undici@7.30.1`、`zod@4.6.7`，以及重键后的 serve-static 快照。
- 无其它包出现版本集合变化，无无关依赖注入。

overrides 复核：只改了 `fast-uri: ^3.1.8 → ^3.1.9`，新增 `fastify@>=5.0.0 <5.12.6: ^5.12.6`、`undici: ^7.30.1`、`body-parser@>=2.0.0 <2.4.0: ^2.4.0` 三条；无删除、无放宽、无通配符。其中 fastify 范围 override 的必要性已独立证实：`@nestjs/platform-fastify@12.1.3` 把 `fastify` 记为普通依赖，改动前解析 `5.12.5`，加范围 override 后解析 `5.12.7`，否则生产闭包会残留一份 5.12.5。

## 4. zod v4 代码复核

逐文件读改动全文，判断均为 v4 兼容必需、无业务语义变化：

| 文件 | 改动 | 结论 |
| --- | --- | --- |
| `shared/src/dto/api/api.dto.ts` | `AnyZodObject` → `ZodObject`；新增 `ApiSuccessEnvelope` / `ApiResponseEnvelope` 并钉住 `ApiResponseSchema` 返回类型；运行期 schema 保持 `ApiErrorResponseSchema.or(ApiSuccessResponse(data))` 原样 | 合理。v4 不再导出 `AnyZodObject`；v4 对泛型 `.merge` 的推断不可解析会破坏客户端 `success` 判别，钉显式信封类型后 `api.service.ts` 的 `success === false` 收窄在 build 中成立。信封类型字段正确：错误信封的 `data` 是 `{type,message}`，`Omit<ApiErrorResponse,'success'|'data'>` 只留下 `statusCode/timestamp/timeMs` 三个基础字段 |
| `frontend/src/app/services/api/api.service.ts` | 7 处 `AnyZodObject` → `ZodObject`；去掉多余 `as` 断言 | 纯类型改动，调用面不变 |
| `shared/src/validators/ms.validator.ts` | `z.number({ errorMap: () => ({message}) })` → `z.number({ error: 'Invalid duration value' })` | v4 删除构造参数 `errorMap`；用户可见文案不变，冒烟已验证 `Invalid duration value` |
| `shared/src/entities/user.entity.ts` | `hashedPassword: z.undefined()` → `z.undefined().optional()` | 必需且语义等价：v3 中接受 undefined 的字段可缺失键，v4 要求键存在；JSON 会丢 undefined 键，不加 `.optional()` 会让所有携带 user 的响应校验失败。出现字符串仍被拒，防泄漏意图不变 |
| `shared/src/dto/api/image.dto.ts` | `original: z.union([z.string(), z.undefined()])` → `z.string().optional()` | 必需且语义等价：后端 `getFileMimes` 显式写入 `original: undefined`，JSON 丢键；消费方 `view.component.ts` 用 `!== undefined` 与 `?? master` 判断，类型从 `string \| undefined` 变为可选属性后行为一致 |

两个重点项的独立证据：

- 用真实 dist 产物与 zod 4.6.7 自写探针验证：v4 下 `z.undefined()` 字段缺失键确实被拒、`union(string, undefined)` 字段缺失键确实被拒，证明这两处修改是必需而非风格化改动。
- `EUserSchema`：无键通过、显式 undefined 通过、JSON round-trip 丢键后通过、泄漏 hash 字符串被拒、序列化结果不含 `hashedPassword` 键。
- `ImageMetaResponse`：无 original 键通过、显式 undefined 通过、JSON round-trip 丢键后通过、字符串通过、数字被拒。
- 信封：成功信封 data 原样保留、错误信封判别正确、成功信封带错 data 被拒；`UserMeResponse` 与 `ImageMetaResponse` 的 JSON round-trip 信封均通过。
- 后端链路一致性：`SuccessInterceptor.validate` 用 `safeParse(data)` 并返回 `parseResult.data`，strip 后不会把实体上的 `hashed_password` 带进响应；`EUserBackend2EUser` 的现有行为未被本次提交修改。

v3 残留 grep：`AnyZodObject` 0 处、`errorMap` 0 处、`invalid_type_error` / `required_error` 0 处；`z.undefined()` 仅剩已修复的 1 处；`z.record(string(), z.string())` 均为 v4 合法的双参数形式；`.merge()`、`z.string().uuid()`、`z.nativeEnum()`、`ZodTypeAny` 属 v4 仍可用但标 deprecated 的 API，保留与迁移计划一致。

## 5. 运行期冒烟

- 实现成员的 `/tmp/dep-security-v4-smoke.mjs` 仍在，独立重跑 **87/87 passed，退出码 0**，覆盖 createZodDto、`ZodValidationPipe.transform`、响应信封、各响应 DTO 的后端对象与 JSON round-trip、`SuccessInterceptor`、校验器与偏好。
- 本验证人另写 20 条针对性探针，全部通过，见第 4 节。
- **证据缺口**：未启动完整后端进程、未发真实 HTTP 请求。PRD R4 的“后端启动与基础 API 烟测”未闭环。实现报告给出的原因成立：后端必须读 `.env` 凭据文件，8080 实例不可动，dev Postgres 会写迁移/种子。该项必须在 Phase B 的 dry-run 隔离栈回归中补齐，发布前不得省略。

## 6. CI 核对

- run `40881034838`：`headSha=2a8f38c…`，**conclusion=success**，链接 <https://github.com/zhemed/picsur/actions/runs/40881034838>。
- 唯一 job `build-and-audit` 全部步骤 success：checkout、pnpm setup、node setup、工具链版本、装依赖、三包构建、依赖审计、Lint 均 success。
- 对照：父提交 `846f656` 的最近一次 run `40874837318` 为 failure，失败点正是依赖审计；本次提交把该门禁恢复为绿。

## 7. 迁移计划与实际改动的一致性

- 计划 §2.1 的 T1、T2、T3 与 §2.2 的 R1、R2 全部落地，位置与修法一致；T3 结论是“预计可编译”，实际 `create-zod-dto.ts` 未改且编译通过，一致。
- 计划 §3 未预见 `@nestjs/platform-fastify` 的精确钉版导致的额外 fastify 范围 override，实际实现补了这一条并有报告说明；独立核实该 override 必要且范围受限。
- 计数层面有轻微出入：计划写 `.merge()` 6 处、`ZodTypeAny` 3 处、`.uuid()` 6 处，实际源码分别约 6 处运行期 merge、6 处 `ZodTypeAny`、4 行 `uuid()` 调用；属计划阶段估算口径，不影响结论，无遗漏的 v4 不兼容用法。
- 计划 §2.3 记录的“v4 默认错误文案变化”确认只影响 `pref-option` 直接展示的 `issues[0].message`，无代码断言依赖文案。

## 差异与观察

1. 前端 bundle 初始体积由 1.39 MB 增至 1.44 MB，预算警告由超 393.79 kB 变为超 442.17 kB；属 zod v4 体积变化，warning 不阻断，基线本就超预算。非阻断。
2. dev 树仍有存量 advisory：全量审计 50 条，23 high、17 moderate、9 low、2 critical，集中在 brace-expansion 1.x、minimatch 3.x、js-yaml、webpack 链等开发工具，属既有技术债，不在本次生产口径内。
3. `body-parser@1.20.8` 仍经 `express@4.22.3 ← webpack-dev-server ← @angular-builders/custom-webpack` 留在 dev 树，属 dev-only；生产闭包不含它，故审计口径仍为 0。若将来需要全量审核，需另起任务处理 dev 树。

## 残留风险

1. **证据缺口**：后端完整进程与 HTTP 烟测未跑；Fastify 5.12.5 到 5.12.7 的适配器组合、Nest DI 启动路径均未端到端验证。必须在 Phase B dry-run 隔离栈回归中覆盖后再正式推送镜像。
2. zod v4 默认错误文案有细微变化，仅影响偏好输入框直接展示的原始校验信息，不影响判定逻辑。
3. dev 树 advisory 与 bundle 体积上升均为已知非阻断项，建议后续独立任务处理。
