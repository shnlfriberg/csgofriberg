# 图寻接口 v1

## 2026-11-04 首发修复

首发范围由用户确认为当前七张开放地图；关闭的 Overpass、Vertigo、Train 不参与本轮首发验收，也不改写其题库或校准。

- `REDIS_REQUIRED=true` 时，图寻状态读写和共享锁在 Redis 不可用时拒绝操作，HTTP 返回 503 / `REDIS_UNAVAILABLE`，Socket ACK 使用同名错误码。仅明确允许 Redis 可选的单实例测试保留内存后备；多人客户端保留失败请求用于重试。
- 单人/每日最终成绩落库后，以 `location_results` 内保存的 GameView 为准。最后一次 Redis 保存失败、缓存消失、重试或重新读取都返回原已存结果，不重算成绩。新结果附带内部 `answerRequests` 回执；相同 UUID 改变请求内容返回 `LOCATION_REQUEST_CONFLICT`，换 UUID 也不能改掉已提交答案。旧结果无回执仍兼容读取。随机开局不会恢复已经落库的旧 playing 缓存；每日继续恢复正式交卷结果。已完成局不能再放弃。
- 房间 `me/host/players[].key/results[].key` 使用按 gameId 派生的 `p:` HMAC 标识。私人字段 `viewerUserId` 为接收者账号 ID 或 null，前端用它与会话代次过滤切换账号后的旧推送，不能将它用作服务端认证。只有本人当前落点进入私人视图，权限仍由原 Cookie/Socket 身份链决定。
- 回放仍通过 codec 读取旧 JSON 和共享快照，在对外边界转换旧的原始身份键；新多人结果保存公开席位键。`myKey` 保持与参赛席位对应，访客认领后仍可正确选择本人。内部请求回执不返回客户端，旧数据库载荷不迁移或重写。
- 每日排行榜同时排除 `banned_at` 非空和主动隐藏的账号；解封后可以恢复展示，不删除或改写历史成绩。

## 批量采集草稿（管理员）

- `GET /api/admin/location/capture-drafts`：读取已保存的采集点，返回 `{items}`。
- `POST /api/admin/location/capture-drafts`：提交 `{points:[{id,batchId,batchName,order,capturePointId,mapId,floorId,u,v}]}`，每批最多 500 点。客户端 UUID 保证同一批保存重试不会重复生成；不要求图片、难度或采集信息。
- `PATCH /api/admin/location/capture-drafts/:id/asset`：提交 `{version,asset:{url,thumbnailUrl,hash}}`，绑定已上传的截图。校验图片哈希和版本；同一绑定的重试幂等。
- `POST /api/admin/location/capture-drafts/:id/images`：提交 `{version,imageId,asset}`，追加一张独立待出题图片。`imageId` 是客户端生成的 UUID，同一请求重试幂等；不同图片可以指定同一点位，按返回的新点位版本继续追加，每点最多 100 张待出题图片。
- `DELETE /api/admin/location/capture-drafts/:id/images/:imageId`：提交 `{version}`，只移除指定待出题图片，保留点位及其它图片和题目。
- `DELETE /api/admin/location/capture-drafts/:id`：提交 `{version}`，移除错误采集点。
- `POST /api/admin/location/capture-drafts/:id/complete`：提交 `{version,imageId,question}`，将选中的图片生成独立题目，题目 ID 使用 `imageId`。题目保存和该图片从待出题列表移除在同一事务完成，点位与其它图片继续保留。旧版单图记录可省略 `imageId`，使用点位 ID。地图、楼层、拍摄点编号须与点位一致；截图和雷达答案即可发布，不要求实测坐标、视角或地图校准。

点位可包含 `images:[{id,asset,createdAt}]` 和共用 `world`，旧 `asset` 单图格式仍可读取。第一张实测题目确定位置；同一地图、同一 `capturePointId` 的后续题目继承完全相同的 XYZ 与当前雷达答案，可以分别设置图片、难度、视角和状态。坐标相差超过 0.1 世界单位或楼层不一致时返回 `LOCATION_CAPTURE_POSITION_MISMATCH`；范围内的控制台数值舍入会归一为原坐标。不同站位使用不同点位编号。普通题目接口同样执行约束，避免通过手工编号或 JSON 导入产生同点异位。

地图改版后，旧采集点完成时返回 `LOCATION_CAPTURE_MAP_CHANGED`。管理员必须在编辑页重新核对位置并确认；客户端再携带当前 `question.mapVersion` 保存。

