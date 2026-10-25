# Research: 前端（frontend/）视频支持改造调研

- Query: Picsur 扩展为支持视频上传，前端（Angular）需要改哪些地方；分 A（不转码）/ B（转码+海报）两档评估。
- Scope: internal（仓库代码 + 依赖源码 + 项目 spec）
- Date: 2026-10-25
- 任务: `.trellis/tasks/10-25-video-support-eval`；本文件只做调研，不含实现。
- 只读声明：本调研未改任何源码/配置、未装依赖、未跑服务、未提交。唯一写入是本文件。

---

## 结论

1. **前端完全没有视频相关代码或依赖**：全仓库 `grep -rni video`（backend/src、frontend/src、shared、docs、README）0 命中；`frontend/package.json:18-49` 无任何视频库。当前所有媒体管线都写死"图片"假设，视频不是"加一个 `<video>` 标签"就能完成，而是要**新增一条并行的 media-type 分支**。
2. **A 档（存原片、不转码）前端可行、工作量小**：约 8~10 个产品文件（其中 2 个在 shared 包），粗估 400~700 行 diff，无新依赖、无构建配置变更、不新增强路由。原生 `<video controls playsinline preload="metadata" src="/i/<id>.mp4">` 足够承担"详情页能播"；图库在没有海报的前提下用**静态视频占位 tile + VIDEO 徽章**是成本最低、风险最小的选择。
3. **A 档的真实卡点不在 Angular**：直链 `/i/<id>.<ext>` 的扩展名解析依赖 shared mime/ext 表（前后端共用）；播放拖动（Range/206）后端目前完全没有实现；CSP 无 `media-src`（回落到 `default-src 'self'`，同源 URL 可播，但 **blob: 路径不可用**，不能照抄现有 picsur-img 的 blob 逻辑）；上传大小上限未通过 `/api/info` 暴露给前端。
4. **B 档（转码 + 海报 + Range）前端增量小**：在 A 档基础上再加 3~4 个文件、约 100~250 行（海报字段接入、图库换真海报、播放器 `poster`、时长展示、转码状态展示）；B 档的主体工作量在后端 ffmpeg/海报存储/流式响应与部署，见 backend 侧调研。
5. **结论一句话**：前端侧"能上传、图库能看到、详情页能播放、直链可用"（A 档）是**低风险、小工作量**；是否值得做由后端（视频原片直出 + Range + 大小/时长限制）与运维（磁盘/带宽）决定，而不是前端。

---

## 证据（文件:行号）

### 0. 总体：媒体类型只有图片/动图，视频概念不存在

| 文件路径 | 说明 |
|---|---|
| `shared/src/dto/mimes.dto.ts` | 媒体类型白名单：只有 ImageFileType / AnimFileType 和 mime/ext 映射 |
| `shared/src/entities/image.entity.ts` | 列表/详情共用的 EImage 结构，没有媒体类型/时长字段 |
| `frontend/src/app/components/picsur-img/*` | 唯一的媒体渲染组件，canvas/QOI 与 `<img>` 两条路 |
| `frontend/src/app/services/api/image.service.ts` | 直链与复制链接片段的唯一构建点 |

- shared 只有图片/动图两类：`shared/src/dto/mimes.dto.ts:4-17`（ImageFileType，含 QOI/JPEG/PNG/WEBP/SVG/TIFF/AVIF/HEIF/JXL/JP2/BMP）、`:19-23`（AnimFileType，GIF/WEBP）、`:34-37`（SupportedFileTypeCategory 只有 Image/Animation）。没有 video 类别。
- mime 映射 `shared/src/dto/mimes.dto.ts:48-66`、扩展名映射 `:85-103` 都只覆盖图片；`FileType2Ext('video/mp4')` 直接返回失败（`:112-117`）。
- `ParseFileType` 只认图片/动图，其它一律 Fail：`shared/src/util/parse-mime.ts:11-22`；`ParseMime2FileType('video/mp4')` 因此在 `:30-33` 失败。
- EImage 结构：`shared/src/entities/image.entity.ts:4-26` —— `id / user_id / created / file_name / source_filetype / width / height / expires_at`，**无 media_type、无时长、无字节数**。
- 列表响应：`shared/src/dto/api/image-manage.dto.ts:25-31`（`results: EImage[]` + total/page/pages）；详情响应 `shared/src/dto/api/image.dto.ts:30-38`（image + user + `fileTypes.master/original`）。

### 1. 上传入口：单文件、无 accept、无客户端校验、无进度

