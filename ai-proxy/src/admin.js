const ADMIN_SESSION_TTL_MS = 4 * 60 * 60 * 1000;
const ADMIN_LOGIN_WINDOW_MS = 15 * 60 * 1000;
const ADMIN_LOGIN_MAX_ATTEMPTS = 8;
const loginBuckets = new Map();

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers }
  });
}
function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, ch => ch.charCodeAt(0));
}
function safeEqual(a, b) {
  const left = new TextEncoder().encode(String(a ?? ""));
  const right = new TextEncoder().encode(String(b ?? ""));
  let diff = left.length ^ right.length;
  const max = Math.max(left.length, right.length);
  for (let i = 0; i < max; i++) diff |= (left[i] || 0) ^ (right[i] || 0);
  return diff === 0;
}
async function signPayload(payload, env) {
  const secret = String(env.ADMIN_SESSION_SECRET || env.ADMIN_PASSWORD || "");
  if (!secret) throw new Error("未设置管理会话签名密钥");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return encodeBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))));
}
async function createToken(env) {
  const payload = encodeBase64Url(new TextEncoder().encode(JSON.stringify({ role: "admin", exp: Date.now() + ADMIN_SESSION_TTL_MS })));
  return payload + "." + await signPayload(payload, env);
}
async function verifyToken(request, env) {
  const match = (request.headers.get("Authorization") || "").match(/^Bearer\s+([A-Za-z0-9_.-]+)$/i);
  if (!match || !env.ADMIN_PASSWORD) return false;
  const parts = match[1].split(".");
  if (parts.length !== 2) return false;
  try {
    if (!safeEqual(await signPayload(parts[0], env), parts[1])) return false;
    const payload = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[0])));
    return payload.role === "admin" && Number(payload.exp) > Date.now();
  } catch { return false; }
}
function loginAllowed(request) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const now = Date.now();
  const previous = loginBuckets.get(ip);
  if (!previous || now - previous.start >= ADMIN_LOGIN_WINDOW_MS) {
    loginBuckets.set(ip, { start: now, count: 1 });
    return true;
  }
  previous.count += 1;
  return previous.count <= ADMIN_LOGIN_MAX_ATTEMPTS;
}
export class AdminSettingsStore {
  constructor(state, env) { this.state = state; this.env = env; }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/data") return json({ error: "Not found" }, 404);
    if (request.method === "GET") return json((await this.state.storage.get("adminData")) || {});
    if (request.method !== "PUT") return json({ error: "Method not allowed" }, 405);
    let data;
    try { data = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
    if (!data || typeof data !== "object" || Array.isArray(data)) return json({ error: "Invalid admin data" }, 400);
    await this.state.storage.put("adminData", data);
    return json({ ok: true });
  }
}
export function createAdminModule({ getAllowedOrigins, defaultPrompts }) {
  async function readData(env) {
    if (!env.ADMIN_STORE) return null;
    const stub = env.ADMIN_STORE.get(env.ADMIN_STORE.idFromName("settings-v1"));
    const response = await stub.fetch("https://admin-store.internal/data");
    if (!response.ok) throw new Error("无法读取管理设置存储");
    return await response.json();
  }
  async function writeData(env, data) {
    if (!env.ADMIN_STORE) throw new Error("管理设置存储未绑定");
    const stub = env.ADMIN_STORE.get(env.ADMIN_STORE.idFromName("settings-v1"));
    const response = await stub.fetch("https://admin-store.internal/data", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data)
    });
    if (!response.ok) throw new Error("无法保存管理设置");
  }
  function normalizeApiBaseUrl(value) {
    let url;
    try { url = new URL(String(value || "").trim()); } catch { throw new Error("API 地址不是有效的网址"); }
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("API 地址必须使用 HTTPS，且不能包含账号密码");
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "::1" || /^(fc|fd|fe80:)/i.test(host)) {
      throw new Error("API 地址不能指向本机或内网地址");
    }
    const parts = host.split(".");
    if (parts.length === 4 && parts.every(x => /^\d{1,3}$/.test(x) && Number(x) <= 255)) {
      const ip = parts.map(Number);
      if (ip[0] === 0 || ip[0] === 10 || ip[0] === 127 || (ip[0] === 169 && ip[1] === 254) ||
          (ip[0] === 172 && ip[1] >= 16 && ip[1] <= 31) || (ip[0] === 192 && ip[1] === 168) ||
          (ip[0] === 100 && ip[1] >= 64 && ip[1] <= 127)) throw new Error("API 地址不能指向本机或内网地址");
    }
    url.pathname = url.pathname.replace(/\/+(chat\/completions|models)\/?$/i, "").replace(/\/+$/, "") || "/";
    url.search = ""; url.hash = "";
    return url.toString().replace(/\/$/, "");
  }
  function cleanPromptMap(input, fallback) {
    const output = {};
    for (const key of Object.keys(fallback)) {
      const value = input && Object.hasOwn(input, key) ? input[key] : fallback[key];
      if (typeof value !== "string") throw new Error("提示词「" + key + "」格式无效");
      if (value.length > 16000) throw new Error("提示词「" + key + "」最多 16000 字符");
      output[key] = value;
    }
    return output;
  }
  function buildRuntimeSettings(data, env) {
    const saved = data?.settings || {};
    const defaults = defaultPrompts();
    const stored = saved.prompts || {};
    const apiKey = saved.apiKeyMode === "custom" && saved.apiKey ? saved.apiKey : (env.AI_API_KEY || "");
    return {
      apiBaseUrl: saved.apiBaseUrl || env.AI_BASE_URL || "",
      model: saved.model || env.AI_MODEL || "",
      apiKey,
      temperature: Number.isFinite(Number(saved.temperature)) ? Math.min(2, Math.max(0, Number(saved.temperature))) : 0.2,
      maxTokens: Number.isInteger(Number(saved.maxTokens)) ? Math.min(32768, Math.max(0, Number(saved.maxTokens))) : 0,
      prompts: {
        chat: { ...defaults.chat, ...(stored.chat || {}) },
        analysisBase: typeof stored.analysisBase === "string" && stored.analysisBase ? stored.analysisBase : defaults.analysisBase,
        analysisModes: { ...defaults.analysisModes, ...(stored.analysisModes || {}) },
        analysisActions: { ...defaults.analysisActions, ...(stored.analysisActions || {}) }
      },
      apiKeySource: saved.apiKeyMode === "custom" && saved.apiKey ? "custom" : (env.AI_API_KEY ? "worker" : "missing"),
      hasApiKey: Boolean(apiKey),
      updatedAt: saved.updatedAt || null,
      stats: data?.stats || { totalRequests: 0, failedRequests: 0, promptTokens: 0, completionTokens: 0, recent: [] }
    };
  }
  function publicSettings(runtime) {
    return {
      apiBaseUrl: runtime.apiBaseUrl, model: runtime.model, hasApiKey: runtime.hasApiKey,
      apiKeySource: runtime.apiKeySource, temperature: runtime.temperature, maxTokens: runtime.maxTokens,
      prompts: runtime.prompts, updatedAt: runtime.updatedAt, stats: runtime.stats
    };
  }
  async function getRuntimeSettings(env) {
    return buildRuntimeSettings(await readData(env), env);
  }
  async function recordRequest(env, event) {
    try {
      const data = await readData(env);
      if (!data) return;
      const stats = data.stats || { totalRequests: 0, failedRequests: 0, promptTokens: 0, completionTokens: 0, recent: [] };
      stats.totalRequests = (stats.totalRequests || 0) + 1;
      if (!event.ok) stats.failedRequests = (stats.failedRequests || 0) + 1;
      if (event.usage) {
        stats.promptTokens = (stats.promptTokens || 0) + (Number(event.usage.prompt_tokens) || 0);
        stats.completionTokens = (stats.completionTokens || 0) + (Number(event.usage.completion_tokens) || 0);
      }
      stats.recent = [{ at: new Date().toISOString(), mode: event.mode || "unknown", ok: Boolean(event.ok), status: event.status || 0, model: event.model || "" }, ...(stats.recent || [])].slice(0, 20);
      data.stats = stats;
      await writeData(env, data);
    } catch { /* 统计不能中断主请求 */ }
  }
  async function handleRoute(request, env, url, cors) {
    const origin = request.headers.get("Origin") || "";
    if (!origin || !getAllowedOrigins(env).includes(origin)) return json({ error: "该网页来源未获授权" }, 403, cors);
    if (url.pathname === "/admin/login" && request.method === "POST") {
      if (!env.ADMIN_PASSWORD) return json({ error: "尚未配置管理密码。请在 Cloudflare Worker → Settings → Variables and Secrets 中添加 Secret：ADMIN_PASSWORD。" }, 503, cors);
      if (!loginAllowed(request)) return json({ error: "登录尝试过多，请 15 分钟后再试。" }, 429, cors);
      let body;
      try { body = await request.json(); } catch { return json({ error: "请求格式错误" }, 400, cors); }
      if (typeof body.password !== "string" || !safeEqual(body.password, env.ADMIN_PASSWORD)) return json({ error: "管理密码不正确" }, 401, cors);
      return json({ token: await createToken(env), expiresIn: ADMIN_SESSION_TTL_MS }, 200, cors);
    }
    if (!await verifyToken(request, env)) return json({ error: "管理会话已失效，请重新登录" }, 401, cors);
    if (!env.ADMIN_STORE) return json({ error: "管理设置存储尚未部署，请检查 Worker 的 Durable Object 绑定" }, 503, cors);
    let data;
    try { data = await readData(env) || {}; } catch { return json({ error: "读取管理数据失败，请稍后重试" }, 500, cors); }
    if (url.pathname === "/admin/settings" && request.method === "GET") return json(publicSettings(buildRuntimeSettings(data, env)), 200, cors);
    if (url.pathname === "/admin/settings" && request.method === "PUT") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "请求格式错误" }, 400, cors); }
      let apiBaseUrl;
      try { apiBaseUrl = normalizeApiBaseUrl(body.apiBaseUrl); } catch (error) { return json({ error: error.message }, 400, cors); }
      const model = String(body.model || "").trim();
      if (!model || model.length > 200) return json({ error: "模型名称不能为空且不能超过 200 字符" }, 400, cors);
      const defaults = defaultPrompts();
      const pi = body.prompts || {};
      let prompts;
      try {
        prompts = {
          chat: cleanPromptMap(pi.chat, defaults.chat),
          analysisBase: typeof pi.analysisBase === "string" ? pi.analysisBase : defaults.analysisBase,
          analysisModes: cleanPromptMap(pi.analysisModes, defaults.analysisModes),
          analysisActions: cleanPromptMap(pi.analysisActions, defaults.analysisActions)
        };
      } catch (error) { return json({ error: error.message }, 400, cors); }
      if (prompts.analysisBase.length > 20000) return json({ error: "总分析提示词最多 20000 字符" }, 400, cors);
      const temperature = Number(body.temperature);
      if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) return json({ error: "temperature 必须在 0 到 2 之间" }, 400, cors);
      const maxTokens = Number(body.maxTokens ?? 0);
      if (!Number.isInteger(maxTokens) || maxTokens < 0 || maxTokens > 32768) return json({ error: "最大输出 Token 必须为 0 到 32768 的整数，0 表示不指定" }, 400, cors);
      const newKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
      if (newKey.length > 1000) return json({ error: "API Key 长度无效" }, 400, cors);
      const current = data.settings || {};
      const next = { apiBaseUrl, model, temperature, maxTokens, prompts, updatedAt: new Date().toISOString() };
      if (body.clearSavedKey === true) {
        next.apiKey = ""; next.apiKeyMode = "worker";
      } else if (newKey) {
        next.apiKey = newKey; next.apiKeyMode = "custom";
      } else {
        next.apiKey = current.apiKey || ""; next.apiKeyMode = current.apiKeyMode || "worker";
      }
      data.settings = next;
      try { await writeData(env, data); } catch { return json({ error: "保存失败，请检查管理存储是否正常" }, 500, cors); }
      return json({ ok: true, settings: publicSettings(buildRuntimeSettings(data, env)) }, 200, cors);
    }
    if (url.pathname === "/admin/models" && request.method === "POST") {
      const runtime = buildRuntimeSettings(data, env);
      if (!runtime.apiKey || !runtime.apiBaseUrl) return json({ error: "请先设置 API 地址和密钥" }, 400, cors);
      let response;
      try {
        response = await fetch(runtime.apiBaseUrl.replace(/\/+$/, "") + "/models", {
          headers: { "Authorization": "Bearer " + runtime.apiKey, "Accept": "application/json" }, signal: AbortSignal.timeout(20000)
        });
      } catch { return json({ error: "无法连接模型列表接口，请检查 API 地址和网络" }, 502, cors); }
      let result;
      try { result = await response.json(); } catch { result = {}; }
      if (!response.ok) return json({ error: "获取模型列表失败（HTTP " + response.status + "）：" + String(result?.error?.message || result?.message || "当前供应商可能不支持 /models 接口").slice(0, 400) }, 502, cors);
      const list = Array.isArray(result.data) ? result.data : (Array.isArray(result.models) ? result.models : []);
      const models = [...new Set(list.map(item => typeof item === "string" ? item : item?.id).filter(item => typeof item === "string" && item.length > 0))].sort();
      return json({ models, count: models.length }, 200, cors);
    }
    if (url.pathname === "/admin/test" && request.method === "POST") {
      const runtime = buildRuntimeSettings(data, env);
      if (!runtime.apiKey || !runtime.apiBaseUrl || !runtime.model) return json({ error: "请先配置 API 地址、模型和 API Key" }, 400, cors);
      const start = Date.now();
      let response;
      try {
        response = await fetch(runtime.apiBaseUrl.replace(/\/+$/, "") + "/chat/completions", {
          method: "POST",
          headers: { "Authorization": "Bearer " + runtime.apiKey, "Content-Type": "application/json" },
          body: JSON.stringify({ model: runtime.model, messages: [{ role: "user", content: "请只回复：连接成功" }], temperature: 0, max_tokens: 20, stream: false }),
          signal: AbortSignal.timeout(25000)
        });
      } catch { return json({ ok: false, elapsedMs: Date.now() - start, error: "连接失败：无法连接模型服务，请检查地址和网络" }, 502, cors); }
      let result;
      try { result = await response.json(); } catch { result = {}; }
      const elapsedMs = Date.now() - start;
      if (!response.ok) return json({ ok: false, elapsedMs, error: "模型服务返回 HTTP " + response.status + "：" + String(result?.error?.message || result?.message || "请检查 API 地址、密钥和模型权限").slice(0, 500) }, 502, cors);
      return json({ ok: true, elapsedMs, model: result.model || runtime.model, preview: String(result?.choices?.[0]?.message?.content || "连接成功").slice(0, 300), usage: result.usage || null }, 200, cors);
    }
    return json({ error: "管理接口不存在" }, 404, cors);
  }
  return { readData, writeData, getRuntimeSettings, handleRoute, recordRequest };
}
