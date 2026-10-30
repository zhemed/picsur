# Backend Development Guidelines

> Best practices for backend development in this project.

---

## Overview

This directory contains guidelines for backend development. Fill in each file with your project's specific conventions.

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Build & Deploy](./build-and-deploy.md) | 工具链（Node 20 / pnpm 9.6.0）、三包构建、Docker 镜像、all-in-one 唯一部署路径、环境变量契约 | ✅ 已填 |
| [Image API Contracts](./image-api-contracts.md) | 图像 HTTP 接口：路径、请求/响应字段、状态码、错误矩阵 | ✅ 已填 |
| [Upload Concurrency](./upload-concurrency.md) | 上传链路并发模型：单进程事件循环、每次转换 fork 子进程、QOI 单线程编解码、前端并发上限 1、瓶颈与验证口径 | ✅ 已填（10-30 调查） |
| [Directory Structure](./directory-structure.md) | Module organization and file layout | To fill |
| [Database Guidelines](./database-guidelines.md) | ORM patterns, queries, migrations | To fill |
| [Error Handling](./error-handling.md) | Error types, handling strategies | To fill |
| [Quality Guidelines](./quality-guidelines.md) | Code standards, forbidden patterns | To fill |
| [Logging Guidelines](./logging-guidelines.md) | Structured logging, log levels | To fill |

---

## Pre-Development Checklist

写代码前逐条确认（来自 2026-10-13 接手基线的实测教训）：

- [ ] 涉及装依赖/构建 → 先读 [Build & Deploy](./build-and-deploy.md)：**必须 Node 20 + pnpm 9.6.0**。
- [ ] 涉及图像接口 → 先读 [Image API Contracts](./image-api-contracts.md)：路径与状态码都不符合直觉。
- [ ] 涉及上传/转码/worker/性能 → 先读 [Upload Concurrency](./upload-concurrency.md)：单张图处理基本单核，
      多核并行只来自多请求各 fork 一个子进程；前端上传并发上限是 1。
- [ ] 动到环境变量 → 三处同步：`.env.example`、all-in-one 的 `Dockerfile.allinone` 默认值、`build-and-deploy.md` §3.1。
      compose 部署已退役（`6fc28d9` 删除 `docker-compose.yml`），旧文档里出现 compose 的地方按此为准。
- [ ] 动到数据库实体/查询 → 生产必须 `PICSUR_PRODUCTION=true`，否则 TypeORM 会 `synchronize` 直改 schema。
- [ ] 要打日志 → **不要开 `PICSUR_VERBOSE`**（会明文打印 JWT secret 与 DB 口令）。
- [ ] 要出网 → 本仓库**已断掉遥测**：`ReportUrl` 编译期为空（`config.static.ts`），
      `UsageService.execute()` 见端点为空即跳过。不要以为改 `enable_telemetry` 或
      `PICSUR_TELEMETRY` 才是开关（它们现在都不控制出网）。

## Quality Check

改完要能回答：

- [ ] 三包是否都构建过（顺序 shared → backend → frontend）？
- [ ] `GET /api/info` 是否 200 且 `production:true`？
- [ ] 上传/取回/删除冒烟是否仍然全绿（取回断言**像素**而不是字节）？
- [ ] 有没有把密钥带进 git 跟踪范围或镜像（检查 `.gitignore` + `.dockerignore`）？
- [ ] 镜像里是否仍然**没有**依赖上游私有中间镜像？

---

## How to Fill These Guidelines

For each guideline file:

1. Document your project's **actual conventions** (not ideals)
2. Include **code examples** from your codebase
3. List **forbidden patterns** and why
4. Add **common mistakes** your team has made

The goal is to help AI assistants and new team members understand how YOUR project works.

---

**Language**: All documentation should be written in **English**.