- 文件选择框**没有 accept、没有 multiple**：`frontend/src/app/routes/upload/upload.component.html:3` 只有 `<input type="file" fileInput [formControl]="fileControl" />`；全前端模板 `grep accept=` 0 命中、`grep multiple` 只命中设置页的 `name-multiple`。
- 依赖的 `@ngx-dropzone/cdk` 默认接受一切：`FileInputDirective._accept = '*'`，且拖拽不按 accept 过滤（`_onDrop` 直接 `handleFileDrop`）。实现位于依赖源码 `frontend/node_modules/@ngx-dropzone/cdk/fesm2022/ngx-dropzone-cdk.mjs`（非仓库代码，见"风险"第 10 条）。结论：**现在任何文件都能被选中/拖入，类型校验 100% 落在后端**。
- 后端只认图片：上传入口 `backend/src/routes/image/image-manage.controller.ts:58-90`（`@PostFiles(1)`，只取一个文件）；识别用 `file-type` + QOI/SVG 特判，识别不出报 `Unsupported or unrecognized image format`（`backend/src/managers/image/image.service.ts:359-390`）。
- **没有批量上传**：`ImageService.UploadImage(image: File)` 只收单个文件（`frontend/src/app/services/api/image.service.ts:46-54`），批量方法被整段注释掉（`:56-69`）；后端 `@PostFiles(1)` 也只消费第一个文件。
- **多文件混合（图 + 视频）的现状**：
  - 选择框/拖拽因无 `multiple` 只取第一个文件（dropzone 实现里 `multiple ? Array.from(fileList) : item(0)`）。
  - 粘贴路径会把剪贴板里所有 file 装进 metadata：`frontend/src/app/routes/upload/upload.component.ts:56-80`（`onPaste` 只过滤 `item.kind === 'file'`，不校验 mime）。
  - `ProcessingViewMeta` 虽然携带 `imageFiles: File[]`（`frontend/src/app/models/dto/processing-view-meta.dto.ts:1-9`），但处理页**只上传第一个**：`frontend/src/app/routes/processing/processing.component.ts:35` `UploadImage(state.imageFiles[0])`。
  - 因此混合拖入时：只有第一个文件被处理，其余静默丢弃；如果第一个是视频，后端拒绝，前端表现是 snackbar 报错 + 回首页（`frontend/src/app/util/error-manager/error.service.ts:20-32` 的 `quitFailure`）。
- **进度/错误处理**：`ApiService` 提供 `uploadProgress` 流（`frontend/src/app/services/api/api.service.ts:268-291`）和 `cancel()`（`:304-309`），但 `UploadImage` 只取 `.result`（`image.service.ts:46-52`），全前端 grep `uploadProgress` 无消费方 → 上传期间只有一个不动的 spinner（`frontend/src/app/routes/processing/processing.component.html:1-6`），且**没有超时**（大文件+慢链路可能无限等待）。
- **客户端大小/类型校验：没有**。`grep file.size frontend/src/app` 0 命中；`/api/info` 也不返回上限（`shared/src/dto/api/info.dto.ts:8-17`）；后端默认上限 128,000,000 字节由 env 决定（`backend/src/config/early/multipart.config.service.ts:14-19`）。
- 文案写死"图片"：`upload.title` = "Upload Image/上传图片"、`upload.dropHint` = "...an image.../...一张图片..."、`upload.clipboardNoImages`、`upload.clipboardImageError`（`frontend/src/assets/i18n/en.json:88-96`、`zh.json:88-96`）。

### 2. 图库/列表：硬编码 `<img>` + WebP 派生链，缺媒体类型分支

