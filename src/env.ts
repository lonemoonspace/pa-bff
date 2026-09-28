// Worker 的环境变量与机密类型。字段与 CONTRACT.md 第 1 节一一对应。
export interface Env {
  /** base64 编码的 32 字节随机数，AES-GCM 主密钥（secretbox 用，见 P2 T2.1）。 */
  MASTER_KEY: string;
  /** 认领码，长度 ≥ 12。未设置时 /v1/claim 返回 503 not_configured。 */
  CLAIM_CODE?: string;
  /** 例 yourteam.cloudflareaccess.com。与 ACCESS_AUD 同时设置才开启管理界面。 */
  ACCESS_TEAM_DOMAIN?: string;
  /** Access 应用的 AUD tag。 */
  ACCESS_AUD?: string;
  /** 每次 tick 结束后 GET 一次（healthchecks.io 之类）。 */
  HEALTHCHECK_URL?: string;
  /** D1 数据库绑定。 */
  DB: D1Database;
  /** 管理界面的静态文件绑定（bff/admin-ui/public/），只经 Worker 取用。 */
  ASSETS: Fetcher;
  /** 仅本地开发：值为 "1" 且请求主机名是 localhost / 127.0.0.1 时跳过 Access 校验。 */
  ADMIN_DEV_BYPASS?: string;
}
