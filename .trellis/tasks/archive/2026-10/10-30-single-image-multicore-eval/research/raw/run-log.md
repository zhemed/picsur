# 测量 stdout 摘要与补充测量

本文件是测量脚本运行时打印到 stdout 的内容摘要；`bench.mjs` 与 `bench2.mjs` 的完整数字在 `results.json` 与 `results2.json`。所有测量均在 `ghcr.io/zhemed/picsur:allinone` 的一次性容器内完成，未碰 8080 现网实例。

## 1. `gen-fixtures.mjs` 输出

```text
12mp 4000x3000 png+jpg done in 1128ms
24mp 6000x4000 png+jpg done in 2273ms
12mp.qoi bytes=47976454 encode=168ms
fixture 12mp.jpg 9894992 bytes
fixture 12mp.png 36066826 bytes
fixture 12mp.qoi 47976454 bytes
fixture 24mp.jpg 19776640 bytes
fixture 24mp.png 72131563 bytes
```

## 2. `bench.mjs` 输出摘要

环境：

```text
{"node":"v20.20.2","sharp":"0.35.5","vips":"8.18.7","libvips_threads_default":16,"cpus":16,"availableParallelism":16,"cpuModel":"12th Gen Intel(R) Core(TM) i7-12700","container_cpu_max_v2":"max 100000","container_cpu_quota_v1":null,"container_cpuset":"0-15","memory_limit":"max"}
```

各阶段，wall 与 CPU 取中位数，ratio 为 CPU/wall：

```text
## decode
24mp.jpg c=1                              wall=  195.97ms cpu=  199.22ms ratio=1.02
24mp.jpg c=4                              wall=  187.71ms cpu=  213.95ms ratio=1.14
24mp.jpg c=16                             wall=  199.16ms cpu=  232.16ms ratio=1.17
24mp.png c=1                              wall=   70.07ms cpu=   72.04ms ratio=1.03
24mp.png c=4                              wall=   56.65ms cpu=   81.03ms ratio=1.43
24mp.png c=16                             wall=   67.50ms cpu=   96.91ms ratio=1.44
12mp.jpg c=1                              wall=  101.41ms cpu=  103.92ms ratio=1.02
12mp.jpg c=4                              wall=   97.91ms cpu=  112.02ms ratio=1.14
12mp.jpg c=16                             wall=  105.51ms cpu=  125.44ms ratio=1.19

## qoi_encode
24mp.jpg-decoded-raw                      wall=  297.02ms cpu=  299.14ms ratio=1.01
12mp.jpg-decoded-raw                      wall=  149.99ms cpu=  151.24ms ratio=1.01

## qoi_decode
12mp.qoi                                  wall=   54.52ms cpu=   55.59ms ratio=1.02

## full_chain
24mp.jpg c=1                              wall=  497.50ms cpu=  507.19ms ratio=1.02
24mp.jpg c=16                             wall=  499.99ms cpu=  540.90ms ratio=1.08

## libvips_encode
webp q80 24mp raw c=1                     wall= 2918.16ms cpu= 2926.80ms ratio=1.00
jpeg q90 24mp raw c=1                     wall=  375.43ms cpu=  384.66ms ratio=1.02
resize1600+webp 24mp raw c=1              wall=  190.98ms cpu=  194.34ms ratio=1.02
webp q80 24mp raw c=4                     wall= 2943.93ms cpu= 2973.82ms ratio=1.01
jpeg q90 24mp raw c=4                     wall=  374.85ms cpu=  407.58ms ratio=1.09
resize1600+webp 24mp raw c=4              wall=  179.93ms cpu=  212.31ms ratio=1.18
webp q80 24mp raw c=16                    wall= 2919.38ms cpu= 3031.46ms ratio=1.04
jpeg q90 24mp raw c=16                    wall=  381.34ms cpu=  505.81ms ratio=1.33
resize1600+webp 24mp raw c=16             wall=  186.03ms cpu=  329.62ms ratio=1.77

## qoi_chain
12mp.qoi decode+encode                    wall=  202.34ms cpu=  204.64ms ratio=1.01
```

