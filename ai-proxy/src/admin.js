import { handleCloudAdminDataRoute } from "./cloud-admin.js";
const ADMIN_SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const ADMIN_LOGIN_WINDOW_MS = 15 * 60 * 1000;
const ADMIN_LOGIN_MAX_ATTEMPTS = 8;
const ENCRYPTED_KEY_PREFIX = "enc:v1:";
const EMPTY_STATS = () => ({ totalRequests: 0, failedRequests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, recent: [] });
function normalizeAppId(value) { return value === "zhixing-ai" ? "zhixing-ai" : "learning"; }
function readProfile(data, appId) {
  const key = normalizeAppId(appId);
  const profile = data?.apps?.[key];
  if (profile && typeof profile === "object") return profile;
  if (key === "learning") return { settings: data?.settings || {}, stats: data?.stats || EMPTY_STATS() };
  // Bootstrap the newly separated Zhixing AI profile from the existing shared API connection once.
  // Keep prompt defaults app-specific and statistics isolated; the first write persists an independent profile.
  const legacySettings = data?.settings && typeof data.settings === "object" && !Array.isArray(data.settings) ? { ...data.settings } : {};
  delete legacySettings.prompts;
  return { settings: legacySettings, stats: EMPTY_STATS() };
}
function writeProfile(data, appId, profile) {
  const key = normalizeAppId(appId);
  if (!data.apps || typeof data.apps !== "object" || Array.isArray(data.apps)) data.apps = {};
  data.apps[key] = profile;
  if (key === "learning") {
    data.settings = profile.settings || {};
    data.stats = profile.stats || EMPTY_STATS();
  }
}

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

async function decryptApiKeyDetails(value, env) {
  if (typeof value !== "string" || !value.startsWith(ENCRYPTED_KEY_PREFIX)) {
    return { value: String(value || ""), secretIndex: -1 };
  }
  const parts = value.slice(ENCRYPTED_KEY_PREFIX.length).split(".");
  if (parts.length !== 2) throw new Error("自定义 API Key 的加密数据格式无效");
  const iv = decodeBase64Url(parts[0]);
  const ciphertext = decodeBase64Url(parts[1]);
  const secrets = encryptionSecrets(env);
  for (let secretIndex = 0; secretIndex < secrets.length; secretIndex++) {
    try {
      const key = await importEncryptionKey(secrets[secretIndex]);
      const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
      return { value: new TextDecoder("utf-8", { fatal: true }).decode(plaintext), secretIndex };
    } catch {}
  }
  throw new Error("无法解密自定义 API Key。请检查管理加密密钥是否被轮换；如已丢失原密钥，请重新保存模型 API Key。");
}

async function decryptApiKey(value, env) {
  return (await decryptApiKeyDetails(value, env)).value;
}

