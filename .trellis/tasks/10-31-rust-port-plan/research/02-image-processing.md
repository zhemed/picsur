# Research: Rust 图片处理链路选型与格式缺口

- Query: 现有 sharp 加 libvips 的图片链路在 Rust 侧怎么对位，逐格式列出缺口、风险与验证办法
- Scope: mixed —— 仓库事实取自 `backend/src/managers/image/**`、`backend/src/workers/**`、`Dockerfile`，外部资料取自 crates.io 公开元数据
- Date: 2026-10-31

## Findings

### Files Found

| File Path | Description |
|---|---|
| `backend/src/managers/image/image.service.ts` | 上传编排、类型嗅探、派生图缓存键、读取语义 |
| `backend/src/managers/image/image-processor.service.ts` | 主格式选择：静态图转 QOI，动图转无损 WebP，SVG 原样存 |
| `backend/src/managers/image/image-converter.service.ts` | 像素上限预检、sharp 操作串、转换时限与内存上限 |
| `backend/src/managers/image/svg-security.service.ts` | SVG 净化：svgo 加 DOMPurify 加 href 白名单 |
| `backend/src/managers/image/webpinfo/*.ts` | 自写 WebP 头解析，用于判断动图 |
| `backend/src/workers/sharp/universal-sharp.ts` | 输入输出格式分发表，BMP/QOI 原生编解码 |
| `backend/src/workers/sharp/sharp.worker.ts` | 子进程内单线程处理，`setrlimit` 内存上限 |
| `backend/src/workers/sharp/worker-pool.ts` | 进程级 worker 池，上限 min(4, CPU)，空闲 60 秒回收 |
| `backend/src/workers/sharp.wrapper.ts` | 任务级超时与失败销毁语义 |
| `Dockerfile` | 自编译 libvips 8.18.7 与全部编解码依赖，sharp 源码构建 |
| `shared/src/dto/mimes.dto.ts` | 支持的图片与动图格式枚举、mime 与扩展名映射 |
| `shared/src/mimes` 相关校验 | `/i/:id.:ext` 的扩展名白名单 |
| `support/make-image-fixtures.cjs` | 夹具生成器，产出 png/jpg/webp/avif/jxl/jp2/heif/qoi 与超大像素图 |
| `support/regression-image-api.sh` | 34 项接口与格式回归 |
| `.trellis/spec/picsur-backend/backend/upload-concurrency.md` | 并发模型与实测性能基线 |
| `.trellis/spec/picsur-backend/backend/image-api-contracts.md` | 取图与画质实测口径 |

### Code Patterns

一、现有链路的真实行为

