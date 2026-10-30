# 单图多核调查：测量脚本与原始输出留档

- 来源任务：task-8，目录 `.trellis/tasks/10-30-single-image-multicore-eval`
- 测量日期：2026-10-30
- 报告：`../backend-single-image.md`
- 测量环境：`ghcr.io/zhemed/picsur:allinone`，Node v20.20.2，sharp 0.35.5，libvips 8.18.7，qoi-img 2.2.0；宿主 16 逻辑核 i7-12700，容器无 CPU 与内存配额；所有测量为 `docker run --rm` 一次性容器，未碰 8080 现网实例

## 文件清单

| 文件 | 作用 |
|---|---|
| `gen-fixtures.mjs` | 生成 12MP 与 24MP 的 JPEG、PNG 与 12MP QOI fixture，写入 `/bench/fixtures` |
| `bench.mjs` | 解码 sweep、QOI 编解码、完整链路、libvips 编码对照，输出 `/bench/results.json` |
| `bench2.mjs` | 类型判定、metadata、Buffer 拷贝、解码细扫、完整链路、resize 缩放，输出 `/bench/results2.json` |
| `bench3.mjs` | QOI 编解码在 `sharp.concurrency` 1 与 16 下的对照，只打印 stdout |
| `ipc-parent.mjs` | `fork` 子进程 IPC 往返测量，只打印 stdout |
| `ipc-child.mjs` | `ipc-parent.mjs` 的子进程端，接收消息回传大 Buffer |
| `qoi_chunked.mjs` | QOI 分块并行编码原型、正确性验证与成本测量，只打印 stdout |
| `results.json` | `bench.mjs` 的完整输出 JSON |
| `results2.json` | `bench2.mjs` 的完整输出 JSON |
| `run-log.md` | 各脚本 stdout 摘要与补充测量记录 |

## 复现方式

脚本内固定使用容器路径 `/bench/fixtures` 作为输入、`/bench/results*.json` 作为输出，因此把 raw 目录只读挂载后，先把脚本拷到可写工作目录再运行，避免输出写回仓库：

```bash
R=/root/picsur/.trellis/tasks/10-30-single-image-multicore-eval/research/raw
mkdir -p /tmp/bench-out
docker run --rm -v "$R":/bench/raw:ro -v /tmp/bench-out:/bench \
  --entrypoint sh ghcr.io/zhemed/picsur:allinone \
  -c 'cp /bench/raw/*.mjs /bench/ && cd /picsur/backend &&
      node --expose-gc /bench/gen-fixtures.mjs /bench/fixtures &&
      node --expose-gc /bench/bench2.mjs'
```

各脚本容器内命令：

| 脚本 | 命令 |
|---|---|
| `gen-fixtures.mjs` | `node --expose-gc /bench/gen-fixtures.mjs /bench/fixtures` |
| `bench.mjs` | `node --expose-gc /bench/bench.mjs /bench/fixtures /bench/results.json` |
| `bench2.mjs` | `node --expose-gc /bench/bench2.mjs` |
| `bench3.mjs` | `node --expose-gc /bench/bench3.mjs` |
| `ipc-parent.mjs` | `node /bench/ipc-parent.mjs`，需同目录 `ipc-child.mjs` |
| `qoi_chunked.mjs` | `node --expose-gc /bench/qoi_chunked.mjs` |

## 注意

- fixture 是渐变加伪随机噪声的合成图，属压缩最坏情况；报告的结论只用相对占比，不用绝对毫秒外推真实照片。
- 脚本内输出路径写死为 `/bench/...`，请按上面的拷入可写目录方式运行，不要直接在生产容器内执行。
- `results.json` 与 `results2.json` 是原始运行产物；`run-log.md` 汇总了未落盘的 stdout 类测量。
