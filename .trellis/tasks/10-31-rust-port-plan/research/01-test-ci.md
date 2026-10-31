# Research: 测试与 CI

- Query: 盘点现有测试、lint、构建脚本、Docker 化方式与发布流水线
- Scope: internal
- Date: 2026-10-31
- 证据基线: git master b6bd23c

## Findings

### 一、结论先行

| 项 | 事实 | 证据 |
|---|---|---|
| 单元测试 | 无 | 全仓 `*.spec.ts` 与 `*.test.ts` 计数为 0，2026-10-31 执行 find |
| 集成测试文件 | 无 | 无 jest、vitest、supertest 配置或依赖 |
| 测试脚本 | `package.json` 无 test 脚本 | `package.json:5-10`、`backend/package.json:10-21`、`frontend/package.json:9-16` |
| 质量门禁 | 构建、依赖审计、lint 三项 | `.github/workflows/ci.yml:34-75` |
| 行为验证 | 靠脚本对运行中的实例做黑盒回归 | `support/regression-image-api.sh`、`support/regression-user-admin.sh` |
| 视觉与布局验证 | 靠本机常驻 Chromium 的手动探针 | `support/gallery-layout-probe.cjs`、`support/visual-contrast-probe.cjs`、`ci.yml:17-18` |

### 二、CI 工作流

文件：`.github/workflows/ci.yml:1-75`，只在 push 与 PR 触发，不构建也不发布镜像，见 `:3-4, 22-26`。

| 步骤 | 命令 | 失败含义 | 证据 |
|---|---|---|---|
| 检出 | actions/checkout 固定 SHA | 无 | `:39` |
| pnpm 安装器 | 固定 9.6.0 | 无 | `:42-44` |
| Node | 固定 20，启用 pnpm 缓存 | 无 | `:46-51` |
| 打印版本 | node -v、pnpm -v | 无 | `:53-56` |
| 装依赖 | `pnpm install --frozen-lockfile` | 锁文件与清单不一致，或源抖动 | `:58-59` |
| 三包构建 | `pnpm build`，顺序 shared、backend、frontend | 类型或编译错误 | `:61-62` |
| 依赖审计 | `bash support/audit-prod.sh` | 后端与共享口径出现告警即失败 | `:64-70` |
| Lint | `pnpm lint`，eslint flat config | 代码问题 | `:72-75` |

- 超时 30 分钟，并发按 ref 取消，见 `:30-37`
- action 全部锁 commit SHA，见 `:20, 39, 42, 48` 与文件头注释
- 注释明确说明该 workflow 不需要浏览器环境，浏览器相关验证在开发机手动跑，见 `:13-18`

### 三、依赖审计口径

脚本：`support/audit-prod.sh:1-100+`

- 判定分两层：后端与共享的生产依赖闭包必须 0 告警；前端浏览器侧允许已知存量，见 `:1-13`、`AGENTS.md` 第 6 条
- 实现方式：`pnpm audit --prod --json` 拿告警，再用 `pnpm-lock.yaml` 计算 backend 与 shared 的生产闭包，逐个判断，见 `:34-35, 57-74`
- registry 默认官方源，可用 `PICSUR_AUDIT_REGISTRY` 覆盖，见 `:28`
- 退出码 0 表示后端与共享 0 告警，1 表示仍有告警，2 表示审计本身失败，见 `:18-21`
- 依赖 `pnpm`、`python3`、`PyYAML`，见 `:23-25, 46-47`

### 四、回归脚本

| 脚本 | 覆盖 | 对运行环境的要求 | 证据 |
|---|---|---|---|
| `support/regression-image-api.sh` | 图片 API 与格式回归，34 项检查 | 需要已启动实例与管理员口令 | `:31-32, 243`、`docs/MAINTAINING.md:106-110` |
| `support/regression-user-admin.sh` | 用户管理流程，口令与权限 | 需要实例与管理员口令 | `:26, 80` |
| `support/bench-upload.cjs` | 上传性能基准，延迟、worker 峰值、内存、容器 CPU | 需要实例、JWT、夹具目录 | `:1-36` |
| `support/gallery-layout-probe.cjs` | 画廊布局探针 | 需要常驻 Chromium | `ci.yml:13-18` |
| `support/visual-contrast-probe.cjs` | 视觉对比度探针 | 需要常驻 Chromium | 同上 |
| `support/make-image-fixtures.cjs` | 生成测试图片 | 无 | 文件存在 |

