# Research: 迁移策略与分阶段割接

- Query: 从 TypeScript 后端迁到 Rust，用绞杀者式灰度还是一次性重写，数据库共享还是双写，分阶段与回滚点怎么设计
- Scope: mixed —— 仓库事实取自路由、启动副作用、Dockerfile 与部署文档；外部资料仅用于核对 crate 版本
- Date: 2026-10-31

## Findings

### Files Found

| File Path | Description |
|---|---|
| `backend/src/main.ts` | 唯一启动入口与公网端口 8080 |
| `backend/src/app.module.ts` | 静态托管、CORS、调度模块注册 |
| `backend/src/managers/image/image-manager.module.ts` | 每 60 秒清理派生图与过期图片 |
| `backend/src/managers/demo/demo.module.ts` | demo 模式按间隔清空图片 |
| `backend/src/managers/usage/usage.module.ts` | 每 1 小时用量上报，当前端点为空不实际出网 |
| `backend/src/managers/update/update.module.ts` | 启动 2 秒后自愈自升级残留 |
| `backend/src/managers/update/self-update.service.ts` | docker socket 自升级编排，1060 行 |
| `backend/src/routes/image/image.controller.ts` | 图片读取与转码缓存，读路径核心 |
| `backend/src/routes/image/image-manage.controller.ts` | 上传与管理的写路径核心 |
| `Dockerfile` | 常规镜像，多阶段构建 |
| `Dockerfile.allinone` | 唯一部署形态，内嵌 Postgres，数据在 `/data` |
| `support/allinone-entrypoint.sh` | 初始化数据库、生成密钥、启动应用 |
| `support/regression-image-api.sh` | 34 项接口回归 |
| `.trellis/spec/picsur-backend/backend/build-and-deploy.md` | 部署、升级、回滚契约 |
| `docs/MAINTAINING.md` | 运维手册与升级路径 |

### Code Patterns

一、现状部署形态约束

1. 唯一部署路径是 all-in-one 单容器：内嵌 Postgres 17，数据全在 `/data`，见 `docs/MAINTAINING.md` 第 1 节与 `.trellis/spec/picsur-backend/backend/build-and-deploy.md` §12。没有 compose、没有副本、没有编排。
2. 单副本意味着切换期间无法靠多实例做蓝绿；要么同容器内跑两个进程，要么临时起第二个容器共享数据库。
3. 自升级用 docker socket 重建容器，助手容器与替换容器的命名规则复杂，见 `build-and-deploy.md` §13。迁移期若同时保留 Node 与 Rust 两套自升级逻辑，会在同一宿主上互相干扰。
4. 健康检查探的是 `/api/info`，见 `Dockerfile.allinone:70-71`。任何割接都必须让该端点先可用。
5. 数据备份口径是打包 `./data`，迁移前应先做 `pg_dump` 加镜像 ID 记录，见 `build-and-deploy.md` §6.2。

二、启动副作用清单

这些是「切换期间谁负责」必须显式分配的部分，重复执行会改变数据或状态：

| 副作用 | 位置 | 频率或时机 | 过渡期要求 |
|---|---|---|---|
| 派生图清理与过期图片清理 | `image-manager.module.ts:40-44` | 每 60 秒，启动时也跑一次 | 只允许一个实现执行 |
| demo 模式清空图片 | `demo.module.ts:28-38` | 默认 300000ms，仅 demo 开启 | 只允许一个实现执行，先关 Node 或先关 Rust |
| 用量上报 | `usage.module.ts:24-31` | 每 1 小时 | 当前端点为空，实际是 no-op，可忽略 |
| 自升级自愈 | `update.module.ts:17-27` | 启动后 2 秒 | 只能有一个实现处理 docker socket |
| guest 与 admin 账号种子 | `user-db.module.ts:31-55` | 启动时 | 两侧都要能容忍对方已创建，逻辑幂等 |
| JWT 默认值装载 | `late-config.module.ts:40-57` | 启动时 | 只允许一个实现回写 secret，见 `02-auth.md` |
| 迁移执行 | `type-orm.config.service.ts:60` | 启动时 | 过渡期只能由一侧执行迁移 |

三、候选迁移策略

