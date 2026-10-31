# Picsur 全栈迁移到 Rust：规划

## Goal

为 `zhemed/picsur` 制定一份可直接排期的「全栈迁移到 Rust」规划：明确目标架构、迁移顺序、验收基线与回滚点，并把迁移拆成可独立验收的任务待办。

本轮交付的是**规划**，不是迁移实现。规划获用户批准后，实施由子任务逐项承接。

## Background：现状确认事实

以下事实来自本轮调研，证据见 `research/*.md`。

| 维度 | 现状 |
|---|---|
| 仓库 | pnpm workspace 三包：`shared` 纯 DTO/工具、`backend` NestJS 12 + Fastify 5 + TypeORM 0.3、`frontend` Angular 21 SPA |
| 部署 | 唯一形态是 all-in-one 单容器：内嵌 Postgres 17，数据全在 `/data`，健康检查打 `/api/info` |
| API | 33 个路由处理器、34 个路径形态，成功与失败统一信封 `{success,statusCode,timestamp,timeMs,data}`；11 个权限字符串；无状态 JWT，未登录回退 guest |
| 数据 | 7 个实体、9 张物理表（含 `e_role_backend` 与 `e_api_key_backend` 两张遗留表）、12 个手写 SQL 迁移、启动自动迁移；图片主文件/原文件/派生图全存 Postgres bytea，无本地或 S3 适配，无内容级去重 |
| 图片 | 静图统一转 QOI 主文件，动图转 animated WebP，SVG 经 svgo + DOMPurify 清洗后原样存；转码在子进程池执行，并发上限 `min(CPU 核数, 4)`，默认 512MB / 15s；派生图缓存键是转换参数 JSON 的 sha256 |
| 前端 | 七个页面域 upload、processing、view、user、images、settings、errors；自研 i18n，en / zh 各 327 行；QOI 在 Web Worker 内解码 |
| 质量 | 零单元与集成测试；CI 只做 install、build、audit、lint；行为基线是 `support/regression-image-api.sh` 的 34 项检查 |
| 无此能力 | 无 SSR、无 WebSocket、无 OnlyOffice、无插件系统、无 API key（已移除） |

## 用户决策口径

1. **范围**：全栈迁移，前端也用 Rust 重写。
2. **前端口径**：功能与界面复刻现有 Angular 版本，页面、路由、i18n 文案与交互即验收基准。
3. **存量兼容**：无缝升级，保持 Postgres schema 与 `/data` 目录布局，可回滚。

## Requirements

### R1 规划交付物

- 产出 `prd.md`、`design.md`、`implement.md`。
- 产出覆盖全部迁移阶段的子任务待办，每个子任务有可验证验收标准与显式依赖顺序。

### R2 迁移范围

- 后端：HTTP 层、数据层、鉴权、图片链路、偏好、自升级子系统全部由 Rust 实现。自升级过渡期允许由 Node 侧车暂代，但最终态必须由 Rust 以 bollard 重写，或由用户明确决定放弃该能力。
- 前端：七个页面域由 Rust 前端技术栈重写，视觉与交互对齐现有版本。
- 交付：构建、镜像、发布流程随迁移更新，运行期不再依赖 Node。

### R3 前端对等

- 七个页面域全部可用，路由与深链行为一致。
- en / zh 两份词典逐键复用，语言切换与 `localStorage['picsur.language']` 兼容。
- 图片展示链路对等：`/i/:id.qoi` 输出、HEAD 存在性探测、`/i/meta/:id` 依赖、Web Worker 级 QOI 解码能力在 WASM 内实现。
- 视觉回归以现有 `support/visual-contrast-probe.cjs` 与 `support/gallery-layout-probe.cjs` 为参照。

### R4 后端契约对等

- 端点集合、方法、路径、状态码、响应信封字段与 `timeMs`/`timestamp` 精度一致。
- 11 个权限字符串与类级加处理器级并集的判定规则一致；未声明权限即拒绝。
- 限流阈值与 `Retry-After` 语义一致。
- 响应头契约一致：图片 30 天 `Cache-Control`、404 与 meta 的 `no-store`、SVG 的 CSP 与 nosniff、`Cross-Origin-Resource-Policy`、两套 CORS。
- POST 成功返回 201 等 Nest 默认行为必须逐路由固定。

### R5 数据兼容

- 复用现有 Postgres schema 与 `migrations` 表，不改存量列语义；新迁移只允许加列加表，直到 Node 退役。
- 两张遗留表 `e_role_backend` 与 `e_api_key_backend` 不删不改，保留供回滚到 Node 使用。
- 图片二进制继续存 bytea，`/data` 目录布局不变，`uuid-ossp` 扩展由显式迁移保证。
- 现有实例可直接升级，且保留回滚到上一镜像的能力。

