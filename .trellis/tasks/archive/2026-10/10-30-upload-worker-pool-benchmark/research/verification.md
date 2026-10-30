# 复核报告：worker 池实现与池化后压测

- 复核对象：`backend/src/workers/sharp/worker-pool.ts` 新增、`backend/src/workers/sharp.wrapper.ts` 重写、`research/benchmark-after.md`
- 复核依据：`prd.md` R1-R6 与 Acceptance Criteria、`design.md` 第 2 至 5 节、`implement.md`、`research/benchmark-baseline.md`、`image-api-contracts.md`、`upload-concurrency.md`
- 角色：Trellis check 子代理 upload-verifier，共享任务 task-7
- 日期：2026-10-30
- 只读声明：未改实现代码，未 commit；仅有写入是本文件与 `benchmark-after.md`。压测实例、临时库、临时凭据均已清理，8080 现网容器未被触碰。
- 复核方式：对照 design.md 逐条读码核对，复跑 Node 20 构建与类型检查，用与基线完全相同的 run B 配方独立压测，不采信实现方自测数字。

## 一、复核结论

判定：通过，0 条阻断、0 条需修正、5 条建议。

- 实现与 `design.md` 逐条一致，设计里的每一条硬要求都能在代码行上指认，未发现行为偏差。
- 构建侧：Node 20 容器内 `nest build`、`tsc --noEmit`、eslint 全部退出码 0；重建的 `backend/dist` 与冻结快照 `/tmp/picsur-pool-dist` 逐文件一致，405 个文件 sha256 全对，清单自身 sha256 等于 `200ba361…c2142`。
- 压测侧：串行 p50 13.6ms 对基线 125.4ms，降 89.2%；并发 8 的 worker 峰值 4，等于池上限；并发 8 总耗时 268.5ms 对 340.1ms，p50 208.4ms 对 267.5ms，均未劣化；三场景像素校验 PASS。
- 回归与清理：38 passed 0 failed；删除实例后宿主 `sharp.worker` 进程数 0；空闲 65 秒后 worker 归零；临时库已 DROP。
- 5 条建议均为可维护性与文档前提，不影响本次合并判定，详见第四节。

## 二、A 部分：代码与构建逐条核对

### 2.1 构建、类型检查与产物一致性

| # | 核对项 | 复核命令与结果 | 判定 |
|---|---|---|---|
| A1 | Node 20 构建 | `docker run --rm -v /root/picsur:/repo -w /repo/backend node:20-alpine node /repo/backend/node_modules/@nestjs/cli/bin/nest.js build`，退出码 0，`backend/dist` 405 个文件，`worker-pool.js` 12070 B | 相符 |
| A2 | 类型检查 | `tsc --noEmit -p /repo/backend/tsconfig.json`，Node 20 容器内退出码 0 | 相符 |
| A3 | lint | `eslint backend/src/workers/sharp/worker-pool.ts backend/src/workers/sharp.wrapper.ts`，退出码 0，无输出 | 相符 |
| A4 | 重建产物与快照一致 | `diff -rq backend/dist /tmp/picsur-pool-dist` 无输出；405 个文件逐文件 `sha256sum -c` 全 OK | 相符 |
| A5 | 快照清单哈希 | `sha256sum /tmp/picsur-pool-dist.sha256` 为 `200ba3617247db599a3fba1a4f07b4a4d136f68ee37caa986ef10133ff3c2142`，与实现报告一致 | 相符 |
| A6 | 清单内容一致性 | 自建清单与冻结清单逐行相同，唯一差异是冻结版路径无 `./` 前缀，去掉前缀后完全一致 | 相符 |

说明：我曾用自己的命令重新生成清单并直接比较 sha256，得到 `38fa3993…`，差异只来自路径前缀写法，不是内容漂移；改为按冻结清单逐文件校验 405 项全 OK，`diff -rq` 也证明两棵目录树逐字节一致。

### 2.2 `worker-pool.ts` 对照 design §2.1

