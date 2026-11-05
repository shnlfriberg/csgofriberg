# 本机 Docker 配置与容器验收

记录时间：2026-10-23 03:44（Asia/Shanghai）。工作区：`F:\friberg-ex`。

## 安装与存储

用户授权在 F 盘安装 Docker 并完成项目验收。本机安装 Docker Desktop 4.96.3，Engine 29.9.2，Compose 5.6.1；使用 WSL 2 / Linux amd64，context 为 `desktop-linux`。

| 内容 | 实际位置或设置 |
| --- | --- |
| 程序 | `F:\Docker\Desktop` |
| Docker CLI | `F:\Docker\Desktop\resources\bin\docker.exe`，已加入系统 PATH，新终端生效 |
| 镜像、构建缓存和数据卷所在虚拟磁盘 | `F:\Docker\wsl\disk\docker_data.vhdx` |
| Docker WSL 系统盘 | `F:\Docker\wsl\main\ext4.vhdx` |
| 官方安装包 | `F:\Docker\installers\DockerDesktopInstaller.exe` |
| 用户配置 | `%APPDATA%\Docker\settings-store.json` |
| Docker 日志 | `%LOCALAPPDATA%\Docker\log` |
| WSL 集成 | 启用既有 `Ubuntu-24.04` |
| 登录 Windows 自动启动 | 关闭；需要时手动启动 Docker Desktop |

程序及主要磁盘数据在 F 盘；少量用户配置、日志和 Windows 注册信息仍由 Docker 放在系统用户目录。没有迁移既有 Ubuntu 发行版，也没有改动用户原有全局 `.wslconfig`：内存上限 20 GB、12 个处理器、32 GB swap。这些是 WSL 共享上限，不是 Docker 的固定内存占用。

