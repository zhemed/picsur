# Research: 视频上传 A 档实现就绪清单（只上传与直链）

- Query: 把 10-25 视频评估与 A+ 草稿收窄为 A 档「只上传与直链」，产出可直接开工的实现清单
- Scope: internal
- Date: 2026-11-01，同日按用户弹窗决定收窄
- 证据基线: git master 05bdf4e，版本 0.10.7；10-25 评估基于 45e8b09
- 范围决定: 用户已在弹窗中选择 A 档。**不做** Range/206、Accept-Ranges、Content-Range，**不做**前端 video 播放器；保留上传、原片 master、`/i` 直出与 HEAD、meta 与列表识别、前端 accept 与预检、图库占位、详情页直链与下载、i18n
- 只读声明: 未改源码/配置、未启动实例、未跑回归、未写业务代码；唯一写入是本任务 research/ 目录

## Findings

### 一、结论摘要

1. A 档可行且改动面比 A+ 更小：视频不走 sharp、不进 worker、不生成派生图，字节原样作为 master 存入 `e_image_file_backend`，`/i/:id.ext` 直接返回原片。
2. **数据模型推荐零迁移**：现有 `source_filetype` 与 `/i/meta` 的 `fileTypes.master` 已经足以让前后端识别视频，列表响应也带 `source_filetype`。A 档不需要加 `media_kind`；加列方案作为备选保留，留给 B 档或第三方契约需要时。
3. 后端需要改 8 个文件：shared 类型表、shared 解析、处理器、image 服务、文件仓储加一个 `octet_length` 查询、读取控制器、文档同步。零新增迁移、零新依赖、零镜像改动。
4. HEAD 与 GET 的 Content-Type、Content-Length 是关键；`HEAD` 需要 `octet_length` 查询避免为了长度把整段视频读进内存。
5. 必须同时修掉「可识别但不支持的容器返回 500」：把 `Mime2FileType` 的 Internal 失败转成 400，覆盖 mov、mkv、avi 等。
6. 前端详情页不做播放器：显示占位与说明、保留直链复制、提供下载入口；图库视频卡片用占位加 VIDEO 徽章。
7. 用户已接受 A 档无 Range 的代价，见第七节范围边界记录；不再作为待确认项。

---

### 二、现状复核与漂移

复核方法：提取 10-25 三个调研文件里的全部 `file:line` 锚点，用 `git diff 45e8b09..HEAD -- <文件>` 判断文件是否被改过。未改过的文件行号原样成立；改过的逐个重读取今日锚点。

#### 2.1 文件未变，10-25 行号仍有效

| 文件 | 10-25 锚点示例 | 今日状态 |
|---|---|---|
| `shared/src/dto/mimes.dto.ts` | `:4-37`、`:48-66`、`:68-75`、`:85-103` | 未变，逐项核对一致 |
| `shared/src/util/parse-mime.ts` | `:11-22`、`:30-33` | 未变 |
| `shared/src/entities/image.entity.ts` | `:4-26` | 未变，`source_filetype` 在 `:9` |
| `shared/src/dto/api/image-manage.dto.ts` | `:11-18`、`:25-31` | 未变 |
| `backend/src/managers/image/image.service.ts` | `:100-170`、`:172-287`、`:359-402` | 未变 |
| `backend/src/managers/image/image-processor.service.ts` | `:23-34`、`:36-55` | 未变 |
| `backend/src/routes/image/image.controller.ts` | `:93-138`、`:140-150`、`:184-202`、`:204-216` | 未变 |
| `backend/src/routes/image/image-manage.controller.ts` | `:58-90`、`:69-75`、`:76-78` | 未变 |
| `backend/src/app.module.ts` | `:25-37`、`:39-47`、`:49-58`、`:91-94` | 未变 |
| `backend/src/config/early/multipart.config.service.ts` | `:14-19`、`:21-29` | 未变 |
| `backend/src/collections/image-db/image-file-db.service.ts` | `:57-71` | 未变 |
| `backend/src/database/entities/images/*.entity.ts` | `image-file.entity.ts:13-42`、`:40-42`、`image-derivative.entity.ts:46-48` | 未变 |
| `shared/src/types/failable.ts` | `:45-49`、`:75-79` | 未变；Internal 区块实际 45-50 |
| `frontend` 除 i18n 与 api.service.ts 外全部锚点 | 见 frontend.md | 未变，前端行号原样成立 |

#### 2.2 漂移文件与今日锚点

