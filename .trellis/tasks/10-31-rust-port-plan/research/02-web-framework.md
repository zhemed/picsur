# Research: Rust Web 框架与 HTTP 层选型

- Query: Picsur 后端从 NestJS 12 + Fastify 5 迁到 Rust，Web 框架、运行时、中间件、错误处理与 JSON 契约怎么选
- Scope: mixed —— 仓库事实取自 `/root/picsur` 源码与 `.trellis/spec`，外部资料取自 crates.io 公开元数据与官方文档
- Date: 2026-10-31

## Findings

### Files Found

| File Path | Description |
|---|---|
| `backend/src/main.ts` | Fastify 适配器、trustProxy、multipart/helmet/reply-from 插件、全局 filter/interceptor/pipe/guard |
| `backend/src/app.module.ts` | 两套 CORS、图片缓存头、SPA 静态托管、ScheduleModule、Node 版本检查 |
| `backend/src/layers/exception/exception.filter.ts` | 统一错误信封，Failure → HTTP 状态码映射 |
| `backend/src/layers/success/success.interceptor.ts` | 统一成功信封，响应体回验 zod schema，`timeMs` 取值 |
| `backend/src/layers/validate/zod-validator.pipe.ts` | 全局 zod 校验管道，失败抛 `usrvalidation` |
| `backend/src/layers/throttler/PicsurThrottler.guard.ts` | 全局限流守卫，超限抛 `ratelimit` |
| `backend/src/decorators/easy-throttle.decorator.ts` | 每路由限流，秒 → 毫秒换算 |
| `backend/src/decorators/permissions.decorator.ts` | `RequiredPermissions` / `NoPermissions` / `HasPermission` / `UseLocalAuth` |
| `backend/src/decorators/image-id/image-full-id.pipe.ts` | `/i/:id.:ext` 解析与 400 语义 |
| `backend/src/security.ts` | Helmet/CSP 全量选项 |
| `backend/src/managers/auth/guards/main.guard.ts` | JWT 与 guest 双策略回退、权限并集判定 |
| `backend/src/routes/**/*.controller.ts` | 14 个 handler 的路由表、权限与限流参数 |
| `backend/src/config/early/host.config.service.ts` | 端口/主机/生产模式/演示模式等 env 解析 |
| `backend/src/config/early/serve-static.config.service.ts` | SPA 静态目录与 `fallthrough` |
| `backend/src/routes/api/usage/usage.controller.ts` | `/api/usage/report` 反向代理到外部统计端点 |
| `shared/src/dto/api/api.dto.ts` | 响应信封 zod schema |
| `shared/src/types/failable.ts` | Failure 类型枚举 FT 与状态码表 |
| `.trellis/spec/picsur-backend/backend/image-api-contracts.md` | 实测 HTTP 契约，端口径权威 |

### Code Patterns

一、现有 HTTP 栈事实

