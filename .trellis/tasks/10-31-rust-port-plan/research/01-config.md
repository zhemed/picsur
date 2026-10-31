# Research: 配置项与环境变量

- Query: 盘点所有配置项、环境变量、默认值、敏感性与来源
- Scope: internal
- Date: 2026-10-31
- 证据基线: git master b6bd23c

## Findings

### 一、配置加载机制

- 前缀固定 `PICSUR_`，默认用户名与库名 `picsur`，见 `backend/src/config/config.static.ts:9-10`
- `ConfigModule.forRoot({ ignoreEnvVars: true, cache: true })`，见 `config/early/early-config.module.ts:12-18`
  - 实际影响：`ignoreEnvVars` 只影响预定义变量校验，本仓库未配置 validate 与 validationSchema，因此等价于不生效
  - `.env` 默认从进程工作目录加载，已存在的进程环境变量优先，见 `backend/node_modules/@nestjs/config/dist/config.module.js:42-51`，依赖为 `@nestjs/config` 12.x
- 配置服务分两阶段，early 只依赖环境，late 依赖数据库偏好，见 `config/early/early-config.module.ts:1-41`、`config/late/late-config.module.ts`
- 版本号来自 `npm_package_version`，缺省 `0.0.0`，见 `config/early/host.config.service.ts:91-93`
  - 常规镜像用 `pnpm` 启动以注入该变量，见 `Dockerfile:160-163, 173`
  - all-in-one 由入口脚本兜底写入，见 `support/allinone-entrypoint.sh:276-282`
- 布尔解析口径：`true/1/yes` 为真，`false/0/no` 为假，见 `shared/src/util/parse-simple.ts:1-11`
- 整数解析口径：数字或数字字符串，四舍五入，见 `parse-simple.ts:17-32`

### 二、环境变量清单

| 变量 | 默认 | 是否敏感 | 读取位置 |
|---|---|---|---|
| `PICSUR_HOST` | `0.0.0.0` | 否 | `config/early/host.config.service.ts:50-52` |
| `PICSUR_PORT` | `8080` | 否 | `host.config.service.ts:54-56` |
| `PICSUR_DEMO` | `false` | 否 | `host.config.service.ts:58-60` |
| `PICSUR_DEMO_INTERVAL` | `300000` 毫秒 | 否 | `host.config.service.ts:62-67` |
| `PICSUR_PRODUCTION` | `false` | 否 | `host.config.service.ts:24-26, 69-71` |
| `PICSUR_SYNC_SCHEMA` | `false` | 否，危险 | `host.config.service.ts:73-81` |
| `PICSUR_VERBOSE` | `false` | 是，会打印 secret 与 DB 口令 | `host.config.service.ts:83-85`、`.env.example:87-89` |
| `PICSUR_TELEMETRY` | `true` | 否，当前无效果 | `host.config.service.ts:87-89`、`config/config.static.ts:4-8` |
| `PICSUR_DB_HOST` | `localhost` | 否 | `config/early/type-orm.config.service.ts:30-33` |
| `PICSUR_DB_PORT` | `5432` | 否 | `type-orm.config.service.ts:34` |
| `PICSUR_DB_USERNAME` | `picsur` | 否 | `type-orm.config.service.ts:35-38` |
| `PICSUR_DB_PASSWORD` | `picsur` | 是 | `type-orm.config.service.ts:39-42` |
| `PICSUR_DB_DATABASE` | `picsur` | 否 | `type-orm.config.service.ts:43-46` |
| `PICSUR_ADMIN_PASSWORD` | `picsur` | 是 | `config/early/auth.config.service.ts:10-15` |
| `PICSUR_JWT_SECRET` | 无，缺省随机生成并入库 | 是 | `config/early/early-jwt.config.service.ts:10-14`、`preference-defaults.service.ts:29-39` |
| `PICSUR_JWT_EXPIRY` | 无，等价 `7d` | 否 | `early-jwt.config.service.ts:16-20`、`preference-defaults.service.ts:40-41` |
| `PICSUR_MAX_FILE_SIZE` | `128000000` 字节 | 否 | `config/early/multipart.config.service.ts:14-19` |
| `PICSUR_MAX_IMAGE_PIXELS` | `268402689`，0 表示不限 | 否 | `config/early/image.config.service.ts:28-46`、`shared/src/util/image-pixel-limit.ts:12-16` |
| `PICSUR_MAX_DERIVATIVES_PER_IMAGE` | `100`，0 表示不限 | 否 | `config/early/image.config.service.ts:9-12, 30-32` |
| `PICSUR_STATIC_FRONTEND_ROOT` | `<包根>/../frontend/dist` | 否 | `config/early/serve-static.config.service.ts:17-30` |
| `PICSUR_REDIS_URL` | `redis://localhost:6379` | 否，死配置 | `config/early/redis.config.service.ts:14-19` |
| `PICSUR_UPDATE_CHECK` | `true` | 否 | `config/late/update.config.service.ts:36-39` |
| `PICSUR_ALLOW_SELF_UPDATE` | `true` | 否，高危 | `update.config.service.ts:41-53` |
| `PICSUR_UPDATE_REPO` | `zhemed/picsur` | 否 | `update.config.service.ts:55-61` |
| `PICSUR_UPDATE_API_URL` | `https://api.github.com` | 否 | `update.config.service.ts:63-69` |
| `PICSUR_UPDATE_TIMEOUT` | `5000` 毫秒，夹在 500 到 60000 | 否 | `update.config.service.ts:71-85` |
| `PICSUR_UPDATE_IMAGE` | 无 | 否 | `update.config.service.ts:87-94` |
| `PICSUR_UPDATE_TAG` | 无 | 否 | `update.config.service.ts:96-103` |
| `PICSUR_UPDATE_COMMAND` | 无 | 否 | `update.config.service.ts:105-112` |
| `PICSUR_DOCKER_SOCKET` | `/var/run/docker.sock` | 否，高危 | `update.config.service.ts:114-120` |
| `PICSUR_UPDATE_CONTAINER` | 无 | 否 | `managers/update/self-update.service.ts:761-765` |

