# Research: 前端处置方案

- Query: 迁到 Rust 后 Angular 前端保留还是重写，Rust 如何托管静态资源，代价与风险是什么
- Scope: mixed —— 仓库事实取自 `frontend/**`、`angular.json`、`serve-static.config.service.ts`，外部资料仅做版本核对
- Date: 2026-10-31

## Findings

### Files Found

| File Path | Description |
|---|---|
| `frontend/package.json` | Angular 21.2 全家桶、Material 21、bootstrap、axios、moment、zod、QOI worker 依赖 |
| `frontend/angular.json` | 输出目录 `dist`、index、assets、styles、custom webpack 构建器 |
| `frontend/custom-webpack.config.cjs` | moment locale 裁剪与 babel 规则 |
| `frontend/src/index.html` | base href、PWA manifest、默认语言 zh、无 JS 兜底文案 |
| `frontend/src/app/app.routing.module.ts` | 7 个懒加载路由加 404 兜底 |
| `frontend/src/app/services/api/api.service.ts` | axios 封装、响应 zod 校验、Bearer 注入、进度与取消 |
| `frontend/src/app/services/api/image.service.ts` | 图片 URL 拼装、分享链接生成、上传与列表调用 |
| `frontend/src/app/workers/qoi.worker.ts` 与 `qoi.job.ts` | Web Worker 内解码 QOI |
| `frontend/src/app/i18n/*` | 自研 i18n，en 与 zh 两份词典 |
| `frontend/src/assets/i18n/en.json` 与 `zh.json` | 各 327 行，必须键一一对应 |
| `frontend/src/app/routes/**` | upload、processing、view、user、images、settings、errors 七个页面域 |
| `backend/src/config/early/serve-static.config.service.ts` | 静态目录与 SPA fallthrough |
| `backend/src/app.module.ts` | 静态托管挂载与 CORS 中间件 |
| `.trellis/spec/picsur-frontend/frontend/index.md` | 前端规范与踩坑清单 |

### Code Patterns

一、前端事实

1. 规模：`frontend/src` 下 ts、html、scss 合计约 11986 行，其中七条懒加载路由与大量 Material 组件封装。
2. 技术栈：Angular 21.2 加 Angular Material 21 加 Angular CDK，bootstrap 5.3 只用于少量样式，axios 负责 HTTP，moment 负责日期，fuse.js 做搜索，zone.js 变更检测。
3. 构建：`ng build` 输出到 `frontend/dist`，index 为 `src/index.html`，用了 `@angular-builders/custom-webpack` 加 `custom-webpack.config.cjs` 裁掉 moment 多余 locale。构建必须在 Node 20 下跑，见 `.trellis/spec/picsur-frontend/frontend/index.md` 的 Pre-Development Checklist 第一条。
4. 路由：`upload`、`processing`、`view`、`user`、`images`、`settings`、`error` 七个域全部懒加载，未知路径重定向到 `error/404`，见 `app.routing.module.ts:5-53`。
5. i18n 是自研的，没有使用 ngx-translate：`I18nService.instant` 查两份内置词典，找不到 key 时原样返回，见 `i18n.service.ts:54-68`。默认语言是 zh，存 `localStorage['picsur.language']`。用户可见文案必须走 i18n，见前端 spec 的检查清单。
6. 后端的错误 message 是英文原文，前端 `instant` 找不到 key 时原样显示，因此后端文案本身不可翻译，迁移时不得改写措辞。
7. HTTP 契约依赖：前端用同一份 shared zod schema 校验响应，见 `api.service.ts:152-196`；任何字段漂移会变成 `sysvalidation` 错误而不是静默兼容。
8. 图片 URL 拼装：`GetImageURL` 用 `infoService.getHostname` 加 `/i/<id>.<ext>`，见 `image.service.ts:168-179`；`/api/info` 的 `host_override` 会影响分享链接域名，见 `info.service.ts:111-121`。
9. 图片展示依赖 `HEAD /i/<id>.<ext>` 探测存在性，也依赖 `/i/meta/<id>` 判断图片是否被删，见 `image.service.ts:71-73` 与 `.trellis/spec/picsur-backend/backend/image-api-contracts.md` §3.7。
10. QOI 解码在 Web Worker 内完成，走 axios 取 `.qoi` 字节后本地解码，见 `qoi-worker.service.ts:26-50`。因此 Rust 后端必须继续支持 `/i/<id>.qoi` 输出，即使前端图库缩略图已改成显式 WebP。
11. 静态资源形态：`index.html` 里引用 `/assets/branding/...`、`/assets/app.webmanifest`、`/assets/css/*.css`，`base href` 固定 `/`。没有 service worker 注册，manifest 存在但 PWA 离线能力未落地。
12. 构建产物由后端托管：`serve-static.config.service.ts:17-47` 默认目录是 `backend` 包的上一级 `frontend/dist`，可用 `PICSUR_STATIC_FRONTEND_ROOT` 覆盖；`fallthrough: true` 让未匹配路由回 `index.html`。
13. 前端只消费三个非 API 路径形态：`/i/*` 图片、`/api/*` JSON、其余 SPA 路由。这决定了 Rust 静态托管的路由优先级。

