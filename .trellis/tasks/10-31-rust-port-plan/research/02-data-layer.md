# Research: Rust 数据层选型与 TypeORM 存量迁移策略

- Query: Picsur 的 Postgres 数据层从 TypeORM 0.3 迁到 Rust 时，sqlx / sea-orm / diesel 怎么选，实体与迁移文件怎么对应
- Scope: mixed —— 仓库事实取自 `backend/src/database/**` 与 `.trellis/spec/picsur-backend/backend/database-guidelines.md`，外部资料取自 crates.io 公开元数据
- Date: 2026-10-31

## Findings

### Files Found

| File Path | Description |
|---|---|
| `backend/src/database/entities/index.ts` | 7 个实体的注册清单 |
| `backend/src/database/entities/users/user.entity.ts` | `e_user_backend`，含冻结列 `roles` 与 `permissions text[]` |
| `backend/src/database/entities/images/image.entity.ts` | `e_image_backend`，uuid 主键、timestamptz、可空 width/height |
| `backend/src/database/entities/images/image-file.entity.ts` | `e_image_file_backend`，bytea 主数据、`image_id` 加 `variant` 唯一 |
| `backend/src/database/entities/images/image-derivative.entity.ts` | `e_image_derivative_backend`，派生图缓存 |
| `backend/src/database/entities/system/*.ts` | 系统/用户偏好与系统状态三张表 |
| `backend/src/database/migrations/*.ts` | 12 条迁移，全部是内联 SQL 字符串 |
| `backend/src/database/migrations/index.ts` | `MigrationList` 顺序注册，顺序即执行顺序 |
| `backend/src/config/early/type-orm.config.service.ts` | 连接参数、`migrationsRun: true`、`useUTC: true`、实体选择 |
| `backend/src/collections/image-db/*.ts` | 分页、级联删除、唯一冲突回读等查询模式 |
| `backend/src/collections/user-db/user-db.service.ts` | bcrypt 强度、权限计算、用户名查询 |
| `backend/src/config/early/multipart.config.service.ts` | 上传大小上限，与 bytea 写入量直接相关 |
| `.trellis/spec/picsur-backend/backend/database-guidelines.md` | 迁移与命名约定，非破坏性优先 |

### Code Patterns

一、实际库结构

从迁移内联 SQL 可以还原出真实的 DDL，与实体声明有若干处差异，迁移时按 SQL 为准：

1. 表名：`e_image_backend`、`e_image_file_backend`、`e_image_derivative_backend`、`e_user_backend`、`e_sys_preference_backend`、`e_usr_preference_backend`、`e_system_state_backend`，加冻结表 `e_role_backend` 与 `e_api_key_backend`。命名策略是 TypeORM 默认类名转 snake_case，见 `database-guidelines.md` §Overview。
2. `image_file` 与 `image_derivative` 的主键列名是 `_id`，不是 `id`，见 `1661692206479-V_0_3_0_a.ts:8` 与 `:17`；实体里用 `private _id?: string` 承接，见 `image-file.entity.ts:17`。
3. 主键默认值全部是 `uuid_generate_v4()`，因此数据库必须装 `uuid-ossp` 扩展。all-in-one 镜像专门带 `postgresql17-contrib` 就是为了这个，见 `.trellis/spec/picsur-backend/backend/build-and-deploy.md` §12。
4. `image_id` 在 `e_image_file_backend` / `e_image_derivative_backend` 上是 `uuid` 且有外键 `ON DELETE CASCADE`，见 `1662485374471-V_0_4_0_b.ts:17`、`:41-45`。`e_image_backend.user_id` 虽然是 uuid，但没有外键约束，见 `1662535484200-V_0_4_0_c.ts:17`。
5. `variant` 列是 `character varying NOT NULL`，不是 Postgres 枚举类型，见 `1661692206479-V_0_3_0_a.ts:17`。TypeORM 的 `enum` 选项没有产生独立枚举类型，这一点对 Rust 侧直接映射成 `String` 很重要。
6. 时间列在 `1662728275448-V_0_4_0_d.ts` 里全部改成 `TIMESTAMP WITH TIME ZONE`：`image.created`、`image.expires_at`、`derivative.last_read`、`api_key.created/last_used`。TypeORM 配了 `useUTC: true`，见 `type-orm.config.service.ts:65`。
7. 数组列：`e_user_backend.roles` 与 `e_user_backend.permissions` 是 `text[] NOT NULL DEFAULT '{}'`，见 `user.entity.ts:39-50` 与 `1792281600000-AddUserPermissions.ts:21`。`e_role_backend.permissions` 也是 `text array`。
8. 二进制列：图片主文件与派生图都存在 `bytea`，单文件上限 128MB，见 `image-file.entity.ts:41-42` 与 `multipart.config.service.ts:14-19`。一次上传顺序写 2 到 3 次，见 `.trellis/spec/picsur-backend/backend/upload-concurrency.md` §3.4。
9. 隐藏列：`hashed_password` 与 `delete_key` 用 `select: false`，见 `user.entity.ts:52-53` 与 `image.entity.ts:60-64`。Rust 侧没有 ORM 的自动列选择，必须显式控制查询字段，否则会把哈希写进 JSON。

