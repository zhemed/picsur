# 实现报告：修复 compose 退役后的文档漂移

> 任务：`.trellis/tasks/10-30-fix-doc-drift-compose-retired`；共享任务：task-4
> 角色：Trellis 实现子代理；本轮只改文档，未做 `git commit`
> 日期：2026-10-30

## 一、结论

已完成。`build-and-deploy.md`、`backend/index.md`、`.env.example` 三处过时表述已按仓库现状修正：唯一部署路径统一为 all-in-one 单容器，环境变量三处同步口径改为「`.env.example` 占位值 + `Dockerfile.allinone` 镜像内 ENV 默认值 + 本 spec §3.1 契约表」，验证用例里的容器名、迁移数、重启命令与当前代码/现网一致。全仓扫描后，非归档、非历史任务文件中不再有「把 compose / install.sh 当现状」的表述；剩余 compose / install.sh 字样均为明确标注的历史说明，或落在本任务写入白名单之外的禁改文件里（见第六节）。

## 二、事实基准（先核对再改）

所有结论都来自仓库当前文件与现网只读查询，没有推断：

| 事实 | 证据 |
|---|---|
| `install.sh` 与 `.github/workflows/release-image.yml` 已在 `54fe809` 删除 | `git show --name-status 54fe809` |
| `docker-compose.yml` 与 `support/verify-published-image.sh` 已在 `6fc28d9` 删除 | `git show --name-status 6fc28d9` |
| `support/dev.docker-compose.yml` 已在 `db04c3b` 删除 | `git log --diff-filter=D -- support/dev.docker-compose.yml` |
| 仓库根只有 `Dockerfile` 与 `Dockerfile.allinone`；部署相关脚本只剩 `support/allinone-entrypoint.sh` | `ls` 仓库根与 `support/` |
| 唯一部署命令：`docker run -d --name picsur --restart always -p 8080:8080 -v ./data:/data -v /var/run/docker.sock:/var/run/docker.sock ghcr.io/zhemed/picsur:allinone` | `README.md:6-14`、`docs/MAINTAINING.md:5-13` |
| 现网容器与该命令一致 | `docker inspect picsur`：Image `ghcr.io/zhemed/picsur:allinone`、Cmd `node backend/dist/main.js`、Mounts `…->/data` 与 `docker.sock`、RestartPolicy `always`、Port 8080 |
| all-in-one 镜像 ENV：`PICSUR_PRODUCTION=true`、`HOST=0.0.0.0`、`PORT=8080`、`DB_HOST=127.0.0.1`、`DB_PORT=5432`、`DB_USERNAME/DATABASE=picsur`、`STATIC_FRONTEND_ROOT=/picsur/frontend/dist`、`MAX_FILE_SIZE=128000000`、`TELEMETRY=false`、`VERBOSE=false`、`DATA_DIR=/data` | `Dockerfile.allinone:53-64` |
| 口令类变量缺失时不报错：入口脚本自动生成、打印并写 `/data/allinone.env`（0600）；`-e` 传入值优先 | `support/allinone-entrypoint.sh:228-274`、`README.md:16-17` |
| 迁移共 12 条（7 条基线 + `AddImageSourceFiletype` + 0.9.x 去角色化 3 条 + `AddImageDimensions`） | `backend/src/database/migrations/index.ts` 注册 12 条；`docker exec picsur psql -U picsur -d picsur -tAc "select count(*) from migrations;"` 返回 `12` |
| 当前版本 `0.10.7` | 四个 `package.json` 一致 |
| 应用默认值：`MAX_IMAGE_PIXELS=268402689`、`MAX_DERIVATIVES_PER_IMAGE=100`、`ALLOW_SELF_UPDATE=true`、`DB_HOST=localhost` | `shared/src/util/image-pixel-limit.ts:13`、`backend/src/config/early/image.config.service.ts:11`、`backend/src/config/late/update.config.service.ts:42-53`、`backend/src/config/early/type-orm.config.service.ts:30-45` |
| 镜像发布 tag：`:<版本>` / `:v<版本>` / `:<主>.<次>` / `:latest` / `:allinone`，其中常规镜像只是 all-in-one 的构建基底 | `support/release-local.sh:93-105`、`Dockerfile.allinone:21-22` |
| 现网迁移数与表结构正常；`/api/info` 探活由镜像 HEALTHCHECK 承担 | `Dockerfile.allinone:69-70` |

