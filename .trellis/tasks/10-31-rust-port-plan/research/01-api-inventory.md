# Research: 后端 HTTP API 全量清单

- Query: 盘点 Picsur 后端所有 HTTP 端点、鉴权要求、请求响应 DTO 与错误格式
- Scope: internal
- Date: 2026-10-31
- 证据基线: git master b6bd23c

## Findings

### 一、总体约定

| 约定 | 事实 | 证据 |
|---|---|---|
| 应用框架 | NestJS 12 跑在 Fastify 5 上 | `backend/src/main.ts:24-45` |
| 全局前缀 | 无 `setGlobalPrefix`，路径由控制器自带 `api/`、`i/` 前缀 | `backend/src/main.ts:57-59`，`backend/src/routes/api/*/*.controller.ts` 的 `@Controller` |
| 请求校验 | 全局 `ZodValidationPipe`，DTO 是 zod schema 生成的类 | `backend/src/main.ts:53`、`backend/src/layers/validate/zod-validator.pipe.ts:30-46` |
| 响应包装 | 对象响应统一包成 success 信封，Buffer 原样返回 | `backend/src/layers/success/success.interceptor.ts:36-48` |
| 错误包装 | 全局异常过滤器，输出 error 信封 | `backend/src/layers/exception/exception.filter.ts:25-70` |
| 全局限流 | 60 次 / 60 秒；单路由可用 `@EasyThrottle` 覆盖 | `backend/src/layers/PicsurLayers.module.ts:10-19`、`backend/src/decorators/easy-throttle.decorator.ts` |
| 鉴权 | 全局 `MainAuthGuard`，JWT Bearer 或 guest 回退 | `backend/src/main.ts:55`、`backend/src/managers/auth/guards/main.guard.ts:28` |
| 默认拒绝 | 未声明权限的处理器直接拒绝，返回 internal 失败 | `backend/src/managers/auth/guards/main.guard.ts:94-100` |
| 权限合并 | 类级与处理器级权限取并集 | `backend/src/managers/auth/guards/main.guard.ts:85-115` |

### 二、成功与错误信封

成功信封，`backend/src/layers/success/success.interceptor.ts:101-117`：

```json
{ "success": true, "statusCode": 200, "timestamp": "ISO", "timeMs": 3, "data": { } }
```

错误信封，`backend/src/layers/exception/exception.filter.ts:51-69`：

```json
{ "success": false, "statusCode": 403, "timestamp": "ISO", "timeMs": 1, "data": { "type": "permission", "message": "Permission denied" } }
```

- 信封 schema 定义：`shared/src/dto/api/api.dto.ts:3-25`
- `type` 取值来自失败类型枚举 `FT`：`shared/src/types/failable.ts:7-23`
- 状态码映射：`shared/src/types/failable.ts:37-118`，例如 permission=403、authentication=401、usrvalidation=400、ratelimit=429、notfound=404
- 图片二进制响应不套信封，直接返回 Buffer：`backend/src/layers/success/success.interceptor.ts:39-40`

### 三、端点清单

#### 3.1 info 资源

| 方法 | 路径 | 权限 | 限流 | 响应 DTO | 证据 |
|---|---|---|---|---|---|
| GET | `/api/info` | 无 | 全局 | `InfoResponse` | `routes/api/info/info.controller.ts:22-23, 31-49` |
| GET | `/api/info/permissions` | 无 | 全局 | `AllPermissionsResponse` | `routes/api/info/info.controller.ts:52-58` |
| GET | `/api/info/formats` | 无 | 全局 | `AllFormatsResponse` | `routes/api/info/info.controller.ts:61-78` |

DTO：`shared/src/dto/api/info.dto.ts:8-34`。`/api/info` 返回 production、demo、version、host_override、tracking。

#### 3.2 user 资源，普通用户

| 方法 | 路径 | 权限 | 限流 | 请求 DTO | 响应 DTO | 证据 |
|---|---|---|---|---|---|---|
| POST | `/api/user/login` | `user-login`，允许 user/pass 认证 | 30 次 / 300 秒 | `UserLoginRequest` | `UserLoginResponse` | `routes/api/user/user.controller.ts:35-43` |
| POST | `/api/user/register` | `user-register` | 5 次 / 300 秒 | `UserRegisterRequest` | `UserRegisterResponse` | `routes/api/user/user.controller.ts:45-57` |
| POST | `/api/user/checkname` | `user-register` | 20 次 | `UserCheckNameRequest` | `UserCheckNameResponse` | `routes/api/user/user.controller.ts:59-69` |
| GET | `/api/user/me` | `user-keep-login` | 10 次 | 无 | `UserMeResponse` | `routes/api/user/user.controller.ts:71-83` |
| GET | `/api/user/me/permissions` | 无 | 20 次 | 无 | `UserMePermissionsResponse` | `routes/api/user/user.controller.ts:86-98` |

DTO：`shared/src/dto/api/user.dto.ts:8-61`。`login` 返回 `jwt_token`；`me` 同时返回新 `token` 和 `user`。

