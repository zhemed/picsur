# Research: 前端单张图上传能否走多核

- Query: 单张照片上传时，前端能不能走多核；浏览器侧到底做了哪些计算
- Scope: internal，仓库源码静态盘点 + 只读关键词扫描；外部文档只用于浏览器协议行为
- Date: 2026-10-30
- Task: task-9，目录 `.trellis/tasks/10-30-single-image-multicore-eval`
- 相关规范: `.trellis/spec/picsur-backend/backend/upload-concurrency.md`、`image-api-contracts.md`、`build-and-deploy.md`
- 只读声明: 本轮未改代码与配置，未启动服务，未碰 8080 现网容器，未做压测；调研笔记只写入本文件。

## 1. 结论

结论：前端单张上传不能走多核，而且当前实现里没有可并行的图像计算——上传请求本身是浏览器原生网络 I/O，JS 只做 FormData 组装和响应解析；整个前端唯一的图像计算是上传完成后展示页的 QOI 解码，它已经放在一个 Web Worker 里，但 QOI 解码逐像素顺序依赖，单张图无法拆给多个核。

明确回答 R6 的前端部分：不能走多核，属于「当前实现没有」，而且是「没有可并行对象」，不是「没开线程池」。加 Web Worker、HTTP/2 多路复用、多连接都不能把单张照片的计算拆到多个核；分片上传需要后端新接口，且对 CPU 没有收益。

- 上传请求内客户端图像编解码次数：0
- 上传请求内客户端压缩、EXIF、哈希或加密次数：0
- 上传路径可并行的 CPU 计算：无
- 多核对当前上传延迟的收益上限：约 0，因为客户端没有图像计算段；瓶颈在传输与服务端转换

## 2. 证据盘点：单张上传浏览器侧实际做了什么

### 2.1 上传路径逐阶段

| 阶段 | 实际工作 | 性质 | 证据 |
|---|---|---|---|
| 选择文件 | 原生 file input 无 multiple，点击后由浏览器打开文件选择器 | 系统交互，无图像计算 | `frontend/src/app/routes/upload/upload.component.html:3`、`frontend/src/app/routes/upload/dropzone/dropzone.component.ts:10-13` |
| 选中或拖入 | `FileInputDirective` 只取 File 对象并写入 FormControl，不读取文件内容 | 无 CPU，File 是浏览器持有的二进制引用 | `node_modules/.pnpm/@ngx-dropzone+cdk@21.1.0_*/node_modules/@ngx-dropzone/cdk/fesm2022/ngx-dropzone-cdk.mjs:260-278` |
| 路由跳转 | `valueChanges` 里把 File 包成数组，构造 ProcessingViewMeta，跳 `/processing` | 微 JS | `frontend/src/app/routes/upload/upload.component.ts:38-45` |
| 粘贴入口 | 从剪贴板拿 File 列表后同样跳 `/processing`，不读内容 | 无 CPU | `frontend/src/app/routes/upload/upload.component.ts:56-80` |
| 上传请求构造 | `new ImageUploadRequest(file)` 后 `FormData.append('image', file)`，只传引用 | 应用层无文件内容拷贝 | `frontend/src/app/models/dto/image-upload-request.dto.ts:3-10` |
| 发起 HTTP | `imageService.UploadImage` 调一次 `postForm`，`fetch` 里只调一次 `axios.request` | 网络 I/O，单请求 | `frontend/src/app/services/api/image.service.ts:46-54`、`frontend/src/app/services/api/api.service.ts:141-150`、`api.service.ts:255-289` |
| 上传进度 | axios onUploadProgress 回调把百分比推给 BehaviorSubject | 网络事件回调，非计算 | `frontend/src/app/services/api/api.service.ts:281-286` |
| 取消 | AbortController.abort 中止请求 | 网络操作 | `frontend/src/app/services/api/api.service.ts:270`、`:287`、`:304-308` |
| 响应处理 | Zod 校验统一信封，取 `data.id` | 极小 CPU | `frontend/src/app/services/api/api.service.ts:152-196`、`frontend/src/app/services/api/image.service.ts:47-53` |
| 跳转结果页 | `router.navigate` 到 `/view/<id>` | 微 JS | `frontend/src/app/routes/processing/processing.component.ts:35-40` |

