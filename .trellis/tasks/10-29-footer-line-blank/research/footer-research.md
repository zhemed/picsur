# Research: 页脚来源行的实现、布局占位与历史坑点

- Query: 把页脚「由 ♥ 制作 zhemed · V0.10.6 · 源代码」这一行去掉并替换为空白；其余 UI 不得变动，主界面不能因此位移。
- Scope: internal 源码检索 + 本机真机测量（只读，未改任何源码/配置/依赖）
- Date: 2026-10-29
- 测量环境: 常驻浏览器 Chromium 153，视口 1600x857，DPR 1；被测实例为本机 all-in-one 容器 `127.0.0.1:8080`，版本 0.10.6，语言为默认 zh；仓库 HEAD `007b592`，`git log --oneline fe4f837..HEAD -- frontend/src` 为空（0.10.6 发版后前端源码无改动，故线上测量与仓库源码一致）。

## 一、页脚实现位置

### 1. 文件清单

| 文件路径 | 行号 | 说明 |
|---|---|---|
| `frontend/src/app/components/footer/footer.component.html` | 1-24 | 页脚模板，全部可见文本都在这里 |
| `frontend/src/app/components/footer/footer.component.scss` | 1-20 | 页脚布局：`footer` flex 列居中、`margin-top: 1em`、`span.line` inline-block、`.heart` 图标 22px |
| `frontend/src/app/components/footer/footer.component.ts` | 11-63 | 组件逻辑：版本 getter、demo 标记、语言/服务端信息订阅 |
| `frontend/src/app/components/footer/footer.module.ts` | 1-11 | 声明并导出 `FooterComponent`，导入 `CommonModule` 与 `I18nModule` |
| `frontend/src/app/app.component.html` | 26 | `<app-footer></app-footer>`，全仓库唯一渲染点 |
| `frontend/src/app/app.component.scss` | 1-24 | 外壳布局：`.sidenav-content` 为 flex 列且 `height: 100%`；`.grow-full` 为 `flex-grow: 1`；`.header-spacer` 64px + 32px 下边距 |
| `frontend/src/app/app.module.ts` | 10、32 | 导入 / 注册 `FooterModule` |
| `frontend/src/assets/i18n/en.json` | 6-11 | `app.footer.*` 四个键与 `app.unknownVersion` 第 5 行 |
| `frontend/src/assets/i18n/zh.json` | 6-11 | 同上，中文词典 |
| `frontend/src/index.html` | 37 | `<body class="mat-typography mat-app-background">`，决定页脚继承 14px/20px 字体与 `p` 下边距 |

### 2. 渲染链路

模板逐行拆解 `footer.component.html`：

- 第 1 行 `<footer class="container">`，第 2-23 行 `<p>` 内两个 `span.line`。
- 第 4-13 行是第一个 span：`{{ 'app.footer.madeWith' | translate }}`（zh 为「由」）＋ 第 6 行心形 Material Icons 连字 `favorite_border`（`class="material-icons-outlined heart"`）＋ `{{ 'app.footer.by' | translate }}`（zh 为「制作」）＋ 第 8-10 行硬编码的 `https://github.com/zhemed` 链接与文本 `zhemed`；第 12 行 demo 实例追加 ` - Demo Version`，条件来自 `info.demo`。
- 第 15-22 行是第二个 span：第 16 行硬编码 `&nbsp; -`、第 17 行 `{{ version }}`、第 18 行硬编码 `-`、第 19-21 行硬编码的源代码链接 `https://github.com/zhemed/picsur` 与 i18n 文本 `app.footer.sourceCode`。
- 实际分隔符是半角连字符 `-`，不是用户描述里的 `·`；整行由两个 inline-block span 组成，窄屏时可能在两个 span 之间换行。

文本来源分三类：

