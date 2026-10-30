# Research: 后端图片上传链路的并发模型

- Query: 用户疑问「上传图片时感觉像是单核串行运行」是否成立
- Scope: internal，只读代码走查，后端为主，前端做交叉验证
- Date: 2026-10-30
- Active task: .trellis/tasks/10-30-investigate-upload-concurrency
- 调查者: upload-backend-researcher

## 一、结论一句话

不是「全局单核串行」：HTTP 请求在单进程 Node 事件循环上并发受理，上传链路里没有全局锁，CPU 最重的转码被 `fork` 到独立子进程执行，理论上多个请求可以并行使用多核；但「单核感」有三个真实来源，一是每个转码任务被关在一个独立子进程里，进程内 JS 只有一条线程且同一时刻只处理一张图，二是主进程里有几段纯 JS CPU 处理会阻塞事件循环，三是按仓库内单实例单进程的部署方式，加上每次转换都新 fork 一个进程、每张图上传后浏览还要再转一次，所以并发上传时的观感接近串行。

**回答用户疑问**：部分成立。并发受理与多进程转码成立，单核与串行只成立在「单个请求内部的流水线」「主进程同步段」「单实例部署」三处，不是整条上传链路的全局串行。

## 二、证据

### 2.1 相关文件清单

| 文件 | 作用 |
|---|---|
| `backend/src/main.ts` | Fastify 实例、multipart 插件注册、全局管道与守卫、唯一 listen |
| `backend/src/routes/image/image-manage.controller.ts` | `POST /api/image/upload` 入口 |
| `backend/src/decorators/multipart/postfiles.pipe.ts` | `request.files()` 迭代器，multipart 限流参数 |
| `backend/src/config/early/multipart.config.service.ts` | 单文件大小上限，默认 128 MB |
| `backend/src/managers/image/image.service.ts` | 上传编排：类型判定、SVG 净化、转码、落库 |
| `backend/src/managers/image/image-processor.service.ts` | 主格式选择：静态图存 QOI，动图存 WebP |
| `backend/src/managers/image/image-converter.service.ts` | 像素预检、转换参数、每次新建 SharpWrapper |
| `backend/src/workers/sharp.wrapper.ts` | 每次转换 `fork` 一个子进程并回收 |
| `backend/src/workers/sharp/sharp.worker.ts` | 子进程入口，setrlimit 内存上限，执行转换 |
| `backend/src/workers/sharp/universal-sharp.ts` | sharp 与 QOI/BMP 编解码适配 |
| `backend/src/managers/image/svg-security.service.ts` | SVG 同步净化，运行在主进程事件循环 |
| `backend/src/collections/image-db/image-file-db.service.ts` | 图片字节写入 Postgres bytea |
| `backend/src/config/early/type-orm.config.service.ts` | TypeORM 连接配置，未配置连接池 |
| `backend/src/util/mutex-fallback.ts` | 唯一一处显式互斥实现 |
| `backend/src/layers/PicsurLayers.module.ts` | 全局限流模块，存储为进程内 |

### 2.2 运行时与部署形态：单进程，无 cluster，无 worker 池

`backend/src/main.ts:19-59`，整个应用只有一个 Node 进程、一个监听端口：

```text
backend/src/main.ts:24-33
  const fastifyAdapter = new FastifyAdapter({
    trustProxy: [ ... ],
  });
  await fastifyAdapter.register(multipart as any);
...
backend/src/main.ts:59
  await app.listen(hostConfigService.getPort(), hostConfigService.getHost());
```

容器里也是单个进程，`Dockerfile:172`：

```text
172: CMD ["pnpm", "--filter", "picsur-backend", "start:prod"]
```

`Dockerfile.allinone:75`：

```text
75: CMD ["node", "backend/dist/main.js"]
```

在 `backend/src`、`shared/src` 与部署脚本中检索 `cluster`、`pm2`、`pm2-runtime`、`worker_threads` 均 0 命中；并发相关库 `p-limit`、`semaphore` 等也 0 命中。唯一的并行机制是 `child_process.fork`，见 2.4。

### 2.3 HTTP 入口：请求并发受理，但请求体整块进内存

上传入口在 `backend/src/routes/image/image-manage.controller.ts:58-90`：

