# 知行 AI 云对话存储部署说明

## 1. 数据库初始化

在 Supabase 项目 `gzuaqjtvnkiblhqsgzpd` 的 **SQL Editor** 中，执行仓库文件：

`ai-proxy/supabase/cloud-chat-storage.sql`

该脚本建立 `zx_conversations`、`zx_messages`，启用 RLS，并撤销前端对聊天表的直接访问。聊天表只能通过 Worker 后端操作。不要把数据库密码或 service-role key 放进 SQL 文件、网页、GitHub Actions 日志或仓库。

## 2. Cloudflare Worker Secrets

在 Cloudflare Dashboard 打开承载 `api.zhixing.us.ci` 的 Worker → **Settings → Variables and Secrets**，新增以下三个 **Secret**（不要写入 `wrangler.toml`）：

- `SUPABASE_URL`：Supabase Project URL
- `SUPABASE_PUBLISHABLE_KEY`：Supabase Publishable key（公开 key）
- `SUPABASE_SERVICE_ROLE_KEY`：优先使用 Supabase 的 Secret key（`sb_secret_...`），也兼容旧版 `service_role` JWT；只能放 Worker Secret，绝不可提供给浏览器或提交到仓库

保存后重新部署 Worker。高权限密钥能绕过 RLS，因此 Worker 所有对话读写都必须继续校验登录令牌、当前用户 ID、产品 ID 和对话所有权。新版 `sb_secret_...` 不是 JWT，Worker 会只把它放在 `apikey` 请求头；不要自行添加 `Authorization: Bearer sb_secret_...`。

## 3. 邮箱注册与登录

前端使用 Supabase Auth 邮箱/密码登录。请在 Supabase Dashboard → Authentication → URL Configuration 中，将实际学习版站点加入 Site URL / Redirect URLs。若启用邮箱验证，请确保邮件模板和站点回跳地址正确。密码至少 8 位；建议保留邮箱验证与适当的登录限流。

## 4. 自动删除 90 天未活动的对话

Worker 配置每日 UTC 03:17 触发清理任务。该任务调用 `public.zx_cleanup_expired_conversations()`，按 `last_activity_at` 删除超过 90 天的会话，消息通过外键级联删除。部署后请在 Cloudflare Worker 的 Triggers / Logs 检查 Cron 是否已启用并成功运行。

## 5. 接入范围与隐私边界

- `learning`（知行AI学习版）和 `zhixing-ai`（知行AI）分开存储。
- 仅保存消息文字；图片和文件原件不会写入聊天历史表。
- 删除会话会级联删除其消息；列表接口最多返回最近 100 条，会话消息接口最多返回 500 条。
- 90 天清理针对本 Supabase 聊天表，不代表模型供应商、Cloudflare 日志或备份中的数据也会同时删除；这些保留策略需要分别核对。
- 本功能需先执行 SQL、配置 Worker Secrets 并部署后才会真正连通。不要在公开渠道分享 `SUPABASE_SERVICE_ROLE_KEY`、数据库密码或用户访问令牌。
