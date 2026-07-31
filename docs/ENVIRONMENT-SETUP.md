# 投资收益统计项目 — 开发环境准备清单

> 文档版本：v1.0 | 更新日期：2026-07-29
> 本清单与 PRD 并行推进，可在 PRD 完成前先行准备，缩短整体启动周期。

---

## 一、环境准备总览

本项目涉及 4 条技术线，建议**并行准备**以节省时间：

| 序号  | 环境模块                              | 必要性 | 预计准备时长   | 可否与其它并行 |
| --- | --------------------------------- | --- | -------- | ------- |
| 1   | PostgreSQL 数据库                    | 必须  | 15-30 分钟 | ✅ 可并行   |
| 2   | 后端开发环境（Node.js + NestJS）          | 必须  | 15 分钟    | ✅ 可并行   |
| 3   | Web 前端开发环境（Vite + React）          | 必须  | 15 分钟    | ✅ 可并行   |
| 4   | HarmonyOS APP 开发环境（DevEco Studio） | 必须  | 30-60 分钟 | ✅ 可并行   |
| 5   | Git 仓库与项目骨架                       | 必须  | 10 分钟    | 需先于代码编写 |
| 6   | 通用工具（编辑器、DB 客户端、API 测试）           | 推荐  | 15 分钟    | ✅ 可并行   |

---

## 二、PostgreSQL 数据库（后端数据存储）

### 2.1 安装

**推荐版本**：PostgreSQL 16.x（LTS，稳定且性能优秀）

**Windows 安装方式（任选其一）**：

**方式 A：官方安装包（推荐新手）**
1. 下载地址：https://www.postgresql.org/download/windows/
2. 下载 EDB 安装包，双击运行
3. 安装时记住设置的：
   - 超级用户 `postgres` 的密码（**务必记牢**）
   - 端口（默认 `5432`，建议保持）
   - 区域设置（选 `Default locale`）
4. 安装完成后会自动启动 PostgreSQL 服务

**方式 B：Docker（推荐有 Docker 经验者）**
```bash
docker run -d \
  --name investment-postgres \
  -e POSTGRES_PASSWORD=your_password \
  -e POSTGRES_DB=investment_tracker \
  -p 5432:5432 \
  -v pgdata:/var/lib/postgresql/data \
  postgres:16
```

### 2.2 验证安装

打开 SQL Shell (psql) 或命令行：
```bash
psql -U postgres -h localhost
# 输入密码后进入 psql 终端

# 验证版本
SELECT version();
# 应输出 PostgreSQL 16.x ...

# 创建项目专用数据库
CREATE DATABASE investment_tracker WITH ENCODING 'UTF8';
CREATE USER investment_app WITH PASSWORD 'change_me_in_prod';
GRANT ALL PRIVILEGES ON DATABASE investment_tracker TO investment_app;

# 退出
\q
```

### 2.3 数据库连接信息（后续配置用）

请准备好以下信息，PRD 完成后架构师会基于此设计 schema：

| 配置项 | 示例值 | 备注 |
|--------|--------|------|
| HOST | localhost | 开发环境本机 |
| PORT | 5432 | 默认端口 |
| DATABASE | investment_tracker | 项目专用库 |
| USERNAME | investment_app | 应用专用账号 |
| PASSWORD | （你自己设置的） | 不要硬编码进代码 |

---

## 三、后端开发环境（Node.js + NestJS）

### 3.1 Node.js 运行时

**当前环境已检测到**：Node.js 22.22.2（managed，位于 `C:\Users\dolphin738\.workbuddy\binaries\node\versions\22.22.2\node.exe`）

✅ **无需额外安装**，版本满足 NestJS 最新版要求。

### 3.2 包管理器

推荐使用 **pnpm**（速度快、磁盘占用小，适合 monorepo）：

```bash
# 启用 corepack（Node.js 22 自带）
corepack enable
corepack prepare pnpm@latest --activate

# 验证
pnpm -v
```

### 3.3 后端框架与依赖（待架构师确认后安装）

**推荐技术栈**（架构师最终决定）：
- 框架：NestJS（TypeScript 优先，结构清晰，适合中型项目）
- ORM：Prisma（TypeScript 友好，支持 PostgreSQL，迁移管理优秀）
- XIRR 计算：`xirr` 或 `financejs`（npm 包，需架构师评估精度与性能）
- 数据校验：class-validator + class-transformer
- API 文档：Swagger（@nestjs/swagger）
- 测试：Jest

