# 设计：视频 Range 与直接播放

## 后端

### 数据读取

- 现有视频读取路径会整段取字节。新增按字节区间读取：`backend/src/collections/image-db/image-file-db.service.ts` 增加 `getFileSlice(id, offset, length)`，用 PostgreSQL bytea 的 `substring(data from offset+1 for length)` 与 `octet_length(data)` 一次查询返回切片与总大小，避免整段加载。
- 需要总大小时先做轻量元数据查询：现有 `getFileInfo()` 已有 filetype 与 octet_length。

### 控制器

- 文件：`backend/src/routes/image/image.controller.ts` 视频 GET/HEAD 分支。
- Range 解析仅支持单段：`bytes=start-end`、`bytes=start-`、`bytes=-suffix`；多段逗号请求忽略 Range 按 200 整段返回。
- 校验：start < size；end 缺省为 size-1，超过则截断；suffix 超过 size 时取整段；start >= size 或非法返回 416 且 `Content-Range: bytes */<size>`。
- 响应头：`Accept-Ranges: bytes`；200 与 206 都带 `Content-Length`、`Content-Type` 按文件类型 video/mp4 或 video/webm、`X-Content-Type-Options: nosniff`；206 追加 `Content-Range`。
- HEAD：不读数据，按文件大小返回同样头部，Content-Length 为完整大小，带 Accept-Ranges。
- 现有同格式直链、无扩展名回退、跨格式 400 逻辑保持不变。

### 缓存

- 沿用现有视频直链缓存头；206 分段响应同样允许缓存。不引入 no-store 变更，避免破坏现有回归断言。

## 前端

- 文件：`frontend/src/app/routes/view/view.component.ts|html|scss`。
- 视频类型判断沿用 `isVideo()` 与 `ImageMediaKind`；对 mp4 与 webm 渲染 `<video controls playsinline preload="metadata" [src]="directUrl">`，不自动播放。
- 占位面板保留给浏览器不支持内嵌播放的兜底场景，正常视频不再显示「不能在页面内播放」提示。
- 下载按钮、直链与分享模板保持；video 元素加最大宽高约束，保持现有详情页布局。
- 图库列表缩略图逻辑不变。

## 兼容与风险

- Chrome、Firefox、Edge 对单段 Range 支持良好；Safari 必须 206 才播，本设计满足。
- 大文件 Range 请求按切片读取，避免整段内存；整段 GET 仍可能占用较多内存，属既有边界。
- 多段 Range 返回整段是浏览器可接受的降级行为。
- 不改存储与数据库结构，回滚只需回退代码与 dist。

## 验证

- 扩展 `support/regression-video-api.sh`：Range 单段、开放区间、后缀区间、越界 416、HEAD Accept-Ranges、切片字节一致性；现有 54 项不得回退。
- 前端用 bw 打开详情页检查 video 可加载、可播放、进度条可拖。
- 部署顺序：先把新 frontend/dist 拷入容器，再更新 backend/dist 与 shared/dist，最后重启后端，避免静态路由未注册问题。