| 10-25 锚点 | 漂移原因 | 今日正确锚点 |
|---|---|---|
| `backend/src/workers/sharp.wrapper.ts:32-115`、`:49-115` | 10-30 提交 0389ec2 改为常驻 worker 池，wrapper 重写并新增 `worker-pool.ts` | `sharp.wrapper.ts:38-265`，租用 `:65-71`，销毁 `:237-250`；fork 与 env 在 `worker-pool.ts:364-372` |
| `frontend/src/assets/i18n/en.json:88-96`、`zh.json:88-96` | 10-29 提交 d8d1802 删除页脚，i18n 顶部 `app.footer` 两个块各删 6 行，其后行号 −6 | `upload` 组今日 `:82-90`，`images` 组 `:91-108`，`view` 组 `:120-166`，`download` 组 `:167-171`，`processing` 组 `:191-194` |
| `frontend/src/assets/i18n/en.json:141-172` | 同上，整表 −6 | 今日 customize/edit 区块 `:135-166` |
| `shared/src/dto/api/image.dto.ts:30-38` | 10-29 zod v4 迁移在 fileTypes 内加注释，schema 扩到 30-44 | `:30-44`，`ImageMetaResponse` 类在 `:44` |
| `backend/package.json:43`、`:58` | 版本与依赖升级 | `file-type` `:43` 不变；`sharp` 今日 `:62` |
| `frontend/src/app/services/api/api.service.ts:214-232`、`:268-291` | 仅 zod 类型名改写，行数不变 | 两处锚点今日仍成立；`uploadProgress` 创建 `:268`，上报 `:285` |
| `docs/MAINTAINING.md:5-20` | 10-30 文档去 compose 化 | 部署命令 `:7-13`，`/data` 备份说明 `:16-18` |
| `backend/src/routes/image/image.controller.ts:100` | 10-25 用单行指代「返回完整 Buffer」 | 函数体 `:93-138`，`return image.data` 在 `:109` 与 `:122` |
| `backend/src/routes/image/image.controller.ts:42-52`、`:50` | 类装饰器实际占 50-53 行 | `@Controller('i')` `:51`，类 `:53`，限流常量 `:47` |
| 10-25 `image.service.ts:359-390`、`:389-399` | 文件未变，函数实际 359-402 | 以 `:359-402` 为准 |

#### 2.3 语义漂移与文档偏差

| 项 | 事实 | 影响 |
|---|---|---|
| 上传字段名 | 后端 `@PostFiles(1)` 不校验字段名；前端发 `image`，回归脚本发 `file`，都能过。spec `image-api-contracts.md:56` 写死 `file` 属于片面描述 | A 档回归用 `image` 并在 spec 更正 |
| Range 文档 | spec `image-api-contracts.md:73-96` 没有 Range 契约 | A 档明确不实现 Range，文档不必补 Range，只需说明无 Range 支持 |
| 字节落盘 | `Dockerfile:162` 与 `docs/MAINTAINING.md:16-18` 说明数据全在 Postgres 与 `./data`，视频沿用同一模型 | 备份体积随视频放大，见风险 |
| worker 架构 | 已是常驻池，不是 10-25 描述的每次 fork | 视频不经过 worker，不影响 A 档设计 |
| 现状 500 行为 | 可识别但未支持容器在 `image.service.ts:396-398` 走 `Mime2FileType` 失败，类型是 `FT.Internal`，见 `mimes.dto.ts:68-75` | 10-25 的「现状 mp4 是 500」静态推断成立；A 档必须顺手改成 400 |

---

### 三、后端改动清单

#### 3.1 shared 媒体类型表

文件：`shared/src/dto/mimes.dto.ts`，今日 117 行。

| 位置 | 改动 |
|---|---|
| `:19-23` AnimFileType 之后 | 新增 `VideoFileType` 枚举，只收 `MP4 = 'video:mp4'`、`WEBM = 'video:webm'`。收 mov、mkv、avi 的代价见风险 R5 |
| `:25-32` | 新增 `SupportedVideoFileTypes = Object.values(VideoFileType)`；`SupportedFileTypes` 改为 Image、Anim、Video 三枚举合并 |
| `:34-37` | `SupportedFileTypeCategory` 增加 `Video = 'video'` |
| `:48-66` | `FileType2MimeMap` 键联合加 `VideoFileType`，新增 mp4 到 `video/mp4`、webm 到 `video/webm` |
| `:85-103` | `FileType2ExtMap` 同理，新增 `mp4`、`webm` |
| `:68-75`、`:112-117` | 反查逻辑不变，扩展键联合类型即可 |

#### 3.2 shared 类型解析与视频判定

文件：`shared/src/util/parse-mime.ts`，今日 34 行。

| 位置 | 改动 |
|---|---|
| `:1-8` 导入 | 引入 `SupportedVideoFileTypes` |
| `:11-22` `ParseFileType` | 在 Animation 分支后、最终 Fail 前增加 Video 分支，返回 `{ identifier: filetype, category: SupportedFileTypeCategory.Video }` |
| `:24-34` | `ParseExt2FileType`、`ParseMime2FileType` 自动获得视频能力 |
| 新增导出 | `export function IsVideoFiletypeIdentifier(id: string \| null \| undefined): boolean`，实现为 `typeof id === 'string' && id.startsWith('video:')`。前端列表只有 identifier，没有 category，这个纯函数是零迁移方案的核心判定点，后端也可用于日志与断言 |

`ImageFullIdPipe` 会因该改动自动接受 `.mp4` 与 `.webm`，见 `backend/src/decorators/image-id/image-full-id.pipe.ts:9-32`。

#### 3.3 图片处理器

文件：`backend/src/managers/image/image-processor.service.ts`，今日 69 行。

| 位置 | 改动 |
|---|---|
| `:23-34` `process` | 在 Animation 分支后加 Video 分支，调用新私有方法 |
| `:57-68` 之后新增 | `processVideo(image, filetype)` 直接返回 `{ image, filetype: filetype.identifier }`；不解码、不产生宽高；注释写明原片即 master，转码属于 B 档 |
| `:31-33` | 保留兜底 Fail，类型上 Video 已被前一分支覆盖 |

#### 3.4 图片管理服务

