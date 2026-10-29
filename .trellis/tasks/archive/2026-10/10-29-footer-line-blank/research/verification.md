# 验证报告：页脚来源行清空与 53px 占位

- **任务**：`.trellis/tasks/10-29-footer-line-blank`
- **验证角色**：Trellis check 子代理 `footer-verifier`，独立验证，不采信实现成员结论
- **时间**：2026-10-29
- **代码基线**：HEAD `007b592`，分支 master，版本 0.10.6
- **环境**：Node v20.20.2、pnpm 9.6.0；常驻浏览器 Chromium 153，视口 1600x857、DPR 1、语言 zh

## 一、结论

**结论：通过，无打回项。** 未修改任何业务代码。

- 业务代码 diff 恰好 4 个文件：`footer.component.html`、`footer.component.scss`、`en.json`、`zh.json`；无 TS、module、外壳、后端、共享包、主题、路由、版本号改动。
- 规范清理到位：模板已不再引用 `app.footer.*`；en/zh 各删 4 个键且键集合一一对应；`app.unknownVersion` 保留。
- 独立复跑全部通过：`pnpm lint` exit 0、`tsc --noEmit` exit 0、`pnpm --filter picsur-frontend build` exit 0。
- 运行期几何在开发服务器与生产产物两条路径上均与改动前基线逐值一致：`app-footer` 高 53、`.grow-full.relative` 高 708、top 96、页脚无可见文本、主内容容器与 H1 位置零位移。
- 有 3 项非阻断观察与 5 项残留风险，见第四节。

## 二、逐项证据

### 1. diff 范围复核

业务代码 diff 共 4 个文件，行数如下，来自 `git diff --numstat -- frontend/src`：

| 文件 | 新增 | 删除 |
|---|---|---|
| `frontend/src/app/components/footer/footer.component.html` | 1 | 22 |
| `frontend/src/app/components/footer/footer.component.scss` | 5 | 0 |
| `frontend/src/assets/i18n/en.json` | 1 | 7 |
| `frontend/src/assets/i18n/zh.json` | 1 | 7 |

- `git status --porcelain`：仅 4 个业务文件 `M`、2 个 `.trellis/spec` 文档 `M`、任务目录 `??`，无其它未跟踪业务文件。
- 无 TS、module、app shell、后端、shared、主题、路由改动：`git diff --name-only -- frontend/src` 只列出上述 4 个文件；`footer.component.ts`、`footer.module.ts`、`app.module.ts`、`app.component.html`、`app.routing.module.ts`、`scss/`、`backend/`、`shared/` 均无 diff。
- 无版本号改动：`git diff --name-only` 中无任何 `package.json`；根与前端 `package.json` 版本仍为 `0.10.6`。
- `git diff --check` 无空白错误。
- 构建产物 `frontend/dist` 与缓存 `frontend/.angular` 均被 `.gitignore` 覆盖，未污染 `git status`。

**并发观察，非实现缺陷**：我首次记录 diff 时，12:25:40 左右 `git diff --stat` 恰为 4 个文件；12:26:08 与 12:26:19，`.trellis/spec/picsur-frontend/frontend/index.md` 与 `.trellis/spec/picsur-backend/backend/build-and-deploy.md` 被并发队友更新，现为 6 个文件。两处均为规范文档，非业务代码，内容与实现一致，且符合调研「收尾顺手更新 spec」的建议；提交前请 Lead 确认这两个文档的归属与提交范围。

### 2. 规范与 i18n 复核

- 模板不再引用 `app.footer.*`：`grep -rn "app\.footer\." frontend/src` 无匹配，exit 1；放宽到 `app\.footer` 也无匹配。
- 两本词典各删 4 键且键集合一一对应，值级对比结果如下：

| 词典 | HEAD 键数 | 现键数 | 删除键 | 新增 | 改值 |
|---|---|---|---|---|---|
| `en.json` | 247 | 243 | `app.footer.madeWith`、`app.footer.by`、`app.footer.demoVersion`、`app.footer.sourceCode` | 无 | 无 |
| `zh.json` | 247 | 243 | 同上 4 键 | 无 | 无 |

  扁平键集合对称：`onlyEn` 与 `onlyZh` 均为空；两份 JSON 均可被 `JSON.parse` 正常解析。
- `app.unknownVersion` 保留：`footer.component.ts:31` 仍引用；`en.json:5` 与 `zh.json:5` 均有该键。
- `<app-footer>` 仍在 DOM 中：`app.component.html:26` 未被改动；运行期 `document.querySelector('app-footer')` 命中且高 53px。
- 旧可见文案已从源码与产物消失：`frontend/src` 与 `frontend/dist` 中 grep `Made with`、`Source Code`、`源代码`、`演示版本`、`favorite_border`、`app.footer` 均无匹配。
- i18n 中已无任何 footer 相关键；`grep -rni footer frontend/src` 仅剩组件/模块的类名、选择器与注释。
- Prettier：`footer.component.html` 与 `footer.component.scss` 通过；`en.json` 与 `zh.json` 报格式问题，但用 HEAD 版本做对照同样报错，报错点是存量 `adminAlwaysAll` 缩进，不属本次引入，不构成打回项。
- 未新增依赖：diff 无 `package.json`、锁文件或依赖清单变化。