processing 页面本身只有一个 spinner，没有任何图片、预览或解码代码：`frontend/src/app/routes/processing/processing.component.html:1-6`。上传页也没有图片元素或预览：`frontend/src/app/routes/upload/upload.component.html` 全文无 img，grep 上传与 processing 目录的 `<img|picsur-img` 为 0 命中。

### 2.2 上传之后的展示阶段，单独列出

这一步不属于上传请求，但属于「上传一张照片后用户马上看到它」的流程，是前端唯一存在图像 CPU 工作的地方，必须与上传区分。

| 子步骤 | 实际工作 | 性质 | 证据 |
|---|---|---|---|
| 请求展示图 | 展示页把主格式按屏幕宽度拼成 URL，默认主格式是 QOI | 网络请求 | `frontend/src/app/routes/view/view.component.ts:86-103`、`:94-97` |
| 判定格式 | `picsur-img` 先发 HEAD 拿 content-type | 网络请求 | `frontend/src/app/components/picsur-img/picsur-img.component.ts:181-193` |
| QOI 解码 | QOI 分支把 URL 发给唯一的 Worker；Worker 内 fetch、arrayBuffer、`QOIdecodeJS` | 网络加 CPU，解码在 Worker | `frontend/src/app/components/picsur-img/picsur-img.component.ts:134-146`、`frontend/src/app/workers/qoi-worker.service.ts:26-50`、`frontend/src/app/workers/qoi.job.ts:10-36` |
| 解码算法 | 纯 JS 逐像素顺序解码，每个像素依赖前一个像素状态与 64 项索引表 | 单线程、顺序依赖 | `frontend/src/app/util/qoi/qoi-decode.ts:80-93`、`:95-167` |
| 回传绘制 | Worker 把 ImageData postMessage 回主线程，主线程 `canvas.getContext('2d')?.putImageData` | 结构化克隆的内存拷贝加主线程绘制 | `frontend/src/app/workers/qoi.worker.ts:6-21`、`frontend/src/app/components/picsur-img/picsur-img.component.ts:140-146`、`picsur-img.component.html:18-24` |
| 非 QOI 分支 | 拉 bytes 后 `new Blob` 加 `URL.createObjectURL`，交给原生 img 由浏览器解码 | 网络加浏览器内部解码 | `frontend/src/app/components/picsur-img/picsur-img.component.ts:147-170` |

对比：图库缩略图已经改成 WebP 并显式走 `[native]="true"`，由浏览器自己解码，不再走 QOI worker 路径；代码注释明确写了 QOI 路径要 HEAD、fetch、worker decode 与 canvas paint，成本高：`frontend/src/app/routes/images/images.component.ts:316-330`、`frontend/src/app/routes/images/images.component.html:31-40`。

### 2.3 关键词扫描结果

扫描范围 `frontend/src`，下列关键词全部逐条核对，命中位置与判定如下。

| 关键词 | 上传路径 | 全前端命中 | 判定 |
|---|---|---|---|
| FileReader | 0 | 0 | 客户端不读文件内容 |
| arrayBuffer | 0 | `frontend/src/app/workers/qoi.job.ts:19`，展示阶段 | 上传路径无读取 |
| canvas | 0 | `frontend/src/app/components/picsur-img/picsur-img.component.ts:143`，展示绘制 | 与上传无关 |
| createImageBitmap | 0 | 0 | 无 |
| OffscreenCanvas | 0 | 0 | 无 |
| new Worker | 0 | `frontend/src/app/workers/qoi-worker.service.ts:20`，共 1 个 | 展示用 QOI 解码器 |
| URL.createObjectURL | 0 | `picsur-img.component.ts:155`、`util.service.ts:21` | 展示与下载 |
| 图像压缩 | 0 | 0，依赖里也没有 | 无客户端压缩 |
| 哈希与加密 | 0 | 0，无 `crypto.subtle`、digest、sha 等调用 | 无 |
| 预览渲染 | 0 | 上传页与 processing 页无图片元素 | 上传前无预览 |
| File.slice | 0 | 只有 `util/qoi/qoi-encode.exclude.ts:211` | 未做分片 |
| service worker | 0 | 0，`angular.json` 与源码都无 | 无 |

对应的扫描命令是只读 grep，产出的关键结论：

