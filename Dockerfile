# Picsur 自有镜像（zhemed/Picsur）
#
# 与上游 support/picsur-stage1.Dockerfile + picsur-stage2.Dockerfile 的区别：
#   1. JS 构建阶段内联在本文件里 —— 上游那套 stage2 依赖它自己的**私有中间镜像**，
#      那个镜像随时可能被清理，构建就废了；本文件不依赖任何外部构建产物。
#   2. pnpm 固定为 9.6.0，与根 package.json 的 packageManager 字段一致（可复现）。
#   3. libvips 编译限制并行度（-j4），避免在小内存机器上 OOM。
#   4. 生产依赖在「目标平台 + 全局 libvips」下重新安装，保证 sharp 是针对 musl + 全局 vips 编译的。
#
# 构建（在仓库根目录）：docker build -t zhemed/picsur:local .
# 说明：镜像内固定 PICSUR_PRODUCTION=true —— TypeORM 不再 synchronize，只跑 migrations。
#
# 可复现性（2026-10-15 审计 C-M5）：
#   * 基础镜像锁 digest（node:20 / node:20-alpine），digest 由 Dependabot 每周提 PR 更新；
#   * apk 包锁到具体版本（Alpine 3.23 当前版本）—— Alpine 一发新的 -rN 修订，这里就会
#     构建失败（"unable to select packages"），用 `bash support/apk-versions.sh` 重新解析并更新；
#     注意：锁的是 amd64 的版本号，arm64 上同一 Alpine 分支的修订号可能不同；
#   * libvips 源码包校验 sha256（值同时核对过 GitHub release asset 的 digest）；
#   * 全局 node-gyp / node-addon-api 锁版本（与 lockfile 里的解析结果一致）。
#
# 构建阶段不变量（2026-10-16「发布偶发失败」根治后固化，别改）：
#   * **需要写权限的构建阶段必须在 root 下执行**：每个构建阶段显式写 `USER root`；
#     `USER node` 只用于最终运行阶段（见文件末尾）。构建阶段里加 `USER` 都是 bug。
#   * 全局 pnpm 自带的 node-gyp 发布时**没有可执行位**（pnpm tarball 里 `node-gyp/gyp/*` 全是 0644），
#     而 gyp 生成的 Makefile 在「自我再生」（`ACTION Regenerating Makefile`，Makefile 第 348 行那条规则）
#     时会**直接执行** `gyp_main.py`（靠 shebang）→ `/bin/sh: … Permission denied`、make Error 126。
#     是否触发取决于 make 的时间戳判断，所以表现为「偶发、重试即过」的发布中断。
#     → 每次装完 pnpm / 装完依赖，都要用下面的 `chmod` 显式补齐 gyp 入口的 exec 位（别删）。

# ============================================================
# 阶段 1：JS 产物（shared → frontend → backend）
# ============================================================
# 注意：必须是 node:20（完整镜像，自带 python3/gcc/g++/make），不能用 -slim ——
# 依赖里有 qoi-img / bmp-img / posix.js 是走 node-gyp 源码编译的。
# Node 版本必须是 20：Node ≥22.16 的 N-API 签名变更会让这些包编译失败（实测）。
FROM node:20@sha256:8f693eaa7e0a8e71560c9a82b55fd54c2ae920a2ba5d2cde28bac7d1c01c9ba5 AS js_builder

# 构建阶段必须 root（见文件头不变量）：pnpm/node-gyp 要写 /usr/local 与项目 node_modules
USER root

# pnpm 自带的 node-gyp 入口没有 exec 位（pnpm tarball 里就是 0644）→ 显式补齐。
# 末尾那条 test 是断言：万一以后 pnpm 改了目录结构，chmod 会静默失配、这个坑又会回来 —— 直接让构建失败。
RUN npm install -g pnpm@9.6.0 \
 && find /usr/local/lib/node_modules -path '*/node-gyp/gyp/*' \( -name 'gyp' -o -name '*.py' \) -exec chmod +x {} + \
 && test -n "$(find /usr/local/lib/node_modules -name gyp_main.py -print -quit)"

WORKDIR /picsur
COPY . .

