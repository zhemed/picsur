# 重置本地实例管理员密码

## Goal

用户本地 Picsur 部署实例的管理员口令失效，要求把管理员口令改为用户当轮指定值，并验证可登录。只动本机部署，不发布镜像、不改代码仓库。

## Confirmed Facts

- 实例：Docker 容器 `picsur`，镜像 `ghcr.io/zhemed/picsur:allinone`，宿主端口 8080，数据在容器 `/data`。
- admin 账号由启动时的 `ensureUserExists` 创建，仅在不存在时创建，因此修改环境变量不会更新已存在账号的口令。
- 口令存储：`e_user_backend.hashed_password`，算法 `bcrypt-ts`，强度取系统偏好 `bcrypt_strength`，默认 10。
- 登录入口：`POST /api/user/login`，成功返回 2xx 与 `jwt_token`；NestJS 对 POST 默认 201，故实际为 201，失败返回 401。
- 口令原文与哈希不写入仓库、任务文件、日志或报告；仅在执行会话内传递。

## Requirements

- R1 只更新本机容器内数据库中 admin 用户的 `hashed_password`，影响行数必须为 1。
- R2 更新前备份原哈希，备份位置可追溯。
- R3 验证新口令可登录、错误口令被拒绝、实例继续健康。
- R4 若 `/data/allinone.env` 持久化了管理员口令，先备份再同步，权限保持 0600；有风险则只给建议。
- R5 全程不重启容器、不重装、不删数据、不改代码。

## Execution Result

- 数据库：单条受保护 UPDATE，`WHERE username='admin' AND hashed_password=旧值`，影响行数 1；新哈希读回 1 条、旧哈希 0 条；其它用户与 admin 其它字段指纹前后一致；用户总数 2 对 2。
- 登录：新口令返回 201 且含 `jwt_token`，token 调 `GET /api/user/me` 返回 200、身份 admin、权限 11 项；错误口令 401。
- 健康：`GET /api/info` 200，容器 healthy，容器 StartedAt 未变，确认未重启。
- 持久配置：`/data/allinone.env` 的 `PICSUR_ADMIN_PASSWORD` 行已同步新口令，权限保持 600，其余行字节未变；改前备份 `/data/allinone.env.bak-20261101T054123Z`。
- 旧哈希备份：宿主 `/tmp/picsur-admin-reset-20261101T053938Z/admin-hash-backup.txt`，600，目录 700。
- 仓库零改动；口令与哈希未写入仓库与任务文件。

## Acceptance Criteria

- [x] 用新口令请求 `POST /api/user/login` 返回 2xx 并拿到 token。
- [x] 用错误口令请求返回 401。
- [x] `GET /api/info` 仍返回 200，容器状态 healthy。
- [x] admin 行之外的数据零改动，权限与其它用户不变。
- [x] 备份位置与持久配置处置方式已记录，口令与哈希未落盘到仓库。

## Risks

- 口令强度弱：用户指定值较短且常见，建议后续改为长随机口令；登录限流为 30 次每 300 秒。
- 明文留存：`/data/allinone.env` 按设计保存管理员口令明文，容器启动 banner 会打印；`docker logs` 仍可看到旧口令，建议限制日志访问并在确认后清理或轮换。
- 敏感备份：宿主旧哈希备份与容器 env 备份均含敏感材料，确认无误后可删除或加密归档。
- 会话回显：执行期间系统偏好表中的 `jwt_secret` 行曾出现在会话回显，未复述值、未落盘；建议后续轮换 JWT secret，但轮换会使现有 token 失效且需要重启，本轮未做。
- 直接改库绕过正常改密流程，属应急处置；后续应走正常改密入口。
