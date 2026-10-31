# Research: 全栈 Rust 重写的前端选型与 Material 复刻

- Query: 用户已定调全栈迁移到 Rust，前端也要重写且功能与界面对齐现有 Angular 版本；框架、UI 复刻、i18n、QOI、构建、契约与验收怎么设计
- Scope: mixed —— 仓库事实取自 `frontend/**` 与 `support/**`，外部资料取自 crates.io 与 npm 公开元数据
- Date: 2026-10-31
- 决策前提：三条用户决策已定。第一，后端与前端都迁到 Rust。第二，验收基准是现有页面、路由、i18n 文案与交互。第三，新版本要与现有实例无缝升级，Postgres schema 与 `/data` 目录保持兼容且可回滚。本文件只分析前端侧，后端侧见 `02-web-framework.md` 等。

## Findings

### Files Found

| File Path | Description |
|---|---|
| `frontend/package.json` | Angular 21.2 全家桶与第三方依赖清单 |
| `frontend/angular.json` | 构建输出 `dist`、index、assets、styles |
| `frontend/src/index.html` | base href、PWA manifest、默认语言 zh、加载样式 |
| `frontend/src/app/app.routing.module.ts` | 七域懒加载与 404 兜底 |
| `frontend/src/app/routes/**` | 各页面路由模块与组件，共 19 个页面级组件 |
| `frontend/src/app/components/**` | 12 个共享组件，含 masonry、picsur-img、speed-dial、values-picker |
| `frontend/src/app/util/**` | 对话框、snackbar、下载、剪贴板、错误管理、QOI 解码 |
| `frontend/src/app/services/api/*.ts` | 9 个 API 服务与 axios 封装 |
| `frontend/src/app/services/storage/*.ts` | localStorage 键：`apiKey`、`server-info` |
| `frontend/src/app/i18n/*` | 自研 i18n 服务、翻译管道、权限与偏好词典、分页器词典 |
| `frontend/src/assets/i18n/en.json` 与 `zh.json` | 各 327 行，243 个叶子键，21 个顶层命名空间 |
| `frontend/src/scss/**` | 25 个 SCSS 文件，含 M2 legacy 主题与自定义令牌 |
| `frontend/src/assets/css/loading.css` 与 `normalize.min.css` | 首屏加载与 CSS 重置 |
| `support/visual-contrast-probe.cjs` | 全站对比度与页面渲染探针 |
| `support/gallery-layout-probe.cjs` | 图库布局探针 |
| `support/regression-image-api.sh` | 34 项接口回归，后端契约基线 |
| `.trellis/spec/picsur-frontend/frontend/index.md` | 前端规范与踩坑清单 |

### Code Patterns

一、现有前端资产清单

1. 规模：ts、html、scss 合计约 11986 行；33 个 component 文件，其中 19 个页面级、12 个共享组件、2 个对话框组件；另有 6 个 util 服务与 9 个 API 服务。
2. 路由表，需逐条复刻：

| 路径 | 组件 | 说明 |
|---|---|---|
| `/` | 重定向到 `/upload` | 根路径 |
| `/upload` | UploadComponent | 上传页 |
| `/processing` | ProcessingComponent | 上传处理页 |
| `/view/:id` | ViewComponent | 图片详情，带权限守卫 |
| `/images` 与 `/images/:page` | ImagesComponent | 图库，`page` 从 1 起，带权限守卫 |
| `/user/login`、`/user/register` | Login 与 Register | 带权限守卫 |
| `/settings` 与 `/settings/general` | SettingsGeneral | 设置首页重定向 |
| `/settings/users`、`/settings/users/add`、`/settings/users/edit/:uuid` | 用户管理 | 带权限守卫 |
| `/settings/system` | SettingsSyspref | 系统偏好 |
| `/settings/about` | SettingsAbout | 关于与升级 |
| `/error/404`、`/error/401`、`/error/delete-success`、`/error/delete-failure` | 四个错误页 | 兜底与删除结果页 |
| 其它任意路径 | 重定向到 `/error/404` | 见 `app.routing.module.ts:49-53` |

