# Research: 里程碑与交付物建议

- Query: 把 Picsur 从 Node 迁到 Rust 拆成可独立验收的阶段，每阶段的交付物、验收标准、回滚点与依赖是什么
- Scope: mixed —— 阶段划分基于仓库结构与既有实测脚本，工作量估算为经验值并标注待确认
- Date: 2026-10-31

## Findings

### Files Found

| File Path | Description |
|---|---|
| `support/regression-image-api.sh` | 34 项图像接口与格式回归，夹具自给 |
| `support/make-image-fixtures.cjs` | 生成 png/jpg/webp/avif/jxl/jp2/heif/qoi 与超大像素夹具 |
| `support/regression-user-admin.sh` | 用户与权限回归 |
| `support/bench-upload.cjs` | 上传与转换并发压测 |
| `support/gallery-layout-probe.cjs` | 图库布局探针 |
| `support/visual-contrast-probe.cjs` | 全站对比度探针 |
| `support/audit-prod.sh` | 依赖审计口径 |
| `support/release-local.sh` | 镜像构建与发布脚本 |
| `.github/workflows/ci.yml` | 现有 CI 门禁四项 |
| `.trellis/spec/picsur-backend/backend/build-and-deploy.md` | 构建、部署、升级、回滚契约 |
| `.trellis/spec/picsur-frontend/frontend/index.md` | 前端验收清单 |

### Code Patterns

一、现有验收资产可复用性

1. 接口回归：`support/regression-image-api.sh` 自带登录、夹具生成与断言，基础 34 项，连接数据库时 38 项，本机可一条命令跑完，见 `.trellis/spec/picsur-backend/backend/image-api-contracts.md` §6.1。迁移后应原样指向 Rust 实例运行，脚本本身尽量不改。
2. 用户与权限回归：`support/regression-user-admin.sh` 覆盖用户管理路径，可作为鉴权阶段的验收工具。
3. 压测：`support/bench-upload.cjs` 是上传并发基准脚本，见 `.trellis/spec/picsur-backend/backend/upload-concurrency.md` §9.2 的实测数据来源。迁移前后必须同口径复跑。
4. 前端探针：布局与对比度探针依赖真实浏览器，见 `.trellis/spec/picsur-frontend/frontend/index.md` 的检查清单，迁移期只需保证行为不变。
5. 依赖审计：现有口径是后端与共享零告警，浏览器侧存量不算阻断，见 `support/audit-prod.sh` 与 `AGENTS.md` 第 6 条。Rust 侧对应换成 `cargo audit` 与 `cargo deny`。
6. CI 现有四项：装依赖、三包构建、依赖审计、lint，见 `.github/workflows/ci.yml:35-74`。Rust 阶段要新增 Rust 构建、测试、clippy、迁移检查，Node 阶段在退役前保留前端构建。

二、里程碑建议

| 里程碑 | 主题 | 主要交付物 | 验收标准 | 回滚点 | 粗略工作量 |
|---|---|---|---|---|---|
| M0 | 契约冻结与差分工具 | 请求响应快照集、差分脚本、像素与 DB 基线、风险清单确认 | 快照可重放；差分脚本能对两个实例输出字段级差异报告 | 不涉及生产 | 3 到 5 人日 |
| M1 | Rust 骨架 | 可运行的 Rust 服务，配置解析、DB 连接、`/api/info`、健康检查、迁移基线 | `/api/info` 与 Node 逐字段一致；库连接与迁移基线自检通过；启动日志级别一致 | 直接停掉服务 | 5 到 8 人日 |
| M2 | 读路径 | `/i/*`、`/i/meta/*`、`/api/info/formats`、`/api/info/permissions` | 34 项回归全绿；图片像素零差异；缓存头、404 占位图、SVG CSP 一致 | 前缀移出 Rust 归属名单 | 8 到 12 人日 |
| M3 | 鉴权 | 登录、`/me`、`/me/permissions`、权限中间件、限流 | token 双向互认；密码语料全过；权限矩阵 4 种身份一致；429 语义一致 | 同上 | 5 到 8 人日 |
| M4 | 管理读路径 | 图片列表、用户列表、偏好读取、SPA 静态托管 | 分页边界用例表全过；静态路径矩阵一致；偏好只暴露 5 项 | 同上 | 5 到 8 人日 |
| M5 | 写路径与图片管线 | 上传、转码、派生图缓存、删除、级联、worker 进程池 | 逐格式像素一致；8 类故障输入无 500；并发性能不劣于基线 1.2 倍 | 同上，需先排空在途请求 | 15 到 25 人日 |
| M6 | 剩余接口 | 偏好写入、用量反代、系统信息 | 头矩阵一致，反代只转发白名单头 | 同上 | 3 到 5 人日 |
| M7 | 自升级 | docker socket 子系统或明确保留 Node | 正常升级、杀 helper 自愈、坏镜像回滚三例通过 | 保留 Node 实现 | 10 到 20 人日，可延后 |
| M8 | 退役 | 移除 Node 运行时与构建阶段、文档更新、旧镜像归档 | 连续 7 天无回归；回滚演练通过；备份可恢复 | 旧镜像 tag 与数据备份 | 3 到 5 人日 |