1. 框架与运行时：NestJS 12 跑在 Fastify 5.12.6 上，单进程单事件循环，无 cluster。`backend/src/main.ts:24-45` 建 `FastifyAdapter`，`trustProxy` 信任 `127.0.0.0/8`、`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16` 四段；随后注册 multipart、helmet、reply-from 三个 Fastify 插件。
2. 全局分层：`main.ts:51-55` 依次挂 `MainExceptionFilter`、`SuccessInterceptor`、`ZodValidationPipe`、`PicsurThrottlerGuard`、`MainAuthGuard`。守卫顺序是限流先于鉴权。
3. 中间件：`backend/src/app.module.ts:91-94` 用路径通配 `{*path}` 挂两套 CORS：主站用 `cors({ origin: '<origin>' })`，图片路径 `/i/{*path}` 用 `origin: '*'` 并额外注入 `Cross-Origin-Resource-Policy: cross-origin` 与 `Cache-Control: max-age=2592000`。注意主站那条的 origin 是字面量占位串，见本文件末尾待确认项。
4. 路由表共 6 个 controller 模块：`/api/info`、`/api/user`、`/api/user` 管理段、`/api/image`、`/api/pref/sys`、`/api/pref/usr`、`/api/usage`、`/api/system/update`、`/i`。控制器清单见 `backend/src/routes/api/api.module.ts` 与 `backend/src/routes/image/image.module.ts`；逐条请求/响应字段的现状清单由 `research/01-api-inventory.md` 承担，本文件不重复。
5. 成功信封：`backend/src/layers/success/success.interceptor.ts:101-117` 生成 `{success:true, statusCode, timestamp, timeMs, data}`；`timestamp` 是 `new Date().toISOString()`，毫秒精度加 `Z`；`timeMs` 是 `Math.round(response.elapsedTime)`。该 interceptor 还会用 handler 上 `@Returns` 声明的 zod schema 校验**自己的响应**，不合规直接抛 `internal`，见 `success.interceptor.ts:66-99`。
6. 错误信封：`exception.filter.ts:51-69` 生成 `{success:false, statusCode, timestamp, timeMs, data:{type, message}}`，并强制 `Cache-Control: no-store`。FT 到状态码的映射表在 `shared/src/types/failable.ts:37-118`：`usrvalidation` 400、`payloadtoolarge` 413、`permission` 403、`authentication` 401、`ratelimit` 429、`notfound` 与 `routenotfound` 404、`conflict` 409、`impossible` 422、其余 500。Nest 内置异常在 `exception.filter.ts:72-86` 折算成 `permission`、`routenotfound`、`internal`。
7. 全部 POST 成功返回 201：Nest 对 `@Post` 默认 201，见 `.trellis/spec/picsur-backend/backend/image-api-contracts.md` §3.6。Rust 侧必须按路由逐个固定状态码，不能一律 200。
8. 校验语义：全局 `ZodValidationPipe` 在 `metadata.metatype.zodSchema` 存在时 `safeParse`，失败抛 `usrvalidation` 且 message 固定 `Invalid data`，见 `zod-validator.pipe.ts:30-43`。查询参数用 `z.preprocess` 把字符串转数字/布尔，见 `shared/src/dto/api/image.dto.ts:8-24`；`ParseInt` 会对数字四舍五入，`ParseBool` 只认 `true/1/yes` 与 `false/0/no`，见 `shared/src/util/parse-simple.ts:1-50`。
9. 鉴权用途与限流：`main.guard.ts:28-83` 先 `['jwt','guest']` 双策略取用户，再取路由权限并集，最后与用户权限比较。路由级权限声明在 handler 上；`NoPermissions()` 是空数组，等价于只要求通过 guest 回退。限流全局 60 次每 60 秒，见 `backend/src/layers/PicsurLayers.module.ts:10-19`；路由级用 `EasyThrottle` 传秒，见 `easy-throttle.decorator.ts:12-21`，例如上传 20 次每 60 秒、登录 30 次每 300 秒、图片路由 600 次每 60 秒。
10. 安全头：`backend/src/security.ts:3-41` 关闭 helmet 默认值后逐项打开，CSP 为 `default-src 'self'` 加 `script-src 'self' 'unsafe-inline'` 等；SVG 响应额外加 `sandbox; default-src 'none'; ...`，见 `backend/src/routes/image/image.controller.ts:30-40`。
11. 静态托管：`serve-static.config.service.ts:17-47` 默认目录 `<PackageRoot>/../frontend/dist`，`fallthrough: true` 让未匹配路由回前端 `index.html`。SPA 深链必须 200 text/html，见 `.trellis/spec/picsur-backend/backend/build-and-deploy.md` §6。
12. 唯一出站代理：`/api/usage/report` 用 Fastify reply-from 转发到管理员配置的统计端点，只转发 `content-type`/`accept`/`user-agent` 三个头并用连接 IP 覆盖 `X-Forwarded-For`，见 `usage.controller.ts:26-83`。
13. 进程内定时任务：`ScheduleModule` 加 `UsageManagerModule` 的 `setInterval` 每小时触发一次用量上报，见 `backend/src/managers/usage/usage.module.ts:24-38`；demo 清理与派生图清理也由模块初始化触发。多实例部署时这些任务会重复执行。

二、候选框架对比

| 候选 | 当前稳定版 | 运行时 | 中间件模型 | 与本项目的贴合度 | 主要代价 |
|---|---|---|---|---|---|
| axum | 0.8.9，2026-04-14 | tokio 1.54.1 | tower 层，`Layer` 与 `Service` | 高：extractor 接近 Nest pipe，`tower-http` 可一一对位 filter/interceptor/guard | 无内置 multipart 之外的便利，需自己拼审计与限流层 |
| actix-web | 4.18.1，2026-10-23 | actix-rt | `Transform` 与 `Service` | 中：路由与提取器够用，但中间件生态与 tower 不互通 | 引入第二套运行时抽象，静态文件/限流要另学一套 |
| poem | 待确认，未取版本 | tokio | tower 兼容 | 中：API 更接近 Fastify 风格 | 社区与文档体量小于 axum |
| warp | 0.3 线维护放缓 | tokio | filter 组合 | 低：错误处理与提取器组合写法与现有分层差异大 | 可维护性风险 |
| rocket | 0.5 线 | tokio | fairing | 低：配置与请求生命周期模型不同 | 团队迁移成本高 |

