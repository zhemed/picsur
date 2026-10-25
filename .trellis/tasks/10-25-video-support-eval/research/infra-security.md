# Research: 视频支持评估 —— 部署 / 限额 / 安全 / 上游先例

- Query: 评估把 Picsur 扩展为支持视频上传时的部署、资源与限额、安全影响、配置项与上游先例（本轮只评估不实现）
- Scope: mixed（仓库内部只读 + 公开互联网只读检索）
- Date: 2026-10-25
- 角色: infra-recon（只读调研员）；本文件是本轮唯一写入
- 只读边界: 未改代码/配置、未装依赖、未重启服务、未 git 写操作；未读 `.env` 内容（只看 `.env.example` 的变量名）；网络只访问公开页面，无登录态、无写操作

## 1. 结论

1. **部署形态是「单容器 all-in-one + 应用直接对外 8080 明文 HTTP」**：仓库唯一文档化的部署方式是 `docker run ... ghcr.io/zhemed/picsur:allinone`，没有 nginx/Caddy/Traefik 配置，TLS 只能由外部另加；应用本身（Fastify）监听 `0.0.0.0:8080`（README.md:6-14、docs/MAINTAINING.md:5-20、backend/src/main.ts:57-59、backend/src/config/early/host.config.service.ts:50-55）。当前实例实测端口发布为 `0.0.0.0:8080`。
2. **上传链路不是流式的**：整个文件先 `file.toBuffer()` 读进内存，再交给 sharp 子进程（Buffer 经 IPC 复制）或写入 Postgres `bytea`；应用不落盘（image-manage.controller.ts:69-74、backend/src/workers/sharp.wrapper.ts:54-65、backend/src/database/entities/images/image-file.entity.ts:41-42、Dockerfile:160-162）。视频体积会把内存、数据库/WAL、备份成本同时放大。
3. **完全没有 Range/206 支持**：`grep` 在 backend/src、shared/src 里对 `Accept-Ranges`、`Content-Range`、`Range`、`createReadStream`、`StreamableFile` 均 0 命中；`/i/:id` 直接返回整块 Buffer（backend/src/routes/image/image.controller.ts:93-138）。视频拖动进度、边下边播必须先补 Range，而 `bytea` 存储无法按块流式读取 —— 这是「只存原片」档的第一个硬前提。
4. **现有图片防线较完整，视频新增风险集中在 ffmpeg、转码炸弹、磁盘耗尽与公开直链带宽滥用**：现有防线是魔数白名单 + SVG 净化 + 文件大小/像素上限 + 子进程 15s/512MB 限制 + 上传 20 次/分 + `/i` 600 次/分 + 仅登录且有上传权限的用户（image.service.ts:359-402、mimes.dto.ts:4-32、svg-security.service.ts:41-69、image-manage.controller.ts:58-61、image.controller.ts:42-52）。镜像当前**没有** ffmpeg/ffprobe（`docker exec picsur command -v ffmpeg` exit 127；源码 grep 0 命中）。
5. **上游没有先例**：`rubikscraft/Picsur` 已转到 `CaramelFur/Picsur` 且 README 明确写 NOT MAINTAINED；README 功能清单无视频，issue/PR 搜索 `video`/`videos`/`mp4`/`ffmpeg`/`audio` 全部 0 命中（URL 见第 6 节）。本仓不是 fork、自维护版本线 0.10.6，拿不到上游现成实现。
6. **建议路线**：分两档。档 A（MVP）：只收 MP4（H.264/AAC，faststart）原片直出，**必须**同时做文件系统存储 + Range 流式 + 严格限额，不做转码；档 B（二期）：转码 720p + 海报，ffmpeg 必须独立进程/容器、无网络、硬超时、并发 1。建议默认限额见第 7 节（**建议值，非实测**）。

## 2. 部署现状

### 2.1 部署形态：单容器 all-in-one，仓库内已无编排文件

- 唯一文档化方式：`docker run -d --name picsur --restart always -p 8080:8080 -v ./data:/data -v /var/run/docker.sock:/var/run/docker.sock ghcr.io/zhemed/picsur:allinone`（README.md:6-14；docs/MAINTAINING.md:5-20）。数据全在 `/data`（Postgres + `allinone.env`）。
- 仓库已没有 docker-compose / install.sh：`git ls-files | grep -c 'docker-compose'` = 0；跟踪的部署相关文件只有 `Dockerfile`、`Dockerfile.allinone`、`docs/MAINTAINING.md`、`support/allinone-entrypoint.sh`。
- 注意文档漂移：`.trellis/spec/picsur-backend/backend/build-and-deploy.md` 仍大量描述 compose / install.sh（例如 :71-76、:93-96、:344、:455），与当前仓库不符；部署事实以 README / docs/MAINTAINING.md 为准。
- 镜像结构：

| 阶段/文件 | 基础镜像 | 要点 | 证据 |
|---|---|---|---|
| 常规镜像 JS 构建 | `node:20`（digest 锁定） | pnpm 9.6.0、三包构建、裁剪只留 dist/package.json/branding | Dockerfile:36-64 |
| 常规镜像 libvips | `node:20-alpine`（digest 锁定） | 源码编译 libvips 8.18.7，14 个 apk 包全部锁到 `-rN` 精确版本 | Dockerfile:71-94 |
| 常规镜像生产依赖 | 复用 vips_builder | sharp 必须显式源码构建才拿到自编译 libvips 全量编解码 | Dockerfile:116-144 |
| 常规镜像最终阶段 | 复用 vips_runtime | `PICSUR_PRODUCTION=true`；`USER node`（非 root）；应用只写 DB 与 `/tmp`，上传内容存 Postgres 不落盘 | Dockerfile:149-172 |
| all-in-one | 常规镜像最终阶段 | 加 PostgreSQL 17 + tini + su-exec；`/data` 唯一数据卷；**保持 root**（initdb/chown + 自升级要 docker.sock）；HEALTHCHECK `/api/info` | Dockerfile.allinone:21-75 |

