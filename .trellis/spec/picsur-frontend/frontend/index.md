# Frontend Development Guidelines

> Best practices for frontend development in this project.

---

## Overview

This directory contains guidelines for frontend development. Fill in each file with your project's specific conventions.

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| **构建入口（跨包）** → [Build & Deploy](../../picsur-backend/backend/build-and-deploy.md) | Angular 构建、`custom-webpack.config.cjs`、Node 版本约束 | ✅ 已填（10-13-handover-baseline） |
| [Directory Structure](./directory-structure.md) | Module organization and file layout | To fill |
| [Component Guidelines](./component-guidelines.md) | Component patterns, props, composition | To fill |
| [Hook Guidelines](./hook-guidelines.md) | Custom hooks, data fetching patterns | To fill |
| [State Management](./state-management.md) | Local state, global state, server state | To fill |
| [Quality Guidelines](./quality-guidelines.md) | Code standards, forbidden patterns | To fill |
| [Type Safety](./type-safety.md) | Type patterns, validation | To fill |

---

## Pre-Development Checklist（frontend）

- [ ] 构建必须在 **Node 20** 下跑（宿主 Node 22 装不了依赖，`frontend/custom-webpack.config.cjs` 这个
      改动就是被 Node ≥20.19 的 `require(esm)` 行为逼出来的，**不要改回 `.js` + ESM**）。
- [ ] 前端产物由 backend 托管（`PICSUR_STATIC_FRONTEND_ROOT`），构建产物路径必须是 `frontend/dist`。
- [ ] 调 API 时路径看 [Image API Contracts](../../picsur-backend/backend/image-api-contracts.md)：
      `POST` 一律返回 **201**，图片直链必须带扩展名。
- [ ] **上传并发上限是 1，且多选会丢文件**（2026-10-30 调查，`10-30-investigate-upload-concurrency`）：
      `upload.component.html:3` 的 file input 没有 `multiple`，`processing.component.ts:35` 只上传
      `state.imageFiles[0]`，批量 `UploadImages` 整段被注释且目标是并不存在的 `/api/image/upload/bulk`；
      多选、拖多张、粘贴多张时其余文件被静默丢弃。改上传交互前先读
      [Upload Concurrency](../../picsur-backend/backend/upload-concurrency.md)；要真正并发必须先补后端批量端点，
      否则只是把 N 次串行请求变成 N 次并发请求。
- [ ] **用户可见文案必须走 i18n**（#130 起）：模板里用 `{{ 'some.key' | translate }}`，
      TS 里用 `this.i18n.instant('some.key')`。**禁止硬编码英文/中文**。
      - 词典：`frontend/src/assets/i18n/en.json` 与 `zh.json`，**两边 key 必须一一对应**（新增文案要同时加）。
      - 缺 key 时原文原样输出（不会崩），但会在 UI 里露出裸 key —— PR 前请对照两份词典。
      - 切换语言：`I18nService`，持久化在 `localStorage['picsur.language']`，**默认 `zh`**
        （`defaultLanguage`；无记录时用简体中文，用户显式切过就尊重其选择，`documentElement.lang` 同步）。
      - **Material 内置文案也要接**：`MatPaginatorIntl` 已由 `PicsurPaginatorIntl`
        （`app/i18n/paginator.i18n.ts`，在 `app.module.ts` provide）覆盖，走 `pagination.*`；
        其它 Material 组件的硬编码文案（日期选择器、对话框等）同样要接到 `I18nService`。
      - `I18nService.languageChange` 是语言切换流：切换语言后需要重算的派生值（分页器文案等）订阅它。
      - 组件里要注入 `I18nService`（不要再引入 `@ngx-translate/*`，本仓库没这个依赖）。
- [ ] **异步状态必须自己触发渲染**（2026-10-16 定调，`10-16-about-page-fix`）：
      由 promise 回调 / poll 定时器改出来的状态（「正在检查」「正在升级」这类）**不会**可靠地触发变更检测，
      页面会停在第一帧文案上，只有刷新或再点一下才显示真实状态。
      做法：注入 `ChangeDetectorRef`，每次异步改状态后显式 `detectChanges()`；
      组件构造期（view 还没建）要先用 `ngAfterViewInit` 置位再渲染，否则会抛异常。
      参考实现：`frontend/src/app/routes/settings/about/settings-about.component.ts` 的 `render()`。
- [ ] **检查更新按钮走强制刷新**（2026-10-16，`10-16-update-check-fix`）：
      面板「检查更新」的 URL 带 `?force=true`（后端据此跳过约 1 小时的 GitHub 缓存，发版后点一次即可见）；
      **页面首屏与升级进度轮询不要带 force**，那两条是有意省额度的缓存路径。
      实现见 `frontend/src/app/services/api/system-update.service.ts` 的 `checkForUpdates()`。
- [ ] **「关于」页的手动命令块是兜底不是装饰**：只在**可升级**或**升级失败**时显示，
      「已是最新 / 升级中 / 刚升级成功」都不显示（否则会在“一切正常”的页面上挂一大块命令框）。
      实现见 `settings-about.component.ts` 的 `showManualCommand` / `showManualHintLine`。