export function normalizeApiBaseUrl(value) {
  let url;
  try { url = new URL(String(value || "").trim()); }
  catch { throw new Error("API 地址不是有效的网址"); }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("API 地址必须使用 HTTPS，且不能包含账号密码");
  }
  if (url.port) throw new Error("API 地址暂不允许自定义端口，请使用标准 HTTPS 端口");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const isIPv4 = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host);
  const numericHost = /^[0-9.]+$/.test(host);
  const isIPv6 = host.includes(":");
  // WHATWG URL parsers normalize legacy numeric IPv4 spellings such as 127.1.
  if (isIPv4 || numericHost || isIPv6 || !host.includes(".")) {
    throw new Error("API 地址必须使用公开的 HTTPS 域名，不接受 IP 地址或单段主机名");
  }
  const blockedSuffixes = [
    ".localhost", ".local", ".internal", ".lan", ".home", ".home.arpa",
    ".test", ".invalid", ".example"
  ];
  if (host === "localhost" || blockedSuffixes.some(suffix => host.endsWith(suffix))) {
    throw new Error("API 地址不能指向本机或内网域名");
  }
  url.pathname = url.pathname.replace(/\/+(chat\/completions|models)\/?$/i, "").replace(/\/+$/, "") || "/";
  if (host === "api.a6api.com" && url.pathname === "/") url.pathname = "/v1";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export async function readResponseTextLimited(response, maxBytes = 2 * 1024 * 1024) {
  const declaredLength = response.headers.get("Content-Length");
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > maxBytes) {
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

function describeFetchFailure(error, apiKey = "") {
  const cause = error && typeof error === "object" ? error.cause : null;
  let detail = String(cause?.code || cause?.message || error?.message || error?.name || "未知网络错误")
    .replace(/\s+/g, " ").slice(0, 180);
  if (apiKey) detail = detail.split(apiKey).join("[已隐藏]");
  detail = detail.replace(/Bearer\s+\S+/gi, "Bearer [已隐藏]");
  return detail || "未知网络错误";
}

const API_SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer"
};
function sanitizeProviderText(value, apiKey = "", maxLength = 400) {
  let message = String(value ?? "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  if (apiKey) message = message.split(apiKey).join("[已隐藏]");
  message = message
    .replace(/Bearer\s+\S+/gi, "Bearer [已隐藏]")
    .replace(/(api[_ -]?key|token|secret)(\s*[:=]\s*)["']?[^,\s"'<>]{8,}/gi, "$1$2[已隐藏]");
  return message.slice(0, maxLength);
}
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...API_SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8", ...headers }
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
  const password = String(env.ADMIN_PASSWORD || "");
  const configuredSessionSecret = String(env.ADMIN_SESSION_SECRET || "");
  // Bind sessions to both secrets: changing the admin password revokes old tokens even
  // when ADMIN_SESSION_SECRET is configured separately. The password is never placed in the token.
  const secret = configuredSessionSecret
    ? configuredSessionSecret + "\0" + password
    : password;
  if (!password || !secret) throw new Error("未设置管理会话签名密钥或管理密码");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return encodeBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))));
}
async function createToken(env, appId = "learning", role = "admin") {
  const payload = encodeBase64Url(new TextEncoder().encode(JSON.stringify({
    role,
    app: normalizeAppId(appId),
    exp: Date.now() + ADMIN_SESSION_TTL_MS
  })));
  return payload + "." + await signPayload(payload, env);
}
async function verifyToken(request, env, appId = "learning", expectedRole = "admin") {
  const match = (request.headers.get("Authorization") || "").match(/^Bearer\s+([A-Za-z0-9_.-]+)$/i);
  if (!match || match[1].length > 2048 || !env.ADMIN_PASSWORD) return false;
  const parts = match[1].split(".");
  if (parts.length !== 2) return false;
  try {
    if (!safeEqual(await signPayload(parts[0], env), parts[1])) return false;
    const payload = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[0])));
    return payload.role === expectedRole &&
      payload.app === normalizeAppId(appId) &&
      Number(payload.exp) > Date.now();
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
      // Keyed digest keeps client IPs from being trivially recovered from stored rate-limit keys.
      const rateSecret = String(this.env?.ADMIN_ENCRYPTION_KEY || this.env?.ADMIN_SESSION_SECRET || this.env?.ADMIN_PASSWORD || "");
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rateSecret + "\0" + key));
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
    if (url.pathname === "/cloud-audit") {
      if (request.method === "GET") {
        const entries = await this.state.storage.get("cloudAudit");
        return json(Array.isArray(entries) ? entries : []);
      }
      if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
      const parsed = await readJsonLimited(request, 4096);
      if (parsed.error) return json({ error: parsed.error }, parsed.status);
      const input = parsed.data;
      const actions = new Set(["delete_conversation", "delete_selected", "delete_user_data", "cleanup_90d", "create_account"]);
      if (!actions.has(input.action) ||
          !["zhixing-ai", "learning", "all"].includes(input.app) ||
          !Number.isInteger(input.affectedCount) || input.affectedCount < 0 || input.affectedCount > 1000000) {
        return json({ error: "Invalid cloud audit entry" }, 400);
      }
      const entry = {
        id: crypto.randomUUID(),
        at: new Date().toISOString(),
        action: input.action,
        app: input.app,
        affectedCount: input.affectedCount
      };
      const previous = await this.state.storage.get("cloudAudit");
      await this.state.storage.put("cloudAudit", [entry, ...(Array.isArray(previous) ? previous : [])].slice(0, 200));
      return json({ ok: true, entry });
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
    const response = await stub.fetch("https://admin-store.internal/data", {
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) throw new Error("无法读取管理设置存储");
    const data = await response.json();
    // Migrate legacy and profile-specific custom keys to authenticated AES-GCM ciphertext.
    const settingsToCheck = [
      data?.settings,
      ...Object.values(data?.apps || {}).map(profile => profile?.settings)
    ].filter(settings => settings && typeof settings === "object");
    let changed = false;
    for (const settings of settingsToCheck) {
      const savedKey = settings.apiKey;
      if (settings.apiKeyMode !== "custom" || typeof savedKey !== "string" || !savedKey) continue;
      if (!savedKey.startsWith(ENCRYPTED_KEY_PREFIX)) {
        settings.apiKey = await encryptApiKey(savedKey, env);
        changed = true;
      } else {
        const decrypted = await decryptApiKeyDetails(savedKey, env);
        if (decrypted.secretIndex > 0) {
          settings.apiKey = await encryptApiKey(decrypted.value, env);
          changed = true;
        }
      }
    }
    if (changed) await writeData(env, data);
    return data;
  }
  async function writeData(env, data) {
    if (!env.ADMIN_STORE) throw new Error("管理设置存储未绑定");
    const stub = env.ADMIN_STORE.get(env.ADMIN_STORE.idFromName("settings-v1"));
    const response = await stub.fetch("https://admin-store.internal/data", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(8000)
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
  async function buildRuntimeSettings(data, env, appId = "learning") {
    const profile = readProfile(data, appId);
    const saved = profile.settings || {};
    const defaults = defaultPrompts(normalizeAppId(appId));
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
      stats: profile.stats || EMPTY_STATS()
    };
  }
  function publicSettings(runtime) {
    return {
      apiBaseUrl: runtime.apiBaseUrl, model: runtime.model, hasApiKey: runtime.hasApiKey,
      apiKeySource: runtime.apiKeySource, temperature: runtime.temperature, maxTokens: runtime.maxTokens,
      prompts: runtime.prompts, updatedAt: runtime.updatedAt, stats: runtime.stats
    };
  }
  async function getRuntimeSettings(env, appId = "learning") {
    return await buildRuntimeSettings(await readData(env), env, normalizeAppId(appId));
  }

  async function checkRateLimit(env, key, limit, windowMs) {
    // Never silently fall back to isolate-local counters: production abuse controls must fail closed.
    if (!env.ADMIN_STORE) return { allowed: false, unavailable: true, retryAfter: 60 };
    try {
      const stub = env.ADMIN_STORE.get(env.ADMIN_STORE.idFromName("settings-v1"));
      const response = await stub.fetch("https://admin-store.internal/rate-limit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, limit, windowMs }),
        signal: AbortSignal.timeout(8000)
      });
      if (!response.ok) return { allowed: false, unavailable: true, retryAfter: 60 };
      const result = await response.json();
      if (typeof result.allowed !== "boolean") return { allowed: false, unavailable: true, retryAfter: 60 };
      return result;
    } catch {
      return { allowed: false, unavailable: true, retryAfter: 60 };
    }
  }
  async function recordRequest(env, event, appId = event?.appId || "learning") {
    try {
      const data = await readData(env);
      if (!data) return;
      const profile = readProfile(data, appId);
      const stats = profile.stats || EMPTY_STATS();
      stats.totalRequests = (stats.totalRequests || 0) + 1;
      if (!event.ok) stats.failedRequests = (stats.failedRequests || 0) + 1;
      const toTokenCount = value => {
        const number = Number(value ?? 0);
        return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
      };
      const usage = event.usage && typeof event.usage === "object" ? event.usage : null;
      const promptTokens = toTokenCount(usage?.prompt_tokens ?? usage?.input_tokens ?? usage?.promptTokens);
      const completionTokens = toTokenCount(usage?.completion_tokens ?? usage?.output_tokens ?? usage?.completionTokens);
      const reportedTotal = toTokenCount(usage?.total_tokens ?? usage?.totalTokens);
      const totalTokens = reportedTotal || promptTokens + completionTokens;
      if (usage) {
        stats.promptTokens = (stats.promptTokens || 0) + promptTokens;
        stats.completionTokens = (stats.completionTokens || 0) + completionTokens;
        stats.totalTokens = (stats.totalTokens || 0) + totalTokens;
      }
      stats.recent = [{
        at: new Date().toISOString(),
        mode: String(event.mode || "unknown").slice(0, 80),
        ok: Boolean(event.ok),
        status: Number.isFinite(Number(event.status)) ? Number(event.status) : 0,
        model: String(event.model || "").slice(0, 200),
        promptTokens,
        completionTokens,
        totalTokens,
        usageAvailable: Boolean(usage),
        // Client IP comes from Cloudflare's edge header, never from a client-supplied field.
        ip: String(event.clientIp || "unknown").slice(0, 80),
        origin: String(event.origin || "").slice(0, 200),
        userAgent: String(event.userAgent || "").slice(0, 220),
        durationMs: Math.max(0, Math.min(900000, Math.floor(Number(event.durationMs) || 0)))
      }, ...(stats.recent || [])].slice(0, 500);
      profile.stats = stats;
      writeProfile(data, appId, profile);
      await writeData(env, data);
    } catch { /* 统计不能中断主请求 */ }
  }
  async function handleRoute(request, env, url, cors) {
    const appId = normalizeAppId(url.searchParams.get("app"));
    const origin = request.headers.get("Origin") || "";
    if (!origin || !getAllowedOrigins(env).includes(origin)) return json({ error: "该网页来源未获授权" }, 403, cors);
    if (["POST", "PUT", "PATCH"].includes(request.method) &&
        !/^application\/json(?:\s*;|$)/i.test(request.headers.get("Content-Type") || "")) {
      return json({ error: "请求必须使用 application/json 格式。" }, 415, cors);
    }
    const isLoginRoute = request.method === "POST" &&
      (url.pathname === "/admin/login" || url.pathname === "/admin/login/all" || url.pathname === "/admin/cloud/login");
    if (!isLoginRoute) {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const rate = await checkRateLimit(env, "admin-auth:" + ip, 120, 60 * 1000);
      if (rate.unavailable) return json({ error: "安全限流存储暂时不可用，请稍后重试。" }, 503, cors);
      if (!rate.allowed) return json({ error: "管理接口请求过于频繁，请稍后再试。" }, 429, { ...cors, "Retry-After": String(rate.retryAfter) });
    }
    if (url.pathname === "/admin/login/all" && request.method === "POST") {
      if (!env.ADMIN_PASSWORD) return json({ error: "尚未配置管理密码。请在 Cloudflare Worker → Settings → Variables and Secrets 中添加 Secret：ADMIN_PASSWORD。" }, 503, cors);
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const rate = await checkRateLimit(env, "admin-login:" + ip, ADMIN_LOGIN_MAX_ATTEMPTS, ADMIN_LOGIN_WINDOW_MS);
      if (rate.unavailable) return json({ error: "安全限流存储暂时不可用，请稍后重试。" }, 503, cors);
      if (!rate.allowed) return json({ error: "登录尝试过多，请 15 分钟后再试。" }, 429, { ...cors, "Retry-After": String(rate.retryAfter) });
      const parsed = await readJsonLimited(request, 8192);
      if (parsed.error) return json({ error: parsed.error }, parsed.status, cors);
      if (typeof parsed.data.password !== "string" || !safeEqual(parsed.data.password, env.ADMIN_PASSWORD)) return json({ error: "管理密码不正确" }, 401, cors);
      return json({
        tokens: {
          "zhixing-ai": await createToken(env, "zhixing-ai"),
          learning: await createToken(env, "learning"),
          cloud: await createToken(env, "learning", "cloud-admin")
        },
        expiresIn: ADMIN_SESSION_TTL_MS
      }, 200, cors);
    }
    if (url.pathname === "/admin/login" && request.method === "POST") {
      if (!env.ADMIN_PASSWORD) return json({ error: "尚未配置管理密码。请在 Cloudflare Worker → Settings → Variables and Secrets 中添加 Secret：ADMIN_PASSWORD。" }, 503, cors);
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const rate = await checkRateLimit(env, "admin-login:" + ip, ADMIN_LOGIN_MAX_ATTEMPTS, ADMIN_LOGIN_WINDOW_MS);
      if (rate.unavailable) return json({ error: "安全限流存储暂时不可用，请稍后重试。" }, 503, cors);
      if (!rate.allowed) return json({ error: "登录尝试过多，请 15 分钟后再试。" }, 429, { ...cors, "Retry-After": String(rate.retryAfter) });
      const parsed = await readJsonLimited(request, 8192);
      if (parsed.error) return json({ error: parsed.error }, parsed.status, cors);
      if (typeof parsed.data.password !== "string" || !safeEqual(parsed.data.password, env.ADMIN_PASSWORD)) return json({ error: "管理密码不正确" }, 401, cors);
      return json({ token: await createToken(env, appId), expiresIn: ADMIN_SESSION_TTL_MS }, 200, cors);
    }
    if (url.pathname === "/admin/cloud/login" && request.method === "POST") {
      if (!env.ADMIN_PASSWORD) return json({ error: "尚未配置管理密码。" }, 503, cors);
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const rate = await checkRateLimit(env, "admin-login:" + ip, ADMIN_LOGIN_MAX_ATTEMPTS, ADMIN_LOGIN_WINDOW_MS);
      if (rate.unavailable) return json({ error: "安全限流存储暂时不可用，请稍后重试。" }, 503, cors);
      if (!rate.allowed) return json({ error: "登录尝试过多，请 15 分钟后再试。" }, 429, { ...cors, "Retry-After": String(rate.retryAfter) });
      const parsed = await readJsonLimited(request, 8192);
      if (parsed.error) return json({ error: parsed.error }, parsed.status, cors);
      if (typeof parsed.data.password !== "string" || !safeEqual(parsed.data.password, env.ADMIN_PASSWORD)) return json({ error: "管理密码不正确。" }, 401, cors);
      return json({ token: await createToken(env, "learning", "cloud-admin"), expiresIn: ADMIN_SESSION_TTL_MS }, 200, cors);
    }
    const cloudAdminRoute = url.pathname.startsWith("/admin/cloud/");
    if (!await verifyToken(request, env, cloudAdminRoute ? "learning" : appId, cloudAdminRoute ? "cloud-admin" : "admin")) {
      return json({ error: "管理会话已失效或无权访问，请重新登录。" }, 401, cors);
    }
    if (cloudAdminRoute) return await handleCloudAdminDataRoute(request, env, url, cors);
    if (url.pathname === "/admin/defaults" && request.method === "GET") return json(defaultPrompts(appId), 200, cors);
    if (!env.ADMIN_STORE) return json({ error: "管理设置存储尚未部署，请检查 Worker 的 Durable Object 绑定" }, 503, cors);
    let data;
    try { data = await readData(env) || {}; } catch { return json({ error: "读取管理数据失败，请稍后重试" }, 500, cors); }
    if (url.pathname === "/admin/settings" && request.method === "GET") {
      try { return json(publicSettings(await buildRuntimeSettings(data, env, appId)), 200, cors); }
      catch { return json({ error: "无法读取加密的 API Key。请检查加密密钥设置；若原密钥已丢失，需要重新保存 API Key。" }, 503, cors); }
    }
    if (url.pathname === "/admin/key/reveal" && request.method === "POST") {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const rate = await checkRateLimit(env, "admin-key-reveal:" + ip, 8, 15 * 60 * 1000);
      if (rate.unavailable) return json({ error: "安全限流存储暂时不可用，请稍后重试。" }, 503, cors);
      if (!rate.allowed) return json({ error: "Token 查看次数过多，请稍后再试。" }, 429, { ...cors, "Retry-After": String(rate.retryAfter) });
      const parsed = await readJsonLimited(request, 4096);
      if (parsed.error) return json({ error: parsed.error }, parsed.status, cors);
      if (parsed.data.confirm !== "REVEAL_KEY") return json({ error: "请在管理页面点击“查看已保存 Token”后重试。" }, 400, cors);
      let runtime;
      try { runtime = await buildRuntimeSettings(data, env, appId); }
      catch { return json({ error: "无法读取已保存的 Token，请检查加密密钥设置。" }, 503, cors); }
      if (!runtime.apiKey) return json({ error: "当前没有已配置的 API Token。" }, 404, cors);
      return json({ apiKey: runtime.apiKey, source: runtime.apiKeySource }, 200, cors);
    }
    if (url.pathname === "/admin/balance" && request.method === "POST") {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const rate = await checkRateLimit(env, "admin-balance:" + ip, 12, 15 * 60 * 1000);
      if (rate.unavailable) return json({ error: "安全限流存储暂时不可用，请稍后重试。" }, 503, cors);
      if (!rate.allowed) return json({ error: "余额查询过于频繁，请稍后再试。" }, 429, { ...cors, "Retry-After": String(rate.retryAfter) });
      const parsed = await readJsonLimited(request, 16384);
      if (parsed.error) return json({ error: parsed.error }, parsed.status, cors);
      let runtime;
      try { runtime = await buildRuntimeSettings(data, env, appId); }
      catch { return json({ error: "无法读取已保存的 API Token，请检查加密密钥设置。" }, 503, cors); }
      let apiBaseUrl;
      try { apiBaseUrl = normalizeApiBaseUrl(parsed.data.apiBaseUrl || runtime.apiBaseUrl); }
      catch (error) { return json({ error: error.message }, 400, cors); }
      const apiKey = typeof parsed.data.apiKey === "string" && parsed.data.apiKey.trim()
        ? parsed.data.apiKey.trim() : runtime.apiKey;
      if (!apiKey) return json({ error: "请先配置 API Token。" }, 400, cors);
      if (new URL(apiBaseUrl).hostname.toLowerCase() !== "api.a6api.com") {
        return json({ error: "当前不是 A6API API 地址。余额查询仅支持 https://api.a6api.com/v1；请先切换服务商或手动查看其他服务商的控制台。" }, 400, cors);
      }
      const headers = { "Authorization": "Bearer " + apiKey, "Accept": "application/json" };
      let subscriptionResponse, tokenResponse;
      // Cloudflare Workers do not support redirect:"error"; "manual" avoids forwarding credentials,
      // and the explicit 3xx check below rejects redirects without contacting their destinations.
      try {
        [subscriptionResponse, tokenResponse] = await Promise.all([
          fetch("https://api.a6api.com/dashboard/billing/subscription", {
            headers, redirect: "manual", signal: AbortSignal.timeout(12000)
          }),
          fetch("https://api.a6api.com/api/usage/token/", {
            headers, redirect: "manual", signal: AbortSignal.timeout(12000)
          })
        ]);
      } catch (error) {
        return json({
          error: "连接 A6API 额度接口失败。网络原因：" + describeFetchFailure(error, apiKey) +
            "。请求已固定到官方 API 主机，且不会跟随重定向。"
        }, 502, cors);
      }
      if ((subscriptionResponse.status >= 300 && subscriptionResponse.status < 400) ||
          (tokenResponse.status >= 300 && tokenResponse.status < 400)) {
        const redirectStatus = subscriptionResponse.status >= 300 && subscriptionResponse.status < 400
          ? subscriptionResponse.status : tokenResponse.status;
        return json({
          error: "A6API 额度接口返回重定向（HTTP " + redirectStatus +
            "）。为保护 API Token，Worker 不会跟随重定向。请检查 A6API 接口地址或服务商配置。"
        }, 502, cors);
      }
      const [subscriptionRead, tokenRead] = await Promise.all([
        readResponseTextLimited(subscriptionResponse, 256 * 1024),
        readResponseTextLimited(tokenResponse, 256 * 1024)
      ]);
      if (subscriptionRead.error || tokenRead.error) return json({ error: "A6API 额度响应无法读取。" }, 502, cors);
      let subscriptionBody, tokenBody;
      try { subscriptionBody = JSON.parse(subscriptionRead.text); } catch { subscriptionBody = null; }
      try { tokenBody = JSON.parse(tokenRead.text); } catch { tokenBody = null; }
      const providerMessage = body => {
        const nested = body?.data && typeof body.data === "object" ? body.data : body;
        return sanitizeProviderText(nested?.error?.message || nested?.message || nested?.msg || body?.message || "", apiKey, 180);
      };
      if (!subscriptionResponse.ok || !tokenResponse.ok) {
        const parts = [];
        if (!subscriptionResponse.ok) parts.push("订阅限额接口 HTTP " + subscriptionResponse.status + (providerMessage(subscriptionBody) ? "：" + providerMessage(subscriptionBody) : ""));
        if (!tokenResponse.ok) parts.push("Token 用量接口 HTTP " + tokenResponse.status + (providerMessage(tokenBody) ? "：" + providerMessage(tokenBody) : ""));
        return json({
          error: "A6API 余额查询失败：" + parts.join("；") +
            "。请确认该 Token 有效且 A6API 账户接口可用；若是 401/403，请重新核对密钥。"
        }, 502, cors);
      }
      const subscription = subscriptionBody?.data && typeof subscriptionBody.data === "object" ? subscriptionBody.data : subscriptionBody;
      const tokenUsage = tokenBody?.data && typeof tokenBody.data === "object" ? tokenBody.data : tokenBody;
      if (!subscription || typeof subscription !== "object" || !tokenUsage || typeof tokenUsage !== "object") {
        return json({ error: "A6API 额度接口返回格式无法识别，请检查服务商状态。" }, 502, cors);
      }
      if (subscriptionBody?.success === false || tokenBody?.success === false ||
          subscriptionBody?.code === false || tokenBody?.code === false) {
        return json({ error: "A6API 拒绝了额度查询：" + (providerMessage(tokenBody) || providerMessage(subscriptionBody) || "请核对 API Token 权限。") }, 502, cors);
      }
      const readNumber = (record, key) => {
        const raw = record?.[key];
        if (raw === undefined || raw === null || raw === "") return null;
        const value = Number(raw);
        return Number.isFinite(value) ? value : null;
      };
      const unlimitedValue = tokenUsage.unlimited_quota;
      const unlimited = unlimitedValue === true || unlimitedValue === 1 || unlimitedValue === "true";
      const expiryRaw = Number(tokenUsage.expires_at);
      const expiresAt = Number.isFinite(expiryRaw) && expiryRaw > 0 ? expiryRaw : null;
      const name = typeof tokenUsage.name === "string" ? tokenUsage.name.slice(0, 100) : "";
      if (unlimited) {
        return json({
          ok: true, provider: "A6API", name, unlimited: true,
          totalGranted: null, totalUsed: null, totalAvailable: null,
          hardLimitUsd: readNumber(subscription, "hard_limit_usd"),
          usedUsd: null, availableUsd: null, currencySymbol: "$", expiresAt
        }, 200, cors);
      }
      const hardLimitUsd = readNumber(subscription, "hard_limit_usd");
      const totalGranted = readNumber(tokenUsage, "total_granted");
      const totalUsed = readNumber(tokenUsage, "total_used");
      const totalAvailable = readNumber(tokenUsage, "total_available");
      if (hardLimitUsd === null || hardLimitUsd <= 0 ||
          totalGranted === null || totalGranted <= 0 ||
          totalUsed === null || totalUsed < 0 ||
          totalAvailable === null || totalAvailable < 0) {
        return json({ error: "A6API 额度数据不完整：缺少 hard_limit_usd 或 Token 总额/已用/可用字段，无法可靠计算余额。" }, 502, cors);
      }
      const tolerance = Math.abs(totalGranted) * 1e-9;
      if (Math.abs((totalUsed + totalAvailable) - totalGranted) > tolerance) {
        return json({ error: "A6API 返回的总额度、已用与剩余额度不一致，已停止显示可能有误的余额。" }, 502, cors);
      }
      const usdPerQuotaUnit = hardLimitUsd / totalGranted;
      return json({
        ok: true, provider: "A6API", name, unlimited: false,
        totalGranted, totalUsed, totalAvailable, hardLimitUsd,
        usedUsd: totalUsed * usdPerQuotaUnit,
        availableUsd: totalAvailable * usdPerQuotaUnit,
        currencySymbol: "$", expiresAt
      }, 200, cors);
    }
    if (url.pathname === "/admin/stats/reset" && request.method === "POST") {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const rate = await checkRateLimit(env, "admin-stats-reset:" + ip, 5, 60 * 60 * 1000);
      if (rate.unavailable) return json({ error: "安全限流存储暂时不可用，请稍后重试。" }, 503, cors);
      if (!rate.allowed) return json({ error: "统计重置操作过于频繁，请稍后再试。" }, 429, { ...cors, "Retry-After": String(rate.retryAfter) });
      const parsed = await readJsonLimited(request, 4096);
      if (parsed.error) return json({ error: parsed.error }, parsed.status, cors);
      if (parsed.data.confirm !== "RESET_STATS") return json({ error: "确认字段不正确，未重置统计。" }, 400, cors);
      const profile = readProfile(data, appId);
      profile.stats = {
        totalRequests: 0,
        failedRequests: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        recent: [],
        resetAt: new Date().toISOString()
      };
      writeProfile(data, appId, profile);
      try { await writeData(env, data); }
      catch { return json({ error: "统计重置失败，请检查管理存储是否正常。" }, 500, cors); }
      return json({ ok: true, resetAt: profile.stats.resetAt }, 200, cors);
    }
    if (url.pathname === "/admin/settings" && request.method === "PUT") {
      const parsed = await readJsonLimited(request, 256 * 1024);
      if (parsed.error) return json({ error: parsed.error }, parsed.status, cors);
      const body = parsed.data;
      let apiBaseUrl;
      try { apiBaseUrl = normalizeApiBaseUrl(body.apiBaseUrl); } catch (error) { return json({ error: error.message }, 400, cors); }
      const model = String(body.model || "").trim();
      if (!model || model.length > 200) return json({ error: "模型名称不能为空且不能超过 200 字符" }, 400, cors);
      const defaults = defaultPrompts(appId);
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
      const profile = readProfile(data, appId);
      const current = profile.settings || {};
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
      profile.settings = next;
      writeProfile(data, appId, profile);
      try { await writeData(env, data); } catch { return json({ error: "保存失败，请检查管理存储是否正常" }, 500, cors); }
      try { return json({ ok: true, settings: publicSettings(await buildRuntimeSettings(data, env, appId)) }, 200, cors); }
      catch { return json({ error: "设置已保存，但无法解密 API Key。请检查加密密钥设置。" }, 503, cors); }
    }
    if (url.pathname === "/admin/models" && request.method === "POST") {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const rate = await checkRateLimit(env, "admin-upstream:" + ip, 20, 15 * 60 * 1000);
      if (rate.unavailable) return json({ error: "安全限流存储暂时不可用，请稍后重试。" }, 503, cors);
      if (!rate.allowed) return json({ error: "模型管理请求过于频繁，请稍后再试。" }, 429, { ...cors, "Retry-After": String(rate.retryAfter) });
      let runtime;
      try { runtime = await buildRuntimeSettings(data, env, appId); }
      catch { return json({ error: "无法解密已保存的 API Key，请检查加密密钥设置。" }, 503, cors); }
      const parsed = await readJsonLimited(request, 16384);
      if (parsed.error) return json({ error: parsed.error }, parsed.status, cors);
      const input = parsed.data;
      let apiBaseUrl;
      try { apiBaseUrl = normalizeApiBaseUrl(input.apiBaseUrl || runtime.apiBaseUrl); }
      catch (error) { return json({ error: error.message }, 400, cors); }
      const apiKey = typeof input.apiKey === "string" && input.apiKey.trim() ? input.apiKey.trim() : runtime.apiKey;
      if (!apiKey || !apiBaseUrl) return json({ error: "请先设置 API 地址和密钥" }, 400, cors);
      let response;
      try {
        response = await fetch(apiBaseUrl.replace(/\/+$/, "") + "/models", {
          headers: { "Authorization": "Bearer " + apiKey, "Accept": "application/json" },
          redirect: "manual",
          signal: AbortSignal.timeout(20000)
        });
      } catch (error) {
        const host = new URL(apiBaseUrl).hostname;
        return json({
          error: "无法连接模型列表接口（" + host + "）。网络原因：" +
            describeFetchFailure(error, apiKey) + "。请核对 API 根地址，并检查 Worker 出网、DNS/TLS 与服务商状态。"
        }, 502, cors);
      }
      if (response.status >= 300 && response.status < 400) {
        return json({ error: "模型列表接口返回重定向（HTTP " + response.status +
          "）。为保护 API Token，Worker 不会跟随重定向。请检查 API 根地址或供应商配置。" }, 502, cors);
      }
      const responseText = await readResponseTextLimited(response, 1024 * 1024);
      if (responseText.error) return json({ error: "模型列表响应体过大或无法读取。" }, 502, cors);
      let result;
      try { result = JSON.parse(responseText.text); } catch { result = {}; }
      if (!response.ok) return json({ error: "获取模型列表失败（HTTP " + response.status + "）：" + sanitizeProviderText(result?.error?.message || result?.message || "当前供应商可能不支持 /models 接口", apiKey, 400) }, 502, cors);
      if (result && (result.success === false || result.code === false)) {
        return json({ error: "获取模型列表失败：" + sanitizeProviderText(result.message || result.msg || "服务商拒绝请求", apiKey, 400) }, 502, cors);
      }
      const list = [
        Array.isArray(result) ? result : null,
        Array.isArray(result?.data) ? result.data : null,
        Array.isArray(result?.models) ? result.models : null,
        Array.isArray(result?.items) ? result.items : null,
        Array.isArray(result?.data?.models) ? result.data.models : null,
        Array.isArray(result?.result?.data) ? result.result.data : null,
        Array.isArray(result?.result?.models) ? result.result.models : null
      ].find(Array.isArray) || [];
      const models = [...new Set(list.map(item => typeof item === "string" ? item : item?.id || item?.model || item?.name)
        .filter(item => typeof item === "string" && item.trim().length > 0).map(item => item.trim()))].sort();
      if (!models.length) {
        return json({ error: "接口已响应，但未找到可识别的模型列表。请检查该服务商的 /models 返回格式，或手动填写模型 ID。" }, 502, cors);
      }
      return json({ models, count: models.length }, 200, cors);
    }
    if (url.pathname === "/admin/test" && request.method === "POST") {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const rate = await checkRateLimit(env, "admin-upstream:" + ip, 20, 15 * 60 * 1000);
      if (rate.unavailable) return json({ error: "安全限流存储暂时不可用，请稍后重试。" }, 503, cors);
      if (!rate.allowed) return json({ error: "模型管理请求过于频繁，请稍后再试。" }, 429, { ...cors, "Retry-After": String(rate.retryAfter) });
      let runtime;
      try { runtime = await buildRuntimeSettings(data, env, appId); }
      catch { return json({ error: "无法解密已保存的 API Key，请检查加密密钥设置。" }, 503, cors); }
      const parsed = await readJsonLimited(request, 16384);
      if (parsed.error) return json({ error: parsed.error }, parsed.status, cors);
      const input = parsed.data;
      let apiBaseUrl;
      try { apiBaseUrl = normalizeApiBaseUrl(input.apiBaseUrl || runtime.apiBaseUrl); }
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
          redirect: "manual",
          signal: AbortSignal.timeout(25000)
        });
      } catch (error) {
        const host = new URL(apiBaseUrl).hostname;
        return json({
          ok: false,
          elapsedMs: Date.now() - start,
          error: "连接失败（" + host + "）。网络原因：" + describeFetchFailure(error, apiKey) +
            "。请检查 API 根地址、Worker 出网/DNS/TLS，以及服务商是否发生重定向。"
        }, 502, cors);
      }
      if (response.status >= 300 && response.status < 400) {
        return json({
          ok: false, elapsedMs: Date.now() - start,
          error: "模型服务返回重定向（HTTP " + response.status +
            "）。为保护 API Token，Worker 不会跟随重定向。请检查 API 根地址或供应商配置。"
        }, 502, cors);
      }
      const responseText = await readResponseTextLimited(response, 256 * 1024);
      if (responseText.error) return json({ ok: false, elapsedMs: Date.now() - start, error: "测试响应体过大或无法读取。" }, 502, cors);
      let result;
      try { result = JSON.parse(responseText.text); } catch { result = {}; }
      const elapsedMs = Date.now() - start;
      if (!response.ok) return json({ ok: false, elapsedMs, error: "模型服务返回 HTTP " + response.status + "：" + sanitizeProviderText(result?.error?.message || result?.message || "请检查 API 地址、密钥和模型权限", apiKey, 500) }, 502, cors);
      return json({ ok: true, elapsedMs, model: result.model || model, preview: String(result?.choices?.[0]?.message?.content || "连接成功").slice(0, 300), usage: result.usage || null }, 200, cors);
    }
    return json({ error: "管理接口不存在" }, 404, cors);
  }
  return { readData, writeData, getRuntimeSettings, handleRoute, recordRequest, checkRateLimit };
}
