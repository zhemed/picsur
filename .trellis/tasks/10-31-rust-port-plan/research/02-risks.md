# Research: 迁移风险注册表

- Query: 从 Node 迁到 Rust 最容易翻车的点有哪些，每项怎么提前发现与验证
- Scope: mixed —— 风险事实来自仓库源码与既有实测记录，验证手段来自现有回归脚本与压测脚本
- Date: 2026-10-31

## Findings

### Files Found

| File Path | Description |
|---|---|
| `shared/src/types/failable.ts` | 错误类型与状态码表，信封兼容的核心 |
| `backend/src/layers/success/success.interceptor.ts` | 成功信封与响应自校验 |
| `backend/src/layers/exception/exception.filter.ts` | 错误信封与缓存头覆盖 |
| `backend/src/routes/image/image.controller.ts` | 图片响应的状态码、头、占位图三件套 |
| `backend/src/managers/image/image.service.ts` | 派生图缓存键与读取语义 |
| `backend/src/collections/image-db/image-db.service.ts` | 分页与删除语义 |
| `backend/src/workers/**` | 进程模型、内存上限、超时与失败语义 |
| `backend/src/managers/update/**` | docker socket 自升级，约 2000 行 |
| `backend/src/config/late/late-config.module.ts` | secret 回写副作用 |
| `backend/src/config/early/*.config.service.ts` | env 语义细节 |
| `Dockerfile` 与 `Dockerfile.allinone` | 构建与部署契约 |
| `.trellis/spec/picsur-backend/backend/build-and-deploy.md` | 已踩过的坑清单 |
| `support/audit-prod.sh` | 依赖审计口径 |

### Code Patterns

一、风险总表

| 编号 | 风险 | 影响面 | 概率 | 发现阶段 | 缓解与验证 |
|---|---|---|---|---|---|
| R1 | JWT secret 被 Rust 回写导致全站登录失效 | 全员会话 | 中 | 骨架期 | Rust 只读 secret；三种场景测试 |
| R2 | bcrypt 兼容性：前缀、72 字节截断、异常哈希 | 登录 | 中 | 鉴权期 | 双向哈希语料 |
| R3 | 图片画质与格式能力回退 | 产品核心 | 高 | 读路径与写路径 | 逐格式夹具加像素断言 |
| R4 | 派生图缓存键字节不一致 | 缓存命中率、存储膨胀 | 高 | 写路径前 | 两侧 key 逐字节 diff |
| R5 | 迁移账本与 schema 漂移 | 数据安全 | 中 | 骨架期 | pg_dump 差分加基线脚本 |
| R6 | 响应信封与头差异 | 前端解析、代理缓存 | 高 | 读路径 | 差分快照加头矩阵 |
| R7 | 分页与列表语义差异 | 图库页 | 中 | 管理读路径 | 边界用例表 |
| R8 | 限流与 IP 语义变化 | 防滥用 | 中 | 灰度期 | 代理链与 429 断言 |
| R9 | i18n 文案被翻译或改写 | UI 一致性与用户可见文案 | 中 | 全阶段 | 词典与错误文案快照 |
| R10 | docker 自升级子系统迁移出错 | 升级能力、宿主安全 | 高 | 最后阶段 | 三例演练；可保留 Node |
| R11 | Rust 工具链与 MSRV 冲突 | 构建 | 高 | P0 | rust-toolchain 钉版本加 CI |
| R12 | 内存与 CPU 限制语义变化 | 稳定性 | 中 | 写路径 | 压测与故障注入 |
| R13 | 时间戳与时区差异 | 契约与测试抖动 | 中 | 全阶段 | 毫秒级格式断言 |
| R14 | 静态托管与 SPA 回落差异 | 前端可用性 | 中 | 读路径末 | 路径矩阵 |
| R15 | 许可证不兼容 | 合规 | 低 | 选型期 | cargo license 清单 |
| R16 | 单图性能预期落空 | 体验 | 中 | 写路径后 | 基线压测 |
| R17 | 安全头与日志泄露 | 安全 | 低 | 全阶段 | 头矩阵加日志样本 |
| R18 | 上线回滚窗口不足 | 事故恢复 | 中 | P8 | 备份与镜像留档 |

