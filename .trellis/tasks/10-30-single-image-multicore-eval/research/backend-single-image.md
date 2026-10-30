# Research: 后端单张图片转换能否走多核

- Query: 用户问「单张照片不管是前端还是后端能不能走多核」
- Scope: internal，后端链路读码 + 隔离容器实测；前端部分见同任务 `research/frontend-single-image.md`，本文不覆盖
- Date: 2026-10-30
- Task: task-8，目录 `.trellis/tasks/10-30-single-image-multicore-eval`
- 相关规范: `.trellis/spec/picsur-backend/backend/upload-concurrency.md`、`image-api-contracts.md`、`build-and-deploy.md`
- 只读声明: 未改任何源码与配置；测量只在 `docker run --rm` 的一次性容器内进行，未碰 8080 现网 picsur 容器、未用生产库；唯一写入是本文件与 `/tmp/single-image-bench` 下的测量脚本与 fixture

## 一、结论

单张图在后端当前实现里不能走多核：一次上传请求的转换会在一个 worker 子进程内串行完成「解码到 raw」与「QOI 编码」两段，实测把 `sharp.concurrency()` 从 1 调到 16，完整链路 wall time 没有任何改善，进程 CPU 时间与 wall time 的比值约 1.0 到 1.12，其中 JPEG 链路 1.0 到 1.08，即基本只用到一个核。

- 量化构成，24MP JPEG 在 worker 内共 495ms：解码 197ms 占 39.8%，QOI 编码 291ms 占 58.9%，其它约 6.5ms。QOI 编码是单线程原生同步调用，解码在 JPEG 上也不随线程数加速。
- 理论上限受 Amdahl 约束：只有 QOI 编码具备可并行改造空间，4 路并行时 worker 内链路最快约 1.8 倍；把主进程 IPC 的约 131ms 串行成本算进去，端到端约 1.5 倍，16 路理论上限约 1.8 倍。
- QOI 格式层面：单块编码是逐像素状态机，不可原地并行；但按像素区间分块、先算出每块起始索引表状态再拼接，是可行的，本次已用原型验证拼接后可被原生解码器正确解码。代价是需要新增 native 多线程编码器，当前 `qoi-img` addon 只有单块同步 encode 与顺序流式接口。
- 换输出格式不解决多核问题：同一张 24MP raw 上 WebP 质量 80 编码需 2.9 秒、JPEG 质量 90 需 375ms，都比 QOI 的 291ms 慢，且本 build 里这两种编码同样不随线程加速。
- 前端部分：由同任务另一份报告给出「不能走多核，且当前没有可并行的客户端图像计算」；本文的后端结论与它不冲突。

## 二、单张图转换链路与阶段边界

### 2.1 链路逐段与行号

一次非 SVG、非动图的静图上传，后端实际执行顺序如下。

1. 上传入口读 multipart 并整块缓冲：`backend/src/routes/image/image-manage.controller.ts:58-90`，`toBuffer` 在 `:71`。
2. 上传编排：`backend/src/managers/image/image.service.ts:100-170`；类型判定在 `:106` 调 `getFileTypeFromBuffer`，实现见 `:359-401`；转码在 `:128-132`。
3. 主格式选择：`backend/src/managers/image/image-processor.service.ts:36-55`；SVG 原样返回在 `:44-49`，静态图目标格式选 QOI 在 `:51-54`，动图目标 WebP 在 `:57-68`。
4. 转换参数与像素预检：`backend/src/managers/image/image-converter.service.ts:67-164`；偏好读取 `:73-76`，新建 wrapper `:84`，主进程像素预检 `:96-101` 与 `:195-197`，启动转换 `:103-108`，等待结果 `:153-154`。
5. worker 租约：`backend/src/workers/sharp.wrapper.ts:56-95` 只 `acquire` 一个 worker，`:65`；结束时成功 `releaseLease` 见 `:226`，失败或超时 `destroyLease` 见 `:237`。
6. 池上限：`backend/src/workers/sharp/worker-pool.ts:24-28` 为 `max(1, min(4, availableParallelism()))`，空闲 TTL 见 `:30`，`acquire` 见 `:108`，fork 见 `:364-374`。
7. 子进程协议：`backend/src/workers/sharp/sharp.worker.ts:65-75` 分发 init、operation、finish；内存限制 `:49-56`；`init` 解码建 sharp 实例 `:77-94`，其中 `:85-89` 调 `UniversalSharpIn`；`finish` 编码回传 `:110-138`，其中 `:122` 调 `UniversalSharpOut`。
8. 编解码适配：`backend/src/workers/sharp/universal-sharp.ts:16-31` 的 `UniversalSharpIn`，`24-30` 按格式分派；QOI 解码入口 `60-71`，其中 `:61` 调 `QOIdecode`；`73-140` 的 `UniversalSharpOut`，QOI 分支在 `119-121`；QOI 编码实现 `159-174`，其中 `:160` 取 raw，`:164` 调 `QOIencode`；单通道扩展 `176-190`。

