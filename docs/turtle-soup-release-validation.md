# 海龟汤第三阶段发布验收

日期：2026-09-25。接手基线 `9494a18`，功能分支 `feat/turtle-soup`，上游基线 `ad8439894c14a50fd1a40294e46942aa530c99cf`。

第三阶段代码提交：`630e371`（后台快照及两种计数）、`ef0c45a`（隔离生产验收与构建上下文保护）。

上游 [PR #12](https://github.com/shnlfriberg/csgofriberg/pull/12)。首轮 [Linux CI 36065190676](https://github.com/shnlfriberg/csgofriberg/actions/runs/36065190676) 对分支提交 `8ee1958` 的合并测试结果为 `test: success`、`docker: success`，已包含下列生产容器专项；后续文档提交的动态结果见 [PR 检查页](https://github.com/shnlfriberg/csgofriberg/pull/12/checks)。

## 环境与数据保护

- Windows、Node 26.10.0、pnpm 11.13.1、Redis 7.4.3、SQLite；原 `5173/3000/16379` 服务直接复用，没有停启 Redis、重新导入选手或应用 stash。
- 账号/后台串联使用本轮创建的测试身份、数据库副本 `.local-data/stage3-acceptance.sqlite3`、编译后页面 `http://localhost:3002`、独立 Redis 前缀 `csgofriberg-stage3-acceptance:`。仅副本内修改测试选手昵称/年龄。验收结束后只关闭本轮启动的 3002 进程；原前后端和 Redis 保持健康。
- 原库现有 1 个账号、12 条已完成记录、668 条选手的逐行 SHA-256 摘要与接手时相同；选手仍为 646 启用、22 禁用。此数字不是删除其他记录的依据。新增测试身份/匿名记录保留；凭据仅存忽略目录。
- stash `ba48ddc3660812141bfff3c522f498bc764502e5` 保留。没有提交数据库、完整选手数据、凭据、截图、日志、工具或构建缓存。

## 验收结果

| 项目 | 状态 | 实际检查与证据 |
| --- | --- | --- |
| 接手/完整基线 | 通过 | 重新执行 `scripts/local.ps1 -Action test/build`，后端 203/203，前端 160/160；`.local-logs/stage3-baseline-tests.log`、`stage3-baseline-build.log` |
| 必要修复后完整回归 | 通过 | 后端 36 文件、204/204；前端 32 文件、162/162；`stage3-final-tests.log`、`stage3-fix-build.log` |
| 账号登录/登出、归并 | 通过 | 访客赢一局→UI 登录→同一记录归并；普通统计为 0，海龟汤为 1；账号待确认提问→UI 登出→新访客无旧操作且不能读旧账号回放。另用同标签直接登录另一账号验证旧 pending 清除、旧对局 404、没有自动补发提问。`stage3-account.log/json`、`stage3-switch.log/json` |
| 隐藏排名与缓存 | 通过 | 后台 UI 隐藏/恢复测试用户，已缓存海龟汤排行榜立即移除/恢复。`stage3-account.log/json` |
| 个人/后台回放 | 通过 | 同一局个人和后台回放答案及事件一致；副本选手改名/改年龄后，列表和回放均保留快照；事件正序。`stage3-personal-replay.png`、`stage3-admin-replay.png`；新增后端回归同时覆盖后台访客列表 |
| 次数/胜负/退出 | 通过 | Chrome 实际接口：猜错锁定、第 18 问保留最后猜名、猜错失败、猜中、0 问认输记负、退出不记账；获胜提问数与猜名数分别验证。`stage3-flow.log` |
| 弱网与并发基本流程 | 通过 | 请求未送达、服务端接受但响应丢失、终局响应丢失、刷新恢复、两个标签同版本写入返回 200/409 且只扣一次。`stage3-flow.log`；单测覆盖同 UUID 不同内容和过期版本拒绝 |
| 持续双标签弱网 | 通过（12 分 32 秒） | Chrome 两标签，UTC 21:43:31.845–21:56:03.430，5 轮实际同版本并发、延迟后响应丢失、未送达后刷新恢复，最终正好 15 次提问。未送达重试保留 ID/版本/正文；已接受的丢失响应可通过读取事件确认，无需再次写入。`stage3-soak.log/json`。此结果不代替数小时压力、系统挂起或真实移动网络切换 |
| 真实 30 分钟过期 | 通过（30 分 7 秒） | Edge 两标签，独立访客局，从真实 `lastActiveAt` 计时；UTC 21:31:45.584–22:01:52.970，33 次只读检查，TTL 从 1799 秒降至 33 秒；到期后 HTTP 404，两标签均显示过期、禁止提问并要求明确重新开始。未更改 TTL 或服务器时钟。`stage3-expiry.log/json`、`stage3-expiry.png` |
| 视觉回归 | 通过 | Chrome：1920×1080/960/900、1440×900、390×844 × 双主题 × 三语共 30 组；另 18 组连续提问记录检查，主内容高度不增加、外层不跳动、内部滚动、结算置顶。`stage3-layout.log`、`stage3-history.log`、`stage3-compact-*.png`、`stage3-history-*.png`；实际查看桌面日文 blast、手机中文 light 和回放截图 |
| 桌面跨浏览器 | 部分通过 | Edge 150.0.4078.48 与 Chrome 154.0.8037.57 独立无界面真实浏览器；两者同为 Chromium，不能据此认定 Firefox/WebKit/Safari 通过 |
| 真机 Android/输入法/软键盘 | 未验证，用户暂缓 | 用户有真机及模拟器。Windows 识别 USB 调试接口，但现有 ADB 36.0.0 在原服务及独立服务均没有设备；重新插拔并启用文件传输后仍不可用。用户暂不方便改用同一 Wi-Fi，明确要求先记未验证。未安装/更换驱动；自动化触控/视口压缩/合成 composition 测试不等于原生输入法 |
| iOS Safari、无障碍设备 | 未验证 | 无设备通道 |
| PostgreSQL 迁移/镜像启动 | 通过（Linux CI） | Ubuntu runner 实际构建 Linux/amd64 生产镜像，PostgreSQL 17-alpine + Redis 7.4-alpine；空库迁移、含旧 classic 记录的升级、重复迁移后原胜负/猜测数保留，nonroot/只读镜像启动及真实结算通过。CI 36065190676 的 `Verify isolated PostgreSQL migrations and production runtime` 步骤 |
| 生产 PoW/Cookie/代理头/缓存 | 通过（隔离环境范围） | 实际 PoW 求解、Secure/HttpOnly/SameSite Cookie 属性、代理 IP 绑定、非许可 Origin 拒绝、SPA 深链、资源 immutable/HTML no-cache、缺失资源 404，以及真实登录、归并、登出令牌失效通过。代理部分为请求头和配置兼容，未部署真实 TLS/边缘代理；CI 同上 |
| 真实边缘代理/HTTPS/GeeTest/SMTP | 未验证 | 隔离脚本不连接验证码或邮件外部服务，不绕过注册认证；需维护者在预发布环境另验 |
| PR / CI | 已创建，首轮全部通过 | 用户确认使用账号 `SHISGAY114514`，只向其 fork 的 `feat/turtle-soup` 推送；上游 PR #12 可合并且无冲突，首轮 `test/docker` 皆成功。没有向上游 main 推送、合并、部署、发布镜像或标签 |

## 修复范围

后台用户与访客单人记录列表此前从当前选手表读取昵称，与海龟汤快照回放可能不一致。现在海龟汤列表使用 `answer_snapshot.nickname`，返回 `questionCount`，前端显示玩法并分别标注提问数和猜名数；普通玩法保持原语义。后端新增改名后两个列表及管理员回放的回归，前端新增两种身份列表的计数标注检查。

`.dockerignore` 增加 `.local-*`，防止本地工具、账号凭据与数据库副本被送进 Docker 构建上下文。

## 隔离生产验收入口

PR 的 Docker 作业将构建结果加载到 runner，运行：

```bash
bash scripts/verify-production.sh LOCAL_IMAGE_TAG
```

脚本只创建带独立名称的容器/网络，PostgreSQL 使用临时内存卷、不映射宿主端口、不挂载生产配置。随机测试密钥写临时文件并在退出时删除；只清理本次命名资源，不执行 Redis FLUSH。验收流程：

1. 空 PostgreSQL 迁移；在隔离库构造缺少新列的旧 classic 记录；重复迁移并核对原胜负/猜测次数。
2. 以 nonroot、只读文件系统实际启动生产镜像；检查健康、SPA 深链、带 hash 资源缓存及缺失资源 404。
3. 保留实际 PoW 和身份中间件，求解挑战、接收安全 Cookie，检查代理 IP 绑定及 Origin 拒绝。
4. 完成海龟汤提问/幂等/409/胜局/统计/改名后快照回放，再检查真实登录、访客归并、登出令牌失效。

脚本本机完成 Node/Bash 语法检查后，已在上述 Linux CI 实际运行并全部通过；本地保留日志 `.local-logs/stage3-ci-36065190676.log`。GeeTest 参数使用隔离占位值；不调用注册/验证码/邮件，因此不证明外部服务或真实 TLS 边缘部署可用。安全 Cookie 属性通过 HTTP 请求检查，不等于真机浏览器 HTTPS Cookie 传输验收。PR 事件仍为 `push: false`，没有新增手动发布触发。

PR 本地加载的镜像关闭 attestations，以兼容 runner 的 classic image store；原发布分支的 provenance/SBOM 继续保留。该限制依据 [Docker attestations 文档](https://docs.docker.com/build/metadata/attestations/)。

## 迁移与回退注意

新列 `games.question_count/soup_events/answer_snapshot` 为增量迁移；`variant` 继续区分 classic 和 turtle-soup，旧记录仍为 classic。生产必须先备份 PostgreSQL，并在应用启动前运行迁移；本任务没有执行生产迁移。

回退应用前先评估旧版本对已有海龟汤记录的处理，不能直接删列或将海龟汤记录重写为 classic。已保存的答案/事件快照应保留。部署由维护者合并后另行安排。