3. 权限守卫：`PermissionGuard` 先取静态权限清单校验路由声明的权限，再比对当前用户权限，不足则跳 `/error/401`，见 `frontend/src/app/guards/permission.guard.ts:36-62`。路由权限声明在 `data.permissions`，嵌套路由会做并集。
4. Material 组件用量，按模板里出现的元素统计：`mat-icon` 66 次、`mat-form-field` 与 `mat-label` 各 40 次、`mat-error` 20 次、`mat-icon-button` 18 次、`mat-option` 14 次、`mat-slide-toggle` 12 次、`mat-select` 10 次、`mat-stroked-button` 与 `mat-chip` 各 8 次、`mat-flat-button` 7 次、`mat-spinner` 6 次、`mat-paginator` 2 次、`mat-table` 2 次、`mat-sidenav` 2 次、`mat-menu` 4 次、`mat-progress-bar` 4 次、`mat-toolbar` 2 次、`mat-fab` 与 `mat-mini-fab` 共 7 次，以及 `mat-card`、`mat-divider`、`mat-nav-list`、`mat-list-item` 各少量。
5. 主题：M2 legacy 调色板，由 Material Theme Generator 生成，主色绿 600、强调蓝灰 600、警告红，见 `frontend/src/scss/material/material-theme.scss` 与 `material-theme.legacy.scss`。另有手写令牌补丁 `material-theme-custom.scss`，因为 Material 21 组件在缺 `--mat-*` 令牌时会掉进浅色默认值，见 `.trellis/spec/picsur-frontend/frontend/index.md` 末尾两条实测。仓库没有暗色主题切换，只定义了调色板。
6. 字体与图标：Roboto 100 到 900 六个字重来自 `@fontsource/roboto`，图标来自 `material-icons` 字体，见 `frontend/src/scss/fonts.scss`。Bootstrap 只引入 grid，见 `frontend/src/scss/bootstrap.scss`。
7. 全局服务：对话框、确认框、下载框、snackbar、剪贴板、API 错误统一管理，见 `frontend/src/app/util/**`。这些是跨页面交互契约，不是可选装饰。
8. 共享组件要点：`masonry` 用 `ResizeObserver` 动态分列，见 `masonry-item.directive.ts:47`；`picsur-img` 先 HEAD 探测类型再决定解码路径；`paginator` 全站复用；`values-picker`、`infinite-select`、`pref-option` 用于设置页表单；`speed-dial` 用于详情页悬浮操作。
9. 首屏与路由行为：`index.html` 预置加载样式，`app.component.ts` 在路由切换时显示 loading，并有路由过渡动画，见 `frontend/src/app/app.animation.ts`。
10. 时间显示：详情页与图库用 `amTimeAgo` 显示相对时间，见 `routes/view/view.component.html:17`、`:27`、`routes/images/images.component.html:48`、`:55`；语言切换时同步 moment locale，见 `i18n/i18n.service.ts:90-91`。

二、框架候选

| 候选 | 版本事实 | 渲染模式 | 路由与异步 | 与本项目贴合度 | 主要风险 |
|---|---|---|---|---|---|
| Leptos | 0.8 线稳定，0.9.0-rc0 于 2026-10-15 发布，MSRV 1.88，MIT | CSR、SSR 加 hydration、islands | leptos_router，`Resource` 与 `Suspense` | 高：细粒度信号模型与 Angular 21 的 signal 心智接近，DOM 更新粒度小，包体相对小 | 0.9 迁移在即，生态组件多为 beta |
| Dioxus | 0.7 线稳定，0.8.0-alpha.3 于 2026-10-16 发布，MSRV 1.83 | CSR、SSR、桌面与移动 | dioxus-router，内置 fullstack 与 hot reload | 中高：React 模型直观，工具链 dioxus-cli 完整 | 0.8 alpha 已开，组件库偏 Tailwind 风格 |
| Yew | 0.23.0，2026-03-10，MSRV 1.84 | CSR、SSR | yew-router，函数组件加 hooks | 中：虚拟 DOM，模板写法最接近 Angular 模板 | 社区活跃度低于前两者，无 M2 组件方案 |

推荐 Leptos 的理由：一是当前 Angular 21 已经是 signal 驱动，团队心智可直接迁移；二是细粒度 DOM 更新在图片密集的图库页更不容易出现整块重渲染；三是 `leptos-use` 0.20.0 提供 `use_intersection_observer`、`use_resize_observer`、`use_infinite_scroll`、`use_intl_datetime_format`，正好对位现有 masonry、懒加载与相对时间；四是 `leptos_i18n` 0.6.2 可作备选，但本文件推荐自研薄封装以复用现有 JSON。替代方案 Dioxus 0.7 的优势是工具链与文档、以及 React 式组件写法，适合团队更熟悉 React 的情况；Yew 适合想保留虚拟 DOM 语义的情况，但组件生态与 2026 年的活跃度都弱一档。