### 2.2 默认主格式 QOI 的编解码实现

- 包与版本：`backend/package.json` 依赖 `qoi-img ^2.2.0`，装载到 2.2.0；`sharp ^0.35.5`，镜像内实测 0.35.5，libvips 8.18.7。
- JS 入口：`backend/node_modules/qoi-img/dist/index.js:24` 通过 `bindings` 加载原生 addon；`QOIencode` 在 `:26-28`，`QOIdecode` 在 `:29-34`，`IsQOI` 在 `:35-39`，流式类 `QOIEncoder` 在 `:89-121`。
- 原生实现：`backend/node_modules/qoi-img/lib/qoi.cpp:30` 是 `Encode`，`:73` 调 `qoixx::qoi::encode<std::vector<std::byte>>` 一次性完成整图编码，`:85` 再把结果复制成 Node Buffer；`Decode` 在 `:98`。整个 `lib/` 目录检索 `thread`、`pthread`、`std::thread`、`openmp` 均为 0 命中，addon 没有任何多线程入口。
- 编码算法：`backend/node_modules/qoi-img/lib/qoixx.hpp:326-401` 的 `encode_body` 是单线程逐像素循环 `385-390`，状态包括 64 槽索引表 `index[index_size]`、上一像素 `px_prev`、`prev_hash` 与 `run`；`index_size = 64` 在 `:225`，opcode 枚举在 `:217-224`，哈希在 `:253` 与 `:271`。编码分派 `:1018-1024` 与 `:1263-1332`，SIMD 版本只在编译期宏下启用，`binding.gyp` 未开 `-mavx2` 一类开关，据此推断 x86-64 默认走标量 `encode_impl`。
- 流式接口同样是顺序状态机：`backend/node_modules/qoi-img/lib/qoi-stream.h:106-121` 的 `qois_enc_state` 携带 `last_pixel`、`cache[64]`、`run_length`，只能按输入顺序推进，不能把同一张图拆成互不相关的并行流。

## 三、测量环境与方法

### 3.1 环境

| 项 | 值 | 来源 |
|---|---|---|
| 运行时镜像 | `ghcr.io/zhemed/picsur:allinone`，本机 ImageID 前缀 `3c6bcf7f` | `docker images` |
| Node | v20.20.2 | 容器内 `node -v` |
| sharp | 0.35.5 | 容器内 `sharp.versions` |
| libvips | 8.18.7 | 容器内 `sharp.versions` |
| qoi-img | 2.2.0 | 容器内 `require('qoi-img/package.json')` |
| `sharp.concurrency()` 默认 | 16 | 容器内实测 |
| 宿主 CPU | 16 逻辑核，i7-12700 | `nproc`、`os.cpus()` |
| 容器 CPU 配额 | 无限制 | 容器内 `/sys/fs/cgroup/cpu.max` 为 `max 100000`，cpuset `0-15` |
| 容器内存配额 | 无限制 | 容器内 `memory.max` 为 `max` |

镜像内 `/picsur/backend/node_modules` 自带 sharp 与 qoi-img，且 libvips 是镜像自编译版本，与生产一致；不需要挂载仓库 node_modules，避免宿主 glibc 与镜像 musl 混用。所有测量都是 `docker run --rm` 一次性容器，未使用 8080 容器与其数据卷。

### 3.2 fixture

在容器内用 sharp 生成确定性合成图，写入挂载的 `/tmp/single-image-bench/fixtures`：