结论：推荐 axum 0.8.9 加 tokio 1.54.1 加 tower-http 0.7.1 加 tracing。理由是三层结构能一比一映射现有 Nest 分层：`MainExceptionFilter` → 自定义 `IntoResponse` 错误类型；`SuccessInterceptor` → 响应包装中间件或 handler 返回类型；`ZodValidationPipe` → extractor 内显式校验；两个 guard → tower 层加 handler 内权限检查。actix-web 的裸吞吐通常略高，但本项目是单机单副本、请求量以缩略图读取为主，功能对位成本高于性能收益。

三、运行时与进程模型

1. tokio 多线程运行时即可覆盖 HTTP 并发；图片转码属于阻塞 CPU 活，必须走 `spawn_blocking` 或独立进程，不能占用 async worker 线程，对照现状是 Node 侧 fork 子进程，见 `.trellis/spec/picsur-backend/backend/upload-concurrency.md` §3.1。
2. 硬内存上限要注意：现状靠子进程 `setrlimit('data')` 限制 512MB，见 `backend/src/workers/sharp/sharp.worker.ts:49-56`。`setrlimit` 在 Rust 里同样是进程级，线程级隔离做不到，所以要么保留「独立 worker 进程」模型，要么接受 cgroup 级限制。这条对图片链路选型有决定性影响，细节写在 `02-image-processing.md`。
3. 优雅停机：容器里 tini 是 PID 1，`SIGTERM` 先停应用，见 `.trellis/spec/picsur-backend/backend/build-and-deploy.md` §12。Rust 侧要 `tokio::signal::ctrl_c` 与 `unix::signal(SignalKind::terminate())`，在退出前收尾在途请求与 worker 子进程。
4. 日志：现状 `PicsurLoggerService` 在生产且非 verbose 时只保留 error/warn/log，见 `backend/src/logger/logger.service.ts:5-12`。Rust 用 `tracing` 加 `tracing-subscriber` 的 `EnvFilter` 复刻同样阈值，并保留 `SanitizeLogValue` 的截断与转义语义，见 `backend/src/util/redact.ts`。
5. 配置：`PICSUR_` 前缀，`ParseBool` 认 `true/1/yes` 与 `false/0/no`，`ParseInt` 对数字四舍五入，缺省值散落在各 config service。推荐手写一个 `Config` 结构体集中解析，不用 figment 之类框架，因为语义细节多、需要逐项对齐；关键项见 `.trellis/spec/picsur-backend/backend/build-and-deploy.md` §3.1。

四、错误处理与响应层

1. 错误类型用 `thiserror` 定义，内部持有 FT 等价枚举与可选 debug 信息；对外只序列化 `type` 与 `message`，与 `Failure.getReason()` 的口径一致。`Failure` 对 `Error` 实例会自动隐藏具体信息只给默认文案，见 `shared/src/types/failable.ts:207-269`，Rust 侧要保留「内部错误不外泄原因」这条规则。
2. 状态码映射写成 `From<AppError> for StatusCode` 的单点表，测试覆盖每个 FT 值。
3. `timeMs` 需要从请求进入时刻计时。Fastify 的 `elapsedTime` 是框架注入的浮点毫秒；axum 下用一个最外层中间件把 `Instant` 放进请求扩展，响应构造时读取并 `round`。
4. `timestamp` 格式必须是 `YYYY-MM-DDTHH:MM:SS.mmmZ`，用 `chrono::Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)`。
5. `Cache-Control` 与 CORS 属于响应头契约，必须逐路由断言，见 `image-api-contracts.md` §3.7。错误响应强制 `no-store`，图片存在时保留 `max-age=2592000`。
6. 404 占位图：`/i/<不存在 id>.<ext>` 返回 404 加品牌占位图字节加 `no-store`，见 `image.controller.ts:123-150`。这是「状态码、缓存头、正文」三者绑定的契约。

五、JSON 契约与 OpenAPI

