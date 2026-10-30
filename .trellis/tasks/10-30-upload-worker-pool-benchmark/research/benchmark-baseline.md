# Research: 上传转换基线压测（fork-per-conversion）

- Query: 为转换 worker 池化改造采集可复现的 fork 版上传压测基线：串行 10 张，并发 4 × 8 张，并发 8 × 8 张，附转换子进程峰值、实例 CPU、像素一致性校验。
- Scope: mixed，内部源码 + 本机运行环境实测。
- Date: 2026-10-30。
- 角色：研究子代理 baseline-bencher 产出。
- 状态：已完成，三项压测场景与回归均已跑完，压测实例已清理。

## 0. 一句话结论

**本节全部数字都是「fork 版基线」**，对应 git HEAD `5675514`、2026-10-30 11:56:13Z 构建的 `backend/dist` 快照。

主基线口径，生产镜像运行时，fork 版：

| 场景 | 成功/失败 | 总耗时 | p50 | p90 | 吞吐 | worker 峰值 | 容器 CPU |
|---|---|---|---|---|---|---|---|
| 串行 10 张 | 10/0 | 1341.4ms | 125.4ms | 128.3ms | 7.45 张/s | 1 | 2.00s，1.49 核 |
| 并发 4 × 8 张 | 8/0 | 404.0ms | 159.5ms | 192.6ms | 19.80 张/s | 4 | 1.89s，4.68 核 |
| 并发 8 × 8 张 | 8/0 | 340.1ms | 267.5ms | 285.7ms | 23.52 张/s | 8 | 2.31s，6.79 核 |

读法：每次上传都 fork 一个新 `sharp.worker`，worker 峰值与并发数一比一，不受控；并发从 4 提到 8，吞吐只从 19.80 涨到 23.52 张/s（+19%），单请求 p50 从 159.5ms 涨到 267.5ms，worker 瞬时 RSS 从 314MB 涨到 540MB。池化后应重点看串行 p50 的 fork 开销削减、并发 8 时 worker 峰值收敛到池上限、以及并发 8 的总耗时与 CPU 削峰。

## 1. 构建与版本（时点敏感，先读）

- 仓库：`/root/picsur`，分支 `master`。
- HEAD：`5675514e8c65d92f73c3776c6dc2464cac64f1ab`，提交时间 2026-10-30 11:47:36Z，构建前 `backend/` 工作树干净。
- 构建命令，只在 Node 20 容器内，宿主 Node 24 不参与：
  ```bash
  docker run --rm -v /root/picsur:/repo -w /repo/backend node:20-alpine \
    node /repo/backend/node_modules/@nestjs/cli/bin/nest.js build
  ```
  退出码 0，`backend/dist/main.js` 时间戳 2026-10-30 11:56，共 402 个文件。
- 基线构建快照：`/tmp/picsur-baseline-dist`，`.sha256` 清单 `/tmp/picsur-baseline-dist.sha256`，清单自身 sha256 为 `ff27b4c1…3a9da`，生成于 11:56:23Z。
- fork 版关键源文件哈希，构建时点：
  | 文件 | sha256 |
  |---|---|
  | `backend/src/workers/sharp.wrapper.ts` | `d5378695550bdbae87d90f73aa382ada8efe0774932d8ba94bfe5d04184559d5` |
  | `backend/src/workers/sharp/sharp.worker.ts` | `f5186b50521cf8331bd67656f3f13ca8db6c95192962dfdf2ee9bd14c4904232` |
  | `backend/src/managers/image/image-converter.service.ts` | `3781661a04c9c1f46462889a3934bcd98df036bef644d9c9146b939c21bfe5ed` |

### 1.1 backend/dist 被并行重建的监测

实现方并行修改 `backend/src` 并会重建 `backend/dist`。本任务的处理办法是：构建完成后立刻把 `backend/dist` 冻结到 `/tmp/picsur-baseline-dist`，所有压测实例把这个快照只读挂载到容器的 `backend/dist`，因此宿主的 `backend/dist` 之后被重建成什么都不影响已采集的数字。

实测时间线：

