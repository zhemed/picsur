# 复核报告：上传并发调查的证据与结论

- 复核对象：`research/backend-upload-pipeline.md`、`research/runtime-and-frontend.md`
- 复核依据：`prd.md` 的 R1-R6 与 Acceptance Criteria、`.trellis/spec/picsur-backend/backend/quality-guidelines.md`、`image-api-contracts.md`
- 角色：Trellis check 子代理，共享任务 task-3
- 日期：2026-10-30
- 只读声明：本轮未修改两份被检报告与任何源码、配置；未装依赖、未构建、未重启、未 docker exec；唯一写入是本文件。
- 复核方式：不采信报告自洽性，逐条回到源码与只读命令原文核对行号与结论；抽查 45 条主张，其中 8 类重点为前端串行、fork 线程模型、主进程 sharp、上传入口限流、DB 写入、全局锁与队列、QOI 编解码、容器 CPU 配额。

## 一、复核结论

判定：通过，附 1 条需修正表述与 7 条建议。

- 两份报告的五节结构、总体判定、瓶颈排序、确认与推测标注、不确定项章节均齐备，满足 PRD 的 Acceptance Criteria 1、2、4、5。
- 抽查的 45 条证据全部能在源码或只读命令输出中复现，未发现无证据的臆造结论，行号级别也基本精确，个别范围略宽。
- 唯一实质性表述问题：runtime 报告把「每张图的编解码」统归 sharp 与 libvips 线程池，而默认主格式 QOI 的编码与解码走 `qoi-img` 原生插件同步调用。该表述不影响「后端不是单核」的总体判定，但会误导「单次转换用多少核」的口径，列为需修正。
- 只读约束遵守：`git status --porcelain` 只有 `?? .trellis/tasks/10-30-investigate-upload-concurrency/` 一条，无 tracked 改动，锁文件未变。

## 二、逐条证据核对

判定列含义：相符表示报告主张与源码或命令输出一致；相符【…】表示结论正确但范围或表述有小偏差。

### 2.1 前端串行

| # | 报告主张与出处 | 源文件实际内容 | 判定 |
|---|---|---|---|
| A1 | runtime 2.7：`upload.component.html:3` 的 input 无 `multiple` | 第 3 行 `<input type="file" fileInput [formControl]="fileControl" />`，无 multiple 属性；全前端 html 无上传相关 multiple | 相符 |
| A2 | runtime 2.7 与 backend 2.8：`processing.component.ts:35` 只上传 `imageFiles[0]` | 第 35 行 `const id = await this.imageService.UploadImage(state.imageFiles[0]);` | 相符 |
| A3 | runtime 2.7：`image.service.ts:46-54` 单文件上传，`:56-69` 批量方法被注释 | 46-54 为 `UploadImage(image: File)` 单文件 POST；56-69 每行均以 `//` 开头，批量 POST 目标为已不存在的 `/api/image/upload/bulk` | 相符 |
| A4 | runtime 2.7：`@ngx-dropzone/cdk` 的 `multiple` getter 在 192-193，`_handleChange` 在 266 取 `fileList.item(0)`，`handleFileDrop` 在 278 取 `files[0]` | 192-193 `get multiple() { return this.elementRef.nativeElement.multiple; }`；266 `const files = this.multiple ? Array.from(fileList) : fileList.item(0);`；278 `this._appendOrReplace(this.multiple ? files : files[0])` | 相符 |
| A5 | runtime 2.7：全前端无 forkJoin 或 Promise.all 驱动上传 | grep 检索 forkJoin、Promise.all、concurrency、imageFiles，仅命中 settings 用户页两处 Promise.all 与 processing 的 `[0]` | 相符 |

### 2.2 图片处理与 fork 线程模型