三、每个里程碑的详细验收

M0 契约冻结与差分工具

- 交付物：一组 JSON 快照，覆盖 14 个 handler 的成功响应与主要失败响应；图片字节基线；DB 行基线；一个差分脚本，输入两个 base URL，输出字段级差异与图片像素差异。
- 验收：对同一 Node 实例跑两次差分，差异为 0，证明工具本身稳定；对故意改坏一个字段的模拟实例，差分能报出该字段。
- 关键点：豁免项只允许时间戳、`timeMs`、随机生成的 key 与 token；其余严格相等。
- 风险：快照里若包含随机 id 或 token，需要预处理占位符，否则每次运行都红。

M1 Rust 骨架

- 交付物：可执行服务、配置模块、DB 模块、迁移基线脚本、`/api/info`、健康检查、结构化日志、`rust-toolchain.toml`。
- 验收：`curl /api/info` 在 Rust 与 Node 上返回相同字段与值，版本号来源已确定并且与根 `package.json` 同步；空库与线上备份库两种场景迁移基线都通过；进程收到 SIGTERM 能优雅退出。
- 关键点：Rust 当前不在构建环境里，见本轮实测 rustc 与 cargo 均未安装，第一个任务就是补齐工具链与 CI。
- 风险：MSRV 冲突，见 `02-risks.md` R11，必须一次钉到 1.94 以上。

M2 读路径

- 交付物：`/i/<id>.<ext>`、`/i/<id>`、`HEAD`、`/i/meta/<id>`、`/api/info/formats`、`/api/info/permissions`，派生图读取与缓存命中路径。
- 验收：`bash support/regression-image-api.sh <rust-base> <admin-password>` 全绿，期望 34 项；对 9 种格式夹具断言像素；对存在、不存在、已删除、无原图、SVG 五种情况断言状态码、缓存头与正文。
- 关键点：这是第一个真实流量可切的部分，读完即可灰度。
- 风险：编码器差异导致有损格式字节不同，见 `02-risks.md` R3，验收口径要提前定成像素与尺寸而非字节。

M3 鉴权

- 交付物：JWT 签发校验、guest 回退、权限中间件、路由权限表、限流层、登录与注册。
- 验收：Node 签发 token 在 Rust 200，Rust 签发 token 在 Node 200；20 条密码语料双向通过；匿名、guest、普通用户、admin 四种身份对权限矩阵每一行结果一致；删除用户后旧 token 两侧都失效。
- 关键点：guest 行缺失时现有实现会 500，见 `02-auth.md`，这是修复项，要在验收里注明行为变化。
- 风险：secret 回写导致会话失效，见 `02-risks.md` R1。

M4 管理读路径与静态托管

- 交付物：图片列表分页、`list/all`、用户列表、偏好读取、静态资源与 SPA 回落。
- 验收：分页边界用例表，包含 `count=0`、`count=101`、`page=0`、`page` 极大、`total` 不整除、非 admin 越权指定 `user_id`；静态路径矩阵 7 条路径状态码与 Content-Type 一致。
- 关键点：分页语义最容易错，见 `02-risks.md` R7。
- 风险：SPA 回落与 `/api/*` 的边界，见 `02-risks.md` R14。

M5 写路径与图片管线

- 交付物：上传、格式嗅探、转码、SVG 净化、派生图落库与上限、删除与级联、worker 进程池与超时内存限制。
- 验收：`support/make-image-fixtures.cjs` 生成的夹具逐格式上传并取回，无损格式像素零差异；8 类故障输入返回可读 4xx 且服务存活；`support/bench-upload.cjs` 同口径压测，串行 10 张与并发 8 张的 p50 与总耗时不劣于 Node 基线 1.2 倍；派生图缓存键与 Node 逐字节一致。
- 关键点：这是风险最集中的阶段，需要最长的灰度观察期。
- 风险：缓存键顺序、内存上限、QOI 编码速度，见 `02-risks.md` R3、R4、R12、R16。

M6 剩余接口

- 交付物：偏好写入、用量反代、系统更新检查的读部分。
- 验收：偏好只允许 5 项可写，其余返回 400；反代只转发三个白名单头并用连接 IP 覆盖 `X-Forwarded-For`；更新检查的缓存与 `force` 语义一致。
- 关键点：反代是安全面，见 `backend/src/routes/api/usage/usage.controller.ts:26-83`。
- 风险：把客户端头透传会变成开放代理。

M7 自升级

- 交付物：docker socket 自升级子系统，或一份「保留 Node 侧车」的决策记录与部署方案。
- 验收：正常升级、杀 helper 后 rescue 接管、坏镜像只回滚一次并记录 failed，三例通过；不挂 socket 时退化显示可复制命令。
- 关键点：`self-update.service.ts` 1060 行加 helper 脚本 311 行，是全仓最复杂的模块，见 `02-risks.md` R10。
- 风险：与容器编排耦合，任何细微差异都可能导致升级窗口内无容器可用。

