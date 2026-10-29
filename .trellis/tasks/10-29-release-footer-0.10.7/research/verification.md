# 独立终验报告：0.10.7 发布与本机实例升级

- **任务**：`.trellis/tasks/10-29-release-footer-0.10.7`，独立终验，team task `task-16`
- **验证角色**：Trellis check 子代理 `footer-verifier`，不采信执行成员结论
- **时间**：2026-10-29 13:58 至 14:06 UTC
- **代码基线**：HEAD `b0e50d2`，origin/master 同为 `b0e50d2`，版本 0.10.7
- **环境**：本机 docker 29 系列；常驻浏览器 Chromium 153，视口 1600x857、DPR 1、语言 zh；实例 `127.0.0.1:8080`

## 一、结论

**结论：通过，无打回项。** 未修改任何文件，唯一写入为本报告与两张截图；未执行 git 写操作，未改容器、服务与数据。

逐项断言全部成立：实例 `0.10.7` 且镜像 digest 精确匹配 `sha256:3c6bcf7fc981…`；页脚空白且高 53、关于页当前与最新版本均为 0.10.7；远端 `v0.10.7` 两行且 peel 指向 `b0e50d2`、`v0.10.6` 仍在；五个镜像标签 pull 成功且 digest 与发布记录一致；最新 CI success；回归 `RESULT: 38 passed, 0 failed`；业务代码无未提交改动。

与实现留痕有 4 处差异和 6 项残留风险，均不构成失败项，见第三、四节。

## 二、逐项证据

### 1. 本机实例

`curl http://127.0.0.1:8080/api/info` 连续三次采样结果一致：

```json
{"success":true,"statusCode":200,"data":{"production":true,"demo":false,"version":"0.10.7","tracking":{"state":"detailed"}}}
```

| 检查项 | 实测值 | 判定 |
|---|---|---|
| `/api/info` version | `0.10.7` | 通过 |
| production / demo | `true` / `false` | 通过 |
| `docker ps --filter publish=8080` | `picsur`，`ghcr.io/zhemed/picsur:allinone`，`Up 10 minutes (healthy)`，`0.0.0.0:8080->8080/tcp`、`[::]:8080->8080/tcp` | 通过 |
| 容器 Image ID | `sha256:3c6bcf7fc981e9805618ea9506ed28b5c9bd42b6008010bd996be6e1ef917aab` | 与任务要求逐字符一致 |
| RepoDigest | `ghcr.io/zhemed/picsur@sha256:3c6bcf7fc981e9805618ea9506ed28b5c9bd42b6008010bd996be6e1ef917aab` | 通过 |
| 容器创建时间 | `2026-10-29T13:54:26Z`，状态 running、health healthy | 通过 |
| 端口映射 | `8080/tcp` 的 HostIp 为空串、HostPort `8080` | 与升级前一致 |
| 重启策略 | `always` | 与升级前一致 |
| 网络模式 | `bridge`，privileged `false`，网络列表仅 `bridge` | 与升级前一致 |
| 挂载 | `/root/picsur-data -> /data` RW；`/var/run/docker.sock -> /var/run/docker.sock` RW | 与升级前一致 |
| 环境变量 | 容器 15 条，与镜像默认 Env 逐条相同，额外 0、缺失 0 | 与升级前一致 |
| 健康检查 | 镜像自带 `wget /api/info`，interval 15s，startPeriod 90s | 通过 |
| 遗留容器 | `docker ps -a` 无 `picsur-verify-*`、`picsur-prev-*` | 通过 |
| 遗留端口与目录 | 18080 端口空闲，`/tmp/picsur-verify-0107-data` 不存在 | 通过 |

### 2. 页面验收

`bw` 打开 `http://127.0.0.1:8080/?nocache=<时间戳>`，路由重定向到 `/upload?nocache=<时间戳>`，在 1600x857、DPR 1、zh 下测得：

| 断言 | 实测值 | 判定 |
|---|---|---|
| `app-footer` 存在 | 存在，top 804 | 通过 |
| `app-footer` 高度 | `53px` | 通过 |
| `app-footer` 文本 | `innerText.trim()` 为空串，`innerHTML` 为 `<footer _ngcontent… class="container"></footer>` | 通过 |
| `footer` 计算高度 | `39px`，margin-top `14px`，合计 53 | 通过 |
| 主区域 `.grow-full.relative` | top `96`、高 `708`，且 `708 = 857 - 149` | 主界面无位移 |
| 设置页「关于」 | 当前版本 `0.10.7`、最新版本 `0.10.7`、「当前已是最新版本」「上次升级已成功完成」 | 通过 |
| 实例主 bundle | `main.84c8bdfff97bdd8f.js`，与 Phase B1 记录的 bundle hash 一致，`madeWith` 0 次、`app.footer` 0 次、`源代码`/`演示版本` 0 次 | 通过 |
| 实例 i18n | `/assets/i18n/zh.json` 与 `en.json` 均 243 键、无 footer 键、保留 `app.unknownVersion` | 通过 |
| 图片列表 API | 已登录态 POST `/api/image/list` 返回 201，total `1`、pages `1` | 与留痕一致 |