| # | design 要求 | 代码事实 | 判定 |
|---|---|---|---|
| B1 | 导出 `SharpWorkerPool` 单例与 `WorkerLease` | 36-43 行 `export interface WorkerLease`；541 行 `export const SharpWorkerPool = new SharpWorkerPoolImpl()` | 相符 |
| B2 | `pools: Map<string, PoolState>`，key 为 memoryLimit | 89 行 `Map<string, PoolState>`；192-205 行 `getPool` 用 `String(memoryLimit)` 建池 | 相符 |
| B3 | `PoolState = { idle, active, waiters }` | 70-75 行三字段齐备，`active` 为 `Set<WorkerSlot>` | 相符 |
| B4 | 并发上限 `Math.max(1, Math.min(4, availableParallelism()))` | 24-27 行逐字一致，`availableParallelism` 从 `os` 导入 | 相符 |
| B5 | 不新增环境变量 | 全文件无 `process.env` 读取；grep `process.env` 为 0 命中 | 相符 |
| B6 | 空闲 TTL 60 秒 | 30 行 `IDLE_WORKER_TTL_MS = 60 * 1000` | 相符 |
| B7 | TTL 定时器 `unref()` | 325-331 行 `setTimeout(...).unref()`，注释说明不阻止进程退出 | 相符 |
| B8 | `process.once('exit')` 清理全部子进程 | 98 行注册，516-533 行 `killAll` 遍历 active 与 idle 逐个 kill，best effort | 相符 |
| B9 | 不注册 SIGTERM 干扰既有信号处理 | grep `SIGTERM` 仅 96 行注释，无任何信号监听注册 | 相符 |
| B10 | acquire 三态：空闲复用、未达上限 fork、达上限排队 | 108-154 行，115-121 空闲、123-137 fork 并等 ready、139-153 入 FIFO 队列 | 相符 |
| B11 | 排队整体受 pTimeout 约束 | 143 行 `pTimeout(waiter.promise, { milliseconds: waitMs })`；超时后 145-148 行摘除等待者并返回 `Fail(FT.Internal, 'Timed out waiting for a free conversion worker')`，不占 worker | 相符 |
| B12 | 等待者按 FIFO 出队 | 238-259 行 `drain` 始终取 `state.waiters[0]`；220-235 行结算时先判 `settled` 防重复结算 | 相符 |
| B13 | ready 握手 | 426-463 行 `waitUntilReady` 监听 `message.type === 'ready'`，同名清理 message、exit、error 三个一次性监听 | 相符 |
| B14 | 崩溃销毁并补位 | 465-480 行 `handleSlotExit` 调 `disposeSlot` 后再 `drain`，队首等待者按上限重新 fork | 相符 |
| B15 | 超时或失败销毁 | 130-133 行、270-274 行就绪超时调 `disposeSlot`；507-513 行 kill | 相符 |
| B16 | fork 失败不死循环 | 252-255 行 fork 失败直接把该等待者结算为失败并 `continue`，不会无限补位 | 相符 |
| B17 | 正在 fork 的 slot 计入上限 | 390 行 `state.active.add(slot)` 在等 ready 之前执行，避免突发请求超发 | 相符 |
| B18 | stdio 日志只在 fork 时挂一次 | 397-406 行在 `forkSlot` 内挂 stdout、stderr；任务级代码不再挂，未随任务重建 | 相符 |
| B19 | release 回 idle 并重置 TTL | 157-175 行，`parkSlot` 清旧定时器再设新定时器 | 相符 |
| B20 | destroy 从 active 移除并补位 | 181-190 行 `disposeSlot` 加 `drain` | 相符 |
| B21 | 删除 fork 的 `timeout` 选项 | 364-374 行 fork 选项只有 `serialization`、`env`、`stdio`，无 `timeout` | 相符 |
| B22 | fork 保留原 3 个 env 键 | 366-372 行 `MEMORY_LIMIT_MB`、`MAX_IMAGE_PIXELS`、`NODE_OPTIONS`，与 fork 版逐字一致 | 相符 |
| B23 | 子进程路径正确 | 33 行 `pathJoin(__dirname, 'sharp.worker.js')`，与 dist 内实际文件名一致 | 相符 |

### 2.3 `sharp.wrapper.ts` 对照 design §2.2

