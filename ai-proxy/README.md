# 知行计算器 AI 后端代理与管理中心

此目录部署到 Cloudflare Workers。模型 API Key 不会返回给网页；管理员通过有时效的签名会话访问受保护的管理 API。

## 1. 首次部署

Worker 使用一个 SQLite-backed Durable Object 保存后台配置与调用统计，Wrangler 会通过 `v1` migration 自动创建存储命名空间，不需要手动创建 KV。

在 Cloudflare Dashboard 中打开：

`Workers & Pages → zhixing-calculator-ai → Settings → Variables and Secrets`

添加一个 **Secret**：

- `ADMIN_PASSWORD`：由你自己设定的管理密码。建议至少 16 位，并使用密码管理器保存。

可选再添加一个独立 **Secret**：

- `ADMIN_SESSION_SECRET`：用于签名登录会话的随机长字符串。未设置时，系统会使用 `ADMIN_PASSWORD` 作为会话签名密钥。

保存后打开管理页面：

`https://c.zhixing.us.ci/ai-admin.html`

输入上述管理密码登录。没有配置 `ADMIN_PASSWORD` 时，后端会拒绝登录；密码绝不会被写入网页代码或 GitHub 仓库。

## 2. 后端管理页面功能

- **模型与 API**：编辑 OpenAI 兼容 API 根地址、API Key、模型 ID、Temperature 和最大输出 Token。
- **自动获取模型列表**：使用当前 API 地址和密钥调用 `GET /models`，将可用模型显示为下拉候选；若服务商不实现该接口，可以直接手动填写模型 ID。
- **连接测试**：发起一次短回复请求，返回 HTTP 错误、响应耗时与模型预览。
- **提示词管理**：分别编辑 AI 学习助手通用聊天、数学、函数、化学，以及计算器各题型和分析/扩展动作提示词；保存后无需重新部署。
- **统计与调用记录**：显示累计请求、失败次数、供应商返回的 Token 用量和最近 20 条元数据。不会存储用户题目正文。
- **配置备份**：导出/导入 API 地址、模型参数和提示词；导出文件不包含密钥和管理密码。

## 3. 模型 API 配置

`AI_BASE_URL` 是 API 根地址，例如 `https://api.example.com/v1`，不要填写 `/chat/completions`。必须使用 HTTPS，且不能指向本机或内网地址。`AI_MODEL` 和 `AI_API_KEY` 的 Worker 原有变量/Secret 继续作为默认值；管理页面保存的配置优先使用。密钥输入框留空表示不修改现有密钥；“改用 Worker Secret”会清除后台保存的自定义 Key 并回退至 `AI_API_KEY`。

模型列表通过 `GET /models` 获取，这是 OpenAI 兼容接口的常见行为，但部分服务商可能禁用该接口；此时可以手动输入模型 ID，使用“测试连接”确认权限。

## 4. 安全说明

- `ADMIN_PASSWORD` 必须作为 Cloudflare Worker Secret 配置，不要写进 `wrangler.toml`、网页或仓库。
- 管理接口只允许 `ALLOWED_ORIGINS` 中的网页来源，并要求 HMAC 签名、约 4 小时有效的 Bearer 会话；登录失败次数受到限制。
- API Key 不会通过管理 API 回传到浏览器；后台保存的密钥只在 Worker 内部读取。
- 管理页不是靠隐藏网址来保密，安全性依赖 Worker Secret、签名验证、来源校验与 HTTPS。不要把管理密码分享给他人。
- 使用量只记录时间、场景、模型、HTTP 状态和成功/失败结果。流式供应商若不回传 Token 用量，统计中的 Token 数可能不完整。
- `AI_API_KEY` 仍建议保留在 Cloudflare Secret 中；不要在前端添加服务商密钥或将密钥放入导出备份。
