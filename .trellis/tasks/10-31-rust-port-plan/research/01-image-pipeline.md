# Research: 图片处理链路

- Query: 盘点上传、格式识别与转换、EXIF 与元数据、缩略图与派生图、去重、存储方式、支持格式与依赖库
- Scope: internal
- Date: 2026-10-31
- 证据基线: git master b6bd23c

## Findings

### 一、上传链路，逐步

1. 路由 `POST /api/image/upload`，要求 `image-upload` 权限，限流 20 次，只接受 1 个文件。`routes/image/image-manage.controller.ts:58-66`
2. multipart 解析，单文件上限来自 `PICSUR_MAX_FILE_SIZE`，默认 128000000 字节，字段上限 files=1。`config/early/multipart.config.service.ts:14-29`
3. 前端表单字段名为 `image`。`frontend/src/app/models/dto/image-upload-request.dto.ts:6-10`
4. 空文件直接拒绝，错误类型 usrvalidation。`image-manage.controller.ts:76-78`
5. 读取整个文件到内存 Buffer，再交给图片管理服务。`image-manage.controller.ts:69-88`
6. 格式识别：`file-type` 嗅探二进制，QOI 用 `qoi-img` 检测，SVG 用 `is-svg`，WebP 再区分静图与动图。`managers/image/image.service.ts:359-402`
7. SVG 先做安全清洗，其余格式直接进入转码。`image.service.ts:112-118`、`managers/image/svg-security.service.ts:41-69`
8. 读取用户偏好 `keep_original`，默认 false。`image.service.ts:120-126`、`collections/preference-db/preference-defaults.service.ts:18-22`
9. 生成主文件：静图转 QOI，动图转 animated WebP，SVG 原样保留。`managers/image/image-processor.service.ts:36-68`
10. 写 `e_image_backend` 行，含文件名去扩展名、source_filetype、宽高、删除密钥。`image.service.ts:134-149`、`collections/image-db/image-db.service.ts:21-48`
11. 写主文件到 `e_image_file_backend`，variant=master。`image.service.ts:151-157`
12. 若 keep_original，再写一份原文件，variant=original。`image.service.ts:159-167`
13. 返回图片元数据，含 delete_key 当且仅当调用者有 `image-delete-key`。`image-manage.controller.ts:65, 80-89`

### 二、支持的格式

| 类别 | 格式 | 证据 |
|---|---|---|
| 静图 | QOI、JPEG、PNG、WEBP、SVG、TIFF、AVIF、HEIF、JXL、JP2、BMP | `shared/src/dto/mimes.dto.ts:4-17` |
| 动图 | GIF、WEBP | `shared/src/dto/mimes.dto.ts:19-23` |
| 已注释未启用 | ICO、APNG | `mimes.dto.ts:16, 22, 53, 65, 90, 102` |

MIME 与扩展名映射见 `shared/src/dto/mimes.dto.ts:48-117`，前端格式列表来自 `GET /api/info/formats`。

### 三、主文件与转换策略

| 输入类别 | 主文件格式 | 说明 | 证据 |
|---|---|---|---|
| 静图 | QOI | 统一内部格式，质量与体积折中 | `managers/image/image-processor.service.ts:36-55` |
| 动图 | animated WEBP | lossless、effort 0 | `image-processor.service.ts:57-68` |
| SVG | 原样 SVG | 矢量无法栅格转码，存清洗后的文本 | `image-processor.service.ts:44-49` |

转换服务在源格式与目标格式相同且无操作参数时直接返回原 Buffer，避免无意义编码。`managers/image/image-converter.service.ts:46-54`

### 四、转换参数与操作

请求参数，全部可选：height、width、rotate、flipx、flipy、greyscale、noalpha、negative、shrinkonly、quality。`shared/src/dto/image.dto.ts:8-24`

对应 sharp 操作：

| 参数 | 操作 | 证据 |
|---|---|---|
| width、height 同给 | resize fit fill，可 withoutEnlargement | `image-converter.service.ts:111-120` |
| 只给一个 | resize fit inside | `image-converter.service.ts:120-130` |
| rotate | rotate，背景透明 | `:131-135` |
| flipx | flop | `:136-138` |
| flipy | flip | `:139-141` |
| noalpha | removeAlpha | `:142-144` |
| negative | negate | `:145-147` |
| greyscale | greyscale | `:148-150` |
| quality | 输出编码质量 | `:152-153`、`workers/sharp/universal-sharp.ts:80-137` |

编辑参数是否生效受系统偏好 `allow_editing` 控制，关闭时忽略全部参数。`managers/image/image.service.ts:180-186`

SVG 目标的特殊规则：只能从 SVG 主文件出，且不允许任何编辑参数，否则返回 usrvalidation。`image.service.ts:191-214`

### 五、worker 进程模型

