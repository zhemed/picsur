# 构建与部署契约（Build & Deploy）

> 来源：任务 `10-13-handover-baseline`（2026-10-13）实测。所有命令都在本机 `/root/picsur` 验证过。
> 这是**可执行契约**，不是建议：违反其中任一条会直接失败或引入漏洞。

---

## 1. Scope / Trigger

- Trigger：任何要「装依赖 / 构建 / 起服务 / 出镜像 / 改部署」的改动。
- 原因：本项目的工具链有一处**硬性版本约束**（Node 20）、一处**上游构建缺陷**、
  以及**不能依赖上游私有镜像**的镜像约束。不按契约做会直接卡死或把密钥打进镜像。

---

## 2. Signatures（命令契约）

```bash
# 依赖安装（必须 Node 20；用仓库内 corepack 固定 pnpm 9.6.0）
export PATH="/root/picsur/.run/node20/bin:$PATH" # 本机 Node 20 位置（gitignored）
corepack enable && corepack prepare pnpm@9.6.0 --activate
pnpm install --frozen-lockfile

# 三包构建（顺序不可换：backend / frontend 直接 import picsur-shared/dist/*）
pnpm --filter picsur-shared build   # -> shared/dist/index.js
pnpm --filter picsur-backend build  # -> backend/dist/main.js
pnpm --filter picsur-frontend build # -> frontend/dist/index.html

# 本机开发形态（生产模式起后端，前端由后端托管）
set -a
. ./.env
set +a
node backend/dist/main.js # 8080

# 常驻部署（唯一路径：all-in-one 单容器，内嵌 PostgreSQL；命令以 README 为准）
docker run -d --name picsur --restart always -p 8080:8080 -v ./data:/data \
  -v /var/run/docker.sock:/var/run/docker.sock ghcr.io/zhemed/picsur:allinone
docker ps --filter name=picsur        # 一个容器 Up（healthy）
docker restart picsur                 # 验证重启恢复（数据在 ./data）
```

**镜像契约**：`Dockerfile`（仓库根目录）必须满足

| 约束                   | 值 / 原因                                                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------------------------- |
| JS 构建 stage 基础镜像 | `node:20`（**不能 `-slim`**：`qoi-img`/`bmp-img`/`posix.js` 需 node-gyp 编译，slim 无 python3/gcc）             |
| pnpm                   | 固定 `9.6.0`（与根 `package.json` 的 `packageManager` 一致）                                                    |
| libvips                | 源码编译 **8.18.7**（sharp 0.35 的硬要求；HEIF/JXL/JP2 编解码只有这层有）                                       |
| 生产依赖 stage         | `SHARP_FORCE_GLOBAL_LIBVIPS=1` + `python3/build-base`，**并且必须显式跑一次 sharp 源码构建**（见 §8.3 第 5 条） |
| **禁止**               | `FROM ghcr.io/caramelfur/picsur-alpha-stage1:*`（上游私有中间镜像，随时可能消失）                               |
| 构建产物               | 只拷贝 `{frontend,backend,shared}/{dist,package.json}` + 锁文件 + `branding`                                    |
| 运行时                 | `PICSUR_PRODUCTION=true` + `PICSUR_SYNC_SCHEMA` 默认关（TypeORM 只跑 migrations）                                |
| 运行用户               | 常规镜像 `USER node`（uid 1000，非 root）；应用只写数据库与 /tmp，`/picsur` 用 `--chown=node:node` 保证可读。**例外**：all-in-one 保持 root（initdb/chown /data + 自升级要访问宿主 docker.sock，理由写在 `Dockerfile.allinone` 注释里） |
| 可复现性（2026-10-15） | 基础镜像锁 digest、apk 锁 `=版本`、libvips 源码包 `sha256sum -c`、全局 node-gyp/node-addon-api 锁版本；Alpine 发新 `-rN` 后构建会明确失败，用 `bash support/apk-versions.sh` 重新解析并同步 |
| 面板自升级 + 非 root   | 常规镜像不是 root，光挂 `/var/run/docker.sock` 还不够：还要把宿主 docker 组的 GID 加进容器（`docker run --group-add` / `PICSUR_DOCKER_GID`），否则 socket 打不开、面板退化成显示升级命令。all-in-one 镜像是 root，不需要这一项 |
| 构建阶段用户（不变量） | **需要写权限的构建阶段必须在 root 下执行**（pnpm / node-gyp / apk 都要写 `/usr/local` 与项目 `node_modules`），每个构建阶段显式写 `USER root`；**`USER` 只用于最终运行阶段**（`Dockerfile` 末尾 `USER node`）。2026-10-16 两次发布中断的根因就是构建阶段缺 exec 位：全局 pnpm 自带的 `node-gyp/gyp/gyp_main.py` 在 tarball 里是 0644，而 gyp 生成的 Makefile 在「自我再生」时会直接执行它 → `/bin/sh: … Permission denied`、`make Error 126`（偶发＝取决于 make 的时间戳判断）。修法：装完 pnpm / 装完依赖后用 `find … -path '*/node-gyp/gyp/*' -exec chmod +x` 补齐 exec 位，那几行**不要删** |

---

## 3. Contracts（环境变量与部署契约）

### 3.1 环境变量（前缀 `PICSUR_`，见 `backend/src/config/config.static.ts`）