二、迁移机制

1. 迁移是 TypeORM 的 `MigrationInterface` 实现，全部内容就是 `queryRunner.query` 内联 SQL，没有事务包裹，见 `database-guidelines.md` §Migrations。
2. 启动即跑迁移：`typeorm.config.service.ts:60` 设 `migrationsRun: true`，容器启动时自动执行待跑迁移。
3. 迁移表是 TypeORM 的 `migrations` 表，列名与语义是 TypeORM 私有的：`id` 整数自增、`timestamp` 大整数、`name` 字符串。现网实测 12 行，见 `.trellis/spec/picsur-backend/backend/build-and-deploy.md` §6。
4. 迁移 ID 是 Unix 毫秒时间戳，文件名 `<ms>-<Name>.ts`，`name` 属性写类名。最新是 `1792454400000-AddImageDimensions.ts`，见 `migrations/index.ts:24`。
5. 迁移风格契约：非破坏性优先、`down()` 只回退结构不回删数据、回填要幂等、迁移里不 import 代码常量。典型例子是 `1792281600000-AddUserPermissions.ts:19-36` 的 `WHERE cardinality(u."permissions") = 0` 守卫，和 `1792195200000-RemoveApikeyPermissionFromRoles.ts:32-37` 的空 `down()`。

三、查询模式

1. 分页：`findMany` 用 `skip: count * page` 加 `take: count`，`page` 从 0 开始，`count` 上限 100，返回 `total` 与 `pages: Math.ceil(total / count)`，见 `image-db.service.ts:66-95` 与 `user-db.service.ts:270-295`。
2. 全量列表：`findAll` 默认 100、硬上限 1000，`total` 仍报真实总数，见 `image-db.service.ts:104-134`。
3. 排序：图片与用户列表都按 `created` 或 `username` 排序，图片是 `created DESC`，见 `image-db.service.ts:78`、`:117`；用户是 `username ASC`，见 `user-db.service.ts:281`。
4. 唯一冲突处理：派生图写入撞 `23505` 时回读已有行而不是报 500，见 `image-file-db.service.ts:130-157`。这是并发正确性要求，Rust 侧要保留同样的「冲突即读」语义。
5. 原子替换：图片主文件用 `upsert` 加冲突列 `image_id, variant`，见 `image-file-db.service.ts:34-55`。
6. 级联删除靠外键 `ON DELETE CASCADE`，删除 `e_image_backend` 一行即清掉文件与派生图，见 `image-db.service.ts:169-195` 与实测记录 `image-api-contracts.md` §3.5。
7. 过期清理：`expires_at < now()` 直接 delete，见 `image-db.service.ts:231-241`；派生图按 `last_read` 早于 N 秒清理，见 `image-file-db.service.ts:196-208`。
8. 没有显式事务：一次上传写 image 行加 1 到 2 次 file 行，失败会留下半成品行，这是现有行为，迁移时不要把「顺手加事务」当成无风险改进，会改变失败语义。
9. 连接池：TypeORM 未配置池参数，沿用 `pg` 默认 10 连接，见 `upload-concurrency.md` §3.4。

