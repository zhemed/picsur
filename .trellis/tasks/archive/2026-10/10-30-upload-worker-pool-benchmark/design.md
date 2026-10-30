# 设计：转换 worker 池化

## 1. 边界与目标

- 改动边界：`backend/src/workers/` 下的转换进程管理，以及 `backend/src/managers/image/image-converter.service.ts` 的必要调用点。
- 不改：HTTP 路由、DTO、DB schema、前端、镜像与部署文件、QOI 编解码实现。
- 目标：把「每个转换 fork 一个子进程并杀死」改成「有限并发的常驻 worker 池，按需创建、空闲回收、失败销毁」。
- 对外 API 保持 `SharpWrapper` 的 `start / operation / finish` 三方法不变，`image-converter.service.ts` 的调用方式不变，降低回归面。

## 2. 组件与职责

```
ImageConverterService
  → new SharpWrapper(timeoutMs, memLimit)          // 每任务句柄，构造不变
      → SharpWorkerPool.acquire(memLimit, timeout) // 全局单例，按 memLimit 分池
          → 复用空闲 ChildProcess 或 fork 新子进程
      → init / operation / finish                  // 协议不变
      → release(lease) | destroy(lease)
```

### 2.1 新文件 `backend/src/workers/sharp/worker-pool.ts`

- 导出 `SharpWorkerPool` 单例与 `WorkerLease` 类型。
- 内部结构：
  - `pools: Map<string, PoolState>`，key 为 `memoryLimit` 字符串。子进程的 `MEMORY_LIMIT_MB` 在 fork 时写死，不同内存上限不能共用。
  - `PoolState = { idle: WorkerSlot[]; active: Set<WorkerSlot>; waiters: Waiter[] }`。
  - `WorkerSlot = { child: ChildProcess; ready: boolean }`。
- 并发上限：`Math.max(1, Math.min(4, os.availableParallelism()))`，常量，不加环境变量。
- 空闲 TTL：60 秒。空闲 slot 到期后 `kill`，从 idle 移除；定时器 `unref()`，不阻止进程退出。
- `acquire(memoryLimit, timeoutMs)`：
  - 有空闲 slot 且 ready → 移入 active 并返回；
  - 未达上限 → fork 新子进程，等待 `ready` 消息，就绪后移入 active 并返回；
  - 已达上限 → 进入 FIFO 等待队列，整体受 `pTimeout` 约束，超时返回失败，调用方返回既有可读错误。
- `release(slot)`：从 active 移除，放回 idle，重置 TTL。
- `destroy(slot, reason)`：`kill()`、清理监听、从 active 移除；若队列有等待者则按需补位。
- 进程退出清理：`process.once('exit')` 遍历所有 slot kill，best effort；不注册会干扰既有信号处理的 SIGTERM 逻辑。

### 2.2 重构 `backend/src/workers/sharp.wrapper.ts`

- 构造函数签名不变，仍接收 `instance_timeout` 与 `memory_limit`。
- `start()`：
  1. 通过池 `acquire(memory_limit, instance_timeout)` 拿到 slot；
  2. 给该 slot 的 child 挂本任务的 `message` / `close` 一次性监听；
  3. 发送 `init`；失败则 `destroy` 并返回 Failure。
- `operation()` / `finish()`：逻辑与现在一致，只把「fork 与 kill」换成「池租约」。
- `finish()` 结束时：
  - 成功 → `release`；
  - 超时、`result.failure`、协议错误、`close` → `destroy`，下次按需重建，避免把不确定状态的子进程放回池；
  - 失败原因映射保持现状：`DecodeWorkerFailure` 转 `FT.UsrValidation`，其它转 `FT.Internal`。
- 关键实现点：
  - 删除 `fork(..., { timeout })` 选项。该选项是按子进程生命周期计时的，长驻 worker 会在 15 秒后被误杀。
  - 每次任务只清理本任务挂上的监听器，不能 `removeAllListeners()` 掉池的共用监听。
  - 子进程 `stdout/stderr` 日志监听在 fork 时挂一次，不随任务重建。
- `purge()` 语义拆成「任务失败销毁租约」与「正常归还」，不再一律 kill。

### 2.3 子进程 `backend/src/workers/sharp/sharp.worker.ts`

- 协议不变，但去掉「一个子进程只处理一个任务」的假设：
  - `init` 时若 `sharpi !== null` 仍报错，`finish` 后已经置空，天然支持复用；
  - `fail()` 后的 `process.exit(0)` 保留，父进程按失败处理并销毁该 worker；
  - 内存上限 `setrlimit` 只在进程启动时设一次，长驻期间复用同一上限。
- 不做额外改造，除非验证发现复用后状态残留。

## 3. 超时与资源语义

| 场景 | 现行为 | 池化后 |
|---|---|---|
| 单任务转换超过 15 秒 | fork timeout 加 pTimeout 杀进程 | 任务级 pTimeout 超时，销毁该 worker |
| 排队等待超过任务超时 | 不存在，无排队 | 等待队列超时，返回既有 Internal 失败，不占用 worker |
| 子进程崩溃 | close 事件触发失败 | close 触发本任务失败并销毁，其它任务不受影响 |
| 内存超限 | 子进程 setrlimit 失败 | 同上，失败原因映射不变 |
| 请求并发大于池上限 | 无上限，可能 fork 大量进程 | 排队，峰值子进程数等于池上限 |
| 进程退出 | 每次转换后已 kill | `process.once('exit')` 统一下发 kill |

## 4. 备选方案与取舍

1. 常驻固定池，启动即 fork 4 个：实现最简单，但空闲内存代价大，且在内存偏紧的宿主上不划算。不选。
2. 按需创建加空闲 TTL：本方案。冷启动仍有一次 fork 开销，只有在连续上传时才体现复用收益，符合线上真实负载。
3. 用 `worker_threads` 替 `child_process`：内存更省，但 sharp 与 qoi-img 状态隔离、setrlimit 语义都要重新验证，改动面大。本轮不做。
4. 引入 `piscina` 等池库：多一个依赖且仍要处理协议与 rlimit，收益不明显。不选。

## 5. 压测口径

- fixture：用 `support/make-image-fixtures.cjs` 生成的标准集，至少覆盖 PNG、JPEG、WebP、QOI 各一张，外加一张大图。
- 场景 A 串行：单张上传 10 次，记录每次端到端耗时。
- 场景 B 并发：并发 4 与并发 8 各上传 8 张，记录总耗时、失败数、子进程峰值数。
- 观测：`docker exec picsur-bench ps -ef | grep sharp.worker` 或宿主 `ps` 统计 worker 进程数；`docker stats` 或 `ps` 取 CPU 与 RSS；对比基线。
- 断言：全部上传成功且取回像素一致；错误路径用例单独跑。
- 实例：Node 20 容器内跑 backend，`--network host` 连 dev Postgres 5432，端口用 18080，禁止碰 8080 现网容器。

## 6. 回退

- 改动集中在 `worker-pool.ts` 与 `sharp.wrapper.ts`，把 `SharpWrapper` 内部换回「fork 一次、用完 kill」即可回退。
- 压测脚本与 research 报告保留，便于下次复测。
- 如果池化后延迟或内存反而变差，保留基线数据，不合并改动。
