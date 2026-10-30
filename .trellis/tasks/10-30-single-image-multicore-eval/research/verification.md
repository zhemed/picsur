# 复核报告：单图多核调查的证据与实测

- 复核对象：`research/backend-single-image.md`、`research/frontend-single-image.md`
- 复核依据：`prd.md` R1-R7 与 Acceptance Criteria、`.trellis/spec/picsur-backend/backend/upload-concurrency.md`、`image-api-contracts.md`
- 角色：Trellis check 子代理 upload-verifier，共享任务 task-10
- 日期：2026-10-30
- 只读声明：未改两份被检报告与任何源码、配置；未碰 8080 现网容器；测量只在 `docker run --rm` 一次性容器内复跑。唯一写入是本文件。原始 `results.json`、`results2.json` 在复跑前备份、复跑后恢复，收尾 sha256 与原始一致。
- 复核方式：不采信文字自洽，逐条回源码核对行号；用同一批脚本在隔离容器内独立复跑 5 组测量；把报告表格与 surviving 的 `results*.json` 逐值对比。

## 一、复核结论

判定：通过，0 条阻断、1 条需修正、7 条建议。

- 核心结论成立且可复现：单张图后端当前不能走多核；线程数从 1 调到 16 对完整链路无可测改善；QOI 编码是头号串行段且为原生单线程；QOI 分块并行的格式可行性经原型验证，拼接后原生解码像素一致。
- 源码核对 42 处 file:line 全部相符，未发现臆造。报告里的实测表格与 `results2.json` 逐值相等，说明数字来自真实运行而非后来手写。
- 复跑 5 组测量方向全部一致：解码线程对照、QOI 编码单线程、完整链路、IPC 往返、QOI 分块 K=4 正确性。允许机器波动，最大偏差约 2%，QOI 分块原型耗时偏差约 2% 到 5%。
- 唯一需修正项是 §4.1 表头的 concurrency 标注与所用数字不符，属标注级错误，不影响结论。
- 只读约束遵守：`git status --porcelain` 只有 `?? .trellis/tasks/10-30-single-image-multicore-eval/`；8080 现网容器 `Restarts=0`，启动时间未变。

## 二、复核环境与复跑口径

| 项 | 复核实测 | 报告值 | 判定 |
|---|---|---|---|
| 镜像 | `ghcr.io/zhemed/picsur:allinone`，ImageID 前缀 `3c6bcf7f` | 同 | 相符 |
| 容器内 Node | v20.20.2 | v20.20.2 | 相符 |
| sharp / libvips | 0.35.5 / 8.18.7 | 同 | 相符 |
| qoi-img | 2.2.0 | 2.2.0 | 相符 |
| `sharp.concurrency()` 默认 | 16 | 16 | 相符 |
| 宿主 CPU | 16 逻辑核 | 16 | 相符 |
| cgroup `cpu.max` | `max 100000` | `max 100000` | 相符 |
| cgroup `cpuset.cpus.effective` | `0-15` | `0-15` | 相符 |
| cgroup `memory.max` | `max` | `max` | 相符 |
| fixture 字节数 | 24mp.jpg 19776640、24mp.png 72131563、12mp.jpg 9894992、12mp.png 36066826、12mp.qoi 47976454 | 同 | 相符 |

复跑命令与报告 §3.3 完全一致，只换成我自己的输出目录：

```bash
docker run --rm -v /tmp/single-image-bench:/bench --entrypoint sh ghcr.io/zhemed/picsur:allinone \
  -c 'cd /picsur/backend && node --expose-gc /bench/bench2.mjs'
# 同形命令另跑 bench3.mjs、ipc-parent.mjs、qoi_chunked.mjs
```

复跑脚本均未修改，也未新增参数。`bench2.mjs` 会覆写 `/tmp/single-image-bench/results2.json`，我在运行前把它备份到 `/tmp/verify-bench/results2-original.json`，运行后恢复，恢复后 sha256 为 `bfb876afccd01e7daad8c8e6cd84767375773528b79fdadde231803c636288eb`，与运行前一致。

## 三、A 部分：源码证据抽查

### 3.1 后端转换链路