文件：`backend/src/managers/image/image.service.ts`，今日 412 行。

| 位置 | 改动 |
|---|---|
| `:100-170` `upload` | 只改一处：`:159` 的 `if (keepOriginal)` 改为 `if (keepOriginal && fileType.category !== SupportedFileTypeCategory.Video)`。视频 master 就是原片，再存 original 等于双份字节。其余不变：`:142-148` 的 create 签名不改，零迁移方案不需要 mediaKind 参数；宽高自然为 null |
| `:172-287` `getConverted` | 在 `:180` 读 allow_editing 前插入视频分支：取 master 类型；master 是视频而目标不是视频时返回 400；目标是视频而 master 不是视频时返回 400；两者都是视频则要求 identifier 相同，否则 400；视频目标忽略编辑参数，直接返回 `{ key, filetype, data: master.data }`，不写派生表。这样 `/i/<视频>.webp`、`/i/<图片>.mp4` 都是明确 400 |
| `:289-355` 文件 getter 区新增 | `getVideoFileInfo(imageId)`，转发到 DB 服务的 `getFileInfo`，返回 `{ filetype, size }`，供 HEAD 设置 Content-Length，避免为了长度拉全量 |
| `:359-402` `getFileTypeFromBuffer` | `:396-398` 把 `Mime2FileType` 失败转成用户错误：`return Fail(FT.UsrValidation, 'Unsupported upload format: ' + mime, parsed.getReason())`。`:379-387` 的未知字节分支已是 400，不动 |
| `:404-411` | 视频不走缓存键逻辑，无需改 |

#### 3.5 文件仓储

文件：`backend/src/collections/image-db/image-file-db.service.ts`，今日 209 行。只加一个方法，放在 `getFile` `:57-71` 之后：

```ts
public async getFileInfo(
  imageId: string,
  variant: ImageEntryVariant,
): AsyncFailable<{ filetype: string; size: number }> {
  const rows = await this.imageFileRepo.query(
    `SELECT filetype, octet_length(data) AS size
       FROM e_image_file_backend WHERE image_id = $1 AND variant = $2`,
    [imageId, variant],
  );
  if (rows.length === 0) return Fail(FT.NotFound, 'Image not found');
  return { filetype: rows[0].filetype, size: Number(rows[0].size) };
}
```

要点：`octet_length(bytea)` 返回 int4，pg 驱动给 number；参数化查询无拼接；不读 `data` 列，HEAD 不产生大内存。`variant` 传 `ImageEntryVariant.MASTER` 即 `'master'`。A 档不需要按字节切片的方法。

#### 3.6 图片读取控制器

文件：`backend/src/routes/image/image.controller.ts`，今日 217 行。

| 位置 | 改动 |
|---|---|
| `:1-20` 导入 | shared 导入增加 `ParseFileType`、`SupportedFileTypeCategory` 或新纯函数 `IsVideoFiletypeIdentifier`；无需增加 Fastify 之外的依赖 |
| `:61-91` `headImage` | original 分支 `:67-74` 与 normal 分支 `:77-83`：解析到 filetype 后若是视频，调 `getVideoFileInfo` 设 Content-Type、Content-Length、`X-Content-Type-Options: nosniff` 后返回；normal 分支要求请求的 `fullid.filetype` 与 master 一致，否则抛 `Fail(FT.UsrValidation, ...)` 得 400。**不加 Accept-Ranges** |
| `:93-138` `getImage` | original 分支 `:102-110` 与 normal 分支 `:112-122`：视频在 `getConverted` 的视频分支已返回 master 数据，控制器只需照现有代码 `setImageResponseHeaders`、`res.type(FileType2Mime(...))`、`return image.data`；Fastify 自动写 Content-Length。**不读 Range 头，不设 206**。收到 Range 头时行为等同无 Range，返回 200 全量 |
| `:140-150`、`:152-175` | 不改；404 与 meta 的 no-store 语义不变 |
| `:177-182` | `setImageResponseHeaders` 对视频加 `nosniff`（可把判断改为 SVG 或视频都加，再仅 SVG 加 CSP）；不涉及 CSP 变化 |
| `:190-202`、`:204-216` | 两处 fallback 从「master 是 SVG 才回落」改为「master 是 SVG 或视频都回落」。这样视频上传后 `/i/<id>` 无扩展名返回原片而不是占位图。抽私有方法 `isVerbatimMaster(filetype)` 判断更清晰 |
| 新增私有方法 | `sendVideoHead(res, imageId, requestedFiletype)`，内部取 info 并设头；GET 不需要新的专用方法，走 `getConverted` 视频分支即可 |

HEAD 示例写法仅供参考：

```ts
private async sendVideoHead(
  res: FastifyReply,
  imageId: string,
  requestedFiletype: string,
): Promise<void> {
  const info = ThrowIfFailed(await this.imagesService.getVideoFileInfo(imageId));
  if (info.filetype !== requestedFiletype) {
    throw Fail(FT.UsrValidation, 'Unsupported conversion', 'Video formats cannot be converted');
  }
  this.setImageResponseHeaders(res, info.filetype);
  res.type(ThrowIfFailed(FileType2Mime(info.filetype)));
  res.header('Content-Length', String(info.size));
}
```

#### 3.7 CORS、配置、上传控制器：都不改

