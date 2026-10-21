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
  $('authForm').hidden = !!user; $('signedInRow').hidden = !user;
  $('accountEmailLabel').textContent = user?.email || '已登录';
  if (user) { try { await listHistory(false); setStatus('已登录 · 选择历史记录可恢复对话。'); } catch (e) { setStatus('已登录，但云历史暂不可用：' + e.message); } }
  else { activeConversationId = null; $('historyList').replaceChildren(); setStatus('登录后可同步文字对话；两个产品的历史相互隔离，保留 90 天。'); }
}
async function auth(mode) {
  const email = $('accountEmail').value.trim(), password = $('accountPassword').value;
  if (!email || !password) { setStatus('请输入邮箱和密码。'); return; }
  if (password.length < 8) { setStatus('密码至少需要 8 位。'); return; }
  $('signInBtn').disabled = $('signUpBtn').disabled = true;
  try {
    const result = mode === 'signup' ? await client.auth.signUp({ email, password }) : await client.auth.signInWithPassword({ email, password });
    if (result.error) throw result.error;
    if (mode === 'signup' && !result.data.session) { setStatus('注册已提交，请先打开邮箱完成验证，再回来登录。'); return; }
    await refreshAuth();
  } catch (e) { setStatus('账号操作失败：' + (e.message || '请检查邮箱、密码或邮件验证设置。')); }
  finally { $('signInBtn').disabled = $('signUpBtn').disabled = false; }
}
$('signInBtn').addEventListener('click', () => auth('signin'));
$('signUpBtn').addEventListener('click', () => auth('signup'));
$('signOutBtn').addEventListener('click', async () => { await client?.auth.signOut(); activeConversationId = null; if (window.zxAIApp) { window.zxAIApp.state.messages = []; window.zxAIApp.render(); } await refreshAuth(); });
$('refreshHistoryBtn').addEventListener('click', () => listHistory());
$('clearChat').addEventListener('click', () => { activeConversationId = null; });
if (client) client.auth.onAuthStateChange(() => setTimeout(refreshAuth, 0));
window.zxCloudHistory = {
  get isSignedIn() { return !!client; },
  async ensureConversation(title) { const session = await client.auth.getSession(); if (!session.data.session) return null; return ensureConversation(title); },
  async saveMessage(role, content, id) { const session = await client.auth.getSession(); if (!session.data.session) return; return saveMessage(role, content, id || uuid()); },
  refresh: listHistory,
  newConversation() { activeConversationId = null; },
  messageId: uuid
};
refreshAuth();
})();