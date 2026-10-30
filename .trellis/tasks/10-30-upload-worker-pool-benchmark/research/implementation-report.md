# 实现报告：常驻转换 worker 池替代每次 fork

> 任务：`.trellis/tasks/10-30-upload-worker-pool-benchmark`；共享任务：task-6
> 角色：Trellis 实现子代理 pool-implementer；本轮未做 `git commit`
> 日期：2026-10-30；池化版构建时间 2026-10-30 12:12Z
> 对照基线：同目录 `benchmark-baseline.md`，fork 版构建 2026-10-30 11:56:13Z，git HEAD `5675514`

## 一、结论

实现已完成，六项正确性验证全部实测通过，无残留。

- 构建：Node 20 容器内 `nest build` 退出码 0，dist 405 个文件；`tsc --noEmit` 与 eslint 均退出 0，无新增违规。
- 复用：3 次连续上传只 fork 一次 worker，cold 170.2ms → warm 19.6ms / 15.8ms，取回像素校验 PASS。
- 并发上限：并发 8 上传 8 张 6MP 图，worker 峰值恰好 4，等于 `min(4, availableParallelism())`；fork 日志恰好 4 条。
- 错误路径：超像素 400、损坏图 400 可读、worker 侧解码失败 400 可读，全程无 500；失败 worker 被销毁并在后续并发中按需补位。
- 空闲 TTL：空闲 65 秒后 worker 3 → 0，无重建。
- 回归：`support/regression-image-api.sh` 对池化实例 38 passed / 0 failed；整套回归只新 fork 1 个 worker。
- 退出清理：实例删除后宿主 `sharp.worker` 进程数 0。

改动文件只有 3 个：新增 `backend/src/workers/sharp/worker-pool.ts`、重写 `backend/src/workers/sharp.wrapper.ts`；`sharp.worker.ts` 与 `image-converter.service.ts` 未改，源文件哈希与基线报告记录完全一致，复用未发现状态残留。

## 二、完成度与改动文件

| 文件 | 状态 | 说明 |
|---|---|---|
| `backend/src/workers/sharp/worker-pool.ts` | 新增，541 行 | 进程级单例池：按 memoryLimit 分池、并发上限、空闲 TTL、FIFO 队列、acquire/release/destroy、ready 握手、崩溃补位、退出清理 |
| `backend/src/workers/sharp.wrapper.ts` | 重写，265 行，diff 120+/91- | 对外 `start` / `operation` / `finish` 与构造函数签名不变，内部改为池租约；删除 fork 的 timeout 选项；任务级监听器只清自己的 |
| `backend/src/workers/sharp/sharp.worker.ts` | 未改 | 协议天然支持复用，无状态残留；sha256 与基线报告一致 |
| `backend/src/managers/image/image-converter.service.ts` | 未改 | `new SharpWrapper(timeLimitMS, memLimit)` 调用方式无需变化；sha256 与基线报告一致 |
| `support/bench-upload.cjs` | 未改 | 仅作为只读压测工具使用，属基线方写入范围 |
| 前端 / DB schema / `Dockerfile*` / docs | 未碰 | 不在白名单，且本任务无需要 |

源文件哈希，最终状态：

| 文件 | sha256 |
|---|---|
| `backend/src/workers/sharp/worker-pool.ts` | `e8505ec0e4e568b13abf4d544c87d9bdf64e8f1b03ee533d3482aac0f1e5cdf9` |
| `backend/src/workers/sharp.wrapper.ts` | `eab002e1bf42d2ffa657d8541d9fe69295d16e7a1b15b086d59016c5d171a306` |
| `backend/src/workers/sharp/sharp.worker.ts` | `f5186b50521cf8331bd67656f3f13ca8db6c95192962dfdf2ee9bd14c4904232`，与基线一致，未改 |
| `backend/src/managers/image/image-converter.service.ts` | `3781661a04c9c1f46462889a3934bcd98df036bef644d9c9146b939c21bfe5ed`，与基线一致，未改 |

`git status` 本任务范围内只有：`M backend/src/workers/sharp.wrapper.ts`、`?? backend/src/workers/sharp/worker-pool.ts`、`?? .trellis/tasks/10-30-upload-worker-pool-benchmark/`（任务目录）。

## 三、实现要点

### 1. `worker-pool.ts`