二、候选处置方案

| 方案 | 工作量估计 | 能力保持 | 主要风险 |
|---|---|---|---|
| 保留 Angular，Rust 托管静态产物 | 2 到 4 人日加持续 Node 20 构建 | 完全保持 | 构建链仍依赖 Node 与 pnpm，镜像不是纯 Rust |
| 保留 Angular，Node 只做静态托管侧车 | 3 到 5 人日 | 完全保持 | 多一个常驻进程，失去「一个二进制」的收益 |
| 重写为 Leptos 或 Dioxus 等 Rust 前端 | 数月量级，待确认 | 需要重做 Material 组件、i18n、布局与对比度 | 功能回退与 UI 回归风险极高，收益与迁移目标不匹配 |
| 重写为 SvelteKit 或 Vue 并保留 SSR | 数月量级 | 需要重做全部页面 | 引入新的 Node 运行时，等于换一个技术栈再迁一次 |
| 只重写部分页面到 Rust WASM 组件 | 不确定 | 混合栈，维护成本翻倍 | 收益不明确 |

结论推荐第一种：保留 Angular，Rust 作为静态宿主。理由是把迁移风险集中在后端语义上；前端是纯静态产物，重写不会带来任何服务端收益，却会把验收面从 34 项接口扩大到几十个页面的视觉与交互回归。

三、静态托管契约

Rust 侧要实现的行为清单，逐条都要与 Node 实例对比：

1. `GET /` 返回 `index.html`，`Content-Type: text/html`。
2. 未匹配的非 API 路径返回 `index.html` 且状态码 200，即 SPA 深链，见 `serve-static.config.service.ts:36-45` 的注释与 `.trellis/spec/picsur-backend/backend/build-and-deploy.md` §8.3 第 1 条。
3. `/api/*` 未匹配不得回落到 index.html，应返回 JSON 错误信封，`type` 为 `routenotfound`。
4. `/i/*` 由业务 handler 处理，不能进静态托管。
5. 静态资源按扩展名给 Content-Type；`/assets/*` 是带 hash 或不带 hash 的构建产物，现状没有额外 Cache-Control。
6. 目录穿越防护：`@fastify/static` 自带，Rust 用 `tower-http` 的 `ServeDir` 同样自带，但都要测 `..%2f` 这类请求。
7. 现状没有 gzip 或 brotli 压缩，也没有 ETag 与 Range 之外的缓存策略。Rust 侧首版不要顺手加压缩层，否则响应头差异会污染差分测试。
8. 静态目录不存在时：Node 侧 `serve-static` 会怎样表现需要实测，Rust 侧要给出明确启动告警而不是 500。
9. 前端构建产物路径固定 `frontend/dist`，`PICSUR_STATIC_FRONTEND_ROOT` 可覆盖，两者都要支持。

四、构建与发布影响