- all-in-one 是「常规镜像 + 内嵌 Postgres」，不是另一条构建产物：以 `ARG PICSUR_BASE_IMAGE` 指定的常规镜像为基础（Dockerfile.allinone:21-22），入口 `tini → allinone-entrypoint.sh`（Dockerfile.allinone:74-75），数据目录 `/data`、`PGDATA=/data/postgres`（support/allinone-entrypoint.sh:21-30）。
- 生产环境变量在 all-in-one 里写死一组默认：`PICSUR_PRODUCTION=true`、`PICSUR_HOST=0.0.0.0`、`PICSUR_PORT=8080`、`PICSUR_MAX_FILE_SIZE=128000000`、`PICSUR_DATA_DIR=/data`（Dockerfile.allinone:53-64）。

### 2.2 对外暴露与 TLS 终止点

- 应用自己监听对外端口：`app.listen(PICSUR_PORT, PICSUR_HOST)`，默认 `0.0.0.0:8080`（backend/src/main.ts:57-59；host.config.service.ts:50-55）。
- 仓库内没有任何反向代理/TLS 配置：`grep -rniE "nginx|caddy|traefik|haproxy|ssl_certificate|letsencrypt" README.md docs/ Dockerfile Dockerfile.allinone support/ .github/ backend/src frontend/src` 0 命中。
- 因此 **TLS 不在仓库/镜像内终止**：README 让用户直接打开 `http://<主机>:8080`（README.md:16）；Helmet 配了 HSTS（backend/src/security.ts:27），但在明文 HTTP 下不生效。要 HTTPS 必须用户自备反代，而反代不在本项目部署契约里。
- 代理相关：Fastify 只设了 `trustProxy` 为私网段（backend/src/main.ts:24-31）；若外部反代不在私网段，限流按代理 IP 统计。CORS：`/i` 通配路由的 origin 为通配（任意站点可跨域取图），其它 API 的 origin 被限制为占位值（backend/src/app.module.ts:25-37）；`/i` 通配路由另设 30 天 Cache-Control（app.module.ts:49-58）；前端静态资源由 Nest ServeStatic 托管（app.module.ts:63-66；backend/src/config/early/serve-static.config.service.ts:32-45）。

### 2.3 上传请求沿途的大小/超时限制

| 层 | 当前值 | 证据 | 对视频的含义 |
|---|---|---|---|
| Fastify 全局 bodyLimit | 1,048,576 B（1MiB，JSON body） | Fastify 5.12.5 默认值 `defaultInitOptions`（node_modules/.pnpm/fastify@5.12.5/node_modules/fastify/lib/config-validator.js:1265）；main.ts 未覆盖 | 不适用于 multipart 文件；不要误以为是上传上限 |
| Fastify 请求超时 | `requestTimeout=0`、`connectionTimeout=0`（禁用） | 同上默认值；fastify.js:887-914 应用默认值；lib/server.js:340 写入 server.requestTimeout | 服务端没有上传超时；慢速大文件可长期占用连接 |
| keepAliveTimeout | 72,000 ms | 同上 | 与视频无关，但大文件分块请求会复用连接 |
| multipart 限制 | fieldNameSize 128、fieldSize 1024、fields 20、files 20（上传接口强制 1）、fileSize=`PICSUR_MAX_FILE_SIZE` | backend/src/config/early/multipart.config.service.ts:14-29；postfiles.pipe.ts:17-27；image-manage.controller.ts:63 `@PostFiles(1)` | 视频单文件上限可直接复用该值，但 128MB 对内存/DB 太重 |
| 上传文件上限 | 默认 128,000,000 B（约 122MiB） | multipart.config.service.ts:14-19；.env.example:27-28；Dockerfile.allinone:61 | 视频若沿用 128MB，单次上传内存峰值远超 128MB |
| 上传读取方式 | `file.toBuffer()` 整块读入内存 | image-manage.controller.ts:69-74 | 非流式；视频需要改成磁盘流式写入或分块 |
| 上传错误映射 | 超限 → 413 `PayloadTooLarge`；中断/畸形 → 4xx | backend/src/util/upload-error.ts:11-50 | 视频格式错误需要同样映射为 4xx（当前视频 mime 会 500，见 4.1） |
| 鉴权 | `POST /api/image/upload` 需要 `ImageUpload` 权限 | image-manage.controller.ts:58-61；shared/src/dto/permissions.enum.ts:5-9 | 非 demo 实例匿名用户不能上传 |
| 限流 | 上传 20 次/分（`EasyThrottle(20)`，即 60s 窗口） | image-manage.controller.ts:61；backend/src/decorators/easy-throttle.decorator.ts:12-20 | 视频上传成本更高，20 次/分也偏宽 |

- `@fastify/multipart` 插件级默认 `fileSize` 取 Fastify bodyLimit（node_modules/.pnpm/@fastify+multipart@10.1.3/node_modules/@fastify/multipart/index.js:50-54），但项目在每次 `request.file()/files()` 时都显式传 limits（multipart.config.service.ts:21-29），所以实际生效的是 `PICSUR_MAX_FILE_SIZE`。
- 没有请求/上传超时配置，也没有代理层可加超时（容器里无 nginx）；视频上传时长可能达分钟级，慢客户端会长期占内存（Buffer 已在累积）。
- 没有磁盘暂存逻辑：文件 Buffer 直接进 sharp worker（sharp.wrapper.ts:54-65）或写库（image-file-db.service.ts:34-55）。

