# 扩展视频容器上传白名单不转码

## Goal

用户确认边界：放宽视频上传到更多容器格式，用于存储与直链下载；浏览器能原生播放的继续显示播放器，不能播放的明确提示不支持在线播放并引导下载；**绝不转码**。

## Scope

In：
- 扩展共享层的视频容器白名单与 MIME、扩展名映射，前端上传 accept、直链扩展名、图库与详情页识别自动跟随。
- 后端上传接受新容器，master 仍存原片字节；直链按容器 MIME 返回，Range 与 206 行为对所有视频一致。
- 详情页用浏览器能力探测决定是否渲染播放器：能播就播，不能播显示「不支持在线播放，请使用直链或下载」提示面板。
- 视频回归脚本覆盖新容器的上传、直链、HEAD、Range、列表、删除与跨容器 400；更新原先把 mov 视为拒绝的断言。
- 规范文档同步。

Out：
- 不转码、不生成海报/时长、不做容器互转。
- 不改图片链路、不改数据库结构与迁移、不新增依赖。
- 不改变 mp4 与 webm 现有行为与用户体验。

## 候选容器

mp4、webm 保持；新增候选：mov（video/quicktime）、mkv（video/x-matroska）、avi（video/x-msvideo）、wmv（video/x-ms-wmv）、flv（video/x-flv）、mpg 或 mpeg（video/mpeg）、ts（video/mp2t）、3gp（video/3gpp）。

实现前必须用当前 `file-type` 版本逐个验证魔数识别；只保留能被稳定识别的容器，识别不了的从白名单移除并在报告中说明。

## Acceptance Criteria

- [ ] 新白名单容器可上传，返回 201，source_filetype 为 video: 前缀对应类型。
- [ ] 直链 GET 返回 200，Content-Type 为容器对应 MIME，字节与原片一致。
- [ ] 直链 HEAD 返回完整 Content-Length 与 Accept-Ranges: bytes。
- [ ] 视频直链带 Range 返回 206 与正确 Content-Range，对所有新增容器一致。
- [ ] 跨容器请求返回 400，不做转换。
- [ ] 详情页对 mp4 与 webm 显示播放器；对不能播放的容器显示不支持提示与直链、下载。
- [ ] 图片上传与读取行为不变。
- [ ] 视频回归脚本覆盖新增容器并全过；图片回归不回退。
- [ ] 前端上传 accept、图库视频徽章、分享模板对新增容器正确。

## 执行结果（2026-11-01）

- 最终白名单 11 容器：mp4、webm、mov、mkv、avi、wmv、flv、ts、3gp、ogv、m4v；mpg 因 file-type MIME 不稳定（video/mpeg、video/MP1S、video/MP2P）被排除，上传返回 400。
- 共享层：VideoFileType 扩到 11 项，MIME 与扩展名双向唯一；新增 PlayableVideoFileTypes 与 IsPlayableVideoFiletype。
- 前端：详情页用 canPlayType 决定播放器或提示面板；能力不支持直接显示「该视频格式无法在浏览器中播放」并给直链与下载；播放器解码失败回退旧面板；i18n en 与 zh 各 251 key 对齐；上传 accept 增加扩展名条目。
- 后端零改动：上传直通、直链 MIME、Range 206 对所有容器同一路径；跨容器 400 保留。
- 验证：视频回归 261 passed 0 failed；验证者独立攻击套件 325 项与 shared 契约 127 项全过；图片回归 34 passed 4 项宿主 libvips 已知环境差异；浏览器实测 webm 与 mp4 可播且媒体请求 206，mov 显示提示面板，mkv 先播后回退。
- 部署：按铁律先后端顺序热部署到 8080，容器 StartedAt 2026-11-01T08:46:09Z，healthy，/api/info 200；默认实例视频回归 260 passed 加 1 项 413 SKIP；mov 与 mkv 上传 201、直链 MIME 正确、HEAD Accept-Ranges、Range 206；mpg 400；跨容器 400；png 冒烟通过，测试数据清理。
- 文档：image-api-contracts §3.9、build-and-deploy、docs/MAINTAINING 已更新为 11 容器与 261 断言口径。
- 备份：容器旧三个 dist 位于 /root/picsur-data/backups/deploy-video-more-containers-20261101T084603Z。