- 缩略图用 `picsur-img` 的 native 模式：`frontend/src/app/routes/images/images.component.html:31-40`。native 模式的模板就是一个 `<img loading="lazy" decoding="async">`：`frontend/src/app/components/picsur-img/picsur-img.component.html:7-16`；非 native 模式是 canvas / `<img>` / `broken_image` 图标（`:18-33`），**没有 `<video>` 分支**。
- 缩略图 URL 硬编码为 WebP 派生：`frontend/src/app/routes/images/images.component.ts:324-329`（`GetImageURL(id, ImageFileType.WEBP) + '?width=...&shrinkonly=yes'`）。视频没有图片派生，这条链路对视频必然失败。
- 尺寸推导依赖 EImage.width/height：`images.component.ts:230-247`（`getThumbnailUrl`）、`:292-301`（`exactThumbWidth`）、`:267-275`（小图不放大）；尺寸为 null 时回退默认宽度 `:308-313`。视频的分辨率可以塞进这两个字段复用。
- 懒加载：native 模式用 `loading="lazy"`（`picsur-img.component.html:10`）；非 native 模式用 `nguiInview` 指令（`picsur-img.component.ts:195-208`，模板 `picsur-img.component.html:35-39`）。
- **格式/尺寸标签**：图库卡片只显示文件名 `image.file_name`、上传时间、过期时间（`images.component.html:43-58`），**页面上没有任何"格式"或"尺寸"文本**；`image.width/height` 仅参与缩略图尺寸计算。格式信息只有详情页的下拉框在用（见第 3 节）。
- **列表是分页而非无限滚动**：每页 24 条（`images.component.ts:431` `ListMyImages(24, page - 1)`），底部 `paginator`（`images.component.html:71-75`）；`infinite-select` 组件只被设置页使用（全前端 grep 只在 `components/infinite-select` 自身命中）。
- **数据结构够不够用**：对视频"够用一半"。可复用：`file_name`、`created`、`expires_at`、`width/height`（存视频分辨率）。缺：**媒体类型**（`source_filetype` 是 `string | null`，见 `shared/src/entities/image.entity.ts:9`，语义是"上传时的图片格式"，可被后端塞入 `video:mp4` 但语义不干净；列表页要分支必须有稳定字段）、**时长**、**字节大小**、**海报/缩略图标识**。

### 3. 详情页：渲染流程是 QOI/canvas 或 blob 图片，视频会显示"坏图"

- 预览组件：`frontend/src/app/routes/view/view.component.html:32-34` 的 `<picsur-img [src]="previewLink">`。
- `previewLink` 构造：`frontend/src/app/routes/view/view.component.ts:86-103` —— 取 `metadata.fileTypes.master` 作为目标格式，请求当前屏宽（`width=innerWidth*dpr&shrinkonly=yes`）的派生图；SVG master 时改请求 JPEG。
- 渲染实现：`frontend/src/app/components/picsur-img/picsur-img.component.ts:130-172` —— 先 `HEAD` 拿 content-type（`:181-193`），QOI 走 worker 解码进 canvas（`:134-146`），其它格式 `getBuffer` → `blob` → `<img>`（`:147-170`）。`ParseMime2FileType('video/mp4')` 在 `shared/src/util/parse-mime.ts:30-33` 失败 → 组件进 Error 状态 → 模板显示 `broken_image` 图标（`picsur-img.component.html:33`）。**即：如果后端直出视频，现有详情页会把它渲染成坏图。**
- 格式切换：下拉选项由 `updateFormatOptions`（`view.component.ts:205-221`）生成 —— `hasOriginal` 时加"Original"项，然后拼上 `utilService.getBaseFormatOptions()`（`frontend/src/app/util/util.service.ts:36-65`，只遍历 `SupportedFileTypes` 图片/动图格式，显式跳过 SVG）。默认选中逻辑在 `view.component.ts:161-189`：上传时 PNG 保留 PNG，否则按 master 类别选 JPEG / GIF。**格式下拉只影响复制链接与下载的目标格式，不影响预览。**
- **尺寸信息**：详情页**没有尺寸展示**（`view.component.html` 全文无宽高文本）；只有 customize 弹窗里的"目标宽/高"输入（`frontend/src/app/routes/view/customize-dialog/customize-dialog.component.ts:61-78`，文案 `en.json:141-172` 的 `view.customize.*`）。
- 下载：`frontend/src/app/routes/view/view-speeddial/view-speeddial.component.ts:96-102` → `GetImageURL(id, selectedFormat)` → `DownloadService.downloadFile`（`frontend/src/app/util/download-manager/download.service.ts:40-59`，用 `getBuffer` 再 `downloadBuffer`）。文件名优先取 content-disposition，否则取 URL 尾段，扩展名靠 `FileType2Ext` 补（`frontend/src/app/services/api/api.service.ts:214-232`）——**视频没有 ext 映射时下载文件名会缺扩展名**；下载弹窗里的文件名还固定写成 `'image'`（`download.service.ts:43`）。
- 复制链接：`imageLinks` getter（`view.component.ts:105-119`）→ `CreateImageLinksFromID`（`image.service.ts:245-251`）→ `CreateImageLinks`（`:182-195`）。**片段是硬编码的图片语义**：markdown 固定 `![alt](url)`（`:190`）、html 固定 `<img src alt>`（`:191`）。
- 分享：`view-speeddial.component.ts:104-110` → `download.service.shareFile`（`download.service.ts:83-131`）走 Web Share API（URL 或 File 两种）；File 分支用 content-type 构造（`:97-110`），视频 mime 不会被改写，但 URL 分支仍是图片直链。