- `grep -rn "FileReader|createImageBitmap|OffscreenCanvas|toBlob|toDataURL|CompressionStream" frontend/src` 无命中。
- `grep -rn "new Worker" frontend/src` 只有 1 处，即 `qoi-worker.service.ts:20`。
- `grep -rn "crypto|subtle|gzip|deflate|compress" frontend/src` 无命中。
- `grep -rn "serviceWorker|ngsw" frontend/angular.json frontend/src` 无命中。
- `grep -rn "<img|picsur-img" frontend/src/app/routes/upload frontend/src/app/routes/processing` 无命中。
- 上传路径范围内 `grep "arrayBuffer|FileReader|.text()|.stream()"` 无命中，唯一命中在展示阶段 `qoi.job.ts:19`。

### 2.4 依赖与构建事实

- `frontend/package.json:18-49` 的运行时依赖里没有任何图像处理库，没有 sharp、jimp、pica、browser-image-compression、exif 之类；只有 `axios ^1.20.0`、`@ngx-dropzone/cdk ^21.1.0` 等：`frontend/package.json:33`、`:35`。
- 安装到的 axios 版本是 1.20.0：`node_modules/.pnpm/axios@1.20.0/node_modules/axios/package.json` 的 version 字段；其默认适配器顺序是 `['xhr','http','fetch']`，见 `node_modules/.pnpm/axios@1.20.0/node_modules/axios/lib/defaults/index.js:42`，浏览器里 `http` 不可用，实际走 XHR，`onUploadProgress` 由 XHR 上传事件提供；代码里没有自定义 adapter 或分片逻辑：`frontend/src/app/services/api/api.service.ts:274-289`。
- Angular 构建为 Worker 单独编译：`frontend/angular.json:43` 的 `webWorkerTsConfig`，`frontend/tsconfig.worker.json:5-10` 只包含 `src/app/workers/*.worker.ts`。
- `frontend/tsconfig.app.json:11` 把 `*.worker.ts` 与 `*.exclude.ts` 排除出主应用构建。
- `frontend/src/app/util/qoi/qoi-encode.exclude.ts` 里定义了 JS 版 QOI 编码器 `QOIencodeJS:15`，但全前端没有任何引用，且被 `tsconfig.app.json:11` 排除，属于不参与构建的死代码。
- 批量上传 DTO `frontend/src/app/models/dto/images-upload-request.dto.exclude.ts:3-13` 同样被排除；批量服务方法整段被注释，目标端点也不存在：`frontend/src/app/services/api/image.service.ts:56-69`。

## 3. 工作性质分类：网络 I/O、内存拷贝、CPU 计算

### 3.1 网络 I/O，与核数无关

- 上传：一次 multipart POST，浏览器把 File 的字节交给网络栈发送，应用只等待 Promise：`frontend/src/app/services/api/image.service.ts:46-54`、`api.service.ts:255-289`。
- 展示：HEAD 判类型加 GET 取派生图：`picsur-img.component.ts:181-193`、`qoi.job.ts:10-18`。
- 进度与取消：XHR 上传进度事件与 abort：`api.service.ts:281-286`、`:304-308`。
- 传输快慢取决于带宽、RTT、服务端处理与协议，不取决于客户端用了几个核；把传输说成多核收益是错的。

### 3.2 内存拷贝

- 上传路径应用层不复制文件内容：File 直接进 FormData，代码里没有 FileReader、arrayBuffer 或 slice：`frontend/src/app/models/dto/image-upload-request.dto.ts:6-10`。浏览器内部把 File 数据交给网络栈的复制次数属浏览器实现，本仓库无法证实。
- 展示路径有多处拷贝：response 进 ArrayBuffer `qoi.job.ts:19`，解码输出 Uint8Array `qoi-decode.ts:77-78`，构造 ImageData `qoi.job.ts:23-30`，postMessage 结构化克隆 `qoi.worker.ts:20`，canvas putImageData `picsur-img.component.ts:143`，非 QOI 分支的 Blob 与 objectURL `picsur-img.component.ts:153-155`。
- 下载与分享路径还会再复制：`frontend/src/app/util/download-manager/download.service.ts:97-109`、`frontend/src/app/util/util.service.ts:21-22`。
- 这些拷贝都在展示或下载阶段，不在上传请求内。

### 3.3 CPU 计算

