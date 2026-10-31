# 图片写路径、转码管线与 worker 隔离

## Goal

复刻上传与转码链路，这是风险最集中、必须留最长灰度观察期的阶段。

## Deliverables

- 上传端点：multipart 单文件、字段名 `image`、体积上限 128000000 字节、空文件与格式嗅探语义。
- 主文件策略：静图转 QOI、动图转 animated WebP、SVG 经白名单清洗后原样存；`keep_original` 语义一致。
- 转换参数：height、width、rotate、flipx、flipy、greyscale、noalpha、negative、shrinkonly、quality 逐项对位，`allow_editing` 关闭时忽略参数。
- 转码隔离：进程池或独立 worker、硬内存上限、单次超时、超限与超时返回可读 4xx 且不拖垮主进程。
- 派生图写入、上限与 LRU 清理、过期图片清理、图片删除与级联删除。
- 格式能力声明：`/api/info/formats` 与实际能力一致，HEIF、JXL、JP2、AVIF 不缩水。

## Acceptance Criteria

- [ ] 8 种源格式夹具加超大像素故障夹具逐个上传与取回，无损格式像素零差异；TIFF、BMP、SVG、动图 GIF 需补夹具或登记缺口。
- [ ] 8 类故障输入返回与 Node 同状态码同 `type`，服务保持存活。
- [ ] 转换超时与内存超限各返回可读错误，主进程 RSS 不失控。
- [ ] 派生图缓存键与 Node 一致，过渡期两侧缓存可互相命中。
- [ ] `support/bench-upload.cjs` 同口径压测，p50 与总耗时不劣于 Node 基线 1.2 倍。
- [ ] 删除图片后主文件、原文件、派生图全部级联清理。

## Dependencies

依赖 04 图片读路径完成缓存键与读取语义对位。

## Rollback

把 `/api/image/upload`、`update`、`delete*` 前缀移出 Rust 归属名单；需先排空在途请求。
