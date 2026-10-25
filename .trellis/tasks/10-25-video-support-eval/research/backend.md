# Research: 视频上传支持 — 后端（Picsur）

- Query: 评估 Picsur 后端把「视频上传」纳入支持范围需要改什么；区分 A 档（存原片直出、不转码）与 B 档（转码 + 封面海报 + Range 流式播放）。
- Scope: internal（后端为主，引用必要的 shared 契约与前端证据，用于说明接口影响；前端/部署的完整结论归其它调研文件）
- Date: 2026-10-25
- 方法: **只读静态分析**。读了源码/规格/依赖实现，跑了只读命令（`git grep`、`grep`、`ls`、`wc`、`sed`）。**没有**启动实例、跑回归、装依赖、改代码。因此「运行时行为」类结论标为静态推断，见「风险与不确定项」。

---

## 结论

1. **现状定性**：Picsur 后端是一条**严格的图片管线**。上传把整个文件读进内存 `Buffer`（`image-manage.controller.ts:69-75`），用 `file-type` 魔数识别，再对照 shared 的 image/anim 白名单；随后 sharp 转成内部 master（静态图 QOI、动图 WEBP），最后全部写进 **Postgres 的 bytea 列**（`e_image_file_backend` / `e_image_derivative_backend`），**没有文件系统存储、没有流式、没有 Range、没有 ETag，也没有 ffmpeg**。
2. **今天上传 mp4 会怎样**：`file-type` 能识别 mp4/webm/mov（依赖证据见 §2.1），但白名单映射 `Mime2FileType` 对 `video/mp4` 返回 `FT.Internal`（`shared/src/dto/mimes.dto.ts:68-75`），异常过滤器把 Internal 映射成 **500**（`shared/src/types/failable.ts:45-49`）。所以现状是 **500「An internal error occurred」，不是 400**（静态推断，建议实测确认）。超过 `PICSUR_MAX_FILE_SIZE`（默认 128,000,000 B）才是 **413**（`upload-error.ts:20-26` + `failable.ts:75-79`）。
3. **A 档（存原片、不转码、直出）**：**可行，后端量级小—中**。约 6–9 个文件、百行级改动、**零新依赖、无需动 Docker**。核心是：shared 增加 video 类型与分类 → 上传路径绕开 sharp（原片直接作为 master）→ 读取路径绕开实时转换（`/i/:id.ext` 直出、无扩展名回退到 video master）。主要代价不在功能，而在**模型假设**：整段视频进内存、无法生成封面、没有 Range（浏览器跳播/Safari 兼容性差）。
4. **B 档（转码 + 封面 + Range）**：**不是小改，是新建一个媒体子系统，量级大**。需要：ffmpeg/ffprobe 进镜像、异步任务与状态（项目里**没有**任何队列/后台任务基础设施，`RedisConfigService` 只有配置、无人使用）、转码产物与任务的新数据模型、Range 206 响应、以及最关键的一个架构决策——**视频继续放 Postgres bytea，还是改为文件系统/对象存储**。当前 bytea + 整文件 Buffer 的读取模型无法真正流式。
5. **判断门槛的四条硬约束**（都来自代码，不是猜测）：
   - ① 上传是 `file.toBuffer()` 的**全内存**路径（`image-manage.controller.ts:69-75`；`@fastify/multipart` 的 `toBuffer` 实现也是纯内存）；
   - ② 二进制全部存 **Postgres bytea**（`image-file.entity.ts:40-42`、`image-derivative.entity.ts:46-48`）；
   - ③ mime 白名单只有 **image / anim 两类**（`shared/src/dto/mimes.dto.ts:4-37`）；
   - ④ 读取端一次性返回**完整 Buffer**（`image.controller.ts:100`），无 Range/流式（全仓库 grep 无 `Accept-Ranges`/`Content-Range`/`ETag`）。
6. **建议**：先做 A 档（或先做 A 档 + 一张数据模型迁移），B 档单独立项。若目标只是「图床能顺手收小视频、给直链」，A 足够且性价比高；若要「像视频站一样拖动播放、封面、兼容 mkv/mov」，B 是数周级的子系统，且 A 档限制（无 Range、无海报）会先暴露给用户。

---

## 现状速查（Files Found）

| 文件 | 作用 |
|---|---|
| `backend/src/routes/image/image-manage.controller.ts` | 上传/列表/删除等入口；`POST /api/image/upload` 在此 |
| `backend/src/decorators/multipart/postfiles.pipe.ts`、`postfile.pipe.ts` | multipart 解析与 limits 注入 |
| `backend/src/config/early/multipart.config.service.ts` | `PICSUR_MAX_FILE_SIZE` 与 busboy limits |
| `backend/src/managers/image/image.service.ts` | 上传主流程、魔数识别、读取/实时转换、original/master 语义 |
| `backend/src/managers/image/image-processor.service.ts` | 按 category 选择 master 产出（QOI / WEBP） |
| `backend/src/managers/image/image-converter.service.ts` | sharp 转换（worker 调用、像素上限、超时/内存预算） |
| `backend/src/workers/sharp.wrapper.ts` + `sharp/sharp.worker.ts` | 每次转换 fork 一个子进程，带 timeout / setrlimit |
| `backend/src/routes/image/image.controller.ts` | `GET/HEAD /i/:id`、`/i/:id.:ext`、`/i/meta/:id` 的响应与 Content-Type |
| `backend/src/app.module.ts` | `/i/*` 的 CORS + 30 天 Cache-Control 中间件 |
| `backend/src/database/entities/images/{image,image-file,image-derivative}.entity.ts` | 三张表：元数据 / 原片·master bytea / 派生图 bytea |
| `backend/src/database/migrations/index.ts` | 迁移注册表（启动自动跑） |
| `shared/src/dto/mimes.dto.ts`、`shared/src/util/parse-mime.ts` | 允许格式白名单、mime/扩展名映射、分类 |
| `shared/src/entities/image.entity.ts` | `EImage` 响应契约（zod），上传/列表/详情共用 |
| `backend/src/config/early/type-orm.config.service.ts` | `migrationsRun: true`，生产靠迁移建列 |
| `.trellis/spec/picsur-backend/backend/image-api-contracts.md` | 已实测的 HTTP 契约（含缓存/404/编码坑），本次大量交叉验证 |

---

## 1. 上传链路（Q1）

### 1.1 路由定义