三、UI 复刻路径

| 方案 | 本质 | 视觉对齐现有 M2 主题 | 可访问性 | 工作量 | 结论 |
|---|---|---|---|---|---|
| 手写 picsur-ui 组件库加移植 SCSS | 用现有 SCSS 令牌与结构重写组件 | 高，逐像素可控 | 需自己补 ARIA 与焦点管理 | 大 | 推荐 |
| @material/web 2.5.0 | Lit Web Components，Material 3 | 低，M3 视觉与现有 M2 不同 | 高，组件自带 | 中 | 不推荐，视觉必然漂移 |
| leptos-material 0.6.1 | 对 @material/web 的 Leptos 包装，2024-08 后未更新 | 低，同为 M3 | 中 | 中 | 不推荐，缺表格、分页器、对话框、菜单、snackbar |
| thaw 0.5.0-beta、leptonic 0.5.0、leptos_ui 0.3.22 | 通用组件库，Tailwind 或其他设计语言 | 低到中，需要大量覆写 | 中 | 中 | 备选，只用于表单控件可考虑 |
| 保留 Angular 前端 | 不重写 | 完全一致 | 完全一致 | 最小 | 与用户决策冲突，不作方案 |

推荐手写组件库的直接理由：现有界面是 M2 主题，Material Web 与 leptos-material 都是 M3，M3 的圆角、阴影、间距与状态层都与 M2 不同，走这条路会被对比度探针与截图 diff 直接打回。手写时把现有 25 个 SCSS 文件里的调色板、排版级别、间距与阴影抽成一层 CSS 自定义属性，再按实际用到的组件清单实现，范围可控。

需要实现的组件清单与难度：

| 组件 | 现有来源 | 难度 | 说明 |
|---|---|---|---|
| Button 四变体加 IconButton | mat-flat、stroked、raised、icon-button | 低 | 状态层与禁用态需要逐色对齐 |
| FormField 加 Input 加 Error | mat-form-field、mat-label、mat-error | 高 | 浮动标签、描边、错误公告与焦点环是主要工作量 |
| Select 与 Option | mat-select、mat-option | 高 | 下拉面板、键盘导航、多选与 ARIA |
| SlideToggle | mat-slide-toggle | 低 | 动画曲线对齐 |
| Chip 与 ChipListbox | mat-chip、mat-chip-listbox | 中 | 可删除 chip 与键盘操作 |
| Table 加 HeaderCell 与 Cell | mat-table | 中 | 含固定列宽与响应式滚动 |
| Paginator | mat-paginator 加 `PaginationIntl` | 中 | 文案走 i18n 的 5 个键与 range 模板 |
| Dialog | MatDialog 与 confirm 与 download | 高 | 原生 dialog 加焦点陷阱、Esc、遮罩与滚动锁 |
| Menu | mat-menu | 中 | 定位与关闭策略 |
| Snackbar | MatSnackBar | 中 | 队列、超时、动作按钮 |
| Tooltip | 少量使用 | 低 | 可先做 CSS 版 |
| Sidenav 与 Toolbar | mat-sidenav、mat-toolbar | 中 | 移动端抽屉与断点 |
| Progress 三态 | mat-spinner、mat-progress-spinner、mat-progress-bar | 低 | 圆形与线性 |
| Card 与 Divider 与 NavList | mat-card、mat-divider、mat-nav-list | 低 | 样式为主 |
| Masonry | 自写，ResizeObserver | 中 | 移植算法并使用 `use_resize_observer` |
| PicsurImg | 自写，HEAD 加 QOI 加 canvas | 高 | 见第五节 |
| SpeedDial 与 CopyField 与 ValuesPicker 与 InfiniteSelect 与 PrefOption | 自写 | 中到高 | 交互密集，逐个页面验证 |

逐页复刻难点评级：