## 三、逐处改动清单

### 1. `.trellis/spec/picsur-backend/backend/build-and-deploy.md`

改动前该文件有 34 行出现 compose / install.sh 字样（PRD 记 24 处，按引用次数而非行数统计）。逐处处理如下，未重排任何章节：

1. §2 命令契约（现 35-39 行）：`docker compose up -d --build` / `ps` / `restart` → README 的 all-in-one `docker run` + `docker ps --filter name=picsur` + `docker restart picsur`。
2. §2 镜像契约表「面板自升级 + 非 root」行（现 55 行）：`compose group_add` → `docker run --group-add`，并补「all-in-one 镜像是 root，不需要这一项」。
3. §3.1 环境变量表（现 66、72、74、75、77 行）：
   - DB 行：删除「compose 内用服务名 `picsur_postgres`」，改为 all-in-one 内嵌 Postgres 默认 `127.0.0.1`、本机开发也连 `127.0.0.1`，并注明 `picsur_postgres` 是已退役 compose 服务名。
   - 第 72 行 `PICSUR_SYNC_SCHEMA`：删「`docker-compose.yml` 已透传」，改为「all-in-one 镜像不在 ENV 里设它，应用默认 `false`；要开用 `docker run -e PICSUR_SYNC_SCHEMA=true`」。
   - 第 74 行 `PICSUR_MAX_IMAGE_PIXELS`：删「`docker-compose.yml` 已透传」，改为「`Dockerfile.allinone` 不设这个 ENV，应用默认值同为 268402689，`.env.example` 里也写死这个值」，保留「别传空值」告警。
   - 第 75 行 `PICSUR_MAX_DERIVATIVES_PER_IMAGE`：同上，注明应用默认值 100、`-e` 覆盖。
   - 第 77 行 `PICSUR_ALLOW_SELF_UPDATE`：`docker-compose.yml 默认已挂 socket` → 「README 的 all-in-one 命令默认已挂 socket」。