### 2.4 当前实例只读实测（不代表生产）

| 项 | 实测值 | 取证方式 |
|---|---|---|
| 部署 | `ghcr.io/zhemed/picsur:allinone`，端口 `0.0.0.0:8080`，重启策略 always | docker inspect / ps |
| 镜像体积 | `docker images` 显示 799MB（本机磁盘口径）；`docker image inspect` Size=165,039,399 B（内容口径）；`v0.10.6` 常规镜像 752MB | docker images / image inspect |
| 容器用户 | `uid=0(root)`（all-in-one 语义） | docker exec id |
| 运行内存 | 约 102.7MiB（docker stats 一次性采样） | docker stats --no-stream |
| 数据目录 | `/data` 46.3M（其中 `/data/postgres` 46.3M） | docker exec du |
| 数据量 | 图片 1 张、文件 1 个共 510 字节、派生图 0、数据库 8174 kB | 只读 psql SELECT |
| 宿主资源 | 16 核、11GiB 内存、根分区 251G（余 159G） | nproc / free / df |
| 容器限额 | `NanoCpus=0 Memory=0`（无 CPU/内存限制） | docker inspect HostConfig |
| Postgres 参数 | `max_connections=100`、`shared_buffers=128MB`、`work_mem=4MB`、`wal_level=replica`（默认参数） | 只读 psql SHOW |
| 应用信息 | `/api/info` → production=true、demo=false、version=0.10.6 | 本机只读 curl |

说明：本机实例只有 1 张 510 字节的图，是验证实例，不能代表真实使用量；真实部署的磁盘/带宽/CPU 未知（见第 8 节）。

## 3. 资源与限额

### 3.1 存储模型与增长

- 所有二进制都在 Postgres：`e_image_file_backend.data` 是 `bytea`（image-file.entity.ts:41-42），读写都是整个 Buffer（image-file-db.service.ts:34-71）；派生图同样是 `bytea`（backend/src/database/entities/images/image-derivative.entity.ts）。
- 原图默认不保留：`KeepOriginal` 默认 false（preference-defaults.service.ts:18-22），上传流程只在偏好开启时另存 ORIGINAL（image.service.ts:120-167）。
- 静止图上传后统一转 QOI master，动图转 animated WebP（image-processor.service.ts:36-68）。视频没有可用的「统一内部格式」，转码需要 ffmpeg。
- 派生图缓存有上限：`PICSUR_MAX_DERIVATIVES_PER_IMAGE` 默认 100，超限只影响落库不影响返回（image.config.service.ts:9-12、57-75；image.service.ts:260-284）。
- Postgres 单字段上限 1GB，大值走 TOAST（官方 limits 页）；但 TOAST 不是流式读，`SELECT data` 仍会把整个值物化到内存。
- 无总量/用户配额：除派生图数量与图片到期时间外，没有磁盘配额、没有按用户容量限制（全仓 grep 无 quota 实现）。

### 3.2 清理 / 临时文件 / 备份

- 每分钟 cron：先清理派生图，再清理过期图片（backend/src/managers/image/image-manager.module.ts:36-44）。
- 派生图清理：删除 `last_read` 早于 `remove_derivatives_after`（默认 7d）的派生图；`last_read` 最多每天触写一次（image-file-db.service.ts:159-208；preference-defaults.service.ts:44）。
- 过期图清理：删除 `expires_at < now` 的图片及其级联文件（image-db.service.ts:231-241；image-manager.module.ts:71-81）。
- demo 模式每 5 分钟清空全部图片（host.config.service.ts:58-66；backend/src/managers/demo/demo.service.ts:27-31）。当前实例 demo=false。
- 没有临时文件：应用只写数据库与 `/tmp`，上传内容存 Postgres 不落盘（Dockerfile:160-162）；也没有转码临时目录/清理逻辑（现在没有转码）。
- 没有备份代码：备份 = 打包 `/data`（docs/MAINTAINING.md:16-17），恢复 = 解包后重启。视频会让 tar 备份线性增长，且每次全量。
- all-in-one 备份包含 `PGDATA` 与 `allinone.env`（入口脚本把生成凭据写 `/data/allinone.env`，support/allinone-entrypoint.sh:52-64）。

### 3.3 视频相对图片的体积 / 带宽 / 内存量级（估算，未实测）

| 项 | 估算 | 依据/说明 |
|---|---|---|
| 1080p30 H.264 6Mbps + AAC 128kbps | 约 0.77 MB/s → 46 MB/分钟 | 码率换算；照片通常 2–5MB/张，1 分钟视频约等于 10–20 张照片 |
| 720p30 2.5Mbps + AAC | 约 0.33 MB/s → 19–20 MB/分钟 | 同上 |
| 单观众出口带宽 | 6Mbps 约 2.7GB/小时 | 连续流式，与图片「一次性取完」不同 |
| 单文件存储放大 | 50MB 原片 ≈ DB 行 50MB + WAL 增量 + 备份 50MB + 派生（如有） | `bytea` 存储；删除后空间要 VACUUM 才回收 |
| 上传瞬时内存 | 50MB 文件约 100–150MB 峰值（toBuffer + fork IPC 复制/转码） | image-manage.controller.ts:69-74；sharp.wrapper.ts:54-65 |
| 转码内存 | 720p 软件 x264 单路约 200–500MB RSS（估） | 未实测；现有图片 worker 上限 512MB 可作参照 |
| 50MB 视频的 Range 请求数 | 按 1MB 块约 50 请求/次播放；按 2MB 块约 25 请求 | 影响现有 600 次/分限流 |

### 3.4 Range / 流式与并发观看