- 结构：模块级单例 `export const SharpWorkerPool = new SharpWorkerPoolImpl()`，`pools: Map<string, PoolState>`，key 为 `String(memoryLimit)`。子进程的 `MEMORY_LIMIT_MB` 在 fork 时写死，不同内存上限不能共享 worker，因此按 memoryLimit 分池。
- 并发上限：`MAX_CONCURRENT_WORKERS = max(1, min(4, availableParallelism()))`，本机 16 逻辑 CPU 下等于 4；不加环境变量。正在 fork、尚未 ready 的 slot 也计入 `active`，避免请求突发时超出上限。
- 空闲 TTL：60 秒，`setTimeout(...).unref()`，不阻止进程退出；到期 kill 并从 idle 移除。
- `acquire(memoryLimit, timeoutMs)`：
  1. 有空闲 slot 且未退出 → 清除 TTL、移入 active、返回租约；
  2. `active.size < 上限` → fork 新子进程，在 `pTimeout(timeoutMs)` 内等 `ready` 消息，就绪后返回租约；
  3. 已达上限 → 进入 FIFO 等待队列，整体受 `pTimeout(timeoutMs)` 约束，超时返回 `Fail(FT.Internal, 'Timed out waiting for a free conversion worker')`，不会占用 worker。
- `release(lease)`：从 active 移除、放回 idle、重置 TTL，并立即 `drain` 把空闲 slot 交给队首等待者。
- `destroy(lease, reason)`：kill、清监听、从 active 移除；若有等待者则按需补位。
- 崩溃补位：池层常驻 `exit` 监听 → `disposeSlot` → `drain`，队首等待者按上限重新 fork；fork 失败则该等待者拿到 Internal 失败，不会死循环。
- ready 握手：fork 后同一 tick 同步挂 `message` / `exit` / `error` 一次性监听，`ready` 到达后全部摘掉；超时或提前退出则销毁并返回失败。
- 退出清理：`process.once('exit')` 遍历所有池 kill 全部 slot，best effort；**不**注册 SIGTERM/SIGINT，避免干扰既有信号处理。
- 监听器边界：`stdout` / `stderr` 的 `data` 日志、`error`、`exit` 持久监听在 fork 时各挂一次，随 worker 生命周期存在，不随任务重建；`@fastify/busboy` 破坏 `stream` 类型增补的注释按原样保留。
- fork 选项：保留 `serialization: 'advanced'`、`stdio: 'overlapped'` 和三个 env（`MEMORY_LIMIT_MB`、`MAX_IMAGE_PIXELS`、`NODE_OPTIONS`），**删除 `timeout` 选项**（它是按子进程生命周期计时的，长驻 worker 会被 15 秒误杀）。
- 日志分级：fork 用 `log` 级（生产可见，每次 fork 一行，正常情况下极低频，作为「复用而非重建」的运维证据）；复用、归还、TTL 回收、销毁用 `verbose` 级。

### 2. `sharp.wrapper.ts`

- 对外 API：`constructor(instance_timeout, memory_limit)`、`start(image, filetype, sharpOptions?)`、`operation(name, ...params)`、`finish(filetype, options?)` 签名与返回值类型完全不变。
- `start`：`SharpWorkerPool.acquire(memory_limit, instance_timeout)` 拿到租约 → 挂本任务的一次性 `close` 监听 → 发送 `init`；acquire 或 send 失败则销毁租约并返回原失败。
- `finish`：发送 `finish` 后在本任务专属的 `once('message')` 上等 result，整体受 `pTimeout(instance_timeout)` 约束。
  - 成功 → `releaseLease()` 归还池；
  - `result.failure` → `destroyLease()` 销毁，错误映射保持现状：`DecodeWorkerFailure` 转 `FT.UsrValidation`，其它转 `FT.Internal`；
  - `close` / 超时 / 协议错误 → `destroyLease()` 销毁，返回既有 `Fail(FT.Internal, ...)`。
- 监听器：每个任务只 `removeListener` 自己的 `message` / `close`，不调用 `removeAllListeners()`，池层的 `error` / `exit` / stdio 监听不受影响。任务成功归还、失败销毁前都会先摘掉本任务监听，避免在同一个长驻 child 上累积监听器。
- 删除项：`fork` / `path` / `waitReady` / `purge` / fork `timeout` 全部移除；`purge` 语义拆成 `releaseLease`（正常归还）与 `destroyLease`（失败销毁）。`sendToWorker` 增加了 `try/catch`，IPC 通道已关闭时返回可读失败而不是抛出。
- `onTaskClose` 会缓存关闭原因并拒绝挂起的 finish，避免 worker 崩溃时请求只能等超时。

