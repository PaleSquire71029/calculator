/**
 * 知行计算器 AI 代理
 * API 密钥必须通过 Cloudflare Worker Secret 配置，不要写入仓库。
 */
const DEFAULT_ORIGINS = [
  "https://c.zhixing.us.ci",
  "https://zhixingjsq.pages.dev",
  "https://palesquire71029.github.io"
];
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const WINDOW_MS = 10 * 60 * 1000;
const MAX_REQUESTS = 12;
const buckets = new Map();

const MODE_PROMPTS = {
  solve: "你是严谨的高中数学解题老师。用中文回答，按已知条件、思路、逐步推导、结论组织。不要跳过关键步骤；计算不确定时明确指出，不得编造题目条件。",
  function: "你是高中函数分析老师。用中文分析用户给出的函数，尽可能讨论定义域、值域、奇偶性、单调性、零点、对称性、渐近线和图像特征；区分严格结论与数值/直观判断。表达式不明确时先澄清。",
  chemistry: "你是中学化学老师。用中文回答化学问题；方程式配平须遵守原子守恒，不得修改化学式下标；说明反应条件、现象、产物、离子方程式时要考虑反应物状态、强弱电解质、沉淀/气体/水生成及常见例外。不能确定的反应请明确说明，不要把猜测写成事实。",
  general: "你是知行计算器的学习助手。用中文准确、清晰地回答，优先给出可检查的推导与结论；对不确定内容说明不确定性。"
};

function json(data, status, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers }
  });
}
function getAllowedOrigins(env) {
  const raw = typeof env.ALLOWED_ORIGINS === "string" ? env.ALLOWED_ORIGINS : "";
  return (raw ? raw.split(",") : DEFAULT_ORIGINS).map(s => s.trim()).filter(Boolean);
}
function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = getAllowedOrigins(env);
  const headers = { "Vary": "Origin", "Access-Control-Allow-Methods": "POST, GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "86400" };
  if (allowed.includes(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}
function tooLarge(request) {
  const len = Number(request.headers.get("Content-Length") || 0);
  return len > MAX_BODY_BYTES;
}
function checkRate(request) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const now = Date.now();
  const old = buckets.get(ip);
  if (!old || now - old.start >= WINDOW_MS) {
    buckets.set(ip, { start: now, count: 1 });
    return true;
  }
  old.count += 1;
  if (old.count <= MAX_REQUESTS) return true;
  return false;
}
function validImageUrl(value) {
  return typeof value === "string" &&
    /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=\r\n]+$/.test(value) &&
    value.length <= 5_000_000;
}
function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 12) return "messages 必须包含 1 至 12 条消息";
  let totalChars = 0;
  for (const msg of messages) {
    if (!msg || !["user", "assistant"].includes(msg.role)) return "消息角色无效";
    if (typeof msg.content === "string") {
      totalChars += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part?.type === "text" && typeof part.text === "string") totalChars += part.text.length;
        else if (part?.type === "image_url" && validImageUrl(part.image_url?.url)) totalChars += part.image_url.url.length;
        else return "图片或消息格式不受支持，请使用 JPEG、PNG 或 WebP 图片";
      }
    } else return "消息内容格式无效";
  }
  if (totalChars > 5_500_000) return "消息过长，请缩短文字或压缩图片";
  return "";
}
export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    const origin = request.headers.get("Origin") || "";
    const allowed = getAllowedOrigins(env);
    if (request.method === "OPTIONS") {
      if (origin && !allowed.includes(origin)) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: cors });
    }
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, configured: Boolean(env.AI_API_KEY && env.AI_BASE_URL && env.AI_MODEL) }, 200, cors);
    }
    if (url.pathname !== "/api/chat" || request.method !== "POST") return json({ error: "Not found" }, 404, cors);
    if (!origin || !allowed.includes(origin)) return json({ error: "该网站来源未获授权，请检查 Worker 的 ALLOWED_ORIGINS 配置。" }, 403, cors);
    if (!checkRate(request)) return json({ error: "请求过于频繁，请等待几分钟后再试。" }, 429, cors);
    if (tooLarge(request)) return json({ error: "请求体过大，请压缩图片后重试。" }, 413, cors);
    if (!env.AI_API_KEY || !env.AI_BASE_URL || !env.AI_MODEL) {
      return json({ error: "AI 后端尚未配置。请在 Worker 中设置 AI_API_KEY（Secret）、AI_BASE_URL 和 AI_MODEL。" }, 503, cors);
    }
    let body;
    try { body = await request.json(); } catch { return json({ error: "请求不是有效的 JSON。" }, 400, cors); }
    const mode = Object.hasOwn(MODE_PROMPTS, body.mode) ? body.mode : "general";
    const messageError = validateMessages(body.messages);
    if (messageError) return json({ error: messageError }, 400, cors);
    let base;
    try {
      base = new URL(env.AI_BASE_URL);
      if (base.protocol !== "https:" && base.hostname !== "localhost") throw new Error("HTTPS required");
    } catch {
      return json({ error: "AI_BASE_URL 必须是有效的 HTTPS API 根地址。" }, 500, cors);
    }
    const endpoint = base.toString().replace(/\/+$/, "") + "/chat/completions";
    const payload = {
      model: env.AI_MODEL,
      messages: [{ role: "system", content: MODE_PROMPTS[mode] }, ...body.messages],
      temperature: 0.2,
      stream: false
    };
    let upstream;
    try {
      upstream = await fetch(endpoint, {
        method: "POST",
        headers: { "Authorization": "Bearer " + env.AI_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(90000)
      });
    } catch {
      return json({ error: "无法连接模型服务，请检查 API 地址和网络后重试。" }, 502, cors);
    }
    const text = await upstream.text();
    let result;
    try { result = JSON.parse(text); } catch { result = null; }
    if (!upstream.ok) {
      const upstreamMessage = result?.error?.message;
      return json({ error: "模型服务返回错误（" + upstream.status + "）：" + (typeof upstreamMessage === "string" ? upstreamMessage.slice(0, 500) : "请检查模型名称、API 地址和密钥。") }, 502, cors);
    }
    const answer = result?.choices?.[0]?.message?.content;
    if (typeof answer !== "string" || !answer.trim()) return json({ error: "模型没有返回可显示的文字，请稍后重试。" }, 502, cors);
    return json({ answer, model: result.model || env.AI_MODEL, usage: result.usage || null }, 200, cors);
  }
};
