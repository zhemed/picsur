# Research: 视频上传 A 档前端与 i18n 清单

- Query: A 档「只上传与直链」的前端改动清单，覆盖上传 accept 与预检、图库视频占位、详情页直链与下载、i18n
- Scope: internal
- Date: 2026-11-01，同日按用户弹窗决定收窄
- 证据基线: git master 05bdf4e；依赖 shared 侧改动见 `01-implementation-brief.md` 第 3.1 到 3.2 节
- 范围决定: **不做** video 播放器、不做 Range 相关前端逻辑；页面内不播放，只提供直链与下载
- 只读声明: 未改源码/配置，未启动实例，未写业务代码；唯一写入是本任务 research/

## Findings

### 一、结论摘要

1. A 档前端改动比 A+ 小：没有播放器与 Range 逻辑，核心是「上传能收视频、图库能识别、详情页不出现损坏图片、直链与下载可用」。
2. `picsur-img` 不可复用：它的 native 模式是 `<img>`，非 native 模式会 fetch 全量再画 canvas，视频必须绕开它，改为占位块。
3. 详情页要同时处理三件事：预览区换占位、格式下拉与图片嵌入复制框隐藏、`selectedFormat` 初始化为 master，否则直链会变成 `/i/<id>.jpg` 而后端 400。
4. 上传页需要 accept 提示与组件内预检；拖拽与粘贴绕过 accept，预检不能省。
5. 下载建议用同源直链锚点，不要复用 `DownloadService` 的 XHR 下载：后者会把整段视频读进浏览器内存。现有 `downloadService.ts:42-45` 把文件名写死 `'image'`，如需保留按钮式下载应顺带修掉。
6. i18n 新增 4 个必需 key、修改 8 个既有 key；en 与 zh 行号结构一致，插入锚点见第五节。
7. 上传进度能力已存在但不在收窄后的必做项内，列为可选 P2。

---

### 二、现状与关键约束

| 约束 | 事实 | 证据 |
|---|---|---|
| 渲染组件 | `picsur-img` 只有 img 与 canvas 两条路 | `frontend/src/app/components/picsur-img/picsur-img.component.html:7-16`、`:18-39` |
| 画廊缩略图 | 原生 `picsur-img native` 加 WebP 派生图 | `frontend/src/app/routes/images/images.component.html:30-41`、`images.component.ts:324-329` |
| 详情预览 | 用 `picsur-img`，`previewLink` 带 width 参数走图片转码 | `frontend/src/app/routes/view/view.component.html:31-34`、`view.component.ts:86-103` |
| 上传选择 | 无 accept、无 multiple，任何文件可选可拖 | `frontend/src/app/routes/upload/upload.component.html:3` |
| 上传校验 | 只在后端做 | `upload.component.ts:38-45`、`:56-80` |
| 格式下拉 | 由 shared `SupportedFileTypes` 生成，扩集后自动长出视频选项 | `frontend/src/app/util/util.service.ts:36-65` |
| 下载文件名 | 写死 `'image'` | `frontend/src/app/util/download-manager/download.service.ts:42-45` |
| CSP | 页面内不嵌视频，无需 `media-src` | `backend/src/security.ts:5-15` |
| i18n | en 与 zh 结构一致；相关组今日行号见第五节 | `frontend/src/assets/i18n/en.json:82-194`、`zh.json:82-194` |

相对 10-25 的漂移：`api.service.ts` 在 10-29 只改 zod 类型名，进度相关行号未变；i18n 删了页脚块，`upload` 组今日在 `:82-90` 而不是 `:88-96`。

---

### 三、改动清单

#### 3.1 上传页：accept 与客户端预检（必做）

文件：`frontend/src/app/routes/upload/upload.component.html`，约 8 行。

| 位置 | 改动 |
|---|---|
| `:3` | `<input>` 增加 `[accept]="acceptedMimeTypes"`；用属性绑定而非写死字符串，避免 shared 白名单变化后失配 |

