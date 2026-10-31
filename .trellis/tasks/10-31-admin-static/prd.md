# 管理 API、偏好与静态托管

## Goal

补齐管理面与杂项接口，并让 Rust 能完整托管 SPA 静态产物。

## Deliverables

- 图片管理：`/api/image/list`、`list/all`、`update`、`delete`、`delete/key`、`GET /api/image/delete/:id/:key`。
- 用户管理剩余端点与特殊用户清单。
- 系统偏好与用户偏好：只暴露 5 项可写键，固定项写入被拒，`jwt_secret` 不回显。
- 用量反代 `/api/usage/report`：只转发 content-type、accept、user-agent，`X-Forwarded-For` 用真实连接 IP。
- 静态托管：`ServeDir` 加 SPA 回落，`/api/*` 未匹配不回落到 index.html；目录穿越防护。
- 两套 CORS、Helmet 安全头、SPA 深链 200 text/html。

## Acceptance Criteria

- [ ] 分页边界用例表全过：count=0、count=101、page 极大、total 不整除、非 admin 越权指定 user_id。
- [ ] 静态路径矩阵 7 条状态码与 Content-Type 一致，含目录穿越请求。
- [ ] 偏好只暴露 5 项可写，非白名单键返回 400。
- [ ] 反代只转发三个白名单头，不能被当作开放代理。
- [ ] 头矩阵与 Node 逐项一致。

## Dependencies

依赖 03 鉴权与用户 API、04 图片读路径。