### 3. `sharp.worker.ts` 未改

复用所需前提在现有代码里已经成立：`finish` 进入时先 `this.sharpi = null`，`init` 见 `sharpi !== null` 才报 Already initialized；`fail()` 后 `process.exit(0)`，父进程按失败销毁该 worker；`setrlimit` 只在启动时设一次。实测连续复用与失败重建均未出现状态残留，按 design.md §2.3「不做额外改造」执行。

### 4. `image-converter.service.ts` 未改

每个请求仍然 `new SharpWrapper(timeLimitMS, memLimit)`，池由模块级单例承担，调用点无需改动，行为不变。

### 5. 与 design.md 的逐条对照

| design.md 要求 | 实现情况 |
|---|---|
| 导出 `SharpWorkerPool` 单例与 `WorkerLease` | 是，`acquire` / `release` / `destroy` 公开 |
| `pools: Map<string, PoolState>`，`PoolState = { idle, active, waiters }` | 是，按 memoryLimit 字符串分池 |
| 并发上限 `max(1, min(4, availableParallelism()))` | 是，常量，无环境变量 |
| 空闲 TTL 60s、timer unref | 是 |
| acquire 三态：空闲 / 未达上限 fork / FIFO 队列受 pTimeout | 是 |
| release 回 idle 重置 TTL；destroy kill 并补位 | 是 |
| `process.once('exit')` 清理全部子进程 | 是 |
| 删除 fork `timeout` | 是 |
| 任务级监听只清自己的，不 removeAllListeners | 是 |
| stdout/stderr 日志在 fork 时挂一次 | 是，位于池层 |
| 成功 finish release，超时/失败/close destroy | 是 |
| 错误映射保持现状 | 是，代码逐字保留 |
| `purge()` 拆成销毁与归还 | 是 |
| `sharp.worker.ts` 协议不变 | 是，未改 |
| 不改前端 / DB schema / Dockerfile | 是 |

## 四、构建与验证环境

### 1. 构建与静态检查

```bash
# 构建，仅在 Node 20 容器内，宿主 Node 24 不参与
docker run --rm -v /root/picsur:/repo -w /repo/backend node:20-alpine \
  node /repo/backend/node_modules/@nestjs/cli/bin/nest.js build
# 退出码 0；backend/dist 共 405 个文件；backend/dist/workers/sharp/worker-pool.js 12070 B

# 类型检查，不写 dist
docker run --rm -v /root/picsur:/repo -w /repo/backend node:20-alpine \
  node /repo/backend/node_modules/typescript/bin/tsc --noEmit -p /repo/backend/tsconfig.json
# 退出码 0

# eslint
docker run --rm -v /root/picsur:/repo -w /repo node:20-alpine \
  node node_modules/eslint/bin/eslint.js \
  backend/src/workers/sharp/worker-pool.ts backend/src/workers/sharp.wrapper.ts
# 退出码 0，无输出
```

池化版 dist 快照，供 bench-after 与 check 复跑使用，避免宿主 dist 被后续重建后数字不可比：

- 目录：`/tmp/picsur-pool-dist`，405 个文件，与当时宿主 `backend/dist` 逐文件一致。
- 清单：`/tmp/picsur-pool-dist.sha256`，清单自身 sha256 `200ba3617247db599a3fba1a4f07b4a4d136f68ee37caa986ef10133ff3c2142`。
- 挂载方式同基线：只读挂到容器的 `/picsur/backend/dist`。

### 2. 验证实例配方

| 项 | 值 |
|---|---|
| 容器 | `picsur-bench-pool`，`ghcr.io/zhemed/picsur:allinone`，与基线 run B 同一镜像 |
| 运行时 | 容器内 Node v20.20.2，镜像自带自编译 libvips，支持全部 8 种源格式 |
| 代码 | `/tmp/picsur-pool-dist` 只读挂载到 `/picsur/backend/dist` |
| 网络与端口 | `--network host`，`PICSUR_PORT=18081` |
| 数据库 | dev Postgres 容器 `support-devdb-1`，`127.0.0.1:5432`，临时库 `picsur_pool_img`，用户与口令均为 `picsur` |
| 其他环境变量 | `PICSUR_PRODUCTION=true`、`PICSUR_SYNC_SCHEMA=true`、`PICSUR_STATIC_FRONTEND_ROOT` 取镜像自带路径、临时管理员口令与 JWT secret |
| 启动命令核心 | `docker run -d --name picsur-bench-pool --network host --entrypoint /bin/sh -w /picsur -v /tmp/picsur-pool-dist:/picsur/backend/dist ghcr.io/zhemed/picsur:allinone -c 'exec node backend/dist/main.js'` |