| 时点，UTC | 事件 |
|---|---|
| 11:56:13Z | Node 20 容器内构建完成，快照 `ff27b4c1…` |
| 12:00:54Z | 第一次 dist 监测：宿主 dist 与快照一致 |
| 12:06:04Z | 主基线实例启动，dist 监测一致 |
| 12:09:29Z | 场景与首轮回归结束，最后一次自动监测仍一致 |
| 12:10Z | 实现方 src 出现改动：`M backend/src/workers/sharp.wrapper.ts`、新增 `backend/src/workers/sharp/worker-pool.ts` |
| 12:11:42Z | 手工复核：宿主 `backend/dist` 仍是 11:56 构建，与快照一致 |
| 12:12Z | 实现方重建宿主 `backend/dist`，`main.js` 时间戳 12:12，整目录哈希变为 `8c143d74…` |
| 12:12:50Z | 基线实例被删除，采集已完成 |

结论：三个压测场景发生在 12:00:54Z 到 12:08:16Z，全部早于 12:12 的重建；最终的绿色回归复跑在 12:12:01Z 到 12:12:05Z，实例自 12:06 起就只读挂载 11:56 快照，因此所有数字都对应 fork 版构建，未混入池化代码。**如果后续要复跑本基线，必须重新挂载 `/tmp/picsur-baseline-dist`；不能直接跑宿主当前的 `backend/dist`，那已经是池化版本。**

## 2. 压测实例配方

### 2.1 主基线：run B，生产镜像运行时（本报告采用的数字）

| 项 | 值 |
|---|---|
| 容器 | `picsur-bench`，`ghcr.io/zhemed/picsur:allinone`，本地镜像 digest `sha256:3c6bcf7f…17aab`，构建时间 2026-10-29T13:45:02Z |
| 运行时 | 容器内 Node `v20.20.2`，镜像自带自编译 libvips 8.18.7，支持全部 8 种源格式 |
| 代码 | 镜像只提供运行时与依赖，业务代码为 `/tmp/picsur-baseline-dist` 只读挂载到 `/picsur/backend/dist` |
| 网络与端口 | `--network host`，`PICSUR_PORT=18080`；现网 `picsur` 容器占 8080，全程未触碰 |
| 数据库 | dev Postgres 容器 `support-devdb-1`，`127.0.0.1:5432`，临时库 `picsur_bench_img`，用户与口令均为 `picsur` |
| 其他环境变量 | `PICSUR_PRODUCTION=true`、`PICSUR_SYNC_SCHEMA=true`、`PICSUR_STATIC_FRONTEND_ROOT` 取镜像自带 `/picsur/frontend/dist`、临时 `PICSUR_ADMIN_PASSWORD` 与 `PICSUR_JWT_SECRET` |
| 启动命令核心 | `docker run -d --name picsur-bench --network host --env-file /tmp/picsur-bench-img.env -v /tmp/picsur-baseline-dist:/picsur/backend/dist:ro -w /picsur --entrypoint /bin/sh ghcr.io/zhemed/picsur:allinone -c 'exec node backend/dist/main.js'` |

两处与派单文本的偏差，都有实测原因：

1. 派单写的是 `node:20-alpine` 起实例。实测该镜像加载不了本机 `backend/node_modules` 里的原生模块：
   ```
   sharp FAIL Could not load the "sharp" module using the linuxmusl-x64 runtime
   ```
   宿主预装的 sharp 与 qoi-img 是 glibc 产物，alpine 是 musl。构建仍然用 `node:20-alpine`，运行时改用仓库自己的生产镜像 `ghcr.io/zhemed/picsur:allinone`，Node 版本同为 20.20.2，同时具备完整解码器。这个选择还让回归脚本 38 项全绿，见第 7 节。
2. 派单写库名 `picsur`。dev 库 `picsur` 里已有更早会话留下的 admin 账号，`PICSUR_ADMIN_PASSWORD` 只在首次建号时生效，改不了已有口令；为了不重置共享 dev 数据，改在同一个 dev Postgres 上新建一次性库 `picsur_bench_img`，压测结束已 DROP。建库命令：
   ```bash
   docker exec support-devdb-1 psql -U picsur -d picsur -c "CREATE DATABASE picsur_bench_img"
   ```