# 装完依赖再补一次：node-gyp 可能是从依赖树里解出来的（本地 .pnpm 树），同样要能直接执行
RUN pnpm install --frozen-lockfile \
 && { find /picsur/node_modules -path '*/node-gyp/gyp/*' \( -name 'gyp' -o -name '*.py' \) -exec chmod +x {} + 2>/dev/null || true; }

# 顺序不能变：backend / frontend 直接 import picsur-shared/dist/*
RUN pnpm --filter picsur-shared build \
 && pnpm --filter picsur-frontend build \
 && pnpm --filter picsur-backend build

# 只保留生产运行需要的东西（dist + package.json + 锁文件 + 品牌资源）
RUN mkdir -p /trimmed \
 && cp -r --parents ./package.json ./pnpm-lock.yaml ./pnpm-workspace.yaml ./branding /trimmed \
 && cp -r --parents ./frontend/dist ./frontend/package.json /trimmed \
 && cp -r --parents ./backend/dist ./backend/package.json /trimmed \
 && cp -r --parents ./shared/dist ./shared/package.json /trimmed

# ============================================================
# 阶段 2：编译 libvips（HEIF / JPEG-XL / JPEG2000 等编解码在这一层）
# ============================================================
# 版本不能低于 8.18.7：sharp 0.35.x 的 package.json config.libvips 要求 >=8.18.7，
# 低于它 sharp 的 install 脚本会拒绝用全局 libvips（SHARP_FORCE_GLOBAL_LIBVIPS 下仍会失败）。
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS vips_builder

# 构建阶段必须 root（见文件头不变量）
USER root

RUN apk add --no-cache \
    build-base=0.5-r3 meson=1.9.1-r0 cmake=4.1.3-r0 pkgconf=2.5.1-r0 \
    glib-dev=2.86.3-r0 expat-dev=2.9.0-r0 libexif-dev=0.6.26-r0 jpeg-dev=9f-r0 \
    libjxl-dev=0.11.2-r0 openjpeg-dev=2.5.4-r2 libpng-dev=1.6.59-r0 tiff-dev=4.7.2-r0 \
    libheif-dev=1.23.0-r0 libwebp-dev=1.6.0-r0 cgif-dev=0.5.4-r0 \
    imagemagick-dev=7.1.2.34-r0 librsvg-dev=2.61.2-r0 pango-dev=1.56.4-r0 \
    cfitsio-dev=4.6.3-r0 poppler-dev=25.12.0-r0 libspng-dev=0.7.4-r1 \
    lcms2-dev=2.19-r0 fftw-dev=3.3.10-r7 libimagequant-dev=4.2.2-r0

WORKDIR /vips
# sha256 由 GitHub release asset 的 digest 交叉核对过（2026-10-15）
RUN wget -q https://github.com/libvips/libvips/releases/download/v8.18.7/vips-8.18.7.tar.xz -O vips.tar.xz \
 && echo "5baaead3b0bb20ffdb9e9ff09aa9fda08620923df77b63b436654cb5e0b3bf94  vips.tar.xz" | sha256sum -c - \
 && tar -xf vips.tar.xz && rm vips.tar.xz
RUN cd vips-*/ \
 && meson setup build -Dexamples=false \
 && cd build \
 && meson compile -j4 \
 && meson install

# ============================================================
# 阶段 3：vips 运行时（只带运行期依赖）
# ============================================================
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS vips_runtime

# 构建阶段必须 root（见文件头不变量）
USER root

COPY --from=vips_builder /usr/local /usr/local
RUN apk add --no-cache \
    pkgconf=2.5.1-r0 glib=2.86.3-r0 expat=2.9.0-r0 libexif=0.6.26-r0 jpeg=9f-r0 \
    libjxl=0.11.2-r0 openjpeg=2.5.4-r2 libpng=1.6.59-r0 tiff=4.7.2-r0 \
    libheif=1.23.0-r0 libwebp=1.6.0-r0 cgif=0.5.4-r0 imagemagick=7.1.2.34-r0 \
    librsvg=2.61.2-r0 pango=1.56.4-r0 cfitsio=4.6.3-r0 poppler=25.12.0-r0 \
    poppler-glib=25.12.0-r0 libspng=0.7.4-r1 lcms2=2.19-r0 fftw=3.3.10-r7 \
    libimagequant=4.2.2-r0

