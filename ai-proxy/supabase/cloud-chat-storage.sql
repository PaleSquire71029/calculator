-- 知行 AI 云对话存储：Supabase SQL Editor 中执行本文件。
-- 只保存文字，不保存图片、文件二进制或附件原件。
-- 服务端仍须验证 Supabase access token，并对 user_id + app_id 双重授权。

create extension if not exists pgcrypto;

create table if not exists public.zx_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  app_id text not null check (app_id in ('zhixing-ai', 'learning')),
  title text not null default '新对话' check (char_length(title) <= 160),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now()
);

create index if not exists zx_conversations_owner_app_activity
  on public.zx_conversations (user_id, app_id, last_activity_at desc);

create table if not exists public.zx_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.zx_conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  app_id text not null check (app_id in ('zhixing-ai', 'learning')),
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null check (char_length(content) <= 100000),
  client_message_id uuid,
  status text not null default 'complete' check (status in ('pending', 'complete', 'failed')),
  created_at timestamptz not null default now(),
  constraint zx_messages_idempotency unique (conversation_id, client_message_id)
);

create index if not exists zx_messages_conversation_created
  on public.zx_messages (conversation_id, created_at asc);

alter table public.zx_conversations enable row level security;
alter table public.zx_messages enable row level security;

-- RLS 是额外防线；Worker 使用 service role 时仍必须逐次校验所有权。
drop policy if exists zx_conversations_select_own on public.zx_conversations;
create policy zx_conversations_select_own on public.zx_conversations
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists zx_conversations_insert_own on public.zx_conversations;
create policy zx_conversations_insert_own on public.zx_conversations
  for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists zx_conversations_update_own on public.zx_conversations;
create policy zx_conversations_update_own on public.zx_conversations
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists zx_conversations_delete_own on public.zx_conversations;
create policy zx_conversations_delete_own on public.zx_conversations
  for delete to authenticated using (auth.uid() = user_id);

drop policy if exists zx_messages_select_own on public.zx_messages;
create policy zx_messages_select_own on public.zx_messages
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists zx_messages_insert_own on public.zx_messages;
create policy zx_messages_insert_own on public.zx_messages
  for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists zx_messages_delete_own on public.zx_messages;
create policy zx_messages_delete_own on public.zx_messages
  for delete to authenticated using (auth.uid() = user_id);

-- 只由管理员/Worker 定时调用。按最后活动时间清理会话，消息通过外键级联删除。
create or replace function public.zx_cleanup_expired_conversations()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare deleted_count bigint;
begin
  delete from public.zx_conversations
  where last_activity_at < now() - interval '90 days';
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

revoke all on function public.zx_cleanup_expired_conversations() from public, anon, authenticated;
grant execute on function public.zx_cleanup_expired_conversations() to service_role;

-- 限制表访问面：前端登录用户只可通过 RLS 访问自己的行。
revoke all on public.zx_conversations, public.zx_messages from anon, authenticated;
-- 所有聊天表读写均经 Worker 完成。前端只使用 Supabase Auth，不直接查询表，
-- 从而避免客户端绕过 Worker 的 app_id 产品隔离。

-- 自动清理：先在 Supabase Dashboard 的 Database → Extensions 启用 pg_cron，
-- 再取消下面两行注释并执行；若当前项目不支持 pg_cron，改由受保护的 Worker Cron 调用清理函数。
-- select cron.schedule('zx-chat-retention-90d', '17 3 * * *', $$select public.zx_cleanup_expired_conversations();$$);
