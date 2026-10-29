# Phase A 执行记录：预检与主机侧门禁（0.10.7 发版）

- 执行人：release-executor，Trellis implement 子代理
- 时间：2026-10-29 12:52 UTC 起
- 范围：`release-runbook.md` 第四节 Step 0 至 Step 4
- 结论：**停在 Step 1 审计门禁**。Step 0 预检全绿；Node 20 + pnpm 9.6.0 下 lint 与 build 通过；`bash support/audit-prod.sh` 退出码 1，后端/共享 15 条告警。**未改版本号、未提交、未推送、未打 tag**，等待决定。

## 1. Step 0 发布前预检

| 检查 | 命令 | 结果 | 判定 |
| --- | --- | --- | --- |
| 工作树 | `git status --porcelain` | 仅 `?? .trellis/tasks/10-29-release-footer-0.10.7/`，无已跟踪文件改动 | 通过，符合 runbook 3.3 预期 |
| 当前分支 | `git rev-parse --abbrev-ref HEAD` | `master` | 通过 |
| 本地 HEAD | `git rev-parse HEAD` | `846f656572b98d63c0824426e8f08d837f696226` | 记录 |
| 远端 master | `git fetch origin --tags` 后 `git ls-remote origin refs/heads/master` | `846f6565…`，与本地一致，`git rev-list --left-right --count origin/master...HEAD` 为 `0 0` | 通过 |
| v0.10.7 本地 | `git tag -l 'v0.10.7'` | 空 | 通过 |
| v0.10.7 远端 | `git ls-remote --tags origin 'refs/tags/v0.10.7*'` | 空 | 通过 |
| docker | `docker info` | 成功 | 通过 |
| 磁盘 | `df -h /` | 251G 总，154G 可用，使用 36% | 通过 |
| gh 认证 | `gh auth status` | 已登录 zhemed，含 `repo` 与 `workflow` scope | 通过，可用于轮询 CI |

## 2. Step 1 主机侧检查

固定前缀 `export PATH="/root/picsur/.run/node20/bin:$PATH"`。

| 命令 | 退出码 | 耗时 | 结果 |
| --- | --- | --- | --- |
| `node -v` | 0 | 瞬时 | `v20.20.2` |
| `pnpm -v` | 0 | 瞬时 | `9.6.0` |
| `pnpm lint` | 0 | 2s | `0 errors, 9 warnings`，与基线一致 |
| `pnpm build` | 0 | 30s | 三包构建成功，仅 Sass 弃用与 bundle 预算警告 |
| `bash support/audit-prod.sh` | **1** | 3s | **后端/共享 15 条告警，阻断** |

`pnpm lint` 的 9 条 warning 全部是 `@typescript-eslint/no-unused-vars` 存量，与基线相同，无新增。

`pnpm build` 尾部警告：Sass `@import` 弃用 164 条、`infinite-select` 未被入口引用、bundle 初始体积 1.39 MB 超 1.00 MB 预算。均为存量，未失败。

## 3. 阻断证据：审计失败

`bash support/audit-prod.sh` 输出要点：

```text
▶ pnpm audit --prod（registry: https://registry.npmjs.org/）
  backend/shared 生产依赖闭包：478 个包
  命中总数：后端/共享 15 ｜ 浏览器侧 0
  ▸ ❌ 后端/共享（阻断）
❌ 后端/共享生产依赖有告警 —— 必须清零后再发版。
```

15 条命中明细，其中 `created` 取自 GitHub Advisory API：

| 包@当前版本 | 严重度 | 修复版本 | GHSA | 上游发布 |
| --- | --- | --- | --- | --- |
| `zod@3.25.76` | high | `>=4.6.6` | GHSA-mrhx-c7xc-m3w5 | 2026-10-01 |
| `body-parser@2.3.0` | high | `>=2.4.0` | GHSA-27r3-jxmh-p828 | 2026-10-23 |
| `undici@7.30.0` | high ×4 | `>=7.30.1` | GHSA-4w7w-5xrc-9h26 等 4 条 | 2026-10-27 |
| `undici@7.30.0` | moderate ×4 | `>=7.30.1` | GHSA-4qv8-2p9j-2685 等 4 条 | 2026-10-23 至 10-27 |
| `fast-uri@3.1.8` | moderate ×2 / low ×2 | `>=3.1.9` | GHSA-w74x-v6f9-j3xg 等 4 条 | 2026-10-23 |
| `fastify@5.12.5` | low | `>=5.12.6` | GHSA-389g-gv7q-r4x8 | 2026-10-22 |