- i18n 键，共 4 个：`app.footer.madeWith`、`app.footer.by`、`app.footer.demoVersion`、`app.footer.sourceCode`，en/zh 两个词典都齐全且一一对应。
- 硬编码：作者名 `zhemed`、两个 GitHub 链接、`-` 与 `&nbsp; -` 分隔符、版本前缀 `V`。前端规范要求用户可见文案走 i18n，但这些属专有名词/符号，历次 i18n 补齐轮未纳入。
- 运行时数据：版本号来自 `FooterComponent.version` getter，`footer.component.ts:29-35` 在数据未到时返回 `app.unknownVersion`，到货后返回 `'V' + loadedVersion`；`loadedVersion` 由 `footer.component.ts:51-62` 订阅 `InfoService.live` 得到。服务端 `/api/info` 的 `version` 由 `backend/src/routes/api/info/info.controller.ts:42` 调用 `backend/src/config/early/host.config.service.ts:91-92`，最终读环境变量 `npm_package_version`，即根 `package.json` 的 `"version": "0.10.6"`。这就是 V0.10.6 的来源，本次页面没有 demo 后缀，说明 `info.demo` 为 false。
- 语言切换时 `footer.component.ts:42-49` 订阅 `I18nService.languageChange` 触发重渲染；`I18nModule` 由 `footer.module.ts:3、8` 提供 `translate` 管道。

结论：`V0.10.6` 不是写死的，是服务端版本；「源代码」是模板第 19-21 行硬编码链接配 i18n 文本；`♥` 是 `favorite_border` 图标连字，曾因文字可选中被用户复制成原始文本「favorite_border」，见第一节第 4 小节的历史指令。

### 3. 当前渲染实测

在 1600x857 视口、zh 语言、上传页测得：

```text
app-footer 元素       Display block，高 53px，宽 1296px，位置 top 804
footer 元素           display flex，flex-direction column，align-items center
                      margin-top 14px，计算高度 39px，padding 0 12px，text-align center
p 元素                高 27px，margin 0 0 12px，字体 14px/20px Roboto
span.line 第 1 个      宽 127.53px，高 27px
span.line 第 2 个      宽 115.41px，高 20px
文本内容              由 favorite_border 制作 zhemed - V0.10.6 - 源代码
文本单行总宽          约 243px
```

盒模型合成公式：`app-footer 53px = 14px 下移 + p 高 27px + p 下边距 12px`。其中 14px 是 `footer` 的 `margin-top: 1em` 在 body 字号 14px 下的值；27px 是心形图标参与行盒后 `.line` 被撑到的高度，`.heart` 自身 22px 高、22px 行高；12px 来自 Angular Material 的内置规则 `.mat-typography p { margin: 0 0 12px }`，因为 `index.html:37` 给 body 加了 `mat-typography` 类，同时该类把 body 字号定为 `400 14px/20px Roboto`。

### 4. 历史指令原话（页脚文本的来历）

- `10-13-remove-footer/directive.md:8`：「不错，但是还有个问题，把由 favorite_border 制作 zhemed - V0.7.4 - 源代码去掉很影响观感」。
- `10-13-restore-footer/directive.md:8`：「哈哈哈哈哈，还是还原吧，回退0.7.4」。

这说明页脚这行曾被完整删掉过一次，用户随后要求还原；本次要求是「清空文字、保留原高度」的新口径，不等同于当年的整行删除。

## 二、布局占位与「清空文本但保留原高度」

### 1. 外壳 flex 关系

`frontend/src/app/app.component.html:7-28` 的结构：

```text
mat-sidenav-container.grow-full
  mat-sidenav
  mat-sidenav-content
    div.sidenav-content                        ← app.component.scss:20-24，flex 列 + height 100%
      div.header-spacer                        ← app.component.scss:9-13，64px 高 + 32px 下边距，flex-shrink 0
      div.grow-full.relative.container         ← app.component.scss:1-7，flex-grow 1，装 router-outlet
      app-footer                               ← 第 26 行，flex-grow 0
```

关键事实：

