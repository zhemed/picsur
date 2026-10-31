# Research: 鉴权与权限模型

- Query: 盘点登录、JWT、会话模型、用户状态、角色与权限、管理员口径
- Scope: internal
- Date: 2026-10-31
- 证据基线: git master b6bd23c

## Findings

### 一、认证方式总览

| 方式 | 是否启用 | 证据 |
|---|---|---|
| JWT Bearer | 主方式，所有请求都过全局 guard | `backend/src/main.ts:55`、`managers/auth/guards/main.guard.ts:28` |
| 用户名口令 | 仅登录端点，`@UseLocalAuth` 局部启用 | `decorators/permissions.decorator.ts:20-25`、`routes/api/user/user.controller.ts:35-38` |
| guest 回退 | 未带 token 时自动落到内置 guest 账号 | `managers/auth/guards/main.guard.ts:18-28`、`guards/guest.strategy.ts:22-35` |
| API Key | 已移除，仅在失败路径提及 | `managers/auth/guards/main.guard.ts:22-25` |
| Cookie / Session | 不存在，无状态 | 全局无 cookie 中间件，`main.ts` 未注册 session |

Guard 链顺序：`AuthGuard(['jwt', 'guest'])`，jwt 失败后 guest 兜底，然后才是权限校验。`guards/main.guard.ts:28, 38-83`

### 二、JWT 细节

| 项 | 事实 | 证据 |
|---|---|---|
| 载荷 | 只有 `uid` 字段，schema 校验 | `shared/src/dto/jwt.dto.ts`、`managers/auth/auth.service.ts:13-26` |
| 签名算法 | 未显式指定，走 @nestjs/jwt 默认 HS256 | `config/late/jwt.config.service.ts:43-50` |
| 密钥来源 | 系统偏好 `jwt_secret`；环境变量 `PICSUR_JWT_SECRET` 优先，否则随机生成 64 位并持久化 | `collections/preference-db/preference-defaults.service.ts:29-39` |
| 过期时间 | 系统偏好 `jwt_expires_in`，默认 7d，可由 `PICSUR_JWT_EXPIRY` 覆盖，单位转秒 | `preference-defaults.service.ts:40-41`、`config/late/jwt.config.service.ts:30-41` |
| 提取方式 | `Authorization: Bearer <token>` | `guards/jwt.strategy.ts:20-24` |
| 过期校验 | `ignoreExpiration: false` | `guards/jwt.strategy.ts:22` |
| 刷新机制 | 无 refresh token；`GET /api/user/me` 每次返回新 token | `routes/api/user/user.controller.ts:71-83` |
| 失效 | 无黑名单、无版本号，改密码不使旧 token 失效 | 无相关代码，标「待确认」；`user-db.service.ts:174-191` 只改哈希 |
| 日志泄露风险 | `PICSUR_VERBOSE=true` 会把 secret 打进日志 | `config/late/jwt.config.service.ts:15-20`、`.env.example:87-89`、`AGENTS.md` 第 4 条 |

`JwtDataSchema` 校验失败会被记录并返回 401 路径，见 `guards/jwt.strategy.ts:27-45`。

### 三、口令哈希与登录流程

- 哈希库：`bcrypt-ts` 5.0.2，`backend/package.json:38`
- 哈希前缀：库生成 `$2a$` 格式，见 `backend/node_modules/bcrypt-ts/dist/node.mjs` 中 genSalt 实现；Rust 侧需兼容 `$2a$` 与常见 `$2b$` 校验
- cost 来源：系统偏好 `bcrypt_strength`，默认 10，见 `preference-defaults.service.ts:42`、`collections/user-db/user-db.service.ts:311-319`
- 登录校验：按用户名查含密码列的用户，再 `bcrypt.compare`，见 `user-db.service.ts:195-219`
- 失败统一文案 `Wrong username or password`，不区分用户名不存在与口令错误，见 `:200-217`
- 时间侧信道缓解：登录成功后至少等待 450ms，见 `guards/local-auth.strategy.ts:18-27`
- 登录限流 30 次 / 300 秒，见 `routes/api/user/user.controller.ts:38`
- 注册与检查用户名限流分别 5 次 / 300 秒与 20 次，见 `user.controller.ts:48, 62`

### 四、用户状态与内置账号

| 账号 | 属性 | 证据 |
|---|---|---|
| `admin` | 内置，不可删除，权限不可修改，读取时永远返回全部权限 | `models/constants/special-users.const.ts:1-5`、`user-db.service.ts:103-128, 162-172` |
| `guest` | 内置，不可删除，禁止登录，未登录请求的实际身份 | `special-users.const.ts:1-8`、`user-db.service.ts:210-213` |
| 普通用户 | 无启用、禁用、封禁字段，注册后即可用 | `database/entities/users/user.entity.ts:21-57` |

- admin 初始口令来自 `PICSUR_ADMIN_PASSWORD`，默认 `picsur`，见 `config/early/auth.config.service.ts:10-15`、`collections/user-db/user-db.module.ts:48-54`
- guest 口令为 128 位随机串，见 `user-db.module.ts:38-46`
- guest 账号在启动时被同步到权限模板，admin 仅在不存在时创建，见 `user-db.module.ts:31-55`
- 用户表无 email、无头像、无创建时间字段，见 `user.entity.ts:21-57`
- 没有「已禁用用户」概念，唯一限制登录的是内置 guest，见 `special-users.const.ts:7-8`

