<div align="center">

# 弗一把 (csgofriberg)

**CS:GO / CS2 Major 选手猜测游戏 —— 类 Wordle 玩法 + 实时多人对战**

[![CI and Docker](https://github.com/shnlfriberg/csgofriberg/actions/workflows/docker.yml/badge.svg)](https://github.com/shnlfriberg/csgofriberg/actions/workflows/docker.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![Node.js ≥ 22](https://img.shields.io/badge/node-%E2%89%A522-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
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

**环境要求**:Node.js ≥ 22、pnpm、Redis(本地开发可降级为内存模式)；SQLite 开箱即用,无需额外数据库。Rust 工具链可选——仅在需要重新编译 PoW WASM 时安装,默认使用仓库内置的预编译产物。

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

管理员按需外部作弊分析的 Bearer 鉴权与 JSON 展示契约见 [`docs/cheat-analysis-api.md`](docs/cheat-analysis-api.md)。

## 选手数据

选手数据集独立维护在 [**shnlfriberg/csgo-major-db**](https://github.com/shnlfriberg/csgo-major-db):646 名 CS Major 选手的 `players.json`,可直接通过管理后台批量导入,每次提交自动校验格式合法性。数据纠错与新增选手请到该仓库[提交 issue](https://github.com/shnlfriberg/csgo-major-db/issues/new/choose)。

### 外部选手更新 API

管理员可在管理后台的 **API Token** 页生成最长 365 天有效的 Bearer Token。明文只在创建时返回一次，服务端仅保存 SHA-256 哈希；每位管理员最多保留 20 个有效 Token，撤销后立即失效。

外部 API 不需要浏览器 PoW，但保留全局限流与独立的失效关闭限流。请求统一携带：

```http
Authorization: Bearer csgf_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
Content-Type: application/json
```

可用端点：

- `POST /api/external/players`：新增单个选手，body 与管理后台新增选手格式相同。
- `PUT /api/external/players/:id`：部分更新选手，只传需要修改的字段。
- `POST /api/external/players/import`：按昵称批量 upsert，body 为 `{ "players": [...] }`，单次最多 1000 名。

示例：

```bash
curl -X PUT 'https://example.com/api/external/players/123' \
  -H 'Authorization: Bearer csgf_your_token' \
  -H 'Content-Type: application/json' \
  -d '{"team":"NAVI","age":27,"difficulties":["normal","easy"]}'
```

外部 API 不提供永久删除；同步源可将 `is_enabled` 设为 `false`，使选手立即退出目标池与猜测列表，同时保留历史对局。

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

## 贡献

- 🐛 [问题反馈 / 功能建议](https://github.com/shnlfriberg/csgofriberg/issues/new/choose) —— 请使用对应的 issue 模板
- 📊 选手数据问题请前往 [csgo-major-db](https://github.com/shnlfriberg/csgo-major-db/issues/new/choose)
- 提交 PR 前请运行 `pnpm test` 与 `pnpm build`;所有用户可见文案需同步维护中/英/日三语(`client/src/i18n/resources.ts`)

## 许可证

本项目基于 [AGPL-3.0](LICENSE) 开源。
