# Research: 上传链路的运行时、部署层与前端上传行为

- Query: 用户感觉图片上传「像是单核串行运行」，只读调查运行时与部署层、前端上传行为，佐证或反驳「单核」判断
- Scope: mixed，仓库源码 + 只读服务器与容器事实 + sharp/libuv 官方文档
- Date: 2026-10-30
- Task: task-2，目录 `.trellis/tasks/10-30-investigate-upload-concurrency`
- 只读声明: 本轮未修改仓库源码与配置，未发起上传请求，未 docker exec，未修改任何容器状态；调研笔记只写入本文件。

## 1. 结论一句话

结论：上传链路不是「单核串行」——运行时侧是 16 逻辑 CPU、容器无任何 CPU 配额的 all-in-one 单容器，单 Node 进程负责请求，每张图的处理 fork 一个转换子进程，默认主格式 QOI 的编解码是 qoi-img 原生插件同步调用、worker 内单线程，其它格式的解码与转码才走 sharp 与 libvips 线程池，跨图片靠多进程并行，后端没有单核事实；但浏览器侧严格一次一张、串行 await，多选、拖多张、粘贴多张都只上传第一张，所以批量时耗时线性叠加的「串行体感」成立，来源是前端而不是 CPU。

总体判定：部分。前端串行体感成立，后端单核事实不成立。

## 2. 证据

### 2.1 部署形态：单容器 all-in-one 是唯一部署方式，compose 已退役

- `README.md:6-14` 写明「部署（唯一方式）」是一条 `docker run`，镜像 `ghcr.io/zhemed/picsur:allinone`，命令里没有 `--cpus`、没有 `--memory`、没有 `--pids-limit`。
- `docs/MAINTAINING.md:5-13` 是同一条唯一部署命令，数据目录以 `-v ./data:/data` 挂载。
- 仓库当前没有 `docker-compose.yml` 与 `install.sh`：`ls docker-compose.yml install.sh` 对两者都返回 `No such file or directory`。compose 的删除发生在 commit `6fc28d9 chore: slim the repo to a single path`，该 commit 的说明写明 `Removes docker-compose.yml (the retired compose deployment shape)...`，diffstat 含 `docker-compose.yml | 100 -----`。
- `.trellis/spec/picsur-backend/backend/build-and-deploy.md:482` 的 all-in-one 契约写明「单副本（一个 `/data` 一个 postmaster）」。
- 运行中的容器就是 all-in-one 镜像：`docker inspect` 显示 `Image=ghcr.io/zhemed/picsur:allinone`，镜像 `Created=2026-10-29T13:45:02Z`，容器 `Image ID=sha256:3c6bcf7f...`；挂载是 `bind /root/picsur-data -> /data` 与 `bind /var/run/docker.sock -> /var/run/docker.sock`。docker.sock 挂载用于面板自升级，与本问题无关。

### 2.2 进程模型：单 Node 进程，无 cluster、无 pm2、无 replicas；转换走 fork 子进程

- `backend/src/main.ts:19-60`：bootstrap 只创建一次 Nest/Fastify 应用并 `app.listen` 一次，没有 cluster 分支。
- 在跟踪文件中搜索 `replicas|pm2|cluster|worker_threads`，唯一命中是旧任务归档 `.trellis/tasks/archive/2026-10/10-13-dep-security-upgrade/research/t0-deviations.md:176`，属历史笔记而不是运行代码；后端源码没有 cluster、pm2、worker_threads。
- `docker top picsur` 只看到 tini、入口 shell、postgres 及其后台进程、单个 node 进程：

```
PID      PPID     COMMAND
1836704  1836679  /sbin/tini -- /usr/local/bin/picsur-allinone-entrypoint node backend/dist/main.js
1836775  1836704  /bin/sh /usr/local/bin/picsur-allinone-entrypoint node backend/dist/main.js
1836806  1836775  postgres -D /data/postgres -c listen_addresses=127.0.0.1 -c port=5432 ...
1836855  1836775  node backend/dist/main.js
```