| fixture | 尺寸 | 字节数 | 用途 |
|---|---|---|---|
| `12mp.jpg` | 4000x3000 | 9,894,992 | 中等负载对照 |
| `24mp.jpg` | 6000x4000 | 19,776,640 | 主力测量 |
| `12mp.png` | 4000x3000 | 36,066,826 | 对照 |
| `24mp.png` | 6000x4000 | 72,131,563 | 对照 |
| `12mp.qoi` | 4000x3000 | 47,976,454 | QOI 解码测量 |

合成方式是渐变加伪随机噪声，属于压缩最坏情况，QOI 输出会膨胀到 raw 的 1.31 倍左右；真实照片通常比它更容易压缩，但编码耗时基本按像素线性增长，因此本文用占比判断，不用绝对毫秒外推。

### 3.3 测量方法与脚本

脚本最初写在 `/tmp/single-image-bench/`，容器内以 `/bench` 挂载，用 `node --expose-gc` 运行，每个阶段先 warm-up 再测 3 到 5 次取中位数，迭代之间强制 GC，解码前显式 `sharp.cache(false)` 关闭缓存；缓存开关对照实测无差异，见 4.1。以上脚本与测量输出已按 Lead 要求留档到 `.trellis/tasks/10-30-single-image-multicore-eval/research/raw/`，含七个脚本、`results.json`、`results2.json`、`README.md` 与 `run-log.md`。复现时把 raw 目录只读挂载，并把脚本拷到可写工作目录运行，避免脚本写死的 `/bench/...` 输出路径污染仓库：

```bash
R=/root/picsur/.trellis/tasks/10-30-single-image-multicore-eval/research/raw
mkdir -p /tmp/bench-out
docker run --rm -v "$R":/bench/raw:ro -v /tmp/bench-out:/bench \
  --entrypoint sh ghcr.io/zhemed/picsur:allinone \
  -c 'cp /bench/raw/*.mjs /bench/ && cd /picsur/backend &&
      node --expose-gc /bench/gen-fixtures.mjs /bench/fixtures &&
      node --expose-gc /bench/bench2.mjs'
```

各脚本的容器内命令：`gen-fixtures.mjs` 用 `node --expose-gc /bench/gen-fixtures.mjs /bench/fixtures`；`bench.mjs` 用 `node --expose-gc /bench/bench.mjs /bench/fixtures /bench/results.json`；`bench2.mjs`、`bench3.mjs`、`qoi_chunked.mjs` 用 `node --expose-gc /bench/<脚本名>`；`ipc-parent.mjs` 用 `node /bench/ipc-parent.mjs`，与同目录 `ipc-child.mjs` 配套。

| 脚本 | 作用 |
|---|---|
| `gen-fixtures.mjs` | 生成 12MP 与 24MP 的 JPEG、PNG、QOI fixture |
| `bench.mjs` | 解码 sweep、QOI 编解码、完整链路、libvips 编码对照 |
| `bench2.mjs` | 类型判定、metadata、Buffer 拷贝、解码细扫、完整链路、resize 缩放 |
| `bench3.mjs` | QOI 编解码在 `sharp.concurrency` 1 与 16 下的对照 |
| `ipc-parent.mjs` + `ipc-child.mjs` | fork 子进程 IPC 往返成本 |
| `qoi_chunked.mjs` | QOI 分块并行编码原型与正确性验证 |

原始运行时脚本位于临时目录 `/tmp/single-image-bench`，长期复现以本轮留档的 `research/raw/` 为准。

### 3.4 方法边界

- 测量进程本身是普通 Node 进程，不是 Nest 的 worker 子进程；两者用同一套 sharp、libvips、qoi-img 与同版本 Node，差异只有 worker 的 512MB `setrlimit` 与 IPC 隔离，对 CPU 时间测量无影响，但未在真实 worker 内复测，列入不确定项。
- 不含 multipart 流式解析、数据库写入与队列等待；这些阶段在主进程，与「单图能否多核」无关，只作为链路背景列出。主进程相关的小项单独测了类型判定、metadata 与 Buffer 拷贝作为量级参考。
- 所有 wall time 都是单请求独占容器、无其它负载时测得；没有跑多请求并发压测，那属于上一轮 worker 池任务的范围。

## 四、实测数据

### 4.1 阶段耗时构成

24MP JPEG 6000x4000，单请求、无并发、`sharp.concurrency`=1。

