# 技术设计：视频上传与直链（A 档）

## 1. 范围与原则

- 用户决策：A 档，只上传与直链。不做 Range 与 206、不做内嵌播放器、不做转码与海报。
- 允许容器：`video:mp4` 与 `video:webm`；其余视频容器明确拒绝为 4xx。
- 存储：沿用 Postgres bytea 与 `/data` 备份模型；视频原片即 master，不额外存 original。
- 兼容：不新增字段，视频识别沿用 `source_filetype` 前缀；回滚只需回退代码与镜像。
- 复用：图片上传、列表、删除、权限、限流、缓存头全部沿用现有实现。

## 2. 契约变更（shared）

| 文件 | 变更 |
|---|---|
| `shared/src/dto/mimes.dto.ts` | 新增 `VideoFileType { MP4='video:mp4', WEBM='video:webm' }`、`SupportedVideoFileTypes`、`SupportedFileTypeCategory.Video`；`SupportedFileTypes` 合并三类；`FileType2MimeMap` 增加 `video/mp4`、`video/webm`；`FileType2ExtMap` 增加 `mp4`、`webm`；新增 `MediaKindOfFileType(category)` 纯函数 |
| `shared/src/util/parse-mime.ts` | `ParseFileType` 增加 Video 分支；`ParseExt2FileType` 与 `ParseMime2FileType` 自动获得视频能力 |
| `shared/src/entities/image.entity.ts` | 不改；视频识别用既有 `source_filetype` 的 `video:` 前缀，无新字段 |
| `shared/src/dto/image-links.class.ts` | 不改结构；视频由前端按媒体类型填不同取值 |

注意：`Mime2FileType` 反查顺序里 `image/webp` 与 `anim:webp` 的歧义由上传路径的 WebPInfo 特判处理，新增视频 mime 不产生歧义。

## 3. 后端

### 3.1 数据模型

- **零迁移**：不新增列、不改实体、不改迁移、不改 `image-db.service.create()` 签名。
- 视频识别以既有字段为准：`source_filetype` 为 `video:mp4` 或 `video:webm`；`/i/meta/:id` 的 `fileTypes.master` 同样是 `video:` 前缀。
- 语义约定：`source_filetype` 为 null 或 `image:`/`anim:` 前缀即图片；前端判定统一封装成 `isVideo()`，便于后续加列时只改一处。

### 3.2 上传

1. `image-processor.service.ts` 增加 Video 分支，`processVideo` 直接返回 `{ image, filetype: filetype.identifier }`，不调用 sharp、不产生宽高。
2. `image.service.ts` 的 `upload`：
   - 保持先魔数识别与 SVG 清洗顺序；
   - `keepOriginal && category !== Video` 才写 original，避免视频双份存储；
   - 写入 `source_filetype` 为视频标识、宽高为 null。
3. `image.service.ts` 的 `getFileTypeFromBuffer`：`Mime2FileType` 失败时返回 `FT.UsrValidation` 而非原样内部错误，保证 mov/mkv 等返回 400。
4. 上传接口、权限、限流、multipart 限制均不改；`PICSUR_MAX_FILE_SIZE` 默认 128MB 沿用。

### 3.3 转换与读取

- `image.service.getConverted`：
  - 目标类型是视频且 master 不是视频，或目标不是视频而 master 是视频：返回 `FT.UsrValidation` 加明确 message；
  - 两者都是视频时必须同 identifier，直接返回 master 数据，不写派生表、不进入 sharp；
  - 视频忽略编辑参数。
- `image.controller`：
  - GET/HEAD 对视频不再调用 `getConverted`，改为取 master 文件：`Content-Type` 用 `FileType2Mime`、`X-Content-Type-Options: nosniff`、状态 200、正文为原片字节；缓存头继续由 `app.module.ts` 的 `/i/*` 中间件给 30 天。
  - HEAD 只设头不返回正文；`Content-Length` 用 `octet_length(data)` 查询，避免为 HEAD 加载整段字节。
  - 无扩展名 `/i/:id` 的 master 回退条件从「master 是 SVG」扩展为「master 是 SVG 或视频」，抽取 `isVerbatimMaster(filetype)` 判定；这样视频直链不带扩展名也能打开。
  - 视频分支不设置 SVG 的 CSP；`setNotFoundHeaders` 与 404 语义不变。
  - 不做任何 Range、206、`Accept-Ranges`、`Content-Range` 处理。
- `image-file-db.service.ts` 新增 `getFileSize(imageId, variant)`：用 `octet_length(data)` 查询返回字节数，供 HEAD 使用；GET 直接复用现有 `getFile`。

### 3.4 列表与元数据

- 列表、详情与 `/i/meta/:id` 不新增字段，继续返回既有 `source_filetype` 与 `fileTypes`；视频即 `video:mp4` / `video:webm` 前缀值。
- 不新增筛选接口、不加索引、不做类型查询。

### 3.5 安全与错误

