# Research: 仓库结构与技术栈

- Query: 为「Picsur 迁移到 Rust」规划提供事实底座，覆盖仓库包结构、技术栈、入口与构建命令
- Scope: internal
- Date: 2026-10-31
- 证据基线: git master b6bd23c，版本号 0.10.7

## Findings

### 一、仓库基本信息

| 项 | 事实 | 证据 |
|---|---|---|
| 仓库 | zhemed/picsur，非 fork，AGPL-3.0-or-later | `package.json:2-4`、`README.md`、`git remote -v` |
| 版本 | 0.10.7 | `package.json:3`、`backend/package.json:3`、`shared/package.json:3`、`frontend/package.json:3` |
| 包管理 | pnpm workspace，锁定 pnpm@9.6.0 | `package.json:44`、`pnpm-workspace.yaml:1-4` |
| Node | v20，`.nvmrc` 为 v20 | `.nvmrc:1`、`.github/workflows/ci.yml:46-51` |
| 工作区成员 | shared、frontend、backend 三个包 | `pnpm-workspace.yaml:2-4` |
| 无 Rust 痕迹 | 全仓无 Cargo.toml/Cargo.lock/rust-toolchain/*.rs | `find` 命令结果为空，2026-10-31 执行 |

### 二、三个包的分工

| 包 | 名称 | 技术栈 | 入口 | 产物 |
|---|---|---|---|---|
| shared | picsur-shared | TypeScript + zod 4，纯类型/DTO/工具库，tsc 编译 | `shared/src/index.ts` | `shared/dist/*.js` |
| backend | picsur-backend | NestJS 12 + Fastify 5 + TypeORM 0.3 + Postgres，ESM | `backend/src/main.ts:19` `bootstrap` | `backend/dist/main.js` |
| frontend | picsur-frontend | Angular 21 + Angular Material + axios + rxjs，SPA，custom-webpack | `frontend/src/main.ts` | `frontend/dist/` |

证据：

- shared 构建脚本 `tsc`，exports 指向 `dist`：`shared/package.json:9-14`、`shared/package.json:24-28`
- backend 依赖清单含 `@nestjs/platform-fastify`、`typeorm`、`pg`、`sharp`、`bcrypt-ts`、`zod`：`backend/package.json:23-67`
- backend 入口与监听：`backend/src/main.ts:19-60`，`app.listen(hostConfig.getPort(), hostConfig.getHost())` 在 `:58-59`
- frontend 使用 Angular 21.2 与 `@angular-builders/custom-webpack:browser`：`frontend/package.json:18-49`、`frontend/angular.json:24-49`
- frontend 入口 main.ts 在 `angular.json` 的 `main` 字段：`frontend/angular.json:28`；worker tsconfig 在 `frontend/angular.json:43`

### 三、构建与运行命令

| 场景 | 命令 | 证据 |
|---|---|---|
| 全量构建 | `pnpm build` 顺序 shared → backend → frontend | `package.json:6` |
| 后端构建 | `nest build`，产物 dist | `backend/package.json:12` |
| 后端生产启动 | `node dist/main` | `backend/package.json:16` |
| 前端构建 | `pnpm clean && pnpm sync:branding && ng build`，默认 production 配置 | `frontend/package.json:12`、`frontend/angular.json:79` |
| 前端品牌资源同步 | 把 `../branding` 拷到 `src/assets/branding` | `frontend/package.json:15` |
| 迁移生成 | `typeorm migration:generate -d ./src/datasource.ts`，带 `PICSUR_PRODUCTION=true` | `backend/package.json:18` |
| Lint / 格式化 | `eslint .` / `prettier --write .` | `package.json:8-9` |
| 生产镜像 | `docker build -t zhemed/picsur:local .` | `Dockerfile:10` |
| all-in-one 镜像 | `docker build -f Dockerfile.allinone -t zhemed/picsur:allinone .` | `Dockerfile.allinone:11-14` |

构建顺序有硬依赖：backend 与 frontend 直接 import `picsur-shared/dist/*`，所以 shared 必须先构建，见 `Dockerfile:54-57` 的注释与命令。

### 四、后端目录结构

| 目录 | 职责 | 关键文件 |
|---|---|---|
| `routes/` | HTTP 控制器，按 api 与 image 分组 | `routes/routes.module.ts:1-8`、`routes/api/api.module.ts:1-19` |
| `managers/` | 业务服务：auth、image、update、usage、demo | `managers/image/`、`managers/auth/`、`managers/update/` |
| `collections/` | DB 访问层，按仓储拆分 | `collections/image-db/`、`collections/user-db/`、`collections/preference-db/`、`collections/system-state-db/` |
| `database/` | TypeORM 实体与迁移 | `database/entities/index.ts:9-17`、`database/migrations/index.ts:16-29` |
| `config/` | early 与 late 两阶段配置服务 | `config/early/early-config.module.ts:1-41`、`config/late/late-config.module.ts` |
| `layers/` | 全局横切：异常过滤、成功包装、限流、zod 校验 | `layers/PicsurLayers.module.ts:1-35` |
| `workers/` | sharp 转换子进程与进程池 | `workers/sharp/worker-pool.ts:1-541`、`workers/sharp.wrapper.ts:1-265` |
| `decorators/` | 权限、multipart、image-id、返回 schema 装饰器 | `decorators/permissions.decorator.ts:1-57` |
| `util/` | brand 消息、日志脱敏、锁、迭代器等 | `util/redact.ts`、`util/mutex-fallback.ts`、`util/branding.ts` |

### 五、前端目录结构

| 目录 | 职责 |
|---|---|
| `app/routes/` | 页面：upload、processing、view、user、images、settings、errors |
| `app/services/api/` | 与后端一一对应的 HTTP 服务 |
| `app/components/` | 通用组件：picsur-img、masonry、paginator、fab 等 |
| `app/i18n/` + `assets/i18n/` | 运行时 i18n，en/zh 两份词典 |
| `app/workers/` | 浏览器内 QOI 编解码 worker |
| `app/util/` | 错误、下载、对话框、bootstrap 等 |

路由根表：`frontend/src/app/app.routing.module.ts:5-53`，默认重定向到 upload，未知路由到 error/404。i18n 词典：`frontend/src/assets/i18n/en.json`、`frontend/src/assets/i18n/zh.json`。

### 六、部署形态

- 唯一对外部署路径是 all-in-one 单容器：应用 + Postgres 17 + 内嵌 `/data`。`Dockerfile.allinone:1-23`
- 常规镜像不是独立部署路径，只作 all-in-one 的基底；最终阶段 `USER node`，`CMD pnpm --filter picsur-backend start:prod`。`Dockerfile:149-173`
- all-in-one 以 root 运行，用 tini 作 PID 1，入口脚本降权跑 Postgres，应用仍以 root 跑。`Dockerfile.allinone:24-51`、`Dockerfile.allinone:75-76`
- 健康检查请求 `/api/info`。`Dockerfile.allinone:70-71`
- compose / install.sh 已退役并从仓库删除，仓库里只剩 `Dockerfile`、`Dockerfile.allinone`。`Dockerfile.allinone:5-8`、仓库根目录列表无 compose 文件

## Caveats / Not Found

- 仓库内没有 `packages/` 目录，问题描述里的「project.json」不存在；等价物是根 `package.json` 加 `pnpm-workspace.yaml`。
- 未发现任何 Rust 代码、Cargo 配置或交叉编译脚手架，迁移是全新工程。
- `.github/workflows` 只有 `ci.yml`，但 `ci.yml:4` 提到 `release-image.yml`；发布流水线文件在当前工作树缺失，标「待确认」。
- 前端 `.browserslistrc`、`tsconfig.base.json` 等细节未逐一展开，迁移影响有限。

## Related Specs

- `.trellis/spec/picsur-backend/backend/directory-structure.md`
- `.trellis/spec/picsur-backend/backend/build-and-deploy.md`
- `.trellis/spec/picsur-frontend/frontend/directory-structure.md`
- `docs/MAINTAINING.md` 维护手册，含部署、发布、验收清单
