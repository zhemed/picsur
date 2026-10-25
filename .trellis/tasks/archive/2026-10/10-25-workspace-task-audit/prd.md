# 工作区残留任务盘点

## Goal

回答用户「工作区现在还有没有残留的任务」：以 `.trellis/tasks/` 与仓库实际状态为准，只读盘点未归档任务与相关仓库残留（worktree / 已合并分支 / journal 留痕缺口），给出可清理清单。是否清理由用户当轮决定。

## Requirements

- R1 以 `.trellis/tasks/` 下的 `task.json` / `prd.md` 为准逐个核对未归档任务的真实状态，不臆造、不以提交信息代替任务记录。
- R2 解释 SessionStart 显示 `no_task` 而 `get_context.py` 显示 2 个活跃任务并存的原因：两者数据源不同（前者是该会话指针，后者是任务目录扫描）。
- R3 盘点仓库级残留：git worktree（含未被 git 注册的 ...worktrees/hint 目录）、已并入 master 的本地与远端分支、journal 与 session index 的留痕缺口。
- R4 盘点阶段只读：不改任务状态、不删 worktree / 分支、不提交、不推送。
- R5 若用户批准清理：先把清理项写入本 PRD，再 `task.py start` 后执行；归档任务走 `task.py archive` 流程，提交按仓库约定带 `[task:...]` 锚点。
- R6（用户 2026-10-25 选择「都归档」）归档 2 个残留任务：`10-17-admin-username` 先补回 directive 与调查结论再归档（按其记录的「暂时归档」决定）；`00-bootstrap-guidelines` 在 PRD 追加 spec 缺口结案说明后归档。
- R7（用户授权）清理本地残留：删除 5 个已合并 worktree、未注册的 `.worktrees/hint` 目录、12 个已并入 master 的本地分支；**保留**未合并分支（backup/pre-squash、experiments/rust、pr-115/128/129/130）。
- R8（用户点名授权联网写操作）删除 origin 上 11 个已并入 master 的远端分支，并 prune 远端追踪引用。
- R9（用户选择）补记 3 轮缺失 journal（0.10.5 share-dropdown / 0.10.6 admin 密码 / 10-17 admin 用户名调查），并同步 session index.md。

## Acceptance Criteria

- [x] 残留任务清单（名称 / 状态 / 建期 / 成因 / 是否重复或过期）逐项有文件出处。
- [x] 仓库级残留清单附可清理性判断（分支是否已并入 master、worktree 是否干净、是否存在唯一副本）。
- [x] 用户已批准清理范围（2026-10-25 选择：两个任务都归档 + 本地 worktree/分支 + origin 已合并分支 + 补记 journal）。
- [x] 执行结果：2 个残留任务已归档并提交；5 个 worktree + `.worktrees/hint` + 12 个已合并本地分支已删；origin 11 个已合并分支已删并 prune；journal 补记 Session 33-35 并同步 index；本任务归档后 `task.py list` 无活跃任务。
- [x] 未改任何业务代码（本轮提交只触及 `.trellis/tasks/**` 与 `.trellis/workspace/**`）。

## Notes / 遗留

- 盘点结论：未归档任务 2 个 —— `00-bootstrap-guidelines`（长期 in_progress，spec 仅部分填充）、`10-17-admin-username`（模板 PRD、漏归档重复体）。
- spec 遗留：各 index 共 28 条 "To fill"（已填 3 条）；已随 bootstrap 任务归档留待日后另起 `spec-fill-*` 任务，不在本任务处理。
- 运行态小残留：`.trellis/.runtime/update-check-dsh_1b96b428-*.marker`（2026-10-16 旧会话 marker，在 gitignore 内、无副作用），本轮未动。
- 未合并本地分支按用户授权保留：`backup/pre-squash-2026-10-13`、`experiments/rust`、`pr-115/128/129/130`。

