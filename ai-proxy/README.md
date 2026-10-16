# 知行计算器 AI 后端代理

此目录部署到 Cloudflare Workers。前端不会接触模型 API 密钥，密钥必须在 Worker 的 Secret 中设置。

## 1. 创建/部署 Worker

在本目录执行：

```bash
npx wrangler login
npx wrangler deploy
npx wrangler secret put AI_API_KEY
```

按提示粘贴你所选模型供应商的 API Key。不要把密钥写进 `wrangler.toml`、前端文件或 GitHub。

默认配置使用 DeepSeek 的 OpenAI 兼容接口。可在 Cloudflare Dashboard → Worker → Settings → Variables and Secrets 中修改：
- `AI_BASE_URL`：API 根地址，必须是 HTTPS，例如 `https://api.deepseek.com/v1`（不要加 `/chat/completions`）。
- `AI_MODEL`：供应商实际提供的模型 ID。
- `ALLOWED_ORIGINS`：允许访问的网页源，逗号分隔；必须与浏览器地址栏的 Origin 完全匹配。

其他兼容供应商也只需改 `AI_BASE_URL`、`AI_MODEL` 和 Secret `AI_API_KEY`。拍照识题要求模型支持图像输入。

## 2. 在前端连接代理

打开计算器的「AI 学习助手」页面，在「后端代理地址」填写部署后得到的 Worker 地址，例如 `https://zhixing-calculator-ai.<你的子域>.workers.dev`。前端会请求该地址下的 `/api/chat`。地址仅保存在当前浏览器标签页的会话中，不包含 API Key。

## 3. 安全说明

- Worker 只接受配置的来源，限制请求体大小，拒绝不支持的图片格式，并提供每个运行实例的基础频率限制。
- 内存频率限制不是全局配额控制。部署到公开网页前，建议在 Cloudflare Dashboard 为 `/api/chat` 配置正式的 Rate Limiting 规则，并监控模型费用。
- CORS 不是身份验证；任何非浏览器客户端都可能伪造 Origin。请勿将该代理当作私有 API。
- `AI_API_KEY` 必须使用 Cloudflare Secret；`.dev.vars`、`.env` 等本地密钥文件不要提交到 Git。
- Worker 的 API Key 与 GitHub Pages 的静态文件完全分离。不要在前端添加供应商密钥输入框。
