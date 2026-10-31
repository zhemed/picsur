# 图片读路径与派生图缓存

## Goal

先切读路径：让真实流量最早进入 Rust 验证，覆盖 `/i/*` 与派生图缓存读取。

## Deliverables

- `/i/:id`、`/i/:id.:ext`、HEAD、`/i/meta/:id` 四个读端点。
- 主文件读取：QOI、animated WebP、SVG 三种 master 原样服务；SVG 响应加 CSP 与 nosniff。
- 派生图缓存：缓存键与 Node 逐字节一致，命中直接返回，未命中按格式转换并落库，遵守每图上限 100。
- 404 语义：品牌占位图加 `no-store`；`/i/meta` 显式 `no-store`；成功响应 30 天 `Cache-Control`。
- 图片 CORS 与 `Cross-Origin-Resource-Policy: cross-origin`。

## Acceptance Criteria

- [ ] 基础 34 项、连库 38 项回归脚本对 Rust 实例全绿。
- [ ] 存在、不存在、已删除、无原图、SVG 五种情况的状态码、缓存头、正文与 Node 一致。
- [ ] 缓存键枚举参数组合后两侧逐字节 diff 为 0。
- [ ] 无损格式转换输出像素零差异；有损格式以像素与尺寸判定，不要求字节相等。
- [ ] HEAD 探测与删除后 404 行为一致。

## Dependencies

依赖 02 后端骨架，以及 03 的 JWT、guest 回退与权限中间件接口；可与 03 的端点部分并行开发，但验收前需要登录端点可用（可先经 Rust 前门转发到 Node 取 token）。

## Rollback

把 `/i` 前缀移出 Rust 归属名单。
