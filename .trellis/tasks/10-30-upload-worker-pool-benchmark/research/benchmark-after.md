# Research: 池化后上传压测（worker pool）

- Query: 用与 `benchmark-baseline.md` §2.1 run B 完全相同的口径，复跑串行 10 张、并发 4 × 8、并发 8 × 8，验证池化收益、worker 上限、像素一致性与清理行为。
- Scope: mixed，内部源码复核 + 本机运行环境实测。
- Date: 2026-10-30。
- 角色：Trellis check 子代理 upload-verifier 独立复跑，不复用实现方的运行时与数字。
- 对照基线：`research/benchmark-baseline.md`，fork 版构建 2026-10-30 11:56:13Z，git HEAD `5675514`。
- 池化版：`/tmp/picsur-pool-dist` 快照，清单 sha256 `200ba3617247db599a3fba1a4f07b4a4d136f68ee37caa986ef10133ff3c2142`，本轮复核前已重新构建并与之逐文件一致。

## 0. 一句话结论

池化成立：同一 run B 配方下，串行 p50 从 125.4ms 降到 13.6ms，降幅 89.2%；并发 8 的 worker 峰值从 8 收敛到 4，总耗时从 340.1ms 降到 268.5ms，p50 从 267.5ms 降到 208.4ms，worker RSS 峰值从 540.4MB 降到 291.9MB，CPU 平均核数从 6.79 降到 4.08。三项压测 26 次上传只 fork 9 个 worker，像素校验全 PASS，38 项回归全绿，实例删除后宿主无残留 worker。

## 1. 复核环境与时点

| 项 | 值 |
|---|---|
| 仓库 | `/root/picsur`，分支 `master`，HEAD `62c90a8223ac005e61ee859f8a281faf5f51bf39`，提交时间 2026-10-30 12:21:17Z |
| 构建 | Node 20 容器内 `nest build`，退出码 0，`backend/dist` 405 个文件；`tsc --noEmit` 退出码 0；eslint 退出码 0 |
| 代码快照 | `/tmp/picsur-pool-dist`，405 个文件，`diff -rq backend/dist /tmp/picsur-pool-dist` 无差异，405 个文件逐文件 sha256 校验全 OK；清单自身 sha256 与实现报告一致 |
| 运行时镜像 | `ghcr.io/zhemed/picsur:allinone`，Image ID `sha256:3c6bcf7fc981e9805618ea9506ed28b5c9bd42b6008010bd996be6e1ef917aab`，与基线 run B 同一镜像 |
| 容器内 Node | v20.20.2，与基线一致 |
| 挂载 | `/tmp/picsur-pool-dist -> /picsur/backend/dist`，只读 `rw=false` |
| 扫描确认 | 容器内 `worker-pool.js`、`sharp.wrapper.js`、`main.js` 三个 sha256 与宿主快照逐一相等，证明跑的是池化版而不是镜像自带代码 |
| 网络与端口 | `--network host`，`PICSUR_PORT=18082`；18080 与 18081 空闲，8080 现网容器全程未触碰 |
| 数据库 | dev Postgres 容器 `support-devdb-1`，`127.0.0.1:5432`，本任务专用临时库 `picsur_check_pool`，结束后已 DROP |
| 环境变量 | `PICSUR_PRODUCTION=true`、`PICSUR_SYNC_SCHEMA=true`、`PICSUR_STATIC_FRONTEND_ROOT=/picsur/frontend/dist`、临时管理员口令与 JWT secret；credentials 只写 `/tmp/*.env`，权限 600，收尾删除 |
| fixture | `/tmp/picsur-fx`，三场景与基线一致都上传 `base.png`，488 B，200 × 150 RGBA |
| 压测脚本 | `support/bench-upload.cjs`，只读使用，未改 |
| 时点 | 12:22:48Z 实例就绪；12:23:06Z 串行；12:24:10Z 并发 4；12:25:13Z 并发 8；12:26:20Z TTL 检查；12:26:44Z 回归；12:28Z 清理完成 |

实例启动命令，与原配方仅端口与库名不同：

```bash
docker exec support-devdb-1 psql -U picsur -d picsur -c "CREATE DATABASE picsur_check_pool"
docker run -d --name picsur-bench-check --network host --env-file /tmp/picsur-check-pool.env \
  -v /tmp/picsur-pool-dist:/picsur/backend/dist:ro \
  -w /picsur --entrypoint /bin/sh ghcr.io/zhemed/picsur:allinone \
  -c 'exec node backend/dist/main.js'
```