```text
58:   @Post('upload')
59:   @RequiredPermissions(Permission.ImageUpload)
60:   @Returns(ImageUploadResponse)
61:   @EasyThrottle(20)
62:   async uploadImage(
...
67:     const file = ThrowIfFailed(await GetNextAsync(multipart));
...
71:       buffer = await file.toBuffer();
```

请求体解析方式：`@fastify/multipart` 在 `backend/src/main.ts:33` 注册，controller 用 `@PostFiles(1)` 拿 `request.files()` 异步迭代器，`backend/src/decorators/multipart/postfiles.pipe.ts:20-24`：

```text
22:     const files = request.files({
23:       limits: this.multipartConfigService.getLimits(filesLimit),
24:     });
```

`toBuffer()` 把整个文件放进 Node 内存，不落临时盘。单文件上限默认 128 MB，`backend/src/config/early/multipart.config.service.ts:14-19`：

```text
14:   public getMaxFileSize(): number {
15:     return ParseInt(
16:       this.configService.get(`${EnvPrefix}MAX_FILE_SIZE`),
17:       128000000,
18:     );
19:   }
```

这段是 `await` 出来的异步流读取，多个请求的 multipart 解析在事件循环上交错进行，不是串行。真正占用资源的是每请求持有一份完整 Buffer。

### 2.4 图片处理：fork 出去的独立子进程，不是主进程同步转码

上传编排 `backend/src/managers/image/image.service.ts:100-170`，静态图与动图都先经过 `processService.process`，`backend/src/managers/image/image-processor.service.ts:36-55`：

```text
51:     const outputFileType = ParseFileType(ImageFileType.QOI);
52:     if (HasFailed(outputFileType)) return outputFileType;
53:
54:     return this.imageConverter.convert(image, filetype, outputFileType, {});
```

转换入口 `backend/src/managers/image/image-converter.service.ts:83-108`，每次转换新建一个 wrapper：

```text
83:     const maxPixels = this.imageConfig.getMaxImagePixels();
84:     const sharpWrapper = new SharpWrapper(timeLimitMS, memLimit);
...
103:     const hasStarted = await sharpWrapper.start(
104:       image,
105:       sourceFiletype,
106:       sharpOptions,
107:     );
```

`SharpWrapper.start` 的实现是 `fork` 一个完整 Node 子进程，`backend/src/workers/sharp.wrapper.ts:54-65`：

```text
54:     this.worker = fork(SharpWrapper.WORKER_PATH, {
55:       serialization: 'advanced',
56:       timeout: this.instance_timeout,
57:       env: {
58:         MEMORY_LIMIT_MB: this.memory_limit.toString(),
59:         MAX_IMAGE_PIXELS: ReadMaxImagePixelsFromEnv().toString(),
60:         NODE_OPTIONS: '--no-warnings',
61:       },
62:       stdio: 'overlapped',
63:     });
```

`finish` 等子进程回消息，`backend/src/workers/sharp.wrapper.ts:158-180`，结束即杀掉，不复用，`backend/src/workers/sharp.wrapper.ts:231-235`：

```text
172:       const result = await pTimeout(finishPromise, {
173:         milliseconds: this.instance_timeout,
174:       });
...
231:   private purge() {
232:     this.worker?.kill();
233:     this.worker?.removeAllListeners();
234:     this.worker = null;
235:   }
```

子进程内做内存限额与真正的转换，`backend/src/workers/sharp/sharp.worker.ts:49-56` 与 `110-129`；其中 `39-47` 先读取 `MEMORY_LIMIT_MB` 与像素上限：

```text
49:     try {
50:       setrlimit('data', {
51:         soft: 1000 * 1000 * memoryLimit,
52:         hard: 1000 * 1000 * memoryLimit,
53:       });
...
122:       const result = await UniversalSharpOut(sharpi, filetype, options);
```

默认内存上限 512 MB、时间上限 15 秒，`backend/src/collections/preference-db/preference-defaults.service.ts:47-48`：

```text
47:     [SysPreference.ConversionTimeLimit]: '15s',
48:     [SysPreference.ConversionMemoryLimit]: 512,
```

结论：CPU 密集的 decode/encode 不跑在主事件循环上，而是每个转换一个子进程。子进程之间由操作系统调度，可以并行使用多核；但每个子进程内部只有一条 JS 主线程，且同一进程同时只处理一张图，`UniversalSharpOut` 的 QOI 编码还是同步原生调用，`backend/src/workers/sharp/universal-sharp.ts:159-174`：