| # | 报告主张与出处 | 源文件实际内容 | 判定 |
|---|---|---|---|
| B1 | backend 2.4 与 runtime 2.2：`sharp.wrapper.ts:54-65` 用 `fork` 起子进程，`env` 只有 3 个键 | 54-65 `this.worker = fork(WORKER_PATH, { serialization: 'advanced', timeout, env: { MEMORY_LIMIT_MB, MAX_IMAGE_PIXELS, NODE_OPTIONS: '--no-warnings' }, stdio: 'overlapped' })` | 相符 |
| B2 | backend 2.4：`image-converter.service.ts:84` 每次转换新建 SharpWrapper | 第 84 行 `const sharpWrapper = new SharpWrapper(timeLimitMS, memLimit);` | 相符 |
| B3 | backend 2.4：`sharp.worker.ts:49-58` 用 setrlimit 限 data 段 | 第 8 行 `import { setrlimit } from 'posix.js';`；49-53 setrlimit 的 soft 与 hard 均为 1000 × 1000 × memoryLimit；54-56 catch | 相符【范围略宽，58 行是 message 监听】 |
| B4 | runtime 2.2：结束或超时由 `:86-91`、`:231-235` 杀掉 | 86-91 `worker.on('close', …)` 内 `this.purge()`；231-235 `purge() { this.worker?.kill(); … }` | 相符 |
| B5 | backend 2.4：`sharp.wrapper.ts:158-180` 用 pTimeout 等子进程回消息 | 158-174 构造 finishPromise 并 `await pTimeout(finishPromise, { milliseconds: this.instance_timeout })`；180 `this.purge()` | 相符 |
| B6 | backend 2.5 与 runtime 2.4：`image-converter.service.ts:192-197` 主进程调 sharp metadata 预检 | 192-197 `try { const metadata = await sharp(image, { limitInputPixels: false }).metadata(); … }` | 相符 |
| B7 | backend 2.5：预检只在像素上限非 0 且输入不是 BMP 或 QOI 时执行 | 179 `if (maxPixels <= 0) return true;`；181-188 BMP 或 QOI 直接 return true | 相符 |
| B8 | backend 2.2 与 runtime 2.2：无 cluster、pm2、worker_threads、replicas | `backend/src`、`shared/src`、`support/` 检索 cluster、pm2、worker_threads 均 0 命中 | 相符 |
| B9 | backend 2.5 与 runtime 2.5：sharp 类型声明说明 libvips 线程数与 UV_THREADPOOL_SIZE 的关系 | `backend/node_modules/sharp/lib/index.d.ts` 105-107 三行文档，104-111 为整段注释；`.pnpm/sharp@0.35.5_@types+node@22.8.4/…/index.d.ts` 路径存在 | 相符 |
| B10 | backend 2.5 与 runtime 2.4：仓库未设置 UV_THREADPOOL_SIZE | `git grep UV_THREADPOOL_SIZE` 0 命中；容器 Env 也无该键 | 相符 |

### 2.3 上传入口与限流

| # | 报告主张与出处 | 源文件实际内容 | 判定 |
|---|---|---|---|
| C1 | backend 2.3：`image-manage.controller.ts:58-90` 是上传入口 | 58 `@Post('upload')`，59 权限，60 返回类型，61 限流，62 为方法签名起始，90 方法结束 | 相符 |
| C2 | backend 2.3 与 runtime 2.6：`:61` 为 `@EasyThrottle(20)` | 第 61 行 `@EasyThrottle(20)` | 相符 |
| C3 | backend 2.7：装饰器把秒换算毫秒，默认 60 秒 | `easy-throttle.decorator.ts:12-21` 中 `ttl: (ttlSeconds ?? 60) * 1000` | 相符 |
| C4 | runtime 2.6：上传 20 次每 60 秒，全局 60 次每 60 秒，读接口 600 次 | `image.controller.ts` 47 行 `const ImageRequestsPerMinute = 600;`、52 行 `@EasyThrottle(ImageRequestsPerMinute, 60)`；`PicsurLayers.module.ts` 13 行 `limit: 60`、17 行 `ttl: 60_000` | 相符 |
| C5 | backend 2.3：`postfiles.pipe.ts:20-24` 传 limit 给 request.files | 20 非 multipart 抛错；22-24 `request.files({ limits: this.multipartConfigService.getLimits(filesLimit) })` | 相符 |
| C6 | backend 2.3：单文件上限默认 128 MB | `multipart.config.service.ts:14-19` `ParseInt(env MAX_FILE_SIZE, 128000000)`；21-29 getLimits 里 `fileSize` 取同一值 | 相符 |
| C7 | backend 2.7：限流 key 含 handler 与 IP，存储为进程内 | `throttler.guard.js:150-152` 默认 tracker 为 `normalizeIp(req.ip, …)`；165-168 `generateKey` 前缀含类名与 handler；`throttler.providers.js:17-21` 默认 `new ThrottlerStorageService()`；`PicsurLayers.module.ts:10-20` 只传 throttlers 未传 storage | 相符 |