验收清单固定要求回归脚本 34 项全过，见 `docs/MAINTAINING.md:106-110`。

### 五、构建与质量工具

| 工具 | 配置 | 证据 |
|---|---|---|
| ESLint | flat config，覆盖 TS、JSDoc、扩展名检查、prettier 集成 | `eslint.config.cjs:1-196`、`package.json:5-10, 33-43` |
| Prettier | `.prettierrc.yaml`，忽略 `.prettierignore` | `package.json:8-9`、仓库根两个配置文件 |
| TypeScript | 根 tsconfig.base 加各包 tsconfig | `tsconfig.base.json`、`backend/tsconfig.json`、`frontend/tsconfig.base.json`、`shared/tsconfig.json` |
| EditorConfig | 统一换行与缩进 | `.editorconfig:1-10` |
| 版本固定 | `.nvmrc` 为 v20，`packageManager` 为 pnpm@9.6.0 | `.nvmrc:1`、`package.json:49` |

Node 版本是硬约束：`qoi-img`、`bmp-img`、`posix.js` 走 node-gyp 编译，Node 22.16 以上失败，见 `Dockerfile:33-35`、`.github/workflows/ci.yml:46-47`、`AGENTS.md` 第 3 条。

### 六、Docker 化与发布

- 常规镜像：多阶段构建，node:20 与 node:20-alpine 均锁 digest，自编译 libvips 8.18.7，生产依赖从源码重编 sharp，最终 `USER node`。`Dockerfile:30-173`
- all-in-one 镜像：基于常规镜像，加 Postgres 17 与入口脚本，root 运行，tini 作 PID 1，健康检查打 `/api/info`。`Dockerfile.allinone:1-76`
- 本地发布脚本：`support/release-local.sh`，读根 package.json 版本，推 ghcr.io 的版本 tag 与 allinone tag，发布前检查工作树干净、tag 指向 HEAD、版本不降级、docker 已登录。`support/release-local.sh:1-20`
- apk 版本锁定辅助：`support/apk-versions.sh`，用于 Alpine 修订号变化后重新解析。`Dockerfile:13-19`
- CI 不构建镜像，镜像发布走另一条流水线，见 `ci.yml:3-4`、`ci.yml:18`

### 七、对 Rust 迁移的含义

| 事实 | 影响 |
|---|---|
| 没有任何可复用的自动化测试 | Rust 实现需要先补一套等价的行为测试，尤其图片字节输出、错误码、分页语义 |
| 唯一可执行的验收基线是 34 项回归脚本 | 迁移阶段应把它当作黄金测试，先让 Rust 服务通过同一脚本，见 `support/regression-image-api.sh:243` |
| 回归脚本依赖管理员口令与 HTTP 接口 | 可用同一脚本对新旧实现分别跑，做行为对照 |
| 依赖审计口径针对 npm 生态 | Rust 侧需要换成 `cargo audit` 或等价扫描，并保留后端运行时 0 高危的团队约定 |
| Node 20 原生模块编译约束 | Rust 版可以彻底去掉这层，属于迁移收益，但也会改变部署基线 |
| 镜像用自编译 libvips 提供 HEIF、JXL、JP2 能力 | Rust 若用 image crate 或纯 Rust 解码，需逐格式验证覆盖度 |

## Caveats / Not Found

- 仓库只有 `ci.yml`，但文件头提到 `release-image.yml`，该文件在当前工作树中不存在，标「待确认」。发布实际更可能靠本地 `release-local.sh`，见 `support/release-local.sh:1-20`。
- 回归脚本的实际覆盖项未逐条读取，只确认了框架与结果行格式，需要时用 `grep -n '^ok'` 展开。
- 未发现覆盖率、性能门槛或基准回归门禁，唯一性能工具是手动跑的 `bench-upload.cjs`。
- 未发现 pre-commit 钩子或提交信息校验的仓库内配置，提交锚点规则在全局闸门与 `AGENTS.md` 中，不在仓库代码里。

## Related Specs

- `.trellis/spec/picsur-backend/backend/build-and-deploy.md`
- `.trellis/spec/picsur-backend/backend/quality-guidelines.md`
- `.trellis/spec/picsur-frontend/frontend/quality-guidelines.md`
- `docs/MAINTAINING.md` 第 5 节验收清单
