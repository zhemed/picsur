# 工作区残留任务清点与新任务建立

## Goal

按用户 2026-10-29 指令「建立新任务，查看一下我们的工作区是否还有残留任务」：建立本轮可追踪的 Trellis 任务，并只读盘点 `.trellis/tasks/`、运行态会话指针、git 工作区与 journal 留痕中的残留项，产出证据化清单与处置建议。是否执行任何清理动作由用户当轮决定，本轮不擅自清理。

## Requirements

- R1 建立新任务并落痕：任务目录 `.trellis/tasks/10-29-workspace-residual-audit/` 含 `prd.md`、`directive.md`（用户原文）、`implement.jsonl`、`check.jsonl`。
- R2 盘点未归档任务：对 `.trellis/tasks/` 下每个非 archive 任务核对 `task.json` 状态、PRD/design/implement/directive 是否齐备、research 内容、最近修改时间，判定是否残留及其成因。
- R3 盘点运行态残留：`.trellis/.runtime/sessions/` 中指向已结束会话或已归档任务的陈旧指针，逐个给出文件名与绑定任务。
- R4 盘点仓库级残留：git 工作区未提交与未跟踪文件、worktree、stash、本地与远端分支、与 origin 的偏移，判定是否由上轮任务遗留。
- R5 盘点留痕残留：`.trellis/workspace/zhemed/` 的 journal 与 index 是否存在未记录会话或数量不一致。
- R6 只读边界：不删除、不移动、不归档任何任务，不做 git 写操作；调研结论只写入本任务 `research/` 与 `prd.md`。
- R7 交付格式：清单每项含 任务或路径、证据（文件与状态字段、时间）、分类（可归档 / 需决定 / 进行中属其他会话 / 非残留）、建议动作；末尾列出待用户决定项。

## Acceptance Criteria

- [x] 任务目录齐备且 `directive.md` 逐字记录本轮用户原话。
- [x] 非归档任务逐个有状态与文件证据结论，无臆造、不以提交信息代替任务记录。
- [x] `.trellis/.runtime/sessions/` 陈旧指针已定位到具体文件名与绑定任务。
- [x] git 工作区、worktree、分支与 origin 偏移有命令证据。
- [x] journal/index 留痕缺口有具体会话编号与日期证据。
- [x] 待决定项以弹窗询问用户，未擅自清理。
- [x] 本轮不修改业务代码、配置与依赖。

## Notes

- 已知线索：`10-25-video-support-eval` 状态为 `planning`，PRD 末尾已有评估结论，尚未归档；其对应会话指针 `dsh_session-37b89e5b-5c14-4f0e-8d19-8814e6f67a78.json` 最后活跃 2026-10-25T01:57Z。
- 上一轮同类盘点见 `.trellis/tasks/archive/2026-10/10-25-workspace-task-audit/prd.md`，本轮判据与其对齐。
- 证据文件：`research/residual-inventory.md`。

## 审计结果（2026-10-29）

- 证据文件 `research/residual-inventory.md` 共 277 行（初版 237 行，收尾追加清理执行记录），由团队成员 `residual-auditor` 只读产出；Lead 已抽查：`task.py list` 活跃 2 个（含本轮）、`list-archive` 48 个、journal Session 1-36 连续共 840 行、`.trellis/workspace/` 检索「视频」与「video」零命中、`refs/original` 指向 3e3d73a、`.run` 193M、spec 28 处 To fill，与清单一致。
- 一句话结论：真正未收口的残留任务只有 `10-25-video-support-eval`，其评估已完成但 `status=planning` 未归档；另有 1 条陈旧会话指针、1 处 journal 漏记，即第 37 次视频评估会话未入 journal；git 工作区干净且与 origin/master 同步，无 worktree、无 stash。
- 非残留确认：6 条未合并分支属上一轮用户授权保留；`.run/node20` 为构建必需工具链，不按残留清理；两个 update-check marker 为无害陈迹；归档区 48 个任务结构正常。
- 归档区瑕疵 2 处：`00-bootstrap-guidelines` 缺 directive 与 jsonl，属初始化历史例外；`10-16-admin-username` 缺 task.json 与 jsonl，属重复体副本；另 `10-13-investigate-update-disabled` 的 name 字段与目录名不一致。
- 待用户决定项：视频评估任务处置方式、是否补记 journal 第 37 次会话、是否补录归档副本 task.json、是否清理 `.run` 非 node20 旧产物、是否清理 `refs/original` 隐藏引用、是否清理陈旧会话指针与 marker。

## 处置结果（2026-10-29，用户弹窗授权后执行）

### 用户决定

- Q1 残留任务 `10-25-video-support-eval`：用户选择「保留在 planning 等拍板」，本轮不归档、不改动其目录与记录。
- Q2 其它小残留：用户勾选全部五项，即补记 journal 第 37 次会话、补录归档副本 task.json、清理陈旧会话指针与 marker、清理 `refs/original` 隐藏引用、清理 `.run` 非 node20 旧产物。

### 执行结果

- 陈旧运行态：已删 `.trellis/.runtime/sessions/dsh_session-37b89e5b-5c14-4f0e-8d19-8814e6f67a78.json` 与两个 update-check marker；`.trellis/.runtime/` 仅剩当前会话指针 `dsh_session-60be8e28-...json`。
- 隐藏引用：`refs/original/refs/heads/master` 已删除，`git for-each-ref refs/original` 为空；`backup/pre-squash-2026-10-13` 仍为 3e3d73a，未丢数据。
- `.run/`：仅保留 `.run/node20` 构建工具链，`node --version` 为 v20.20.2；实际释放约 27 MiB。更正首轮清单体积笔误：`.run/node20` 为 167M，非 node20 旧产物为 27M，清单 4.9 与待决定项已修正。
- 归档副本：为 `.trellis/tasks/archive/2026-10/10-16-admin-username/` 补录 `task.json`，字段参照 10-17 完整记录，status=completed，notes 注明重复体与补录；`task.py list-archive` 仍为 48 个。
- journal：第 37 次会话已补记；本轮会话记录随后写入并随收尾提交，index 计数与日期同步。
- 边界：未改动业务代码与配置，未归档 `10-25-video-support-eval`。
- 独立验证：`research/verification.md` 由成员 `residual-verifier` 只读产出，结论为通过但需修正；必改项为 journal 补记缺失，已在本收尾执行；低风险文档修正项已落实。
