/**
 * Admin-only control plane for Supabase chat data.
 * This module never exposes Supabase service credentials to the browser.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VALID_APPS = new Set(["zhixing-ai", "learning"]);
const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer"
};
function reply(data, status = 200, cors = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8", ...cors }
  });
}
async function readBody(request, maxBytes = 16384) {
  const raw = await request.text();
  if (raw.length > maxBytes) return { error: "请求内容过大。", status: 413 };
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object" || Array.isArray(data)) return { error: "请求格式无效。", status: 400 };
    return { data };
  } catch { return { error: "请求格式无效。", status: 400 }; }
}
function serviceHeaders(env) {
  const key = String(env.SUPABASE_SERVICE_ROLE_KEY || "");
  return {
    apikey: key,
    ...(key.startsWith("sb_secret_") ? {} : { Authorization: "Bearer " + key }),
    Accept: "application/json",
    "Content-Type": "application/json"
  };
}
async function db(env, path, options = {}) {
  const base = String(env.SUPABASE_URL || "").replace(/\/+$/, "");
  if (!base || !env.SUPABASE_SERVICE_ROLE_KEY) {
    const error = new Error("Supabase 后端密钥未配置。");
    error.status = 503;
    throw error;
  }
  const response = await fetch(base + "/rest/v1/" + path, {
    ...options,
    headers: { ...serviceHeaders(env), ...(options.headers || {}) },
    redirect: "manual",
    signal: AbortSignal.timeout(15000)
  });
  const raw = await response.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch {}
  if (!response.ok) {
    const error = new Error("Supabase 云数据查询失败。");
    error.status = response.status;
    throw error;
  }
  return { response, data };
}
async function countRows(env, table, filters = {}) {
  const params = new URLSearchParams({ select: "id", ...filters });
  const { response } = await db(env, table + "?" + params.toString(), {
    method: "HEAD", headers: { Prefer: "count=exact", Range: "0-0" }
  });
  const match = (response.headers.get("Content-Range") || "").match(/\/(\d+|\*)$/);
  return match && match[1] !== "*" ? Number(match[1]) : null;
}
function requestedApp(url) {
  const value = url.searchParams.get("app");
  return VALID_APPS.has(value) ? value : "";
}
export async function handleCloudAdminDataRoute(request, env, url, cors) {
  if (!url.pathname.startsWith("/admin/cloud/") || url.pathname === "/admin/cloud/login") return null;
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return reply({ error: "Supabase 后端密钥未配置，请检查 Worker Secrets。" }, 503, cors);
  }
  try {
    const path = url.pathname;
    if (path === "/admin/cloud/overview" && request.method === "GET") {
      const apps = ["zhixing-ai", "learning"];
      const cutoff = new Date(Date.now() - 90 * 86400000).toISOString();
      const perApp = await Promise.all(apps.map(async app => {
        const [conversations, messages, expired] = await Promise.all([
          countRows(env, "zx_conversations", { app_id: "eq." + app }),
          countRows(env, "zx_messages", { app_id: "eq." + app }),
          countRows(env, "zx_conversations", { app_id: "eq." + app, last_activity_at: "lt." + cutoff })
        ]);
        return { app, conversations, messages, expired };
      }));
      const sample = await db(env, "zx_conversations?" + new URLSearchParams({
        select: "user_id", order: "last_activity_at.desc", limit: "1000"
      }).toString(), { headers: { Prefer: "count=exact" } });
      const distinctUsers = new Set((Array.isArray(sample.data) ? sample.data : []).map(row => row.user_id).filter(Boolean));
      const range = (sample.response.headers.get("Content-Range") || "").match(/\/(\d+|\*)$/);
      const scannedTotal = range && range[1] !== "*" ? Number(range[1]) : null;
      return reply({
        apps: perApp,
        totals: {
          conversations: perApp.every(x => x.conversations !== null) ? perApp.reduce((n, x) => n + x.conversations, 0) : null,
          messages: perApp.every(x => x.messages !== null) ? perApp.reduce((n, x) => n + x.messages, 0) : null,
          expired: perApp.every(x => x.expired !== null) ? perApp.reduce((n, x) => n + x.expired, 0) : null
        },
        usersInRecentSample: distinctUsers.size,
        userSampleSize: Array.isArray(sample.data) ? sample.data.length : 0,
        userSampleTruncated: scannedTotal !== null ? scannedTotal > 1000 : (Array.isArray(sample.data) && sample.data.length === 1000)
      }, 200, cors);
    }
    if (path === "/admin/cloud/conversations" && request.method === "GET") {
      const app = requestedApp(url);
      if (!app) return reply({ error: "请选择有效产品。" }, 400, cors);
      const page = Math.max(1, Math.min(10000, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1));
      const pageSize = Math.max(1, Math.min(50, Number.parseInt(url.searchParams.get("page_size") || "20", 10) || 20));
      const term = String(url.searchParams.get("q") || "").trim().slice(0, 100).replace(/[,*()%_\\]/g, "");
      const userId = String(url.searchParams.get("user_id") || "").trim();
      if (userId && !UUID_RE.test(userId)) return reply({ error: "用户 ID 格式无效。" }, 400, cors);
      const params = new URLSearchParams({
        select: "id,user_id,app_id,title,created_at,updated_at,last_activity_at,zx_messages(count)",
        app_id: "eq." + app,
        order: "last_activity_at.desc",
        limit: String(pageSize),
        offset: String((page - 1) * pageSize)
      });
      if (term) params.set("title", "ilike.*" + term + "*");
      if (userId) params.set("user_id", "eq." + userId);
      const { response, data } = await db(env, "zx_conversations?" + params.toString(), { headers: { Prefer: "count=exact" } });
      const range = (response.headers.get("Content-Range") || "").match(/\/(\d+|\*)$/);
      const rows = (Array.isArray(data) ? data : []).map(row => ({
        ...row,
        message_count: Array.isArray(row.zx_messages) && Number.isFinite(Number(row.zx_messages[0]?.count))
          ? Number(row.zx_messages[0].count) : null
      }));
      rows.forEach(row => delete row.zx_messages);
      return reply({ conversations: rows, page, pageSize, total: range && range[1] !== "*" ? Number(range[1]) : null }, 200, cors);
    }
    if (path === "/admin/cloud/users" && request.method === "GET") {
      const app = url.searchParams.get("app") || "all";
      if (app !== "all" && !VALID_APPS.has(app)) return reply({ error: "产品筛选无效。" }, 400, cors);
      const needle = String(url.searchParams.get("q") || "").trim();
      if (needle && !UUID_RE.test(needle)) {
        return reply({ users: [], scannedSessions: 0, truncated: false, note: "用户搜索仅支持完整用户 UUID。" }, 200, cors);
      }
      const sessions = [];
      const chunkSize = 1000, scanLimit = needle ? 1000 : 5000;
      for (let offset = 0; offset < scanLimit; offset += chunkSize) {
        const params = new URLSearchParams({
          select: "user_id,app_id,last_activity_at",
          order: "last_activity_at.desc",
          limit: String(Math.min(chunkSize, scanLimit - offset)),
          offset: String(offset)
        });
        if (app !== "all") params.set("app_id", "eq." + app);
        if (needle) params.set("user_id", "eq." + needle);
        const { data } = await db(env, "zx_conversations?" + params.toString());
        if (!Array.isArray(data) || !data.length) break;
        sessions.push(...data);
        if (data.length < Math.min(chunkSize, scanLimit - offset)) break;
      }
      const users = new Map();
      for (const row of sessions) {
        if (!row.user_id) continue;
        const user = users.get(row.user_id) || {
          user_id: row.user_id, conversation_count: 0, apps: new Set(), last_activity_at: row.last_activity_at || null
        };
        user.conversation_count++;
        user.apps.add(row.app_id);
        if (row.last_activity_at && (!user.last_activity_at || row.last_activity_at > user.last_activity_at)) user.last_activity_at = row.last_activity_at;
        users.set(row.user_id, user);
      }
      const rows = [...users.values()].map(user => ({ ...user, apps: [...user.apps] }))
        .sort((a, b) => String(b.last_activity_at || "").localeCompare(String(a.last_activity_at || "")));
      return reply({
        users: rows,
        scannedSessions: sessions.length,
        truncated: !needle && sessions.length >= scanLimit,
        note: !needle && sessions.length >= scanLimit
          ? "仅扫描最近 5000 条会话；如需精确定位，请使用用户 UUID 搜索。"
          : "仅列出有云端会话的用户；出于最小化原则，未读取用户邮箱。"
      }, 200, cors);
    }
    if (path === "/admin/cloud/messages" && request.method === "GET") {
      const app = requestedApp(url);
      const id = String(url.searchParams.get("conversation_id") || "");
      if (!app || !UUID_RE.test(id)) return reply({ error: "产品或会话 ID 无效。" }, 400, cors);
      const check = new URLSearchParams({
        select: "id,title,user_id,app_id,created_at,last_activity_at",
        id: "eq." + id, app_id: "eq." + app, limit: "1"
      });
      const { data: conversations } = await db(env, "zx_conversations?" + check.toString());
      if (!Array.isArray(conversations) || !conversations.length) return reply({ error: "会话不存在，或不属于当前产品。" }, 404, cors);
      const offset = Math.max(0, Math.min(100000, Number.parseInt(url.searchParams.get("offset") || "0", 10) || 0));
      const params = new URLSearchParams({
        select: "id,conversation_id,user_id,app_id,role,content,status,created_at",
        conversation_id: "eq." + id, app_id: "eq." + app,
        order: "created_at.asc", limit: "100", offset: String(offset)
      });
      const { response, data } = await db(env, "zx_messages?" + params.toString(), { headers: { Prefer: "count=exact" } });
      const range = (response.headers.get("Content-Range") || "").match(/\/(\d+|\*)$/);
      return reply({
        conversation: conversations[0], messages: Array.isArray(data) ? data : [],
        offset, pageSize: 100, total: range && range[1] !== "*" ? Number(range[1]) : null
      }, 200, cors);
    }
    if (path === "/admin/cloud/conversations/delete" && request.method === "POST") {
      const parsed = await readBody(request);
      if (parsed.error) return reply({ error: parsed.error }, parsed.status, cors);
      const body = parsed.data;
      if (body.confirm !== "DELETE_SELECTED") return reply({ error: "缺少批量删除确认，未执行操作。" }, 400, cors);
      if (!VALID_APPS.has(body.app) || !Array.isArray(body.ids) || !body.ids.length || body.ids.length > 100 ||
          body.ids.some(id => typeof id !== "string" || !UUID_RE.test(id)) || new Set(body.ids).size !== body.ids.length) {
        return reply({ error: "产品或会话 ID 无效；单次最多删除 100 条记录。" }, 400, cors);
      }
      const params = new URLSearchParams({ id: "in.(" + body.ids.join(",") + ")", app_id: "eq." + body.app, select: "id" });
      const { data } = await db(env, "zx_conversations?" + params.toString(), {
        method: "DELETE", headers: { Prefer: "return=representation" }
      });
      return reply({ ok: true, deleted: Array.isArray(data) ? data.length : 0 }, 200, cors);
    }
    if (path === "/admin/cloud/users/delete" && request.method === "POST") {
      const parsed = await readBody(request);
      if (parsed.error) return reply({ error: parsed.error }, parsed.status, cors);
      const userId = parsed.data.user_id;
      if (parsed.data.confirm !== "DELETE_USER_DATA" || typeof userId !== "string" || !UUID_RE.test(userId)) {
        return reply({ error: "用户 ID 无效，或缺少删除确认。" }, 400, cors);
      }
      const params = new URLSearchParams({ user_id: "eq." + userId, select: "id" });
      const { data } = await db(env, "zx_conversations?" + params.toString(), {
        method: "DELETE", headers: { Prefer: "return=representation" }
      });
      return reply({ ok: true, deleted: Array.isArray(data) ? data.length : 0 }, 200, cors);
    }
    if (path === "/admin/cloud/cleanup" && request.method === "POST") {
      const parsed = await readBody(request, 4096);
      if (parsed.error) return reply({ error: parsed.error }, parsed.status, cors);
      if (parsed.data.confirm !== "CLEANUP_90D") return reply({ error: "缺少 90 天清理确认，未执行操作。" }, 400, cors);
      const { data } = await db(env, "rpc/zx_cleanup_expired_conversations", { method: "POST", body: "{}" });
      return reply({ ok: true, deletedConversations: Number(data) || 0 }, 200, cors);
    }
    return reply({ error: "Not found" }, 404, cors);
  } catch (error) {
    console.error("Cloud admin operation failed:", { path: url.pathname, status: error?.status || 0 });
    const status = error?.status === 400 || error?.status === 404 || error?.status === 413 ? error.status : (error?.status === 503 ? 503 : 502);
    return reply({ error: status === 404 ? "所需数据或数据库对象不存在。" : status === 503 ? error.message : "云端数据请求失败，请检查 Supabase 配置或稍后重试。" }, status, cors);
  }
}