三处与派单文本的偏差，均与基线报告 §2.1 / §10 一致，原因是实测：

1. 运行镜像用生产镜像而不是 `node:20-alpine`：alpine 是 musl，加载不了宿主 `backend/node_modules` 里 glibc 的 sharp / qoi-img 原生模块；构建仍然严格用 `node:20-alpine`。该镜像 Node 版本同为 20.20.2，且带自编译 libvips，回归才能全绿。
2. 端口用 18081：18080 在实现与验证期间被基线实例 `picsur-bench` 占用，不能影响正在采集的基线，故另起端口。
3. 库名用临时库 `picsur_pool_img`：dev 库 `picsur` 已有旧 admin 账号，口令只能首次建号时生效；用一次性库避免重置共享数据。验证结束后已 DROP。

fixture：`/tmp/picsur-fx`，8 种 200×150 源格式加 `big-900mp.png`；并发场景另生成 `/tmp/picsur-fx/base-medium.png`，3000×2000 RGBA，5045503 B，用于让 8 并发请求真正重叠，而不是被小图瞬间串完。

## 五、正确性验证结果

### 1. 连续复用：同一 worker 处理多个任务，第二次无重建

```bash
node support/bench-upload.cjs --base http://127.0.0.1:18081 \
  --token "$TOKEN" --fixtures /tmp/picsur-fx --mode serial --count 3 \
  --container picsur-bench-pool
```

原始输出：

```text
  #01 201 170.2ms id=e3535486-2322-4efa-9a7a-d0972ef8473f
  #02 201 19.6ms id=c58771dd-c49d-4438-aced-877e9b07b2e9
  #03 201 15.8ms id=aa6aed4d-eb4f-4a30-a652-b587ec5331b2

== bench-upload summary ==
mode             serial (concurrency 1), fixture base.png (488 B)
uploads          3 total, 3 ok, 0 failed
wall             255.3ms
latency          min 15.8ms / p50 19.6ms / p90 170.2ms / p95 170.2ms / max 170.2ms / mean 68.5ms
worker peak      1 processes (4 samples @ 50ms)
worker rss peak  79.7MB
main rss peak    152.4MB
container cpu    0.26s over 0.26s = 1.04 cores
pixel verify     PASS 200x150x4 pixels identical to fixture (488 B, image/png)
cleanup          deleted 3 images
```

同时刻容器日志与进程：

```text
[Nest] 1  - 10/30/2026, 12:13:09 PM     LOG [SharpWorkerPool] Forked sharp worker #1 (512MB, max 4 concurrent)

fork 日志条数：1
容器内 sharp.worker 进程数：1
```

判定：3 个任务只 fork 一次，第 2、3 个任务没有新增 fork 日志，说明复用同一个 worker；两次结果都经取回像素校验 PASS。冷启动 170.2ms，热路径 p50 19.6ms，符合「省掉进程启动与模块加载」的预期。

### 2. 并发上限：并发 8 时 worker 峰值 4

```bash
node support/bench-upload.cjs --base http://127.0.0.1:18081 \
  --token "$TOKEN" --fixtures /tmp/picsur-fx --file base-medium.png \
  --mode concurrent --concurrency 8 --count 8 --container picsur-bench-pool
```

原始输出：