**验证命令**：
```bash
node -v   # 应为 v22.22.2
pnpm -v   # 应为 9.x 或更高
```

---

## 四、Web 前端开发环境（Vite + React）

### 4.1 运行时

复用后端的 Node.js 22.22.2 + pnpm，无需额外安装。

### 4.2 推荐技术栈（待架构师确认）

- 构建工具：Vite 5.x
- 框架：React 18 + TypeScript
- UI 组件库：**shadcn/ui**（基于 Radix UI + Tailwind，零冲突，组件代码复制进项目可自由定制；弃用 MUI，因 MUI 的 CSS-in-JS 与 Tailwind 存在样式优先级冲突）
- 样式：Tailwind CSS 3.x
- **可视化库**：Recharts（基础图表，shadcn/ui chart 底层）+ ECharts 5.x（热力图等复杂图表，echarts-for-react 封装）
- 状态管理：Zustand（轻量）或 Redux Toolkit（重型可选项）
- 路由：React Router 6
- HTTP 客户端：Axios 或 TanStack Query（推荐后者，自带缓存与状态管理）
- 表单：React Hook Form + Zod 校验
- 测试：Vitest + React Testing Library

### 4.3 验证命令

```bash
node -v
pnpm -v
```

---

## 五、HarmonyOS APP 开发环境（CRITICAL — 需要单独安装）

### 5.1 DevEco Studio

HarmonyOS APP 必须使用华为官方 IDE **DevEco Studio** 开发（类似 Android Studio 之于 Android）。

**下载地址**：https://developer.huawei.com/consumer/cn/deveco-studio/

**安装步骤**：
1. 注册/登录华为开发者账号（必须，用于真机调试与签名）
2. 下载 DevEco Studio 最新版安装包（Windows 版）
3. 双击安装，**安装路径不要有中文和空格**
4. 首次启动会自动下载 HarmonyOS SDK，保持网络畅通
5. 配置 SDK 路径（默认即可，建议 SSD）

### 5.2 HarmonyOS SDK 与 API 版本

**目标版本**：HarmonyOS 5.0+（对应 API 12+），建议使用最新稳定版 API（当前推荐 API 12 或更高）

> ⚠️ HarmonyOS 版本迭代较快，请以 DevEco Studio 启动后提示的最新稳定 API 为准。本机已安装 `harmonyos-code-workshop` 技能，开发阶段可调用以获取最新 ArkTS/ArkUI 编码规范。

### 5.3 真机调试准备（可选但推荐）

1. 准备一台 HarmonyOS 手机（HarmonyOS 4.0+ 或 HarmonyOS NEXT）
2. 手机开启「开发者模式」+「USB 调试」
3. 用 USB 连接电脑，DevEco Studio 会自动识别
4. 无真机也可使用 DevEco Studio 内置的 **Previewer** 和 **模拟器**（Emulator）

### 5.4 验证安装

```bash
# DevEco Studio 安装完成后，启动它：
# 1. 新建一个空项目（Empty Ability）
# 2. 点击右上角 Previewer，能看到 "Hello World" 渲染即安装成功
```

### 5.5 关键技术点（开发阶段会用到）

- 语言：ArkTS（TypeScript 超集，鸿蒙专用）
- UI 框架：ArkUI（声明式 UI，类似 SwiftUI/Jetpack Compose）
- 状态管理：@State / @Prop / @Link / @Observed / @ObjectLink
- 网络请求：@ohos.net.http
- 数据存储：@ohos.data.relationalStore（本地 SQLite）或纯走后端 API
- 可视化：鸿蒙原生无 ECharts，需用 Canvas 自绘 或 使用第三方图表库（架构师评估）

---

## 六、Git 仓库与项目骨架

### 6.1 Git 安装

```bash
git --version
# 若未安装，下载：https://git-scm.com/download/win
```

### 6.2 推荐仓库结构（Monorepo）

本项目建议采用 **monorepo** 结构（一个仓库管三端），便于共享类型定义与 API 契约：