| Key                                              |   必填    | 默认                              | 说明                                                                                                                     |
| ------------------------------------------------ | :-------: | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `PICSUR_DB_HOST/PORT/USERNAME/PASSWORD/DATABASE` | ✅(生产)  | `localhost` / `5432` / `picsur`×3 | all-in-one 用容器内嵌 Postgres（默认 `127.0.0.1`）；本机开发也连 `127.0.0.1`；`picsur_postgres` 是已退役 compose 服务名  |
| `PICSUR_HOST` / `PICSUR_PORT`                    |     —     | `0.0.0.0` / `8080`                | —                                                                                                                        |
| `PICSUR_ADMIN_PASSWORD`                          |    ✅     | —                                 | 账号名固定 `admin`，这是初始口令                                                                                         |
| `PICSUR_JWT_SECRET`                              | ✅(生产)  | 随机                              | 不固定会导致每次重启登录态失效                                                                                           |
| `PICSUR_STATIC_FRONTEND_ROOT`                    |  镜像内   | `/picsur/frontend/dist`           | 前端产物目录                                                                                                             |
| `PICSUR_PRODUCTION`                              | ✅(生产)  | `false`                           | 生产模式：影响日志级别/格式、`/api/info` 的 `production` 字段、内置账号（guest/admin）的初始化。取值按 `ParseBool`：`true/1/yes` 真、`false/0/no` 假、缺省假。**不再控制 schema 同步**（A-2 起拆成下面的独立开关；旧版 `main.ts` 用 `!== undefined`、配置服务用 `ParseBool`，`PICSUR_PRODUCTION=false` 会一半当真一半当假） |
| `PICSUR_SYNC_SCHEMA`                             |     —     | `false`                           | **默认关**：是否让 TypeORM 按实体自动同步表结构。开启 = 启动时 ALTER 表结构以匹配实体（**可能删掉它认为多余的列/表**），只能用于本地开发或空库，跑在有数据的库上等于赌博；开启时启动日志会打 WARN。审计 A-2 起是显式开关（此前由 `!production` 推导）。all-in-one 镜像不在 ENV 里设它，应用默认 `false`；要开用 `docker run -e PICSUR_SYNC_SCHEMA=true` |
| `PICSUR_MAX_FILE_SIZE`                           |     —     | `128000000`                       | 上传字节上限                                                                                                             |
| `PICSUR_MAX_IMAGE_PIXELS`                        |     —     | `268402689`                       | 图像**像素**上限（`w*h`，sharp 默认 `0x3FFF^2`）；超限上传返回 400 并回显该值，`0` = 不限制。2026-10-13 起（issue #107）。`Dockerfile.allinone` 不设这个 ENV，应用默认值同为 268402689（`.env.example` 里也写死这个值，**别传空值**：空串会被 `ParseInt` 解析成 0 = 不限制） |
| `PICSUR_MAX_DERIVATIVES_PER_IMAGE`               |     —     | `100`                             | 每图最多缓存多少张派生图（转码结果）。**超限只影响落库**：图片仍照常返回给用户，只是不再写库（WARN 日志），用于限制数据库体积；`0`（或负数） = 不限制。审计 A-8 新增。all-in-one 不设这个 ENV，应用默认值同为 100；要改用 `docker run -e PICSUR_MAX_DERIVATIVES_PER_IMAGE=<值>` |
| `PICSUR_UPDATE_CHECK` | ✅ 默认开 | `true` | 面板「关于」页的版本检测：只读 `api.github.com/repos/zhemed/picsur/tags`，缓存 1 小时、失败降级、不发任何实例数据；`false` 关闭时接口返回 `checkEnabled:false`（不是报错）。**显式检查会绕过缓存**（见 §14）。0.7.0 起 |
| `PICSUR_ALLOW_SELF_UPDATE` | ⚠️ **默认开** | `true` | 面板内一键自升级。**真正的门槛是挂载**：`/var/run/docker.sock` 一旦挂进容器就等于把宿主 docker 的 root 权限交给面板（任意管理员都能起特权容器），只适合完全信任管理员的单机部署。README 的 all-in-one 命令默认已挂 socket（要关：删挂载 + 设 `false`，此时按钮退化为显示可复制的升级命令）。可选：`PICSUR_UPDATE_{REPO,API_URL,IMAGE,TAG,TIMEOUT,COMMAND}`、`PICSUR_DOCKER_SOCKET`。**`PICSUR_UPDATE_TAG` 在 all-in-one 部署（tag 形如 `allinone`）会被忽略**：换版本 tag 会拉到入口不同的常规镜像，故只重拉当前 tag（`self-update.service.ts: resolveTarget`） |
| `PICSUR_VERBOSE`                                 | ❌ 不要开 | `false`                           | **开了会把 JWT secret 与 DB 口令明文写进日志**                                                                           |
| `PICSUR_TELEMETRY`                               |     —     | `true`                            | **纯装饰**：只影响启动日志里的一行提示，不控制是否出网                                                                   |

**遥测为什么出不了网（2026-10-13 起）**：`ReportUrl` 在 `config.static.ts` 里是**空字符串**
（编译期常量，运行期改不了），`UsageService.execute()` 两道守卫：

```ts
if (!(await this.usageConfig.getMetricsEnabled())) return; // ① DB 首选项（现在已纯装饰）
if (!(await this.usageConfig.getMetricsUrl())) return; // ② 端点为空 → 直接跳过（真正的断链）
```

②是为了「将来有人把 URL 改回某个地址、却忘了重置首选项」这种情形留的兜底。
要接**自己的**统计后端，只需把 `ReportUrl` 改成自己的 URL（并让首选项为 true）。

### 3.2 常驻部署契约

- 唯一部署路径是 **all-in-one 单容器**：`docker run ... ghcr.io/zhemed/picsur:allinone`（README 与 `docs/MAINTAINING.md` 是命令的权威来源）。`install.sh` 已在 `54fe809` 删除、`docker-compose.yml` 已在 `6fc28d9` 删除，均不再是部署路径。
- 所有数据都在 `/data`（PGDATA + `allinone.env`）；宿主机数据目录挂到 `/data`（README 用 `./data`）。
- 口令类变量缺失时**不报错**：`PICSUR_ADMIN_PASSWORD` / `PICSUR_JWT_SECRET` / `PICSUR_DB_PASSWORD` 由入口脚本首启自动生成、打印并写入 `/data/allinone.env`（0600），重启复用；`-e` 传入的值优先。
- `--restart always`（README 命令）；镜像自带 HEALTHCHECK，探活的是容器内 `/api/info`。
- `.env` 必须在 `.gitignore` 与 `.dockerignore` 里**同时**排除（后者决定密钥会不会进镜像层）。

---

### 3.1 系统偏好只暴露真正需要在线改的项（2026-10-16 定调）

判据只有一条：**这项偏好的改动能不能立刻生效、且出错不会把实例弄坏？** 不能的就不给入口。

- 面板里只列 `SysPreferenceExposedList`（`shared/src/dto/sys-preferences.enum.ts`）里的 5 项：
  `host_override` / `remove_derivatives_after` / `allow_editing` / `tracking_url` / `tracking_id`；
- 只在启动时读一次的（`jwt_secret`、`jwt_expires_in`）、排障专用且改坏就全站挂的
  （`conversion_time_limit`、`conversion_memory_limit`）、以及"强度无上限会自锁"的
  `bcrypt_strength`，一律保留默认值但**不给 UI**：`GET/POST /api/pref/sys/:key` 对它们返回 400
  （`getExposedPreferences()` / `setExposedPreference()` 的守门逻辑），前端 i18n 也不留词条；
- `jwt_secret` 曾经在设置页明文回显 ✗ —— 现在既不在列表里，也不允许单读；
- 死设置（`enable_tracking` 无人读取、`enable_telemetry` 端点为空）直接从枚举/默认值/校验器删掉，
  不要留着当"隐私开关"的错觉；旧库里的残留行不会被读取，可日后单独清。

## 4. Validation & Error Matrix

| 条件                                                 | 结果                                                                                                                       |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Node ≥ 22.16 跑 `pnpm install`                       | ❌ 失败：`qoi-img` 等 C++ 编译报 `node_api_basic_finalize` 签名错。必须 Node 20                                            |
| 用全局 pnpm 12 装依赖                                | ❌ 锁文件 v9 与工具链不匹配；用 corepack 固定 9.6.0                                                                        |
| `frontend/custom-webpack.config.js` 保持 `.js` + ESM | ❌ Node ≥20.19 下 `require(esm)` 成功返回命名空间 → webpack `unknown property 'default'`。必须是 `.cjs` + `module.exports` |
| `PICSUR_SYNC_SCHEMA=true` 跑在有数据的库上            | ❌ TypeORM 启动即按实体 ALTER（可能删列）；生产只跑 migration，这个开关默认关                                              |
| `PICSUR_VERBOSE=true`                                | ⚠️ JWT secret / DB 口令明文入日志                                                                                          |
| all-in-one 未提供 `PICSUR_ADMIN_PASSWORD`            | ⚠️ 不报错：入口脚本自动生成随机口令并打印，写入 `/data/allinone.env`（0600）                                               |
| `.env` 未进 `.dockerignore`                          | ❌ 密钥进入镜像层（`docker history` 可捞）                                                                                 |
| 请求 `/i/<uuid>`（不带扩展名）                       | 200 + 品牌占位图 `notfound.png`（**不是原图，也不是 index.html**）                                                         |
| 请求不存在的 `/i/<uuid>`（无扩展名）                 | 404 + 占位图 + `Cache-Control: no-store`                                                                                   |
| 请求**存在但没有保留原图**的 `/i/<uuid>`（无扩展名） | 也返回 **404 + no-store**（#129 吸收后按"原图有无"分流；有原图才是 200）                                                   |
| 删除后再取 `/i/<uuid>.<ext>`                         | **404** + 占位图 + `no-store`（2026-10-13 修复；此前是 200 + 30 天缓存，见 `image-api-contracts.md` §3.4/§3.7）            |
| 上传超过 `PICSUR_MAX_IMAGE_PIXELS` 的图片            | 400 `usrvalidation`，消息含实际像素数与上限（2026-10-13 修复；此前是 500 `Worker closed`）                                 |