4. §3.2 常驻部署契约（现 92-98 行）：4 条 compose 契约（compose 根目录 `.env`、`${VAR:?}` 守卫、`restart: unless-stopped`、数据卷 `picsur-data`）→ 5 条 all-in-one 契约（唯一路径、数据全在 `/data`、口令自动生成并写 `/data/allinone.env`、`--restart always` + HEALTHCHECK、`.env` 双排除）。
5. §4 错误矩阵（现 125 行）：`compose 缺 PICSUR_ADMIN_PASSWORD → 报错` → `all-in-one 未提供 → 不报错，自动生成并打印、写 allinone.env`。
6. §5 Good / Base（现 137-141 行）：Good 从 compose 两容器改为 all-in-one 单容器，重启命令改 `docker restart picsur`，版本号 `0.6.0` → `0.10.7`；Base 的 `support/dev.docker-compose.yml`（已删）改为直连本机 `127.0.0.1:5432` + `set -a` 启后端，并注明 dev compose 已随 `db04c3b` 退役。
7. §6 验收断言（现 154、160 行）：迁移命令容器名 `picsur_postgres` → `picsur`；迁移数 `8` → `12`（2026-10-30 现网实测）；持久化用例 `docker compose restart` → `docker restart`。
8. §6.1 CI 门禁（现 165 行）：相邻事实修正——发布不再是 `release-image.yml`（与 install.sh 同批删除），改为「本地 `bash support/release-local.sh`，见 §9」。
9. §7.3 加环境变量（现 259-265 行）：三处同步从「`.env.example` + `docker-compose.yml` + §3.1」改为「`.env.example` + `Dockerfile.allinone` 镜像内 ENV 默认值（没写进镜像的变量以应用默认值为准）+ §3.1」；Wrong 示例同步改写。
10. §9 部署镜像来源（现 375 行）：compose 的 `image: ${PICSUR_IMAGE:-…}` → 「`ghcr.io/zhemed/picsur:allinone` 是唯一部署镜像；`:<版本>` / `:latest` 是常规镜像、只作为 `Dockerfile.allinone` 的构建基底（`PICSUR_BASE_IMAGE`），不是部署路径」，并给出钉版本的 build 命令。
11. §10 部署形态指引（现 415 行）：删「compose+install.sh」，改为「唯一路径：all-in-one 单容器」。
12. §11 轮换凭据（现 431-434、443、458 行）：第 3 条反直觉事实标注「历史，compose 已退役」并补 all-in-one 下的优先级（`-e` > `/data/allinone.env` > 应用/镜像默认值）；步骤 1a 改为「用 `docker run -e PICSUR_JWT_SECRET=...` 重建容器」；步骤 1b 的 psql 目标从 `<db 容器>` / `<库>` 改为 all-in-one 容器 `picsur` / 库 `picsur`；步骤 4 从「清 shell 变量 + `docker compose up -d --force-recreate`」改为「写 `.env`（本机开发）或 `/data/allinone.env`（all-in-one 持久化密钥）后 `docker restart picsur`」，并说明 all-in-one 不读宿主 `.env`。
13. §12 一键部署（现 472-499 行）：标题从「两条路径」改为「唯一路径：all-in-one」；表格删 compose 行，all-in-one 命令补 `docker.sock` 挂载与 README 一致；「两者都发布在 … `release-image.yml`」改为本地 `release-local.sh` 的 tag 说明 + compose/install.sh 退役（记 `54fe809` / `6fc28d9`）；「常规 `Dockerfile` 与 `docker-compose.yml` 不受影响」改为「常规 `Dockerfile` 是 all-in-one 的构建基底」；`install.sh` 契约段改为「`install.sh` / compose 的退役记录」，旧契约以历史摘要保留并注明不要按旧文档执行。
14. §13 自升级（现 573-574、595-598 行）：非 root socket 段「app 容器靠 compose 的 `group_add`」→「靠编排层的 `group_add`（compose 时代即 compose 的 `group_add`；compose 退役后手工起常规镜像对应 `docker run --group-add`）」；「给 0.7.x → 0.8.x 用户的注意」标注历史，并补「现在唯一部署路径 all-in-one 以 root 运行，不存在这个 GID 问题」。

其余 compose 字样（现 66、94、140、431-434、478、499、527-528、574、596-598 行）均保留为明确的历史说明。

### 2. `.trellis/spec/picsur-backend/backend/index.md`

- 现第 17 行 Build & Deploy 描述：删「compose」，改为「Docker 镜像、all-in-one 唯一部署路径、环境变量契约」。
- 现第 36-37 行的三处同步口径与「compose 部署已退役（`6fc28d9` 删除 `docker-compose.yml`）」已经是新口径，核对后无需改动。

### 3. 仓库根 `.env.example`

按授权只改注释，变量名与 `=` 后的值一律未动：

1. 现 3-4 行：`cp .env.example .env && docker compose up -d --build`（用仓库根 `docker-compose.yml`）→ 唯一部署命令 `docker run … ghcr.io/zhemed/picsur:allinone`，并注明容器变量用 `-e` 传。
2. 现 13-14 行：`compose 内部使用服务名` → `all-in-one 用容器内嵌 Postgres 的 127.0.0.1；本机开发也用 127.0.0.1`；新增一行说明下面的 `picsur_postgres` 是已退役 compose 服务名、实际使用要改成 `127.0.0.1`（值按「默认值不动」约束未改，见第六节）。
3. 现 22-26 行：compose 透传说明 → 两种跑法：本机开发整份 `.env` 生效；all-in-one 容器不读这份文件，变量必须用 `docker run -e` 传，没传的用 `Dockerfile.allinone` 的 ENV 默认值或应用默认值。
4. 现 60 行：`compose 里是 ${PICSUR_ALLOW_SELF_UPDATE:-true}` → 「后端默认值 true；关掉用 `docker run -e PICSUR_ALLOW_SELF_UPDATE=false`」。
5. 现 63-64 行：`compose / install.sh 路径` 与 `all-in-one` 的对照 → 只有 all-in-one，README 那条 `docker run` 已带 `docker.sock` 挂载，不想要就删掉该挂载。
6. 现 68-72 行：把「常规镜像非 root 需要 GID」整段改为：all-in-one 以 root 运行不需要 `PICSUR_DOCKER_GID`；只有手工用常规镜像时才有 GID 问题，保留 `node（uid 1000）`、`root:docker`、`stat -c %g /var/run/docker.sock` 这些技术事实与变量名。