### R6 图片链路对等

- 支持格式集合与现状一致：静图 QOI、JPEG、PNG、WebP、SVG、TIFF、AVIF、HEIF、JXL、JP2、BMP；动图 GIF、WebP。
- 主文件策略一致：静图 QOI、动图 animated WebP、SVG 清洗后原样存；`keep_original` 语义一致。
- 转换参数与语义一致：height、width、rotate、flipx、flipy、greyscale、noalpha、negative、shrinkonly、quality。
- 派生图缓存键必须与现状逐字节一致，老缓存继续命中。
- 转码隔离：硬内存上限与超时可配置，超时或超限不得拖垮主进程。
- 限值一致：上传体积 128000000 字节、像素上限 268402689、每图派生图上限 100，`0` 表示不限。

### R7 鉴权兼容

- JWT 保持 HS256 与现有 payload 口径，存量 token 在迁移期可继续使用。
- 密码校验兼容 `bcrypt-ts` 产出的 `$2a$` 哈希，`bcrypt_strength` 偏好语义一致。
- admin / guest 种子账号幂等；`jwt_secret` 以数据库值为准，Rust 只读不回写，env 仅在库内缺失时一次性落库。

### R8 部署与运维对等

- all-in-one 镜像继续可用，`/data` 备份即全量备份，健康检查仍打 `/api/info`。
- 自升级能力保留：`/api/system/update/check`、`/apply`、docker socket 重建容器、helper 自愈与坏镜像回滚；过渡期可由 Node 侧车承担，最终由 Rust 以 bollard 实现，归属决策在退役阶段前完成。
- 发布流程与版本号来源明确，构建环境不再强制 Node 20 与 pnpm 9.6.0。

### R9 迁移方式

- 采用绞杀者式单入口灰度：Rust 做前门，按路径前缀在 Rust 与 Node 之间翻转，未命中回落 Node。
- 写路径按资源单一属主；启动副作用（图片清理、demo 清空、自升级自愈、种子、迁移执行）同一时刻只允许一侧执行。
- 每个阶段都能通过配置秒级回滚，不需要回滚数据库。

### R10 质量门禁

- 基础 34 项、连库 38 项回归脚本对新旧实现都能跑，差异计数为 0。
- 新增契约测试覆盖信封、状态码、错误类型、响应头、分页语义与图片字节。
- Rust 侧依赖扫描（`cargo audit` 等价物）保持后端 0 高危；前端浏览器侧存量告警不算阻断，口径沿用 `AGENTS.md` 第 6 条。

## In Scope

- 后端 Rust 重写与前端 Rust 重写两条完整工作线。
- 迁移期灰度前门、归属开关、启动副作用单属主机制。
- 契约测试、差分测试、探针验收与 CI 门禁调整。
- 镜像、发布、备份/回滚流程更新。

## Out of Scope

- 本轮不写任何 Rust 代码、不改前端代码、不执行数据迁移、不发布镜像。
- 不覆盖产品功能新增（相册、标签、内容去重、S3 存储、EXIF 方向纠正等）；这些即使要做也另立任务。
- 不在本次迁移中升级 Angular 版本或替换现有验收探针。

## Acceptance Criteria

- [ ] `prd.md`、`design.md`、`implement.md` 三件套齐备，且与用户三项决策一致。
- [ ] 子任务待办覆盖 R2 至 R9 的全部阶段，每个子任务含验收标准与依赖顺序。
- [ ] 每个关键技术选型写明推荐方案、替代方案与验证方式。
- [ ] 风险清单含 QOI 字节兼容、派生图缓存键、状态码与响应头契约、WASM 前端体积、自升级归属等项，且每项有验证或回退手段。
- [ ] 迁移阶段回滚点明确，且不需要回滚数据库。
- [ ] 基础 34 项与连库 38 项回归脚本、视觉对比度探针、画廊布局探针被写入验收基线。
- [ ] 用户明确批准本规划后，才执行 `task.py start` 与提交。

## Risks and Deferred Items

- 前端 Rust 化是最大不确定性：Material 组件复刻与视觉回归工作量以月计，框架选择在子任务规划阶段定稿。
- QOI 与 animated WebP 的字节级输出兼容需要原型验证，不能只验格式可读。
- 派生图缓存键若与现状不一致，过渡期老缓存全部失效，命中率下降但不影响正确性。
- 自升级子系统涉及 docker socket 与容器替换，过渡期必须单属主，否则会互相干扰。
- `PICSUR_VERBOSE` 会打印 JWT secret 与 DB 口令，Rust 实现不复制该行为。