```
投资收益app/
├── .git/
├── .gitignore
├── README.md
├── docs/                      # 文档（PRD、架构设计、交付报告）
│   ├── PRD.md
│   ├── ARCHITECTURE.md
│   └── ENVIRONMENT-SETUP.md   # 本文件
├── packages/
│   ├── backend/               # NestJS 后端
│   │   ├── src/
│   │   ├── prisma/            # Prisma schema 与迁移
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── web/                   # Vite + React Web 前端
│   │   ├── src/
│   │   ├── public/
│   │   ├── package.json
│   │   └── vite.config.ts
│   ├── harmonyos/             # HarmonyOS APP（DevEco Studio 工程）
│   │   ├── entry/
│   │   ├── build-profile.json5
│   │   └── oh-package.json5
│   └── shared/                # 共享类型定义（TypeScript 类型、API 契约）
│       ├── src/
│       │   ├── types/         # Transaction, XirrResult, NavRecord 等
│       │   └── api-contracts/
│       └── package.json
├── pnpm-workspace.yaml        # pnpm monorepo 配置
├── package.json               # 根 package.json
└── turbo.json                 # Turborepo 配置（可选，加速构建）
```

> ⚠️ HarmonyOS 工程由 DevEco Studio 管理，放在 `packages/harmonyos/` 下时需注意 DevEco Studio 的工程根目录约定，架构师阶段会细化。

### 6.3 .gitignore 要点

需覆盖：`node_modules/`、`dist/`、`.env*`、`*.log`、`coverage/`、HarmonyOS 构建产物（`build/`、`.preview/`）、IDE 配置（`.idea/`、`.vscode/` 可选择性忽略）、PostgreSQL 凭据文件等。

### 6.4 初始化命令（Git 与仓库骨架准备好后执行）

```bash
cd "D:/sync/obsidian_wiki/w_wiki/04_Projects/AI Coding/app"
git init
git add .
git commit -m "chore: 初始化项目骨架与文档"
# 若推送到远端（GitHub/Gitee/GitCode）：
# git remote add origin <your-remote-url>
# git branch -M main
# git push -u origin main
```

---

## 七、通用工具（推荐安装）

| 工具 | 用途 | 下载地址 | 备注 |
|------|------|---------|------|
| VS Code | 主编辑器（后端 + Web） | https://code.visualstudio.com/ | 装 ESLint/Prettier/Tailwind/Prisma 插件 |
| DBeaver Community | PostgreSQL 可视化管理 | https://dbeaver.io/ | 免费，跨平台，强烈推荐 |
| Apifox 或 Postman | API 调试 | https://apifox.com/ | Apifox 国内友好，支持团队协作 |
| Sourcetree 或 GitKraken | Git 可视化客户端 | — | 命令行党可跳过 |
| Typora 或 Obsidian | Markdown 文档编辑 | — | 项目文档会比较多 |

---

## 八、准备优先级建议

**第一批（立即并行启动，约 1 小时）**：
1. PostgreSQL 安装 + 建库建账号
2. DevEco Studio 下载安装（耗时最长，先启动）
3. VS Code + DBeaver + Apifox 安装

**第二批（第一批完成后，约 15 分钟）**：
4. 启用 pnpm（corepack）
5. Git 仓库初始化 + monorepo 骨架搭建

**第三批（PRD 与架构设计完成后）**：
6. 后端依赖安装（NestJS/Prisma/xirr 等）
7. Web 前端依赖安装
8. HarmonyOS 工程创建（DevEco Studio 内新建工程）

---

## 九、环境准备自检清单（Checklist）

请逐项确认后再进入开发阶段：

- [ ] PostgreSQL 16 已安装，能通过 psql 登录
- [ ] 数据库 `investment_tracker` 与用户 `investment_app` 已创建
- [ ] Node.js 22.22.2 可用（`node -v`）
- [ ] pnpm 已启用（`pnpm -v`）
- [x] Git 已安装（`git --version`）
- [x] DevEco Studio 已安装，能新建空工程并预览
- [x] 华为开发者账号已注册
- [ ] VS Code 已安装并装好推荐插件
- [ ] DBeaver 已连接到本地 PostgreSQL
- [ ] monorepo 骨架已搭建并完成首次 commit

---

## 十、待确认问题（环境相关）

以下问题会影响架构设计，建议准备环境时同步思考：

1. **HarmonyOS APP 分发方式**：仅自用？还是需要上架华为应用市场？（影响签名与认证流程）
2. **多用户支持**：单机自用还是 SaaS 多租户？（影响数据库 schema 设计与认证方案）
3. **部署环境**：后端部署在哪？（本地内网？云服务器？影响 PostgreSQL 部署方式）
4. **数据同步策略**：Web 和 HarmonyOS APP 如何保证数据一致？（纯走后端 API 即可，还是 APP 需要本地缓存？）
5. **XIRR 计算位置**：后端统一计算（推荐）还是前端各自计算？（影响架构）

这些问题的默认建议会在 PRD 的「待确认问题」章节给出，届时请一并确认。