- 视频响应加 nosniff；不放宽 CSP，不新增 `media-src`，因为不使用 blob 与播放器。
- 非白名单视频容器返回 400 `usrvalidation`，超限仍 413。
- 无出网、无外部依赖、无镜像变更。

## 4. 前端

### 4.1 上传页

- `upload.component.html` 的 `<input>` 增加 `[accept]`，取值由 `SupportedFileTypes` 映射为 mime 生成，避免写死。
- `upload.component.ts` 在 `onFileChange` 与 `onPaste` 入口做类型预检：`ParseExt2FileType` 或 `ParseMime2FileType` 失败时提示 `upload.unsupportedType` 并中止；拖放与粘贴不依赖 accept。
- 不新增大小预检，避免与后端配置漂移；超限仍由后端 413 加错误提示承担。

### 4.2 图库

- `images.component.ts` 增加 `isVideo(image)`：按 `source_filetype` 的 `video:` 前缀判定。
- 模板按媒体类型分叉：图片继续 `picsur-img` 与 WebP 派生；视频渲染 `div.video-thumb` 占位块，含播放图标、`images.videoBadge` 徽章、`data-media-kind="video"` 便于探针定位。
- 不改变卡片尺寸与网格布局，避免探针基线漂移。

### 4.3 详情页

- 视频不渲染播放器：预览区替换为占位面板，含 VIDEO 徽章、文件名提示与 `view.videoNotice` 文案，说明可复制直链或下载。
- 隐藏格式下拉与自定义按钮；`previewLink` 对视频返回带扩展名的直链。
- 复制框四类片段按媒体类型生成：source 直链、markdown 普通链接、html 用 `<video controls playsinline src="...">`、bbcode 用 `[url]`，rst 用普通 URL；图片模板不变。
- 下载按钮传入 `file_name`，下载文件名带正确扩展名；分享链接仍可用。

### 4.4 格式下拉与下载

- `util.service.ts` 的 `getBaseFormatOptions` 过滤掉 Video 类别，避免图片详情页出现 MP4、WEBM 选项。
- `download.service.ts` 的默认文件名从写死 `'image'` 改为接收调用方传入的名字；`shareFile` 依赖 content-type 解析扩展名，shared 扩集后自动给出 `.mp4`、`.webm`。

### 4.5 i18n

- 修改 8 条既有文案为中性表述：上传标题与提示、剪贴板提示、图库 alt 与删除确认、详情页 URL 与下载/分享 tooltip。
- 新增：`upload.unsupportedType`、`images.videoBadge`、`view.videoNotice`，如需进度再加 `processing.uploadingPercent`。
- en 与 zh 两份词典逐键对齐，插入后以脚本校验键集合相等。

## 5. 兼容、回滚与已知限制

- 回滚：没有数据库变更，回滚只需回退代码与镜像。回滚到旧版本后，视频在旧前端会显示坏图，读取接口会按未知类型返回占位图，需要回滚时提前导出视频直链。
- 混合版本：新旧版本之间没有新字段依赖，识别只看既有 `source_filetype`，不需要兼容分支。
- 已知限制：没有 Range，浏览器与下载器只能整段获取；没有播放器 UI，详情页只提供直链与下载；没有转码，编码不兼容的文件能上传但只能在外部播放器尝试。
- 内存与备份：128MB 上限下上传峰值约 2 倍文件体积，视频入库会放大数据库与备份体积，写入文档与发布说明。

## 6. 测试与验收

| 门 | 方式 | 通过标准 |
|---|---|---|
| 构建 | `pnpm --filter picsur-shared build`、backend、frontend | 三包通过 |
| 图片回归 | `bash support/regression-image-api.sh <base> <pwd>` | 34 项全绿，行为不变 |
| 视频冒烟 | 新增脚本或回归增量 | 上传 mp4/webm、GET 带扩展名、GET 无扩展名、HEAD、列表识别、删除后 404、mov 400、超限 413 |
| 字节一致 | `curl` 下载与上传文件 `sha256sum` | 完全一致 |
| 前端手动 | 上传页、图库、详情页、复制框、下载 | 无坏图，直链与下载可用，图片流程不回归 |
| i18n | 键集合脚本 | en / zh 缺失集合为空且计数相等 |
| 探针 | `support/gallery-layout-probe.cjs` | 视频卡片按 `data-media-kind` 跳过图片断言，图片卡片结果不变 |

## 7. 风险

| 风险 | 缓解 |
|---|---|
| 上传全内存路径导致内存峰值 | 沿用 128MB 上限，文档写明；后续可调小 env |
| mov 等容器识别后返回 400 的边界 | 上传时统一转 usrvalidation；回归覆盖负例 |
| 图库视频卡片破坏布局探针 | 显式 `data-media-kind` 标记并适配探针 |
| 旧前端缓存遇新字段 | 新字段可为空，旧前端不读；新前端双判兜底 |
| 视频入库放大备份 | 文档与发布说明标注，必要时提示用户调低上限 |
