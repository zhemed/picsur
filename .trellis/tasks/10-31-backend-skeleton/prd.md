# Rust 后端骨架：工具链、配置、数据层与 info API

## Goal

建立可运行的 Rust 后端骨架，把配置、数据库、迁移、日志与健康检查这些地基先对齐，再往上叠业务。

## Deliverables

- Rust workspace 与 `rust-toolchain.toml`，MSRV 一次钉死；CI 增加 fmt、clippy、test、cargo audit。
- `PICSUR_*` 配置解析：与现状逐项同名同默认值，布尔与整数解析语义一致，verbose 不打印 secret。
- 数据库层：连接、7 个实体到 9 张物理表的映射（含 e_role_backend 与 e_api_key_backend 遗留表，不删不改）、迁移执行机制与现有 `migrations` 账本兼容，不重复执行 DDL。
- `/api/info`、`/api/info/permissions`、`/api/info/formats` 三个只读端点与统一信封。
- 结构化日志、优雅停机、健康检查、静态托管开关骨架。

## Acceptance Criteria

- [ ] `/api/info` 与 Node 逐字段一致，版本号来源明确且与根 `package.json` 同步。
- [ ] 空库、线上备份库、缺一条迁移账本的库三种场景启动自检均通过。
- [ ] Rust 启动不修改数据库 `jwt_secret`，只读。
- [ ] `PICSUR_VERBOSE=true` 不打印 JWT secret 与 DB 口令。
- [ ] SIGTERM 后进程在超时内退出且不丢在途请求。
- [ ] CI 四项 Rust 门禁全绿，cargo audit 无 high。

## Dependencies

依赖 01 基线与契约冻结。产出供 03 至 09 使用。

## Rollback

不接生产流量，直接停进程即可。
