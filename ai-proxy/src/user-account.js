/**
 * Supabase end-user self-service account routes.
 * User tokens are verified by Supabase Auth; request-supplied user IDs are never trusted.
 */
const AUTH_TIMEOUT_MS = 12000;
const ACCESS_TTL_DEFAULT = 3600;

function safeText(value, max = 100) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
}
function publicKey(env) {
  return String(env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || "");
}
function apiHeaders(key, authorization) {
  return {
    apikey: key,
    ...(authorization ? { Authorization: authorization } : {}),
    Accept: "application/json",
    "Content-Type": "application/json"
  };
}
function reply(data, status = 200, cors = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Pragma": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      ...cors
    }
  });
}
async function readBody(request, limit = 16384) {
  const declared = request.headers.get("Content-Length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > limit) return { error: "请求内容过大。", status: 413 };
  if (!request.body) return { error: "请求格式无效。", status: 400 };
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel().catch(() => {});
        return { error: "请求内容过大。", status: 413 };
      }
      chunks.push(value);
    }
    const joined = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
    const data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(joined));
    return data && typeof data === "object" && !Array.isArray(data)
      ? { data } : { error: "请求格式无效。", status: 400 };
  } catch { return { error: "请求格式无效。", status: 400 }; }
  finally { try { reader.releaseLock(); } catch {} }
}
function authBase(env) {
  const base = String(env.SUPABASE_URL || "").replace(/\/+$/, "");
  const key = publicKey(env);
  if (!base || !key) {
    const error = new Error("Supabase Auth 配置不完整。");
    error.status = 503;
    throw error;
  }
  return { base, key };
}
async function authFetch(env, path, { method = "GET", body, bearer, publicApi = true } = {}) {
  const { base, key } = authBase(env);
  const response = await fetch(base + "/auth/v1/" + path, {
    method,
    headers: apiHeaders(key, bearer ? "Bearer " + bearer : undefined),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "manual",
    signal: AbortSignal.timeout(AUTH_TIMEOUT_MS)
  });
  const raw = await response.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch {}
  if (response.status >= 300 && response.status < 400) {
    const error = new Error("身份服务返回重定向，已拒绝跟随。");
    error.status = 502;
    throw error;
  }
  if (!response.ok) {
    const error = new Error("身份验证失败。");
    error.status = response.status;
    error.publicMessage = safeText(data?.msg || data?.message || data?.error_description || data?.error || "", 180);
    throw error;
  }
  return data;
}
async function readUser(request, env) {
  const token = (request.headers.get("Authorization") || "").match(/^Bearer\s+(\S+)$/i)?.[1] || "";
  if (!token || token.length > 8192) return null;
  try {
    const user = await authFetch(env, "user", { bearer: token });
    if (!user || typeof user.id !== "string" || !user.id) return null;
    return { token, user };
  } catch (error) {
    if (error.status === 503) throw error;
    return null;
  }
}
function safeRegistration(user) {
  const metadata = user?.app_metadata?.zx_registration;
  if (!metadata || typeof metadata !== "object") return {
    ip: "", city: "", region: "", country: "", countryCode: "", timezone: "", registeredAt: null, source: ""
  };
  return {
    ip: safeText(metadata.ip, 80),
    city: safeText(metadata.city, 80),
    region: safeText(metadata.region, 80),
    country: safeText(metadata.country, 80),
    countryCode: safeText(metadata.countryCode, 8),
    timezone: safeText(metadata.timezone, 80),
    registeredAt: typeof metadata.registeredAt === "string" ? metadata.registeredAt : null,
    source: safeText(metadata.source, 40)
  };
}
function safeAccount(user) {
  return {
    id: safeText(user?.id, 64),
    email: safeText(user?.email, 254),
    emailConfirmedAt: user?.email_confirmed_at || null,
    createdAt: user?.created_at || null,
    lastSignInAt: user?.last_sign_in_at || null,
    registration: safeRegistration(user)
  };
}
async function consumeRate(env, key, limit, windowMs) {
  if (!env.ADMIN_STORE) return { allowed: false, unavailable: true, retryAfter: 60 };
  try {
    const stub = env.ADMIN_STORE.get(env.ADMIN_STORE.idFromName("settings-v1"));
    const response = await stub.fetch("https://admin-store.internal/rate-limit", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, limit, windowMs }),
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) return { allowed: false, unavailable: true, retryAfter: 60 };
    const result = await response.json();
    return typeof result.allowed === "boolean" ? result : { allowed: false, unavailable: true, retryAfter: 60 };
  } catch { return { allowed: false, unavailable: true, retryAfter: 60 }; }
}
async function rateGate(request, env, key, limit, windowMs, cors, includeIp = true) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const rate = await consumeRate(env, includeIp ? key + ":" + ip : key, limit, windowMs);
  if (rate.unavailable) return reply({ error: "安全限流服务暂不可用，请稍后重试。" }, 503, cors);
  if (!rate.allowed) return reply({ error: "请求次数过多，请稍后再试。" }, 429, { ...cors, "Retry-After": String(rate.retryAfter || 60) });
  return null;
}
export async function handleUserAccountRoute(request, env, url, cors) {
  if (!url.pathname.startsWith("/api/account/")) return null;
  const path = url.pathname;
  const allowedMethods = {
    "/api/account/login": ["POST"],
    "/api/account/refresh": ["POST"],
    "/api/account/me": ["GET"],
    "/api/account/password": ["POST"],
    "/api/account/logout": ["POST"]
  };
  if (!allowedMethods[path]) return reply({ error: "Not found" }, 404, cors);
  if (!allowedMethods[path].includes(request.method)) return reply({ error: "Method not allowed" }, 405, cors);
  if (request.method === "POST" && !/^application\/json(?:\s*;|$)/i.test(request.headers.get("Content-Type") || "")) {
    return reply({ error: "请求必须使用 application/json 格式。" }, 415, cors);
  }
  try {
    if (path === "/api/account/login") {
      const parsed = await readBody(request);
      if (parsed.error) return reply({ error: parsed.error }, parsed.status, cors);
      const email = typeof parsed.data.email === "string" ? parsed.data.email.trim().toLowerCase() : "";
      const password = typeof parsed.data.password === "string" ? parsed.data.password : "";
      if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 1 || password.length > 128) {
        return reply({ error: "邮箱或密码不正确。" }, 401, cors);
      }
      const ipGate = await rateGate(request, env, "account-login", 12, 15 * 60 * 1000, cors);
      if (ipGate) return ipGate;
      const emailGate = await rateGate(request, env, "account-login-email:" + email, 8, 60 * 60 * 1000, cors, false);
      if (emailGate) return emailGate;
      let session;
      try {
        session = await authFetch(env, "token?grant_type=password", { method: "POST", body: { email, password } });
      } catch (error) {
        if (error.status === 503) return reply({ error: error.message }, 503, cors);
        return reply({ error: "邮箱或密码不正确，或账号尚未完成邮箱验证。" }, 401, cors);
      }
      if (typeof session?.access_token !== "string" || typeof session?.refresh_token !== "string" || !session.user?.id) {
        return reply({ error: "身份服务未返回完整登录会话。" }, 502, cors);
      }
      return reply({
        accessToken: session.access_token,
        refreshToken: session.refresh_token,
        expiresIn: Math.min(86400, Math.max(60, Number(session.expires_in) || ACCESS_TTL_DEFAULT)),
        user: safeAccount(session.user)
      }, 200, cors);
    }
    if (path === "/api/account/refresh") {
      const parsed = await readBody(request, 8192);
      if (parsed.error) return reply({ error: parsed.error }, parsed.status, cors);
      const refreshToken = typeof parsed.data.refreshToken === "string" ? parsed.data.refreshToken : "";
      if (!refreshToken || refreshToken.length > 8192) return reply({ error: "刷新会话已失效，请重新登录。" }, 401, cors);
      const gate = await rateGate(request, env, "account-refresh", 30, 60 * 60 * 1000, cors);
      if (gate) return gate;
      let session;
      try {
        session = await authFetch(env, "token?grant_type=refresh_token", {
          method: "POST", body: { refresh_token: refreshToken }
        });
      } catch {
        return reply({ error: "登录已失效，请重新登录。" }, 401, cors);
      }
      if (typeof session?.access_token !== "string" || typeof session?.refresh_token !== "string" || !session.user?.id) {
        return reply({ error: "身份服务未返回有效刷新会话。" }, 502, cors);
      }
      return reply({
        accessToken: session.access_token,
        refreshToken: session.refresh_token,
        expiresIn: Math.min(86400, Math.max(60, Number(session.expires_in) || ACCESS_TTL_DEFAULT)),
        user: safeAccount(session.user)
      }, 200, cors);
    }
    if (path === "/api/account/me") {
      const gate = await rateGate(request, env, "account-profile", 120, 60 * 1000, cors);
      if (gate) return gate;
      const auth = await readUser(request, env);
      if (!auth) return reply({ error: "登录已失效，请重新登录。" }, 401, cors);
      return reply({ user: safeAccount(auth.user) }, 200, cors);
    }
    if (path === "/api/account/password") {
      const ipGate = await rateGate(request, env, "account-password-ip", 20, 60 * 60 * 1000, cors);
      if (ipGate) return ipGate;
      const auth = await readUser(request, env);
      if (!auth) return reply({ error: "登录已失效，请重新登录。" }, 401, cors);
      const parsed = await readBody(request, 8192);
      if (parsed.error) return reply({ error: parsed.error }, parsed.status, cors);
      const currentPassword = typeof parsed.data.currentPassword === "string" ? parsed.data.currentPassword : "";
      const newPassword = typeof parsed.data.newPassword === "string" ? parsed.data.newPassword : "";
      if (currentPassword.length < 1 || currentPassword.length > 128 ||
          newPassword.length < 8 || newPassword.length > 128 || /[\r\n\0]/.test(newPassword)) {
        return reply({ error: "当前密码无效，或新密码长度不在 8–128 个字符范围内。" }, 400, cors);
      }
      if (currentPassword === newPassword) return reply({ error: "新密码不能与当前密码相同。" }, 400, cors);
      const gate = await rateGate(request, env, "account-password:" + safeText(auth.user.id, 64), 6, 15 * 60 * 1000, cors);
      if (gate) return gate;
      let verified;
      try {
        verified = await authFetch(env, "token?grant_type=password", {
          method: "POST", body: { email: auth.user.email, password: currentPassword }
        });
      } catch {
        return reply({ error: "当前密码不正确。" }, 401, cors);
      }
      if (verified?.user?.id !== auth.user.id) return reply({ error: "当前密码不正确。" }, 401, cors);
      try {
        const changed = await authFetch(env, "user", {
          method: "PUT", bearer: auth.token, body: { password: newPassword }
        });
        if (changed?.id !== auth.user.id) return reply({ error: "密码服务未确认账号归属，请重新登录检查。" }, 502, cors);
      } catch (error) {
        if (error.status === 503) return reply({ error: error.message }, 503, cors);
        return reply({ error: "密码更新失败，请确认新密码满足 Supabase Auth 的密码策略后重试。" }, 400, cors);
      }
      return reply({ ok: true }, 200, cors);
    }
    if (path === "/api/account/logout") {
      const gate = await rateGate(request, env, "account-logout", 30, 60 * 60 * 1000, cors);
      if (gate) return gate;
      const auth = await readUser(request, env);
      if (!auth) return reply({ ok: true }, 200, cors);
      try { await authFetch(env, "logout", { method: "POST", bearer: auth.token }); }
      catch { /* browser still clears its session; a revoked session may already be expired */ }
      return reply({ ok: true }, 200, cors);
    }
  } catch (error) {
    console.error("User account route failed:", { path, status: error?.status || 0 });
    return reply({ error: error?.status === 503 ? error.message : "账号服务暂时不可用，请稍后重试。" }, error?.status === 503 ? 503 : 502, cors);
  }
}
