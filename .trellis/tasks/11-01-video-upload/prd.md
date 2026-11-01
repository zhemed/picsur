# 图床支持视频上传与直链（A 档）

## Goal

让现有 Picsur 图床接受浏览器可直放的视频容器并存入现有存储模型，上传后能拿到可用的直链用于下载与外部引用。

用户已定调范围为 **A 档：只上传与直链**。不做 Range、不做内嵌播放器、不做转码与海报。

## 用户决策

- 档位：A 档，只上传与直链。A+ 的 Range 播放与 B 档的转码海报明确不做。
- 允许容器：mp4 与 webm，即浏览器原生可直放的两种；mov、mkv、avi、HEVC 等一期不收。
- 存储：沿用现有 Postgres bytea 与 `/data` 备份模型，不引入文件系统或对象存储。
- 上传大小：沿用现有 `PICSUR_MAX_FILE_SIZE`，默认 128,000,000 字节，不新增配置项。

## Background：现状确认事实

以下事实来自 10-25 评估与今天代码复核，证据见 [research/](.trellis/tasks/11-01-video-upload/research/) 与 [10-25 评估研究](../10-25-video-support-eval/research/)。

| 维度 | 现状 |
|---|---|
| 上传 | `POST /api/image/upload`，multipart 单文件，整段读进内存 `Buffer`，上限来自 `PICSUR_MAX_FILE_SIZE`，默认 128MB |
| 类型识别 | `file-type` 魔数识别后查 `Mime2FileType`，视频 mime 未收录，返回内部错误，异常过滤器映射为 500 |
| 主文件策略 | 静图转 QOI，动图转 animated WebP，SVG 清洗后原样；视频没有分支 |
| 存储 | 图片 master、original、派生图全部存 Postgres bytea，无文件系统存储 |
| 读取 | `/i/:id` 无扩展名走 original 回退，`/i/:id.:ext` 走转换；两者都一次性返回完整 Buffer，无 Range |
| 前端 | 上传 input 无 accept；图库缩略图走 WebP 派生；详情页走 QOI/canvas 或 blob `<img>`，视频会显示坏图 |
| i18n | en / zh 两份词典，键必须一一对应；用户可见文案走 i18n |
| 回归 | 现有 34 项图片 API 回归脚本；期望本次不回归 |

## Requirements

### R1 shared 视频类型契约

- `mimes.dto.ts` 新增视频类型：`video:mp4`、`video:webm`，以及 `SupportedFileTypeCategory.Video`。
- mime 映射：`video/mp4`、`video/webm`；扩展名映射：`mp4`、`webm`；`SupportedVideoFileTypes` 与 `SupportedFileTypes` 收录。
- `parse-mime.ts` 的 `ParseFileType` 认识视频类别。
- 非白名单视频容器（mov、mkv 等）必须返回 `usrvalidation` 类错误，最终映射为 4xx，不得再是 500。

### R2 上传链路

- 上传接口接受 mp4 与 webm，权限仍为 `image-upload`，限流沿用现状。
- 视频 master 就是上传的原片字节，不经过 sharp、不做像素预检、不做转码。
- `keep_original` 对视频语义不变：master 已是原片，不额外重复存 original。
- 记录 `source_filetype` 为 `video:mp4` 或 `video:webm`；宽高留空；文件名去扩展名逻辑保持现状。

### R3 直链与读取

- `GET /i/:id.mp4`、`GET /i/:id.webm` 返回原片字节，`Content-Type` 分别为 `video/mp4`、`video/webm`，保留 30 天缓存头。
- `GET /i/:id` 无扩展名时，视频返回 master 原片，行为与 SVG 的 master 回退一致。
- `HEAD /i/:id` 与 `HEAD /i/:id.:ext` 对视频返回与 GET 一致的状态码与 `Content-Type`，无正文。
- 对视频请求转换成其他格式或带编辑参数时返回 `usrvalidation` 4xx，不尝试 sharp 转码。
- 删除后直链返回 404 加品牌占位图与 `no-store`。

### R4 列表与元数据