```text
  #07 201 1691.4ms id=b4b63457-c01c-45ef-9572-01dff11083fe
  #02 201 2014.8ms id=a2e86887-b203-4081-a011-96739cb579a8
  #04 201 2046.2ms id=c8c8977f-dec8-454a-b82b-975a18c98c36
  #01 201 2080.5ms id=0977dff5-dff3-433e-ad44-e280303b5f70
  #05 201 2132.1ms id=7b31da93-5fba-4720-acc5-4b54d5482364
  #06 201 2249.9ms id=41d3a299-1ec9-4994-b8cf-ab0bcd9d7b4a
  #08 201 2332.4ms id=854e2d20-d9cc-4c2a-85cf-2b05e06f308b
  #03 201 2350.5ms id=86855481-7077-487c-9da2-a2364bfee57f

== bench-upload summary ==
mode             concurrent (concurrency 8), fixture base-medium.png (5045503 B)
uploads          8 total, 8 ok, 0 failed
wall             2413.5ms
latency          min 1691.4ms / p50 2080.5ms / p90 2350.5ms / p95 2350.5ms / max 2350.5ms / mean 2112.2ms
throughput       3.31 uploads/s
peak concurrency 8 in flight
worker peak      4 processes (46 samples @ 50ms)
worker rss peak  720.5MB
main rss peak    458.2MB
container cpu    4.74s over 2.41s = 1.96 cores
pixel verify     PASS 3000x2000x4 pixels identical to fixture (515093 B, image/png)
cleanup          deleted 8 images
```

fork 日志：

```text
Forked sharp worker #1 (512MB, max 4 concurrent)  12:13:09  复用
Forked sharp worker #2 (512MB, max 4 concurrent)  12:14:05
Forked sharp worker #3 (512MB, max 4 concurrent)  12:14:05
Forked sharp worker #4 (512MB, max 4 concurrent)  12:14:05
fork 总数：4；容器内 worker 进程数：4
```

判定：8 个并发请求只产生 4 个 worker，峰值恰好等于池上限 4，未超发；每个 worker 各处理了 1 到 2 个任务。8 个请求全部 201，像素校验 PASS。worker RSS 峰值 720.5MB 是 4 个 worker 的合计峰值，平均约 180MB/worker。

### 3. 错误路径：超像素 400、坏图可读 4xx、无 500

用例与原始响应：

```text
用例 1：900MP 超像素 PNG，只在主进程预检，不 fork
HTTP 400
{"success":false,"statusCode":400,...,"data":{"type":"usrvalidation","message":"Image is too large to process: 30000x30000 (900000000 pixels) exceeds the maximum of 268402689 pixels. Set PICSUR_MAX_IMAGE_PIXELS to raise the limit (0 disables it)."}}

用例 2：只有 PNG 签名加随机字节的损坏文件
HTTP 400
{"success":false,"statusCode":400,...,"data":{"type":"usrvalidation","message":"Unsupported or unrecognized image format"}}

用例 3：头部合法 200x150、IDAT 被破坏的 PNG，主进程 metadata 可读但 worker 解码失败
HTTP 400
{"success":false,"statusCode":400,...,"data":{"type":"usrvalidation","message":"Failed to decode the image: it appears to be corrupt or unsupported (vipspng: libpng read error)"}}
```

用例 3 是专门构造的 worker 侧失败路径，用于验证 design.md 里「worker 报告 failure → 销毁该 worker → 返回可读 4xx」：

```text
失败前容器内 sharp.worker 进程数：2
失败后容器内 sharp.worker 进程数：1   即该 worker 已被销毁
容器日志：MainExceptionFilter ... UsrvalidationFailure: Failed to decode the image: it appears to be corrupt or unsupported (vipspng: libpng read error)
InternalFailure 计数：0
```

销毁后按需补位：紧接着发 4 个并发上传，全部 201 且像素校验 PASS：

```text
forks before: 4   workers before: 1
uploads 4 total, 4 ok, 0 failed
worker peak 3 processes
pixel verify PASS
forks after: 6   新 fork #5、#6，按需补位成立
```

整体日志中 `InternalFailure` 计数为 0，即本轮所有错误路径都没有 500。

### 4. 空闲 TTL：60 秒空闲后回收

```text
12:15:32  workers now: 3
12:16:37  workers after 65s idle: 0
12:16:37  forks: 6  回收期间没有新 fork
```

另在 12:15:06 前后还观察到 4 → 2 的自然回收，与 60 秒 TTL 的时间线吻合。回收后再次上传会重新 fork，说明 TTL 回收是「闲置回收 + 按需补位」，不是常驻固定进程。

### 5. 回归：`support/regression-image-api.sh` 38 项全绿

```bash
PICSUR_PSQL="docker exec support-devdb-1 psql -U picsur -d picsur_pool_img" \
  bash support/regression-image-api.sh http://localhost:18081 poolbench123 /tmp/picsur-fx
# 退出码 0
# RESULT: 38 passed, 0 failed
# 原始日志：/tmp/regression-pool.log
```