三场景命令，参数与基线完全相同，仅端口与容器名不同，每步之间 `sleep 62` 避开上传限流 20 次每 60 秒：

```bash
node support/bench-upload.cjs --base http://127.0.0.1:18082 --token "$TOKEN" \
  --fixtures /tmp/picsur-fx --mode serial --count 10 --container picsur-bench-check
node support/bench-upload.cjs --base http://127.0.0.1:18082 --token "$TOKEN" \
  --fixtures /tmp/picsur-fx --mode concurrent --count 8 --concurrency 4 --container picsur-bench-check
node support/bench-upload.cjs --base http://127.0.0.1:18082 --token "$TOKEN" \
  --fixtures /tmp/picsur-fx --mode concurrent --count 8 --concurrency 8 --container picsur-bench-check
```

## 2. 原始结果，run B 同配方，池化版

### 2.1 汇总

| 场景 | 成功/失败 | 总耗时 | 最小 | p50 | p90 | p95 | 最大 | 平均 | 吞吐 | worker 峰值 | worker RSS 峰值 | 主进程 RSS 峰值 | CPU 秒 | 平均核数 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 串行 10 张 | 10/0 | 348.9ms | 12.4ms | 13.6ms | 19.8ms | 169.4ms | 169.4ms | 29.8ms | 28.66 张/s | 1 | 81.0MB | 157.4MB | 0.34s | 0.96 |
| 并发 4 × 8 张 | 8/0 | 267.5ms | 25.4ms | 37.4ms | 179.8ms | 179.8ms | 179.8ms | 104.1ms | 29.90 张/s | 4 | 318.4MB | 156.5MB | 0.98s | 3.68 |
| 并发 8 × 8 张 | 8/0 | 268.5ms | 203.9ms | 208.4ms | 212.9ms | 212.9ms | 212.9ms | 208.7ms | 29.79 张/s | 4 | 291.9MB | 158.5MB | 1.10s | 4.08 |

原始数字取自 `support/bench-upload.cjs --json-out` 输出，字节换算按 MiB 除以 1048576：

- 串行 worker RSS 峰值 84893696 B，主进程 165027840 B，cgroup CPU 336103 usec。
- 并发 4 worker RSS 峰值 333848576 B，主进程 164057088 B，cgroup CPU 984903 usec。
- 并发 8 worker RSS 峰值 306077696 B，主进程 166166528 B，cgroup CPU 1095030 usec。
- worker 采样序列，50ms 间隔：串行 `0,1,1,1,1,1`；并发 4 `0,4,4,4`；并发 8 `0,4,4,4`。

### 2.2 逐请求原始输出

串行 10 张，首张含 fork 冷启动：

```text
  #01 201 169.4ms id=884ca1ab-da16-4264-93d8-14d5eb8974e3
  #02 201 19.8ms id=afc0794f-82ba-4cfc-bbe9-01aaa5e289ba
  #03 201 15.1ms id=c3387a44-22e3-43f9-a998-7748912e4cc4
  #04 201 14.0ms id=78eeac7c-7fb9-4968-9f73-a877d7a1b49a
  #05 201 14.1ms id=621e213f-e79a-4a4f-a247-713fbc7e8e3d
  #06 201 13.2ms id=8888c475-37a4-444a-945c-c82d978a7907
  #07 201 12.7ms id=80f6023b-63a8-41f0-8021-d3f4ce6e77c3
  #08 201 12.4ms id=f7df6bb8-ba60-44f2-9118-e4a0ed105818
  #09 201 13.6ms id=4c028925-1c2e-42a7-9598-c0def17285cc
  #10 201 13.6ms id=1bfb6b17-c15e-442a-ab60-b99940e78014
```

并发 4 × 8 张，前 4 个赶上 fork，后 4 个直接复用暖 worker：