### 2.4 存储与数据库

| # | 报告主张与出处 | 源文件实际内容 | 判定 |
|---|---|---|---|
| D1 | backend 2.6：`image-file.entity.ts:41` 为 bytea | 41 `@Column({ type: 'bytea', nullable: false })`，42 `data: Buffer;` | 相符 |
| D2 | backend 2.6：`image.service.ts:141-167` 请求内按顺序写库，固定 2 次，保留原图时 3 次 | 142 `imagesService.create`；151-156 `setFile(MASTER)`；159-166 `keepOriginal` 时再 `setFile(ORIGINAL)`；均逐条 await | 相符 |
| D3 | backend 2.6：`type-orm.config.service.ts:51-74` 未配置连接池 | 51-74 只有 type、synchronize、migrationsRun、entities、migrations、useUTC、cli 与连接信息；`backend/src` 检索 pool 与 extra 0 命中 | 相符 |
| D4 | backend 2.7：`image-manager.module.ts:40-44` 每分钟 cron 顺序执行两个清理 | 40 `@Interval(1000 * 60)`；42 `await this.cleanupDerivatives()`；43 `await this.cleanupExpired()` | 相符 |

### 2.5 全局锁与队列

| # | 报告主张与出处 | 源文件实际内容 | 判定 |
|---|---|---|---|
| E1 | backend 2.7：唯一显式互斥是 `mutex-fallback.ts:14-20` 的字符串 key Promise 表 | 14 `const fallBackMap: Record<string, Promise<unknown>> = {};`；16-20 函数签名；21-22 先跑主函数 | 相符 |
| E2 | backend 2.7：使用点只有三类 | grep 检索 MutexFallBack 调用 3 处：`sys-preference-db.service.ts:75`、`usr-preference-db.service.ts:78`、`image.service.ts:218`，与「偏好默认值填充」「派生图缓存」「读路径转换」一致 | 相符 |
| E3 | backend 2.7：派生图互斥 key 为图片 id 加转换参数，上传不经过 | `image.service.ts:216` `getConvertHash`，218-226 MutexFallBack 的 key 由 imageId 与 converted_key 拼接 | 相符 |
| E4 | backend 2.2 与 runtime 2.6：无队列库 | `backend/src` 与 `shared/src` 检索 p-limit、p-queue、bullmq、piscina、queue 均 0 命中 | 相符 |

### 2.6 QOI 编解码

| # | 报告主张与出处 | 源文件实际内容 | 判定 |
|---|---|---|---|
| F1 | backend 2.1：静态图存 QOI，动图存 WebP | `image-processor.service.ts:51` 目标 QOI；`:61` 目标 `AnimFileType.WEBP` | 相符 |
| F2 | backend 2.4：`universal-sharp.ts:159-174` 的 qoiSharpOut 走同步原生编码 | 159-174 `qoiSharpOut` 先 `raw().toBuffer()`，再 `QOIencode(raw.data, {…})`，无 await 等待编码 | 相符 |
| F3 | backend 2.4：`qoi-img` 是原生插件，见 `backend/node_modules/qoi-img/dist/index.js:24-30` | 24 `const addon = require('bindings')('qoixx_addon');`；26 `QOIencode`；29 `QOIdecode`；包版本 2.2.0，后端依赖 `^2.2.0` | 相符 |
| F4 | backend 2.1 与 2.8：主格式 QOI 加宽度参数的派生图首次必然 miss，读路径会再转一次 | `image.service.ts:233-240` 缓存 miss 时 convert；248-258 仅当目标格式等于主格式且无编辑时才复用主文件，带 width 不属于此情况 | 相符【SVG 例外见 S2】 |
| F5 | 两份报告对默认格式与转换次数的描述是否冲突 | backend 报告有 QOI 与转换次数结论；runtime 报告全文 0 处提及 QOI 或转换次数，但第 11 行把「每张图的编解码」统称 sharp 与 libvips 线程池 | 无直接冲突，存在表述不一致，见 S1 |

### 2.7 容器与运行时