---

## 5. Good / Base / Bad Cases

- **Good**：按 README 起 all-in-one 容器 → `docker ps` 一个容器 Up（healthy）→
  `curl /api/info` 200（`version` 与根 `package.json` 一致，当前 `"0.10.7"`）→ 上传/取回/删除通过 → `docker restart picsur` 后
  数据仍在、服务自动恢复。
- **Base**：本机开发形态 —— Postgres 直连本机 `127.0.0.1:5432`（`picsur` 库/用户；`support/dev.docker-compose.yml` 已随 `db04c3b` 退役），
  后端 `set -a; . ./.env; set +a; node backend/dist/main.js`。
- **Bad**：① 在宿主 Node 22 上 `pnpm install`；② 直接 `FROM` 上游 stage1 镜像；
  ③ 把 Dockerfile 放进 `support/`（会被 `.dockerignore` 的 `support` 一行排除出构建上下文，改放仓库根目录）；
  ④ 以为 `PICSUR_TELEMETRY=false` 关掉了遥测（它只影响一行日志；真正的断链是 `ReportUrl` 为空）。

---

## 6. Tests Required（验收断言点）

| 场景     | 命令                                                                                           | 断言                                                                                                           |
| -------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 构建     | 三包 `pnpm --filter <pkg> build`                                                               | `shared/dist/index.js`、`backend/dist/main.js`、`frontend/dist/index.html` 存在；exit 0                        |
| 服务     | `curl -s -o /dev/null -w '%{http_code}' localhost:8080/api/info`                               | `200`，且 body 里 `production:true`                                                                            |
| 迁移     | `docker exec picsur psql -U picsur -d picsur -tAc "select count(*) from migrations;"`          | **`12`**（7 条基线 + 5 条后续迁移，2026-10-30 现网实测），且 `e_user_backend` 里有 `admin`/`guest`             |
| 上传     | `POST /api/image/upload`（multipart 字段 `file`）                                              | `201`，返回 `data.id`（UUID）                                                                                  |
| 取回     | `GET /i/<id>.png`                                                                              | `200` + `image/png`；与原始图片**像素一致**（字节不保证一致）                                                  |
| 转码     | `GET /i/<id>.{qoi,webp,avif,jxl,jp2,heif}`                                                     | 全部 `200`（证明镜像里的自编译 libvips **并且** sharp 是源码构建的）                                           |
| SPA 深链 | `curl -o /dev/null -w '%{http_code} %{content_type}' localhost:8080/some/spa/route`            | `200 text/html` —— `@nestjs/serve-static` ≥11 的 `fallthrough` 回归只有这条能抓到                              |
| 删除     | `POST /api/image/delete` `{"ids":[...]}`                                                       | `201`，且三张表 `e_image_backend`/`e_image_derivative_backend`/`e_image_file_backend` 计数归零                 |
| 持久化   | `docker restart picsur` 后再取原图                                                             | `200` 且内容一致                                                                                               |
| 密钥     | `git grep` 扫跟踪范围                                                                          | 无真实口令/secret；`.env`、`.run/` 不在 `git status` 视野                                                      |

### 6.1 CI 门禁（`.github/workflows/ci.yml`）

push 到任意分支 / PR 触发，跑 4 步（**不构建、不发布镜像**；发布是本地 `bash support/release-local.sh`，见 §9）。
**每一步的外部依赖都要写在 workflow 注释里**，改 CI 时同步更新本节 —— 判错时先看依赖，别先怀疑代码：