| 策略 | 优点 | 缺点 | 适用条件 |
|---|---|---|---|
| 绞杀者加反向代理灰度 | 每步可回滚，真实流量验证，问题早暴露 | 需要代理层与双进程编排，过渡期两套代码并存 | 有持续用户、不能长时间停机 |
| 一次性重写后整体切换 | 实现简单，不用维护并存期 | 全部风险集中在切换瞬间，画质与契约问题难以提前发现 | 可接受停机，且有完整差分测试与影子验证 |
| 双写数据库加双向同步 | 理论上可长时间并存 | 本项目图片是 bytea 大对象，双写等于双倍存储与两倍失败面；没有事务，冲突无法收敛 | 不推荐 |
| 只读镜像站加写路径代理 | 读多写少的图床很适合 | 需要按方法分流，缓存一致性要处理 | 作为绞杀者的第一段 |

结论：推荐绞杀者，但采用「Rust 做前门、Node 做后备」的单入口形态，不引入 nginx 或 Caddy 这类额外组件。理由是 all-in-one 只有一条 ingress，Rust 可以直接承担反向代理职责，路由表用配置开关控制，开关翻转即回滚。

四、单入口反向代理设计

1. 公网仍是 8080，由 Rust 进程监听。
2. 路由归属表按前缀加方法配置，例如 `/i/*` 读路径归 Rust、`/api/image/upload` 归 Node，未命中回落 Node。
3. 过渡期在容器内以 `127.0.0.1:8081` 起 Node 实例，`PICSUR_PORT=8081`，仅 localhost 可达。
4. Rust 侧用 reqwest 或 hyper 做转发，逐跳复制方法、路径、查询串、必要请求头与请求体，响应则复制状态码、全部响应头与正文。不能只复制 Content-Type。
5. 归属开关放环境变量，形如 `PICSUR_LEGACY_URL` 与 `PICSUR_RUST_ROUTES`，默认全部走 Node，翻转单个前缀即可灰度。
6. 回滚动作是把对应前缀从 `PICSUR_RUST_ROUTES` 移除并重启，秒级恢复；数据库不需要回滚，因为写路径在任一时刻只有一个属主。
7. 替代方案：在宿主上用 Caddy 或 nginx 做前门。代价是多一个组件与一份配置，收益是 Rust 侧少写代理代码。若未来多实例部署，再引入外部代理更合适。

五、分阶段建议

| 阶段 | 归属 | 内容 | 回滚点 | 验收标准 |
|---|---|---|---|---|
| P0 契约冻结 | 无 | 采集 Node 实例的请求响应快照、DB 行快照、图片字节与像素基线 | 不涉及 | 快照可重放，差分工具就绪 |
| P1 骨架 | 无流量 | Rust 起服务，实现配置、DB 连接、`/api/info`、健康检查、静态托管关闭 | 直接停掉 | `/api/info` 与 Node 输出逐字段一致，版本号来源明确 |
| P2 读路径 | `/api/info*`、`/i/meta/*`、`/i/*` | 图片读取与派生图缓存 | 前缀移出 Rust 名单 | 34 项回归全绿，像素与响应头零差异 |
| P3 鉴权 | `/api/user/login`、`/me`、`/me/permissions` | token 双签与密码校验 | 同上 | 双向 token 互认，密码语料全过 |
| P4 管理读路径 | `/api/image/list*`、`/api/user/*` | 列表、分页、权限隔离 | 同上 | DB 行一致，分页语义一致 |
| P5 写路径 | `/api/image/upload`、`update`、`delete*` | 上传、转码、删除、级联 | 同上，需先确认在途请求 | 逐格式像素一致，失败路径无 500，性能不低于基线 |
| P6 偏好与杂项 | `/api/pref/*`、`/api/usage/*`、静态托管 | 偏好、反代上报、SPA | 同上 | 头矩阵与静态路径一致 |
| P7 自升级 | `/api/system/update/*` | docker socket 子系统 | 保留 Node 实现到最后 | 正常升级、杀 helper 自愈、坏镜像回滚三例通过 |
| P8 退役 | 全部 | 移除 Node 进程、Node 构建阶段、旧镜像 | 保留上一个镜像 tag 与数据备份 | 连续运行 7 天无回归，回滚演练通过 |

六、数据库共享与写入纪律