| # | 报告主张与出处 | 只读命令实际输出 | 判定 |
|---|---|---|---|
| G1 | runtime 2.3：NanoCpus=0、CpuQuota=0、CpuPeriod=0、CpuShares=0、CpusetCpus 空、Memory=0、MemorySwap=0 | 逐字段与报告完全一致；另外 `Image=ghcr.io/zhemed/picsur:allinone`、`State=running` | 相符 |
| G2 | runtime 2.2：docker top 只见 tini、入口 shell、postgres 与单个 node 进程 | PID 与命令完全一致：1836704 tini、1836775 sh 入口脚本、1836806 postgres、1836855 `node backend/dist/main.js`；另有 5 个 postgres 子进程，与报告「postgres 及其后台进程」表述一致 | 相符 |
| G3 | runtime 2.3：宿主机 16 逻辑 CPU，i7-12700 | `nproc` 为 16；`/proc/cpuinfo` 为 12th Gen Intel Core i7-12700；`docker info NCPU=16` | 相符 |
| G4 | runtime 2.1：镜像 `Created=2026-10-29T13:45:02Z`，ImageID 前缀 `sha256:3c6bcf7f` | `docker image inspect` 输出 `Created=2026-10-29T13:45:02.242235733Z`、`Id=sha256:3c6bcf7fc981…` | 相符 |
| G5 | runtime 2.1：挂载 /root/picsur-data 到 /data 与 docker.sock | `bind /root/picsur-data -> /data`、`bind /var/run/docker.sock -> /var/run/docker.sock` | 相符 |
| G6 | runtime 2.4：容器 Env 无 NODE_OPTIONS 与 UV_THREADPOOL_SIZE | 无这两个键；含 NODE_VERSION=20.20.2、PICSUR_MAX_FILE_SIZE=128000000、PICSUR_VERBOSE=false、PICSUR_DATA_DIR=/data，与报告摘录一致 | 相符 |
| G7 | runtime 2.4：node 进程 Threads=11、VmRSS=85784 kB、cmdline 为 node backend/dist/main.js | `ps -o nlwp,rss` 得 NLWP=11、RSS=86196 kB；`/proc/1836855/cmdline` 为 `node backend/dist/main.js` | 相符【RSS 为时变值】 |
| G8 | runtime 2.1：仓库无 docker-compose.yml 与 install.sh，删除于 6fc28d9，diffstat 含 docker-compose.yml 100 行 | `ls` 两者均 No such file；`git show --stat 6fc28d9` 显示 docker-compose.yml 删除 100 行；commit body 含「Removes docker-compose.yml ... the retired compose deployment shape」 | 相符 |
| G9 | runtime 2.3：docker ps 当时共 8 个容器 | `docker ps -q` 计数为 8 | 相符 |
| G10 | runtime 2.5：Dockerfile 69-94 自编译 libvips 8.18.7，139-144 sharp 源码构建 | 87 行下载 vips-8.18.7.tar.xz，88 行 sha256 校验，90-94 meson 编译安装；143-144 `SHARP_FORCE_GLOBAL_LIBVIPS=1 NODE_PATH=/usr/local/lib/node_modules node install/build.js` | 相符 |
| G11 | backend 2.2：`Dockerfile:172` 为 pnpm start:prod，`Dockerfile.allinone:75` 为 node backend/dist/main.js | 两处逐字一致；另 `support/allinone-entrypoint.sh:322` 为 `set -- node backend/dist/main.js` | 相符 |

### 2.8 其余引用