- 转换不在这个 node 主进程里跑：`backend/src/managers/image/image-converter.service.ts:84` 每次转换 `new SharpWrapper(timeLimitMS, memLimit)`；`backend/src/workers/sharp.wrapper.ts:36-40` 指向 `sharp.worker.js`，`:54-65` 用 `child_process.fork` 为每次转换起一个子进程；结束或超时后由 `:86-91`、`:231-235` 杀掉。
- 子进程有独立内存上限：`backend/src/workers/sharp/sharp.worker.ts:39-56` 用 `posix.js` 的 `setrlimit` 把 data 段限制到 `MEMORY_LIMIT_MB` MB。
- 转换时间上限：`sharp.wrapper.ts:158-174` 的 pTimeout 加上 fork 的 `timeout` 选项，默认值来自系统首选项 `conversion_time_limit=15s`，见 `backend/src/collections/preference-db/preference-defaults.service.ts:47-48`。

### 2.3 CPU 与内存事实：宿主机 16 逻辑 CPU，容器无任何配额

调查 shell 不在容器内，因此 `nproc`、`free` 是宿主机事实；容器事实来自 docker inspect/top/stats。以下宿主机与容器快照的采集时点约 11:29，时变数值在不同时点会有正常波动。

```
ls -la /.dockerenv
ls: cannot access '/.dockerenv': No such file or directory
head -1 /proc/1/cgroup
0::/init.scope
```

宿主机命令原文：

```
nproc
16

grep -c '^processor' /proc/cpuinfo
16

grep -m1 'model name' /proc/cpuinfo
model name	: 12th Gen Intel(R) Core(TM) i7-12700

free -m
               total        used        free      shared  buff/cache   available
Mem:           11957        8075         237           7        3644        3547
Swap:          16383        7648        8735

uptime
 11:29:51 up 10 days, 17:05,  0 users,  load average: 0.56, 0.41, 0.20
```

容器命令原文：

```
docker inspect --format 'NanoCpus={{.HostConfig.NanoCpus}} CpuQuota={{.HostConfig.CpuQuota}} CpuPeriod={{.HostConfig.CpuPeriod}} CpuShares={{.HostConfig.CpuShares}} CpusetCpus={{.HostConfig.CpusetCpus}} Memory={{.HostConfig.Memory}} MemorySwap={{.HostConfig.MemorySwap}}' picsur
NanoCpus=0 CpuQuota=0 CpuPeriod=0 CpuShares=0 CpusetCpus= Memory=0 MemorySwap=0

docker info --format 'NCPU={{.NCPU}} MemTotal={{.MemTotal}}'
NCPU=16 MemTotal=12538286080

docker stats --no-stream --format '{{.Name}} CPU={{.CPUPerc}} MEM={{.MemUsage}}' picsur
picsur CPU=0.00% MEM=105.1MiB / 11.68GiB
```

- 容器没有 CPU 配额：`NanoCpus=0`、`CpuQuota=0`、`CpuPeriod=0`、`CpuShares=0`、`CpusetCpus` 为空，因此容器可调度到宿主机全部 16 个逻辑 CPU。
- 容器没有内存配额：`Memory=0`、`MemorySwap=0`。
- 宿主机负载不高：load average 0.56 / 0.41 / 0.20，picsur 空闲时 CPU 0.00%、内存 105.1MiB。
- 宿主机内存偏紧：总 11957MB，可用 3547MB，swap 已用 7648MB。这是潜在风险，不是「单核」证据。
- 宿主机还跑着其它容器：`docker ps` 当时共 8 个，包括其它图床与数据库；本轮不把它们的负载归因到 picsur。

### 2.4 运行时参数：没有 NODE_OPTIONS、没有 UV_THREADPOOL_SIZE、没有 --max-old-space-size

- 在仓库源码与部署文件范围内搜索 `UV_THREADPOOL_SIZE|NODE_OPTIONS|max-old-space-size`，只命中 `backend/src/workers/sharp.wrapper.ts:62` 的 `NODE_OPTIONS: '--no-warnings'`，而且只设给 fork 的转换子进程。
- `Dockerfile`、`Dockerfile.allinone`、`support/allinone-entrypoint.sh` 对这三个变量的 grep 无输出。
- 运行容器 Env 摘录，无 NODE_OPTIONS 与 UV_THREADPOOL_SIZE：