- 后端完全没有 Range 支持（见第 1 节 grep 结果）；`getImage` 返回 `Promise<Buffer>`，控制器只设置 Content-Type（image.controller.ts:93-138、177-182）。
- MDN 的 HTTP Range 指南说明：支持随机访问的媒体播放器需要 `Accept-Ranges`/`Range`/206/416（https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Range_requests）。Safari 尤其依赖 Range；没有 Range 时部分浏览器只能整段下载后播放，拖动进度条会失败。
- 并发观看的内存代价：每次取文件都把整个 `bytea` 读进内存（image-file-db.service.ts:57-71），N 个并发观众 ≈ N × 文件大小；Node 进程没有流式背压，视频并发会直接打爆内存。
- 公开取图限流 600 次/分/IP（image.controller.ts:42-52）。图片场景足够；视频若按 Range 分块请求，一次播放几十个请求，NAT 后多人共享出口会顶到上限，需要给视频/Range 单独预算（或按字节/并发流限流）。
- 结论：**视频即使只存原片，也必须先实现 Range + 字节级流式**；存储要从 `bytea` 改到文件系统（或至少提供按块读取），否则「能上传」但「不能正常播放」。

### 3.5 单实例承载力粗判

- 说明：以下是根据码率与组件参数的粗算，不是压测结果。
- 现状基线：容器 idle 约 103MiB，Postgres 默认 128MB shared_buffers；宿主 16 核/11GiB，容器无 CPU/内存限额；本地盘余量 159GB。
- 档 A（原片直出 + Range + 文件存储）：2 vCPU / 2GiB 内存 / 20–50GB 盘可支撑小规模自用；瓶颈通常是出口带宽（10 并发 1080p 约 60–80Mbps），不是 CPU。
- 档 B（转码）：软件 x264 720p 大致实时量级（估），1–2 vCPU 的小 VPS 上必须并发=1 + 队列；本机 16 核可以同时跑几路，但不代表典型部署。Docker 当前没有给应用加 CPU/内存限制，需要新增。
- 当前实例只有 1 张图，不能据此推断真实生产容量；真实负载未知。

## 4. 安全风险

### 4.1 现有上传校验与攻击面

- 魔数识别 + 白名单：`file-type` 按内容识别，特殊处理 QOI 与 SVG；白名单为 13 种图片 + 2 种动画（GIF、animated WebP）（image.service.ts:359-402；shared/src/dto/mimes.dto.ts:4-32、48-75）。
- 未知/无法识别格式返回 400 `UsrValidation`（image.service.ts:379-387）。
- 但「已识别为视频 mime」会走到 `Mime2FileType('video/mp4')` 失败 → `FT.Internal` → HTTP 500（mimes.dto.ts:68-75；shared/src/types/failable.ts:45-49）。即当前上传 mp4 是 **500 而不是 400**；加视频时必须修错误映射并加回归。
- SVG 是主动内容：上传前用 svgo + DOMPurify 净化，禁止脚本/外链/foreignObject（backend/src/managers/image/svg-security.service.ts:22-69），响应再加 CSP sandbox 与 nosniff（image.controller.ts:29-40、177-182）。
- 体积/像素/转换限制：`PICSUR_MAX_FILE_SIZE`、`PICSUR_MAX_IMAGE_PIXELS`（默认 0x3FFF²）；转码前先读 header 判断像素，再进子进程；worker 里 setrlimit 内存 + 15s 超时 + `limitInputPixels`（multipart.config.service.ts:14-29；shared/src/util/image-pixel-limit.ts:12-16；image-converter.service.ts:73-102、174-222；sharp.wrapper.ts:49-65、172-175；sharp.worker.ts:34-63）。
- 权限：上传需要 `ImageUpload`；guest 默认只有 `ImageView` + `ImageDeleteKey`；只有 demo 模式额外给 guest 上传（permission-templates.const.ts:17-27、60-64）。当前实例 demo=false（/api/info 实测）。
- 限流：全局 60 次/分、上传 20 次/分、公开取图 600 次/分（PicsurLayers.module.ts:10-19；image-manage.controller.ts:61；image.controller.ts:42-52）。
- 缺口：没有病毒扫描、没有内容审核、没有账号/实例配额、没有播放带宽限制。

### 4.2 视频新增风险（按优先级）