文件：`frontend/src/app/routes/upload/upload.component.ts`，今日 81 行。

| 位置 | 改动 |
|---|---|
| `:1-12` 导入 | 增加 shared 的 `ParseMime2FileType`、`ParseExt2FileType`、`SupportedFileTypes`、`FileType2Mime` |
| `:24` `fileControl` 之后 | 增加 `public acceptedMimeTypes: string`，在 `ngOnInit` 由 `SupportedFileTypes.map(FileType2Mime)` 生成；失败项跳过 |
| `:38-45` `onFileChange` | 取第一个文件后先校验；不通过则 `errorService.info('upload.unsupportedType')` 并 return，不导航到 processing |
| `:56-80` `onPaste` | `:68-75` 拿到 blob 后同样校验；全部不支持时用 `upload.clipboardNoImages` 或新 key 提示；通过的文件原样进入 `ProcessingViewMeta` |
| 新增私有方法 | `isSupportedMedia(file: File): boolean`：优先用 `file.type` 走 `ParseMime2FileType`；`file.type` 为空时用扩展名走 `ParseExt2FileType`；两者都失败返回 false。不要只按 `file.type.startsWith('video/')` 放行，否则 mov 会到后端吃 400 |

accept 建议运行时生成：shared 白名单里图片与视频 MIME 拼接，天然覆盖后续新增格式；静态字面量 `image/*,video/mp4,video/webm` 也可接受，但需手动同步。

#### 3.2 处理页与上传进度（可选 P2，不在必做范围）

- 进度能力已存在：`ApiService.postForm` 返回 `RunningRequest`，内部有 `uploadProgress`，见 `api.service.ts:141-147, 268-285`。
- 现状 `ImageService.UploadImage` 只返回 Promise，见 `image.service.ts:46-54`；processing 页 `:35` 直接 await。
- 若后续要做：给 `UploadImage` 增加一个返回 `RunningRequest` 的变体，processing 页订阅进度并在模板显示百分比；i18n 用 `processing.uploadingPercent`。
- A 档收窄后不要求，列此仅避免后续重复调研。

#### 3.3 格式下拉过滤（必做）

文件：`frontend/src/app/util/util.service.ts`，今日 70 行左右，`getBaseFormatOptions` 在 `:36-65`。

| 位置 | 改动 |
|---|---|
| `:44` `SupportedFileTypes.flatMap` | 回调里先判断类型：`const parsed = ParseFileType(mime); if (HasFailed(parsed)) return []; if (parsed.category === SupportedFileTypeCategory.Video) return [];`，与现有 SVG 过滤 `:47` 并列 |
| `:1-10` 导入 | 增加 `ParseFileType`、`SupportedFileTypeCategory`、`HasFailed` |

不改这里会导致图片详情页出现 MP4、WEBM，点选后后端返回 400，属于明确回归。

#### 3.4 图库卡片（必做）

文件：`frontend/src/app/routes/images/images.component.ts`，今日 450 行以上。

| 位置 | 改动 |
|---|---|
| `:1-30` 导入区 | 增加 shared 的 `IsVideoFiletypeIdentifier` |
| `:230-247` `getThumbnailUrl` 附近 | 新增 `public isVideo(image: EImage): boolean`：优先 `IsVideoFiletypeIdentifier(image.source_filetype)`；无 media_kind 的零迁移方案下这是唯一判定；若后续加了 `media_kind`，再加 `image.media_kind === 'video'` 双判 |
| `:250-380` | 尺寸推导、`isSmallThumb`、`buildThumbUrl`、`onThumbLoaded` 均不改；视频卡片不渲染 picsur-img，这些方法不会对其执行 |
| `:383` `viewImage`、`:387` `deleteImage` | 不改 |

文件：`frontend/src/app/routes/images/images.component.html`，约 75 行。

| 位置 | 改动 |
|---|---|
| `:30-41` `gallery-thumb` 块 | `*ngIf` 分叉：图片保持现有 `picsur-img`；视频渲染占位块，建议 `div.video-thumb`，含播放图标与 VIDEO 徽章，并带 `data-media-kind="video"` 供探针与测试定位 |

