# 技术设计：Picsur 全栈迁移到 Rust

## 1. 设计原则

1. **契约优先**：`research/01-*` 与 `support/regression-image-api.sh` 固化的行为是唯一判据，任何实现差异以差分结果为准。
2. **存量兼容优先于设计洁癖**：复用现有 Postgres schema、`/data` 布局与 JWT 格式；迁移期新旧实现双向互认。
3. **写路径单一属主**：同一时刻只有一个实现拥有某类写权限与启动副作用，避免双写与竞态。
4. **失败可回滚**：每个阶段通过环境变量翻转即回滚，回滚不涉及数据库。
5. **能力不缩水**：HEIF、JXL、JP2、AVIF、动图 WebP、SVG 能力必须与现网一致。
6. **最终态不依赖 Node**：自升级子系统在过渡期可由 Node 侧车暂代，但退役前必须由 Rust 重写或经用户明确决定放弃。

> 说明：`research/02-frontend.md` 的结论是「保留 Angular 前端」，该结论已被用户决策覆盖；前端按 `research/02-frontend-rust.md` 的全栈 Rust 方案设计。

## 2. 目标架构

### 2.1 Cargo workspace 与 crate 划分

| crate | 职责 | 关键依赖 | 首建阶段 |
|---|---|---|---|
| `picsur-contracts` | 请求/响应结构体、信封、错误类型、权限枚举、i18n 词典、校验函数；前后端共用，wasm 可编译 | serde、serde_json、thiserror、include_str 词典 | 子任务 02 |
| `picsur-db` | sqlx 连接池、查询、迁移账本与基线引导、定时清理任务 | sqlx 0.9、chrono、uuid | 子任务 02 |
| `picsur-auth` | JWT 与 bcrypt、用户加载、权限矩阵、guest 回退 | jsonwebtoken 11、bcrypt 0.19 | 子任务 03 |
| `picsur-image` | 图片嗅探、主文件策略、转换参数到 vips 操作的映射、SVG 净化、缓存键 | rs-vips 0.7、qoi 0.4、svg-hush 0.9 | 子任务 04 |
| `picsur-imgworker` | 独立可执行文件，被父进程拉起做转码，`setrlimit` 限内存 | 上述图片依赖、serde_json | 子任务 05 |
| `picsur-server` | axum 路由、中间件、静态托管、前门反代、启动与关停 | axum 0.8、tower-http 0.7、tokio、tracing | 子任务 02 |
| `picsur-frontend` | Leptos CSR wasm 应用 | leptos 0.8、leptos_router、gloo-net、web-sys、qoi | 子任务 07 |
| `picsur-testkit` | 差分工具、契约快照、夹具生成、回归脚本胶水 | reqwest、serde_json、image | 子任务 01 |

### 2.2 运行期拓扑

```
浏览器 ── 8080 ──> picsur-server（Rust 前门）
                     ├── /api/* 与 /i/*：Rust handler（归属由 PICSUR_RUST_ROUTES 控制）
                     ├── 未归属前缀：反代到 127.0.0.1:8081（Node 过渡实例）
                     └── 静态资源：frontend dist（Rust 前端产物）
                                  │
                     ┌────────────┴────────────┐
                     │ Postgres（共享，单一写属主） │
                     └─────────────────────────┘
                     picsur-imgworker 子进程池（min(4, CPU 核数)，setrlimit 限内存）
```

### 2.3 迁移期灰度形态

- Rust 监听 `PICSUR_PORT`（默认 8080）作为唯一入口；Node 以 `PICSUR_PORT=8081` 起在 loopback，仅前门可达。
- 归属开关 `PICSUR_RUST_ROUTES` 形如 `info,image-read,user`，未命中的前缀与前缀内未实现的 handler 一律回落到 Node。
- 反代逐跳复制方法、路径、查询串、请求体；请求头白名单为 `authorization`、`content-type`、`accept`、`user-agent`、`cookie`、`if-none-match`、`if-modified-since`、`range`。
- 客户端 IP 语义：沿用 `trustProxy` 的可信网段 `127.0.0.0/8`、`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`；反代时用真实连接 IP 覆盖 `X-Forwarded-For`，并把 Host 头原样传给 Node，避免限流桶与分享链接域名失真。
- 响应复制状态码、全部响应头与正文；不改写 30 天缓存头与 `no-store`。
- 回滚 = 把前缀从开关移除并重载配置；不需要回滚数据库。

