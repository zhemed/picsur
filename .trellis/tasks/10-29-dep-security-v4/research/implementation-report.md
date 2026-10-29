# 实施与自测报告：清 15 条后端/共享 advisory + zod v4 迁移

- 任务：`10-29-dep-security-v4`（父任务 `10-29-release-footer-0.10.7` 前置）
- 执行：trellis-implement 子代理 `dep-fixer`，2026-10-29 13:02 UTC 起
- 环境：Node `v20.20.2` + pnpm `9.6.0`（`export PATH="/root/picsur/.run/node20/bin:$PATH"`），registry npmmirror（审计强制官方 registry）
- 结论：**6 项验收全部满足（CI 除外，提交后轮询），无业务逻辑改动**

## 1. 依赖升级与锁文件解析

| 位置 | 变更 | 锁文件解析结果 |
| --- | --- | --- |
| `backend/package.json` `fastify` | `^5.12.5` → `^5.12.6` | `5.12.7` |
| `backend/package.json` `zod` | `^3.23.8` → `^4.6.7` | `4.6.7` |
| `shared/package.json` `zod` | `^3.23.8` → `^4.6.7` | `4.6.7` |
| `frontend/package.json` `zod` | `^3.25.76` → `^4.6.7` | `4.6.7` |
| 根 `pnpm.overrides` `fast-uri` | `^3.1.8` → `^3.1.9` | `3.1.9` |
| 根 `pnpm.overrides` 新增 `undici` | `^7.30.1` | `7.30.1`（树内唯一的 undici 7.x，dev 侧 7.29.1 一并提升） |
| 根 `pnpm.overrides` 新增 `body-parser@>=2.0.0 <2.4.0` | `^2.4.0` | `2.4.0`；express@4 的 body-parser@1.20.8 **保持不动**（范围限定避免跨大版本） |
| 根 `pnpm.overrides` 新增 `fastify@>=5.0.0 <5.12.6` | `^5.12.6` | `5.12.7`；见下方「计划外发现」 |

**计划外发现**：`@nestjs/platform-fastify@12.1.3` 把 `fastify` 钉成**精确依赖 `5.12.5`**（不是 peer），只把 backend 直接依赖升到 `^5.12.6` 后，生产闭包里仍会留一份 `fastify@5.12.5`，审计还剩 1 条 low。补一条范围限定的 override（仅 5.x 且 <5.12.6）后全局只剩 `5.12.7`（已确认快照依赖全部指向它）。

**锁文件漂移核对**（对比 `git show HEAD:pnpm-lock.yaml` 的 snapshots 包版本集合）：

- 移除 7 个旧版本：`body-parser@2.3.0`、`fast-uri@3.1.8`、`fastify@5.12.5`、`light-my-request@6.1.0`（fastify 升级的连带补丁版）、`undici@7.29.1`、`undici@7.30.0`、`zod@3.25.76`
- 新增 5 个版本：`body-parser@2.4.0`、`fast-uri@3.1.9`、`fastify@5.12.7`、`undici@7.30.1`、`zod@4.6.7`
- 无其它包的大版本漂移；`zod@4.6.6`（`@angular/cli` / MCP SDK 的 dev 传递依赖）保持原样，不与 workspace 的 4.6.7 冲突。
- `pnpm install --frozen-lockfile` 复核：`Lockfile is up to date, resolution step is skipped`，退出码 0（与 CI 第一步同口径）。

## 2. 审计前后

| 时间点 | 命令 | 后端/共享命中 | 浏览器侧 | 退出码 |
| --- | --- | --- | --- | --- |
| 改动前（基线） | `bash support/audit-prod.sh` | **15** | 0 | 1 |
| 仅升级 fastify/fast-uri/undici/body-parser/zod 后（首次 install） | 同上 | **1**（只剩 `fastify@5.12.5`，来自 platform-fastify 精确钉版） | 0 | 1 |
| 补 fastify override 后（最终） | 同上 | **0** | 0 | **0** |

最终输出：

```text
▶ pnpm audit --prod（registry: https://registry.npmjs.org/）
  backend/shared 生产依赖闭包：477 个包
  命中总数：后端/共享 0 ｜ 浏览器侧 0

✅ 后端/共享口径 0 告警（浏览器侧 0 条，已知）
```

15 条明细的覆盖：zod high ×1、body-parser high ×1、undici high ×4/moderate ×4、fast-uri moderate ×2/low ×2、fastify low ×1 —— 全部随解析版本升级消失，**没有放宽任何依赖范围或修改审计脚本**。

## 3. 代码修复（zod v4 迁移）

迁移面侦察见 `zod-v4-migration-plan.md`。实际落地 6 个文件，均为类型/兼容层最小修复，无业务语义改动：