## 3. `bench2.mjs` 输出摘要

```text
## cache_check
decode 24mp.jpg c=16 cache=true           wall=  202.63ms cpu=  237.71ms ratio=1.17
decode 24mp.jpg c=16 cache=false          wall=  202.78ms cpu=  236.89ms ratio=1.17

## main_process
fileTypeFromBuffer 24mp.jpg               wall=    0.10ms cpu=    0.11ms ratio=1.12
fileTypeFromBuffer 24mp.png               wall=    0.24ms cpu=    1.22ms ratio=5.12
Buffer copy 24mp.jpg 19.8MB               wall=    6.91ms cpu=    7.95ms ratio=1.15
sharp.metadata() 24mp.jpg c=1             wall=    0.37ms cpu=    1.29ms ratio=3.51
sharp.metadata() 24mp.jpg c=16            wall=    0.39ms cpu=    1.26ms ratio=3.27

## decode_sweep
24mp.jpg c=1                              wall=  197.19ms cpu=  200.87ms ratio=1.02
24mp.jpg c=2                              wall=  186.80ms cpu=  212.45ms ratio=1.14
24mp.jpg c=4                              wall=  188.20ms cpu=  215.68ms ratio=1.15
24mp.jpg c=8                              wall=  194.23ms cpu=  221.90ms ratio=1.14
24mp.jpg c=16                             wall=  200.69ms cpu=  235.01ms ratio=1.17
24mp.png c=1                              wall=   64.27ms cpu=   66.40ms ratio=1.03
24mp.png c=2                              wall=   47.35ms cpu=   72.53ms ratio=1.53
24mp.png c=4                              wall=   51.77ms cpu=   77.71ms ratio=1.50
24mp.png c=8                              wall=   56.63ms cpu=   83.04ms ratio=1.47
24mp.png c=16                             wall=   64.07ms cpu=   99.43ms ratio=1.55

## full_chain
24mp.jpg c=1                              wall=  495.03ms cpu=  505.19ms ratio=1.02
24mp.jpg c=16                             wall=  503.76ms cpu=  544.50ms ratio=1.08
24mp.png c=1                              wall=  357.92ms cpu=  367.04ms ratio=1.03
24mp.png c=16                             wall=  356.40ms cpu=  397.94ms ratio=1.12
12mp.jpg c=1                              wall=  251.05ms cpu=  254.17ms ratio=1.01
12mp.jpg c=16                             wall=  254.86ms cpu=  275.62ms ratio=1.08

## resize_scaling
24mp raw -> 1600 raw c=1                  wall=   28.61ms cpu=   30.59ms ratio=1.07
24mp raw -> 1600 raw c=2                  wall=   16.31ms cpu=   32.79ms ratio=2.01
24mp raw -> 1600 raw c=4                  wall=   15.48ms cpu=   46.58ms ratio=3.01
24mp raw -> 1600 raw c=8                  wall=   18.78ms cpu=   80.46ms ratio=4.28
24mp raw -> 1600 raw c=16                 wall=   22.75ms cpu=  135.64ms ratio=5.96
jpeg24 -> resize 1600 webp c=1            wall=  336.66ms cpu=  342.12ms ratio=1.02
jpeg24 -> resize 1600 webp c=4            wall=  337.63ms cpu=  355.86ms ratio=1.05
jpeg24 -> resize 1600 webp c=16           wall=  348.93ms cpu=  373.14ms ratio=1.07
```

## 4. `bench3.mjs` 输出

```json
{
  "default_concurrency": 16,
  "qoi_encode 24mp jpg-raw c=1": {"wall_ms": 291.37, "cpu_ms": 293.71, "ratio": 1.01},
  "qoi_encode 24mp png-raw c=1": {"wall_ms": 291.79, "cpu_ms": 293.77, "ratio": 1.01},
  "qoi_decode 12mp c=1": {"wall_ms": 52.88, "cpu_ms": 53.84, "ratio": 1.02},
  "qoi_encode 24mp jpg-raw c=16": {"wall_ms": 294.10, "cpu_ms": 296.39, "ratio": 1.01},
  "qoi_encode 24mp png-raw c=16": {"wall_ms": 295.39, "cpu_ms": 297.50, "ratio": 1.01},
  "qoi_decode 12mp c=16": {"wall_ms": 52.50, "cpu_ms": 53.38, "ratio": 1.02},
  "decode 24mp.jpg default-c=16": {"wall_ms": 198.56, "cpu_ms": 236.27, "ratio": 1.19}
}
```

