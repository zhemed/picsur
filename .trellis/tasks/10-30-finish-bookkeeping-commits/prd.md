# 收尾提交：完成归档与 journal 的 git 提交并推送

## Goal

上一任务 `10-30-investigate-upload-concurrency` 已完成调查、复核、spec 更新与两个工作提交，并执行了归档与 journal 记录；但归档脚本与 `add_session.py` 的 auto-commit 都因提交信息缺任务锚点被全局钩子拒绝，工作区留下了未提交的归档移动与 journal 变更。本任务只做补提交与推送，不改任何产物内容。

## Requirements

- R1 只提交两批既有变更：归档移动、journal 记录；提交信息带 `[task:<slug>]` 锚点，风格与仓库历史一致。
- R2 不修改任何文件内容，不 amend、不 no-verify、不 reset/checkout/rebase/clean、不强制推送。
- R3 推送 origin master，遵循本仓库默认直接推送约定。
- R4 完成后工作区干净，提交顺序为：工作提交 2 条 → 归档提交 → journal 提交。

## Acceptance Criteria

- [ ] 归档移动提交存在且带锚点。
- [ ] journal 记录提交存在且带锚点。
- [ ] `git status --porcelain` 为空。
- [ ] `git push origin master` 成功，远端与本地一致。
- [ ] 没有修改任何被提交文件的内容，diff 与归档脚本、add_session 生成的结果一致。

## Notes

- 本任务由收尾卡住后的补提交需求产生，是流程性任务；不产生业务改动。
