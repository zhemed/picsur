# Research: 数据层与数据库 schema

- Query: 盘点 ORM 实体、表结构、迁移方式、数据库类型与扩展、连接配置来源
- Scope: internal
- Date: 2026-10-31
- 证据基线: git master b6bd23c

## Findings

### 一、数据库与技术选型

| 项 | 事实 | 证据 |
|---|---|---|
| 数据库 | PostgreSQL，TypeORM 0.3.31 + pg 驱动 | `backend/package.json:73-74`、`backend/src/config/early/type-orm.config.service.ts:54` |
| 连接配置 | 全部来自 `PICSUR_DB_*` 环境变量 | `type-orm.config.service.ts:28-49` |
| 默认值 | host localhost、port 5432、username/password/database 均为 picsur | `type-orm.config.service.ts:29-47`、`config/config.static.ts:10` |
| schema 同步 | 默认关闭，只有 `PICSUR_SYNC_SCHEMA=true` 才 synchronize | `type-orm.config.service.ts:54-58`、`config/early/host.config.service.ts:73-81` |
| 迁移自动执行 | `migrationsRun: true`，启动即迁移 | `type-orm.config.service.ts:60` |
| 时区 | `useUTC: true` | `type-orm.config.service.ts:65` |
| 迁移/实体注册表 | 显式数组，供 CLI 与运行时共用 | `database/entities/index.ts:9-17`、`database/migrations/index.ts:16-29` |
| CLI 数据源 | 用 Nest 起一个只有 DatabaseModule 的应用取配置 | `backend/src/datasource.ts:10-23` |
| 部署侧扩展 | all-in-one 首次启动用超级用户建 `uuid-ossp` 扩展 | `support/allinone-entrypoint.sh:143-149` |

补充：`uuid-ossp` 是 uuid 主键 `uuid_generate_v4()` 的依赖，迁移 SQL 里直接使用该默认值，见 `migrations/1661692206479-V_0_3_0_a.ts:8`。entrypoint 注释说明应用启动时 TypeORM 也会建一次，见 `support/allinone-entrypoint.sh:143-145`。

### 二、实体与表

七个实体，证据 `backend/src/database/entities/index.ts:9-17`。表名为类名 snake_case，无显式 `@Entity` 名称。

#### 2.1 `e_image_backend`

| 列 | 类型 | 约束 | 证据 |
|---|---|---|---|
| id | uuid | 主键，uuid 自动生成 | `entities/images/image.entity.ts:8-9` |
| user_id | uuid | 非空 | `:11-15` |
| created | timestamptz | 非空 | `:17-21` |
| file_name | varchar | 非空，默认 image | `:23-27` |
| source_filetype | varchar | 可空 | `:31-35` |
| width / height | int | 可空，0 与非 0 都接受 | `:42-52`、`shared/src/entities/image.entity.ts:10-24` |
| expires_at | timestamptz | 可空 | `:54-58` |
| delete_key | varchar | 可空，`select: false` | `:60-64` |

关联：一对多 derivatives 与 files，见 `:66-70`。

#### 2.2 `e_image_file_backend`

| 列 | 类型 | 约束 | 证据 |
|---|---|---|---|
| _id | uuid | 主键 | `entities/images/image-file.entity.ts:16-17` |
| image_id | varchar | 外键指向 image，级联删除 | `:20-31` |
| variant | varchar | 非空，枚举值 original/master/ingest | `:33-35`、`shared/src/dto/image-entry-variant.enum.ts:1-5` |
| filetype | varchar | 非空 | `:37-38` |
| data | bytea | 非空，图片二进制 | `:40-42` |

唯一约束 `image_id + variant`：`:13-14`。

#### 2.3 `e_image_derivative_backend`

| 列 | 类型 | 约束 | 证据 |
|---|---|---|---|
| _id | uuid | 主键 | `entities/images/image-derivative.entity.ts:15-16` |
| image_id | varchar | 外键，级联删除 | `:19-30` |
| key | varchar | 非空，sha256 转换键 | `:32-34` |
| filetype | varchar | 非空 | `:36-37` |
| last_read | timestamptz | 非空，LRU 清理依据 | `:39-44` |
| data | bytea | 非空 | `:46-48` |

唯一约束 `image_id + key`：`:12-13`。

#### 2.4 `e_user_backend`

| 列 | 类型 | 约束 | 证据 |
|---|---|---|---|
| id | uuid | 主键 | `entities/users/user.entity.ts:23-24` |
| username | varchar | 唯一，索引 | `:26-28` |
| roles | text[] | 非空默认空数组，遗留冻结列 | `:30-40` |
| permissions | text[] | 非空默认空数组 | `:42-50` |
| hashed_password | varchar | 非空，`select: false` | `:52-53` |

#### 2.5 偏好与系统状态三张 key-value 表

| 表 | 列 | 约束 | 证据 |
|---|---|---|---|
| `e_sys_preference_backend` | id uuid、key varchar 唯一、value varchar | key 唯一索引 | `entities/system/sys-preference.entity.ts:12-23` |
| `e_usr_preference_backend` | id uuid、key、value、user_id | key + user_id 唯一，user 外键级联删 | `entities/system/usr-preference.entity.ts:22-48` |
| `e_system_state_backend` | id uuid、key 唯一、value | key 唯一索引 | `entities/system/system-state.entity.ts:3-14` |

