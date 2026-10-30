# 维护手册

> 本项目只有**一条部署路径**和**一条发布路径**。手册也只写这两条。

## 1. 部署（唯一方式）

```bash
docker run -d --name picsur --restart always \
  -p 8080:8080 \
  -v ./data:/data \
  -v /var/run/docker.sock:/var/run/docker.sock \
  ghcr.io/zhemed/picsur:allinone
```

- 登录名固定 `admin`；首次启动的管理员口令打印在 `docker logs picsur`，并写入 `./data/allinone.env`（600）。
- 所有数据（PostgreSQL + 图片文件）都在 `./data`。**备份 = 打包这个目录**：
  `tar czf picsur-data-$(date +%F).tgz ./data`（恢复 = 解包回原位后重启容器）。
- 那行 `docker.sock` 挂载是**面板一键升级**的开关：它是把宿主 docker 的控制权交给面板，
  因此面板管理员等价于宿主 root。不想要就删掉这行 —— 面板会改为显示可复制的手动升级命令，
  其它功能不受影响。

## 2. 升级

- **正常路径**：面板 → 设置 →「关于」→「立即升级」。点完页面会显示进度，成功后自动变成新版本。
- **失败**：面板会显示「升级失败，已回滚到 X」+ 原因 + 「重试」；容器与数据都保持原样。
- **手动路径**（没挂 socket、或面板不可用时）：
  ```bash
  docker pull ghcr.io/zhemed/picsur:allinone
  docker rm -f picsur && docker run -d --name picsur --restart always \
    -p 8080:8080 -v ./data:/data -v /var/run/docker.sock:/var/run/docker.sock \
    ghcr.io/zhemed/picsur:allinone
  ```
  数据库迁移随容器启动自动执行。
- **固定版本**：all-in-one 在 GHCR 上只有滚动的 `:allinone` 标签，没有版本化 all-in-one tag；要固定版本，
  得把常规镜像的版本 tag 当基底自行重建 all-in-one（在仓库根目录执行）：
  ```bash
  docker build -f Dockerfile.allinone \
    --build-arg PICSUR_BASE_IMAGE=ghcr.io/zhemed/picsur:vX.Y.Z \
    -t picsur:allinone-fixed .
  ```
  再用 `docker run` 起本地这个 tag。不能直接把部署命令的镜像换成 `:vX.Y.Z` —— 那是常规镜像，
  没有内嵌 Postgres，需要外置数据库，不是一条 `docker run` 的部署形态。

### 2.1 去角色化（v0.9.x）的升级与回滚

权限从"角色"改成了"直接挂在用户上"，升级时会自动迁移（迁移随容器启动执行）：

- 每个用户当前的生效权限（其所有角色权限的并集）会被**物化**到新的
  `e_user_backend.permissions` 列；常规用户升级前后权限**逐项一致**；
- 三个内置角色（guest/user/admin）变成代码里的权限模板：`admin` 账号**永远拥有全部权限**
  （读时计算，将来新增权限不需要再迁移，也不会把自己锁在外面）；`guest` 的权限集合由
  模板决定（demo 实例额外给上传权，**切 demo 需要重启**）；
- **新建账号默认没有任何权限**（默认拒绝）：在用户页用「访客默认 / 普通用户默认」按钮
  一键套用，或逐个勾选；
- 老的 `/settings/roles` 页面与 `/api/roles*` 接口**已移除**，旧书签会落到 404 页；
  之前建的自定义角色保留在库里（`e_role_backend` 冻结），其权限已并入相应用户。

**回滚**（换回旧版本镜像）：旧代码仍然按 `e_user_backend.roles` 判定，而该列与角色行
**原样保留**，所以回滚后权限行为与升级前一致。代价是：**切换之后在用户页做的权限编辑
会丢失**（角色模型里没有这些信息），需要重做。API 密钥功能的残留表
（`e_api_key_backend`）同理保留、不再读取。

## 3. 发布（维护者）

```bash
# 需要：Node 20（.run/node20 或等价环境）、pnpm 9.6.0、docker 已登录 ghcr、干净的工作树
bash support/release-local.sh          # 构建 + 推送 :<版本> :v<版本> :<major.minor> :latest :allinone + 打 git tag
bash support/release-local.sh --dry-run
```

- 脚本会拒绝脏工作树、未推送提交、版本回退与重复发布 —— **不要重推同一个版本号**
  （面板比较的是版本号，重推同版本对已部署的实例不可见）。