1. 主格式选择在 `image-processor.service.ts:36-68`：静态图一律转 `image:qoi`；动图转 `anim:webp` 且 `lossless: true, effort: 0`；SVG 不转码，直接存净化后的原文。也就是说库里的 master 只有三种：QOI、动画 WebP、净化 SVG。`source_filetype` 单独记录用户上传时的真实格式，见 `image.entity.ts:29-35`。
2. 转换入口是 `image-converter.service.ts:40-164`。当源格式等于目标格式且无任何编辑参数时，直接返回原字节，不重新编码，见 `:46-54`。这是现有画质契约的一部分，见 `image-api-contracts.md` 末节「取图与画质」。
3. 编辑操作串与 sharp 语义绑定，见 `image-converter.service.ts:111-150`：同时给宽高时 `fit: fill` 加 `kernel: cubic`；只给一边时 `fit: inside`；`rotate` 只按显式角度旋转，**不做 EXIF 自动定向**；`noalpha` 调 `removeAlpha`；`negative` 调 `negate`；`greyscale` 调 `greyscale`。Rust 侧必须逐项复刻，包括「不自动定向」这一条。
4. 输出格式分发表在 `universal-sharp.ts:73-140`：PNG、JPEG、TIFF、AVIF、HEIF 且压缩用 av1、JXL、JP2、BMP、QOI、WebP、动图 GIF。BMP 与 QOI 走原生库先解成 raw 再喂 sharp，见 `:33-71`；单通道 raw 会扩成三通道再编码，见 `:176-190`。
5. 动画语义：`sharpOptions.animated` 只在目标类别是 Animation 时置真，见 `image-converter.service.ts:85-92`。因此把动图转成静态格式时只取第一帧，这是既有行为。
6. 派生图缓存：键是 `sha256(JSON.stringify({mime: fileType, ...options}))`，见 `image.service.ts:404-411`。写入前用 `MutexFallBack` 去重，见 `:218-226`；命中时若 `last_read` 早于一天则刷新一次，见 `image-file-db.service.ts:160-184`；每图派生图数量上限默认 100，超限只服务不落库，见 `image.config.service.ts:62-75` 与 `image.service.ts:260-277`。
7. 读取语义：`/i/<id>.<ext>` 按扩展名转码并缓存；`/i/<id>` 走原图，没有保留原图时 404 加占位图，SVG 例外走 master，见 `image.controller.ts:184-216`；栅格图请求 `.svg` 返回 400 而不是 500，见 `image.service.ts:191-214`。
8. 类型嗅探：`file-type` 先嗅二进制，失败时用 `IsQOI` 与 `isSvg` 兜底，见 `image.service.ts:359-402`；WebP 再走自写解析器判断是否动图，见 `webpinfo/webpinfo.ts`。
9. 资源上限：像素上限默认 268402689 且 `0` 表示不限，见 `shared/src/util/image-pixel-limit.ts:12-38`；转换时限默认 15 秒、内存上限默认 512MB，见 `preference-defaults.service.ts:47-48`；worker 并发上限 min(4, CPU 核数)、空闲 60 秒回收，见 `worker-pool.ts:24-33`。
10. 内存限制靠子进程内 `setrlimit('data', ...)`，见 `sharp.worker.ts:49-56`。这是进程级限制，不是线程级，决定了 Rust 侧要么保留独立进程，要么换 cgroup 限制。
11. 镜像里的编解码能力来自自编译 libvips 8.18.7，`Dockerfile` 的 vips 阶段显式装了 libjxl、openjpeg、libheif、librsvg、pango、imagemagick、poppler、cfitsio、libspng、lcms2、cgif、libimagequant，见 `Dockerfile:78-96`。宿主预编译 sharp 没有 JXL/JP2 解码器，这个差异是既有实测结论，见 `.trellis/spec/picsur-backend/backend/build-and-deploy.md` §8.3 第 4 条。
12. SVG 净化策略在 `svg-security.service.ts:19-69`：先 `svgo` 的 `preset-default` 加 `removeScripts`，再 DOMPurify 的 svg profile，禁掉 `foreignObject`/`script`/`iframe`/`object`/`embed`，`href` 与 `xlink:href` 只允许本地 fragment 或内联 raster data URI，最后用 `is-svg` 复验。

二、候选方案

| 方案 | 能力覆盖 | 成熟度 | 与本项目贴合度 | 主要风险 |
|---|---|---|---|---|
| libvips 绑定 rs-vips 0.7.0 或 vips 0.2.0 | 与镜像内 libvips 完全一致，含 HEIF/JXL/JP2/PDF/Magick | 均为 0.x；rs-vips 2026-04 发布，vips 2026-10 发布 | 高：镜像里已有 libvips，编解码集不变 | FFI 安全、错误映射、并发线程模型需要封装 |
| 纯 Rust image 0.25.10 | PNG/JPEG/GIF/WebP/BMP/TIFF/QOI/ICO/HDR/EXR/DDS/PNM/TGA；AVIF 编码走 ravif，解码要 dav1d；无 JXL/HEIF/JP2/PDF；WebP 只支持无损编码 | 高，下载量大 | 中：可覆盖 QOI 与 BMP 以及测试路径 | 会丢失 JXL/JP2/HEIF 支持，属产品能力回退 |
| image 加 libheif-rs 3.0.0 加 jpegxl-rs 0.16.0 | 补齐 HEIF 与 JXL | libheif 3.0.0 稳定；jpegxl 0.16 需系统 libjxl | 中 | 三个库各自独立色彩管理，AVIF 与 JXL 输出与 libvips 不同源，像素与体积都会漂移 |
| 子进程调用 vips CLI | 与 libvips 一致 | 高，命令行稳定 | 中高：延续现有「每次转换独立进程」模型 | 每次转换多一次进程启动开销，参数拼装与错误解析要自写 |
| resvg 0.49.0 做 SVG 栅格化 | 静态 SVG 子集，纯 Rust | 高 | 中：可替 librsvg | 与 librsvg 的字体与抗锯齿结果不同，像素会漂移 |

结论：推荐 libvips 绑定为主引擎，QOI 用 `qoi` 0.4.1 纯 Rust 库，SVG 净化用 `svg-hush` 0.9.7 加自写策略测试，SVG 栅格化仍走 libvips 内的 librsvg 以保持与现状同源。

三、逐格式缺口

