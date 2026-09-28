# BFF 契约（G1 冻结）

> 修改本文件、`bff/src/contract/**`、`contracts/**` 必须经过 Opus 关口（见 `docs/BFF_PLAN.md`）。
> 实现者发现契约有问题：停下来，在汇报里写明，不要自行修改。

## 0. 范围

v1 = **把 Android v5 现有的通勤 / 皇马数据刷新与四类通知搬到服务端**，行为与 App 一致。
不含：新闻（Cloudflare 免费版 CPU 限额，留在手机上）、WatchedLine 通用线路配置（留给纯客户端重写）。

## 1. 环境变量与机密（Worker）

| 名称 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `MASTER_KEY` | secret | 是 | base64 编码的 32 字节随机数。AES-GCM 主密钥 |
| `CLAIM_CODE` | secret | 是 | 认领码，长度 ≥ 12。未设置时 `/v1/claim` 返回 503 `not_configured` |
| `ACCESS_TEAM_DOMAIN` | var | 否 | 例 `yourteam.cloudflareaccess.com`。与 `ACCESS_AUD` 同时设置才开启管理界面 |
| `ACCESS_AUD` | var | 否 | Access 应用的 AUD tag |
| `HEALTHCHECK_URL` | secret | 否 | 每次 tick 结束后 GET 一次（healthchecks.io 之类） |
| `DB` | D1 binding | 是 | 数据库 |
| `ASSETS` | 静态资源 binding | 是 | 管理界面的静态文件（`bff/admin-ui/public/`）。**只经 Worker 取用**（`run_worker_first` 覆盖 `/admin*`），不直接对外 |
| `ADMIN_DEV_BYPASS` | var | 否 | 仅本地开发：值为 `"1"` **且**请求主机名是 `localhost` / `127.0.0.1` 时跳过 Access 校验，身份记为 `dev@localhost`。其余任何情况都不生效；`wrangler.jsonc` 里不得设置它（只放 `.dev.vars`） |

出站请求头：Entur `ET-Client-Name: personal-assistant-bff`；MET `User-Agent: personal-assistant-bff/1.0 (cloudflare-worker, personal use)`。

## 2. 鉴权