all-in-one 与入口脚本额外读取的变量：

| 变量 | 默认 | 读取位置 |
|---|---|---|
| `PICSUR_DATA_DIR` | `/data` | `support/allinone-entrypoint.sh:21`、`Dockerfile.allinone:65` |
| `PICSUR_PGDATA` | `$PICSUR_DATA_DIR/postgres` | `allinone-entrypoint.sh:22` |
| `PICSUR_PG_SOCKET_DIR` | `/run/postgresql` | `allinone-entrypoint.sh:29` |
| `PICSUR_DOCKER_GID` | 无 | `.env.example:69-73`、`docs/MAINTAINING.md` |

### 三、镜像内置默认值

- 常规镜像只固定 `PICSUR_PRODUCTION=true`，见 `Dockerfile:157`
- all-in-one 额外固定 HOST、PORT、DB、静态目录、上传上限、遥测与 verbose 关闭、DATA_DIR，见 `Dockerfile.allinone:53-65`
- 入口脚本对未提供的 DB 口令、admin 口令、JWT secret 自动生成，持久化到 `/data/allinone.env`，权限 0600，并在日志打印，见 `support/allinone-entrypoint.sh:1-14, 228-272`

### 四、数据库中的配置，系统偏好

环境变量只管启动期与基础设施配置；运行时业务配置存在 `e_sys_preference_backend`，键与默认值如下。

| 偏好键 | 默认值 | 类型 | 是否面板可改 | 证据 |
|---|---|---|---|---|
| `host_override` | 空 | string | 是 | `preference-defaults.service.ts:27`、`sys-preferences.enum.ts:41-49` |
| `jwt_secret` | 环境变量或随机 64 位 | string | 否 | `preference-defaults.service.ts:29-39` |
| `jwt_expires_in` | 环境变量或 `7d` | string | 否 | `preference-defaults.service.ts:40-41` |
| `bcrypt_strength` | `10` | number | 否 | `preference-defaults.service.ts:42` |
| `remove_derivatives_after` | `7d`，最小 60 秒 | string | 是 | `preference-defaults.service.ts:44`、`image-manager.module.ts:55-60` |
| `allow_editing` | `true` | boolean | 是 | `preference-defaults.service.ts:45` |
| `conversion_time_limit` | `15s` | string | 否 | `preference-defaults.service.ts:47` |
| `conversion_memory_limit` | `512` MB | number | 否 | `preference-defaults.service.ts:48` |
| `tracking_url` | 空 | string | 是 | `preference-defaults.service.ts:50` |
| `tracking_id` | 空 | string | 是 | `preference-defaults.service.ts:51` |