二、高风险项详述

1. R1 JWT secret 回写。Node 在启动时若 `PICSUR_JWT_SECRET` 有值会把数据库 `jwt_secret` 覆盖成 env 值，见 `backend/src/config/late/late-config.module.ts:44-57`。过渡期 Rust 若照搬这段逻辑，而两侧 env 不同，会瞬间让所有在线 token 失效。缓解：Rust 首版只读数据库值；env 只在数据库缺失时使用且一次性落库；启动日志明确打印来源但不打印值。验证：三种场景组合测试，见 `02-auth.md`。
2. R2 bcrypt 兼容。口令校验失败全部返回同一句 `Wrong username or password`，见 `backend/src/collections/user-db/user-db.service.ts:199-216`，所以兼容性错误只会表现为「登录不了」，不会报库错误。缓解：双向语料测试包含 20 条口令，覆盖多字节、72 字节边界、100 字节、空串、含空格、JWT 同长度无关项；同时覆盖强度 10 与 12。验证：Node 生成哈希给 Rust 验、Rust 生成哈希给 Node 验，全绿才算通过。
3. R3 图片能力回退。现状镜像的自编译 libvips 支持 HEIF、JXL、JP2、PDF、Magick，宿主预编译 sharp 没有这些解码器，见 `.trellis/spec/picsur-backend/backend/build-and-deploy.md` §8.3 第 4 条。若 Rust 选纯 image crate，JXL/JP2/HEIF 直接消失，`/i/<id>.jxl` 会从 200 变 400 或 500，这是产品能力回退而不是实现细节。缓解：以 libvips 绑定为主引擎，逐格式夹具必须全绿；把 `GET /api/info/formats` 的输出作为能力声明，若能力集变化必须显式决策。验证：`support/regression-image-api.sh` 的 34 项在 Rust 实例上全绿，且额外跑 7 种格式的双向转换。
4. R4 缓存键顺序。键是 `sha256(JSON.stringify({mime, ...options}))`，见 `backend/src/managers/image/image.service.ts:404-411`。Node 的键顺序由 zod 输出对象决定，Rust 的键顺序由结构体声明决定，二者不一致时同一请求会算出两个 key。后果是过渡期缓存双份、派生图上限被更快打满，回滚后旧派生图仍在但新的一样失效。缓解：把 key 生成做成一个独立的、有对照测试的纯函数，字段顺序固定为 mime、height、width、rotate、flipx、flipy、greyscale、noalpha、negative、shrinkonly、quality；布尔与数字的 JSON 表示严格按 JS 惯例。验证：枚举所有参数组合的子集，两侧各生成 key 列表做逐字节 diff，差异必须为 0。
5. R5 迁移账本。TypeORM 的 `migrations` 表与 sqlx 的 `_sqlx_migrations` 表语义不同，已有实例上直接跑 sqlx 迁移会重复执行 DDL 而失败。缓解：基线脚本加启动自检；迁移只允许加列加表；退役前不删列。验证：空库、线上备份库、缺一条基线的库三种情况各跑一次。
6. R6 响应信封。所有 POST 返回 201 是 Nest 默认行为，见 `.trellis/spec/picsur-backend/backend/image-api-contracts.md` §3.6；`timestamp` 是毫秒精度 ISO 串；`timeMs` 是取整毫秒；错误 `type` 是 FT 字符串。任何一项漂移都会让前端 zod 校验失败。缓解：差分工具按字段比对，允许时间类字段做正则与近似容差，其余严格相等。验证：14 个 handler 的成功与主失败分支快照。
7. R10 自升级子系统。`docker-api.service.ts` 421 行、`self-update.service.ts` 1060 行、`update-helper.script.ts` 311 行，加上 helper 与 rescue 容器编排、socket 权限、容器改名状态机，见 `.trellis/spec/picsur-backend/backend/build-and-deploy.md` §13。这是全仓库最不适合首轮迁移的模块。缓解：迁移期由 Node 保留该端点，Rust 只做代理；退役阶段再评估用 bollard 0.21.1 重写，或直接保留一个 Node 侧车只做升级。验证：正常升级、杀 helper 自愈、坏镜像回滚三例，必须在隔离宿主上演练。