判定依据：`AGENTS.md` 第 6 条要求后端/共享口径必须保持 0；`build-and-deploy.md` 6.1 规定审计日志出现「后端/共享 N 条」＝必须处理；runbook 2.5 与 3.2 规定 audit「退出码 0 才继续」。这 15 条是 2026-10-22 至 10-27 新发布的上游 advisory，与本次页脚改动无关，但对发布提交同样构成硬阻断。

### 3.1 CI 现状：master 已经是红的

`gh run list --branch master` 显示 2026-10-17 之后没有一次绿色：

| 时间 | 提交 | 结论 |
| --- | --- | --- |
| 2026-10-29T12:37 | `846f656` 当前 HEAD | failure |
| 2026-10-29T12:02 | `007b592` | failure |
| 2026-10-29T12:02 | `e589755` | cancelled |
| 2026-10-25T02:11 | `45e8b09` | failure |
| 2026-10-25T01:20 | `18c0875` | failure，日志为「后端/共享 10 条」审计失败 |
| 2026-10-17T11:11 | `86d7a79` | success |

最近一次 run `40874837318`（HEAD `846f656`）的步骤级结果：装依赖 success、三包构建 success、**依赖审计 failure**、Lint skipped。即：不是代码或锁文件坏了，唯一失败点就是新增 advisory。

结论：即使现在提交并推送版本号，CI 也不会变绿；Phase A 的「等 CI 绿」在当前 master 上不可达。

### 3.2 依赖来源与修复可行性

从 `pnpm-lock.yaml` 生产闭包追溯：

| 包 | 引入链 | 修复方式 |
| --- | --- | --- |
| `fastify@5.12.5` | backend 直接依赖 `^5.12.5` | 锁文件刷新即可到 `5.12.7`，兼容 |
| `fast-uri@3.1.8` | `fastify` → `fast-json-stringify@7.1.0` | 根 `pnpm.overrides` 已有 `fast-uri: ^3.1.8`，改为 `^3.1.9` 即可 |
| `body-parser@2.3.0` | `@nestjs/serve-static` 可选 peer → `express@5.3.0` | 锁文件刷新到 2.4.0，需验证 express 5.3.0 的范围 |
| `undici@7.30.0` | `@fastify/reply-from@12.7.1` | 新增 overrides `undici: ^7.30.1`，兼容 |
| `zod@3.25.76` | backend / shared / frontend 直接依赖 | **只能升到 4.6.7**，v3 分支无修复版本，属破坏性大版本迁移 |

前四项都是补丁级升级，但第五项 zod v3 → v4 会触及 backend/shared 里 DTO、实体与 `create-zod-dto.ts` 等大量用法，需要独立任务做迁移与全量回归。这一项与「本次发版只改四处版本号」的边界冲突，Phase A 无权处理。

## 4. 当前仓库状态

- 已跟踪文件：**零改动**，未改任何 `package.json`。
- 未跟踪：任务目录与本文档，符合 runbook 3.3 的预期形态，未提交。
- 未创建 `v0.10.7` tag，未推送任何提交，未触碰 `127.0.0.1:8080` 实例与 docker 镜像。
- 本任务的 team task `task-9` 保持 in_progress，等待决定。

## 5. 后续可选路径

- 路径 A，推荐：先新建「依赖安全修复」任务，清掉 15 条后再回到 Phase A。四个补丁升级加 zod v4 迁移、全量回归，风险与工作量独立可控。
- 路径 B：带风险例外发版。违反 AGENTS.md 第 6 条与 runbook 门禁，且 CI 必然保持红色，不建议。
- 路径 C：暂停 0.10.7 发版，先修依赖再重新排期。

## 附录：原始命令

```bash
cd /root/picsur
git status --porcelain
git rev-parse --abbrev-ref HEAD
git fetch origin --tags
git rev-parse HEAD && git rev-parse origin/master
git ls-remote origin refs/heads/master
git tag -l 'v0.10.7'
git ls-remote --tags origin 'refs/tags/v0.10.7*'
docker info >/dev/null 2>&1 && echo 'docker OK'
df -h /
export PATH="/root/picsur/.run/node20/bin:$PATH"
node -v && pnpm -v
pnpm lint
pnpm build
bash support/audit-prod.sh
pnpm audit --prod --json --registry https://registry.npmjs.org/
gh auth status
gh run list --branch master --limit 6 --json headSha,status,conclusion,url,createdAt,displayTitle
gh run view 40874837318 --json jobs --jq '.jobs[] | .name as $j | .steps[] | "\($j) | \(.name) | \(.conclusion)"'
gh run view 40874837318 --log-failed
```