| 页面 | 现有行数 | 难度 | 主要难点 |
|---|---|---|---|
| errors 四个页面 | 10 到 13 行各 | 低 | 纯静态文案与路由 |
| upload | 81 行加 dropzone 14 行 | 低到中 | 文件选择、拖放、上传进度与取消 |
| processing | 41 行 | 中 | 轮询上传结果、失败重试、驱动跳转详情页 |
| view | 258 行加 3 个子组件 | 高 | 元数据加载、格式选择、QOI 显示、分享链接、删除密钥、到期计时、速度拨盘、两个对话框 |
| images | 455 行 | 高 | 无限滚动加分页、缩略图与全图切换、筛选与搜索、批量选择与删除、masonry 布局、相对时间 |
| settings 与 general | 31 行与 60 行 | 低 | 侧栏导航与占位页 |
| settings 与 about | 435 行 | 高 | 检查更新、升级状态机、轮询、失败与回滚文案、手动命令块、页面自动刷新 |
| settings 与 users | 154 行加 215 行编辑页 | 高 | 表格加分页、用户创建与权限矩阵、特殊用户锁定、删除确认 |
| settings 与 system | 70 行 | 中 | 5 个系统偏好的类型化表单与校验 |
| user 登录与注册 | 84 行加 114 行 | 中 | 表单校验、错误提示、登录后 token 写入 |
| 全局头尾与侧栏 | header 132 行、footer 63 行 | 中 | 语言切换、导航、移动端断点与 53px 页脚高度契约 |

四、i18n 复用

1. 词典结构：en 与 zh 各 21 个顶层命名空间，243 个叶子键，文件各 327 行，见 `frontend/src/assets/i18n/en.json` 与 `zh.json`。两侧键必须一一对应，前端 spec 已有明文要求。
2. 运行时行为：`instant` 按点分路径查词典，找不到返回 key 原文；`{{ name }}` 占位符替换，缺失参数时保留原文；语言持久化到 `localStorage['picsur.language']`，默认 zh，见 `i18n.service.ts:54-68`、`:118-160`。
3. 推荐做法：把两份 JSON 用 `include_str!` 编进 wasm，启动时 `serde_json` 解析成静态表，按当前语言信号查表；实现同名 `t` 函数，保持「找不到返回 key」与 `{{ }}` 插值两条语义；写入同一个 localStorage 键，并同步 `document.documentElement.lang`；页脚、分页器、Material 内置文案这类原本走 `PaginationIntl` 的键也要接到同一函数。
4. 相对时间：现有 `amTimeAgo` 由 ngx-moment 提供，语言切换会改 moment locale，见 `i18n/i18n.service.ts:90-91`。Rust 侧推荐用浏览器 `Intl.RelativeTimeFormat`，走 `leptos-use` 的 `use_intl_datetime_format` 或 `web-sys` 直接调用；输出文案与 moment 的差异需要逐条对齐，见待确认项。
5. 服务端错误文案：后端 message 是英文原文，前端 `instant` 找不到 key 时原样显示。新前端必须保持同样的透传行为，不得把错误 message 当 key 去翻译，也不得改写后端文案。
6. 键一致性检查：建议在构建期加一步，比较 en 与 zh 的键集合差异，并扫描源码里出现的 `t!("...")` 字面量，断言都在词典里。

五、图片展示链路

1. 现状：`picsur-img` 先发 HEAD 取 `content-type`，识别 QOI 时走 Web Worker 解码并画到 canvas，其它格式走 `getBuffer` 加 Blob URL 加 `<img>`；`native` 模式直接让浏览器加载，见 `picsur-img.component.ts:88-189`。QOI 解码器是 qoijs 的 TypeScript 移植，见 `frontend/src/app/util/qoi/qoi-decode.ts`。
2. WASM 方案：用 `qoi` 0.4.1 在 wasm 内解码为 RGBA 字节，再通过 `web-sys` 的 `ImageData` 与 `CanvasRenderingContext2d::put_image_data` 上屏。理由：qoi 是纯 Rust 且无依赖，格式固定；解码路径与现有 Worker 语义等价，且省掉一次跨线程消息。
3. 网络层：用 `gloo-net` 0.7.0 的 `Request` 加 `Authorization` 头取字节，HEAD 探测复用同一层；非 QOI 用 `Blob` 加 `Url::create_object_url_with_blob`，在组件卸载或换图时 revoke，对应现有 `releaseObjectURL` 语义。
4. 懒加载：图库卡片进入视口才加载，用 `leptos-use` 的 `use_intersection_observer` 或 `web-sys` 的 `IntersectionObserver`；现有实现通过 `onInview` 触发首载。
5. `/i/meta/:id` 交互：详情页取元数据、判断是否保留原图、生成分享链接与格式列表，见 `view.component.ts` 与 `image.service.ts:168-243`。这部分逻辑是纯数据流，可直接移植到共享契约层。
6. 可选简化：既然后端继续支持 WebP 派生图，新版前端可以统一请求 WebP 而不解码 QOI。代价是行为与现有不完全一致，且 QOI 作为主存储格式带来的体积收益会被前端放弃；是否采用需产品决策，见待确认项。

