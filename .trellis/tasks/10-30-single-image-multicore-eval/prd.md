# 调查单张图片上传能否走多核

## Goal

只读调查 Picsur 的单张照片上传与转换链路，回答「前端和后端各自能不能让一张图利用多个 CPU 核」。要求给出分环节的判定、可复核的实测证据、以及只针对单张图的优化方向与量化上限，不实施任何改动。

## Background

- 上一轮已把「每次转换 fork 一个子进程」改为常驻 worker 池，收益来自跨请求复用与并发上限；但**单张图内部**仍然基本是单核：子进程内一条 JS 线程，默认主格式 QOI 的编解码走 `qoi-img` 原生同步插件。
- 现实现关键位置：`backend/src/workers/sharp.wrapper.ts`、`backend/src/workers/sharp/worker-pool.ts`、`backend/src/workers/sharp/universal-sharp.ts`、`backend/src/managers/image/image-processor.service.ts`、前端 `frontend/src/app/routes/processing/processing.component.ts`。
- 运行时事实：容器无 CPU 配额，宿主 16 逻辑 CPU；镜像内 libvips 是自编译 8.18.7，sharp 0.35.5；Node 20.20.2；主格式 QOI，动图 WebP，SVG 原样。
- 可用的隔离测试底座：Node 20 容器、dev Postgres 127.0.0.1:5432、生产镜像 `ghcr.io/zhemed/picsur:allinone` 可作为运行时；禁止压测或改动 8080 现网容器。

## Requirements

- R1 后端：拆解单个上传请求的转换耗时构成，至少区分「读入与类型判定」「解码为 raw」「可选操作」「目标格式编码」四段，用可复现的 fixture 给出各段耗时占比。
- R2 后端：实测 sharp 与 libvips 对**单张图**的线程行为，至少覆盖 decode 与 QOI encode 两段；用 CPU 时间与 wall time 比值及 `sharp.concurrency` 变化来判定是否真的吃到多核，禁止只凭文档下结论。
- R3 后端：判定 QOI 编码在格式层面能否并行，并给依据，例如编码的逐像素依赖、编码器实现是否单线程、分块拼接是否可行。
- R4 后端：给出单张图多核化的候选方案与量化上限，至少评估：只并行解码、并行生成派生图、换输出格式、分块编解码、把单图工作拆给多个池 worker；对每个方案写清可行性、预期收益上限与代价。
- R5 前端：盘点单张图上传时浏览器侧到底做了哪些 CPU 工作，判定有没有可并行的计算；说明 Web Worker 与多连接请求对单文件上传是否有效，禁止把网络 I/O 说成多核收益。
- R6 结论：给出「前端能否走多核」「后端能否走多核」两个明确判定，并区分「理论可以」「当前实现没有」「受格式限制不可能」三种情况。
- R7 全程只读：不改源码、不改配置；测量只允许在本地隔离容器与临时数据库上进行，禁止压测或改动 8080 现网 picsur 容器；报告写入任务 `research/` 目录。

## Acceptance Criteria

- [ ] `research/backend-single-image.md` 存在，含：耗时构成表、线程实测数据、QOI 可并行性判定、候选方案与上限、不确定项。
- [ ] `research/frontend-single-image.md` 存在，含：浏览器侧 CPU 工作盘点、多核手段有效性判定、结论与不确定项。
- [ ] 每个「能或不能多核」的判定都能指到源码行号或本机实测数据，不只引外部文档。
- [ ] 后端至少有一组对照实测：同一张大图在 concurrency 1 与 concurrency N 下的 decode 与 encode 时间、CPU 时间与 wall time。
- [ ] 有明确的单图并行收益上限估算，例如按实测占比算 Amdahl 上限，并说明假设。
- [ ] 前端结论明确回答「单张上传能否走多核」，并解释即使引入 Web Worker 对当前链路是否有实际收益。
- [ ] `git status` 显示除本任务目录外无改动。

## Constraints

- 只读调查；不写业务代码、不改配置、不装依赖。
- 测量必须在隔离环境：Node 20 容器与 dev Postgres 临时库；禁止碰现网容器与数据。
- 结论以本仓库当前实现与实测为准，不以别家图床的做法推断。

