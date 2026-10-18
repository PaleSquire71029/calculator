const ADMIN_SESSION_TTL_MS = 4 * 60 * 60 * 1000;
const ADMIN_LOGIN_WINDOW_MS = 15 * 60 * 1000;
const ADMIN_LOGIN_MAX_ATTEMPTS = 8;
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
  if (!match || match[1].length > 2048 || !env.ADMIN_PASSWORD) return false;
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
    if (data?.settings?.apiKeyMode === "custom" && typeof savedKey === "string" && savedKey.length > 0) {
      if (!savedKey.startsWith(ENCRYPTED_KEY_PREFIX)) {
        // Upgrade legacy plaintext to encrypted storage.
        data.settings.apiKey = await encryptApiKey(savedKey, env);
        await writeData(env, data);
      } else {
        // Re-wrap ciphertext under the preferred secret if an older fallback key was used.
        const decrypted = await decryptApiKeyDetails(savedKey, env);
        if (decrypted.secretIndex > 0) {
          data.settings.apiKey = await encryptApiKey(decrypted.value, env);
          await writeData(env, data);
        }
      }
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
    // Never silently fall back to isolate-local counters: production abuse controls must fail closed.
    if (!env.ADMIN_STORE) return { allowed: false, unavailable: true, retryAfter: 60 };
    try {
      const stub = env.ADMIN_STORE.get(env.ADMIN_STORE.idFromName("settings-v1"));
      const response = await stub.fetch("https://admin-store.internal/rate-limit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, limit, windowMs })
      });
      if (!response.ok) return { allowed: false, unavailable: true, retryAfter: 60 };
      const result = await response.json();
      if (typeof result.allowed !== "boolean") return { allowed: false, unavailable: true, retryAfter: 60 };
      return result;
    } catch {
      return { allowed: false, unavailable: true, retryAfter: 60 };
    }
  }
  async function recordRequest(env, event) {
    try {
      const data = await readData(env);
      if (!data) return;
      const stats = data.stats || { totalRequests: 0, failedRequests: 0, promptTokens: 0, completionTokens: 0, recent: [] };
      stats.totalRequests = (stats.totalRequests || 0) + 1;
      if (!event.ok) stats.failedRequests = (stats.failedRequests || 0) + 1;
      const toTokenCount = value => {
        const number = Number(value ?? 0);
        return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
      };
      const promptTokens = toTokenCount(event.usage?.prompt_tokens ?? event.usage?.input_tokens ?? event.usage?.promptTokens);
      const completionTokens = toTokenCount(event.usage?.completion_tokens ?? event.usage?.output_tokens ?? event.usage?.completionTokens);
      if (event.usage) {
        stats.promptTokens = (stats.promptTokens || 0) + promptTokens;
        stats.completionTokens = (stats.completionTokens || 0) + completionTokens;
      }
      stats.recent = [{
        at: new Date().toISOString(),
        mode: event.mode || "unknown",
        ok: Boolean(event.ok),
        status: event.status || 0,
        model: event.model || "",
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        usageAvailable: Boolean(event.usage)
      }, ...(stats.recent || [])].slice(0, 20);
      data.stats = stats;
      await writeData(env, data);
    } catch { /* 统计不能中断主请求 */ }
  }
  async function handleRoute(request, env, url, cors) {
    const origin = request.headers.get("Origin") || "";
    if (!origin || !getAllowedOrigins(env).includes(origin)) return json({ error: "该网页来源未获授权" }, 403, cors);
    if (!(url.pathname === "/admin/login" && request.method === "POST")) {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const rate = await checkRateLimit(env, "admin-auth:" + ip, 120, 60 * 1000);
      if (rate.unavailable) return json({ error: "安全限流存储暂时不可用，请稍后重试。" }, 503, cors);
      if (!rate.allowed) return json({ error: "管理接口请求过于频繁，请稍后再试。" }, 429, { ...cors, "Retry-After": String(rate.retryAfter) });
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
    if (url.pathname === "/admin/key/reveal" && request.method === "POST") {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const rate = await checkRateLimit(env, "admin-key-reveal:" + ip, 8, 15 * 60 * 1000);
      if (rate.unavailable) return json({ error: "安全限流存储暂时不可用，请稍后重试。" }, 503, cors);
      if (!rate.allowed) return json({ error: "Token 查看次数过多，请稍后再试。" }, 429, { ...cors, "Retry-After": String(rate.retryAfter) });
      const parsed = await readJsonLimited(request, 4096);
      if (parsed.error) return json({ error: parsed.error }, parsed.status, cors);
      if (parsed.data.confirm !== "REVEAL_KEY") return json({ error: "请在管理页面点击“查看已保存 Token”后重试。" }, 400, cors);
      let runtime;
      try { runtime = await buildRuntimeSettings(data, env); }
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
      try { runtime = await buildRuntimeSettings(data, env); }
      catch { return json({ error: "无法读取已保存的 API Token，请检查加密密钥设置。" }, 503, cors); }
      let apiBaseUrl;
      try { apiBaseUrl = normalizeApiBaseUrl(parsed.data.apiBaseUrl || runtime.apiBaseUrl); }
      catch (error) { return json({ error: error.message }, 400, cors); }
      const apiKey = typeof parsed.data.apiKey === "string" && parsed.data.apiKey.trim()
        ? parsed.data.apiKey.trim() : runtime.apiKey;
      if (!apiKey) return json({ error: "请先配置 API Token。" }, 400, cors);
      const rootUrl = new URL(apiBaseUrl);
      rootUrl.pathname = rootUrl.pathname.replace(/\/v1\/?$/i, "") || "/";
      rootUrl.search = "";
      rootUrl.hash = "";
      const root = rootUrl.toString().replace(/\/$/, "");
      let quota = null;
      let lastStatus = 0;
      let lastMessage = "";
      for (const path of ["/api/usage/token/", "/api/usage/token"]) {
        let response;
        try {
          response = await fetch(root + path, {
            method: "GET",
            headers: { "Authorization": "Bearer " + apiKey, "Accept": "application/json" },
            redirect: "error",
            signal: AbortSignal.timeout(12000)
          });
        } catch {
          return json({ error: "余额接口无法连接。请确认该服务商支持 /api/usage/token/ 查询接口。" }, 502, cors);
        }
        lastStatus = response.status;
        const body = await readResponseTextLimited(response, 256 * 1024);
        if (body.error) return json({ error: "余额接口响应无法读取。" }, 502, cors);
        let result;
        try { result = JSON.parse(body.text); }
        catch { result = null; }
        if (response.ok && result && typeof result === "object") {
          const nested = result.data && typeof result.data === "object" ? result.data : result;
          const number = (...keys) => {
            for (const key of keys) {
              const raw = nested[key];
              if (raw === undefined || raw === null || raw === "") continue;
              const value = Number(raw);
              if (Number.isFinite(value)) return value;
            }
            return null;
          };
          const totalUsed = number("total_used", "used_quota", "used");
          const totalGranted = number("total_granted", "total_quota") ??
            (totalUsed !== null ? number("quota", "total") : null);
          const totalAvailable = number("total_available", "available_quota", "remaining", "balance") ??
            (totalGranted !== null && totalUsed !== null ? Math.max(0, totalGranted - totalUsed) : null);
          const unlimited = nested.unlimited_quota === true || nested.unlimited === true ||
            nested.unlimited_quota === 1 || nested.unlimited === 1;
          if (unlimited || totalAvailable !== null || totalUsed !== null || totalGranted !== null) {
            quota = {
              name: typeof nested.name === "string" ? nested.name.slice(0, 100) : "",
              unlimited,
              totalGranted,
              totalUsed,
              totalAvailable,
              expiresAt: Number(nested.expires_at) > 0 ? Number(nested.expires_at) : null
            };
            break;
          }
          lastMessage = typeof result.message === "string" ? result.message : "余额接口返回成功，但响应中没有可识别的额度字段";
          break;
        }
        lastMessage = String(result?.error?.message || result?.message || result?.msg || "服务商未提供兼容的 Token 额度接口").slice(0, 300);
        if (response.status !== 404 && response.status !== 405) break;
      }
      if (!quota) {
        if (lastStatus === 401 || lastStatus === 403) {
          return json({ error: "余额查询被服务商拒绝（HTTP " + lastStatus + "）。请确认这个 API Token 有效，且服务商支持额度查询。" }, 502, cors);
        }
        return json({ error: "无法获取余额（HTTP " + lastStatus + "）：" + lastMessage }, 502, cors);
      }
      let quotaPerUnit = null;
      let currencySymbol = "";
      let currencyEnabled = true;
      try {
        const statusResponse = await fetch(root + "/api/status", {
          headers: { "Accept": "application/json" }, redirect: "error", signal: AbortSignal.timeout(8000)
        });
        if (statusResponse.ok) {
          const statusBody = await readResponseTextLimited(statusResponse, 128 * 1024);
          if (!statusBody.error) {
            const statusData = JSON.parse(statusBody.text);
            const detail = statusData?.data && typeof statusData.data === "object" ? statusData.data : statusData;
            const ratio = Number(detail?.quota_per_unit);
            if (Number.isFinite(ratio) && ratio > 0) quotaPerUnit = ratio;
            currencySymbol = String(detail?.display_in_currency_symbol || detail?.currency_symbol || "").slice(0, 8);
            if (detail?.display_in_currency === false || detail?.display_in_currency === 0) currencyEnabled = false;
          }
        }
      } catch { /* quota points remain available even when public status isn't supported */ }
      const monetaryUnit = currencySymbol || "$";
      return json({
        ok: true,
        provider: rootUrl.hostname,
        name: quota.name,
        unlimited: quota.unlimited,
        totalGranted: quota.totalGranted,
        totalUsed: quota.totalUsed,
        totalAvailable: quota.totalAvailable,
        expiresAt: quota.expiresAt,
        quotaPerUnit,
        currencySymbol: monetaryUnit,
        currencyEnabled: Boolean(quotaPerUnit && currencyEnabled)
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
      data.stats = {
        totalRequests: 0,
        failedRequests: 0,
        promptTokens: 0,
        completionTokens: 0,
        recent: [],
        resetAt: new Date().toISOString()
      };
      try { await writeData(env, data); }
      catch { return json({ error: "统计重置失败，请检查管理存储是否正常。" }, 500, cors); }
      return json({ ok: true, resetAt: data.stats.resetAt }, 200, cors);
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
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const rate = await checkRateLimit(env, "admin-upstream:" + ip, 20, 15 * 60 * 1000);
      if (rate.unavailable) return json({ error: "安全限流存储暂时不可用，请稍后重试。" }, 503, cors);
      if (!rate.allowed) return json({ error: "模型管理请求过于频繁，请稍后再试。" }, 429, { ...cors, "Retry-After": String(rate.retryAfter) });
      let runtime;
      try { runtime = await buildRuntimeSettings(data, env); }
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
          redirect: "error",
          signal: AbortSignal.timeout(20000)
        });
      } catch { return json({ error: "无法连接模型列表接口，请检查 API 地址和网络" }, 502, cors); }
      const responseText = await readResponseTextLimited(response, 1024 * 1024);
      if (responseText.error) return json({ error: "模型列表响应体过大或无法读取。" }, 502, cors);
      let result;
      try { result = JSON.parse(responseText.text); } catch { result = {}; }
      if (!response.ok) return json({ error: "获取模型列表失败（HTTP " + response.status + "）：" + String(result?.error?.message || result?.message || "当前供应商可能不支持 /models 接口").slice(0, 400) }, 502, cors);
      if (result && (result.success === false || result.code === false)) {
        return json({ error: "获取模型列表失败：" + String(result.message || result.msg || "服务商拒绝请求").slice(0, 400) }, 502, cors);
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
      try { runtime = await buildRuntimeSettings(data, env); }
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
          redirect: "error",
          signal: AbortSignal.timeout(25000)
        });
      } catch { return json({ ok: false, elapsedMs: Date.now() - start, error: "连接失败：无法连接模型服务，请检查地址和网络" }, 502, cors); }
      const responseText = await readResponseTextLimited(response, 256 * 1024);
      if (responseText.error) return json({ ok: false, elapsedMs: Date.now() - start, error: "测试响应体过大或无法读取。" }, 502, cors);
      let result;
      try { result = JSON.parse(responseText.text); } catch { result = {}; }
      const elapsedMs = Date.now() - start;
      if (!response.ok) return json({ ok: false, elapsedMs, error: "模型服务返回 HTTP " + response.status + "：" + String(result?.error?.message || result?.message || "请检查 API 地址、密钥和模型权限").slice(0, 500) }, 502, cors);
      return json({ ok: true, elapsedMs, model: result.model || model, preview: String(result?.choices?.[0]?.message?.content || "连接成功").slice(0, 300), usage: result.usage || null }, 200, cors);
    }
    return json({ error: "管理接口不存在" }, 404, cors);
  }
  return { readData, writeData, getRuntimeSettings, handleRoute, recordRequest, checkRateLimit };
}