- **设备令牌**：`pa_` + 32 字节随机数的 base64url。请求头 `Authorization: Bearer <token>`。数据库只存 `sha256(token)` 的 hex。
- **角色**：`owner`（认领得到，可写设置 / 密钥 / 设备）与 `viewer`（配对得到，只读）。
- **认领**：只在 `meta.claimed_at` 为空时可用。先校验认领码，认领码正确后才校验 `deviceName`（名字不合法返回 422 `invalid_device_name`，不计入失败次数）。比较 `sha256(输入)` 与 `sha256(CLAIM_CODE)`，用 `crypto.subtle.timingSafeEqual`。`CLAIM_CODE` 缺失或长度 < 12 一律视为未配置（503）。**比较之前**先用一条 SQL 原子地占用一次尝试（`INSERT ... ON CONFLICT DO UPDATE ... RETURNING`，窗口判断写在同一条语句里）：15 分钟窗口内第 6 次起返回 429 并锁定 15 分钟；认领成功后清零。认领在一个 D1 batch 里完成：条件写入 `meta.claimed_at` 与 `meta.claimed_by = <新设备 id>`（条件 `IS NULL`），设备插入语句以 `(SELECT value FROM meta WHERE key='claimed_by') = <新设备 id>` 为条件；**不得依赖 `changes()`**。设备未插入则返回 409。
- **配对码**：owner 生成，8 位 Crockford base32，10 分钟有效，单次使用，存哈希。兑换时先规范化输入（转大写，I/L→1，O→0，去掉空格和连字符）。核销用条件 UPDATE 写入唯一的 `used_at`，设备插入以该行已被本次核销为条件（同样不依赖 `changes()`）。
- **吊销**：`devices.revoked_at` 非空即拒绝（401 `revoked`）。
- **管理界面**：只在配置了 Access 时开启。必须用 `https://<ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs` 的 JWKS 校验 `Cf-Access-Jwt-Assertion` 的签名、`aud`、`exp`；**不得**只检查请求头存在。未配置时 `/admin*` 返回说明页，`/admin/api/*` 返回 404。（[gate] P7 细化如下）
  - JWT：只接受 `alg = RS256`，按头里的 `kid` 在 JWKS 里找公钥（WebCrypto `RSASSA-PKCS1-v1_5` + SHA-256）；`iss` 必须等于 `https://<ACCESS_TEAM_DOMAIN>`；`aud` 为字符串或数组，须包含 `ACCESS_AUD`；`exp > now`、`nbf`（有则）`≤ now`，均允许 60 秒时钟误差；`email` 为非空字符串。任何一项不满足 → `/admin/api/*` 返回 401 `access_denied`，页面返回 403 纯文本。错误消息不回显 JWT
  - JWKS：isolate 内存缓存 10 分钟；遇到缓存里没有的 `kid` 时最多立即重取一次（应对轮换）；取 JWKS 失败 → 503 `access_unavailable`（不放行）
  - 只认请求头 `Cf-Access-Jwt-Assertion`，不读 `CF_Authorization` cookie
  - CSRF：Access 的 cookie 会随跨站请求带上，边缘会替它补上 JWT 头，所以**签名有效不代表是本站发起的**。`/admin/api/*` 的非 GET 请求必须同时满足：`X-PA-Admin: 1` 请求头存在；`Origin` 头存在且等于请求 URL 的 origin。否则 403 `csrf_rejected`。不设置任何 CORS 响应头
  - 响应头：`/admin*` 页面带 `Content-Security-Policy: default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`Cache-Control: no-store`；`/admin/api/*` 带后三个。管理界面不得使用内联脚本或内联事件处理器
  - 审计身份：管理员的写操作以 `admin:<email>` 作为操作者（例如 `settings.updated_by`、`pair_codes.created_by`）

## 3. App 接口（`/v1`）

所有响应 `Content-Type: application/json`（JSON 按规范即 UTF-8，不强制 charset 参数）。未捕获的异常也必须输出下面的错误格式（500 `internal_error`，消息里不得包含机密）。错误统一为：

```json
{ "error": { "code": "snake_case_code", "message": "给人看的中文说明" } }
```

| 方法 路径 | 角色 | 请求 | 成功响应 | 错误 |
|---|---|---|---|---|
| `POST /v1/claim` | 无（认领码） | `{ "claimCode": string, "deviceName": string(1..40) }` | 201 `{ deviceId, token, role: "owner" }` | 401 `bad_claim_code`，409 `already_claimed`，429 `locked`，503 `not_configured` |
| `POST /v1/pair/redeem` | 无（配对码） | `{ "code": string, "deviceName": string }` | 201 `{ deviceId, token, role: "viewer" }` | 401 `bad_pair_code`（含过期、已用） |
| `POST /v1/devices/pair-codes` | owner | — | 201 `{ code, expiresAt }` | |
| `GET /v1/devices` | owner | — | 200 `{ devices: [{ id, name, role, createdAt, lastSeenAt, hasPushToken, self }] }` | |
| `DELETE /v1/devices/:id` | owner | — | 204（同时作废该设备生成的未使用配对码） | 404，409 `last_owner`（不能删除最后一个有效 owner） |
| `PATCH /v1/devices/:id` | owner | `{ role }` | 200 设备对象 | 409 `last_owner`（不能降级最后一个有效 owner；判断必须写在 UPDATE 条件里，保证并发安全） |
| `PUT /v1/devices/me/push-token` | 任意 | `{ "token": string }` | 204 | |
| `GET /v1/settings` | 任意 | — | 200 `{ revision, settings, updatedAt }`，头 `ETag: "r<revision>"` | |
| `PUT /v1/settings` | owner | 头 `If-Match: "r<revision>"`，体 `{ settings }`（完整对象） | 200 `{ revision, settings, updatedAt }` | 428 `precondition_required`，409 `revision_conflict`（体里带 `current: { revision, settings, updatedAt }`），422 `invalid_settings`（体里带 `issues`） |
| `GET /v1/secrets` | owner | — | 200 `{ secrets: [SecretStatus] }` | |
| `PUT /v1/secrets/:name` | owner | `{ "value": string }` | 200 `SecretStatus`（保存后立刻做一次真实测试） | 404 未知 name，422 `invalid_value` |
| `DELETE /v1/secrets/:name` | owner | — | 204 | |
| `POST /v1/secrets/:name/test` | owner | — | 200 `SecretStatus` | |
| `GET /v1/dashboard` | 任意 | 可带 `If-None-Match` | 200 `Dashboard`（见 `src/contract/dashboard.ts`），头 `ETag`；或 304 | |
| `POST /v1/refresh` | owner | `{ "sources"?: SourceKey[] }` | 202 `{ queued: SourceKey[] }` | 429 `too_soon`（每分钟最多一次） |
| `GET /v1/stops/search?q=` | 任意 | q 长度 2..60 | 200 `{ stops: [{ id, name, locality }] }` | |
| `GET /v1/lines?stopA=&stopB=` | 任意 | 两个 `NSR:StopPlace:<数字>`（[gate] P9） | 200 `LinesResponse`（见 `src/contract/lines.ts`，第 9 节） | 422 `invalid_request`，502 `upstream_error`（Entur 失败） |
| `POST /v1/push/test` | owner | `{ "scope"?: "self" \| "all" }`（默认 self） | 200 `{ deviceCount, result: PushLogResult }`（FCM 失败也是 200，看 `result`；见 `src/contract/push.ts`） | 409 `no_push_token`（没有可发送的设备），503 `fcm_not_configured`（服务账号缺失、无法解密或字段不全），429 `too_soon`（30 秒内最多一次），422 `invalid_request` |
| `GET /healthz` | 无 | — | 200 `{ ok: true, lastTickAt }` | |

`SecretStatus = { name, state: "missing" | "present" | "unreadable", hint: string | null, lastTest: { ok: boolean, at: string, message: string } | null }`。
`hint` 为明文末 4 位前加 `···`；`unreadable` 表示解密失败（例如 MASTER_KEY 被换）。**任何接口都不返回明文或密文。**

`GET /v1/dashboard` 的 ETag：对 `DashboardSchema.parse` 之后、**去掉 `generatedAt`** 的对象做 `JSON.stringify`（键序以 schema 为准），取 SHA-256 的前 16 位 hex，加双引号，作为强 ETag。`settingsRevision`、`window` 或任一来源信封的 `state / fetchedAt / observedAt / error / data` 变化都必须改变 ETag；只有 `generatedAt` 不同视为未变化。`If-None-Match` 按 RFC 9110 解析（逗号分隔列表，比较时忽略 `W/` 前缀，`*` 匹配任意值）；命中时返回 304，带同一个 ETag，无响应体。

来源信封的不变式：`state = "not_configured"` 时 `data` 与 `error` 均为 null；`state = "ok"` 时 `error` 为 null。
每次通过鉴权的请求更新 `devices.last_seen_at`（同一设备 5 分钟内最多写一次，节省 D1 写入）。

## 4. D1 表

所有时间列为 ISO-8601 UTC 字符串（`...Z`），便于字典序比较。

```
meta            key TEXT PK, value TEXT
                -- claimed_at / claimed_by / claim_fail_count / claim_fail_window_start / claim_locked_until / last_tick_at
                -- refresh_last_at / push_test_at
settings        id INTEGER PK CHECK(id = 1), json TEXT, revision INTEGER, updated_at TEXT, updated_by TEXT
secrets         name TEXT PK, ciphertext TEXT, iv TEXT, hint TEXT, last_test_json TEXT, updated_at TEXT
devices         id TEXT PK, name TEXT, role TEXT, token_hash TEXT UNIQUE, push_token_ct TEXT, push_token_iv TEXT,
                created_at TEXT, last_seen_at TEXT, revoked_at TEXT
pair_codes      code_hash TEXT PK, expires_at TEXT, used_at TEXT, created_by TEXT
jobs            name TEXT PK, next_run_at TEXT, lease_until TEXT, last_run_at TEXT, last_status TEXT,
                last_duration_ms INTEGER, fail_count INTEGER DEFAULT 0
snapshots       source TEXT PK, json TEXT, state TEXT, fetched_at TEXT, observed_at TEXT, error_json TEXT,
                etag TEXT, last_modified TEXT, config_key TEXT
notify_state    policy TEXT PK, state_json TEXT, version INTEGER
push_log        id INTEGER PK AUTOINCREMENT, at TEXT, policy TEXT, title TEXT, body TEXT, device_count INTEGER, result TEXT
logs            id INTEGER PK AUTOINCREMENT, at TEXT, level TEXT, source TEXT, message TEXT
rate_buckets    name TEXT PK, tokens REAL, updated_at TEXT
```

`snapshots.config_key`：生成该快照时所用设置的指纹（例如火车用 `originStation|destStation`）。设置变化后指纹不匹配的快照视为不存在，避免显示另一条路线的缓存。

## 5. 调度

Cron 每分钟触发一次 `tick()`：

1. 取 `next_run_at <= now` 且租约已过期的任务，按 `next_run_at` 升序最多 4 个（首次运行或新增任务时用 `INSERT OR IGNORE` 补齐 jobs 行）；
2. 每个任务开始前**重新读取时钟**，用一条语句抢租约并预扣一次失败：
   `UPDATE jobs SET lease_until = now+120s, last_status = 'running', fail_count = fail_count+1, next_run_at = now+backoff(fail_count+1) WHERE name=? AND next_run_at <= now AND (lease_until IS NULL OR lease_until < now) RETURNING ...`，影响 0 行就跳过。这样即使 Worker 在执行中被杀，失败次数与退避也已经落库；
3. 执行处理器，超时 60 秒（`AbortSignal`，必须小于租约）。处理器可返回 `CadenceCtx`（例如 weather 的 `Expires`、football 的比赛时刻），供下一步计算间隔；
4. 成功：`fail_count = 0`，`next_run_at` = 按下表计算，释放租约；失败：保留第 2 步预扣的结果，只写 `last_status`、`last_duration_ms`，释放租约。**两种写回都以 `lease_until = <本次写入的值>` 为条件**，影响 0 行说明租约已被别的执行接管，只记日志不写回；
5. 退避：`backoff(n) = min(2^n, 30)` 分钟（2、4、8、16、30、30 …），与任务的正常间隔无关；
6. 每个任务单独 try/catch，一个任务或其写回失败不影响后续任务；`meta.last_tick_at` 在 `finally` 中写入；
7. 设置解析失败时回退到 `DEFAULT_SETTINGS` 并写一条 `logs`，不让整个 tick 停摆；
8. 预算：单次 tick 的 D1 查询总数 ≤ 45（免费版上限约 50），调度器自身开销之外，每个处理器 ≤ 8 次查询、≤ 6 个外部请求（notify 的外部请求例外见第 6.4 节）。

本地时刻换算到 UTC 时，夏令时开始当天不存在的本地时刻（例如 02:30）顺延到切换后（03:30），与 Java `ZonedDateTime.of` 一致；重复的本地时刻取第一次出现。
窗口按 `Europe/Oslo` 本地时间、用设置里的窗口计算（与 App 的 `Windows.resolve` 相同，含跨午夜与无效值回退）。

| 任务 | 间隔 |
|---|---|
| `train` | WORK / RETURN 窗口内 2 分钟；窗口外 15 分钟 |
| `bus` | 06:00–23:30 每 5 分钟；其余 30 分钟 |
| `weather` | 30 分钟，且不早于上次响应的 `Expires` |
| `traffic_outbound` | 仅 WORK 窗口内每 5 分钟；窗口外状态为 `idle`，下次 = 下一个 WORK 窗口开始 |
| `traffic_return` | 仅 RETURN 窗口内每 5 分钟；其余同上 |
| `football` | 默认 6 小时；有比赛在开球前 90 分钟到终场之间时每分钟 |
| `notify` | 每分钟（只读快照、跑四个策略，CPU 很小） |
| `housekeeping` | 每天 03:30：清理 7 天前的 logs / push_log、过期配对码 |

## 6. 通知（[gate] P5 修订）

### 6.1 策略与状态

四个策略从 Kotlin 原样移植（`CommuteDisruptionPolicy`、`MorningBriefPolicy`、`FootballNotifyPolicy`、`TicketPolicy`），输入输出与 Kotlin 相同，以 `contracts/golden/` 的用例为准。策略名、推送路由与 push_log 的外形见 `src/contract/push.ts`。

- `notify_state.policy` 取 `commute_disruption / morning_brief / football / ticket`；`state_json` 的外形与解析回退见 `src/domain/*` 的 `parse*State`，写入时用规范 JSON（键序固定、数组升序）。缺行视为 `version = 0`、`state_json = null`。
- 设置开关（`notifyCommuteDisruption` / `notifyMorningBrief` / `notifyFootballMatch` / `notifyTicketExpiry`）为 false 时，该策略不评估、不读写状态（与 App 一致）。

### 6.2 输入

App 是「先刷新、再用这次刷新成功的结果判定」；BFF 的任务之间没有先后保证，所以 notify 只用**有效**的快照代替「本轮刷新成功」：快照按当前设置的 configKey 读取（与 dashboard 同一函数），`state = ok`、`data` 非空且能被契约 schema 解析、`now − fetched_at` 不超过时效。stale / idle / not_configured / 缺失 / 过期都视为无效（相当于 App 这次刷新失败）。

| 策略 | 输入 | 时效 | 无效时 |
|---|---|---|---|
| `commute_disruption` | `train`；另要求 `resolveWindow(fetched_at) = resolveWindow(now) ≠ OUTSIDE` | 5 分钟 | 不评估、不动状态 |
| `morning_brief` | 只在 WORK 窗口评估。`weather`、`train`（fetched_at 也须在 WORK 窗口）、`traffic_outbound` | 120 / 5 / 10 分钟 | 见下 |
| `football` | `football` | 7 小时 | 不评估、不动状态 |
| `ticket` | 只看设置 | — | — |

早间简报的宽限：当前 WORK 窗口开始后 10 分钟内，只要有一个「应有」的来源无效就本轮不评估（三个来源 train、weather、traffic_outbound 都是在其快照存在且 state ≠ not_configured 时应有；[gate] P9 起 train 也可能 not_configured，不再「总是应有」）；10 分钟后按有效的来源评估，无效的传 null（正文「暂无数据」）。三个来源都不应有时不评估（与 App「三个来源全缺时不消耗当天机会」一致）。跨午夜窗口的开始时刻取前一天。

### 6.3 至多一次

每轮 notify 的顺序：

1. 读设置 → 用一条 `IN` 查询读所需快照 → 读全部 `notify_state`。
2. 按 `morning_brief、commute_disruption、football、ticket` 的顺序评估；新状态的规范 JSON 与旧状态（解析后再序列化）相同则不写。
3. 用**一条**条件 upsert 提交所有变化的状态，只有 RETURNING 里出现的策略才发送；未出现说明另一个执行已处理，丢弃该策略本轮的通知：
   ```sql
   INSERT INTO notify_state (policy, state_json, version) VALUES (?, ?, 1), ...
   ON CONFLICT(policy) DO UPDATE SET state_json = excluded.state_json, version = notify_state.version + 1
   WHERE COALESCE(notify_state.version, 0) = CASE notify_state.policy WHEN ? THEN ? ... END
   RETURNING policy
   ```
4. 发送（6.4）。发送的任何失败（超时、5xx、429、令牌失效、oauth 失败、无设备、未配置服务账号）都**不回滚状态、不重试、不让处理器抛错**——宁可漏发一条，不重复轰炸，也不让调度退避拖住下一分钟。无设备或未配置服务账号时状态照常推进（与 App 没有通知权限时一样）。
5. 发送结束后用一条多行 INSERT 写 push_log（每条通知一行）。

崩溃语义：第 3 步之前崩溃 → 下一轮重新评估；之后崩溃 → 该通知丢失，可能没有 push_log 行。FCM 请求超时的设备可能已经收到，同样不重试。处理器超时 60 秒 < 租约 120 秒，正常不会有两个 notify 并发；条件提交是租约被接管时的第二道防线。

### 6.4 发送（FCM HTTP v1）

- **服务账号**：密钥 `fcm_service_account`，值为 Firebase 控制台下载的服务账号 JSON，必须含非空字符串 `project_id`、`client_email`、`private_key`（PKCS#8 PEM），否则 `PUT` 返回 422 `invalid_value`；其余字段忽略，`token_uri` 忽略。
- **访问令牌**：JWT RS256（WebCrypto `RSASSA-PKCS1-v1_5` + SHA-256，base64url 无填充）。头 `{ alg: "RS256", typ: "JWT", kid: private_key_id（有才带） }`；声明 `{ iss: client_email, scope: "https://www.googleapis.com/auth/firebase.messaging", aud: "https://oauth2.googleapis.com/token", iat: now 秒, exp: iat + 3600 }`；`POST https://oauth2.googleapis.com/token`，表单 `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=<jwt>`，超时 5 秒。令牌只缓存在 isolate 内存（按服务账号明文的 SHA-256 区分，`expires_in` 缺省 3600，过期前 5 分钟视为过期），**不写 D1**；FCM 返回 401 时清掉。只在确有要发送的通知时才取令牌。oauth 失败时本轮所有通知记 `skipped / fcm_auth_failed`，不发 FCM 请求。
- **目标**：`revoked_at` 为空且 `push_token_ct` 非空的设备（owner 与 viewer 都算），按 `created_at, id` 升序；push token 用 secretbox purpose `push_token` 解密，失败的设备记 `token_unreadable`，不发送、不清除。
- **请求**：`POST https://fcm.googleapis.com/v1/projects/<project_id>/messages:send`，`Authorization: Bearer <access_token>`，每台设备一个请求、串行、单个超时 4 秒。**只发 data**（不带 notification 块），由 App 用现有 `NotificationSender` 按渠道与深链出通知：
  ```json
  { "message": { "token": "<push token>", "data": { PushData }, "android": { "priority": "HIGH", "ttl": "900s", "collapse_key": "commute_disruption" } } }
  ```
  `PushData`、每类的 channelId / deepLink / ttl / collapse_key（`PUSH_ROUTING`）见 `src/contract/push.ts`；collapse_key 为 null 时不带该键。通勤类深链 `personalassistant://home`，皇马类 `personalassistant://football`。
- **错误映射**（每台设备一个 outcome）：

  | FCM 响应 | outcome | 后续 |
  |---|---|---|
  | 2xx | `ok` | |
  | 404，或 `details[].errorCode = UNREGISTERED` | `unregistered` | 清空该设备 push token，条件 `WHERE id = ? AND push_token_ct = <发送前读到的密文>`（多台合并为一条语句），不清掉刚上传的新令牌 |
  | 400 其他（INVALID_ARGUMENT） | `invalid_argument` | 不清除（也可能是负载问题） |
  | 401 | `auth_error` | 清令牌缓存；本轮其余发送记 `skipped_auth` |
  | 403（含 SENDER_ID_MISMATCH） | `sender_mismatch` | 不清除（多半是服务账号与 App 不是同一项目） |
  | 429 | `rate_limited` | 本轮其余发送记 `skipped_rate_limited` |
  | 其他 4xx / 5xx | `upstream_4xx` / `upstream_5xx` | |
  | 超时 / 网络错误 / 调度信号中止 | `timeout` / `network` / `aborted` | 中止后其余记 `aborted` |

- **预算**（第 5 节第 8 步对 notify 的例外）：D1 ≤ 8 次（开关全关 1 次；有开关但无状态变化 3 次）；外部请求 ≤ 1 次 oauth + `MAX_FCM_SENDS_PER_RUN`（10）次 FCM，超出的发送记 `skipped_budget`。
- **push_log**：每条通知一行，`at = now`、`policy`、`title`、`body`、`device_count` = 目标设备数、`result` = `PushLogResult` 的 JSON。任何日志、push_log、接口响应都不得包含私钥、访问令牌、JWT 或 push token。

### 6.5 测试推送

`POST /v1/push/test`（第 3 节）走 6.4 的同一条发送路径，policy 为 `test`，文案固定（`TEST_PUSH_TITLE / TEST_PUSH_BODY`），`scope = self` 只发给调用者本机。30 秒内最多一次（原子占用 `meta.push_test_at`）。

## 7. 缓存键映射（App 端）

| Dashboard 来源 | App CacheStore 键 |
|---|---|
| `weather` | `weather` |
| `train` | `train` |
| `trafficOutbound` | `traffic_outbound` |
| `trafficReturn` | `traffic_return` |
| `bus` | `bus` |
| `football` | `football` |

`data` 为 null 时不覆盖 App 已有缓存。

## 8. 管理接口（`/admin/api`，[gate] P7）

全部需要第 2 节的 Access 校验（及非 GET 的 CSRF 校验）；错误格式同第 3 节。外形见 `src/contract/admin.ts`。
管理接口**复用** `/v1` 的业务逻辑（同一批函数），规则与 `/v1` 完全一致（例如「不能删除 / 降级最后一个 owner」「测试推送 30 秒一次」「PUT 设置需要 If-Match」），不另立一套。

| 方法 路径 | 请求 | 成功响应 | 错误 |
|---|---|---|---|
| `GET /admin/api/me` | — | 200 `AdminMe` | |
| `GET /admin/api/overview` | — | 200 `Overview` | |
| `POST /admin/api/jobs/:name/run` | — | 202 `{ queued: name }`（把 `next_run_at` 设为 now；租约未过期时照样只改 next_run_at，由调度器决定何时执行） | 404 未知或不开放的任务名（见 `RunnableJobSchema`） |
| `GET /admin/api/devices` | — | 200 `{ devices: AdminDevice[] }` | |
| `DELETE /admin/api/devices/:id` | — | 204 | 404，409 `last_owner` |
| `PATCH /admin/api/devices/:id` | `{ role }` | 200 `AdminDevice` | 404，409 `last_owner`，422 `invalid_request` |
| `POST /admin/api/pair-codes` | — | 201 `{ code, expiresAt }`（`created_by = admin:<email>`） | |
| `GET /admin/api/logs` | 查询 `LogsQuery` | 200 `LogsResponse` | 422 `invalid_request` |
| `GET /admin/api/push-log` | 查询 `PageQuery` | 200 `PushLogResponse` | 422 `invalid_request` |
| `POST /admin/api/push/test` | `AdminPushTestRequest`（无 deviceId = 全部设备） | 200 `{ deviceCount, result }` | 同 `/v1/push/test`（409 `no_push_token`、503 `fcm_not_configured`、429 `too_soon`，与 `/v1` 共用 `meta.push_test_at`），另 404 deviceId 不存在 |
| `GET /admin/api/settings` | — | 200 同 `GET /v1/settings`（含 ETag） | |
| `PUT /admin/api/settings` | 同 `PUT /v1/settings` | 同 `/v1` | 同 `/v1` |
| `GET /admin/api/settings/schema` | — | 200 `SettingsSchema` 的 JSON Schema（zod v4 `z.toJSONSchema`，draft 2020-12） | |
| `GET /admin/api/secrets` 等四个 | 同 `/v1/secrets*` | 同 `/v1` | 同 `/v1` |
| `GET /admin/api/export` | — | 200 `SettingsExport`，头 `Content-Disposition: attachment; filename="pa-bff-settings-<yyyyMMdd>.json"` | |
| `POST /admin/api/import` | 头 `If-Match: "r<revision>"`，体 `SettingsExport` | 200 同 `PUT /v1/settings` | 428，409 `revision_conflict`，422 `invalid_settings`（`format` / `version` 不对也是 422） |

未配置 Access 时本节所有路径返回 404 `not_found`（与未知路由相同，不暴露管理界面存在）。

## 9. 关注线路与车站默认值（[gate] P9）

v1 的公交卡片把线路与两端站写死在代码里；P9 起改为设置里的**一条**关注线路（`watchedLine*` 六个字段，见 `src/contract/settings.ts`），火车出发站 / 到达站的默认值改为空串。

**车站未选择**：`originStation` 或 `destStation` 在 L1 站表里找不到（含空串）→ 不再回退到任何默认站：
- App：火车卡片显示「请先在设置里选择车站」，不发请求
- BFF：`train` 任务写 `not_configured`（configKey 为 null），不发请求；依赖 train 的通知按「输入无效」处理（第 6.2 节）

**关注线路**：六个字段都非空才算已配置，否则 `bus` 来源为 `not_configured`、不发请求。configKey = `<lineId>|<stopAId>|<stopBId>`。已配置时：
- 请求：一次 Entur 查询取 A、B 两个 stop place 的到站记录，`whiteListed: { lines: [lineId] }`，每个班次同时取 `serviceJourney.quays { stopPlace { id } }`（该班次按顺序经过的站）
- 方向判定：A 站的班次只有当 B 出现在该班次站序里、且位置在 A 之后，才算「A → B」；B 站同理。**不再**按终点站名匹配（线路可能有不到对端的区间车，例如只开到中途的短线班次必须被排除）
- `BusStatus.boards` 固定两块：`[A → B, B → A]`，`boardStop` / `towardStop` 为设置里的站名；`lineCode` 为设置里的 `watchedLineCode`
- 其余（每块取的条数、裁剪已开走的班次、倒计时文案、30 分钟过期标注）与 v1 的公交卡片相同

**`GET /v1/lines`**：一次 Entur 查询取两个 stop place 的 `quays { lines { id publicCode name transportMode } }`，返回两边都出现的线路（按 id 去重），排序见 `LinesResponseSchema` 注释。任一 stop place 不存在 → 返回空列表。

**首次运行迁移（只在 App 本地）**：App 首次运行（新装或升级；PANext 用新包名 `com.panext.app`，在用户手机上是新装而不是覆盖升级）时，若本机设置的六个 `watchedLine*` 都为空且迁移标记未写过，填入 v1 那张写死卡片的线路与两端站，并写迁移标记（只迁移一次；用户之后清空也不会再填回）。App 不公开发布，这相当于只存在于 App 里的一个首装默认值。已接入 BFF 的 owner 设备经 `RemoteSettingsSync.save` 提交；viewer 不迁移（由 owner 决定）。**BFF 不做任何迁移，BFF 代码与测试里不出现这条线路与这两个站**。

**存储兼容**：App（`encodeDefaults = true`）与 BFF（写入 parse 后的完整对象）都把全部字段写进存储，默认值变化不影响已保存的设置。只有极旧、缺 `originStation` 字段的存储会解出空串——这属于上面「车站未选择」的情形，由用户重新选择。