### 2.2 对照：run A，宿主预编译 sharp 运行时

用于交叉验证脚本与运行时敏感性，不参与主口径：

- 容器 `picsur-bench`，`debian:trixie-slim`，命令 `/repo/.run/node20/bin/node backend/dist/main.js`，`--network host` 端口 18080，挂载 `/root/picsur:/repo` 与冻结的快照 dist，静态目录 `/tmp/picsur-bench-static`，临时库 `picsur_bench`。
- 该运行时用宿主 `backend/node_modules` 的预编译 sharp 0.35.5 / libvips 8.18.7，没有 JXL/JP2 解码器。
- 同一 fork 代码在两种运行时上串行 p50 差约 50%：run A 为 82.3ms，run B 为 125.4ms。**因此 run A 与 run B 的数字不能混用**，池化后压测必须固定用同一配方，建议用 2.1 的生产镜像配方。

## 3. Fixture

生成命令，宿主执行，本机已缓存 `ghcr.io/zhemed/picsur:allinone`，只用本地镜像不联网拉新：

```bash
cd /root/picsur
PICSUR_FIXTURE_NO_PULL=1 node support/make-image-fixtures.cjs /tmp/picsur-fx
```

产物 `/tmp/picsur-fx`，每个格式都是 200 × 150 RGBA：

| 文件 | 说明 |
|---|---|
| `base.png` | 488 B，MD5 `aa5ebcf743db859688ef6eb88e7923e8`，三场景上传都用它 |
| `base.jpg` / `base.webp` / `base.avif` / `base.heif` | 同源 200 × 150 |
| `base.qoi` | 510 B，QOI 主格式源 |
| `base.jxl` / `base.jp2` | 115 B / 748 B，仅回归用 |
| `big-900mp.png` | 167 B，头部声明 30000 × 30000 = 9 亿像素，回归超像素用例用 |

偏差说明：派单要求在容器内生成 fixture。实测宿主 sharp 无法生成 jxl/jp2，而生成脚本的容器回退需要 docker，容器内没有 docker；因此在宿主用脚本的本地镜像回退生成全套，这与脚本设计一致，生成结果完整。

## 4. 压测脚本 `support/bench-upload.cjs`

```bash
node support/bench-upload.cjs --base <url> --token <jwt> --fixtures <dir> \
  --mode serial|concurrent [--count N] [--concurrency C] [--container <name>] \
  [--sample-ms 50] [--json-out <path>] [--keep] [--no-verify]
```

口径定义：

- **单请求耗时**：从发出 `POST /api/image/upload` 到读完响应体的端到端墙钟，包含服务端耗时与网络，客户端不预生成 form 以外的额外工作。
- **P50/P90/P95**：成功请求耗时的近邻秩百分位，`ceil(p/100 × n) - 1`。
- **worker 峰值**：宿主每 50ms 扫 `/proc/*/cmdline`，匹配 `sharp.worker.js`，并用 `/proc/<pid>/cgroup` 过滤到目标容器 id；序列里同时记录主进程 `backend/dist/main.js`。
- **RSS**：同一采样读 `/proc/<pid>/statm`，worker 为存活 worker 之和的峰值，主进程为单进程峰值。
- **容器 CPU**：场景前后各执行一次 `docker exec <c> cat /sys/fs/cgroup/cpu.stat`，取 `usage_usec` 差值，除以场景墙钟得到平均核数，包含主进程和全部 worker。
- **像素一致性**：场景结束后取第一张成功上传的图，`GET /i/<id>.png`，用 sharp 对 fixture 与响应各做 `ensureAlpha().raw()`，比较尺寸、通道数与逐像素缓冲区；同时记录 content-type 与响应字节数。
- **清理**：默认用 `POST /api/image/delete` 删除本场景上传的图，避免 dev 库累积；`--keep` 可保留。
- **限流提醒**：上传路由限 20 请求 / 60 秒 / IP。本任务的三个场景在窗口内都 ≤ 20 次，场景之间 sleep 62 秒等窗口重置；429 会被记为失败，不会静默通过。

三场景实际调用：

