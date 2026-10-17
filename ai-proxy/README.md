# 知行计算器 AI 后端代理与管理中心

此目录部署到 Cloudflare Workers。模型 API Key 不会通过管理 API 回传到网页；管理员通过有时效的签名会话访问受保护的管理 API。

**重要隐私边界：**用户提交的文字、对话上下文和图片会被转发给管理中心配置的模型 API 服务商，以便生成回答。当前 Worker 不会主动将问题正文、回答正文或图片写入项目自己的调用统计；但这不代表 Cloudflare、浏览器或模型服务商绝不记录数据。请先阅读 [AI 数据安全与隐私说明](./SECURITY.md)。

## 1. 首次部署

Worker 使用一个 SQLite-backed Durable Object 保存后台配置与调用统计，Wrangler 会通过 `v1` migration 自动创建存储命名空间，不需要手动创建 KV。

在 Cloudflare Dashboard 中打开：

`Workers & Pages → zhixing-calculator-ai → Settings → Variables and Secrets`

添加一个 **Secret**：

- `ADMIN_PASSWORD`：由你自己设定的管理密码。建议至少 16 位随机字符，并使用密码管理器保存。

建议再添加两个独立 **Secrets**：

- `ADMIN_SESSION_SECRET`：用于签名登录会话的高熵随机字符串。请与管理密码、加密密钥分别生成。
- `ADMIN_ENCRYPTION_KEY`：用于加密后台保存的自定义模型 API Key。应使用独立、高熵的随机值，并长期安全保管。首次保存或读取自定义 Key 前配置它，避免加密依赖管理密码。

保存后打开管理页面：

`https://c.zhixing.us.ci/ai-admin.html`

输入上述管理密码登录。没有配置 `ADMIN_PASSWORD` 时，后端会拒绝登录；密码绝不会被写入网页代码或 GitHub 仓库。

## 2. 后端管理页面功能

- **模型与 API**：编辑 OpenAI 兼容 API 根地址、API Key、模型 ID、Temperature 和最大输出 Token。
- **自动获取模型列表**：使用当前 API 地址和密钥调用 `GET /models`，将可用模型显示为下拉候选；若服务商不实现该接口，可以直接手动填写模型 ID。
- **连接测试**：发起一次短回复请求，返回 HTTP 错误、响应耗时与模型预览。
- **提示词管理**：分别编辑 AI 学习助手通用聊天、数学、函数、化学，以及计算器各题型和分析/扩展动作提示词；保存后无需重新部署。
- **统计与调用记录**：显示累计请求、失败次数、供应商返回的 Token 用量和最近 20 条元数据。当前统计逻辑不会保存用户题目正文或回答正文。
- **配置备份**：导出/导入 API 地址、模型参数和提示词；导出文件不包含密钥和管理密码。

## 3. 模型 API 配置

`AI_BASE_URL` 是 API 根地址，例如 `https://api.example.com/v1`，不要填写 `/chat/completions`。必须使用 HTTPS，且不能指向本机或常见内网地址。只配置你信任的服务商，并先核对其隐私、留存、训练、计费和数据处理政策。

`AI_MODEL` 和 `AI_API_KEY` 的 Worker 原有变量/Secret 继续作为默认值；管理页面保存的配置优先使用。密钥输入框留空表示不修改现有密钥；“改用 Worker Secret”会清除后台保存的自定义 Key 并回退至 `AI_API_KEY`。

模型列表通过 `GET /models` 获取，这是 OpenAI 兼容接口的常见行为，但部分服务商可能禁用该接口；此时可以手动输入模型 ID，使用“测试连接”确认权限。

## 4. 安全基线

- `ADMIN_PASSWORD`、`ADMIN_SESSION_SECRET` 和 `AI_API_KEY` 应配置为 Cloudflare Worker Secrets；不要写进 `wrangler.toml`、网页、仓库或备份。
- 管理接口使用允许来源校验、HMAC 签名的 Bearer 会话和到期检查；管理会话约 4 小时有效。
- API Key 不会通过管理 API 回传到浏览器；自定义 Key 使用 AES-GCM 加密后保存在 Durable Object，优先使用 `ADMIN_ENCRYPTION_KEY`。为兼容旧部署，缺少该 Secret 时会回退到 `ADMIN_SESSION_SECRET` 或 `ADMIN_PASSWORD`，因此强烈建议配置独立加密密钥。
- 登录失败限制、普通 AI 请求限制、健康检查和上游模型测试/列表限制使用 Durable Object 持久计数；如果限流存储不可用或没有绑定 `ADMIN_STORE`，请求会失败关闭而不是跳过限流。
- 调用统计只记录时间、场景、模型、HTTP 状态、成功/失败和可用的 Token 用量；最近记录最多 20 条。流式供应商若不回传 Token 用量，统计可能不完整。
- 不要将管理密码、会话令牌、API Key、学生身份信息或其他敏感内容放进公开 Issue、日志、截图或测试问题中。
- 如果密钥疑似泄露，应立即在服务商控制台撤销并重新生成；仅删除仓库文件不能保证密钥从 Git 历史和缓存中消失。

完整的数据流、第三方处理边界、风险限制和泄露响应步骤见 [SECURITY.md](./SECURITY.md)。

## 5. 重要说明

安全功能是多层防护，不等于绝对安全。浏览器的 CORS/Origin 校验不能代替身份认证；模型服务商对请求内容的处理由其服务条款与隐私政策决定。若不希望某段内容发送给当前配置的模型服务商，请不要提交该内容。