点位及待出题图片保存在 `location_capture_drafts`，独立于可玩题库。完整题库 ZIP 的可选 `captureDrafts` 字段保存点位、共用坐标与所有待出题图片，兼容旧单图及不包含此字段的旧包。

复用现有访客 / 登录身份、请求封装、PoW、权限与限流。身份由 cookie 确定，不能由请求体指定。游戏、进度、历史、回放仅允许当前拥有者读取。管理接口要求管理员。所有游戏状态响应 `Cache-Control: no-store`。

## 单人禁图（2026-10-31）

图寻原“无限模式”的界面名称统一为“单人模式”，沿用 `random` 接口值、路由和历史存储，不改每日/多人玩法。开局难度设置下方提供默认收起的禁图面板，标题显示已选数量 / 2，展开可选择 0–2 张，收起不清空选择。重复 ID、超过两张、未知地图及每日携带非空禁图名单均拒绝。新局先从可玩题池排除这些地图，再执行原有难度配比、点位去重及当日每日题目排除。过滤后不足返回 `LOCATION_BAN_POOL_INSUFFICIENT`，不会回退到禁用地图。

`GameState`/`GameView` 新增可选 `bannedMapIds`，旧局缺省为空；单人局保留全部地图快照供界面显示，但禁图选项标红并禁用，服务端作答时也拒绝 `LOCATION_MAP_BANNED`。禁图随 Redis 状态、回放 codec 和“再玩一局”保留。活跃索引及开局锁按排序后的禁图名单区分；空名单沿用原 key，避免恢复错规则对局或丢失旧局。浏览器恢复后以服务端名单为准；清空按钮可解除已被后台停用地图的旧设置。仅开局多一次题池过滤，无新增 SQL 表/列，不改变历史成绩和固定题单；多人调用不传此参数。

## HTTP

| 方法和路径 | 请求 / 作用 |
|---|---|
| GET `/api/location/maps` | 当前开放地图及楼层雷达目录 |
| POST `/api/location/games` | `{mode: "random"或"daily", difficulty: "easy"或"normal"或"hard", bannedMapIds?: string[]}`；创建或恢复；禁图仅 random 单人模式允许，最多两个不同地图 ID |
| GET `/api/location/games/:id` | 当前私人状态 |
| POST `/api/location/games/:id/answers` | 下列 AnswerInput；一次锁定本轮 |
| POST `/api/location/games/:id/abandon` | `{}`；放弃未完成局 |
| POST `/api/location/games/:id/submit` | `{}`；每日五轮后的正式交卷 |
| GET `/api/location/games/:id/replay` | 已完成五轮回放；未正式交卷不可读取 |
| GET `/api/location/daily` | 上海日期、服务端时间、下一次刷新时间、三个难度的本人状态及题库可用性 |
| GET `/api/location/history?difficulty=normal&page=1` | 每页 15 条本人历史，随机局统计，房间名次及退赛状态 |
| GET `/api/location/leaderboard?date=YYYY-MM-DD&difficulty=normal` | 登录账号每日榜，同分同名次；当日该难度正式交卷后才可读取 |

```json
{
  "mapId": "de_nuke",
  "floorId": "upper",
  "u": 0.42,
  "v": 0.58,
  "round": 1,
  "version": 0,
  "requestId": "04a9a7c8-0df4-47ba-b6cb-5d5d1475321e"
}
```

`u/v` 为原始画布 0–1 坐标。单人 `version` 使用收到的 GameView.version；多人使用当前 round。网络结果不明确时保留并重发同一个 payload/requestId；不得修改重试答案。确定的 409 错误先同步状态。地图 / 楼层无效、非有限数和越界坐标返回 400。

随机逐轮返回结果；每日直到最终交卷前 `results=[]`、`totalScore=null`，不返回题目答案、题号、正确性或距离。地图目录包含公共校准信息，不包含当前题目的答案。每日同难度对所有身份使用相同题序、地图版本和评分版本；三个题单站立点互不重复。正式成绩在数据库以日期＋难度＋身份唯一约束保护。放弃不消耗交卷机会，未交卷进度在上海零点过期。

每日题单由服务端任务在北京时间（Asia/Shanghai）00:00 自动生成，无需后台操作或玩家访问。服务启动会补齐当天缺失的题单；题库不足或其他失败会每分钟重试，跨日时立即尝试新一天。多个服务实例通过共享锁和数据库日期唯一约束只保留一份全服题单；已有题单原样复用，重启、题库编辑和后台补生成均不会重抽当天题目。原有玩家请求的补生成逻辑作为兜底保留，榜单继续使用相同的日期和难度统计分数。