```
NODE_VERSION=20.20.2
PICSUR_PRODUCTION=true
PICSUR_HOST=0.0.0.0
PICSUR_PORT=8080
PICSUR_DB_HOST=127.0.0.1
PICSUR_STATIC_FRONTEND_ROOT=/picsur/frontend/dist
PICSUR_MAX_FILE_SIZE=128000000
PICSUR_TELEMETRY=false
PICSUR_VERBOSE=false
PICSUR_DATA_DIR=/data
```

- 启动命令无 node 参数：`Dockerfile.allinone:74-75` 是 tini + 入口脚本 + CMD `node backend/dist/main.js`；`support/allinone-entrypoint.sh:322` 同样是 `set -- node backend/dist/main.js`；`backend/package.json:16` 的 `start:prod` 是 `node dist/main`。
- 默认值：libuv 文档写明线程池默认 4，可在启动时用 `UV_THREADPOOL_SIZE` 改写，最大 1024。Node 进程实测 `Threads=11`、`VmRSS=85784 kB`，`/proc/1836855/cmdline` 是 `node backend/dist/main.js`；采集时点约 11:29，与未覆盖默认值一致。
- 关键细节：`sharp.wrapper.ts:57-63` 的 fork 显式传了 `env`，其中只有 `MEMORY_LIMIT_MB`、`MAX_IMAGE_PIXELS`、`NODE_OPTIONS` 三个键；按 Node `child_process.fork` 的 `env` 选项语义，显式 env 就是子进程的完整环境，因此即使将来在容器级加 `UV_THREADPOOL_SIZE` 或 `VIPS_CONCURRENCY`，也到不了转换子进程，只能改代码。
- 主进程里也有一处 sharp 调用：`image-converter.service.ts:192-197` 在上传时用 `sharp(...).metadata()` 读尺寸做像素上限预检。sharp 的异步任务排队等 libuv 线程池，所以主进程这一步的并行度受默认 4 线程池约束；它每张图只一次、耗时很短，不是主要瓶颈，但属于确认的机制事实。

### 2.5 图片处理库：sharp 0.35.5，镜像内是源码构建并链接自编译 libvips 8.18.7

- `backend/package.json:62` 依赖 `sharp ^0.35.5`；`pnpm-lock.yaml:6227` 与 `:13427-13457` 解析到 `sharp@0.35.5`，并带 `@img/sharp-linux-x64@0.35.5`、`@img/sharp-libvips-linux-x64@1.3.4` 等平台包。
- 生产镜像不是用预编译 sharp：`Dockerfile:139-144` 注释写明 sharp >=0.33 只装预编译 `@img/sharp-*`，其内置精简 libvips 不含 JPEG-XL / JPEG2000，所以镜像里显式跑了一次源码构建 `SHARP_FORCE_GLOBAL_LIBVIPS=1 NODE_PATH=/usr/local/lib/node_modules node install/build.js`。
- 镜像内 libvips 是自编译 8.18.7：`Dockerfile:69-94` 用 meson 源码构建，`:87-89` 下载并校验 `vips-8.18.7.tar.xz` 的 sha256。
- 官方并发语义：sharp 文档 concurrency 一节写明 libvips 为每张图创建的线程数默认等于 CPU 核数，glibc 且无 jemalloc 的 Linux 默认是 1，传 0 恢复默认；`node_modules/.pnpm/sharp@0.35.5_@types+node@22.8.4/node_modules/sharp/lib/index.d.ts:105-107` 还写明同时并行的图片数受 libuv `UV_THREADPOOL_SIZE` 限制。原文档链接 https://sharp.pixelplumbing.com/api-utility/
- 本镜像基于 Alpine 3.23 musl，`Dockerfile` 未安装 jemalloc，因此 glibc 无 jemalloc 的例外条款不适用，推断非 QOI 的 sharp/libvips 编解码可用多线程、默认线程数约等于 16。此点为推断，未在容器内实测，见第 5 节。
- 单张图线程口径补正：默认主格式是 QOI。QOI 作为源时，解码走 `backend/src/workers/sharp/universal-sharp.ts:24-30` 与 `:60-71` 的 `qoiSharpIn`，内部调 `qoi-img` 的 `QOIdecode`；上传后转主格式时，编码走 `universal-sharp.ts:119-121` 与 `:159-174` 的 `qoiSharpOut`，内部调 `QOIencode`。两者都是 `qoi-img` 原生插件的同步调用，不经过 libvips 线程池，worker 内编码是单线程；`qoiSharpOut:160` 的 `raw().toBuffer()` 仍由 sharp 取像素。`qoi-img` 是原生插件，见 `node_modules/.pnpm/qoi-img@2.2.0/node_modules/qoi-img/dist/index.js:24-30` 的 `require('bindings')('qoixx_addon')`。跨图片并行仍靠每次转换一个子进程。
- 注意区分：宿主仓库 `node_modules` 是开发安装，带预编译 `@img/sharp-linux-x64@0.35.5` 与 `@img/sharp-libvips-linux-x64@1.3.4`；它不代表镜像里实际运行的那份 sharp。