**非阻断观察**：`textarea` 外的死代码被刻意保留，含 `span.line` 与 `.heart` 两条 SCSS 规则、`footer.component.ts` 的 `version` getter 及 `InfoService` / `I18nService` 订阅、词典中的 `app.unknownVersion`。调研主方案明确「倾向保留以缩小 diff 并保留还原路径」，PRD 亦要求保留 `app.unknownVersion`，故不作为缺陷；如需零死代码可在后续任务清理。

### 3. 独立复跑

全部在本机离线执行，Node 20 + pnpm 9.6.0 口径，`export PATH="/root/picsur/.run/node20/bin:$PATH"`。

| 命令 | 退出码 | 耗时 | 结果摘要 |
|---|---|---|---|
| `pnpm lint` | 0 | 2.39s | 0 error / 9 warning，与调研基线一致；9 条均为存量告警 |
| `cd frontend && pnpm exec tsc -p tsconfig.app.json --noEmit` | 0 | 1.90s | 无输出 |
| `pnpm --filter picsur-frontend build` | 0 | 22.87s 墙钟，其中 `ng build` 自报 20.58s | 产物 `main.e7945a2e2b0d2916.js`、`styles.e69d10653664abda.css`；警告均为存量 sass deprecation、预算提示与 unused-file 提示 |

开发服务器 `pnpm --filter picsur-frontend start`：13.16s 编译完成并监听 4200，`Compiled successfully`。

### 4. 运行期几何断言

三条测量路径：旧构建基线为本机 all-in-one 实例 `127.0.0.1:8080`，版本 0.10.6，页脚仍有原文案；新构建分别取 `127.0.0.1:4200` 开发服务器与 `127.0.0.1:4300` 生产产物静态服务。视口均为 1600x857、DPR 1、语言 zh。

| 指标 | 旧构建 8080 基线 | 新构建 dev 4200 | 新构建 dist 4300 |
|---|---|---|---|
| `app-footer` top / height | 804 / 53 | 804 / 53 | 804 / 53 |
| `footer` 计算 height | 39 | 39 | 39 |
| `footer` margin-top | 14px | 14px | 14px |
| `footer` 可见文本 | 由 favorite_border 制作 zhemed - V0.10.6 - 源代码 | 空串 | 空串 |
| `footer` 子元素数 | 2 个 span | 0 | 0 |
| `.grow-full.relative` top / height | 96 / 708 | 96 / 708 | 96 / 708 |
| `grow` 高 = 视口高 - 149 | 是 | 是 | 是 |
| `.sidenav-content` top / height | 0 / 857 | 0 / 857 | 0 / 857 |
| `.header-spacer` top / height | 0 / 64 | 0 / 64 | 0 / 64 |
| `.centered` top / height | 101 / 698 | 101 / 698 | 101 / 698 |
| H1 top / height | 410 / 32 | 410 / 32 | 410 / 32 |

- 页脚无可见文本：`footer.innerText.trim()` 为空串、`textContent` 为空串；生产产物 AOT 已剥掉模板注释，`footer.innerHTML` 为 `<footer class="container"></footer>`；`app-footer` 内无文本节点。
- 盒模型核对：53 = 固定 39 + `margin-top: 1em` 的 14px；708 = 857 - 96 - 53；改动前旧页脚内容本身也是 39px，因此 53px 占位逐像素等价。
- 主界面未位移：主内容容器 `.centered` 与 H1 的 top、height 与旧构建基线完全相同，0 像素差异。
- 其它路由不受影响：在生产产物上直接打开 `/error/404`，`app-footer` 仍为 53px、`grow` 仍为 708 且满足视口高减 149、页脚无文本，说明外壳级改动无路由副作用。
- 截图人工核对：上传页 1600x857 截图中页脚区域为纯背景，无任何文字。

### 5. 产物核对

- `frontend/dist` 全量 grep：`Made with`、`Source Code`、`源代码`、`演示版本`、`favorite_border`、`app.footer` 均无匹配。
- `height:39px` 已进入产物：命中 `frontend/dist/main.e7945a2e2b0d2916.js`。
- `dist/assets/i18n/en.json` 与 `zh.json`：均 243 键、无 `app.footer` 键、保留 `app.unknownVersion`，与源码一致。
- `dist/index.html` 的 mtime 为本次构建时间 12:27:13，确认为本轮独立复跑产物，不是实现轮旧产物。

### 6. 兼容性

