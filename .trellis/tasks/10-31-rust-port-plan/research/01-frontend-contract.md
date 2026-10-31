# Research: 前端与后端契约

- Query: 盘点前端调用的 API、静态资源托管方式、是否存在 SSR 或特殊集成
- Scope: internal
- Date: 2026-10-31
- 证据基线: git master b6bd23c

## Findings

### 一、前端形态

| 项 | 事实 | 证据 |
|---|---|---|
| 框架 | Angular 21，SPA，无 SSR | `frontend/package.json:18-49`、`frontend/angular.json:1-102` |
| 构建器 | `@angular-builders/custom-webpack:browser` | `frontend/angular.json:24` |
| 输出目录 | `frontend/dist`，production 配置默认 | `frontend/angular.json:26, 79` |
| 路由 | 无 hash，全部懒加载模块，未知路由到 error/404 | `frontend/src/app/app.routing.module.ts:5-53` |
| 运行时配置 | 只有 production 布尔值，其它全部来自后端 `/api/info` | `frontend/src/environments/environment.ts:1-5`、`environment.prod.ts:1-5` |
| i18n | 运行时 i18n，en 与 zh 两份词典，模板用 translate 管道 | `frontend/src/app/i18n/`、`frontend/src/assets/i18n/en.json`、`zh.json` |
| 品牌资源 | 构建前从 `branding/` 拷入 `src/assets/branding` | `frontend/package.json:15` |

### 二、静态资源托管

- 后端用 `ServeStaticModule` 托管 `frontend/dist`，路径由 `PICSUR_STATIC_FRONTEND_ROOT` 覆盖，默认 `<包根>/../frontend/dist`。`backend/src/config/early/serve-static.config.service.ts:17-30`
- 未匹配的路径回落到 index.html，`fallthrough: true`，保证 SPA 深链可用。`serve-static.config.service.ts:32-48`
- 注册位置在 AppModule，先于其它业务模块。`backend/src/app.module.ts:61-66`
- 静态资源与 API 同源同端口，前端不需要跨域配置，axios 直接用相对路径。`frontend/src/app/services/api/api.service.ts:255-289`

### 三、HTTP 客户端约定

- 库：axios，统一包在 `ApiService`，支持 GET、HEAD、Buffer GET、POST JSON、空 POST、POST multipart。`frontend/src/app/services/api/api.service.ts:98-150`
- 认证：从本地存储取 token，加 `Authorization: Bearer <token>`。`api.service.ts:259-266`
- 超时与错误：`validateStatus: () => true`，不因 4xx 抛异常，改为解析信封；错误类型映射回 `FT` 枚举。`api.service.ts:69-75, 274-298`
- 响应校验：每个请求都带 zod DTO，把 `data` 部分再解析一次。`api.service.ts:152-196`
- Buffer 下载：按 content-type 补扩展名，用于图片与下载。`api.service.ts:198-239`

### 四、前端调用的 API 清单

| 前端服务 | 调用 | 证据 |
|---|---|---|
| info | `GET /api/info` | `services/api/info.service.ts:136` |
| info | `GET /api/info/permissions` | `services/api/static-info.service.ts:45` |
| user | `POST /api/user/login`、`POST /api/user/checkname`、`POST /api/user/register`、`GET /api/user/me` | `services/api/user.service.ts:70, 93, 109, 150` |
| user | `GET /api/user/special` | `services/api/static-info.service.ts:33` |
| user | `GET /api/user/me/permissions` | `services/api/permission.service.ts:73-76` |
| user admin | `POST /api/user/list`、`POST /api/user/create`、`POST /api/user/update`、`POST /api/user/delete` | `services/api/user-manage.service.ts:40, 52, 61, 70` |
| image | `POST /api/image/upload` | `services/api/image.service.ts:47-51` |
| image | `POST /api/image/list`、`POST /api/image/list/all` | `services/api/image.service.ts:80-103` |
| image | `POST /api/image/update`、`POST /api/image/delete` | `services/api/image.service.ts:130-152` |
| image | `GET /i/meta/:id` | `services/api/image.service.ts:72` |
| image 字节 | `GET /i/:id` 或 `/i/:id.:ext`，带 query | `services/api/image.service.ts:168-243`、`components/picsur-img/picsur-img.component.ts:155-166` |
| 用户偏好 | `GET /api/pref/usr`、`GET/POST /api/pref/usr/:key` | `services/api/usr-pref.service.ts:68, 85, 102` |
| 系统偏好 | `GET /api/pref/sys`、`GET/POST /api/pref/sys/:key` | `services/api/sys-pref.service.ts:68, 85, 102` |
| 升级 | `POST /api/system/update/check`、`POST /api/system/update/apply` | `services/api/system-update.service.ts:29, 74` |
| 统计 | `POST /api/usage/report` 前缀由 ackee 自动拼接 | `services/usage/usage.service.ts:63` |

未被前端调用的后端端点：`POST /api/image/delete/key`、`GET /api/image/delete/:id/:key`、`GET /api/info/formats`。其中删除密钥端点只在直接访问时使用，格式列表端点前端未使用，证据是对应 grep 无命中。

### 五、上传契约

