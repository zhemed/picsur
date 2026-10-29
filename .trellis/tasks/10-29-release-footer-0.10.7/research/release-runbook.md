# Research: 0.10.7 发版 runbook 与发布后验证

- Query: 为「发版 0.10.7：发布页脚清空改动」产出一份可直接执行、可回滚的发布 runbook；覆盖版本号规则、真实发布链路、发布前检查、发布后隔离栈回归、本机实例升级、风险与回滚。
- Scope: mixed，项目源码 + spec + journal + 归档任务 + 本机只读探测。
- Date: 2026-10-29
- 调研人: release-researcher，Trellis 子代理，只读调研，唯一写入本目录。

## 0. 结论速览

1. 本仓库**没有** `.github/workflows/release-image.yml`，该工作流已于 2026-10-16 由提交 `54fe809` 删除；现在**唯一发布路径**是本地脚本 `support/release-local.sh`，它构建并推送 `ghcr.io/zhemed/picsur` 的五个标签，并自动打推 `v<版本>` git tag。spec 与 ci.yml 注释里「tag 推送即自动构建镜像」的表述均已过期。
2. 版本号只有四个权威位置：根、`shared`、`backend`、`frontend` 的 `package.json` 第 3 行；`pnpm-lock.yaml` 不含自身版本，升版**不需要**改锁文件。历史发布提交 `fe4f837` 实证就是 4 文件 4 行。
3. `v0.10.7` 在本地与远端都**未被占用**；远端 tag 最新是 `v0.10.6`，指向 `fe4f837`；当前 `HEAD` 与 `origin/master` 都是 `846f656`，页脚改动已在远端。
4. 发布后必须做的是：`docker pull` 新 `:allinone` → 起隔离栈 → 跑 `support/regression-image-api.sh`。脚本当前版本基础 34 项，有数据库访问时另加 4 项老行回归，因此**合理结果是 38 passed, 0 failed**；文档里的「34 项」指基础项。CI 只做 install/build/audit/lint，**不构建镜像**，CI 绿不能证明镜像可用。
5. 本机 `127.0.0.1:8080` 实测为 all-in-one，版本 `0.10.6`，`PICSUR_PRODUCTION=true`；升级本机实例已包含在 `directive.md` 的弹窗口径「发布、回归并升级本机实例」里，属本次授权范围，但必须由有 docker 权限的执行成员操作，且**先回归通过再升级**。
6. 本次改动风险画像：`v0.10.6..HEAD` 的业务改动只有前端 4 个文件且全是页脚与词典；`backend`、`shared`、`Dockerfile*`、`support/` 零改动，**没有新迁移**，所以升级与回滚的数据风险为零。

## 一、版本号规则

### 1.1 当前 0.10.6 出现位置

`git grep` 与全仓检索结果：

| 位置 | 行 | 性质 |
| --- | --- | --- |
| `package.json` | 3 | 权威版本源：`release-local.sh` 读它，Docker 构建拷贝它 |
| `shared/package.json` | 3 | 权威版本源：pnpm 运行时注入 `npm_package_version` |
| `backend/package.json` | 3 | 权威版本源：常规镜像 CMD 读它 |
| `frontend/package.json` | 3 | 权威版本源：与其余三处保持同步 |
| `.trellis/tasks/**`、`.trellis/workspace/**`、`.trellis/spec/**` | 多处 | 历史记录与文档，**不是版本源，本次不要改** |
| `pnpm-lock.yaml` | 无 | 锁文件只记录依赖解析，不记录 workspace 自身版本 |

实测命令与结果：

```bash
cd /root/picsur
grep -n '"version"' package.json backend/package.json frontend/package.json shared/package.json
# package.json:3:  "version": "0.10.6",
# backend/package.json:3:  "version": "0.10.6",
# frontend/package.json:3:  "version": "0.10.6",
# shared/package.json:3:  "version": "0.10.6",
```

### 1.2 升到 0.10.7 需要改哪几处

只改上面四处，命令可复制：

```bash
cd /root/picsur
for f in package.json backend/package.json frontend/package.json shared/package.json; do
  sed -i '0,/"version": "0\.10\.6"/s//"version": "0.10.7"/' "$f"
done

grep -n '"version": "0.10.7"' package.json backend/package.json frontend/package.json shared/package.json
git diff --stat
# 期望恰好：4 files changed, 4 insertions(+), 4 deletions(-)
git diff
# 期望每处只有 "0.10.6" -> "0.10.7" 一行，无其它改动
git diff --quiet -- pnpm-lock.yaml && echo 'lockfile untouched OK'
```

判定标准：

- 四处都是 `0.10.7`；
- `git diff --stat` 为 4 个文件、各 1 增 1 删；
- `pnpm-lock.yaml` 未变化；
- 页脚、i18n、后端、shared、Dockerfile、support 一律不动。本次已确认业务改动已在 `846f656` 里，发版只升版本号。

### 1.3 发布脚本：`support/release-local.sh`

源码：116 行，2026-10-13 引入，是当前**唯一**发布路径。核心事实：

| 项 | 值 |
| --- | --- |
| 用法 | `bash support/release-local.sh [--no-allinone] [--dry-run] [--allow-dirty] [--allow-downgrade]` |
| 版本来源 | 根 `package.json` 的 `version`，经 python3 读取 |
| 镜像名 | `ghcr.io/zhemed/picsur` |
| 推送标签 | `:0.10.7`、`:v0.10.7`、`:0.10`、`:latest`，以及 all-in-one 的 `:allinone` |
| 额外动作 | 成功后 `git tag -a v0.10.7 -m "release 0.10.7"` 并 `git push origin v0.10.7`；本地 tag 已存在且指向 HEAD 则跳过 |

脚本内的四道守卫，逐条读源码确认：

| 守卫 | 触发条件 | 失败表现 | 跳过开关 |
| --- | --- | --- | --- |
| 1 脏树/未推送 | `git status --porcelain` 非空，或 `@{u}..HEAD` 有提交 | 拒绝执行并列出前 10 行 | `--allow-dirty` |
| 2 同版本 tag 错位 | 本地或远端 `v0.10.7` 已存在但不指向当前 HEAD | 拒绝执行，提示改版本号或删 tag | `--allow-dirty` |
| 3 版本号回退 | 当前版本低于远端最高 tag | 拒绝执行，防止 `:latest` 回退 | `--allow-downgrade` |
| 4 docker/登录 | `docker info` 失败直接退出；ghcr 未登录仅警告 | docker 不可用则硬退出 | 无 |

脚本会做的事，按顺序：