1. **ffmpeg 攻击面与 CVE**：镜像当前没有 ffmpeg/ffprobe（源码 grep 0 命中；`docker exec picsur command -v ffmpeg` exit 127）。若引入 Alpine 3.23 的 ffmpeg 8.0.1-r1（https://pkgs.alpinelinux.org/package/v3.23/community/x86_64/ffmpeg），Debian 安全跟踪页（https://security-tracker.debian.org/tracker/source-package/ffmpeg）显示 2024–2026 大量 CVE，8.0.x 仍有多个 open issue（bookworm/trixie 标 vulnerable、no DSA postponed）。结论：ffmpeg 不能放进主进程直接解析用户文件，应独立 worker/容器 + 硬超时 + 资源限额 + 非 root + 无网络。
2. **转码/解码炸弹**：小体积文件可解出超大分辨率、超长时长、超高 fps（解压炸弹），耗尽 CPU/内存/磁盘。必须按 duration/resolution/fps/bitrate/pixel budget 校验并设硬超时。
3. **SSRF**：ffmpeg 原生支持 http/rtsp/hls 等网络协议；绝不能把用户可控 URL 传给 ffmpeg，只传本地文件并加 `-protocol_whitelist file`（参考 https://ffmpeg.org/ffmpeg-protocols.html）。
4. **磁盘 / WAL / 备份耗尽**：没有总量配额；当前 128MB 上限 × 20 次/分 × 多账号即可快速填满小 VPS 的 20–50GB 磁盘；`bytea` 还会放大 WAL 与 VACUUM 成本。需要默认配额 + 保留期 + 按字节限速。
5. **公开直链被当 CDN 滥用**：`/i/:id` 只需 `ImageView`（guest 有）、CORS `*`、缓存 30 天（app.module.ts:29-58）；视频直链可被外站盗链播放，无鉴权、无 hotlink 防护、无带宽配额。建议每 IP 并发流/带宽上限、可选 Referer 防盗链、Range 请求单独限流。
6. **任意文件/伪装容器**：MP4 是容器格式，可携带非视频数据或不可播内容；必须按内容嗅探（file-type + ffprobe）而非扩展名，响应必须正确 `Content-Type` + `X-Content-Type-Options: nosniff`（现有 nosniff 只对 SVG 设置，image.controller.ts:181），并考虑附件语义/禁止 HTML 渲染。
7. **权限粒度**：一旦给普通用户视频上传能力，等于放开大文件滥用面；建议单独权限（如 `video-upload`）或配额，避免「账号能传图就能传视频」。
8. **容器 blast radius**：all-in-one 以 root 运行且挂 docker.sock（Dockerfile.allinone:39-43；README.md:21-26；docs/MAINTAINING.md:18-20），任一媒体解析 RCE ≈ 宿主 root。常规镜像虽是 `USER node`（Dockerfile:170），但用户实际部署的是 all-in-one；引入 ffmpeg 后必须重新评估这条，最好要求「视频功能不挂 socket」部署。
9. **无上传超时**：Fastify `requestTimeout=0`（默认）意味着慢速上传可长期占用连接与内存；需要在应用层或外部反代补超时。
10. **合规/内容滥用**：视频更容易承载侵权/违法内容；当前无审核、SECURITY.md 只有公开 issue 渠道（SECURITY.md:1-10）。自托管可接受，但公开 demo 实例不宜开视频（demo 会给 guest 上传且 5 分钟清空）。

### 4.3 最低防护清单（实现时作为验收点）

- 格式白名单 + 容器/编解码校验（一期 MP4 H.264/AAC；二期 WebM VP9/Opus）。
- 大小/时长/分辨率/码率/fps 上限；实例与用户配额；上传按字节/账号限速。
- 转码隔离：独立进程或容器、非 root、无网络、`-protocol_whitelist file`、硬超时、内存/CPU 限额、临时目录清理、并发=1。
- Range/206/416 + ETag/If-Range；每 IP 并发流与带宽限制；可选防盗链。
- 正确 MIME + `nosniff`；错误统一 4xx（视频 mime 不再 500）。
- 播放/上传限流与审计日志；SECURITY.md 补支持版本与私密上报渠道；docs/MAINTAINING.md 补配额、备份影响、反代超时/大小。

## 5. 配置项

### 5.1 现有与上传/大小/转换相关的配置

环境变量（`PICSUR_` 前缀，backend/src/config/config.static.ts:9）：

| 变量 | 默认 | 作用 | 证据 |
|---|---|---|---|
| `PICSUR_MAX_FILE_SIZE` | 128000000 | 单个 multipart 文件上限（字节） | multipart.config.service.ts:14-19；.env.example:27-28；Dockerfile.allinone:61 |
| `PICSUR_MAX_IMAGE_PIXELS` | 268402689 | 图像像素上限（w*h），0=不限 | shared/src/util/image-pixel-limit.ts:12-16；image.config.service.ts:28-46；.env.example:29-31 |
| `PICSUR_MAX_DERIVATIVES_PER_IMAGE` | 100 | 每图最多落库派生图数，0=不限 | image.config.service.ts:9-12、57-75；.env.example:32-35 |
| `PICSUR_HOST` / `PICSUR_PORT` | 0.0.0.0 / 8080 | 监听地址 | host.config.service.ts:50-55；Dockerfile.allinone:54-55 |
| `PICSUR_STATIC_FRONTEND_ROOT` | /picsur/frontend/dist（镜像内） | 前端静态目录 | .env.example:26；serve-static.config.service.ts:23-30 |
| `PICSUR_PRODUCTION` | false（镜像内 true） | 生产模式 | host.config.service.ts:19-24、70-72；Dockerfile:157 |
| `PICSUR_SYNC_SCHEMA` | false | TypeORM 自动同步表结构（危险，默认关） | host.config.service.ts:74-82；.env.example:41-45 |
| `PICSUR_VERBOSE` | false | 会把 JWT secret/DB 口令写日志（不要开） | .env.example:85-87 |
| `PICSUR_TELEMETRY` | true（装饰性） | 只影响一行日志，不控制出网 | .env.example:47-51；config.static.ts:4-7 |
| `PICSUR_DEMO` / `PICSUR_DEMO_INTERVAL` | false / 5min | demo 模式（guest 可匿名上传）与清空间隔 | host.config.service.ts:58-66（注意：未写进 .env.example） |
| `PICSUR_DATA_DIR` / `PICSUR_PGDATA` / `PICSUR_PG_SOCKET_DIR` | /data / /data/postgres / /run/postgresql | all-in-one 数据目录 | Dockerfile.allinone:64；support/allinone-entrypoint.sh:21-30 |
| `PICSUR_DB_*`、`PICSUR_ADMIN_PASSWORD`、`PICSUR_JWT_SECRET` | 见文档 | 数据库与凭据 | .env.example:6-17 |
| `PICSUR_ALLOW_SELF_UPDATE` / `PICSUR_UPDATE_*` / `PICSUR_DOCKER_SOCKET` / `PICSUR_DOCKER_GID` | 默认开 / 见文档 | 面板自升级（socket = 宿主 root） | .env.example:53-83；build-and-deploy.md:76 |

转换相关限制实际在**数据库系统偏好**里，不是环境变量：

