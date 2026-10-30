# 上传链路的并发模型

> 来源：任务 `10-30-investigate-upload-concurrency` 的只读调查（2026-10-30），
> 证据见该任务 `research/` 三份报告：后端调用链、运行时与前端、复核记录。
> 本文只写实测或读码确认过的机制；标「推断」的地方必须压测后才能当结论用。

---

## 1. Scope / Trigger

- 触发：改上传、转码、worker、限流、部署资源；或排查「上传慢」「像单核」「CPU 上不去」「批量上传慢」。
- 为什么需要：本仓库上传链路的并发边界不在直觉位置 —— 单张图的 QOI 编解码是单线程原生调用，
  前端一次只上传一张，真正的多核并行只来自「多个请求同时到达时各自 fork 一个子进程」。
  按「加机器 / 加线程池」的直觉改，很可能改不到点子上。

---

## 2. Signatures

```text
POST /api/image/upload            # multipart，字段名 file，成功 201
GET  /i/:id.:ext                  # 读路径转码，派生图 miss 时再触发一次转换
```

```ts
// 上传编排 → 转换：每次转换新建一个 wrapper，无池化
ImageManagerService.upload()                          // backend/src/managers/image/image.service.ts:100-170
  → ImageProcessorService.process()                    // backend/src/managers/image/image-processor.service.ts:36-55
  → ImageConverterService.convertImage()               // backend/src/managers/image/image-converter.service.ts:83-108
  → new SharpWrapper(timeLimitMS, memLimit)            // backend/src/managers/image/image-converter.service.ts:84
  → SharpWrapper.start()                               // backend/src/workers/sharp.wrapper.ts:54-65
  → child_process.fork('sharp.worker.js')              // 每次转换一个子进程，结束即 purge
```

```ts
// 子进程环境变量只有三个键；容器级 env 不会透传进来
fork(WORKER_PATH, {
  serialization: 'advanced',
  timeout: instance_timeout,
  env: {
    MEMORY_LIMIT_MB: memory_limit.toString(),
    MAX_IMAGE_PIXELS: ReadMaxImagePixelsFromEnv().toString(),
    NODE_OPTIONS: '--no-warnings',
  },
  stdio: 'overlapped',
});
```

---

## 3. Contracts

### 3.1 进程与线程模型

| 层 | 事实 | 证据 |
|---|---|---|
| 部署 | 单容器 all-in-one，单副本；一条 `docker run`，容器无 CPU/内存配额 | `README.md:6-14`、`docs/MAINTAINING.md:5-13`、`build-and-deploy.md:482` |
| Node 进程 | 单进程、单事件循环；无 cluster、无 pm2、无 worker_threads、无副本 | `backend/src/main.ts:19-59`、`Dockerfile.allinone:75` |
| 请求受理 | 并发：multipart 流式解析在事件循环上交错，无全局上传锁 | `backend/src/routes/image/image-manage.controller.ts:58-90`、`backend/src/main.ts:33` |
| 转码 | 每次转换 fork 一个新子进程，结束或超时即 kill，无常驻池 | `backend/src/workers/sharp.wrapper.ts:54-65`、`:231-235` |
| 子进程内 | 单条 JS 线程，同一时刻只处理一张图 | `backend/src/workers/sharp/sharp.worker.ts:110-129` |
| 跨图片并行 | 只来自多请求并发 → 多子进程；单进程内没有图片级并行 | 同上 |
| 主进程同步段 | SVG 净化、file-type 判定与 `isSvg` 全文扫描、WebP 头解析直接在事件循环上跑 | `backend/src/managers/image/svg-security.service.ts:41-54`、`backend/src/managers/image/image.service.ts:359-401` |
| 主进程 sharp | 像素预检 `sharp().metadata()` 在主进程，受 libuv 线程池约束 | `backend/src/managers/image/image-converter.service.ts:195-197`、`backend/node_modules/sharp/lib/index.d.ts:104-111` |
| libuv 线程池 | 默认 4，仓库与容器均未设置 `UV_THREADPOOL_SIZE` | libuv 文档；`git grep` 0 命中 |
| 转换子进程 env | 显式三键，容器级 `UV_THREADPOOL_SIZE` / `VIPS_CONCURRENCY` 到不了子进程 | `backend/src/workers/sharp.wrapper.ts:57-63` |