| 文件 | 结论 |
|---|---|
| `backend/src/app.module.ts` | 不改。A 档不引入 Range，`imageCorsConfig:29-37` 无需增加头；`imageCacheSet:49-58` 的 30 天缓存继续适用；CORP `:39-47` 已是 cross-origin，直链可被第三方页面打开 |
| `backend/src/config/early/multipart.config.service.ts` | 不改。`getMaxFileSize:14-19` 与 `getLimits:21-29` 在文件内容到达前生效，无法按类型区分；视频与图片共用 `PICSUR_MAX_FILE_SIZE`，见 `.env.example:30-31` 与 `Dockerfile.allinone:62`。要更严只能部署侧调小，或做流式改造，属 B 档 |
| `backend/src/routes/image/image-manage.controller.ts` | 不改。`POST /api/image/upload:58-90` 只做 Buffer 读取、空文件拒绝、调 manager，视频走同一路径；`@EasyThrottle(20):61` 不变 |
| `backend/src/security.ts` | 不改。A 档不在页面内嵌视频，`media-src` 无需求；直链是顶层导航，不受页面 CSP 约束 |
| `backend/src/database/**` | 不改。零迁移方案不动实体、迁移注册表与 `image-db.service.create:21-48` |

#### 3.8 文档同步

| 文件 | 改动 |
|---|---|
| `.trellis/spec/picsur-backend/backend/image-api-contracts.md` | 上传字段名更正为后端不校验、前端用 `image`；新增视频条目：支持的容器、`source_filetype` 形态、`/i` 行为、无 Range 的明确说明、400 语义 |
| `.env.example:30-31` 附近 | 补一句最大文件大小同时作用于视频；不新增变量名 |
| `docs/MAINTAINING.md:106-110` | 验收清单项数随回归增量更新；备份说明补视频体积提示 |

---

### 四、视频响应契约，无 Range

适用范围：master 或 original 解析后属于 Video 类别的 `/i/*` 请求，以及上传与列表。图片契约一律不变。

#### 4.1 通用头

| 头 | 值 | 说明 |
|---|---|---|
| Content-Type | `video/mp4` 或 `video/webm` | 来自 `FileType2Mime`，不猜扩展名 |
| Content-Length | 全量字节数 | GET 由 Fastify 依据 Buffer 写；HEAD 由 `octet_length` 显式写 |
| X-Content-Type-Options | `nosniff` | 视频分支单独加；SVG 继续走既有 CSP 分支 |
| Cache-Control | `max-age=2592000` | 沿用 `app.module.ts:49-58` 的中间件 |
| Cross-Origin-Resource-Policy | `cross-origin` | 中间件已有，见 `app.module.ts:39-47` |
| Accept-Ranges | **不发** | A 档不声明 Range 能力；缺省即表示只支持全量 |

#### 4.2 逐请求期望

| 请求 | 状态 | 关键头 | 响应体 | 说明 |
|---|---|---|---|---|
| `HEAD /i/<id>.mp4` | 200 | video/mp4、Content-Length N、nosniff、month cache | 空 | 依赖 `getFileInfo`，见 3.5；当前 HEAD 实现 `image.controller.ts:61-91` 无长度头，需要新增分支 |
| `HEAD /i/<id>` 视频 | 200 | 同上 | 空 | 走 `getOriginalDownloadFileType` 的视频回落，见 3.6 |
| `HEAD /i/<id>.webm` 而 master 是 mp4 | 400 | JSON 信封 usrvalidation | 空 | 与 GET 一致，避免 HEAD 200 而 GET 400 |
| `HEAD /i/<已删除 id>.mp4` | 404 | no-store | 空 | 沿用 `image.controller.ts:84-90` |
| `GET /i/<id>.mp4` | 200 | video/mp4、Content-Length N、month cache | 全部字节，与上传字节完全相同 | master 即原片，无转码；可用 `cmp` 断言 |
| `GET /i/<id>` 视频 | 200 | 同上 | 同上 | 无扩展名回退到 master |
| `GET /i/<id>.mp4` 携带 `Range` 头 | 200 | 普通 200 头，无 Content-Range | 全量 | A 档忽略 Range；浏览器可能因此先整段下载 |
| `GET /i/<id>.mp4?width=100` | 200 | 普通视频头 | 全量 | 视频忽略编辑 query，不做拒绝 |
| `GET /i/<视频 id>.webp` | 400 | 信封 usrvalidation | `{success:false,...}` | 3.4 的 getConverted 视频分支 |
| `GET /i/<图片 id>.mp4` | 400 | 同上 | 同上 | 同上 |
| `GET /i/meta/<id>` 视频 | 200 | no-store | `data.image.source_filetype = 'video:mp4'`、`data.fileTypes.master = 'video:mp4'`、`width/height = null` | 零迁移方案下这就是视频识别依据；若加 media_kind 则多一个字段 |
| `GET /api/image/list` 或 `list/all` 的视频行 | 201 | 普通信封 | 行内 `source_filetype = 'video:mp4'` | 列表无 fileTypes，只能靠 source_filetype 判定；前端用共享纯函数判断前缀 |
| `GET /i/<已删除视频>.mp4` | 404 | no-store | 品牌占位图 image/png | 与图片一致 |
| `POST /api/image/upload` mp4 | 201 | 普通信封 | `source_filetype='video:mp4'`、`width=null`、`height=null`、`delete_key` 视权限 | 上传路径不变 |
| 上传 mov、mkv、avi、pdf 等可识别未支持格式 | 400 | 信封 usrvalidation | message 以 Unsupported upload format 开头 | 3.4 的 `:396-398` 改动 |
| 上传超过 `PICSUR_MAX_FILE_SIZE` | 413 | 信封 payloadtoolarge | 既有文案 | `upload-error.ts:20-26` 不变 |
| 上传未知字节 | 400 | 信封 usrvalidation | 既有文案 | `image.service.ts:379-387` 不变 |