### 4. 分享页 / 嵌入 / 直链：没有分享页，也没有 embed 模板

- **前端路由只有** upload / processing / view / user / images / settings / error：`frontend/src/app/app.routing.module.ts:5-53`。没有 share / embed / iframe 路由。
- **全仓库没有 embed/oEmbed 实现**：`grep -rni "embed|oembed|iframe"` 只命中 SVG 安全过滤（`backend/src/managers/image/svg-security.service.ts:50`）与安全头注释（`backend/src/security.ts`、`backend/src/app.module.ts`）。所谓"分享"就是详情页的 Web Share 按钮；所谓"嵌入"就是复制的 HTML 片段（目前是 `<img>`）。
- **直链唯一拼接点**：`image.service.ts:168-179` `GetImageURL` 把 Host 与 `/i/<id>.<扩展名>` 拼接（源码用模板字符串写法）；`baseURL` 来自 `InfoService.getHostname(allowOverride)`（`frontend/src/app/services/api/info.service.ts:111-121`，支持系统偏好 `host_override`）。extension 来自 `FileType2Ext(filetype)`，失败则拼出**无扩展名**的 `/i/<id>`。
- 用户可见链接：`CreateImageLinksFromID`（`image.service.ts:245-251`）→ `CreateImageLinks`（`:182-195`），产出 source / markdown / html / rst / bbcode。
- 直链扩展名解析在后端：`backend/src/routes/image/image.controller.ts:50-53`（`@Controller('i')`）、`:61-91`（HEAD `:id`）、`:93-138`（GET `:id`），`ImageFullIdPipe` 用 shared 的 `Ext2FileType` 解析 `<id>.<ext>`（`backend/src/decorators/image-id/image-full-id.pipe.ts:9-32`）。**所以增加 `.mp4/.webm` 直链是 shared 层改动，前端无需另写代码，但必须和后端一起改。**
- 无扩展名 `/i/<id>` 的现有语义：只对"保留了原片"的上传或 SVG 返回原图，否则 404 + 占位图（见 `.trellis/spec/picsur-backend/backend/image-api-contracts.md` §3.4 实测表）——视频直链应强制带扩展名。
- 公开页假设：详情页路由受 `Permission.ImageView` 保护（`frontend/src/app/routes/view/view.routing.module.ts:8-15`），元数据来自 `/i/meta/:id`；`index.html` 只有**站点级静态 OG 标签**（`frontend/src/index.html:27-33`），没有按媒体动态注入 OG/oEmbed → 分享到社交平台本来就没有单图/单视频预览。
- 公开直出路径只有后端 `/i/*`：CORS 与 30 天缓存中间件只作用于该前缀（`backend/src/app.module.ts:91-94`）。

### 5. i18n：双语词典静态打包，无自动对齐校验

- 词典文件：`frontend/src/assets/i18n/en.json`、`frontend/src/assets/i18n/zh.json`；被 `I18nService` 直接 import（`frontend/src/app/i18n/i18n.service.ts:5-7`），`instant()`（`:60-66`）+ `translate` pipe 使用；默认语言 zh（`:16`）。
- **实测 key 对齐**：用 python 展平两本词典比较，各 247 个叶子 key，无孤儿（`only en: []`、`only zh: []`）；两份文件的顶层分组行号完全一致（upload 88、images 97、view 126、download 173、processing 197 …）。
- 没有自动化 key 对齐脚本：`support/` 下无 i18n 检查（只有 gallery-layout-probe、visual-contrast-probe、regression-*.sh 等）。
- 现有相关 key 与位置（en/zh 行号相同）：

| 分组 | 行号 | 现有 key |
|---|---|---|
| `upload.*` | en.json:88-96 / zh.json:88-96 | title, dropHint, loginRequired, permissionRequired, clipboardEmpty, clipboardNoImages, clipboardImageError |
| `images.*` | 97-114 | loadFailed, empty, title, uploaded, expires, uploadedByYouAlt, deleteConfirmTitle, deleteConfirmDescription, deleted, downloaded, invalidLink, notFound, expired, updated, deleteFailedPermission, defaultAlt |
| `view.*` | 126-172 | imageFallbackName, uploadedBy, imageUrl, imageFormat, markdown, html, bbcode, rst, original, downloadTooltip, shareTooltip, customizeTooltip, editTooltip, deleteTooltip, customize.* |
| `download.*` | 173-177 | downloading, shareUnsupported, shareFailed |
| `processing.*` | 197-200 | title, noState |
| `common.*` | 21-42 | actions.retry/cancel/close/delete/edit/view..., copy, hide ... |