M8 退役

- 交付物：移除 Node 运行期依赖、更新 Dockerfile 与文档、归档旧镜像、清理过渡开关。
- 验收：连续 7 天运行无回归；从备份恢复演练通过；回滚演练能在 10 分钟内回到旧镜像；文档里指向 Node 的地方全部更新。
- 关键点：Node 构建阶段在 M8 之前仍保留用于前端，退役不等于删掉全部 Node 工具链。
- 风险：回滚窗口，见 `02-risks.md` R18。

四、验收门与证据

| 门 | 命令或工具 | 通过标准 | 证据保存 |
|---|---|---|---|
| 接口差分门 | 差分脚本对两个实例 | 除豁免字段外差异为 0 | 每次 CI 存 JSON 报告 |
| 图片门 | `support/regression-image-api.sh` 加夹具 | 34 项全绿，无损格式像素零差异 | 断言日志与像素哈希 |
| 用户门 | `support/regression-user-admin.sh` | 全绿 | 脚本输出 |
| 数据门 | 迁移前后行数与关键列哈希 | 完全一致，级联删除结果一致 | SQL 查询结果快照 |
| 故障门 | 8 类输入清单 | 状态码与 type 与 Node 一致，无 500 | 请求响应快照 |
| 性能门 | `support/bench-upload.cjs` | 不劣于基线 1.2 倍 | 原始数据与统计 |
| 依赖门 | `cargo audit` 与 `cargo deny` | 无 high 以上，许可证清单完整 | CI 日志 |
| 前端门 | 布局与对比度探针 | 与 Node 托管时结果一致 | 探针报告 |

## Decision

### 推荐方案：九个里程碑，M1 到 M6 可独立上线，M7 可延后或保留 Node

- 理由：每个里程碑都能独立验收与回滚；读路径先行使真实流量最早参与验证；写路径与升级子系统风险最高，放在后面且需要最长观察期。
- 替代方案：合并 M2 与 M3 为「只读服务」，代价是单个里程碑变大、失败时定位变难。
- 代价：总周期约 57 到 104 人日，按单人节奏约 3 到 5 个月，估算为经验值，待确认。
- 验证方式：每个里程碑结束跑对应验收门，全绿才进入下一个；任何一个门红则回退到上一个可发布状态。

### 推荐方案：先补工具链与差分基础设施

- 理由：本机实测没有 rustc 与 cargo，没有差分工具，没有结构化指标。M0 与 M1 必须先解决这些，否则后续阶段无法判断对错。
- 替代方案：边迁移边补工具。代价是回归会在后期集中爆发。
- 代价：M0 与 M1 约 8 到 13 人日，不产出用户可见功能。
- 验证方式：M0 的差分工具在 Node 对 Node 上差异为 0；M1 的 CI 能对 Rust 代码跑 fmt、clippy、test、audit。

### 推荐方案：M7 默认保留 Node 侧车

- 理由：自升级的收益是运维便利，成本是与 docker 编排强耦合的 2000 行状态机；迁移的核心目标是把图片与数据链路放到 Rust，先把这条做好。
- 替代方案：用 bollard 0.21.1 重写。作为独立任务立项，不阻塞 M8 的 Node 退役决策。
- 代价：退役后可能保留一个小 Node 侧车或一段未迁移代码，需在交接文档中显式记录。
- 验证方式：若保留，写一份侧车部署与健康检查方案；若重写，按 M7 三例验收。

## Caveats / Not Found

1. 待确认：总工作量与各里程碑估算。当前只按代码规模与风险系数粗估，未做任务分解。验证方法：M0 结束后按实际速度重新校准后续里程碑。
2. 待确认：迁移期是否需要额外机器或容器做双跑。all-in-one 单容器形态下，双跑需要临时第二个容器共享同一个 Postgres，验证方法是在测试宿主上起一套临时环境跑一周。
3. 待确认：CI 是否可以引入 Rust 构建。现有 CI 只跑 Node，见 `.github/workflows/ci.yml`。验证方法：先在分支上加一个最小 Rust job，确认缓存与耗时可以接受。
4. 待确认：前端构建产物是否可以在 Rust 镜像里预置。若要做到运行期镜像不含 Node，需要在构建阶段把 dist 拷进 Rust 镜像，验证方法是比对 dist 哈希与 Node 镜像一致。
5. 未找到：仓库没有现成的差分测试框架、契约快照或请求录制工具，M0 需要从零搭一套，这是容易被低估的隐性成本。
6. 未找到：没有性能基线文件，只有 spec 里的表格数据，见 `.trellis/spec/picsur-backend/backend/upload-concurrency.md` §9.2 与 §10.2。M0 应重新采集一份可复现的基线。
