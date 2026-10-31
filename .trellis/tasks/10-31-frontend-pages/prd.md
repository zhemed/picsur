# 前端七页复刻与视觉验收

## Goal

按现有 Angular 版本逐页复刻七个页面域，以页面、路由、i18n 文案与交互为验收基准。

## Deliverables

- upload：拖拽上传、格式与体积校验、进度与取消。
- processing：转换参数交互与结果预览。
- view：单图查看、分享链接、删除确认。
- images：图库、分页、搜索、筛选、批量删除。
- user：登录、注册、个人资料、权限展示。
- settings：系统偏好、用户偏好、关于与升级入口。
- errors：401、404、删除成功与删除失败。
- QOI WASM 解码与图片展示链路：HEAD 探测、`/i/meta` 轮询、错误占位图。

## Acceptance Criteria

- [ ] 七页功能清单逐条通过手工回归，交互行为与现有版本一致。
- [ ] `support/visual-contrast-probe.cjs` 结果与现有版本一致，无新增对比度失败。
- [ ] `support/gallery-layout-probe.cjs` 图库布局断言通过。
- [ ] en / zh 两份词典逐键复用，用户可见文案零改写。
- [ ] QOI 图片在主流浏览器内正常解码显示，删除后展示 404 占位。
- [ ] 分享链接域名逻辑与 `host_override` 语义一致。

## Dependencies

依赖 07 前端骨架、03 鉴权、04 图片读路径；写路径可先对 Node 实例联调。