模板示意：

```html
<div class="gallery-thumb">
  <picsur-img *ngIf="!isVideo(image)" ... 现有绑定 ... ></picsur-img>
  <div *ngIf="isVideo(image)" class="video-thumb" data-media-kind="video">
    <mat-icon>movie</mat-icon>
    <span class="video-badge">{{ 'images.videoBadge' | translate }}</span>
  </div>
</div>
```

文件：`frontend/src/app/routes/images/images.component.scss`，`gallery-thumb` 在 `:43`。

| 位置 | 改动 |
|---|---|
| `:43` 之后 | 新增 `.video-thumb` 与 `.video-badge`，沿用卡片 4:3 盒子尺寸与圆角；不要改 `.gallery-grid` 与 `.gallery-card` 的既有尺寸，否则动到布局探针基线 |

#### 3.5 详情页（必做）

文件：`frontend/src/app/routes/view/view.component.ts`，今日 258 行。

| 位置 | 改动 |
|---|---|
| `:1-30` 导入 | 增加 `IsVideoFiletypeIdentifier`；若做下载文件名再加 `FileType2Ext` |
| `:36-80` 字段与 getter 区 | 新增 `public get isVideo()`；新增 `public get videoLink()`：`GetImageURL(this.id, metadata.fileTypes.master)`；新增 `public get videoDownloadName()`：`file_name + '.' + ext`，ext 由 `FileType2Ext(master)` 得到，失败回退 `mp4` |
| `:44-55` 构造器 | 若下载改用 `DownloadService` 则注入；用直链锚点则不需要改构造器 |
| `:86-103` `previewLink` | 视频分支直接返回空串或 `videoLink`，避免拼 width 与 shrinkonly 触发图片转码 |
| `:105-119` `imageLinks` | 不改逻辑；`selectedFormat` 对视频会被初始化为 master |
| `:121-193` `ngOnInit` | `:161-189` 默认格式块：视频判断放最前，`selectedFormat = metadata.fileTypes.master`，并跳过 PNG 特判；否则默认 JPEG 会让 source 直链变成 `/i/<id>.jpg` 而后端 400 |
| `:205-221` `updateFormatOptions` | 视频分支直接 `this.formatOptions = []` 并 return |
| `:224-235` `getImageLinkFiletype` | 视频分支返回 master filetype，让复制出的直链带 `.mp4` |
| `:237-248` `getOriginalFormatLabel` | 视频不进入下拉，可保留 |

文件：`frontend/src/app/routes/view/view.component.html`，约 80 行。

| 位置 | 改动 |
|---|---|
| `:31-34` 预览块 | 条件双渲染：图片保留 `picsur-img`；视频改为占位块，内含图标、标题、说明与下载锚点。**不要**出现 `<video>` 标签 |
| `:36-40` 直链复制框 | 保留；`imageLinks.source` 对视频是 `/i/<id>.mp4`；标签文案由 `view.imageUrl` 中性化 |
| `:41-52` 格式下拉块 | 外层加 `*ngIf="!isVideo"` |
| `:59-72` markdown、html、bbcode、rst 四个复制框 | 视频隐藏或全部加 `*ngIf="!isVideo"`；这些模板是图片语法，A 档只承诺直链 |

视频占位块建议结构，仅作参考：

```html
<div class="col-12 py-3">
  <picsur-img *ngIf="!isVideo" class="uploadedimage" [src]="previewLink"></picsur-img>
  <div *ngIf="isVideo" class="video-placeholder">
    <mat-icon>movie</mat-icon>
    <h3>{{ 'view.videoNoPreviewTitle' | translate }}</h3>
    <p>{{ 'view.videoNoPreviewDescription' | translate }}</p>
    <a mat-stroked-button [href]="videoLink" [attr.download]="videoDownloadName" target="_blank" rel="noopener">
      {{ 'common.actions.download' | translate }}
    </a>
  </div>
</div>
```

