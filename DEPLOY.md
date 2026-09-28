# BFF 部署指南

把 `bff/` 部署到 Cloudflare Workers（免费版），然后让 App 接入、打开推送，最后（可选）开启管理界面。
命令按 Windows PowerShell 写，在仓库根目录 `C:\Project\PANext` 下执行。

整个过程分五步，前三步必做，后两步按需：

| 步骤 | 做什么 | 做完能用什么 |
|---|---|---|
| 1 | 部署 Worker | 服务端开始按日程抓取数据 |
| 2 | App 认领服务器 | App 从服务器读数据、设置在服务器上同步 |
| 3 | 上传第三方 Key | 路况、皇马数据 |
| 4 | Firebase 推送 | 四类通知由服务器准点发送 |
| 5 | 管理界面（可选） | 浏览器里看状态、管设备、改设置 |

> Cloudflare / Firebase 控制台的菜单名称会随改版变化，下面写的是 2026 年 9 月的叫法；找不到时按意思找相近的入口。

---

## 0. 准备

- Cloudflare 账号（免费版即可）
- Node.js 24 与 pnpm（`node --version`、`pnpm --version` 能输出版本号）
- 安装依赖并登录 Cloudflare（会打开浏览器授权）：

```powershell
pnpm -C bff install
pnpm -C bff exec wrangler login
```

---

## 1. 部署 Worker

### 1.0 一键部署（可选，更快）

公开仓库 README 里有一个按钮：

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/lonemoonspace/PANext-BFF/tree/main/bff)

点它，按提示登录 Cloudflare、授权 GitHub 后，它会：

- 把 `bff/` 子目录部署为一个新 Worker
- 按 `bff/wrangler.jsonc` 自动创建同名 D1 数据库并回填 `database_id`
- 跑一次 `pnpm run deploy`（已改成「先建表 / 迁移，再部署」，见下面 1.3）

**按钮做不到的事，仍要手动补：**

- 两个机密（`MASTER_KEY`、`CLAIM_CODE`）：按钮不会提示填写机密，跳到下面 1.2 用 `wrangler secret put` 补上，然后在 Cloudflare 控制台该 Worker 的「部署」页重新触发一次部署（或本机跑 `pnpm -C bff run deploy`），机密和迁移才会生效
- 部署完成后仍要走本文档「2. App 认领服务器」认领、按需走「5. 管理界面」配 Access

不想用按钮，跳过本节，从 1.1 开始手动走同样能完成部署。

### 1.1 建数据库

```powershell
pnpm -C bff exec wrangler d1 create pa-bff
```

输出里有一行 `"database_id": "xxxxxxxx-...."`。把它填进 `bff/wrangler.jsonc`，替换全 0 的占位符：

```jsonc
"database_id": "<上一步输出的 id>",
```

database_id 不是机密，可以提交到私人仓库，省得每次部署前重填。

### 1.2 设置两个机密

**MASTER_KEY**：加密所有第三方 Key 和推送令牌用的主密钥。先生成一个：

```powershell
$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Fill($b); [Convert]::ToBase64String($b)
```

把输出**存进密码管理器**，然后：

```powershell
pnpm -C bff exec wrangler secret put MASTER_KEY
```

按提示粘贴。

> ⚠️ MASTER_KEY 丢了或换了，服务器上已保存的所有 Key 和推送令牌都会变成「无法解密」，需要逐个重新填写、所有设备重新打开 App 上传推送令牌。不要随手更换。

**CLAIM_CODE**：第一台设备「认领」服务器时要输入的口令，至少 12 个字符。生成一个：

```powershell
-join ((48..57) + (65..90) | Get-Random -Count 16 | ForEach-Object { [char]$_ })
```

同样记下来，然后：

```powershell
pnpm -C bff exec wrangler secret put CLAIM_CODE
```

认领成功后这个口令就不再起作用（服务器只能被认领一次）；之后加设备用配对码。

### 1.3 建表并部署

```powershell
pnpm -C bff run deploy
```

这一条命令做两件事：先对远程 D1 跑一遍迁移（建表，幂等），再部署 Worker。

> 注意是 `pnpm -C bff run deploy`，**不是** `pnpm deploy`——后者是 pnpm 自带的另一个命令。

部署成功会输出地址，形如 `https://pa-bff.<你的子域>.workers.dev`。每分钟一次的定时任务（Cron）随部署自动生效。

### 1.4 检查

浏览器打开 `https://pa-bff.<你的子域>.workers.dev/healthz`：

- 刚部署时 `{"ok":true,"lastTickAt":null}`
- 一两分钟后 `lastTickAt` 变成一个时间，说明定时任务在跑