六、构建链路

1. 现状：`ng build` 输出 `frontend/dist`，含 index.html、runtime 与 polyfills 与 main 等哈希产物、assets；由后端 `PICSUR_STATIC_FRONTEND_ROOT` 托管，SPA 回落靠 `fallthrough: true`。
2. 推荐工具：trunk 0.22.1，2026-10-26 发布，MSRV 1.96.1。它负责 index.html 模板、wasm-bindgen 绑定生成、资源指纹、`dist/` 输出，与 `ng build` 的阶段划分等价；配套 `wasm-bindgen` 0.2.130 的 CLI 必须与 crate 版本严格一致，另需 `wasm-opt` 做体积优化。
3. 替代工具：`wasm-pack` 适合库形态，做应用需要自己拼 index.html 与资源复制，不如 trunk 直接；`cargo-leptos` 面向 SSR 与 hydration 工程，本项目用 CSR 时不必引入。
4. 产物与后端衔接：`dist/index.html`、`dist/*.js`、`dist/*.wasm`、`dist/assets/**`。后端静态托管需要正确给 `application/wasm`，否则 `WebAssembly.instantiateStreaming` 会失败；`mime_guess` 2.0.5 对该扩展名的映射需实测，见待确认项。
5. 资源清单：Roboto 六个字重、Material Icons 字体、branding 目录、`app.webmanifest`、`loading.css`、`normalize.min.css`、favicon，全部复制为静态资源；i18n JSON 走 `include_str!` 编进 wasm，不再作为网络资源。
6. 首屏：现有 index.html 有加载占位，新版本保留同样的骨架与 loading.css，避免首屏白屏差异。

七、与后端契约的共用

1. 推荐新建 workspace crate `picsur-contracts`，放全部请求与响应结构体、枚举、信封类型与校验函数；后端与前端 wasm 同时依赖它，用 feature 隔离服务端专属依赖，例如 `server` feature 才引入 utoipa 与 axum 派生。
2. 前端解析：serde_json 反序列化到同一结构体，信封用 serde 的 tagged enum，`success: bool` 加 `data` 泛型；错误类型枚举与 FT 字符串一一对应。
3. 校验：zod 的 `preprocess`、`partial`、uuid 版本约束这些语义迁到后端与契约 crate，前端只做展示层表单校验，且表单校验函数也放进契约 crate 编译成 wasm，避免两套正则。
4. 是否需要 ts-rs 或 typeshare：只有过渡期保留 Angular 前端时才需要。ts-rs 12.0.1 与 typeshare 1.0.5 都能从 Rust 生成 TS，但既然目标前端也是 Rust，首版不应引入，避免额外生成物与漂移。
5. shared 包的退役：迁移期 Angular 仍用 `shared/src` 的 zod 与类型；新前端完成后该包只服务旧前端，退役阶段一并删除。契约以 `picsur-contracts` 为唯一来源。

八、验收基线

1. 接口回归：`support/regression-image-api.sh` 的 34 项继续作为后端契约基线，前端重写不改变它。
2. 对比度探针：`support/visual-contrast-probe.cjs` 逐页截图并计算 WCAG 对比度，输出低对比数量与覆盖率。新前端复用同一脚本，把 `--base` 指向新实例，断言每页低对比数量不高于现有基线，且页面确实渲染出来而不是空白通过。
3. 布局探针：`support/gallery-layout-probe.cjs` 检查图库卡片布局，新前端复用，断言列数、卡片尺寸与间距在容差内。
4. 页面清单验收：把第一节的路由表转成检查清单，逐页断言状态码、标题、关键元素与文案，语言 zh 与 en 各一遍。
5. 交互验收：登录、上传、查看、删除、设置修改、语言切换、升级检查七条主流程脚本化；现有仓库没有 e2e 框架，建议用 Playwright 放在 `support/`，只作为测试工具保留 Node，不影响运行时纯 Rust 目标。
6. i18n 验收：键集合 diff 为 0；源码里出现的键全部存在；切换语言后 `documentElement.lang`、localStorage、页脚与分页器文案同步变化。
7. 升级兼容验收：同一 `/data` 与同一 Postgres 数据卷下，旧 Angular 前端产出的 localStorage 键在新前端的读取行为一致，至少 `apiKey`、`server-info`、`picsur.language` 三个键要兼容。

