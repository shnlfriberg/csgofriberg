# 弗一把本机整合版

整合日期：2026-10-19。结果目录：`F:\friberg-ex`。

2026-11-06 仓库边界更新：以下爬虫联调步骤仅适用于已获得私有 `shnlfriberg/external-scraper` 权限、将其检出到游戏 `external-scraper/` 并恢复其中 `workspace-integration/` 的维护者。爬虫程序、专用脚本和 `compose.scraper.yaml` 不再随公开游戏仓库分发。普通游戏启动、管理员创建及前后端测试不要求安装爬虫。本机既有联调文件和真实配置保留，不要用私有仓库示例覆盖已有配置或工作数据。

2026-10-20 已与 GitHub 主仓库 `csgofriberg@99f2e47` 重新逐文件核对。公共业务代码已具备上游最新修复；旧 `scripts/local.ps1` 已改为调用本整合版的启动、停止、测试和导入流程。版本关系、全部差异及复查命令见 [上游统一结果](upstream-unification.md)。

## 直接开始测试

1. 双击根目录 `启动本机测试.cmd`。
2. 打开 <http://localhost:5175/>，或直接进入 <http://localhost:5175/admin>。
3. 使用 `.local-data/test-admin.json` 中的 `username`、`password` 登录。新建账号为 `integration_admin`，角色为管理员；密码由系统随机生成。
4. 首页“娱乐模式”可进入随机五轮图寻、每日图寻、多人图寻及海龟汤。
5. 后台的“选手管理”“选手变更审核”“API TOKEN”“图寻管理”使用同一账号与同一数据库。
6. 结束时双击 `停止本机测试.cmd`，保存 Redis 状态并停止本工作区的服务。

| 服务 | 本机地址 / 配置 |
| --- | --- |
| 网页 / 管理后台 | `http://localhost:5175/` / `http://localhost:5175/admin` |
| API 健康检查 | `http://127.0.0.1:3002/api/health` |
| Redis | `127.0.0.1:16380`，键前缀 `friberg-integrated:` |
| SQLite | `server/data/csgofriberg.sqlite3` |
| 图寻图片 | `data/location-assets/` |
| Node 26 | `.tools/node-v26.10.0-win-x64/` |
| 运行日志 | `.local-data/*-local.stdout.log`、`*-local.stderr.log` |

脚本只管理已记录并核验 PID、进程创建时间、可执行路径和工作区入口的进程。端口已被其他工作区占用时会报错。原项目目录保留。