- `POST /api/image/upload`：`backend/src/routes/image/image-manage.controller.ts:58-90`。
  - 需要 `Permission.ImageUpload`（`:59`；权限枚举 `shared/src/dto/permissions.enum.ts:7`），限流 `EasyThrottle(20)` = 20 次/分钟（`:61`，装饰器语义见 `backend/src/decorators/easy-throttle.decorator.ts:12-20`）；全局另有 60 次/分钟（`backend/src/layers/PicsurLayers.module.ts:10-20`）。
  - 函数签名只取第一个文件：`@PostFiles(1) multipart: FileIterator`（`:63`），`GetNextAsync` 拿首项（`:67`，`backend/src/util/iterator.ts:3-9`）。
- 路由前缀推导：`@Controller('api/image')`（`image-manage.controller.ts:49`）；`GET /i/*` 是另一个控制器（`image.controller.ts:50`）。

### 1.2 multipart 解析与大小限制

- 注册：`backend/src/main.ts:33` `fastifyAdapter.register(multipart)`，**没有 options**。
- 每次请求在 pipe 里注入 limits：
  - `@PostFiles(n)` → `MultiPartPipe.transform`：`request.files({ limits: multipartConfig.getLimits(filesLimit) })`（`backend/src/decorators/multipart/postfiles.pipe.ts:17-27`）。
  - `getLimits`（`backend/src/config/early/multipart.config.service.ts:21-29`）：`fieldNameSize:128`、`fieldSize:1024`、`fields:20`、`files: fileLimit ?? 20`（上传路由传 1）、`fileSize: getMaxFileSize()`。
  - `getMaxFileSize` = `PICSUR_MAX_FILE_SIZE`，默认 `128000000`（同文件 `:14-19`；`.env.example:28`；all-in-one 镜像 ENV 同值 `Dockerfile.allinone:61`）。
- **fastify `bodyLimit` 的实际作用**：Fastify 5 默认 1 MiB（`node_modules/.pnpm/fastify@5.12.5/node_modules/fastify/lib/config-validator.js:1265`），但它只作用于会缓冲的默认 content-type parser；`@fastify/multipart` 用 `addContentTypeParser('multipart/form-data', setMultipart)` 接管请求流（`node_modules/.pnpm/@fastify+multipart@10.1.3/node_modules/@fastify/multipart/index.js:184`），文件大小由 busboy 的 `fileSize` 限制。
  - 插件未传 options 时 `fileSize` 会退回 `fastify.initialConfig.bodyLimit`（即 1 MiB，`index.js:50-53`）；本项目**每次请求都显式传 limits**，而每请求 options 会与插件 options 做 deepmerge 覆盖（`index.js:259-263`），因此实际生效的是 `PICSUR_MAX_FILE_SIZE`（128 MB），**不是** 1 MiB。结论：调视频上限只需改 env，不必动 Fastify `bodyLimit`；但若以后有调用方漏传 limits，会静默退回 1 MiB。
- 解析顺序：`MultiPartPipe` 只返回异步迭代器（`postfiles.pipe.ts:17-27`），真正的读取发生在控制器 `file.toBuffer()`（`image-manage.controller.ts:69-75`）。`toBuffer()` 把分片收集到数组再 `Buffer.concat`，**纯内存、无临时文件**（依赖实现 `index.js:385-421`）。

### 1.3 临时文件

- **没有临时文件**。控制器直接 `toBuffer()`（`image-manage.controller.ts:69-75`），后端源码里没有 `fs.writeFile`/`createWriteStream`/`tmpdir` 的使用（grep 未命中）；`@fastify/multipart` 的磁盘档模式（`saveRequestFiles` / `tmpUploads`）在本项目**未被调用**；`Dockerfile:162` 的注释也明确「应用只写数据库与 /tmp（上传内容存 Postgres，不落盘）」。
- 对视频的含义：上传大小受内存而非磁盘约束；A 档可以沿用此路径（但要评估 128 MB × 并发时的内存峰值），B 档若引入 ffmpeg，需要额外决定用内存管道还是临时文件（mp4 输出通常需要可 seek 的临时文件）。

### 1.4 校验顺序（完整顺序）

1. multipart 解析 + 边收边计税的大小限制（limits）；
2. `file.toBuffer()` 完成（超限在此抛错）；
3. 空文件检查 → 400（`image-manage.controller.ts:76-78`）；
4. `ImageManagerService.upload()`：**魔数识别**（`image.service.ts:106`，详见 §2）→ SVG 净化（`:109-118`）→ 读 keep-original 偏好（`:121-125`）→ **sharp 转 master**（`:128-132`）→ 去掉文件名扩展名（`:134-139`）→ 写 image 行（`:142-149`）→ 写 master 文件行（`:151-157`）→ 可选写 original 文件行（`:159-167`）。
- 要点：**大小限制先于格式校验**；格式校验必须等整个 Buffer 到手（不是流式探测）。对 B 档意味着 ffprobe 只能在上传完成后做，若想「早拒」需要先落临时文件或先 probe 前若干字节。

### 1.5 超过限制时返回什么错误

| 场景 | 结果 | 证据 |
|---|---|---|
| 文件超过 `PICSUR_MAX_FILE_SIZE` | busboy 抛 `RequestFileTooLargeError`（code `FST_REQ_FILE_TOO_LARGE`，依赖定义 `index.js:24`；`toBuffer` 抛出点 `index.js:390-404`）；`MapUploadError` → `FT.PayloadTooLarge` → **HTTP 413** | `image-manage.controller.ts:69-75`；`upload-error.ts:20-26`；`failable.ts:75-79` |
| 文件数/字段数超限 | `FST_FILES_LIMIT` / `FST_PARTS_LIMIT` / `FST_FIELDS_LIMIT` → `FT.UsrValidation` → **400** | `upload-error.ts:27-34` |
| 非 multipart 请求 | `FT.UsrValidation` → **400**（`'Invalid files'`） | `postfiles.pipe.ts:20` |
| 空文件 | **400** `'The uploaded file is empty'` | `image-manage.controller.ts:76-78` |
| 上传中断 | **400** `'The upload was interrupted'` | `upload-error.ts:42-47` |
| 缺文件（无 part） | `FT.BadRequest` → **400** | `iterator.ts:3-9` |
| 响应格式 | 错误也是统一信封 `{success:false,statusCode,timestamp,timeMs,data:{type,message}}`，且错误响应强制 `Cache-Control: no-store` | `exception.filter.ts:51-69` |

