# 当前工作区与 shnlfriberg 仓库的完整差异

## 2026-11-04 全量复核与修复验收

本节为最新结果，采集与验证时间为 **2026-11-04，Asia/Shanghai**。后面的 2026-10-23 章节保留作历史记录。

结论：本机已经扩展为包含图寻、卡牌连接、选手生涯和更完整爬虫审核链的版本。本轮发现并修复了稳定 ID 导入、非法查询处理、发布工作流、图片内存和依赖安全问题；最终代码、数据一致性和受限双实例容器验收通过，可以进入目标服务器部署验收。尚不能认定“线上已具备全部上线条件”，因为未连接线上运行主机、未验证目标环境的外部服务与恢复流程，也未发布本轮修改。

### 比对范围与证据

- 指定游戏仓库 [csgofriberg/main](https://github.com/shnlfriberg/csgofriberg/commit/99f2e471474cfefd38de13033608bdc816a24242) 当前仍为 `99f2e471474cfefd38de13033608bdc816a24242`；提交时间 2026-10-18 17:12:08 +08:00。已核对远端引用、文件树及全部跟踪文件内容。
- [external-scraper/main](https://github.com/shnlfriberg/external-scraper/commit/ce0c9509534be74609263bdd98bcd690221647c6) 当前仍为 `ce0c9509534be74609263bdd98bcd690221647c6`；提交时间 2026-10-18 17:11:37 +08:00。PR #3 仍 open，head `740ec2ac`，不视作 main 已合并；本机较新爬虫实现保持不被旧版本覆盖。
- `csgofriberg2` 已被用户废弃，不作游戏同步或上线基准。
- 上游 [CI run 39114403769](https://github.com/shnlfriberg/csgofriberg/actions/runs/39114403769) 成功，但 GitHub main/CI 成功不能证明线上主机正在运行这一镜像。
- 远端 blob 使用 Git SHA 校验；文本仅归一 CRLF/LF，二进制比较字节。检查包含前后端、共享包、爬虫、测试、脚本、部署配置、文档和静态地图资源。排除依赖/构建产物、工具运行时、缓存、旧源码归档、真实数据库/图片和敏感配置；真实数据另作只读审计与哈希保真。
- 全文件清单、每个同路径差异的补丁和远端证据：[`comparison.json`](../.local-data/verification/full-release-audit-20261104/comparison.json)、[`diffs/`](../.local-data/verification/full-release-audit-20261104/diffs/)、[`remote-evidence.json`](../.local-data/verification/full-release-audit-20261104/remote-evidence.json)。完整清单列出相同、修改、本机独有及缺失文件，没有用目录抽样代替全文件比对。

| 比较对象 | 远端跟踪 | 相同 | 同路径修改 | 本机缺失 | 生成文件另行排除 | 本机独有 | 本机纳入比较总数 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| csgofriberg/main | 320 | 260 | 59 | 0 | 1 | 411 | 730 |
| external-scraper/main | 42 | 20 | 22 | 0 | 0 | 20 | 62 |

游戏表包含本机爬虫目录，两个表不能相加。根目录没有 `.git`，因此没有虚构本机提交号或领先提交数。本轮修改后重新生成上述统计。

### 本机新增玩法与功能

| 模块 | 相对上游的增量 | 核心代码位置与检查结论 |
| --- | --- | --- |
| 图寻单人 | 截图定位、距离评分、随机/每日五轮、三难度、历史回放 | `packages/location-core`、`server/src/location`、前端 location 页面；规则、固定每日题、隔离题池、旧/新 codec 均验证 |
| 图寻多人 | 2–8 人好友房、双人随机匹配、禁图、准备/轮次/结算、断线恢复 | 同上及多人/Socket 模块；房间权限、快照版本、Redis/SQL 故障恢复、两实例结算通过 |
| 图寻制作与贡献 | 采集草稿、独立点位、同点多图、裁剪/缩略图、地图楼层与校准、点位合并、玩家投稿审核、题库 ZIP 导入导出 | 后台/采集工作台、location assets/bank/projections；真实图片全解码、坐标/引用/配额检查通过；内存问题本轮已修复 |
| 卡牌连接玩法 | 无限牌库与限定手牌两种规则；练习、每日、好友、排位四场景；限定 7 张手牌及机会规则、三局对战 | `packages/card-link-core`、`server/src/card-link`、前端 card-link 页面；规则、合法路径、确定性发牌和手牌隐私验证 |
| 卡牌持续运营 | 每日可重做取最佳、上海零点截止、Elo、排行/个人统计/回放、生涯证据展示 | matches/settlement/leaderboard/stats/replay；跨零点、访客认领、最好成绩及唯一结算通过 |
| 卡牌后台 | 生涯任期审核、关系图后台构建/发布/回退、分场景开关、变更审计 | careers/graphs/buildJobs/operations；源版本失效、人工字段保护、发布/回退权限与审计验证 |
| 账号 | 找回密码、已验证邮箱绑定、验证码限流与单次消费、重置后撤销 token | auth/passwordReset；真实 PG+Redis 并发验证，发信本身使用模拟服务 |
| 选手库与爬虫 | 稳定 playerId、动态基准、expected 冲突检测、scopes、幂等回执、生涯时间线和来源解析、人工修正保护、失败重试报告 | `external-scraper`、playerMutations/playerChangeSubmissions/submissionIdempotency；新 Python 环境回归与审核链验证通过 |
| 共用能力 | 分玩法在线人数、缓存代次失效、锁续租、模块懒加载、跨端共享规则、统一隔离测试/启动和生产门禁 | services、packages、scripts、Docker/Compose/CI；经典玩法回归与容器静态资源/SPA 验证通过 |

经典猜选手、经典每日挑战、多人接力/2v2、海龟汤在上游已经存在，不能算成本机新玩法。它们的共用身份、认领、缓存、锁、在线统计和基础依赖有扩展，所以本轮仍运行全部前后端测试，未仅测试两个新模块。

### 逐项上线评估

| 检查项 | 实际核对内容 | 当前判定 |
| --- | --- | --- |
| 玩法闭环 | 创建、操作、结束、计分、重复请求、历史回放、退出/恢复 | 自动化与生产镜像门禁通过 |
| 身份与权限 | Cookie/PoW、登录/登出、Socket 身份、访客认领、后台角色与外部 Token scopes | 通过；随机匹配保留“登录且邮箱验证”，没有扩大到普通访客或好友房 |
| 数据迁移 | 空库、旧库、重复迁移、readiness、投影和老 JSON 快照兼容 | SQLite 回归及 PostgreSQL 实际迁移通过；DDL 由独立迁移作业执行 |
| 并发与故障 | 双实例操作、请求去重、互斥/续租、应用死亡、Redis 异常、唯一结算 | 隔离环境通过；正式 DB/Redis 未注入故障 |
| 图寻首发题库 | 七张开放地图、三难度、每日/随机保留题、禁 0–2 图后的取题、图片引用和校准 | 七图符合用户首发计划；87 种禁图×难度组合全部可用 |
| 卡牌关系与题库 | 批准任期/schema/投影、当前图重建、端点距离/起手可解性 | 646 人/5,277 边；60,000 端点、9,000 起手通过；重建与活动图一致 |
| 资料事实质量 | 模糊日期、日期间隙、重叠、未知角色、人工保护及待审数据 | 结构一致；不等于所有历史事实均经人工核实。保留不确定值和待审状态，不编造日期、不批量批准 |
| 导入与错误处理 | ID/昵称冲突、同批重复 ID、整批回滚、非法 query/分页 | 本轮复现后修复并添加回归，SQLite/PG/HTTP 通过 |
| 运行资源 | 真实 Compose heap/内存/池限制、后台构图与在线操作、大图并发上传 | 原 256 MiB OOM 已复现并修复；512 MiB 配置下最终门禁通过 |
| 依赖与发布 | pnpm/Python 漏洞数据库、锁文件、构建、CI 隔离路径、候选镜像门禁 | 本次审计零告警；新 GitHub 工作流未推送运行，不能声称远端 CI 已验证本轮代码 |
| 真实设备与目标运维 | 手机触控、邮件投递、GeeTest 公网校验、TLS/反代、目标机容量/备份恢复 | 本轮未连接目标环境，仍需部署验收 |

### 本轮发现并修复的问题

1. **稳定 ID 导入可能覆盖错人或复制人物。** 原检查依赖 career 字段与同昵称记录；构造不带 career 的同昵称异 ID 导入会更新错人，旧导出遇改名会新建重复人物。现在同时查询昵称和 ID，拒绝不匹配及同批重复 ID，返回 `409 PLAYER_TARGET_MISMATCH`，整个事务保持不变；保留无 ID 的旧格式和真正新人物导入。修复前两个反例确实失败，修复后 SQLite、PG 回归通过。
2. **卡牌非法 query 变成 500。** stats/replays/history/leaderboard/daily-leaderboard/reviews 改为统一 `validateQuery`；分页须为范围内整数，非法输入为 `400 VALIDATION_FAILED`。添加真实 HTTP 回归。
3. **发布工作流路径与测试隔离约束冲突。** CI 数据库从 `/tmp/friberg-ci.sqlite3` 改为 `/tmp/friberg-verification/ci.sqlite3`，否则卡牌测试直接 `ISOLATED_DB_REQUIRED`。同时添加 pnpm 全依赖审计。
4. **旧生产门禁没有使用生产内存限制。** 现在检查 Compose 默认值并施加相同应用/迁移/PG/Redis 内存、Node heap、连接池与密码 worker 数；构图在真实应用子进程执行，同时运行 100 房间/200 玩家负载；收集 cgroup 峰值和 OOM 计数。
5. **4,000×4,000 图片并发上传导致 256 MiB 应用 OOM。** 有 Docker OOM 事件和失败日志证据。新增总解码像素预算 16,000,000、Sharp 单线程/关闭缓存，保留原压缩字节/并发预算，超额返回 429 并可重试；应用与离线题库导入容器改为 512 MiB，heap 仍 192 MiB。最终同场景首轮返回 200/429，重试两张均成功，另一实例可读取。
6. **JavaScript 依赖存在已知安全告警。** 初始生产依赖审计 28 条；全量审计另有开发工具告警。升级 Express 4.22.3、Sharp 0.35.5、Socket.IO 4.8.3、Zod 4.6.7、Axios 1.20.0、React Router 7.18.5、Vite 6.4.5、Vitest 4.1.12 及传递依赖；shell-quote 使用 1.11.0 override。Zod 4 的 record 和 optional 默认值行为已适配，防止部分更新覆盖队伍/启用状态等未提交字段，并加回归。最终全部 485 依赖零告警。审计条目不等同于已证明可被当前应用利用的入口。
7. **爬虫 HTTP/证书依赖过旧。** 初始 3 包有 11 条审计记录（含公告别名重复）；新依赖要求 Python ≥ 3.10。本机新建独立 CPython 3.12.16 venv，安装 requests 2.34.2、urllib3 2.8.0、certifi 2026.10.23 等，五包审计零告警。启动/测试脚本优先选择 venv，CI 最低 Python 改为 3.10，文档同步。没有替换系统 Python，也没有运行真实采集送审。

### 最终测试与真实数据保真

| 验证 | 最终结果 | 证据 |
| --- | --- | --- |
| 服务端 | 78 文件，468 项通过，Vitest 4.1.12 | `tests-final.log` |
| 前端 | 64 文件，331 项通过，Vitest 4.1.12 | `tests-final.log` |
| 爬虫 | 173 项中 172 通过、1 联网测试跳过，Python 3.12.16 | `scraper-final.log`；Windows 临时夹具补齐新 helper 后重跑 |
| 完整构建 | 共享包、服务端、前端通过 | `build-final.log` |
| 最终 Docker 镜像 | 构建成功 | `docker-build-final.log`；`friberg-local:full-release-audit-final-20261104` |
| 受限生产容器 | PG/Redis 双实例全部门禁通过 | `production-acceptance-final.log` |
| 并发负载 | 100 房间、200 人、2,000 次 HTTP/Socket 操作，并行应用内构图 | 操作 P50 5.90/P95 8.78/P99 11.49 ms；仅容器内网 |
| 内存/图片 | 双 16MP 上传限流、重试、跨实例读取成功；无 OOM | 应用峰值 217,391,104 / 155,832,320 字节，oom/oom_kill 均 0 |
| 依赖安全 | pnpm 全依赖和 Python 已装业务依赖均 0 告警 | `dependency-audit-final.json`、`python-audit-final.log` |
| 真实副本复验 | 升级后 schema/所有图片解码/新旧 codec、图关系再次通过 | `domain-audit.json`、`catalog-final.json`、`careers-final.json` |
| 上游基线 | 260 相同、59 已审阅扩展、0 缺失、0 未预期差异 | `upstream-final.json`；只更新 10 个逐项审阅的哈希 |
| 数据保真 | 56 张业务表、2,484 张资源、83 个爬虫工作文件完全一致 | `preservation-final.json`，前后清单和在线备份保留 |

以上证据均在 `.local-data/verification/full-release-audit-20261104/`。曾失败的反例、OOM 和升级中间测试日志也保留；最终爬虫结果以 `scraper-final.log` 为准，不能拿中间失败的 all 日志冒充整轮无失败。

只读数据核对：669 人、668 生涯、8,748 任期；4 个持久关系图、53 对局、49 结果；图寻 1,234 条题目记录（1,233 published）、1,118 草稿、1,124 点位；七张开放图中 1,121 个可抽独立点。2,484 个资源共 30,860,452 字节；3,947 次当前/历史图片哈希引用核对无错误。16 个没有 SQL 引用的文件可能对应队列/未保存工作，未删除。数据库 integrity/FK/投影/JSON 引用检查通过。

生涯质量报告含 388 个 date_gap、306 个 empty_interval、77 个 overlapping_active_teams、44 个 unknown_role 标记，类别可能重叠，不能相加当作错误人物数。唯一 missing_career 是停用重复人物 seangres #524。未知日期采用保守关系计算，未把这些提示伪装成已经核实的事实，也未批准历史待审内容。当前 revision 862 的重建图哈希与活动版本 `bc3d12646c9883b5b051fd040cf163ab5ba9f49f364d466b8c9932564e948d9f` 一致。

### 部署约束与尚未覆盖项

- 应用容器必须使用本轮 512 MiB 预算与对应图片限制；两应用上限共 1 GiB，PostgreSQL 384 MiB、Redis 128 MiB，常驻预算约 1.5 GiB，主机另留系统、代理和维护余量。没有在目标机做容量承诺。
- 迁移为独立一次性任务，不能让两个应用同时执行 DDL；保留数据库及图片可恢复备份，正式环境恢复演练尚需核对。
- SMTP/GeeTest 使用受控模拟覆盖应用逻辑，未验证实际账号、邮件投递或公网校验；TLS/反代的真实请求路径、手机触控、目标机监控告警和备份恢复均待目标环境验收。
- 本机官方启停脚本已应用最终版本，网页 5175/API 3002/Redis 健康；没有清库、重算历史、重建每日题、发布关系图、运行真实爬虫送审、推送仓库或部署远端。

### 全部同路径修改文件索引

以下枚举本轮最终差异，完整补丁见上述 diffs。对新增目录逐模块检查的结果见功能/评估表；411 个本机独有文件的完整路径可在 comparison.json 的 local_only 查看，避免把本地日志或依赖误算作新功能。

#### csgofriberg

| 文件 | 相对远端增加行 | 删除行 |
| --- | ---: | ---: |
| `.dockerignore` | 6 | 0 |
| `.github/workflows/docker.yml` | 46 | 12 |
| `.gitignore` | 10 | 0 |
| `Dockerfile` | 9 | 3 |
| `README.md` | 22 | 0 |
| `client/package.json` | 10 | 5 |
| `client/src/components/GameRules.tsx` | 50 | 8 |
| `client/src/components/admin/AdminApiTokens.tsx` | 7 | 0 |
| `client/src/components/admin/AdminPlayerChanges.tsx` | 2 | 0 |
| `client/src/components/admin/AdminPlayers.tsx` | 2 | 0 |
| `client/src/i18n/resources.ts` | 26 | 0 |
| `client/src/pages/Admin.tsx` | 16 | 21 |
| `client/src/pages/Home.tsx` | 2 | 2 |
| `client/src/pages/Leaderboard.tsx` | 11 | 9 |
| `client/src/pages/Login.tsx` | 2 | 1 |
| `client/src/pages/Stats.tsx` | 10 | 12 |
| `client/src/router.tsx` | 28 | 9 |
| `client/src/store/auth.ts` | 1 | 1 |
| `client/src/styles/home-multiplayer.css` | 36 | 0 |
| `client/src/types.ts` | 6 | 0 |
| `client/test/components/GameRules.test.tsx` | 22 | 0 |
| `client/test/components/admin/AdminApiTokens.test.tsx` | 1 | 0 |
| `client/test/pages/Home.test.tsx` | 6 | 0 |
| `client/vite.config.ts` | 11 | 5 |
| `compose.yaml` | 38 | 3 |
| `package.json` | 4 | 0 |
| `pnpm-lock.yaml` | 1001 | 830 |
| `pnpm-workspace.yaml` | 5 | 0 |
| `scripts/local.ps1` | 34 | 136 |
| `scripts/verify-production.cjs` | 144 | 0 |
| `scripts/verify-production.sh` | 77 | 10 |
| `server/package.json` | 19 | 5 |
| `server/src/config.ts` | 2 | 2 |
| `server/src/controllers/admin/operations.ts` | 2 | 1 |
| `server/src/controllers/admin/players.ts` | 1 | 1 |
| `server/src/db/migrate.ts` | 2 | 0 |
| `server/src/db/ready.ts` | 9 | 2 |
| `server/src/db/schema.ts` | 17 | 1 |
| `server/src/index.ts` | 24 | 2 |
| `server/src/middleware/apiToken.ts` | 12 | 1 |
| `server/src/routes/adminSchemas.ts` | 2 | 0 |
| `server/src/routes/auth.ts` | 54 | 1 |
| `server/src/routes/externalPlayers.ts` | 11 | 2 |
| `server/src/services/apiTokens.ts` | 10 | 5 |
| `server/src/services/externalCheatAnalysis.ts` | 1 | 1 |
| `server/src/services/keyLock.ts` | 20 | 2 |
| `server/src/services/playerChangeSubmissions.ts` | 16 | 6 |
| `server/src/services/playerExport.ts` | 8 | 1 |
| `server/src/services/playerMutations.ts` | 79 | 11 |
| `server/src/services/presence.ts` | 96 | 4 |
| `server/src/services/queryCache.ts` | 31 | 19 |
| `server/src/services/singleGameStore.ts` | 5 | 2 |
| `server/src/socket/workers.ts` | 3 | 2 |
| `server/test/db/ready.test.ts` | 42 | 0 |
| `server/test/db/schema.test.ts` | 25 | 0 |
| `server/test/routes/admin.integration.test.ts` | 2 | 0 |
| `server/test/routes/externalPlayers.integration.test.ts` | 3 | 1 |
| `server/test/routes/playerChangeSubmissions.integration.test.ts` | 23 | 12 |
| `server/test/routes/pow.integration.test.ts` | 8 | 0 |

#### external-scraper

| 文件 | 相对远端增加行 | 删除行 |
| --- | ---: | ---: |
| `.github/workflows/docker.yml` | 1 | 1 |
| `PRODUCTION_DEPLOY.md` | 2 | 2 |
| `README.md` | 87 | 4 |
| `api_client.py` | 35 | 6 |
| `cli.py` | 187 | 17 |
| `comparator/compare.py` | 88 | 17 |
| `docs/team-identity-audit.md` | 60 | 0 |
| `pipeline.py` | 6 | 0 |
| `requirements.txt` | 3 | 1 |
| `scraper/core.py` | 53 | 13 |
| `scraper/rules.py` | 2 | 6 |
| `scraper/teams.py` | 33 | 2 |
| `tests/test_api_client.py` | 1 | 0 |
| `tests/test_cmtry_sync.py` | 4 | 3 |
| `tests/test_compare.py` | 31 | 0 |
| `tests/test_deep_team_pipeline.py` | 3 | 3 |
| `tests/test_history_identity.py` | 3 | 3 |
| `tests/test_rules.py` | 10 | 10 |
| `tests/test_team_identity.py` | 8 | 3 |
| `tests/test_team_normalization.py` | 4 | 4 |
| `tests/test_team_pipeline.py` | 8 | 8 |
| `tests/test_team_repair_cli.py` | 1 | 1 |

---

## 2026-10-23 历史比较记录

比对日期：2026-10-23（Asia/Shanghai）。远端分支快照开始于 04:31；本机对象为 `F:\friberg-ex`，不包含本报告生成后的自身文件。结论基于固定提交的文件树、文件内容及逐文件补丁，不以 README 或此前检查记录代替当前源码比较。

**当前工作区是在 `csgofriberg/main` 基础上加入完整图寻系统，整合较新的爬虫修复，并补充提交一致性、权限、缓存、开发和容器验收工具的本机版本。主游戏没有遗漏远端 main 的源码文件；爬虫包含仍未合并的 PR #3 内容，并继续增加了提交安全改动。**

## 1 比对对象和统计口径

本次通过 GitHub 连接检索了包含 fork 和归档状态的仓库清单，找到以下 3 个可访问仓库，并检查全部 8 个现存分支。三个仓库的 tags 引用集合均为空。不可访问的私有仓库不在结论范围内；网站运行数据库、服务器环境变量和实际部署镜像不能由仓库源码推断。

| 仓库 | 默认分支提交 | 提交时间（北京时间） | 与工作区的关系 |
| --- | --- | --- | --- |
| [csgofriberg](https://github.com/shnlfriberg/csgofriberg) | [99f2e471](https://github.com/shnlfriberg/csgofriberg/commit/99f2e471474cfefd38de13033608bdc816a24242) | 2026-10-18 17:12 | 当前指定的公共游戏基线，main 尚未前进 |
| [external-scraper](https://github.com/shnlfriberg/external-scraper)（私有） | [ce0c9509](https://github.com/shnlfriberg/external-scraper/commit/ce0c9509534be74609263bdd98bcd690221647c6) | 2026-10-18 17:11 | 对应本机 `external-scraper/` 子目录 |
| [csgofriberg2](https://github.com/shnlfriberg/csgofriberg2) | [d54f687f](https://github.com/shnlfriberg/csgofriberg2/commit/d54f687faabb2e4c3fca406c93a2630ae57369e4) | 2026-08-17 00:22 | 用户已废弃的较早游戏版本，仅作比较，不作为同步来源 |

GitHub 上 csgofriberg2 的 archived 标记仍为 false；这不改变用户已经废弃它的开发边界。工作区根目录没有 `.git`，所以不能给本机虚构提交号或“领先多少个 commit”。

| 默认分支比较 | 远端跟踪文件 | 内容一致 | 同路径修改 | 远端独有而本机缺失 | 本机独有 |
| --- | ---: | ---: | ---: | ---: | ---: |
| csgofriberg/main ↔ 整体工作区 | 320 | 275 | 44 | 0 | 255 |
| external-scraper/main ↔ 本机爬虫目录 | 42 | 30 | 12 | 0 | 6 |
| csgofriberg2/main ↔ 整体工作区 | 283 | 202 | 80 | 0 | 292 |

两个游戏仓库都跟踪了 `client/tsconfig.tsbuildinfo`；各有 1 个生成文件另行排除，因此第一行 275+44+1=320。文本统一 CRLF/LF 后比较，二进制按原始字节比较。爬虫表与整体工作区表有包含关系，不能相加。

本机纳入比较的 574 个文件包括源码、测试、配置示例、文档、雷达和集成资料。255 个本机独有文件不等于 255 个新功能：其中客户端 70、服务端 75、爬虫 48、共享包 8、脚本 14、文档 14、集成证据 19、根目录入口及规则 6、统一配置 1。运行数据、真实凭据、依赖、构建产物、日志缓存及历史源码归档另行说明，不混入源码增量。

## 2 主游戏中保持一致的部分

与 `csgofriberg/main` 比较，经典单人核心、经典每日、经典多人大厅/房间/接力/2v2核心、海龟汤玩法核心、公共 PoW/邮件验证/限流及多数管理、统计模块保持一致。例如 `server/src/services/gameService.ts`、`server/src/services/singleGame.ts`、`server/src/services/turtleSoup.ts`、`server/src/socket/handlers/game.ts`、`server/src/routes/stats.ts` 和 `client/src/pages/TurtleSoupGame.tsx` 均在一致清单内。

海龟汤不是本机相对主仓库新增的玩法；主仓库已经具有该功能。登录认领、Token、缓存、分布式锁和页面入口有下述扩展，因此不能将整条公共调用链笼统称为完全没变。管理员编辑选手只发送可编辑字段的修复，本机与主仓库相同。

## 3 图寻是完整新增业务域

主游戏 main 和 csgofriberg2 均没有本机这套图寻模块。本机新增内容包括：

| 分类 | 本机能力 | 主要证据 |
| --- | --- | --- |
| 游玩 | 随机五轮、每日五轮、2 至 8 人好友房、双人随机匹配、按地图/楼层/距离评分 | `server/src/location/games.ts`、`rooms.ts`、`rules.ts`；`client/src/pages/LocationGame.tsx`、`LocationMulti.tsx` |
| 排行与回放 | 图寻战绩、逐轮回放、每日榜、投稿贡献榜 | `server/src/location/statistics.ts`、`replayStorage.ts`；`client/src/location/` |
| 题目制作 | 采集草稿、连续标点、批量配图、同点多图、逐图编辑、框选筛选、审核发布 | `client/src/components/admin/LocationBatchCapture.tsx` 及 `location/QuestionManager.tsx`；`server/src/location/admin/` |
| 地图 | 10 张地图定义、13 张楼层雷达资源、边界、版本、可选世界坐标与标定 | `server/src/location/catalog.json`；`client/public/location-radars/`；`packages/location-core/src/` |
| 投稿 | 访客/用户上传、审核采纳/拒绝、贡献记录、资源清理任务 | `submissionRoutes.ts`、`submissions.ts`、`assetTasks.ts` |
| 迁移与维护 | 题库 ZIP 导入导出、题库可用性诊断、运维状态、结算重试、资源引用盘点 | `bank.ts`、`bankAvailability.ts`、`assetInventory.ts`、后台 `Operations.tsx` |

新增 `/entertainment` 入口及图寻 random/daily/multi/history/submit 路由；旧海龟汤路由保留。首页娱乐图标为单色勾线鸭子，图寻“你的落点”使用橙色。规则、统计和贡献榜接入原页面，图寻文案独立提供中英日三语。

图寻复用现有 Cookie、PoW、账号和 Socket 身份链。随机匹配要求登录并验证邮箱；普通访客游玩和好友房没有被整体改成强制登录。游客认领新增图寻战绩及投稿/贡献信息的处理，返回的 claimed 数量也包含图寻。

## 4 架构与存储变化

1. **独立图寻目录及共享包。** 新增服务端图寻目录 47 个文件，以及前端游戏/后台组件；`packages/location-core` 提供跨端类型、坐标、标定和采集点计算，前端不再通过运行时导入依赖服务端源码。
2. **新增 17 张图寻持久表。** 覆盖地图、版本、题目、采集、每日、进度、成绩、投稿、贡献、位置版本、共享回放、归档、结算任务、删图任务和修订号；清单见 `server/src/location/schema.ts`。另新增 `external_submission_requests`，以及既有表的 `api_tokens.scopes`、`player_change_items.observed_value`。
3. **查询与版本读取。** 题目/草稿有 SQL 投影和索引，题目分页/框选；采集按 revision 避免无变化重复传全量，首次及实际变更仍返回完整草稿元数据，以保留跨批次匹配。
4. **历史保留。** 新回放复用共享快照、分批读取；旧 JSON 经 codec 兼容；过期进度可归档。题目、点位、地图版本和对局版本分开处理，不靠改写旧成绩节省存储。
5. **后台任务拆分。** 结算 outbox、删图和归档从房间推进分离；结算重试以 SQL due_at 为准，有退避和并发上限。图片处理有预算约束，房间可协商增量更新；远端和旧连接仍可能使用全量视图。
6. **通用缓存与锁也有变化。** `queryCache.ts` 增加代次和 Redis Lua 条件写回，防止旧查询在失效后重新污染缓存；`keyLock.ts` 增加租约续期及丢失检测。这两处属于已有基础模块修改，会被其调用方共用，不能只算界面新增。

这些是可以从代码确认的结构和行为差异。远端没有图寻对应实现，不能据此宣称本机图寻比远端快某个百分比。

## 5 爬虫与选手审核的差异

### 5.1 远端已有且本机保留的能力

爬取、动态导出基准、比较器、分批 HTTP 提交、重试、断点状态、运行锁、原子文件写入、队名归一、历史队伍处理、cmtry 角色修复、Dockerfile 和独立部署示例并非本机从零新增。

本机与爬虫 main 一致的文件包括 `comparator/compare.py`、`runtime_utils.py`、`scraper/rules.py`、`scraper/team_repair.py`、`config.example.json`、Dockerfile、工作流等。`players.json` 也完全相同，均包含 646 条静态记录；它与实际 SQLite 的 669 人选手库是不同对象，不能用静态文件数量推断线上当前人数或丢失记录。

### 5.2 本机已包含但远端 main 尚未合并的修复

[爬虫 PR #3](https://github.com/shnlfriberg/external-scraper/pull/3) 当前仍为 open，分支 `codex/fix-history-sync-compatibility` 为 `740ec2ac`，比 main 多 2 个提交，改动/新增 12 个文件。本机包含其实现，并在部分文件上继续修改：

- 旧默认字段白名单 `team/age/role` 在运行时自动补入 `team_history`；显式自定义仍保留原意，不静默改写用户配置。
- 记录历史队伍“检测到/纳入提交/被过滤”数量，覆盖 HooXi、jabbi 等仅历史字段变化的场景。
- 避免将 `American organization` 等组织限定误当角色后缀，保留不同组织身份。
- 补充 28 个经资料核验的队名，并将 CPH Flames/CPH Wolves 从独立标准名改为指向对应 Copenhagen 队伍的明确别名。
- 增加真实页面片段夹具、历史提交和标准队名回归。

相对该 PR 分支，本机 39 个文件相同、8 个修改、1 个新增，没有缺失文件。因此“本机爬虫更接近 main 还是 PR 分支”的答案是：更接近 PR #3，而不是只在 main 上改了几个配置。

### 5.3 本机进一步增加的提交一致性

| 行为 | 远端 main | 本机 |
| --- | --- | --- |
| 基准值传递 | API payload 主要保留定位和 changes | 额外保留 expected，CLI 与客户端重复转换后仍保留 old 值 |
| 提交时冲突 | 以提交时库值建立审核基准 | 对比抓取基准与提交时库值，可立即标 conflict；保存 observed_value，审批前再检查 |
| 重试身份 | 爬虫用内容指纹形成 Idempotency-Key；主游戏入口未消费该头 | diff 保存 submission_run_id，键结合任务和批次内容；服务端以 SQL 事务保存回执并检查同键异内容 |
| 并发 submit | 缺少单个 diff 初始化身份的专属锁 | diff 专属进程锁，原子补写运行 ID |
| Token | 有效外部 Token 可访问原有外部接口 | 区分读取/送审/直接写入，新建默认读取和送审，旧 Token 保留原权限 |
| 审核界面 | 旧值、新值等已有字段 | 增加提交时实际值；Token 页面增加权限选择 |

关键配对文件为 `external-scraper/api_client.py`、`cli.py` 与服务端 `submissionIdempotency.ts`、`externalSubmissionSchema.ts`、`apiTokenScopes.ts`、`playerChangeSubmissions.ts`。因此不能仅把当前爬虫替换到未经适配的远端游戏 main 就视为完成升级：本机发送的 expected 会遇到远端旧版严格请求 schema，持久回执和 scopes 也需要后端配套。

## 6 前端、开发与依赖

- 路由从大量静态导入改为 React.lazy/Suspense 按需加载，保留共享 vendor 分组。
- 图寻后台首次访问后保持挂载；隐藏时暂停加载，保留未保存点位和 File 图片队列。
- 增加图寻规则、统计模式标签、贡献榜及三语文案；经典页面本身多数未改变。
- 前后端增加 `@friberg/location-core` workspace 依赖和 prebuild/pretest/predev；服务端新增 sharp、yauzl、yazl 及类型依赖。锁文件增加对应条目，Node 26/pnpm 11.13.1 等公共基础没有因为整合而整体换技术栈。
- 本机 `config/local-profile.json` 统一为网页 5175、API 3002、Redis 16380 和独立前缀。远端 Vite 默认 5173/代理 3000；本机 Vite 可从配置读取覆盖，并新增图片代理。
- 本机提供双击启动/停止/爬虫预览、进程归属校验、Redis PING 就绪等待、SQLite shim、隔离测试与数据保真工具。旧 local.ps1 改为调用统一入口，避免连到不同数据库。

## 7 Docker、Compose 与 CI

| 项目 | 远端主游戏 | 本机 |
| --- | --- | --- |
| 生产基础 | 已有 distroless Node 26、PostgreSQL、Redis、双应用和独立 migrate | 保留该布局，并增加图寻共享资源和共享包 |
| 镜像依赖 | deploy 使用 `--no-optional` | 保留 sharp 所需平台可选包，新增非 root 拥有的图片目录 |
| 默认镜像名 | compose 指向 `ghcr.io/xinhai-ai/csgofriberg:latest` | 改为 `ghcr.io/shnlfriberg/csgofriberg:latest` |
| 持久资源 | 无图寻图片卷 | 两实例共享 location-assets；新增可选题库导入服务 |
| 日志 | 应用无这项轮转配置 | 应用 json-file 10 MB × 5 |
| PR CI | 工作流写有 PR 条件，但没有 pull_request 触发器 | 增加 main PR 触发，爬虫测试及隔离数据库/图片/Redis 配置 |
| 发布验收 | 容器验收仅在 PR 条件分支 | 先构建并验收候选镜像，再对非 PR 发布相同构建输入，保留 provenance/SBOM |
| 本机实测 | 不能从远端配置推断执行结果 | 2026-10-23 已实际通过 Linux/PostgreSQL/双实例及 Compose 重启持久化验收 |

新增 `compose.scraper.yaml` 为可选爬虫 profile。其默认配置路径 `external-scraper/config.docker.json` 当前未创建，不能表述为爬虫常驻容器已配置上线。已有本机配置不在此报告中展示。

一个容易遗漏的结构差异：远端爬虫仓库根 `.github/workflows/docker.yml` 会测试 Python 3.9/3.12，并发布独立爬虫镜像；本机该文件放在 `external-scraper/.github/workflows/`，GitHub 不会把子目录中的工作流当成整合仓库工作流自动运行。本机根 CI 目前测试爬虫 Python 3.12，发布的是游戏镜像，尚无根级独立爬虫镜像发布任务。文件字节相同不代表整合后的自动化入口相同。

本机 Docker 程序位于 `F:\Docker\Desktop`，数据盘位于 `F:\Docker\wsl`；这是本机环境配置，不是 GitHub 源码功能。完整已执行结果见 [Docker 配置与验收](docker-local-acceptance.md)。远端是否已经部署同款镜像、网站是否使用这些变更，本次没有服务器证据。

## 8 测试和文档

本机新增客户端图寻测试文件 15 个、服务端测试文件 23 个（其中包含图寻测试/夹具辅助及缓存、锁、提交安全测试），并修改原有相关回归。爬虫相对 main 新增 3 个测试文件、3 个页面夹具，修改 5 个既有测试文件。

最近已记录的本机隔离验收是服务端 312 项、前端 242 项；Docker 内爬虫 127 项通过、1 项联网跳过；生产脚本和实际 Compose 重启验收通过。这些是前序实际记录，本次源码比对没有重新运行全部测试，也不能用这些数字推断 GitHub 当前工作流状态。

新增主交接手册、图寻设计/接口/采集/迁移/部署说明、统一工作区与上游核对记录、Docker 验收记录、哈希清单及截图。旧文档的一些历史数量、分支名称仍被保留并由主手册解释；不能把旧资料中的空题库、旧端口或归档 Git 分支当成当前事实。

## 9 运行数据与仓库之外的内容

本次只读采样确认：选手 669、地图 10、图寻题目 408、草稿 379、独立位置 381、图片资源 822。这些内容在本机 SQLite 和图片目录中；两个远端游戏仓库没有相应的实际运行数据库与本机图片文件。远端主游戏内置 5 人种子不是 669 人运行库的备份。

真实 `.env`、管理员凭据、爬虫 Token 配置、Redis 活跃状态、采集输出、历史备份、`.tools` 与 `node_modules` 未作为源码读取或上传。`integration/source-archives` 是历史来源材料，不将其重复代码计为新增功能。不能用拉取 GitHub 或重建镜像替代这些本机数据的备份。

## 10 其余分支与废弃仓库

- `csgofriberg2/main` 比本机早：没有海龟汤、图寻和后来拆分的后台/单人玩法模块，管理员编辑字段修复等也尚未包含。本机相对它修改 80 个文件、增加 292 个文件；它没有本机完全缺失的非生成文件。仍按用户要求仅作历史参考。
- `csgofriberg/dev` 停在 2026-07-19 的 pnpm 锁文件提交，110 个跟踪文件；与 main 分叉后 main 有 225 个独有提交，该分支有 1 个独有提交。不是比 main 更新的完整游戏版本。
- `copilot/fix-failing-github-actions-test` 也是早期 110 文件树，独有提交为无文件修改的 Initial plan。不能按分支名猜测它包含当前还需要合入的 CI 修复。
- 爬虫 `codex/fix-cmtry-role-history` 与 main 文件树完全相同，其 PR #2 已合并。`release/v1.0.0-team-history` 的 PR #1 已合并，较当前 main 少 cmtry 测试且 rules 有差异。
- 唯一仍打开且直接关联本机改动的是爬虫 PR #3；本机已包含其修复并继续扩展，但本次没有合并、关闭或评论该 PR。

对于两个早期游戏分支，16 个仅远端路径包括旧样式、旧导入资源和旧位置的测试文件；这与当前 main 的零缺失结论不矛盾，不应直接恢复这些旧文件。全部分支逐文件状态在附件 JSON 中。

## 11 同步时需要区分的内容

适合保持为本机扩展的主要内容是图寻、采集和真实素材。通用缓存/锁、Token scopes、提交一致性及 CI 改动也修改了公共模块，未来同步应逐项审阅，不能当成纯外挂目录覆盖。

爬虫与游戏后端的提交协议需要配套升级；`expected`、持久幂等回执和 scopes 不是只改一侧就完整成立。独立爬虫仓库发布和整合仓库发布的工作目录也不同。本机当前功能、已提交到 GitHub 的功能、GitHub main 已合并的功能和线上实际已部署的功能，是四种不同状态。

本次只读取和比较源码、查询运行数据计数、保存报告与证据，没有同步代码、修改数据库、更新固定基线哈希、初始化 Git 或推送 GitHub。

## 附录 A 全部分支数量

| 仓库与分支 | 提交 | 一致 | 修改 | 远端独有 | 本机独有 | 排除生成文件 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| csgofriberg / copilot/fix-failing-github-actions-test | `b07fb4be` | 10 | 83 | 16 | 481 | 1 |
| csgofriberg / dev | `c05804b5` | 10 | 83 | 16 | 481 | 1 |
| csgofriberg / main | `99f2e471` | 275 | 44 | 0 | 255 | 1 |
| csgofriberg2 / main | `d54f687f` | 202 | 80 | 0 | 292 | 1 |
| external-scraper / codex/fix-cmtry-role-history | `f37d5068` | 30 | 12 | 0 | 6 | 0 |
| external-scraper / codex/fix-history-sync-compatibility | `740ec2ac` | 39 | 8 | 0 | 1 | 0 |
| external-scraper / main | `ce0c9509` | 30 | 12 | 0 | 6 | 0 |
| external-scraper / release/v1.0.0-team-history | `51b241f8` | 29 | 12 | 0 | 7 | 0 |

## 附录 B 主游戏 44 个同路径修改文件

每项的逐行补丁已保存在本机证据目录；“+/-”是文本增删行数，不是性能或功能评分。

| 文件 | 差异 | + / - |
| --- | --- | --- |
| [.dockerignore](../.dockerignore) | 排除本机工具、资料、数据及共享包构建产物 | 6 / 0 |
| [.github/workflows/docker.yml](../.github/workflows/docker.yml) | PR 触发、爬虫测试、隔离测试及发布前候选镜像验收 | 45 / 12 |
| [.gitignore](../.gitignore) | 忽略本机凭据、运行产物及共享包构建输出 | 10 / 0 |
| [Dockerfile](../Dockerfile) | 共享包、sharp 平台依赖、图片目录权限 | 8 / 3 |
| [README.md](../README.md) | 整合工作区及固定上游核对说明 | 22 / 0 |
| [client/package.json](../client/package.json) | 共享包依赖和构建/测试/开发前置步骤 | 6 / 2 |
| [client/src/components/GameRules.tsx](../client/src/components/GameRules.tsx) | 图寻规则分支 | 27 / 8 |
| [client/src/components/admin/AdminApiTokens.tsx](../client/src/components/admin/AdminApiTokens.tsx) | Token scopes 选择 | 7 / 0 |
| [client/src/components/admin/AdminPlayerChanges.tsx](../client/src/components/admin/AdminPlayerChanges.tsx) | 展示提交时库内值 observedValue | 2 / 0 |
| [client/src/i18n/resources.ts](../client/src/i18n/resources.ts) | 加载图寻中英日文案 | 7 / 0 |
| [client/src/pages/Admin.tsx](../client/src/pages/Admin.tsx) | 图寻管理入口及隐藏时保留挂载 | 5 / 1 |
| [client/src/pages/Home.tsx](../client/src/pages/Home.tsx) | 娱乐入口及统一鸭子图标 | 2 / 2 |
| [client/src/pages/Leaderboard.tsx](../client/src/pages/Leaderboard.tsx) | 图寻贡献榜分支 | 11 / 9 |
| [client/src/pages/Stats.tsx](../client/src/pages/Stats.tsx) | 图寻统计与共用模式标签 | 7 / 12 |
| [client/src/router.tsx](../client/src/router.tsx) | 娱乐/图寻路由和页面按需加载 | 22 / 9 |
| [client/test/components/GameRules.test.tsx](../client/test/components/GameRules.test.tsx) | 更新相关回归：图寻入口/迁移、权限或提交行为 | 13 / 0 |
| [client/test/components/admin/AdminApiTokens.test.tsx](../client/test/components/admin/AdminApiTokens.test.tsx) | 更新相关回归：图寻入口/迁移、权限或提交行为 | 1 / 0 |
| [client/test/pages/Home.test.tsx](../client/test/pages/Home.test.tsx) | 更新相关回归：图寻入口/迁移、权限或提交行为 | 6 / 0 |
| [client/vite.config.ts](../client/vite.config.ts) | 配置化端口/API 代理、图片代理及懒加载说明 | 11 / 5 |
| [compose.yaml](../compose.yaml) | 镜像来源、共享图片卷、导入服务、日志轮转 | 37 / 2 |
| [package.json](../package.json) | 本机入口与 upstream:check 命令 | 4 / 0 |
| [pnpm-lock.yaml](../pnpm-lock.yaml) | 图像、ZIP 和共享包依赖锁定 | 365 / 0 |
| [pnpm-workspace.yaml](../pnpm-workspace.yaml) | packages/* 及 sharp 构建许可 | 2 / 0 |
| [scripts/local.ps1](../scripts/local.ps1) | 统一到当前启动/停止/测试/导入入口 | 34 / 136 |
| [scripts/verify-production.cjs](../scripts/verify-production.cjs) | 图寻/双实例/图片/提交幂等验收 | 56 / 0 |
| [scripts/verify-production.sh](../scripts/verify-production.sh) | 共享测试卷、双实例、额外验收阶段和匿名卷清理 | 16 / 7 |
| [server/package.json](../server/package.json) | 图寻命令、共享包及图像/ZIP 依赖 | 14 / 2 |
| [server/src/controllers/admin/operations.ts](../server/src/controllers/admin/operations.ts) | 创建 Token 时传递 scopes | 2 / 1 |
| [server/src/db/migrate.ts](../server/src/db/migrate.ts) | 迁移后 readiness 核验 | 2 / 0 |
| [server/src/db/ready.ts](../server/src/db/ready.ts) | 新表/新列就绪检查 | 6 / 2 |
| [server/src/db/schema.ts](../server/src/db/schema.ts) | 接入图寻和外部提交迁移 | 4 / 1 |
| [server/src/index.ts](../server/src/index.ts) | 图寻 HTTP/图片/Socket/每日任务生命周期接入 | 15 / 0 |
| [server/src/middleware/apiToken.ts](../server/src/middleware/apiToken.ts) | 读取 scopes 及接口权限中间件 | 12 / 1 |
| [server/src/routes/adminSchemas.ts](../server/src/routes/adminSchemas.ts) | Token scopes 输入校验 | 2 / 0 |
| [server/src/routes/auth.ts](../server/src/routes/auth.ts) | 游客认领图寻战绩与投稿 | 5 / 1 |
| [server/src/routes/externalPlayers.ts](../server/src/routes/externalPlayers.ts) | 按 scope 授权并向提交服务传递 Idempotency-Key | 7 / 2 |
| [server/src/services/apiTokens.ts](../server/src/services/apiTokens.ts) | Token scopes 持久化及默认权限 | 10 / 5 |
| [server/src/services/keyLock.ts](../server/src/services/keyLock.ts) | 租约续期与丢失检测 | 18 / 2 |
| [server/src/services/playerChangeSubmissions.ts](../server/src/services/playerChangeSubmissions.ts) | expected/observed、提交时冲突及持久幂等 | 13 / 6 |
| [server/src/services/queryCache.ts](../server/src/services/queryCache.ts) | 代次及原子条件写回防止过期查询污染 | 31 / 19 |
| [server/test/db/ready.test.ts](../server/test/db/ready.test.ts) | 更新相关回归：图寻入口/迁移、权限或提交行为 | 42 / 0 |
| [server/test/db/schema.test.ts](../server/test/db/schema.test.ts) | 更新相关回归：图寻入口/迁移、权限或提交行为 | 15 / 0 |
| [server/test/routes/externalPlayers.integration.test.ts](../server/test/routes/externalPlayers.integration.test.ts) | 更新相关回归：图寻入口/迁移、权限或提交行为 | 1 / 1 |
| [server/test/routes/playerChangeSubmissions.integration.test.ts](../server/test/routes/playerChangeSubmissions.integration.test.ts) | 更新相关回归：图寻入口/迁移、权限或提交行为 | 9 / 6 |

## 附录 C 爬虫 main 的全部差异文件

| 文件 | 状态 | + / - |
| --- | --- | --- |
| [PRODUCTION_DEPLOY.md](../external-scraper/PRODUCTION_DEPLOY.md) | 修改 | 1 / 1 |
| [README.md](../external-scraper/README.md) | 修改 | 17 / 2 |
| [api_client.py](../external-scraper/api_client.py) | 修改 | 14 / 4 |
| [cli.py](../external-scraper/cli.py) | 修改 | 70 / 11 |
| [docs/team-identity-audit.md](../external-scraper/docs/team-identity-audit.md) | 修改 | 60 / 0 |
| [scraper/core.py](../external-scraper/scraper/core.py) | 修改 | 4 / 0 |
| [scraper/teams.py](../external-scraper/scraper/teams.py) | 修改 | 33 / 2 |
| [tests/test_api_client.py](../external-scraper/tests/test_api_client.py) | 修改 | 1 / 0 |
| [tests/test_cmtry_sync.py](../external-scraper/tests/test_cmtry_sync.py) | 修改 | 2 / 1 |
| [tests/test_deep_team_pipeline.py](../external-scraper/tests/test_deep_team_pipeline.py) | 修改 | 1 / 1 |
| [tests/test_team_identity.py](../external-scraper/tests/test_team_identity.py) | 修改 | 6 / 1 |
| [tests/test_team_pipeline.py](../external-scraper/tests/test_team_pipeline.py) | 修改 | 2 / 2 |
| [tests/fixtures/hooxi_history.wiki](../external-scraper/tests/fixtures/hooxi_history.wiki) | 本机新增 | — |
| [tests/fixtures/jabbi_history.wiki](../external-scraper/tests/fixtures/jabbi_history.wiki) | 本机新增 | — |
| [tests/fixtures/sense-history-20261019.wiki](../external-scraper/tests/fixtures/sense-history-20261019.wiki) | 本机新增 | — |
| [tests/test_history_sync.py](../external-scraper/tests/test_history_sync.py) | 本机新增 | — |
| [tests/test_submission_safety.py](../external-scraper/tests/test_submission_safety.py) | 本机新增 | — |
| [tests/test_team_catalogue_refresh.py](../external-scraper/tests/test_team_catalogue_refresh.py) | 本机新增 | — |

## 附录 D 相对主游戏 main 的 255 个本机独有文件

此表包含已经单独比较的爬虫目录；不包含真实数据、凭据、依赖和生成文件。

### client（70 个）

- [client/public/location-radars/de_ancient_main.webp](../client/public/location-radars/de_ancient_main.webp)
- [client/public/location-radars/de_anubis_main.webp](../client/public/location-radars/de_anubis_main.webp)
- [client/public/location-radars/de_cache_main.webp](../client/public/location-radars/de_cache_main.webp)
- [client/public/location-radars/de_dust2_main.webp](../client/public/location-radars/de_dust2_main.webp)
- [client/public/location-radars/de_inferno_main.webp](../client/public/location-radars/de_inferno_main.webp)
- [client/public/location-radars/de_mirage_main.webp](../client/public/location-radars/de_mirage_main.webp)
- [client/public/location-radars/de_nuke_lower.webp](../client/public/location-radars/de_nuke_lower.webp)
- [client/public/location-radars/de_nuke_upper.webp](../client/public/location-radars/de_nuke_upper.webp)
- [client/public/location-radars/de_overpass_main.webp](../client/public/location-radars/de_overpass_main.webp)
- [client/public/location-radars/de_train_lower.webp](../client/public/location-radars/de_train_lower.webp)
- [client/public/location-radars/de_train_upper.webp](../client/public/location-radars/de_train_upper.webp)
- [client/public/location-radars/de_vertigo_lower.webp](../client/public/location-radars/de_vertigo_lower.webp)
- [client/public/location-radars/de_vertigo_upper.webp](../client/public/location-radars/de_vertigo_upper.webp)
- [client/src/components/DuckIcon.tsx](../client/src/components/DuckIcon.tsx)
- [client/src/components/StatsModeTabs.tsx](../client/src/components/StatsModeTabs.tsx)
- [client/src/components/admin/AdminLocation.tsx](../client/src/components/admin/AdminLocation.tsx)
- [client/src/components/admin/LocationBankTransfer.tsx](../client/src/components/admin/LocationBankTransfer.tsx)
- [client/src/components/admin/LocationBatchCapture.tsx](../client/src/components/admin/LocationBatchCapture.tsx)
- [client/src/components/admin/LocationQuestionDialog.tsx](../client/src/components/admin/LocationQuestionDialog.tsx)
- [client/src/components/admin/location/BankChecks.tsx](../client/src/components/admin/location/BankChecks.tsx)
- [client/src/components/admin/location/CaptureImagePreview.tsx](../client/src/components/admin/location/CaptureImagePreview.tsx)
- [client/src/components/admin/location/DailyManager.tsx](../client/src/components/admin/location/DailyManager.tsx)
- [client/src/components/admin/location/ManifestImport.tsx](../client/src/components/admin/location/ManifestImport.tsx)
- [client/src/components/admin/location/MapManager.tsx](../client/src/components/admin/location/MapManager.tsx)
- [client/src/components/admin/location/Operations.tsx](../client/src/components/admin/location/Operations.tsx)
- [client/src/components/admin/location/PositionCodeInput.tsx](../client/src/components/admin/location/PositionCodeInput.tsx)
- [client/src/components/admin/location/QuestionAreaFilter.tsx](../client/src/components/admin/location/QuestionAreaFilter.tsx)
- [client/src/components/admin/location/QuestionManager.tsx](../client/src/components/admin/location/QuestionManager.tsx)
- [client/src/components/admin/location/SubmissionManager.tsx](../client/src/components/admin/location/SubmissionManager.tsx)
- [client/src/components/admin/location/admin.css](../client/src/components/admin/location/admin.css)
- [client/src/components/admin/location/api.ts](../client/src/components/admin/location/api.ts)
- [client/src/components/admin/location/batchColors.ts](../client/src/components/admin/location/batchColors.ts)
- [client/src/components/admin/location/capturePlan.ts](../client/src/components/admin/location/capturePlan.ts)
- [client/src/components/admin/location/useAdminTask.ts](../client/src/components/admin/location/useAdminTask.ts)
- [client/src/components/admin/location/useBatchCapture.ts](../client/src/components/admin/location/useBatchCapture.ts)
- [client/src/components/admin/location/useQuestionEditor.ts](../client/src/components/admin/location/useQuestionEditor.ts)
- [client/src/i18n/location.ts](../client/src/i18n/location.ts)
- [client/src/location/Components.tsx](../client/src/location/Components.tsx)
- [client/src/location/ContributorLeaderboard.tsx](../client/src/location/ContributorLeaderboard.tsx)
- [client/src/location/DailyLeaderboard.tsx](../client/src/location/DailyLeaderboard.tsx)
- [client/src/location/LocationReplayDialog.tsx](../client/src/location/LocationReplayDialog.tsx)
- [client/src/location/LocationStats.tsx](../client/src/location/LocationStats.tsx)
- [client/src/location/Radar.tsx](../client/src/location/Radar.tsx)
- [client/src/location/RoomCountdown.tsx](../client/src/location/RoomCountdown.tsx)
- [client/src/location/api.ts](../client/src/location/api.ts)
- [client/src/location/positionCode.ts](../client/src/location/positionCode.ts)
- [client/src/location/types.ts](../client/src/location/types.ts)
- [client/src/location/useLocationGame.ts](../client/src/location/useLocationGame.ts)
- [client/src/location/useRadarGestures.ts](../client/src/location/useRadarGestures.ts)
- [client/src/pages/Entertainment.tsx](../client/src/pages/Entertainment.tsx)
- [client/src/pages/LocationGame.tsx](../client/src/pages/LocationGame.tsx)
- [client/src/pages/LocationHistory.tsx](../client/src/pages/LocationHistory.tsx)
- [client/src/pages/LocationMulti.tsx](../client/src/pages/LocationMulti.tsx)
- [client/src/pages/LocationSubmission.tsx](../client/src/pages/LocationSubmission.tsx)
- [client/src/styles/location.css](../client/src/styles/location.css)
- [client/test/location/Admin.test.tsx](../client/test/location/Admin.test.tsx)
- [client/test/location/BankTransfer.test.tsx](../client/test/location/BankTransfer.test.tsx)
- [client/test/location/BatchCapture.test.tsx](../client/test/location/BatchCapture.test.tsx)
- [client/test/location/CaptureImagePreview.test.tsx](../client/test/location/CaptureImagePreview.test.tsx)
- [client/test/location/CapturePlan.test.ts](../client/test/location/CapturePlan.test.ts)
- [client/test/location/Game.test.tsx](../client/test/location/Game.test.tsx)
- [client/test/location/LocationMulti.test.tsx](../client/test/location/LocationMulti.test.tsx)
- [client/test/location/MapCalibration.test.tsx](../client/test/location/MapCalibration.test.tsx)
- [client/test/location/PositionCode.test.ts](../client/test/location/PositionCode.test.ts)
- [client/test/location/QuestionManager.test.tsx](../client/test/location/QuestionManager.test.tsx)
- [client/test/location/QuestionPagination.test.tsx](../client/test/location/QuestionPagination.test.tsx)
- [client/test/location/Radar.test.tsx](../client/test/location/Radar.test.tsx)
- [client/test/location/Statistics.test.tsx](../client/test/location/Statistics.test.tsx)
- [client/test/location/Submissions.test.tsx](../client/test/location/Submissions.test.tsx)
- [client/test/location/UploadDialog.test.tsx](../client/test/location/UploadDialog.test.tsx)

### config（1 个）

- [config/local-profile.json](../config/local-profile.json)

### docs（14 个）

- [docs/PROJECT_HANDOFF.md](../docs/PROJECT_HANDOFF.md)
- [docs/community-submissions.md](../docs/community-submissions.md)
- [docs/docker-local-acceptance.md](../docs/docker-local-acceptance.md)
- [docs/integration.md](../docs/integration.md)
- [docs/location-api.md](../docs/location-api.md)
- [docs/location-bank-transfer.md](../docs/location-bank-transfer.md)
- [docs/location-capture.cfg](../docs/location-capture.cfg)
- [docs/location-capture.md](../docs/location-capture.md)
- [docs/location-deployment.md](../docs/location-deployment.md)
- [docs/location-local-testing.md](../docs/location-local-testing.md)
- [docs/location-optimization.md](../docs/location-optimization.md)
- [docs/location-radar-resources.json](../docs/location-radar-resources.json)
- [docs/location-verification.md](../docs/location-verification.md)
- [docs/upstream-unification.md](../docs/upstream-unification.md)

### external-scraper（48 个）

- [external-scraper/.dockerignore](../external-scraper/.dockerignore)
- [external-scraper/.github/workflows/docker.yml](../external-scraper/.github/workflows/docker.yml)
- [external-scraper/.gitignore](../external-scraper/.gitignore)
- [external-scraper/CHANGELOG.md](../external-scraper/CHANGELOG.md)
- [external-scraper/Dockerfile](../external-scraper/Dockerfile)
- [external-scraper/PRODUCTION_DEPLOY.md](../external-scraper/PRODUCTION_DEPLOY.md)
- [external-scraper/README.md](../external-scraper/README.md)
- [external-scraper/api_client.py](../external-scraper/api_client.py)
- [external-scraper/cli.py](../external-scraper/cli.py)
- [external-scraper/comparator/__init__.py](../external-scraper/comparator/__init__.py)
- [external-scraper/comparator/compare.py](../external-scraper/comparator/compare.py)
- [external-scraper/config.example.json](../external-scraper/config.example.json)
- [external-scraper/deploy/cron.example](../external-scraper/deploy/cron.example)
- [external-scraper/deploy/systemd/external-scraper.service](../external-scraper/deploy/systemd/external-scraper.service)
- [external-scraper/deploy/systemd/external-scraper.timer](../external-scraper/deploy/systemd/external-scraper.timer)
- [external-scraper/docs/team-identity-audit.md](../external-scraper/docs/team-identity-audit.md)
- [external-scraper/logs/.gitkeep](../external-scraper/logs/.gitkeep)
- [external-scraper/output/.gitkeep](../external-scraper/output/.gitkeep)
- [external-scraper/pipeline.py](../external-scraper/pipeline.py)
- [external-scraper/players.json](../external-scraper/players.json)
- [external-scraper/requirements.txt](../external-scraper/requirements.txt)
- [external-scraper/runtime_utils.py](../external-scraper/runtime_utils.py)
- [external-scraper/scheduled-sync.cmd](../external-scraper/scheduled-sync.cmd)
- [external-scraper/scraper/__init__.py](../external-scraper/scraper/__init__.py)
- [external-scraper/scraper/core.py](../external-scraper/scraper/core.py)
- [external-scraper/scraper/rules.py](../external-scraper/scraper/rules.py)
- [external-scraper/scraper/team_repair.py](../external-scraper/scraper/team_repair.py)
- [external-scraper/scraper/teams.py](../external-scraper/scraper/teams.py)
- [external-scraper/state/.gitkeep](../external-scraper/state/.gitkeep)
- [external-scraper/tests/fixtures/hooxi_history.wiki](../external-scraper/tests/fixtures/hooxi_history.wiki)
- [external-scraper/tests/fixtures/jabbi_history.wiki](../external-scraper/tests/fixtures/jabbi_history.wiki)
- [external-scraper/tests/fixtures/sense-history-20261019.wiki](../external-scraper/tests/fixtures/sense-history-20261019.wiki)
- [external-scraper/tests/test_api_client.py](../external-scraper/tests/test_api_client.py)
- [external-scraper/tests/test_cli_smoke.py](../external-scraper/tests/test_cli_smoke.py)
- [external-scraper/tests/test_cmtry_sync.py](../external-scraper/tests/test_cmtry_sync.py)
- [external-scraper/tests/test_compare.py](../external-scraper/tests/test_compare.py)
- [external-scraper/tests/test_deep_team_pipeline.py](../external-scraper/tests/test_deep_team_pipeline.py)
- [external-scraper/tests/test_dynamic_baseline.py](../external-scraper/tests/test_dynamic_baseline.py)
- [external-scraper/tests/test_history_identity.py](../external-scraper/tests/test_history_identity.py)
- [external-scraper/tests/test_history_sync.py](../external-scraper/tests/test_history_sync.py)
- [external-scraper/tests/test_rules.py](../external-scraper/tests/test_rules.py)
- [external-scraper/tests/test_stability.py](../external-scraper/tests/test_stability.py)
- [external-scraper/tests/test_submission_safety.py](../external-scraper/tests/test_submission_safety.py)
- [external-scraper/tests/test_team_catalogue_refresh.py](../external-scraper/tests/test_team_catalogue_refresh.py)
- [external-scraper/tests/test_team_identity.py](../external-scraper/tests/test_team_identity.py)
- [external-scraper/tests/test_team_normalization.py](../external-scraper/tests/test_team_normalization.py)
- [external-scraper/tests/test_team_pipeline.py](../external-scraper/tests/test_team_pipeline.py)
- [external-scraper/tests/test_team_repair_cli.py](../external-scraper/tests/test_team_repair_cli.py)

### integration（19 个）

- [integration/admin-location.png](../integration/admin-location.png)
- [integration/community-submission-review.png](../integration/community-submission-review.png)
- [integration/community-submission.png](../integration/community-submission.png)
- [integration/community-submissions-http.json](../integration/community-submissions-http.json)
- [integration/community-submissions-verification.json](../integration/community-submissions-verification.json)
- [integration/database-merge.json](../integration/database-merge.json)
- [integration/http-smoke.json](../integration/http-smoke.json)
- [integration/location-game.png](../integration/location-game.png)
- [integration/map-buttons.png](../integration/map-buttons.png)
- [integration/project-handoff-snapshot.json](../integration/project-handoff-snapshot.json)
- [integration/question-area-filter.png](../integration/question-area-filter.png)
- [integration/question-area-verification.json](../integration/question-area-verification.json)
- [integration/source-manifest.json](../integration/source-manifest.json)
- [integration/upstream-baseline.json](../integration/upstream-baseline.json)
- [integration/upstream-checker-verification.json](../integration/upstream-checker-verification.json)
- [integration/upstream-comparison-20261020.json](../integration/upstream-comparison-20261020.json)
- [integration/upstream-differences.patch](../integration/upstream-differences.patch)
- [integration/upstream-verification.json](../integration/upstream-verification.json)
- [integration/verification.json](../integration/verification.json)

### packages（8 个）

- [packages/location-core/build.cjs](../packages/location-core/build.cjs)
- [packages/location-core/package.json](../packages/location-core/package.json)
- [packages/location-core/src/calibration.ts](../packages/location-core/src/calibration.ts)
- [packages/location-core/src/capturePoints.ts](../packages/location-core/src/capturePoints.ts)
- [packages/location-core/src/coordinates.ts](../packages/location-core/src/coordinates.ts)
- [packages/location-core/src/index.ts](../packages/location-core/src/index.ts)
- [packages/location-core/src/types.ts](../packages/location-core/src/types.ts)
- [packages/location-core/tsconfig.json](../packages/location-core/tsconfig.json)

### scripts（14 个）

- [scripts/check-upstream.mjs](../scripts/check-upstream.mjs)
- [scripts/create-test-admin.ps1](../scripts/create-test-admin.ps1)
- [scripts/extract-location-radars.mjs](../scripts/extract-location-radars.mjs)
- [scripts/location-capture-template.mjs](../scripts/location-capture-template.mjs)
- [scripts/location-local-common.ps1](../scripts/location-local-common.ps1)
- [scripts/merge-local-databases.py](../scripts/merge-local-databases.py)
- [scripts/prepare-location-import.mjs](../scripts/prepare-location-import.mjs)
- [scripts/run-local-scraper.ps1](../scripts/run-local-scraper.ps1)
- [scripts/smoke-integrated.py](../scripts/smoke-integrated.py)
- [scripts/smoke-location-optimization.py](../scripts/smoke-location-optimization.py)
- [scripts/start-location-local.ps1](../scripts/start-location-local.ps1)
- [scripts/stop-location-local.ps1](../scripts/stop-location-local.ps1)
- [scripts/test-integrated.ps1](../scripts/test-integrated.ps1)
- [scripts/verify-location-preservation.py](../scripts/verify-location-preservation.py)

### server（75 个）

- [server/scripts/benchmark-location.ts](../server/scripts/benchmark-location.ts)
- [server/scripts/connect-local-scraper.ts](../server/scripts/connect-local-scraper.ts)
- [server/src/db/externalSubmissionSchema.ts](../server/src/db/externalSubmissionSchema.ts)
- [server/src/location/admin/captureQueries.ts](../server/src/location/admin/captureQueries.ts)
- [server/src/location/admin/captureRoutes.ts](../server/src/location/admin/captureRoutes.ts)
- [server/src/location/admin/captures.ts](../server/src/location/admin/captures.ts)
- [server/src/location/admin/maps.ts](../server/src/location/admin/maps.ts)
- [server/src/location/admin/overview.ts](../server/src/location/admin/overview.ts)
- [server/src/location/admin/questionQuery.ts](../server/src/location/admin/questionQuery.ts)
- [server/src/location/admin/questions.ts](../server/src/location/admin/questions.ts)
- [server/src/location/admin/routes.ts](../server/src/location/admin/routes.ts)
- [server/src/location/assetInventory.ts](../server/src/location/assetInventory.ts)
- [server/src/location/assetTasks.ts](../server/src/location/assetTasks.ts)
- [server/src/location/assets.ts](../server/src/location/assets.ts)
- [server/src/location/bank.ts](../server/src/location/bank.ts)
- [server/src/location/bankAvailability.ts](../server/src/location/bankAvailability.ts)
- [server/src/location/calibration.ts](../server/src/location/calibration.ts)
- [server/src/location/capturePoints.ts](../server/src/location/capturePoints.ts)
- [server/src/location/catalog.json](../server/src/location/catalog.json)
- [server/src/location/coordinates.ts](../server/src/location/coordinates.ts)
- [server/src/location/dailyScheduler.ts](../server/src/location/dailyScheduler.ts)
- [server/src/location/exportBank.ts](../server/src/location/exportBank.ts)
- [server/src/location/games.ts](../server/src/location/games.ts)
- [server/src/location/identity.ts](../server/src/location/identity.ts)
- [server/src/location/imageProcessing.ts](../server/src/location/imageProcessing.ts)
- [server/src/location/immutable.ts](../server/src/location/immutable.ts)
- [server/src/location/importBank.ts](../server/src/location/importBank.ts)
- [server/src/location/lock.ts](../server/src/location/lock.ts)
- [server/src/location/maintenance/reset.ts](../server/src/location/maintenance/reset.ts)
- [server/src/location/maintenance/resetLocal.ts](../server/src/location/maintenance/resetLocal.ts)
- [server/src/location/maintenanceWorkers.ts](../server/src/location/maintenanceWorkers.ts)
- [server/src/location/metrics.ts](../server/src/location/metrics.ts)
- [server/src/location/pointStore.ts](../server/src/location/pointStore.ts)
- [server/src/location/progressArchive.ts](../server/src/location/progressArchive.ts)
- [server/src/location/projections.ts](../server/src/location/projections.ts)
- [server/src/location/replayStorage.ts](../server/src/location/replayStorage.ts)
- [server/src/location/resultOutbox.ts](../server/src/location/resultOutbox.ts)
- [server/src/location/roomBroadcast.ts](../server/src/location/roomBroadcast.ts)
- [server/src/location/roomView.ts](../server/src/location/roomView.ts)
- [server/src/location/rooms.ts](../server/src/location/rooms.ts)
- [server/src/location/routes.ts](../server/src/location/routes.ts)
- [server/src/location/rules.ts](../server/src/location/rules.ts)
- [server/src/location/schema.ts](../server/src/location/schema.ts)
- [server/src/location/statistics.ts](../server/src/location/statistics.ts)
- [server/src/location/store.ts](../server/src/location/store.ts)
- [server/src/location/submissionRoutes.ts](../server/src/location/submissionRoutes.ts)
- [server/src/location/submissions.ts](../server/src/location/submissions.ts)
- [server/src/location/types.ts](../server/src/location/types.ts)
- [server/src/location/validation.ts](../server/src/location/validation.ts)
- [server/src/location/workBudget.ts](../server/src/location/workBudget.ts)
- [server/src/services/apiTokenScopes.ts](../server/src/services/apiTokenScopes.ts)
- [server/src/services/submissionIdempotency.ts](../server/src/services/submissionIdempotency.ts)
- [server/test/location/admin.integration.test.ts](../server/test/location/admin.integration.test.ts)
- [server/test/location/assets.test.ts](../server/test/location/assets.test.ts)
- [server/test/location/bank.integration.test.ts](../server/test/location/bank.integration.test.ts)
- [server/test/location/calibration.test.ts](../server/test/location/calibration.test.ts)
- [server/test/location/captureDrafts.integration.test.ts](../server/test/location/captureDrafts.integration.test.ts)
- [server/test/location/dailyScheduler.test.ts](../server/test/location/dailyScheduler.test.ts)
- [server/test/location/database.ts](../server/test/location/database.ts)
- [server/test/location/fixtures.ts](../server/test/location/fixtures.ts)
- [server/test/location/http.integration.test.ts](../server/test/location/http.integration.test.ts)
- [server/test/location/instance.ts](../server/test/location/instance.ts)
- [server/test/location/multiImage.integration.test.ts](../server/test/location/multiImage.integration.test.ts)
- [server/test/location/optimization.integration.test.ts](../server/test/location/optimization.integration.test.ts)
- [server/test/location/projectionMigration.test.ts](../server/test/location/projectionMigration.test.ts)
- [server/test/location/reset.test.ts](../server/test/location/reset.test.ts)
- [server/test/location/roomBroadcast.test.ts](../server/test/location/roomBroadcast.test.ts)
- [server/test/location/rules.test.ts](../server/test/location/rules.test.ts)
- [server/test/location/scopedOptimization.test.ts](../server/test/location/scopedOptimization.test.ts)
- [server/test/location/socket.integration.test.ts](../server/test/location/socket.integration.test.ts)
- [server/test/location/statistics.integration.test.ts](../server/test/location/statistics.integration.test.ts)
- [server/test/location/submissions.integration.test.ts](../server/test/location/submissions.integration.test.ts)
- [server/test/services/keyLockLease.test.ts](../server/test/services/keyLockLease.test.ts)
- [server/test/services/queryCache.test.ts](../server/test/services/queryCache.test.ts)
- [server/test/services/submissionSafety.test.ts](../server/test/services/submissionSafety.test.ts)

### 根目录（6 个）

- [.gitattributes](../.gitattributes)
- [AGENTS.md](../AGENTS.md)
- [compose.scraper.yaml](../compose.scraper.yaml)
- [停止本机测试.cmd](../停止本机测试.cmd)
- [启动本机测试.cmd](../启动本机测试.cmd)
- [爬虫预览.cmd](../爬虫预览.cmd)

## 附录 E 原始证据

本机证据目录：`.local-data/verification/github-comparison-20261023/`。

- `branches.json`、`remote-metadata.json`、`trees/`：固定提交、完整未截断文件树、PR 状态。
- `comparison.json`：8 个分支的全部一致、修改、本机独有、远端独有和生成文件清单。
- `diffs/`：所有修改文件逐行补丁，包括废弃仓库和早期分支。
- `blobs/`：远端源文件缓存；私有爬虫差异 blob 已按 Git SHA 验证。
- `runtime-facts.json`：本次只读计数与采集时间。
- `compare.py`：可复核的比较算法及明确排除规则；只读当前业务文件，写入该证据目录。

GitHub 链接均指向仓库或明确提交；对照方向为“远端 → 本机”。原先固定基线 `integration/upstream-baseline.json` 未因本次比较被更新。