`lastTickAt` 一直是 null：到 Cloudflare 控制台 → Workers → pa-bff → 设置 → 触发器，确认有 `* * * * *` 的 Cron 触发器。

### 1.5（可选）外部心跳

想在服务器停摆时收到提醒，可以在 [healthchecks.io](https://healthchecks.io) 之类的服务建一个检查（周期 1 分钟、宽限 5 分钟），把它给的 ping 地址设为：

```powershell
pnpm -C bff exec wrangler secret put HEALTHCHECK_URL
```

---

## 2. App 认领服务器

1. 用 PANext 的 App（包名 `com.panext.app`）打开「设置 → 服务器」
2. 在「认领」一栏填：服务器地址（第 1.3 步的 `https://…workers.dev`，不要带路径）、CLAIM_CODE、设备名
3. 点「认领」

认领成功后：

- 这台设备成为 **owner**（可以改设置、管 Key、管设备）
- App 会把本机的通勤设置上传到服务器（服务器还是默认值时），并把本机填过的 Google Maps Key、football-data Key 上传；**服务器确认保存后才会删除本机那份**
- 之后首页、皇马页的数据都来自服务器；服务器暂时连不上时自动改为手机直连，首页顶部会有提示

**加第二台设备（家人手机等）**：owner 设备在「设置 → 服务器」点「生成配对码」→「分享」，把链接发给对方；对方点开链接，确认服务器地址后点「加入」。配对码 10 分钟内有效、只能用一次，加入的设备是只读的 **viewer**。

---

## 3. 第三方 Key

第 2 步的自动上传已经处理了本机填过的 Key。要新填或更换：owner 设备「设置 → 服务器 → 密钥」，每个 Key 保存后服务器会立刻测一次，显示 ✅ 或失败原因。

| Key | 用途 | 没有它会怎样 |
|---|---|---|
| `google_routes` | 驾车路况（Google Routes API） | 路况卡片显示「服务器上未配置」 |
| `football_data` | 皇马赛程、积分榜（football-data.org 免费 Key） | 皇马页显示「服务器上未配置」 |

天气、火车、公交不需要 Key。

---

## 4. Firebase 推送

服务器用 Firebase Cloud Messaging 把通知推到手机。需要同一个 Firebase 项目里的两样东西：App 的配置（编进 APK）和服务账号（上传到服务器）。

### 4.1 Firebase 项目

1. [Firebase 控制台](https://console.firebase.google.com) 建一个项目（或用已有的）
2. 在 [Google Cloud 控制台](https://console.cloud.google.com) 选中同一个项目，「API 和服务 → 库」里搜索并启用 **Firebase Cloud Messaging API**（V1）

### 4.2 App 配置 → `local.properties`

1. Firebase 控制台 → 项目设置 → 常规 → 您的应用 → 添加应用 → Android，包名填 **`com.panext.app`**（必须与 `app/build.gradle.kts` 的 applicationId 一致）
2. 下载 `google-services.json`（**不要**放进仓库；本项目不用 google-services 插件，只从里面抄四个值）
3. 在仓库根目录的 `local.properties`（没有就新建，它不入库）里加四行：

| 键 | 从 `google-services.json` 的哪里取 |
|---|---|
| `firebase.project.id` | `project_info.project_id` |
| `firebase.sender.id` | `project_info.project_number` |
| `firebase.app.id` | `client[0].client_info.mobilesdk_app_id` |
| `firebase.api.key` | `client[0].api_key[0].current_key` |

键名模板见 `local.properties.example`。四个值缺任何一个，App 会整体关闭推送（设置页有提示）。

4. 重新构建并安装 App（签名见根目录 README「签名 Release 构建」；调试用 `.\gradlew.bat installDebug` 也行）

### 4.3 服务账号 → 服务器

1. Firebase 控制台 → 项目设置 → 服务账号 → 生成新的私钥，下载 JSON
2. 放在仓库目录**之外**（例如 `C:\Users\<你>\keys\`），不要提交、不要发给任何人
3. owner 设备「设置 → 服务器 → FCM 服务账号」→ 选择这个 JSON 文件上传，确认显示 ✅「已取得 FCM 访问令牌」
4. 上传成功后，这个 JSON 文件可以删掉（服务器已加密保存；需要时再生成一把新的）

> 服务账号 JSON 里的 `project_id` 必须与 4.2 的 `firebase.project.id` 相同，否则推送会失败（原因显示 `sender_mismatch`）。

### 4.4 测试

1. 确认手机已允许 App 发通知
2. 「设置 → 服务器」点「发送测试推送（本机）」，应收到「测试推送」通知
3. 再分别在**锁屏**、**从最近任务里划掉 App** 两种状态下各试一次

四类通知（列车异常、早间简报、皇马、车票到期）的开关仍在 App 的通勤设置里，打开后由服务器判定并推送；接入服务器后手机本身不再发这四类通知，不会重复。

---

## 5. 管理界面（可选）

浏览器里的 `/admin`：总览（调度与数据源状态、「立即运行」）、设备、日志、推送记录与测试推送、设置表单、密钥、设置导出导入。

它**只在配置了 Cloudflare Access 之后才开启**，并且要校验 Access 签发的登录凭证。前提是你有一个托管在 Cloudflare 上的**自己的域名**。

> ⚠️ 不要用 Worker 设置里 workers.dev 那个「一键启用 Access」开关：它会保护整个域名，App 的 `/v1` 接口也会被挡住，所有设备立刻连不上。Access 只能覆盖 `/admin` 这个路径。

### 5.1 给 Worker 绑自己的域名

Cloudflare 控制台 → Workers → pa-bff → 设置 → 域和路由 → 添加 → 自定义域，例如 `bff.example.com`。

之后 App 可以继续用 workers.dev 地址，也可以改用新域名（改地址需要重新认领或配对）。

### 5.2 建 Access 应用

Cloudflare 控制台 → Zero Trust → Access → 应用程序 → 添加 → 自托管：

- 应用域名：`bff.example.com`，**路径**：`admin`
- 策略：动作「允许」，规则「电子邮件」等于你自己的邮箱
- 保存后在应用的「概述」里复制 **应用程序受众（AUD）标记**
- 团队域名在 Zero Trust → 设置 → 自定义页面（或「团队域」）里，形如 `<团队名>.cloudflareaccess.com`

### 5.3 告诉 Worker

```powershell
pnpm -C bff exec wrangler secret put ACCESS_TEAM_DOMAIN
pnpm -C bff exec wrangler secret put ACCESS_AUD
```

分别填 `<团队名>.cloudflareaccess.com`（不带 https://）和 AUD 标记。这两个值并不机密，用 `secret put` 只是为了以后重新部署时不会被覆盖掉。

### 5.4 打开

浏览器访问 `https://bff.example.com/admin/`，先经过 Access 登录（邮箱验证码），然后进入管理界面，右上角显示「已登录：<你的邮箱>」。

- 没配这两个值时，`/admin` 只显示一页「管理界面尚未启用」的说明
- 通过 workers.dev 地址访问 `/admin` 会被拒绝（那里没有 Access），这是预期行为

---

## 日常维护

**更新服务端**（拉了新代码之后）：

```powershell
pnpm -C bff install
pnpm -C bff run db:migrate:remote
pnpm -C bff run deploy
```

迁移是幂等的，没有新迁移时什么也不做。

**看日志**：管理界面「日志」页；或实时看 Worker 输出：

```powershell
pnpm -C bff exec wrangler tail
```

**移除设备**：owner 设备「设置 → 服务器」的设备列表，或管理界面「设备」页。不能移除 / 降级最后一个 owner。

## 常见问题

| 现象 | 原因与处理 |
|---|---|
| 认领时提示「服务器没有设置 CLAIM_CODE」 | CLAIM_CODE 没设或短于 12 个字符，回到 1.2 |
| 认领时提示「该服务器已被认领」 | 服务器只能认领一次；向已有的 owner 要配对码 |
| 认领时提示「尝试次数过多」 | 连续输错 5 次，15 分钟后再试 |
| `/healthz` 的 `lastTickAt` 一直为 null | Cron 触发器没生效，见 1.4 |
| 首页顶部「服务器暂时不可达，本次改为直连」 | 手机连不上服务器；数据改由手机直连，通知仍由服务器发 |
| 密钥状态显示「无法解密」 | MASTER_KEY 被换过；在密钥页重新填写 |
| 测试推送提示「本机还没有推送令牌」 | 这个 APK 没有配置 Firebase（4.2），或没有通知权限 |
| 测试推送结果 `sender_mismatch` | 服务账号与 App 不是同一个 Firebase 项目 |
| 测试推送结果 `fcm_auth_failed` | 服务账号 JSON 无效或已在 Google Cloud 里被删除；重新生成上传 |
| `/admin` 显示「管理界面尚未启用」 | 5.3 的两个值没设 |
| `/admin` 显示「需要通过 Cloudflare Access 登录」 | 访问的地址没有经过 Access（例如用了 workers.dev 地址），或 Access 应用的路径没覆盖 `/admin` |

## 费用

个人使用在 Cloudflare Workers 免费版额度内：每分钟一次定时任务（每天约 1440 次调用）、D1 读写与每天几十次 App 请求都远低于免费上限。Firebase Cloud Messaging 免费。Google Routes API 与 football-data.org 按各自的免费额度计。
