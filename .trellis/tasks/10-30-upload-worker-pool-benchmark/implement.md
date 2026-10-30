# 执行计划：转换 worker 池化并压测

## 前置事实

- 构建硬约束：Node 20 + pnpm 9.6.0。宿主是 Node 24，禁止在宿主装依赖或构建；本机已有 `node:20-alpine` 镜像与已安装的 `backend/node_modules`，构建在容器内用 `node backend/node_modules/@nestjs/cli/bin/nest.js build` 完成。
- 本地压测实例：`node:20-alpine` 容器、`--network host`、端口 18080、连 dev Postgres 127.0.0.1:5432，库名用户名口令均为 `picsur`；禁止使用 8080 上的现网容器与数据。
- 环境变量给压测实例：`PICSUR_DB_HOST=127.0.0.1`、`PICSUR_DB_PORT=5432`、`PICSUR_DB_USERNAME=picsur`、`PICSUR_DB_PASSWORD=picsur`、`PICSUR_DB_DATABASE=picsur`、`PICSUR_PRODUCTION=false`、`PICSUR_SYNC_SCHEMA=true`、`PICSUR_PORT=18080`、`PICSUR_ADMIN_PASSWORD=<临时值>`、`PICSUR_JWT_SECRET=<临时值>`、`PICSUR_STATIC_FRONTEND_ROOT=<一个存在的空目录>`。
- 现有可用回归脚本：`support/regression-image-api.sh`、`support/make-image-fixtures.cjs`。

## 步骤

### 1. 基线压测，产出 research/benchmark-baseline.md

- 1.1 在 Node 20 容器内构建当前 backend：`docker run --rm -v /root/picsur:/repo -w /repo/backend node:20-alpine node /repo/backend/node_modules/@nestjs/cli/bin/nest.js build`。
- 1.2 生成 fixture：容器内跑 `node support/make-image-fixtures.cjs /tmp/picsur-fx`，`NODE_PATH=/repo/backend/node_modules`；确认 PNG/JPEG/WebP/QOI 都在。
- 1.3 启动压测实例容器，确认 `GET /api/info` 200，`POST /api/user/login` 拿到 JWT。
- 1.4 写压测脚本 `support/bench-upload.cjs`，支持参数：base url、token、fixture 目录、串行次数、并发度、总请求数；输出每次耗时、P50/P90、总耗时、失败数；并发抓 worker 进程数峰值。
- 1.5 跑场景 A 串行 10 张、场景 B 并发 4 与 8 各 8 张，记录原始输出；同时记录实例容器的 CPU 与 worker 峰值数。
- 门禁：数字与命令能复现，失败数为 0，取回像素校验通过。

### 2. 实现 worker 池

- 2.1 新增 `backend/src/workers/sharp/worker-pool.ts`，按 `design.md` §2.1 实现 acquire、release、destroy、TTL、等待队列、退出清理。
- 2.2 重构 `backend/src/workers/sharp.wrapper.ts`，按 `design.md` §2.2 改成租约模型，删除 fork 的 `timeout` 选项，保留错误映射。
- 2.3 检查 `backend/src/workers/sharp/sharp.worker.ts`，只在验证发现状态残留时做最小修正。
- 2.4 若 `image-converter.service.ts` 需要改动，只允许改调用点，不改行为。
- 门禁：TypeScript 构建通过，无新增 lint 违规。

### 3. 池化正确性单测与回归

- 3.1 写最小验证脚本：连续用同一 worker 处理至少 2 个任务，断言两次结果正确、第二个任务不触发进程重建日志。
- 3.2 验证池上限：并发 8 时子进程峰值不超过 4。
- 3.3 错误路径：超像素图返回 400、损坏图返回可读 4xx、构造一个超时场景确认不返回 500。
- 3.4 池化后实例对 `support/regression-image-api.sh` 全绿。

### 4. 池化后压测，产出 research/benchmark-after.md

- 4.1 用与步骤 1 完全相同的 fixture、参数与脚本重跑。
- 4.2 记录数字并与基线对比，计算串行 P50 与并发总耗时变化。
- 4.3 记录空闲 60 秒后 worker 是否被回收，以及实例退出后是否无残留 worker。

### 5. 复核与交付

- 5.1 check 子代理复核 diff、构建、回归、压测报告与设计一致性。
- 5.2 Lead 审查后提交；若收益不显著，报告结论并保留回退说明。

## 验证命令清单

```bash
# 构建
docker run --rm -v /root/picsur:/repo -w /repo/backend node:20-alpine \
  node /repo/backend/node_modules/@nestjs/cli/bin/nest.js build

# 启动压测实例
docker run -d --name picsur-bench --network host \
  -e PICSUR_DB_HOST=127.0.0.1 -e PICSUR_DB_PORT=5432 \
  -e PICSUR_DB_USERNAME=picsur -e PICSUR_DB_PASSWORD=picsur \
  -e PICSUR_DB_DATABASE=picsur -e PICSUR_PRODUCTION=false \
  -e PICSUR_SYNC_SCHEMA=true -e PICSUR_PORT=18080 \
  -e PICSUR_ADMIN_PASSWORD=<临时值> -e PICSUR_JWT_SECRET=<临时值> \
  -e PICSUR_STATIC_FRONTEND_ROOT=/tmp/static \
  -v /root/picsur:/repo -w /repo node:20-alpine node backend/dist/main.js

# 基线/池化后压测
node support/bench-upload.cjs --base http://127.0.0.1:18080 --token <JWT> \
  --fixtures /tmp/picsur-fx --mode serial --count 10
node support/bench-upload.cjs --base http://127.0.0.1:18080 --token <JWT> \
  --fixtures /tmp/picsur-fx --mode concurrent --concurrency 4 --count 8
```

## 回滚点

- 步骤 1 完成后：基线数字已落盘，可随时停下。
- 步骤 2 完成后：若构建或回归失败，`git checkout -- backend/src/workers` 回到 fork 实现。
- 步骤 4 后：若压测收益不显著，不合并池化改动，只保留报告。