#### 3.3 user 资源，管理员

类级权限 `user-admin`，证据 `routes/api/user/user-manage.controller.ts:34-36`。

| 方法 | 路径 | 限流 | 请求 DTO | 响应 DTO | 证据 |
|---|---|---|---|---|---|
| POST | `/api/user/list` | 全局 | `UserListRequest` | `UserListResponse` | `user-manage.controller.ts:41-51` |
| POST | `/api/user/create` | 10 次 | `UserCreateRequest` | `UserCreateResponse` | `user-manage.controller.ts:53-73` |
| POST | `/api/user/delete` | 全局 | `UserDeleteRequest` | `UserDeleteResponse` | `user-manage.controller.ts:75-81` |
| POST | `/api/user/info` | 全局 | `UserInfoRequest` | `UserInfoResponse` | `user-manage.controller.ts:83-89` |
| POST | `/api/user/update` | 20 次 | `UserUpdateRequest` | `UserUpdateResponse` | `user-manage.controller.ts:91-117` |
| GET | `/api/user/special` | 全局 | 无 | `GetSpecialUsersResponse` | `user-manage.controller.ts:119-130` |

DTO：`shared/src/dto/api/user-manage.dto.ts:9-72`。`/api/user/special` 返回不可删除用户、不可改权限用户、禁止登录用户、隐式权限、guest 模板、user 模板。

#### 3.4 用户偏好

类级权限 `settings`，证据 `routes/api/pref/usr-pref.controller.ts:16-18`。

| 方法 | 路径 | 限流 | 请求 DTO | 响应 DTO | 证据 |
|---|---|---|---|---|---|
| GET | `/api/pref/usr` | 20 次 | 无 | `MultiplePreferencesResponse` | `pref/usr-pref.controller.ts:23-37` |
| GET | `/api/pref/usr/:key` | 全局 | 无 | `GetPreferenceResponse` | `pref/usr-pref.controller.ts:39-50` |
| POST | `/api/pref/usr/:key` | 30 次 | `UpdatePreferenceRequest` | `UpdatePreferenceResponse` | `pref/usr-pref.controller.ts:52-71` |

#### 3.5 系统偏好

类级权限 `syspref-admin`，证据 `routes/api/pref/sys-pref.controller.ts:15-17`。

| 方法 | 路径 | 限流 | 请求 DTO | 响应 DTO | 证据 |
|---|---|---|---|---|---|
| GET | `/api/pref/sys` | 20 次 | 无 | `MultiplePreferencesResponse` | `pref/sys-pref.controller.ts:22-32` |
| GET | `/api/pref/sys/:key` | 全局 | 无 | `GetPreferenceResponse` | `pref/sys-pref.controller.ts:34-42` |
| POST | `/api/pref/sys/:key` | 30 次 | `UpdatePreferenceRequest` | `UpdatePreferenceResponse` | `pref/sys-pref.controller.ts:44-62` |

读写都只允许暴露清单内的键，固定项会被拒绝，`jwt_secret` 不会回显。`shared/src/dto/sys-preferences.enum.ts:41-53`、`collections/preference-db/sys-preference-db.service.ts:131-187`。

#### 3.6 图片管理

控制器 `ImageManageController` 无类级权限，权限逐个处理器声明。`routes/image/image-manage.controller.ts:45-50`。

| 方法 | 路径 | 权限 | 限流 | 请求 DTO | 响应 DTO | 证据 |
|---|---|---|---|---|---|---|
| POST | `/api/image/upload` | `image-upload` | 20 次 | multipart 单文件，字段名 `image` | `ImageUploadResponse` | `image-manage.controller.ts:58-90`、`frontend/src/app/models/dto/image-upload-request.dto.ts:6-10` |
| POST | `/api/image/list` | `image-manage` | 全局 | `ImageListRequest` | `ImageListResponse` | `image-manage.controller.ts:92-109` |
| POST | `/api/image/list/all` | `image-manage` | 全局 | `ImageListAllRequest` | `ImageListAllResponse` | `image-manage.controller.ts:111-128` |
| POST | `/api/image/update` | `image-manage` | 全局 | `ImageUpdateRequest` | `ImageUpdateResponse` | `image-manage.controller.ts:130-145` |
| POST | `/api/image/delete` | `image-manage` | 全局 | `ImageDeleteRequest` | `ImageDeleteResponse` | `image-manage.controller.ts:147-165` |
| POST | `/api/image/delete/key` | `image-delete-key` | 全局 | `ImageDeleteWithKeyRequest` | `ImageDeleteWithKeyResponse` | `image-manage.controller.ts:167-176` |
| GET | `/api/image/delete/:id/:key` | `image-delete-key` | 全局 | 路径参数 | 302 跳转，无信封 | `image-manage.controller.ts:178-194` |

DTO：`shared/src/dto/api/image-manage.dto.ts:9-100`。`upload` 仅在拥有 `image-delete-key` 时返回 `delete_key`，见 `image-manage.controller.ts:65, 80-87`。