2026-10-28 起，本机启动默认先进行前端类型检查和构建，再用 Vite preview 提供稳定测试页面（产物位于 `.local-data/client-preview/`，仅监听本机）。它不加载开发热更新客户端，因此热更新连接中断不会触发整页刷新。API、图片和 Socket 仍代理到原本机后端。代码修改后重新运行启动脚本，再手动刷新页面；旧哈希资源保留，避免已打开页面懒加载失败。该目录是生成缓存，长期开发会累积旧资源，不属于数据库备份。需要开发热更新时显式运行 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-location-local.ps1 -HotReload -NoBrowser`，此模式仍有 Vite 的重连刷新行为。正式部署继续使用原 Docker 流程，不能把 preview 用于公网生产服务。

## 来源核对与合并原则

`F:\external-scraper-main` 包含多个爬虫副本、一个游戏仓库和启动脚本。其 `local-test.config.json` 指向 `F:\csgofriberg2-main\csgofriberg2-main`；因此该处的实际选手数据库也纳入了本次数据合并。

| 部分 | 采用的来源 | 处理 |
| --- | --- | --- |
| 游戏主体、普通模式、海龟汤、用户、后台 | `F:\CS-guesser猜位置小游戏` | 保留现有实现 |
| 娱乐入口、图寻前后端、雷达、题目及采集工作台 | 同上 | 完整保留源码、测试、资料和原始截图 |
| 爬虫 CLI、规则、比较器、API 客户端、测试和部署 | `F:\external-scraper-main\work\github-external-scraper` | 整合到 `external-scraper/` |
| 爬虫侧游戏代码参考 | `F:\external-scraper-main\work\github-csgofriberg` | 与图寻主体逐文件比较，公共部分已被主体包含 |
| 选手库、难度成员、原变更审核记录、旧账号 | 启动脚本指向的实际旧数据库 | 以 SQLite 在线备份取得一致快照后合并 |
| 历史爬虫副本 | `external-scraper-main`、`external-scraper-pr` 子目录 | 有差异或独有的文件保存在 `integration/source-archives/` |

源文件清单和 SHA-256 位于 `integration/source-manifest.json`。比对同时计算了统一换行后的哈希，避免把 CRLF/LF 差异误认成功能差异。

图寻项目覆盖了爬虫侧游戏仓库的全部 320 个清单条目；其中 297 个内容一致（统一换行后），23 个有差异，差异集中于图寻接入、依赖、构建、部署、相关页面和测试。爬虫侧没有独有的游戏文件需要额外覆盖。公共选手管理、字段审核、Token 和导出接口沿用原实现。`external-scraper-main` 与所选爬虫当前共同文件内容一致；PR 副本有 8 个历史差异文件，已保留供回查。

依赖目录、缓存、旧进程记录、Git 元数据不作为源代码混入整合版。Node、Redis 和 pnpm 依赖在本工作区单独准备。Windows 没有 Visual C++ 编译环境，`better-sqlite3` 的可选本机扩展无法构建，本机脚本沿用图寻项目已有的 `.tools/sqlite-shim.cjs`，通过 Node 26 内置 SQLite 运行；生产 Docker 仍使用 PostgreSQL。

## 功能连接

### 娱乐与图寻

保留随机五轮、每日挑战、多人图寻、战绩回放和统计，以及海龟汤入口。图寻管理保留采集工作台、连续标点、截图配对、getpos 坐标、难度、审核发布、地图校准、题库检查、每日出题和 ZIP 备份迁移。

已有 10 张地图定义；115 道已发布图片题目前全部来自 Dust2，按简单 / 中 / 困难分别为 68 / 29 / 18 张。同一个站位可以有多张图片，抽题会避开站位重复。其他地图保留原有配置，尚无正式题目；Train 的校准待完成。这些是原题库状态，本次未生成虚构题目或修改原发布状态。

### 爬虫与选手库

保留 Python 的 `crawl`、`compare`、`submit`、`sync`、`normalize-teams`，以及断点续传、运行锁、动态基准、失败回退、队伍身份归一、历史队伍同步、cmtry 角色规则、差异报告、分批提交及原部署说明。

```text
整合版数据库 → GET /api/external/players/export
                  ↓ 最新选手清单 / ID / 当前值
          爬取 → 归一化 → 字段差异
                  ↓ POST /api/external/player-change-submissions
          后台“选手变更审核” → 批准 / 拒绝 / 冲突检查 → 选手库
                  ↓
          查选手 / 普通模式 / 海龟汤