### 2.6 配置项：没有并发、worker、queue、threads、cpus 键；相关上限如下

- 在 `backend/src` 与 `shared/src` 搜索 `concurren|worker|queue|thread|cpu` 后，除转换子进程相关注释外，只剩 `backend/src/managers/usage/usage.service.ts:155` 的 `cpu_count: os.cpus().length`，以及 `backend/src/managers/update/self-update.service.ts:888-893` 对 HostConfig 字段的透传，后者是自升级重建容器时保留 NanoCpus/CpuShares 等值，不是应用并发调优项。
- 环境变量全集按 `PICSUR_` 前缀 grep 归类为 `ADMIN_PASSWORD`、`DB_*`、`HOST/PORT`、`JWT_*`、`MAX_FILE_SIZE`、`MAX_IMAGE_PIXELS`、`MAX_DERIVATIVES_PER_IMAGE`、`PRODUCTION`、`SYNC_SCHEMA`、`STATIC_FRONTEND_ROOT`、`TELEMETRY`、`VERBOSE`、`DEMO*`、`REDIS_URL`、`UPDATE_*`、`ALLOW_SELF_UPDATE`、`DOCKER_SOCKET`、`DATA_DIR`；其中没有任何 cpus、threads、worker、queue、concurrency 键。
- 与并发最相关的是下列资源上限，全部是阈值而不是并发度：

| 键 | 默认值 | 证据 |
|---|---|---|
| `PICSUR_MAX_FILE_SIZE` | 128000000 字节 | `backend/src/config/early/multipart.config.service.ts:14-19`；容器已显式设置同名值 |
| `PICSUR_MAX_IMAGE_PIXELS` | 268402689，等于 0x3FFF 的平方 | `shared/src/util/image-pixel-limit.ts:12-16`；容器未设置，取默认 |
| `PICSUR_MAX_DERIVATIVES_PER_IMAGE` | 100 | `backend/src/config/early/image.config.service.ts:9-12`；容器未设置 |
| `conversion_time_limit` | 15s | `preference-defaults.service.ts:47`；DB 系统首选项，不是 env |
| `conversion_memory_limit` | 512MB | `preference-defaults.service.ts:48`；DB 系统首选项，不是 env |