```bash
node support/bench-upload.cjs --base http://127.0.0.1:18080 --token "$TOKEN" \
  --fixtures /tmp/picsur-fx --mode serial --count 10 --container picsur-bench
node support/bench-upload.cjs --base http://127.0.0.1:18080 --token "$TOKEN" \
  --fixtures /tmp/picsur-fx --mode concurrent --count 8 --concurrency 4 --container picsur-bench
node support/bench-upload.cjs --base http://127.0.0.1:18080 --token "$TOKEN" \
  --fixtures /tmp/picsur-fx --mode concurrent --count 8 --concurrency 8 --container picsur-bench
```

原始输出副本在 `research/raw/`：`serial-10.log|json`、`concurrent-4x8.log|json`、`concurrent-8x8.log|json`、`runner.log`、`dist-watch.log`、`docker-stats.log`。

## 5. 主基线原始结果，run B

### 5.1 汇总

| 场景 | 成功/失败 | 总耗时 | 最小 | p50 | p90 | p95 | 最大 | 平均 | 吞吐 | worker 峰值 | worker RSS 峰值 | 主进程 RSS 峰值 | CPU 秒 | 平均核数 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 串行 10 张 | 10/0 | 1341.4ms | 122.4ms | 125.4ms | 128.3ms | 161.8ms | 161.8ms | 128.9ms | 7.45 张/s | 1 | 79.7MB | 154.1MB | 2.00s | 1.49 |
| 并发 4 × 8 张 | 8/0 | 404.0ms | 150.5ms | 159.5ms | 192.6ms | 192.6ms | 192.6ms | 172.6ms | 19.80 张/s | 4 | 314.0MB | 155.2MB | 1.89s | 4.68 |
| 并发 8 × 8 张 | 8/0 | 340.1ms | 266.5ms | 267.5ms | 285.7ms | 285.7ms | 285.7ms | 271.4ms | 23.52 张/s | 8 | 540.4MB | 158.6MB | 2.31s | 6.79 |

补充观测：

- 客户端实测在途并发峰值分别为 1 / 4 / 8，与 `--concurrency` 一致，说明并发真的压上去了。
- worker 进程数采样序列，50ms 间隔：串行 `0,1,1,1,1,0,…` 峰 1；并发 4 `0,4,4,0,4,4,4` 峰 4；并发 8 `0,4,8,8,8,0` 峰 8。
- 每个场景结束后的空闲容器内存，`docker stats --no-stream`：92.49MiB / 95.44MiB / 97.08MiB，说明 worker 用完即杀、没有常驻残留。
- 像素校验三场景全 PASS：响应 200 `image/png`，488 B，200 × 150 × 4 通道，与 fixture 逐像素一致。
- 图片清理三场景全成功，各删除 10 / 8 / 8 张，dev 库回到 0 行。

### 5.2 逐请求原始输出

串行 10 张：

```
  #01 201 161.8ms id=6b95a7a6-7f9e-4f3b-995a-2fa71999e37c
  #02 201 122.4ms id=9b6b7fd4-8958-4ca0-9bcd-9adbe8ee661c
  #03 201 128.3ms id=4a0c1431-43d5-495e-b70e-82ea9c1555f8
  #04 201 122.4ms id=fb384d1f-7b41-42ba-ab64-407ffc54b70a
  #05 201 126.7ms id=c6d085cf-8720-4cac-a720-74dde6261f83
  #06 201 122.4ms id=ca27f5f2-7141-45ab-aa7f-d78a12be5df3
  #07 201 125.4ms id=0e415388-4111-4f0e-997a-5856ed120106
  #08 201 128.0ms id=f2c0c1b7-f374-4e5f-ad9c-0c08971e2511
  #09 201 122.7ms id=b6d45ba8-be4b-4c5e-950d-7aeaa0c6649f
  #10 201 123.4ms id=67e882bf-9642-46f1-a90f-dba2abd5d7eb
```

并发 4 × 8 张，输出顺序为完成顺序：