```text
159: async function qoiSharpOut(sharpImage: Sharp): Promise<SharpResult> {
160:   const raw = await sharpImage.raw().toBuffer({ resolveWithObject: true });
...
164:   const encoded = QOIencode(raw.data, {
165:     width: raw.info.width,
166:     height: raw.info.height,
167:     channels: raw.info.channels as 3 | 4,
168:   });
```

`qoi-img` 的编解码是原生同步插件，`backend/node_modules/qoi-img/dist/index.js:24-30`：

```text
24: const addon = require('bindings')('qoixx_addon');
26: function QOIencode(pixels, options) {
27:     return addon.encode(pixels, options.width, options.height, options.channels, ...);
29: function QOIdecode(data, convertChannels) {
30:     const result = addon.decode(data, convertChannels || 0);
```

### 2.5 主进程里的同步 CPU 段：先预检，再 fork

每次仍会使用主进程的 sharp：像素上限预检直接在主进程调 `sharp().metadata()`，`backend/src/managers/image/image-converter.service.ts:195-197`：

```text
195:       const metadata = await sharp(image, {
196:         limitInputPixels: false,
197:       }).metadata();
```

主进程 sharp 的并行度受 libuv 线程池限制，sharp 自己的类型声明写明，`backend/node_modules/sharp/lib/index.d.ts:104-111`。该预检只在 `PICSUR_MAX_IMAGE_PIXELS` 非 0 且输入不是 BMP 或 QOI 时执行，`backend/src/managers/image/image-converter.service.ts:174-188`：

```text
105:  * Gets or sets the number of threads libvips' should create to process each image.
106:  * The default value is the number of CPU cores. A value of 0 will reset to this default.
107:  * The maximum number of images that can be processed in parallel is limited by libuv's UV_THREADPOOL_SIZE environment variable.
```

仓库源码与部署脚本中没有设置 `UV_THREADPOOL_SIZE`，检索 0 命中，即沿用 libuv 默认值 4，见外部依据。

主进程还有几段纯 JS CPU 处理，直接占用事件循环，不会被 fork 隔离：

1. 文件类型判定：`backend/src/managers/image/image.service.ts:359-401`，`file-type` 读 Buffer，`isSvg` 会把整块内容当 utf8 字符串扫一遍：

```text
367:       else if (isSvg(image.toString('utf8'))) mime = 'image/svg+xml';
...
373:         isSvg(image.toString('utf8'))
```

2. WebP 头部解析：`backend/src/managers/image/image.service.ts:390-394`：

```text
390:     if (mime === 'image/webp') {
391:       const header = await WebPInfo.from(image);
392:       if (header.summary.isAnimated) filetype = AnimFileType.WEBP;
393:       else filetype = ImageFileType.WEBP;
394:     }
```

3. SVG 净化完全同步：`backend/src/managers/image/svg-security.service.ts:41-54`，svgo optimize 加 DOMPurify 加 isSvg 全部在事件循环上执行：

```text
41:   public sanitize(image: Buffer): Failable<Buffer> {
43:       const result = optimize(image.toString('utf8'), {
44:         multipass: true,
45:         plugins: ['preset-default', 'removeScripts'],
46:       });
48:       const sanitized = SvgDOMPurify.sanitize(result.data, {
```

SVG 上传在整个净化期间会阻塞主进程的所有其他请求，这是货真价实的「单核串行」段。

### 2.6 存储与数据库：Postgres bytea，同请求内串行写，无全局锁

图片字节存在 Postgres 的 bytea 列，不在本地磁盘也不在对象存储，`backend/src/database/entities/images/image-file.entity.ts:40-42`：

```text
40:   // Binary data
41:   @Column({ type: 'bytea', nullable: false })
42:   data: Buffer;
```

写入是整块 Buffer upsert，`backend/src/collections/image-db/image-file-db.service.ts:34-55`：

```text
34:   public async setFile(
...
44:     imageFile.data = file;
46:     try {
47:       await this.imageFileRepo.upsert(imageFile, {
48:         conflictPaths: ['image_id', 'variant'],
49:       });
```

上传在一个请求内部按顺序写库，`backend/src/managers/image/image.service.ts:141-167`：

```text
141:     // Save processed to db
142:     const imageEntity = await this.imagesService.create(
...
151:     const imageFileEntity = await this.imageFilesService.setFile(
152:       imageEntity.id,
153:       ImageEntryVariant.MASTER,
...
159:     if (keepOriginal) {
160:       const originalFileEntity = await this.imageFilesService.setFile(
```