- 两个转换上限不是面板可改项：`shared/src/dto/sys-preferences.enum.ts:41-49` 的暴露列表只有 5 项，不含这两个 conversion 项；`build-and-deploy.md:100-112` 记录了这个决定。
- 限流不是并发限制：全局 60 次/60 秒，见 `backend/src/layers/PicsurLayers.module.ts:10-20`；上传路由再加 20 次/60 秒，见 `backend/src/routes/image/image-manage.controller.ts:61` 与 `backend/src/decorators/easy-throttle.decorator.ts:12-21`。它只会挡住高频请求，不会把并发压成 1。
- 没有队列：`backend/src` 与 `shared/src` 没有 p-limit、p-queue、bullmq、piscina 的引用；`pnpm-lock.yaml:5572`、`:5576`、`:5742`、`:12699`、`:12703`、`:12886` 里的 p-limit 与 piscina 都是传递依赖。上传处理直接在当前请求的 Promise 里 await 转换，没有入队。
- DB 连接池没有显式配置：`backend/src/config/early/type-orm.config.service.ts:51-74` 只设置 type、synchronize、migrationsRun、entities、migrations、useUTC 与连接信息，没有 extra 或 pool 字段，因此使用 pg 驱动默认值，本轮未实测该默认数字。
- env 变量三处同步的约定位置：`build-and-deploy.md:255-263` 的 §7.3 写明三处同步 = `.env.example`、`docker-compose.yml`、本 spec 的 §3.1 契约表。
- 但 compose 已删除，这个「三处」现在只剩两处可写：仓库无 `docker-compose.yml`；`.env.example:3` 与 `:20-24` 仍写着 compose 用法；`.env.example:28-35` 仍列出 MAX_FILE_SIZE、MAX_IMAGE_PIXELS、MAX_DERIVATIVES_PER_IMAGE。all-in-one 的实际默认值现在写在 `Dockerfile.allinone:52-64`，运行时由 `support/allinone-entrypoint.sh` 追加 `DB_*` 与口令类变量。这是文档漂移，本轮只记录不改。

### 2.7 前端上传并发行为证据

- 上传控件是单文件：`frontend/src/app/routes/upload/upload.component.html:3` 的 `<input type="file" fileInput [formControl]="fileControl" />` 没有 `multiple` 属性。
- 选择逻辑来自 `@ngx-dropzone/cdk`：该依赖的 FileInputDirective 用 `get multiple() { return this.elementRef.nativeElement.multiple; }` 读原生属性，没有 multiple 就按单选处理，见 `node_modules/.pnpm/@ngx-dropzone+cdk@21.1.0_*/node_modules/@ngx-dropzone/cdk/fesm2022/ngx-dropzone-cdk.mjs:192-193`；随后的 `_handleChange` 在 `:266` 取 `fileList.item(0)`，拖拽入口 `handleFileDrop` 在 `:278` 取 `files[0]`。
- 上传跳转：`frontend/src/app/routes/upload/upload.component.ts:38-45` 把值包成数组后 `router.navigate` 到 `/processing`；粘贴入口 `:56-80` 能把多个 File 放进数组，但同样只进 `/processing`。
- 真正上传处：`frontend/src/app/routes/processing/processing.component.ts:35` 是 `const id = await this.imageService.UploadImage(state.imageFiles[0]);`，只上传第 0 个，成功后 `:39` 立刻跳 `/view/<id>`。
- 服务层：`frontend/src/app/services/api/image.service.ts:46-54` 的 `UploadImage` 只接受一个 File、发一条 `POST /api/image/upload`；批量 `UploadImages` 已被注释掉，见 `:56-69`。
- HTTP 层：`frontend/src/app/services/api/api.service.ts:141-150` 的 `postForm` 把 FormData 交给一次 `axios.request`，`:255-310` 是单请求的进度与取消；全前端没有代码用 forkJoin 或 Promise.all 驱动上传。
- 全前端 grep `forkJoin|Promise.all|concurrency|imageFiles` 只命中 settings 用户页的 Promise.all 与 processing 的 `[0]` 两处，没有上传并发代码。
- 结论：前端并发上限是 1，且不可由用户调整；N 张图需要用户重复 N 次操作，每次等待一次完整请求。多选、拖多张、粘贴多张时其余文件被静默丢弃。
- 补充：前端没有客户端队列、没有重试、没有分批并发能力，因此「批量上传耗时线性叠加」与前端的严格串行行为完全吻合。

### 2.8 相关规范与外部参考