## 3. 后端 HTTP 层

### 3.1 Nest/Fastify 到 axum/tower 的映射

| 现有机制 | 证据 | Rust 对位 |
|---|---|---|
| `MainExceptionFilter` | `backend/src/layers/exception/exception.filter.ts` | `AppError` 实现 `IntoResponse`，单点状态码映射 |
| `SuccessInterceptor` | `success.interceptor.ts` | 响应包装中间件：记录 `Instant`，统一信封 |
| `ZodValidationPipe` | `zod-validator.pipe.ts` | `picsur-contracts` 校验函数，在 extractor 内调用，失败返回 `usrvalidation` |
| `PicsurThrottlerGuard` | `layers/throttler/PicsurThrottler.guard.ts` | tower 层加每路由固定窗口计数，超限返回 429 |
| `MainAuthGuard` | `managers/auth/guards/main.guard.ts` | 最外层中间件解析 Bearer 并加载用户，handler 声明权限由 extractor 校验 |
| CORS 两套 | `app.module.ts:25-58` | `tower-http::cors` 两套 layer，按路径分流 |
| Helmet | `backend/src/security.ts` | 显式响应头中间件，逐项对齐 `security.ts` |
| multipart | `@fastify/multipart` | `axum::extract::Multipart`，字段名 `image`、files=1、体积上限一致 |
| 静态托管 | `serve-static.config.service.ts` | `tower-http::services::ServeDir` 加 SPA 回落 |

### 3.2 信封与错误

- 成功：`{success:true, statusCode, timestamp, timeMs, data}`；`timestamp` 用 `to_rfc3339_opts(Millis, true)`，`timeMs` 为 `Instant` 差值四舍五入。
- 失败：`{success:false, statusCode, timestamp, timeMs, data:{type, message}}`，强制 `Cache-Control: no-store`。
- `FT` 枚举与状态码单点映射，覆盖 permission 403、authentication 401、usrvalidation 400、ratelimit 429、notfound 404、conflict 409、impossible 422、payloadtoolarge 413。
- 内部错误只输出默认文案，不透传内部细节与原始 `Display`。
- POST 成功状态码逐路由固定为 201，不用 axum 默认 200。

### 3.3 限流

- 全局 60 次每 60 秒；登录 30 次每 300 秒；注册 5 次每 300 秒；上传 20 次；图片读取 600 次每 60 秒；其余按现状逐路由声明。
- 超限返回 429；是否携带 `Retry-After` 以基线实测的 Node 行为为准，过渡期不得自行新增该头。

### 3.4 鉴权与密码

- JWT：`jsonwebtoken` 11 加 `rust_crypto` 后端，HS256，payload 与 `JwtDataSchema` 对齐，只含 uid；`exp` 语义来自 `jwt_expires_in` 偏好。
- 密码：`bcrypt` 0.19 校验 `$2a$` / `$2b$` / `$2y$`，强度取数据库 `bcrypt_strength`；超过 72 字节的行为以基线实测为准，不得与 Node 不一致。
- guest 回退：无 token 或 token 无效时加载 guest 账号，不直接 401。
- 权限：11 个权限字符串；类级与处理器级取并集；未声明权限的 handler 直接拒绝。
- `jwt_secret`：以数据库值为准，Rust 只读不回写；env 仅在库内缺失时一次性落库，启动日志打印来源不打印值。这条是为了避免过渡期两侧 env 不一致导致全员会话失效。

## 4. 数据层

### 4.1 访问层

- sqlx 0.9，运行期查询加 `query!` 宏，CI 用 `cargo sqlx prepare --check`；连接池上限 10，与现状 pg 默认对齐。
- 不引入 ORM 实体层；bytea 与 `text[]` 用原生 SQL，避免抽象泄漏。
- 结构口径：7 个实体、9 张物理表；`e_role_backend` 与 `e_api_key_backend` 为遗留表，不删不改，保留供回滚到 Node。

### 4.2 迁移账本兼容