已完成回放返回 `results[]`、`totalScore`、`difficultyMix` 和 `scoringVersion`。每轮保存题号 / 版本 / 等级、原图、所选点、答案、真实和所选地图快照及已计算得分。多人还返回 `rank`、`retired`、`myKey`、`participants` 和 `roomResults`。历史分数不重新计算。

## 管理 HTTP

| 方法和路径（前缀 `/api/admin/location`） | 作用 |
|---|---|
| GET `/overview` | 轻量元数据：地图、题目、采集数量、各等级数量、待重新核对数量、最近每日题单；不扫描图片 |
| GET `/checks` | 按需检查原图哈希、缩略图、五轮配比和每日三个独立题单配比，返回 `{missingAssets,compositions,dailyAvailable}` |
| POST `/assets` | 原始 PNG / JPEG / WebP 请求体；最大 16 MiB。默认先应用 EXIF 方向，再直接裁取正中心 360×360 像素，保存 WebP 和 240×240 缩略图；返回处理后 URL、SHA256 和尺寸。原图宽高均需至少 360 像素 |
| PUT `/maps/:id` | 完整 MapDefinition，携带当前 version；有足够分散基准点时，服务端根据全部实测点重算原点和比例，忽略提交的旧参数；几何变更生成新版本 |
| POST `/questions` | 完整题目；新题 id 可省略；修改携带当前 version |
| POST `/questions/import` | `{questions:[...]}`，1–500 题，分别返回成功或失败 |
| POST `/daily/generate` | 立即检查并补生成当天三个题单；已有题单原样返回。常规生成由服务端每天北京时间 00:00 自动执行，无需手动操作 |

题目状态：`draft / review / published / disabled`。地图、楼层、雷达答案点、等级、capturePointId 和图片素材引用必填；capturedAt 默认当前时间，build 和 source 默认空字符串。`world={x,y,z}` 和 `view={pitch,yaw,roll,fov}` 始终可选，地图校准也不作为发布条件。若主动提供 world，仍检查其与雷达答案的一致性（偏差不超过 0.005）；可选定位辅助不参与游戏计分。地图配置和采集流程见 [location-capture.md](location-capture.md)。

`POST /api/admin/location/questions/publish` 批量发布：提交 `{questions:[{id,version}]}`，每次 1–500 道且 ID 不重复。只处理当前仍为 `draft/review`、题目版本一致且地图版本未变的题目；使用正常保存逻辑校验图片和答案，并保留历史版本。返回 `{results:[{id,capturePointId,ok,code?}]}`，单项失败不会阻止其余题目。已发布或已停用返回 `LOCATION_QUESTION_NOT_PENDING`，地图版本变化返回 `LOCATION_CAPTURE_MAP_CHANGED`，题目被修改返回 `LOCATION_STALE_STATE`。

## 统一统计与图片回放

“统计/回放”中的“图寻”页签地址为 `/stats?variant=location`；原 `/entertainment/location/history` 入口自动跳转到这里。

- `GET /api/location/stats?difficulties=easy,normal,hard`：返回 `personal/global` 两份统计，包括单人总场次、随机与每日场次、单人平均分和最高分、多人场次、参与人次、胜场和平均分。空样本分数为 `null`。只统计已持久化的已完成战绩；个人统计按当前登录账号或游客身份隔离。全站多人场次按 `game_id` 去重，参与人次按玩家战绩计数；多人 `rank=1` 且未退赛计为胜场。汇总直接在数据库聚合，不载入整站截图和地图快照。
- `GET /api/location/replays?difficulties=easy,normal,hard&type=single&mode=all&page=1&pageSize=15`：只返回当前身份战绩，支持 `type=single/multi`；单人可选 `mode=all/random/daily`，多人忽略单人模式筛选。每页最多 50 条，响应包含 `items/page/pageSize/hasNext`，排序按完成时间和对局 ID 倒序。
- `GET /api/location/games/:id/replay`：继续使用既有的身份权限校验，返回原始截图、历史地图、答案、玩家落点及逐题得分快照；其他身份不能读取个人回放。新回放弹窗提供轮次缩略图、图片放大、雷达叠加及多人玩家切换。页面筛选变化时会忽略先前尚未完成的回放请求。