## 5. `ipc-parent.mjs` 输出

```json
{
  "inputBytes": 19776640,
  "replyBytes": 94111421,
  "rows": [
    {"roundtrip_wall_ms": 151.8, "parent_cpu_ms": 110.3, "child_handle_wall_ms": 2.1, "child_handle_cpu_ms": 2.9, "sent_bytes": 19776640, "received_bytes": 94111421},
    {"roundtrip_wall_ms": 131.0, "parent_cpu_ms": 95.9, "child_handle_wall_ms": 0.3, "child_handle_cpu_ms": 0.3, "sent_bytes": 19776640, "received_bytes": 94111421},
    {"roundtrip_wall_ms": 132.3, "parent_cpu_ms": 100.6, "child_handle_wall_ms": 0.3, "child_handle_cpu_ms": 0.3, "sent_bytes": 19776640, "received_bytes": 94111421}
  ]
}
```

## 6. `qoi_chunked.mjs` 输出

```text
## correctness (small images)
{
  "gradient": {
    "js_plain_eq_native_pixels": true,
    "native_encode_pixels_ok": true,
    "chunked_K2_pixels_eq_source": true, "chunked_K2_bytes": 60818,
    "chunked_K3_pixels_eq_source": true, "chunked_K3_bytes": 60818,
    "chunked_K4_pixels_eq_source": true, "chunked_K4_bytes": 60818,
    "chunked_K7_pixels_eq_source": true, "chunked_K7_bytes": 60818,
    "native_bytes": 60818
  },
  "runsCrossingChunks": {
    "js_plain_eq_native_pixels": true,
    "native_encode_pixels_ok": true,
    "chunked_K2_pixels_eq_source": true, "chunked_K2_bytes": 3649,
    "chunked_K3_pixels_eq_source": true, "chunked_K3_bytes": 3651,
    "chunked_K4_pixels_eq_source": true, "chunked_K4_bytes": 3649,
    "chunked_K7_pixels_eq_source": true, "chunked_K7_bytes": 3655,
    "native_bytes": 3649
  }
}

## 24mp jpg raw 6000x4000x3
native encode: pixels_ok=true bytes=94111421
js plain encode: 2739.9ms pixels_ok=true bytes=94111421
chunked K=4: phaseA=178.7ms phaseB=0.04ms phaseC=2699.3ms total=2878.0ms bytes=94111421 pixels_ok=true
chunked K=8: phaseA=168.0ms phaseB=0.05ms phaseC=2410.0ms total=2578.0ms bytes=94111421 pixels_ok=true
chunked K=4 with 4 workers: phaseA=176.7ms phaseB=0.12ms sab_copy=21.6ms workers=1356.0ms total=1554.4ms pixels_ok=true
```

## 7. 补充测量：12MP QOI 编码在 c=1 下的耗时

为统一 §4.1 第二张表的 c=1 口径补测，容器内 5 次，取中位数 151.20ms：

```json
{"twelveMP_RAW_QOI_encode_c1_ms":[148.11,150.14,151.20,154.99,170.72],"warmup":"4000x3000"}
```

## 8. 口径说明

- 报告 §4.1 第一张表统一取 `sharp.concurrency`=1：解码 197.19ms、QOI 编码 291.37ms、链路 495.03ms，其它约 6.5ms。
- c=16 的对照值：解码 200.69ms、链路 503.76ms，CPU/wall 分别为 1.17 与 1.08。
- `qoi_chunked.mjs` 早期一版在 DIFF 分支上有一处符号处理错误，导致 24MP 分块结果像素不一致；修正后重跑得到上表。留档脚本是修正后的版本。
