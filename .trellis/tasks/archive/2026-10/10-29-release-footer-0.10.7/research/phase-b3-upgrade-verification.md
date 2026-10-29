# Phase B3 升级留痕：本机 8080 实例升级到 0.10.7

- 任务：`10-29-release-footer-0.10.7` Phase B3，team task `task-15`
- 执行人：release-executor，Trellis implement 子代理
- 时间：2026-10-29 13:52 至 13:58 UTC
- 范围：仅升级本机 all-in-one 实例并做页面验收；未改代码、未重新发布镜像、未删旧 0.10.6 标签、未改数据目录内容

## 1. 升级前取证

| 项 | 值 |
| --- | --- |
| `/api/info` | version `0.10.6`，production `true`，demo `false` |
| 容器名 | `picsur`，容器 ID `477e9cf5ea29…`，`Up 9 days (healthy)` |
| 镜像引用 | `ghcr.io/zhemed/picsur:allinone`，Image ID `sha256:4dd8bd40598b1657…` |
| 端口映射 | `8080/tcp` → `0.0.0.0:8080` 与 `[::]:8080`，HostIp 空 |
| 重启策略 | `always` |
| 挂载 | `/root/picsur-data:/data` RW，`/var/run/docker.sock:/var/run/docker.sock` RW |
| 网络模式 | `bridge`，非 privileged，无额外 Hosts/DNS/Ulimits/CapAdd |
| 环境变量 | 15 个键与镜像默认 Env 完全一致，无运行时额外 `-e` |
| 健康检查 | 镜像自带 `wget /api/info`，间隔 15s，StartPeriod 90s |
| 数据目录 | `/root/picsur-data`，47M，`allinone.env` 0600 |
| 迁移数 | `12` |
| 图片数 | `/api/image/list`：total `1`，首页 1 条，pages `1` |
| 管理员登录 | 登录成功，token 长度 188 |

## 2. 新镜像

`docker pull ghcr.io/zhemed/picsur:allinone` 退出 0，`Status: Image is up to date`，digest 为 **`sha256:3c6bcf7fc981e9805618ea9506ed28b5c9bd42b6008010bd996be6e1ef917aab`**，与发布记录一致。

## 3. 升级步骤

先做逻辑备份：`docker exec picsur pg_dump -U picsur -d picsur > /tmp/picsur-pre-0107.sql`，退出 0，17693 字节，含 10 个 `CREATE TABLE`。

重建容器，只替换镜像，其余 HostConfig 原样：

```bash
docker stop picsur
docker rename picsur picsur-prev-0106
docker run -d --name picsur --restart always -p 8080:8080 \
  -v /root/picsur-data:/data \
  -v /var/run/docker.sock:/var/run/docker.sock \
  ghcr.io/zhemed/picsur:allinone
```

新容器 ID `2d5ecde4928e…`；3 次轮询后 `/api/info` 即返回 `0.10.7`。

## 4. 验收结果

| 项 | 结果 |
| --- | --- |
| `/api/info` | version **0.10.7**，production `true`，demo `false` |
| 容器状态 | `picsur` `Up (healthy)`，镜像 `ghcr.io/zhemed/picsur:allinone` |
| 镜像 ID / digest | `sha256:3c6bcf7fc981…`，RepoDigest `…@sha256:3c6bcf7fc981…` |
| 端口 / 重启策略 / 挂载 / 网络 | `0.0.0.0:8080`、`always`、`/root/picsur-data:/data` 与 docker.sock、`bridge`，与升级前一致 |
| 图片数 | total `1`，首页 1 条，pages `1`，与升级前一致 |
| 迁移数 | `12` |
| 页脚 | `app-footer` 文本长度 **0**，高度 **53** |
| 设置页关于 | 当前版本 **0.10.7**、最新版本 **0.10.7**、「当前已是最新版本」 |
| 日志 | 无 error/fatal 行，`Nest application successfully started` |
| 截图 | `research/verify-instance-footer-0107.png`、`research/verify-instance-about-0107.png` |

## 5. 异常与说明：回滚容器被新实例自动清理

按计划保留 `picsur-prev-0106` 作为回滚窗口，但新实例启动约 2 秒后，应用自身的自升级恢复逻辑把旧容器删除了：

```text
[Nest] SelfUpdateService WARN Removed leftover container picsur-prev-0106 (interrupted update)
```

`docker events` 佐证：`stop name=picsur` 与 `destroy name=picsur-prev-0106` 相隔 5 秒，无 `prune` 事件。源码依据：`backend/src/managers/update/self-update.service.ts` 的 `cleanupLeftovers()` 会删除同 lineage 下处于停止状态的 `<base>-prev-*` 容器，判定为「中断升级的残留」。

由此产生两点影响：

- 手动 rename 方案的回滚窗口实际只有约 5 秒，新实例一起来就会清掉 `picsur-prev-0106`；本次验收全部通过，无需回滚，但这条经验应写进下次升级的操作要点。
- 旧 allinone 镜像 `sha256:4dd8bd40598b…` 在升级前就已不在本地镜像列表（重打标签后成为无标签镜像，被镜像存储回收；升级前已复核 `docker image inspect` 报 No such image）。因此无法按任务预期「保留旧 allinone 镜像」；旧**常规**镜像与标签 `0.10.6`、`v0.10.6` 仍在。

## 6. 回滚命令：升级后

数据侧安全网：`/tmp/picsur-pre-0107.sql`，`pg_dump` 于升级前、退出码 0；`0.10.6` 与 `0.10.7` 无新增迁移，数据双向兼容。

镜像侧旧 allinone 已不在本地，采用 runbook 6.6 路径三，从 ghcr 上仍在的 `v0.10.6` 常规镜像重建：

```bash
cd /root/picsur
docker pull ghcr.io/zhemed/picsur:v0.10.6
docker build -f Dockerfile.allinone \
  --build-arg PICSUR_BASE_IMAGE=ghcr.io/zhemed/picsur:v0.10.6 \
  -t picsur-allinone:rollback-0.10.6 .
docker rm -f picsur
docker run -d --name picsur --restart always -p 8080:8080 \
  -v /root/picsur-data:/data \
  -v /var/run/docker.sock:/var/run/docker.sock \
  picsur-allinone:rollback-0.10.6
curl -s http://127.0.0.1:8080/api/info | jq -r '.data.version'   # 期望 0.10.6
```

## 7. 结论

本机实例升级成功并全部验收通过：版本 0.10.7、production true、新镜像 digest 正确、图片数与迁移数不变、页脚空白且 53px、关于页显示 0.10.7。升级动作未改数据目录内容，旧 0.10.6 常规镜像与标签保留。唯一偏差是 `picsur-prev-0106` 被新实例的自升级恢复逻辑自动清理，回滚窗口短于预期，已在第 5、6 节记录。
