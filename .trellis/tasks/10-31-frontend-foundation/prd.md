# Rust 前端骨架、设计系统与 i18n

## Goal

为前端重写搭好地基：框架定稿、路由与状态模型、HTTP 与类型契约、i18n 复用、设计系统骨架。

## Deliverables

- 框架定稿与理由：Leptos、Dioxus、Yew 三选一，给出渲染模式与构建链决定。
- 工程骨架：Cargo workspace 成员、trunk 或 wasm-pack 构建、产物目录与静态托管衔接。
- 路由：七个页面域 upload、processing、view、user、images、settings、errors 与 404 兜底共 8 条路由，默认重定向 `/`→`/upload`、`/images`→`/images/1`、`/settings`→`/settings/general`，深链可用。
- 契约层：与后端 serde 结构体共用的类型方案，运行时校验策略，Bearer 注入与错误信封解析。
- i18n：复用 `frontend/src/assets/i18n/en.json` 与 `zh.json` 全部键，语言切换与 `localStorage['picsur.language']` 兼容。
- 设计系统骨架：颜色、间距、排版、按钮、对话框、表单控件、暗色模式变量。

## Acceptance Criteria

- [ ] 构建产物可由 Rust 后端托管，SPA 深链返回 200 text/html。
- [ ] 七个页面域加 404 共 8 条路由均能到达页面骨架，默认重定向与未知路径落 404 的行为与现有版本一致。
- [ ] i18n 两份词典逐键对齐脚本可跑，缺键即失败。
- [ ] 语言切换行为与现有实现一致。
- [ ] 首屏 WASM 体积有实测数字并记录预算。

## Dependencies

依赖 02 后端骨架的静态托管契约；工程骨架可与 02 并行开发，验收在 02 完成之后。
