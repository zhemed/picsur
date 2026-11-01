# 修复热部署后前端资源被 SPA 回退吞掉

## 状态

已修复并验证通过。容器已重启，静态插件重新注册全部前端资源，页面正常渲染。

## 现象

用户部署后打开本机 8080 页面一直停在「加载中」转圈。bw 无缓存复现：body 文本「加载中」，app-root 未渲染。

## 根因

- 后端 @nestjs/serve-static v12 的 FastifyLoader 在启动时以 `wildcard: false` 注册 @fastify/static，每个静态文件路由在启动瞬间一次性建立，之后磁盘新增文件不会被服务。
- 时间线：容器 07:01:48 重启时容器内仍是旧前端；新 `frontend/dist` 是重启之后才 docker cp 进去的。
- 结果：新构建 6 个文件 main.08f0a58b5fff6c5b.js、runtime.c26db0accd868ead.js 与 4 个懒加载 chunk 没有路由，请求命中 SPA fallback，返回 index.html 且状态 200、Content-Type 为 text/html；浏览器把 HTML 当 JS 解析失败，Angular 永不启动。
- 旧文件因启动时已注册，返回正常 application/javascript。
- 排除浏览器缓存与文件缺失：旧 index 引用的旧资源都正常，新文件在容器磁盘上存在。

## 修复动作

- 用户弹窗授权服务单元重启后执行 `docker restart picsur`，容器 StartedAt 更新为 2026-11-01T07:15:12Z，静态插件按当前 `frontend/dist` 重新扫描注册。
- 未回滚、未改仓库、未重建镜像、未动数据卷。

## 验证结果

- 新构建 163 个静态文件逐个请求，Content-Type 全部正确，mismatched=0；此前 6 个文件现均返回 application/javascript，大小与构建产物一致。
- bw 无缓存打开：app-loader 消失；/upload 渲染「上传媒体」；/images/1 正常渲染「您的图片」并显示原有图片；页面内动态 import 成功。
- `/api/info` 200、容器 healthy、日志无错误；管理员登录 201。
- 视频冒烟：mp4 与 webm 上传 201、直链 200 且 Content-Type 正确、字节一致、删除后 404；测试行已清理。

## 验收

- [x] 全部静态文件 Content-Type 正确，无 text/html 回退。
- [x] bw 打开页面正常渲染，console 无脚本解析错误。
- [x] /api/info 200、容器 healthy、管理员可登录。
- [x] 视频上传冒烟通过且测试数据已清理。

## 教训与后续

- 部署顺序铁律：先更新 `frontend/dist`，再启动或重启后端；反向顺序会复现本问题。
- 热部署仍非持久发布方式，镜像未更新，容器重建会回落旧版；建议后续用 `support/release-local.sh` 发布镜像。
- allinone 启动 banner 会把管理员口令写入容器日志，属既有设计，建议限制日志访问。
