# 设计：更多视频容器，不转码

## 共享层

- 文件：`shared/src/dto/mimes.dto.ts`。
- `VideoFileType` 扩展新容器；同步 `FileType2MimeMap`、`FileType2ExtMap`，保证 Mime2FileType、Ext2FileType、FileType2Ext 双向可逆且无重复 MIME。
- 新增可播判定辅助：`PlayableVideoFileTypes` 与 `IsPlayableVideoFiletype()`，当前仅 mp4 与 webm 属浏览器稳定原生可播；其它容器需要运行时能力探测兜底。
- 文件：`shared/src/util/parse-mime.ts` 的视频分支继续按前缀识别，无需改判定逻辑，只需白名单扩展。

## 后端

- 上传链路沿用现有视频直通：识别为视频后 master 存原片，不进入 sharp。
- 新增容器通过 `file-type` 识别的 MIME 映射到对应 `video:*` 标识；识别不到的容器不要加白名单。
- 直链 GET/HEAD 用 `FileType2Mime` 取内容类型；Range 与 206/416 逻辑对所有视频一致，无需特殊分支。
- 同容器直链返回原片，跨容器请求 400，错误文案沿用现有 usrvalidation。
- 无扩展名直链仍回落 master 原片。

## 前端

- 上传 accept 来自共享 `SupportedFileTypes` 的 MIME 列表，不需要硬编码。
- 详情页：读取视频 filetype 的 MIME，用 `document.createElement('video').canPlayType(mime)` 判断：
  - 返回 probably 或 maybe：渲染 `<video controls playsinline preload="metadata">`，error 时回退提示面板。
  - 返回空字符串：不渲染播放器，直接显示提示面板。
- 提示面板文案区分场景：能力不支持时「该格式不支持在线播放，请使用直链或下载」；播放器解码失败时沿用「该视频不能在页面内播放，请使用直链或下载」。i18n en 与 zh 同步。
- 直链、下载、Markdown、HTML、BBCode、Rst 模板与图库视频徽章自动跟随新的扩展名映射。

## 测试

- `support/make-video-fixtures.cjs` 增加新容器的魔数夹具生成；夹具只保证 file-type 能识别，不保证可解码。
- `support/regression-video-api.sh`：
  - 原有 mov 被拒 400 的断言改为 mov 上传 201、直链 200 video/quicktime、Range 206。
  - 为每个新增容器加：上传 201、GET 200 且 MIME 正确、字节一致、HEAD 长度与 Accept-Ranges、Range 206、meta 与列表识别、删除 404。
  - 跨容器 400 与不可识别格式 400 保留。
- 图片回归与现有 mp4/webm 用例不得回退。

## 兼容与风险

- 浏览器对容器支持差异大：mkv、avi、wmv、flv 基本不支持在线播放，详情页直接给提示与下载，符合用户「不转码」边界。
- mov 在部分浏览器可能可播：能力探测决定是否显示播放器；canPlayType 返回空即提示，返回 maybe 时尝试播放并在 error 后回退。
- 文件类型识别误判：只收 file-type 稳定识别的魔数，避免把音频或任意文件当视频。
- 存储无上限变化，128MB 与既有内存边界不变。