- 图片列表、图片详情与 `/i/meta/:id` 能让前端识别出「这是视频」。
- 采用零迁移方案：以 `source_filetype` 的视频前缀判定，不新增字段、不改实体与迁移。
- `fileTypes` 字段对视频仍返回 master 的 mime，前端不得再据此构造 WebP 缩略图。

### R5 前端

- 上传页 `accept` 放行图片与 mp4/webm；拖放同样做类型与大小预检；不支持的类型与超限给出 i18n 错误。
- 图库：视频卡片不走 WebP 派生，改为占位 tile 加 VIDEO 徽章与文件名，点击进详情。
- 详情页：视频不渲染坏图，展示直链、下载与分享片段；下载文件名带正确扩展名。
- 分享片段：markdown 对视频给普通链接而不是图片语法，html 片段给 `<video controls src>`；复制直链在未登录窗口可打开。
- i18n：en 与 zh 同步新增所需键，现有写死「image」的文案按媒体类型中性化或分支。

### R6 安全与限额

- 仅 mp4 与 webm 进入视频白名单；大小上限沿用 `PICSUR_MAX_FILE_SIZE`。
- 超限返回 413；非白名单视频返回 4xx；两者都不得出现 500。
- 沿用现有上传权限、限流与 CORS 策略，不新增出网与外部依赖。

### R7 回归与文档

- 现有 34 项图片 API 回归全绿，图片上传、读取、删除行为不变。
- 新增视频冒烟断言，覆盖上传、直链 GET、HEAD、列表、删除后 404、超限与非白名单。
- 环境变量与文档保持三处同步：`.env.example`、`Dockerfile.allinone` 默认值、`build-and-deploy.md` 的变量说明；本次若不新增变量则明确记录。

## In Scope

- shared 视频类型契约、后端上传与读取旁路、列表与元数据可识别视频。
- 前端上传入口、图库卡片、详情页直链与下载、i18n。
- 视频冒烟断言与文档更新。

## Out of Scope

- Range 与 206、`Accept-Ranges`、拖动进度条优化、内嵌播放器。
- ffmpeg 转码、海报截帧、时长与分辨率解析、多码率、HLS/DASH。
- mov、mkv、avi、HEVC、AV1 等容器或编码的白名单。
- 文件系统或对象存储、配额系统、防盗链、水印、CDN。
- 多文件批量上传语义变更。

## Acceptance Criteria

- [ ] 上传 mp4 与 webm 成功，返回统一信封，`data.source_filetype` 为 `video:mp4` 或 `video:webm`。
- [ ] `GET /i/<id>.mp4` 返回 200、`Content-Type: video/mp4`、字节与上传完全一致；webm 同理。
- [ ] `GET /i/<id>` 对视频返回 master 原片；`HEAD` 返回正确 `Content-Type` 且无正文。
- [ ] 图片列表、详情与 `/i/meta/<id>` 能区分视频与图片；前端不再对视频请求 WebP 派生。
- [ ] 删除视频后直链返回 404 加占位图与 `no-store`。
- [ ] 上传 mov 等非白名单容器返回 4xx `usrvalidation`，不再返回 500。
- [ ] 超过 `PICSUR_MAX_FILE_SIZE` 返回 413。
- [ ] 图库与详情页对视频不出现坏图，直链与下载可用，下载文件名扩展名正确。
- [ ] en / zh 两份 i18n 词典键一一对应，新增文案齐全。
- [ ] `pnpm build` 三包通过，现有 34 项图片回归全绿。
- [ ] 相关文档更新完成，视频范围边界与已知限制写明。

## Risks and Deferred Items

- A 档没有 Range：浏览器能拿到完整文件后播放，但拖动进度条与部分 Safari 场景体验受限。这是用户已接受的范围边界，二期再评估。
- 视频存 bytea 且整段读入内存：128MB 上限下单请求内存峰值约 2 到 3 倍文件体积；需要在文档写明并发风险，必要时后续调低上限。
- 没有转码意味着只承诺「浏览器原生能解」的容器与编码；编码不兼容时用户只能下载。
- 图库视频卡片没有真实封面，只能占位 tile；海报能力属二期。