| # | 报告主张与位置 | 源码实际 | 判定 |
|---|---|---|---|
| A1 | 上传入口与 `toBuffer`：`image-manage.controller.ts:58-90`、`:71` | 58 `@Post('upload')` 到 90 方法结束；71 `buffer = await file.toBuffer();` | 相符 |
| A2 | 上传编排与类型判定：`image.service.ts:100-170`、`:106`、`:359-401` | 100 为 upload 方法起始，106 `getFileTypeFromBuffer`，359-401 类型判定实现 | 相符 |
| A3 | 转码调用：`image.service.ts:128-132` | 128 为 processService.process 调用起始，132 失败判空 | 相符 |
| A4 | 主格式选择：`image-processor.service.ts:36-55`，SVG 原样 `:44-49`，静态 QOI `:51-54`，动图 `:57-68` | 44-49 SVG 直接返回 image；51 `ParseFileType(ImageFileType.QOI)`；54 调 convert；57-68 processAnimation 目标 WebP | 相符 |
| A5 | 转换与预检：`image-converter.service.ts:67-164`、`:73-76`、`:84`、`:96-101`、`:103-108`、`:153-154`、`:195-197` | 67 为 convertImage 方法起始；73-76 用 `Promise.all` 读两个偏好；84 为 `new SharpWrapper(timeLimitMS, memLimit)`；96-101 调 checkPixelLimit；103-108 调 `sharpWrapper.start`；153-154 调 `finish`；195-197 调 `sharp(...).metadata()` | 相符 |
| A6 | worker 租约与池上限：`sharp.wrapper.ts:56-95`、`:65`、`:226`、`:237`；`worker-pool.ts:24-28`、`:30`、`:108`、`:364-374` | 65 为 `SharpWorkerPool.acquire` 调用；226 为 releaseLease；237 为 destroyLease；24-27 `Math.max(1, Math.min(4, availableParallelism()))`；30 TTL 60s；108 为 acquire 方法起始；364-374 fork 选项 | 相符 |
| A7 | 子进程协议：`sharp.worker.ts:65-75`、`:49-56`、`:77-94`、`:85-89`、`:110-138`、`:122` | 65-75 分发 init/operation/finish；49-56 setrlimit；77-94 init；85-89 `UniversalSharpIn`；110-138 finish；122 `UniversalSharpOut` | 相符 |
| A8 | 编解码适配：`universal-sharp.ts:16-31`、`:24-30`、`:60-71`、`:61`、`:73-140`、`:119-121`、`:159-174`、`:160`、`:164`、`:176-190` | 16-31 `UniversalSharpIn`；24-30 BMP/QOI/默认三路分派；60-71 `qoiSharpIn`，61 `QOIdecode`；73-140 `UniversalSharpOut`；119-121 QOI 分支；159-174 `qoiSharpOut`，160 取 raw，164 `QOIencode`；176-190 `no1Channel` | 相符 |
| A9 | 解码无并行：`universal-sharp.ts:28-29` 即一次 `sharp(image, options)` | 28-29 `return sharp(image, options);` | 相符 |

### 3.2 qoi-img 格式层事实

