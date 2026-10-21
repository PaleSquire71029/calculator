/**
 * Secure Supabase chat history API.
 * Secrets required in Cloudflare Worker:
 *   SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SERVICE_ROLE_KEY
 * Never place the service role key in source control or browser code.
 */
const MAX_TEXT = 100000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function reply(data, status = 200, cors = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...cors }
  });
}
function appId(value) {
  if (value === "zhixing-ai") return "zhixing-ai";
  if (value === "learning") return "learning";
  return "";
}
function restHeaders(env) {
  return {
    "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
    "Authorization": "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY,
    "Content-Type": "application/json",
    "Accept": "application/json"
  };
}
async function readBody(request) {
  const raw = await request.text();
  if (raw.length > 140000) { const error = new Error("请求内容过大。"); error.status = 413; throw error; }
  try { return JSON.parse(raw); } catch { const error = new Error("请求格式无效。"); error.status = 400; throw error; }
}
async function supabase(env, path, options = {}) {
  const base = String(env.SUPABASE_URL || "").replace(/\/+$/, "");
  const response = await fetch(base + "/rest/v1/" + path, {
    ...options,
    headers: { ...restHeaders(env), ...(options.headers || {}) },
    redirect: "manual"
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  if (!response.ok) {
    const err = new Error("云对话存储请求失败。");
    err.status = response.status;
    err.detail = data?.message || data?.hint || "";
    throw err;
  }
  return { response, data };
}
async function authenticate(request, env) {
  const authorization = request.headers.get("Authorization") || "";
  const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token || token.length > 8192) return null;
  const base = String(env.SUPABASE_URL || "").replace(/\/+$/, "");
  const publicKey = env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY;
  if (!base || !publicKey || !env.SUPABASE_SERVICE_ROLE_KEY) return { configError: true };
  const response = await fetch(base + "/auth/v1/user", {
    headers: { "apikey": publicKey, "Authorization": "Bearer " + token, "Accept": "application/json" },
    redirect: "manual"
  });
  if (!response.ok) return null;
  const user = await response.json().catch(() => null);
  return user && UUID_RE.test(user.id || "") ? { id: user.id } : null;
}
async function ownedConversation(env, id, userId, app) {
  if (!UUID_RE.test(id || "")) return null;
  const query = "zx_conversations?id=eq." + encodeURIComponent(id) +
    "&user_id=eq." + encodeURIComponent(userId) +
    "&app_id=eq." + encodeURIComponent(app) + "&select=id&limit=1";
  const { data } = await supabase(env, query);
  return Array.isArray(data) && data.length ? data[0] : null;
}
export async function handleCloudStorage(request, env, url, cors) {
  const app = appId(url.searchParams.get("app") || "");
  if (!app) return reply({ error: "产品标识无效。" }, 400, cors);
  if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY && !env.SUPABASE_ANON_KEY || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return reply({ error: "云对话存储尚未完成后端密钥配置。" }, 503, cors);
  }
  let auth;
  try { auth = await authenticate(request, env); }
  catch { return reply({ error: "登录验证服务暂时不可用，请稍后重试。" }, 503, cors); }
  if (!auth) return reply({ error: "请先登录或重新登录后再同步对话。" }, 401, cors);
  if (auth.configError) return reply({ error: "云对话存储配置不完整。" }, 503, cors);
  const path = url.pathname;
  try {
    if (path === "/api/history/conversations" && request.method === "GET") {
      const query = "zx_conversations?user_id=eq." + encodeURIComponent(auth.id) +
        "&app_id=eq." + encodeURIComponent(app) +
        "&select=id,title,created_at,updated_at,last_activity_at&order=last_activity_at.desc&limit=100";
      const { data } = await supabase(env, query);
      return reply({ conversations: data || [] }, 200, cors);
    }
    if (path === "/api/history/conversations" && request.method === "POST") {
      const body = await readBody(request);
      const title = typeof body.title === "string" ? body.title.trim().slice(0, 160) : "新对话";
      const { data } = await supabase(env, "zx_conversations?select=id,title,created_at,updated_at,last_activity_at", {
        method: "POST", headers: { "Prefer": "return=representation" },
        body: JSON.stringify([{ user_id: auth.id, app_id: app, title: title || "新对话" }])
      });
      return reply({ conversation: Array.isArray(data) ? data[0] : null }, 201, cors);
    }
    if (path === "/api/history/messages" && request.method === "GET") {
      const conversationId = url.searchParams.get("conversation_id") || "";
      if (!await ownedConversation(env, conversationId, auth.id, app)) return reply({ error: "对话不存在或无权访问。" }, 404, cors);
      const query = "zx_messages?conversation_id=eq." + encodeURIComponent(conversationId) +
        "&user_id=eq." + encodeURIComponent(auth.id) + "&app_id=eq." + encodeURIComponent(app) +
        "&select=id,role,content,status,created_at,client_message_id&order=created_at.asc&limit=500";
      const { data } = await supabase(env, query);
      return reply({ messages: data || [] }, 200, cors);
    }
    if (path === "/api/history/messages" && request.method === "POST") {
      const body = await readBody(request);
      const conversationId = String(body.conversation_id || "");
      if (!await ownedConversation(env, conversationId, auth.id, app)) return reply({ error: "对话不存在或无权访问。" }, 404, cors);
      if (!["user", "assistant"].includes(body.role) || typeof body.content !== "string" ||
          !body.content.trim() || body.content.length > MAX_TEXT) return reply({ error: "消息内容无效或过长。" }, 400, cors);
      if (!UUID_RE.test(body.client_message_id || "")) return reply({ error: "消息 ID 无效，请重试发送。" }, 400, cors);
      const clientMessageId = body.client_message_id;
      const row = { conversation_id: conversationId, user_id: auth.id, app_id: app,
        role: body.role, content: body.content, status: body.status === "failed" ? "failed" : "complete",
        ...(clientMessageId ? { client_message_id: clientMessageId } : {}) };
      const { data } = await supabase(env, "zx_messages?on_conflict=conversation_id,client_message_id&select=id,role,content,status,created_at,client_message_id", {
        method: "POST",
        headers: { "Prefer": "resolution=ignore-duplicates,return=representation" },
        body: JSON.stringify([row])
      });
      await supabase(env, "zx_conversations?id=eq." + encodeURIComponent(conversationId) +
        "&user_id=eq." + encodeURIComponent(auth.id) + "&app_id=eq." + encodeURIComponent(app), {
        method: "PATCH", headers: { "Prefer": "return=minimal" },
        body: JSON.stringify({ updated_at: new Date().toISOString(), last_activity_at: new Date().toISOString() })
      });
      if (Array.isArray(data) && data[0]) return reply({ message: data[0], duplicate: false }, 201, cors);
      return reply({ duplicate: true }, 200, cors);
    }
    if (path === "/api/history/conversations" && request.method === "DELETE") {
      const id = url.searchParams.get("id") || "";
      if (!await ownedConversation(env, id, auth.id, app)) return reply({ error: "对话不存在或无权访问。" }, 404, cors);
      await supabase(env, "zx_conversations?id=eq." + encodeURIComponent(id) +
        "&user_id=eq." + encodeURIComponent(auth.id) + "&app_id=eq." + encodeURIComponent(app), {
        method: "DELETE", headers: { "Prefer": "return=minimal" }
      });
      return reply({ ok: true }, 200, cors);
    }
    return reply({ error: "Not found" }, 404, cors);
  } catch (error) {
    if (error?.status === 400 || error?.status === 413) return reply({ error: error.message }, error.status, cors);
    const status = error?.status === 401 || error?.status === 403 ? 503 : 502;
    return reply({ error: status === 503 ? "云存储服务暂时拒绝请求，请检查后台配置。" : "云存储暂时不可用，请稍后重试。" }, status, cors);
  }
}