即每条上传固定 2 次写，保留原图时 3 次，是请求内串行，但请求之间没有事务锁或全局写队列。TypeORM 配置未设置连接池参数，`backend/src/config/early/type-orm.config.service.ts:51-74`：

```text
51:   public createTypeOrmOptions() {
52:     const varOptions = this.getTypeOrmServerOptions();
53:     return {
54:       type: 'postgres' as const,
...
72:       ...varOptions,
73:     } as TypeOrmModuleOptions;
```

`backend/src` 中没有 `extra`、`poolSize`、`max:` 连接池配置，即沿用 node-postgres 默认池大小 10，见外部依据。

### 2.7 显式锁：只有缓存填充互斥，没有上传互斥

唯一显式互斥实现是 `backend/src/util/mutex-fallback.ts:14-20`，一个进程内以字符串为 key 的 Promise 表：

```text
14: const fallBackMap: Record<string, Promise<unknown>> = {};
15:
16: export async function MutexFallBack<
...
21:   const try_it = await mainFunc();
22:   if (try_it !== undefined && try_it !== null) return try_it;
```

使用点只有三类：偏好默认值填充、派生图缓存缺失时的生成、以及读路径转换，`backend/src/managers/image/image.service.ts:216-226`：

```text
216:     const converted_key = this.getConvertHash({ mime: fileType, ...options });
217:
218:     return MutexFallBack(
219:       // The mutex key must include the image: ...
222:       `${imageId}:${converted_key}`,
223:       () => {
224:         return this.imageFilesService.getDerivative(imageId, converted_key);
225:       },
```

这是按「图片 id 加转换参数」去重，只影响同一张图同一参数的并发转换请求，上传新图不经过它，key 也不同。

限流方面：上传是每 IP 每分钟 20 次，`backend/src/routes/image/image-manage.controller.ts:61` 的 `@EasyThrottle(20)`，装饰器把秒换算成毫秒并默认 ttl 60 秒，`backend/src/decorators/easy-throttle.decorator.ts:12-21`。图片读取是每 IP 每分钟 600 次，`backend/src/routes/image/image.controller.ts:42-52`。限流存储是进程内内存，未接 Redis，`backend/src/layers/PicsurLayers.module.ts:10-17` 只传了 throttlers。

```text
backend/node_modules/@nestjs/throttler/dist/throttler.providers.js:17-21
    provide: throttler_storage_interface_1.ThrottlerStorage,
        return !Array.isArray(options) && options.storage
            ? options.storage
            : new throttler_service_1.ThrottlerStorageService();
```

限流 key 含 handler 与 IP，`backend/node_modules/@nestjs/throttler/dist/throttler.guard.js:165-168`，即上传计数是 `/api/image/upload` 单独的桶。这是硬上限，但不构成服务端串行。

另有每分钟一次的清理 cron，`backend/src/managers/image/image-manager.module.ts:40-44`，顺序执行两个清理任务，只短暂占用数据库连接。

### 2.8 前端交叉验证：一次只传一张，上传后浏览再触发一次转换

上传页面把文件交给处理页，`frontend/src/app/routes/upload/upload.component.ts:38-43`，处理页只上传第一个文件，`frontend/src/app/routes/processing/processing.component.ts:35`：

```text
35:     const id = await this.imageService.UploadImage(state.imageFiles[0]);
```

批量上传方法在代码里是注释掉的，`frontend/src/app/services/api/image.service.ts:56-69`。所以从 UI 看，「一张传完再传下一张」首先由前端串行决定，而不是服务端强制排队。

上传成功后进入浏览页，浏览页请求的是「主格式加宽度参数」，`frontend/src/app/routes/view/view.component.ts:86-101`：

```text
 86:   public get previewLink(): string {
 90:     const width = window.innerWidth * window.devicePixelRatio;
 94:     const previewFiletype =
100:       this.imageService.GetImageURL(this.id, previewFiletype) +
101:       (width > 1 ? `?width=${width}&shrinkonly=yes` : '')
```

主格式是 QOI，带宽度参数的派生图首次请求必然 miss，于是又 fork 一次子进程生成派生图，`backend/src/managers/image/image.service.ts:233-240` 与 `279-284`。画廊缩略图同理，`frontend/src/app/routes/images/images.component.ts:324-329` 请求 WebP 加宽度。也就是说每张图片在上传后首次被浏览时，还会再来至少一次昂贵转换。