四、候选数据层对比

| 候选 | 当前稳定版 | 编译期检查 | 迁移工具 | 与本项目贴合度 | 主要代价 |
|---|---|---|---|---|---|
| sqlx | 0.9.0，2026-05-21，MSRV 1.94 | `query!` 宏连库解析，可离线缓存 | `sqlx migrate`，SQL 文件，`_sqlx_migrations` 表 | 高：仓库就是 7 张表加少量 SQL，没有复杂关联图 | 需要维护 `.sqlx/` 离线缓存，CI 要 `cargo sqlx prepare --check` |
| sea-orm | 2.0.4，2026-09-27，MSRV 1.94 | 实体与 ActiveModel，运行时拼 SQL | `sea-orm-cli` 可从存量库生成实体 | 中高：能从旧库反向生成实体，但动态查询与生命周期学习成本高 | 多一层抽象；对 `text[]`、bytea、`select: false` 这类细节仍要写原生 SQL |
| diesel | 2.3.14，2026-10-07 | schema 宏加类型级校验 | `diesel migration`，支持 up 与 down | 中：同步 API，异步要加 diesel-async | 同步模型与 tokio 混用成本；schema.rs 生成物与手写 SQL 并存 |
| tokio-postgres 加手写 SQL | 0.7 线 | 无 | 无，需要自带 | 低：纯手写容易漂移，错误处理全靠自己 | 编译期没有保护 |
| cornucopia | 待确认 | 从 SQL 文件生成类型 | 无 | 中：与 sqlx 类似但生态小 | 采用面窄，工具链维护风险 |

结论：推荐 sqlx 0.9.0。理由是仓库的查询都是直白 SQL，没有需要 ORM 图遍历的关系；`text[]`、`bytea`、`timestamptz`、`ON CONFLICT` 这些都需要 SQL 级控制；`sqlx migrate` 的 SQL 文件形态可以直接承接现有迁移里的内联 SQL 字符串。sea-orm 作为替代，适合「先反向生成实体再逐条替换」的路径，但首版会多一层抽象负担。

五、实体到 Rust 类型的映射

| 列 | Postgres 类型 | Rust 类型 | 备注 |
|---|---|---|---|
| `id` / `_id` | uuid | `uuid::Uuid` | 需要 `sqlx` 的 `uuid` feature |
| `username` / `filetype` / `variant` | varchar | `String` | 长度无约束，校验在应用层 |
| `roles` / `permissions` | text[] | `Vec<String>` | `sqlx` Postgres 原生支持数组 |
| `data` | bytea | `Vec<u8>` | 大对象全量载入内存，见风险项 |
| `created` / `expires_at` / `last_read` | timestamptz | `chrono::DateTime<Utc>` | 需要 `chrono` feature |
| `width` / `height` | int4 可空 | `Option<i32>` | 旧行为 null 表示未知 |
| `hashed_password` / `delete_key` | varchar 可选 | `Option<String>` | 默认查询不取，显式列选择 |

## Decision

### 推荐方案：sqlx 0.9.0 加 SQL 文件迁移

- 理由：SQL 直白可控；离线缓存让 CI 不需要数据库；`query!` 宏能在编译期发现列名或类型漂移；`PgPoolOptions::max_connections(10)` 可直接对齐现有 pg 默认池。
- 替代方案：sea-orm 2.0.4。代价是多一层实体抽象与生命周期心智，收益是能从旧库反向生成实体、CRUD 样板更少。若团队更看重开发速度而不是 SQL 可见性，可以选它，但要接受 `text[]` 与 bytea 仍写原生 SQL 的混合状态。
- 代价：`sqlx` 0.9 的 MSRV 是 1.94，构建镜像必须钉新版 Rust；离线缓存需要在每次改 SQL 后重新 prepare，否则 CI 红。
- 验证方式：在克隆库上跑 `sqlx migrate run`，再用 `pg_dump --schema-only` 与线上库 diff，期望零差异；`cargo sqlx prepare --workspace --check` 在 CI 必过。

