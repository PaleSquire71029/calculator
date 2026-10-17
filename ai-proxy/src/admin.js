const ADMIN_SESSION_TTL_MS = 4 * 60 * 60 * 1000;
const ADMIN_LOGIN_WINDOW_MS = 15 * 60 * 1000;
const ADMIN_LOGIN_MAX_ATTEMPTS = 8;
const LOCAL_RATE_BUCKETS = new Map();
const ENCRYPTED_KEY_PREFIX = "enc:v1:";

export async function readJsonLimited(request, maxBytes = 256 * 1024) {
  const declaredLength = request.headers.get("Content-Length");
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > maxBytes) {
    return { error: "请求体过大", status: 413 };
  }
  if (!request.body) return { error: "请求格式错误：缺少 JSON 请求体", status: 400 };
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        return { error: "请求体过大", status: 413 };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { error: "请求 JSON 必须是对象", status: 400 };
    }
    return { data };
  } catch {
    return { error: "请求不是有效的 JSON", status: 400 };
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

function encryptionSecrets(env) {
  return [...new Set([env.ADMIN_ENCRYPTION_KEY, env.ADMIN_SESSION_SECRET, env.ADMIN_PASSWORD]
    .filter(value => typeof value === "string" && value.length > 0))];
}

async function importEncryptionKey(secret) {
  const material = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("zhixing-ai-key-encryption-v1\0" + secret));
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptApiKey(value, env) {
  const secret = encryptionSecrets(env)[0];
  if (!secret) throw new Error("缺少 ADMIN_ENCRYPTION_KEY 或其他可用的管理密钥，无法安全保存 API Key");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importEncryptionKey(secret);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(value)
  ));
  return ENCRYPTED_KEY_PREFIX + encodeBase64Url(iv) + "." + encodeBase64Url(encrypted);
}

async function decryptApiKey(value, env) {
  if (typeof value !== "string" || !value.startsWith(ENCRYPTED_KEY_PREFIX)) return String(value || "");
  const parts = value.slice(ENCRYPTED_KEY_PREFIX.length).split(".");
  if (parts.length !== 2) throw new Error("自定义 API Key 的加密数据格式无效");
  const iv = decodeBase64Url(parts[0]);
  const ciphertext = decodeBase64Url(parts[1]);
  for (const secret of encryptionSecrets(env)) {
    try {
      const key = await importEncryptionKey(secret);
      const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
      return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    } catch {}
  }
  throw new Error("无法解密自定义 API Key。请检查管理加密密钥是否被轮换；如已丢失原密钥，请重新保存模型 API Key。");
}

export function normalizeApiBaseUrl(value) {
  let url;
  try { url = new URL(String(value || "").trim()); }
  catch { throw new Error("API 地址不是有效的网址"); }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("API 地址必须使用 HTTPS，且不能包含账号密码");
  }
  if (url.port) throw new Error("API 地址暂不允许自定义端口，请使用标准 HTTPS 端口");
  const host = url.hostname.toLowerCase().replace(/^\\[|\\]$/g, "").replace(/\\.$/, "");
  const isIPv4 = /^(?:\\d{1,3}\\.){3}\\d{1,3}$/.test(host);
  const isIPv6 = host.includes(":");
  if (isIPv4 || isIPv6 || !host.includes(".")) {
    throw new Error("API 地址必须使用公开的 HTTPS 域名，不接受 IP 地址或单段主机名");
  }
  const blockedSuffixes = [
    ".localhost", ".local", ".internal", ".lan", ".home", ".home.arpa",
    ".test", ".invalid", ".example"
  ];
  if (host === "localhost" || blockedSuffixes.some(suffix => host.endsWith(suffix))) {
    throw new Error("API 地址不能指向本机或内网域名");
  }
  url.pathname = url.pathname.replace(/\\/+(chat\\/completions|models)\\/?$/i, "").replace(/\\/+$/, "") || "/";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\\/$/, "");
}

