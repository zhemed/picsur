# 实施计划

## 1. 后端

- [ ] 在 `image-file-db.service.ts` 增加按区间读取文件的方法，返回切片与总大小。
- [ ] 在 `image.controller.ts` 视频 GET/HEAD 分支实现单段 Range 解析、206 与 416 响应头。
- [ ] 保持无 Range 请求、无扩展名回退、跨媒体 400 与图片逻辑不变。

## 2. 前端

- [ ] `view.component.ts` 暴露视频直链，判断 mp4 与 webm 可内嵌播放。
- [ ] `view.component.html` 对可播放视频渲染 `<video controls playsinline preload="metadata">`，保留直链、下载与分享模板。
- [ ] `view.component.scss` 约束播放器尺寸与现有布局一致。
- [ ] i18n 仅在有新增文案时补键，en 与 zh 同步。

## 3. 回归脚本

- [ ] 扩展 `support/regression-video-api.sh`：单段 Range、开放区间、后缀区间、越界 416、HEAD Accept-Ranges、切片字节一致。
- [ ] 保留原有 54 项断言并更新通过计数。

## 4. 构建

```bash
export PATH=/root/picsur/.run/node20/bin:$PATH
corepack pnpm install --frozen-lockfile
corepack pnpm -r build
```

- [ ] 后端 build、前端 build 均通过，无 lint 新增错误。

## 5. 本地验证

- [ ] 用临时后端实例与开发库跑扩展后的视频回归脚本，确认 Range 用例全过、原有断言不回退。
- [ ] 用 bw 或 curl 验证详情页视频元素可加载并播放。

## 6. 部署到本机 8080

- [ ] 先 docker cp 新 `frontend/dist` 到容器。
- [ ] 再 docker cp 新 `backend/dist` 与 `shared/dist`。
- [ ] 取得用户对 picsur 重启授权后重启容器，验证 healthy 与 `/api/info` 200。
- [ ] 在本机实例跑扩展视频回归与图片冒烟，浏览器确认播放与拖进度条正常。

## 回滚

- 容器旧 dist 备份保留在 `/root/picsur-data/backups/`；回滚为恢复旧 dist 后重启，重启需重新取得授权。