## 四、保留的历史说明

以下位置保留 compose / install.sh 字样，均为明确的历史说明或退役记录，不再被当作现状：

| 文件:行 | 内容 | 为什么保留 |
|---|---|---|
| `build-and-deploy.md:66` | 「`picsur_postgres` 是已退役 compose 服务名」 | 解释环境变量表里历史默认值的来源 |
| `build-and-deploy.md:94` | 「`install.sh` 已在 `54fe809` 删除、`docker-compose.yml` 已在 `6fc28d9` 删除」 | 退役事实 + 提交锚点 |
| `build-and-deploy.md:140` | 「`support/dev.docker-compose.yml` 已随 `db04c3b` 退役」 | 本机开发 Base 用例的演变说明 |
| `build-and-deploy.md:431-434` | §11 第 3 条「历史，compose 已退役」 | 2026-10-13 轮换凭据的真实踩坑记录 |
| `build-and-deploy.md:478` | 「compose + install.sh 路径已退役并从仓库删除（提交号）」 | §12 现状入口处的一次性说明 |
| `build-and-deploy.md:499` | 「`install.sh` / compose 的退役记录」+ 旧契约摘要 | 保留历史契约信息，避免有人按旧文档执行 |
| `build-and-deploy.md:527-528` | 「已删除读 `com.docker.compose.*` 标签的分支」 | 自升级代码的准确历史变更说明 |
| `build-and-deploy.md:574` | 「compose 时代即 compose 的 `group_add`；compose 退役后对应 `docker run --group-add`」 | 解释非 root socket 权限机制的来源 |
| `build-and-deploy.md:595-598` | 「给 0.7.x → 0.8.x 用户的注意（历史）」 | 历史升级注意事项，已注明现在不适用 |
| `.env.example:14` | 「`picsur_postgres` 是已退役 compose 的服务名」 | 解释保留值的历史来源 |
| `.trellis/workspace/zhemed/journal-1.md` 等 | 会话日志里的 compose / install.sh | 历史工作记录，不修改 |

## 五、全仓扫描结果

扫描命令（跟踪范围，`git grep`）：

```bash
git grep -n -i -e 'docker.compose' -e 'docker-compose' -e 'install\.sh' -e 'compose' -- ':!.trellis'
git grep -n -i -e 'compose' -e 'install\.sh' -- '.trellis/spec'
git grep -n -i -e 'compose' -e 'install\.sh' -- '.trellis/tasks' \
  ':!.trellis/tasks/archive' ':!.trellis/tasks/10-25-video-support-eval' \
  ':!.trellis/tasks/10-30-fix-doc-drift-compose-retired'
```

结果分类：

1. **已修正**：`.env.example`、`build-and-deploy.md`、`backend/index.md`（见第三节）。
2. **准确的历史说明，已核对保留**：`build-and-deploy.md` 上述 9 处；`backend/src/managers/update/self-update.service.ts:234-235` 的注释明确写「compose is no longer a supported deployment path」；`self-update.service.ts:653/822` 是通用/历史性描述，不是部署现状表述；`.trellis/workspace/zhemed/journal-1.md` 16 行属会话历史记录。
3. **已排除、未修改**：`.trellis/tasks/archive/**` 共 42 个文件含 compose / install.sh 字样；`.trellis/tasks/10-25-video-support-eval/**` 历史任务目录。按要求一律不动。
4. **仍过时但不在本任务写入白名单，未改**：见第六节。

## 六、未改与风险

以下问题在扫描中发现但超出 task-4 写入白名单（只允许 3 个文档 + 本任务 research 目录），未擅自扩大范围，建议 Lead 决定是否开后续任务或授权修：