| # | 报告主张与出处 | 源文件实际内容 | 判定 |
|---|---|---|---|
| H1 | backend 2.2：`main.ts:19-59` 只有一次 listen | 19 行起为 `async function bootstrap()`，59 行 `await app.listen(...)`，全文件无 cluster 分支 | 相符 |
| H2 | backend 2.8：`view.component.ts:86-101` 请求主格式加宽度参数 | 86-101 为 `get previewLink`，94-97 对 SVG 主格式改请求 JPEG，100-101 拼 `?width=&shrinkonly=yes` | 相符【有 SVG 分支】 |
| H3 | backend 2.8：`images.component.ts:324-329` 缩略图请求 WebP 加宽度 | 324 `buildThumbUrl`，326 `GetImageURL(image.id, ImageFileType.WEBP)`，327 拼 width 与 shrinkonly | 相符 |
| H4 | backend 2.5：`image.service.ts:359-401` 类型判定，367 与 373 调 isSvg，390-394 解析 WebP 头 | 逐行一致；390-394 为 `WebPInfo.from` 后按 isAnimated 分 WEBP 或 AnimFileType.WEBP | 相符 |
| H5 | backend 2.5：`svg-security.service.ts:41-54` 同步 svgo 加 DOMPurify | 41 `sanitize`，43-46 `optimize(...)`，48-54 `SvgDOMPurify.sanitize(...)`，全同步无 await | 相符 |
| H6 | runtime 2.6：`usage.service.ts:155` 为 `cpu_count: os.cpus().length` | 第 155 行逐字一致 | 相符 |
| H7 | runtime 2.6：`sys-preferences.enum.ts:41-49` 暴露列表只有 5 项，不含 conversion 两项 | 41-49 为 `SysPreferenceExposedList`，含 HostOverride、RemoveDerivativesAfter、AllowEditing、TrackingUrl、TrackingId 共 5 项 | 相符 |
| H8 | runtime 2.6：`build-and-deploy.md:255-263` 三处同步 | 255 节标题 7.3 加环境变量，261-262 写明三处同步 | 相符 |
| H9 | runtime 2.1 与 2.6：`build-and-deploy.md:482` 单副本 | 482 行写明「单副本（一个 /data 一个 postmaster）」 | 相符 |
| H10 | runtime 2.5：sharp 依赖为 `^0.35.5`，锁文件解析到 0.35.5 | `backend/package.json:62` 为 `"sharp": "^0.35.5"`；`pnpm-lock.yaml:6227` 与 `:13427` 为 `sharp@0.35.5` | 相符 |
| H11 | backend 2.4：`preference-defaults.service.ts:47-48` 为 15s 与 512 | 47 行 `ConversionTimeLimit: '15s'`，48 行 `ConversionMemoryLimit: 512` | 相符 |
| H12 | backend 2.1 与六：规范写明默认存储 QOI | `image-api-contracts.md:69` 写明「默认存储格式为 QOI（无损）」 | 相符 |
| H13 | runtime 2.5：宿主 node 与 pnpm 版本不是运行时 | 复核机 `node -v` 为 v24.22.0、`pnpm -v` 为 9.6.0；运行时为容器内 20.20.2 | 相符 |

## 三、总体判定与瓶颈清单复核

1. 总体判定存在且为「部分」。
   - backend 报告第 13 行写「部分成立」，并说明并发受理与多进程转码成立、单核与串行只成立在三处。
   - runtime 报告第 13 行写「总体判定：部分。前端串行体感成立，后端单核事实不成立」。
   - 两者顶层结论一致，均能指到证据，满足 R3 与 Acceptance Criteria 4。
2. 前端串行体感与后端单核事实已区分。
   - runtime 报告第 4 节完整给出前端一次一张的证据链。
   - backend 报告 2.8 节做了交叉验证。措辞上有口径差异，见 S3。
3. 瓶颈清单满足排序与确认推测要求。
   - backend 报告第 4 节 10 条按影响排序，每条都有「判定」行，明确写确认或推测，推测项统一指向待压测，第 5 节给出各项验证方法。
   - 缺口：两份报告都未单列出「优化候选方向与后续任务拆分」，属 PRD R6 的交付缺口，见 S7。
4. 未发现臆造。
   - 抽查 45 条主张全部可复现；数值型主张如镜像创建时间、PID、NanoCpus、docker ps 数量、行号均吻合。
   - 唯二不准确处均为表述层面：S1 与 S2。

## 四、需要修的点

### 4.1 需修正

S1 表述需修正，位置：`runtime-and-frontend.md` 第 11 行与第 3 节事实表「单张图线程数」行。

- 报告主张：每张图的编解码 fork 一个转换子进程，并由 sharp 调用 libvips 原生线程池；单张图线程数默认约等于 CPU 核数。
- 正确事实：该描述只覆盖解码与非 QOI 编码。默认主格式是 QOI，其解码走 `universal-sharp.ts:60-62` 的 `qoiSharpIn`，内部调 `QOIdecode`；编码走 `:159-174` 的 `qoiSharpOut`，内部调 `QOIencode`；两者都是 `qoi-img` 原生插件同步调用，不经过 libvips 线程池，单次 QOI 编码在 worker 内是单线程。
- 建议改法：在该行与事实表补一句「QOI 编解码为原生同步插件，不经 libvips 线程池；跨图片仍靠多进程并行」。总体判定不受影响，因为单张图的 QOI 编码只占一个进程，N 张图仍是 N 个进程。
- 严重度：需修正，表述级，不影响结论成立性。