| # | 报告主张与位置 | 源码实际 | 判定 |
|---|---|---|---|
| B1 | `dist/index.js:24` 用 bindings 加载原生 addon | 24 `const addon = require('bindings')('qoixx_addon');` | 相符 |
| B2 | `QOIencode` 在 `:26-28`，`QOIdecode` 在 `:29-34`，`IsQOI` 在 `:35-39`，`QOIEncoder` 在 `:89-121` | 26-28、29-34、35-39 逐行一致；89 `class QOIEncoder` 到 121 导出 | 相符 |
| B3 | `qoi.cpp:30` Encode、`:73` 调 `qoixx::qoi::encode`、`:85` 复制成 Buffer、`:98` Decode | 30 `napi_value Encode`、73 `image = qoixx::qoi::encode<std::vector<std::byte>>(...)`、85 `napi_create_buffer_copy(...)`、98 `napi_value Decode` | 相符 |
| B4 | `qoixx.hpp:326-401` encode_body，`:385-390` 逐像素循环 | 326 encode_body 签名，385 `auto px = px_prev;`，390、401 循环与函数收尾 | 相符 |
| B5 | `index_size = 64` 在 `:225`，opcode 枚举 `:217-224`，哈希 `:253` 与 `:271` | 217 `enum chunk_tag`、224 结束、225 `index_size = 64u`；253 与 271 两处 `hash()` | 相符 |
| B6 | 分派 `:1018-1024` 与 `:1263-1332` | 1018 `encode_impl`，1024 `push<sizeof(padding)>`；1263 为 `static inline T encode`，1268 计算 header 与 padding 上限 | 相符 |
| B7 | 流式状态机：`qoi-stream.h:106-121` 的 `qois_enc_state` 带 `last_pixel`、`cache[64]`、`run_length` | 106 `typedef struct _qois_enc_state`，111 `pixel_position`，112 `run_length`，118 `last_pixel`，120 `cache[64]`，121 结束 | 相符 |
| B8 | `lib/` 检索 thread、pthread、std::thread、openmp 均 0 命中 | 同样式检索命中 0 | 相符 |
| B9 | `binding.gyp` 未开 `-mavx2` 一类开关，据此推断走标量实现 | binding.gyp 只有 `-std=c++2a -O3 -Wall ...` 与 `-O3 ...`，无 `-mavx`、`-march` 等 | 相符 |
| B10 | qoi-img 依赖与版本 | `backend/package.json` 为 `qoi-img ^2.2.0`，容器内实测 2.2.0 | 相符 |

### 3.3 规范与接口契约引用

| # | 报告主张与位置 | 源码实际 | 判定 |
|---|---|---|---|
| C1 | `upload-concurrency.md:12-14` 记录单张图单线程与多核前提 | 12-14 明文写「单张图的 QOI 编解码是单线程原生调用」「真正的多核并行只来自多个请求各自 fork」 | 相符 |
| C2 | `upload-concurrency.md:69-77` 是「单张图到底用几个核」 | 69 节标题，71-77 给出 QOI 主格式、QOI 编解码行号与「基本单核」结论 | 相符 |
| C3 | `upload-concurrency.md:79-87` 是前端上传行为 | 79 节标题，81-86 单张上限 1 与三条证据 | 相符 |
| C4 | `image-api-contracts.md:21`、`:54-71`、`:69` | 21 `POST /api/image/upload` multipart 字段 file；54 §3.3；56 请求说明；69 默认 QOI | 相符 |

## 四、B 部分：实测复跑对照

### 4.1 解码线程对照，24MP 图，`sharp.cache(false)`

| 配置 | 报告 24mp.jpg wall / CPU/wall | 复核 wall / CPU/wall | 报告 24mp.png wall / CPU/wall | 复核 wall / CPU/wall |
|---|---|---|---|---|
| c=1 | 197.19 / 1.02 | 195.06 / 1.02 | 64.27 / 1.03 | 63.10 / 1.03 |
| c=2 | 186.80 / 1.14 | 185.26 / 1.13 | 47.35 / 1.53 | 45.69 / 1.51 |
| c=4 | 188.20 / 1.15 | 186.98 / 1.14 | 51.77 / 1.50 | 49.74 / 1.48 |
| c=8 | 194.23 / 1.14 | 192.62 / 1.14 | 56.63 / 1.47 | 56.03 / 1.45 |
| c=16 | 200.69 / 1.17 | 197.55 / 1.16 | 64.07 / 1.55 | 60.37 / 1.51 |

判定：方向完全一致。JPEG 解码在 185 到 198ms 之间浮动，c 变小或变大都没有实质加速，CPU/wall 只到 1.16 到 1.17；PNG 解码 c=2 最优，之后回升。报告「JPEG 解码不可并行、PNG 弱并行最多 2 线程」成立。

### 4.2 原生 QOI 编码与解码，`bench3.mjs`

| 操作 | 报告 c=1 / c=16 | 复核 c=1 / c=16 | 报告 CPU/wall | 复核 CPU/wall |
|---|---|---|---|---|
| QOI 编码 24MP JPEG raw | 291.37 / 294.10 | 291.82 / 292.97 | 1.01 | 1.01 |
| QOI 编码 24MP PNG raw | 291.79 / 295.39 | 291.87 / 292.12 | 1.01 | 1.01 |
| QOI 解码 12MP | 52.88 / 52.50 | 52.60 / 53.42 | 1.02 | 1.02 |