| 阶段 | wall ms | CPU ms | CPU/wall | 占 worker 内链路 |
|---|---|---|---|---|
| multipart 读入缓冲，按 19.8MB Buffer 拷贝代理测量 | 6.91 | 7.95 | 1.15 | 主进程，不计入 worker 链路 |
| 类型判定 `fileTypeFromBuffer` | 0.10 | 0.11 | 1.12 | 主进程，可忽略 |
| 像素预检 `sharp().metadata()` | 0.37 到 0.39 | 1.26 到 1.29 | 约 3.3 | 主进程，可忽略 |
| 解码到 raw | 197.19 | 200.87 | 1.02 | 39.8% |
| 可选操作 | 上传路径无操作，options 为空 | — | — | 0% |
| QOI 编码 | 291.37 | 293.71 | 1.01 | 58.9% |
| worker 内完整链路 | 495.03 | 505.19 | 1.02 | 100% |

本表统一取 `sharp.concurrency`=1；其它约 6.5ms 是链路实测减解码与编码的余量，占 1.3%。作为对照，c=16 时解码 200.69ms、链路 503.76ms，CPU/wall 分别为 1.17 与 1.08，结论不变，见 4.2 与 4.4。

对照尺寸，worker 内完整链路：

| 输入 | 解码 ms | QOI 编码 ms | 链路 ms | 编码占比 |
|---|---|---|---|---|
| 24MP JPEG | 197.19 | 291.37 | 495.03 | 58.9% |
| 24MP PNG | 64.27 | 291.37 | 357.92 | 81.4% |
| 12MP JPEG | 101.41 | 151.20 | 251.05 | 60.2% |

编码列的 24MP 值取 `sharp.concurrency`=1 的 291.37ms，12MP 值取补测的 c=1 中位数 151.20ms；链路列是同一口径的实测值，与两段之和存在 1 到 6ms 级余量，属 raw 搬运与计时噪声。

缓存对照：同一张 24MP JPEG 解码，`sharp.cache(true)` 202.63ms 与 `sharp.cache(false)` 202.78ms 无差异，说明反复解码没有命中缓存，上述解码数字是真实解码成本。

### 4.2 解码线程实测

同一张 24MP 图，`sharp.cache(false)`，改变 `sharp.concurrency`：

| 配置 | 24MP JPEG wall ms | CPU/wall | 24MP PNG wall ms | CPU/wall |
|---|---|---|---|---|
| c=1 | 197.19 | 1.02 | 64.27 | 1.03 |
| c=2 | 186.80 | 1.14 | 47.35 | 1.53 |
| c=4 | 188.20 | 1.15 | 51.77 | 1.50 |
| c=8 | 194.23 | 1.14 | 56.63 | 1.47 |
| c=16 | 200.69 | 1.17 | 64.07 | 1.55 |
| 默认值 16 | 198.56 | 1.19 | 未单测，等同 c=16 | — |

判定：JPEG 解码 wall time 在 186.8 到 200.7ms 之间小幅波动，基本持平，没有有效加速，c=2 与 c=4 只比 c=1 低约 5%，c=16 回升，CPU/wall 只到 1.17，说明 libvips 内部虽然起了少量线程但没有产生有效加速；PNG 解码在 c=2 最好，约省 26%，c=4 之后反而回升，属于弱并行且最优只有 2 线程。整链路上 PNG 解码只占 18%，把这 17ms 收益摊回链路是 4.7%。

### 4.3 QOI 编码与解码线程实测

QOI 走 `qoi-img` 原生同步调用，不经 libvips，改 `sharp.concurrency` 理论上无影响，实测确认：

| 操作 | c=1 wall ms | c=16 wall ms | CPU/wall |
|---|---|---|---|
| QOI 编码 24MP JPEG 解码出来的 raw | 291.37 | 294.10 | 1.01 |
| QOI 编码 24MP PNG 解码出来的 raw | 291.79 | 295.39 | 1.01 |
| QOI 解码 12MP | 52.88 | 52.50 | 1.02 |

判定：QOI 编解码在进程内是严格的单线程工作，CPU/wall 恒为 1.01 到 1.02，没有可利用的线程并行度。

### 4.4 完整链路线程对照