截图已写入任务 research：`final-check-footer.png` 1600x857 页脚纯背景无文字；`final-check-about.png` 关于页显示当前与最新版本均 0.10.7。

### 3. 发布物

**远端 tag**：

```text
f492c8e2c8af71f9468234c88e9ed36449d39722	refs/tags/v0.10.7
b0e50d28619a1f269fb51cd786e608e5a7ce9258	refs/tags/v0.10.7^{}
438b6b786c2e2ad0603a8b3cd21915440b51ffc1	refs/tags/v0.10.6
fe4f8371f8a246d182dec23e53f889e334eec0aa	refs/tags/v0.10.6^{}
```

- `v0.10.7` 恰两行，peel 等于 `b0e50d2`，等于 HEAD 与 origin/master；tag 对象类型为 annotated tag，`f492c8e2…`，指向 commit `b0e50d2`。
- `v0.10.6` 仍在，peel `fe4f837` 与历史一致。
- tag 完整性：本地 30 个 tag 与远端 30 个 tag 的 tag 对象 SHA 逐条相同；`support/release-local.sh` 第 112 至 113 行只创建 annotated tag 并单独 push 该 tag，不推其它 tag；发布日志只有一条 `[new tag] v0.10.7 -> v0.10.7`。未发现 0.10.7 以外的 tag 变化。

**五个标签 `docker pull`** 全部成功，digest 与发布日志 `research/release-0107-run.log` 完全一致：

| 标签 | pull 结果 | digest |
|---|---|---|
| `:0.10.7` | Image is up to date | `sha256:ecd41501fc35a185f515fec67d2862aea7c2638d77fef1ae858b5e1a9cb4c603` |
| `:v0.10.7` | Image is up to date | 同上 `ecd41501fc35…` |
| `:0.10` | Image is up to date | 同上 `ecd41501fc35…` |
| `:latest` | Image is up to date | 同上 `ecd41501fc35…` |
| `:allinone` | Image is up to date | `sha256:3c6bcf7fc981e9805618ea9506ed28b5c9bd42b6008010bd996be6e1ef917aab` |

发布日志对应行：`allinone: digest: sha256:3c6bcf7fc981…`、`latest: digest: sha256:ecd41501fc35…`，与实测一致；运行中容器 Image ID 正是 allinone digest。

**CI**：`gh run list --branch master --limit 6` 结果：

| 时间 UTC | 提交 | 结论 | 说明 |
|---|---|---|---|
| 13:47:10 | `b0e50d2` | success | 最新一次，HEAD，run 40885136767 |
| 13:41:07 | `08286b9` | success | apk pin 修复 |
| 13:33:26 | `b09f327` | success | 版本提交 |
| 13:31:37 | `f6c81f6` | success | 依赖安全子任务归档 |
| 13:20:31 | `2a8f38c` | success | 依赖修复与 zod v4 迁移 |
| 12:37:48 | `846f656` | failure | 发布前旧 HEAD，因 audit 失败，已被后续修复覆盖 |

最新 CI run `40885136767` headSha 为 `b0e50d2`，conclusion 为 `success`。

### 4. 仓库与留痕

- `git status --porcelain -- . ':(exclude).trellis'` 为空：业务代码、配置、锁文件无未提交改动。
- HEAD 与 origin/master 均为 `b0e50d2`；`git log -1` 与 release 提交链一致。
- HEAD 上四个 `package.json` 版本均为 `0.10.7`；`grep '"version": "0.10.6"' --include=package.json` 排除 node_modules 后无命中，无版本号漂移。
- `git show --stat b09f327`：仅 4 个 `package.json`，4 增 4 删，无业务代码。
- 提交锚点：`44ba1fd`、`b09f327`、`08286b9`、`b0e50d2` 的提交正文均含 `[task:10-29-release-footer-0.10.7]`。
- `git status` 中 `.trellis/spec/.../build-and-deploy.md`、任务 `prd.md` 的修改与 research 下未跟踪文件，按指令属 Lead 收口在写，不作为失败项。
- 任务 research 下留痕齐备：`phase-a-preflight.md`、`phase-b1-verification.md`、`phase-b3-upgrade-verification.md`、`regression-0107.log`、`dryrun-build-success.log`、`release-0107-run.log`、`release-runbook.md`、`phase-b1` 与 `phase-b3` 的截图均在盘。

### 5. 回归与升级留痕核对

