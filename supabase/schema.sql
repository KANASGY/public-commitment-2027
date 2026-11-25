-- 2027 パブリックコミットメント：テーブルと権限
-- Supabase の SQL Editor に貼り付けて、Run を1回押す

-- メンバーの表示名
create table if not exists public.profiles (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default '',
  declared_on  date,
  updated_at   timestamptz not null default now()
);

-- 目標
create table if not exists public.goals (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users (id) on delete cascade,
  position    int  not null default 0,
  goal        text not null default '',
  due         date,
  category    text,
  status      text not null default '未着手'
              check (status in ('未着手', '進行中', '達成', '保留', '断念')),
  memo        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists goals_user_position on public.goals (user_id, position);

-- 権限：誰でも読める。書けるのはログインした本人の行だけ
alter table public.profiles enable row level security;
alter table public.goals    enable row level security;

drop policy if exists "profiles are public"      on public.profiles;
drop policy if exists "own profile insert"       on public.profiles;
drop policy if exists "own profile update"       on public.profiles;
drop policy if exists "goals are public"         on public.goals;
drop policy if exists "own goals insert"         on public.goals;
drop policy if exists "own goals update"         on public.goals;
drop policy if exists "own goals delete"         on public.goals;

create policy "profiles are public" on public.profiles
  for select to anon, authenticated using (true);
create policy "own profile insert" on public.profiles
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "own profile update" on public.profiles
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy "goals are public" on public.goals
  for select to anon, authenticated using (true);
create policy "own goals insert" on public.goals
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "own goals update" on public.goals
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own goals delete" on public.goals
  for delete to authenticated using (user_id = (select auth.uid()));

-- 更新日時を自動で入れる
create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists goals_touch on public.goals;
create trigger goals_touch before update on public.goals
  for each row execute function public.touch_updated_at();

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();