### 五、权限模型

权限字符串共 11 个，见 `shared/src/dto/permissions.enum.ts:5-20`：

| 权限 | 含义 |
|---|---|
| `image-view` | 查看图片 |
| `image-upload` | 上传图片 |
| `image-delete-key` | 用删除密钥删除图片 |
| `image-manage` | 管理自己的图片 |
| `user-login` | 登录 |
| `user-keep-login` | 查看自己资料并续签 token |
| `user-register` | 注册 |
| `settings` | 个人设置 |
| `image-admin` | 管理所有人的图片 |
| `user-admin` | 管理用户 |
| `syspref-admin` | 管理系统偏好与升级 |

权限来源与合并规则：

- 权限直接存在 `e_user_backend.permissions` 文本数组，见 `database/entities/users/user.entity.ts:42-50`
- 每个请求的最终权限 = 隐式权限 + 用户已存权限，见 `collections/user-db/user-db.service.ts:162-172`
- 隐式权限为 `user-login`、`user-keep-login`、`settings`，见 `models/constants/permission-templates.const.ts:47-51`
- admin 账号直接返回全量权限列表，不查库里的数组，见 `user-db.service.ts:166`
- 路由权限 = 类级权限与处理器级权限的并集，见 `managers/auth/guards/main.guard.ts:85-115`
- 未声明权限的处理器默认拒绝，见 `main.guard.ts:94-100`
- 新增用户默认零权限，采用默认拒绝策略，见 `user-db.service.ts:43-57`、`shared/src/entities/user.entity.ts:6-12`
- 写权限时会过滤隐式权限，避免显示与实际不一致，见 `user-db.service.ts:117-121`
- 权限列表与展示模板由 `GET /api/user/special` 提供给前端，见 `routes/api/user/user-manage.controller.ts:119-130`

权限模板：

| 模板 | 内容 | 证据 |
|---|---|---|
| Guest | image-view、image-delete-key | `permission-templates.const.ts:16-20` |
| User | Guest 全部 + image-manage + image-upload | `:22-27` |
| Admin | 全部权限 | `:29-37` |
| Demo 模式 Guest | Guest 再加 image-upload | `:53-64` |

### 六、请求上下文中的用户与权限

- guard 校验通过后把 `user` 与 `userPermissions` 写回请求对象，见 `main.guard.ts:77-78`
- 控制器用 `@ReqUser()` 取完整用户，用 `@ReqUserID()` 取 id，见 `decorators/request-user.decorator.ts`
- 用 `@HasPermission(Permission.X)` 在处理器内做条件分支，示例见 `routes/image/image-manage.controller.ts:65, 98, 117, 136, 153`
- 请求上下文类型定义在 `models/interfaces/authrequest.dto.ts`

### 七、角色系统的历史与现状

- 角色系统已移除：权限从角色迁到用户，`e_role_backend` 表与 `user.roles` 列冻结保留用于回滚，见 `migrations/1792281600000-AddUserPermissions.ts:3-14`、`database/entities/users/user.entity.ts:30-40`
- 历史角色权限字符串清理迁移见 `migrations/1792195200000-RemoveApikeyPermissionFromRoles.ts`、`migrations/1792368000000-RemoveRoleAdminPermission.ts`
- 代码里已无角色判断逻辑，`roles` 只在创建时写空数组，见 `user-db.service.ts:68-70`
- 前端旧称 Admin 的权限位已删除，见 `migrations/1792368000000-RemoveRoleAdminPermission.ts:3-14`

### 八、与鉴权相关的其它行为

- 未登录访问图片走 guest 权限；guest 默认有 image-view，所以图床公开可看，见 `permission-templates.const.ts:16-20`
- 演示模式下 guest 可上传，见 `permission-templates.const.ts:53-64`、`managers/demo/demo.service.ts:1-26`
- 删除图片的两种路径：登录用户走 `image-manage`，匿名持有删除密钥走 `image-delete-key`，见 `routes/image/image-manage.controller.ts:147-194`
- 上传时是否返回删除密钥取决于调用者是否有 `image-delete-key`，见 `image-manage.controller.ts:65, 80-89`
- 系统升级端点要求 `syspref-admin`，可触发容器重建，属最高危权限，见 `routes/api/system/system-update.controller.ts:39-41`、`managers/update/self-update.service.ts:290-311`

## Caveats / Not Found

- 没有找到 token 吊销或密码修改后失效的实现，若 Rust 版需要增强，属于行为变更而非等价迁移。
- JWT 算法未显式声明，实际使用库默认值；Rust 实现需要固定算法并保留旧 token 可验证性，建议在迁移方案里明确 HS256。
- `bcrypt-ts` 的 `$2a$` 前缀来自依赖实现而非仓库代码；仓库只锁定版本 5.0.2，见 `backend/package.json:38`。
- 没有多因素认证、OAuth、LDAP 等外部身份源。
- `roles` 列与 `e_role_backend` 仍被写入和保留，Rust 实现应继续兼容这两处遗留数据，见 `user-db.service.ts:68-70`。

## Related Specs

- `.trellis/spec/picsur-backend/backend/error-handling.md`
- `.trellis/spec/picsur-backend/backend/logging-guidelines.md`
- `.trellis/spec/picsur-backend/backend/image-api-contracts.md`