文件：`frontend/src/app/routes/view/view.component.scss`，`:1-4` 已有 `.uploadedimage`。

| 位置 | 改动 |
|---|---|
| `:1-4` 之后 | 新增 `.video-placeholder`：居中、边框或浅色底、图标与文案间距；`video` 不需要样式，因为不渲染 video 元素 |

#### 3.6 操作按钮（轻改）

文件：`frontend/src/app/routes/view/view-speeddial/view-speeddial.component.html`，今日 38 行。

| 位置 | 改动 |
|---|---|
| `:15-21` 自定义按钮 | 加 `*ngIf="!isVideo"`，视频没有转码参数可自定义；编辑、删除按钮 `:22-37` 保留 |
| `:8-14` 分享按钮 | 保留；分享的是直链 |

文件：`frontend/src/app/routes/view/view-speeddial/view-speeddial.component.ts`，今日 170 行左右。

| 位置 | 改动 |
|---|---|
| `:40-46` 输入区 | 增加 `public get isVideo()`，来源 `metadata` 的 `source_filetype` 或 `fileTypes.master` |
| `:96-102` `download()` | 保留；建议把 `image.file_name` 传入下载服务，避免文件名写死 `image` |
| `:104-110` `share()` | 保留 |
| `:142` `customize()` | 加视频防御：直接 return，避免旧 DOM 或快捷键绕过按钮 |

#### 3.7 下载（必做一处，可选一处）

文件：`frontend/src/app/util/download-manager/download.service.ts`，今日 132 行。

| 位置 | 改动 |
|---|---|
| `:40-59` `downloadFile` | `:43` 的 `'image'` 改为可传入的 `fileName`，默认 `'file'`；`showDownloadDialog` 用传入值。XHR 下载会把整段文件读进内存，大视频不推荐走这里 |
| `:83-131` `shareFile` | 不改；直链分享已足够，Files 分享对 128MB 视频不现实 |

推荐视频下载走 3.5 的直链锚点，`[attr.download]` 在同源生效，不产生 JS Buffer；只有需要进度条时才考虑 XHR 路径。

#### 3.8 picsur-img 与后端契约不改

`picsur-img` 保持图片与 QOI 专用，视频分支用占位块绕开；`CreateImageLinks` 与 `ImageLinks` 无需为 A 档改造，因为详情页对视频隐藏四个嵌入复制框，只保留直链。若 Lead 后续想给视频提供 markdown、html 模板，再按媒体类型分支，属 B 档或增强项。

---

### 四、直链与下载行为约定

| 场景 | 行为 |
|---|---|
| 详情页直链复制框 | 值形如 `<origin>/i/<id>.mp4`，标签为 File URL 或等价中性文案 |
| 点击下载锚点 | 同源链接加 `download` 属性，浏览器直接保存文件，文件名用 `file_name + 扩展名`；不经 XHR，不占 JS 内存 |
| 点击直链或在新标签打开 | 浏览器按 `Content-Type: video/mp4` 处理；Chrome 桌面通常内联播放，Safari 与部分环境可能直接下载，属 A 档已接受行为 |
| speeddial 下载按钮 | 若保留，走 `downloadFile`，文件名用 `image.file_name`；大视频提示走直链 |
| 分享 | 分享直链 URL；不支持 Files 分享的大文件不强行构造 File |
| 无扩展名直链 | 后端已回落 master，可播放或下载；UI 仍优先给带扩展名的直链 |

---

### 五、i18n 改动

en 与 zh 结构、行号完全一致。今日锚点：`common.actions` 在 17-25、`upload` 组 82-90、`images` 组 91-108、`view` 组 120-166、`processing` 组 191-194。

#### 5.1 新增 key