## Decision

### 推荐方案：Leptos 0.8 线加 CSR，不用 SSR

- 做法：单页 CSR，trunk 构建，客户端路由通配照搬现有路由表；权限守卫在路由层实现，失败跳 `/error/401`。
- 理由：现有鉴权是 localStorage token 加 Bearer 头，服务端渲染无法在无 cookie 的情况下渲染用户相关内容；SSR 会把鉴权模型改成 cookie 会话，属于契约变更，与「无缝升级」冲突。CSR 与现有 SPA 行为最接近。
- 替代方案：Leptos SSR 加 hydration，用 islands 渲染静态外壳。代价是需要引入 cookie 会话或两套鉴权，收益是首屏更快；可作为后续独立优化，不建议首版。
- 代价：首屏依赖 wasm 下载与初始化，需要控制体积。
- 验证方式：测量首屏可交互时间与现有 Angular 对比，目标不劣于现有；路由矩阵逐条通过。

### 推荐方案：手写 picsur-ui 组件库并移植现有 SCSS 令牌

- 做法：先抽 CSS 变量层，包含 M2 调色板、四类排版、间距、圆角、阴影、断点；再按第三节清单实现组件，优先对话框、表单字段、表格与分页器这四个高风险项。
- 理由：Material Web 已是 M3，视觉必然与现有 M2 不同；手写能逐像素对齐，并复用现有 25 个 SCSS 文件里的真实样式。
- 替代方案一：@material/web 2.5.0 加 leptos-material 0.6.1。代价是 M3 视觉漂移与包装层停更，收益是自带可访问性。
- 替代方案二：thaw 或 leptonic 加主题覆写。代价是设计语言不同且需大量覆写，收益是省组件开发。
- 代价：组件库约 20 到 30 人日，且必须补 ARIA、焦点陷阱与键盘导航。
- 验证方式：每实现一个组件，用现有页面的真实数据做侧对比截图；对比度探针与布局探针全绿；键盘导航逐组件手测。

### 推荐方案：i18n 嵌入现有 JSON，保持运行时语义

- 做法：`include_str!` 两份 JSON，编译期或启动时解析；`t` 函数负责路径查找、`{{ }}` 插值与原文回落；同一 localStorage 键与默认语言。
- 理由：文案是验收基准，词典不能重写；嵌入可省一次请求并避免版本不一致。
- 替代方案：`leptos_i18n` 0.6.2。代价是键格式与插值语义不同，需要转换词典或改文案，收益是编译期检查与复数与日期格式化。
- 代价：自己维护 50 行左右的查表与插值代码，外加键一致性测试。
- 验证方式：键集合 diff 为 0；en 与 zh 切换后同一页面的所有可见文案与现有版本逐字一致。

### 推荐方案：QOI 在 WASM 内用 qoi 0.4.1 解码

- 做法：wasm 内用 `qoi` 解码为 RGBA，`web-sys` 构造 ImageData 后画到 canvas；非 QOI 走 Blob 与 `<img>`；懒加载用 IntersectionObserver。
- 理由：与现有 Worker 解码等价，纯 Rust，无 JS 依赖；qoi crate 无依赖且格式固定。
- 替代方案：统一改用 WebP，不再解码 QOI。代价是行为变化与后端转码量增加，收益是前端更简单。
- 代价：canvas 尺寸与内存管理要仔细，避免大图撑爆 wasm 内存。
- 验证方式：同一张 24MP QOI 在旧前端与新前端解码后的像素哈希一致；连续切换 50 张图后 canvas 与 Blob URL 无泄漏。

### 推荐方案：共享 Rust 契约 crate，不引入 ts-rs 或 typeshare

- 做法：`picsur-contracts` 放 serde 结构体与校验函数，前后端共用；服务端专属依赖用 feature 隔离。
- 理由：前后端同语言的最大收益就是零代码生成与零漂移。
- 替代方案：ts-rs 12.0.1 或 typeshare 1.0.5 生成 TS。仅在过渡期保留旧前端时需要。
- 代价：契约 crate 要保持 wasm 可编译，不能渗入 sqlx 与 axum 类型。
- 验证方式：`cargo check --target wasm32-unknown-unknown -p picsur-contracts` 通过；契约 crate 的单元测试与后端集成测试共用同一批 JSON 夹具。