1. 单一 Postgres，两个实现共用；所有迁移只允许**加列加表**，不删列不改语义，直到 Node 路径彻底退役。
2. 写路径按资源划分属主：图片写入归一侧、用户写入归一侧，任一时刻不交叉。这样不需要分布式锁。
3. 缓存类写入要允许两侧互相消费：派生图缓存键由请求参数决定，若两侧算法一致则共享命中，见 `02-image-processing.md` 的待确认项；若不一致，过渡期缓存命中率减半但不影响正确性。
4. 主文件格式必须保持 QOI/动画 WebP/SVG 三种，任何一侧写出的 master 另一侧都要能读。QOI 是规范格式，双向兼容性可测。
5. 不引入双写，不做逻辑复制，不引入 CDC。

## Decision

### 推荐方案：Rust 前门加 Node 后备的绞杀者，单入口

- 理由：部署形态只有一条 ingress，Rust 做前门最省组件；按前缀翻转即回滚；写路径单一属主避免双写复杂度。
- 替代方案：一次性重写加整体切换。若项目所有者接受停机且愿意先做一到两周影子验证，这条也可行，风险是切换瞬间才暴露问题，且没有真实流量的分阶段反馈。
- 代价：过渡期镜像里同时有 Node 与 Rust 两套运行时，镜像体积与构建时间上升；需要额外维护归属开关与代理层，预计 3 到 5 人日。
- 验证方式：每个阶段跑同一套差分工具；灰度期把 1%、10%、50% 流量导向 Rust 观察错误率与 p95；最后全量后保留一周一键回滚能力。

### 推荐方案：数据库共享，不做双写

- 理由：图片数据是 bytea 大对象，双写意味着双倍存储与两倍失败面；仓库没有事务习惯，跨实现冲突无法收敛。
- 替代方案：逻辑复制或 CDC 做单向同步。代价是延迟与一致性复杂，本场景不需要。
- 代价：过渡期必须严格按资源划分写属主，运维要能看懂归属表。
- 验证方式：对同一时刻的两个实现断言写操作只来自属主，检查日志与 DB 的 `xmin` 时间线；灰度期每日对比两侧读到的行数与最近写入时间。

### 推荐方案：启动副作用单属主

- 做法：过渡期 Node 侧设置 `PICSUR_DISABLE_JOBS=true` 一类开关，或直接让 Rust 侧不启动这些任务，二选一，并在部署文档里写死。
- 理由：图片清理、demo 清空、自升级自愈都是会改变数据或宿主状态的副作用，重复执行会造成误删与升级冲突。
- 替代方案：两侧都跑但加数据库租约。代价是引入额外表与租约逻辑，收益不抵复杂度。
- 代价：需要改 Node 代码加开关，属于过渡期补丁，退役时删除。
- 验证方式：过渡期观察日志，同一分钟内清理日志只出现一次；故意两侧都开，断言检测到冲突并只让一侧执行。

## Caveats / Not Found

1. 待确认：Node 侧能否方便地以 `127.0.0.1:8081` 起第二实例并与 Rust 同容器共存。验证方法：在临时容器里起两个进程，确认端口、静态目录、worker 子进程内存预算都能共存。
2. 待确认：动态图片转码在灰度期两侧各自缓存会写入同一张派生表，唯一键冲突处理是否会导致重复转换。验证方法：同一图同一参数分别请求两侧，断言只产生一行派生图，另一侧能读到该行。
3. 待确认：自升级子系统在过渡期由谁负责。若 Rust 只做前门，`/api/system/update/apply` 必须完整转发，且响应要等 Node 写出后再转发；若 Node 容器被替换，代理会短暂失联，需要客户端重试语义。验证方法：在测试实例做一次完整升级演练，观察代理层行为。
4. 待确认：健康检查在灰度期的语义。`/api/info` 由 Rust 直接处理还是转发，会影响容器 ready 判定。建议 Rust 直接实现，保证启动即可用。
5. 未找到：仓库没有 feature flag 框架、没有 canary 基础设施、没有 trace 系统。过渡期的灰度只能靠环境变量与前缀归属，不要假设有更细粒度能力。
6. 未找到：没有多租户或多实例共享数据库的场景，因此不需要考虑跨实例缓存一致性。