| 输入 | concurrency=1 wall ms | concurrency=16 wall ms | 差异 |
|---|---|---|---|
| 24MP JPEG | 495.03 | 503.76 | 慢 1.8% |
| 24MP PNG | 357.92 | 356.40 | 快 0.4%，在噪声内 |
| 12MP JPEG | 251.05 | 254.86 | 慢 1.5% |

判定：上传链路的完整转换对 `sharp.concurrency` 不敏感。瓶颈阶段 QOI 编码根本不经过 libvips，可调的线程数对它无效；JPEG 解码本身又不随线程数提速。因此「调大 libvips 线程数提升单图上传」在本实现里不成立。

### 4.5 libvips 参考操作线程实测

为了区分「libvips 不能多线程」与「上传路径的操作不可并行」，对不属于上传路径的操作做对照：

| 操作 | c=1 | c=2 | c=4 | c=8 | c=16 |
|---|---|---|---|---|---|
| 24MP raw 缩放到 1600 宽，wall ms | 28.61 | 16.31 | 15.48 | 18.78 | 22.75 |
| 同上，CPU/wall | 1.07 | 2.01 | 3.01 | 4.28 | 5.96 |
| 24MP raw WebP q80 编码，wall ms | 2918.16 | — | 2943.93 | — | 2919.38 |
| 24MP raw JPEG q90 编码，wall ms | 375.43 | — | 374.85 | — | 381.34 |
| JPEG 24MP 解码加缩放 1600 加 WebP，wall ms | 336.66 | — | 337.63 | — | 348.93 |

结论：libvips 的缩放操作确实能并行，c=4 时 28.61ms 降到 15.48ms，约 1.85 倍，CPU/wall 到 3.0；但上传链路上既没有缩放操作，主体又是不经 libvips 的 QOI 编码，所以这些并行度用不上。WebP 与 JPEG 编码在本 build 里 wall time 同样不随线程数下降，换格式也不能顺带获得多核。

### 4.6 主进程 IPC 成本

生产链路里主进程要把 19.8MB 原图发给 worker，再把 94.1MB 的 QOI 结果收回来，`serialization: 'advanced'` 见 `worker-pool.ts:364-374`。用 fork 子进程做纯 IPC 往返测量，子进程不做计算：

| 项 | 第 1 次 | 第 2 次 | 第 3 次 |
|---|---|---|---|
| 往返 wall ms | 151.8 | 131.0 | 132.3 |
| 父进程 CPU ms | 110.3 | 95.9 | 100.6 |
| 子进程侧处理耗时 ms | 2.1 | 0.3 | 0.3 |
| 发送字节 | 19,776,640 | 同 | 同 |
| 接收字节 | 94,111,421 | 同 | 同 |

判定：约 131ms 的往返 wall 与约 100ms 的父进程 CPU 是每张 24MP 图都要付的串行成本，且这部分发生在主进程单线程上，加 worker 也无法并行。它占端到端约 634ms 中的 20.7%。

### 4.7 QOI 分块并行原型实测

目的：验证 QOI 格式能否按像素区间分块、各块独立编码后直接拼接，以及分块的前置成本。原型 `qoi_chunked.mjs` 用 JS 手写 QOI 编码器，算法与 `qoixx.hpp:326-401` 对齐，先验证与原生编码字节一致，再验证分块拼接的可解码性。

正确性验证：

| 用例 | 结论 |
|---|---|
| 301x200 渐变图，JS 单块编码与原生 `QOIencode` 对比 | 字节完全一致，60,818 字节，原生解码回像素一致 |
| 同上，分块 K=2、K=3、K=4、K=7 | 拼接后原生解码像素全部一致，且四种分块字节都与原生完全一致，均为 60,818 字节 |
| 301x200 专门构造的跨块长 run 图，run 长度 37 像素跨块 | K=2 到 K=7 像素全部一致；K=2 与 K=4 字节与原生一致，K=3 多 2 字节、K=7 多 6 字节，属于边界处等价编码 |
| 24MP JPEG 解码 raw，分块 K=4、K=8 | 拼接结果用原生 `QOIdecode` 解码，像素全部等于原始 raw |

分块成本与并行效果，24MP JPEG 解码 raw，72MB 原始像素：