# ============================================================
# 阶段 4：生产依赖（sharp 必须从源码编译，链接到我们自编译的 libvips）
# ============================================================
FROM vips_builder AS prod_deps

# 构建阶段必须 root（见文件头不变量）
USER root

# node-addon-api / node-gyp 供 sharp 的源码构建使用（sharp 自己的 node_modules 是空的，
# 所以用 NODE_PATH 指到全局安装位置给它解析）；版本锁死，避免构建工具悄悄换代。
# 末尾这两条 chmod 是给 pnpm 自带的 node-gyp 补 exec 位（pnpm tarball 里是 0644，
# 而 gyp 生成的 Makefile 自我再生时会直接执行 gyp_main.py → 偶发 EACCES，见文件头）
RUN npm install -g pnpm@9.6.0 node-gyp@11.5.0 node-addon-api@8.2.2 \
 && find /usr/local/lib/node_modules -path '*/node-gyp/gyp/*' \( -name 'gyp' -o -name '*.py' \) -exec chmod +x {} + \
 && test -n "$(find /usr/local/lib/node_modules -name gyp_main.py -print -quit)"
# sharp 从源码编译需要 python3 + 编译工具链
RUN apk add --no-cache python3=3.12.16-r0 build-base=0.5-r3

WORKDIR /picsur
COPY --from=js_builder /trimmed ./

ENV SHARP_FORCE_GLOBAL_LIBVIPS=1
# 这一步就是 2026-10-16 两次发布中断的地方（posix.js 的 gyp 构建）：装完依赖同样补一次 exec 位
RUN pnpm install --frozen-lockfile --prod \
 && { find /picsur/node_modules -path '*/node-gyp/gyp/*' \( -name 'gyp' -o -name '*.py' \) -exec chmod +x {} + 2>/dev/null || true; }

# ⚠️ 关键：sharp >= 0.33 的安装流程**不会**自动从源码构建 —— 它只装预编译的
# `@img/sharp-*`（自带一份精简 libvips，**不含 JPEG-XL / JPEG2000 编解码**，
# SHARP_FORCE_GLOBAL_LIBVIPS 也不再被安装流程读取）。要拿到我们自编译 libvips 的
# 全量编解码（HEIF / JXL / JP2 / PDF / Magick），必须显式跑一次 sharp 的源码构建。
RUN cd /picsur/backend/node_modules/sharp \
 && SHARP_FORCE_GLOBAL_LIBVIPS=1 NODE_PATH=/usr/local/lib/node_modules node install/build.js

# ============================================================
# 阶段 5：最终镜像
# ============================================================
FROM vips_runtime

# 构建阶段必须 root（见文件头不变量）；顺带把 pnpm 自带 node-gyp 的 exec 位补上，
# 让发布出去的镜像里这套工具链也是完整可用的（all-in-one 基镜像就是它）
USER root
RUN npm install -g pnpm@9.6.0 \
 && find /usr/local/lib/node_modules -path '*/node-gyp/gyp/*' \( -name 'gyp' -o -name '*.py' \) -exec chmod +x {} +

ENV PICSUR_PRODUCTION=true

WORKDIR /picsur
# 以非 root 运行（审计 C-M6）：
#   * `--chown=node:node` 让 /picsur（含 frontend/dist 静态产物、backend/dist、node_modules）可读；
#   * 应用只写数据库与 /tmp（上传内容存 Postgres，不落盘），所以不需要写 /picsur；
#   * CMD 仍是 pnpm（为了注入 npm_package_version 给 /api/info），node 用户的 HOME=/home/node 可写。
#   * ⚠️ 面板内一键升级需要访问宿主 docker.sock：socket 属于宿主 root:docker，容器里 uid 1000
#     默认**没有**权限。要保留这个能力，compose 里用 `group_add` 把宿主 docker 组 GID 加进来
#     （install.sh 会自动探测并写进受管 override；手工部署见 .env.example 的 PICSUR_DOCKER_GID）。
#     不加也能跑：应用会检测到 socket 不可用，面板退化为显示可复制的升级命令。
COPY --from=prod_deps --chown=node:node /picsur ./

USER node

CMD ["pnpm", "--filter", "picsur-backend", "start:prod"]