## 三、上传调用链逐段说明

以「浏览器 POST 一张 PNG」为例，单请求生命周期如下，全程在主进程单线程事件循环上按 `await` 分段让出。

1. 路由与限流：`POST /api/image/upload`，全局守卫按注册顺序先过 `PicsurThrottlerGuard` 扣上传桶计数，`backend/src/layers/throttler/PicsurThrottler.guard.ts:6-9`，再由 `EasyThrottle(20)` 的 20 次每分钟上限判定，`backend/src/routes/image/image-manage.controller.ts:58-61`；随后 `MainAuthGuard` 跑 JWT 认证并查一次用户权限，`backend/src/managers/auth/guards/main.guard.ts:51-72`。
2. multipart 解析：`@PostFiles(1)` 返回 `request.files()` 迭代器，`backend/src/decorators/multipart/postfiles.pipe.ts:20-24`，限 `files: 1`、`fileSize: 128 MB`，`backend/src/config/early/multipart.config.service.ts:21-29`。
3. 读入内存：controller 取第一个文件并 `toBuffer`，`backend/src/routes/image/image-manage.controller.ts:67-74`，整个图片进入 V8 堆。
4. 类型判定：`ImageManagerService.upload` 调 `getFileTypeFromBuffer`，`backend/src/managers/image/image.service.ts:106` 与 `359-401`，`file-type` 读 Buffer，SVG 与 QOI 走额外分支，WebP 走 `WebPInfo.from`。
5. SVG 分支：仅 SVG 走 `svgSecurity.sanitize`，同步 svgo 加 DOMPurify，`backend/src/managers/image/image.service.ts:109-118` 与 `svg-security.service.ts:41-54`；其余格式跳过。
6. 偏好读取：查 `KeepOriginal` 用户偏好，`backend/src/managers/image/image.service.ts:120-125`，命中 TypeORM 查询缓存则开销很小，`backend/src/collections/preference-db/usr-preference-db.service.ts:83-85`。
7. 主格式转换：`ImageProcessorService.process` 选目标格式，非 SVG 静态图选 QOI，`backend/src/managers/image/image-processor.service.ts:36-55`；SVG 是例外，不走转码也不 fork，直接原样返回，`backend/src/managers/image/image-processor.service.ts:44-49`，且 SVG 不允许带编辑参数，`backend/src/managers/image/image.service.ts:188-213`。以下计数与 fork 判定均针对非 SVG 路径。
8. 转码准备：`ImageConverterService.convertImage` 并行读两个系统偏好，`backend/src/managers/image/image-converter.service.ts:73-76`，`Promise.all` 并发；然后主进程 `sharp().metadata()` 做像素预检，`image-converter.service.ts:195-197`。
9. 子进程转码：`new SharpWrapper`，`fork` 子进程，`backend/src/workers/sharp.wrapper.ts:54-65`；子进程 `setrlimit` 限内存，`backend/src/workers/sharp/sharp.worker.ts:49-56`；`init` 解出 sharp 实例，`sharp.worker.ts:85-89`；`finish` 做 `UniversalSharpOut` 编码，`sharp.worker.ts:110-129`；QOI 输出走同步原生编码，`universal-sharp.ts:159-174`。主进程 `await pTimeout` 等结果，`backend/src/workers/sharp.wrapper.ts:158-180`，随后 `purge` 杀掉子进程，`sharp.wrapper.ts:231-235`。
10. 落库第一步：写 `e_image_backend` 元数据并 `reload: true`，`backend/src/managers/image/image.service.ts:142-149` 与 `backend/src/collections/image-db/image-db.service.ts:21-48`。
11. 落库第二步：主格式字节 upsert 到 `e_image_file_backend`，`backend/src/managers/image/image.service.ts:151-157` 与 `backend/src/collections/image-db/image-file-db.service.ts:34-55`。
12. 可选第三步：`KeepOriginal` 打开时再把原图 upsert 一份，`backend/src/managers/image/image.service.ts:159-167`。
13. 响应：返回图片实体给前端，前端跳转浏览页。
14. 后续读路径：浏览和缩略图请求走 `getConverted`，按「图片 id 加参数哈希」做 `MutexFallBack` 去重，`backend/src/managers/image/image.service.ts:216-226`，miss 时再一次走第 8 到 9 步的 fork 转码，`image.service.ts:233-240`，成功后写派生图，`image.service.ts:279-284`。