- 现有 12 条迁移的 SQL 原样搬为 `migrations/<原时间戳>_<name>.sql`，编号沿用，不再发明新编号。
- 新实例：空库顺序执行 12 条，schema 与现网 `pg_dump` 一致。
- 存量实例：先做基线引导，读取 TypeORM `migrations` 表，把已应用记录写入 `_sqlx_migrations` 并补校验和；随后只执行新迁移。
- 启动自检：基线完整性校验失败则显式报错退出，不静默继续。
- 过渡期任何 schema 变更必须同时提供 TypeORM 迁移与 Rust SQL，保证回滚到 Node 后仍可运行。
- `uuid-ossp` 扩展由显式迁移保证，不依赖应用自动建。

### 4.3 读写纪律与启动副作用

- 图片写入、用户写入、偏好写入在任一时刻只有一个属主；切换点由归属开关决定。
- 五项启动副作用必须单属主：图片清理与派生图 LRU（每 60 秒）、过期图片清理（每 60 秒）、demo 模式清空（按 `PICSUR_DEMO_INTERVAL`，默认 300 秒）、admin 与 guest 种子、迁移执行。
- 单属主开关为 `PICSUR_JOB_OWNER=node|rust`，两侧启动时读取；默认在过渡期指向 Node，随阶段推进切换。
- `e_user_backend.roles` 无默认值，插入用户必须显式写 `'{}'`。
- 分页语义照搬：count 上限 100、page 从 0 起、`pages=ceil(total/count)`；`list/all` 默认 100、上限 1000；批量删除上限 500。

## 5. 图片管线

### 5.1 引擎分工

- libvips（rs-vips 0.7 封装）负责 HEIF、JXL、JP2、AVIF、TIFF、JPEG、PNG、BMP、动图 WebP 的解码、缩放、旋转、翻转、色彩与编码，沿用镜像内自编译 libvips 8.18.7。
- QOI 用 `qoi` 0.4.1 纯 Rust 编解码，raw 通过 libvips memory source 进入同一管线。
- SVG 用 svg-hush 0.9 基础清洗，再补一层与 `AllowedSvgHref` 等价的 href 白名单；响应仍加 CSP 与 nosniff。
- 首版不引入 EXIF 库，不自动定向，保持与现网像素一致。

### 5.2 worker 隔离

- `picsur-imgworker` 为独立可执行文件，父进程池上限 `min(4, CPU 核数)`，空闲 60 秒回收。
- 子进程启动时用 `setrlimit(RLIMIT_DATA)` 施加内存上限，值来自系统偏好 `conversion_memory_limit`，默认 512MB。
- 单次转换超时来自 `conversion_time_limit`，默认 15s；超时或失败销毁 worker 不重用。
- 主进程先做像素上限预检，worker 端再兜底一次，区分用户输入问题与内部错误。

### 5.3 主文件与转换参数

- 策略与现网一致：静图转 QOI、动图转 animated WebP、SVG 清洗后原样；`keep_original` 时另存 original。
- 参数映射：width 与 height 齐全时 fill、只给一个时 inside，两个分支的 `withoutEnlargement` 均取 `shrinkonly`；rotate 背景透明；flipx→flop；flipy→flip；noalpha→removeAlpha；negative→negate；greyscale；quality 控制编码质量。
- `allow_editing` 关闭时忽略全部参数；SVG 目标只允许从 SVG master 出且不允许编辑参数。

### 5.4 派生图缓存键

- 键为 `sha256(JSON.stringify({mime, ...options}))`；其中 mime 字段实际是 FileType 标识串，示例 `image:png`，不是 HTTP MIME。
- 字段顺序固定为 mime、height、width、rotate、flipx、flipy、greyscale、noalpha、negative、shrinkonly、quality，来源是 `shared/src/dto/api/image.dto.ts` 的 zod 字段顺序。
- `JSON.stringify` 会省略未提供的字段，因此字段集合是「请求里出现的参数」，不是固定全集；序列化顺序必须与 Node 一致。
- 键始终取请求的原始转换参数；即使 `allow_editing` 关闭导致实际转换忽略参数，键也不变。
- 达到每图派生图上限时仍返回转换结果但不落库，与现状一致。
- 用独立纯函数生成，两侧 key 列表逐字节 diff 为 0 作为契约测试。

### 5.5 限值