- `.sidenav-content` 是 `display: flex; flex-direction: column; height: 100%`，父级 `app-root` 也是 flex 列且 `height: 100%`（`frontend/src/scss/fixes.scss:1-17`）。
- 主区域 `div.grow-full.relative` 用 `flex-grow: 1` 吃掉剩余高度；页脚不参与拉伸，只按自身高度占位。
- 页脚是外壳级组件，所有路由页面共用；因此页脚高度变化会等量改变主区域可用高度。对 `height: 100%` 且内容垂直居中的页面，例如上传页的 `.centered`，会表现为内容整体上下偏移一半的差值。

### 2. 实测基线（1600x857，zh，上传页）

| 元素 | 位置 / 尺寸 |
|---|---|
| `.sidenav-content` | top 0，高 857，即视口高 |
| `.header-spacer` | top 0，高 64 |
| `.grow-full.relative` | top 96，高 708，即 857 - 96 - 53 |
| `app-footer` | top 804，高 53 |
| `.centered` 内容容器 | top 101，高 698 |
| `.centered` 首个子元素 H1 | top 410，高 32，中心 Y 426 |

### 3. 换行与视口宽度

页脚文本在两个 span 之间可以换行，换行后 `app-footer` 从 53px 变 73px。用同源 iframe 加载真实应用逐宽度实测：

| 视口宽 | zh 页脚高 | en 页脚高 |
|---|---|---|
| 375 | 53 | 53 |
| 360 | 53 | 73 |
| 320 | 53 | 73 |
| 300 | 53 | 未测 |
| 291 | 53 | 未测 |
| 280 | 73 | 未测 |

按文本宽度换算，单行所需视口下限约为 zh 292px、en 370px。也就是说 zh 默认语言下常见手机宽度都不会换行，en 在小于约 370px 的视口会变成两行，例如 360 宽手机。

### 4. 各做法对主区域的影响（实测/推导）

以 1600x857 上传页为基准，`grow` 指 `.grow-full.relative` 高度，H1 位移指垂直中心变化：

| 做法 | app-footer 高 | grow 变化 | 实测 H1 位移 | 结论 |
|---|---|---|---|---|
| 保持现状 | 53 | 0 | 0 | 基准 |
| 删除 `<app-footer>`，即 10-13 的做法 | 0 | +53 | +26.5px | 明确违反本次要求，当年也因此被用户要求还原 |
| 只删 footer 内容，保留空 footer | 14 | +39 | 推导 +19.5px | 高度塌陷，不可用 |
| 保留 p 但清空 p，留空 p 自带 12px 下边距 | 26 | +27 | 推导 +13.5px | 不可用 |
| p 内只放 `&nbsp;` | 46 | +7 | 实测 +3.5px | 仍会位移，不可用 |
| 原文全部隐藏，p 设 visibility hidden | 53 | 0 | 实测 0 | 高度精确，但文本仍在 DOM |
| 清空模板 + footer 固定高度 39px | 53 | 0 | 实测 0 | 推荐，见第五节 |

以上「实测」来自在线上页面临时改 DOM 后立即复位，复位后已核对 `app-footer` 高 53、`p` 文本与行内样式均恢复原样。

### 5. 「只清空文本、保留原高度」的最小做法

做法是让 `footer` 自身保持原来由内容撑出的 39px 高度：

```scss
footer {
  /* 原页脚内容高 39px：心形图标撑出的 27px 行盒 + Material 给 p 的 12px 下边距。
     清空文字后写死这 39px，保证 app-footer 仍是 53px（39 + 14 的 margin-top）。 */
  height: 39px;
}
```

模板只留空 `<footer class="container">`，不再渲染 `p`。`margin-top: 1em` 保留，因此 `app-footer` 总占位仍是 `14 + 39 = 53px`。此做法已在线上 DOM 里验证：footer 设 39px 高度并移除 p 后，`app-footer` 高 53、`grow` 高 708、H1 中心 426，与改动前完全一致。

### 6. 备选做法与风险

