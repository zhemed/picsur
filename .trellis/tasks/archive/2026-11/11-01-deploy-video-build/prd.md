# 部署视频上传版本到本机实例

## 状态

已完成并通过验证。容器已重启加载新后端，新前端在线，视频上传与直链可用；旧构建备份保留可回滚。

## Goal

用户在本机 8080 实例上传视频时页面显示 `An internal error occurred`。把已通过验证的视频上传版本部署到本机实例，使 8080 支持 mp4 与 webm 上传与直链。

## 诊断

- 容器 `picsur` 原运行镜像 `ghcr.io/zhemed/picsur:allinone` 版本 `0.10.7`，旧后端对 `video/mp4` 返回 `InternalFailure: Unsupported mime type`。
- 仓库 `c366450` 已提交视频上传功能，构建产物 `backend/dist`、`shared/dist`、`frontend/dist` 已就绪。
- 结论：原因是旧镜像未部署新功能，不是新代码缺陷。

## 用户决策与授权

- 第一次部署尝试：用户弹窗选择「立即热部署并重启容器」。
- 重启被 S-3 拦截，用户一度选择「暂停部署」，容器回滚到旧构建后保持旧版可用。
- 本次用户指令「继续吧」恢复部署；弹窗点名服务单元，选择「授权重启本机 picsur 容器」。
- 服务授权写入任务级记录后，子会话重启成功。

## 执行结果

- 暂存：新 `backend/dist` 与 `shared/dist` 覆盖到容器 `/picsur` 对应目录，回读与宿主构建 diff 0 行。
- 重启：`docker restart picsur` 成功，容器 StartedAt 更新为 2026-11-01T07:01:48Z，healthy，`/api/info` 200。
- 前端：`frontend/dist` 部署后 `GET /` 引用新 `main.08f0a58b5fff6c5b.js` 与 `runtime.c26db0accd868ead.js`，资源 200；旧 `main.84c8bdfff97bdd8f.js` 被替换；`/assets/i18n/zh.json` 与宿主新构建逐字节一致，含「上传媒体」2 处。
- 视频回归：`support/regression-video-api.sh` 54 passed、0 failed，退出码 0；覆盖 mp4 与 webm 上传 201、直链 200 与 Content-Type、字节与 Content-Length 一致、无扩展名直链、列表识别、mov 400、删除后 404 与 no-store；413 项因未设测试上限而跳过。
- 图片冒烟：png 上传 201、读取 200 且字节一致、删除 201 后 404；原有图片数据未受影响。
- 数据清理：测试视频行 0 条，测试图片已删除；管理员登录 201 且含 token；口令与数据保持。
- 备份：旧三个 dist 备份在 `/root/picsur-data/backups/deploy-video-20261101T055823Z`，8.3MB，含 SHA256SUMS；本次未触发回滚。

## Requirements

- R1 替换容器内后端 `dist`、`shared/dist` 与前端 `dist`，不动数据卷、不改镜像、不改仓库。
- R2 覆盖前备份，失败可回滚；回滚校验用 SHA256SUMS。
- R3 重启后实例健康，`/api/info` 200，管理员可登录，既有图片与用户数据不受影响。
- R4 验证视频上传与直链：mp4 与 webm 上传返回 2xx，`/i/<id>.<ext>` 返回 200 与正确 Content-Type。
- R5 验证图片路径不回归：上传、读取、删除一张 png 的冒烟通过，测试数据清理。
- R6 口令、token、哈希不写入仓库、报告与日志输出。

## Acceptance Criteria

- [x] 容器健康，`/api/info` 返回 200。
- [x] 页面前端引用新构建产物，上传文案为新版。
- [x] mp4 与 webm 上传返回 2xx，直链返回 200 且 Content-Type 正确。
- [x] 图片上传、读取、删除冒烟通过且测试数据已清理。
- [x] 旧产物备份路径已记录，回滚步骤明确。
- [x] 仓库零改动。

## 遗留与风险

- 热部署在容器重启后保持，但容器重建或镜像自升级会退回旧镜像；建议后续用 `support/release-local.sh` 构建并发布新镜像走正式升级路径。
- 容器 `frontend/dist` 有 6 个旧构建惰性文件、`/tmp` 有 2 个探针文件，需 docker exec rm 清理，本轮未做。
- 视频仍为 A 档边界：无 Range/206、无转码与海报、整段进出内存、受 128MB 上限约束。
- allinone 启动 banner 会把管理员口令写入容器日志，属既有设计，建议限制日志访问。