```
  #01 201 192.6ms id=a9ed14fe-ae98-4067-bbca-063c43f31de2
  #04 201 189.3ms id=f08873d4-2ee7-44e0-bba7-07c1300744a5
  #02 201 191.4ms id=76521274-4f83-43d1-9550-285bd15aa547
  #03 201 191.9ms id=fabc1bdc-8dbc-466b-9bb9-dc99de458141
  #07 201 150.9ms id=75d2a22d-51ba-466a-a241-84d569c9ddc3
  #08 201 150.5ms id=6bcc0065-dbe3-4435-b780-040603114f8d
  #05 201 154.7ms id=06be5708-91c1-463e-baca-c2b784d0e446
  #06 201 159.5ms id=1894b4f8-01a5-48a5-8f11-9d9a1f9a0cea
```

并发 8 × 8 张：

```
  #01 201 269.5ms id=4bde408e-87ea-4a08-8e39-a1c5f213ff94
  #03 201 266.5ms id=d4ccdb27-f0a8-4c5c-8b2b-9acaa42a05b6
  #02 201 267.5ms id=0c8362df-9b6f-4703-9e08-29ff83949b91
  #05 201 266.8ms id=6b50a38c-303d-4ce3-9ff4-80b8586f9f9e
  #06 201 267.2ms id=4e33302d-c38c-4dbd-ab7d-b3d12c15512d
  #07 201 269.1ms id=552a2385-f861-46dc-ab80-62ced16b3601
  #08 201 279.1ms id=27bf3493-d83e-4492-bfb7-172a1fabaf5b
  #04 201 285.7ms id=3d76a2dc-6548-4246-8893-69db0c178f43
```

### 5.3 基线特征解读，供池化对比

1. **串行稳态约 122 到 128ms**，首张 161.8ms 是进程内冷启动，主要成本是每次 fork 一个 Node 子进程、加载 sharp 与 qoi-img 模块、握手 ready、转换、finish、kill。
2. **worker 数与并发数一比一**：1 / 4 / 8，没有任何上限；池化后并发 8 的 worker 峰值应收敛到池上限 4。
3. **并发 4 到并发 8 已进入收益递减**：吞吐 19.80 → 23.52 张/s，仅 +19%，而 p50 从 159.5 涨到 267.5ms，CPU 从 4.68 核涨到 6.79 核，worker 瞬时 RSS 从 314MB 涨到 540MB。说明超过 4 个并发 fork 后，额外并行主要转化为启动开销与资源争抢，而不是吞吐。
4. **并发 8 的总耗时 340.1ms 小于并发 4 的 404.0ms**，因为并发 4 要排两轮、每轮都要付一次 fork 启动成本；并发 8 一轮完成。池化后并发 8 若排队，排队时间要计入单请求耗时，需单独观察。
5. 三场景失败数均为 0，像素校验全部一致，说明 fork 版功能面正常，基线可作为行为对照组。

## 6. 对照 run A 结果，宿主预编译 sharp 运行时

| 场景 | 成功/失败 | 总耗时 | p50 | p90 | 最大 | 吞吐 | worker 峰值 | worker RSS 峰值 | CPU 秒 | 平均核数 |
|---|---|---|---|---|---|---|---|---|---|---|
| 串行 10 张 | 10/0 | 943.0ms | 82.3ms | 100.7ms | 128.4ms | 10.60 张/s | 1 | 68.9MB | 1.43s | 1.52 |
| 并发 4 × 8 张 | 8/0 | 305.1ms | 116.1ms | 143.0ms | 143.0ms | 26.22 张/s | 4 | 268.9MB | 1.37s | 4.51 |
| 并发 8 × 8 张 | 8/0 | 248.0ms | 181.8ms | 193.3ms | 193.3ms | 32.26 张/s | 8 | 460.7MB | 1.64s | 6.62 |

这组数字只能用来证明「同一份 fork 代码换运行时后绝对值会变」，不能与 run B 混比。run A 更快的原因没有进一步归因，可能是预编译 sharp 与自编译 libvips 在 PNG 解码路径上的差异，也可能是镜像内依赖版本较发布版。**结论：池化前后必须同配方对比，建议统一用 2.1 的 run B 配方。**

## 7. 回归结果

回归脚本：`support/regression-image-api.sh`，38 项。

主基线 run B，生产镜像运行时，最终结果 **38 项通过，0 项失败**：