| 格式 | 现状实现 | Rust 首选对位 | 缺口与风险 | 验证方式 |
|---|---|---|---|---|
| QOI | qoi-img 原生插件，主存储格式 | qoi 0.4.1 | 编解码实现不同但规范确定；库自 2022 年起未更新 | 用库里现有 QOI master 全量解码，断言像素与原图一致；再用 qoi 编码后由 qoi-img 解码回读，双向互操作 |
| PNG | sharp PNG 编码 | libvips `pngsave` | 无损像素可对齐，压缩级别与元数据剥离需一致 | 像素哈希比对；元数据断言为空 |
| JPEG | sharp JPEG 编码，质量参数 1 到 100 | libvips `jpegsave` 的 quality | 编码器不同，同质量参数下字节与体积必然不同，像素因有损编码也不同 | 只断言解码后 PSNR 与尺寸，不断言字节；体积偏差记录进基线 |
| WebP | sharp WebP，动图无损 | libvips `webpsave`，`page-height` 表达动画 | 动画封装参数多，lossless 与 effort 语义要核对 | 动图夹具转 `.webp` 后断言帧数与像素一致 |
| GIF | sharp GIF 编码，动图路径 | libvips `gifsave` | 帧延迟与调色板量化差异大 | 帧数与单帧像素比对，允许调色板差异 |
| BMP | bmp-img 原生 | image 0.25.10 的 BMP 编解码，或 libvips magickload | 通道数与调色板 BMP 处理差异 | 8 位与 24 位 BMP 各一张，断言像素 |
| TIFF | sharp TIFF | libvips `tiffsave` | 多页 TIFF 行为需确认 | 单页夹具像素比对 |
| AVIF | sharp AVIF，走 ravif 或 aom | libvips `heifsave` 的 AV1 压缩 | 编码器源不同，体积与像素有损差异 | 夹具往返，断言尺寸与可解码性 |
| HEIF/HEIC | 自编译 libheif | libvips `heifsave` 加 `heifload` | 需要 libheif 与 AV1 解码器同时在位 | 上传 heif 夹具并转 png，断言 200 |
| JXL | 自编译 libjxl | libvips `jxlsave` 加 `jxlload` | 纯 Rust 无对位，必须用 libvips 或 jpegxl-rs | 上传 jxl 夹具并转 png，断言 200；反向转 jxl 断言 200 |
| JP2 | 自编译 openjpeg | libvips `jp2ksave` 加 `jp2kload` | 同上 | 同上 |
| SVG 存储 | svgo 加 DOMPurify | svg-hush 0.9.7 加自写 href 白名单 | svg-hush 策略与 DOMPurify 不等价，可能删多或删少 | 用现有净化夹具对照：脚本、onload、外部 use、data URI raster 四类断言 |
| SVG 栅格化 | librsvg 经 libvips | libvips 原路径 | 换 resvg 会导致像素漂移 | 同一 SVG 转 png，与 Node 输出像素比对 |

四、性能与并发基线

1. 现状实测：24MP JPEG 单请求 worker 内链路约 495ms，其中解码 197ms、QOI 编码 294ms；单张图基本单核。worker 池化后串行 10 张 p50 从 125.4ms 降到 13.6ms，并发 8 时总耗时降约两成，见 `upload-concurrency.md` §9.2 与 §10.2。
2. QOI 编码占单张图耗时近六成，是性能主战场。Rust `qoi` crate 的单线程编码速度是未知量，不能假设快于 C 实现的 qoi-img。必须实测后再谈收益。
3. 多核利用仍然只来自多请求并发。迁移不应期待「换 Rust 就单图多核」，现有 Amdahl 估算与 QOI 分块并行的结论不因语言而改变，见 `upload-concurrency.md` §10.3。

## Decision

### 推荐方案：libvips 绑定加 qoi 纯 Rust 库分工

- 分工：libvips 负责除 QOI 外的解码、缩放、旋转、翻转、编码；QOI 用 `qoi` 0.4.1 在 Rust 内做 raw 互转，再通过 libvips 的 memory source 进入同一管线。
- 理由：编解码集与现网镜像完全一致，避免 JXL/JP2/HEIF 能力回退；libvips 的色彩管理与 `lcms2` 行为不变，画质漂移面最小；QOI 是主存储格式，用纯 Rust 库能去掉一个原生插件依赖。
- 绑定选型：首推 rs-vips 0.7.0，由 libvips-rust-bindings fork 而来，生成自 libvips 8.18.1，采用 MIT，2026-04 仍在更新；备选 vips 0.2.0，2026-10 发布且带 `v8_18` feature，但采用面更窄。两者都是 0.x，必须封装在内部门面之后，避免全局替换成本。
- 替代方案：子进程调用 vips CLI。代价是每次转换多一次进程启动，收益是天然内存隔离且无需 FFI 封装，适合作为首版兜底或回滚方案。
- 代价：FFI 层要处理 `VipsError`、线程安全、`VipsApp` 初始化与退出，预计 2 到 3 周封装配对测试；另需在 Dockerfile 里保留 libvips 编译阶段。
- 验证方式：用 `support/make-image-fixtures.cjs` 生成 9 种夹具，逐格式上传、取回、转码，断言全部 200 且无损格式像素一致；对库内历史 master 做全量解码抽样。