判定：单线程原生调用的判定完全复现，改 `sharp.concurrency` 对 QOI 编解码零影响，CPU/wall 恒为 1.01 到 1.02。

### 4.3 完整链路，`bench2.mjs`

| 输入 | 报告 c=1 / c=16 | 复核 c=1 / c=16 | 判定 |
|---|---|---|---|
| 24mp.jpg | 495.03 / 503.76 | 488.72 / 491.86 | 方向一致，c=16 不更快 |
| 24mp.png | 357.92 / 356.40 | 358.09 / 361.53 | 差异在噪声内 |
| 12mp.jpg | 251.05 / 254.86 | 246.05 / 252.34 | 方向一致 |

补充对照：缓存开关报告 202.63 对 202.78，复核 196.39 对 197.75，均无差异；类型判定 0.10 对 0.11；Buffer 拷贝 6.91 对 6.56；metadata 0.37 到 0.39 对 0.36。报告「完整链路对 concurrency 不敏感、CPU/wall 约 1.0 到 1.08」成立。

### 4.4 主进程 IPC 往返，`ipc-parent.mjs` 加 `ipc-child.mjs`

| 轮次 | 报告 往返 wall / 父 CPU / 子处理 | 复核 往返 wall / 父 CPU / 子处理 |
|---|---|---|
| 第 1 次 | 151.8 / 110.3 / 2.1 | 158.3 / 110.3 / 2.2 |
| 第 2 次 | 131.0 / 95.9 / 0.3 | 136.2 / 105.4 / 0.3 |
| 第 3 次 | 132.3 / 100.6 / 0.3 | 133.6 / 100.3 / 0.3 |
| 字节 | 发送 19,776,640 / 接收 94,111,421 | 完全相同 |

判定：「约 131ms 往返、约 100ms 父进程 CPU」可复现；占端到端 634ms 约 20.7% 的算术也正确。

### 4.5 QOI 分块并行原型，`qoi_chunked.mjs`

正确性部分，复跑输出现场：

```text
gradient: js_plain_eq_native_pixels=true; chunked K2/K3/K4/K7 pixels_eq_source=true; 四种分块与原生 bytes 均为 60818
runsCrossingChunks: native_bytes=3649; K2=3649; K3=3651; K4=3649; K7=3655; 全部 pixels_eq_source=true
24mp jpg raw 6000x4000x3: native bytes=94111421; js plain 2697.7ms pixels_ok=true
chunked K=4: phaseA=187.1ms phaseB=0.03ms phaseC=2759.1ms total=2946.2ms pixels_ok=true
chunked K=8: phaseA=175.7ms phaseB=0.05ms phaseC=2377.1ms total=2552.9ms pixels_ok=true
chunked K=4 with 4 workers: phaseA=175.4ms phaseB=0.12ms sab_copy=22.9ms workers=1273.5ms total=1471.9ms pixels_ok=true
```

与报告 §4.7 对比：K=3 多 2 字节、K=7 多 6 字节、渐变图四种分块字节全等于原生的描述**逐字复现**；24MP 的 K=4 单线程 2946.2ms 对报告 2878.0ms，K=8 2552.9ms 对 2578.0ms，4 线程 K=4 1471.9ms 对 1554.4ms，偏差 2% 到 5%，方向一致；「JS 比原生慢约 9.2 倍」「4 线程仍比原生单线程慢 5 倍左右」成立。**关键断言「分块拼接后可被原生解码器正确解码、像素一致」复现通过。**

### 4.6 报告表格与 raw JSON 的可追溯性

| 报告表格 | 对应 raw 文件 | 比对结果 |
|---|---|---|
| §4.1 缓存对照、主进程小项 | `results2.json` cache_check 与 main_process | 逐值相等 |
| §4.2 解码线程表全表 | `results2.json` decode_sweep | 逐值相等 |
| §4.4 完整链路表全表 | `results2.json` full_chain | 逐值相等 |
| §4.5 缩放与 WebP/JPEG 编码表 | `results2.json` resize_scaling 与 `results.json` libvips_encode | 逐值相等，如 WebP q80 c=1 2918.16、c=4 2943.93、c=16 2919.38 完全一致 |
| §4.7 原生 QOI 编码 297.02ms | `results.json` qoi_encode | 逐值相等 |
| §4.3 QOI 编解码表 | 无落盘文件，脚本只打印 stdout | 用同脚本复跑复现，见 4.2 |
| §4.2 末行「默认值 16 198.56」 | 无落盘文件 | 未能从现存 JSON 复核，见问题 S4 |

