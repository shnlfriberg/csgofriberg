# 卡牌连接：选手队史时间线基础

实现日期：2026-11-04（北京时间）。本次在现有任期模型上补齐迁移和时点查询，没有另建选手库或替换已批准队史。游戏当前使用的冻结关系图保持原契约。

## 当前数据与导入链路

检查范围包括 `services/playerMutations.ts`、`playerExport.ts`、`teamHistory.ts`，`card-link/careers.ts`、`careerSync.ts`、`tenures.ts`、`schema.ts`，以及爬虫 `scraper/careers.py`、README 和卡牌设计/实施记录。

| 数据 | 现有职责及保留方式 |
| --- | --- |
| `players.team` | 当前队伍显示值，不能用于推断过去时刻的队伍 |
| `players.team_history` | 旧玩法的队名 JSON 数组；允许重复经历，没有可靠起止日期，保留原值、顺序与选手 ID |
| `card_careers` | 每个 player_id 的已批准完整任期 JSON 和 revision，保留原始日期、精度、来源、人工保护及 sourceSnapshot |
| `card_career_tenures` | `(player_id, ordinal)` 主键的任期投影；有 person_key、team_id/start_date 索引，日期允许 null |
| `card_career_reviews` | 独立的待审/冲突/已批准任期提案，不是时点查询事实来源 |

普通爬虫更新经旧资料审核维护 `team_history`。结构化时间线由同页面的 `extract_career` 独立产生，`career_sync.py` 按 expectedRevision 提交任期审核；`mergeCareer` 匹配已有事实、保护人工字段，`reviewCareer` 审批后在事务中更新生涯修订与变化的索引行。此流程继续保留。

选手 JSON 导出带 `career`、`career_revision`；导入任期变化进入审核，相同内容重导入不增加修订。旧格式或 `career:null` 不清空已批准生涯。本次复用了该链路，增加了审批前后时点查询结果的回归断言，没有直接导入或批准真实数据。

## 增量存储与迁移

复用上述已有表，避免产生与现有任期相互覆盖的第三套数据。`careerProjection.ts` 集中生成任期投影，日常审批与迁移共用相同字段映射。

`ensureCardSchema` 在单独迁移流程中调用 `backfillCareerTenures`：

1. 对已有 `card_careers.payload` 校验后，按原始任期序号补充缺失的投影行；索引表不存在时沿用原 schema 创建。
2. 已存在的 `(player_id, ordinal)` 只保留，不更新或删除，包括原 payload 的格式。分批写入不超过 SQLite 保守绑定数量，唯一键冲突忽略；再次执行无重复。
3. 回填在一个事务中完成，并复用审批的 catalog 行锁，防止 PostgreSQL 并发审批时混用旧 JSON 与新序号。任一来源解析或插入失败，回滚本轮全部回填；不修剪、不自动修复或重排来源。
4. 不从 `team_history` 队名猜造日期，不更新 `players`、`card_careers`、审核状态、catalog revision 或冻结图。已有投影与 JSON 不一致也不在迁移中强制覆盖，应另行核查并走审核修复。