关键项原文：

```text
[PASS] GET /api/info is 200 with production (200 True)
[PASS] GET /i/<id>.png -> 200 image/png (200 image/png)
[PASS] GET /i/<id>.qoi / .webp / .avif / .jxl / .jp2 / .heif -> 200
[PASS] GET /some/spa/route -> 200 text/html (200 text/html)
[PASS] oversized upload -> 400 (400)
[PASS] message names actual size + limit
[PASS] service still alive after rejection (200)
[PASS] source .png / .jpg / .webp / .avif / .jxl / .jp2 / .heif / .qoi -> upload 201 + fetch 200
[PASS] row with width/height=NULL,NULL -> /api/image/list 201 ...
[PASS] row with width/height=0,0 -> /api/image/list 201 ...
[PASS] legacy row -> /i/meta 200 (200)
[PASS] legacy row -> /api/image/list/all 201 (201)

RESULT: 38 passed, 0 failed
```

整套回归前 fork 总数 6，结束后 7，即约 30 次转换只新 fork 了 1 个 worker，其余全部复用。

### 6. 退出清理：实例停止后无残留 sharp.worker

```text
停止前：容器内 sharp.worker 1 个；宿主 sharp.worker 3 个，其中 2 个属于同时运行的基线容器 picsur-bench
docker stop picsur-bench-pool  ->  exited
停止后：宿主 sharp.worker 2 个，均属于仍存活的基线容器
docker rm picsur-bench-pool    ->  0 个同名容器
最终：ps -eo pid,args | grep '[s]harp.worker' | wc -l  ->  0
```

说明两点：

1. 最终宿主 `sharp.worker` 进程数 0。基线容器同时在 12:17 前后被其主人删除，之后复核确实为 0，没有本实例的孤儿进程。
2. `docker stop` 耗时 10.07 秒：本次手工用 `--entrypoint /bin/sh -c 'exec node backend/dist/main.js'` 启动，node 是容器 PID 1，内核默认忽略 PID 1 的 SIGTERM，所以 docker 走满 10 秒宽限期后 SIGKILL。这是手工运行方式的既有特性，正式镜像是 tini + 入口脚本转发信号，不是本次改动引入；容器停止时 cgroup 整体回收，仍无残留。`process.once('exit')` 覆盖的是正常退出路径。

## 六、未完成项与风险

| 项 | 状态 | 说明与建议 |
|---|---|---|
| 转换超时大于 15 秒的 E2E | 未覆盖 | 现有 fixture 太小，且 `conversion_time_limit` 属不可在线修改的固定偏好；不改偏好、不造超大图无法稳定触发。代码路径保留：任务级 `pTimeout` 超时 → `destroyLease` 销毁 → `Fail(FT.Internal, ...)`，与改造前 fork 版「超时杀进程 + Internal 失败」语义一致。check 可用临时库直接改偏好值或构造单测覆盖 |
| 排队超时 E2E | 未单独构造 | 需要 8 个以上长任务把队列压满超过 15 秒；实现里已按 design.md 返回 Internal 失败且不占 worker。本次并发 8 的 6MP 图在 2.4 秒内完成，没触发排队超时 |
| 内存代价 | 已观测，未长稳 | 并发 8 时 4 个 worker 合计 RSS 峰值 720.5MB；空闲 worker 最多保留到 TTL 60 秒。未做 12 小时长稳或内存缓慢增长观测，建议 bench-after 记录 RSS 序列 |
| worker 内模块级状态 | 已验证短期无残留 | 连续复用、失败重建、TTL 回收后重建均正常；未覆盖 sharp / qoi-img 模块级缓存的长时间增长 |
| 生产日志新增 fork 行 | 已按需分级 | fork 用 `log` 级，只有 fork 时一行，频次极低；复用、归还、TTL 回收、销毁为 `verbose`，生产模式不可见。若运维希望完全静默，可把 fork 行降回 `verbose` |
| 验证脚本 | 复用现有脚本 | 派单建议写最小验证脚本；因写入白名单不含 `support/`，改用基线方 `support/bench-upload.cjs` 只读运行，配合容器日志与 `ps` 计数取证，未改该脚本 |
| 运行时敏感性 | 与基线同配方 | 所有数字都来自生产镜像 run B 配方；未做宿主预编译 sharp 运行时的交叉验证，bench-after 应用同一配方才可比 |