| 方案 | 阶段耗时 | 总耗时 | 输出字节 | 与原生对比 |
|---|---|---|---|---|
| 原生 `QOIencode` 单块 | 297.02ms | 297.02ms | 94,111,421 | 基准 |
| JS 单块编码 | — | 2739.9ms | 94,111,421 | 慢 9.2 倍，字节一致 |
| JS 分块 K=4，单线程 | 预扫描 178.7 + 合并 0.05 + 编码 2699.3 | 2878.0ms | 94,111,421 | 像素一致 |
| JS 分块 K=8，单线程 | 预扫描 168.0 + 合并 0.05 + 编码 2410.0 | 2578.0ms | 94,111,421 | 像素一致 |
| JS 分块 K=4，4 个 worker_threads | 预扫描 176.7 + 合并 0.12 + 共享内存拷贝 21.6 + 4 线程编码 1356.0 | 1554.4ms | 94,111,421 | 像素一致 |

判定：格式层面可行，且原型证明拼接产物能被原生解码器正确解码；但 JS 实现比原生慢一个数量级，4 线程并行后仍比原生单线程慢 5.2 倍。因此分块并行只有在 native 层重写编码器才有意义；当前 addon 的批量接口只有单块同步 `encode`，另有顺序流式接口，没有分块或多线程接口，`backend/node_modules/qoi-img/lib/qoi.cpp:30-85` 与 `qoi-stream.h:106-121` 都是单状态机。

## 五、判定：单张图能否走多核

### 5.1 解码阶段

- 现状：JPEG 解码实测没有有效加速，wall 基本持平，c=2 与 c=4 仅低约 5%，c=16 回升；PNG 解码最多 2 线程有效，整链路收益 4.7%。证据见 4.2 与 4.4。
- 原因：解码由 libvips 的 loader 完成，代码上就是一次 `sharp(input).raw()`，见 `universal-sharp.ts:28-29` 与 `image-converter.service.ts:103-108`；实测无加速，推测是 JPEG loader 没有可拆分的并行工作单元加线程调度开销，未能从源码进一步确认，标为推断；服务端也没有把同一张图拆给多进程解码的接口。
- 结论：属于「受格式与库实现限制，当前不可并行」。

### 5.2 QOI 编码阶段

QOI 格式的逐像素依赖：

- 编码每个像素的决策依赖三样状态：上一像素 `px_prev`、64 槽索引表 `index` 与未结算的 `run` 计数，见 `qoixx.hpp:326-401`。
- `px_prev` 不是依赖，因为源像素全量已知，前一个像素可从源数组直接取。
- 真正的跨像素依赖是索引表：`index[hash(px)]` 记录该哈希槽上一次写入的像素值，命中就发 `QOI_OP_INDEX`，不命中才发 DIFF、LUMA、RGB 或 RGBA 并更新索引表；opcode 常量见 `qoixx.hpp:217-224`，哈希与 64 槽见 `:225`、`:253`、`:271`。
- `OP_RUN` 依赖连续相同像素的计数，run 可以任意跨块切分，因为两个相邻 RUN opcode 叠加与一个长 RUN 解码结果相同；块首需要一个确定的 `prev_hash` 哨兵，原型用 64 哨兵在 run 长度为 1 时发 RUN 而不是 INDEX，仍然可解码，见 4.7 的跨块 run 用例。

分块并行的前置条件：

1. 计算每块起始时刻的全局索引表状态。做法是每块先扫描出 64 个槽在本块内的最后出现像素，再按块序做 64 槽前缀合并，复杂度为 64 乘以块数的串行合并加全图并行扫描。
2. 块首记录 `px_prev` 为源图前一个像素，`run` 从 0 开始，块尾把未结算 run 结算掉。
3. 各块只输出 opcode，不写文件头与结尾，最后由主线程拼上 14 字节头与 8 字节尾，见 `qoixx.hpp:1263` 附近对 header 与 padding 的处理。
4. 输出要按块收集并拼接，块大小上界为每像素 5 字节，实际 24MP 输出 94MB。

判定：