1. `Dockerfile:165-166`：注释仍写「compose 里用 `group_add`…（`install.sh` 会自动探测并写进受管 override）」。Dockerfile 在本任务禁改范围内。
2. `Dockerfile.allinone:5-6`：顶部注释仍写「与常规 `Dockerfile` / `docker-compose.yml` 的关系……二者并存（常规路径仍是正式部署方式）」，与本任务确立的「唯一部署路径」直接矛盾。Dockerfile* 禁改，建议优先安排一轮修正。
3. `package.json:6-9`：`devdb:start/stop/restart/remove` 仍指向已删除的 `support/dev.docker-compose.yml`，这些脚本现在必然失败；属代码/配置，禁改。`support/setversion.sh`、`support/purge-all.sh` 也被删而脚本仍在文件里，同类问题。
4. `.trellis/spec/guides/index.md:44`：「改 compose 或 `.env`」应改为「改 all-in-one 运行参数或 `.env`」；属其它 spec 文件，禁改。
5. `docs/MAINTAINING.md:34`：「固定版本：把镜像换成 `ghcr.io/zhemed/picsur:vX.Y.Z`」——`:vX.Y.Z` 是常规镜像，不含内嵌 Postgres、不能直接 `docker run`；all-in-one 只有滚动的 `:allinone` tag，钉版本要用 `docker build -f Dockerfile.allinone --build-arg PICSUR_BASE_IMAGE=…`。README/MAINTAINING 不在写入白名单，未改；与 PRD「README 与 MAINTAINING 核对」一条相关。
6. `.env.example:7-10`：`# ---- 必填 ----` 与「JWT 不设置则每次重启随机生成」对 all-in-one 不成立（入口脚本生成一次并持久化到 `/data/allinone.env`）；按 Lead 只改列出的注释行的指令，未动，建议后续单独修。
7. `.env.example:15` 的值 `PICSUR_DB_HOST=picsur_postgres` 与注释不一致：按「变量名与默认值不动」未改，只加了说明行；若要彻底消除地雷，需授权把值改成 `127.0.0.1`。
8. `build-and-deploy.md:429-430`（§11 第 2 条）与步骤 1a 语义不一致：第 2 条说「`PICSUR_JWT_SECRET` 只在首选项不存在时被采用」，步骤 1a 说「LateConfigModule 在启动时用它覆盖首选项」；按当前代码 `late-config.module.ts:44-57`，env 有值时每次启动都会 `setPreference` 覆盖。非 compose 问题，未改，建议核代码后单独修。
9. `build-and-deploy.md:485-486`（§12 局限条目）说「单副本、必须 root…（写进 README/手册）」，但 README 与 MAINTAINING 并未写「必须 root」；属既有表述，未改。

## 七、验证命令与输出摘要

```bash
# 1) 只改了文档，没有代码 / Dockerfile / support 变化
git status --short
#  M .env.example
#  M .trellis/spec/picsur-backend/backend/build-and-deploy.md
#  M .trellis/spec/picsur-backend/backend/index.md
#  ?? .trellis/tasks/10-30-fix-doc-drift-compose-retired/
# 另有两个未跟踪路径来自并行的 10-30-upload-worker-pool-benchmark 任务（非同任务改动）：
#  ?? .trellis/tasks/10-30-upload-worker-pool-benchmark/
#  ?? support/bench-upload.cjs

git diff --stat
#  .env.example                                    | 33 ++++++++++++---------
#  .../picsur-backend/backend/build-and-deploy.md  | 92 ++++++++++++++++++-------------
#  .trellis/spec/picsur-backend/backend/index.md   |  2 +-
#  3 files changed, 65 insertions(+), 62 deletions(-)

# 2) 现网事实核对（只读）
docker inspect picsur --format '{{.Config.Image}}'        # ghcr.io/zhemed/picsur:allinone
docker ps --filter name=picsur --format '{{.Status}}'      # Up … (healthy)
docker exec picsur psql -U picsur -d picsur -tAc \
  "select count(*) from migrations;"                       # 12

# 3) 迁移注册数
# backend/src/database/migrations/index.ts 的 MigrationList 共 12 条

# 4) 版本号
grep '"version"' package.json backend/package.json shared/package.json frontend/package.json
# 全部 0.10.7

# 5) 退役提交
git show -s --format='%h %s' 54fe809   # 删 install.sh + release-image.yml
git show -s --format='%h %s' 6fc28d9   # 删 docker-compose.yml + verify-published-image.sh
git show -s --format='%h %s' db04c3b   # 删 support/dev.docker-compose.yml

# 6) 改后文件里 compose / install.sh 只剩历史说明
grep -n -i -e 'compose' -e 'install\.sh' -e 'release-image' \
  .trellis/spec/picsur-backend/backend/build-and-deploy.md
# 命中行：66、94、140、431-434、478、499、527-528、574、596-598，均为历史说明
```