- 上传请求内：FormData 组装、axios 回调、响应 Zod 校验、路由跳转，耗时为微秒到毫秒级，不涉及图像解码或编码：`api.service.ts:152-196`。
- 展示路径：QOI JS 解码是唯一明显的 CPU 段，位于 Worker 内且逐像素顺序执行；主线程还有 `putImageData` 与绘制：`qoi-decode.ts:95-167`、`picsur-img.component.ts:140-146`。
- 浏览器对 WebP、JPEG 等原生格式的解码发生在浏览器内部，应用代码不可控制，也不能算作应用可用的多核手段：`picsur-img.component.html:7-16`、`images.component.ts:316-330`。

## 4. 当前客户端是否做图像处理

判定：上传路径完全不做；整个前端只在展示阶段做 QOI 解码与 canvas 绘制。

- 上传前：没有预览、没有尺寸检查、没有压缩、没有格式转换；上传页与 processing 页无图片元素。
- 上传中：没有任何文件内容读取；唯一的客户端解码器 QOI worker 服务是懒加载的展示组件依赖，上传组件不引用它：`frontend/src/app/components/picsur-img/picsur-img.component.ts:19`、`frontend/src/app/workers/qoi-worker.service.ts:18-24`。
- 上传后展示：QOI 主格式需要客户端解码，这是当前默认主格式 QOI 的直接后果；后端把静态图转成 QOI 存储，浏览器不能原生渲染，所以展示页必须手工解码：`.trellis/spec/picsur-backend/backend/upload-concurrency.md:71-77`、`frontend/src/app/routes/view/view.component.ts:94-97`。
- 客户端 QOI 编码器与批量上传 DTO 都是排除在构建外的死代码，不属于当前能力。

## 5. 前端多核手段逐个判定

| 手段 | 对单张上传是否有效 | 理由与证据 |
|---|---|---|
| 用 Web Worker 外包当前上传 | 无效 | 上传路径没有可外包的 CPU 工作；把 fetch 放进 Worker 仍是同一条网络传输，不会增加带宽或核数：`api.service.ts:255-289`、`image.service.ts:46-54` |
| 用 Web Worker 做客户端预处理 | 有限，不是多核 | 可把未来新增的解码、缩放、重编码移出主线程；单张图在应用视角仍是单线程编码，多 worker 只能靠自研分块，格式与画质复杂；且新增本不存在的计算：`qoi-decode.ts:95-167` |
| HTTP/2 多路复用 | 无效 | 多路复用拆分的是多条并发请求，不是单个 multipart 请求体；单张上传仍是一个请求一个流。后端服务本身是 HTTP/1.1，`main.ts` 只传 trustProxy，没有 http2 或 TLS 配置；`git grep` 检索 http2、TLS、createSecureServer 三个关键字在 backend 与部署文件 0 命中：`backend/src/main.ts:24-31`、`:58-59` |
| 多连接 | 无效 | 单文件只占一条连接；浏览器同源连接数有限，通用上限约 6 条；只有把文件拆成多个请求才有并行传输，而当前前端没有拆分逻辑：`frontend/src/app/models/dto/image-upload-request.dto.ts:6-10` |
| 分片上传 | 可做但无 CPU 收益 | 需要后端新增分片接口与重组，当前只有一个上传路由且每请求只收 1 个文件，`@Post('upload')`、`@PostFiles(1)`、`file.toBuffer()` 一次读全量：`backend/src/routes/image/image-manage.controller.ts:58-90`、`:63`、`:69-74`；前端分片不减少任何客户端计算，服务端还要拼接并仍然单线程转换 |
| 客户端哈希或校验 | 当前无，未来可能是新增 CPU | 当前前端没有 crypto.subtle、digest、sha 等调用；若为分片或去重引入，属于新增工作，可以用多 worker 并行，但不改变单图上传现状 |
| Service Worker | 与核数无关 | 仓库没有 service worker 配置，它解决缓存、离线与代理问题，不是 CPU 并行手段 |
| 依赖浏览器内部线程 | 不可由应用控制 | TLS、网络栈、原生图片解码可能使用浏览器内部线程，但应用无法调度，也不能算作前端可用的多核能力，见不确定项 |

补充：唯一可能让前端「用上多核」的场景是一次上传或展示多张图，例如多个请求并发、多个 QOI 解码任务并发；但这是上一轮已结论的批量与并发问题，不是单张图内部拆分。单张图内部没有可用的图片级并行。

## 6. 若未来引入客户端并行处理：收益、代价与判定