| key | 插入位置 | en | zh | 使用位置 |
|---|---|---|---|---|
| `common.actions.download` | common 组 `:25` view 之后 | Download | 下载 | 详情页视频占位块下载按钮 |
| `upload.unsupportedType` | upload 组 `:86` permissionRequired 之后 | This file type is not supported | 不支持此文件类型 | 上传类型预检失败的 toast |
| `images.videoBadge` | images 组 `:97` uploadedByYouAlt 之后 | VIDEO | 视频 | 图库视频卡片徽章 |
| `view.videoNoPreviewTitle` | view 组 `:121` imageFallbackName 之后，或紧随 `:133` editTooltip 之后 | Video file | 视频文件 | 详情页占位标题 |
| `view.videoNoPreviewDescription` | 紧随上一条 | This video cannot be played inline. Use the direct link or download it. | 该视频不能在页面内播放，请使用直链或下载。 | 详情页占位说明 |

可选：做客户端大小预检时再加 `upload.tooLarge`；做上传进度时再加 `processing.uploadingPercent`。两者都不在必做范围。

#### 5.2 修改既有 key

| key | 今日行 | 建议 en | 建议 zh | 原因 |
|---|---|---|---|---|
| `upload.title` | 83 | Upload Media | 上传媒体 | 视频也走上传页 |
| `upload.dropHint` | 84 | Drag and drop / paste an image or video here, or click to select a file | 将图片或视频拖放到此处 / 粘贴到此处，或者点击选择文件 | 同上 |
| `upload.clipboardNoImages` | 88 | Your clipboard does not contain any images or videos | 剪贴板中没有图片或视频 | 粘贴路径支持视频 |
| `images.uploadedByYouAlt` | 97 | File uploaded by you | 由您上传的文件 | 图库 alt 同时用于视频卡片 |
| `images.deleteConfirmTitle` | 98 | Are you sure you want to delete this file? | 您确定要删除这个文件吗？ | 视频不是图片 |
| `view.imageUrl` | 123 | File URL | 文件 URL | 视频直链也用它 |
| `view.downloadTooltip` | 130 | Download the file | 下载文件 | 中性化 |
| `view.shareTooltip` | 131 | Share file | 分享文件 | 中性化 |

不建议改 `view.imageFormat`、`view.markdown`、`view.html`、`view.bbcode`、`view.rst`、`images.defaultAlt`，它们对视频保持现状即可，相关控件在视频下已隐藏。

#### 5.3 校验命令

```bash
python3 - <<'PY'
import json
en = json.load(open('frontend/src/assets/i18n/en.json'))
zh = json.load(open('frontend/src/assets/i18n/zh.json'))
def flat(d, prefix=''):
    out = {}
    for k, v in d.items():
        key = f'{prefix}.{k}' if prefix else k
        if isinstance(v, dict):
            out.update(flat(v, key))
        else:
            out[key] = v
    return out
a, b = flat(en), flat(zh)
print('missing in zh:', sorted(set(a) - set(b)))
print('missing in en:', sorted(set(b) - set(a)))
print('counts:', len(a), len(b))
PY
```

期望两组缺失为空且计数相等。插入 key 后旧行号会整体后移，改完以命令结果为准。

---

### 六、前端验收断言

#### 6.1 手动验收

1. 上传页选择器过滤到图片与 mp4、webm；拖入 mov 或 pdf 时前端提示不支持，不发请求。
2. 上传 mp4 成功，详情页不出现损坏图片，显示视频占位、说明、直链复制与下载按钮。
3. 点击下载按钮保存 `.mp4` 文件，字节与上传一致。
4. 复制直链在新标签打开，浏览器按视频处理，可播放或下载，取决于浏览器设置。
5. 图库视频卡片显示占位与 VIDEO 徽章；图片卡片布局不变。
6. 图片详情页格式下拉不出现 MP4、WEBM；原有图片转码、下载、复制不变。
7. 视频详情页不显示格式下拉与四个图片嵌入复制框。
8. 删除视频后详情页与直链均为 404，直链响应 no-store。
9. 混合版本：旧后端不返回 `media_kind` 时，视频卡片仍能靠 `source_filetype` 判定。

#### 6.2 探针增量