## 五、C 部分：QOI 分块可行性的断言核对

| 断言 | 报告依据 | 复核 | 判定 |
|---|---|---|---|
| 单块编码是逐像素状态机，不可原地并行 | `qoixx.hpp:326-401`、`:217-225`、`:253`、`:271` | 源码确认 encode_body 为单循环，状态含 index[64]、px_prev、prev_hash、run | 相符 |
| 真正的跨像素依赖是索引表，不是 px_prev | 报告 §5.2 | 源码确认 px 从源数组取，index[hash] 决定 opcode | 相符 |
| run 可跨块，两个相邻 RUN 与一个长 RUN 解码等价 | 报告 §5.2 | 原型 flushRun 对 run=1 发 `0xc0`、对长 run 分段；跨块用例字节与像素均正确 | 相符 |
| 块首需要确定哨兵 | 报告 §5.2 | 原型 `prevHash = 64`、`pxPrev` 取源图前一个像素、run 从 0 起 | 相符 |
| 分块后拼接可被原生解码器解码 | 报告 §4.7 | K=2/3/4/7 与 24MP K=4/K=8 全部像素一致 | 相符 |
| 需要 native 重写才有收益 | 报告 §5.2、§6 | 原型 4 线程仍慢 5 倍；addon 无分块接口 | 相符 |
| Amdahl 算术 | 报告 §6：4 路 1.80、16 路 2.26、端到端 1.53 与 1.77 | 逐式复算：495 对 274.7 得 1.80；495 对 219.6 得 2.25；634 对 413.5 得 1.53；634 对 358.6 得 1.77 | 相符，16 路 2.26 系四舍五入 |

## 六、D 部分：前端报告证据抽查