```text
  #01 201 178.5ms id=1a07c57a-c4ca-4837-9a6c-b3bab7289aab
  #03 201 176.1ms id=26b27a18-5b72-403f-a30a-81b5d5490cb6
  #04 201 176.8ms id=242bc574-24e0-4fd2-8b4c-474c29564788
  #02 201 179.8ms id=c3ab44f3-1c3e-4b07-a33f-e9c5231017bd
  #05 201 29.9ms id=89caa036-cfbe-42f6-8341-f22c6bc8deb2
  #08 201 25.4ms id=ac0162d7-a733-4e8d-937d-00da362e6aec
  #07 201 28.7ms id=b73a8267-9791-4ce0-89fb-7c42c8882ffd
  #06 201 37.4ms id=8c2a81d1-9e77-40a1-9867-3c44c59d3587
```

并发 8 × 8 张，8 个请求争 4 个 worker，排队时间计入单请求：

```text
  #05 201 203.9ms id=09778e6b-c44b-428d-a183-42cc2b8c8697
  #01 201 211.5ms id=2b20fdbe-e261-4344-b80e-7199e4e25a12
  #07 201 206.0ms id=0b8eab5d-a58e-43a3-8694-0af1f6cbd282
  #02 201 208.6ms id=916960a2-1b20-42a7-a86d-62485c99cafe
  #04 201 208.4ms id=c400b60e-1d37-4724-b806-e8e220df1d5a
  #08 201 207.8ms id=cb034eb2-6ac4-4c26-a575-0226efd087a8
  #03 201 209.9ms id=3f2a8d34-512e-4a87-8fd9-bf553bea4598
  #06 201 212.9ms id=fa7b53aa-2bd9-4bf8-85a6-70741c0dd767
```

### 2.3 fork 证据，复用而非重建

容器日志中 `Forked sharp worker` 的时间线，本池化构建在每次 fork 打一行 `log` 级日志：

```text
12:23:06  #1    串行场景第 1 张请求
12:24:10  #2 #3 #4 #5    并发 4 场景，一次 fork 4 个
12:25:13  #6 #7 #8 #9    并发 8 场景，一次 fork 4 个
12:26:44  #10   回归脚本第一次转换
fork 总数：10
```

对应关系：

| 观测 | 数字 | 说明 |
|---|---|---|
| 三场景上传总数 | 26 | 10 + 8 + 8 |
| 三场景 fork 总数 | 9 | 串行 1 个、并发 4 个、并发 8 个 |
| 串行 10 张的 fork | 1 | 第 2 到第 10 张全部复用 #1，未重建 |
| 并发 8 的 fork | 4 | 等于池上限，未按请求数 8 个超发 |
| 38 项回归的 fork | 新增 1 | 回归约 30 次转换只新 fork 1 个，其余复用 |
| 容器内 worker 峰值 | 4 | 采样序列与 fork 计数互相印证，从未超过 4 |

正确性对照：每场景结束后脚本取第一张成功上传的图，`GET /i/<id>.png` 后与 fixture 逐像素比较，三场景全部 PASS，响应 200 `image/png`，488 B，200 × 150 × 4 通道。

## 3. 与基线逐项对比

读法：基线数字取自 `benchmark-baseline.md` §5.1 的 run B 主口径；变化率为负数表示池化后更优。

| 场景 | 指标 | 基线 fork 版 | 池化后 | 变化 |
|---|---|---|---|---|
| 串行 10 张 | 成功/失败 | 10/0 | 10/0 | 持平 |
| 串行 10 张 | 总耗时 | 1341.4ms | 348.9ms | -74.0% |
| 串行 10 张 | p50 | 125.4ms | 13.6ms | -89.2% |
| 串行 10 张 | p90 | 128.3ms | 19.8ms | -84.6% |
| 串行 10 张 | p95 | 161.8ms | 169.4ms | +4.7%，首张冷启动 |
| 串行 10 张 | 吞吐 | 7.45 张/s | 28.66 张/s | +285%，约 3.85 倍 |
| 串行 10 张 | worker 峰值 | 1 | 1 | 持平 |
| 串行 10 张 | worker RSS 峰值 | 79.7MB | 81.0MB | +1.6%，单个常驻略高 |
| 串行 10 张 | CPU 秒 | 2.00s | 0.34s | -83.2% |
| 并发 4 × 8 张 | 成功/失败 | 8/0 | 8/0 | 持平 |
| 并发 4 × 8 张 | 总耗时 | 404.0ms | 267.5ms | -33.8% |
| 并发 4 × 8 张 | p50 | 159.5ms | 37.4ms | -76.6% |
| 并发 4 × 8 张 | p90 | 192.6ms | 179.8ms | -6.6% |
| 并发 4 × 8 张 | worker 峰值 | 4 | 4 | 持平，均等于并发数 |
| 并发 4 × 8 张 | CPU 平均核数 | 4.68 | 3.68 | -21.3% |
| 并发 8 × 8 张 | 成功/失败 | 8/0 | 8/0 | 持平 |
| 并发 8 × 8 张 | 总耗时 | 340.1ms | 268.5ms | -21.0% |
| 并发 8 × 8 张 | p50 | 267.5ms | 208.4ms | -22.1% |
| 并发 8 × 8 张 | p90 | 285.7ms | 212.9ms | -25.5% |
| 并发 8 × 8 张 | 吞吐 | 23.52 张/s | 29.79 张/s | +26.7% |
| 并发 8 × 8 张 | worker 峰值 | 8 | 4 | -50%，且等于池上限 |
| 并发 8 × 8 张 | worker RSS 峰值 | 540.4MB | 291.9MB | -46.0% |
| 并发 8 × 8 张 | CPU 秒 | 2.31s | 1.10s | -52.6% |
| 并发 8 × 8 张 | CPU 平均核数 | 6.79 | 4.08 | -39.9% |