### 3.2 单张图到底用几个核

- 默认主格式是 QOI（`backend/src/managers/image/image-processor.service.ts:51`），动图存 WebP（`:61`），SVG 原样存不转码（`:44-49`）。
- QOI 编解码是 `qoi-img` 原生插件同步调用：解码 `qoiSharpIn` → `QOIdecode`
  （`backend/src/workers/sharp/universal-sharp.ts:60-71`），编码 `qoiSharpOut` → `QOIencode`
  （`universal-sharp.ts:159-174`），**不经 libvips 线程池，子进程内单线程**。
- 非 QOI 的解码与转码走 sharp/libvips 线程池，线程数默认约等于 CPU 核数
  （musl 镜像未装 jemalloc，此点为推断，见 `build-and-deploy.md`）。
- 结论：**单张图上传的处理基本是单核的**；用满多核的前提是同一时刻有多个请求各 fork 一个子进程。

### 3.3 前端上传行为

- 上传并发上限固定为 **1**，不可配置：
  - `frontend/src/app/routes/upload/upload.component.html:3` 的 file input 没有 `multiple`；
  - `frontend/src/app/routes/processing/processing.component.ts:35` 只上传 `state.imageFiles[0]`；
  - 批量上传服务 `UploadImages` 整段被注释，且目标是并不存在的 `/api/image/upload/bulk`
    （`frontend/src/app/services/api/image.service.ts:56-69`）；
  - 多选、拖多张、粘贴多张时，其余文件被静默丢弃。
- 因此「批量上传耗时线性叠加」首先由前端串行决定，不是服务端排队。

### 3.4 资源上限与阈值：都是阈值，不是并发度

| 键 | 默认值 | 位置 |
|---|---|---|
| `PICSUR_MAX_FILE_SIZE` | 128000000 字节 | `backend/src/config/early/multipart.config.service.ts:14-19` |
| `PICSUR_MAX_IMAGE_PIXELS` | 268402689 | `shared/src/util/image-pixel-limit.ts:12-16` |
| `PICSUR_MAX_DERIVATIVES_PER_IMAGE` | 100 | `backend/src/config/early/image.config.service.ts:9-12` |
| `conversion_time_limit` | 15s | `backend/src/collections/preference-db/preference-defaults.service.ts:47` |
| `conversion_memory_limit` | 512MB | 同上 `:48` |
| 上传限流 | 每 IP 每 60s 20 次 | `backend/src/routes/image/image-manage.controller.ts:61` |

- 仓库里没有任何 concurrency / worker / queue / threads / cpus 配置键；没有 p-limit、p-queue、bullmq、piscina。
- 图片字节存 Postgres `bytea`（`backend/src/database/entities/images/image-file.entity.ts:41`），
  每上传顺序写 2 次，保留原图 3 次（`backend/src/managers/image/image.service.ts:141-167`）；
  TypeORM 未配置连接池，沿用 pg 默认 10。

### 3.5 已确认的瓶颈清单，按影响排序

1. 每次转换新 fork 一个 Node 子进程，无常驻池：固定包含进程启动、模块加载、libvips 初始化开销；并发 N 张就是 N 个进程互抢 CPU 与内存。
2. 单实例单进程：主进程事件循环上的同步段无法横向分摊。
3. 主进程同步纯 JS CPU 段阻塞事件循环：SVG 净化最典型，期间所有其它请求被卡住。
4. 主进程 sharp metadata 预检受 libuv 默认 4 线程池限制：并发上传大于 4 时预检排队。
5. 整文件读入内存，单文件上限 128MB；IPC 到子进程还会复制一份。
6. 图片字节进 Postgres bytea，请求内串行 2 到 3 次写，pg 默认池 10。
7. 上传后浏览还会再触发一次转码：浏览页带 width 请求主格式派生图，首次必然 miss，
   非 SVG 图生命周期至少两次 fork 级转换（`frontend/src/app/routes/view/view.component.ts:86-101`、
   `backend/src/managers/image/image.service.ts:233-240`、`:279-284`）。