| # | 报告主张与位置 | 源码实际 | 判定 |
|---|---|---|---|
| F1 | 上传 input 无 multiple：`upload.component.html:3` | 第 3 行 `<input type="file" fileInput [formControl]="fileControl" />`，无 multiple | 相符 |
| F2 | 只上传第一个文件：`processing.component.ts:35-40` | 35 `UploadImage(state.imageFiles[0])`，39 跳 `/view/` | 相符 |
| F3 | 上传服务单文件单请求：`image.service.ts:46-54`，批量方法被注释 `:56-69` | 46-54 单 File；56-69 整段注释且目标 `/api/image/upload/bulk` 不存在 | 相符 |
| F4 | `postForm` 只有一次 `axios.request`：`api.service.ts:141-150`、`:255-289`、`:274-289`、`:281-286`、`:270`、`:287`、`:304-308` | 141-150 postForm；255 fetch；274 `axios.request`；281-286 两个进度回调；270 AbortController；287 signal；304-308 cancel | 相符 |
| F5 | FormData 只 append File 引用：`image-upload-request.dto.ts:3-10` | 6-10 `createFormData` 里 `data.append('image', this.image)`，无读取 | 相符 |
| F6 | processing 页只有 spinner：`processing.component.html:1-6` | 1-6 只有标题与 `<mat-spinner>` | 相符 |
| F7 | 唯一 Worker 是 QOI 展示解码：`qoi-worker.service.ts:20` | 全前端 `new Worker` 只有 1 处，20 行 `new Worker(new URL('./qoi.worker', ...))` | 相符 |
| F8 | Worker 内 fetch 加 arrayBuffer 加 JS 解码：`qoi.job.ts:10-36`、`:19`、`:23-30` | 10 fetch，19 `response.arrayBuffer()`，21 `QOIdecodeJS`，23-30 构造 ImageData | 相符 |
| F9 | QOI 解码逐像素顺序：`qoi-decode.ts:80-93`、`:95-167` | 80-93 初始化 arrayPosition、index[64]、rgba、run；95 起为单循环 | 相符 |
| F10 | 回传与绘制：`qoi.worker.ts:6-21`、`:20`；`picsur-img.component.ts:134-146`、`:143` | 6-21 message 处理，20 postMessage；140-143 canvas 与 `putImageData` | 相符 |
| F11 | 非 QOI 走浏览器原生：`picsur-img.component.ts:147-170`、`:153-155`，HEAD 判类型 `:181-193` | 148 取 buffer，153-155 Blob 与 objectURL，158-164 img.onload 与 src；181-193 HEAD 后解析 content-type | 相符 |
| F12 | 展示页请求主格式加宽度：`view.component.ts:86-103`、`:94-97` | 86-103 previewLink，94-97 SVG 主格式改 JPEG，100-101 拼 width 与 shrinkonly | 相符 |
| F13 | 缩略图已改 WebP 且 native：`images.component.ts:316-330`、`images.component.html:31-40` | 316-322 注释说明 QOI 路径成本，324-329 请求 WebP；html 31-40 有 `[native]="true"` | 相符 |
| F14 | 上传路径无客户端图像计算 | `grep FileReader、createImageBitmap、OffscreenCanvas、toBlob、toDataURL、CompressionStream` 命中 0；`grep crypto、subtle、gzip、deflate、compress` 命中 0；上传与 processing 目录 `<img` 与 `picsur-img` 命中 0；上传路径 `arrayBuffer`、`FileReader`、`.text()`、`.stream()` 命中 0 | 相符 |
| F15 | 依赖里没有图像处理库：`frontend/package.json:18-49`、`:33`、`:35` | 18 起 dependencies，33 `@ngx-dropzone/cdk`，35 `axios`，49 结束；区间内无 sharp、jimp、pica、压缩库 | 相符 |
| F16 | axios 1.20.0，默认适配器 `['xhr','http','fetch']`：`defaults/index.js:42` | 42 `adapter: ['xhr', 'http', 'fetch'],` | 相符 |
| F17 | Worker 单独构建：`angular.json:43`、`tsconfig.worker.json:5-10`、`tsconfig.app.json:11` | 43 `webWorkerTsConfig`；worker tsconfig 的 include 只有 workers 目录下的 worker 入口文件；app tsconfig 把 worker 入口与 exclude 文件排除出主构建 | 相符 |
| F18 | QOI 客户端编码器是死代码：`qoi-encode.exclude.ts:15` | 15 为 `export function QOIencodeJS` 定义，全前端引用 0 处 | 相符 |
| F19 | 后端是 HTTP/1.1，无 http2 与 TLS：`main.ts:24-31`、`:58-59` | 24-31 只有 FastifyAdapter 与 trustProxy；58-59 只有 listen；`grep http2、TLS、createSecureServer` 在 backend/src 与 Dockerfile 命中 0 | 相符 |

前端 6 处关键证据抽查要求超额完成，共 19 处。

## 七、验收标准逐条判定

| PRD 验收项 | 判定 | 依据 |
|---|---|---|
| 后端报告含耗时构成表、线程实测、QOI 可并行性、候选方案与上限、不确定项 | 满足 | 报告 §4.1、§4.2 与 §4.3、§5.2、§6、§7 |
| 前端报告含 CPU 工作盘点、多核手段判定、结论与不确定项 | 满足 | 报告 §2、§5、§1 与 §4、§8 |
| 每个能或不能多核的判定可指到源码行号或实测 | 满足 | 抽查 42 处后端与 19 处前端，全部相符 |
| 后端有 c=1 与 c=N 的 decode 与 encode 对照，含 CPU 与 wall | 满足 | §4.2 与 §4.4；复跑复现 |
| 有 Amdahl 上限估算并说明假设 | 满足 | §6 算术正确；假设在 §6 首段与 §7 第 3 条列明，依赖项见 S3 |
| 前端明确回答能否多核，并解释 Web Worker 的实际收益 | 满足 | §1 与 §5 表，逐手段判定 |
| git status 除任务目录外无改动 | 满足 | 仅 `?? .trellis/tasks/10-30-single-image-multicore-eval/` |
| R7 只读、未碰 8080 | 满足 | 现网容器 `Restarts=0`、启动时间未变；测量容器为 `docker run --rm` |

## 八、发现的问题分级

### 8.1 阻断

无。

### 8.2 需修正

M1 `backend-single-image.md` §4.1 表头与实际测量的 concurrency 不符。