偏好值统一以字符串存库，读写时按枚举声明的类型编码解码，见 `collections/preference-db/preference-common.service.ts:34-118`。

### 三、迁移清单，按时间顺序

| 迁移文件 | 作用 | 证据 |
|---|---|---|
| `1661692206479-V_0_3_0_a.ts` | 建 7 张初始表，含已冻结的 `e_role_backend` | `:8-56` |
| `1662029904716-V_0_3_2_a.ts` | 早期表结构演进，待确认具体列 | 文件存在，未逐行展开 |
| `1662314197741-V_0_4_0_a.ts` | 新建 `e_api_key_backend` | `:8` |
| `1662485374471-V_0_4_0_b.ts` | 早期演进，待确认 | 文件存在 |
| `1662535484200-V_0_4_0_c.ts` | 早期演进，待确认 | 文件存在 |
| `1662728275448-V_0_4_0_d.ts` | 早期演进，待确认 | 文件存在 |
| `1672154027079-V_0_5_0_a.ts` | 新建 `e_system_state_backend` | `:8` |
| `1780617600000-AddImageSourceFiletype.ts` | 加 `source_filetype` 列 | `:14-18` |
| `1792195200000-RemoveApikeyPermissionFromRoles.ts` | 从角色权限数组移除 api-key 权限 | `:19-25` |
| `1792281600000-AddUserPermissions.ts` | 加 user.permissions 并从 roles 物化权限 | `:19-37` |
| `1792368000000-RemoveRoleAdminPermission.ts` | 从用户与角色权限数组移除 role-admin | `:18-33` |
| `1792454400000-AddImageDimensions.ts` | 加 width/height 两列，不回填 | `:16-23` |

迁移注册顺序即执行顺序：`database/migrations/index.ts:16-29`。

### 四、schema 行为要点

- 图片二进制全部存 Postgres bytea，没有本地磁盘或 S3 存储适配：`entities/images/image-file.entity.ts:41-42`、`entities/images/image-derivative.entity.ts:47-48`，且 `Dockerfile:162` 注释明确「上传内容存 Postgres，不落盘」
- 没有内容级去重：image 表无 hash 列，upload 每次都新建行，证据 `collections/image-db/image-db.service.ts:21-48`；唯一的 hash 是转换缓存键，见 `managers/image/image.service.ts:404-411`
- 派生图 LRU：读取时最多每天更新一次 last_read，见 `collections/image-db/image-file-db.service.ts:160-184`
- 派生图上限默认 100，超出后仍返回但不入库，见 `config/early/image.config.service.ts:10-12, 62-75`、`managers/image/image.service.ts:260-277`
- 过期图片与陈旧派生图由每分钟一次的定时任务清理，见 `managers/image/image-manager.module.ts:40-81`、`collections/image-db/image-db.service.ts:231-241`
- 用户分页 count 最大 100，page 从 0 开始，pages = ceil(total/count)：`collections/user-db/user-db.service.ts:270-295`
- 图片分页同样 count 最大 100：`image-db.service.ts:66-95`；`list/all` 无分页时默认 100，上限 1000：`image-db.service.ts:9-12, 104-134`
- 批量删除上限 500：`image-db.service.ts:169-174`
- 删除用户受内置账号保护：`collections/user-db/user-db.service.ts:79-92`、`models/constants/special-users.const.ts:1-8`
- 偏好读取用 TypeORM 查询缓存 60 秒：`collections/preference-db/sys-preference-db.service.ts:75-103`
- 偏好缺失时按默认值写回数据库，JWT secret 在无环境变量时随机生成并持久化：`collections/preference-db/preference-defaults.service.ts:24-52`
- `e_role_backend` 表与 user.roles 列均保留，用于回滚，见 `migrations/1792281600000-AddUserPermissions.ts:12-14`、`migrations/1792368000000-RemoveRoleAdminPermission.ts:25-32`
- `e_api_key_backend` 表仍在，API key 功能已于 2026-10-16 移除，见 `managers/auth/guards/main.guard.ts:22-25`

### 五、迁移工具链

- 生成：`typeorm migration:generate -d ./src/datasource.ts`，脚本强制 `PICSUR_PRODUCTION=true`，见 `backend/package.json:17`
- 运行：应用启动时由 TypeORM 执行，`migrationsRun: true`，见 `type-orm.config.service.ts:60`
- 迁移记录表为 TypeORM 默认 `migrations` 表，未做定制，仓库内无覆盖设置
- 迁移均为手写 SQL，含 up 与 down，可回滚，例见 `migrations/1792281600000-AddUserPermissions.ts:19-46`

## Caveats / Not Found

- 六个早期迁移 1662029904716 至 1662728275448 的具体变更未逐行读取，标「待确认」；它们只在存量库升级时有意义，对 Rust 重写新增迁移影响有限。
- 未找到连接池、超时、SSL 相关配置，使用 pg 默认行为，标「待确认」是否需要在新实现中显式配置。
- uuid 扩展由谁创建存在两条路径：all-in-one 入口脚本显式建，TypeORM 也可能自动建；Rust 实现建议显式建扩展，避免依赖 ORM 行为。
- 数据库无 schema 版本以外的表注释、无外键级联之外的一致性约束，应用层承担大部分校验。

## Related Specs

- `.trellis/spec/picsur-backend/backend/database-guidelines.md`
- `.trellis/spec/picsur-shared/backend/database-guidelines.md`
- `.trellis/spec/picsur-shared/backend/error-handling.md`