- 备选 A：保留原模板，只给内容加 `visibility: hidden`。所有宽度、语言、缩放下高度都精确不变，因为排版算法完全没变；但文本仍留在 DOM 与产物里，用户复制页面不会得到它、屏幕读者也不会读它，代价是与「清空文字」的字面口径不一致，词典键也仍需保留。
- 备选 B：固定高度搭配媒体查询，例如窄屏补到 59px。zh 与 en 的换行阈值不同，且桌面缩放下等价宽度也会变化，无法同时覆盖，不建议。
- 备选 C：删掉 `<app-footer>` 再在 `app.component.html` 或外壳 SCSS 里加一个 53px 占位 div。改动扩散到全局外壳，且把 53px 写进与页脚无关的文件，同等风险下更脏，不建议。
- 备选 D：`display: none` 或 `height: 0`。高度直接消失，必然位移，不可用。

## 三、历史坑点

### 1. 页脚相关 git 提交

| 提交 | 日期 | 内容 | 与本次的关系 |
|---|---|---|---|
| `11535b1` | 2026-10-13 | 把页脚 `Made with` / `by` / `Demo Version` / `Source Code` 接上 i18n，新增 `app.footer.*` 与 `app.unknownVersion`，OnPush 下订阅 `languageChange` | 说明模板文本现已全走 i18n，清空模板会留下 4 个孤儿键 |
| `8ee0d99` | 2026-10-13 | feat(ui): drop the footer，删掉 `app.component.html:26` 的 `<app-footer>` 与 `app.module.ts` 的 `FooterModule`，版本 0.7.5 | 当年的「整行删除」路线，导致主区域可用高度增加 53px |
| `f514f11` | 2026-10-13 | revert(ui): bring the footer back，还原 `app-footer` 与 `FooterModule` | 用户改主意后整行还原；本次不能再犯整行删除 |
| `98710bf` | 2026-10-13 | 发布 0.7.6 | 还原后重新发版 |
| `d977a31` | 2026-10-15 | `InfoService.live` 未加载返回 null，页脚在服务端信息未到时显示「未知版本」占位 | 页脚与 InfoService 的耦合点；清空模板后这段逻辑变成无效代码 |
| `b209624` | 2026-10-15 | Angular 18 → 19 升级，给页脚组件补 `standalone: false` | 页脚随 Angular 主版本才动过，样式数值稳定 |

### 2. 归档任务与用户原话

- `10-13-remove-footer`：需求是把整行去掉；改动范围写明 `app.component.html:26` 与 `app.module.ts` 的 `FooterModule`，组件文件保留。其 `prd.md:16` 验收项 AC2 特意写了「内容区高度/滚动正常（上传框仍垂直居中、无多余空白）」，说明当年就意识到删页脚会改变主区域高度，只是口径是「接受变化并确认居中正常」。
- `10-13-restore-footer`：用户原话「还是还原吧」；`prd.md:5` 用 `git revert 8ee0d99` 还原，`prd.md:14` AC3 要求在真实实例上确认 `app-footer` 非 null、那行文字回来、版本正确。执行记录在 `.trellis/workspace/zhemed/journal-1.md` 第 305-325 行（Session 14）与第 328-348 行（Session 15）。
- 还原轮踩的两个坑，`journal-1.md:338` 原文记录：① 被 revert 的提交夹带 Trellis 任务目录归档移动，revert 出现 rename/delete 冲突；② revert 把同一提交里的版本号一并退回 0.7.4，发布脚本因此按旧版本重推标签，版本标签短暂不单调。教训是 revert 前先看提交是否夹带版本号与任务目录等非功能改动。
- 口径校正：PRD `Notes` 写「2026-10-15 与 2026-10-16 两轮曾去掉页脚后又还原」，按 git log 与 `.trellis/tasks/archive/2026-10/` 实测，去掉与还原都发生在 2026-10-13，任务目录分别是 `10-13-remove-footer` 与 `10-13-restore-footer`；10-15 只改过页脚 TS 的 null 处理，10-16 没有页脚任务。
- `11535b1` 之前，页脚文本是硬编码英文；`.trellis/tasks/archive/2026-10/10-13-v070-upgrade-i18n/prd.md` 明确把「页脚品牌行」列为硬编码补齐对象。本次若清空模板，4 个 `app.footer.*` 键会变成无引用，需要按前端规范「删功能要清干净」同步清理 en/zh 两本词典。