- 理论可以：分块编码在格式层面成立，已用原型验证 24MP 分块 K=4、K=8 拼接后像素完全正确。
- 当前没有：`qoi-img` addon 的批量接口只有单块同步 `encode`，见 `dist/index.js:26-28` 与 `backend/node_modules/qoi-img/lib/qoi.cpp:30-85`；另有有状态流式 `streamEncode` 与 `createEncodeState`，见 `dist/index.js:93` 与 `:98`，同样是顺序状态机，见 `qoi-stream.h:106-121`；`lib/` 全文无任何线程引用，没有分块或多线程接口。
- 成本：要拿到收益必须新增 native 多线程编码器或至少分块接口，并改造 worker 协议；JS 层分块原型证明纯 JS 不可行。

### 5.3 整条上传链路

- worker 内链路：解码 39.8% 加 QOI 编码 58.9%，两者都不并行，`sharp.concurrency` 与 `availableParallelism` 对链路无效，见 4.4。
- 端到端：再加主进程约 131ms 的 IPC 往返与约 8ms 的读入、类型判定、metadata，合计约 634ms，其中串行的 IPC 占 20.7%，属于加核也无法消除的部分。
- 当前 worker 池对一个转换任务只租一个 worker，见 `sharp.wrapper.ts:65` 与 `worker-pool.ts:108`，所以即使图内可拆，现有协议也不会把一张图分给多个 worker。
- 结论：当前后端单张图上传不能走多核，属于「当前实现没有」加「关键阶段受格式与库限制」。

### 5.4 三类划分

| 问题 | 判定 | 依据 |
|---|---|---|
| 后端当前实现能不能 | 不能 | 4.4 链路对照无改善，CPU/wall 约 1.01 到 1.12 |
| 理论上有没有可能 | 部分可能 | QOI 编码分块可行且已验证，见 4.7；解码受 JPEG loader 限制基本不可行，见 4.2 |
| 是否受格式限制不可能 | 不是不可能，是代价高 | QOI 单块串行，但分块加前缀状态可以并行；需要 native 重写 |
| 前端单张图能不能 | 不能 | 见 `research/frontend-single-image.md`，客户端无图像计算可并行 |

## 六、候选方案与量化上限

Amdahl 估算基线用 24MP JPEG 在 worker 内的 495ms，解码 197.19ms、QOI 编码 291.37ms、其它约 6.5ms；端到端再加 IPC 131ms 与主进程其它 8ms，合计 634ms。假设被并行的阶段能线性扩展，估算的是上限不是承诺。

| 候选方案 | 可行性 | 代价 | 实测依据与上限 |
|---|---|---|---|
| 只并行解码 | 低。JPEG 解码不可并行；PNG 最多 2 线程且整链路只省 4.7% | 要绕过 libvips loader 自己做分块解码，工作量大 | 4.2 数字。即使解码完美 4 路，worker 内 1.43 倍、端到端 1.30 倍；实测约 1.0 倍 |
| 并行预生成派生图 | 可行，但只优化首屏，不优化上传延迟 | 每个派生多一次 QOI 解码加缩放加目标编码，额外占用 worker 池；上传响应可以先返回，派生在后台做 | QOI 解码 12MP 52.9ms、24MP 约 105ms；缩放 1600 宽 15 到 28ms；24MP raw 缩放加 WebP 约 180ms。4 个派生并行约 300ms wall，串行约 1.2s。上传链路本身不缩短 |
| 换输出格式 | 不解决多核，且更慢 | 改默认存储格式、迁移存量、失去 QOI 无损 | 24MP raw 编码：QOI 291ms、JPEG q90 375ms、WebP q80 2918ms；三者 wall 都不随线程数下降，见 4.5。WebP 在真实照片上会快于合成噪声图，但仍慢于 QOI，且无多核收益 |
| 分块 QOI 编解码 | 格式可行，当前实现不可行 | 新增 native 分块或多线程编码器，改造 worker 协议，增加输出拼接与内存占用 | 原型已证明正确性，见 4.7。理想上限假设预扫描可并行或成本可忽略：编码 4 路并行时 worker 内 495 降到约 276ms，1.79 倍；16 路上限 2.23 倍；加 IPC 后端到端 4 路约 1.53 倍、16 路约 1.76 倍。若预扫描只能串行，见下表后的假设说明，收益降到约 1.1 倍 |
| 把单图拆给多个池 worker | 架构上可行但收益被 IPC 吃掉 | 需要分块 QOI 或分区解码，池上限只有 4，且拆一张图会挤占其它请求的转换容量 | 单次 IPC 往返 131ms，见 4.6；拆 4 份意味着多份像素与结果拷贝，父进程串行成本反而上升；当前池上限 min(4, 核数) 见 `worker-pool.ts:24-28` |