### 4.2 建议

S2 位置：`backend-upload-pipeline.md` 第 375 行调用链第 7 步、第 418 行瓶颈第 7 条。

- 问题：「静态图选 QOI」与「一张图生命周期至少两次 fork 级转换」未计入 SVG 例外。
- 事实：`image-processor.service.ts:44-49` 对 SVG 直接原样返回，上传路径不 fork；`image.service.ts:188-213` 规定 SVG 不能带编辑参数，`view.component.ts:94-97` 对 SVG 主格式请求 JPEG 预览。
- 建议：加一句「以下计数与 fork 判定均针对非 SVG 路径；SVG 上传为纯主进程同步路径」。

S3 位置：两份报告第 11 至 13 行的「单核」口径。

- 问题：backend 报告把「单实例部署」列入单核成立处，runtime 报告称「后端单核事实不成立」。
- 建议 Lead 在最终答复统一为三层：主进程事件循环单线程；每张图的转换在独立子进程内完成，可跨进程并行；单张图的 QOI 编码在子进程内单线程。

S4 位置：backend 报告第 156 至 166 行引 `sharp.worker.ts:49-58`，runtime 报告第 40 行引 `:39-56`。

- 事实：setrlimit 实际在 49-56；58 行是 `process.on('message', …)`，39-47 是读取 MEMORY_LIMIT_MB 与像素上限。
- 建议：范围收窄为 49-56 与 39-47，内容无需改。

S5 位置：runtime 报告第 114 行与事实表「容器空闲占用」等。

- 事实：VmRSS 复核为 86196 kB，报告写 85784 kB；load average、可用内存、docker ps 数量同理。
- 建议：标注采集时点，避免后续复核者误判为不一致。

S6 位置：runtime 报告第 5 节不确定项第 9 条与 backend 报告 2.7 节。

- 事实：限流 key 构成可确认：`throttler.guard.js:150-152` 默认 tracker 取 `normalizeIp(req.ip)`，165-168 的 key 前缀含类名与 handler。
- 建议：把 runtime 报告的该条不确定项合并为已确认，非矛盾。

S7 位置：两份报告整体。

- 缺口：PRD R6 要求「只给候选方向与建议的后续任务拆分」，两份报告均未单列优化候选清单。
- 建议：Lead 在最终答复补齐候选方向，可从现有瓶颈直接推出：常驻 worker 池替代每次 fork、评估 UV_THREADPOOL_SIZE 与 libvips 并发、避免上传后再转一次、多副本或限流外置。

S8 位置：runtime 报告 2.6 节对 `.env.example` 第 3、20 至 24、28 至 35 行的引用。

- 事实：复核时该文件读取被策略闸门 S-m3 拦截，命中凭据路径规则，未能打开核验。
- 建议：标注为「复核未覆盖」而非「已证伪」，Lead 如需要可另行授权核对。

## 五、PRD 验收标准逐条核对

| 验收标准 | 判定 | 依据 |
|---|---|---|
| 两份报告各含五节 | 满足 | backend 为一至五节加第六节规范依据；runtime 为 1 至 5 节，与要求的小节名一一对应 |
| 每条串行与并发判定可指证据 | 满足 | 抽查 45 条，全部可复现，见第二节 |
| 总体判定为是或否或部分并说明环节 | 满足 | 两份均为「部分」，并分别说明成立与不成立环节 |
| 瓶颈清单按影响排序且区分确认与推测 | 满足 | backend 第 4 节 10 条带判定行，第 5 节给验证方法 |
| git status 除任务目录外无改动 | 满足 | 仅 `?? .trellis/tasks/10-30-investigate-upload-concurrency/` |
| 最终答复含面向用户的简明结论与优化建议 | 待 Lead | 报告已提供素材，S7 提醒补齐候选方向 |

## 六、复核限制

1. 未做压测，报告中标为待压测的影响量级仍是推测，与本任务只读约束和 PRD 不做压测的约定一致，不构成缺陷。
2. 时变数值以复核时点为准，包括 RSS、load average、可用内存、docker ps 数量。
3. 本任务无代码改动，未运行 lint、typecheck、测试，运行这些命令对调查报告复核没有判定意义。
4. 复核只读：未 docker exec，未改容器状态，未读取任何环境变量文件与凭据；`.env.example` 一处引用因策略闸门未核验，已在 S8 标注。