- 可获得的收益：只有当网络是瓶颈时，客户端缩图、转码或压缩才可能减少上传字节，从而缩短网络时间；多核最多加速客户端编码这一步，而当前客户端这一步不存在，所以对现有上传延迟的多核收益上限约为 0。
- 代价一：新增客户端 CPU、电量与发热，Worker 与主线程之间还有结构化克隆的拷贝成本。
- 代价二：重复计算。服务端收到字节后仍会完整解码并转成默认主格式 QOI，客户端先编码一次再让服务端再编码一次，总 CPU 增加：`.trellis/spec/picsur-backend/backend/upload-concurrency.md:71-77`、`backend/src/managers/image/image-processor.service.ts:51`。
- 代价三：画质不可逆。客户端压缩或缩小会在上传前先损失原图质量，后端主格式 QOI 只是对收到的字节做无损转换，有损预处理与默认存储契约冲突：`.trellis/spec/picsur-backend/backend/image-api-contracts.md:69`。
- 代价四：单张图内并行需要自研分块编解码，输出格式与画质都要自己负责，复杂度和维护成本高，且浏览器 API 的可并行粒度不由应用决定。
- 判定：为了「单张上传走多核」不值得做；如果目标是让单张上传更快，应先测清上传耗时的网络、服务端转换、客户端计算三段占比，当前代码表明客户端计算段接近 0，前端不是单张上传慢的杠杆点。

## 7. 相关规范与外部参考

- `.trellis/spec/picsur-backend/backend/upload-concurrency.md:12-14`、`:69-77`、`:79-87`：单张图处理基本单核、默认主格式 QOI 单线程编解码、前端上传并发上限 1。
- `.trellis/spec/picsur-backend/backend/image-api-contracts.md:21`、`:54-71`、`:69`：上传是单请求 multipart，字段名 file，默认存储 QOI。
- `README.md:6-14` 与 `docs/MAINTAINING.md:5-13`：唯一部署方式是单容器 docker run，直接暴露 8080；本仓库既有只读调查已核实仓库内没有 nginx、Caddy、Traefik 配置，8080 是明文 HTTP，TLS 只能由外部另加：`.trellis/tasks/10-25-video-support-eval/research/infra-security.md:11`、`:41`。
- [MDN: Connection management in HTTP/1.x](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Connection_management_in_HTTP_1.x)：浏览器对每个域名开若干并行连接，常见上限约 6 条，HTTP/1.1 无法在单连接内并行请求。
- [MDN: HTTP/2](https://developer.mozilla.org/en-US/docs/Glossary/HTTP_2)：HTTP/2 的多路复用与优先级用于减少多个请求之间的队头阻塞，不改变单个请求的语义。
- [HTTP/2 FAQ](https://http2.github.io/faq/) 与 [Wikipedia: HTTP/2](https://en.wikipedia.org/wiki/HTTP/2)：主流浏览器只支持基于 TLS 的 HTTP/2，明文 h2c 不被浏览器采用；仓库服务端本身是 HTTP/1.1。

## 8. 不确定项

1. 未用真实浏览器做 Performance 与 Network 面板实测。约束要求不碰 8080 现网容器、不启动额外服务，本轮是静态读码判定；如需实测，应在隔离实例与浏览器里记录上传请求的主线程 JS 时间、Worker 解码时间与网络时间。
2. 浏览器内部行为无法从仓库证实：File 到网络栈的复制次数、TLS 与网络栈线程、原生 WebP 或 JPEG 解码的线程数都由浏览器实现决定，代码不可控。
3. 现网是否在 TLS 反向代理之后未知。仓库没有 TLS 或代理配置，README 直接暴露 8080；若用户实际通过 HTTPS 代理访问，浏览器到代理可能是 HTTP/2，但上传请求仍是一个流，不改变本报告判定。
4. QOI 展示解码的 Worker 回传拷贝与 canvas 绘制耗时未实测。它不影响上传请求判定，但影响「上传后多久看到图」的体感，需要浏览器实测。
5. 未来若实现分片上传或客户端预处理，收益与代价需实测；本报告只判定当前实现，不否定未来压测后立项的可能。
6. HTTP/1.1 的实际连接复用与连接数未实测，属浏览器内部实现；外部文档给出的是通用上限。
7. Worker 不可用的旧环境会回落到主线程执行 QOI 解码，`qoi-worker.service.ts:19-23`；这属于展示阶段风险，与上传无关。
8. 未读到的项：前端没有任何分片上传、图像压缩、哈希、预览生成的实现；后端也没有分片或断点续传接口。
