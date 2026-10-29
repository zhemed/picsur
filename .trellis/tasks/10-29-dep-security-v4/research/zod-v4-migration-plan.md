# zod v3 → v4 迁移面侦察与修法（实施前）

- 任务：`10-29-dep-security-v4`（0.10.7 发版前置）
- 依据：`zod@4.6.7`（已确认 npmmirror 与官方 registry 均有该版本）、官方 migration guide（https://zod.dev/v4/changelog）
- 侦察方法：全量 grep 三包 zod 用法；用已安装的 `zod@4.6.6` 与 `zod@3.25.76` 在 /tmp 做同输入对照探针；只读，不改代码

## 1. 用法清单（31 个文件、57 处 import）

- `shared`：DTO（`dto/api/*.dto.ts`）、实体 schema（`entities/*.entity.ts`）、校验器（`validators/*.validator.ts`）、`util/create-zod-dto.ts`
- `backend`：`layers/validate/zod-validator.pipe.ts`（请求校验）、`layers/success/success.interceptor.ts`（响应校验）、两个 preference 实体 schema、`managers/auth` 里的 `safeParse`
- `frontend`：`services/api/api.service.ts`（响应信封校验）、`pref-option.component.ts`（表单校验）、`settings-sys-pref.component.ts`（validator 注入）

## 2. 必须修的破坏点

### 2.1 类型层面（tsc 报错）

| # | 位置 | 问题 | 修法 |
| --- | --- | --- | --- |
| T1 | `shared/src/dto/api/api.dto.ts`（2 处）、`frontend/src/app/services/api/api.service.ts`（7 处） | `z.AnyZodObject` 在 zod v4 中已不再导出（仅在 `zod/v3` 兼容入口） | 改为 `z.ZodObject`（v4 泛型有默认参数，可直接作类型用；`T` 仍是具体 schema，`z.infer<T>` 精度不变） |
| T2 | `shared/src/validators/ms.validator.ts` | v4 删除了构造函数参数里的 `errorMap`，改名 `error` | `z.number({ error: 'Invalid duration value' })`；语义等价，用户的偏好值校验文案不变 |
| T3 | `shared/src/util/create-zod-dto.ts` | `z.ZodType<unknown>` 作泛型约束在 v4 的方差下是否仍成立需编译确认 | 预计可编译（v4 把 Output/Input 都标了 `out`）；若报错改为 `z.ZodTypeAny`（v4 compat 仍导出） |

保留不动的 deprecated API（v4.6.7 仍存在，仅类型标 `@deprecated`，编译/runtime 均正常）：
`.merge()`（6 处）、`z.string().uuid()`（6 处）、`z.nativeEnum()`（1 处）、`ZodTypeAny`（3 处）。

### 2.2 运行期（v4 对象字段「缺失键」语义变化，最危险）

v3 中「schema 接受 undefined」的字段可以整键缺失；**v4 要求键必须存在**，否则报 `expected nonoptional`。而 JSON 序列化会丢掉值为 `undefined` 的键，后端响应校验（`SuccessInterceptor`）与前端响应解析（`api.service`）都会命中。

| # | 位置 | 现状 | 运行期后果 | 修法 |
| --- | --- | --- | --- | --- |
| R1 | `shared/src/entities/user.entity.ts` `hashedPassword: z.undefined()` | 期待「键可有可无，但一旦出现必须是 undefined」（防泄露） | v4 下 DB 实体对象/JSON 响应都没有该键：后端响应校验 500（登录、/user、用户管理等），前端解析同样失败 | `z.undefined().optional()`：意图不变（出现字符串仍报错），缺失键放行 |
| R2 | `shared/src/dto/api/image.dto.ts` `fileTypes.original: z.union([z.string(), z.undefined()])` | `getFileMimes` 显式写入 `original: undefined`；但 JSON 序列化丢失该键 | 默认 `keep_original=false`（大多数图片）：响应 JSON 无 `original` 键，前端解析失败 → 图片查看页拿不到 metadata | `z.string().optional()`（原值仍只允许 string/undefined，`?? master` 的消费方不变） |

已用探针确认**行为一致**、无需改动的点：`z.preprocess`（含 partial 场景）、`.nullable()`、`z.date()`、`z.record(键,值)` 双参数、`z.enum(元组)`、`.merge/.partial/.pick/.omit`、`z.nativeEnum`、`z.string().uuid()`（标准 UUID 通过；nil/uppercase 也通过）、`z.any()` 在 `safeParse` 单值场景。

### 2.3 已知但可接受的差异

- 错误文案：v4 默认 issue message 改为 `Invalid input: expected string, received number`（v3 为 `Expected string, received number`）。仅 `pref-option` 展示给用户；`ms.validator` 有显式文案，已保留。无代码断言依赖文案。
- `z.number().int()` 只接受安全整数：仓库内数值（statusCode/timeMs/pages/total/宽高/rotate/quality）都远在安全范围。
- `z.any()` 出现在 `_ApiAnySuccessResponseSchema` 的 `data` 字段，但该 schema 只用于 `z.infer` 类型，不做运行期 parse。

## 3. 依赖升级清单

| 位置 | 现在 | 改为 | 解析预期 |
| --- | --- | --- | --- |
| `backend/package.json` `fastify` | `^5.12.5` | `^5.12.6` | 5.12.7 |
| `backend/shared/frontend` `zod` | `^3.23.8` / `^3.23.8` / `^3.25.76` | `^4.6.7` | 4.6.7 |
| 根 `pnpm.overrides` `fast-uri` | `^3.1.8` | `^3.1.9` | 3.1.9 |
| 根 `pnpm.overrides` 新增 `undici` | 无 | `^7.30.1` | 7.30.1（树内只有 7.29.1/7.30.0，无跨大版本风险） |
| 根 `pnpm.overrides` 新增 `body-parser` | 无 | `body-parser@>=2.0.0 <2.4.0: ^2.4.0` | 2.4.0；**必须限定 2.x**，树里还有 express@4 的 body-parser@1.20.8，裸 `^2.4.0` 会跨大版本顶掉它（违反 spec §8.2） |

依赖来源链（读 `pnpm-lock.yaml` snapshots 确认）：
`fastify@5.12.5` ← backend 直接依赖（另被 `@nestjs/platform-fastify`/`@nestjs/serve-static` 以 peer/optional 方式复用，提升 backend 声明即可全局解析到 5.12.7）；
`fast-uri@3.1.8` ← `@fastify/ajv-compiler` / `fast-json-stringify` / `ajv`；
`undici@7.30.0` ← `@fastify/reply-from@12.7.1`（生产）；`undici@7.29.1` ← `@angular/build`（dev）；
`body-parser@2.3.0` ← `express@5.3.0`（`@nestjs/serve-static` 的 optional dep，express 的最新版仍是 5.3.0，其依赖区间 `^2.3.0` 允许 2.4.0）。

## 4. 实施与验证顺序

1. 改 4 个 package.json（只动依赖：不改 version 字段）+ 根 overrides。
2. Node 20 + pnpm 9.6.0 `pnpm install`；核对锁文件解析版本、无跨大版本漂移。
3. `pnpm build` 暴露全部 TS 错误 → 逐处最小修复（预期即 T1/T2，可能含 T3）。
4. 运行期冒烟：请求/响应 DTO 的 JSON round-trip 校验、`ZodValidationPipe.transform`、`createZodDto.create`、错误信封、preference 校验；必要时起临时后端实例做基础 API 烟测（不动 8080 实例）。
5. `pnpm lint`、`bash support/audit-prod.sh`（后端/共享 0 条）。
6. 提交推送、等 CI success。