1. 校验 docker 可用、警告 ghcr 未登录；
2. 四道守卫；
3. `docker build` 常规镜像，输出 `-t :0.10.7 -t :v0.10.7 -t :0.10 -t :latest`；
4. `docker build -f Dockerfile.allinone --build-arg PICSUR_BASE_IMAGE=ghcr.io/zhemed/picsur:0.10.7`，输出 `:allinone`；
5. 依次 `docker push` 四个常规标签，再 push `:allinone`；
6. 打并推 git tag `v0.10.7`。

副作用与注意事项：

- **会改写 ghcr 的 `:latest` 与 `:allinone`**，这两个是滚动标签，推上去即对已部署实例可见；
- **不做版本号修改、不做提交**：版本号必须由执行人先改并提交推送，否则镜像里还是旧版本号；
- 构建先于推送，构建失败不会污染仓库；但推送是逐标签的，中途断网会留下部分标签，重跑脚本可补齐，属幂等；
- 推送顺序为 `:0.10.7` → `:v0.10.7` → `:0.10` → `:latest` → `:allinone`，因此「`:latest` 已换新而 `:allinone` 还是旧」的窗口存在，**在 `:allinone` 推送完成前不要升级实例**；
- `--dry-run` 只构建不推送、不打 tag，适合先本地验证镜像；
- 不允许在同版本已发布并已升级实例后再重推同版本号：面板比较的是版本号，重推对已部署实例不可见，见 `docs/MAINTAINING.md` §3；
- 脚本全程需要 docker 与网络，不需要 Node 20，构建发生在容器内。发布前的主机侧构建与审计才需要 Node 20。

### 1.4 已失效的脚本与死引用

| 脚本 | 状态 | 证据 |
| --- | --- | --- |
| `support/setversion.sh` | 已删除，但根 `package.json` 的 `"setversion"` 仍指向它 | 删除提交 `db04c3b`；`pnpm setversion` 会失败 |
| `support/purge-all.sh` | 已删除，`"purge-all"` 仍指向它 | 同 `db04c3b` |
| `.github/workflows/release-image.yml` | 已删除 | 删除提交 `54fe809`，提交信息明说发布只走 `release-local.sh` |
| `support/verify-published-image.sh` | 已删除 | 随单部署路径精简一并删除 |

结论：**不要用** `pnpm setversion`，版本号按 1.2 手工改四处；不要找 `release.sh`，没有这个文件。

### 1.5 版本号在运行期的消费链路

1. 根 `package.json` 的 `version` 被 `release-local.sh` 读作发布版本；
2. Docker 构建把四个 `package.json` 拷进镜像；
3. 常规镜像 CMD 走 `pnpm --filter picsur-backend start:prod`，pnpm 注入环境变量 `npm_package_version`；
4. all-in-one 入口脚本在变量为空时读 `/picsur/backend/package.json` 补上，见 `support/allinone-entrypoint.sh`；
5. 后端 `host.config.service.ts` 读该变量，`/api/info` 返回 `version`；
6. 设置页「关于」与升级检测读 `/api/info` 与 GitHub tags；
7. 页脚**不再显示版本**，2026-10-29 已清空，见 `.trellis/spec/picsur-frontend/frontend/index.md` 第 85 至 89 行。

## 二、发布链路

### 2.1 现状：GitHub Actions 只剩 CI，且 CI 不发镜像

`.github/workflows/` 下只有 `ci.yml`，实测：

```bash
cd /root/picsur
git ls-files .github/
# .github/workflows/ci.yml
```

`ci.yml` 事实：

| 项 | 值 |
| --- | --- |
| 触发 | `push` 到任意分支，以及 `pull_request`；**tag 推送不匹配 branches 过滤器，不会触发** |
| 步骤 | `pnpm install --frozen-lockfile` → `pnpm build` → `bash support/audit-prod.sh` → `pnpm lint` |
| 权限 | `contents: read`，没有任何 packages 写权限 |
| 超时 | 30 分钟 |
| 是否构建镜像 | **否**，也没有 docker 步骤 |

`ci.yml` 头部注释仍写「镜像发布走 release-image.yml」，这是**过期注释**，实际文件不存在。

### 2.2 历史上的 `release-image.yml`，仅供对账

旧工作流在删除前已被改为仅手动触发 `workflow_dispatch`；再早的版本由 `v*` tag 触发。其关键参数可从删除提交的父版本读到：

| 项 | 旧值 |
| --- | --- |
| 触发 | 早期为 `v*` tag；删除前为手动 `workflow_dispatch`，tag ref 才发布，分支 ref 只构建 |
| 标签策略 | semver 版本、主.次、`ref`、`latest`，另建 `:allinone`，基镜像用刚构建镜像的 digest |
| 凭据 | 仅内置 `GITHUB_TOKEN` 加 `packages: write`，无额外 secret |
| 实测耗时 | 首次 v0.6.0 为 7 分 26 秒，后续 7 分钟以上，超时上限 120 分钟 |
| 现状 | 已删除，见 `54fe809`；不要再等 Actions 发版 |

### 2.3 git tag 历史与 v0.10.7 可用性

实测命令与结果：

```bash
cd /root/picsur
git tag -l 'v0.10.*' | sort -V
# v0.10.0 v0.10.1 v0.10.2 v0.10.3 v0.10.4 v0.10.5 v0.10.6
git tag -l 'v0.10.7'
# 空，本地不存在
git ls-remote --tags origin 'refs/tags/v0.10.7*'
# 空，远端不存在
git ls-remote --tags --refs origin | awk '{print $2}' | sed 's#refs/tags/##' | sort -V | tail -3
# v0.10.4 / v0.10.5 / v0.10.6
git rev-parse 'v0.10.6^{commit}'
# fe4f8371f8a246d182dec23e53f889e334eec0aa 即 chore(release): 0.10.6
git for-each-ref refs/tags/v0.10.6 --format='%(objecttype) %(taggername) %(contents:subject)'
# tag zhemed release 0.10.6
```

三个直接结论：`v0.10.7` 未被占用；历史 tag 是 annotated tag；远端 tag 列表**已到 v0.10.6**，PRD 第 27 行「远端 tag 只到 v0.9.0 附近」的说法不准确，执行时以本条实测为准。

### 2.4 本次需要 push 什么

| 对象 | 谁推 | 命令 | 备注 |
| --- | --- | --- | --- |
| 任务留痕提交 | 执行成员 | `git push origin master` | PRD R6 要求与发布提交分开 |
| 版本号提交 | 执行成员 | `git push origin master` | 必须先推，release 脚本守卫 1 要求 `@{u}` 无待推提交 |
| 五个镜像标签 | `release-local.sh` | 脚本内 `docker push` | 需要 ghcr 登录与网络 |
| git tag `v0.10.7` | `release-local.sh` | 脚本内 `git tag -a` 加 `git push origin v0.10.7` | 脚本失败漏推时手工补，见 7.1 |

不需要推：`pnpm-lock.yaml`、镜像之外的额外产物、GitHub Release。仓库 `master` 有保护规则但允许直推，禁强推与删除，见 journal Session 24。

