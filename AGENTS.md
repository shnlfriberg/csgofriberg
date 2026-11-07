# 弗一把工作区接手入口

本文件帮助后续智能体继续开发。用户当前指示优先；本文件不授权发布、发送消息、清库或覆盖既有数据。

## 先读什么

1. [项目设计与接手手册](docs/PROJECT_HANDOFF.md)：产品、演进、架构、数据、流程、测试、部署和待办。
2. [当前数据与配置快照](integration/project-handoff-snapshot.json)：2026-10-23 只读采集，数量会继续变化。
3. 修改相应模块前，再读主手册末尾列出的专题文档和当前代码。

## 项目与来源

- 工作区是 `F:\friberg-ex`，包含游戏、图寻及 `external-scraper/`，共用游戏账号、选手库与后台。
- 游戏公共代码基线是 `shnlfriberg/csgofriberg@99f2e471474cfefd38de13033608bdc816a24242`。
- 用户明确废弃 `csgofriberg2`，不要用它同步游戏代码。
- 用户明确爬虫与选手库更新功能以本机较新版本为准，不要用上游旧实现覆盖。
- 2026-10-23 交接时根目录没有 `.git`；归档仓库不等于当前工作区 Git 状态。不要擅自初始化仓库或推送。

## 必须保留的开发边界

- 真实题库、采集草稿、地图校准、历史快照、战绩、选手 ID、图片和 Redis 活跃状态都是用户数据。
- 不为测试重置本机数据库，不重生成既有每日题单，不重算旧分数，不以种子库覆盖 669 人选手库。
- 数据迁移优先新增表、列和索引，保留原 JSON；破坏性迁移必须另有明确任务范围并有可恢复备份。
- 图寻历史记录同时存在旧 JSON 和新共享快照格式，必须经过存储 codec 读取，不能假定 `JSON.parse(payload)` 得到完整回放。
- 图寻题目 `id`、采集草稿 `id`、`capturePointId`、地图版本和对局版本含义不同，不得混用。
- 默认保留未保存的采集点和图片队列；隐藏工作台只暂停加载，不能通过卸载清空输入。
- 娱乐入口保留统一单色勾线小鸭图标；“你的落点”保留橙色 `#ff9f43`。
- 普通玩家可访客游玩；随机匹配要求已登录并完成邮箱验证。不要把此要求扩大到好友房或全部游戏。

## 本机运行

- 统一配置在 `config/local-profile.json`：网页 `5175`、API `3002`、Redis `16380`、前缀 `friberg-integrated:`。
- 数据库：`server/data/csgofriberg.sqlite3`；资源：`data/location-assets/`。
- 使用 `启动本机测试.cmd` / `停止本机测试.cmd`，或 `pnpm local:start` / `pnpm local:stop`。
- 本机用 `.tools` 内的 Node 26 和 SQLite shim。不要全局终止所有 Node/Redis 进程；启动停止脚本会验证进程归属。
- `.env`、`.local-data/test-admin.json`、`.local-data/location-runtime.json` 和爬虫真实配置含敏感信息，不写入文档、日志或提交。

## 修改与验证

- 新增图寻纯计算或跨端类型优先放在 `packages/location-core`。前端不要重新依赖 `server/src` 运行时代码。
- 保持现有 Cookie、PoW、错误码、权限和 Socket 身份链；不要为新页面另建认证或连接。
- 服务端新增持久表时同步 schema、readiness、维护清单及迁移测试；不要在两个生产应用实例启动时并发执行 DDL。
- 使用 `scripts/test-integrated.ps1 -Suite server|client|scraper|all` 隔离数据库、图片与 Redis 前缀；不要直接继承实际 `.env` 运行集成测试。
- `pnpm test` 只覆盖前后端，不包含爬虫。图寻多人变更应覆盖双进程故障演练。
- 固定上游基线哈希检查（原 `pnpm upstream:check`、`scripts/check-upstream.mjs`、`integration/upstream-baseline.json`）已按用户要求于 2026-11-07 移除；同步上游时直接审阅具体差异，不再维护哈希清单。
- 最新已记录验证（2026-11-07，娱乐单人接入 `/api/game` 与 `/api/stats` 后）为服务端 80 文件/490 项、前端 65 文件/349 项，客户端/服务端构建通过；爬虫历史为 124 项通过、1 项联网测试跳过。这些是历史验收，不能代替本次改动后的验证。
- 单人玩法（经典、海龟汤、图寻单人、卡牌单人）统一走 `/api/game`（`start` 按身份＋mode＋variant 创建或恢复），图寻/卡牌统计走 `/api/stats?variant=`；用户明确不需要兼容升级前页面，不要恢复已删除的旧单人/统计接口。
- 卡牌多人页面的创建、加入、准备、开局、出牌、匹配、目录、补读和续局均走现有 WS，房间 ID 保存在绑定身份的页面/sessionStorage 状态，不写入地址栏；单人和每日仍用原 API。图寻与卡牌均支持至少两名在线玩家全部同意后自动续局，可撤回；随机匹配续局转为好友局，旧战绩保留。图寻作答及重试必须绑定 gameId，不能把上局延迟答案用于新局。
- 本轮工作树验证（2026-11-07）：隔离服务端 86 文件/515 项、前端 67 文件/357 项及双方构建通过，包含双进程三人续局与原 20 房/160 人故障演练；未做浏览器或 Docker/PostgreSQL 验收。日志 `.local-data/verification/rematch-server-final.log`、`rematch-client-acceptance.log`。此结果包含工作树已有安全修复，不代表仅此次提交的独立检出已跑过同样数量。
- 完成任务时更新主手册相关事实、设计边界及验证记录；数量和地址应带采集时间，待办不能写成已完成功能。