| # | design 要求 | 代码事实 | 判定 |
|---|---|---|---|
| C1 | 构造函数签名不变 | 51-54 行 `constructor(instance_timeout, memory_limit)`，与 HEAD 版一致 | 相符 |
| C2 | `start` 签名不变 | 56-60 行 `start(image, filetype, sharpOptions?)`，返回 `AsyncFailable<true>` | 相符 |
| C3 | `operation` 签名不变 | 97-100 行泛型与参数转发与 HEAD 版一致 | 相符 |
| C4 | `finish` 签名不变 | 120-123 行 `finish(targetFiletype, options?)`，返回 `AsyncFailable<SharpResult>` | 相符 |
| C5 | `start` 改为池租约 | 65-68 行 `SharpWorkerPool.acquire(memory_limit, instance_timeout)` | 相符 |
| C6 | 成功 release、失败 destroy | 186 行成功 `releaseLease()`；171 行 `result.failure` 时 `destroyLease`；189 行超时或协议错误 `destroyLease` | 相符 |
| C7 | 删除 fork 与 fork timeout | 全文件无 fork 调用与 fork 选项；文件头注释说明改为池租约 | 相符 |
| C8 | 只清本任务监听，不用 removeAllListeners | 211-217 行只 `removeListener('message', finishListener)`；219-223 行只移除 `'close'` 的 `onTaskClose`；grep `removeAllListeners` 在 `backend/src/workers/` 为 0 命中 | 相符 |
| C9 | 错误映射逐字保留 | 170-182 行与 HEAD 版逐行相同，只多出 171 行 `this.destroyLease(result.failure)`；`DecodeWorkerFailure` 转 `FT.UsrValidation`、其它转 `FT.Internal` 保持不变 | 相符 |
| C10 | `purge()` 语义拆分 | 226-234 行 `releaseLease`、237-250 行 `destroyLease`，不再统一 kill | 相符 |
| C11 | `close` 拒绝挂起的 finish | 194-208 行 `onTaskClose` 缓存原因并 `reject('Worker closed')`；139-157 行 finish 用本任务 `once('message')` | 相符 |
| C12 | IPC 关闭返回可读失败 | 252-264 行 `sendToWorker` 用 try/catch 包 `child.send` | 相符 |
| C13 | 调用点未变 | `image-converter.service.ts:84` 仍是 `new SharpWrapper(timeLimitMS, memLimit)`，该文件哈希与基线一致 | 相符 |
| C14 | 池内复用后状态干净 | 子进程 `sharp.worker.ts` 未改，`finish` 前先把 `sharpi` 置空，`init` 只在非空时报 Already initialized；实测连续 10 次上传只 fork 1 次且结果正确 | 相符 |

### 2.4 未改文件哈希与范围

| # | 核对项 | 实测 | 判定 |
|---|---|---|---|
| D1 | `sharp.worker.ts` 未改 | sha256 `f5186b50521cf8331bd67656f3f13ca8db6c95192962dfdf2ee9bd14c4904232`，与基线报告一致 | 相符 |
| D2 | `image-converter.service.ts` 未改 | sha256 `3781661a04c9c1f46462889a3934bcd98df036bef644d9c9146b939c21bfe5ed`，与基线报告一致 | 相符 |
| D3 | `worker-pool.ts` 与实现报告一致 | sha256 `e8505ec0e4e568b13abf4d544c87d9bdf64e8f1b03ee533d3482aac0f1e5cdf9` | 相符 |
| D4 | `sharp.wrapper.ts` 与实现报告一致 | sha256 `eab002e1bf42d2ffa657d8541d9fe69295d16e7a1b15b086d59016c5d171a306` | 相符 |
| D5 | git status 范围 | 仅 `M backend/src/workers/sharp.wrapper.ts`、`?? backend/src/workers/sharp/worker-pool.ts`、`?? .trellis/tasks/10-30-upload-worker-pool-benchmark/`、`?? support/bench-upload.cjs`；无前端、无 DB schema、无 `Dockerfile`、无 `Dockerfile.allinone` 改动 | 相符 |
| D6 | 无新增环境变量 | 池化两文件无 `process.env`，fork 仍只有原 3 个 env 键；`git diff` 不含 env 定义 | 相符 |