### 6. 依赖与构建：零视频依赖，原生 `<video>` 成本极低，海报接口不存在

- `frontend/package.json:18-49` 运行时依赖：Angular 21.2.x、Material 21.2.x、`@ngx-dropzone/cdk`（:33）、axios（:35）、picsur-shared（:42）、moment、rxjs、zod 等，**没有任何视频/转码/播放器库**；devDependencies（:50-67）也没有。
- 原生 `<video>` 成本：Angular 模板可直接写原生标签，**不需要新依赖、不需要新模块、bundle 增量约等于 0**；主要成本是模板分支、CSS 适配（`frontend/src/app/routes/view/view.component.scss:1-4` 的 `.uploadedimage` 可直接复用 max-width）和事件/属性（controls、playsinline、preload、poster）。
- CSP 是硬约束：`backend/src/security.ts:4-18` 的 CSP 只有 `default-src 'self'`、`img-src 'self' data: blob:`，**没有 `media-src`** → 媒体回落到 `default-src 'self'`，**同源 `/i/<id>.mp4` 可播；`blob:` 不在任何指令里，blob 视频会被拦**。另外 `crossOriginEmbedderPolicy: true` / `crossOriginResourcePolicy: true`（`:20,23`）意味着 COEP require-corp 下的同源子资源需要 CORP 头（helmet 默认会加），跨域/反代场景需实测。
- **海报/缩略图接口现状**：后端**没有专门的缩略图或海报端点**。图库缩略图就是实时图片派生 `GET /i/<id>.<imageext>?width=...&shrinkonly=yes`（前端 `images.component.ts:324-329`；后端 `image.controller.ts:93-122` → `ImageManagerService.getConverted` → sharp，`backend/src/managers/image/image.service.ts:172-212` 附近）。视频没有帧抽取能力，所以 **A 档没有海报可读；B 档需要后端新增海报（存为图片 derivative 或独立字段/端点），之后前端可直接复用 `GetImageURL` 读海报 URL**。
- `/api/info` 不暴露上传大小上限（`shared/src/dto/api/info.dto.ts:8-17` 只有 production/demo/version/host_override/tracking）→ 前端要做上传前大小预检，只能写死默认 128MB（与 `backend/src/config/early/multipart.config.service.ts:14-19` 的默认值一致）或请后端加字段。
- 构建/测试设施相关：Angular 构建预算 `frontend/angular.json:50-61`（initial 1mb warn / 2mb error，加播放器 UI 不构成压力）；图库布局探针 `support/gallery-layout-probe.cjs:56,139,545-546` 断言每个 `picsur-img` 内必须有 `canvas` 或 `img` —— 视频 tile 会打破该断言。

---

## A 档改动（能上传、图库能看到、详情能播、直链可用；不转码）

范围约束：不新增运行时依赖、不新增路由（复用 upload / processing / view）、不做客户端截帧。

