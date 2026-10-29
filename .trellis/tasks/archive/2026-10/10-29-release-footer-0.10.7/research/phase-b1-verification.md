# Phase B1 验证留痕：dry-run 构建与隔离栈 38 项回归（0.10.7）

- 任务：`10-29-release-footer-0.10.7` Phase B1，team task `task-13`
- 执行人：release-executor，Trellis implement 子代理
- 时间：2026-10-29 13:39 至 13:47 UTC
- 环境：Node `v20.20.2` + pnpm `9.6.0`，docker 29.x；未正式发布、未推镜像、未打 tag、未动 8080 实例

## 1. apk pin 修复

上一轮 dry-run 因 Alpine 3.23 软件源修订漂移失败，详见 `dryrun-failure-analysis.md`。本轮用锁定基础镜像重新解析：

```bash
APK_BASE_IMAGE='node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293' \
  bash support/apk-versions.sh           # 退出码 0
```

只改版本号，包集合与锁定形式不变，`Dockerfile.allinone` 未动：

| 位置 | 阶段 | 旧 | 新 |
| --- | --- | --- | --- |
| `Dockerfile:78` | vips_builder | `expat-dev=2.8.5-r0` | `expat-dev=2.9.0-r0` |
| `Dockerfile:81` | vips_builder | `imagemagick-dev=7.1.2.29-r0` | `imagemagick-dev=7.1.2.34-r0` |
| `Dockerfile:106` | vips_runtime | `expat=2.8.5-r0` | `expat=2.9.0-r0` |
| `Dockerfile:108` | vips_runtime | `imagemagick=7.1.2.29-r0` | `imagemagick=7.1.2.34-r0` |
| `Dockerfile:129` | prod_deps | `python3=3.12.15-r0` | `python3=3.12.16-r0` |

提交 `08286b9948e3f2334baac320506be41f94b7cbb2`，标题 `fix(build): refresh the Alpine apk pins for the 0.10.7 image`，diff 为 5 增 5 删，只含 `Dockerfile` 与任务留痕；CI run `40884198837` 为 success。

## 2. dry-run 构建

```bash
bash support/release-local.sh --dry-run
```

- 退出码 **0**，耗时 **232 秒**，尾部 `✅ dry-run：镜像已构建但未推送`。
- 本地构建出五个标签：`ghcr.io/zhemed/picsur:0.10.7`、`:v0.10.7`、`:0.10`、`:latest` 指向 `c3450d756142`；`:allinone` 指向 `7b3c94995cf5`。
- 未推送任何镜像、未创建或推送 `v0.10.7` tag。
- 完整日志：`research/dryrun-build-success.log`，被 `*.log` 规则 gitignore，仅保留在磁盘。

## 3. 隔离栈与断言

```bash
docker run -d --name picsur-verify-0107 --restart no \
  -p 127.0.0.1:18080:8080 -v /tmp/picsur-verify-0107-data:/data \
  ghcr.io/zhemed/picsur:allinone
```

- `/api/info` 第 3 次轮询即 200，内容：`production=true`、`version=0.10.7`、`demo=false`、`tracking.state=detailed`。
- 容器内 `node -p require('/picsur/backend/package.json').version` 为 `0.10.7`。
- `select count(*) from migrations` 为 `12`。
- `/data/allinone.env` 中管理员口令长度 32，回归使用成功。

## 4. 38 项回归

```bash
PICSUR_PSQL="docker exec picsur-verify-0107 psql -U picsur -d picsur" \
  bash support/regression-image-api.sh http://127.0.0.1:18080 "$PW"
```

- 退出码 **0**，耗时 **5 秒**，输出 **`RESULT: 38 passed, 0 failed`**；`[PASS]` 38 条、`[FAIL]` 0 条。
- 基础 34 项全过，含 7 格式转码、8 种源格式上传、删除语义、像素上限、SPA 深链；第 9 节老行尺寸 4 项因显式 `PICSUR_PSQL` 生效而全部通过。
- 夹具由脚本自动生成：本机 sharp 缺 JXL/JP2，按设计回退到容器 `ghcr.io/zhemed/picsur:allinone` 生成，全部就位后开跑。
- 完整日志：`research/regression-0107.log`，被 `*.log` 规则 gitignore，仅保留在磁盘。

## 5. 页脚验收

- 首页主 bundle 为 `main.84c8bdfff97bdd8f.js`，其中 `madeWith` 出现次数为 **0**。
- `bw` 浏览器打开 `http://127.0.0.1:18080/`，`app-footer` 存在：
  - `textContent.trim().length` 为 **0**，文本内容为空；
  - `getBoundingClientRect().height` 为 **53**。
- 截图：`research/verify-footer-blank.png`，1600x857。

## 6. 清理与现场

- `docker rm -f picsur-verify-0107` 成功，数据目录 `/tmp/picsur-verify-0107-data` 已删除。
- 无 `picsur-verify` 遗留容器，18080 端口空闲。
- `127.0.0.1:8080` 常驻实例未受影响：仍 `Up 9 days (healthy)`，运行镜像 ID 仍为 `sha256:4dd8bd40598b…`，与新构建无关。
- 本地镜像标签副作用：dry-run 把滚动标签 `:0.10`、`:latest`、`:allinone` 重新指向新构建；旧 `:0.10.6`、`:v0.10.6` 标签与旧镜像仍在，可回滚。正式发布时会重建并覆盖这些标签。

## 7. 结论

Phase B1 通过：apk pin 已按既有维护路径修复并推送，CI 绿；dry-run 五个标签本地构建成功；隔离栈断言全部符合预期；38 项回归 `38 passed, 0 failed`；页脚空白且高度 53；现场清理干净。可以进入 Phase B2 正式发布，但发布动作、推镜像、打 `v0.10.7` tag 与升级 8080 实例均未执行，等待 Lead 指令。
