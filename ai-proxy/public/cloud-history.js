(() => {
'use strict';
const SUPABASE_URL = 'https://gzuaqjtvnkiblhqsgzpd.supabase.co';
const SUPABASE_KEY = 'sb_publishable_jJDVBqrGIjg87Iwn5bXwxQ_Z4JfI3aj';
const $ = id => document.getElementById(id);
const client = window.supabase?.createClient ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY) : null;
let activeConversationId = null;
function setStatus(message) { const el = $('accountStatus'); if (el) el.textContent = message; }
function uuid() { return crypto.randomUUID(); }
async function api(path, options = {}) {
  const sessionResult = await client.auth.getSession();
  const token = sessionResult.data.session?.access_token;
  if (!token) throw new Error('请先登录。');
  const separator = path.includes('?') ? '&' : '?';
  const response = await fetch(($('proxyUrl').value.trim() || 'https://api.zhixing.us.ci').replace(/\/+$/, '') + path + separator + 'app=learning', {
    ...options,
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token, ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || '云存储请求失败。');
  return data;
}
async function listHistory(showStatus = true) {
  const result = await api('/api/history/conversations');
  const host = $('historyList'); host.replaceChildren();
  (result.conversations || []).forEach(item => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'history-item' + (item.id === activeConversationId ? ' active' : '');
    button.textContent = item.title || '新对话';
    button.title = new Date(item.last_activity_at || item.updated_at).toLocaleString();
    button.addEventListener('click', () => openHistory(item.id));
    host.appendChild(button);
  });
  if (showStatus) setStatus('已登录 · 本产品云历史 ' + (result.conversations || []).length + ' 条，保留 90 天。');
}
async function openHistory(id) {
  try {
    const result = await api('/api/history/messages?conversation_id=' + encodeURIComponent(id));
    activeConversationId = id;
    if (window.zxAIApp) {
      const state = window.zxAIApp.state;
      state.messages = (result.messages || []).filter(m => m.status === 'complete' && ['user', 'assistant'].includes(m.role)).map(m => ({ role: m.role, text: m.content }));
      state.images = []; state.files = [];
      window.zxAIApp.updateAttachments?.();
      window.zxAIApp.render();
    }
    await listHistory(false); setStatus('已恢复云端对话。');
  } catch (error) { setStatus('读取历史失败：' + error.message); }
}
async function ensureConversation(title) {
  if (activeConversationId) return activeConversationId;
  const result = await api('/api/history/conversations', { method: 'POST', body: JSON.stringify({ title: (title || '新对话').replace(/\s+/g, ' ').slice(0, 70) || '新对话' }) });
  activeConversationId = result.conversation?.id || null;
  await listHistory(false);
  return activeConversationId;
}
async function saveMessage(role, content, clientMessageId) {
  if (!activeConversationId || !content) return;
  await api('/api/history/messages', { method: 'POST', body: JSON.stringify({ conversation_id: activeConversationId, role, content, client_message_id: clientMessageId, status: 'complete' }) });
}
async function refreshAuth() {
  if (!client) { setStatus('登录组件加载失败，请刷新页面后重试。'); return; }
  const result = await client.auth.getSession();
  const user = result.data.session?.user || null;
  const statusEl = $('accountStatus');
  if (user) {
    if (statusEl) statusEl.textContent = '已登录 · 本产品云历史 ' + ((await listHistory(false).catch(() => ({ conversations: [] }))).conversations || []).length + ' 条。';
    else await listHistory(false).catch(() => {});
  } else {
    activeConversationId = null;
    const host = $('historyList');
    if (host) host.replaceChildren();
    setStatus('登录后可同步文字对话；登录入口位于页面顶栏账号窗口。');
  }
}
async function syncAuth(session) {
  if (!client) throw new Error('登录组件加载失败，请刷新页面后重试。');
  if (session?.access_token && session?.refresh_token) {
    const result = await client.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token });
    if (result.error) throw result.error;
  } else {
    const result = await client.auth.signOut();
    if (result.error) throw result.error;
  }
  await refreshAuth();
}
if ($('refreshHistoryBtn')) $('refreshHistoryBtn').addEventListener('click', () => listHistory());
if ($('clearChat')) $('clearChat').addEventListener('click', () => { activeConversationId = null; });
if (client) client.auth.onAuthStateChange(() => setTimeout(refreshAuth, 0));
window.zxCloudHistory = {
  syncAuth,
  async ensureConversation(title) { const session = await client.auth.getSession(); if (!session.data.session) return null; return ensureConversation(title); },
  async saveMessage(role, content, id) { const session = await client.auth.getSession(); if (!session.data.session) return; return saveMessage(role, content, id || uuid()); },
  refresh: listHistory,
  newConversation() { activeConversationId = null; },
  messageId: uuid
};
refreshAuth();
})();