| # | 文件 | 改动要点 | 规模 |
|---|---|---|---|
| A1 | `shared/src/dto/mimes.dto.ts`、`shared/src/util/parse-mime.ts` | 新增 VideoFileType（至少 mp4/webm）+ `SupportedFileTypeCategory.Video` + mime/ext 映射，使 `FileType2Ext('video:mp4')` 成功、`ParseFileType` 认识视频 | 小 |
| A2 | `shared/src/entities/image.entity.ts`（+ `image-manage.dto.ts` / `image.dto.ts`） | 让列表与详情能表达媒体类型。建议新增 `media_type` 或至少约定视频的 `source_filetype='video:*'`；列表页必须能不看详情就分支 | 小（跨包契约） |
| A3 | `frontend/src/app/routes/upload/upload.component.html` | `<input ... accept="image/*,video/mp4,video/webm">`；拖拽仍需前端预检（dropzone 不按 accept 过滤） | 小 |
| A4 | `frontend/src/app/routes/upload/upload.component.ts`（+ `dropzone/dropzone.component.ts`） | 选中/拖入后做客户端媒体类型 + 大小预检（大小常量与后端对齐），非图/视频给 i18n 错误；混合多文件明确"只处理第一个"并提示（保持现状语义） | 小 |
| A5 | `frontend/src/app/routes/processing/processing.component.ts/html` | 复用单文件上传；可选把 `ImageService.UploadImage` 改为暴露 `RunningRequest`，接 `uploadProgress` 显示百分比；错误区分"不支持的类型/文件过大" | 小-中 |
| A6 | `frontend/src/app/components/picsur-img/*`（或新建 `picsur-media` 组件） | 增加媒体类型输入：图片走现有逻辑；视频在详情页渲染 `<video controls playsinline preload="metadata" [src]>`；**不要走 blob/getBuffer**（CSP 无 media-src blob:） | 中 |
| A7 | `frontend/src/app/routes/images/images.component.ts/html/scss` | 按媒体类型分支：视频卡片跳过 `buildThumbUrl`（WebP 派生），改渲染占位 tile（`videocam` 图标）+ 文件名 + VIDEO 徽章；点击进详情；删除/分页/过期逻辑全部复用 | 中 |
| A8 | `frontend/src/app/routes/view/view.component.ts/html` | 详情页 video 分支：`<video controls playsinline preload="metadata">` + `<source src="/i/<id>.<ext>">`；格式下拉对视频隐藏（或只保留原始）；下载/复制链接按媒体分支；可选展示分辨率/时长（时长可从 `<video>` metadata 读，无需后端） | 中 |
| A9 | `frontend/src/app/services/api/image.service.ts`、`frontend/src/app/util/download-manager/download.service.ts` | 复制链接按媒体类型生成片段（source 直链 + markdown `[name](url)` + html `<video controls src>` + rst/bbcode）；下载文件名补视频扩展名；下载弹窗文件名不再写死 `'image'` | 小 |
| A10 | `frontend/src/assets/i18n/en.json` + `zh.json` | 新增 key 双写（清单见下），并把 upload/images/view 中"图片"文案改为"图片或视频"或按类型动态选择 | 小 |
| A11 | `support/gallery-layout-probe.cjs`（测试设施，非产品） | 探针断言每个 `picsur-img` 内有 canvas/img（:56,139,545-546）；视频 tile 需改探针或加显式豁免/可识别标记 | 小 |

A 档前端合计：约 8~10 个产品文件（含 1~2 个 shared 文件），粗估 400~700 行 diff，规模 **小**；无新依赖、无构建配置变更。前置依赖：后端能把视频原片存起来并直出（含 Range，见第 9 节风险 1/2）。

---

## B 档改动（转码 + 封面海报 + Range 流式播放）

前端增量（后端/部署的大头见 backend 调研，此处只列前端消费侧）：

| # | 文件 | 改动要点 |
|---|---|---|
| B1 | shared：`image.dto.ts` / `image.entity.ts` | `ImageMetaResponse.fileTypes` 增加 poster/thumb 变体（或 EImage 增加 `poster_filetype` / `poster_url`），并加时长等展示字段 |
| B2 | `frontend/src/app/routes/images/images.component.ts/html` | 用真海报替代占位 tile：`<img [src]="posterUrl">`（或 `<video poster>`）；可选悬停静音预览（成本高，不建议 MVP） |
| B3 | `frontend/src/app/routes/view/view.component.ts/html` | 播放器加 `[poster]`、时长显示、`preload=metadata`；可选"复制海报链接"入口 |
| B4 | `frontend/src/app/services/api/image.service.ts` | 海报 URL 构造（复用 `GetImageURL`/`GetImageURLCustomized`，如 `/i/<id>.webp?width=...`）；视频链接片段可扩展 `<source>` 多格式 |
| B5 | `frontend/src/app/routes/processing/processing.component.*` | 转码任务状态展示（提交后轮询/SSE），依赖后端任务模型设计 |
| B6 | i18n en/zh | 转码中/转码失败/时长/分辨率/封面等文案 |

B 档前端工作量：在 A 档基础上 **+3~4 个文件、约 100~250 行**，规模 **小-中**；B 档整体是**中-大**，但增量主要在 ffmpeg、海报生成/存储、Range/206 与部署（另见 backend 调研）。

---

## 新增 i18n key 清单（en / zh 双写，行号按当前文件）

> 原则：能改文案就改文案（`upload.dropHint` 等），确实需要新语义才加 key；两本词典必须同步。