```

本机 `external-scraper/config.json` 已配置整合版 API 地址及新管理员名下的 90 天 Token。数据库只存 Token 哈希；配置文件和账号凭据均由 Git 忽略。默认 `dry_run=true`。爬虫的预览仍会访问 Liquipedia，但不会提交变更。完整爬取的时间取决于选手数量、请求间隔及网络。

双击根目录 `爬虫预览.cmd`，或在 PowerShell 中运行：

```powershell
.\scripts\run-local-scraper.ps1 -Mode Preview
```

确认需要真正提交到本机待审核队列时：

```powershell
.\scripts\run-local-scraper.ps1 -Mode Submit
```

该命令提交到审核队列，管理员在后台批准后才更新选手。脚本校验目标必须为 `127.0.0.1:3002`。未安装或启用任何定时任务。

其他爬虫命令仍可直接使用 `python external-scraper/cli.py --help`。爬虫本来是独立 Python CLI，本次保留其操作方式；游戏后台负责选手管理、Token 及审核。详细参数见 `external-scraper/README.md`。

## 数据合并与备份

数据库合并脚本为 `scripts/merge-local-databases.py`，已有输出数据库时会拒绝覆盖。原数据库通过 SQLite backup API 复制到 `.local-data/backups/location.sqlite3` 与 `players.sqlite3`，未直接复制可能正在写入的数据库文件。

| 数据 | 合并时数量 |
| --- | ---: |
| 选手 | 669 |
| 原账号 | 3（另新增测试管理员 1 个） |
| 访客 | 307（实际访问后继续增加） |
| 难度成员关系 | 1,394 |
| 原选手变更提交 / 字段记录 | 4 / 146 |
| 多人对局 / 参与者 / 举报 | 28 / 63 / 3 |
| 经典每日题目 | 9 |
| 图寻地图 / 版本快照 | 10 / 256 |
| 图寻发布题目 / 采集草稿 | 115 / 107 |
| 图寻历史结果 | 3 |

原选手库有 668 人；图寻库中独有的 NiKo 使用原空闲 ID 4 补入，合计 669 人。s1mple、ZywOo、device、donk 使用选手库现值，避免用图寻开发用的 5 人种子库覆盖已有维护数据。共用选手的难度关系同样以选手库为准。所有原选手库行在合并完成时逐行核验保留；账号与选手 ID 保持一致，历史 JSON 引用无需改写；经典每日题目的自增 ID 重新分配以避开碰撞。

146 条字段记录保留原审核状态：143 条已批准、3 条已拒绝；没有待处理项。本次不自动批准。初始数量与完整性结果见 `integration/database-merge.json`。数据迁移事务执行 `foreign_key_check`、`integrity_check`，均通过。使用过程中的用户访问、每日出题和测试账号操作会使部分记录数量自然增加。

## 验证与复现

构建命令（先将 `.tools/node-v26.10.0-win-x64` 加入 PATH）：`pnpm build`。

```powershell
.\scripts\test-integrated.ps1 -Suite all
python scripts/smoke-integrated.py
```

测试脚本每次使用新的 `.local-data/verification/<随机ID>/` 数据库和图片目录，以及 Redis 第 15 号库中的随机前缀。测试中的 Redis 可选设置支持原有内存回退单元测试；正常运行的整合版仍要求 Redis。测试不会使用正式本机选手库、题库或图片目录。

HTTP 冒烟测试走实际网页代理与 PoW / 登录流程，检查管理员权限、669 人导出、Token 鉴权、未授权拒绝、115 道题、107 个采集点、图片完整性、三档抽题配比以及随机五轮创建和图片加载；随后放弃该测试对局。提交测试使用不变字段，返回 `submitted=0`，不生成新的待审核项。报告见 `integration/http-smoke.json`。选手变更提交、审批、冲突及图寻多人跨进程行为由后端回归测试覆盖。

前端 229 项、后端 283 项、爬虫 124 项全部通过；爬虫另 1 项真实联网测试按原设置跳过。动态基准预览发现 Acilion、acilion、tenzki 的历史队伍中存在可归一化的旧别名，共 3 项；保留了差异产物，未提交或改库。

真实 Liquipedia 全量联网爬取未执行；联网测试维持原项目的显式开启机制。最终测试数量及结果见 `integration/verification.json` 与 `.local-data/*-tests.log`。

管理员初始创建可复现：运行 `scripts/create-test-admin.ps1`；若已有本机凭据文件则使用原凭据重新设置该测试管理员。不要把本机随机测试凭据复制到生产。

## 部署整合

根目录保留游戏 Dockerfile、生产 Compose、共享图寻图片卷和题库导入工具；`external-scraper/` 保留独立 Python Dockerfile、systemd 与 cron 示例。

可选的 `compose.scraper.yaml` 把爬虫接到同一 Compose 网络；先创建 `external-scraper/config.docker.json`，使用 `api_url=http://app-1:3000`、生产管理员生成的 Token 及容器内路径，随后运行：

```text
docker compose -f compose.yaml -f compose.scraper.yaml --profile scraper run --build --rm scraper
```

默认只预览。正式同步时在命令末尾显式提供 `sync --config /config/config.json --no-dry-run`。爬虫状态、输出和日志使用独立持久卷。生产部署继续遵循 `deploy/README.md` 的 PostgreSQL、JWT、Redis 与验证码配置要求。本次只启动了 Windows 本机测试环境，Docker 生产部署未执行。
