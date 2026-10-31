# Research: 鉴权与密码哈希在 Rust 侧的对位

- Query: 现有 bcrypt 加 JWT 的鉴权在 Rust 侧用什么库，密码哈希与 token 如何保持兼容，权限模型怎么落地
- Scope: mixed —— 仓库事实取自 `backend/src/managers/auth/**`、`backend/src/collections/user-db/**`、`backend/src/config/late/jwt.config.service.ts`，外部资料取自 crates.io 公开元数据
- Date: 2026-10-31

## Findings

### Files Found

| File Path | Description |
|---|---|
| `backend/src/managers/auth/auth.service.ts` | 签发 token，payload 只含 `uid` |
| `backend/src/managers/auth/guards/jwt.strategy.ts` | Bearer 提取、签名校验、payload 校验、按 uid 查用户 |
| `backend/src/managers/auth/guards/local-auth.strategy.ts` | 用户名口令校验，最少 450ms 延迟 |
| `backend/src/managers/auth/guards/guest.strategy.ts` | 匿名回退到 guest 用户 |
| `backend/src/managers/auth/guards/main.guard.ts` | JWT 与 guest 双策略、路由权限并集判定 |
| `backend/src/managers/auth/guest.service.ts` | guest 用户读取与兜底对象 |
| `backend/src/collections/user-db/user-db.service.ts` | bcrypt 强度读取、create、updatePassword、authenticate、getPermissions |
| `backend/src/collections/user-db/user-db.module.ts` | 启动时确保 guest 与 admin 账号存在并同步 guest 权限 |
| `backend/src/config/late/jwt.config.service.ts` | secret 与有效期从系统偏好读取 |
| `backend/src/config/late/late-config.module.ts` | env 覆盖数据库 secret 的启动逻辑 |
| `backend/src/config/early/early-jwt.config.service.ts` | `PICSUR_JWT_SECRET` 与 `PICSUR_JWT_EXPIRY` |
| `backend/src/models/constants/permission-templates.const.ts` | guest、user、admin 权限模板与隐式权限 |
| `backend/src/models/constants/special-users.const.ts` | 特殊账号名单 |
| `shared/src/dto/jwt.dto.ts` | JWT payload 的 zod schema |
| `shared/src/validators/user.validators.ts` | 用户名与口令的字符与长度约束 |
| `frontend/src/app/services/storage/key-storage.service.ts` | 前端保存 token 的位置 |
| `.trellis/spec/picsur-backend/backend/build-and-deploy.md` §11 | secret 轮换实测记录 |

### Code Patterns

一、密码哈希

1. 算法是 bcrypt，库是 `bcrypt-ts` 5.0.2，纯 TypeScript 实现，见 `backend/package.json` 依赖与 `user-db.service.ts:3`。
2. 强度来自系统偏好 `bcrypt_strength`，默认 10，读不到时也回落 10，见 `user-db.service.ts:311-319` 与 `preference-defaults.service.ts:42`。也就是说每次哈希前都要查一次数据库偏好，不是常量。
3. 哈希写入两个入口：创建用户 `user-db.service.ts:53-77`，修改口令 `:174-191`。校验入口是 `authenticate` 的 `bcrypt.compare`，见 `:215-216`。
4. 口令明文约束是 4 到 1024 字符，见 `shared/src/validators/user.validators.ts:10`。1024 远超 bcrypt 的 72 字节有效长度，两者的截断语义必须核对，见本文件末尾待确认项。
5. `hashed_password` 列查询时默认不取，见 `user.entity.ts:52-53`；只有登录路径显式取全列，见 `user-db.service.ts:238-255`。对外序列化前用 transformer 抹掉哈希字段，见 `models/transformers/user.transformer.ts:4-11`。

二、JWT

