# 基线与契约冻结：golden 快照与差分工具

## Goal

在动任何 Rust 代码前，把现有 Node 实现的行为固化为可重放的 golden 基线与差分工具，作为后续所有迁移阶段的唯一判据。

## Deliverables

- 请求响应快照集：覆盖 33 个路由处理器、34 个路径形态的成功分支与主要失败分支，信封字段、状态码、错误 `type`、响应头齐全。
- 图片基线：8 种源格式夹具加 1 个超大像素故障夹具的 sha256、尺寸、像素哈希，以及 `/i/:id`、`/i/:id.:ext`、HEAD 三类请求的结果。
- DB 行基线：9 张物理表（含 e_role_backend 与 e_api_key_backend 两张遗留表）的行数与关键列哈希，级联删除前后快照。
- 差分脚本：输入两个 base URL，输出字段级差异与图片像素差异；豁免项只允许 timestamp、timeMs、随机 id 与 token。
- 回归脚本验证：确认 `support/regression-image-api.sh` 与 `support/regression-user-admin.sh` 的第一个参数已是 base URL，并登记 Rust 侧差异点清单。

## Acceptance Criteria

- [ ] 差分脚本在 Node 对 Node 上差异为 0，证明工具本身稳定。
- [ ] 对故意改坏一个字段的模拟服务，差分脚本能报出该字段。
- [ ] 基础 34 项、连库 38 项回归脚本可直接对任意 base URL 运行，不需要改脚本逻辑。
- [ ] 显式登记格式覆盖缺口：现有夹具没有 TIFF、BMP、SVG、动图 GIF，缺口由后续子任务补夹具。
- [ ] 基线文件与复跑命令入库，不进入生产镜像。
- [ ] 采集脚本与夹具生成可一键复跑，结果可重复。

## Dependencies

无，最先执行。产出供 02 至 09 全部子任务使用。
