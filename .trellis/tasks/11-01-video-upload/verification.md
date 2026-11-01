# 验收记录：视频上传与直链（A 档）

## 环境

- 构建：`./.run/node20/bin/node` v20.20.2 + pnpm 9.6.0
- 运行验证：dev Postgres 临时库 `picsur_lead_verify`，后端 `127.0.0.1:8091`，`PICSUR_MAX_FILE_SIZE=2000000`，验证后已停进程并删库
- 生产容器 8080 未参与验证；全过程中复测 `/api/info` 200、容器 healthy

## 构建

| 命令 | 结果 |
|---|---|
| `corepack pnpm --filter picsur-shared build` | 通过 |
| `corepack pnpm --filter picsur-backend build` | 通过 |
| `corepack pnpm --filter picsur-frontend build` | 通过，仅存量 sass/bundle 预算告警 |

## 回归

| 套件 | 结果 |
|---|---|
| `support/regression-video-api.sh` | 55 passed, 0 failed |
| `support/regression-image-api.sh` | 34 passed, 4 failed；4 项为宿主预编译 libvips 缺 JXL/JP2，与 spec §6.1 记录的环境基线一致，非本次回归 |

## 其他检查

- i18n：en / zh 各 249 键，双向缺失集合为空。
- eslint：本任务改动文件 0 problems；全仓 lint 存量 128 个无关错误。
- 浏览器实测：图库混合卡布局 PASS；视频详情页无坏图、无 `<video>` 播放器、直链与下载可用；图片详情页行为不变；上传页 accept 含 mp4/webm，mov 被前端拦截。
- 数据：视频只写 master、无 original 副本；`source_filetype` 为 `video:mp4` / `video:webm`；宽高 null；空文件 400。
- 错误语义：mov/mkv 返回 400 `usrvalidation`，超限 413，视频跨格式 400，删除后 404 加 no-store。

## 已知边界

- 无 Range/206、无页面内播放器、无转码与海报，属用户已接受的 A 档范围。
- 视频整段进出内存，128MB 上限下单请求峰值约 2 到 3 倍文件体积；视频入库放大备份体积。
- 部分界面文案仍带 image 字样，属产品文案口径，本次未扩大改动。