1. 签发：`auth.service.ts:13-30` 构造 `{uid}`，用 `JwtDataSchema` 校验后 `signAsync`。payload schema 允许 `iat` 与 `exp`，其余字段会被 zod 剥离，见 `shared/src/dto/jwt.dto.ts:4-9`。
2. 算法与库：Nest `@nestjs/jwt` 12 封装 `jsonwebtoken` 9.0.3，默认 HS256 对称签名，没有显式配置 algorithm。
3. secret 来源有两级：数据库系统偏好 `jwt_secret` 优先被运行期读取，见 `jwt.config.service.ts:22-28`；env 有 `PICSUR_JWT_SECRET` 时在启动阶段覆盖数据库值，见 `late-config.module.ts:44-52`。没有 env 且数据库没有时，用 64 字符随机串生成并落库，见 `preference-defaults.service.ts:29-39`。
4. 有效期来自系统偏好 `jwt_expires_in`，默认 `7d`，用 `ms` 解析成毫秒再除以 1000 传给 signOptions，见 `jwt.config.service.ts:30-49`。
5. 校验：`jwt.strategy.ts:20-24` 用 `fromAuthHeaderAsBearerToken` 提取，`ignoreExpiration: false`，共享 secret 校验签名；随后用 zod 解析 payload 并按 `uid` 查用户，见 `:27-45`。用户被删除后 token 立即失效，因为每次请求都查库。
6. 双策略回退：`main.guard.ts:28` 是 `AuthGuard(['jwt','guest'])`，无 token 或 token 无效时落到 guest 策略，见 `guest.strategy.ts:32-34`。guest 用户来自数据库 `guest` 行，不存在时用内存兜底对象，见 `guest.service.ts:8-23`。
7. 一个现存缺陷：兜底 guest 对象没有 `id`，而 `main.guard.ts:53-59` 要求 user 必须有 id，否则抛 `internal`。也就是说 guest 行缺失时匿名访问会 500。Rust 侧建议在启动时确保 guest 行存在，并把这条行为记为「修复而非兼容」。
8. 权限判定：`main.guard.ts:62-82` 取路由声明的权限并集，与 `usersService.getPermissions` 结果比较，全包含才放行；权限结果挂到请求上供 `HasPermission` 使用，见 `permissions.decorator.ts:27-41`。
9. 权限计算规则在 `user-db.service.ts:162-172`：内置 `admin` 账号读时全权；其他账号是隐式权限加用户列。隐式权限是 `user-login`、`user-keep-login`、`settings`，见 `permission-templates.const.ts:47-51`。guest 模板是 `image-view` 与 `image-delete-key`，demo 模式额外加 `image-upload`，见 `:16-63`。
10. 特殊账号约束：`admin` 不可改权限、`guest` 与 `admin` 不可删、`guest` 不可登录，见 `special-users.const.ts:1-7` 与 `user-db.service.ts:83-121`、`:210-213`。
11. 登录路径：`POST /api/user/login` 走 `LocalAuthGuard`，要求 `user-login` 权限，见 `user.controller.ts:35-43`；成功后返回 `{jwt_token}`，201 状态码。`/api/user/me` 返回用户与新签发的 token，见 `:71-83`。登录限流 30 次每 300 秒，注册 5 次每 300 秒。
12. 防用户枚举：本地策略强制最少 450ms 响应，见 `local-auth.strategy.ts:18-27`；账号不存在与口令错误返回同一句 `Wrong username or password`，见 `user-db.service.ts:199-216`。
13. 前端把 token 存在本地存储，见 `frontend/src/app/services/storage/key-storage.service.ts`，所有请求加 `Authorization: Bearer`，见 `api.service.ts:259-265`。token 过期后由 401 或 403 触发重新登录，没有刷新令牌机制。

三、路由与权限矩阵

| 路由 | 声明位置 | 所需权限 | 备注 |
|---|---|---|---|
| `GET /api/info`、`/permissions`、`/formats` | `info.controller.ts:22-24` | 无 | 匿名可读 |
| `POST /api/user/login` | `user.controller.ts:35-38` | `user-login` | 走本地口令策略 |
| `POST /api/user/register`、`/checkname` | `user.controller.ts:45-69` | `user-register` | 限流 5 与 20 |
| `GET /api/user/me` | `user.controller.ts:71-74` | `user-keep-login` | 返回新 token |
| `GET /api/user/me/permissions` | `user.controller.ts:86-89` | 无 | 登录后自查 |
| `/api/user/list`、`create`、`delete`、`info`、`update`、`special` | `user-manage.controller.ts:34-35` | `user-admin` | 类级声明 |
| `POST /api/image/upload` | `image-manage.controller.ts:58-60` | `image-upload` | 另判 `image-delete-key` 决定是否发删除密钥 |
| `POST /api/image/list`、`list/all`、`update`、`delete` | `image-manage.controller.ts:92-165` | `image-manage` | 另判 `image-admin` 决定能否越权操作他人图片 |
| `POST /api/image/delete/key`、`GET /api/image/delete/:id/:key` | `image-manage.controller.ts:167-194` | `image-delete-key` | 匿名删除入口 |
| `GET`、`HEAD` `/i/*` | `image.controller.ts:50-53` | `image-view` | 限流 600 每 60 秒 |
| `/api/pref/sys*` | `sys-pref.controller.ts:15-17` | `syspref-admin` | 只暴露 5 项可写偏好 |
| `/api/pref/usr*` | `usr-pref.controller.ts:16-18` | `settings` | 按 user_id 隔离 |
| `POST /api/usage/report` | `usage.controller.ts:28-30` | 无 | 限流 120 每 60 秒 |
| `/api/system/update/*` | `system-update.controller.ts:39-41` | `syspref-admin` | 含 docker 自升级 |

## Decision

### 推荐方案：jsonwebtoken 11.1.0 加 rust_crypto 后端，继续用 bcrypt 0.19.3

