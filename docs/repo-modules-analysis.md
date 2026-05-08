# 仓库模块结构分析

## 1. Monorepo 顶层

该仓库使用 `pnpm workspace` 管理多应用结构，根目录通过 `pnpm-workspace.yaml` 将 `apps/*` 作为工作区包。根 `package.json` 提供统一的开发/构建脚本（并行 dev、分别构建 server/web、格式化检查）。

- 工作区定义：`apps/*`
- 统一脚本：`dev`、`build:server`、`build:web`、`start:server`、`start:web`

## 2. Web 前端模块（apps/web）

前端是基于 React + Vite 的单页应用，路由基于 `react-router-dom`，在 `/dash` 基路径下运行。

核心模块包括：

1. 路由与页面组织
   - 页面模块：`feeds`、`knowledge`、`knowledge-indexing`、`accounts`、`login`
   - 由 `App.tsx` 集中注册路由，使用 `BaseLayout` 作为父布局。

2. Provider 层
   - `ThemeProvider`：主题切换/暗黑模式管理
   - `TrpcProvider`：前后端通信上下文

3. 组件与 UI
   - 导航与状态组件：`Nav`、`StatusDropdown`、`ThemeSwitcher`
   - 图标组件：`GitHubIcon`、`PlusIcon`

4. 工具与基础设施
   - `utils/auth.ts`：鉴权逻辑
   - `utils/trpc.ts`、`provider/trpc.tsx`：trpc 客户端封装
   - `utils/env.ts`：环境变量读取

## 3. Server 后端模块（apps/server）

后端使用 NestJS，`AppModule` 负责聚合核心子模块：

1. 基础框架模块
   - `ConfigModule`：全局配置，支持 `.env.local` 和 `.env`
   - `ThrottlerModule`：限流配置（按分钟限制请求数）
   - `ScheduleModule`：定时任务能力

2. 业务模块
   - `FeedsModule`：订阅源相关业务（controller/service）
   - `TrpcModule`：将服务能力通过 tRPC 暴露
   - `RagModule`：知识库 / 检索增强相关能力（从目录结构判断）

3. 数据访问层
   - `PrismaModule`、`PrismaService`
   - 同时维护 `prisma` 与 `prisma-sqlite` 两套 schema/migrations，说明兼容不同数据库后端的部署场景。

4. 测试模块
   - 单元测试：`*.spec.ts`
   - 端到端测试：`test/app.e2e-spec.ts`

## 4. 钉钉集成子项目（wewe-rss-dingtalk）

该目录是独立 Python 子项目，用于将消息/能力与钉钉机器人打通。

- 运行方式：直接 `python3 main.py` 或通过 Docker Compose
- 依赖声明：`requirements.txt`
- 容器化：`Dockerfile` + `docker-compose.yml`

该模块与主 `apps/*` Node.js 应用并行存在，更像“扩展集成插件”。

## 5. 配套与部署模块

仓库根目录还包含：

- 多环境编排：`docker-compose.yml`、`docker-compose.dev.yml`、`docker-compose.sqlite.yml`
- 容器镜像定义：根 `Dockerfile`
- 部署文档：`docs/deployment-knowledge-base.md`
- 可视化资产：`assets/*`
- 发布脚本：`release.sh`

## 6. 模块关系简图（逻辑视角）

- `apps/web`（前端）通过 tRPC 调用 `apps/server`。
- `apps/server` 通过 Prisma 访问数据库，并通过定时任务/订阅源模块处理 RSS。
- `wewe-rss-dingtalk` 作为外部消息通道集成模块，与主系统部署可解耦。
- 根目录 Docker/Compose 提供统一部署入口。

## 7. 总结

这是一个“前后端一体 + 外部渠道扩展”的多模块仓库：

- 主链路：`web -> server -> database`
- 扩展链路：`server/rss -> dingtalk`
- 运维链路：`docker compose + docs + release script`

结构清晰，适合分别演进 UI、后端能力和外部机器人集成。
