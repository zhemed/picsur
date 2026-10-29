# Phase B1 dry-run 构建失败分析：Alpine apk 版本锁漂移

- 任务：`10-29-release-footer-0.10.7` Phase B1，team task `task-12`
- 执行人：release-executor，Trellis implement 子代理
- 时间：2026-10-29 13:36 至 13:40 UTC
- 结论：`bash support/release-local.sh --dry-run` **退出码 1，耗时 7 秒**，在 `vips_builder` 阶段失败，Phase B1 阻断。未生成任何 0.10.7 镜像、容器与 tag；隔离栈、38 项回归、页脚验收均未开始。

## 1. 失败命令与输出

```bash
export PATH="/root/picsur/.run/node20/bin:$PATH"
bash support/release-local.sh --dry-run
```

关键输出，完整日志见同目录 `dryrun-build-failure.log`：

```text
#8 [vips_builder 2/5] RUN apk add --no-cache
    build-base=0.5-r3 meson=1.9.1-r0 ... expat-dev=2.8.5-r0 ... imagemagick-dev=7.1.2.29-r0 ...
#8 1.747 ERROR: unable to select packages:
#8 1.748   expat-dev-2.9.0-r0:
#8 1.748     breaks: world[expat-dev=2.8.5-r0]
#8 1.749   imagemagick-dev-7.1.2.34-r0:
#8 1.749     breaks: world[imagemagick-dev=7.1.2.29-r0]
ERROR: failed to build: failed to solve: process "/bin/sh -c apk add --no-cache ..." did not complete successfully: exit code: 9
```

启动阶段正常：`release-local.sh` 的守卫全部通过，版本读取为 0.10.7，两个基础镜像 digest 解析成功（`node:20@sha256:8f693e…`、`node:20-alpine@sha256:fb4cd1…`），失败只发生在 `vips_builder` 的 apk 安装层。

## 2. 根因

Alpine 3.23 软件源发布了新的修订版本，旧版本已从源中下架：

| 包 | Dockerfile 锁的版本 | 源里当前版本 |
| --- | --- | --- |
| `expat-dev` / `expat` | `2.8.5-r0` | `2.9.0-r0` |
| `imagemagick-dev` / `imagemagick` | `7.1.2.29-r0` | `7.1.2.34-r0` |
| `python3` | `3.12.15-r0` | `3.12.16-r0` |

`apk add pkg=旧版本` 在旧版本不存在时直接失败，属确定性失败，重跑不会自愈。这与 Dockerfile 文件头注释、`build-and-deploy.md` §2 与 §8.3 预写的已知路径完全一致：Alpine 一发新的 `-rN`，Dockerfile 的 apk 锁就会构建失败，标准处置是跑 `bash support/apk-versions.sh` 重新解析并同步。

## 3. 应修改的 pin 预览（未执行，属代码改动）

用 `support/apk-versions.sh` 对 Dockerfile 锁定的 `node:20-alpine@sha256:fb4cd12c…` 解析当前版本，原始输出见同目录 `apk-versions-resolution.log`。与仓库现状逐项比对，**恰好 5 处需要改动**：

| 文件:行 | 阶段 | 当前 | 应改为 |
| --- | --- | --- | --- |
| `Dockerfile:78` | vips_builder | `expat-dev=2.8.5-r0` | `expat-dev=2.9.0-r0` |
| `Dockerfile:81` | vips_builder | `imagemagick-dev=7.1.2.29-r0` | `imagemagick-dev=7.1.2.34-r0` |
| `Dockerfile:106` | vips_runtime | `expat=2.8.5-r0` | `expat=2.9.0-r0` |
| `Dockerfile:108` | vips_runtime | `imagemagick=7.1.2.29-r0` | `imagemagick=7.1.2.34-r0` |
| `Dockerfile:129` | prod_deps | `python3=3.12.15-r0` | `python3=3.12.16-r0` |

其余 43 个 `Dockerfile` pin 与 `Dockerfile.allinone` 的 5 个 pin（`postgresql17` 17.11-r0、`postgresql17-client` 17.11-r0、`postgresql17-contrib` 17.11-r0、`tini` 0.19.0-r3、`su-exec` 0.3-r0）均无需改动。

注意两点：只修 vips_builder 的两条不够，vips_runtime 会因同名包同样失败；prod_deps 的 `python3` 是第三处，修完前两处后会在那里继续失败，建议一次改完五处。

## 4. 建议路径

1. 新开一个小任务，或由 Lead 授权，更新上述 5 处 pin；只改 `Dockerfile`，不改业务代码与版本号。
2. 用 `docker build` 或 `bash support/release-local.sh --dry-run` 复验构建通过；构建缓存可复用，预计比本次冷启动快。
3. 构建通过后回到 Phase B1：dry-run 五标签 → 隔离栈 18080 → 38 项回归 → 页脚验收。
4. 不建议去掉版本 pin 改用宽范围，会破坏可复现契约（Dockerfile 头与 spec §2 都明确要求锁定）。

## 5. 现场状态

- 本地镜像仍只有 0.10.6 旧标签，无 `ghcr.io/zhemed/picsur:0.10.7`、`:v0.10.7`、`:0.10`、`:latest` 的新构建结果。
- 无 `picsur-verify-0107` 容器，18080 空闲；未起隔离栈，无回归 RESULT。
- 未打任何 tag，未推送镜像，未动 `127.0.0.1:8080` 实例，该实例仍 `Up 9 days (healthy)`。
- 两份日志被 `.gitignore` 的 `*.log` 规则忽略，只保留在磁盘，不随提交入库；本分析文件随 pin 修复提交入库。
- 构建中间层保留在 docker build cache 中，未清理，便于下一次构建命中缓存。

## 6. 修复已应用（2026-10-29）

按第 3 节表格更新了 `Dockerfile` 的 5 处 pin，只改版本号，包集合与锁定形式不变，`Dockerfile.allinone` 未动。解析基准为 `node:20-alpine@sha256:fb4cd12c…`，`support/apk-versions.sh` 退出码 0。复跑 dry-run 与 38 项回归的结果见 team task `task-13` 回报与本任务后续留痕。

## 附：复现命令

```bash
cd /root/picsur
export PATH="/root/picsur/.run/node20/bin:$PATH"
bash support/release-local.sh --dry-run               # 期望 exit 0；当前 exit 1
APK_BASE_IMAGE='node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293' \
  bash support/apk-versions.sh                        # 解析各阶段当前应锁版本
```