## 四、瓶颈点清单，按影响排序

1. 每次转换都新 fork 一个 Node 子进程，没有常驻 worker 池。
   - 证据：`backend/src/workers/sharp.wrapper.ts:54-65` 与 `231-235`，每次 `new SharpWrapper` 见 `backend/src/managers/image/image-converter.service.ts:84`。
   - 影响：每个请求的延迟里固定含一次进程创建加模块加载加 libvips 初始化开销；并发 N 张时同时存在 N 个 Node 进程，CPU 与内存互抢，超过核数后反而互相拖慢。
   - 判定：确认是设计事实；对吞吐的具体影响待压测。

2. 单实例单进程部署，主进程 JS 段只有一核。
   - 证据：`backend/src/main.ts:19-59` 只有一次 listen，`Dockerfile:172` 单进程，`backend/src` 与部署脚本中无 `cluster` 或 `pm2`。
   - 影响：事件循环上的同步工作无法横向分摊，多副本部署在仓库里没有体现。
   - 判定：确认。

3. 主进程同步纯 JS CPU 段阻塞事件循环。
   - 证据：SVG 净化 `backend/src/managers/image/svg-security.service.ts:41-54`，类型判定与 `isSvg` 全文扫描 `backend/src/managers/image/image.service.ts:359-401`，WebP 头解析 `image.service.ts:390-394`。
   - 影响：这些段执行期间所有其他请求被卡住，SVG 上传最明显，是真正意义上的单核串行。
   - 判定：确认存在；阻塞时长与文件大小相关，待压测。

4. 主进程每次上传都做 sharp metadata 预检，受 libuv 线程池限制。
   - 证据：`backend/src/managers/image/image-converter.service.ts:195-197`，sharp 类型声明 `backend/node_modules/sharp/lib/index.d.ts:104-111` 明确并行图片数受 `UV_THREADPOOL_SIZE` 限制，仓库内未设置该变量。
   - 影响：默认 4 个 libuv 线程，并发上传大于 4 时 metadata 预检排队，表现为并发上传启动延迟。
   - 判定：预检位置确认；默认值 4 来自 libuv 文档；实际影响待压测。

5. 整文件读入内存，单文件默认 128 MB。
   - 证据：`backend/src/routes/image/image-manage.controller.ts:71`，`backend/src/decorators/multipart/postfiles.pipe.ts:20-24`，上限 `backend/src/config/early/multipart.config.service.ts:14-19`。
   - 影响：主进程每请求持有一份完整 Buffer，IPC 传给子进程还会再复制一份并解码，内存随并发与文件大小线性增长；子进程侧有 512 MB 的 data rlimit，大图或高并发会先在子进程侧失败或被杀，主进程侧则表现为 GC 抖动与停顿。
   - 判定：确认。

6. 图片字节存 Postgres bytea，每上传串行 2 到 3 次写，连接池未配置。
   - 证据：`backend/src/database/entities/images/image-file.entity.ts:40-42`，`backend/src/collections/image-db/image-file-db.service.ts:34-55`，顺序写 `backend/src/managers/image/image.service.ts:141-167`，无池配置 `backend/src/config/early/type-orm.config.service.ts:51-74`。
   - 影响：大图整块写库是重 IO，node-postgres 默认池上限 10，并发上传时写库会排队；这是请求之间的共享资源上限。
   - 判定：写入方式确认；默认池 10 来自 node-postgres 文档；实际排队待压测。

7. 上传后浏览会再触发一次转码。
   - 证据：`frontend/src/app/routes/view/view.component.ts:86-101` 带宽度参数请求主格式，`backend/src/managers/image/image.service.ts:233-240` 缓存 miss 时转换；缩略图 `frontend/src/app/routes/images/images.component.ts:324-329`。SVG 例外：上传走纯主进程同步路径不 fork，`backend/src/managers/image/image-processor.service.ts:44-49`；SVG 不能带编辑参数，`backend/src/managers/image/image.service.ts:188-213`；但 SVG 主格式预览会被改请求 JPEG，`frontend/src/app/routes/view/view.component.ts:94-97`，读路径仍会触发一次转换。
   - 影响：用户感知里「上传慢」其实包含「浏览页第一次打开慢」；以下计数与 fork 判定均针对非 SVG 路径，非 SVG 图生命周期至少两次 fork 级转换，SVG 则是上传 0 次 fork 加读路径按需一次转换。
   - 判定：机制确认；各占多少耗时待压测。

