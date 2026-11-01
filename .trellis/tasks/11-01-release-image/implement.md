# 实施计划

## 1. 入库

- [ ] 提交全部改动，锚点 [task:11-01-release-image]。
- [ ] push origin master。

## 2. 构建

- [ ] 检查 ghcr 登录状态与网络；记录版本号与远端 tag 情况。
- [ ] 运行 support/release-local.sh（或等价构建）生成普通镜像与 allinone 镜像。
- [ ] 记录镜像 ID、标签、大小；若推送失败记录原因。

## 3. 切换容器

- [ ] 备份旧容器 docker inspect 配置到 /root/picsur-data/backups/。
- [ ] 停旧容器、用新镜像重建，保持端口、/data 挂载、restart always、env 与 docker.sock 挂载。
- [ ] 失败时按备份配置恢复旧容器。

## 4. 验证

- [ ] 健康、登录、图片数据、视频回归 260 passed 加 1 SKIP、mov 与 mkv 抽查、mp4 与 webm 播放、Range 206。
- [ ] 清理测试数据，记录镜像与备份位置。

## 回滚

- 恢复旧容器：按备份 inspect 配置 docker run 旧镜像，或保留旧容器改名后重新 start。