### 2.5 网络、授权、耗时矩阵

| 动作 | 需要网络 | 需要授权 | 实测或估计耗时 |
| --- | --- | --- | --- |
| `git push origin master` | 是 | 仓库约定默认允许推送 | 数秒 |
| `pnpm install --frozen-lockfile` | 是 | 装包动作 | 约 20 秒至 1 分钟，视 store 缓存 |
| `pnpm build` | 否 | 无 | 估计 1.5 至 4 分钟，三包顺序构建 |
| `bash support/audit-prod.sh` | 是，官方 registry | 无 | 估计 10 至 40 秒 |
| `pnpm lint` | 否 | 无 | **实测 2.4 秒**，0 error 9 warning |
| `bash support/release-local.sh` | 是，拉基础镜像与推 ghcr | 发布授权，用户已给「发版吧」 | 热缓存历史实测 1 分 59 秒至 2 分 07 秒；冷缓存估计 10 至 20 分钟 |
| `docker pull :allinone` | 是 | 发布验证授权 | 视网络，估计 10 至 60 秒 |
| 34 项回归 | 否，除夹具缺料要拉镜像 | 无 | 约 30 至 90 秒；撞限流最多多等约 72 秒 |
| 面板升级本机实例 | 是，拉 :allinone | 已在 directive 授权范围 | 历史实测 50 至 110 秒 |

## 三、发布前检查清单

### 3.1 环境口径

本机实测：

| 项 | 实测值 | 说明 |
| --- | --- | --- |
| 宿主 Node | v24.22.0 | **不能**用于 `pnpm install` 与构建，见 AGENTS.md 第 3 条 |
| 构建用 Node | `/root/picsur/.run/node20/bin/node` v20.20.2 | gitignored，`export PATH` 后生效 |
| pnpm | 9.6.0 | 与 `packageManager` 和 CI 一致，PATH 切到 node20 后仍是 9.6.0，已实测 |
| docker | 29.7.2 | 构建、推送、隔离栈、升级都要它 |
| python3 | 有 | audit 脚本解析锁文件需要 PyYAML |
| jq | 有 | 解析 `/api/info` 与升级检测响应 |
| bw 浏览器 | 运行中，Chrome 153 | 页面级验收用 |
| gh | 有二进制，认证状态未验证 | 查 CI 状态用，可退化为网页 |

固定 Node 20 与 pnpm 9.6.0 的会话前缀，所有主机侧构建命令之前都要先执行：

```bash
cd /root/picsur
export PATH="/root/picsur/.run/node20/bin:$PATH"
node -v      # 期望 v20.20.2
pnpm -v      # 期望 9.6.0
```

### 3.2 最小必跑命令

分三档，全部可复制。

必跑，缺少任一项不得发布：

```bash
# 网络：否；耗时：2.4 秒；已实测基线 0 error 9 warning
pnpm lint

# 网络：否；耗时：估计 1.5 至 4 分钟；三包顺序由根脚本保证 shared -> backend -> frontend
pnpm build

# 网络：是，官方 registry；耗时估计 10 至 40 秒；退出码 0 才继续
bash support/audit-prod.sh

# 网络：否；确认锁文件与 package.json 未漂移，本次升版不应触碰锁文件
git diff --quiet -- pnpm-lock.yaml && echo 'lockfile OK'
```

按情形跑：

```bash
# 仅当 node_modules 缺失、或怀疑依赖树不完整时；网络：是
pnpm install --frozen-lockfile
```

可以明确跳过的，附理由：

| 可跳过项 | 理由 |
| --- | --- |
| `support/regression-user-admin.sh` | 4 项 admin 密码权限回归；本次零后端与前端用户页改动 |
| `support/visual-contrast-probe.cjs` 与 `support/gallery-layout-probe.cjs` | 需要常驻 Chromium，测主题与画廊；本次未动主题与布局，页脚几何已在上游任务验证 |
| `bash support/apk-versions.sh` | 只在 Docker 构建报 apk 版本不存在时用，不是发布前常规步骤 |
| `pnpm install` | 锁文件未变且 node_modules 完好时可省；CI 会跑，本地为省时间可略 |

CI 会跑的正是 install、build、audit、lint 四步，本地这四步等价于把 CI 提前跑一遍。CI 绿本身不代表镜像可用，见 5.3。

### 3.3 工作树与任务前置

`release-local.sh` 的守卫 1 要求工作树完全干净，**untracked 文件也算脏**。实测当前 `git status --porcelain` 只有任务目录未跟踪，因此发布前必须先把任务留痕提交掉。

任务侧前置，均已就绪，执行时复核即可：

| 前置 | 状态 | 证据 |
| --- | --- | --- |
| 任务目录有 `directive.md` 逐字记录用户原话 | 已就绪 | 内容为「确认授权，发版吧」加弹窗口径 |
| 任务处于 `in_progress` | 已就绪 | `task.json` 的 `status` 为 `in_progress` |
| PRD 已从模板填充为真实需求 | 已就绪 | `prd.md` 的 R1 至 R6 与验收标准 |
| 提交带 `[task:10-29-release-footer-0.10.7]` 锚点 | 提交时保证 | 全局提交闸门会拒绝缺锚点的提交 |
| 远端无 `v0.10.7` | 已就绪 | 见 2.3 |

### 3.4 CI 门禁核对

推送版本号提交后查 CI。CI 只跑分支推送与 PR，因此查的是 `master` 上那个提交：

```bash
# 方式一，需要 gh 已认证；网络：是
gh run list --branch master --limit 1 --json databaseId,headSha,status,conclusion,url

# 方式二，公开仓库接口；网络：是
curl -s 'https://api.github.com/repos/zhemed/picsur/actions/runs?branch=master&per_page=1' \
  | jq -r '.workflow_runs[0] | "\(.head_sha[0:8]) \(.status) \(.conclusion) \(.html_url)"'

# 方式三，浏览器打开
# https://github.com/zhemed/picsur/actions
```

期望：`head_sha` 等于版本号提交的 SHA，`conclusion` 为 `success`。CI 失败先按 `ci.yml` 注释判因：install 失败看锁文件与源，build 失败看类型错误，audit 失败区分真告警与 registry 连接错误，lint 失败按文件行修。

## 四、完整执行序列

以下 Step 0 到 Step 10 为建议顺序，每条命令可直接复制。标注含义：`网络` 需要外网，`长耗时` 一分钟以上，`授权` 已包含在本次发版授权内，但必须由执行成员操作。

### Step 0 发布前预检