三、中低风险项补充

1. R7 分页：`page` 从 0 开始，`count` 上限 100，`pages` 是 `Math.ceil(total / count)`，`list/all` 默认 100 硬上限 1000 且 `total` 报真实值，见 `backend/src/collections/image-db/image-db.service.ts:66-134`。最容易错的是把 page 做成 1 起或把 total 截断。
2. R8 限流：全局 60 次每 60 秒，路由级另有声明，见 `backend/src/layers/PicsurLayers.module.ts:10-19` 与 `easy-throttle.decorator.ts`。计数器在进程内，过渡期两个实现各自计数会让实际限额翻倍；反向代理不补 `X-Forwarded-For` 会让所有请求共享一个 IP 桶。要把 `trustProxy` 的四段网段语义一起迁。
3. R9 i18n：后端 message 是英文原文，前端 `instant` 找不到 key 时原样输出，见 `frontend/src/app/i18n/i18n.service.ts:54-68`。因此迁移不得改 message 文案，也不得把 `Invalid data`、`Wrong username or password` 之类改成 key。词典 en 与 zh 各 327 行且键必须对应，前端不改就不受影响。
4. R11 工具链：本机当前没有 rustc 与 cargo，Node 是 v24.22.0，docker 是 29.7.2，见本轮实测。Rust 侧要新增 `rust-toolchain.toml` 钉版本；MSRV 冲突需要注意，sqlx 0.9 与 sea-orm 2.0 要求 1.94，actix-web 4.18 要求 1.89，image 0.25 要求 1.88，jpegxl-rs 0.16 要求 1.92，取最大公约数即 1.94 以上。CI 要加 `cargo fmt --check`、`cargo clippy -- -D warnings`、`cargo test`、`cargo audit`、`cargo sqlx prepare --check`。
5. R12 资源限制：`setrlimit` 是进程级，tokio 任务是线程，无法在任务级设内存上限，见 `backend/src/workers/sharp/sharp.worker.ts:49-56`。若改成线程模型，512MB 上限变成软约束，一张超大图可拖垮整个实例。
6. R13 时间：`created` 是 `TIMESTAMP WITH TIME ZONE`，TypeORM 配 `useUTC: true`，见 `backend/src/config/early/type-orm.config.service.ts:65`。JSON 输出是 JS `Date.toISOString()`，固定毫秒三位加 Z。Rust 若输出纳秒或省略毫秒，前端 zod 的 `new Date(data)` 仍能解析，但差分测试会红；要统一到 `SecondsFormat::Millis`。
7. R14 静态托管：SPA 深链必须 200 text/html，见 `.trellis/spec/picsur-backend/backend/build-and-deploy.md` §8.3 第 1 条；`/api/*` 与 `/i/*` 不得回落。`@nestjs/serve-static` 版本升级曾经踩过这个坑，Rust 侧要重新测一遍路径矩阵。
8. R15 许可证：仓库是 AGPL-3.0-or-later。候选里 jpegxl-rs 是 GPL-3.0-or-later，按 AGPLv3 第 13 条可以与 GPLv3 组合成 AGPL 作品，但需要在引入前复核并记录；libheif-rs 是 MIT，rs-vips 是 MIT，sqlx 与 axum 是 MIT 或 Apache-2.0。CI 加 `cargo deny` 或 `cargo license` 生成清单。
9. R16 性能预期：现有实测表明单张图基本单核，QOI 编码占近六成耗时，见 `.trellis/spec/picsur-backend/backend/upload-concurrency.md` §10.2。换语言不会改变这个结构；`qoi` crate 的编码速度未知，必须实测后再判断收益，不能把「Rust 更快」写进验收标准。
10. R17 安全与日志：`PICSUR_VERBOSE` 会打印 JWT secret 与 DB 口令，见 `AGENTS.md` 第 4 条与 `backend/src/config/late/jwt.config.service.ts:15-20` 的 verbose 打印。Rust 侧要保留 redact 语义且默认关闭 verbose 的敏感打印。Helmet 头、SVG 的 CSP、`Cross-Origin-Resource-Policy`、`Cache-Control` 都要逐条断言。
11. R18 回滚：本机实测记录显示，新版实例启动约 2 秒后会删掉同 lineage 的 `-prev-` 容器，见 `.trellis/spec/picsur-backend/backend/build-and-deploy.md` §6.2。迁移上线前必须 `pg_dump` 与记录旧镜像 ID，不能依赖 rename 出来的旧容器。