截图上传不保留大尺寸原图，重复图片按裁剪后的内容判断。显式使用 `/assets?purpose=radar` 上传校准雷达时保留原始画布尺寸，不执行截图裁剪。题库 ZIP 恢复原有图片和哈希，不重复裁剪历史素材。原图不足 360×360 时返回 `LOCATION_CAPTURE_TOO_SMALL`。

## Socket.IO

复用原有连接、身份、PoW 与 IP / 身份限流；事件独立使用 `location:*`。成功 ACK：`{ok:true,data:...}`；失败：`{ok:false,code:...}`。私人推送：`location:room`，内容为当前席位的 RoomView。

| 事件 | 参数 |
|---|---|
| `location:room:create` | `{difficulty,duration:60或120或180}` |
| `location:room:join` | `{roomId}`，五位大写字母数字 |
| `location:room:state` | `{roomId}` |
| `location:room:ready` | `{roomId,ready}` |
| `location:room:start` | `{roomId}`，房主操作，至少两人且全员准备 |
| `location:room:answer` | `{roomId,...AnswerInput}` |
| `location:room:leave` | `{roomId}` |
| `location:match:join` | `{difficulty}`；双人、120 秒；仅限已登录且绑定并验证邮箱的用户，否则返回 `EMAIL_VERIFICATION_REQUIRED`；入队及配对时读取最新验证状态；一个身份只在一个难度队列中 |
| `location:match:cancel` | `{difficulty}`；取消此身份的匹配 |

状态：waiting → preparing（3 秒）→ playing → round_over（8 秒）→下一轮 preparing；第五轮结束为 finished。全员提交或服务端到时才公开本轮答案及各席位落点。作答前仅有各自的 myGuess、公开提交状态和已揭晓轮次的成绩。可恢复计时和结果队列在 Redis；数据库结果写失败进入重试，游戏＋身份唯一约束防重复。

断线保留 30 秒，计时不停。新连接按身份恢复席位和私人状态；过期则退赛。退赛者保留已揭晓得分，后续计 0，不参与获胜判定。只剩一名仍完成五轮；所有人退赛取消。已开始比赛不能插入新玩家，无观战。

## 管理员题库 ZIP 迁移

以下接口均在 `/api/admin/location` 下，复用管理员认证、PoW 和 no-store；不提供给普通玩家：

| 接口 | 输入／输出 |
| --- | --- |
| `GET /bank/export` | 流式 ZIP 附件，包含当前题目、所引用的地图快照及图片 |
| `POST /bank/preview` | `Content-Type: application/zip` 的二进制请求体，最大 1 GiB；返回预览 token、30 分钟期限、catalog fingerprint、数量、冲突和 canImport |
| `POST /bank/recheck` | JSON `{token,updateQuestions:false或true}`，刷新预览及 fingerprint |
| `POST /bank/import` | JSON `{token,fingerprint,updateQuestions}`，返回 `{added,updated,skipped,maps}`；token 幂等，同编号差异默认阻止 |

包格式为 `friberg-location-bank` v1，只有 `manifest.json` 和 `assets/<sha256>.webp`；上传阶段校验缺图、哈希、格式、雷达尺寸、坐标与楼层，拒绝路径越界和未知条目。导入在一个数据库事务中保存题目和地图版本；当前每日题单、已开局、账号与战绩不在迁移范围，旧快照不改写。更多边界及上线命令见 [题库迁移文档](location-bank-transfer.md)。

## 规则和常见错误

easy＝3 易/1 中/1 难；normal＝2 易/2 中/1 难；hard＝1 易/2 中/2 难，均打乱题序，站立点不重复，优先不同地图。关闭地图不参与新题组。

地图错：0。地图对：`max(1, round(5000 × exp(-5 × max(0,r-0.005)) × f))`，`r` 使用原始雷达二维距离除以可玩边界对角线；楼层正确 f=1，错误 f=0.25。没有速度奖励。同分并列。

常见 code：LOCATION_POOL_INSUFFICIENT、LOCATION_STALE_STATE、LOCATION_REQUEST_CONFLICT、LOCATION_ROUND_LOCKED、LOCATION_GAME_EXPIRED、LOCATION_ALREADY_SUBMITTED、LOCATION_NOT_READY、LOCATION_ROOM_UNAVAILABLE、LOCATION_RETIRED、LOCATION_CALIBRATION_REQUIRED、LOCATION_COORDINATE_REQUIRED、LOCATION_CAPTURE_DETAILS_REQUIRED、LOCATION_COORDINATE_MISMATCH、LOCATION_DUPLICATE_IMAGE、LOCATION_INVALID_ASSET。错误文案有中 / 英 / 日三语。