- 每次转换租用一个子进程，进程池全局共享，最多 `min(4, CPU 核数)` 个并发。`workers/sharp/worker-pool.ts:24-27, 536-541`
- 子进程 60 秒空闲后被回收。`worker-pool.ts:30, 315-346`
- 子进程通过 `setrlimit` 限制内存，限制值来自系统偏好 `conversion_memory_limit`，默认 512MB。`workers/sharp/sharp.worker.ts:49-56`、`preference-defaults.service.ts:48`
- 单次转换超时来自 `conversion_time_limit`，默认 15s。`managers/image/image-converter.service.ts:73-84`、`preference-defaults.service.ts:47`
- 失败或超时的 worker 一律销毁，不重用。`workers/sharp.wrapper.ts:236-250`
- 主进程先做像素上限预检，避免无谓拉起 worker。`image-converter.service.ts:166-222`
- worker 端再做一次像素上限兜底，并区分「用户输入问题」与「内部错误」，把前者转成 4xx。`workers/sharp/sharp.worker.ts:110-138`、`shared/src/util/image-pixel-limit.ts:77-129`
- 转换互斥：同一图片同一转换键用 mutex 防止并发重复计算。`managers/image/image.service.ts:216-226`、`util/mutex-fallback.ts`

### 六、自定义编解码

- BMP：用 `bmp-img` 解码为 raw，再喂给 sharp；输出时 sharp 出 raw 再 `BMPencode`。`workers/sharp/universal-sharp.ts:33-43, 142-157`
- QOI：用 `qoi-img` 解码与编码，中间同样走 raw。`universal-sharp.ts:60-71, 159-174`
- 单通道 raw 会扩展为 3 通道再编码。`universal-sharp.ts:176-190`
- 动图 WebP 识别用自写 RIFF 解析器。`managers/image/webpinfo/webpinfo.ts`、`managers/image/image.service.ts:390-394`

### 七、派生图缓存与清理

- 缓存键 = sha256 对 `{mime, ...options}` 的 JSON 字符串，十六进制。`managers/image/image.service.ts:216, 404-411`
- 命中直接返回；未命中则转换并写 `e_image_derivative_backend`。`image.service.ts:218-286`
- 若目标格式就是主文件格式且无编辑参数，直接返回主文件，不写缓存副本。`image.service.ts:248-258`
- 每图派生图上限默认 100，来自 `PICSUR_MAX_DERIVATIVES_PER_IMAGE`；达到上限仍返回但不入库。`config/early/image.config.service.ts:9-12, 62-75`、`image.service.ts:260-277`
- LRU 口径是 `last_read`，读取时最多每天更新一次；清理任务每分钟跑一次，按偏好 `remove_derivatives_after` 删除，默认 7d，最小 60 秒。`collections/image-db/image-file-db.service.ts:159-184`、`managers/image/image-manager.module.ts:40-69`、`preference-defaults.service.ts:44`
- 过期图片按 `expires_at < now` 删除，同一分钟级任务。`image-manager.module.ts:71-81`、`collections/image-db/image-db.service.ts:231-241`

### 八、存储方式

- 主文件、原文件、派生图全部以 bytea 存 Postgres，没有本地目录、没有 S3 适配层。`database/entities/images/image-file.entity.ts:40-42`、`database/entities/images/image-derivative.entity.ts:46-48`
- 镜像注释明确「上传内容存 Postgres，不落盘」。`Dockerfile:160-163`
- 没有内容级去重：相同文件重复上传会产生多条 image 行与多份字节。`collections/image-db/image-db.service.ts:21-48`，无 hash 列
- 唯一的 hash 用途是转换缓存键，不是内容寻址存储。`managers/image/image.service.ts:404-411`

### 九、SVG 安全链路

- 上传时用 svgo 优化并移除脚本，再经 DOMPurify 清洗，禁止 foreignObject、script、iframe、object、embed。`managers/image/svg-security.service.ts:41-69`
- 只允许片段引用与内联光栅 data URI 作为 href，其余一律删除。`svg-security.service.ts:12-29`
- 响应时对 SVG 加 `Content-Security-Policy: sandbox; default-src 'none'; ...` 与 nosniff。`routes/image/image.controller.ts:26-40, 177-182`
- 清洗后仍不是合法 SVG 则拒绝上传。`svg-security.service.ts:56-62`

### 十、响应与缓存语义

- `/i/:id` 无扩展名返回 original，若未保存原文件则对 SVG 回退到 master，其余格式返回 404 占位图。`routes/image/image.controller.ts:184-216`
- `/i/:id.:ext` 返回按扩展名转换的派生图。`image.controller.ts:93-122`
- 成功响应携带 30 天 `Cache-Control`，由中间件统一设置。`backend/src/app.module.ts:49-58`
- 404 改为 `no-store` 并返回品牌占位图。`image.controller.ts:123-137, 147-150`
- `/i/meta/:id` 显式 `no-store`。`image.controller.ts:158-162`
- HEAD 用于探测存在性，删除后必须返回 404，见 `image.controller.ts:61-91`