export async function readResponseTextLimited(response, maxBytes = 2 * 1024 * 1024) {
  const declaredLength = response.headers.get("Content-Length");
  if (declaredLength && /^\\d+$/.test(declaredLength) && Number(declaredLength) > maxBytes) {
    try { await response.body?.cancel(); } catch {}
    return { error: "上游响应体过大" };
  }
  if (!response.body) return { text: "" };
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        return { error: "上游响应体过大" };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { error: "无法读取上游响应" };
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

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
export class AdminSettingsStore {
  constructor(state, env) { this.state = state; this.env = env; }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/rate-limit") {
      if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
      const parsed = await readJsonLimited(request, 4096);
      if (parsed.error) return json({ error: parsed.error }, parsed.status);
      const { key, limit, windowMs } = parsed.data;
      if (typeof key !== "string" || key.length < 1 || key.length > 512 ||
          !Number.isInteger(limit) || limit < 1 || limit > 10000 ||
          !Number.isInteger(windowMs) || windowMs < 1000 || windowMs > 86400000) {
        return json({ error: "Invalid rate limit parameters" }, 400);
      }
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
      const storageKey = "rl:" + encodeBase64Url(new Uint8Array(digest));
      const now = Date.now();
      const bucket = await this.state.storage.transaction(async txn => {
        let entry = await txn.get(storageKey);
        if (!entry || now < entry.start || now - entry.start >= windowMs) {
          entry = { start: now, count: 0, expiresAt: now + windowMs };
        }
        entry.count += 1;
        await txn.put(storageKey, entry);
        return { allowed: entry.count <= limit, retryAfter: Math.max(1, Math.ceil((entry.expiresAt - now) / 1000)), expiresAt: entry.expiresAt };
      });
      const alarmAt = bucket.expiresAt + 1000;
      const currentAlarm = await this.state.storage.getAlarm();
      if (currentAlarm === null || currentAlarm > alarmAt) await this.state.storage.setAlarm(alarmAt);
      return json({ allowed: bucket.allowed, retryAfter: bucket.retryAfter });
    }
    if (url.pathname !== "/data") return json({ error: "Not found" }, 404);
    if (request.method === "GET") return json((await this.state.storage.get("adminData")) || {});
    if (request.method !== "PUT") return json({ error: "Method not allowed" }, 405);
    const parsed = await readJsonLimited(request, 1024 * 1024);
    if (parsed.error) return json({ error: parsed.error }, parsed.status);
    await this.state.storage.put("adminData", parsed.data);
    return json({ ok: true });
  }
  async alarm() {
    const now = Date.now();
    const records = await this.state.storage.list({ prefix: "rl:" });
    let nextAlarm = Infinity;
    for (const [key, value] of records) {
      if (!value || Number(value.expiresAt) <= now) await this.state.storage.delete(key);
      else nextAlarm = Math.min(nextAlarm, Number(value.expiresAt) + 1000);
    }
    if (Number.isFinite(nextAlarm)) await this.state.storage.setAlarm(nextAlarm);
  }
}
export function createAdminModule({ getAllowedOrigins, defaultPrompts }) {
  async function readData(env) {
    if (!env.ADMIN_STORE) return null;
    const stub = env.ADMIN_STORE.get(env.ADMIN_STORE.idFromName("settings-v1"));
    const response = await stub.fetch("https://admin-store.internal/data");
    if (!response.ok) throw new Error("无法读取管理设置存储");
    const data = await response.json();
    // Migrate older plaintext custom keys to authenticated AES-GCM ciphertext on first read.
    const savedKey = data?.settings?.apiKey;
    if (data?.settings?.apiKeyMode === "custom" && typeof savedKey === "string" &&
        savedKey.length > 0 && !savedKey.startsWith(ENCRYPTED_KEY_PREFIX)) {
      data.settings.apiKey = await encryptApiKey(savedKey, env);
      await writeData(env, data);
    }
    return data;
  }
  async function writeData(env, data) {
    if (!env.ADMIN_STORE) throw new Error("管理设置存储未绑定");
    const stub = env.ADMIN_STORE.get(env.ADMIN_STORE.idFromName("settings-v1"));
    const response = await stub.fetch("https://admin-store.internal/data", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data)
    });
    if (!response.ok) throw new Error("无法保存管理设置");
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
  async function buildRuntimeSettings(data, env) {
    const saved = data?.settings || {};
    const defaults = defaultPrompts();
    const stored = saved.prompts || {};
    const apiKey = saved.apiKeyMode === "custom" && saved.apiKey
      ? await decryptApiKey(saved.apiKey, env)
      : (env.AI_API_KEY || "");
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
    return await buildRuntimeSettings(await readData(env), env);
  }

  async function checkRateLimit(env, key, limit, windowMs) {
    if (env.ADMIN_STORE) {
      try {
        const stub = env.ADMIN_STORE.get(env.ADMIN_STORE.idFromName("settings-v1"));
        const response = await stub.fetch("https://admin-store.internal/rate-limit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key, limit, windowMs })
        });
        if (!response.ok) return { allowed: false, unavailable: true, retryAfter: 60 };
        return await response.json();
      } catch {
        return { allowed: false, unavailable: true, retryAfter: 60 };
      }
    }
    // Development fallback only: local maps can reset or differ between isolates.
    const now = Date.now();
    const previous = LOCAL_RATE_BUCKETS.get(key);
    let entry = previous;
    if (!entry || now < entry.start || now - entry.start >= windowMs) entry = { start: now, count: 0 };
    entry.count += 1;
    LOCAL_RATE_BUCKETS.set(key, entry);
    if (LOCAL_RATE_BUCKETS.size > 5000) {
      for (const [bucketKey, bucket] of LOCAL_RATE_BUCKETS) {
        if (now < bucket.start || now - bucket.start >= windowMs) LOCAL_RATE_BUCKETS.delete(bucketKey);
      }
    }
    return { allowed: entry.count <= limit, retryAfter: Math.max(1, Math.ceil((entry.start + windowMs - now) / 1000)) };
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
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const rate = await checkRateLimit(env, "admin-login:" + ip, ADMIN_LOGIN_MAX_ATTEMPTS, ADMIN_LOGIN_WINDOW_MS);
      if (rate.unavailable) return json({ error: "安全限流存储暂时不可用，请稍后重试。" }, 503, cors);
      if (!rate.allowed) return json({ error: "登录尝试过多，请 15 分钟后再试。" }, 429, { ...cors, "Retry-After": String(rate.retryAfter) });
      const parsed = await readJsonLimited(request, 8192);
      if (parsed.error) return json({ error: parsed.error }, parsed.status, cors);
      if (typeof parsed.data.password !== "string" || !safeEqual(parsed.data.password, env.ADMIN_PASSWORD)) return json({ error: "管理密码不正确" }, 401, cors);
      return json({ token: await createToken(env), expiresIn: ADMIN_SESSION_TTL_MS }, 200, cors);
    }
    if (!await verifyToken(request, env)) return json({ error: "管理会话已失效，请重新登录" }, 401, cors);
    if (url.pathname === "/admin/defaults" && request.method === "GET") return json(defaultPrompts(), 200, cors);
    if (!env.ADMIN_STORE) return json({ error: "管理设置存储尚未部署，请检查 Worker 的 Durable Object 绑定" }, 503, cors);
    let data;
    try { data = await readData(env) || {}; } catch { return json({ error: "读取管理数据失败，请稍后重试" }, 500, cors); }
    if (url.pathname === "/admin/settings" && request.method === "GET") {
      try { return json(publicSettings(await buildRuntimeSettings(data, env)), 200, cors); }
      catch { return json({ error: "无法读取加密的 API Key。请检查加密密钥设置；若原密钥已丢失，需要重新保存 API Key。" }, 503, cors); }
    }
    if (url.pathname === "/admin/settings" && request.method === "PUT") {
      const parsed = await readJsonLimited(request, 256 * 1024);
      if (parsed.error) return json({ error: parsed.error }, parsed.status, cors);
      const body = parsed.data;
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
        try { next.apiKey = await encryptApiKey(newKey, env); }
        catch { return json({ error: "无法加密保存 API Key。请在 Worker Secrets 中配置 ADMIN_ENCRYPTION_KEY（推荐）或 ADMIN_SESSION_SECRET。" }, 503, cors); }
        next.apiKeyMode = "custom";
      } else {
        next.apiKey = current.apiKey || ""; next.apiKeyMode = current.apiKeyMode || "worker";
      }
      data.settings = next;
      try { await writeData(env, data); } catch { return json({ error: "保存失败，请检查管理存储是否正常" }, 500, cors); }
      try { return json({ ok: true, settings: publicSettings(await buildRuntimeSettings(data, env)) }, 200, cors); }
      catch { return json({ error: "设置已保存，但无法解密 API Key。请检查加密密钥设置。" }, 503, cors); }
    }
    if (url.pathname === "/admin/models" && request.method === "POST") {
      let runtime;
      try { runtime = await buildRuntimeSettings(data, env); }
      catch { return json({ error: "无法解密已保存的 API Key，请检查加密密钥设置。" }, 503, cors); }
      const parsed = await readJsonLimited(request, 16384);
      if (parsed.error) return json({ error: parsed.error }, parsed.status, cors);
      const input = parsed.data;
      let apiBaseUrl = runtime.apiBaseUrl;
      try { if (input.apiBaseUrl) apiBaseUrl = normalizeApiBaseUrl(input.apiBaseUrl); }
      catch (error) { return json({ error: error.message }, 400, cors); }
      const apiKey = typeof input.apiKey === "string" && input.apiKey.trim() ? input.apiKey.trim() : runtime.apiKey;
      if (!apiKey || !apiBaseUrl) return json({ error: "请先设置 API 地址和密钥" }, 400, cors);
      let response;
      try {
        response = await fetch(apiBaseUrl.replace(/\/+$/, "") + "/models", {
          headers: { "Authorization": "Bearer " + apiKey, "Accept": "application/json" },
          redirect: "error",
          signal: AbortSignal.timeout(20000)
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
      let runtime;
      try { runtime = await buildRuntimeSettings(data, env); }
      catch { return json({ error: "无法解密已保存的 API Key，请检查加密密钥设置。" }, 503, cors); }
      const parsed = await readJsonLimited(request, 16384);
      if (parsed.error) return json({ error: parsed.error }, parsed.status, cors);
      const input = parsed.data;
      let apiBaseUrl = runtime.apiBaseUrl;
      try { if (input.apiBaseUrl) apiBaseUrl = normalizeApiBaseUrl(input.apiBaseUrl); }
      catch (error) { return json({ error: error.message }, 400, cors); }
      const apiKey = typeof input.apiKey === "string" && input.apiKey.trim() ? input.apiKey.trim() : runtime.apiKey;
      const model = String(input.model || runtime.model || "").trim();
      if (!apiKey || !apiBaseUrl || !model) return json({ error: "请先配置 API 地址、模型和 API Key" }, 400, cors);
      const start = Date.now();
      let response;
      try {
        response = await fetch(apiBaseUrl.replace(/\/+$/, "") + "/chat/completions", {
          method: "POST",
          headers: { "Authorization": "Bearer " + apiKey, "Content-Type": "application/json" },
          body: JSON.stringify({ model, messages: [{ role: "user", content: "请只回复：连接成功" }], temperature: 0, max_tokens: 20, stream: false }),
          redirect: "error",
          signal: AbortSignal.timeout(25000)
        });
      } catch { return json({ ok: false, elapsedMs: Date.now() - start, error: "连接失败：无法连接模型服务，请检查地址和网络" }, 502, cors); }
      let result;
      try { result = await response.json(); } catch { result = {}; }
      const elapsedMs = Date.now() - start;
      if (!response.ok) return json({ ok: false, elapsedMs, error: "模型服务返回 HTTP " + response.status + "：" + String(result?.error?.message || result?.message || "请检查 API 地址、密钥和模型权限").slice(0, 500) }, 502, cors);
      return json({ ok: true, elapsedMs, model: result.model || model, preview: String(result?.choices?.[0]?.message?.content || "连接成功").slice(0, 300), usage: result.usage || null }, 200, cors);
    }
    return json({ error: "管理接口不存在" }, 404, cors);
  }
  return { readData, writeData, getRuntimeSettings, handleRoute, recordRequest, checkRateLimit };
}