维护清单沿用 [卡牌实现记录](card-link-implementation.md#架构与维护清单) 的原表集合，无新增表/列，因此现有 `CARD_REQUIRED_COLUMNS` 与 readiness 仍覆盖全部所需结构。readiness 仅检查，不执行回填；数据库迁移继续由单独进程运行，不能在两个生产应用启动时并行 DDL。

正式库需要升级时，先做新的可恢复备份并在副本演练，再通过现有迁移命令执行。回填失败可排查来源后重试，不删表回退。本次只执行隔离库与真实库副本迁移，未对真实库运行迁移。

## 查询契约

服务端入口：`server/src/card-link/timelineQuery.ts` 的 `queryPlayerTimelineAt(playerId, at, reader?)`。纯逻辑入口为 `timeline.ts` 的 `timelineDate`、`teamsAt` 与 `playerTimelineAt`。

```ts
const snapshot = await queryPlayerTimelineAt(123, "2020-06-01");
// snapshot.teams 中每项含 teamId、team、该选手 evidence 和 teammates。
// 每个 teammate 含规范 playerId、同人 playerIds、personKey、昵称及任期证据。
```

- `at` 接受严格 `YYYY-MM-DD` 或带 `Z`/明确偏移的 ISO 时间戳。时间戳先转 UTC 日期；无时区时间、非法日期和非法选手 ID 拒绝。资料只有日粒度，不声称知道一天内具体转会时刻。
- 半开区间 `[start,end)`：入队日包含，离队日不含。同日转会、任期间隙及重复回归分别计算。月底/年末等已有保守边界照原样使用，返回证据仍携带 precision/rawDates/source/manual；不扩大到整月或整年。
- Present 使用已经存储的采集截点，不随查询时间延长；null、倒置和零长区间不作为肯定在队证据。
- 完全复用 `effectiveTenures`：租借算借入队，并扣除原队重叠期；下放期扣除；staff、unknown 及未验证试训/替补不算；冲突任期保守排除。独立选手任期不因另有 staff 身份而被删除。
- 按 `teamId` 匹配，不能用队名显示值合并学院、分队或 ex- 阵容。沿用卡牌的 CS:GO/CS2 连续队史规则，不用 game 字段把同一阵容的跨游戏经历拆成不同队伍。
- 按 `personKey` 合并同人的所有记录，再处理冲突、租借和下放；不将自己列为队友。队友按最小旧 playerId 展示，`playerIds` 保留同人全部旧 ID；不删除重复记录。只确认同一日期仍有效的队友，不把同队不同年代混为同队。
- 查询包括已停用选手的历史事实；`is_enabled` 是当前游戏牌池开关。新查询用于资料，不替代冻结图建图时的启用筛选。
- 不存在的 playerId 返回 null；无结构化生涯返回 `coverage: "missing-career"`；有生涯但该日无肯定区间返回 `"no-confirmed-team"`；存在肯定区间返回 `"confirmed"`。空结果不等于确定“自由人”或没有历史队友。

持久查询以一条 LEFT JOIN 读取玩家和已批准生涯，获得 SQLite/PostgreSQL 单语句一致快照，再做纯计算；不依赖可能缺行的旧投影筛选，因此不会遗漏同人的冲突记录。没有 N+1、写入、DDL、系统时间或 Redis 依赖。当前规模约 669 条选手记录，这个按需资料查询会读取全部生涯；不接入出牌或逐秒调度，若未来扩展到更大规模，再设计保留完整人物事实的候选查询优化。

本次交付核心服务，没有新增公开 HTTP/Socket 接口、管理 UI 或自动发布关系图。已开始对局与旧回放继续使用自己的冻结版本，不调用最新资料改判。

## 验证记录

2026-11-04 08:58:29 +08:00 从真实 SQLite 只读连接生成一致副本：669 名选手、668 份生涯、8,748 段索引任期，共 56 张表。副本连续执行两次卡牌迁移，56 张表逐表数据哈希完全一致，`PRAGMA quick_check` 为 `ok`；同时完成一次基于真实资料副本的时点查询。未重新采集、批准或覆盖真实选手数据。

副本和证据：`.local-data/verification/career-timeline-20261104/rehearsal.sqlite3`、`before.json`、`preservation.json`。该副本用于本次数据库演练，不替代图片和 Redis 备份，不允许覆盖真实库。

验证结果（2026-11-04）：

- `scripts/test-integrated.ps1 -Suite server` 最终 74 文件、449 项全部通过。新增 11 项覆盖日期与时区、半开转会边界、重复回归、未知/模糊/Present 日期、租借、下放、staff/临时身份、同人去重、完整/部分索引迁移、回填失败回滚、旧 JSON 字节保留和只读查询；已有导入集成测试另补审批前后查询断言。
- 首轮为 446 通过、3 失败，原因是新迁移测试批量插入样本时漏填非空 `is_enabled`。补齐测试样本后全量复测通过，没有为通过测试放宽正式 schema。
- 服务端构建（含两个共享核心包）通过。固定上游检查：261 identical、58 reviewed、0 missing、0 unexpected，未重算或修改基线。
- 最终构建在上述副本再执行两次迁移并查询，56 表数据仍全部不变、quick_check 为 ok。一次完整资料查询约 58ms，仅是本机单次观察，不作为并发容量承诺。
- 本机 API 健康检查为 ok、Redis 为 up；未重启或发布应用，未向真实库迁移/导入/审核。本次未修改前端或爬虫，未重跑其测试；未执行 PostgreSQL 或生产镜像的新验收。

日志：`.local-data/verification/career-timeline-server.log`（首轮）、`career-timeline-server-final.log`、`career-timeline-build.log`、`career-timeline-upstream.log`。