### 推荐方案：保留独立 worker 进程模型

- 做法：Rust 主服务用 tokio，转换任务交给一个独立可执行文件的子进程池，子进程启动时 `setrlimit` 设内存上限，通过 stdin/stdout 或 unix socket 传消息，保留超时后销毁并补位的语义。
- 理由：`setrlimit` 是进程级，线程里设不了；现状的 512MB 硬上限是运维契约，不能靠 cgroup 退化成软约束。
- 替代方案：tokio `spawn_blocking` 加 cgroup 内存限制。代价是要改部署形态，且单进程内一次 OOM 会带走整个服务。
- 代价：多一层进程编排，IPC 有复制开销，与现状 Node 的 131ms IPC 往返类似。
- 验证方式：构造超内存、超时、解码失败三类输入，断言返回可读 400 且主进程存活；压测并发 8 时子进程峰值数等于池上限。

### 推荐方案：SVG 净化重写策略而非直接照搬库

- 做法：用 svg-hush 0.9.7 做基础清洗，再补一层与 `AllowedSvgHref` 等价的 href 白名单校验；用现有四类攻击夹具写回归。
- 理由：DOMPurify 加 jsdom 是 Node 生态重量级依赖，约 30 个传递依赖，Rust 侧没有等价物；安全策略本身是产品契约，必须逐条测。
- 替代方案：保留 Node 侧一个小服务只做 SVG 净化，Rust 通过 HTTP 调用。代价是多一个常驻进程，收益是净化行为零变化。
- 代价：安全回归测试工作量，约 3 到 5 天。
- 验证方式：对 `<script>`、`onload`、外部 `<use xlink:href>`、`javascript:`、data URI raster 五类输入断言输出不含危险节点且 raster data URI 保留；再跑 `/i/<id>.svg` 的 CSP 与 `nosniff` 头断言。

### 推荐方案：EXIF 只读不写，且不自动定向

- 理由：现有链路重新编码时剥离元数据，且 rotate 只按显式参数执行，见 `image-converter.service.ts:131-135`。保留这个行为才能保证取回像素一致。
- 替代方案：引入 `kamadak-exif` 0.6.1 做定向修正。代价是改变像素输出与用户预期，需要产品决策。
- 代价：无，首版不引入 EXIF 库。
- 验证方式：带 EXIF Orientation 的 JPEG 上传后取回，断言像素与 Node 实例一致，即方向不被修正。

## Caveats / Not Found

1. 待确认：派生图缓存键的字节级一致性。键是 `sha256(JSON.stringify({mime, ...options}))`，Node 侧对象键顺序由 zod schema 的字段顺序决定，见 `shared/src/dto/api/image.dto.ts:8-24`。Rust 若用 `serde_json` 默认序列化，字段顺序是结构体声明顺序，必须核对一致，否则同一逻辑请求在两侧得到不同 key，缓存命中率减半并可能触发重复落库。验证方法：枚举 2 的 10 次方种参数组合的子集，两侧各算 key 做逐字节 diff。
2. 待确认：image 0.25.10 是否支持动画 WebP 解码。验证方法：用动图 WebP 夹具在 Rust 侧解第一帧与全部帧，与 sharp 输出比对。
3. 待确认：rs-vips 与 vips 两个 0.x 绑定在并发调用下的线程安全性承诺。验证方法：读各自 README 与 issue，做 8 线程并发转换压测，检查是否出现崩溃或内存增长。
4. 待确认：jpegxl-rs 0.16.0 的许可证是 GPL-3.0-or-later。本项目是 AGPL-3.0-or-later，按 AGPLv3 第 13 条可与 GPLv3 组合，但需要在引入前做许可证复核并记录。验证方法：与项目所有者确认，或用 libvips 的 JXL 能力替代。
5. 待确认：libvips 8.18.7 的 QOI 支持情况。若 libvips 已原生支持 QOI，纯 Rust qoi 库可以省掉。验证方法：在镜像里跑 `vips -l | grep qoi` 与 `vips copy x.qoi out.png`。
6. 未找到：仓库里没有视频处理、没有 PDF 输出、没有人脸检测或 AI 推理。镜像里的 poppler 与 cfitsio 只是 libvips 的可选依赖，不被业务代码调用。
7. 未找到：没有 OnlyOffice 或文档预览集成。任务描述里的该项在现状代码里不存在。