```bash
cd /root/picsur
git status --porcelain                 # 期望为空，否则先提交，不要用 --allow-dirty 糊过去
git rev-parse --abbrev-ref HEAD        # 期望 master
git fetch origin --tags
git rev-parse HEAD
git ls-remote origin refs/heads/master # 两个 SHA 必须一致
git tag -l 'v0.10.7'                   # 期望为空
git ls-remote --tags origin 'refs/tags/v0.10.7*'  # 期望为空
docker info >/dev/null 2>&1 && echo 'docker OK'   # 授权
df -h /                                # 磁盘余量，镜像与构建缓存需要数 GB
```

ghcr 登录状态，脚本只在缺失时警告、推送时才失败，建议先显式确认并登录：

```bash
# 授权；token 从 stdin 进，不要写在命令行里
docker login ghcr.io -u zhemed --password-stdin
# 提示 Password: 时粘贴 PAT，回车
```

### Step 1 主机侧预检，全部必跑

```bash
cd /root/picsur
export PATH="/root/picsur/.run/node20/bin:$PATH"
node -v && pnpm -v          # v20.20.2 与 9.6.0
pnpm lint                   # 2.4 秒，0 error 9 warning 为基线
pnpm build                  # 长耗时，约 1.5 至 4 分钟
bash support/audit-prod.sh  # 网络，退出码 0
git diff --quiet -- pnpm-lock.yaml && echo 'lockfile OK'
```

### Step 2 升版本号

```bash
cd /root/picsur
for f in package.json backend/package.json frontend/package.json shared/package.json; do
  sed -i '0,/"version": "0\.10\.6"/s//"version": "0.10.7"/' "$f"
done
grep -n '"version": "0.10.7"' package.json backend/package.json frontend/package.json shared/package.json
git diff --stat    # 期望 4 files changed, 4 insertions(+), 4 deletions(-)
```

### Step 3 分两次提交并推送

PRD R6 要求发布提交与任务留痕分开。第一个提交是任务留痕：

```bash
cd /root/picsur
git add .trellis/tasks/10-29-release-footer-0.10.7
git commit -m "docs(task): record the 0.10.7 release plan and runbook" \
  -m "[task:10-29-release-footer-0.10.7]"
git push origin master   # 网络，授权
```

第二个提交是版本号：

```bash
cd /root/picsur
git add package.json backend/package.json frontend/package.json shared/package.json
git commit -m "chore(release): 0.10.7" \
  -m "Publish the footer source-line removal as a patch release. The only product change since 0.10.6 is the blank 53px footer placeholder." \
  -m "[task:10-29-release-footer-0.10.7]"
git push origin master   # 网络，授权
git rev-parse HEAD       # 记下来，发布 tag 必须指向它
```

若提交被全局闸门拒绝，检查两件事：锚点是否存在，`directive.md` 是否存在；不要用 `--no-verify` 绕过。

### Step 4 等 CI 绿

```bash
# 网络；替换 <sha> 为上一提交 SHA
gh run list --branch master --limit 1 --json headSha,status,conclusion,url
# 或浏览器 https://github.com/zhemed/picsur/actions
```

CI 未绿不要发布。CI 估计 3 至 6 分钟，超时上限 30 分钟。

### Step 5 可选但推荐：先 dry-run 构建并预验证

这一步不推送任何东西，只本地构建并用本地镜像跑一次隔离栈；通过后再真正发布，可避免把坏镜像推到 `:latest`。

```bash
cd /root/picsur
bash support/release-local.sh --dry-run   # 网络，长耗时；不推送、不打 tag
docker images 'ghcr.io/zhemed/picsur'     # 应看到 0.10.7、v0.10.7、0.10、latest、allinone
```

随后按第五节跑一遍隔离栈回归，但**跳过 5.1 的第 1 步 `docker pull`**，直接使用 dry-run 构建出的本地 `ghcr.io/zhemed/picsur:allinone`；其余命令不变。验证通过后进入 Step 6；`docker build` 会命中缓存，正式发布主要花在推送。

不做 Step 5 时，回归只能在发布之后做，失败处理见 7.5。

### Step 6 正式发布

```bash
cd /root/picsur
git status --porcelain    # 必须为空
bash support/release-local.sh   # 网络，长耗时，授权
```

期望输出要点：构建 `ghcr.io/zhemed/picsur:0.10.7`，构建 `:allinone`，依次 push 4 加 1 个标签，末尾创建并推送 `v0.10.7`，打印「完成」。若中途失败，先读失败段落再决定重跑，见 7.3 与 7.4。

### Step 7 发布物核对

```bash
cd /root/picsur
git rev-parse HEAD                                  # 发布提交
git ls-remote --tags origin 'refs/tags/v0.10.7*'    # 期望两条：tag 本体与 ^{} peel，均指向 HEAD
git ls-remote --tags origin refs/tags/v0.10.6       # 对照旧 tag 仍在
docker image inspect ghcr.io/zhemed/picsur:allinone --format '{{.Id}} {{index .RepoDigests 0}}'
```

`:0.10.7`、`:v0.10.7`、`:0.10`、`:latest`、`:allinone` 五个标签都要在 ghcr 可见。没有 gh CLI 的包列表命令时，用 `docker pull` 逐个验证最可靠：

```bash
# 网络；每个标签都应成功
for t in 0.10.7 v0.10.7 0.10 latest allinone; do
  docker pull "ghcr.io/zhemed/picsur:$t" >/dev/null && echo "OK $t" || echo "FAIL $t"
done
```

`:latest` 是常规镜像，单独拉下来不能直接跑起来，只作为发布物存在性证据；真正要起栈的是 `:allinone`。

### Step 8 发布后隔离栈回归

见第五节，命令完整可复制。

### Step 9 升级本机实例并验收

见第六节。

### Step 10 留痕与收口

```bash
# 把命令、退出码、回归 RESULT、实例 /api/info 与页面截图记录写进本任务 research 或 prd 核对项
# 然后走 Trellis finish 与 archive，写 journal
```

## 五、发布后验证

### 5.1 隔离栈精确命令

原则：不碰常驻实例，独立端口、独立数据目录、验完即拆。端口用 18080，容器名带 `picsur` 前缀以便回归脚本定位数据库，数据目录放 `/tmp`。