| 步骤                  | 需要外网？                              | 需要浏览器？ | 失败时怎么判                                                                                                     |
| --------------------- | --------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile` | **是**（registry.npmjs.org）  | 否           | 锁文件与 `package.json` 不一致＝真问题（本地跑 `pnpm install` 后提交锁文件）；纯连接错误＝源抖动，重跑。**别**用 `--no-frozen-lockfile` 绕 |
| `pnpm build`（三包）  | 否                                      | 否           | 代码/类型错误，看 `tsc`/`ngc` 报错（本地同命令复现）                                                             |
| `bash support/audit-prod.sh` | **是**（`pnpm audit` 只认官方 registry） | 否 | 日志里「后端/共享 N 条」＝新增了带告警的生产依赖（必须处理，见 AGENTS.md §6）；只有 registry 连接错误＝网络问题，重跑，**别改脚本** |
| `pnpm lint`（eslint flat config） | 否                                 | **否**       | 代码问题，按 `文件:行` 修。探针脚本（`support/*-probe.cjs`）在 CI 里**只做静态 lint**；真跑它们要本机常驻 Chromium（见 `bw`） |

- **CI 里没有任何需要浏览器环境的步骤**：34 项镜像回归（`support/regression-image-api.sh`）、视觉对比度探针、
  画廊布局探针都在开发机上手动跑（它们要真实浏览器 + 起实例）。
- 新增 CI 步骤时：写清「需要外网/浏览器吗」，并在上面表格里加一行；**不允许**用 `|| true`、`continue-on-error`
  或“把目录排除出 lint”来换绿色（2026-10-16 的事故就是这样埋的：lint 步骤上线时 `support/*.cjs`
  缺 Node/浏览器 globals，`no-undef` 报 53 处 error，CI 连续 5 次红）。
- `eslint.config.cjs` 里 globals 的划分是**环境假设**，不是豁免：Node 脚本给 `NODE_GLOBALS`，
  注入浏览器的探针脚本给 `NODE_GLOBALS + BROWSER_GLOBALS`，`no-undef` 全程保持 error。
- ⚠️ **探针/脚本里「注入页面执行」的代码用到新的浏览器全局时，必须同时在 `eslint.config.cjs` 登记**：
  这类代码写在 `page.evaluate(...)` / `page.addInitScript(...)` 的回调体里（编译发生在浏览器，eslint 看到的
  却是 Node 语境），用到任何新 API（`PerformanceObserver`、`IntersectionObserver`、`matchMedia`…）
  就往 `BROWSER_GLOBALS` 里按字母序补一条再提交。忘了登记的后果是 **CI 的
  `Lint（eslint flat config）` 步骤硬失败**（`no-undef` 是 error：不吞退出码、不降级规则、不把 `support/` 排除）。
  这不是假设：**2026-10-16 同一天因此红过两次** —— 先是 `document` / `window` / `getComputedStyle` 等
  （53 处 error、CI 连续 5 次红），随后是新探针里的 `PerformanceObserver`（2 处 error、0.10.3 那次）。

---

### 6.1 挂 `dist` 进容器验证：前端 rebuild 后**必须重启容器**（2026-10-16 实测踩到）

把 `frontend/dist` 以 bind mount 挂进容器跑验收（对比度探针、布局探针都这么用）时，
**前端每次 rebuild 之后都要 `docker restart <容器>`**，否则容器里看到的是一个**空目录**。

原因：Angular 构建是**先 `rm -rf dist` 再重建**——删掉的正是被挂载的那个目录 inode。
容器仍旧挂在**已被删除的旧 inode** 上，宿主机的新文件属于另一个 inode，容器永远看不见它。
（`docker cp` 也救不了：挂载是 `:ro` 时写不进去，而且 inode 已经变了这件事它同样绕不开。）

```bash
corepack pnpm --filter picsur-frontend build
docker restart picsur-<stream>          # 重建挂载
docker exec picsur-<stream> ls /picsur/frontend/dist   # 判据：有文件才算挂对了
```

替代做法：**挂父目录**（让容器从 `<root>/frontend/dist` 取），或验证前把 dist **拷贝**进容器而不挂载。

> **症状识别**：站点本身是好的（`/api/info` 200、`index.html` 也 200），但浏览器里
> `cards=0`、查不到 `picsur-img` 元素、或探针报空页面 —— **先 `ls` 容器里那个目录**，
> 不要去怀疑前端代码。2026-10-16 图库宽高任务就是这样误报过一次 `cards=0`。

### 6.2 升级本机 all-in-one 实例：`-prev-` 容器不能当回滚窗口（2026-10-29 实测）

手动升级常写成 `docker stop picsur && docker rename picsur picsur-prev-0106 && docker run ... 新镜像`，
但 0.10.7 升级实测：新实例启动约 2 秒后，应用自己的 `SelfUpdateService.cleanupLeftovers()`
会把同 lineage 下处于停止状态的 `<base>-prev-*` 容器删除，日志是
`Removed leftover container picsur-prev-0106 (interrupted update)`。
也就是说**手动 rename 的回滚窗口只有几秒**，长验收会以为旧容器还在、其实已经没了。

正确做法：

- 升级前先做数据安全网 `docker exec picsur pg_dump -U picsur -d picsur > /tmp/picsur-pre-<版本>.sql`，
  并记录旧镜像 ID、`HostConfig` 的端口/挂载/重启策略/Env 与是否挂 `docker.sock`；
- 升级后回滚别依赖 `-prev-` 容器，走「从 ghcr 仍在的 `:<旧版本>` 常规镜像 + `Dockerfile.allinone` 重建
  `:allinone`」的路径，或改用面板自升级让应用自己处理回滚；
- 旧 allinone 镜像可能在重打标签后变成无标签镜像被回收，升级前就 `docker image inspect` 确认它还在。

---

## 7. Wrong vs Correct

### 7.1 本机没有 Node 20 时

```bash
# Wrong —— 直接用宿主 Node 22 装依赖，43s 后编译失败
pnpm install

# Correct —— 下载官方 Node 20 二进制到 gitignored 目录，只在该 shell 生效
cd /root/picsur/.run && curl -sSL -O https://nodejs.org/dist/v20.20.2/node-v20.20.2-linux-x64.tar.xz
mkdir -p node20 && tar -xJf node-v20.20.2-linux-x64.tar.xz -C node20 --strip-components=1
export PATH="/root/picsur/.run/node20/bin:$PATH"
```

> 运行期不需要 Node 20：原生模块是 N-API，v20 编译的产物在 v22 正常加载（实测）。

### 7.2 停服务

```bash
# Wrong —— 会连当前 shell 一起杀掉（命令行含同样字符串）
pkill -f "node backend/dist/main.js"

# Correct
pkill -x node # 或先 pgrep 拿 PID 再 kill <pid>
```

### 7.3 加环境变量

```bash
# Wrong —— 只改了代码默认值，忘了 .env.example 与本文档
#         下次部署时没人知道有这个变量，默认值也对不上

# Correct —— 三处同步：.env.example（占位值）、Dockerfile.allinone（镜像内 ENV 默认值；
#           没写进镜像的变量以应用默认值为准）、本 spec 的第 3.1 节（契约表）
```

---

## 8. 依赖版本契约（2026-10-13 安全升级后）

### 8.1 版本底线（低于这些会重新引入已知漏洞，或直接跑不起来）

| 包                                    | 契约版本                             | 为什么不能低                                                                                                                                                                                                          |
| ------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node                                  | **20 用于装依赖/构建**；运行期不强制 | 安装：≥22.16 时 `qoi-img`/`bmp-img`/`posix.js` 编译失败。运行：N-API 产物在 v22 可正常加载（见 §7.1）                                                                                                                 |
| pnpm                                  | **9.6.0**（corepack 固定）           | 与 lockfileVersion 9 对齐                                                                                                                                                                                             |
| `@nestjs/*`                           | **^12**                              | Nest 11 内嵌 `@fastify/middie@9.0.3`，**修不掉那条 critical**（需 ≥9.3.2；Nest 12 = 9.3.5）                                                                                                                           |
| `fastify`                             | **^5**                               | Fastify 4 线上没有 `@fastify/reply-from`/`static` 的修复版                                                                                                                                                            |
| `@fastify/static`                     | **≥10.1.2**                          | 低于它有路由守卫绕过/路径穿越                                                                                                                                                                                         |
| `typeorm`                             | **^0.3.31**                          | <0.3.26 有 SQL 注入；不上 1.x（跨大版本）                                                                                                                                                                             |
| `sharp`                               | **^0.35.5**                          | 继承的 libvips CVE                                                                                                                                                                                                    |
| **libvips（镜像内自编译）**           | **≥8.18.7**                          | sharp 0.35 的 `config.libvips` 硬要求；低于它镜像构建会在 `pnpm install --prod` 阶段失败                                                                                                                              |
| `file-type`（**我们自己的直接依赖**） | **^21.3.4，不能用 22**               | `file-type@22` 的 `engines` 是 `node >= 22`。⚠️ 注意：`@nestjs/common@12.1.3` 自己依赖 `file-type@22.1.1`（Nest 的 `FileTypeValidator` 用 `import()` 懒加载，**本项目未启用该功能**）——它确实在生产树里，但不会被加载 |
| `zod`                                 | **^4.6.7**（2026-10-29 已迁 v4）     | v3 分支无修复版本，2026-10-29 已迁 v4；v4 对缺失键更严格，可选字段必须显式 optional                                                                                                                                                                                                |

### 8.2 `pnpm.overrides` 策略（根 `package.json`）

- **只允许同一大版本内的补丁线**，禁止跨大版本顶（如把 `path-to-regexp@0.x` 顶到 8.x）。
- **优先用「版本区间限定」** `"pkg@<受影响区间>": "<修复版本>"`，避免误伤 devDeps 里的旧大版本
  （裸 `minimatch: ^9` 会把 eslint 的 minimatch@3 顶掉，直接搞坏构建链）。
- 每个 override 落地前必须：`pnpm install` + 三包构建 + 冒烟；不过就撤掉并记入残留说明。
- 当前清单与逐条理由见任务 `10-13-dep-security-upgrade` 的 `research/audit-after.md`。
- 2026-10-29（`10-29-dep-security-v4`）新增：`fast-uri: ^3.1.9`、`undici: ^7.30.1`、
  `body-parser@>=2.0.0 <2.4.0 → ^2.4.0`、`fastify@>=5.0.0 <5.12.6 → ^5.12.6`。
  最后一条是必要的范围 override：`@nestjs/platform-fastify@12.1.3` 把 `fastify` 精确钉在 `5.12.5`，
  只升 backend 依赖清不掉那条 low。同轮 `backend` 直接依赖 `fastify ^5.12.6`，三包 `zod ^4.6.7`。
- **已批准的跨大版本例外（就一条）**：`node-gyp: ^11`（10→11）。它一次带走 `tar` / `glob` / `minimatch` /
  `brace-expansion` / `ip-address` / `http-cache-semantics` 一大片**编译链**告警；三个原生模块
  （`qoi-img` / `bmp-img` / `posix.js`）在容器里实测可编译、可加载。
  **不要**改成「只顶 `tar`」——那会造出「node-gyp@10 + tar 7.x」的混搭，风险更高。
  这是有意为之的例外，不是规则被破坏。

### 8.3 升级时最容易踩的五个坑（都是实测踩过的）

1. **`@nestjs/serve-static` ≥11 的 SPA fallback**：不设 `serveStaticOptions.fallthrough: true` 时，
   未匹配路由返回 **JSON 404** 而不是 `index.html` —— `/api/*` 全绿也发现不了，只有前端深链会炸。
   冒烟必须包含 `curl -o /dev/null -w '%{http_code} %{content_type}' localhost:8080/some/spa/route`，期望 `200 text/html`。
2. **`@nestjs/passport` ≥11 的 verify 回调**：mixin 自己 `super(...args, callback)` 并驱动 `this.validate()`，
   Strategy 构造函数里**不要再传第三个回调**（运行期重复）。
3. **`@fastify/multipart` ≥10 → `@fastify/busboy@3.2.3` 的类型增补有缺陷**：它从 `'node:stream'` 引入 `Readable`
   却 `declare module 'stream'`（裸名），NodeNext 下把裸 `stream` 的 `Readable` 压成只有 `'limit'` 一个重载。
   需要时用 `as NodeJS.ReadableStream` 拓宽（纯类型补丁，运行时无变化）。
4. **宿主环境不支持 JXL/JP2**：sharp 的**预编译** libvips 没有这两个编解码器。
   宿主的症状分两段：`/i/<id>.jxl|.jp2` 转码在旧代码里 500（`jxlsave_buffer not found` /
   `JP2 output requires OpenJPEG`），**源格式上传**则是 400
   `Failed to read image metadata: Input buffer contains unsupported image format`
   （2026-10-13 起会回显底层原因，见 `image-api-contracts.md` §4）。**只有自编译 libvips 才有**，
   所以格式验证必须在**容器里**做，不能在宿主做（`support/regression-image-api.sh` 在宿主会失败这 4 项）。

5. ⚠️ **sharp ≥0.33 默认不会用你的自编译 libvips**（2026-10-13 实际踩到，镜像里 JXL/JP2 全 500）：
   - sharp 的 `install` 只装预编译 `@img/sharp-*`（自带一份精简 libvips，**不含 JXL/JP2**）；
   - **`SHARP_FORCE_GLOBAL_LIBVIPS=1 pnpm install` 已经不起作用** —— 0.35 的 `install/check` 不再读这个变量；
   - 必须**显式跑一次源码构建**：
     ```dockerfile
     RUN cd /picsur/backend/node_modules/sharp \
       && SHARP_FORCE_GLOBAL_LIBVIPS=1 NODE_PATH=/usr/local/lib/node_modules node install/build.js
     ```
     （`node-addon-api` / `node-gyp` 要在 NODE_PATH 里能解析，sharp 自己的 node_modules 是空的）
   - **验证方法**（别只看镜像能起来）：
     ```bash
     docker exec -w /picsur/backend picsur node -e \
       "const s=require('sharp');console.log(!!s.format.jp2?.output?.buffer, !!s.format.jxl?.output?.buffer)"
     # 期望 true true；false false 说明用的是预编译 libvips
     ```
   - 症状特征：容器里 `vips -l | grep jxlsave` **有**（CLI 用的是自编译 libvips），但 sharp 进程里没有
     —— 两个进程用的是不同的 libvips。

6. **Alpine apk pin 会随上游 `-rN` 漂移**（2026-10-29 发布 0.10.7 实测）：`expat` 2.8.5→2.9.0、
   `imagemagick` 7.1.2.29→7.1.2.34、`python3` 3.12.15→3.12.16，旧版本从软件源下架后
   `apk add pkg=旧版本` 直接失败、`docker build` 秒级红。处置：跑 `bash support/apk-versions.sh`
   重新解析四个阶段的应锁版本，只改版本号同步进 `Dockerfile` 对应 stage，**不要加宽范围**；
   本次 5 处一次改完，提交 `08286b9`，修完 dry-run 构建 232 秒通过。

### 8.4 残留风险（本任务明确未覆盖，别当成已解决）

- **前端 Angular 18 的浏览器端告警**：Angular 的运行时包（`@angular/core|common|router|compiler` 等）原本
  放在 `frontend` 的 `devDependencies` 里，`pnpm audit --prod` **看不见**它们（假 0）。2026-10-15 审计修复
  （`fix/ops-audit`）已把它们搬进 `dependencies`：现在 `pnpm audit --prod` 会报出浏览器侧
  **59 条（29 high / 29 moderate / 1 low）**，其中 Angular 那部分（XSS / XSRF 类）**仍未修**，
  归属 **T6（Angular 大版本升级，修复线 19.2.16+）**；axios / moment / uuid / follow-redirects
  有同 major 的修复版本，可单独排一条升级任务（当前未做，避免混进 0.7.9）。
  后端/共享口径仍必须 0：用 `bash support/audit-prod.sh`（它按 `pnpm-lock.yaml` 的生产依赖闭包区分
  「服务器侧」与「浏览器侧」）。
- **全量口径**（含 devDeps）升级后仍有 critical 6 / high 92 / moderate 81 / low 16，几乎全在前端构建链
  （Angular CLI / webpack / eslint / pacote 等）。
- `zod` 已于 2026-10-29 迁到 `^4.6.7`（任务 `10-29-dep-security-v4`）：v4 对 JSON 丢键更严格，
  响应 DTO 的可选字段必须显式 `optional()`，否则后端响应校验 500；迁移改动见
  `shared/src/dto/api/api.dto.ts`、`shared/src/dto/api/image.dto.ts`、`shared/src/entities/user.entity.ts`。
  v4 默认错误文案有细微变化，仅影响偏好输入框展示。
- `pnpm audit` 只反映「已知 advisory 的命中情况」，**不等于**「没有漏洞」。

---

## 9. 仓库来源与发布口径（2026-10-13 起生效）

| 项                     | 约定                                                                                                                                                                                                                                                                                                                                |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 仓库                   | `https://github.com/zhemed/picsur`，**非 fork**（原 fork 已改名 `zhemed/Picsur-fork-archive` 留档）                                                                                                                                                                                                                                 |
| 上游关系               | **无**：不设 `upstream` remote，不依赖上游镜像 / 二进制 / 服务。上游代码只作为历史来源                                                                                                                                                                                                                                              |
| 遥测出网               | **已断链**：`ReportUrl` 编译期为空（`backend/src/config/config.static.ts`），`UsageService.execute()` 见端点为空即跳过。`enable_telemetry` 首选项与 `PICSUR_TELEMETRY` 现在都**不控制**出网；要接自己的统计后端才需要改 `ReportUrl`                                                                                                 |
| 版本线                 | 自有版本线，从 **`0.6.0`** 起；四个 `package.json` 同步，`/api/info` 与设置页「关于」版本区块都读它；页脚来源行已于 2026-10-29 清空，不再显示版本                                                                                                                                                                                                                                               |
| 许可                   | AGPL-3.0（`LICENSE` 不动）。README 保留上游出处声明 —— 这是**合规声明**，不是依赖                                                                                                                                                                                                                                                   |
| 发布（提交）           | 提交默认 push 到 `origin`（见 `AGENTS.md`）                                                                                                                                                                                                                                                                                         |
| 发布（镜像）           | **`support/release-local.sh` 本地构建并发布到 `ghcr.io/zhemed/picsur`**（2026-10-16 起 GitHub Actions 只保留 `ci.yml`，不再由 tag 触发构建；脚本本地构建并推送 `:<版本>`、`:v<版本>`、`:<主>.<次>`、`:latest`、`:allinone`，成功后自动打推 `v<版本>` tag；需要先 `docker login ghcr.io`）。发布后必须 `docker pull` 起一次隔离栈跑 `support/regression-image-api.sh`，基础 34 项、有数据库访问时 38 项，必须 0 failed（CI 绿 ≠ 镜像可用） |
| 部署镜像来源           | **`ghcr.io/zhemed/picsur:allinone`** 是唯一部署镜像（内嵌 Postgres，数据在 `/data`）。`:<版本>` / `:latest` 是常规镜像，只作为 `Dockerfile.allinone` 的构建基底（`PICSUR_BASE_IMAGE`），不是部署路径；要钉版本：`docker build -f Dockerfile.allinone --build-arg PICSUR_BASE_IMAGE=ghcr.io/zhemed/picsur:v<版本> ...`（命令见 `Dockerfile.allinone` 头注释） |
| 文档分工               | README 只讲"跑起来"（≤35 行），运维细节在 `docs/MAINTAINING.md`，可执行契约在本文件                                                                                                                                                                                                                                                 |
| 允许出现上游字样的位置 | 仅 `LICENSE`、README 的出处声明、`.trellis/**` 历史记录；**其余一律清空**                                                                                                                                                                                                                                                           |

> 检查命令（用 `git grep` 跟着 `.gitignore` 走，避免扫到 `.run/` 里的历史产物造成假阳性；
> 白名单之外应为空）：
>
> ```bash
> git grep -ni "picsur\.org\|caramelfur\|discord\.gg" -- . \
>   ':!LICENSE' ':!README.md' ':!.trellis'
> ```

---

## 10. SVG 依赖栈（2026-10-13，#129 吸收后）

SVG 与其它格式不同：**按原始向量存为 master，绝不交给 sharp 栅格化当源**，因此多了一套 XML 处理依赖。

| 包          | 用途                                      | 注意                                                   |
| ----------- | ----------------------------------------- | ------------------------------------------------------ |
| `svgo`      | 压缩 / 规范化 SVG                         | 精确锁定版本（安全面）                                 |
| `jsdom`     | 给 `dompurify` 提供 DOM 实现              | **重量级**（约 30 个传递依赖），也是下面那组告警的来源 |
| `dompurify` | 净化：删 `<script>` / `onload` / 外部引用 | 精确锁定版本                                           |
| `is-svg`    | 判定"这是不是 SVG"                        | —                                                      |

它们**只在后端**使用（`backend/src/managers/image/svg-security.service.ts`），不进前端产物。

**引入时踩到的坑**：`jsdom` 拖进来的 `ws` / `form-data`（以及 `source-map-js`）在生产树上带进了
1 critical + 3 high 告警 —— 按 §8.2 的策略用同大版本补丁线 override 顶掉：

```jsonc
"form-data@>=4.0.0 <4.0.6": "^4.0.6",
"ws@>=8.0.0 <8.21.0": "^8.21.0",
"source-map-js@>=1.0.0 <1.2.2": "^1.2.2"
```

**契约**：新增后端运行时依赖后必须重跑 `bash support/audit-prod.sh` —— **后端/共享口径保持 0**
（浏览器侧已知存量不阻断，见 §8.4 / §10）。
若要减轻依赖，替代方案是换更轻的 DOM 实现（如 linkedom），但需重新验证净化行为。

> 部署形态见 §12（唯一路径：all-in-one 单容器）。

**取回契约**：`/i/<id>.svg` 响应必须带
`Content-Security-Policy: sandbox; default-src 'none'; … script-src 'none'` 与
`X-Content-Type-Options: nosniff`（见 `image-api-contracts.md` §3.4）。动这条链路时要连带验证这两个头。

---

## 11. 轮换凭据（2026-10-13 实操记录）

**先记住三条反直觉的事实**，否则会像本次一样"以为换了其实没换"：

1. **改 `PICSUR_ADMIN_PASSWORD` 不会改已有 admin 的口令**。
   `UserDbModule.ensureUserExists()` 是 `if (exists) return;` —— 只在用户**不存在**时创建。
2. **`PICSUR_JWT_SECRET` 有值时每次启动都会写进本地首选项**：`LateConfigModule.ensureJwtDefaultsLoaded()`
   在 env 有值时调用 `setPreference('jwt_secret', envSecret)` 覆盖；env 没值时才读/生成数据库首选项
   `e_sys_preference_backend` 里 `key='jwt_secret'` 的值，运行期读的也是它（`JwtConfigService.getJwtSecret()`）。
   注意方向：**是 env 覆盖库，不是库覆盖 env**（这与本节 2026-10-13 的旧记录相反，当前代码见 `late-config.module.ts:44-57`）。
3. ⚠️（历史，compose 已退役）**`docker compose` 优先用 shell 环境变量，而不是 `.env` 文件**。
   当时如果先 `set -a; . ./.env; set +a`（把旧值导出到 shell），再改 `.env`，然后
   `docker compose up -d --force-recreate` —— 容器拿到的仍是**shell 里的旧值**。
   all-in-one 下的对应关系：`docker run -e` 传入的值 > `/data/allinone.env` 里的持久化值 > 应用/镜像默认值。

### 轮换步骤（实测可用）

```bash
# 1) 换 JWT secret：面板里已经改不了它（'jwt_secret' 属固定项，API 会返回 400）。
#    两条可用路径：
#    a) 用 docker run -e PICSUR_JWT_SECRET=... 重建容器 —— LateConfigModule 在启动时用它覆盖首选项；
#    b) 直接改库（改完要重启才生效）：
docker exec -i picsur psql -U picsur -d picsur \
  -c "UPDATE e_sys_preference_backend SET value='$(openssl rand -hex 32)' WHERE key='jwt_secret'"

# 2) 换 admin 口令：走接口（需要 admin 的 user id 与当前 token）
curl -X POST localhost:8080/api/user/update -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d "{\"id\":\"<admin-uuid>\",\"password\":\"<新的>\"}"
#    拿不到 token 时（例如口令已经丢了）只能用第 3 步的直接写法

# 3) 兜底：直接用应用自带的 bcrypt-ts 写 hashed_password（等价于 usersService.updatePassword）
#    自己写个临时脚本（bcrypt.hash(pw,10) + UPDATE e_user_backend SET hashed_password），
#    口令通过 stdin 传以免暴露在 argv/env；脚本必须放在 /picsur/backend 下才能解析到 node_modules，
#    用完 `docker exec picsur rm -f …` 删掉。
printf '%s' "$NEW_PW" | docker exec -i -w /picsur/backend picsur node /picsur/backend/ < 临时脚本 > .cjs

# 4) 把新值写回 .env（本机开发）或 /data/allinone.env（all-in-one 持久化密钥），再重启容器
docker restart picsur   # 入口脚本重新读取 /data/allinone.env；`-e` 传入的值优先
#    注意：all-in-one 不读宿主 .env，只改 .env 对已运行的容器无效；要在 docker run 时用 -e 传

# 5) 验证：新凭据 201，旧凭据失败，旧 token 失效（401/403）
```

**验证口径**：`sha256` 比对「`.env` 的值」与「容器 `printenv` 的值」必须一致
（注意 `printenv` 会带尾换行，比较前 `tr -d '\n'`）——本次第一次「成功」的轮换就是因为没做这步，
实际上是旧值生效、`.env` 已漂移。

**轮换后必跑**：`support/regression-image-api.sh`（34 项）——确认凭据变化没有连带影响取图与鉴权。

---

## 12. 一键部署（唯一路径：all-in-one，2026-10-13）

| 路径 | 什么时候用 | 一条命令 |
|---|---|---|
| **all-in-one**（单容器，内嵌 PostgreSQL 17） | 唯一部署方式：单机自用，一条 `docker run` | `docker run -d --name picsur --restart always -p 8080:8080 -v ./data:/data -v /var/run/docker.sock:/var/run/docker.sock ghcr.io/zhemed/picsur:allinone` |

镜像由本地 `support/release-local.sh` 构建并推送（`:<版本>` / `:v<版本>` / `:<主>.<次>` / `:latest` / `:allinone`；2026-10-16 起 Actions 只跑 CI、不再发镜像，见 §9）。**compose + `install.sh` 路径已退役并从仓库删除**（`54fe809` 删 `install.sh`，`6fc28d9` 删 `docker-compose.yml`），不要再按旧文档执行。

**all-in-one 的契约**
- 数据全在 `/data`（PGDATA + `allinone.env`）；`PICSUR_ADMIN_PASSWORD`/`PICSUR_JWT_SECRET`
  没给就**自动生成并打印**，并落 `/data/allinone.env`(0600)。
- 幂等：`/data` 非空则跳过 initdb；迁移仍由应用启动时执行（`migrationsRun`）。
- 信号：tini 为 PID 1，SIGTERM 先停应用再 `pg_ctl -m fast stop`（`docker stop` 退出码 0）。
- **局限（写进 README/手册）**：单副本（一个 `/data` 一个 postmaster）、必须 root、Postgres 默认参数、
  备份靠 `tar ./data`（别丢 `allinone.env`）。
- 常规 `Dockerfile` 仍是 all-in-one 的构建基底（`Dockerfile.allinone` 的 `PICSUR_BASE_IMAGE` 默认 `ghcr.io/zhemed/picsur:latest`）；`:版本` / `:latest` 常规镜像不是部署路径。

**踩过的三个坑（改这个镜像前先看）**
1. alpine 3.23 包名是 `postgresql17` 系列，且 **`postgresql17-contrib` 必需** —— uuid 主键要
   `CREATE EXTENSION "uuid-ossp"`，缺了首启迁移直接 FATAL。
2. `pg_ctl -l /dev/stdout` 在 `su-exec` 下降权后 `Permission denied`（postgres 用户打不开 root 的 stdout）→
   改前台 postgres，日志直接进 `docker logs`。
3. 绕过 `pnpm run` 直接 `node backend/dist/main.js` 时，要自己注入 `npm_package_version`，
   否则 `/api/info` 的版本号会退化成 `0.0.0`。

**为什么必须挂 socket（与 Komari 的对比，2026-10-15 定）**：Komari 免 socket 升级是因为它是**单文件二进制**（`/app/komari`）——下载新文件 → 校验 → 自检 → `os.Rename` 覆盖自己 → 原地重执行（它自己的 `container-replace` 模式）；代价是容器一旦被重建就退回镜像里的版本。Picsur 是 Node + 一整棵树（`dist` + 含原生模块的 `node_modules` + 自编译 libvips），容器内自替换要每次下载数百 MB 覆盖自身，且会让「跑的内容 ≠ 镜像」，故不采用。我们的实现与 Komari 的 `docker-recreate` 模式一致：**应用持有 socket → 拉镜像 → helper 重建自身**。**决定：保持现状**（默认挂 socket、默认开启），不引入侧车更新器。

**`install.sh` / compose 的退役记录**：`54fe809` 删除 `install.sh` 与 `release-image.yml`，`6fc28d9` 删除 `docker-compose.yml` 与 `support/verify-published-image.sh`。旧的 `install.sh` 契约（幂等重跑=升级、`--dir/--port/--version/--admin-password`、缺 docker 或端口占用时非零退出、用受管的 `docker-compose.override.yml` 覆盖端口与容器名）随文件删除失效，**不要按旧文档执行**；部署与升级只走本节的 all-in-one 路径与 §13 的面板自升级。

---

## 13. 自升级的升级窗口与恢复（2026-10-15，审计 D 线修复后）

一次自升级只在一小段时间里「没有任何容器在跑正名」，这段窗口里的每一步都必须可重入：

| 角色 | 容器名 | 作用 / 生命周期 |
| --- | --- | --- |
| 正名容器 | `<名字>` | 用户的实例；被停掉、被重建 |
| 替换容器 | `<名字>-new-<ts>` | 新镜像的容器；先创建，等旧的停掉后改名成 `<名字>` 再启动 |
| 旧容器 | `<名字>-prev-<ts>` | 原容器改名后的样子；升级成功后删除，失败则由 helper 改回原名重启 |
| helper（primary） | `<名字>-update-<ts>` | 真正执行「停旧 → 起新 → 探活 → 删旧/回滚」 |
| helper（rescue） | `<名字>-rescue-<ts>` | 备用：primary 意外消失时接管（见下） |

**手动升级命令必须等于用户真实的部署形态（2026-10-16 修）**：面板做不了升级时会显示一条可复制的
`docker run`。它只能指向**用户实际在跑的那个镜像**——本项目唯一免编排的形态是
`ghcr.io/zhemed/picsur:allinone`（内嵌 Postgres，数据在 `/data`），而 `:latest` 是**常规镜像，
没有内嵌数据库、单独起不来**。这里的坑正是「显示命令的场景 = 用户只能手抄的场景」，抄错就废。

- 能 inspect 到自己：镜像取自身容器的 `Config.Image`，名字/端口/卷/重启策略从
  `Config.Image` + `HostConfig` + `Mounts` 读真实值（`buildRunArguments`）。
- 读不到（没挂 socket / 不在容器里）：回落到 `DefaultRunImage`，**它是 `:allinone`，不是 `:latest`**；
  命令里的名字/端口/卷只能是文档化的默认值（`picsur` / `8080` / `./data`），因为此时确实无从得知真实值。
  注意 README 的推荐命令还多挂一个 `-v /var/run/docker.sock:...`；回落命令**不带**它——
  这个分支本身就意味着 socket 不可用，不该把特权挂载塞进给用户的默认命令。
- `PICSUR_UPDATE_IMAGE` 始终优先于两者（运维显式指定时以它为准）。
- 已删除「读 `com.docker.compose.*` 标签、输出 `docker compose pull && up -d`」的分支：compose
  部署方式已从仓库移除，命中残留标签的容器现在也走上面的 `docker run` 重建。

**三条兜底（缺一条就会出现「升级窗口内没有兜底」）**

1. **helper 自身可重启**：helper 带 `restart: on-failure`（最多 5 次），脚本每一步都写成**可重入**
   （已改名的就跳过改名，已停的就跳过停，已启动的就跳过启动，HTTP 304 视为「已经是目标状态」）。
   进程崩溃 / OOM / daemon 重启后，Docker 会把它拉起来接着做完。
2. **rescue helper**：`restart: on-failure` 对 `docker kill`（人为停止）**无效**，所以另起一个 rescue 容器
   跑同一份脚本。它只做一件事：等 primary 不再运行（或等 8s 以上且对方已死），检查正名容器是否在跑 ——
   在跑就说明这一轮已经有结论（成功或回滚），直接退出；没在跑就自己把交换做完。
   一次升级最多多花十几秒，但把「helper 一死就全站停机」的窗口封掉了。
3. **启动自愈**（`SelfUpdateService.selfHealOnStartup`，模块初始化后 2s 执行、失败只告警）：
   - 自己是 `<名字>-prev-<ts>`（运维手工 `docker start` 了旧容器）：删掉遗留的 `<名字>-new-*`，
     正名空闲时把自己**改名回正名**，面板记一条 `failed` 说明「上一次升级被打断，已恢复」。
   - 自己是正名：删掉同源（同名前缀）的 `-prev-*` / `-new-*` 残留，面板记一条 `success` 说明「helper 没清理干净，启动时已清理」。
   - 只清理**名字属于自己这一支**的容器；正在运行的残留一律不动，只告警。

**结果怎么读**：helper 结束时会把自己的容器名改成 `-ok` / `-rolledback` / `-idle`（无后缀=中途死掉），
面板的 `lastUpdate` 只统计 **owner label = 自己这一支** 的 helper（同宿主跑多个实例不会串台）。

**手工恢复（极端情况，比如宿主重启时 helper 已耗尽重启次数）**

```bash
docker ps -a | grep -E '<名字>-(prev|new|update|rescue)-'   # 看清现场
docker rm -f <名字>-new-<ts>          # 没起来的替换容器
docker rename <名字>-prev-<ts> <名字>  # 旧容器改回正名
docker start <名字>                    # 起回来（起来后应用会自己做剩下的自愈）
```

**必测（改这块时必须复现）**

```bash
# 1) 正常升级：helper 应该 -ok，面板 success
curl -X POST localhost:8091/api/system/update/apply -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -d '{}'

# 2) 杀 primary 必须自愈（rescue 接管）
( while :; do st=$(docker inspect <名字> --format '{{.State.Status}}' 2>/dev/null); \
    [ "$st" != running ] && docker kill $(docker ps --format '{{.Names}}'|grep '^<名字>-update'|head -1) && break; sleep 0.03; done ) &
curl -X POST localhost:8091/api/system/update/apply -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -d '{}'

# 3) 坏镜像必须回滚且**只回滚一次**：helper 名 -rolledback、RestartCount 必须为 0、面板 failed
```

**非 root 镜像下的 socket 权限（2026-10-16，`zh-default` 真机演练暴露）**

0.8.0 起常规镜像 `USER node`（uid 1000），而宿主 socket 是 `root:docker 0660`。app 容器靠编排层的
`group_add: <docker gid>` 拿到权限（compose 时代即 compose 的 `group_add`；compose 退役后手工起常规镜像对应 `docker run --group-add`），**但 helper 与替换容器是 app 用 Docker API 自己建的，不会继承这个 group_add** ——
于是 helper 一启动就 `EACCES`，旧代码还会把它误报成 `the old container is gone`，面板一直等到客户端超时才报错。

修法（都在 `backend/src/managers/update/**`）：

1. **读 socket 的 gid**：`statSync(<socketPath>).gid`（bind mount 保留宿主数值，容器内读到就是宿主 docker 组）。
2. **helper 与替换容器都补这个 gid**：`HostConfig.GroupAdd = 老容器的 GroupAdd + socket gid`。
   helper 仍以**镜像自带用户**跑（不再额外提权），只为它补上缺的那个组；
   替换容器也补——否则「root 老容器 → node 新镜像」升完级之后，新容器自己又用不了 socket（下一次升级再坏）。
3. **拿不到 gid 时的兜底**：helper 用 `User: '0'`（它是唯一带 socket 的容器，提权不扩大爆炸半径），并打 warn。
4. **helper 启动先自检 socket**：`GET /version` 失败就打印真实原因（`EACCES`/`ENOENT`）并退出，不再伪装成「容器不见了」。
5. `Config.User` 仍按老容器克隆：老容器为空（0.7.x 镜像没有 `USER` 指令）时，新容器回到镜像默认用户——
   这正是「root 老容器 → node 新镜像」能自然切换的原因（实测 `User=[] → node`）。

实测身份（非 root 实例 8091）：

```
helper: Config.User=node  HostConfig.GroupAdd=["998"]  → 日志 `uid=1000 gid=1000 groups=998,1000,1000`
升级后的新容器: Config.User=node  GroupAdd=["998"]     → 下一次升级照旧成功
```

**给 0.7.x → 0.8.x 用户的注意（历史）**：那一次升级是**老代码**在执行，它不会给替换容器补 gid。
当时从 0.7.x 升上来要再跑一次 `install.sh`（或 `docker compose up -d`），让 compose 的 `group_add` 落到新容器上；
否则新容器里的面板会显示"升级命令"而不是按钮（`PICSUR_DOCKER_GID` 要等于 `stat -c %g /var/run/docker.sock`）。
现在唯一部署路径是 all-in-one（容器内以 root 运行），不存在这个 GID 问题；`install.sh` / compose 已删除，这里的命令仅作历史记录。

---

## 14. 版本检测的缓存语义：显式检查必刷新（2026-10-16）

`POST /api/system/update/check` 的答案缓存 **1 小时**（失败缓存 2 分钟）。这个缓存**不能一刀切**，
因为同一个接口有两个意图完全不同的调用方：

| 调用方 | 语义 | 为什么 |
|---|---|---|
| 面板「检查更新」按钮 / body `{"force":true}` / `?force=true` | **绕过 TTL，重新问 GitHub** | 用户刚发版，点一下就必须看到新版本号 |
| 升级进度轮询（每 3s，最长 10 分钟 ≈ 200 次调用） | 用缓存 | GitHub 未认证额度只有 **60 次/小时**，轮询会把额度打光 |

**契约**（`backend/src/managers/update/update-check.service.ts` + `routes/api/system/system-update.controller.ts`）：

- `getLatest(true)` **一定发起自己的请求**，不复用别人正在飞的查询（否则用户点按钮可能拿到轮询早先发起的那个请求的答案）；
- `getLatest(false)` 先吃缓存，未过期直接返回；未命中时可共享在飞的查询（保护额度）；
- **只有最新发起的那次查询能写缓存**（单调序号守卫 `newestQuery`）：慢的旧请求晚到也不会把缓存写回旧值；
- 显式检查支持两种写法，body 与 query 任一为真即生效 —— query 写法让没有请求 DTO 的调用方也能强制刷新；
- **空 body 必须继续可用**（`POST /check` 历来可以不带 body），所以 `force` 是可选字段，别用校验把空 body 拒掉。

**踩过的坑（0.8.2 用户反馈）**：控制器 `check()` 当时**根本没读请求体**，直接调
`this.checkService.getLatest()` —— `force` 永远传不下去，于是面板按钮与手工 `{"force":true}` 都吃 1 小时缓存，
表现成"远端已发 `v0.8.2`，面板仍显示 `0.8.1` 且说当前已是最新"。修在**接口层**，缓存服务本身的 `force` 分支一直是对的。

**必测（改这块时必须复现）**：起一个实例，把 `PICSUR_UPDATE_API_URL` 指到一个可控的假 GitHub API，
按顺序走，`latest` 必须在第 3 步就变：

```bash
# 1) 假 API 返回 v0.8.1，普通调用把缓存存成旧值
curl -X POST localhost:8094/api/system/update/check -H "Authorization: Bearer $T"
# 2) 假 API 改成返回 v0.8.2（模拟发版）
# 3) 普通调用**仍应是 0.8.1** ← 证明缓存没被废掉
curl -X POST localhost:8094/api/system/update/check -H "Authorization: Bearer $T"
# 4) 显式检查必须**立刻**是 0.8.2
curl -X POST localhost:8094/api/system/update/check -H "Authorization: Bearer $T" \
  -H 'Content-Type: application/json' -d '{"force":true}'
# 5) 另一种写法等价
curl -X POST 'localhost:8094/api/system/update/check?force=true' -H "Authorization: Bearer $T"
```

再补一条"回真实 API"的确认：把假 API 从"只答 v0.8.1"切到**代理真 `api.github.com`**，
`force` 必须返回真·最新 tag（与不带 force 的缓存值不同）。

**不要**改成"每次调用都强制刷新"：升级进度轮询 3s 一次，会把 GitHub 的 60 次/小时额度打光，
用户看到的是 `Could not check for updates: GitHub answered with HTTP 403`。

**前端配合**：面板「检查更新」按钮发起的调用必须带上 `force`（body 或 `?force=true`）；
`followUpgrade()` 的进度轮询**不要**带 —— 那是有意的省额度路径。