- `.trellis/spec/picsur-backend/backend/build-and-deploy.md:59-96` 是环境变量契约表 §3.1；`:255-263` 是三处同步 §7.3；`:468-499` 是 §12 一键部署的两条路径，这条已与仓库现状不符。
- [sharp Global properties: concurrency](https://sharp.pixelplumbing.com/api-utility/)：每张图的 libvips 线程数默认等于 CPU 核数，glibc 无 jemalloc 时默认 1，同时并行图片数受 UV_THREADPOOL_SIZE 限制。
- [libuv Thread pool work scheduling](https://docs.libuv.org/en/v1.x/threadpool.html)：线程池默认 4，可在启动时用 UV_THREADPOOL_SIZE 改写，最大 1024。
- [Node.js child_process.fork](https://nodejs.org/api/child_process.html#child_processforkmodulepath-args-options)：env 参数语义，用于判断转换子进程的环境继承。

## 3. 部署与运行时事实表

| 项 | 事实 | 证据 |
|---|---|---|
| 部署形态 | 单容器 all-in-one，一条 docker run | `README.md:6-14`、`docs/MAINTAINING.md:5-13` |
| 副本数 | 单副本 | `build-and-deploy.md:482` |
| compose 与 install.sh | 已从仓库删除 | `git show 6fc28d9`、`ls` 返回 No such file |
| 进程模型 | tini 到入口脚本，再派生 Postgres 与单个 node | `docker top picsur` 输出 |
| Node 集群 | 无 cluster、无 pm2、无 worker_threads、无 replicas | `main.ts:19-60`、git grep 结果 |
| 图片转换位置 | 每次转换 fork 一个 sharp 子进程 | `sharp.wrapper.ts:54-65`、`image-converter.service.ts:84` |
| 转换子进程环境 | 只收到 3 个显式变量 | `sharp.wrapper.ts:57-63` |
| CPU 配额 | NanoCpus=0、CpuQuota=0、CpuPeriod=0、CpuShares=0、CpusetCpus 为空 | `docker inspect picsur` |
| 内存配额 | Memory=0、MemorySwap=0 | `docker inspect picsur` |
| 宿主机 CPU | 16 逻辑 CPU，i7-12700 | `nproc`、`/proc/cpuinfo` |
| 宿主机内存 | 总 11957MB，可用 3547MB，swap 已用 7648MB | `free -m`，采集时点约 11:29 |
| 容器空闲占用 | CPU 0.00%，内存 105.1MiB | `docker stats`，采集时点约 11:29 |
| 镜像内 Node | 20.20.2 | `docker inspect` 容器 Env、`Dockerfile:36` |
| Node 运行时参数 | 无 NODE_OPTIONS、无 UV_THREADPOOL_SIZE、无 max-old-space-size | grep 无命中、`docker inspect` Env |
| libuv 线程池 | 默认 4 且未覆盖，node 进程 11 线程 | libuv 文档、`/proc/1836855/status`，采集时点约 11:29 |
| 图片库 | sharp 0.35.5，镜像内源码构建 | `Dockerfile:139-144`、`pnpm-lock.yaml:6227` |
| libvips | 自编译 8.18.7 | `Dockerfile:69-94` |
| 单张图线程数 | 默认 QOI 编解码为 qoi-img 原生同步调用、worker 内单线程；非 QOI 编解码才走 libvips 线程池，默认约等于 CPU 核数 | `universal-sharp.ts:60-71`、`:159-174`、`qoi-img/dist/index.js:24-30`；sharp 官方文档，推断见第 5 节 |
| 转换时间上限 | 默认 15s | `preference-defaults.service.ts:47` |
| 转换内存上限 | 默认 512MB | `preference-defaults.service.ts:48` |
| 上传限流 | 路由 20 次/60s，全局 60 次/60s | `image-manage.controller.ts:61`、`PicsurLayers.module.ts:10-20` |
| 处理队列 | 无 | `backend/src` 无队列库引用 |
| 前端上传并发 | 1，串行 await | `processing.component.ts:35` |
| 前端多选 | 不支持，input 无 multiple | `upload.component.html:3`、ngx-dropzone 266 与 278 行 |

## 4. 前端上传并发行为

1. 选择文件：原生 input 没有 `multiple`，文件选择框只能选一个；拖拽入口即使收到多个文件，`@ngx-dropzone/cdk` 在 multiple=false 时只保留第一项，见 `fesm2022/ngx-dropzone-cdk.mjs:266` 与 `:278`。
2. 生成路由参数：`upload.component.ts:38-45` 把 File 或 File[] 统一包成数组，放进 ProcessingViewMeta 后跳 `/processing`。
3. 上传：`processing.component.ts:35` 只取 `imageFiles[0]`，调用 `image.service.ts:46-54` 的 `UploadImage`，一条请求只发一个文件。
4. 等待与跳转：await 期间 UI 停在 `/processing` 的 spinner；成功后跳 `/view/<id>`，失败则退出到错误页。
5. 其余文件：没有第二次请求，没有队列，没有重试；多选与粘贴里的其余文件不会上传。
6. 并发上限：1。前端不存在可配置并发度，也没有分批或分片上传。
7. 对体感的影响：批量场景里每张图都必须完整走一轮「选文件、请求、等待、跳转」，耗时近似线性叠加；这与「像单核串行」的主观感受一致，但原因是前端一次只处理一张，不是后端只用一个核。

## 5. 不确定项

1. 未在容器内实测 CPU 核数与 `sharp.concurrency`。约束要求不动容器，本轮只用 docker inspect/top/stats 与宿主 `/proc`，没有 docker exec。因此「非 QOI 的 sharp/libvips 编解码可用多线程、默认约 16 线程；QOI 编码在 worker 内单线程」是依据 sharp 文档与 musl 镜像推断，不是实测；验证方法是在容器内执行 `node -e "console.log(require('/picsur/backend/node_modules/sharp').concurrency())"` 与 `nproc`，需要用户授权。
2. 未验证运行镜像里的 sharp 确实来自源码构建并带 JXL/JP2。`build-and-deploy.md:327-334` 给出的验证命令需要 docker exec，本轮未执行；镜像内原生实现来自 Dockerfile 与发布链路推断。
3. 未做任何并发上传实测。按任务约束不做压测，因此无法给出 N 张并发上传时的真实 CPU 利用率、耗时或内存峰值；「不是单核」是机制判定，不是性能实测。
4. 宿主机内存偏紧。可用 3547MB、swap 已用 7648MB；多个转换子进程各有 512MB 默认 rlimit，且无全局并发上限。若并发上传多张大图，是否出现内存压力或 swap 抖动未测，这是潜在风险而不是当前「单核」证据。
5. DB 连接池默认值未实测。`type-orm.config.service.ts` 未配置连接池，实际最大连接数由 pg 驱动默认决定，本轮未读到数字，也没有跑数据库侧观测。
6. 前端结论来自静态读码。未执行浏览器交互验证，没有实际多选或拖多张来观察 UI；不过代码路径已经足够确定，多选输入在 HTML 层就缺失 multiple。
7. 运行镜像的前端 dist 未做内容核对。运行镜像是 2026-10-29 发布构建，本轮无法 docker exec 校验镜像内 dist 与本仓库源码一致，只能假定发布脚本从本仓库构建；验证需要 docker exec 比对或重新构建。
8. 三处同步的文档漂移。compose 已删除但 `.env.example` 与 spec §12 仍引用它；本文件只记录，未修改文档，留给 Lead 决定是否开后续任务。
9. 限流键已确认，不再列入不确定项：`@nestjs/throttler` 默认 `getTracker` 返回 `normalizeIp(req.ip, ipv6SubnetPrefix)`，见 `node_modules/.pnpm/@nestjs+throttler@6.7.1_*/node_modules/@nestjs/throttler/dist/throttler.guard.js:150-152`；`generateKey` 的 key 前缀是类名、handler 名与 throttler 名再 sha256，见 `throttler.guard.js:165-168`，所以「20 次/60 秒」按 IP 与 handler 分桶。
10. 动画 WebP 路径未单独分析。`image-processor.service.ts:57-68` 的动画转换也走同一个 fork 机制，但 animated 编解码的线程与 CPU 特征未单独测量。
11. 宿主 Node v24.22.0 与 pnpm 9.6.0 只是调查机的开发工具，不是运行时；运行时是镜像内 Node 20.20.2，两者不要混淆。
12. 未读到的项：仓库里没有读到任何与并发、worker 数量、队列深度、CPU 配额相关的应用配置键，也没有读到 docker-compose.yml、install.sh、pm2 配置或 cluster 代码。