## 七、给 check 方的复核点

1. 构建与静态检查：复跑第四节命令，确认 exit 0；`diff -rq backend/dist /tmp/picsur-pool-dist` 应无输出，`sha256sum /tmp/picsur-pool-dist.sha256` 应为 `200ba361...c2142`。
2. 关键实现点逐条核对 `worker-pool.ts`：删 fork `timeout`；`MAX_CONCURRENT_WORKERS` 无环境变量；TTL timer `unref()`；`process.once('exit')`；FIFO `waiters` 整体受 `pTimeout`；fork 失败的补位路径不会无限重试；`stdout` / `stderr` 只在 `forkSlot` 挂一次。
3. 关键实现点逐条核对 `sharp.wrapper.ts`：`start` / `operation` / `finish` 签名不变；成功 `releaseLease`、失败 `destroyLease`；任务结束只 `removeListener` 自己的 `message` / `close`，无 `removeAllListeners`；错误映射代码与改造前逐字一致；`onTaskClose` 会拒绝挂起的 finish。
4. 复核未改文件：`sha256sum backend/src/workers/sharp/sharp.worker.ts backend/src/managers/image/image-converter.service.ts` 应分别为 `f5186b50...` 与 `3781661a...`，与基线报告第一节记录的 fork 版哈希一致。
5. 复核范围：`git status` 在 backend/src 下只应有 `M backend/src/workers/sharp.wrapper.ts` 与 `?? backend/src/workers/sharp/worker-pool.ts`；无前端、DB schema、`Dockerfile*`、`support/bench-upload.cjs` 改动。
6. 复跑正确性，命令序列可直接复用：

```bash
# 步骤 1：构建并冻结快照
docker run --rm -v /root/picsur:/repo -w /repo/backend node:20-alpine \
  node /repo/backend/node_modules/@nestjs/cli/bin/nest.js build
rm -rf /tmp/picsur-pool-dist && cp -a /root/picsur/backend/dist /tmp/picsur-pool-dist

# 步骤 2：起实例，临时库自行创建，结束 DROP
docker exec support-devdb-1 psql -U picsur -d picsur -c "CREATE DATABASE picsur_check"
docker run -d --name picsur-bench-pool --network host --entrypoint /bin/sh -w /picsur \
  -e PICSUR_DB_HOST=127.0.0.1 -e PICSUR_DB_PORT=5432 \
  -e PICSUR_DB_USERNAME=picsur -e PICSUR_DB_PASSWORD=picsur \
  -e PICSUR_DB_DATABASE=picsur_check -e PICSUR_PRODUCTION=true \
  -e PICSUR_SYNC_SCHEMA=true -e PICSUR_PORT=18081 \
  -e PICSUR_ADMIN_PASSWORD=<临时值> -e PICSUR_JWT_SECRET=<临时值> \
  -v /tmp/picsur-pool-dist:/picsur/backend/dist \
  ghcr.io/zhemed/picsur:allinone -c 'exec node backend/dist/main.js'

# 步骤 3：登录拿 token 后按第五节命令复跑，日志与进程计数用
docker logs picsur-bench-pool 2>&1 | grep -c "Forked sharp worker"
docker exec picsur-bench-pool ps -ef | grep "[s]harp.worker" | wc -l

# 步骤 4：回归必须显式指向临时库，避免脚本回退到 8080 现网容器
PICSUR_PSQL="docker exec support-devdb-1 psql -U picsur -d picsur_check" \
  bash support/regression-image-api.sh http://localhost:18081 <临时口令> /tmp/picsur-fx

# 步骤 5：收尾
docker rm -f picsur-bench-pool
docker exec support-devdb-1 psql -U picsur -d picsur -c "DROP DATABASE IF EXISTS picsur_check"
```

7. 与基线口径一致性：复核用的运行时镜像、dist 挂载方式、`PICSUR_PRODUCTION=true`、fixture 与等待时间都应与 `benchmark-baseline.md` 第 2 节 run B 一致；唯一允许的差异是端口，基线占 18080，池化验证用 18081。
8. 现网与共享数据：全程未碰 8080 现网容器与数据，未 restart 任何非本任务容器；dev Postgres 临时库已 DROP，基线方临时库由其自行清理。