### 推荐方案：迁移 SQL 直接复用，但换迁移账本

- 做法：把现有 12 条迁移的内联 SQL 原样搬成 `migrations/<timestamp>_<name>.sql`，编号沿用原时间戳；对已存在的实例，不重跑历史 DDL，而是**建立基线**：读取 TypeORM 的 `migrations` 表，把 12 条已应用记录写进 `_sqlx_migrations` 并补上对应校验和，之后只执行新迁移。
- 理由：现有 SQL 已经验证过、幂等、非破坏性；重写 DDL 只会引入差异。基线迁移避免在已有数据的库上重复 `CREATE TABLE`。
- 替代方案一：让 Rust 继续读 TypeORM 的 `migrations` 表并自维护。可行但等于自造迁移工具，不回退。
- 替代方案二：用 sea-orm-cli 从现有库反向生成实体，迁移仍用原 SQL。适合选 sea-orm 时使用。
- 代价：需要写一个一次性的账本迁移脚本，并在启动时校验基线完整性；漏掉一条会导致重复执行 DDL 或漏执行后续迁移。
- 验证方式：三级验收。第一，空库从零跑 12 条迁移后的 schema 与线上 `pg_dump` 一致；第二，用线上备份恢复到临时库后执行基线脚本，`_sqlx_migrations` 行数与 `migrations` 表一致，且启动日志没有执行任何 DDL；第三，故意漏一条基线，断言启动自检失败而不是静默继续。

### 推荐方案：禁用 schema 同步，实体结构由 SQL 加测试锁定

- 理由：TypeORM 的 `PICSUR_SYNC_SCHEMA` 默认就是关的，见 `type-orm.config.service.ts:58`；Rust 侧更不应该有自动改表能力。
- 替代方案：用 sea-orm 的 schema 同步做开发期便利。代价是生产风险，且与「回滚到 Node」时的表结构不可预测。
- 代价：每个新字段都要写迁移，开发节奏稍慢。
- 验证方式：CI 里对空库跑迁移后用 information_schema 快照比对，任何未登记的结构差异直接失败。

## Caveats / Not Found

1. 待确认：`e_user_backend.roles` 的 `NOT NULL` 无默认值细节。迁移里 `permissions` 有 `DEFAULT '{}'`，`roles` 没有，靠代码写空数组维持插入，见 `.trellis/spec/picsur-backend/backend/database-guidelines.md` §Migrations 的坑记录。Rust 侧插入用户必须显式写 `roles = '{}'`。验证方法：用 Rust 代码插入一个用户，断言不触发 not-null 违反。
2. 待确认：TypeORM `migrations` 表的精确列定义与 `id` 序列语义。验证方法：`psql \d migrations` 导出定义，写进基线脚本测试。
3. 待确认：`uuid_generate_v4()` 是否在所有部署形态都可用。all-in-one 带 contrib，但外部 Postgres 部署若没装扩展，迁移会失败。验证方法：在干净 Postgres 17 容器上跑迁移，检查扩展。
4. 待确认：bytea 大对象的内存峰值。128MB 单文件经 sqlx 全量加载会产生至少一份 128MB `Vec<u8>`，加转换缓冲区可能到 512MB 以上。验证方法：用最大尺寸夹具压测 RSS，对比 Node 基线。
5. 未找到：仓库没有使用 TypeORM 的 QueryBuilder 复杂联表查询，也没有视图、触发器、存储过程。这降低了迁移到 sqlx 的风险。
6. 未找到：没有数据库级审计表或软删除列，删除是物理删除加外键级联。
