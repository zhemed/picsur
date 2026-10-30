# 转换 worker 池化并做并发压测

## Goal

当前每次图片转换都 `child_process.fork` 一个新 Node 子进程、用完即杀，固定进程启动开销且并发数不受控。本任务先建立可复现的上传并发压测基线，再把转换改为常驻 worker 池复用，最后用同一压测口径验证收益、正确性与错误路径。

## Background

- `10-30-investigate-upload-concurrency` 的调查结论：单张图处理基本单核，每次转换 `fork` 一个新子进程且不复用，是已确认瓶颈第 1 位。
- 现实现：`backend/src/managers/image/image-converter.service.ts:84` 每次 `new SharpWrapper(...)`；`backend/src/workers/sharp.wrapper.ts:54-65` fork 子进程，`:231-235` 用完 kill；`backend/src/workers/sharp/sharp.worker.ts` 是子进程入口，收到 `init` / `operation` / `finish` 消息。
- 运行时事实：容器无 CPU 配额，宿主 16 逻辑 CPU；默认主格式 QOI 的编解码为 `qoi-img` 原生同步单线程，因此池化收益主要来自省掉每次 fork 的进程启动与模块加载开销，以及把并发度限制在合理范围。
- 构建环境硬约束：装依赖与构建必须 Node 20 + pnpm 9.6.0。本机宿主 Node 24 不能用于构建，但本机已有 `node:20-alpine` 镜像与 `backend/node_modules`，可在容器内用 `nest build` 构建。
- 本地可用的测试底座：dev Postgres 容器 `support-devdb-1` 监听的 5432，库名、用户、口令均为 `picsur`；现网 picsur 容器占 8080，压测实例必须另选端口。

## Requirements

- R1 压测基线可复现：用固定 fixture 集，对改动前的 backend 测量串行单张与并发上传的延迟分布、总耗时、转换子进程峰值数、CPU 使用；命令与原始数字写进任务 research。
- R2 实现常驻 worker 池：复用已 fork 的转换子进程，替代每次转换 fork 与 kill；保留每任务超时、内存上限、失败原因映射这三类既有语义。
- R3 池参数与生命周期：并发上限默认 `min(4, os.availableParallelism())`，不新增环境变量；空闲 worker 有 TTL 回收；worker 崩溃、超时或协议错误时销毁并在下次按需补位；进程退出时清理子进程。
- R4 行为兼容：上传、取回、派生图、错误路径行为不变，包括超像素返回 400、坏图返回可读 4xx、转换超时不被当成 500；并发超过池上限时排队，排队本身不得超过请求超时。
- R5 用同一套压测口径对比改动前后，给出数字；若收益不显著或内存代价过高，如实报告并保留回退路径。
- R6 改动范围限定在 backend 的 worker 层与必要调用点，不改前端、数据库 schema、镜像与部署方式。

## Acceptance Criteria

- [ ] `research/benchmark-baseline.md` 与 `research/benchmark-after.md` 存在，含完整命令、fixture 说明与原始数字。
- [ ] 池化后串行单图延迟与并发吞吐相对基线有可测改善；若否，报告给出原因与数据。
- [ ] 并发 N 为 1 到 8 的上传全部成功，取回断言像素与 fixture 一致，不只断言状态码。
- [ ] 错误路径回归通过：超像素 400、坏文件可读 4xx、转换超时按既有语义处理。
- [ ] 压测期间观测到的转换子进程数不超过池上限。
- [ ] 压测实例退出后没有残留转换子进程。
- [ ] 没有新增环境变量；`git diff` 不含前端、DB schema、Dockerfile 改动。
- [ ] `support/regression-image-api.sh` 对本地压测实例全绿。

## Constraints

- 构建只在 Node 20 容器内进行，不在宿主 Node 24 下装依赖或构建。
- 压测实例只用 dev Postgres，禁止压测现网 picsur 容器与它的数据。
- 不新增环境变量，避免环境变量三处同步的额外扩散。
- 只改 backend worker 层与必要调用点；前端、DB schema、部署文件不动。

## Non-goals

- 不做前端批量上传改造。
- 不做多实例部署或限流外置。
- 不改 QOI 编解码实现本身。

## Notes

- 与「修复文档漂移」是同轮授权的两个独立任务，互不阻塞；两者都改仓库文件但文件集合不重叠。
- 池化的主要风险是常驻子进程的内存占用与子进程内长生命周期状态，验证时要记录 RSS 与连续多任务后的稳定性。

## 实现结论（2026-10-30）

**判定：通过。** 池化已实现并完成同口径压测与独立复核，0 阻断、0 需修正、5 条不阻塞建议。

改动：

- 新增 `backend/src/workers/sharp/worker-pool.ts`：进程级单例池，按 memoryLimit 分池，
  并发上限 `max(1, min(4, availableParallelism()))`，空闲 TTL 60 秒，FIFO 等待队列受 pTimeout，
  `process.once('exit')` 清理，崩溃或超时销毁后按需补位。
- 重写 `backend/src/workers/sharp.wrapper.ts`：`start / operation / finish` 对外签名不变，
  内部改为租约模型；成功 release、失败 destroy；删除 fork 的 `timeout` 选项；错误映射逐字保留。
- `sharp.worker.ts` 与 `image-converter.service.ts` 未改，哈希与基线一致，复用未发现状态残留。
- 新增 `support/bench-upload.cjs` 压测脚本，串行与并发场景通用，含像素校验与 worker 采样。

同口径实测，run B 配方，fork 基线对比池化后：

| 场景 | 基线 | 池化后 | 变化 |
|---|---|---|---|
| 串行 10 张 p50 | 125.4ms | 13.6ms | 降 89.2% |
| 串行 10 张总耗时 | 1341.4ms | 348.9ms | 降 74.0% |
| 并发 4×8 总耗时 / p50 | 404.0 / 159.5ms | 267.5 / 37.4ms | 降 33.8% / 76.6% |
| 并发 8×8 总耗时 / p50 | 340.1 / 267.5ms | 268.5 / 208.4ms | 降 21.0% / 22.1% |
| 并发 8 worker 峰值 | 8 | 4 | 等于池上限 |
| 并发 8 worker RSS 峰值 | 540.4MB | 291.9MB | 降 46.0% |

- 26 次上传只 fork 9 个 worker；串行 10 张只 fork 1 次；像素校验三场景全 PASS。
- 错误路径不变：超像素 400、损坏图 400 可读、worker 解码失败 400 可读，无 500；失败 worker 销毁并补位。
- `support/regression-image-api.sh` 38 passed / 0 failed；TTL 到点回收、实例退出后宿主无残留 worker。

复核：`research/verification.md` 判定通过，代码 35 项逐条核对、验收 13 项，全部相符；
`research/benchmark-after.md` 是独立复跑数据。复核建议 5 条不影响合并，已记录进
`.trellis/spec/picsur-backend/backend/upload-concurrency.md` 第 9.3 节。

残留与后续：

1. 非容器部署只注册了 exit 清理，未注册 SIGTERM 转发；容器 cgroup 回收可兜底，裸机直跑需确认。
2. 空闲 worker 保留 60 秒，4 个 worker RSS 峰值约 292MB；宿主内存紧时需观察。
3. 并发超过池上限时排队；压测显示总耗时仍优于 fork 版，但单请求 p50 会包含排队时间。
4. 可维护性建议：`WorkerSlot.ready` 无消费者、两套 worker 日志标识、排队超时后可能多 fork 一个并 park。
5. 建议后续补一场「间隔 5 秒的暖池对照」压测，本轮三场景间隔 62 秒，全部是冷启动口径。