| 偏好 | 默认 | 作用 | 证据 |
|---|---|---|---|
| `conversion_time_limit` | 15s | 单次 sharp 转码超时 | preference-defaults.service.ts:47；image-converter.service.ts:73-92 |
| `conversion_memory_limit` | 512（MB） | 单次转码 worker 内存 rlimit | preference-defaults.service.ts:48；sharp.worker.ts:39-56 |
| `remove_derivatives_after` | 7d | 派生图未读多久后清理 | preference-defaults.service.ts:44；image-manager.module.ts:46-69 |
| `allow_editing` | true | 是否允许通过 query 触发在线转码 | preference-defaults.service.ts:45；image.service.ts:180-186 |

注意：`conversion_time_limit` / `conversion_memory_limit` 不在面板暴露（build-and-deploy.md:100-112）；新增视频转码限额可以沿用「env + 代码默认值」或「DB 偏好」两种模式，需先定契约。

### 5.2 视频需要新增的配置（建议命名）

| 名称 | 建议默认 | 用途 |
|---|---|---|
| `PICSUR_VIDEO_ENABLED` | false | 总开关（默认关，灰度启用） |
| `PICSUR_MAX_VIDEO_FILE_SIZE` | 50000000 | 视频单文件上限（与图片上限分离） |
| `PICSUR_VIDEO_MAX_DURATION_SECONDS` | 60 | 时长上限（需服务端解析元数据） |
| `PICSUR_VIDEO_MAX_WIDTH` / `PICSUR_VIDEO_MAX_HEIGHT` | 1920 / 1080 | 分辨率上限 |
| `PICSUR_VIDEO_MAX_FPS` | 60 | 帧率上限 |
| `PICSUR_VIDEO_MAX_BITRATE` | 6000000 | 视频码率上限（校验/估容量用） |
| `PICSUR_VIDEO_ALLOWED_FORMATS` | mp4 | 容器白名单（二期加 webm） |
| `PICSUR_VIDEO_STORAGE_MODE` | fs | `fs` 或 `db`；推荐 fs，db 仅兼容历史数据 |
| `PICSUR_VIDEO_STORAGE_DIR` | /data/videos | 文件落盘目录（进 /data 即纳入备份） |
| `PICSUR_MAX_VIDEO_STORAGE_BYTES` | 20000000000 | 实例总配额（20GB） |
| `PICSUR_MAX_VIDEO_STORAGE_PER_USER_BYTES` | 2000000000 | 单用户配额（2GB） |
| `PICSUR_VIDEO_TRANSCODE` | off | 转码开关（档 B） |
| `PICSUR_VIDEO_TRANSCODE_TIMEOUT_MS` | 120000 | 单次转码硬超时 |
| `PICSUR_VIDEO_TRANSCODE_MEMORY_MB` | 512 | 转码内存上限 |
| `PICSUR_VIDEO_TRANSCODE_CONCURRENCY` | 1 | 转码并发 |
| `PICSUR_VIDEO_TRANSCODE_TARGET` | 720p/2.5Mbps/H.264/AAC | 目标参数（或拆成多个细分项） |
| `PICSUR_VIDEO_POSTER` | true | 是否生成封面海报 |
| `PICSUR_VIDEO_RANGE_CHUNK_BYTES` | 2097152 | Range 分块大小 |
| `PICSUR_VIDEO_MAX_STREAMS_PER_IP` | 4 | 每 IP 并发播放流上限 |
| `PICSUR_VIDEO_UPLOAD_TIMEOUT_MS` | 300000 | 上传超时（或由反代配置承担） |

同步约定：项目此前的「三处同步」是 `.env.example` + `docker-compose.yml` + build-and-deploy.md（build-and-deploy.md:239-247），但 compose 已删；新增变量应同步 `.env.example`、`docs/MAINTAINING.md`、代码默认值，必要时代码外的 all-in-one ENV 默认值（Dockerfile.allinone:53-64）也要加。

## 6. 上游先例（URL）

| 来源 | URL | 结论 |
|---|---|---|
| 上游仓库 API（rubikscraft 旧名） | https://api.github.com/repos/rubikscraft/Picsur | 返回 `full_name = CaramelFur/Picsur`，仓库已转移；`archived=false`，`pushed_at=2025-10-12`，open issues 40 |
| 上游 README | https://raw.githubusercontent.com/CaramelFur/Picsur/master/README.md | 明确写 **NOT MAINTAINED**；功能清单只有图片（含 GIF/WebP 动画）、转换、编辑、过期分享等，**没有视频**；未完成计划只有 white mode / public gallery / albums，**没有视频** |
| issue/PR 搜索 `video` | https://api.github.com/search/issues?q=repo:CaramelFur/Picsur+video | `total_count = 0` |
| issue/PR 搜索 `videos` | https://api.github.com/search/issues?q=repo:CaramelFur/Picsur+videos | `total_count = 0` |
| issue/PR 搜索 `mp4` | https://api.github.com/search/issues?q=repo:CaramelFur/Picsur+mp4 | `total_count = 0` |
| issue/PR 搜索 `ffmpeg` | https://api.github.com/search/issues?q=repo:CaramelFur/Picsur+ffmpeg | `total_count = 0` |
| issue/PR 搜索 `audio` | https://api.github.com/search/issues?q=repo:CaramelFur/Picsur+audio | `total_count = 0` |
| 仓库/ fork 搜索 | https://api.github.com/search/repositories?q=picsur+video | `total_count = 0`（没有以 video 为卖点的衍生仓） |
| 最新 release | https://github.com/CaramelFur/Picsur/releases/tag/0.5.6 | 0.5.6，2024-11-01；上游基本冻结 |

**结论：公开可检索范围内查不到 Picsur 上游对视频支持的实现、讨论或计划，也没有相关 fork。** 因此视频支持在本仓是全新的自研特性，无法通过同步 upstream 获得。