要点解读：

1. 串行收益最大，因为 fork 版每张图都要付一次进程创建加模块加载；池化后只有第 1 张付 169.4ms，第 2 到第 10 张稳定在 12.4 到 19.8ms，p50 降 89.2%。
2. 并发 8 的 worker 峰值严格等于 4，与 `min(4, availableParallelism())` 一致；fork 版是 1 比 1，8 个请求 8 个进程。
3. 并发 8 的单请求 p50 从 267.5ms 降到 208.4ms，说明排队并未变成劣化：省下的 fork 成本大于排队等待。
4. 并发 8 的 CPU 平均核数从 6.79 降到 4.08，worker RSS 峰值从 540.4MB 降到 291.9MB，资源削峰明显。
5. 三场景各自都在 62 秒间隔后开始，而空闲 TTL 是 60 秒，所以每场景开头的 worker 都已被回收，各自承担一次冷启动；这是本压测口径的既定条件，与基线口径一致，不是缺陷。真实连续负载下暖池延迟会更低，见第 4 节。

## 4. 补充观测：TTL、失败销毁与补位

### 4.1 空闲 TTL 60 秒回收

| 时点 | 容器内 worker 数 | fork 计数 |
|---|---|---|
| 12:23:06 串行结束 | 1 | 1 |
| 12:24:10 空闲 62 秒后 | 0 | 1，回收期间无新 fork |
| 12:24:10 并发 4 结束 | 4 | 5 |
| 12:25:13 空闲 62 秒后 | 0 | 5 |
| 12:25:13 并发 8 结束 | 4 | 9 |
| 12:26:20 空闲 65 秒后 | 0 | 9 |

TTL 回收正常，且定时器 `unref()` 不影响进程退出，与 design §2.1 一致。

### 4.2 失败销毁与补位，独立复跑

单独起实例验证「worker 侧解码失败 → 销毁 → 400 可读 → 后续按需补位」：

```text
步骤 1 正常上传       HTTP 201，容器 worker 1 个，fork 1
步骤 2 损坏 IDAT 上传 HTTP 400
       响应 data.type=usrvalidation
       message="Failed to decode the image: it appears to be corrupt or unsupported (vipspng: libpng read error)"
       worker 数 1 -> 0，fork 计数仍为 1，即失败 worker 被销毁且未立刻重建
       容器日志 InternalFailure 计数 0，无 500
步骤 3 并发 4 张正常  4 个 HTTP 201，worker 数 0 -> 4，fork 1 -> 5，按需补位成立
```

损坏样本构造方式：取 `base.png` 副本，在其 IDAT 块数据区逐字节加 7 后写回，文件头仍是合法 200 × 150 PNG。

### 4.3 退出清理

| 检查 | 结果 |
|---|---|
| 删除实例前宿主 sharp.worker 进程数 | 4，属于该容器 |
| `docker rm -f picsur-bench-check` 之后 | 0 |
| 18082 端口 | 已释放 |
| 临时库 `picsur_check_pool` | 已 DROP，`pg_database` 计数 0 |
| 临时凭据文件 | 已删除 |
| 8080 现网容器 | `Up 23 hours`，`RestartCount=0`，`StartedAt` 仍为 2026-10-29T13:54:26Z，全程未被触碰 |

