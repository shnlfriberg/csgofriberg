# Docker 生产部署

生产镜像仅支持 PostgreSQL，由 GitHub Actions 发布到：

```text
ghcr.io/shnlfriberg/csgofriberg
```

运行镜像基于 distroless Node.js，仅包含生产 Node 依赖、编译后的服务端
JavaScript、编译后的前端资源以及输出到 `server/dist` 的选手种子文件。镜像中
不包含 pnpm、Rust、TypeScript、Vite、源码、测试、构建工具和 SQLite 驱动。

自带的 Compose 编排会运行两个应用实例、PostgreSQL 和 Redis。反向代理与 TLS
不在该编排范围内。两个应用端口默认都绑定在 `127.0.0.1`。

双实例布局请至少准备 2 GB 内存：容器内存限制合计可能超过 1 GB，宿主机、
Docker 守护进程和文件系统缓存也需要余量。

## 1. 安装 Docker

安装带 Compose 插件的 Docker Engine，并验证：

```bash
docker version
docker compose version
```

## 2. 创建部署目录

服务器上只需要仓库中的四个文件：

```text
compose.yaml
deploy/.env.example
deploy/README.md
deploy/update.sh
```

例如：

```bash
sudo mkdir -p /opt/csgofriberg
sudo cp compose.yaml /opt/csgofriberg/compose.yaml
sudo cp deploy/.env.example /opt/csgofriberg/.env
sudo cp deploy/update.sh /opt/csgofriberg/update.sh
cd /opt/csgofriberg
sudo chmod 600 .env
sudo chmod 700 update.sh
sudo editor .env
```

生成相互独立的密钥：

```bash
openssl rand -base64 48
openssl rand -base64 48
openssl rand -hex 24
```

前两个值分别用于 `JWT_SECRET` 和 `GUEST_ID_SALT`，十六进制值用于
`POSTGRES_PASSWORD`。Compose 会根据 PostgreSQL 相关变量拼出 `DB_URL`，
因此密码只需配置一次。

`CORS_ORIGINS` 必须设置为精确的公网 origin（如 `https://game.example.com`），
末尾不带斜杠。

设置 `SHOW_LEADERBOARD=false` 可隐藏排行榜入口并禁用排行榜 API，默认为
`true`。

PostgreSQL 数据存放在 `PGDATA_PATH`，默认为部署目录下的 `./data/pgdata`。
如果你的 Docker 安装不会自动创建 bind-mount 目录，请在首次启动前手动创建
父目录：

```bash
mkdir -p data/pgdata
```

## 3. 启动

GHCR 包为公开时：

```bash
docker compose pull
docker compose up -d
docker compose ps
docker compose logs -f app-1 app-2
```

若包为私有，先用带 `read:packages` 权限的 GitHub token 登录：

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u GITHUB_USERNAME --password-stdin
```

Compose 会先运行一次性的 `migrate` 服务：它负责创建或更新表和索引，并且
仅在选手表为空时导入内置的选手种子数据。迁移未成功退出前，两个应用实例都
不会启动。应用启动时只做只读的表结构就绪检查；表结构变更完全由迁移服务
负责，因此两个实例不会并发执行 DDL。

`app-1` 监听 `APP_PORT_1`（默认 `3000`），`app-2` 监听 `APP_PORT_2`
（默认 `3001`）。二者共用同一 Redis 命名空间与 PostgreSQL 数据库。
Socket.IO 广播通过 Redis Adapter 跨实例转发，多人房间、匹配队列、限流和
进行中的单人对局都共享在 Redis 中。

每个应用实例维护自己的 PostgreSQL 连接池。默认 `DB_POOL_MAX=10` 时，两个
实例最多占用 20 个应用连接；PostgreSQL 总连接上限为 40，为迁移和运维操作
保留余量。

Node 进程会优雅处理 `SIGTERM`/`SIGINT`：先停止接收新的 HTTP 与 Socket.IO
连接，关闭活跃 socket，停止后台 worker，最后释放 Redis 和 PostgreSQL 连接。
Compose 给这个排空过程留出 30 秒，超时才强制停止容器。

启动失败时单独查看迁移输出：

```bash
docker compose logs migrate
docker compose ps -a migrate app-1 app-2
```

健康检查：

```bash
curl http://127.0.0.1:3000/api/health
curl http://127.0.0.1:3001/api/health
```

## 4. 反向代理

当应用前面只有一层可信反向代理时，保持 `TRUST_PROXY=true`，且该模式下不要
把 Node 端口暴露到公网。Nginx 需要同时转发 HTTP 和 Socket.IO WebSocket
流量，并设置：

```nginx
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
```

HTTP 与 Socket.IO 的限流都以最近一跳可信代理为准。

upstream 配置示例：

```nginx
upstream csgofriberg_backend {
    least_conn;
    server 127.0.0.1:3000 max_fails=1 fail_timeout=5s;
    server 127.0.0.1:3001 max_fails=1 fail_timeout=5s;
    keepalive 64;
}

location /assets/ {
    proxy_pass http://csgofriberg_backend;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_connect_timeout 1s;
    proxy_next_upstream error timeout http_404 http_502 http_503 http_504;
    proxy_next_upstream_tries 2;
}

location / {
    proxy_pass http://csgofriberg_backend;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_next_upstream error timeout http_502 http_503 http_504;
}