### 3. 其它相邻历史经验

- 页脚版本号曾长期被当作升级验收的观测点，例如 `journal-1.md:246` 记录「页面页脚显示 V0.7.2」，Session 15 也以「底部那行文字在、版本 0.7.6」作验收证据。清空后这条观测点消失，后续升级验收需改用 `/api/info` 或设置页「关于」里的版本区块，`settings-about.component.ts:122` 已有版本来源。
- 发布/验证时要绕开浏览器缓存，`journal-1.md:269` 有明确教训：旧 bundle 会让人误判改动没生效。
- 前端构建产物挂进容器验证时，rebuild 后必须重启容器，因为 Angular 会先 `rm -rf dist` 导致挂载 inode 失效，见 `.trellis/spec/picsur-backend/backend/build-and-deploy.md` 中 6.1 节「挂 dist 进容器验证」的第二条。
- `.trellis/spec/picsur-backend/backend/build-and-deploy.md:340` 写着「版本线……`/api/info` 与前端页脚都读它」；清空页脚后这句会过时，收尾时应顺手更新 spec。

## 四、验证命令

### 1. 环境契约

Node 20 与 pnpm 9.6.0 是硬约束，见 `.trellis/spec/picsur-frontend/frontend/index.md:29-30` 与 build-and-deploy 第 2 节：

```bash
export PATH="/root/picsur/.run/node20/bin:$PATH"
node -v    # 实测 v20.20.2
pnpm -v    # 实测 9.6.0，仓库用 corepack 固定
```

宿主默认 Node 24 装不了依赖也不能作为构建口径；本机 `node_modules` 已就绪，本轮无需安装依赖。

### 2. 最小验证命令与耗时

按本次只改前端页脚的边界，最小命令集如下，全部可在本机离线执行：

| 目的 | 命令 | 预期耗时 | 离线 | 说明 |
|---|---|---|---|---|
| Lint | `pnpm lint` | 本轮实测 2.35s | 是 | 基线 0 error / 9 warning，均为存量；HTML 与 SCSS 不在 lint 范围，本改动理论上不新增 lint 问题 |
| 类型检查 | `cd frontend && pnpm exec tsc -p tsconfig.app.json --noEmit` | 本轮实测 1.92s | 是 | 只查 TS，不校验 Angular 模板，不能替代构建 |
| 前端构建，真正的模板与样式门禁 | `pnpm --filter picsur-frontend build` | 历史实测 18.8-19.0s；当前 Angular 21 预估 25-60s | 是 | 脚本先 `rm -rf dist .angular`，每次都是冷构建；会写 `frontend/dist`，属实现轮的正常产物 |
| 全量三包构建 | `pnpm build` | 历史 shared 1.6-1.7s + backend 3.0-3.2s + 前端 | 是 | 仅当连带改版本号或共享包时需要；顺序必须 shared → backend → frontend |

历史耗时出处：`10-13-handover-baseline/research/smoke.md:130-136` 记录 frontend 19.0s、shared 1.7s、backend 3.2s；`10-13-dep-security-upgrade/research/t0-l1-smoke.md:67-71` 记录 frontend 18.8s、shared 1.6s、backend 3.0s。当前仓库已是 Angular 21.2.25，本轮按调研写盘限制未复跑构建，25-60s 为估算，构建后以实际输出为准。`.angular` 缓存当前 82MB，但构建脚本每次先删除它，缓存基本不生效。

需要外网的步骤只有：`pnpm install --frozen-lockfile`、`bash support/audit-prod.sh`、Docker 发布与升级。本次改动无需依赖变更，审计与安装都不必跑。

CI 等价链路见 `.github/workflows/ci.yml`，顺序是装依赖、`pnpm build`、审计、`pnpm lint`；本地最小复现取其中的 lint 与前端构建即可。