### 4.4 回归，38 项全绿

```bash
PICSUR_PSQL="docker exec support-devdb-1 psql -U picsur -d picsur_check_pool" \
PICSUR_FIXTURES=/tmp/picsur-fx \
  bash support/regression-image-api.sh http://127.0.0.1:18082 <临时口令> /tmp/picsur-fx
# 退出码 0
# RESULT: 38 passed, 0 failed
```

补充：这次回归显式设置 `PICSUR_PSQL` 指向临时库，没有回退到 8080 现网容器；回归前 worker 数为 0，回归后为 1、fork 新增 1 个，说明整套回归的转换请求基本都在复用同一个 worker。

## 5. 判定

对照 task-7 的验收口径：

| 验收项 | 目标 | 实测 | 判定 |
|---|---|---|---|
| 串行 p50 明显低于 125.4ms | 明显下降 | 13.6ms，-89.2% | 通过 |
| 并发 8 worker 峰值 | ≤ 4 | 4，fork 计数恰好 4 | 通过 |
| 并发 8 总耗时不劣化 | ≤ 340.1ms | 268.5ms，-21.0% | 通过 |
| 并发 8 p50 不劣化，含排队 | ≤ 267.5ms | 208.4ms，-22.1% | 通过 |
| 像素校验 | 全 PASS | 三场景全 PASS | 通过 |
| fork 次数与复用 | 明显少于请求数 | 26 次上传 9 次 fork | 通过 |
| 回归 | 38 passed 0 failed | 38 passed 0 failed | 通过 |
| 退出无残留 | 0 | 0 | 通过 |
| TTL 65 秒归零 | 0 | 0 | 通过 |
| 无新增环境变量 | 无 | 池化代码无 `process.env` 读取，fork 仍只有原 3 个 env 键 | 通过 |

结论：池化改造的收益与正确性均成立，不存在需要打回的阻断问题；代码层仅有维护性与稳健性建议，见 `verification.md` 第四节。

## 6. 局限与不确定

1. 三场景之间按基线要求各等 62 秒，超过 60 秒 TTL，因此每个场景都从冷池开始；本轮没有测「连续负载下暖池的稳态延迟」，如需可用于下一轮对比。
2. 采样间隔 50ms，短于 50ms 的瞬时 worker 理论上会漏采；但 fork 计数来自容器日志，是权威计数，与采样峰值一致，结论不受影响。
3. 单个 worker 常驻内存略高于 fork 版瞬时峰值，串行场景 worker RSS 从 79.7MB 到 81.0MB；池化后最多 4 个常驻，并发 8 时合计仍显著低于 fork 版 8 个进程的合计。
4. 未做 12 小时以上长稳与内存缓慢增长观测，未覆盖「转换超时超过 15 秒」与「排队超时」的端到端触发，这两项与实现报告 §6 的未完成项一致，代码路径已复核存在。
5. 绝对值只代表本镜像运行时；基线已证明换运行时后绝对值会变，因此本报告只与同配方 run B 对比。

## 附录：raw 证据位置

本轮由 check 子代理生成、未写入任务目录的原始证据，均在宿主 `/tmp`，内容与上文数字一一对应：

| 文件 | 内容 |
|---|---|
| `/tmp/after-serial-10.json` | 串行 10 张完整 JSON：逐请求耗时、worker 采样序列、RSS、cgroup CPU、像素校验 |
| `/tmp/after-conc-4x8.json` | 并发 4 × 8 完整 JSON |
| `/tmp/after-conc-8x8.json` | 并发 8 × 8 完整 JSON |
| `/tmp/after-serial-10.log` 等 | 三场景终端原始输出 |
| `/tmp/regression-after.log` | 38 项回归完整输出，末行 `RESULT: 38 passed, 0 failed` |
| `/tmp/check-dist-manifest.txt` | 复核时重建 dist 的 405 项 sha256 清单，与冻结清单逐行比对用 |

复跑要点：先核对 `/tmp/picsur-pool-dist.sha256` 的 sha256 仍是 `200ba361…c2142`，再用第 1 节命令起实例，端口改成空闲端口，库名换成自己的临时库，收尾 DROP。