location /socket.io/ {
    proxy_pass http://csgofriberg_backend;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_connect_timeout 1s;
    proxy_next_upstream error timeout http_502 http_503 http_504;
    proxy_next_upstream_tries 2;
    proxy_read_timeout 90s;
    proxy_send_timeout 90s;
    proxy_buffering off;
}
```

独立的 `/assets/` location 是滚动更新的必要条件：Vite 资源使用内容哈希
文件名，旧实例对新实例产出的 chunk 会返回 404（反之亦然），对 `http_404`
重试可以让 Nginx 从另一个实例取到该 chunk。应用刻意不对缺失的 `/assets/`
路径或其他带扩展名的 URL（如 `/missing.js`）返回 SPA 的 `index.html`
兜底——模块请求收到 HTML 会因 MIME 类型错误而失败。只有不带扩展名的应用
路由才使用 SPA 兜底。

当前客户端的 Socket.IO 仅使用 WebSocket 传输，因此不需要粘性会话。若要
启用 HTTP 长轮询，请先配置好会话亲和。

## 5. 创建或重置管理员

在一次性的应用容器中运行编译后的管理命令，使用与生产相同的镜像和网络：

```bash
docker compose run --rm \
  -e ADMIN_USERNAME=admin \
  -e ADMIN_PASSWORD='replace-with-at-least-12-characters' \
  app-1 server/dist/db/createAdmin.js
```

命令运行期间密码对本地进程环境可见。在共享服务器上，请使用仅 root 可读的
临时环境文件，并通过 `docker compose run --env-file` 传入。

## 6. 更新与回滚

常规滚动更新使用自带的更新脚本：

```bash
cd /opt/csgofriberg
sudo ./update.sh
```

脚本会阻止并发更新、拉取配置的镜像、在触碰任何应用实例之前先执行迁移，
然后逐个替换 `app-1` 和 `app-2`，每一步都等待 Docker 健康检查通过后才继续。
如果更新后的实例在 180 秒内未变为 healthy，脚本会停止该实例，保留另一个
实例继续对外服务。

每次前端构建都会以构建时间戳作为资源版本。两个实例都恢复 healthy 后，
打开管理后台选择「资源版本」并广播当前版本：本地版本不一致的在线客户端会
弹出刷新提示。最近一次广播存储在 Redis 中，重连和新打开的客户端也会收到。

用 `UPDATE_HEALTH_TIMEOUT_SECONDS` 调整健康检查等待时限。旧镜像默认保留
以便回滚；设置 `PRUNE_OLD_IMAGES=1` 可在更新成功后清理未使用的镜像。

```bash
sudo UPDATE_HEALTH_TIMEOUT_SECONDS=300 ./update.sh
sudo PRUNE_OLD_IMAGES=1 ./update.sh
```

等效的手动流程如下：先执行一次迁移，再逐个替换应用实例。替换期间 Nginx
保持另一个实例可用，Socket.IO 客户端通过共享的 Redis 状态重连：

```bash
docker compose pull migrate app-1 app-2
docker compose up migrate
docker compose up -d --no-deps app-1
docker compose ps app-1
curl http://127.0.0.1:3000/api/health
docker compose up -d --no-deps app-2
docker compose ps app-2
curl http://127.0.0.1:3001/api/health
docker image prune -f
```

单个实例的停机不再设置全局维护标记，否则会影响健康实例上的断线判负逻辑。
当两个实例必须同时停止时，请先显式暂停断线判负（最长 10 分钟）再停止：

```bash
docker compose run --rm app-1 server/dist/maintenance.js 120
docker compose stop app-1 app-2
```

参数为维护窗口的秒数。常规滚动更新不需要这个命令。

如需可确定性的生产发布，把 `IMAGE` 固定为已发布的版本号或 commit 标签，
例如：

```text
IMAGE=ghcr.io/shnlfriberg/csgofriberg:sha-0123456
```

回滚时把 `IMAGE` 改回上一个标签并执行：

```bash
docker compose pull migrate app-1 app-2
docker compose up migrate
docker compose up -d --no-deps app-1
docker compose up -d --no-deps app-2
```

PostgreSQL 数据位于配置的 `PGDATA_PATH` bind mount，Redis 数据位于命名
卷中，更换应用镜像不会影响二者。

## 7. 备份

PostgreSQL：

```bash
docker compose exec -T postgres \
  pg_dump -U csgofriberg -d csgofriberg -Fc > csgofriberg.dump
```

Redis 存放进行中的对局、房间、队列和缓存，PostgreSQL 是持久的历史数据
存储。Compose 中已启用 Redis AOF，容器重启后活跃状态可以恢复。

`REDIS_COMMAND_TIMEOUT_MS` 默认 1500 毫秒，作用于限流等请求路径上的
Redis 操作，避免 Redis 拥塞时无限期挂起 HTTP 请求。

密码哈希在有界的 worker 线程池中执行，登录和注册不会阻塞主 HTTP 与
Socket.IO 事件循环。`PASSWORD_WORKERS` 默认每实例 1 个（整个编排共 2 个），
`PASSWORD_QUEUE_LIMIT` 默认每实例 64。`BCRYPT_ROUNDS` 默认 8 以降低认证的
CPU 开销；成本不同的既有哈希会在下次登录成功后自动重新哈希。

未完成的单人对局在最后一次操作后最多在 Redis 中保留 1800 秒（30 分钟），
对局结束或显式退出会立即清除。

## GitHub Actions 发布

`.github/workflows/docker.yml` 在 pull request 上运行测试和完整的生产构建。
推送到 `main`、`v1.2.3` 形式的版本标签以及手动触发还会构建 `linux/amd64`
镜像并发布到 GHCR。

发布的标签包括：

- `latest`：默认分支
- 分支名
- `v*` 发布对应的语义化版本标签
- `sha-<短提交号>`：用于可确定性部署

工作流使用 BuildKit 缓存，生成 provenance 并附带 SBOM。