- 位置：报告第 106 行表头写「`sharp.concurrency` 默认值 16」，但表中三个数字实际来自 c=1 测量。
- 证据：`results2.json` 中 `decode_sweep["24mp.jpg c=1"].wall_ms = 197.19`、`full_chain["24mp.jpg c=1"].wall_ms = 495.03`、`ratio_cpu_wall = 1.02`；同文件 c=16 的对应值为 200.69、503.76、1.17 与 1.08。
- 影响：读者会把 c=1 的测量误当成生产默认配置的结果；结论方向不受影响，因为 c=1 与 c=16 都显示线程数无收益。
- 建议改法：表头改为「`sharp.concurrency`=1」，或把表内数字换成 c=16 的 200.69 与 503.76 并同步 CPU/wall。

### 8.3 建议

S1 §4.1 混用两种 concurrency 的数字。QOI 编码 294.10ms 取自 §4.3 的 c=16，而解码 197.19ms 与链路 495.03ms 是 c=1。若统一用 c=1，编码应为 291.37ms，此时「其它约 4ms」实际约 6.5ms，编码占比 58.9% 而不是 59.4%。建议同表同口径，或每行标出取数来源。

S2 §5.1 与 §4.2 的「wall 不降反升」偏硬。报告自己的数据里 c=2、c=4 比 c=1 低约 5%，复核同样如此 197.19 到 186.80、195.06 到 185.26，只是 CPU/wall 仅 1.14 到 1.15 且 c=16 回升。建议改为「基本持平，没有有效加速」，避免被读者抓住字面矛盾。

S3 §6 的 1.3 到 1.5 倍区间依赖「预扫描也能并行」这一隐含假设。原型里 phaseA 预扫描是单线程 175 到 187ms，约占原生编码 297ms 的 59%；如果 native 实现只并行编码段而预扫描仍单线程，则 worker 内只有约 1.10 倍、端到端约 1.07 倍。建议把该假设显式写进 §6，或把区间拆成「预扫描并行」与「预扫描串行」两种情形。

S4 §4.2 末行「默认值 16：198.56ms / 1.19」与 §4.3、§4.6 的数字没有落盘证据。现存 `results.json` 与 `results2.json` 里查不到 198.56，`bench3.mjs` 与 `ipc-parent.mjs` 只打印 stdout 未写文件。我复跑 bench3 得 197.58 / 1.20，方向与量级一致，但建议后续把各脚本 stdout 一并存入 raw 目录，便于第三方逐值复核。

S5 前端 §2.3 关键词表「File.slice」引用 `qoi-encode.exclude.ts:211`，该行是 `result.buffer.slice(0, p)`，属 ArrayBuffer 的 slice，不是 File 的 slice。「未做文件分片」的结论不受影响，建议把该行改写为「只有被排除构建的编码器内部有 buffer 复制，没有 File.slice」。

S6 后端 §5.2 写「addon 只有单块同步 `encode`」，实际 addon 还暴露有状态的 `streamEncode` 与 `createEncodeState`，见 `dist/index.js:93` 与 `:98`。报告下一句已说明流式接口是顺序状态机，结论「无分块或并行接口」成立，建议把措辞改为「只有单块 encode 与顺序流式接口」。

S7 §1 概括「CPU/wall 约 1.0 到 1.08」，但 §4.4 表里 24MP PNG c=16 是 1.12，复核为 1.11。若该句只指 JPEG 链路，建议加限定词；若要覆盖全表，建议写成 1.0 到 1.12。

## 九、复核限制

1. 复跑只覆盖 5 组核心测量，未重跑 `bench.mjs` 的 24MP raw WebP 与 JPEG 编码全表；后者通过 `results.json` 与报告表格逐值相等验证，并复现了同类的 resize 加 WebP 无加速路径。
2. 未在真实 worker 子进程内复测，与被检报告的 §7 第 1 条限制一致；本轮复跑仍在普通 Node 进程内完成。
3. 未做 100 次重复取置信区间，每项只复跑一次，允许 2% 到 5% 的机器波动；判定只要求方向一致。
4. 复跑期间 `results2.json` 被脚本覆写一次，已从备份原样恢复并核对 sha256；`results.json` 未被动过。
5. 前端结论仍以静态读码与关键词扫描为主，未在真实浏览器做 Performance 面板实测，与被检报告 §8 第 1 条限制一致。