#### 4.3 与缓存和 404 的交互

- `/i/*` 的 30 天缓存由中间件在处理器前写入，见 `app.module.ts:49-58`；视频 200 保留该值，因为 id 内容不可变。
- 404 与 `/i/meta` 的 no-store 不动，见 `image.controller.ts:126-137`、`:158-162`。
- 不引入 ETag、If-Range、Content-Range；这些属于 B 档。

---

### 五、数据模型取舍

#### 5.1 零迁移方案是否够用

结论：**A 档够用，推荐零迁移。**

证据与判定路径：

| 需求 | 零迁移下的实现 | 证据 |
|---|---|---|
| 上传响应标出视频 | `EImage.source_filetype` 写 `video:mp4` | `image.service.ts:142-148` 传 `fileType.identifier`；`shared/src/entities/image.entity.ts:9` |
| 详情页识别视频 | `/i/meta` 同时给 `image.source_filetype` 与 `fileTypes.master` | `backend/src/routes/image/image.controller.ts:152-175`、`shared/src/dto/api/image.dto.ts:30-44` |
| 列表识别视频 | 列表行含完整 EImage，含 `source_filetype` | `shared/src/dto/api/image-manage.dto.ts:25-31`、`image-db.service.ts:66-95` |
| 前端判定 | `IsVideoFiletypeIdentifier(image.source_filetype)`，或 meta 里 `fileTypes.master` | 3.2 的新纯函数 |
| 服务端按类型筛选 | **不支持**，需要遍历或字符串 LIKE | 列表接口无类型过滤参数，见 `image-manage.dto.ts:18-30` |
| 第三方契约显式化 | **不支持**，需要读文档知道用 `video:` 前缀 | 同上 |

局限：`source_filetype` 在 0.10.2 之前的历史行为 null，只能当图片；它字段名语义是「上传格式」，用前缀承载媒体类别属于轻度语义借用；请求列表时前端每个卡片都要做一次字符串判断。对 A 档，这三点都不构成阻塞。

#### 5.2 两个选项对比

| 维度 | 方案 A：不改表，靠 `source_filetype` 前缀 | 方案 B：加可空 `media_kind` |
|---|---|---|
| 迁移 | 无 | 1 个只加列的迁移，可回滚 |
| 后端改动 | 0 行实体与迁移 | 实体加列、迁移文件与注册、create 写入参数 |
| 前端判断 | 共享纯函数判断前缀，单点封装后不散落 | 直接读 `media_kind` |
| 旧行 | null 视为图片 | null 视为图片 |
| API 契约 | 不新增字段 | 新增可空字段，EImage 加 zod |
| 服务端筛选 | 只能 LIKE，无索引 | 可加索引与筛选参数 |
| B 档演进 | 迟早要加列 | 直接复用 |
| 回滚 | 无迁移可回滚 | down 删列；旧镜像忽略新列 |
| 工作量 | 最小 | 多约 40 行 |

#### 5.3 推荐

A 档推荐方案 A 零迁移。理由：

- 用户选择的是最小可用档，零迁移让改动面、回滚面、审查面都最小；`media_kind` 只在前端判定用，纯函数已把字符串判断收拢到一个点。
- 项目已有「新列可空、旧行 null、客户端兜底」的先例 `width/height`，说明方案 B 也不难；但没有实际消费者时先不加列，符合 YAGNI。
- 若将来做 B 档或开放第三方 SDK，再补 `media_kind` 迁移，届时旧行按 null 视为 image，成本与现在相同。

触发改用方案 B 的条件：需要服务端按媒体类型过滤或统计、需要给第三方明确的 API 契约、或者 B 档同批做转码与海报。任一成立就把 5.4 一起纳入同批。

#### 5.4 若选用方案 B 的落地写法

前提：只有 Lead 明确要显式契约时才做，A 档默认不写这些代码。

| 文件 | 改动 |
|---|---|
| `shared/src/entities/image.entity.ts:4-26` | `source_filetype` 之后加 `media_kind: z.enum(['image', 'anim', 'video']).nullable()` |
| `backend/src/database/entities/images/image.entity.ts:29-35` 之后 | 加 `@Column({ type: 'varchar', nullable: true }) media_kind: string \| null;` |
| 新迁移 `1792540800000-AddImageMediaKind.ts` | 只加列不回填；down 删列；时间戳需大于 `1792454400000` |
| `backend/src/database/migrations/index.ts:14`、`:28` | 注册 import 与数组项 |
| `backend/src/collections/image-db/image-db.service.ts:21-48` | `create` 增加 mediaKind 参数并写入 |
| `backend/src/managers/image/image.service.ts:142-148` | 调用 create 时传由 category 推导的 mediaKind |

迁移模板：