- 暴露给面板的键清单见 `shared/src/dto/sys-preferences.enum.ts:41-53`
- 固定项通过 API 写入会被拒绝并提示改用环境变量，见 `collections/preference-db/sys-preference-db.service.ts:157-187`
- 偏好缺失时按默认值写库，见 `sys-preference-db.service.ts:189-195`、`preference-common.service.ts:34-118`

### 五、数据库中的配置，用户偏好

| 偏好键 | 默认值 | 类型 | 证据 |
|---|---|---|---|
| `keep_original` | `false` | boolean | `shared/src/dto/usr-preferences.enum.ts:5-7`、`preference-defaults.service.ts:18-22` |

用户偏好按 user_id 存于 `e_usr_preference_backend`，见 `database/entities/system/usr-preference.entity.ts:22-48`。

### 六、死配置与易误解项

| 项 | 事实 | 证据 |
|---|---|---|
| `PICSUR_REDIS_URL` | 服务只打印日志，没有任何 redis 客户端或使用点 | `config/early/redis.config.service.ts:1-20`，全仓 grep 只命中该文件与模块注册 |
| `PICSUR_TELEMETRY` | 上报端点在编译期置空，任何设置都不出网 | `config/config.static.ts:4-8`、`managers/usage/usage.service.ts:55-58` |
| `enable_telemetry` 系统偏好 | 已删除，注释说明是死设置 | `config/late/usage.config.service.ts:47-51` |
| `PICSUR_PRODUCTION` | 只影响日志缓冲、demo 判断等，不决定 schema 同步 | `host.config.service.ts:14-26`、`type-orm.config.service.ts:55-58` |
| `PICSUR_UPDATE_TAG` | all-in-one 部署会故意忽略 | `managers/update/self-update.service.ts:719-737`、`.env.example:82-85` |

### 七、敏感项与迁移注意

- 敏感项：`PICSUR_DB_PASSWORD`、`PICSUR_ADMIN_PASSWORD`、`PICSUR_JWT_SECRET`、数据库内 `jwt_secret`、`PICSUR_VERBOSE`
- `PICSUR_VERBOSE=true` 会把 JWT secret 与 DB 口令明文写进日志，见 `config/late/jwt.config.service.ts:15-20` 与 `AGENTS.md` 第 4 条
- 日志脱敏工具见 `backend/src/util/redact.ts`，异常过滤器与 JWT 校验失败日志都走它，见 `layers/exception/exception.filter.ts:37-40`、`guards/jwt.strategy.ts:30-36`
- 密钥不入库策略：`.env` 同时进 `.gitignore` 与 `.dockerignore`，见 `AGENTS.md` 第 5 条与仓库根目录两个 ignore 文件
- Rust 实现必须保持变量名与默认值逐项一致，否则存量部署行为会变，例如 `PICSUR_MAX_IMAGE_PIXELS=0` 表示不限制，见 `shared/src/util/image-pixel-limit.ts:28-34`

## Caveats / Not Found

- `@nestjs/config` 的 `.env` 加载优先序来自依赖实现而非仓库代码；已核对 `ignoreEnvVars` 只影响校验，标为需在 Rust 侧明确复刻的行为。
- 未发现配置校验 schema 或启动期配置自检，非法值多数被静默回退到默认值，见 `parse-simple.ts:1-46`。
- `PICSUR_DOCKER_GID` 只被部署文档与镜像脚本使用，应用代码未直接读取，见 `.env.example:69-73`。
- 系统偏好的 `conversion_time_limit` 与 `conversion_memory_limit` 没有面板入口，只能改库，见 `sys-preferences.enum.ts:41-49`。

## Related Specs

- `.trellis/spec/picsur-backend/backend/build-and-deploy.md`
- `.trellis/spec/picsur-backend/backend/logging-guidelines.md`
- `docs/MAINTAINING.md`
- `.env.example` 是仓库内的权威变量说明