说明：复核开始时 `git status` 还包含并行文档任务的改动，复核中途该任务已提交并在 HEAD `62c90a8` 归档，之后范围收敛为上面 4 条，与本任务白名单一致。

## 三、B 部分：压测与回归复核

数字、命令与逐项对比见 `benchmark-after.md`，此处只列判定与关键证据：

| # | 验收项 | 目标 | 实测 | 判定 |
|---|---|---|---|---|
| E1 | 串行 p50 明显低于基线 125.4ms | 明显下降 | 13.6ms，-89.2% | 通过 |
| E2 | 并发 8 worker 峰值 | ≤ 4 | 峰值 4，容器日志 fork 次数恰好 4 | 通过 |
| E3 | 并发 8 总耗时不劣化 | ≤ 340.1ms | 268.5ms，-21.0% | 通过 |
| E4 | 并发 8 p50 不劣化，排队计入单请求 | ≤ 267.5ms | 208.4ms，-22.1% | 通过 |
| E5 | 像素一致性 | 三场景全 PASS | 三场景全 PASS，200 × 150 × 4，488 B | 通过 |
| E6 | 复用效果 | fork 次数明显少于请求数 | 26 次上传共 9 次 fork；串行 10 张只 fork 1 次 | 通过 |
| E7 | 回归 | 38 passed 0 failed | 38 passed 0 failed，退出码 0 | 通过 |
| E8 | 退出后无残留 worker | 0 | 0 | 通过 |
| E9 | TTL 65 秒空闲归零 | 0 | 0，回收期间无新 fork | 通过 |
| E10 | 运行时配方与基线一致 | 同镜像、同 Node、同 fixture、同参数 | 镜像 ID `sha256:3c6bcf7f…17aab`、Node v20.20.2、base.png 488 B、三场景参数相同，仅端口 18082 | 通过 |
| E11 | 事实核对容器内实际执行池化代码 | 挂载即池化版 | 容器内 `worker-pool.js`、`sharp.wrapper.js`、`main.js` 三个 sha256 与快照逐一相等，挂载 `rw=false` | 通过 |
| E12 | 失败销毁与补位 | 不复活脏 worker | 损坏 IDAT 上传返回 400 可读，worker 1 到 0，随后并发 4 张补位 fork 至 5，无 500 | 通过 |
| E13 | 现网不受影响 | 不碰 8080 | 现网 `picsur` 容器 `Up 23 hours`、`RestartCount=0`、`StartedAt` 未变 | 通过 |

补充：E7 的回归显式设置 `PICSUR_PSQL` 指向临时库 `picsur_check_pool`，没有回退到现网容器；整套回归只新 fork 1 个 worker。

## 四、发现的问题与建议

### 4.1 阻断

无。

### 4.2 需修正

无。

### 4.3 建议

S1 `takeIdleSlot` 未校验 `ready`，`WorkerSlot.ready` 成为无人消费的字段。

- 位置：`backend/src/workers/sharp/worker-pool.ts:63` 定义 `ready`，`289-313` 行 `takeIdleSlot` 只查 `closed` 与退出码。
- 现状风险：无实际缺陷，因为 `parkSlot` 只会在 worker 已 ready 时被调用，即成功 finish 之后或 `readyWaiterSlot` 的 `waitUntilReady` 成功之后，所以不变量成立。
- 建议：要么在 `takeIdleSlot` 里加一条 `ready` 断言或直接复用 `ready` 而非 `closed`，要么删掉该字段，避免后续维护者误以为存在未检查的 ready 状态。

S2 SIGTERM 场景的子进程清理前提应写入文档。

- 位置：`worker-pool.ts:94-98` 只注册 `process.once('exit')`，明确不注册 SIGTERM。
- 现状风险：Node 的 `exit` 事件不会在默认 SIGTERM 终止时触发；容器部署下整个 cgroup 随容器停止回收，实测无残留，风险已被兜住。
- 建议：在 `upload-concurrency.md` 或实现注释里写明「清理依赖容器生命周期兜底；若未来改为非容器化或独立 supervisor 部署，需要补 SIGTERM 转发」。