```ts
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `e_image_backend.media_kind`. Null means "image" for every row that
 * existed before this column, so no backfill is needed. Purely additive;
 * down() drops it again.
 */
export class AddImageMediaKind1792540800000 implements MigrationInterface {
  name = 'AddImageMediaKind1792540800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "e_image_backend" ADD COLUMN IF NOT EXISTS "media_kind" character varying`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "e_image_backend" DROP COLUMN IF EXISTS "media_kind"`,
    );
  }
}
```

#### 5.5 前端判定收拢

无论选哪个方案，前端都建议只在使用点调一个共享纯函数：

- 方案 A：`IsVideoFiletypeIdentifier(image.source_filetype)`，meta 场景用 `IsVideoFiletypeIdentifier(metadata.fileTypes.master)`。
- 方案 B：`image.media_kind === 'video' || IsVideoFiletypeIdentifier(image.source_filetype)`，双判覆盖混合版本与回滚。

---

### 六、测试与验证

#### 6.1 夹具

回归脚本必须自给，参考 `support/make-image-fixtures.cjs:1-25`。视频没有本地编码器，生成「结构合法、file-type 可识别」的最小容器即可满足 HTTP 断言；真实播放属于人工验收，且 A 档本来就不做页面播放器。

`file-type` 的 mp4 判定：偏移 4 必须是 `ftyp`，偏移 8 的 brand major 首字节可打印，见 `node_modules/.pnpm/file-type@21.3.4/node_modules/file-type/core.js:2148-2156`，非特殊品牌回落 mp4 与 `video/mp4`。20 字节头即可：

```
00 00 00 14 66 74 79 70 69 73 6F 6D 00 00 02 00 69 73 6F 6D
```

mov 负例用品牌 `qt  `，同样 20 字节 ftyp 头让 file-type 报 `video/quicktime`，见同文件 `:2161-2163`。

建议新增 `support/make-video-fixtures.cjs`，或扩展 `make-image-fixtures.cjs` 的格式清单 `:39`：

- `base.mp4`：20 字节 ftyp 头加 1MiB 确定性字节，用于正例与 Content-Length 断言。
- `base.mov`：20 字节 ftyp 头加 512 字节，用于 400 负例。
- `base.webm`：可选，EBML 头加 DocType `webm`，见 `core.js:1612, 1651-1654`；手写 EBML 长度字段容易出错，是否纳入回归标待确认。

#### 6.2 curl 断言

以下片段可直接粘贴，假设已有实例与管理员口令。

```bash
BASE=http://127.0.0.1:8080
PW=<PICSUR_ADMIN_PASSWORD>
FX=/tmp/video-fx
TOKEN=$(curl -s -X POST "$BASE/api/user/login" -H 'Content-Type: application/json' \
  -d "{\"username\":\"admin\",\"password\":\"$PW\"}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin).get("data",{}).get("jwt_token",""))')
AUTH="Authorization: Bearer $TOKEN"
SIZE=$(stat -c %s "$FX/base.mp4")

# 1 上传
CODE=$(curl -s -o /tmp/up.json -w '%{http_code}' -X POST "$BASE/api/image/upload" \
  -H "$AUTH" -F "image=@$FX/base.mp4")
ID=$(python3 -c 'import json;print(json.load(open("/tmp/up.json")).get("data",{}).get("id",""))')
python3 - <<'PY'
import json
d = json.load(open('/tmp/up.json'))
assert d['statusCode'] == 201, d
img = d['data']
assert img['source_filetype'] == 'video:mp4', img
assert img['width'] is None and img['height'] is None, img
print('upload json ok')
PY

# 2 HEAD
curl -sI "$BASE/i/$ID.mp4" | tr -d '\r' | grep -iE '^(HTTP/|content-type|content-length|cache-control)'
# 期望 200、video/mp4、Content-Length == $SIZE、Cache-Control: max-age=2592000

# 3 GET 全量且字节一致
CODE=$(curl -s -o /tmp/got.mp4 -D /tmp/h1 -w '%{http_code}' "$BASE/i/$ID.mp4")
test "$CODE" = 200
cmp "$FX/base.mp4" /tmp/got.mp4 && echo 'GET byte-identical'
curl -sI "$BASE/i/$ID.mp4" | grep -i '^content-type' | tr -d '\r'   # video/mp4
grep -i '^content-length' /tmp/h1 | tr -d '\r'                     # $SIZE

# 4 无扩展名回退
curl -s -o /tmp/got2 -w '%{http_code} %{content_type}\n' "$BASE/i/$ID"   # 200 video/mp4
cmp "$FX/base.mp4" /tmp/got2 && echo 'no-ext GET byte-identical'

# 5 meta 识别
curl -s "$BASE/i/meta/$ID" -D /tmp/h2 -o /tmp/meta.json
python3 -c 'import json;d=json.load(open("/tmp/meta.json"));print(d["data"]["image"]["source_filetype"], d["data"]["fileTypes"]["master"])'
# video:mp4 video:mp4
grep -i '^cache-control' /tmp/h2 | tr -d '\r'   # no-store

# 6 列表识别
curl -s -X POST "$BASE/api/image/list" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"count":10,"page":0}' -o /tmp/list.json
python3 -c 'import json;d=json.load(open("/tmp/list.json"));print([i["source_filetype"] for i in d["data"]["results"] if i["source_filetype"] and i["source_filetype"].startswith("video:")])'

# 7 扩展不匹配
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/i/$ID.webp"   # 400
curl -s -o /dev/null -w '%{http_code}\n' -I "$BASE/i/$ID.webm"  # 400

# 8 可识别未支持容器 -> 4xx 而非 500
CODE=$(curl -s -o /tmp/mov.json -w '%{http_code}' -X POST "$BASE/api/image/upload" -H "$AUTH" -F "image=@$FX/base.mov")
python3 -c 'import json;d=json.load(open("/tmp/mov.json"));print(d["success"], d["data"]["type"])'
# 期望 400 与 False usrvalidation

# 9 超限 413，可选：在限流上限调小的实例上跑，或用大于 PICSUR_MAX_FILE_SIZE 的文件
# curl -s -o /tmp/big.json -w '%{http_code}\n' -X POST "$BASE/api/image/upload" -H "$AUTH" -F "image=@$FX/too-big.bin"  # 413

# 10 删除后
curl -s -X POST "$BASE/api/image/delete" -H "$AUTH" -H 'Content-Type: application/json' -d "{\"ids\":[\"$ID\"]}" -o /dev/null
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/i/$ID.mp4"       # 404
curl -s -o /dev/null -w '%{http_code}\n' -I "$BASE/i/$ID.mp4"    # 404
curl -s -D - -o /dev/null "$BASE/i/$ID.mp4" | grep -i '^cache-control' | tr -d '\r'  # no-store
```