可选格式检查：`pnpm exec prettier --check frontend/src/app/components/footer frontend/src/assets/i18n/en.json frontend/src/assets/i18n/zh.json`，本轮实测 0.64s，离线。注意两本词典在 HEAD 上本就不合约：各有一处缩进错误，`adminAlwaysAll` 行，因此 check 会报 2 个文件失败；这不是本次改动引入的。可以不动，若要顺手 `--write` 只会多 2 行修复，但不要跑全仓 `pnpm format`。

### 3. 运行期几何断言

构建通过只证明能编译，是否「主界面不位移」要在浏览器里量。可用常驻浏览器：

```bash
# 1) 起一个能拿到改后产物的页面：开发服务器最轻，shell 与页脚不依赖 API
pnpm --filter picsur-frontend start      # ng serve，默认 4200
bw open http://127.0.0.1:4200/upload --new --wait=4000
```

```javascript
// 2) 断言页脚空白且占位与基线一致
(() => {
  const af = document.querySelector('app-footer');
  const footer = af && af.querySelector('footer');
  const grow = document.querySelector('.grow-full.relative');
  return {
    footerText: footer ? footer.innerText.trim() : null,
    appFooterH: af.getBoundingClientRect().height,
    growH: grow.getBoundingClientRect().height,
    growTop: grow.getBoundingClientRect().top,
  };
})()
```

判据：视口 1600x857、zh 下 `appFooterH` 为 53、`growH` 为 708、`growTop` 为 96，且 `footerText` 为空串。开发服务器下 API 请求会 404，版本占位不影响页脚高度，因为改后页脚不再引用版本；若要在真实页面上比对上传框位置，建议在本机另起端口加载构建产物，或用 bind mount 方式挂进临时容器并在 rebuild 后重启容器，命令形态见 build-and-deploy 中 6.1 节「挂 dist 进容器验证」。发布到实例后验收时，用带 `?v=<新版本>` 的地址或新标签页绕缓存。

## 五、推荐方案

### 1. 主方案：清空模板 + 固定 footer 高度 39px + 清理 4 个 i18n 键

改动范围只有前端页脚相关文件，不动外壳、后端、共享包、主题与路由：

1. `frontend/src/app/components/footer/footer.component.html` 第 1-24 行整体替换为空页脚，保留 `<footer class="container">` 并写清意图注释：

   ```html
   <footer class="container">
     <!-- 来源行已移除；保留 footer 骨架与高度，避免主区域位移。
          高度口径见 footer.component.scss 的注释。 -->
   </footer>
   ```

2. `frontend/src/app/components/footer/footer.component.scss` 在 `footer` 规则里增加 `height: 39px;` 与推导注释。39 = 原 `p` 高 27 + Material 给 `p` 的 12px 下边距；再加原有 `margin-top: 1em` 的 14px，`app-footer` 总占位仍是 53px。`span.line` 与 `.heart` 规则可保留，也可在同一文件里顺手删掉，均不影响其它 UI；倾向保留以缩小 diff。
3. `frontend/src/assets/i18n/en.json` 与 `zh.json` 删除 `app.footer` 整块 4 个键，两本词典同步删，保持键一一对应。`app.unknownVersion` 暂不删：`footer.component.ts:31` 仍引用它。
4. `footer.component.ts`、`footer.module.ts`、`app.module.ts` 不改。保留组件逻辑的代价只是两个不再有可见输出的订阅，收益是 diff 最小且将来若要还原来源行只需回退模板与词典两处；历史已出现过去掉又还原的先例。

若评审更倾向零死代码，可加做可选清理：删 `footer.component.ts` 里 `version`/`isDemo`/两个订阅与 `InfoService`、`I18nService` 注入，`footer.module.ts` 去掉 `I18nModule`，并从两本词典再删 `app.unknownVersion`。这会扩大 diff，但行为等价，`/api/info` 仍由 `InfoService` 自身其它调用方使用，不会少一次请求。