- [ ] **Material 大版本升级后必须跑全站对比度探针**：
      `node support/visual-contrast-probe.cjs --base=<url> --token=<jwt> --out=/tmp/contrast`
      —— 逐页截图 + 计算每段可见文字的 WCAG 对比度（并单独抓大面积浅色面板），
      输出每页的低对比数量、覆盖率（文字元素数）与组件标记（表格/徽章/分页器）；
      页面没渲染出来（空白/限流）也会判失败，不允许"空页面通过"。
- [ ] **Material 组件的 `--mat-*` 令牌要从我们的调色板显式发出**：
      本仓库用的是手写 legacy 主题 map，**不会**发这些令牌；组件拿不到时，
      凡是 fallback 链里带硬编码浅色（`var(--mat-sys-on-surface, rgba(0,0,0,.87))`、
      `var(--mat-dialog-container-color, white)`）的就会掉进**浅色默认值** ——
      表现就是黑底上的近黑文字或白色面板（0.8.6 的表格表头/单元格与徽章就是这样）。
      已按此修：`.mat-mdc-table`、`.mat-mdc-chip`、`.mat-mdc-dialog-container`（见 `scss/material/material-theme.scss`）；
      新组件（tabs / tooltip / select-panel / paginator / progress …）用同样方式补，
      不要改模板绕、也不要在组件 SCSS 里硬编码颜色。
- [ ] **删功能要清干净**（2026-10-16，`10-16-update-check-fix` 删 ShareX）：一次删除必须同时处理
      ① 侧栏入口（它来自路由 `data.page`，删路由即删入口）、② 页面目录与配置生成器、
      ③ 路由条目、④ **i18n 两本词典的对应词条**（`.shareX` 与 `pages.shareX`，删完复核无孤儿 key）、
      ⑤ 对比度探针的覆盖（`support/visual-contrast-probe.cjs` 的路由清单里保留**旧地址**，
      断言它落到 404 而不是白屏）；`app.routing.module.ts` 的 `**` 兜底负责把未知地址送到 `/error/404`。
      删完用全局搜索（功能名，大小写不敏感）+ 探针全量跑一遍确认。
- [ ] **不设版本兼容弹窗**（2026-10-16，`10-16-update-check-fix`）：客户端与服务端版本不一致时
      **不做拦截、不弹对话框**（曾经有一个"服务器不兼容"对话框，用户要求整体移除）；
      升级后的刷新由升级流程自己负责（`util/reload-fresh.ts`），不要再引入启动期版本比对。
- [ ] **「未知」不等于「关闭」**：答案还没拿到（加载中/失败/超时）时，不要渲染「功能未启用」这类结论性文案，
      否则用户会以为后端把功能关了。状态机要区分 idle / loading / ok / failed，失败给可读原因 + 重试入口。
- [ ] **跨网络/跨重启的流程要有上界与自动收尾**：升级、检查这类流程客户端必须有超时与可重试兜底；
      升级过程中轮询后端状态并显示阶段（拉镜像 / 重启中），版本变化后**自动刷新页面**，
      不要留给用户手动强刷；失败要显示「已回滚到 <version>」+ 原因。
- [ ] **页脚来源行已移除，靠固定高度占位**（2026-10-29，`10-29-footer-line-blank`）：
      `footer.component.html` 只剩空骨架，`footer.component.scss` 用 `height: 39px` 加原有 `margin-top: 1em`
      维持 `app-footer` 总占位 53px，主区域高度不随页脚变化。改页脚、body 字号或 `mat-typography` 相关样式后，
      要复量 `app-footer` 是否仍为 53px。页脚旧文案词条已从 en/zh 词典删除；
      需要版本号请读 `/api/info` 或设置页「关于」，不要再往页脚加文案。

---

## How to Fill These Guidelines

For each guideline file:

1. Document your project's **actual conventions** (not ideals)
2. Include **code examples** from your codebase
3. List **forbidden patterns** and why
4. Add **common mistakes** your team has made

The goal is to help AI assistants and new team members understand how YOUR project works.

---

**Language**: All documentation should be written in **English**.

### Material 21 的两条取色/定位坑（2026-10-17 实测）

1. **面板类组件必须显式发 `--mat-*` 令牌**：select / menu / dialog / table / chip 等的底色都走
   `var(--mat-xxx, var(--mat-sys-…))`；我们的主题是手写 legacy 调色板，**不发这些令牌** ✗ →
   组件会静默落回默认（**对话框=白板、表格=近黑字、下拉面板=全透明 `rgba(0,0,0,0)`** ✗）。
   统一做法：在 `scss/material/material-theme.scss` 里**从我们自己的调色板**发令牌（不硬编码颜色 ✓）。
   已知需覆盖：`.mat-mdc-dialog-container`、`.mat-mdc-table`、`.mat-mdc-chip`、`div.mat-mdc-select-panel`（含选中/ hover state layer）。
2. **Material 21 的 select 面板不在 `.cdk-overlay-container` 里** ✗ —— 它用 **popover API 渲染在 `mat-select` 元素内部**（外面套 `.cdk-overlay-popover`）✓。
   所以老写法 `.cdk-overlay-container div.mat-mdc-select-panel` **完全不命中** ✗；要写 `body div.mat-mdc-select-panel`
   （顺便压过 Material 自带的 `div.mat-mdc-select-panel{max-height:275px}` 特异性 ✓ —— 需要它**向下展开**时把 max-height 压到下方可用空间内即可 ✓）。