**S3 假设显式化**：上表「分块 QOI」的 1.3 到 1.5 倍区间假设预扫描与拼接可并行，或成本可忽略。原型里 phaseA 预扫描是单线程 176.7ms，约为原生编码 297ms 的 59%；如果 native 实现只并行编码段、预扫描仍单线程，worker 内为 495/(197.19+176.7+291.37/4+6.5) 约 1.09 倍，端到端约 1.07 倍；只有预扫描也能并行或融合进并行编码段，才接近 1.79 倍上限。

综合判断：在预扫描可并行或成本可忽略的前提下，单张图多核化最现实的路径是「native 分块 QOI 编码加单 worker 内多线程」，端到端上限约 1.3 到 1.5 倍；若预扫描只能串行，则收益降到约 1.1 倍量级；如果同时要保住多请求并发吞吐，收益还会被 worker 池上限摊薄。只并行解码与换输出格式这两条在本 build 上不成立。

## 七、不确定项与待验证项

1. 未在真实 worker 子进程内复测。测量都在普通 Node 进程内完成，与 worker 的差异是 512MB rlimit 与 IPC 隔离；解码、编码数值预期一致，但没有逐项在 worker 内重跑。
2. fixture 是合成噪声图。QOI 输出膨胀到 raw 的 1.31 倍，真实照片的编码耗时与占比会不同，绝对毫秒不能直接外推；报告只用占比判断，真实占比需要拿用户照片复测。
3. 分块 QOI 的实际收益未在 native 层验证。原型只证明正确性与分块方案可行，性能给的是按实测占比推算的上限；预扫描若不能并行，收益会从 1.3 到 1.5 倍降到约 1.1 倍量级，见 §6 假设说明；native 实现后还需要验证预扫描、拼接、内存峰值与 worker 池争用。
4. IPC 131ms 是 19.8MB 输入加 94MB 输出的合成往返；真实请求里 24MP 图可能更大或更小，发送与接收占比会变化。PNG 输入 72MB 的 IPC 成本未单独测，预计更高。
5. WebP 与 AVIF 在真实照片上的编码耗时未测。合成噪声图对 WebP 是最坏情况，4.5 的 2918ms 不能当成真实照片的数字；但「本 build 编码不随线程数下降」这一点与内容无关，结论不受影响。
6. 未测试把 `sharp.concurrency` 调成大于 16 或小于 1 的非常规值，也未测试 `VIPS_CONCURRENCY` 环境变量；worker fork 的 env 只有三个键见 `worker-pool.ts:364-374`，容器级变量到不了子进程，所以预期无效，但未实测。
7. 未做多请求并发下的单图耗时；池满时单图请求会排队，那属于上一轮 worker 池的范围。本文所有数字都是单请求独占。
8. 未评估实现成本与工期；候选方案里 native 多线程 QOI 的实现代价只按架构复杂度定性描述，没有给出代码量或风险分级。

## 八、参考规范与外部依据

相关规范：

- `.trellis/spec/picsur-backend/backend/upload-concurrency.md`：上一轮并发模型规格；本文确认其 §3.2「单张图上传的处理基本是单核」的结论，并给出分阶段实测与 Amdahl 上限。
- `.trellis/spec/picsur-backend/backend/image-api-contracts.md`：上传接口与默认 QOI 存储契约，本文的链路行号与它一致。
- `.trellis/spec/picsur-backend/backend/build-and-deploy.md`：Node 20 与镜像自编译 libvips 的运行契约，测量环境按此搭建。

外部依据：

- [QOI 官方规范](https://qoiformat.org/)：格式定位、参考实现与单页规范，用于核对 opcode 与索引表语义。
- [qoi-img 上游仓库](https://github.com/rubikscraft/qoi-img)：本文引用的 `lib/qoixx.hpp`、`lib/qoi.cpp`、`lib/qoi-stream.h` 即该包源码。
- [sharp concurrency API](https://sharp.pixelplumbing.com/api-utility#concurrency)：`sharp.concurrency` 语义与 libvips 线程数关系，本机类型声明在 `backend/node_modules/sharp/lib/index.d.ts:104-111`。

