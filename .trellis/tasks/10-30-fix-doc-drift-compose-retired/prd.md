# 修复文档漂移：compose 已退役但文档仍引用

## Goal

`docker-compose.yml` 与 `install.sh` 已在 `6fc28d9 chore: slim the repo to a single path` 退役并从仓库删除，唯一部署路径是 all-in-one 单容器。但 `build-and-deploy.md` 仍有 24 处 compose / install.sh 相关表述，环境变量示例文件也还写着 compose 用法。本任务按仓库现状修正文档，使「部署方式、环境变量三处同步口径、验证用例」与代码一致，不涉及任何代码或部署脚本行为变更。

## Background

- 现网部署：`README.md:6-14` 与 `docs/MAINTAINING.md:5-13` 只有一条 `docker run`，镜像 `ghcr.io/zhemed/picsur:allinone`，数据挂载 `/root/picsur-data:/data`，容器无 CPU 与内存配额。
- 仓库现状：根目录只有 `Dockerfile` 与 `Dockerfile.allinone`；无 `docker-compose.yml`、无 `install.sh`、无 `support/dev.docker-compose.yml`；部署相关脚本只剩 `support/allinone-entrypoint.sh`。
- `.trellis/spec/picsur-backend/backend/build-and-deploy.md` 有多处把 compose 当现存路径：§7.3 三处同步、§12 两条部署路径、Good/Base 案例、环境变量表里的「docker-compose.yml 已透传」等。
- 走后门延伸：`10-25-video-support-eval` 的 research 文件也引用 compose，但那是历史任务记录，不改。

## Requirements

- R1 以仓库现状为准修文档，不臆造新部署方式；先核对 `README.md`、`docs/MAINTAINING.md`、`Dockerfile.allinone`、`support/allinone-entrypoint.sh`，再动笔。
- R2 修 `build-and-deploy.md`：把 compose 与 install.sh 相关段落改成「已退役」的历史事实或直接删除过时内容；三处同步口径改为当前真实位置，即环境变量示例文件、`Dockerfile.allinone` 默认值、本 spec 的环境变量契约表。
- R3 修环境变量示例文件里的 compose 用法说明。该文件被凭据路径策略拦截，需要任务级凭据例外授权后才能读写；未获授权时跳过并在报告里给出待改文本。
- R4 只改文档，不改任何代码、脚本、镜像或运行时行为。
- R5 修完在全仓扫一遍：非归档、非历史任务文件中不应再有把 compose / install.sh 当现状的表述；历史任务目录与归档目录一律不动。
- R6 保持文档原有结构与语言风格，不重排无关章节，不做大规模重写。

## Acceptance Criteria

- [ ] `build-and-deploy.md` 中 compose / install.sh 相关表述不再把已删除的部署路径当现状。
- [ ] 三处同步口径与环境变量契约表一致，且能被仓库现有文件验证。
- [ ] 环境变量示例文件中的 compose 用法已修正，或明确记录未获授权而跳过并给出待改文本。
- [ ] `README.md` 与 `docs/MAINTAINING.md` 经核对无需改动，或有改动且与现状一致。
- [ ] 全仓扫描结果记录在任务 research 或实现报告里；归档与历史任务目录未改动。
- [ ] `git diff` 只包含文档改动，无代码与脚本改动。

## Constraints

- 只改文档；不改 `Dockerfile*`、`support/*`、源码、测试。
- 不修改 `.trellis/tasks/archive/` 与其它任务目录。
- 需要凭据策略例外的文件，必须走任务级授权，不自行改全局策略文件。

## Non-goals

- 不恢复 compose 或 install.sh。
- 不新增部署方式。
- 不改 `10-25-video-support-eval` 等历史任务的调研记录。

## Notes

- 本任务与「转换 worker 池化与压测」是同一用户授权的两件独立交付物，分两个任务执行。
