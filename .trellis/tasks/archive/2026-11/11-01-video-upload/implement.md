# 执行计划：视频上传与直链（A 档）

## 1. 前置检查

- 构建环境：仓库要求 Node 20 与 pnpm 9.6.0；先用 `node -v`、`pnpm -v` 确认，不满足时用 corepack 固定版本再继续。
- 改动前先跑一次三包构建作为基线：`pnpm --filter picsur-shared build && pnpm --filter picsur-backend build && pnpm --filter picsur-frontend build`。
- 确认工作区干净、当前任务为 `.trellis/tasks/11-01-video-upload`。
- 本次不改 Dockerfile、不加依赖、不新增环境变量。

## 2. 实施顺序

### 2.1 shared 契约

- [ ] `shared/src/dto/mimes.dto.ts`：新增 `VideoFileType`、`SupportedVideoFileTypes`、`SupportedFileTypeCategory.Video`、mime 与扩展名映射、`SupportedFileTypes` 合并，以及 `MediaKindOfFileType` 纯函数。
- [ ] `shared/src/util/parse-mime.ts`：`ParseFileType` 增加 Video 分支。
- [ ] 不新增实体字段：视频识别沿用 `source_filetype` 的 `video:` 前缀，`EImageSchema` 不改。
- [ ] 构建 shared：`pnpm --filter picsur-shared build`。

验证：`node -e` 或临时脚本断言 `ParseMime2FileType('video/mp4')` 类别为 Video、`FileType2Ext('video:mp4')==='mp4'`、`FileType2Mime('video:webm')==='video/webm'`。

### 2.2 数据模型

- [ ] 零迁移：不改实体、不加迁移、不改 `image-db.service.create()` 签名；视频识别沿用 `source_filetype` 前缀。

### 2.3 后端上传与读取

- [ ] `backend/src/managers/image/image-processor.service.ts`：Video 分支直接返回原片作为 master。
- [ ] `backend/src/managers/image/image.service.ts`：
  - `upload` 推导 `mediaKind`，视频跳过 original 副本；
  - `getFileTypeFromBuffer` 把 `Mime2FileType` 失败转成 `FT.UsrValidation`；
  - `getConverted` 对视频做同格式直出与跨类 400，不写派生表。
- [ ] `backend/src/collections/image-db/image-file-db.service.ts`：新增 `getFileSize` 用 `octet_length(data)`。
- [ ] `backend/src/routes/image/image.controller.ts`：GET/HEAD 视频分支设置 `Content-Type`、`Content-Length`、nosniff，不碰 Range；无扩展名回退条件扩展为 SVG 或视频。
- [ ] 构建 backend：`pnpm --filter picsur-backend build`。

验证：编译通过；用本地实例上传 mp4 后 `GET /i/<id>.mp4`、`GET /i/<id>`、`HEAD` 行为符合设计。

### 2.4 前端

- [ ] `upload.component.html` 与 `.ts`：`[accept]` 加类型预检与 i18n 错误。
- [ ] `images.component.ts/.html/.scss`：`isVideo()`、视频占位卡片与徽章、`data-media-kind` 标记。
- [ ] `view.component.ts/.html/.scss`：视频占位面板、隐藏格式下拉与自定义、直链与下载分支。
- [ ] `view-speeddial`：视频隐藏自定义按钮，下载与分享传文件名。
- [ ] `image.service.ts` 的 `CreateImageLinks`：视频使用直链与链接模板。
- [ ] `util.service.ts`：格式下拉过滤 Video 类别。
- [ ] `download.service.ts`：默认文件名改为调用方传入。
- [ ] 构建 frontend：`pnpm --filter picsur-frontend build`。

### 2.5 i18n

- [ ] 修改 8 条既有文案为中性表述。
- [ ] 新增 `upload.unsupportedType`、`images.videoBadge`、`view.videoNotice`。
- [ ] 运行键集合校验脚本，确认 en 与 zh 缺失集合均为空。

### 2.6 测试与文档

- [ ] 新增视频夹具生成脚本或扩展现有夹具生成器，产出可被 `file-type` 识别的最小 mp4 与 webm。
- [ ] `support/regression-image-api.sh` 增加视频用例：上传、GET 带扩展名、GET 无扩展名、HEAD、列表识别、删除后 404、mov 400、超限 413。
- [ ] `support/gallery-layout-probe.cjs`：视频卡片按 `data-media-kind` 跳过图片断言。
- [ ] 更新 `.trellis/spec/picsur-backend/backend/image-api-contracts.md` 的视频契约与上传字段说明。
- [ ] 更新 `.env.example` 上传大小说明与 `docs/MAINTAINING.md` 验收数字。

## 3. 验证命令

```bash
# 构建三包
pnpm --filter picsur-shared build
pnpm --filter picsur-backend build
pnpm --filter picsur-frontend build

# 图片回归（需要已启动实例与管理员口令）
bash support/regression-image-api.sh <base-url> <admin-password>

# 视频冒烟（脚本落地后）
bash support/regression-video-api.sh <base-url> <admin-password>
```

## 4. 回滚点

| 场景 | 动作 |
|---|---|
| shared 或后端编译失败 | 逐个文件回退到本任务提交前，不影响已发布版本 |
| 无数据库变更 | 本次没有迁移，回滚只回退代码与镜像 |
| 前端视频分支破坏图片流程 | 回退前端视频分支相关文件，后端视频直链仍可用 |
| 发布后需整体回滚 | 回滚镜像与代码提交，数据库按迁移 down 处理 |

## 5. 提交要求

- 提交信息带 `[task:11-01-video-upload]` 锚点。
- 任务目录需有 `directive.md` 记录用户原话与 A 档决策。
- 提交前确认三包构建通过、图片回归无新增失败、i18n 键集合一致。
