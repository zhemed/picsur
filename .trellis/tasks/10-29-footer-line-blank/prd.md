# 去掉页脚来源行并保留空白

## Goal

按用户 2026-10-29 指令「建立新任务，把这一行去掉，替换空白。ui界面可不能动」：移除页脚「由 ♥ 制作 zhemed · V0.10.6 · 源代码」这一行，让页脚区域显示为空白，同时保持页脚原有占位高度，其余 UI 完全不变。

## Requirements

- R1 页脚该行内容在界面上不可见，页脚区域呈现空白。
- R2 页脚保留原占位高度：上传框、页头图标、整体布局的位置与尺寸不因本次改动而变化。用户已确认口径为「清空文字，保留原高度」。
- R3 仅改前端页脚相关实现，不改后端、共享包、路由、主题与其它组件；不引入新依赖。
- R4 遵守前端规范：用户可见文案走 i18n；若模板不再引用 `app.footer.*` 词条，按「删功能要清干净」清理 `en.json` 与 `zh.json` 对应 key，并复核无孤儿 key；如保留词条须在 PRD 说明理由。
- R5 构建与校验按 Node 20 + pnpm 9.6.0 契约执行，至少覆盖前端 lint 或类型检查与一次前端构建。

## Acceptance Criteria

- [x] 页脚文字不可见，页脚呈现空白且高度与改动前一致。
- [x] 主界面元素位置不变：上传框、页头图标、底部版权行以外的布局无位移。
- [x] 改动只涉及页脚相关文件，以及必要时 `en.json` / `zh.json` 的无孤儿清理。
- [x] 前端 lint 或类型检查通过，前端构建通过，命令与结果有记录。
- [x] 无业务逻辑、后端、部署配置改动。

## Notes

- 用户附截图：页脚位于上传页底部居中，红框标注的那一行。
- 历史线索：2026-10-13 两轮曾整行删除页脚，任务 `10-13-remove-footer` 与 `10-13-restore-footer`，用户随后要求还原；本轮口径不同，只清空文字并保留 53px 占位。
- 调研结论见 `research/footer-research.md`，验证报告见 `research/verification.md`。

## 实现与验证结果（2026-10-29）

- 实现改动 4 个业务文件，`+8 / -36`：
  - `frontend/src/app/components/footer/footer.component.html`：24 行替换为空骨架，仅保留 `<footer class="container">` 与注释。
  - `frontend/src/app/components/footer/footer.component.scss`：`footer` 规则新增 `height: 39px` 与推导注释；39 = 原 `p` 高 27 + Material `mat-typography` 给 `p` 的 12px 下边距，加原有 `margin-top: 1em` 的 14px 后 `app-footer` 仍占 53px。
  - `frontend/src/assets/i18n/en.json` 与 `zh.json`：各删 `app.footer` 下 4 个键，保留 `app.unknownVersion`；两本词典各 247 键减至 243 键，键集合一一对应。
- 未改 `footer.component.ts`、`footer.module.ts`、`app.module.ts`、`app.component.html`、`app.component.scss`、路由、主题、后端、shared、版本号与依赖。
- 独立验证通过：`pnpm lint` 0 error / 9 存量 warning；`tsc --noEmit` 通过；`pnpm --filter picsur-frontend build` 通过。
- 运行期几何在开发服务器与生产产物两条路径一致：`app-footer` 高 53、`footer` 内容高 39、`.grow-full.relative` 高 708、top 96、页脚可见文本为空；`.centered` 101/698 与 H1 410/32 与改动前旧构建逐值相同，零位移。
- 已知边界：旧页脚在 zh 视口小于约 292px、en 小于约 370px 时会换行成 73px，新实现固定 53px；桌面与常见手机宽度不受影响，属于用户已选口径的预期结果。
- spec 同步：`.trellis/spec/picsur-frontend/frontend/index.md` 新增页脚固定高度约束条目；`.trellis/spec/picsur-backend/backend/build-and-deploy.md` 版本线一行改为「`/api/info` 与设置页『关于』版本区块都读它，页脚不再显示版本」。
