# 鉴权、用户与权限 API

## Goal

复刻后端鉴权与用户体系，保证迁移期新旧 token 双向互认、权限判定与限流语义一致。

## Deliverables

- JWT：HS256 签发与校验、payload 口径、过期语义、guest 回退、secret 只读来源。
- 密码：bcrypt `$2a$` 校验与生成，`bcrypt_strength` 偏好语义一致。
- 权限：11 个权限字符串、类级与处理器级并集、未声明即拒绝、admin 与 guest 模板。
- 端点：login、register、checkname、me、me/permissions、用户管理 6 个端点。
- 限流层：全局 60 次每 60 秒、登录 30 次每 300 秒、注册 5 次每 300 秒等逐路由阈值与 429 语义。
- admin 与 guest 种子幂等。

## Acceptance Criteria

- [ ] Node 签发 token 在 Rust 通过，Rust 签发 token 在 Node 通过。
- [ ] 20 条密码语料双向验证通过，覆盖多字节、72 字节边界、空串与高强度。
- [ ] 匿名、guest、普通用户、admin 四种身份对权限矩阵每一行结果一致。
- [ ] 删除用户后其旧 token 两侧均失效。
- [ ] `support/regression-user-admin.sh` 对 Rust 实例全绿。
- [ ] 限流超限返回 429 且 `Retry-After` 语义与 Node 一致。

## Dependencies

依赖 02 后端骨架。

## Rollback

灰度期把 `/api/user/*` 前缀移出 Rust 归属名单即可。