## Non-goals

- 不做优化实现，不改默认存储格式，不改前端上传交互。
- 不压测多请求并发，那属于上一轮已完成的工作。

## Notes

- 单张图多核化的关键问题不是「有没有线程池」，而是「能被并行的部分占多少」。如果 QOI 编码占大头且格式本身串行，那么换格式或分块才是突破口，单纯调 libvips 线程数不会有大收益。
- 前端要区分「上传传输」与「客户端图像处理」：当前仓库客户端并不做图像处理，这一点需要用源码证明。

## 调查结论（2026-10-30）

**判定：前端不能，后端当前也不能；后端理论上只有 QOI 编码阶段有分块并行的可能，但需要 native 重写，收益有上限。**

前端：

- 上传链路没有任何客户端图像计算，只有文件选择、`FormData` 组装与一次 XHR；
  全前端无 `FileReader`、`createImageBitmap`、`OffscreenCanvas`、压缩、哈希或上传前预览。
- 唯一的客户端图像计算是展示阶段的 QOI 解码，已在 1 个 Web Worker 内，且逐像素顺序依赖，单张图拆不到多核。
- Web Worker、HTTP/2 多路复用、多连接、分片上传对单文件上传都不产生 CPU 并行收益；
  引入客户端处理属于重复计算，不值得。

后端，24MP JPEG 单请求 worker 内 495ms：

| 阶段 | 耗时 | 占 worker 内 | 能否并行 |
|---|---|---|---|
| 解码到 raw | 197ms | 39.8% | JPEG 不可并行；PNG 最多约 2 线程，整链路仅省 4.7% |
| QOI 编码 | 291ms | 58.9% | 单块实现串行；格式层面可分块并行 |
| 其它 | 约 6.5ms | 1.3% | 不可并行 |
| 主进程 IPC 往返 | 约 131ms | 端到端约 21% | 串行，加核消不掉 |

- `sharp.concurrency` 从 1 调到 16，解码、编码与完整链路均无可测改善，CPU/wall 落在 1.0 到 1.12，
  QOI 编解码恒为 1.01。判定：单张图当前单核处理。
- 换输出格式不解决多核：QOI 291ms、JPEG q90 375ms、WebP q80 2918ms，均不随线程数下降。
- QOI 分块并行在格式层面可行：按块预扫描索引表状态后独立编码再拼接，原型 K=4 与 K=8 拼接后像素完全一致；
  但当前 addon 只有单块同步 encode 与有状态的顺序流接口，纯 JS 分块比原生单线程慢约 5 倍。
- 收益上限：QOI 编码 4 路并行时 worker 内约 1.80 倍、端到端约 1.53 倍；16 路端到端约 1.77 倍；
  计入预扫描与拼接的真实成本后预计 1.3 到 1.5 倍；若预扫描只能串行，收益掉到约 1.1 倍。
- 不建议为了单图多核去调 libvips 线程数、加 `UV_THREADPOOL_SIZE` 或换输出格式；
  若目标是单次上传更快，优先看 IPC 约 131ms 与主进程串行段这个独立课题。

复核：`research/verification.md` 判定通过，0 阻断、1 条需修正、7 条建议；需修正的 §4.1 concurrency 标注
与 S1、S2、S3、S4、S6、S7 已由报告作者落实。规格已更新：
`.trellis/spec/picsur-backend/backend/upload-concurrency.md` 第 10 节，前端 spec 的 Pre-Development Checklist 同步。

产物：

- `research/backend-single-image.md`：314 行，含链路、测量、QOI 分块分析、候选方案与上限、不确定项。
- `research/frontend-single-image.md`：前端盘点与多核手段逐项判定。
- `research/raw/`：7 个测量脚本、原始 results、run-log 与复现说明。
- `research/verification.md`：复核报告。

口径限制：fixture 是合成噪声图，QOI 输出膨胀为 raw 的 1.31 倍，绝对毫秒不可直接外推到真实照片；
结论只用占比与相对判断，真实照片需另测。