仓库没有 markdown lint；本次未改代码，不需要跑三包构建与 lint。除只读的 `docker inspect` / `docker ps` / `psql SELECT` 外未触碰运行中的实例。

## 八、建议 Lead 复核点

1. 抽查 `build-and-deploy.md` §3.1、§3.2、§4、§5、§6、§7.3、§9、§11、§12、§13 的改写是否与 README、`docs/MAINTAINING.md`、`Dockerfile.allinone`、`support/allinone-entrypoint.sh` 一致。
2. 确认 `.env.example` 只动注释、未动变量名与值（`git diff` 中 `= ` 右侧无变化）。
3. 决定第六节第 1、2 项（`Dockerfile` / `Dockerfile.allinone` 过时注释）、第 3 项（`package.json` devdb 脚本）、第 4 项（`guides/index.md`）、第 5 项（`MAINTAINING.md:34`）、第 7 项（`.env.example` 的 `picsur_postgres` 值）、第 8 项（§11 事实 2 与步骤 1a 矛盾）是否另开任务或授权本轮追加。
4. 归档时把本报告与任务目录一起归入 `.trellis/tasks/archive/2026-10/`（由 Lead/主会话执行，子代理不做 archive）。

## 九、第二轮：同类文档漂移一并解决（2026-10-30，Lead 复核后扩围）

> 背景：Lead 复核第一轮报告后决定，第六节里属于同一「文档漂移」的项本轮一并解决（用户已授权「把文档漂移先解决」），写白名单相应扩到 `Dockerfile`、`Dockerfile.allinone`、`docs/MAINTAINING.md`、`package.json`。本节行号为第二轮完成后的当前版本；第一轮各节的行号按当时版本记录，本轮 §11 改写使其后章节整体后移 2 行（文件从 647 行变为 649 行）。

### 1. 逐处改动