- 注意：上传成功是 **201**（Nest `@Post` 默认；规格实测记录 `image-api-contracts.md:121`），响应体是 `EImage`（+ 可选 `delete_key`，见 `shared/src/dto/api/image-manage.dto.ts:11-18`）。
- 一个**潜在坑**：`PostFilePipe`（单文件版）把 `toBuffer()` 的异常统一包成 `FT.Internal` → 500（`backend/src/decorators/multipart/postfile.pipe.ts:40-45`）。本次 grep 确认 `PostFile()` **当前没有调用点**（只有 `multipart.decorator.ts:5` 的定义），上传路由用的是 `PostFiles`。若将来把视频上传改成 `@PostFile()`，超限会变成 500 而不是 413，务必避开。

---

## 2. 格式校验（Q2）

### 2.1 mime / 魔数检测在哪

- `ImageManagerService.getFileTypeFromBuffer()`：`backend/src/managers/image/image.service.ts:359-402`。
  - `file-type` 的 `fileTypeFromBuffer(image)`（`:360-361`；依赖版本 `backend/package.json:43` = `^21.3.4`）。
  - file-type 不认 QOI → 用 `qoi-img` 的 `IsQOI` 补（`:365`；`backend/package.json:58` = `^2.2.0`）。
  - file-type 不认 SVG → 用 `is-svg` 文本判定补（`:367`；XML 被识别为 `application/xml` 时再兜底，`:370-376`）。
  - 识别不出（undefined）→ `FT.UsrValidation` `'Unsupported or unrecognized image format'` → **400**（`:379-387`）。
  - WebP 再判动图/静图（`WebPInfo`，`:389-394`），其余走 `Mime2FileType`（`:395-399`）。
- **关键**：`file-type@21.3.4` 能识别常见视频容器，例如 `video/webm`（`node_modules/.pnpm/file-type@21.3.4/node_modules/file-type/core.js:1654`）、`video/quicktime`（`:2129`）、`video/mp4`（`:2157-2181`）。所以视频文件**能通过魔数识别**，卡住的是下一步的白名单。

### 2.2 允许格式白名单定义在哪

- `shared/src/dto/mimes.dto.ts`：
  - `ImageFileType`：QOI/JPEG/PNG/WEBP/SVG/TIFF/AVIF/HEIF/JXL/JP2/BMP（`:4-17`）；
  - `AnimFileType`：GIF/WEBP（`:19-23`）；
  - `SupportedImageFileTypes` / `SupportedAnimFileTypes` / `SupportedFileTypes`（`:27-32`）；
  - 分类枚举只有 `Image` / `Animation`（`:34-37`）；
  - mime 映射 `FileType2MimeMap`（`:48-66`）、扩展名映射 `FileType2ExtMap`（`:85-103`）；
  - `Mime2FileType`（`:68-75`）与 `FileType2Mime`（`:76-81`）**未命中时返回 `FT.Internal`**（`:72-74`/`:78-80`）；`Ext2FileType`/`FileType2Ext` 同理（`:105-117`，未命中 `FT.Internal`）。
- `shared/src/util/parse-mime.ts:11-34`：`ParseFileType` 只认 `SupportedImageFileTypes` / `SupportedAnimFileTypes` 两个集合，其余 `FT.UsrValidation`。

### 2.3 拒绝策略（现状）

- 视频（mp4/webm/mov 等）的拒绝发生在：魔数成功 → `Mime2FileType('video/mp4')` 未命中 → `FT.Internal`（`mimes.dto.ts:72-74`）→ 由 `image.service.ts:395-399` 原样返回 → `ThrowIfFailed` 抛出 → 异常过滤器 → **500**（`failable.ts:45-49`、`exception.filter.ts:29-70`）。**这是「非图片只能得到 500」的精确位置**，也是 A 档必须改的第一处。
- 随机字节/损坏文件（file-type undefined）：**400**（`image.service.ts:379-387`）。
- 注：`image-category` 之外的类别在 `ImageProcessorService.process()` 里还有一道兜底（`image-processor.service.ts:31-33`，`FT.SysValidation` → 500）。即便有人只往白名单加视频 mime、忘了加 category 分支，也会落到这里继续 500。

### 2.4 前端 accept 是否与后端同源

- **前端没有 accept 约束**：`frontend/src/app/routes/upload/upload.component.html:3` 是裸 `<input type="file" fileInput [formControl]="fileControl">`；`FileInputDirective` 来自 `@ngx-dropzone/cdk`（`frontend/src/app/routes/upload/upload.module.ts:4,20-21`），**没有 `accept` 属性**；选文件后不做类型判断，直接跳 `/processing` 上传（`upload.component.ts:24,38-43`；`processing.component.ts:35-39`）。拖拽/粘贴同样只按 `kind === 'file'` 过滤（`upload.component.ts:56-63`）。
- 唯一的「同源」是**转码目标格式列表**：前端的格式下拉用 shared 的 `SupportedFileTypes` + `FileType2Ext` 生成（`frontend/src/app/util/util.service.ts:36-65`），`GET /api/info/formats` 也由 shared 枚举生成（`backend/src/routes/api/info/info.controller.ts:60-78`）。也就是说：白名单是单一事实源，但**上传入口本身不限类型**，用户选什么都会先上传、再由后端拒绝。
- 对视频的含义：A 档如果只改后端白名单而不改前端，用户仍可选中视频并上传，后端开始接受；前端需要另一路改动（上传提示/accept/`<video>` 渲染，见 §6 与前端调研）。另外 `frontend/src/app/components/picsur-img/picsur-img.component.ts` 的渲染路径是 `HEAD` 取 content-type（`:181-193`）→ 非 QOI 时 `api.getBuffer` 拉整段字节 → `Blob` + `<img>`（`:130-172`）；视频字节进 `<img>` 不会显示，A 档前端必须走原生 `<video src>` 而不是这条 Buffer 路径。

---

## 3. 存储与读取（Q3）

### 3.1 落盘路径 / 扩展名规则

- **没有文件落盘，也没有按扩展名存文件**。二进制都在 Postgres：
  - `e_image_file_backend`：`image_id` + `variant`（original/master/ingest）+ `filetype` + `data bytea`（实体 `backend/src/database/entities/images/image-file.entity.ts:13-42`；建表 `backend/src/database/migrations/1661692206479-V_0_3_0_a.ts:17`）；
  - `e_image_derivative_backend`：`image_id` + `key` + `filetype` + `last_read` + `data bytea`（`image-derivative.entity.ts:12-48`）。
  - 备份口径：`docs/MAINTAINING.md:16`「所有数据（PostgreSQL + 图片文件）都在 `./data`，备份 = 打包这个目录」。