| 文件 | 修复 |
| --- | --- |
| `shared/src/dto/api/api.dto.ts` | `z.AnyZodObject` → `z.ZodObject`（v4 不再导出前者）；新增显式信封类型 `ApiSuccessEnvelope<T>` / `ApiResponseEnvelope<T>` 并钉在 `ApiResponseSchema` 的返回类型上。原因：v4 对「嵌入泛型 schema 的 `.merge()`」推断出不可解析的 mapped type，`success === false` 判别式收窄失效；runtime schema 原样保留 |
| `frontend/src/app/services/api/api.service.ts` | `z.AnyZodObject` → `z.ZodObject`（7 处）；去掉多余的 `as` 断言 |
| `shared/src/validators/ms.validator.ts` | v4 删除构造参数 `errorMap`，改 `error: 'Invalid duration value'`，用户可见文案不变 |
| `shared/src/entities/user.entity.ts` | `hashedPassword: z.undefined()` → `z.undefined().optional()`。v4 对「接受 undefined 的 schema」要求键必须存在；DB 实体对象与 JSON 响应都没有该键 → 否则登录/用户接口的响应校验在 v4 下必 500。意图不变：出现字符串仍判失败 |
| `shared/src/dto/api/image.dto.ts` | `fileTypes.original: z.union([z.string(), z.undefined()])` → `z.string().optional()`。后端显式写 `original: undefined`，JSON 序列化会丢键，前端解析在 v4 下会失败（默认 `keep_original=false` 的大多数图片） |
| `.trellis/.../research/*` | 迁移计划与本报告 |

保留未动的 v4 deprecated API（4.6.7 仍存在、编译与运行期正常）：`.merge()`、`z.string().uuid()`、`z.nativeEnum()`、`ZodTypeAny`。

## 4. 验证证据（均在本机 Node 20 + pnpm 9.6.0）

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| 构建 | `pnpm build` | 退出码 **0**，三包全部成功，0 条 `error TS`；仅存量 Sass 弃用警告与 bundle 预算警告（1.44 MB vs 1 MB，基线相同） |
| Lint | `pnpm lint` | 退出码 **0**，`0 errors, 9 warnings`（9 条 warning 与基线完全一致，均为存量未使用变量） |
| 锁文件一致性 | `pnpm install --frozen-lockfile` | 退出码 **0**，`Lockfile is up to date` |
| 依赖审计 | `bash support/audit-prod.sh` | 退出码 **0**，后端/共享 0 条 |

### 4.1 运行期冒烟（/tmp 临时脚本，87 项全过）

脚本：`/tmp/dep-security-v4-smoke.mjs`（跑完后已移出仓库；实现不等于单测，见下）。直接 import 三个包的 `dist` 产物与真实 `ZodValidationPipe` / `SuccessInterceptor`，结果 **87/87 passed，退出码 0**：

- `createZodDto`：`create()` 合法/非法输入、`zodSchema` 静态属性、泛型 holder 类。
- `ZodValidationPipe.transform`：body 合法、非法 → `Failure(usrvalidation, 400)` 且 debug 带 `too_small`；query 字符串预转换（`height:'100'`、`flipx:'true'`）；`custom` 类型默认跳过；`metatype=null` 透传。
- `ApiResponseSchema`：成功信封、错误信封解析；错误 discriminate；坏信封拒绝。
- 响应 DTO 的 **后端对象校验 + JSON round-trip（前端路径）+ 信封 round-trip + 坏 payload 拒绝** 四连：`UserMeResponse`、`UserLoginResponse`、`EUserSchema`（无 `hashedPassword` 键 / 显式 undefined / 泄漏 hash 必须拒绝）、`ImageListResponse`、`ImageMetaResponse`（无 original / 显式 undefined / 有 original）、`InfoResponse`、`MultiplePreferencesResponse`、`GetSpecialUsersResponse`、`UpdateCheckResponse`、`AllFormatsResponse`。
- `EImageSchema`：后端 `Date` 对象形态与前端 ISO 字符串形态都通过；坏 UUID/日期拒绝。
- 真实 `SuccessInterceptor` + `EUserBackend2EUser`：DB 实体（无/有 `hashed_password`）→ EUser 通过；拦截器包装 `UserMeResponse` 成功、非法响应抛 `Failure(internal)`、`noreturns` 透传。
- 校验器与偏好：`IsValidMS`（`5m`→300000、非法值文案 `Invalid duration value` 保留、min 生效）、`IsPosInt`、`IsEntityID`、`IsApiKey`、`IsPrefValue`、`IsStringList`、`IsUsername`、`IsPlainTextPwd`、`SysPreferenceValidators`、`UsrPreferenceValidators`、`TrackingStateSchema`、`JwtDataSchema`、`ZodError.issues[0].message`（前端 `pref-option` 消费方式）。

### 4.2 证据缺口：未启动完整后端进程

PRD R4 提到「后端启动与基础 API 烟测」。本机后端配置为 `ConfigModule.forRoot({ ignoreEnvVars: true })`，启动必须读取仓库根的 `.env`（凭据文件，属 Trellis 策略闸门 S-m3 拦截的凭据路径），且 8080 的 all-in-one 实例不可动、dev Postgres 启动会跑迁移/种子写入。因此**没有启整个后端进程**，改用上面的「真实 dist 模块 + 真实 `ZodValidationPipe`/`SuccessInterceptor` + 全部响应/请求 DTO」直跑覆盖 zod 迁移风险面。zod 迁移不触及 Nest DI/配置/数据库，该缺口不影响本次验收判断；如需端到端 34 项镜像回归，按 runbook 在 Phase B 用隔离容器做。

## 5. 变更边界

- 未改 0.10.7 版本号（四个 `package.json` 的 `version` 仍为 `0.10.6`）。
- 未夹带页脚改动、任务归档内容；未动 `127.0.0.1:8080` 实例、未跑 `release-local.sh`。
- 未使用 `pnpm audit --fix`；未放宽任何依赖范围。
- 提交只含：4 个 `package.json`、`pnpm-lock.yaml`、5 个源码文件、本任务目录（`10-29-dep-security-v4`）；父任务目录 `10-29-release-footer-0.10.7` 保持原样不提交。