- `FormData` 单文件，字段名固定 `image`。`frontend/src/app/models/dto/image-upload-request.dto.ts:6-10`
- 上传进度用 axios `onUploadProgress`，展示在 processing 页面。`api.service.ts:281-286`、`frontend/src/app/routes/processing/`
- 上传成功后前端只用返回的 `id` 跳转，见 `services/api/image.service.ts:46-54`
- 上传大小上限由后端 128MB 默认值约束，见 `config/early/multipart.config.service.ts:14-19`

### 六、图片 URL 契约

- 生成规则：`<base>/i/<uuid>` 加可选 `.ext`，base 默认取当前 origin，可用 `/api/info` 的 `host_override` 覆盖。`services/api/image.service.ts:168-179`、`services/api/info.service.ts:111-121`
- 分享链接默认带 host_override，见 `image.service.ts:182-195, 245-251`
- 编辑参数拼成 query，顺序固定：height、width、rotate、flipx、flipy、shrinkonly、greyscale、noalpha、negative、quality。`image.service.ts:210-243`
- 画廊展示请求 WEBP 派生图：`routes/images/images.component.ts:326`
- 查看页预览按 `previewFiletype` 请求，见 `routes/view/view.component.ts:100`
- 图片渲染不走原生 `<img src>` 直连，而是带 token 的 XHR 取字节再转 blob URL，见 `components/picsur-img/picsur-img.component.ts:147-168`
- QOI 格式无法被浏览器渲染，前端用 Web Worker 解码后画到 canvas，worker 内的请求同样带 `Authorization: Bearer`，见 `workers/qoi-worker.service.ts:20-50`、`components/picsur-img/picsur-img.component.ts:134-146`

### 七、启动与权限门控

- 应用启动即请求 `/api/info`，失败或 5 秒未响应则报错给调用方，见 `services/api/info.service.ts:17-23, 77-105`
- 权限来自 `/api/user/me/permissions`，未加载完视为空权限，失败关闭，见 `services/api/permission.service.ts:12-52, 72-81`
- 前端路由守卫按权限拦截，见 `frontend/src/app/guards/permission.guard.ts`
- 版本展示：前端版本来自 `frontend/package.json`，后端版本来自 `/api/info`，见 `services/api/info.service.ts:107-109`、`components/footer/footer.component.ts:26, 54`

### 八、错误与 i18n 契约

- 后端错误正文是英文文本，`type` 是机器可读枚举，见 `shared/src/types/failable.ts:7-23`
- 前端把 `type` 映射回 `FT` 并交给错误管理器展示，见 `api.service.ts:69-75`、`app/util/error-manager/error.service.ts`
- 部分前端自产失败用 i18n 键当 reason，例如 `api.somethingWentWrong`，见 `api.service.ts:124, 177`
- 用户可见文案在模板与 TS 中走 i18n，词典为 en 与 zh 两份，见 `assets/i18n/en.json`、`assets/i18n/zh.json`
- 结论：Rust 版后端不需要做 i18n，只需要保持 `type` 枚举与 HTTP 状态码稳定，文案可以保持英文

### 九、特殊集成检查

| 集成 | 是否存在 | 证据 |
|---|---|---|
| SSR | 否，纯 SPA | `angular.json` 无 server builder，后端只做静态托管 |
| OnlyOffice 或文档预览 | 否，全仓 grep 无 onlyoffice 命中 | 2026-10-31 grep 结果为空 |
| WebSocket 或 SSE | 否 | 路由清单只有 HTTP，无 gateway 文件 |
| Service Worker 与 PWA | 存在 manifest 与图标，未发现 ngsw 注册 | `frontend/src/assets/app.webmanifest`、`angular.json` 无 serviceWorker 配置 |
| 浏览器内 Worker | 有，QOI 编解码 | `frontend/src/app/workers/qoi.worker.ts`、`tsconfig.worker.json` |
| 第三方统计 | ackee，经后端代理 | `services/usage/usage.service.ts:57-64`、`routes/api/usage/usage.controller.ts:68-83` |
| 自升级面板 | 有，调 docker socket | `services/api/system-update.service.ts`、`managers/update/self-update.service.ts` |

### 十、打包与体积相关

- production 有初始包 1MB 警告、2MB 错误预算，见 `frontend/angular.json:50-58`
- 自定义 webpack 只做 moment locale 裁剪与 babel 处理，见 `frontend/custom-webpack.config.cjs:1-23`
- 允许 CommonJS 依赖白名单见 `frontend/angular.json:35-42`

## Caveats / Not Found

- 未发现前端对 `GET /api/info/formats` 的调用，可能是预留接口，见 `backend/src/routes/api/info/info.controller.ts:61-78`。
- 前端图片请求全部带 Authorization，因此 Rust 版若改为直接 302 到对象存储或签名 URL，会改变前端行为。
- PWA 是否真正注册 service worker 未确认，`angular.json` 无 `serviceWorker` 字段，标「待确认」。
- 前端不读任何构建期环境变量，部署只需替换后端配置，这对迁移是有利条件。

## Related Specs

- `.trellis/spec/picsur-frontend/frontend/component-guidelines.md`
- `.trellis/spec/picsur-frontend/frontend/state-management.md`
- `.trellis/spec/picsur-frontend/frontend/type-safety.md`
- `.trellis/spec/picsur-backend/backend/image-api-contracts.md`