- 扩展名只存在于 **URL 与服务端映射表**：`/i/<uuid>` 或 `/i/<uuid>.<ext>`；`ImageFullIdPipe` 解析（`backend/src/decorators/image-id/image-full-id.pipe.ts:9-32`）：带扩展名 → `variant: 'normal'` + 由 `Ext2FileType` 得到目标 filetype；不带 → `variant: 'original'`。扩展名集合见 `mimes.dto.ts:85-103`（未知扩展名 → 400，pipe `:18-19`）。
- 上传文件名的扩展名会被**剥掉**只留展示名（`image.service.ts:134-139`），真实格式以魔数为准（`:106`）。

### 3.2 GET /i/:id 如何决定 Content-Type

- `backend/src/routes/image/image.controller.ts`：
  - 无扩展名 `/i/:id` → `variant=original`（`image-full-id.pipe.ts:22-28`）：取 ORIGINAL 行；没有则仅对 SVG master 回退（`getOriginalDownload` `:184-202`，条件 `:199`）；仍无 → 404 + 品牌占位图（`:123-137`）。
  - 带扩展名 `/i/:id.:ext` → `variant=normal`：调用 `getConverted(id, ext对应filetype, query)`（`:112-122`），Content-Type 用**返回行的 filetype** 映射：`res.type(FileType2Mime(image.filetype))`（`:108`、`:121`）。
  - `HEAD` 同样逻辑但不返回 body：original 分支 `getOriginalDownloadFileType` + SVG 回退（`:61-91`、`:204-216`）；normal 分支先 `getMasterFileType` 查存在性，再按 URL 的 filetype 设 Content-Type（`:80-83`），不存在 → 404 + `no-store`（`:84-90`）。
- 结论：Content-Type **由数据库中的 filetype 字符串决定**，不信任请求头；无扩展名与带扩展名是两种语义（下载原图 vs 转码派生图）。
- 已实测契约（这次调研交叉验证）：不带扩展名的普通图（未保留原图）是 **404 + 占位图**（`.trellis/spec/picsur-backend/backend/image-api-contracts.md:83`、`:143`、`:223`）。

### 3.3 ETag / Cache-Control

- `Cache-Control`：`AppModule` 中间件给**所有** `/i/*` 响应统一加 `max-age=2592000`（30 天），`backend/src/app.module.ts:49-58`，应用位置 `:92-94`；同时 `imageCorsOverride` 加 `Cross-Origin-Resource-Policy: cross-origin`（`:39-47`），CORS 允许 GET/HEAD/OPTIONS（`:29-37`）。
- 例外（覆盖为 `no-store`）：图片不存在 `image.controller.ts:140-150`；`/i/meta/:id` `:162`；所有错误响应 `exception.filter.ts:63-67`。契约见 `image-api-contracts.md:123-135`。
- **没有 ETag / Last-Modified / If-None-Match / If-Range**：`grep -rn "Accept-Ranges|Content-Range|ETag|Last-Modified|If-Range|If-None-Match" backend/src frontend/src shared/src` 零命中（2026-10-25）。长缓存靠「id 不可变 + 30 天 max-age」。

### 3.4 是否支持 Range 或流式响应

- **不支持**。两个取图 handler 都返回完整 `Buffer`：`Promise<Buffer>`（`image.controller.ts:100`），`return image.data`（`:109`、`:122`）；没有解析 `Range` 请求头，也没有 `Accept-Ranges`/`Content-Range`/206 分支（grep 零命中）。Fastify 对 Buffer 应答设置 Content-Length 并整段发送；DB 读取（`image-file-db.service.ts:57-71`）本身也是把整段 bytea 读进内存。
- 对视频的含义（A 档）：`<video>` 能拿到 200 + 正确 Content-Type 的完整文件；Chrome 通常可边下边播，但**拖动进度条会发 Range 请求，服务器忽略 Range 返回 200 全量**，Safari 对无 Range 的媒体兼容性差。即 A 档 =「下载式播放」，不是真正的流媒体。

### 3.5 读取时是否实时转换（QOI / 格式协商）

- 带扩展名路径是**按需实时转换 + 数据库缓存**：`ImageManagerService.getConverted()`（`backend/src/managers/image/image.service.ts:172-287`）：
  - 目标类型来自 URL（`:177-178`）；读 `allow_editing` 系统偏好决定是否接受 query 编辑参数（`:180-186`）；
  - SVG 目标只能命中 SVG master、且不许 transform（`:188-214`）；
  - 缓存 key = sha256(`JSON.stringify({mime, ...query})`)（`:216`、`:404-411`）；
  - `MutexFallBack(imageId:key)` 查派生表 → 未命中则取 master → sharp 转换 → 按上限决定是否写派生表（`:218-286`）；
  - 同格式且无编辑参数时直接回 master 字节、不重复落库（`:248-258`）；
  - 派生图上限 `PICSUR_MAX_DERIVATIVES_PER_IMAGE` 默认 100（`backend/src/config/early/image.config.service.ts:9-12,62-75`）。
- 无扩展名路径**不转换**：直接返回 ORIGINAL 或 SVG master 的存储字节（`image.controller.ts:102-110`、`:184-202`）。
- 内部 master 形态：静态图 QOI（`image-processor.service.ts:36-55`），动图 WEBP（`:57-68`）。QOI 是内部无损中转，前端遇到 QOI 会用 worker 解码成 canvas（`picsur-img.component.ts:134-151`）。
- 派生图清理：cron 每 60s 清理 `last_read` 超过 `remove_derivatives_after`（默认 7d）的派生图与过期图片（`backend/src/managers/image/image-manager.module.ts:40-81`；默认值 `preference-defaults.service.ts:44-48`；清理实现 `image-file-db.service.ts:196-208`、`image-db.service.ts:231-241`）。
- 删除图片时 file/derivative 行由外键 `ON DELETE CASCADE` 一并删除（`backend/src/database/migrations/1662485374471-V_0_4_0_b.ts:41,44`）。

---

## 4. 数据模型（Q4）

### 4.1 Image 实体字段（元数据）

`EImageBackend`（`backend/src/database/entities/images/image.entity.ts:6-71`，表 `e_image_backend`）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | uuid PK | 图片 id（也是 URL 里的 id） |
| `user_id` | uuid | 上传者（匿名落 guest 用户） |
| `created` | timestamptz | 创建时间 |
| `file_name` | varchar | 上传文件名去扩展名后的展示名 |
| `source_filetype` | varchar **nullable** | 上传时的真实格式（如 `image:png`），旧行为 null；`migrations/1780617600000-AddImageSourceFiletype.ts` |
| `width` / `height` | int **nullable** | 原始像素尺寸；SVG/旧数据为 null，`migrations/1792454400000-AddImageDimensions.ts` |
| `expires_at` | timestamptz nullable | 过期时间 |
| `delete_key` | varchar nullable（`select:false`） | 匿名删除 key |
- 对外契约：`EImageSchema`（`shared/src/entities/image.entity.ts:4-26`）与实体一一对应，上传/列表/详情响应都走它（`shared/src/dto/api/image-manage.dto.ts:11-18` 等）。
- **重要设计先例**：新增列一律 **nullable**，且客户端把 null 当「未知」处理；理由是旧行没有值、且响应校验跑在自己的输出上，非空约束/必填字段会让老数据直接 500（`shared/src/entities/image.entity.ts:10-24` 的注释、`AddImageDimensions` 迁移注释 `migrations/1792454400000-AddImageDimensions.ts:3-12`）。