1. `Dockerfile.allinone:5-9`（只改注释）：把「与常规 `Dockerfile` / `docker-compose.yml` 的关系……二者并存（常规路径仍是正式部署方式）」改为「唯一部署路径是本镜像（all-in-one 单容器）；compose / install.sh 已退役并从仓库删除；常规镜像不是独立部署路径，只作为本镜像的基底（`PICSUR_BASE_IMAGE`，见下方构建命令）」。另把第 53 行「与常规镜像/compose 一致的运行契约」的 `/compose` 去掉。`git diff` 过滤 `#` 后无内容，说明没有改任何指令。
2. `Dockerfile:164-168`（只改注释）：「要保留这个能力，compose 里用 `group_add`……（install.sh 会自动探测并写进受管 override）」改为「常规镜像不是部署路径（只作 all-in-one 的基底，all-in-one 里以 root 运行），手工跑常规镜像时才需要用 `docker run --group-add` 把宿主 docker 组 GID 加进来（GID 取值见 `.env.example` 的 `PICSUR_DOCKER_GID`）」。
3. `docs/MAINTAINING.md:34-42`：固定版本口径从「把镜像换成 `ghcr.io/zhemed/picsur:vX.Y.Z`」改为「all-in-one 在 GHCR 上只有滚动的 `:allinone` 标签，没有版本化 all-in-one tag；固定版本要在仓库根目录 `docker build -f Dockerfile.allinone --build-arg PICSUR_BASE_IMAGE=ghcr.io/zhemed/picsur:vX.Y.Z -t picsur:allinone-fixed .` 自行重建，再 `docker run` 本地这个 tag；不能直接把部署镜像换成 `:vX.Y.Z`——那是常规镜像，没有内嵌 Postgres、需要外置数据库，不是一条 `docker run` 的部署形态」。
4. `docs/MAINTAINING.md:87-105`：在 §4 构建与依赖下新增 `### 4.1 本地 dev 数据库`，给出 `docker run postgres:17-alpine` 的完整参数（容器名 `picsur-devdb`、`-p 5432:5432`、`POSTGRES_DB/USER/PASSWORD` 全为 `picsur`、数据卷 `picsur-devdb-data`），以及检查/停删命令、连库方式（`.env.example` 复制成 `.env` 并把 `PICSUR_DB_HOST` 改成 `127.0.0.1`，再按 `.env.example` 顶部方式起后端）。
5. `.env.example:7-11`（只改注释，变量名与值未动）：`# ---- 必填 ----` → `# ---- 口令（all-in-one 不填会自动生成；直跑后端时才需要显式设置）----`；JWT 注释从「不设置则每次重启随机生成」改为「all-in-one：入口脚本首次启动生成一次并持久化到 `/data/allinone.env`（600），重启复用；直跑后端且未设置时才会每次重启随机生成，会导致所有登录态失效」。
6. `build-and-deploy.md:429-432`（§11 第 2 条）：按 `backend/src/config/late/late-config.module.ts:44-57` 实际行为改写——`PICSUR_JWT_SECRET` 有值时每次启动调用 `setPreference('jwt_secret', envSecret)` 覆盖首选项；env 没值时才读/生成数据库首选项，运行期读的也是首选项；并注明「是 env 覆盖库，不是库覆盖 env」，与本节 2026-10-13 的旧记录相反。该矛盾不是 compose 遗留问题，本次按代码实况修正；步骤 1a 的既有表述与新第 2 条一致（保留）。
7. `package.json:5-12`：删除 `devdb:start` / `devdb:stop` / `devdb:restart` / `devdb:remove` 四条引用已删除 `support/dev.docker-compose.yml` 的死脚本（本任务唯一非文档改动，属删除死配置）。`node -e "require('./package.json')"` 校验通过，scripts 现为 `build / setversion / purge / purge-all / format / lint`。

### 2. devdb 全仓 grep 结果

```bash
git grep -n -i 'devdb'
```

删除脚本后仍匹配的位置分三类：

1. **新的死引用，未改**：`.vscode/tasks.json:56-58` 的「Start postgres」任务仍 `"command": "pnpm devdb:start"`。本轮白名单未扩到 `.vscode/`，未擅自修改；删除 npm script 后它从「指向已删 compose 文件」变成「指向已删 script」，仍然不可用。建议 Lead 决定：删掉该 task，或把它改成 `### 4.1` 里那条 `docker run`。
2. **历史记录，不动**：`.trellis/tasks/archive/2026-10/10-13-handover-baseline/research/smoke.md` 里的 `support-devdb-1` 实测记录；`.trellis/tasks/10-30-upload-worker-pool-benchmark/prd.md:13` 提到的 `support-devdb-1` 属并行任务记录。
3. **新文档内容**：`docs/MAINTAINING.md` §4.1 的 `picsur-devdb` 命令，以及本报告自身的引用。

### 3. 第一轮风险收敛情况

| 第一轮报告第六节项 | 第二轮处置 |
|---|---|
| 1. `Dockerfile.allinone:5-6` 与 compose 并存表述 | 已修，见本节「逐处改动」第 1 条 |
| 2. `Dockerfile:165-166` 提 compose/install.sh | 已修，见本节「逐处改动」第 2 条 |
| 3. `package.json` devdb 死脚本 | 已删；顺带发现 `.vscode/tasks.json:58` 同类死引用，未授权未改 |
| 4. `guides/index.md:44` 仍写「改 compose」 | 未改（其它 spec 文件，仍是残留） |
| 5. `MAINTAINING.md:34` 固定版本口径 | 已修，见本节「逐处改动」第 3 条 |
| 6. `.env.example:7-10` 必填/每次重启随机 | 已修，见本节「逐处改动」第 5 条 |
| 7. `.env.example:15` 值 `picsur_postgres` | 未改（「变量名与默认值不动」约束仍在；注释已说明） |
| 8. §11 事实 2 与步骤 1a 矛盾 | 已修，见本节「逐处改动」第 6 条 |
| 9. §12 局限「写进 README/手册」表述 | 未改（轻度表述，未授权） |