| key | en | zh | 用途/位置 |
|---|---|---|---|
| `upload.unsupportedType` | "Only images and videos can be uploaded" | "只能上传图片或视频" | A4 客户端预检拒绝 |
| `upload.fileTooLarge` | "This file is too large, the limit is {{ size }}" | "文件过大，上限为 {{ size }}" | A4 大小预检 |
| `upload.videoTitle`（可选） | "Upload Image or Video" | "上传图片或视频" | 若不想改 `upload.title` 则新增此 key |
| `images.videoBadge` | "VIDEO" | "视频" | A7 图库视频徽章 |
| `images.videoAlt` | "Video uploaded by you" | "由您上传的视频" | A7 tile 的 alt/aria-label |
| `images.playVideo` | "Play video" | "播放视频" | A7/A8 按钮/链接 |
| `images.videoFallbackName`（可选） | "video" | "视频" | 无文件名时的后备名 |
| `view.videoUrl` | "Video URL" | "视频 URL" | A8 直链 copy-field 标签 |
| `view.videoEmbed` | "Video embed" | "视频嵌入代码" | A8 HTML 片段标签（复用 `view.html` 也可） |
| `view.videoFormat`（可选） | "Video Format" | "视频格式" | A8 若有格式下拉 |
| `view.downloadVideo` | "Download the video" | "下载视频" | A8 下载按钮 tooltip |
| `view.shareVideo` | "Share video" | "分享视频" | A8 分享按钮 tooltip |
| `view.videoFallbackName` | "video" | "视频" | 无文件名时的标题后备 |
| `view.noPreview` | "Preview not available" | "暂无预览" | 播放失败/不支持编解码时的兜底 |
| `processing.uploading`（可选） | "Uploading {{ percent }}%" | "上传中 {{ percent }}%" | A5 进度展示 |
| `processing.videoUnsupported`（可选） | "This video format is not supported" | "不支持该视频格式" | A5 后端拒绝的错误映射 |

注意：`view.markdown/html/bbcode/rst` 四个标签文案可复用（片段内容按媒体类型变），但 `view.downloadTooltip/shareTooltip` 是写死"image"的，要么按媒体类型切换 key，要么统一改成中性文案。

---

## 风险与不确定项

1. **后端契约未定（最大不确定）**："直链可用"依赖后端如何存视频（master/original 关系）以及 `/i/<id>.mp4` 是否直出原片。无扩展名 `/i/<id>` 现有语义是"只对保留原片的上传返回原图"（`.trellis/spec/picsur-backend/backend/image-api-contracts.md` §3.4），视频必须带扩展名直链；前端在 A1 之后能构造，但需后端配合实现。
2. **Range/206 缺失**：后端代码 `grep Range` 0 命中，`/i/*` 直接返回完整 Buffer（`backend/src/routes/image/image.controller.ts:93-138`）。`<video>` 能开始播，但拖动进度条、大文件起播、iOS Safari 行为都会受影响 —— 这是 A 档"能播"的隐性前提，属后端/反代范畴，前端应在验收中显式测。
3. **CSP 约束**：`backend/src/security.ts:4-18` 无 `media-src`，回落 `default-src 'self'`；同源直链可播，**blob: 不可用**（+ `img-src` 才有 blob）。若 B 档要自定义播放器/切片预览，需要后端补 `media-src`。
4. **COEP/CORP 未实测**：`crossOriginEmbedderPolicy: true` + `crossOriginResourcePolicy: true`（`security.ts:20,23`）在跨域/反代场景下，视频子资源需要正确 CORP 头；本机未起服务实测，标为不确定项。
5. **大小校验口径漂移**：`/api/info` 不暴露上限，前端若写死 128MB 会与 `PICSUR_MAX_FILE_SIZE` 配置脱节；建议后端在 `/api/info` 增加 `maxUploadBytes`（跨包改动，A2 一起做）。
6. **A 档没有封面**：A 档图库只能占位 tile。可行的低成本替代：客户端上传时用 `<video>`+canvas 截一帧作 poster —— 但需要后端存储海报字段/接口，实际已进入 B 档范围；`<video preload="metadata">` 直接当缩略图在无 Range 的后端上可能拉全片，不建议。
7. **数据类型语义**：用 `source_filetype` 承载视频类型是权宜（语义是"上传时的图片格式"，且历史行可能为 null）；建议 A2 明确 `media_type` 字段，否则图库分支依赖脆弱约定。
8. **移动端/编解码**：iOS Safari 需要 `playsinline`（已在方案中）；HEVC/AV1 等编码的浏览器支持差异大，A 档只能承诺"浏览器原生能解的容器/编码"；错误时应落到 `view.noPreview` 而不是坏图。
9. **测试设施**：`support/gallery-layout-probe.cjs:56,139,545-546` 断言每个卡片有 canvas/img，视频 tile 会失败；`support/visual-contrast-probe.cjs` 的路由清单可能需补视频场景；i18n 无自动对齐脚本。
10. **依赖源码证据**：`accept` 默认 `'*'`、拖拽不按 accept 过滤的结论来自 `frontend/node_modules/@ngx-dropzone/cdk/fesm2022/ngx-dropzone-cdk.mjs`（依赖实现，非仓库代码），升级依赖后需复验。
11. **未验证项**：真实视频文件在当前栈的上传/播放表现（本任务只读，未起服务、未上传测试文件）；大文件上传的浏览器/网络超时行为；`<video>` 在 helmet 全量头（COOP/COEP/HSTS）下的实际行为。