### 4.2 文件实体（真正存字节）

- `EImageFileBackend`（`image-file.entity.ts:13-42`）：`(image_id, variant)` 唯一（`:14`）、`variant` 为 original/master/ingest（`shared/src/dto/image-entry-variant.enum.ts:1-5`）、`filetype` 字符串、`data bytea`（`:40-42`）。
- `EImageDerivativeBackend`（`image-derivative.entity.ts:12-48`）：`(image_id, key)` 唯一、`filetype`、`last_read`、`data bytea`。
- 需要的扩展名/mime 映射与分类都在 shared，如果把视频纳入白名单，`filetype` 字段天然能存 `video:mp4` 这类字符串（现有列宽 varchar 无长度限制）。

### 4.3 视频需要加什么、是否需要 migration

- **A 档可以做到「零表结构变更」**：
  - 复用 `e_image_file_backend`（video 原片作为 MASTER 行，`filetype='video:mp4'`）；
  - `source_filetype` 记录上传格式，列表/详情响应已包含它（`EImageSchema:9`）；
  - `width/height` 留 null（客户端把 null 当未知，先例同上）；
  - 前端可用 `source_filetype` 或 `/i/meta/:id` 的 `fileTypes.master` 判断「这是不是视频」。
  - 局限：列表响应没有显式 `media_kind`/时长，前端只能靠解析 `video:*` 前缀；若要「图库直接筛视频/显示时长」，就需要加列。
- **推荐 A 档顺手加一个非破坏性迁移**（可选项，但建议做，避免以后改契约）：
  - `media_kind` varchar nullable（`'image' | 'anim' | 'video'`，旧行 null 视为 image）；`duration_ms` int/bigint nullable（A 档可先留 null，B 档由 ffprobe 填）。
  - 迁移写法按项目规范：新文件 `backend/src/database/migrations/<unix-ms>-AddImageMediaKind.ts`，`up()` 用 `ADD COLUMN IF NOT EXISTS`、`down()` `DROP COLUMN IF EXISTS`，**必须在 `backend/src/database/migrations/index.ts:16-29` 的 `MigrationList` 注册**（规范 `database-guidelines.md:36-53`；忘了注册迁移不会跑，`:96-104`）。
  - 时间戳必须大于当前最新 `1792454400000`（`migrations/index.ts:14,28`）。注意：`database-guidelines.md:39` 写的「最新 1792368000000」已过时，以代码为准。
- **B 档必须 migration**（至少）：`media_kind`、`duration_ms`、`fps`、`codec`（或 `meta jsonb`）、转码状态（或独立 `video_job` 表）；若海报/多分辨率产物走 variant，则 `ImageEntryVariant` 增加 `POSTER`（该枚举被实体/迁移/响应共用，改它属于 shared 契约变更，见 `image-entry-variant.enum.ts:1-5`）。若采用文件系统/对象存储，还要引入存储抽象，与现有三张表的关系需要设计（`image_file.data` 可能不再用于视频）。

### 4.4 迁移执行方式（影响交付形态）

- 应用启动自动跑迁移：`migrationsRun: true`（`backend/src/config/early/type-orm.config.service.ts:60`），实体/迁移列表见 `:62-63`；生产 `synchronize` 默认关（`:58`），所以**必须写迁移，不能靠 synchronize 兜底**（规范 `database-guidelines.md:96-104`）。

---

## 5. 图片假设：sharp 管线在哪、A/B 各要绕开/复用/引入什么（Q5）

### 5.1 sharp 转换管线

- 入口：`ImageProcessorService.process()`（`image-processor.service.ts:23-34`）按 `FileType.category` 分派：
  - `Image` → `processStill` → 转成 **QOI master**（`:36-55`；SVG 例外，原样存，`:44-49`）；
  - `Animation` → `processAnimation` → 转成 **WEBP master**（`:57-68`）；
  - 其它 category → `FT.SysValidation`（500，`:31-33`）。
- 实际转换：`ImageConverterService`（`image-converter.service.ts`）读系统偏好 `conversion_time_limit`（默认 `15s`）与 `conversion_memory_limit`（默认 `512` MB）（`:73-81`；默认值 `preference-defaults.service.ts:47-48`），先做像素上限预检（`:96-101`，上限 `PICSUR_MAX_IMAGE_PIXELS` 默认 268,402,689），然后在 **fork 出的子进程**里跑 sharp（`SharpWrapper`：`workers/sharp.wrapper.ts:49-115`，fork 时注入 timeout/内存 env `:54-65`，`pTimeout` `:172-174`；worker 内 `setrlimit('data', ...)`：`workers/sharp/sharp.worker.ts:49-56`）。
- 失败点（视频会在哪一步挂）：
  1. **白名单**：`Mime2FileType` 未命中 → `FT.Internal` → 500（`image.service.ts:389-399` + `mimes.dto.ts:68-75`）——当前 mp4 死在这里；
  2. 若只加白名单不加 category 分支：`process()` 的 else → `FT.SysValidation` → 500（`image-processor.service.ts:31-33`）；
  3. 若强行把视频喂给 sharp：`checkPixelLimit` 的 `sharp(...).metadata()` 读不出视频 → `FT.UsrValidation` `'Failed to read image metadata: ...'`（`image-converter.service.ts:195-210`）；即便绕过预检，worker 里 libvips 也无法解码视频容器（sharp 不是视频库）。
- 结论：视频**必须显式旁路** sharp，不能靠「宽容地让它失败」。

### 5.2 A 档：视频存原片、不转码、直出——要绕开/修改的步骤