### 工作量估算

| 工作包 | 人日区间 | 说明 |
|---|---|---|
| 工程骨架、构建、静态托管对接 | 5 到 8 | trunk、wasm-bindgen、资源与 SPA 回落 |
| 契约 crate 与 API 客户端 | 5 到 8 | serde 结构、信封、错误映射、上传进度与取消 |
| 组件库 | 20 到 30 | 按第三节清单，含 ARIA 与焦点管理 |
| 页面复刻 | 25 到 40 | 九个页面域，view 与 images 与 about 与 users 占大头 |
| i18n 与文案对齐 | 2 到 3 | 含相对时间与分页器文案 |
| 图片链路 QOI 与懒加载 | 3 到 5 | 含内存与对象 URL 生命周期 |
| 对比度与布局回归迭代 | 6 到 10 | 每轮探针失败后的修正 |
| 交互验收脚本 | 8 到 12 | 七条主流程加页面清单 |
| 合计 | 74 到 116 | 单人全职约 3.5 到 5.5 个月，属经验估算，待确认 |

## Caveats / Not Found

1. 待确认：Leptos 与 Dioxus 的确切最新稳定补丁号。检索时 0.9.0-rc0 与 0.8.0-alpha.3 已发布，稳定线版本以实施当天的 crates.io 为准。验证方法：`cargo search leptos --limit 5` 与 crates.io 页面核对，并把版本写进 `Cargo.toml` 锁定。
2. 待确认：trunk 0.22.1 的 MSRV 是 1.96.1，高于后端 sqlx 0.9 的 1.94 要求，工作区工具链需要按 1.96.1 以上钉版本。验证方法：`rust-toolchain.toml` 统一钉到满足全部依赖的最高 MSRV，CI 里跑一次完整构建。
3. 待确认：`mime_guess` 2.0.5 对 `.wasm` 的映射是否为 `application/wasm`。验证方法：`curl -I http://实例/picsur-<hash>.wasm` 看 Content-Type，并在浏览器控制台确认 `instantiateStreaming` 无 MIME 警告；若不是，后端静态层手工补映射。
4. 待确认：WASM 首屏体积与首次可交互时间。基线用现有 Angular 生产构建的传输体积与 Lighthouse 指标。验证方法：`wasm-opt -Oz` 后测 gzip 体积，目标是不劣于现有主包加懒加载首屏总量；超过则引入代码分割或 islands。
5. 待确认：相对时间文案与 moment 的差异。`amTimeAgo` 的输出例如「3 分钟前」，`Intl.RelativeTimeFormat` 的措辞可能不同。验证方法：固定时间戳集合，在两种语言下分别渲染，逐条对照文案；不一致时改为自定义格式化以对齐。
6. 待确认：路由切换动画是否必须复刻。现有 `app.animation.ts` 有过渡动画，探针只做静态截图，动画差异不会被自动发现。验证方法：询问项目所有者动画是否属于验收范围；若属于，用 CSS 过渡实现并人工比对录屏。
7. 待确认：Material 组件的涟漪与状态层效果是否必须复刻。这些只影响交互瞬间的视觉。验证方法：与项目所有者确认，或做最小 CSS 涟漪实现并人工对比。
8. 待确认：QOI 是否可整体退化为 WebP。需要确认「功能与界面复刻」是否包含对 QOI 直链与前端解码路径的保留。验证方法：与项目所有者确认；若允许退化，可删掉 QOI 解码路径，减少约 3 到 5 人日。
9. 待确认：浏览器兼容范围。wasm 在现代浏览器均可用，但若需支持旧版 Safari 或老旧移动端，需要列目标清单。验证方法：从现有 browserslist 配置反推目标，或询问项目所有者。
10. 未找到：仓库没有 e2e 测试框架、没有组件级视觉快照基线、没有暗色主题切换。因此视觉回归需要新建截图基线，建议在迁移开始前先用现有 Angular 版本采集一套。
11. 未找到：仓库没有前端单元测试。i18n、格式化与校验这类纯函数建议在 `picsur-contracts` 与前端 crate 内补测试，而不是继续依赖手测。