```bash
cd /root/picsur
PICSUR_PSQL="docker exec support-devdb-1 psql -U picsur -d picsur_bench_img" \
PICSUR_FIXTURES=/tmp/picsur-fx \
  bash support/regression-image-api.sh http://127.0.0.1:18080 "<临时 admin 口令>" /tmp/picsur-fx
# RESULT: 38 passed, 0 failed
```

完整输出：`research/raw/regression-green.log`。

两点必须记录：

1. **首次在场景串联脚本里跑回归得到 36 通过 / 2 失败**，两项都在第 9 节「无尺寸旧行」检查。原因是我的运行脚本里 `PICSUR_PSQL` 沿用了 run A 的 `picsur_bench`，而实例实际连 `picsur_bench_img`，更新写到了另一个库；把目标库改对后 38 项全绿。这是压测脚本配置问题，不是产品缺陷。原始失败日志保留在 `research/raw/regression.log`。
2. **安全提醒：跑回归必须显式设置 `PICSUR_PSQL` 指向压测用的临时库。** 脚本在没有该变量时会自动 `docker ps | grep -i picsur` 找容器并写库，本机上会命中 8080 的现网 `picsur` 容器，等于往现网数据库写测试行。本任务全程显式指向临时库，现网容器与数据未被触碰。

对照 run A，宿主预编译 sharp 运行时：34 通过 / 4 失败。4 项失败全部是 JXL/JP2 解码器缺失，即 `/i/<id>.jxl`、`/i/<id>.jp2` 转码各 1 项，加 `.jxl`、`.jp2` 源格式上传各 1 项。回归脚本头部已注明这是「宿主预编译 sharp 没有这两个解码器」的已知环境差异，不是回归。日志：`research/raw/regression-prebuilt-runA.log`。

## 8. 观测方法与口径局限

- 延迟是客户端端到端墙钟，包含网络与客户端开销；三场景都在同一台宿主、同一实例上跑，没有跨机噪声。
- worker 采样 50ms 一次，并用容器 cgroup 过滤，不会数到现网 8080 的 worker。并发 8 场景捕获到峰值 8，说明采样密度足够；但短于 50ms 的瞬时 worker 理论上可能漏采，本项目单 worker 存活约 100ms 以上，不构成问题。
- 容器 CPU 来自 cgroup v2 `cpu.stat` 的 `usage_usec` 差值，包含主进程与所有 worker，是整段场景的平均核数；场景之间实例空闲 62 秒等限流窗口，不影响数字。
- 宿主 16 逻辑 CPU，实例容器无 CPU 配额，与生产运行时一致；压测期间另外两个容器 `picsur` 与成对服务空闲，没有制造负载。
- 三场景之间为避开上传限流各等待 62 秒；等待窗口内实例空闲，不会累积 worker 或内存。
- 串行 10 张没有剔除首张冷启动，池化后对比也必须用同样口径，否则会低估基线。
- 本基线只覆盖「上传 200 × 150 PNG，服务端转 QOI 主格式」这一条主路径；缩略图参数、格式转码、错误路径由回归覆盖，未纳入计时。

## 9. 复现步骤