限制与不确定：GitHub 的 issue/PR 搜索不含 Projects 看板里的 roadmap 条目和 Discord 讨论；上游 README 链接的 project 1 需要登录态，本轮未查。所以只能断言「公开 issue/PR/README/仓库搜索查不到」，不能断言「从未设想过」。

另外本仓不是 fork（README.md:34），自维护版本线 0.10.6（package.json 与 `/api/info` 实测一致）。

## 7. 建议默认限额（建议值，非实测）

以下全部是**建议默认值**，不是压测/实测结果；实施时应先用真实 50MB/60s 样本在本机复测再定稿。

### 7.1 档 A：原片直出（推荐先做）

| 项 | 建议默认 | 理由 |
|---|---|---|
| 允许格式 | MP4（H.264 视频 + AAC 音频，moov 前置 faststart） | 浏览器覆盖最好；MOV/HEVC/AVI/MKV 兼容性差、校验复杂，一期不做 |
| 单文件大小 | 50,000,000 B（约 47.7MiB） | 6Mbps×60s + 音频约 46MB，留余量；限制内存/DB/备份放大 |
| 时长 | ≤60s | 短视频场景；让内存、带宽、许可证风险可预算 |
| 码率 | 视频 ≤6Mbps，音频 ≤128kbps | 1080p 观感够用，控制出口带宽 |
| 分辨率 | ≤1920×1080（2,073,600 像素） | 主流屏幕；限制解码/渲染成本 |
| 帧率 | ≤60fps | 常见上限 |
| 上传频率 | 5 次/分/IP；并发上传 ≤2 | 视频上传更重（现图片为 20 次/分） |
| 实例总配额 | 20GB（可配置） | 留出 DB 膨胀与备份余量；约 400 个 50MB 片段 |
| 单用户配额 | 2GB（可配置） | 防单账号灌满 |
| Range | 必须 206/416 + `Accept-Ranges: bytes` + ETag/If-Range；块 2MiB | MDN Range 契约；块太大首帧慢、太小请求多 |
| 播放限流 | 每 IP 并发流 ≤4；Range 单独预算 | 防直链当 CDN；现有 600 次/分是图片口径 |
| 存储 | 文件系统 `/data/videos` + DB 元数据（路径/size/mime/duration/checksum） | Range 流式、备份可控；DB 只存元数据 |
| 缓存 | 30 天 + ETag（不可变内容） | 与现有 `/i/*` 30 天缓存一致 |
| 原片策略 | 档 A 直出即原片；记录 codec/容器信息 | 无转码 |

容量自洽验算：6Mbps ≈ 0.75MB/s，60s ≈ 45MB；AAC 128kbps ≈ 0.96MB/分钟；合计约 46MB < 50MB 上限。720p 2.5Mbps 时 60s 约 19MB。

### 7.2 档 B：转码 + 海报（二期）

| 项 | 建议默认 | 理由 |
|---|---|---|
| 目标格式 | MP4 H.264（main profile）720p，2.5Mbps，AAC 128kbps，30fps，faststart | 兼容与体积平衡 |
| 海报 | JPEG 640px，质量 80 | 图库/分享预览 |
| 转码超时 | 120s/任务 | 防炸弹/卡死 |
| 内存/CPU | 512MB–1GB，1–2 核 | 软件 x264 720p 大致实时量级（估） |
| 并发 | 1（队列） | 小实例防打满 |
| 隔离 | 独立子进程/容器、非 root、无网络、`-protocol_whitelist file`、临时目录清理 | ffmpeg CVE 多、协议可 SSRF |
| 输入校验 | 先 ffprobe 探测 duration/resolution/codec/fps，超限拒绝 | 不能只信扩展名 |
| 原片 | 默认不保留（省盘）；保留则计入配额 | 存储 ×2–3 |
| 镜像增量 | 估计 +30–60MB（Alpine 3.23 ffmpeg 8.0.1-r1 及其依赖：libavcodec 19.2MiB、libavformat 2.9MiB、libavfilter 6.0MiB、其它 libs + ffmpeg 0.6MiB） | 来自 Alpine 包页面，**未实际构建**；另需锁 apk 版本并更新 support/apk-versions.sh |

### 7.3 推荐 MVP 边界

- **做**：视频白名单（MP4 H.264/AAC）、大小/时长/分辨率校验、文件系统存储、Range 播放、图库/详情页展示、配额与限流、4xx 错误映射、文档与备份说明更新。
- **不做（一期）**：转码、HLS/DASH、截帧封面、多码率、CDN、防盗链水印、在线剪辑。
- **二期**：转码 + 海报 + 720p 标准化 + 独立 worker。
- 若一定跳过 ffmpeg：档 A 仍需要「时长/分辨率」校验来源，可选纯 MP4 box 解析（mvhd 时长、tkhd 宽高）以避开 ffprobe 的攻击面，但 codec 校验会弱化（只按容器白名单），这是需要显式记录的残余风险。

## 8. 风险与不确定项