#### 3.7 图片读取，唯一启用 CORS 的控制器

类级权限 `image-view`，限流 600 次 / 60 秒。`routes/image/image.controller.ts:49-53`。

| 方法 | 路径 | 响应 | 证据 |
|---|---|---|---|
| HEAD | `/i/:id` 或 `/i/:id.:ext` | 仅响应头，404 时也返回 404 状态 | `image.controller.ts:61-91` |
| GET | `/i/:id` 或 `/i/:id.:ext` | 图片字节，支持转换查询参数 | `image.controller.ts:93-138` |
| GET | `/i/meta/:id` | `ImageMetaResponse` | `image.controller.ts:152-175` |

- 无扩展名表示要原始文件，有扩展名表示要对应格式的转换结果：`models/constants/image-full-id.const.ts:1-15`、`decorators/image-id/image-full-id.pipe.ts:9-32`
- 转换查询参数：height、width、rotate、flipx、flipy、greyscale、noalpha、negative、shrinkonly、quality。`shared/src/dto/api/image.dto.ts:8-28`
- 图片成功响应带 30 天缓存头，由中间件统一设置：`backend/src/app.module.ts:49-58`
- 图片 404 返回品牌占位图并 `Cache-Control: no-store`：`image.controller.ts:123-137, 147-150`
- `/i/meta/:id` 显式 `no-store`：`image.controller.ts:158-162`
- SVG 响应加 CSP 与 nosniff：`image.controller.ts:26-40, 177-182`

#### 3.8 系统升级

类级权限 `syspref-admin`，证据 `routes/api/system/system-update.controller.ts:39-41`。

| 方法 | 路径 | 限流 | 请求 | 响应 DTO | 证据 |
|---|---|---|---|---|---|
| POST | `/api/system/update/check` | 30 次 | 可选 body `{force?: boolean}`，也接受 `?force=true` | `UpdateCheckResponse` | `system-update.controller.ts:59-104` |
| POST | `/api/system/update/apply` | 10 次 | `UpdateApplyRequest` | `UpdateApplyResponse` | `system-update.controller.ts:111-139` |

DTO：`shared/src/dto/api/update.dto.ts:23-63`。`apply` 先回响应再执行替换，见 `:121-127`。

#### 3.9 统计上报代理

| 方法 | 路径 | 权限 | 限流 | 证据 |
|---|---|---|---|---|
| POST | `/api/usage/report` 与 `/api/usage/report/*` | 无 | 120 次 / 60 秒 | `routes/api/usage/usage.controller.ts:28-84` |

- 只允许 `application/json`，body 上限 8 KiB：`usage.controller.ts:14, 51-66`
- 只转发 content-type、accept、user-agent，`X-Forwarded-For` 用真实连接 IP：`usage.controller.ts:26, 68-83`

#### 3.10 未启用的实验路由

`/api/experiment` 控制器存在但所有处理器都被注释，实际无路由。`routes/api/experiment/experiment.controller.ts:1-16`

#### 3.11 前端 SPA 兜底

未被 API 匹配的路径交给静态文件服务，返回 `frontend/dist` 下的 index.html，实现 SPA 深链。`backend/src/app.module.ts:63-66`、`config/early/serve-static.config.service.ts:32-48`

### 四、CORS 与安全响应头

- 默认全站 CORS 使用占位 origin，实际等价关闭跨域：`backend/src/app.module.ts:25-27, 91`；该中间件被 `i/*` 排除
- 图片路径独立 CORS 允许任意来源、只读方法：`backend/src/app.module.ts:29-37, 92-94`
- 图片响应加 `Cross-Origin-Resource-Policy: cross-origin`：`backend/src/app.module.ts:39-47`
- Helmet 全局配置：`backend/src/security.ts:3-41`

## Caveats / Not Found

- 前端还调用了 `/api/user/special`、`/api/info/permissions`、`/api/info/formats`、`/api/user/me/permissions`，均已在上面列出，无遗漏端点。
- 未发现 OpenAPI/Swagger 文档或机器可读契约；契约就是 shared 里的 zod DTO，与 `@Returns` 装饰器配合做响应校验，见 `decorators/returns.decorator.ts:14-22`、`layers/success/success.interceptor.ts:66-99`。
- 没有 cookie、session、CSRF 相关端点，鉴权全为无状态 Bearer。
- `GET /api/image/delete/:id/:key` 是给浏览器直接点击用的 302 端点，行为特殊，迁移时容易漏，见 `image-manage.controller.ts:178-194`。
- 实际状态码集合依赖 `FT` 映射，个别失败类型如 impossible 用 422，需要逐项对齐，见 `shared/src/types/failable.ts:37-118`。

## Related Specs

- `.trellis/spec/picsur-backend/backend/image-api-contracts.md`
- `.trellis/spec/picsur-backend/backend/error-handling.md`
- `.trellis/spec/picsur-backend/backend/upload-concurrency.md`