### 4. 验证命令与输出摘要

```bash
# 只改注释，不改指令
git diff -U0 -- Dockerfile Dockerfile.allinone | grep -E '^[-+]' \
  | grep -vE '^(\+\+\+|---)' | grep -vE '^[-+]\s*#'
# 输出为空

# package.json 合法且死脚本已删
node -e "const p=require('./package.json');console.log(Object.keys(p.scripts))"
# [ 'build', 'setversion', 'purge', 'purge-all', 'format', 'lint' ]

# 当前修改面
git status --short
#  M .env.example
#  M .trellis/spec/picsur-backend/backend/build-and-deploy.md
#  M .trellis/spec/picsur-backend/backend/index.md
#  M Dockerfile
#  M Dockerfile.allinone
#  M docs/MAINTAINING.md
#  M package.json
#  ?? .trellis/tasks/10-30-fix-doc-drift-compose-retired/
#  ?? .trellis/tasks/10-30-upload-worker-pool-benchmark/   ← 并行任务
#  ?? support/bench-upload.cjs                             ← 并行任务

git diff --stat
#  .env.example                                    | 38 +++++----
#  .../picsur-backend/backend/build-and-deploy.md  | 98 +++++++++++-----------
#  .trellis/spec/picsur-backend/backend/index.md   |  2 +-
#  Dockerfile                                      |  5 +-
#  Dockerfile.allinone                             | 11 +--
#  docs/MAINTAINING.md                             | 29 ++++++-
#  package.json                                    |  4 -
#  7 files changed, 109 insertions(+), 78 deletions(-)

# 非 .trellis 文件里 compose / install.sh 只剩历史或状态说明
git grep -n -i -e 'docker.compose' -e 'docker-compose' -e 'install\.sh' -e 'compose' -- ':!.trellis'
#  .env.example:15（历史注释）、Dockerfile.allinone:6（退役状态说明）、
#  backend/src/managers/update/self-update.service.ts（准确历史注释）、
#  docs/MAINTAINING.md:89（dev compose 退役说明）
```

未构建镜像、未重启服务、未跑三包构建（没有改指令与代码逻辑，`package.json` 仅删除 4 条脚本）。

### 5. 第二轮后仍存的残留

1. `.vscode/tasks.json:56-58` 的 `pnpm devdb:start` 死引用（本轮新发现，等 Lead 决定）。
2. `package.json:7/9` 的 `setversion` 与 `purge-all` 也指向已删除的 `support/setversion.sh` / `support/purge-all.sh`，属同类死配置；Lead 本轮只授权 devdb，未动。
3. `.trellis/spec/guides/index.md:44` 的「改 compose 或 `.env`」。
4. `.env.example:15` 的值 `PICSUR_DB_HOST=picsur_postgres`（受「值不动」约束）。
5. `build-and-deploy.md:487` §12 局限条目「（写进 README/手册）」与 README/MAINTAINING 实际内容仍略有出入。

### 6. 建议 Lead 复核点（第二轮）

1. 抽查 `Dockerfile` / `Dockerfile.allinone` diff：确认只有 `#` 注释行变化、无指令变化。
2. 抽查 `docs/MAINTAINING.md` 新增 §4.1 与固定版本段是否与 `Dockerfile.allinone` 构建参数、`postgres:17-alpine` 口径一致。
3. 抽查 `package.json` 删除后的 scripts 列表，并决定 `.vscode/tasks.json:56-58` 等残留死引用是否本轮一并处理或另开任务。
4. 更新后的全量 diff 仍只含文档 + `package.json` 死配置删除；未 commit。
