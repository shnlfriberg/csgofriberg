# 弗一把 (csgofriberg)

**CS:GO / CS2 Major 选手猜测游戏 —— 类 Wordle 玩法 + 实时多人对战**

[![CI and Docker](https://github.com/shnlfriberg/csgofriberg/actions/workflows/docker.yml/badge.svg)](https://github.com/shnlfriberg/csgofriberg/actions/workflows/docker.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![Node.js ≥ 26](https://img.shields.io/badge/node-%E2%89%A526-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![pnpm workspaces](https://img.shields.io/badge/pnpm-workspaces-F69220?logo=pnpm&logoColor=white)](https://pnpm.io/)
[![ghcr.io](https://img.shields.io/badge/ghcr.io-csgofriberg-2496ED?logo=docker&logoColor=white)](https://github.com/shnlfriberg/csgofriberg/pkgs/container/csgofriberg)

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![React 18](https://img.shields.io/badge/React_18-61DAFB?logo=react&logoColor=black)
![Vite](https://img.shields.io/badge/Vite-646CFF?logo=vite&logoColor=white)
![Express](https://img.shields.io/badge/Express-000000?logo=express&logoColor=white)
![Socket.IO](https://img.shields.io/badge/Socket.IO-010101?logo=socketdotio&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?logo=postgresql&logoColor=white)
![Redis](https://img.shields.io/badge/Redis-FF4438?logo=redis&logoColor=white)

[玩法](#玩法) · [功能特性](#功能特性) · [快速开始](#快速开始) · [部署](#docker-生产部署) · [选手数据](#选手数据) · [贡献](#贡献)

</div>

---

## 玩法

输入选手昵称,系统按 **国家或地区 / 赛区 / 队伍 / 年龄 / 位置 / Major 冠军数 / Major 出场数 / 现役状态** 逐属性给出对比反馈:

- 🟩 **绿色** —— 该属性与答案完全一致
- 🟨 **黄色** —— 接近(同赛区、数值相差不大)
- ↑↓ **箭头** —— 数值型属性提示答案更高或更低

8 次机会内猜出目标选手即获胜。

## 功能特性

- 🎮 **单人模式** —— 简单版(知名选手)/ 完整版(全部选手),进行中对局可断线续玩
- 🌐 **多人联机** —— BO1/3/5/7 赛制、随机匹配、5 位房间码、观战;每小局限时 120 秒,断线即时通知、同身份可重连,30 秒未归判负
- 🔍 **查选手** —— 模糊搜索选手资料
- 📊 **统计与回放** / 🏆 **排行榜** / 📢 **公告**
- 👤 **无需登录** —— 所有模式对匿名访客开放,战绩按浏览器本地标识记账,登录后自动并入账号
- 🌏 **多语言** —— 简体中文 / English / 日本語;前后端交互仅传递错误码,文案统一在前端翻译
- 🎨 **双主题** —— Blast 暗色 / 日间浅色,首次访问跟随系统偏好
- 🛡 **PoW 人机验证** —— 公开接口由 WASM 工作量证明保护(Rust 编译,仓库内置预编译产物)
- 🛠 **管理后台** —— 选手增删改、JSON 批量导入、外部 API Token、公告管理

## 技术栈

| 层        | 技术                                                     |
| --------- | -------------------------------------------------------- |
| 前端      | React 18 + Vite + TypeScript + React Router + Zustand    |
| 后端      | Node.js + Express + TypeScript                           |
| 数据库    | 本地开发支持 SQLite；生产 Docker 镜像固定使用 PostgreSQL |
| 缓存/实时 | Redis + Socket.IO(Redis Adapter 跨实例广播)              |
| 认证      | JWT + bcrypt(HttpOnly Cookie,客户端不存明文令牌)          |
| 校验/测试 | Zod / Vitest                                             |
| 包管理    | pnpm workspaces                                          |

## 快速开始

**环境要求**:Node.js ≥ 26、pnpm、Redis(本地开发可降级为内存模式)；SQLite 开箱即用,无需额外数据库。Rust 工具链可选——仅在需要重新编译 PoW WASM 时安装,默认使用仓库内置的预编译产物。

```bash
pnpm install
cp .env.example .env                 # 可选,有默认值
pnpm dev                             # server: 3000, client: 5173
```

访问 http://localhost:5173 。公开注册的账号默认都是普通用户,创建或重置管理员:

```bash
ADMIN_USERNAME=admin ADMIN_PASSWORD='至少12位强密码' pnpm create-admin
```

### 运行时行为说明

- Redis 默认连接 `redis://127.0.0.1:6379`;生产环境建议 `REDIS_REQUIRED=true`,避免 Redis 故障时降级为仅适合单实例的内存模式
- 生产环境强制要求 PostgreSQL、至少 32 字节随机 `JWT_SECRET` 和 `REDIS_REQUIRED=true`
- 访客显示 ID 使用 HMAC-SHA256 派生,可用 `GUEST_ID_SALT` 配置独立盐(未配置时复用 `JWT_SECRET`)
- 单人进行中的对局只保存在 Redis,**1800 秒(30 分钟)** 无有效操作自动过期;猜中、次数耗尽或查看答案后才写入数据库,主动离开或重新开始只清理临时状态、不产生历史战绩

## 常用脚本

| 命令                | 说明                                    |
| ------------------- | --------------------------------------- |
| `pnpm dev`          | 同时启动前后端开发服务                  |
| `pnpm build`        | 构建 PoW WASM + 前端 + 编译后端         |
| `pnpm start`        | 生产模式启动(server 托管 client/dist)   |
| `pnpm test`         | 运行前后端测试                          |
| `pnpm migrate`      | 初始化数据库结构 + 种子选手             |
| `pnpm seed`         | 补充 5 名基础种子选手中缺失的选手       |
| `pnpm create-admin` | 显式创建或重置管理员                    |
| `pnpm loadtest`     | 运行 HTTP 缓存接口与多人建房负载测试    |

## 切换 PostgreSQL

修改根目录 `.env`:

```
DB_CLIENT=pg
DB_URL=postgres://user:pass@localhost:5432/csgofriberg
```

## Redis 用途

<details>
<summary>展开查看</summary>

- HTTP 与 Socket.IO 分布式限流
- HttpOnly Cookie 会话、实时角色校验和匿名身份签名绑定
- `/api/players/list` 版本化缓存、ETag 与跨实例失效通知
- 排行榜、公告等热点查询缓存
- 多人房间快照、身份索引、分布式房间锁和匹配队列
- 回合超时、断线判负和房间清理的可恢复调度
- Socket.IO Redis Adapter 跨实例广播
- Redis Stream 多人战绩持久化重试

</details>

## Docker 生产部署

生产环境使用 PostgreSQL 专用的精简 Docker 镜像(distroless 运行时,不含 Rust、pnpm、TypeScript、Vite、源码、测试与 SQLite 驱动)。GitHub Actions 自动执行测试、前后端编译、`linux/amd64` 镜像构建并发布到 [`ghcr.io/shnlfriberg/csgofriberg`](https://github.com/shnlfriberg/csgofriberg/pkgs/container/csgofriberg)。

Docker Compose 部署、自动数据库迁移、管理员创建、更新和回滚方法见 [`deploy/README.md`](deploy/README.md)。

### 应用版本

整个网站与服务端共用根目录 `package.json` 的版本号，子包不单独发版。
当前应用版本为 `0.3.9`，对应正式标签 `v0.3.9`。
首页底部显示 `© shnlfriberg 年份 / Currently v版本 / GitHub 图标与 7 位提交号`，
提交号链接到完整 GitHub 提交；正式版本号链接到对应 Release。开发构建带
`-dev+g提交号`，本机未提交的代码改动另带 `.dirty`，不显示 alpha 标记。

`pnpm build` 在开始时固定一份构建信息，前端、服务端与 Docker OCI 标签使用
相同的版本号、完整 Git hash 和 UTC 构建时间。`GET /api/health` 的 `version`
对象提供当前服务端的这些信息，响应禁止缓存；后台“资源版本”中的“应用构建信息”
可按需查看当前页面与服务端的版本。资源更新广播继续使用独立的
`RESOURCE_VERSION` 毫秒时间戳，不用应用版本号代替。

日常推送 `main` 发布 `:main` 与 `:sha-<12 位提交号>` 镜像；正式发布时：

1. 更新根目录 `package.json` 的 `version`（如 `1.0.1`）和 `CHANGELOG.md`，提交代码。
2. 为该提交创建并推送同名 Git 标签 `v1.0.1`。标签必须与根目录版本完全一致。
3. CI 测试通过后发布 `:1.0.1`、`:1.0`、`:latest` 与 SHA 标签；`latest` 仅随正式发布更新。
4. 在 GitHub Release 中记录发布说明；版本、完整提交号和镜像 digest 可从 Actions 摘要获取。

当前仅使用 `X.Y.Z` 正式版本标签；日常开发使用 `main`。生产可通过 `IMAGE`
指定正式版本，准确复现镜像时使用 `ghcr.io/shnlfriberg/csgofriberg@sha256:摘要`。
应用实例、迁移与题库工具使用同一个 `IMAGE`；应用版本不代表线上题库版本。
版本元数据测试为 `pnpm test:version`。

管理员按需外部作弊分析的 Bearer 鉴权与 JSON 展示契约见 [`docs/cheat-analysis-api.md`](docs/cheat-analysis-api.md)。

## 选手数据

选手数据集独立维护在 [**shnlfriberg/csgo-major-db**](https://github.com/shnlfriberg/csgo-major-db):646 名 CS Major 选手的 `players.json`,可直接通过管理后台批量导入,每次提交自动校验格式合法性。数据纠错与新增选手请到该仓库[提交 issue](https://github.com/shnlfriberg/csgo-major-db/issues/new/choose)。

### 外部选手更新 API

管理员可在管理后台的 **API Token** 页生成最长 365 天有效的 Bearer Token。明文只在创建时返回一次，服务端仅保存 SHA-256 哈希；每位管理员最多保留 20 个有效 Token，撤销后立即失效。

外部 API 不需要浏览器 PoW。当前 Token 不区分端点权限，持有者既能提交待审核变更，也能调用直接写入端点，因此只应发放给可信服务。请求统一携带：

```http
Authorization: Bearer csgf_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
Content-Type: application/json
```

当前限流为全局每 IP 600 次/分钟、外部 API 鉴权前每 IP 120 次/分钟、鉴权后每 Token 60 次/分钟。外部 API 的专用限流失效关闭：超过限制返回 `429 RATE_LIMITED`，限流服务异常返回 `503 RATE_LIMIT_UNAVAILABLE`。

可用端点如下：

| 端点 | 当前行为 |
| --- | --- |
| `POST /api/external/player-change-submissions` | 为已有选手提交字段级待审核变更；单次 1-100 名，不会立即修改选手数据 |
| `GET /api/external/players/export` | 导出全部选手及难度成员关系（含 `playerId`），响应为 `players.json`；仅需 API Token，不需要 PoW |
| `POST /api/external/players` | 直接新增单个选手，成功返回 `201 { "id": number }` |
| `PUT /api/external/players/:id` | 按 ID 直接部分更新选手，成功返回 `200 { "ok": true }` |
| `POST /api/external/players/import` | 按昵称直接批量 upsert；单次 1-1000 名且请求内昵称不可重复，返回 `created`/`updated` 数量 |

待审核接口适合外部数据源报送现有选手的纠错。每项使用 `playerId`、`nickname` 或二者定位选手；同时提供时必须指向同一人，同一请求不能重复提交同一选手。`changes` 必须至少包含一个字段：

```bash
curl -X POST 'https://example.com/api/external/player-change-submissions' \
  -H 'Authorization: Bearer csgf_your_token' \
  -H 'Content-Type: application/json' \
  -d '{
    "players": [
      {
        "playerId": 123,
        "changes": {
          "team": "NAVI",
          "age": 27,
          "difficulties": ["normal", "easy"]
        }
      }
    ]
  }'
```

有实际差异时返回 `201 { "submissionId": number, "submitted": number, "unchanged": number }`；所有值均未变化时返回 `200`，其中 `submissionId` 为 `null`。`submitted` 与 `unchanged` 统计的是字段数，不是选手数。管理员在 **选手变更审核** 页逐项批准或拒绝；批准前若该字段已被其他操作改动，该项会标记为 `conflict`，不会覆盖新值。

可写字段为 `nickname`、`nationality`、`region`、`team`、`team_history`、`age`、`role`、`major_championships`、`major_appearances`、`is_active`、`is_enabled`、`difficulties`。其中 `role` 仅接受 `Rifler`、`AWPer`、`Coach`，`difficulties` 当前仅接受 `beginner`、`easy`、`normal`，`team_history` 最多 50 项。

直接写入端点用于受信任的完整同步任务。新增选手至少需要 `nickname`、`nationality` 和 `age`；批量导入应按完整记录提交。更新已有选手时，导入项省略 `difficulties`、`team_history` 或 `is_enabled` 会保留原值，其他带默认值的字段若省略则可能写入默认值。部分更新接口只修改显式传入的字段。

外部 API 不提供永久删除端点；导出端点返回完整选手字段、`playerId` 及难度成员关系。同步源可将 `is_enabled` 设为 `false`，使选手立即退出目标池与猜测列表，同时保留历史对局。所有错误响应均使用 `{ "code": "..." }` 的机器可读格式。

## 项目结构

```
server/src
├── config.ts          # 环境配置
├── db/                # Knex 实例、建表、种子数据
├── middleware/        # 认证、Zod 校验、限流、PoW、错误处理
├── routes/            # auth / players / game / stats / leaderboard / announcements / admin
├── services/          # 游戏判定、选手缓存、房间状态、战绩队列等
└── socket/            # 多人房间系统
client/src
├── api/               # axios 封装、socket 单例、玩家列表缓存
├── store/             # auth / theme / guest 等轻量状态
├── i18n/              # 中 / 英 / 日 文案与错误码翻译
├── components/        # Page / GuessBoard / GuessInputBar / DataTable / admin/*
└── pages/             # Home / SingleGame / MultiLobby / MultiRoom / Stats / ...
```

## 图寻

娱乐模式页底部新增“图寻题目投稿”：玩家和游客都可上传截图并在雷达上标注物体位置，管理员在“图寻管理 → 投稿审核”中指定难度采纳或拒绝删除。图寻生涯统计显示累计采纳数，排行榜新增“图寻圣人榜”。见 [投稿与审核说明](docs/community-submissions.md)。

首页“娱乐模式”提供随机五轮、每日挑战、多人图寻和原海龟汤入口。图寻管理位于管理员后台的同名页签，题目管理的“新增题目”窗口支持拖拽上传、地图 / 楼层选择、getpos 解析、雷达预览、草稿和审核发布。

- [真实素材采集与导入](docs/location-capture.md)
- [本机启动、上传与测试](docs/location-local-testing.md)
- [原始题库保存、ZIP 备份与上线迁移](docs/location-bank-transfer.md)
- [HTTP 和 Socket.IO 接口](docs/location-api.md)
- [共享素材卷、部署、备份与回滚](docs/location-deployment.md)
- [测试结果与待完成项](docs/location-verification.md)
- [雷达资源来源与文件哈希](docs/location-radar-resources.json)

全新安装的题库初始为空。2026-11-04 内容快照（1,234 道题，其中 1,233 道已发布；1,118 份采集草稿；七张开放地图及完整引用图片；保留历史内容版本的 SQLite 内容归档、2,484 个图片文件和 669 人生涯导出）不再存放在 Git 仓库中，需要另行分发后按题库迁移流程导入；快照不含账号、凭据或个人战绩。下载代码或更新镜像不会自动覆盖线上数据库。

## 贡献

- 🐛 [问题反馈 / 功能建议](https://github.com/shnlfriberg/csgofriberg/issues/new/choose) —— 请使用对应的 issue 模板
- 📊 选手数据问题请前往 [csgo-major-db](https://github.com/shnlfriberg/csgo-major-db/issues/new/choose)
- 提交 PR 前请运行 `pnpm test` 与 `pnpm build`;所有用户可见文案需同步维护中/英/日三语(`client/src/i18n/resources.ts`)

## 许可证

本项目基于 [AGPL-3.0](LICENSE) 开源。