1. **shared 类型与映射（必须）**：`mimes.dto.ts` 增加 `VideoFileType`（建议只放浏览器能直接播的容器：`video:mp4`/`video:webm`；是否收 `mov/mkv` 是产品决策，收进来会「上传成功但播不了」）、`SupportedFileTypeCategory.Video`、mime 映射（`video/mp4`、`video/webm`）、扩展名映射（`mp4`、`webm`）、`SupportedFileTypes`；`parse-mime.ts:11-22` 增加 Video 分支。**这是解除 500 的第一步。**
2. **上传流程（必须）**：`image.service.ts:100-170` 增加视频分支：跳过 `processService.process()`（或给 `ImageProcessorService.process()` 增加 Video 分支直接 `return { image, filetype }`，推荐后者，职责清晰）；**无条件**把视频原片写成 MASTER 文件行（否则不保留原图时 `/i/<id>` 会 404，见 §3.2）；不要因 `KeepOriginal` 再存一份（省一半 DB）。注意跳过像素预检（那是 sharp 专用语义）。
3. **读取/转换（必须）**：`/i/<id>.mp4` 会进入 `getConverted()`（`image.service.ts:172+`）→ 会调 sharp → 必须旁路：目标 filetype 与 master 相同、且 category 是 Video 时直接返回 master 字节（类似现有 `:248-258` 的同格式短路，但要放在 sharp 之前；或改由处理器按 category 分派）。
4. **无扩展名回退（必须）**：`/i/<id>` 的 ORIGINAL 分支要像 SVG 一样回退到 video master（`image.controller.ts:184-202` 的条件 `:199` 与 HEAD 的 `:204-216` 的 `:213` 都要扩展）。这样「下载原片」链接对视频才可用。
5. **Content-Type（必须）**：`FileType2Mime` 增加 video 映射后，现有 `res.type(...)` 自动正确（`image.controller.ts:108,121`、HEAD `:73,83`）。
6. **大小/限流（建议）**：沿用 `PICSUR_MAX_FILE_SIZE`（128 MB）即可跑通；视频语义下建议单独 env（如 `PICSUR_MAX_VIDEO_SIZE`）或至少文档化内存风险；上传限流 20/min（`image-manage.controller.ts:61`）与全局 60/min 可先不动。
7. **数据模型（可选/推荐）**：见 §4.3；A 档不迁移也能上线，但建议加 `media_kind`。
8. **前端（另一路）**：不能用 `picsur-img`（`<img>`）渲染视频；需要 `<video controls>` 直接用 `/i/<id>` 或 `/i/<id>.mp4` URL。Add：`upload.component.html` 无 accept（可选加提示）；图库缩略图（`frontend/src/app/routes/images/images.component.ts:326` 的 WebP 缩略图 URL）对视频无意义，需要占位/改用 `<video preload="metadata">`。
9. **无需改动**：Dockerfile（无新依赖）、sharp/worker、像素限制、派生表、清理 cron、权限模型（可复用 `ImageUpload`）。

### 5.3 B 档：转码 + 封面海报 + Range——可复用什么、要引入什么

- **可复用**：
  - 子进程隔离 + 超时/内存限制的封装模式（`workers/sharp.wrapper.ts:32-115`、`sharp.worker.ts:39-56`）可套到 ffmpeg spawn；
  - `MutexFallBack` 的「同一 key 只做一次」模式（`image.service.ts:216-225`）可防重复转码；
  - `e_image_derivative_backend` 的 key/cache/`last_read` + 60s 清理 cron（`image-manager.module.ts:40-81`）可先承载 poster/转码产物（但大文件要评估 bytea 与清理策略）；
  - 用 ffmpeg 抽帧后，**sharp 仍可复用**做海报缩放/WebP 化（走现有 `ImageConverterService`）；
  - `PICSUR_MAX_IMAGE_PIXELS`、conversion 超时/内存这套配置思路可扩展成视频专用配置。
- **要引入**：
  - **ffmpeg/ffprobe 系统二进制**：仓库里完全没有（`git grep ffmpeg` 零命中；`Dockerfile` 运行时 apk 列表 `:105-112` 无 ffmpeg；all-in-one 基于常规镜像 `Dockerfile.allinone:21-22`，会继承）。需要在 `Dockerfile` 最终阶段 `apk add` 并**锁版本**（项目对 apk 包强制锁版本、由 `support/apk-versions.sh` 解析，脚本需加入 ffmpeg 包；可复现性契约见 `Dockerfile:1-25`、`support/apk-versions.sh:1-15`）。**镜像体积增量未测**，需构建后记录（不要凭印象给数字）。
  - **校验**：ffprobe 读容器/codec/时长/分辨率；新增大小与时长上限 env（三处同步：`.env.example`、镜像 ENV/部署侧、`build-and-deploy.md §3.1`——规范 `build-and-deploy.md:239-246`）。
  - **异步任务/状态**：现有上传请求内同步转换只适合秒级图片（15s 上限），视频转码必须异步或懒转换。项目**没有队列基础设施**：`RedisConfigService` 只有配置、grep 无任何使用（`backend/src/config/early/redis.config.service.ts`）；现有后台任务只有 `@nestjs/schedule` 的 `@Interval` cron（`image-manager.module.ts:40-44`）。B 档需新表（任务/状态）+ 后台 worker + 轮询端点，属于新子系统。
  - **Range 206 / 流式**：bytea 模型下有两条路——(a) 内存切片返回 206（改动最小，但每次仍把整段 bytea 读进内存，解决不了内存与首播延迟）；(b) 视频/转码产物改落文件系统（`./data` 卷）用 `createReadStream` + Range（推荐，但要新存储抽象、备份口径从「备份 DB 目录」扩展、且与 all-in-one 的 `/data` 一致）。仓库当前没有任何 Range/stream 基础设施可复用。
  - **安全**：ffmpeg 是攻击面；输入来自用户上传，需限制协议（禁网络协议）、输出路径、时长/分辨率、CPU/内存、超时、临时文件（常规镜像以 `node` 非 root 跑 `Dockerfile:170`，all-in-one 应用进程是 root，`Dockerfile.allinone:40-44` 有明确说明——两者风险不同）。
  - **封面海报**：ffmpeg 抽一帧 → 走 sharp 转现有格式 → 存成新 `POSTER` variant（`(image_id, variant)` 唯一约束直接支持，`image-file.entity.ts:14`）或派生行；缩略图请求可复用 `/i/<id>.webp?width=` 管线。
- **B 档不建议**：在同步上传请求里直接转码（15s/512MB 预算 + 20/min 限流 + 无进度反馈，长视频必然超时且占住请求）；把整段视频反复读进内存做 Range 切片作为长期方案。

---

## 6. 工作量量级（Q6）

> 量级是相对估计（小/中/大），不是工期承诺；依据是「要改的文件数与是否引入新依赖/新基础设施」。