| 限值 | 默认 | 来源 |
|---|---|---|
| 上传体积 | 128000000 字节 | `PICSUR_MAX_FILE_SIZE` |
| 像素上限 | 268402689，0 表示不限 | `PICSUR_MAX_IMAGE_PIXELS` |
| 每图派生图 | 100，0 表示不限 | `PICSUR_MAX_DERIVATIVES_PER_IMAGE` |
| 转换内存 | 512MB | 系统偏好 |
| 转换超时 | 15s | 系统偏好 |

## 6. 前端

### 6.1 技术栈

- Leptos 0.8 线，CSR，不用 SSR：现有鉴权是 localStorage token 加 Bearer 头，SSR 会迫使改成 cookie 会话，与无缝升级冲突。
- 构建用 trunk 0.22.1，产物 `dist/index.html`、`dist/*.js`、`dist/*.wasm`、`dist/assets/**`；后端静态层必须给 `.wasm` 返回 `application/wasm`。
- 路由表逐条照搬：七个页面域 upload、processing、view/:id、images/:page、user/login、user/register、settings 及其子路由、四个 error 页；默认重定向 `/`→`/upload`、`/images`→`/images/1`、`/settings`→`/settings/general`，未知路径跳 404；权限守卫失败跳 401。

### 6.2 UI 复刻

- 手写 `picsur-ui` 组件库，不引入 @material/web 与 leptos-material：现有界面是 M2 主题，M3 组件会直接导致探针与截图比对失败。
- 先把现有 SCSS 里的调色板、排版、间距、圆角、阴影、断点抽成 CSS 自定义属性层；现状共 36 个 scss 文件，其中 `frontend/src/scss` 11 个、组件级 24 个、`styles.scss` 1 个。
- 高风险组件顺序：FormField、Select、Dialog、Paginator、Table，其次 Snackbar、Menu、Chip、Sidenav、Progress。
- 自写组件 masonry、picsur-img、speed-dial、copy-field、values-picker、infinite-select、pref-option 逐个移植。

### 6.3 i18n 与契约

- `include_str!` 编入 `en.json` 与 `zh.json`，保持「找不到返回 key」「`{{ }}` 插值」「默认 zh」「`localStorage['picsur.language']`」四条语义。
- 相对时间用 `Intl.RelativeTimeFormat`，与 moment 文案差异逐条对齐。
- 前后端共用 `picsur-contracts` 的 serde 结构体；前端不做响应 zod 复刻，改为反序列化到同一结构体。
- 图片展示：HEAD 探测后，QOI 用 wasm 内 `qoi` 解码到 canvas，其他格式走 Blob 加 `<img>`；对象 URL 生命周期与现网一致。

## 7. 迁移与切换

本表是灰度切换与能力归属顺序；执行顺序、依赖与工作量以 `implement.md` 第 2 节为准，同一能力在两张表里的阶段号可对应但不等值。

| 阶段 | 归属 | 回滚点 |
|---|---|---|
| M0 基线与差分 | 无 | 不涉及 |
| M1 骨架 | `/api/info*` | 停进程 |
| M2 读路径 | `/i/*`、`/i/meta/*` | 前缀移出开关 |
| M3 鉴权与用户读 | `/api/user/login`、`/me`、`/me/permissions`、`/api/user/*` 读 | 同上 |
| M4 图片管理读 | `/api/image/list`、`/api/image/list/all` | 同上 |
| M5 图片写 | `/api/image/upload`、`update`、`delete*`、`delete/key` | 排空后移出开关 |
| M6 偏好与杂项 | `/api/pref/*`、`/api/usage/*`、静态托管 | 同上 |
| M7 前端切换 | 全部页面 | 静态产物回退到 Angular dist |
| M8 自升级 | `/api/system/update/*` | 保留 Node 归属 |
| M9 退役 | 全部 | 旧镜像 tag 加数据备份 |

前端切换是唯一不能按前缀灰度的部分，采用独立入口先灰度：`/v2/*` 提供新前端，观察一周后 302 到根路径；旧前端产物保留到退役阶段。

## 8. 部署与发布