- `<app-footer>` 组件与选择器未被删除，`app.module.ts` 的 `FooterModule` 注册、`footer.module.ts` 声明均未改动。
- 无其它组件引用 `app.footer.*` 或页脚文本，无路由或主题依赖页面底部文案。
- 旧版本号观测点消失属预期行为，已在残留风险中记录替代观测方式。

## 三、与 PRD 逐条对照

| 验收项 | 结果 | 证据 |
|---|---|---|
| 页脚文字不可见、呈现空白 | 满足 | footer innerText 空串，产物内无旧文案，截图为纯背景 |
| 页脚高度与改动前一致 | 满足 | app-footer 53px，前后一致，53 = 39 + 14 |
| 主界面元素位置不变 | 满足 | `.centered` 101/698、H1 410/32 与旧构建逐值一致 |
| 改动范围只含页脚相关文件与词典清理 | 业务代码满足 | `frontend/src` 下恰好 4 个文件；无 TS、module、路由、主题、后端、shared、版本号改动 |
| 前端 lint 或类型检查通过、构建通过 | 满足 | 三条命令 exit 0，耗时见第二节第 3 小节 |
| 无业务逻辑、后端、部署配置改动 | 满足 | diff 名称清单与依赖清单均无相关文件 |

**与 PRD 的文本偏差**：PRD `Notes` 称「2026-10-15 与 2026-10-16 两轮曾去掉页脚后又还原」；调研已独立纠正为 2026-10-13 的 `10-13-remove-footer` 与 `10-13-restore-footer`，我在 git log 上复核了页脚提交序列，与调研一致。该偏差属 PRD 历史线索描述，不影响本次验收口径。

**测试路径差异**：开发服务器与生产产物服务均在无后端 API 的环境下测量，`/api/*` 返回 404 或 SPA 回落；这不影响外壳与页脚几何，因为页脚已不依赖 `InfoService`，且上传页主容器照常渲染。两条路径的几何数值完全一致，可排除「开发模式样式注入导致假通过」的可能。

## 四、残留风险

| 风险 | 等级 | 说明与建议 |
|---|---|---|
| 窄屏与大字号下的历史换行差异消失 | 低 | 旧页脚在 zh 视口小于约 292px、en 小于约 370px 时会换行成 73px；新实现固定 53px。默认桌面 1600 宽与常见手机宽度均不受影响，且与用户「清空文字、保留原高度」口径一致。若后续要求任意宽度像素级还原，需改用调研的 visibility 备选方案。本轮常驻浏览器视口固定 1600x857，未独立复测窄屏。 |
| 39px 固定值依赖推导前提 | 低 | 39 = 原 p 高 27 + Material `mat-typography` 下边距 12；`margin-top: 1em` 依赖 body 14px 字号。SCSS 注释已写明推导；改动 body 字号或页面排版时需复量 app-footer 是否仍为 53px。 |
| 刻意保留的死代码与死样式 | 低 | `span.line`、`.heart` 规则与 `footer.component.ts` 的 `version` getter、两个订阅、`app.unknownVersion` 词条已无可见输出。属调研主方案刻意保留，缩小 diff 且便于将来还原；建议后续任务统一清理。 |
| 版本号观测点消失 | 中 | 后续升级验收改读 `/api/info` 或设置页「关于」。相关 spec 行已被并发更新，提交前需确认包含该文档改动。 |
| 并发 spec 文档归属 | 中 | 两个 `.trellis/spec` 文档于验证期间被并发更新，非业务代码；请 Lead 确认是否随本次任务提交，并避免 revert 时误伤。 |
| 环境残留 | 无 | 4200 开发服务器与 4300 临时静态服务已终止，端口已释放；测试标签已关闭；临时脚本已删除。仅保留前端构建产物 `frontend/dist` 与缓存 `frontend/.angular`，两者均已 gitignore。 |

## 五、命令与产物摘要

```text
# 环境
node -v  → v20.20.2        pnpm -v → 9.6.0

# 校验
pnpm lint                                                    exit 0   2.39s   0 error / 9 warning
cd frontend && pnpm exec tsc -p tsconfig.app.json --noEmit   exit 0   1.90s
pnpm --filter picsur-frontend build                          exit 0   22.87s wall
pnpm --filter picsur-frontend start                          dev server 4200, compiled in 13.16s
node /tmp/serve-dist.cjs                                     dist static server 4300, SPA fallback

# 关键断言结果
app-footer height = 53      grow height = 708 = 857 - 149      grow top = 96
footer computed height = 39  footer margin-top = 14px          footer innerText = ""
.centered top/height = 101/698    h1 top/height = 410/32       与旧构建逐值一致
dist grep 旧文案 / app.footer = 无匹配    dist 内 height:39px = 命中
```

本报告是本轮唯一写入的文件；未修改任何业务代码、规范文档或构建配置。