```bash
# 1. Node 20 容器内构建当前 fork 版
docker run --rm -v /root/picsur:/repo -w /repo/backend node:20-alpine \
  node /repo/backend/node_modules/@nestjs/cli/bin/nest.js build

# 2. 冻结构建产物，后续任何并行重建都不影响基线
rm -rf /tmp/picsur-baseline-dist
cp -a backend/dist /tmp/picsur-baseline-dist
(cd /tmp/picsur-baseline-dist && find . -type f -print0 | sort -z | xargs -0 sha256sum) \
  > /tmp/picsur-baseline-dist.sha256

# 3. fixture，只用本地镜像，不联网
PICSUR_FIXTURE_NO_PULL=1 node support/make-image-fixtures.cjs /tmp/picsur-fx

# 4. 临时库与临时凭据，只放 /tmp，权限 600
docker exec support-devdb-1 psql -U picsur -d picsur -c "CREATE DATABASE picsur_bench_img"
PW=$(openssl rand -hex 12); JWT=$(openssl rand -hex 24)
cat > /tmp/picsur-bench-img.env <<EOF
PICSUR_DB_HOST=127.0.0.1
PICSUR_DB_PORT=5432
PICSUR_DB_USERNAME=picsur
PICSUR_DB_PASSWORD=picsur
PICSUR_DB_DATABASE=picsur_bench_img
PICSUR_PRODUCTION=true
PICSUR_SYNC_SCHEMA=true
PICSUR_PORT=18080
PICSUR_ADMIN_PASSWORD=$PW
PICSUR_JWT_SECRET=$JWT
EOF
chmod 600 /tmp/picsur-bench-img.env

# 5. 实例：生产镜像运行时 + 冻结 dist 挂载
docker rm -f picsur-bench 2>/dev/null
docker run -d --name picsur-bench --network host --env-file /tmp/picsur-bench-img.env \
  -v /tmp/picsur-baseline-dist:/picsur/backend/dist:ro \
  -w /picsur --entrypoint /bin/sh ghcr.io/zhemed/picsur:allinone \
  -c 'exec node backend/dist/main.js'

# 6. 登录拿 token
TOKEN=$(curl -s -X POST http://127.0.0.1:18080/api/user/login \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"admin\",\"password\":\"$PW\"}" \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).data.jwt_token))")

# 7. 三场景，每步间隔 62 秒避开上传限流
node support/bench-upload.cjs --base http://127.0.0.1:18080 --token "$TOKEN" \
  --fixtures /tmp/picsur-fx --mode serial --count 10 --container picsur-bench
sleep 62
node support/bench-upload.cjs --base http://127.0.0.1:18080 --token "$TOKEN" \
  --fixtures /tmp/picsur-fx --mode concurrent --count 8 --concurrency 4 --container picsur-bench
sleep 62
node support/bench-upload.cjs --base http://127.0.0.1:18080 --token "$TOKEN" \
  --fixtures /tmp/picsur-fx --mode concurrent --count 8 --concurrency 8 --container picsur-bench
sleep 65

# 8. 回归，必须显式指向临时库
PICSUR_PSQL="docker exec support-devdb-1 psql -U picsur -d picsur_bench_img" \
PICSUR_FIXTURES=/tmp/picsur-fx \
  bash support/regression-image-api.sh http://127.0.0.1:18080 "$PW" /tmp/picsur-fx

# 9. 收尾
docker rm -f picsur-bench
docker exec support-devdb-1 psql -U picsur -d picsur \
  -c "DROP DATABASE IF EXISTS picsur_bench_img"
rm -f /tmp/picsur-bench-img.env
```

## 10. 偏差、风险与不确定

| 项 | 派单要求 | 实际做法 | 原因 |
|---|---|---|---|
| 压测实例基础镜像 | `node:20-alpine` | 生产镜像 `ghcr.io/zhemed/picsur:allinone`，Node 20.20.2 | alpine musl 加载不了 glibc 预编译 sharp/qoi-img 原生模块 |
| 压测库名 | `picsur` | 同一 dev Postgres 上的临时库 `picsur_bench_img` | dev 库已有 admin 账号，口令只能首次建号设置，避免重置共享数据 |
| `PICSUR_PRODUCTION` | `false` | `true` | 回归脚本第 1 项要求 `/api/info` 的 `production` 为 true；生产模式只影响日志级别与内置账号初始化，schema 同步由 `PICSUR_SYNC_SCHEMA=true` 显式控制 |
| fixture 生成位置 | 容器内 | 宿主执行，脚本本地镜像回退生成 jxl/jp2 | 容器内没有 docker，无法回退拉镜像；宿主生成产物完整 |
| 构建产物覆盖 | 并行重建风险 | 构建后冻结 dist 快照，实例只读挂载 | 实现方 12:12Z 重建了宿主 dist，基线数字仍对应 11:56 快照 |
| 写入范围 | 只写 `support/bench-upload.cjs` 与任务 research | 遵守；`backend/dist` 构建副作用已由实现方重建覆盖 | 未改 backend/src，未 commit |

风险与不确定：