- 构建阶段：Rust 工具链阶段编译后端与 wasm 前端，trunk 产出 dist；Node 阶段在 M9 前仍需，用于旧前端构建与过渡镜像。
- 运行阶段：单个 Rust 二进制加静态资源，all-in-one 仍内嵌 Postgres 17，`/data` 布局、`allinone.env` 生成规则、`tini` PID 1 与健康检查 `/api/info` 不变。
- 自升级：过渡期由 Node 侧车继续提供 `/api/system/update/check` 与 `/apply`，Rust 前门完整转发；M8 阶段用 bollard 重写并接管，退役前必须有明确归属决策与接口归属文档。
- 发布：`release-local.sh` 增加 Rust 镜像；旧镜像 tag 保留一个版本用于回滚。
- 回滚不依赖新版启动时清理的 `-prev-` 容器：上线前必须 `pg_dump` 并记录旧镜像 tag，回滚走常规镜像重建。

## 9. 测试与门禁

| 门 | 命令 | 通过标准 |
|---|---|---|
| 契约差分 | `picsur-testkit` 差分脚本 | 除豁免字段外差异 0 |
| 图片回归 | `bash support/regression-image-api.sh <base> <pwd>` | 基础 34 项、连库 38 项全绿，无损格式像素零差异 |
| 用户回归 | `bash support/regression-user-admin.sh` | 全绿 |
| 数据门 | 迁移前后 9 张表行数与列哈希 | 完全一致 |
| 故障门 | 8 类故障输入 | 状态码与 type 一致，无 500 |
| 性能门 | `node support/bench-upload.cjs` | 不劣于基线 1.2 倍 |
| 依赖门 | `cargo audit`、`cargo deny` | 无 high，许可证清单完整 |
| 前端门 | 两个探针加页面清单 | 低对比数量不高于基线，布局在容差内 |
| 构建门 | `cargo fmt --check`、`cargo clippy -D warnings`、`cargo test` | 全部通过 |

## 10. 关键权衡与替代方案

- **axum 对 actix-web**：选 axum 因 tower 层可一比一承接现有分层；actix 极限吞吐略高但单机单副本用不上。
- **sqlx 对 sea-orm/diesel**：选 sqlx 因 SQL 可见、离线缓存让 CI 无需数据库；sea-orm 开发快但会混合原生 SQL。
- **libvips 对纯 image crate**：必须用 libvips，否则 JXL、JP2、HEIF 能力消失，属于产品能力回退。
- **Leptos 对 Dioxus/Yew**：Leptos 的 signal 心智与 Angular 21 接近；Dioxus 工具链更完整但组件偏 Tailwind；Yew 生态活跃度低。
- **CSR 对 SSR**：CSR 避免改鉴权模型；SSR 首屏收益留作后续独立优化。
- **自升级先侧车后重写**：2000 行状态机与 docker 编排耦合，过渡期保留 Node，M8 用 bollard 接管，避免首轮同时引入最高风险模块。

## 11. 风险与回退矩阵

| 风险 | 缓解 | 回退 |
|---|---|---|
| QOI 字节不兼容导致存量图不可用 | 先做 QOI 读写原型与像素断言 | master 保持 Node 写入，仅 Rust 读 |
| JXL、JP2、HEIF、AVIF 能力回退 | libvips 绑定加逐格式双向转换夹具 | 该格式请求回 Node 处理 |
| 派生图缓存键不一致 | 纯函数加逐字节 diff | 过渡期关闭 Rust 缓存写入，只读 |
| 状态码与响应头漂移 | 差分脚本加头矩阵 | 前缀移出开关 |
| JWT secret 被回写 | Rust 只读 secret | 停 Rust，Node 立即接管 |
| 工具链与 MSRV 冲突 | `rust-toolchain.toml` 钉版本，CI 全量构建 | 回退到上一可用工具链版本 |
| WASM 首屏体积超标 | wasm-opt、代码分割、懒加载 | 保留 Angular 前端作为 `/v2` 前的载体 |
| 自升级子系统冲突 | 单属主，过渡期 Node 侧车，M8 bollard 接管 | 移除 docker socket 挂载，转手动升级 |
| 前端视觉回归 | 先采集 Angular 截图基线再开工 | 新前端仅 `/v2` 灰度，可下线 |
| 回滚窗口不足 | 上线前 `pg_dump`，记录旧镜像 tag | 常规镜像重建，不依赖 `-prev-` 容器 |