S3 排队等待超时后仍可能在后台完成一次 fork。

- 位置：`acquire` 在 `139-153` 行以 `waitMs` 等待，而 `261-287` 行 `readyWaiterSlot` 用等待者自己的 `timeoutMs` 重新计时。
- 现状风险：请求本身在 `waitMs` 到点即返回失败，不受影响；但后台可能再 fork 一个 worker，就绪后发现等待者已结算，于是 park 进空闲池，最多被 TTL 回收。
- 建议：加注释说明这是有意为之，或把剩余预算传给 `readyWaiterSlot`，避免运维看到「超时请求之后还多了一个 fork」的日志时误解。

S4 日志里的 worker 标识有两套，排查时需要对号。

- 位置：`sharp.wrapper.ts:39` 用随机 `workerID` 作 logger 名，池层用递增 `#N`。
- 建议：任务日志改打租约里的 `lease.workerID`，与池日志统一，便于线上按 worker 号串起生命周期。

S5 缺少暖池稳态对照场景。

- 现状：三场景之间按基线要求各等 62 秒，超过 60 秒 TTL，所以每场景都从冷池开始，并发 8 的 p50 里仍含约 170 到 200ms 的 fork 冷启动。
- 建议：后续补一场「场景间隔 5 秒、并发 8 × 8」的暖池对照，量化连续负载下的稳态延迟；本轮结论不依赖它，因为验收对比与基线同口径。

## 五、PRD 与 design 对应核对

| 条目 | 要求 | 复核结果 | 判定 |
|---|---|---|---|
| R1 | 基线可复现 | 基线已有 `research/benchmark-baseline.md`，命令与原始数字齐备，本轮按其配方成功复跑 | 满足 |
| R2 | 常驻 worker 池替代每次 fork，保留超时、内存上限、错误映射 | 池化生效，26 次上传 9 次 fork；每任务仍受 `pTimeout(instance_timeout)`；`setrlimit` 仍由子进程启动时设置；错误映射逐字保留 | 满足 |
| R3 | 上限 `min(4, availableParallelism())`、无环境变量、TTL、崩溃补位、退出清理 | 逐条见 B4 至 B9、B14 | 满足 |
| R4 | 行为兼容，超像素 400、坏图可读 4xx、排队不超请求超时 | 回归 38 项全绿含超像素 400；损坏 IDAT 独立复跑得到 400 usrvalidation 且无 500；排队等待受 `waitMs` 约束 | 满足 |
| R5 | 同口径对比给出数字，收益不显著要如实报告 | 同配方对比明确，收益显著；`benchmark-after.md` 第 3 节给出逐项变化 | 满足 |
| R6 | 改动范围限定 worker 层 | git status 仅两文件加任务目录与压测脚本；未改前端、DB schema、镜像 | 满足 |
| design §3 | 超时、崩溃、内存超限、并发超限、进程退出五类语义 | 逐条在 B14、B15、B10，以及 wrapper C6、C11 对齐 | 满足 |
| design §5 | 压测口径与断言 | 场景、fixture、间隔、观测项、像素断言均按基线执行 | 满足 |
| design §6 | 回退路径 | 改动集中在两文件，替换回 fork 实现即可回退；实际未触发 | 满足 |

## 六、复核限制

1. 未覆盖「转换超过 15 秒」与「排队超时」的端到端触发，与本任务实现报告 §6 的未完成项一致；代码路径已核对存在，但未做运行时触发，因此这两条属未实测项，不是已验项。
2. 未做 12 小时以上长稳与内存缓慢增长观测；本轮只记录单场景 RSS 峰值与 TTL 回收。
3. 时点敏感：所有数字对应 `/tmp/picsur-pool-dist` 快照与镜像 `sha256:3c6bcf7f…17aab`；宿主 `backend/dist` 若被再次重建不影响本次记录，但复跑时必须重新核对快照哈希。
4. 压测实例与临时库在本轮结束前已删除与 DROP；临时凭据文件已删除，未落任何持久位置。
5. 本任务无代码改动，未运行项目全量测试套件，只跑了与上传链路相关的 38 项接口回归。
