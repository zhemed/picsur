# 工作区清理收尾：完成归档提交与 journal 落盘

## Goal

本轮「工作区残留任务盘点」已按用户授权完成清理；归档最后一个任务（`10-25-workspace-task-audit`）后 Trellis 闸门按规则拦截了所有工具调用（无 in_progress 任务 / 无会话绑定）。本任务仅用于恢复会话绑定，完成剩余流程收尾：journal 落盘、归档提交、推送 origin，然后立即自行归档。

## Requirements

- R1 恢复闸门放行（本任务创建即绑定会话），不新增业务改动。
- R2 完成本轮 Session 36 journal 记录（--no-commit 写入后统一提交）。
- R3 提交审计任务的归档目录与 journal/index，提交信息带 `[task:...]` 锚点（全局钩子要求）。
- R4 归档本任务并把归档目录一起提交，最终 `task.py list` 无活跃任务、工作区干净。
- R5 按仓库约定推送 origin；不得改动任何业务代码。

## Acceptance Criteria

- [ ] `.trellis/tasks/archive/2026-10/10-25-workspace-task-audit/` 与 journal/index 均已提交。
- [ ] 本任务归档目录已提交，`task.py list` 显示无活跃任务。
- [ ] `git status` 干净，`origin/master` 与本地一致。