```bash
cd /root/picsur
VER=0.10.7
PORT=18080
NAME=picsur-verify-0107
DATA=/tmp/picsur-verify-0107-data

# 1 拉取发布镜像，网络
docker pull ghcr.io/zhemed/picsur:allinone

# 2 起隔离栈，授权
rm -rf "$DATA"
docker run -d --name "$NAME" --restart no \
  -p "127.0.0.1:${PORT}:8080" \
  -v "$DATA":/data \
  ghcr.io/zhemed/picsur:allinone

# 3 等就绪，最多约 2 分钟；all-in-one 首次要 initdb
for i in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/api/info")
  [ "$code" = "200" ] && break
  sleep 2
done
curl -s "http://127.0.0.1:${PORT}/api/info" | jq .

# 4 版本断言，期望 0.10.7 且 production 为 true
curl -s "http://127.0.0.1:${PORT}/api/info" | jq -r '.data.version, .data.production'

# 5 镜像内版本号断言，期望 0.10.7
docker exec "$NAME" node -p "require('/picsur/backend/package.json').version"

# 6 迁移断言，期望 12，不是旧文档写的 8
docker exec "$NAME" psql -U picsur -d picsur -tAc 'select count(*) from migrations;'

# 7 取管理员口令，来自容器内 /data/allinone.env
PW=$(docker exec "$NAME" sed -n 's/^PICSUR_ADMIN_PASSWORD=//p' /data/allinone.env | tr -d '\r')
echo "PW length: ${#PW}"

# 8 跑回归；显式指定 PICSUR_PSQL，把老行检查固定在这个隔离栈上
PICSUR_PSQL="docker exec $NAME psql -U picsur -d picsur" \
  bash support/regression-image-api.sh "http://127.0.0.1:${PORT}" "$PW"
```

期望最后一行：`RESULT: 38 passed, 0 failed`。推导见 5.2。若显式 `PICSUR_PSQL` 不设置且脚本找不到数据库访问，则只跑基础 34 项，输出 `RESULT: 34 passed, 0 failed`；两种情况都要求 failed 为 0。

页脚改动的镜像内断言，二选一或都做：

```bash
# 方案一 主 bundle 里不应再有页脚文案 key，网络否
BUNDLE=$(curl -s "http://127.0.0.1:${PORT}/" | grep -oE 'main[^"]*\.js' | head -1)
echo "bundle: $BUNDLE"
curl -s "http://127.0.0.1:${PORT}/${BUNDLE}" | grep -c 'madeWith'   # 期望 0

# 方案二 浏览器 DOM，授权，需要常驻浏览器
bw open "http://127.0.0.1:${PORT}/?nocache=$(date +%s)" --wait=3000
bw eval "document.querySelector('app-footer').textContent.trim()"   # 期望空字符串
bw eval "Math.round(document.querySelector('app-footer').getBoundingClientRect().height)"  # 期望 53
```

收尾，必须执行，避免遗留实例占端口：

```bash
docker rm -f "$NAME" 2>/dev/null
rm -rf "$DATA"
docker ps -a --format '{{.Names}}' | grep -c 'picsur-verify'   # 期望 0
```

历史教训：曾经遗留的 8099 端口实例导致一次回归首跑 4 项假失败，见 journal Session 20。清理动作不能省。

### 5.2 34 项清单位置与数量口径

- 脚本：`support/regression-image-api.sh`，文件头写明「冒烟 5 步 + 7 格式 + 删除语义 + 像素上限」。
- 清单在脚本体内按小节分布，`ok` 与 `bad` 计数合计为结果行：
  - 第 1 节 service info，1 项；
  - 第 2 节 upload，1 项；
  - 第 3 节 retrieve 与缓存头，2 项；
  - 第 4 节 7 种格式转码，7 项；
  - 第 5 节 SPA 深链，1 项；
  - 第 6 节删除语义 11 项；
  - 第 7 节像素上限 3 项；
  - 第 8 节 8 种源格式上传，8 项；
  - 合计基础 **34 项**，与文档口径一致；
  - 第 9 节老行尺寸回归依赖数据库访问，命中时另加 4 项，因此脚本当前版本结果为 38。
- 文档位置：`docs/MAINTAINING.md` §5 第 1 条、`.trellis/spec/picsur-backend/backend/build-and-deploy.md` §9 与 §6.1，两处都写 34，属于基础口径，未提有数据库时的 4 项。
- 夹具：默认目录 `/tmp/bugs-fx`，缺料时脚本自动调 `support/make-image-fixtures.cjs`；本机 sharp 编不出 JXL 与 JP2 时会改用容器生成，容器镜像默认 `ghcr.io/zhemed/picsur:allinone`，这一路径需要 network 与 docker。离线环境可设 `PICSUR_FIXTURE_NO_PULL=1`。
- 限流：实例全局每 IP 每分钟 60 请求；脚本内已包装 429 重试，最多多等约 72 秒，因此**不要**短时间内连跑两遍，第二遍会被判为限流而非回归。

### 5.3 CI 绿与镜像可用的区别

| 维度 | CI | 发布镜像 |
| --- | --- | --- |
| 谁产出 | GitHub Actions，`ci.yml` | 本地 `release-local.sh` 的 docker build |
| 内容 | 装依赖、三包构建、依赖审计、lint | Node 20 运行树加自编译 libvips、sharp 源码构建、all-in-one 的 Postgres 17 |
| 能否发现 Dockerfile 问题 | 不能，CI 不跑 docker | 只有实际拉取并起栈能发现 |
| 能否发现运行时问题 | 不能 | 起栈跑回归才能发现 |
| tag 推送是否触发 | 不触发，`ci.yml` 只监听 branches | 不适用 |

因此验收顺序固定为：CI 绿只作为代码质量门禁，镜像可用性必须以「拉取发布标签并起隔离栈跑回归」为准。spec §9 的原话就是「CI 绿 ≠ 镜像可用」。

### 5.4 回归失败的处理

| 现象 | 判定 | 处理 |
| --- | --- | --- |
| 端口已被占用，实例起不来 | 环境问题 | 换端口或清理遗留容器后重跑 |
| 输出里出现 429 相关告警后大量 FAIL | 限流 | 等 60 秒窗口重置后重跑一次 |
| 夹具生成失败，exit 2 | 环境问题 | 装 docker、或传现成夹具目录、或设 `PICSUR_FIXTURE_NO_PULL=1` |
| 固定 1 至 2 项 FAIL 且可复现 | 真回归 | **停止，不升级实例**；保留 `docker logs`；按失败项定位 |
| 登录失败 FATAL | 口令或地址错 | 重新从容器 `/data/allinone.env` 取口令，确认端口映射 |
| 老行 4 项 FAIL 且样式为 list 500 | 真回归 | 同上，属后端响应校验问题，不是本次改动引入 |

真回归时的发布处置：镜像与 tag 已经推出去了，此时不要在已升级实例的情况下重推同版本号。建议修代码后发布 `0.10.8`；`0.10.7` 保持为已知坏版本并在发布记录里标注。若确认在任何人升级前就发现，可选删 ghcr 包版本与 git tag 后重发同版本，但这属于高风险动作，需用户明确授权，默认不做。

### 5.5 页面级验收

回归通过后做页面验收，先验收隔离栈，再验收常驻实例。常驻实例的命令在第六节。

隔离栈页面验收：

```bash
bw open "http://127.0.0.1:${PORT}/" --wait=3000
bw eval "document.querySelector('app-footer').textContent.trim().length"   # 期望 0
bw eval "Math.round(document.querySelector('app-footer').getBoundingClientRect().height)"  # 期望 53
bw shot /root/picsur/.trellis/tasks/10-29-release-footer-0.10.7/research/verify-footer-blank.png
```