### 十一、像素与体积上限

| 限制 | 默认 | 环境变量 | 证据 |
|---|---|---|---|
| 上传体积 | 128000000 字节 | `PICSUR_MAX_FILE_SIZE` | `multipart.config.service.ts:14-19` |
| 像素总数 | 268402689，即 0x3FFF 的平方 | `PICSUR_MAX_IMAGE_PIXELS`，0 表示不限 | `shared/src/util/image-pixel-limit.ts:12-16, 28-34` |
| 每图派生图数 | 100，0 表示不限 | `PICSUR_MAX_DERIVATIVES_PER_IMAGE` | `image.config.service.ts:9-12, 78-82` |
| 单次转换内存 | 512MB | 系统偏好，非环境变量 | `preference-defaults.service.ts:48` |
| 单次转换时间 | 15s | 系统偏好，非环境变量 | `preference-defaults.service.ts:47` |
| 并发 worker 数 | min(4, CPU 核数)，无环境变量 | 无 | `worker-pool.ts:19-27` |

### 十二、EXIF 与元数据

- 仓库没有 EXIF 读取、写入或方向纠正代码，全仓 grep 无 exif 相关实现。
- 静图上传后统一转码为 QOI，转码天然丢弃 EXIF 与所有元数据；动图转 WebP 同理。
- 仅当用户开启 `keep_original` 时原文件字节被完整保留，此时 EXIF 也随之保留。`managers/image/image.service.ts:159-167`
- 不自动按 EXIF 方向旋转，只有显式 `rotate` 参数才旋转。`image-converter.service.ts:131-135`
- 图片宽高来自转码输出，SVG 无解码则留空，见 `managers/image/image-converter.service.ts:156-163`、`imageresult.ts:1-12`
- 待确认：sharp 是否默认剥离全部元数据，需要在 Rust 实现时对齐输出字节语义，验证方式是取同一 fixture 对比输出与 API 元数据。

### 十三、相关脚本与基线

- 图片 API 回归脚本，含 34 项检查，见 `support/regression-image-api.sh:31-32, 243`，CI 注释说明该脚本在开发机手动跑，`ci.yml:17-18`
- 上传性能基准脚本，测量延迟、worker 峰值、RSS、容器 CPU，见 `support/bench-upload.cjs:1-36`
- 测试图片生成脚本 `support/make-image-fixtures.cjs`，画廊布局与对比度探针 `support/gallery-layout-probe.cjs`、`support/visual-contrast-probe.cjs`
- 单图多核调研 задача已归档，见任务目录 `.trellis/tasks/archive` 与 `git log` 的 10-30 提交

### 十四、与迁移直接相关的风险点

- QOI 是内部主格式，Rust 侧必须能无损读写 QOI，否则所有存量主文件无法服务。
- BMP、QOI 使用 JS 编解码而非 libvips，行为可能与 Rust 库不同，例如通道数扩展逻辑，见 `universal-sharp.ts:176-190`。
- HEIF、JXL、JP2 依赖自编译 libvips 与编解码插件；用预编译 sharp 会缺失这些能力，见 `Dockerfile:66-70, 139-144`。
- 派生图缓存键是 JSON 字符串的 sha256，键的构造顺序与字段集合必须完全一致，否则老缓存全部失效，见 `image.service.ts:216, 404-411`。
- SVG 清洗逻辑依赖 svgo 与 DOMPurify 的具体行为，Rust 侧需要等价白名单策略，不能只做 XML 解析，见 `svg-security.service.ts:19-29`。
- 图片响应缓存头由中间件统一设置，错误分支再覆盖，迁移时若漏掉会导致 404 被缓存 30 天，见 `app.module.ts:49-58`、`image.controller.ts:140-150`。

## Caveats / Not Found

- 早期 WebP 动图解析细节未逐行核对，见 `managers/image/webpinfo/` 两个文件，标「待确认」。
- 未找到缩略图专用生成逻辑：缩略图就是带上 width 或 height 的派生图，由前端按需请求，见 `frontend/src/app/components/picsur-img/picsur-img.component.ts` 与 `image.service.ts:210-243`。
- 未发现图片删除时的存储层联动清理（文件表依赖外键级联），删除 image 行即级联删 file 与 derivative，见 `database/entities/images/image-file.entity.ts:20-31`。
- EXIF 方向与元数据行为需要实证对比，仓库内无测试覆盖。

## Related Specs

- `.trellis/spec/picsur-backend/backend/image-api-contracts.md`
- `.trellis/spec/picsur-backend/backend/upload-concurrency.md`
- `.trellis/spec/picsur-backend/backend/quality-guidelines.md`
