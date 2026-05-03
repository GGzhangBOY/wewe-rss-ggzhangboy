# WeWe-RSS 部署知识库

## 当前线上部署状态

- 服务器系统：Ubuntu 24.04 LTS，x86_64
- 访问地址：http://47.121.26.65:4000
- 部署目录：`/opt/wewe-rss-ggzhangboy`
- 运行方式：宿主机原生 Node.js + systemd
- systemd 服务：`wewe-rss.service`
- 启动脚本：`/opt/wewe-rss-ggzhangboy/start-native.sh`
- 数据库：SQLite
- 数据文件：`/root/data/wewe-rss.db`
- 数据备份：`/root/backups/wewe-rss.db.20260501155814.bak`
- 旧 Docker 容器：已停止并删除，当前 4000 端口由 `node dist/main` 监听

## 运行环境

- Node.js：`v20.16.0`
- pnpm：`9.15.9`
- 包管理：pnpm workspace
- 后端：NestJS + Prisma
- 前端：React + Vite + NextUI
- 数据库：SQLite，使用 `apps/server/prisma-sqlite/schema.prisma`

## 常用运维命令

```bash
systemctl status wewe-rss
systemctl restart wewe-rss
journalctl -u wewe-rss -f
ss -ltnp | grep ':4000'
curl -I http://127.0.0.1:4000/
```

## 原生部署流程

```bash
cd /opt/wewe-rss-ggzhangboy
export PATH=/usr/local/bin:/usr/bin:/bin

pnpm install --frozen-lockfile --prod=false
pnpm run -r build

cd apps/server
DATABASE_TYPE=sqlite DATABASE_URL=file:/root/data/wewe-rss.db \
  pnpm exec prisma generate --schema prisma-sqlite/schema.prisma

DATABASE_TYPE=sqlite DATABASE_URL=file:/root/data/wewe-rss.db \
  pnpm exec prisma migrate deploy --schema prisma-sqlite/schema.prisma

systemctl restart wewe-rss
```

## 关键环境变量

```bash
NODE_ENV=production
HOST=0.0.0.0
PORT=4000
DATABASE_TYPE=sqlite
DATABASE_URL=file:/root/data/wewe-rss.db
AUTH_CODE=<部署认证码>
SERVER_ORIGIN_URL=http://47.121.26.65:4000
MAX_REQUEST_PER_MINUTE=60
MINIMAX_API_KEY=<不要提交到仓库>
MINIMAX_API_BASE_URL=https://api.minimaxi.com/v1
MINIMAX_MODEL=MiniMax-M2.7
```

生产环境中，MiniMax key 放在 `/etc/wewe-rss.env`，`/opt/wewe-rss-ggzhangboy/start-native.sh` 启动时加载该文件。不要把 key 写入仓库文件。

## 这次踩过的坑

1. Docker 构建受服务器 Docker 代理影响。
   - Docker daemon 原来配置了 `HTTP_PROXY=http://127.0.0.1:7890`。
   - 本机代理不可用时，Docker 拉基础镜像会卡住或失败。

2. Dockerfile 里全局安装 pnpm 未锁版本。
   - `npm i -g pnpm` 会安装 pnpm v10。
   - pnpm v10 对 `pnpm deploy` 行为有变化，需要 `--legacy` 或配置 `force-legacy-deploy=true`。

3. 原生构建不能用 `NODE_ENV=production pnpm install`。
   - 这样会跳过 devDependencies。
   - 后续 `nest build`、`tsc`、`vite build` 会找不到命令。
   - 构建阶段应使用完整依赖：`pnpm install --frozen-lockfile --prod=false`。

4. 前端路由和 Feed 接口路径容易混淆。
   - 前端页面基路径是 `/dash`。
   - Feed 接口是 `/feeds/:id`，默认返回 Atom XML。
   - 页面跳转应使用 `/dash/feeds/:id` 或 React Router 内部导航。
   - RSS 地址应显式使用 `/feeds/:id.rss`，Atom 使用 `/feeds/:id.atom`。

## 技术栈建议

### 当前阶段建议

继续使用：

- Node.js 20 LTS
- pnpm 9.x
- NestJS
- React + Vite
- Prisma + SQLite
- systemd 原生部署

理由：

- 当前业务规模小，SQLite 足够简单稳定。
- systemd 比 PM2 更贴近 Linux 标准，重启、日志、开机自启都清晰。
- pnpm 9 与当前 lockfile 和 Dockerfile 行为更匹配，减少 pnpm v10 行为变化带来的风险。
- 不引入 Nginx/HTTPS/数据库服务前，维护成本最低。

### 中期优化建议

如果访问量、订阅数或数据重要性上升，建议按顺序升级：

1. 加 Nginx 反代。
   - 统一入口。
   - 后续方便接 HTTPS、限流、访问日志。

2. 配置 HTTPS。
   - 有域名后用 Let’s Encrypt。
   - RSS 阅读器和浏览器兼容性更好。

3. 做定时数据库备份。
   - SQLite 至少每日备份 `/root/data/wewe-rss.db`。
   - 保留 7 到 30 天。

4. 将 SQLite 迁移到 MySQL 或 PostgreSQL。
   - 当订阅数、文章量、并发写入明显变多时再迁移。
   - 当前不建议过早迁移，复杂度会明显增加。

5. 加 CI/CD。
   - 推送 main 后自动构建、测试、部署。
   - 可以先用 GitHub Actions + SSH 部署脚本。

### 不建议现在做的事

- 不建议马上上 Kubernetes，规模不匹配。
- 不建议为了单服务引入复杂容器编排。
- 不建议在服务器上长期保留 root 密码登录，应逐步改为 SSH key。
- 不建议混用 Docker 和原生 systemd 同时跑同一个 4000 服务。

## 推荐目标架构

当前：

```text
Internet -> Node/NestJS systemd service :4000 -> SQLite
```

中期：

```text
Internet -> Nginx :80/:443 -> Node/NestJS systemd service :4000 -> SQLite/PostgreSQL
```

## RAG 知识问答

当前已增加 `/dash/knowledge` 页面和 `rag` tRPC 接口。

第一版实现：

- `rag.reindex`：读取最近公众号文章，生成轻量 chunk，写入 SQLite 表 `rag_chunks`
- `rag.stats`：查看索引数量和分类分布
- `rag.ask`：把问题转成本地哈希向量，检索相关 chunk，再调用 MiniMax M2.7 生成回答

当前向量索引是轻量哈希向量，不需要本机 embedding 模型，适合 2C 2G 服务器。后续如果要提升语义检索质量，可以把 `RagService.embedText()` 替换成云端 embedding API，并保留现有问答页和 `rag_chunks` 流程。

常用验证：

```bash
curl -I http://127.0.0.1:4000/dash/knowledge
```

MiniMax 中国区 Token Plan 配置：

```bash
MINIMAX_API_BASE_URL=https://api.minimaxi.com/v1
MINIMAX_MODEL=MiniMax-M2.7
```

## 安全建议

- 部署完成后修改 root 密码。
- 改为 SSH key 登录，关闭 root 密码登录。
- `AUTH_CODE` 不要提交到仓库。
- 数据库备份文件不要放到 Web 可访问目录。
- 定期检查：

```bash
journalctl -u wewe-rss --since "1 day ago"
du -sh /root/data /root/backups
systemctl status wewe-rss
```