验收口径来自 spec：页脚来源行已移除，`app-footer` 总占位 53px，主区域不位移。窄视口曾有换行差异，桌面 1600 宽与常见手机宽度不受影响。

## 六、本机实例部署：127.0.0.1:8080

### 6.1 现状

只读实测与既有调研记录：

| 项 | 值 | 来源 |
| --- | --- | --- |
| `/api/info` | production true，demo false，version 0.10.6 | 本次 `curl`，2026-10-29T12:41:10Z |
| 镜像 | `ghcr.io/zhemed/picsur:allinone` | 任务 10-25 的 docker inspect 记录 |
| 端口 | `0.0.0.0:8080`，宿主 127.0.0.1 可达 | 同上 |
| 重启策略 | always | 同上 |
| 数据 | `/data`，约 46.3M，含 Postgres 与 allinone.env | 同上 |
| 部署形态 | 单容器 all-in-one，仓库唯一文档化形态 | README 与 MAINTAINING |
| 容器名 | 历史记为 `picsur`，执行前用 docker ps 复核 | 调研记录，未在本轮复核 |

### 6.2 如何确定当前版本

首选只读接口，不需要 docker：

```bash
curl -s http://127.0.0.1:8080/api/info | jq -r '.data.version, .data.production'
# 当前应为 0.10.6 与 true
```

docker 侧复核，授权：

```bash
docker ps --filter publish=8080 --format '{{.Names}} {{.Image}} {{.Status}}'
docker inspect picsur --format '{{.Config.Image}} {{.Image}} {{.State.Status}}'
```

### 6.3 升级路径 A：面板一键升级，推荐

条件：容器挂了 `/var/run/docker.sock` 且自升级未被关闭。先查：

```bash
PW=$(docker exec picsur sed -n 's/^PICSUR_ADMIN_PASSWORD=//p' /data/allinone.env | tr -d '\r')
TOKEN=$(curl -s -X POST http://127.0.0.1:8080/api/user/login \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"admin\",\"password\":\"$PW\"}" | jq -r '.data.jwt_token')
echo "token length: ${#TOKEN}"

curl -s -X POST 'http://127.0.0.1:8080/api/system/update/check?force=true' \
  -H "Authorization: Bearer $TOKEN" --max-time 20 \
  | jq '{current:.data.current, latest:.data.latest, updateAvailable:.data.updateAvailable, selfUpdateEnabled:.data.selfUpdateEnabled, command:.data.command, message:.data.message}'
```

判定：`current` 为 0.10.6，`latest` 为 0.10.7，`updateAvailable` 为 true，`selfUpdateEnabled` 为 true 且 `command` 指向 `ghcr.io/zhemed/picsur:allinone`。若 `selfUpdateEnabled` 为 false，改走 6.4 手动路径，不要硬点按钮。

面板操作，授权：

```bash
bw open "http://127.0.0.1:8080/settings/about?nocache=$(date +%s)" --wait=3000
bw text | head -40          # 确认「当前版本 0.10.6」「最新版本 0.10.7」
bw click "立即升级" --exact # 按钮文案以页面实际为准，可先 bw els 看可交互元素
```

等待与验收：页面会显示拉取与重启进度，正常 50 至 110 秒；期间接口会短暂不可用，页面自动重连。逐条验收：

```bash
# 1 版本
for i in $(seq 1 90); do
  V=$(curl -s --max-time 3 http://127.0.0.1:8080/api/info | jq -r '.data.version // empty')
  [ "$V" = "0.10.7" ] && break
  sleep 2
done
echo "instance version: $V"   # 期望 0.10.7

# 2 更新检测与升级状态，重新取 token 后执行
curl -s -X POST 'http://127.0.0.1:8080/api/system/update/check?force=true' \
  -H "Authorization: Bearer $TOKEN" --max-time 20 \
  | jq '{current:.data.current, latest:.data.latest, updateAvailable:.data.updateAvailable, lastUpdate:.data.lastUpdate}'
# 期望 current 0.10.7，latest 0.10.7，updateAvailable false，lastUpdate 为成功态

# 3 页面页脚空白与 53px
bw open "http://127.0.0.1:8080/?nocache=$(date +%s)" --wait=3000
bw eval "document.querySelector('app-footer').textContent.trim().length"   # 0
bw eval "Math.round(document.querySelector('app-footer').getBoundingClientRect().height)"  # 53

# 4 关于页显示 0.10.7
bw open "http://127.0.0.1:8080/settings/about?nocache=$(date +%s)" --wait=3000
bw text | grep -n '0\.10\.7' | head -5
```

另有数据抽查，升级前后图片数量应一致：

```bash
# 升级前先记录总数，升级后用同一命令对照
curl -s -X POST http://127.0.0.1:8080/api/image/list \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"count":10,"page":0}' | jq '.data.total, (.data.results|length)'
```

### 6.4 升级路径 B：手动重建，面板不可用时的兜底

先记录可回滚信息，**必须**先执行：

```bash
OLD_IMAGE=$(docker inspect picsur --format '{{.Image}}')
DATA_SRC=$(docker inspect picsur --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}')
echo "OLD_IMAGE=$OLD_IMAGE"
echo "DATA_SRC=$DATA_SRC"      # 记进任务留痕，回滚要用
docker inspect picsur --format '{{json .HostConfig.PortBindings}}'
```

步骤，全部授权：

```bash
docker pull ghcr.io/zhemed/picsur:allinone   # 网络
docker stop picsur
docker rename picsur picsur-prev-0106
docker run -d --name picsur --restart always \
  -p 8080:8080 \
  -v "$DATA_SRC":/data \
  -v /var/run/docker.sock:/var/run/docker.sock \
  ghcr.io/zhemed/picsur:allinone
```

`-v /var/run/docker.sock` 是否加回，取决于升级前 `HostConfig` 是否挂了 socket；面板升级能力依赖它。然后按 6.3 的验收四条执行。成功后删旧容器，旧镜像保留在本地存储里直到被 prune：

```bash
docker rm picsur-prev-0106
docker images --digests ghcr.io/zhemed/picsur
```

### 6.5 授权边界

- 发布本身：用户原话「确认授权，发版吧」，PRD R1 至 R4 列明版本号、推送、发布、回归。
- 升级本机实例：`directive.md` 记录的弹窗口径为「发布、回归并升级本机实例」，PRD R5 亦列明，因此**不需要二次弹窗**；但按团队规则，部署动作由 Lead 编排、执行成员在有 docker 权限的上下文里做，且顺序必须是先回归通过再升级。
- 若执行中授权状态发生变化、或需要在用户实例上做超出重建与升级的动作，例如删数据目录、改端口、改 `.env`，必须停下来请示，不得自行扩大范围。