1. **真实生产实例未检查**：本机实例只有 1 张 510B 图；真实部署的磁盘/带宽/CPU、是否已有外部反代/TLS 都未知，容量判断只能按估算。
2. **没有压测**：转码耗时、并发上传内存、Range 并发出口、DB 膨胀速度都是估算；本轮只读约束下不能做负载测试。建议实施前在本机用真实 50MB/60s 样本测一轮。
3. **镜像增量是包页面估算**：ffmpeg 及其依赖的安装体积来自 Alpine 3.23 包页面，未实际构建 all-in-one；最终以构建后 `docker images` 为准。
4. **时长/编解码校验依赖**：需要 ffprobe（新增攻击面）或纯 MP4 box 解析（实现成本/兼容性风险）；两者各有残余风险。
5. **存储从 `bytea` 迁到文件系统是重构**：涉及迁移/回滚、备份流程、卷权限（常规镜像跑 node 用户需要可写卷）、清理任务改造；不是小改。
6. **上游检索的盲区**：issue/PR 搜索 0 命中，但 GitHub Projects 看板与 Discord 讨论无鉴权不可查，不能 100% 断言上游从未讨论。
7. **文档漂移**：`.trellis/spec/picsur-backend/backend/build-and-deploy.md` 仍描述已删除的 compose/install.sh；改部署时需同步，否则后人按旧 spec 操作会踩空。
8. **demo 模式风险**：`PICSUR_DEMO` 未写进 `.env.example`；若任何实例开 demo，guest 可匿名上传（含视频）。当前实例 demo=false，但其他部署是否开 demo 未知。
9. **浏览器兼容**：不做转码时只能保证 MP4 H.264/AAC（与二期 WebM）可播；HEVC/MOV/AVI 多数浏览器不能播，必须白名单挡住。
10. **合规/滥用**：视频更容易承载侵权/违法内容；当前无审核与举报流程，SECURITY.md 只有公开 issue 渠道，自托管场景需要明确责任边界；公开 demo 不宜开视频。
11. **安全基线放大**：all-in-one 是 root + docker.sock；视频功能引入媒体解析器后建议要求「视频部署不挂 socket」或把转码拆到无 socket 的 sidecar，否则一次解析 RCE 等于宿主 root。
12. **错误映射缺陷**：当前视频 mime 走 `FT.Internal` 返回 500；加视频时必须显式返回 4xx 并加回归，否则前端难以提示（也是审计口径里「不该是 500 的 500」）。

## 9. 关键文件清单（Files Found）

| 文件路径 | 说明 |
|---|---|
| `README.md`、`docs/MAINTAINING.md` | 当前唯一部署方式（all-in-one）、备份、升级、安全要点 |
| `Dockerfile`、`Dockerfile.allinone` | 常规镜像/all-in-one 构建；apk 锁版本、libvips、sharp 源码构建、非 root 与 root 差异 |
| `support/allinone-entrypoint.sh` | 内嵌 Postgres、密钥生成与 `/data/allinone.env`、信号处理 |
| `backend/src/main.ts`、`backend/src/app.module.ts`、`backend/src/security.ts` | Fastify 启动/trustProxy、CORS/缓存/静态、Helmet |
| `backend/src/config/early/multipart.config.service.ts`、`host.config.service.ts`、`image.config.service.ts`、`serve-static.config.service.ts`、`config/config.static.ts` | 上传大小/像素/主机/端口/静态目录/前缀 |
| `backend/src/routes/image/image-manage.controller.ts`、`image.controller.ts` | 上传与取图接口；权限、限流、响应头 |
| `backend/src/managers/image/image.service.ts`、`image-converter.service.ts`、`image-processor.service.ts`、`svg-security.service.ts` | 魔数校验、转码流程、派生图上限、SVG 净化 |
| `backend/src/workers/sharp.wrapper.ts`、`workers/sharp/sharp.worker.ts` | 子进程隔离、15s 超时、512MB 默认内存限制、像素上限 |
| `backend/src/collections/image-db/image-file-db.service.ts`、`image-db.service.ts` | `bytea` 读写、派生图/过期图清理 |
| `backend/src/managers/image/image-manager.module.ts` | 每分钟清理 cron |
| `backend/src/collections/preference-db/preference-defaults.service.ts` | 转换/清理默认偏好 |
| `backend/src/collections/database/entities/images/image-file.entity.ts` | 二进制 `bytea` 存储定义 |
| `.env.example` | PICSUR 变量清单（注意缺 `PICSUR_DEMO` 等） |
| `.dockerignore` | 排除 `.env`/`.run`/`/data`/`.trellis`，仅保留 entrypoint |
| `.github/workflows/ci.yml` | CI 只做构建/审计/lint，不构建镜像、不跑浏览器验证 |
| `.trellis/spec/picsur-backend/backend/build-and-deploy.md` | 构建部署契约（部分 compose 内容已过时） |

## 10. 只读验证（命令 / 页面）

- 代码：`read` 关键文件（见第 9 节）；`grep` 检查 `bodyLimit`、`PICSUR_`、`EasyThrottle`、`Range|Content-Range|createReadStream|StreamableFile`、`nginx|caddy|traefik`、`ffmpeg` 等。
- 仓库：`git ls-files`（确认无 compose）、`git log --oneline -8`（版本线 0.10.6）、`git status --short`（只有本任务目录未跟踪）。
- 依赖默认值：Fastify 5.12.5 `lib/config-validator.js:1265`（bodyLimit/requestTimeout/connectionTimeout 默认值）、`lib/server.js:340`；`@fastify/multipart` 10.1.3 `index.js:50-54`。
- 运行实例（只读）：`docker images`/`docker image inspect`/`docker inspect`（端口、挂载、资源限制）、`docker history`、`docker exec picsur id`、`du -sh /data`、`psql -Atc` 只读 SELECT（计数/字节/数据库大小）、`psql SHOW`（Postgres 默认参数）、`docker stats --no-stream`、本机 `curl /api/info`。
- 公开页面：GitHub 仓库 API/README/issues 搜索/release（第 6 节 URL）；Alpine 包页面（ffmpeg、ffmpeg-libavcodec、libavformat、libavfilter）；Debian ffmpeg 安全跟踪页；MDN Range 指南；PostgreSQL limits 文档。
- 未做：未构建/未拉镜像、未启动新容器、未安装依赖、未改配置、未重启服务、未读取 `.env` 内容、未访问内网/未授权主机。