1. 事实上的契约来源是 `shared/src/**` 里的 zod schema 加 `.trellis/spec` 里的实测断言，不是任何 OpenAPI 文档。前端用同一份 zod schema 校验响应，见 `frontend/src/app/services/api/api.service.ts:152-196`。
2. 推荐把「契约测试」当第一优先级：用现有 http 快照与回归脚本做差分，OpenAPI 只作为副产品。生成文档用 utoipa 6.0.0 的 `axum_extras` 或 schemars 1.2.3 导出 JSON Schema；可行路径是先用 `zod-to-json-schema` 从 shared 导出 schema，再用 typify 之类的生成器产出 Rust 结构体草稿，但生成质量待确认，首版建议手写 serde 结构体加 golden 测试。
3. 请求校验推荐显式手写 newtype 校验函数，不用 `validator` 或 `garde` 的 derive 魔法，因为 zod 的 `preprocess`、`partial`、`uuid v1-5 大小写`、`IsStringList` 等语义是自定义的，见 `shared/src/validators/*.ts`。手写约 10 个校验器即可，且能逐条对照。

## Decision

### 推荐方案：axum 0.8.9 + tokio 1.54.1 + tower-http 0.7.1 + tracing

- 理由：tower 层能一对一承接现有的 filter、interceptor、guard、CORS、缓存头、限流；route handler 数量只有 14 个，迁移面可控；tokio 生态与后续 sqlx、reqwest、bollard 全部同栈。
- 替代方案：actix-web 4.18.1。代价是引入 actix-rt 与独立中间件体系，团队要维护两套心智模型；收益是极限吞吐略高，但单机单副本场景用不上。
- 代价：tower 的 `Layer` 与 `Service` 组合需要先写一层薄封装，否则每个中间件都要处理泛型噪音；大约多 1 到 2 天基础设施搭建。
- 验证方式：先用一个骨架服务实现 `/api/info` 加静态托管，跑通 SPA 深链 200 text/html；再把现有 `support/regression-image-api.sh` 的 34 项断言改为对 Rust 实例执行，观察通过率。

### 推荐方案：手写错误类型与统一响应包装

- 理由：信封字段顺序、精度、状态码、缓存头都有实测契约，用现成 crate 反而要贴补丁。
- 替代方案：`axum-error` 类库或 `problem+json`。本项目不使用 RFC 7807，改动会破坏前端解析，见 `api.service.ts:69-75`。
- 代价：需要约 300 行错误与响应基础设施，外加每个 FT 值的测试。
- 验证方式：对每个 FT 值构造触发条件，断言 HTTP 状态码、`data.type` 字符串、`Cache-Control` 三项同时正确。

### 推荐方案：契约测试优先，OpenAPI 后置

- 理由：前端已用 zod 校验响应，任何字段漂移立即表现为 `sysvalidation` 错误；文档不承担校验职责。
- 替代方案：utoipa 作为主契约并生成前端类型。代价是要额外维护一套 zod 到 OpenAPI 的桥，且现有前端 DTO 仍要走 shared，短期是双份维护。
- 代价：首版不产出 OpenAPI，对外文档仍以 spec 为准。
- 验证方式：golden 快照覆盖 14 个 handler 的成功与主要失败分支；差分测试的字段差异计数必须为 0。

## Caveats / Not Found

1. 待确认：`app.module.ts:25-27` 的主站 CORS 写作 `origin: '<origin>'`，字面量看起来像占位符未替换。若真按字面量生效，跨源主站请求会被拒。验证方法：起实例用 `curl -H 'Origin: http://localhost:8080'` 与 `-H 'Origin: <origin>'` 各发一次，比对 `Access-Control-Allow-Origin`。
2. 待确认：Fastify `response.elapsedTime` 的起算点与精度。验证方法：连续压测 1000 次记录 `timeMs` 分布，与 Rust 侧计时实现对比，允许 ±1ms 抖动，不允许系统性偏差。
3. 待确认：`serve-static` 对 `api` 前缀与 `/i` 前缀的排除细节，即哪些未匹配路径会落到 SPA fallback。验证方法：枚举 `/api/unknown`、`/i/unknown`、`/some/deep/link` 三类路径，对比 Rust 实现的状态码与 Content-Type。
4. 待确认：multipart 的 busboy 语义与 multer 语义差异，特别是 `fieldNameSize`、`fields`、`files` 上限与超限时的状态码，见 `backend/src/config/early/multipart.config.service.ts:21-29`。验证方法：构造超限请求，对比 Node 与 Rust 的 HTTP 状态与错误 type。
5. 未找到：仓库内没有 OpenAPI 文件、没有 GraphQL、没有 WebSocket 端点，因此无需为这些设计迁移方案。
6. 未找到：仓库内没有 OnlyOffice 或插件系统集成。任务描述里的插件风险在现状代码里不存在，最接近的是 docker socket 自升级子系统，见 `02-risks.md`。