#### 6.3 回归脚本增量

文件：`support/regression-image-api.sh`，今日 243 行。

| 位置 | 改动 |
|---|---|
| `:1-2` 头注释 | 项数描述更新为实际新增后的数字 |
| `:69-90` `== 0. fixtures ==` | 增加 `VIDEO_FORMATS=(mp4 mov)` 检测与生成；生成器 `make-video-fixtures.cjs`；失败时沿用现有 FATAL 退出风格 `:81-92` |
| `:176-187` 第 9 节之后 | 新增 `== 10. video upload and direct link ==`，复用 `ok`、`bad`、`check` 函数 `:31-34` |
| `:243` 结果行 | 不动，计数自动增加 |

新增检查项，逐条可断言：

1. 上传 mp4 返回 201 且 `source_filetype` 为 `video:mp4`。
2. 上传 mp4 返回 `width` 与 `height` 为 null。
3. `HEAD /i/<id>.mp4` 为 200 且 Content-Type 为 video/mp4。
4. HEAD 的 Content-Length 等于夹具字节数。
5. 全量 GET 为 200 且字节与夹具 cmp 一致。
6. GET 的 Content-Type 为 video/mp4 且 Content-Length 等于夹具字节数。
7. `/i/<id>` 无扩展名为 200 video/mp4。
8. `/i/<id>.webp` 为 400。
9. 上传 mov 为 400 且 type 为 usrvalidation。
10. 上传未知字节为 400，沿用现有断言风格。
11. `/i/meta/<id>` 为 200 且 `source_filetype` 与 `fileTypes.master` 以 video: 开头，cache 为 no-store。
12. 列表返回的视频行 `source_filetype` 以 video: 开头。
13. 删除后视频 GET 与 HEAD 均为 404 no-store。
14. 图片回归 34 项仍全过。

限流说明：新增约 15 次请求，原套件约 50 次，`/i/*` 与上传分别有 600 每分钟与 20 每分钟的桶，脚本 429 退避包装 `:47-68` 可复用。

#### 6.4 探针增量

文件：`support/gallery-layout-probe.cjs`。

| 位置 | 当前行为 | 改动 |
|---|---|---|
| `:56-57` | 卡片内查找 `picsur-img canvas, picsur-img img` | 视频卡片没有 picsur-img，需要跳过并单独断言 |
| `:139` | 弹出层同类 query | 同上 |
| `:200-201` | 全量 `picsur-img` 枚举 | 同上 |
| `:545-546` | 等待所有 picsur-img 就绪 | 只统计图片卡片；视频卡片额外断言 `[data-media-kind="video"]` 存在 |

建议视频卡片根节点加 `data-media-kind="video"`，探针按该属性区分，避免依赖 DOM 形状。

#### 6.5 手动验收

1. 上传页选择器过滤到图片与 mp4、webm；拖入 mov 或 pdf 时前端立即提示不支持，不发请求。
2. 上传 mp4 成功，进入详情页，页面不出现损坏图片，显示视频占位、直链与下载入口。
3. 点击直链在新标签打开，浏览器按 Content-Type 处理，能播放或下载。
4. 下载入口拿到 `.mp4` 文件名与正确字节。
5. 图库视频卡片显示占位与 VIDEO 徽章；图片卡片布局不变。
6. 图片详情页格式下拉不出现 MP4、WEBM；原有图片转码与下载不变。
7. 删除视频后详情页 404，直链 404 且 no-store。
8. 上传 mov：得到 400 提示而不是 500。

---

### 七、范围边界与风险

#### 7.1 A 档无 Range 的影响：用户已接受的范围边界

用户已在弹窗中选择 A 档「只上传与直链」，以下影响是知情接受，**不作为待确认项**，仅记录供文档与验收参考：

