# 弗一把开发工作区与 GitHub 版本统一

核对日期：2026-10-20。工作区：`F:\friberg-ex`。

## 采用的基线与结论

基线为 [shnlfriberg/csgofriberg](https://github.com/shnlfriberg/csgofriberg) 的 `main`，提交 [`99f2e471474cfefd38de13033608bdc816a24242`](https://github.com/shnlfriberg/csgofriberg/commit/99f2e471474cfefd38de13033608bdc816a24242)，提交时间 2026-10-18 17:12（北京时间）。仓库 README、生产镜像说明及发布工作流均指向这个项目。此次对齐的是 GitHub 源码基线，未连接线上服务器核实其实际部署镜像。

按项目维护者确认，仅使用 `csgofriberg` 作为同步基线；其他废弃游戏仓库不参与同步，也未从中引入代码。

核对前，上游跟踪的 320 个文件中，294 个与本机内容一致（统一 CRLF/LF 后），26 个有差异，没有缺失文件。差异逐项检查后，没有发现普通游戏公共业务代码缺少上游功能或修复。以下内容已经一致：

| 方面 | 核对结果 |
| --- | --- |
| 单人游戏、难度、反馈、每日挑战 | 玩法、接口、状态存储和前端一致 |
| 多人游戏 | 大厅、房间、接力、2v2、重连、匹配、回放及后端 Socket 代码一致 |
| 海龟汤 | 24 次机会、问答、提示、回放和统计实现一致 |
| 账号与权限 | 登录、游客、邮件验证、PoW、限流及权限代码一致；登录认领额外包含图寻数据 |
| 选手管理 | 已包含 10 月 18 日合入的编辑修复：仅提交可编辑字段，不带数据库元数据 |
| 选手数据接口 | 外部 Token、导出、直接写入、待审核提交、审批与冲突检查代码一致 |
| 统计与排行榜 | 普通及海龟汤数据接口一致；前端保留图寻统计入口和贡献榜 |
| 公共文案与样式 | 三语公共文案一致；额外加载图寻文案和样式 |

本机的 669 人数据库、账号、历史战绩、题库及图片属于运行数据，没有拿演示种子或旧仓库数据库覆盖。爬虫和图寻开发内容保留，未在本次升级其算法或启用新功能。

## 本次实际修改

旧 `scripts/local.ps1` 曾使用 `.local-tools`、`.local-data/development.sqlite3`、端口 3000/5173/16379，和当前双击启动使用的账号、数据库、Redis 及图片目录不同。现将其收敛为现有整合版流程的兼容入口：

| 命令 | 统一后的行为 |
| --- | --- |
| `pnpm local:start` / `scripts/local.ps1 -Action start` | 调用现有启动器，网页 5175、API 3002、Redis 16380，保留进程归属校验 |
| `pnpm local:stop` / `scripts/local.ps1 -Action stop` | 调用现有停止器，校验 PID 与创建时间并保存 Redis |
| `pnpm local:test` / `scripts/local.ps1 -Action test` | 调用隔离测试，运行后端、前端、爬虫测试；先启动本机服务以提供 Redis |
| `scripts/local.ps1 -Action backend-test` | 同一隔离机制，仅测试后端 |
| `scripts/local.ps1 -Action build` | 使用 `.tools` Node 26，执行标准 `pnpm build` |
| `scripts/local.ps1 -Action import -PlayersFile 文件` | 通过现有启动器设置同一数据库和 Redis，再执行既有选手导入器 |
| `scripts/local.ps1 -Action setup` | 使用工作区随附的 `.tools` 运行时，按锁文件安装依赖 |

新增 `scripts/check-upstream.mjs` 和固定版本清单 `integration/upstream-baseline.json`。未改写已经一致的游戏业务代码，也未执行数据导入、重置或向 GitHub 推送。

同时修正 `scripts/smoke-integrated.py` 中固定为初次导入数量的断言，改为只读查询当前 SQLite 数量后与 API 结果核对。此次运行核对了 669 名选手、299 道题和 280 个采集草稿；图片缺失数为 0，三档随机题组均可组成。该改动仅涉及验证脚本。

## 保留差异的逐项说明

以下为上游文件中保留的全部差异类别。每个文件的上游哈希、本机哈希及单独原因均在基线 JSON 中；可读补丁为 `integration/upstream-differences.patch`。

| 文件 | 保留原因 |
| --- | --- |
| `client/src/components/GameRules.tsx` | 新增图寻规则分支；保留经典和海龟汤规则 |
| `client/src/i18n/resources.ts` | 仅额外导入中英日图寻文案 |
| `client/src/pages/Admin.tsx` | 新增图寻管理标签 |
| `client/src/pages/Home.tsx` | 娱乐入口包含海龟汤和图寻，旧海龟汤路由仍可访问 |
| `client/src/pages/Leaderboard.tsx` | 新增图寻贡献榜，公共榜单逻辑保留 |
| `client/src/pages/Stats.tsx` | 新增图寻统计，模式标签抽成共用组件 |
| `client/src/router.tsx` | 增加娱乐、图寻、投稿、历史路由 |
| `client/test/components/GameRules.test.tsx`、`client/test/pages/Home.test.tsx` | 在上游测试上补充图寻规则及娱乐入口断言 |
| `client/vite.config.ts` | 可配置本机代理和端口，新增图寻图片代理 |
| `server/src/db/schema.ts`、`server/src/db/ready.ts` | 创建与检查额外图寻表 |
| `server/src/db/migrate.ts` | 迁移后增加就绪检查 |
| `server/test/db/ready.test.ts` | 增加图寻旧库升级与数据保留测试 |
| `server/src/index.ts` | 注册图寻 HTTP、图片、Socket 和每日调度器 |
| `server/src/routes/auth.ts` | 游客登录认领额外包含图寻战绩与投稿 |
| `server/package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml` | 图寻图像、ZIP 导入导出所需依赖和命令 |
| `Dockerfile`、`compose.yaml` | 图寻原生图像依赖、共享图片卷及题库导入服务；未在本机执行 Docker 部署验收 |
| `.dockerignore`、`.gitignore` | 排除本机运行时、数据、凭据和爬虫输出 |
| `scripts/local.ps1`、`package.json` | 本次统一启动、停止、隔离测试与版本检查命令 |
| `README.md` | 保留整合版说明并增加本次基线与检查入口 |

`client/tsconfig.tsbuildinfo` 是上游误跟踪的增量编译产物，构建会改动，检查时明确排除。新增的图寻、爬虫、采集、投稿、原始素材和整合文档是本地扩展，不将其视为上游缺失文件。

## 以后如何复查

在工作区根目录运行：

```powershell
pnpm upstream:check
pnpm upstream:check --remote
```

第一条离线检查所有 319 个非生成上游文件。公共文件必须与上游相同；已审阅扩展必须匹配本次记录的确切本机哈希，不会因为文件属于图寻接入点就放过其后续任意修改。删除文件或修改公共实现会失败。

第二条额外通过 `git ls-remote` 查询上游 `main`，若出现新提交则失败并提示重新审阅。它不会拉取、覆盖、提交或自动改动基线。

此次下载的上游代码位于 `.local-data/upstream/csgofriberg/`。可额外验证上游检出目录与清单完全对应：

```powershell
node scripts/check-upstream.mjs --source .local-data/upstream/csgofriberg --remote
```

`--output` 可保存完整 JSON 报告，要求使用工作区内尚不存在的文件路径。更新公共代码后应重新比对上游，并检查保留扩展的差异，再人工更新基线；不要仅为了让检查通过而重新计算本机哈希。

## 备份与验证

本次修改前的 `local.ps1`、`package.json`、`README.md` 和整合说明已备份在 `.local-data/backups/upstream-unification-20261020/`。

结果：后端 289 项、前端 234 项、爬虫 124 项测试通过，另 1 项真实联网爬虫测试按原设置跳过；PoW、前端和后端构建通过。统一启动入口及真实 HTTP 冒烟检查通过。版本检查器另通过正常副本、公共文件意外修改、扩展文件意外修改、缺失文件和 CRLF/LF 归一化 5 项验证。

验证记录与结果见 `integration/upstream-verification.json`，完整回归日志见 `.local-data/upstream-unification-tests.log`，构建日志见 `.local-data/upstream-unification-build.log`。隔离测试使用新的临时 SQLite、图片目录及 Redis 第 15 库的随机前缀；未覆盖现有游戏运行库。