| 维度 | A 档（存原片直出） | B 档（转码 + 海报 + Range） |
|---|---|---|
| 后端+shared 改动文件 | 约 6–9 个 | 约 20–30+ 个（新增模块/实体/迁移/接口） |
| 代码量级（不含测试/文档） | 小—中（约 150–350 行） | 大（约 1500–3000+ 行，取决于存储方案） |
| 新依赖 | **无** | **ffmpeg/ffprobe 系统包**（镜像 + 锁版本 + 体积）；不建议再引 npm wrapper（审计口径要求后端/共享 0，见 `AGENTS.md` §6） |
| 数据库迁移 | 可选 1 个（media_kind/duration）；不写也能上线 | 必须 1–2 个（媒体字段/任务表/状态），并可能改存储方案 |
| 新基础设施 | 无 | 异步任务/worker、状态轮询、Range/流式、（可能）文件系统存储抽象 |
| Docker 改动 | 无 | 有（apk 包 + 镜像体积 + 可复现性链） |
| 主要风险 | 内存峰值、无 Range/无封面、播不了的容器被收进来 | ffmpeg 安全/体积/超时、存储架构、备份膨胀、久期 |
| 相对工作量 | **小—中** | **大** |

### 6.1 A 档可开工任务拆分（后端视角，可直接转 implement）

1. **A1 shared 视频类型**（`mimes.dto.ts`、`parse-mime.ts`）：新增 Video 分类 + mime/ext 映射 + `SupportedFileTypes`；决定允许容器（建议 mp4/webm）；补最小校验脚本/单测。
2. **A2 上传旁路**（`image-processor.service.ts` + `image.service.ts`）：Video 类别直接以原片作为 master，跳过 sharp/像素预检；视频原片写 MASTER；不重复存 original。
3. **A3 读取旁路**（`image.service.ts::getConverted` + `image.controller.ts`）：同格式视频直出、无扩展名回退到 video master、HEAD 同步；断言 Content-Type 与 `Cache-Control`。
4. **A4 数据模型**（可选但推荐，可与 A2 并行）：`media_kind`/`duration_ms` nullable 迁移 + 注册 `MigrationList` + 同步 `EImageSchema`（null 兼容）。
5. **A5 回归与文档**：新增视频回归（上传 mp4 → HEAD/GET 200 + Content-Type 正确 → 字节一致（不转码才能断言字节）→ 删除后 404 + no-store）；`.env.example`/spec 文档说明内存与上限语义。
6. **A6 前端（另一路负责）**：上传提示/accept、`/view` 用 `<video>`、图库占位、i18n、分享链接（markdown/html 对视频不再适用，需要新模板）。

### 6.2 B 档任务拆分（先决策后实施）

0. **B0 架构决策门**：存储与 Range 方案（bytea 内存切片 vs 文件系统流式）、允许容器/编码、大小/时长/分辨率上限；决定是否复用 `image_file` variant 还是新表。
1. **B1 工具链**：ffmpeg/ffprobe 进镜像（apk 锁版本 + `support/apk-versions.sh` + 构建体积记录 + 回归环境说明）。
2. **B2 Range/流式**：按 B0 实现 206（`Accept-Ranges`/`Content-Range`/HEAD Content-Length），缓存与不可变性语义（复用现有 30 天 Cache-Control 但要保证产物不可变）。
3. **B3 上传校验与限额**：ffprobe 校验容器/codec/时长/分辨率；新增 env 三处同步；拒绝策略与错误码。
4. **B4 异步转码**：任务表 + 状态机 + 后台 worker + 轮询端点 + 超时/并发/资源限制 + 失败清理；复用 `MutexFallBack`/子进程模式。
5. **B5 封面海报**：ffmpeg 抽帧 → sharp 缩放 → `POSTER` variant/派生行 → 图库缩略图走现有 `/i/:id.ext?width=` 管线。
6. **B6 运维与安全**：清理/配额/备份口径（`docs/MAINTAINING.md:16`）、ffmpeg 协议白名单与非 root、加载/压测、回归脚本扩视频用例。

---

## 风险与不确定项

1. **未实测（最重要）**：本次是只读静态分析，没有起实例。以下结论是代码推断，建议实现前花 10 分钟实测确认：① 当前上传 mp4 返回 500（而非 400）；② 超过 `PICSUR_MAX_FILE_SIZE` 返回 413；③ `/i/*` 无 Range/ETag；④ HEAD 对不存在的图返回 404。实测方式：`bash support/regression-image-api.sh <base-url> <pw>` 之外，用 `curl -F` 传一个视频并看状态码。
2. **内存模型**：`toBuffer()` 全内存（含 `Buffer.concat` 期间的约 2 倍峰值），`PICSUR_MAX_FILE_SIZE` 默认 128 MB；并发上传/下载多个视频会显著抬高 RSS，缺少背压/并发上限。建议 A 档上线前明确上限与并发策略（或把默认值调低并在文档标明）。
3. **Postgres bytea 存视频**：可行但增长快（DB 与备份直接膨胀，备份口径 `docs/MAINTAINING.md:16`）；单行有 TOAST/字段上限，超大文件风险；现有清理只覆盖派生图与过期图片（`image-manager.module.ts:40-81`），**没有按用户配额**；删除靠级联（迁移 `1662485374471-V_0_4_0_b.ts:41,44`）没问题。
4. **无 Range 的影响**：A 档「能播但拖不动/首播要等」，Safari 兼容性存疑（需真机验证）；如果产品要求「像视频一样播」，A 档单独交付会不满足。
5. **ffmpeg（B）的不确定性**：Alpine 3.23 的 ffmpeg 包版本/体积未测；加包会破坏「apk 版本锁死」的可复现链（需跑 `support/apk-versions.sh` 重新解析并同步 Dockerfile），镜像体积增量必须构建后实测，不应照抄网上数字。
6. **ffmpeg 安全与运行身份**：常规镜像应用是 `node`（`Dockerfile:170`），all-in-one 是 root（`Dockerfile.allinone:40-44`）；B 档需要协议白名单、输出路径约束、超时/内存/CPU 限制、临时文件清理与恶意媒体防护。
7. **无队列/无 Redis**：`RedisConfigService` 存在但无人使用；B 档异步只能自建（`@nestjs/schedule` + DB 表是最贴近现有代码的路径），不要假设已有队列。
8. **魔数校验不足（B）**：`file-type` 只能给容器类型，不能给 codec/时长；且冷门容器（mkv/ts）识别差异大。A 档建议只放浏览器可播的容器，避免「收进来却播不了」。
9. **文档/spec 漂移（不影响本次结论，但会影响实现任务）**：
   - `image-api-contracts.md:56` 说上传 multipart 字段名是 `file`，而前端实际 append 的是 `image`（`frontend/src/app/models/dto/image-upload-request.dto.ts:8`）；后端不校验字段名，两者都能跑——实现时不要被文档误导。
   - `database-guidelines.md:39` 说最新迁移是 `1792368000000`，实际最新是 `1792454400000`（`migrations/index.ts:14,28`）。
   - `build-and-deploy.md` 多处提到仓库根 `docker-compose.yml`，但该文件已从仓库删除（提交 `6fc28d9 chore: slim the repo to a single path`），当前部署路径只有 `docker run`（`docs/MAINTAINING.md:5-18`）。
   - 建议实现阶段先修这三处 spec，再动代码（Trellis spec 更新属于 Lead 侧流程）。