1. 保留前端意味着构建流程里仍有 Node 20 与 pnpm 9.6.0 一段，见根 `package.json` 的 `packageManager` 与 `Dockerfile` 的 js_builder 阶段。
2. Rust 镜像可以设计成两段：Node 阶段只产出 `frontend/dist`，Rust 阶段编译二进制并把 dist 拷进镜像。这样运行期是纯 Rust，构建期仍要 Node。
3. 依赖审计口径不变：前端浏览器侧存量告警不算阻断，见 `AGENTS.md` 第 6 条与 `.trellis/spec/picsur-backend/backend/build-and-deploy.md` §8.4。
4. 前端 CI 检查项（lint、type-check、对比度探针、回归脚本）保留，不因后端迁移而删除。

## Decision

### 推荐方案：保留 Angular，Rust 用 tower-http 托管静态并做 SPA 回落

- 做法：`ServeDir` 指向 `PICSUR_STATIC_FRONTEND_ROOT`，默认 `<可执行文件目录>/../frontend/dist`；未命中时 `ServeFile` 返回 `index.html`；路由注册顺序为 `/api/*` 与 `/i/*` 在前，静态兜底在后。
- 理由：前端是纯静态产物，迁移零收益；静态托管只是几十行代码加一组头断言。
- 替代方案：Node 侧车只做静态托管。代价是多一个进程与编排，收益是行为零差异，适合首版过渡期。
- 代价：镜像构建仍依赖 Node 20 与 pnpm；运行期镜像里可以不含 Node，但要在 Dockerfile 里显式分阶段。
- 验证方式：起 Node 与 Rust 两个实例，对同一批路径断言状态码、Content-Type、正文哈希三项一致。路径集至少包含 `/`、`/images`、`/settings/about`、`/assets/...`、`/some/unknown/deep`、`/api/unknown`、`/i/unknown.png`。

### 推荐方案：前端零改动，只加一层构建产物定位

- 做法：不改 Angular 代码；如 Rust 可执行文件与 dist 的相对位置变化，用 `PICSUR_STATIC_FRONTEND_ROOT` 显式指定。
- 理由：任何前端改动都会引入新的验收面，与迁移目标无关。
- 替代方案：顺带升级 Angular 或替换 axios。代价是混入无关变更，回滚粒度变差。
- 代价：无。
- 验证方式：用同一份 `frontend/dist` 分别挂在 Node 与 Rust 后面，跑对比度探针与回归脚本，结果应完全一致。

### 推荐方案：重写前端单独立项，不并入本次迁移

- 理由：重写需要重新实现 Material 组件、i18n、对比度与布局契约，工作量以月计，且与后端迁移正交。
- 替代方案：若目标是「运行时彻底没有 Node」，可以在迁移完成后单独评估 Leptos 或 SvelteKit 方案；届时后端契约已稳定，前端可以独立替换。
- 代价：本次迁移后仍保留 TS 前端。
- 验证方式：立项时以现有页面清单与探针清单作为验收基线。

## Caveats / Not Found

1. 待确认：缺失的静态资源请求当前返回什么。`fallthrough: true` 可能让 `/assets/不存在.js` 也返回 `index.html` 200，这会让前端报语法错误而不是 404。验证方法：对不存在的 js 与 css 发请求，记录状态码与 Content-Type，决定 Rust 侧是复刻还是修正。
2. 待确认：`/api/info` 的 `version` 字段来源。Node 依赖 `npm_package_version`，裸跑会退化成 `0.0.0`，见 `.trellis/spec/picsur-backend/backend/image-api-contracts.md` §3.1。Rust 需要自己的版本注入方式，例如编译期 `CARGO_PKG_VERSION` 或构建参数，并保证与根 `package.json` 同步。
3. 待确认：前端是否有依赖 `Content-Disposition` 的下载路径。`api.service.ts:207-238` 会读该头推断文件名，Node 侧未见显式设置，需确认现状是否为空。
4. 待确认：`host_override` 为空时分享链接用 `location.protocol + location.host`，Rust 侧无需参与，但反向代理若改变 Host 头会影响生成的链接，部署文档要写清。
5. 未找到：没有 SSR、没有 service worker、没有 WebSocket、没有前端路由级别的权限拦截以外的服务端渲染依赖。
6. 未找到：仓库里没有前端单元测试或 e2e 测试框架配置，验收依赖探针脚本与回归脚本，见 `support/visual-contrast-probe.cjs` 与 `support/gallery-layout-probe.cjs`。