- 发布前自检：`bash support/audit-prod.sh`（后端/共享口径必须 0；浏览器侧应无 critical/high）、
  `bash support/regression-image-api.sh <base-url> <admin-password>`（34 项接口/格式回归）。
  回归**夹具自给**：缺 `base.{png,jpg,webp,avif,jxl,jp2,heif,qoi}` / `big-900mp.png` 时脚本
  自动生成（本地 sharp 编不出 JXL/JP2 就换带完整 libvips 的容器，
  `PICSUR_FIXTURE_IMAGE`，默认 `ghcr.io/zhemed/picsur:allinone`）；docker 不可用会直接报错退出。
- 发布后：按第 5 节用真实实例点一次面板升级验收。

## 4. 构建与依赖

- **必须 Node 20 + pnpm 9.6.0**（`corepack` 固定）；宿主 Node 22 装不了后端原生模块。
- 依赖审计：`bash support/audit-prod.sh`（需要官方 registry）。
- 镜像里 apk 版本是**锁死**的；Alpine 发新修订号导致构建失败时，跑 `bash support/apk-versions.sh`
  把新版本号同步进 Dockerfile。

### 4.1 本地 dev 数据库

本机开发连 `127.0.0.1:5432`，库名 / 用户名 / 口令都是 `picsur`。`support/dev.docker-compose.yml`
已随 `db04c3b` 退役，现在直接用一条 `docker run` 起 Postgres 17：

```bash
docker run -d --name picsur-devdb --restart unless-stopped \
  -p 5432:5432 \
  -e POSTGRES_DB=picsur -e POSTGRES_USER=picsur -e POSTGRES_PASSWORD=picsur \
  -v picsur-devdb-data:/var/lib/postgresql/data \
  postgres:17-alpine
```

- 先看有没有已经在跑：`docker ps --filter name=picsur-devdb`；本机 5432 被别的 dev 库占用时
  不要再起第二个，直接复用那个库或先停掉它。
- 停 / 删：`docker stop picsur-devdb`；连数据一起删：`docker rm -f picsur-devdb && docker volume rm picsur-devdb-data`。
- 连库：把 `.env.example` 复制成 `.env`（示例里 `PICSUR_DB_HOST` 已经是 `127.0.0.1`），再
  `set -a; . ./.env; set +a; node backend/dist/main.js` 起后端。

## 5. 验收清单（每次发布后跑一遍）

1. 接口/格式回归（一条命令，夹具自动就位）：
   ```bash
   bash support/regression-image-api.sh <新实例> <管理员口令>   # → RESULT: 34 passed, 0 failed
   ```
2. 打开面板「关于」页：显示当前/最新版本、**不是**「正在检查更新…」或「未启用」；
3. 若这次含自升级相关改动：在测试实例点一次「立即升级」，确认进度显示、成功自动刷新；
4. 数据抽查：升级前后图片数量一致、任取一张图 `/i/<id>.png` 返回 200。

## 6. 排障速查

| 症状 | 原因 / 处理 |
|---|---|
| 面板显示「面板内升级未启用」 | 容器没挂 `/var/run/docker.sock`（或挂了但进程读不到）→ 按第 1 节补挂载；**注意**：面板只有真正拿到检查结果才会这么显示，网络异常会显示原因而非"未启用" |
| 「正在检查更新…」长时间不变 | 服务端要访问 GitHub 取 tag；网络不通会超时报错，点「检查更新」重试 |
| 点升级后页面没变 | 升级中接口会短暂不可用，页面会自动重连并在成功后刷新；若一直不刷新就强刷一次 |
| 端口被占用 | `-p 8080:8080` 换成别的宿主端口（如 `-p 18080:8080`） |
| 忘记管理员口令 | `docker logs picsur | head` 或 `cat ./data/allinone.env` |
| 升级失败 | 面板会显示原因并说明已回滚；数据未动，可直接重试或用手动路径 |

## 7. 安全要点

- 面板一键升级能力 = 宿主 docker 控制权（root 等价）；只有完全信任的管理员才应保留那行挂载。
- 不要把 `.env`、`./data`、任何口令或密钥写进仓库；仓库里不得出现内网地址/主机名。
- 依赖审计后端/共享口径保持 0；浏览器侧告警随 Angular 大版本升级收敛。
