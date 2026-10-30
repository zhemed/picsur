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
// 上传编排 → 转换：每次转换新建一个 wrapper，由进程级 worker 池出租一个常驻子进程
ImageManagerService.upload()                          // backend/src/managers/image/image.service.ts:100-170
  → ImageProcessorService.process()                    // backend/src/managers/image/image-processor.service.ts:36-55
  → ImageConverterService.convertImage()               // backend/src/managers/image/image-converter.service.ts:83-108
  → new SharpWrapper(timeLimitMS, memLimit)            // backend/src/managers/image/image-converter.service.ts:84
  → SharpWrapper.start()                               // backend/src/workers/sharp.wrapper.ts
  → SharpWorkerPool.acquire(memLimit, timeout)         // backend/src/workers/sharp/worker-pool.ts（2026-10-30 起）
  → 复用空闲 worker 或 fork 新子进程；成功后 release，失败/超时 destroy
```

```ts
// 子进程环境变量只有三个键；容器级 env 不会透传进来
fork(WORKER_PATH, {
  serialization: 'advanced',
  env: {
    MEMORY_LIMIT_MB: memoryLimit.toString(),
    MAX_IMAGE_PIXELS: ReadMaxImagePixelsFromEnv().toString(),
    NODE_OPTIONS: '--no-warnings',
  },
  stdio: 'overlapped',
});
// 注意：worker 池时代的 fork 没有 timeout 选项；按任务计时的 pTimeout 在 wrapper 里
```

---

## 3. Contracts

### 3.1 进程与线程模型

| 层 | 事实 | 证据 |
|---|---|---|
| 部署 | 单容器 all-in-one，单副本；一条 `docker run`，容器无 CPU/内存配额 | `README.md:6-14`、`docs/MAINTAINING.md:5-13`、`build-and-deploy.md:482` |
| Node 进程 | 单进程、单事件循环；无 cluster、无 pm2、无 worker_threads、无副本 | `backend/src/main.ts:19-59`、`Dockerfile.allinone:75` |
| 请求受理 | 并发：multipart 流式解析在事件循环上交错，无全局上传锁 | `backend/src/routes/image/image-manage.controller.ts:58-90`、`backend/src/main.ts:33` |
| 转码 | 常驻 worker 池：每次转换从池里租一个子进程，空闲 60 秒回收；并发上限 min(4, CPU 核数)，超出排队 | `backend/src/workers/sharp/worker-pool.ts`、`backend/src/workers/sharp.wrapper.ts` |
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

1. ~~每次转换新 fork 一个 Node 子进程，无常驻池~~ **已于 2026-10-30 修复**：改为进程级常驻 worker 池，
   见第 9 节。修复前的基线数据保留在任务 `10-30-upload-worker-pool-benchmark` 的 research 里。
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

1. ~~常驻或池化转换 worker 替代每次 fork~~ **已完成 2026-10-30**，见第 9 节。
2. 前端批量上传加回批量端点：先补 `POST /api/image/upload/bulk`，再接 `multiple` 与并发上限，否则只是把 N 次串行请求变成 N 次并发请求。
3. 消除上传后浏览的二次转码：上传时预生成常用宽度派生图，或浏览页直接用主格式不带宽高。
4. 评估 `UV_THREADPOOL_SIZE` 与 libvips 并发度，确认收益后再改。
5. 部署层扩容与限流外置，只对多实例有意义。

> 以上未完成项均属新任务范围，需先压测确认收益，不要直接改。

---

## 9. 常驻 worker 池：2026-10-30 落地

实现：`backend/src/workers/sharp/worker-pool.ts`（新增）加 `backend/src/workers/sharp.wrapper.ts`（改租约模型）。
`sharp.worker.ts` 协议未改，`image-converter.service.ts` 调用方式未改。

### 9.1 机制

- 进程级单例池，按 `MEMORY_LIMIT_MB` 分池（子进程 env 在 fork 时写死，不同上限不能共享）。
- 并发上限 `max(1, min(4, availableParallelism()))`，无环境变量；正在 fork 的 slot 也计入上限。
- 空闲 TTL 60 秒，`timer.unref()`；`process.once('exit')` 全量 kill 子进程。
- 每次转换：`acquire` 租一个 worker → `init`/`operation`/`finish` → 成功 `release`，超时/失败/退出 `destroy` 并补位。
- 等待队列 FIFO，整体受任务超时 `pTimeout` 约束；排队超时的请求不占 worker。
- 子进程的 fork 不再带 `timeout` 选项，任务级计时在 wrapper 的 `pTimeout`。

### 9.2 同口径实测收益：run B 配方，与 fork 基线对比

| 场景 | 基线 | 池化后 | 变化 |
|---|---|---|---|
| 串行 10 张 p50 | 125.4ms | 13.6ms | 降 89.2% |
| 串行 10 张总耗时 | 1341.4ms | 348.9ms | 降 74.0% |
| 并发 4×8 总耗时 / p50 | 404.0 / 159.5ms | 267.5 / 37.4ms | 降 33.8% / 76.6% |
| 并发 8×8 总耗时 / p50 | 340.1 / 267.5ms | 268.5 / 208.4ms | 降 21.0% / 22.1% |
| 并发 8 worker 峰值 | 8 | 4 | 等于池上限 |
| 并发 8 worker RSS 峰值 | 540.4MB | 291.9MB | 降 46.0% |
| 并发 8 平均核数 | 6.79 | 4.08 | 降 40% |

- 26 次上传只 fork 9 个 worker；串行 10 张只 fork 1 次。
- 错误路径不变：超像素 400、损坏图 400 可读、worker 解码失败 400 可读，无 500；失败 worker 会销毁并补位。
- 38 项图像接口回归全绿；TTL 到点回收、实例退出无残留。
- 数据与逐请求证据见 `.trellis/tasks/archive/2026-10/10-30-upload-worker-pool-benchmark/research/`。

### 9.3 前提与残留风险

- **非容器部署**：只注册了 `process.once('exit')` 清理，没有注册 SIGTERM 转发；容器 cgroup 回收能兜住，
  但裸机直跑时需要确认主进程退出路径会杀子进程，或后续补信号处理。
- **内存代价**：4 个空闲 worker 会保留到 TTL 60 秒，实测 4 worker RSS 峰值约 292MB；宿主内存紧时要盯着。
- 排队策略是硬上限，并发 8 时后 4 个请求要等第一波释放；这是有意用吞吐换资源上限，压测显示总耗时仍优于 fork 版。
- 已知可维护性建议，均不阻塞合并：`WorkerSlot.ready` 目前无消费者；wrapper 随机 workerID 与池递增 #N 两套日志标识；排队超时后后台可能多 fork 一个并 park。

---

## 10. 单张图能否走多核：2026-10-30 实测结论

结论：**前端与后端当前都不能让一张图利用多核。** 前端是「没有可并行对象」，后端是「关键阶段串行且受库与格式实现限制」。

### 10.1 前端

- 上传请求本身没有任何客户端图像计算：只有文件选择、`FormData` 组装、一次 axios XHR、进度与跳转；
  全前端没有 `FileReader`、`createImageBitmap`、`OffscreenCanvas`、压缩、哈希或上传前预览。
  证据：`frontend/src/app/routes/processing/processing.component.ts:35`、
  `frontend/src/app/services/api/api.service.ts:141-150` 与 `:255-289`。
- 唯一的前端图像计算是**展示阶段**的 QOI 解码，已经放在 1 个 Web Worker 里，
  见 `frontend/src/app/services/workers/qoi-worker.service.ts:20`；QOI 解码逐像素顺序依赖，单张图拆不到多个核。
- Web Worker 对当前上传链路无收益；HTTP/2 多路复用与多连接都拆不了单个请求；分片上传需要后端新增接口，
  且只减少单请求传输阻塞，不产生 CPU 并行收益。引入客户端图像处理属于重复计算，不值得。

### 10.2 后端单张图耗时构成

24MP JPEG，单请求，隔离容器内实测，worker 内链路 495ms：

| 阶段 | 耗时 | 占 worker 内 | 是否可并行 |
|---|---|---|---|
| 解码到 raw | 197ms | 39.8% | JPEG 解码不可并行；PNG 最多约 2 线程，整链路仅省 4.7% |
| 可选操作 | 上传路径无操作 | 0% | libvips resize 可并行，但上传路径不执行 |
| QOI 编码 | 294ms | 59.4% | 单块实现串行；格式层面可分块并行，见 10.3 |
| 主进程 IPC 往返 | 约 131ms | 端到端约 21% | 串行，加核消不掉 |

- `sharp.concurrency` 从 1 调到 16，解码、编码与完整链路都没有可测改善，CPU 时间对 wall time 比值落在
  1.02 到 1.17；QOI 编解码恒为 1.01。判定：单张图当前是单核处理。
- 换输出格式不解决多核：24MP raw 编码实测 QOI 294ms、JPEG q90 375ms、WebP q80 2918ms，
  三者都不随线程数下降。WebP 在真实照片上会快于合成噪声图，但仍无多核收益。

### 10.3 QOI 分块并行的边界

- 格式层面可行：编码每个像素只依赖上一像素与 64 槽索引表状态；先并行扫描出每块起始的索引表状态，
  再让各块独立编码、拼接，产出的流可被原生解码器正确解码。原型已验证 24MP 的 K=4 与 K=8 拼接后像素完全一致，
  相邻 RUN 可以合并。
- 当前实现不可行：`qoi-img` addon 只提供单块同步 encode 与有状态的顺序流接口，`lib/` 无线程代码；
  纯 JS 分块原型比原生单线程慢约 5 倍。要拿到收益必须新增 native 分块或多线程编码器，并改造 worker 协议。
- 收益上限，按实测占比的 Amdahl 估算：QOI 编码 4 路并行时 worker 内约 1.80 倍、端到端约 1.53 倍；
  16 路端到端上限约 1.77 倍；叠加预扫描与拼接的真实成本，预计 1.3 到 1.5 倍。
  该上限依赖「预扫描也能并行」这一未验证假设，预扫描单线程时收益会掉到约 1.1 倍量级。

### 10.4 决策建议

- 不要通过调 libvips 线程数、加 `UV_THREADPOOL_SIZE` 或换 WebP/JPEG 输出来期待单图加速，实测均无效。
- 单图像提速唯一有量化上限的路径是 native 分块 QOI 编码，代价是新增原生编码器与协议改造；
  在多请求并发场景下收益会被 worker 池上限摊薄，建议先验证预扫描可并行性再决定是否立项。
- 若目标是「单次上传更快」，先看主进程 IPC 往返约 131ms 与读入/类型判定等串行段，
  这部分占比约 21%，属于独立优化课题。
- 数据、脚本与原始输出见任务 `10-30-single-image-multicore-eval` 的 `research/`；
  测量环境为生产镜像 all-in-one，Node 20.20.2、sharp 0.35.5、libvips 8.18.7、qoi-img 2.2.0。
- 口径限制：fixture 是合成噪声图，QOI 输出膨胀到 raw 的 1.31 倍，绝对毫秒不可直接外推到真实照片；
  只用占比与相对结论。真实照片需另测。