### 2. i18n 同步结论

- 不需要新增任何键，也不需要改文案；需要的是删除 `app.footer.madeWith`、`app.footer.by`、`app.footer.demoVersion`、`app.footer.sourceCode`，且 en 与 zh 必须同一次改动里删干净，删后复核 `grep -rn "app.footer\." frontend/src` 无残留。
- 若按第五节第 1 小节的主方案保留 `footer.component.ts` 不动，则 `app.unknownVersion` 保留，词典删除后两本仍一一对应。
- 验证可用只读命令比对两本词典的扁平键集合：

  ```bash
  node -e 'const fs=require("fs");const flat=(o,p="")=>Object.entries(o).flatMap(([k,v])=>v&&typeof v==="object"?flat(v,p+k+"."):[p+k]);const en=flat(JSON.parse(fs.readFileSync("frontend/src/assets/i18n/en.json"))).sort();const zh=flat(JSON.parse(fs.readFileSync("frontend/src/assets/i18n/zh.json"))).sort();console.log("en",en.length,"zh",zh.length,"onlyEn",en.filter(k=>!zh.includes(k)),"onlyZh",zh.filter(k=>!en.includes(k)))'
  ```

### 3. 风险评估

| 风险 | 等级 | 说明与缓解 |
|---|---|---|
| 39px 写死随字体主题漂移 | 低 | 数值来自当前 Material 排版与图标字体；若日后改 body 字号或图标字号，需同步这个值。注释已写明推导，构建后几何断言兜底 |
| 窄屏换行差异 | 低 | zh 在视口小于约 292px、en 小于约 370px 时原页脚是 73px；固定 53px 后这些极端宽度下主区域会多 20px。默认语言 zh 的常见手机宽度不受影响；若要求任何宽度都像素级一致，改用第五节第 4 小节的 visibility 方案 |
| 用户缩放或最小字号 | 低 | 浏览器放大缩小等价于视口变窄，极端情况下触发上述换行差异 |
| 版本号观测点消失 | 中 | 页脚不再显示版本，后续升级验收需改用 `/api/info` 或设置页「关于」；相关流程文档与 spec 第 340 行需同步 |
| revert 不干净 | 中 | 历史教训是提交里夹带版本号与任务目录导致 revert 冲突；本次实现提交应只含页脚模板、样式与两本词典，版本号与任务归档分开提交 |
| 主区域轻微位移被漏检 | 低 | 构建后用第四节第 3 小节的几何断言复量 53 与 708 两个数即可，不必截图目测 |

### 4. 备选方案：原文保留并 visibility hidden

若口径允许文本留在 DOM，只求「视觉空白且任何宽度零位移」，可在 `footer.component.scss` 给 `footer > p` 加 `visibility: hidden`，模板与词典全部不动。实测高度 53、grow 708、H1 中心 426 与改前完全一致；缺点是文本仍在页面源码与构建产物里，且不符合 PRD R4 的词典清理口径。仅在主方案第 2 条固定高度被否决时采用。

## Caveats / Not Found

- 「10-15 与 10-16 两轮去掉又还原」在 git log 与归档目录里不存在；实际是 2026-10-13 的 `10-13-remove-footer` 与 `10-13-restore-footer`。10-15 仅 `d977a31` 触及页脚 TS 的 null 语义，10-16 无页脚任务。
- 本轮未复跑构建，构建耗时取 2026-10-13 两次独立任务的实测值并标注当前版本估算；原因是调研写盘范围限制，不允许写 `frontend/dist` 与 `.angular`。
- 本轮未做外部检索；`mat-typography p` 下边距与 body 字号结论来自线上页面样式表实测与仓库内 `index.html` 事实。
- `.env` 与 `.env.example` 等凭据文件按红线未读取；验证命令与结论只依赖仓库内源码与 spec 事实。
- 线上测量用的是常驻浏览器对 `127.0.0.1:8080` 的只读评估，临时 DOM 修改均已复位，未改任何持久状态。