安装包来自 Docker 官方下载地址，执行前验证 Authenticode 状态为 `Valid`、签名者为 Docker Inc，SHA-256 为 `3D8ADAD4F6C86583E0B00EA19A76197C51CCF5C83437C9ED775B739756452507`。使用官方安装参数指定 `--backend=wsl-2 --no-windows-containers --installation-dir=F:\Docker\Desktop --wsl-default-data-root=F:\Docker\wsl`；安装退出码 0，无须重启 Windows。安装及设置依据见 [Docker Windows 官方文档](https://docs.docker.com/desktop/setup/install/windows-install/)和 [WSL 集成文档](https://docs.docker.com/desktop/features/wsl/)。

## 验收结果

| 验收 | 结果及覆盖范围 |
| --- | --- |
| Docker 自检 | Client/Server 版本正常，Compose 正常，`hello-world` 成功 |
| 游戏镜像构建 | `friberg-local:verify-20261023` 构建成功，运行时 Node 26.12.1、UID 65532 |
| 生产脚本 | `scripts/verify-production.sh` 完整通过，最终退出码 0 |
| PostgreSQL | 空库、旧经典记录与重复迁移通过；图寻查询投影、旧 JSON/共享快照回放、持久提交幂等通过 |
| 双应用实例 | 共享图片可读、图寻结算生成两条唯一结果、回放可还原 |
| HTTP 与认证 | 静态资源、深链、缓存、真实 PoW、安全 Cookie、代理指纹、Origin 拒绝、海龟汤结算和回放、登录/认领/退出通过 |
| 实际 Compose 编排 | 原 `compose.yaml` 的 migrate 顺序、内存限制、只读根目录、非 root 运行及四个长期服务健康检查通过 |
| 重启持久化 | 停止两应用、重启 PostgreSQL/Redis、恢复应用；题目/两条成绩、Redis 测试值和两实例原图/缩略图 SHA-256 前后一致 |
| 爬虫镜像 | `friberg-scraper:verify-20261023` 构建成功；容器中 128 项 unittest，127 通过、1 项联网测试按原规则跳过 |
| 原有数据 | 只读比对 11 张业务表的全部行值哈希及 822 个资源文件哈希，前后完全一致 |

游戏验收使用临时 PostgreSQL（仅内置 5 人种子）、独立 Redis、临时图片卷及随机测试密钥，没有挂载真实 SQLite、真实上传目录或实际 `.env`。爬虫测试使用 `--network none`、只读根目录、只读测试源码挂载及 `/tmp`，未运行真实抓取或向线上提交。

Compose 补充验收使用独立 `friberg-compose-qa-20261023-<PID>` 项目，临时覆盖 PostgreSQL 存储为该项目的专用命名卷，并移除应用宿主机端口映射；其余服务约束沿用项目文件。仅清理这个临时项目的容器、网络、卷和测试密钥。结束时 Docker 中没有遗留容器或数据卷，保留镜像与构建缓存以便复测；Docker 引擎保持运行。

截至本次只读核对，真实本机仍为 669 名选手、408 道题、379 个草稿、381 个位置、822 个图片资源。网页 `5175` 返回 200，API `3002` 返回 `ok=true, redis=up`，原 Redis `16380` 保持运行。本轮没有迁移真实数据库、改写题单、重算成绩或发布线上。

## 本轮修正与边界

- Windows 的 CRLF 曾导致 Bash 在 `set -euo pipefail` 处退出；将验收脚本保存为 LF，新增 `.gitattributes` 的 `*.sh text eol=lf`，防止后续 Git 检出重新引入。
- 原验收脚本清理容器时未删除镜像声明的匿名卷。现对明确命名的临时 QA 容器使用 `docker rm -fv`；正式图片命名卷仍由原有独立清理处理。复测后卷数为 0。未执行全局 prune。
- 构建日志中的可选 `better-sqlite3` 编译失败没有使构建失败：该驱动属于本机 SQLite 可选依赖，容器使用 PostgreSQL。没有为此增加生产镜像的编译工具；sharp 图片处理已在容器验收实际通过。
- 补充持久化探针首次误用成绩表不存在的 `id` 排序字段，修正为实际的 `identity_key` 后通过；没有修改业务表结构。
- 未验证真实第三方 GeeTest、SMTP 和公网 TLS，也没有执行真实 SQLite 到 PostgreSQL 的迁移、整站备份恢复或远端 CI 发布。本次结果不能替代这些上线工作。

## 后续使用和复测

在 PowerShell 启动引擎并检查：

```powershell
Start-Process 'F:\Docker\Desktop\Docker Desktop.exe' -WindowStyle Hidden
docker version
docker compose version
```

若旧终端尚未刷新 PATH，可以先执行 `$env:Path = 'F:\Docker\Desktop\resources\bin;' + $env:Path`，或重新打开终端。

构建当前工作区并验收（确保 Docker 已就绪）：

```powershell
Set-Location F:\friberg-ex
docker build --progress=plain -t friberg-local:verify .
wsl -d Ubuntu-24.04 --exec bash -lc 'cd /mnt/f/friberg-ex && bash scripts/verify-production.sh friberg-local:verify'
docker build --progress=plain -t friberg-scraper:verify external-scraper
docker run --rm --network none --read-only --tmpfs /tmp --entrypoint python --mount 'type=bind,source=F:\friberg-ex\external-scraper\tests,target=/app/tests,readonly' friberg-scraper:verify -m unittest discover -s tests -v
```

正常开发仍使用 `启动本机测试.cmd`，不依赖 Docker。需要正式常驻容器服务时，另行准备独立部署配置、真实数据迁移与备份，不将现有根目录 `.env` 替换成部署示例。不要在真实部署项目执行 `docker compose down -v`。

## 验证材料

全部本机证据位于 `.local-data/verification/docker-20261023/`，不含真实业务凭据：

- `installer.json`、`environment.json`、`docker-version.json`、`images.jsonl`：签名、安装路径、版本、实际镜像 ID/digest 与运行状态。
- `build.log`、`scraper-build.log`、`acceptance-final.log`、`scraper-tests.log`：构建及最终验收输出。
- `compose-acceptance.sh`、`compose-persistence.cjs`、`compose-acceptance.log`、`persistence-before.json`、`persistence-after.json`：本次补充编排/重启演练及测试夹具证据。
- `preservation-before.json`、`preservation-after.json`、`preservation-result.json`：11 张表及 822 个文件的前后哈希核对。

固定上游提交保持 `99f2e471474cfefd38de13033608bdc816a24242`。仅审阅并更新验收脚本清理改动的本机哈希；上游检查为 275 个相同、44 个已审阅扩展、0 缺失、0 意外差异。