| 编号 | 影响 | 说明 |
|---|---|---|
| A1 | 浏览器跳转播放可能整段下载 | 服务端不声明 Accept-Ranges 且忽略 Range 头，返回 200 全量；大文件首帧慢，进度拖动不可用 |
| A2 | Safari 与移动端兼容性差 | 无 Range 时 Safari 可能无法播放或频繁失败；移动网络下体验明显变差 |
| A3 | 内存与带宽放大 | 每次取视频都是全量 Buffer，并发观看把内存与出口带宽按文件大小乘以并发数放大 |
| A4 | 无海报、无时长、无缩略图 | 图库只能显示占位；用户看不到内容预览 |
| A5 | 无转码 | 容器合法但编码是 HEVC 等浏览器不支持编码时，用户下载后本地播放器可能可放，浏览器直链可能不能 |
| A6 | 无内容校验 | 只按容器魔数识别，音频 webm 等会被当成视频接收 |

产品文案与文档需要如实描述「直链可下载、页面内不播放」，不要把 A 档包装成视频站体验。B 档再补 Range、转码与海报。

#### 7.2 其余风险

| 编号 | 风险 | 触发 | 影响 | 缓解 | 验证 |
|---|---|---|---|---|---|
| R1 | 上传内存峰值约两倍文件大小 | `toBuffer` 全量读取与后续拼接 | 128MB 文件可能瞬时 256MB | A 档接受；B 档流式改造 | 用 128MB 文件上传观察 RSS |
| R2 | 取视频全量加载 | 每次 GET 与 HEAD 之外的全量读取 | 单请求占用等于文件大小，多并发会放大 | 部署侧评估内存；必要时调小 `PICSUR_MAX_FILE_SIZE` | 并发 GET 观察 RSS |
| R3 | Content-Length 不一致 | HEAD 与实际字节不匹配 | 客户端进度或下载显示异常 | HEAD 用 `octet_length`，GET 用同一份字节；回归断言两者相等 | 6.3 检查 4 与 6 |
| R4 | 可识别未支持容器仍会 500 | 忘记改 `image.service.ts:396-398` | 用户得到内部错误 | 该改动必须与视频同批上线 | mov 负例 |
| R5 | 白名单放开容器过早 | 把 mov、mkv、avi 加进白名单 | 浏览器大多不可播，体验差且支持面变复杂 | A 档只收 mp4 与 webm；其余 400 并列格式说明 | 回归负例 |
| R6 | 格式下拉出现视频选项 | `SupportedFileTypes` 扩集后 `util.service.ts:36-65` 未过滤 | 图片详情页出现 MP4、WEBM，点选后 400 | 前端格式下拉过滤 Video 类，见前端清单 | 手动查看图片详情页下拉 |
| R7 | 探针把视频卡片当图片等待 | `picsur-img` 选择器未加条件 | 探针超时或统计错误 | 加 `data-media-kind` 并跳过 | 跑 gallery-layout-probe |
| R8 | 混合版本前端 | 新前端遇旧后端或缺 `media_kind` | 列表无法判定视频，出现损坏图片 | `IsVideoFiletypeIdentifier` 双判 source_filetype 与 fileTypes.master | 交叉部署手动验证 |
| R9 | 备份与 WAL 体积 | 视频直接入库 | 备份与恢复变慢，单字段上限 1GB，WAL 峰值升高 | 文档提示；可选把 bytea 存储策略改 EXTERNAL 作为 P2 | 上传后看库大小与 WAL |
| R10 | 下载走 XHR 全量缓冲 | 前端用 DownloadService.getBuffer | 浏览器内存与等待时间放大 | 视频下载用直链锚点或不走 XHR，见前端清单 | 下载大文件观察浏览器内存 |
| R11 | 上传字段名误解 | spec 写 `file`，前端用 `image` | 联调时误判 | 文档更正；回归用 `image` | 回归上传成功即证明 |
| R12 | 无播放器导致用户误解 | 详情页只有直链与下载 | 用户以为功能坏了 | i18n 明确说明「页面内不播放」；文档写清 A 档边界 | 手动验收与文案评审 |

---

### 八、待确认

1. 零迁移方案是否被 Lead 采纳：推荐采纳；若坚持显式契约则按 5.4 加 `media_kind`，工作量多约 40 行。
2. webm 是否纳入 A 档白名单：合成 EBML 夹具的 `file-type` 识别需实测，建议先用 `fileTypeFromBuffer` 验证再定。
3. 是否提交一枚真实 mp4 夹具：自动化只测 HTTP 语义；真实浏览器直链行为需要人工或提交小样本。
4. `PICSUR_MAX_FILE_SIZE` 是否本次下调：128MB 视频的内存与备份代价需要部署侧确认。
5. 详情页下载入口形态：直链锚点还是复用 DownloadService 的 XHR 下载；前者省内存，后者能显示进度，见前端清单。
6. 是否在本次同批暴露上传进度：进度能力已有，但不属于收窄后的必做项。

## Related Specs

- `.trellis/spec/picsur-backend/backend/image-api-contracts.md`
- `.trellis/spec/picsur-backend/backend/database-guidelines.md`
- `.trellis/spec/picsur-backend/backend/error-handling.md`
- `.trellis/spec/picsur-backend/backend/build-and-deploy.md`
- 前端清单：`01-frontend-i18n.md`
- 前序评估：`.trellis/tasks/10-25-video-support-eval/research/backend.md`