### 6.6 回滚

本版无数据库迁移，回滚只换镜像，数据不动。

路径一，面板自动回滚：升级失败时面板会显示「升级失败，已回滚到 0.10.6」并给出原因，容器与数据保持原样，直接重试或走手动路径。

路径二，用升级前记录的旧镜像 ID 重建，授权：

```bash
docker rm -f picsur
docker run -d --name picsur --restart always \
  -p 8080:8080 \
  -v "$DATA_SRC":/data \
  -v /var/run/docker.sock:/var/run/docker.sock \
  "$OLD_IMAGE"
curl -s http://127.0.0.1:8080/api/info | jq -r '.data.version'   # 期望 0.10.6
```

前提是旧镜像还在本地。`docker pull` 只移动标签，不会删除旧镜像，但 `docker image prune -a` 会；升级后到确认稳定前不要跑 prune。

路径三，旧镜像已被清理时，用仍留在 ghcr 的 0.10.6 常规镜像重建 all-in-one，授权：

```bash
cd /root/picsur
git fetch origin --tags
docker pull ghcr.io/zhemed/picsur:v0.10.6   # 网络，常规镜像 0.10.6 仍在
docker build -f Dockerfile.allinone \
  --build-arg PICSUR_BASE_IMAGE=ghcr.io/zhemed/picsur:v0.10.6 \
  -t picsur-allinone:rollback-0.10.6 .
# 然后用 picsur-allinone:rollback-0.10.6 按路径二的 docker run 起回 0.10.6
```

该路径成立的前提已核实：`git diff v0.10.6..HEAD -- Dockerfile Dockerfile.allinone support .dockerignore .github` 为空，说明 all-in-one 的构建文件与入口脚本自 0.10.6 起未变。

数据风险：`v0.10.6..HEAD` 的 `backend` 与 `shared` 零改动，`MigrationList` 仍是 12 条，没有新增迁移，所以 0.10.7 与 0.10.6 对同一数据库双向兼容；回滚不丢数据、不需要降级脚本。备份仍建议做，命令：

```bash
tar czf /root/picsur-backups/picsur-data-$(date +%F-%H%M).tgz -C "$(dirname "$DATA_SRC")" "$(basename "$DATA_SRC")"
```

## 七、风险与回滚

### 7.1 风险总表

| 风险 | 触发点 | 检测 | 处置 |
| --- | --- | --- | --- |
| tag 误推到错误提交 | 先打 tag 后 amend 或 reset | `git rev-parse HEAD` 与 `v0.10.7^{commit}` 不一致 | 删本地与远端 tag 后重打，见 7.2 |
| tag 漏推 | 脚本推送镜像后中断 | `git ls-remote --tags origin 'refs/tags/v0.10.7*'` 为空 | 手工 `git tag -a` 与 `git push origin v0.10.7` |
| 版本号不单调 | 手误写成 0.10.5 | 脚本守卫 3 拒绝 | 改回 0.10.7 后重跑 |
| 镜像构建失败 | apk 版本失配、gyp exec 位、网络拉基础镜像 | 构建日志 | 按 7.3 处置 |
| 推送中途失败 | 网络中断 | 部分标签 ok 部分 fail | 重跑脚本补齐，见 7.4 |
| 回归失败 | 真回归或环境问题 | RESULT 行有 failed | 停止升级，按 5.4 判定 |
| 实例升级失败 | 拉镜像失败、新镜像起不来 | 面板报回滚或接口长时间不可用 | 面板自动回滚，或按 6.6 手动回滚 |
| 已升级后发现坏版本 | 验收不充分 | 页面或接口异常 | 回滚到 0.10.6 并发布 0.10.8，不要重推同版本号 |

### 7.2 tag 误推的处理

远端 tag 可删可重打，`master` 分支保护只禁强推与删除分支，不影响 tag：

```bash
cd /root/picsur
git tag -d v0.10.7
git push origin :refs/tags/v0.10.7   # 网络，授权，删除远端 tag
git tag -a v0.10.7 -m "release 0.10.7" <正确的发布提交 SHA>
git push origin v0.10.7              # 网络，授权
git ls-remote --tags origin 'refs/tags/v0.10.7*'
```

注意：已经推出的镜像不需要也不应该重推；tag 只影响版本检测与可追溯性。若 tag 被面板读取过，1 小时内缓存内可能显示旧结论，点「检查更新」会强制刷新，见 spec §14。

### 7.3 镜像构建失败的处理

构建发生在推送之前，失败不会污染 ghcr。常见原因与对策：

| 现象 | 原因 | 对策 |
| --- | --- | --- |
| apk 报 unable to select packages | Alpine 发了新修订号，Dockerfile 里 apk 版本锁死 | `bash support/apk-versions.sh` 取新版本号并同步 Dockerfile 后重试 |
| `make Error 126` 或 gyp Permission denied | pnpm 自带 node-gyp 入口无 exec 位 | Dockerfile 已有 chmod 补位，属已知偶发；原样重试一次，不要删那几行 |
| 拉取 node:20 或 alpine 基础镜像失败 | 网络 | 重试；镜像有 digest 锁，不要改 digest |
| libvips 源码校验失败 | 上游包变动或网络 | 重试；持续失败则停止并报告 |
| 磁盘不足 | docker 缓存 | `docker system df` 查看，必要时清构建缓存后重试 |

### 7.4 推送中途失败的处理

脚本先推 `:0.10.7`、`:v0.10.7`、`:0.10`、`:latest`，最后 `:allinone`。断网可能造成部分成功，处理原则：

1. 不要升级实例，因为 `:allinone` 可能仍是旧版本；
2. 修网络后直接重跑 `bash support/release-local.sh`，构建命中缓存，已推标签重推幂等；
3. 重跑后逐个 `docker pull` 验证五个标签，见 Step 7；
4. 全部到位再进入回归与升级。

### 7.5 回归失败的处理

见 5.4 表格。补充三条原则：

- 回归失败时**常驻实例保持 0.10.6**，不要「先升级看看」；
- 保留隔离栈的 `docker logs` 与失败项输出，写进任务留痕；
- 真回归按 0.10.8 处理，不重推已发布的 0.10.7。

### 7.6 实例升级失败的处理

面板路径有自动回滚，spec §13 记录了 helper 与 rescue 三层兜底，失败时面板显示原因与回滚后的版本。手工恢复的极端情况：

```bash
docker ps -a | grep -E 'picsur-(prev|new|update|rescue)-'   # 先看清现场
docker rename picsur-prev-0106 picsur    # 若旧容器还在且已改名
docker start picsur
```

本版无迁移，数据不受影响。恢复后按 6.3 重新验收。

### 7.7 历史发布教训汇总