- `research/regression-0107.log` 独立计数：`[PASS]` 38 行、`[FAIL]` 0 行、末尾 `RESULT: 38 passed, 0 failed`；第 9 节 4 项老行尺寸回归均在，与 38 口径吻合。
- `phase-b1-verification.md`：apk pin 修复提交 `08286b9`、dry-run 退出码 0、隔离栈 version 0.10.7、production true、migrations 12、38 项回归全过、页脚空且高 53、容器与数据目录已清理，与日志互证。
- `phase-b3-upgrade-verification.md` 升级前后对照：升级前 `/api/info` 0.10.6、容器 `477e9cf5…`、镜像 `4dd8bd40…`、migrations 12、图片 total 1；升级后 0.10.7、conclusion 与本次实测一致；回滚安全网 `pg_dump` 文件 `/tmp/picsur-pre-0107.sql` 实测存在，17693 字节，文件头为 PostgreSQL database dump；旧常规镜像 `ghcr.io/zhemed/picsur:0.10.6` 与 `:v0.10.6` 实测仍在，镜像 ID `248755520402`。
- 回滚口径：b3 第 6 节给出从 `v0.10.6` 常规镜像加深 `Dockerfile.allinone` 重建 allinone 的三步命令；旧 allinone 镜像 `sha256:4dd8bd40…` 实测确实已不在本地，与 b3 第 5 节说明一致。
- 34 与 38 的口径：runbook 第 5.2 节明确「基础 34 项，有数据库访问时另加 4 项老行回归，共 38」，PRD 工作区修订后也写 38，属同一口径，不是矛盾。

## 三、与实现留痕的差异

| 差异 | 性质 | 说明 |
|---|---|---|
| PRD Notes 写「远端 tag 只到 v0.9.0 附近」 | 文档失准 | 实测远端已有 v0.10.0 至 v0.10.6 共 7 个 tag；不影响 v0.10.7 未被占用与本次发布判定 |
| PRD R4 原写「34 项回归」 | 口径说明 | 实际 38 项由基础 34 加老行 4 项组成，runbook 5.2 有说明，Lead 已在工作区 PRD 改为 38 |
| 任务 15 原计划「保留旧 allinone 镜像」 | 已记录偏差 | 旧 allinone 镜像在升级前已被本地镜像存储回收，实测 inspect 报 No such image；b3 第 5 节已记录，回滚改走 v0.10.6 重建路径 |
| `picsur-prev-0106` 回滚容器被应用自动清理 | 已记录偏差 | 新实例 `SelfUpdateService.cleanupLeftovers()` 于约 5 秒内删除，b3 第 5 节记录且已写入 spec 6.2 节；本次未触发回滚，不影响验收 |

我的截图命名为 `final-check-footer.png` 与 `final-check-about.png`，与执行成员的 `verify-instance-*` 区分，两者内容一致。

## 四、残留风险

| 风险 | 等级 | 说明与建议 |
|---|---|---|
| 回滚镜像需重建 | 中 | 旧 allinone 镜像不在本地，回滚需从 `v0.10.6` 常规镜像重建 allinone，耗时数分钟；重建命令已记录在 b3 第 6 节，依赖 ghcr 可拉取 |
| 数据安全网在 `/tmp` | 中 | `/tmp/picsur-pre-0107.sql` 是临时文件，重启或清理可能丢失；建议复制到持久位置或至少在升级窗口内保护 |
| 收口材料未提交 | 中 | `.trellis/spec` 与 PRD 修改、research 未跟踪文件均为 Lead 在写；若丢失则本轮发布留痕不完整，收口提交后应复核 `git status` 干净 |
| 手动升级的 `-prev-` 回滚窗口极短 | 中 | 应用自升级清理逻辑约 5 秒内删除停止的同 lineage 容器，后续手动升级不要依赖 rename 保留旧容器，spec 6.2 已定调 |
| tag 变化的可证明范围 | 低 | 本地与远端 30 个 tag 对象逐条一致，发布脚本只推单个 tag，日志只有一条新 tag；但没有发布前远端 tag 的完整快照，历史性只能靠上述三项互证 |
| 页面验收依赖浏览器已有登录态 | 低 | about 页验证使用浏览器 localStorage 中既有管理员 apiKey，未验证其来源与过期时间；本次页面渲染与 API 调用均正常 |

## 五、验证命令摘要

```text
curl http://127.0.0.1:8080/api/info                      # 3 次：0.10.7 / production true / demo false
docker ps --filter publish=8080                          # picsur + ghcr.io/zhemed/picsur:allinone + healthy
docker inspect picsur                                    # Image sha256:3c6bcf7fc981…; always / bridge / 8080 / 两挂载 / Env 15
docker ps -a --format '{{.Names}}' | grep -E 'picsur-(verify|prev)-'   # 无遗留
bw open 'http://127.0.0.1:8080/?nocache=<ts>'            # app-footer 53px、文本空、grow 708 = 857-149
bw eval 设置页「关于」                                    # 当前版本 0.10.7、最新版本 0.10.7
bw shot …/final-check-footer.png; bw shot …/final-check-about.png
git ls-remote --tags origin 'refs/tags/v0.10.7*'         # 两行，peel b0e50d2
git ls-remote --tags origin 'refs/tags/v0.10.6*'         # 仍在
for t in 0.10.7 v0.10.7 0.10 latest allinone; do docker pull ghcr.io/zhemed/picsur:$t; done
gh run list --branch master --limit 6                    # b0e50d2 success 40885136767
git status --porcelain -- . ':(exclude).trellis'         # 空
grep -c '\[PASS\]' regression-0107.log                   # 38；FAIL 0；RESULT: 38 passed, 0 failed
```

写入声明：仅新增本报告与两张截图，未改业务代码、规范文档、任务正文与容器状态。