1. **运行时敏感性大**：同一份 fork 代码，run A 与 run B 串行 p50 差 82.3 对 125.4ms。池化后压测如果换了实例配方，数字会不可比。建议统一 run B 配方，并让 check 子代理核对实例镜像 digest、挂载 dist 的哈希与 node 版本。
2. **镜像内依赖版本**：run B 用镜像自带的发布版 `node_modules`，与仓库 HEAD 的 lockfile 不一定逐字一致；fork 与池化两次压测都用同一镜像，因此对前后对比公平，但绝对值不代表宿主 HEAD 依赖下的绝对值。
3. **实现方随时可重建 dist**：基线已冻结，但后续任何复跑若忘了挂载快照，会跑成池化版；复跑前先核对 `/tmp/picsur-baseline-dist.sha256` 与 `backend/dist` 的哈希。
4. **首次回归 2 项失败的归因**：已定位为压测运行脚本的 `PICSUR_PSQL` 配错库，不是产品缺陷，但仍建议 check 子代理在干净环境独立复跑一次 38 项。
5. 未测多张不同格式混合上传、缩略图参数与错误路径的耗时，这些如有需要应单独建场景。

## 11. 给实现方与 check 的建议

1. **池化后压测直接用本报告第 9 节命令**，只把第 2 步换成实现方新构建的 dist，并把第 5 步挂载改成新 dist 目录；其余参数、fixture、场景与等待时间保持不变。
2. 对比重点：串行 p50 应从约 125ms 明显下降；并发 8 的 worker 峰值应 ≤ 4，容器 CPU 平均核数应从 6.79 下降；并发 8 的总耗时与单请求 p50 至少不应劣化，排队时间应体现在单请求耗时里单独报。
3. 每次压测都记录 worker 峰值、worker RSS 峰值、容器 CPU 与像素校验；并发 8 场景 peak 必须等于池上限而非常驻进程数，这是验收项。
4. 退出实例后确认没有残留 `sharp.worker`，本次基线实测场景结束后宿主侧 worker 进程数为 0。
5. check 子代理：核对 `research/raw/` 的三份 JSON 与日志、`support/bench-upload.cjs` 的口径注释、以及本文第 1 节的快照哈希，再对 `benchmark-after.md` 做同口径复核。

## 12. 收尾与清理证据

- 12:12:50Z 删除压测容器 `picsur-bench`。删除后复查：宿主 `sharp.worker` 进程数 0，18080 端口释放，没有残留转换子进程。
- 12:14:14Z 终态复核：`picsur-bench` 不存在；18080 空闲；临时库 `picsur_bench` 与 `picsur_bench_img` 均已 DROP，dev Postgres 的库列表回到压测前；含临时管理员口令与 JWT 的 `/tmp` 环境文件与 token 已删除。
- 现网 `picsur` 容器在 8080 上全程 Up 22 hours，未重启、未写入；本任务所有回归写库操作都显式指向临时库。
- 12:14Z 观察到的 4 个 `sharp.worker` 进程属于实现方并行启动的 `picsur-bench-pool` 容器，已按 `/proc/<pid>/cgroup` 与容器 id 核对归属，不是本基线的残留。
- `support/bench-upload.cjs` 权限已设为 644；本任务未执行任何 git 提交。

## 附录：raw 证据清单，`research/raw/`

| 文件 | 内容 |
|---|---|
| `serial-10.log` / `serial-10.json` | 主基线串行场景原始逐请求输出与完整 JSON |
| `concurrent-4x8.log` / `concurrent-4x8.json` | 主基线并发 4 场景 |
| `concurrent-8x8.log` / `concurrent-8x8.json` | 主基线并发 8 场景 |
| `serial-10.json` 等 | 含逐请求耗时、起始偏移、worker 采样序列、RSS 峰值、cgroup CPU、像素校验结果 |
| `runner.log` | 三场景串联运行日志，含时点、dist 监测、docker stats |
| `dist-watch.log` | 构建覆盖监测记录 |
| `docker-stats.log` | 每场景后的空闲内存快照 |
| `regression.log` | run B 首次回归，36 通过 / 2 失败，压测脚本配错库所致 |
| `regression-green.log` | run B 最终回归，38 通过 / 0 失败 |
| `regression-prebuilt-runA.log` | run A 回归，34 通过 / 4 失败，JXL/JP2 已知环境差异 |