从 journal 与归档任务里提取，全部与本仓真实踩坑对应：

| 版本或轮次 | 教训 | 对本次的含义 |
| --- | --- | --- |
| 0.7.2 与 0.7.3 | 本地发布早期漏推 `v` 前缀 tag，面板升级报 404 并安全失败 | 现在脚本自动打推 tag，但仍要核对远端 tag |
| 0.7.4 | 构建时没打 `:v` 标签却推送，推送静默失败 | 发布后逐个 `docker pull` 验证标签存在性 |
| 0.7.6 | 版本检测读 GitHub tag，本地发布后漏推 tag 导致面板显示旧版本 | tag 必须真的在远端，而不是只在本地 |
| 0.7.7 | 提交被闸门拒绝后仍然发布了镜像，镜像与 tag 不对应；随后加了脏树与未推送守卫 | 本次不绕过守卫，不用 `--allow-dirty` |
| 0.7.9 | 遗留 8099 实例占端口，34 项回归首跑 4 项假失败 | 隔离栈验前先确认端口空闲，验后必清 |
| 0.10.3 | 探针新增浏览器全局未登记到 eslint 配置，CI 连红两次 | 本次不改探针，lint 基线已实测为 0 error |
| 0.10.4 | 老行尺寸回归加入后计数从 34 变为 38 口径 | 本次回归结果按 38 或 34 双口径记录 |
| 全部 | 浏览器缓存会让人误判页脚或版本没生效 | 页面验收用带时间戳的 URL 强制刷新 |

### 7.8 本次改动的风险画像

| 维度 | 结论 |
| --- | --- |
| 改动范围 | `v0.10.6..HEAD` 业务改动 4 个前端文件，8 增 36 删，全部在页脚模板、页脚样式与 en/zh 词典 |
| 后端与 shared | 零改动 |
| 数据库 | 无新迁移，`MigrationList` 仍 12 条 |
| 镜像构建文件 | `Dockerfile`、`Dockerfile.allinone`、`support/allinone-entrypoint.sh` 自 0.10.6 未变 |
| 回滚复杂度 | 低，换回旧镜像即可，数据双向兼容 |
| 主要风险 | 发布链路操作风险高于代码风险，集中在 tag、ghcr 标签完整性与实例重建 |

## 八、证据与残留

### 8.1 本次只读取证记录

| 项 | 命令或来源 | 结果 |
| --- | --- | --- |
| 当前 HEAD 与远端 | `git rev-parse HEAD` 与 `git ls-remote origin HEAD` | 均是 `846f656` |
| 远端 tag 最高 | `git ls-remote --tags --refs origin` | `v0.10.6` |
| v0.10.7 占用 | `git tag -l` 与 `git ls-remote` | 本地远端都没有 |
| v0.10.6 指向 | `git rev-parse 'v0.10.6^{commit}'` | `fe4f837` |
| 当前实例版本 | `curl /api/info` | `0.10.6`，production true |
| Node 20 与 pnpm | `.run/node20/bin/node -v` 与 PATH 后 `pnpm -v` | `v20.20.2` 与 `9.6.0` |
| lint 基线 | `time pnpm lint` | 退出码 0，0 error 9 warning，2.4 秒 |
| 迁移条数 | `backend/src/database/migrations/index.ts` | 12 条 |
| 业务差异 | `git diff --stat v0.10.6..HEAD -- frontend backend shared` | 4 文件，8 增 36 删，全前端 |
| 基础设施差异 | `git diff --stat v0.10.6..HEAD -- Dockerfile Dockerfile.allinone support .dockerignore .github` | 空 |
| release-image.yml 删除 | `git log --diff-filter=D -- .github/workflows/release-image.yml` | `54fe809` |
| support 脚本删除 | `git log --diff-filter=D -- support/setversion.sh` | `db04c3b` |
| 发布脚本守卫 | 读 `support/release-local.sh` 全文 | 四道守卫，见 1.3 |

### 8.2 残留：只读范围内无法确认的项

| 项 | 原因 | 执行时如何补 |
| --- | --- | --- |
| ghcr 是否已登录 | 读宿主 docker 配置属凭据路径，本轮不读 | Step 0 的 `docker login` 显式确认 |
| 当前 CI 是否绿 | 本轮网络动作被策略闸门拦截 | Step 4 用 gh 或网页查 |
| 容器精确名、数据宿主路径、socket 挂载 | 禁止 docker 操作 | 6.4 的 docker inspect 先记录再动手 |
| ghcr 现有标签清单 | 网络动作被拦截 | Step 7 逐个 `docker pull` 验证 |
| 常驻浏览器是否已登录管理员 | 未探测 | 6.3 用 API 登录或浏览器登录后操作 |
| 各步骤实测耗时中标注为估计的部分 | 本轮不做写操作与长任务 | 执行时记录真实耗时回填本文档 |

### 8.3 文档与现实的偏差，建议发版后单独修正

以下偏差点不影响本次发布，但会误导下一位执行者，建议由 Lead 另起 spec 与文档更新，不要塞进本次发版提交：

| 文档 | 偏差 | 建议 |
| --- | --- | --- |
| `.trellis/spec/picsur-backend/backend/build-and-deploy.md` 第 163 行与第 343 行 | 仍写「release-image.yml 自动构建发布」「tag 推送即构建」 | 改为本地 `release-local.sh` 唯一路径 |
| 同文件第 446 行与第 12 节 | 仍写 install.sh 与 docker-compose 两条部署路径 | 二者已删除，只余 all-in-one |
| 同文件第 136 行 | 写「当前 0.6.0」 | 改为现行版本或删除具体数字 |
| 同文件第 152 行 | 迁移数写 8 | 实际 12 条 |
| `docs/MAINTAINING.md` 第 34 行 | 写固定版本用 `:vX.Y.Z` | all-in-one 没有版本后缀标签，应说明版本固定需基于常规镜像重建 all-in-one |
| `docs/MAINTAINING.md` 第 83 行 | 写 34 passed | 有数据库访问时为 38，建议写基础 34 加老行 4 |
| 根 `package.json` 的 `setversion` 与 `purge-all` | 指向已删除脚本 | 删除这两个 script 条目 |
| 本任务 `prd.md` 第 27 行 | 写「远端 tag 只到 v0.9.0 附近」 | 实际到 `v0.10.6`，建议更正 |

## 九、待 Lead 决策的事项

1. 是否执行 Step 5 的先 dry-run 预验证。推荐执行：多花一次热缓存构建时间，换取「坏镜像不进 `:latest`」。
2. 回归结果口径按 38 还是 34 记录。推荐写「基础 34 全过，含老行 4 项共 38 passed」。
3. 文档偏差是否本轮一并修。推荐发版与实例升级完成、任务归档后另起一轮，避免把非发版改动混入发布提交。