文件：`support/gallery-layout-probe.cjs`。

| 位置 | 改动 |
|---|---|
| `:56-57` | 图片选择器保持；新增视频卡片断言：`card.querySelector('[data-media-kind="video"]')` 存在且有 `.video-badge` |
| `:139` | 弹出层统计只统计图片元素；视频详情页断言存在 `.video-placeholder`，且不存在损坏的 img |
| `:200-201` | 全量枚举仍只针对 `picsur-img`；视频卡片没有 picsur-img 属期望 |
| `:545-546` | 等待就绪条件只约束图片卡片；视频卡片单独等待徽章出现 |

#### 6.3 不新增依赖

不需要任何视频库、不需要海报、不需要新增 npm 包；A 档前端只是上传接受、占位与链接。

---

### 七、风险

| 编号 | 风险 | 触发 | 影响 | 缓解 |
|---|---|---|---|---|
| F1 | 详情页出现损坏图片 | 忘记为视频绕开 picsur-img | 页面显示 broken image | 条件渲染占位块；探针断言 |
| F2 | 直链变成图片扩展名 | 默认 selectedFormat 仍是 JPEG，见 `view.component.ts:161-189` | 复制出的链接 400 | 视频分支最先设 master |
| F3 | 格式下拉出现视频选项 | `util.service.ts:44` 未过滤 | 图片详情页点选视频格式后 400 | 3.3 过滤与验收 |
| F4 | 上传预检被绕过 | 只用 accept 不写组件校验 | 拖拽或粘贴的 mov 到后端吃 400 | 组件内双判 MIME 与扩展名 |
| F5 | 下载把整段读进浏览器内存 | 用 DownloadService 的 XHR 下载大视频 | 浏览器卡顿或崩溃 | 视频下载用同源直链锚点 |
| F6 | 直链行为因浏览器而异 | A 档无 Range、无播放器 | 有的环境内联播放，有的直接下载，有的需要完整缓冲 | i18n 与文档如实说明；属用户已接受边界 |
| F7 | 混合版本前端 | 旧后端无 media_kind、或缓存旧前端 | 视频卡片误判 | `IsVideoFiletypeIdentifier` 单点判定 source_filetype |
| F8 | 上传容器合法但编码不可播 | HEVC mp4 等 | 直链在部分浏览器不能播放 | A 档不承诺可播性，只承诺直链可下载；文档说明 |
| F9 | 视频卡片影响布局探针 | 探针按 picsur-img 等待 | 探针超时或统计错 | data-media-kind 区分 |
| F10 | i18n 只改一种语言 | 漏改 en 或 zh | 文案不一致 | 5.3 键集合校验 |
| F11 | 视频体积放大下载与备份成本 | 128MB 视频 | 存储、WAL、备份、浏览器下载都变重 | 部署侧评估上限；详情页用直链不缓冲 |

---

### 八、待确认

1. 下载入口形态：同源直链锚点，还是保留 speeddial 的 XHR 下载并加进度；推荐锚点，待 UI 确认是否需要显示进度。
2. 视频详情页是否保留四个嵌入复制框的「链接模板」版本：A 档建议隐藏，只留直链；若要给论坛分享模板，按媒体类型分支生成链接模板即可，工作量小。
3. `accept` 用运行时生成还是静态字面量：取决于是否已有从 shared 生成属性的先例，两者都可。
4. 是否在本次同批做上传进度：能力已有，但不属于收窄后的必做项。
5. 真实可播 mp4 是否需要用于人工验收：A 档页面不播放，人工验收可只验证直链与下载；若要看浏览器直链行为，建议用手机录制小样本。

## Related Specs

- `.trellis/spec/picsur-frontend/frontend/component-guidelines.md`
- `.trellis/spec/picsur-frontend/frontend/state-management.md`
- `.trellis/spec/picsur-frontend/frontend/type-safety.md`
- 后端清单：`01-implementation-brief.md`
- 前序评估：`.trellis/tasks/10-25-video-support-eval/research/frontend.md`
