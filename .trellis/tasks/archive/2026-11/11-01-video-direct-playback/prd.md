# 视频直链支持 Range 与页面内直接播放

## Goal

用户要求视频能在页面内直接播放，不要转码。mp4 H.264 与 webm VP8/VP9 是浏览器原生格式，直接内嵌即可；需要后端补 HTTP Range 分段支持，前端补 video 控件。

## Scope

In：
- 后端视频直链 GET/HEAD 支持单段 HTTP Range 与 206 分段返回，含 Content-Range、Accept-Ranges、416 处理。
- 前端详情页视频从占位面板换成 `<video controls>` 直接播放，保留直链与下载入口。
- 图片链路、存储格式、上传逻辑不变；不引入转码。

Out：
- 不转码、不生成海报、不切片 HLS/DASH。
- 不实现多段 Range 合并，多段请求按 200 整段返回。
- 不支持浏览器不原生支持的容器格式，如 mov。

## Acceptance Criteria

- [ ] 视频 GET 带 `Range: bytes=0-99` 返回 206，`Content-Range: bytes 0-99/<size>`，`Content-Length: 100`，字节与整段前 100 字节一致。
- [ ] 支持 `bytes=N-` 开放区间与 `bytes=-N` 后缀区间。
- [ ] 越界或非法 Range 返回 416，`Content-Range: bytes */<size>`。
- [ ] HEAD 返回 200 且带 `Accept-Ranges: bytes` 与完整 `Content-Length`。
- [ ] 不带 Range 的 GET 行为与现状一致，返回 200 整段。
- [ ] 前端详情页对 mp4 与 webm 显示可播放 video 控件，拖动进度条可续播，iOS Safari 可播。
- [ ] 直链、Markdown、HTML、BBCode、Rst 分享模板保持可用。
- [ ] 图片链路回归不失败；视频回归脚本覆盖 Range 用例并全过。

## Constraints

- 存储仍为 Postgres bytea 原样字节；Range 按字节切片返回，不落盘、不转码。
- 单文件上限沿用现有 128MB；整段请求仍受内存约束，Range 请求应按切片读取避免整段加载。
- 不改数据库结构与迁移。

## 执行结果（2026-11-01）

- 实现：后端新增 getFileSlice 按字节切片、视频 GET/HEAD 支持单段 Range 与 206/416，多段降级 200；前端详情页改为 `<video controls playsinline preload="metadata">` 直接播放，解码失败回退占位面板；分享模板与下载保留。
- 独立验证：视频回归 90 passed 0 failed，自写攻击套件 139 项全过，浏览器实测真实 webm 与 mp4 可播放、暂停、seek，浏览器实际收到 206 分段；图片回归 34 passed 加 4 项宿主 libvips 已知环境差异。
- 验证中发现并修复：416 响应曾继承 `/i/*` 的 30 天缓存，已改为 `Cache-Control: no-store` 并复跑通过。
- 文档同步：image-api-contracts §3.9、build-and-deploy §6.3 热部署顺序铁律、docs/MAINTAINING 已更新为 Range 与播放契约。
- 部署：按「先前端后后端再重启」顺序热部署到 8080，容器 StartedAt 2026-11-01T07:56:06Z，healthy，/api/info 200；163 个前端资源 Content-Type 全部正确。
- 实例验证：HEAD 视频带 Accept-Ranges: bytes；`Range: bytes=0-99` 返回 206 与正确 Content-Range；开放区间、后缀区间、越界截断、416 no-store 与空正文均符合；默认实例口径视频回归 89 passed 加 1 项 413 SKIP；png 冒烟与清理通过；bw 实测真实 mp4 与 webm 播放、拖动进度正常；图片详情页未回归。
- 备份：容器旧三个 dist 位于 /root/picsur-data/backups/deploy-video-playback-20261101T075548Z，含 SHA256SUMS。