8. 上传限流每 IP 每分钟 20 次，进程内计数。
   - 证据：`backend/src/routes/image/image-manage.controller.ts:61`，`backend/src/decorators/easy-throttle.decorator.ts:12-21`，`backend/src/layers/PicsurLayers.module.ts:10-17`，存储实现 `backend/node_modules/@nestjs/throttler/dist/throttler.providers.js:17-21`。
   - 影响：连续快速上传超过 20 次会被直接拒绝，不排队；多实例部署时各实例独立计数。
   - 判定：确认。

9. 读路径派生图有按图按参数的互斥去重。
   - 证据：`backend/src/managers/image/image.service.ts:216-226` 与 `backend/src/util/mutex-fallback.ts:14-52`。
   - 影响：同一图同一参数并发请求会串行等到首次转换完成；不影响上传，只影响热点图首次加载。
   - 判定：确认，但不是上传链路瓶颈。

10. 每分钟清理 cron 顺序执行两个删除任务。
    - 证据：`backend/src/managers/image/image-manager.module.ts:40-44`。
    - 影响：短暂占用数据库连接，影响很小。
    - 判定：确认存在，影响为推测。

## 五、不确定项与待验证项

1. 未做压测。缺并发 N 张上传的 wall time 曲线、CPU 使用率、内存峰值、fork 开销实测值；以上「影响」判断中标注为推测的部分都需要实测。
2. fork 开销的具体数字未测。子进程要加载 Node 运行时、sharp、libvips 与后端模块，冷启动时间可能占单请求延迟的相当比例，需用基准脚本确认。
3. `UV_THREADPOOL_SIZE` 未设置对 metadata 预检的实际影响未测。默认 4 是 libuv 文档值，仓库内确认未覆盖，但排队程度取决于单次 metadata 耗时。
4. libvips 实际线程数未验证。sharp 类型声明说默认等于 CPU 核数，但镜像里自编译 libvips 是否被环境变量或构建参数改过未检查，详见 `.trellis/spec/picsur-backend/backend/build-and-deploy.md`。
5. 线上与本地实例的实际部署形态未验证。仓库内只有单进程 Dockerfile；规范文档提到的 `docker-compose.yml` 不在仓库中，副本数与 CPU 限额未读到。
6. Postgres 连接池实际大小未读到。仓库确认未配置，默认 10 来自 node-postgres 文档，实际是否被外部环境变量覆盖未验证。
7. 单次 QOI 编码与 libvips 解码的耗时占比未测。QOI 走原生同步编码，在子进程内单线程执行。
8. SVG 上传阻塞事件循环的时长未测。svgo 与 DOMPurify 在大 SVG 上的耗时未知。
9. 前端多选文件的实际行为未深挖。处理页只取 `state.imageFiles[0]`，多选其余文件是否被静默丢弃，属于前端行为，需单独确认。
10. 未读到项：线上部署编排文件、运行中进程与线程数、数据库实际负载统计。按只读约束与工作区限制未进一步取证，也未读取任何环境变量文件与凭据。

## 六、相关规范与外部依据

相关规范：

- `.trellis/spec/picsur-backend/backend/image-api-contracts.md`：上传与转换路由契约，默认 QOI 存储、错误矩阵、像素上限行为，本次走查的结论与其中描述一致。
- `.trellis/spec/picsur-backend/backend/build-and-deploy.md`：镜像内自编译 libvips 与 sharp 构建约束、`PICSUR_MAX_IMAGE_PIXELS` 默认值、单容器部署方式。

外部依据：

- [libuv thread pool 文档](https://docs.libuv.org/en/latest/threadpool.html)：默认线程池大小 4，可用 `UV_THREADPOOL_SIZE` 调整。
- [sharp concurrency API](https://sharp.pixelplumbing.com/api-utility#concurrency)：每张图默认使用与 CPU 核数相同的 libvips 线程，并行图片数受 `UV_THREADPOOL_SIZE` 限制；同样的说明在本地类型声明 `backend/node_modules/sharp/lib/index.d.ts:104-111`。
- [node-postgres Pool 文档](https://node-postgres.com/apis/pool)：连接池 `max` 默认 10。