8. 上传限流每 IP 每分钟 20 次，进程内计数，超限直接拒绝不排队。

---

## 4. Validation & Error Matrix

| 条件 | 行为 | 依据 |
|---|---|---|
| 单文件超过 128MB | multipart 限制拒绝 | `multipart.config.service.ts:21-29`，状态码见 `image-api-contracts.md` |
| 超过每 IP 20 次每分钟 | 429 拒绝不排队 | `image-manage.controller.ts:61`、`easy-throttle.decorator.ts:12-21` |
| 转换超过 15s | 子进程超时失败 | `preference-defaults.service.ts:47`、`sharp.wrapper.ts:158-180` |
| 转换内存超过 512MB | 子进程 `setrlimit('data')` 失败 | `backend/src/workers/sharp/sharp.worker.ts:49-56`、`preference-defaults.service.ts:48` |
| 像素超过上限 | 主进程预检直接拒绝，不 fork | `image-converter.service.ts:174-197` |
| 同一图同参数并发读 | `MutexFallBack` 按图片 id 加参数哈希去重，只影响读路径 | `backend/src/util/mutex-fallback.ts:14-52`、`image.service.ts:216-226` |

上传路径不经过任何全局互斥；仓库里唯一的互斥只用于偏好填充与派生图去重。

---

## 5. Good / Base / Bad Cases

- Good：同时上传 4 张非 SVG 图 → 4 个请求并发受理 → 4 个转换子进程，CPU 可以跨核。
- Base：一次上传 1 张大图 → 1 个子进程 → QOI 解码与编码在子进程内单线程，主进程只做 metadata 预检与写库。
- Bad：用当前 Web UI 批量上传 → 一次只发一个请求，多选文件被丢弃，CPU 峰值基本只有一核。

---

## 6. Tests Required

若后续改并发或上传交互，必须补的验证：

- 并发上传 N 张：断言 wall time 随 N 增长小于线性、观察 `docker stats` CPU 可跨核、记录子进程峰值数。
- 批量上传 UI：断言 N 个文件全部产生请求、失败可重试、进度与跳转行为不变。
- 改 worker 机制后：断言转换失败、超时、超内存三条错误路径仍返回可读错误。
- 改 QOI 编码路径后：断言取回像素与原图一致（取回断言像素，不要断言字节）。

---

## 7. Wrong vs Correct

### Wrong：把「上传慢」当成后端单核，直接上多副本或调线程池参数

```text
// 错误做法：在容器上加 UV_THREADPOOL_SIZE / VIPS_CONCURRENCY，期望转换变快
// 事实：fork 的 env 显式只有三个键，容器级变量到不了子进程；
//       而且单张图的大头是 QOI 原生同步编码，加线程也不会并行
```

### Correct：先定位属于哪一层，再动对应位置

```text
// 先分类：
// A. 一次只传一个文件  → 前端问题，改上传交互与批量端点
// B. 单张图慢          → fork 开销 + QOI 编解码单线程 + 主进程同步段
// C. 并发上传也上不去  → 单实例部署、libuv 池 4、pg 池 10、限流 20/分钟
// 再决定：worker 池化 / 批量端点 / 减少二次转换 / 部署扩容，且都要先压测确认收益
```

### Wrong：给 fork 子进程加环境变量时只改容器或 entrypoint

### Correct：改 `sharp.wrapper.ts:57-63` 的显式 env 列表，否则子进程收不到

---

## 8. 后续候选方向：未实施，需先压测

1. 常驻或池化转换 worker 替代每次 fork，降低单张图固定开销。
2. 前端批量上传加回批量端点：先补 `POST /api/image/upload/bulk`，再接 `multiple` 与并发上限，否则只是把 N 次串行请求变成 N 次并发请求。
3. 消除上传后浏览的二次转码：上传时预生成常用宽度派生图，或浏览页直接用主格式不带宽高。
4. 评估 `UV_THREADPOOL_SIZE` 与 libvips 并发度，确认收益后再改。
5. 部署层扩容与限流外置，只对多实例有意义。

> 以上均属新任务范围，需先压测确认收益，不要直接改。