四、验收门建议

1. 差分门：同一批请求分别打 Node 与 Rust，字段级 diff，豁免项只有时间戳与 `timeMs`。
2. 图片门：9 种格式夹具，双向转换，无损格式像素零差异，有损格式断言尺寸与 PSNR。
3. 数据门：迁移前后行数、关键列哈希、外键级联结果一致。
4. 故障门：超像素、损坏图、超时、超内存、并发冲突、不存在 id、非法扩展名、无权限，八类输入断言状态码与 type。
5. 性能门：串行 10 张与并发 8 张的 p50 与总耗时，不劣于 Node 基线 1.2 倍。
6. 依赖门：`cargo audit` 无 high 以上；许可证清单无未知。

## Decision

### 推荐方案：按风险顺序推进，不按模块顺序推进

- 顺序：先做无状态读路径与静态托管，再做鉴权，再做写路径与图片管线，最后做自升级。
- 理由：风险最高的图片画质与自升级都靠后，先把低成本高确定性的部分迁完，可以在早期建立差分基础设施。
- 替代方案：按模块纵向切，例如一次迁完图片域。代价是图片域同时包含读、写、转码、缓存、自升级耦合，单阶段失败面过大。
- 代价：过渡期两套实现并存时间更长。
- 验证方式：每个阶段结束时跑完整的差分门与故障门，任何一门红即停止推进。

### 推荐方案：自升级子系统不首轮迁移

- 理由：约 2000 行状态机代码加容器编排，收益低、风险高，且与图片迁移正交。
- 替代方案：用 bollard 0.21.1 重写并在隔离环境演练三例。可以作为独立后续任务。
- 代价：迁移完成后仍保留一段 Node 代码或一个 Node 侧车。
- 验证方式：若决定保留，需在交接文档中写明该模块仍由 Node 承担及退役条件。

## Caveats / Not Found

1. 待确认：`timeMs` 的精度与来源在 Rust 下能否稳定对齐。验证方法：同一请求压测 1000 次，比较两侧分布，允许 ±1ms 抖动。
2. 待确认：限流计数在反向代理下的 IP 取值。验证方法：构造 `X-Forwarded-For` 多跳，断言取的是可信网段的最后一跳而不是客户端伪造值。
3. 待确认：静态资源缺失时 Node 的行为，见 `02-frontend.md`。验证方法：请求不存在的 js 与 css，记录状态码。
4. 待确认：`qoi` 0.4.1 与 `qoi-img` 的字节输出差异是否影响前端 Web Worker 解码。验证方法：Rust 编码的 QOI 丢给前端 worker 解码，断言像素一致。
5. 未找到：仓库没有熔断、重试、trace 或指标系统，迁移期也没有现成的观测手段，需要先补最小日志与计数，否则灰度期无法判断错误率。
6. 未找到：没有容器级 CPU 与内存配额，单机资源竞争只能靠应用内 worker 上限约束，见 `.trellis/spec/picsur-backend/backend/upload-concurrency.md` §3.4。