---

## 建议 MVP 范围

**推荐先做 A 档最小闭环（前端 shrunk 版）**，不转码、不做封面、不做多文件：

1. **契约先行**（A1 + A2，与后端一起定）：shared 加视频 mime/ext/category；EImage/ImageMetaResponse 能表达"这是视频"（建议 `media_type`；过渡方案约定 `source_filetype` 视频前缀）。
2. **上传**（A3 + A4）：加 `accept`，客户端做类型 + 大小预检（大小常量与后端默认 128MB 对齐，或等后端 `/api/info` 暴露上限），错误走 i18n。
3. **图库**（A7 + A6 的图片分支不动）：视频卡片渲染占位 tile + VIDEO 徽章 + 文件名/时间；不进 WebP 派生；点击进详情。
4. **详情页**（A8）：原生 `<video controls playsinline preload="metadata" [src]="/i/<id>.mp4">`；隐藏图片格式下拉；下载/分享按媒体分支；失败兜底文案。
5. **链接与下载**（A9）：source 用带扩展名直链，html 片段给 `<video controls src>`，markdown 给普通链接（避免 `![]` 把视频当图片）；下载文件名带 `.mp4`。
6. **i18n**（A10）：上表 key 双写 + 现有"图片"文案按媒体动态/中性化。
7. **验收**：上传 mp4 → 图库出现带"视频"标记的卡片 → 详情页可播放/暂停/拖动（拖动依赖后端 Range）→ 复制直链在无登录窗口能打开 → 手机 Safari 内联播放不自动全屏。
8. **明确不做**：转码、封面海报、时长展示、客户端截帧、多文件批量、HLS/DASH、自定义播放器控件。

**可直接转 implement 的前端任务拆分（建议粒度）**

| 任务 | 内容 | 依赖 |
|---|---|---|
| F1 | shared：视频 FileType/Category/Mime/Ext + EImage 媒体类型字段（契约评审后落） | 后端契约 |
| F2 | upload：accept + 客户端类型/大小预检 + 错误文案 | F1 |
| F3 | gallery：媒体分支 + 视频占位 tile + 徽章 | F1 |
| F4 | view：视频播放器 + 下载/复制链接分支 | F1、F3 |
| F5 | i18n：en/zh 新 key 与文案中性化（人工核对两份文件） | 无 |
| F6 | 测试设施：gallery 探针适配视频 tile | F3 |
| F7 | 联调验收：Range、CSP/CORP、Safari 内联播放、大文件超时 | 后端/部署 |

**Related Specs**

- `.trellis/spec/picsur-frontend/frontend/index.md` — Pre-Development Checklist：i18n 双词典必须同步、Node 20 构建、异步状态手动触发渲染、替身组件约定。
- `.trellis/spec/picsur-backend/backend/image-api-contracts.md` — `/i/:id` 与 `/i/:id.:ext` 语义、无扩展名/已删除/占位图实测行为、`POST /api/image/upload` 字段与返回。
- `.trellis/spec/picsur-backend/backend/build-and-deploy.md` — 前端产物由 backend 托管、Node 20 + pnpm 9.6 构建约束。

**复现用只读命令（本报告证据来源）**

```bash
grep -rni video backend/src frontend/src shared docs README.md     # 0 命中
grep -rn "accept=\|multiple" --include=*.html frontend/src          # 仅设置页 name-multiple
grep -rn "ImageFileType\|SupportedFileTypes\|ParseFileType" --include=*.ts frontend/src/app
grep -rn "uploadProgress" --include=*.ts frontend/src/app           # 仅 api.service 自身
grep -rn "Range" --include=*.ts backend/src                         # 0 命中
grep -rn "embed\|oembed\|iframe" --include=*.ts --include=*.html backend/src frontend/src shared
python3 - <<'PY'  # 展开两本词典比较 key 集合（247 vs 247，无差异）
PY
nl -ba frontend/src/assets/i18n/en.json | sed -n '88,200p'
```