- JWT 库：`jsonwebtoken` 11.1.0，2026-09-16 发布，关闭默认 feature 后启用 `rust_crypto`，用纯 Rust hmac 与 sha2，不需要 ring 或 aws-lc 的 C 编译链。HS256 是现有配置，payload 结构与 `JwtDataSchema` 对齐。
- 密码库：`bcrypt` 0.19.3，2026-07-27 发布，MIT，支持 `$2a$`、`$2b$`、`$2y$` 前缀的校验，强度参数直接复用数据库里的 `bcrypt_strength`。
- 理由：两条链路都保持与现网完全相同的算法与格式，token 与密码哈希可以双向互认，最适合绞杀者式过渡；纯 Rust 依赖减少镜像里的 C 构建面。
- 替代方案一：`josekit`，JWT 与 JWS 覆盖更全，代价是依赖树更大、API 更底层，HS256 用不上它的优势。
- 替代方案二：保留 Node 侧鉴权作为独立小服务，Rust 反代登录与校验。代价是多一个常驻进程与一次网络往返，收益是零兼容风险；只在首次割接前短期使用。
- 替代方案三：`argon2` 0.6.0 迁移到 Argon2id。这需要双算法校验加登录时重哈希，属于安全增强而不是迁移必需项，建议放到迁移完成后单独立项。
- 代价：需要写一套密码与 token 的兼容性测试语料，约 2 到 3 天；`jsonwebtoken` 11 与 9 的 API 差异需要重新学习，MSRV 1.88。
- 验证方式：三条硬断言。第一，Node 侧用 `bcrypt-ts` 生成 20 条不同强度与口令（含多字节 UTF-8、空串、72 字节边界）的哈希，Rust 全部校验通过；反向 Rust 生成、Node 校验也通过。第二，Node 签发的 token 在 Rust 校验通过并可解析出同一 uid；Rust 签发的 token 在 Node 的保护路由上 200。第三，删除用户后旧 token 在两侧都失效。

### 推荐方案：鉴权做成两层，中间件加权限提取器

- 做法：最外层中间件解析 Bearer 并加载用户；handler 声明所需权限，由提取器或宏统一校验；guest 回退在同一中间件内完成，保持「无 token 也能访问 image-view 路由」的现状。
- 理由：现有语义是「JWT 失败回退 guest，不是直接 401」，这是很多路由匿名可用的前提，用 axum 的 `FromRequestParts` 实现最贴近。
- 替代方案：每个 handler 内手写鉴权。代价是重复且容易漏，不推荐。
- 代价：需要一张路由到权限的静态表，并与现有 decorator 声明逐条对齐；这张表就是本文件第三节的矩阵。
- 验证方式：对矩阵每一行构造三种身份，匿名、guest、普通用户、admin，断言 200 或 403 与 Node 实例一致；另外断言 `/api/user/me/permissions` 在匿名时仍返回 guest 权限而不是 401。

### 推荐方案：secret 只读，不由 Rust 侧回写数据库

- 理由：现有 Node 启动会用 env 覆盖数据库 secret，见 `late-config.module.ts:44-57`。过渡期两个实现共存时，若 Rust 也执行同样的回写，一旦 env 不同就会把数据库 secret 改掉，导致所有在线会话失效。Rust 首版应当只读数据库值，env 只作为启动失败时的显式覆盖开关。
- 替代方案：完全复刻 Node 的覆盖逻辑，但要求两侧 env 严格一致。代价是运维约束，容易出事。
- 代价：Rust 侧少一条自愈能力，secret 缺失时要给出明确报错。
- 验证方式：造三种场景。数据库有 secret 且无 env、数据库有 secret 且有相同 env、数据库无 secret。断言前两种 token 不失效、第三种按预期生成并落库一次。

## Caveats / Not Found

1. 待确认：`bcrypt-ts` 对超过 72 字节口令的行为是截断还是报错。验证方法：用 100 字节 ASCII 与 100 字节中文各建一个用户，分别在 Node 与 Rust 侧登录，记录成功或失败，写入兼容性测试。若 Node 截断而 Rust 报错，Rust 侧需要实现同样的截断，并在注册时拒绝超长口令或明确文档化。
2. 待确认：`bcrypt-ts` 生成的哈希前缀是 `$2b$` 还是 `$2a$`。验证方法：从现网库读 3 条 `hashed_password`，看前缀；Rust `bcrypt` 0.19.3 对两种前缀都应能校验，仍需实测确认。
3. 待确认：`jsonwebtoken` 11 在 `rust_crypto` 后端下对 HS256 的完整支持，以及 `exp` 的容差配置。验证方法：构造过期 1 秒、过期 1 小时、无 exp 三种 token，断言校验结果与 Node 一致。
4. 待确认：JWT header 里的 `typ` 与 `alg` 字段细节是否与 jsonwebtoken 9 一致。验证方法：解码两侧签发的 token，比较 header 与 payload 的全部字段与顺序，字段顺序不影响校验，但要记录。
5. 待确认：`PICSUR_JWT_EXPIRY` 的 `ms` 语义在 Rust 侧用哪个库复刻，`humantime` 与 `ms` 的表达式集不同。验证方法：枚举 `7d`、`1h`、`30m`、`15s`、非法值，对比两侧解析出的秒数。
6. 未找到：仓库没有刷新令牌、没有 OAuth、没有 API Key 验证路径。API Key 功能已于 2026-10-16 移除，残留表 `e_api_key_backend` 只读不写，见 `main.guard.ts:22-25` 的注释与 `database-guidelines.md`。
7. 未找到：没有多因素认证、没有会话表、没有 token 黑名单。token 失效完全依赖 secret 轮换与用户删除，见 `build-and-deploy.md` §11。