10. **没有读 `.env`**：按红线未读取（含 JWT/DB 凭据）。因此本机实际 `PICSUR_MAX_FILE_SIZE` 可能不是默认 128 MB；结论以 `.env.example:28` 与代码默认值为准。
11. **CSP/CORS 小坑**：`/i/*` 的跨域资源已设置 `Cross-Origin-Resource-Policy: cross-origin`（`app.module.ts:39-47`），但全局 CSP 只有 `img-src`、没有 `media-src`（`backend/src/security.ts:3-27`）。同源 `<video src="/i/...">` 不受影响；若前端用 `blob:` URL 预览视频会被 `default-src 'self'` 拦（与图片 `blob:` 恰好被 img-src 放行不同）。
12. **未验证的浏览器行为**：没有浏览器/实例可测（只读会话），`<video>` 对 200 全量响应、HEAD 无 Content-Length、无 `Accept-Ranges` 的具体表现需实现阶段用真浏览器验证。

---

## 建议 MVP 范围

**推荐：A 档作为 MVP 上线，B 档单独立项；两者之间不要「半 B」**（例如只在同步请求里转码但不做 Range/异步），那会同时踩性能与体验坑。

MVP-A（建议范围）：
- 支持容器限定 **mp4 / webm**（浏览器可直出），存储用现有 Postgres bytea，master = 原片，不转码、不生成封面。
- 提供 `/i/<id>`（原片下载/播放）与 `/i/<id>.mp4|.webm` 直出；沿用 30 天缓存；明确文档说明「无 Range，跳播体验差」。
- 顺手加 `media_kind`（+ `duration_ms` 可空）迁移，避免后端/前端二次改契约。
- 大小沿用 `PICSUR_MAX_FILE_SIZE`，但给出视频场景建议值并提示内存风险；回归脚本覆盖「上传→HEAD→GET→删除后 404」。
- 明确不做：转码、封面、Range、codec 白名单、时长限制（这些进 B 档 backlog）。

MVP-B（后置，必须单独立项）：
- B0 架构决策（存储 + Range）→ B1 ffmpeg 工具链 → B2 Range/流式 → B3 校验限额 → B4 异步转码 → B5 封面 → B6 运维/安全/回归。
- MVP-B 第一版建议只做「mp4(H.264/AAC) 输入 → mp4 输出 + poster + Range」，把编码矩阵压到最小，验证收益后再扩。

**值不值得做（后端视角）**：A 档值得——改动集中、无新依赖，能把「图床顺手收小视频、给直链」变成现实；B 档是独立工程，只有当「必须浏览器内流畅播放/拖动/封面/多容器兼容」成为明确需求时才值得，并且要先解决存储与 Range 架构，而不是先写转码。

---

## 附：本次验证记录

- 读过的关键文件（均已在上文引用行号）：`backend/src/main.ts`、`app.module.ts`、`security.ts`、`routes/image/{image,image-manage}.controller.ts`、`decorators/multipart/*`、`decorators/image-id/*`、`config/early/{multipart,image,serve-static,type-orm,early-config}.module/service.ts`、`managers/image/{image,image-processor,image-converter,image-manager.module}.ts`、`workers/sharp.wrapper.ts`、`workers/sharp/sharp.worker.ts`、`collections/image-db/{image-db,image-file-db}.service.ts`、`database/entities/images/*`、`database/migrations/index.ts` 与两个近期迁移、`layers/{exception,success,throttler}/*`、`util/{upload-error,iterator}.ts`；`shared/src/{dto/mimes.dto.ts,util/parse-mime.ts,util/image-pixel-limit.ts,entities/image.entity.ts,types/failable.ts,dto/api/*,dto/image-entry-variant.enum.ts}`；前端 `routes/upload/*`、`routes/processing/*`、`services/api/{image,api}.service.ts`、`components/picsur-img/*`、`util/util.service.ts`、`models/dto/image-upload-request.dto.ts`、`routes/images/images.component.ts`（缩略图行）、`routes/view/view.component.{ts,html}`；`Dockerfile`、`Dockerfile.allinone`、`.env.example`、`README.md`、`docs/MAINTAINING.md`、`.github/workflows/ci.yml`、`support/{apk-versions,regression-image-api}.sh`；spec `picsur-backend/backend/{index,image-api-contracts,database-guidelines,build-and-deploy}.md`。
- 读过的依赖实现（用于确认运行时语义）：`node_modules/.pnpm/@fastify+multipart@10.1.3/node_modules/@fastify/multipart/index.js`（limits 默认值/合并、`toBuffer` 内存实现、错误码）、`node_modules/.pnpm/fastify@5.12.5/node_modules/fastify/lib/config-validator.js`（`bodyLimit` 默认 1 MiB）、`node_modules/.pnpm/file-type@21.3.4/node_modules/file-type/core.js`（视频魔数支持）。
- 跑过的只读命令：`pwd`、`git status --porcelain`、`git log --oneline`、`git ls-files`、`git grep`、`grep -rn`、`ls`、`wc -l`、`sed -n`、`cat` 少量配置/脚本、`python3 .trellis/scripts/task.py current --source`（输出 `Current task: (none)`——本会话是子 agent、无 Trellis 活动任务指针；按派发 prompt 指明的任务目录写入，未创建/修改任何 Trellis 任务）。
- `git grep` 结果（tracked 文件，排除 `pnpm-lock.yaml`）：`video` **0 命中**、`ffmpeg|ffprobe` **0 命中**——仓库里没有任何既有视频支持或媒体依赖可复用。
- 未做（明确边界）：没有启动/重启服务、没有上传真实视频、没有跑回归脚本、没有装依赖/构建/Docker、没有改任何源码或配置、没有读 `.env`、没有写除本文件外的任何文件。
- 本文件是本次唯一写入产物：`.trellis/tasks/10-25-video-support-eval/research/backend.md`。
