# 投资收益统计系统 · investment-tracker

> 基于 XIRR 的多组合投资收益与净值追踪平台 —— 后端统一计算，Web + HarmonyOS 双端展示。

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)

---

## 一、项目简介

`investment-tracker` 是一套个人/多组合投资收益统计系统。围绕**每日 XIRR（年化收益率）**、**累计净值**、**当年净值**三大核心口径，对多组合的买入/卖出/资产快照进行统一计算，并通过 Web 前端与 HarmonyOS 原生 App 双端展示。

所有金融计算（XIRR、净值）**全部在后端完成**，前端仅做展示，保证口径一致、可审计。

### 核心特性

- **多组合独立计算**：每个组合独立核算收益，互不影响
- **每日 XIRR（累计口径）**：从首笔买入到当日整体年化收益，采用 Newton-Raphson 迭代求解
- **累计净值 / 当年净值**：单位份额法，当年净值每年首个交易日重置
- **多维查询**：年 / 月 / 周 / 日 四个维度，默认取期末值可切换平均值
- **多用户 + 数据隔离**：JWT 认证，按 `user_id` 过滤数据
- **双端架构**：NestJS 后端 + Web 前端（React + ECharts）

---

## 二、技术栈

| 层 | 技术 |
|----|------|
| 后端 | NestJS 10 + Prisma 5 + PostgreSQL 16 |
| Web 前端 | Vite 5 + React 18 + TypeScript + Tailwind CSS 3 + shadcn/ui |
| 图表 | ECharts 5（统一图表库，echarts-for-react 封装） |
| 共享层 | `shared` 包（TypeScript 类型 / API 契约） |
| 认证 | JWT + bcrypt |
| 仓库 | pnpm 9 monorepo + Turborepo |
| 测试 | 后端 Jest / Web Vitest + React Testing Library |

---

## 三、项目结构

```
investment-tracker/
├── docs/                          # 文档
│   ├── PRD.md                     # 产品需求文档
│   ├── ARCHITECTURE.md            # 系统架构设计
│   ├── class-diagram.mermaid      # 类图
│   ├── sequence-diagram.mermaid   # 时序图
│   └── ENVIRONMENT-SETUP.md       # 环境准备清单
├── packages/
│   ├── backend/                   # NestJS 后端 API
│   │   ├── src/
│   │   ├── prisma/                # Prisma schema + 迁移 + seed
│   │   └── .env.example           # 环境变量模板
│   ├── web/                       # Vite + React 前端
│   └── shared/                    # 共享类型与 API 契约
├── pnpm-workspace.yaml
├── turbo.json
├── tsconfig.base.json
├── package.json                   # 根构建脚本
└── LICENSE                        # AGPL-3.0
```

---

## 四、快速开始

### 1. 前置要求

- Node.js **>= 18**（推荐 22.x）
- pnpm **>= 9**
- PostgreSQL **16.x**（本地或 Docker）

### 2. 安装依赖

```bash
# 启用 pnpm（若未启用）
corepack enable
corepack prepare pnpm@latest --activate

# 安装全部 workspace 依赖
pnpm install
```

### 3. 配置环境变量

```bash
cd packages/backend
cp .env.example .env
# 编辑 .env 填入真实值（至少 DATABASE_URL 与 JWT_SECRET）
```

关键变量（`packages/backend/.env.example`）：

| 变量 | 说明 | 默认 |
|------|------|------|
| `DATABASE_URL` | PostgreSQL 连接串 | `postgresql://postgres:postgres@localhost:5432/investment_tracker?schema=public` |
| `JWT_SECRET` | JWT 签名密钥（生产用强随机串） | — |
| `JWT_EXPIRES_IN` | Token 过期时间 | `7d` |
| `PORT` | 后端服务端口 | `3000` |
| `CORS_ORIGIN` | 前端来源（逗号分隔） | `http://localhost:5173` |
| `SWAGGER_PATH` | Swagger 文档前缀 | `docs`（完整路径 `/api/docs`） |
| `NODE_ENV` | 运行环境 | `development` |

### 4. 初始化数据库

```bash
# 生成 Prisma Client
pnpm db:generate

# 执行迁移，创建表结构
pnpm db:migrate

# （可选）写入演示数据
pnpm db:seed
```

演示账号：`demo@investment-tracker.local` / 密码 `password123`

### 5. 启动开发环境

```bash
# 同时启动所有包（turbo）
pnpm dev

# 或分开启动
pnpm dev:backend   # 后端 → http://localhost:3000
pnpm dev:web       # 前端 → http://localhost:5173
```

API 文档（Swagger）：启动后端后访问 `http://localhost:3000/api/docs`

---

## 五、常用脚本（根目录）

| 命令 | 说明 |
|------|------|
| `pnpm dev` | 启动所有包的开发模式（turbo） |
| `pnpm dev:backend` | 仅后端（NestJS watch） |
| `pnpm dev:web` | 仅前端（Vite） |
| `pnpm build` | 构建所有包 |
| `pnpm test` | 运行全部测试 |
| `pnpm lint` | Lint 所有包 |
| `pnpm db:generate` | 生成 Prisma Client |
| `pnpm db:migrate` | 执行数据库迁移 |
| `pnpm db:seed` | 写入演示种子数据 |

各包内也提供各自的 `build` / `test` 脚本（如 `pnpm --filter backend test`）。

---

## 六、文档

详细设计与分析见 `docs/`：

- **PRD.md** — 产品需求、用户故事、需求池
- **ARCHITECTURE.md** — 系统架构、接口、计算口径
- **class-diagram.mermaid / sequence-diagram.mermaid** — 类图与时序图
- **ENVIRONMENT-SETUP.md** — 环境准备清单（含 PostgreSQL 安装）

---

## 七、授权

本项目以 **AGPL-3.0** 授权（见 [LICENSE](LICENSE)）。

AGPL 是强 copyleft 协议：任何人可自由使用、修改、商用本代码，**但**只要分发（含部署为网络服务 / SaaS），就必须公开其修改后的完整源码。

---

## 八、说明

- 金融计算口径（XIRR / 净值）的全部细节以 `docs/ARCHITECTURE.md` 与 PRD 为准。
