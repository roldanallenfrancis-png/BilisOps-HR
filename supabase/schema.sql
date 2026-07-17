-- ═══════════════════════════════════════════════════════════════════════════
-- BilisOps — Supabase schema
-- Run this once in your new project: Supabase Dashboard → SQL Editor → paste → Run.
-- Creates every table the landing / app / admin / kiosk APK share, enables
-- realtime, and seeds the first super-admin (admin / admin — change it after
-- first login!).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Employees ────────────────────────────────────────────────────────────────
create table if not exists employees (
  tenant_id        uuid not null default '00000000-0000-0000-0000-000000000000',
  id               text not null,
  name             text not null,
  position         text,
  department       text,
  role             text default 'Staff',
  contact          text,
  qr_code          text,
  rfid_uid         text,
  face_descriptors jsonb default '[]'::jsonb,
  status           text default 'active',
  emp_type         text default 'Regular',
  start_date       date,
  schedule         jsonb,
  monthly_rate     numeric default 0,
  allowance        numeric default 0,
  sss_no           text,
  philhealth_no    text,
  pagibig_no       text,
  tin_no           text,
  created_at       timestamptz default now(),
  primary key (tenant_id, id)
);

-- ── Attendance (one row per employee per day) ────────────────────────────────
create table if not exists attendance (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null default '00000000-0000-0000-0000-000000000000',
  employee_id        text not null,
  date               date not null,
  time_in            time,
  time_out           time,
  break_start        time,
  break_end          time,
  coffee_start       time,
  coffee_end         time,
  lunch_start        time,
  lunch_end          time,
  coffee_over        integer default 0,
  lunch_over         integer default 0,
  late_minutes       integer default 0,
  over_break_minutes integer default 0,
  hours_worked       numeric,
  status             text,
  is_day_off_scan    boolean default false,
  is_incomplete      boolean default false,
  time_in_src        text,
  time_out_src       text,
  schedule_override  jsonb,
  created_at         timestamptz default now(),
  unique (tenant_id, employee_id, date),
  foreign key (tenant_id, employee_id) references employees(tenant_id, id) on delete cascade
);
create index if not exists attendance_date_idx on attendance(date);

-- ── Leaves ───────────────────────────────────────────────────────────────────
create table if not exists leaves (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null default '00000000-0000-0000-0000-000000000000',
  employee_id text not null,
  date_from   date not null,
  date_to     date not null,
  leave_type  text default 'leave',              -- leave | halfday | offset
  reason      text,
  filed_by    text,
  status      text default 'approved',           -- pending | approved | rejected
  reviewed_by text,
  offset_hours numeric,
  created_at  timestamptz default now()
);

-- ── Roles (managed list used by Settings) ────────────────────────────────────
create table if not exists roles (
  tenant_id  uuid not null default '00000000-0000-0000-0000-000000000000',
  name       text not null,
  created_at timestamptz default now(),
  primary key (tenant_id, name)
);

-- ── Notifications (admin bell) ───────────────────────────────────────────────
create table if not exists notifications (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null default '00000000-0000-0000-0000-000000000000',
  type        text,
  title       text,
  message     text,
  employee_id text,
  department  text,
  is_read     boolean default false,
  created_at  timestamptz default now()
);

-- ── Audit log ────────────────────────────────────────────────────────────────
create table if not exists audit_log (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null default '00000000-0000-0000-0000-000000000000',
  actor      text,
  action     text,
  target     text,
  details    text,
  created_at timestamptz default now()
);

-- ── Admin accounts (login) ───────────────────────────────────────────────────
create table if not exists admin_accounts (
  id                   uuid primary key default gen_random_uuid(),
  username             text unique not null,
  password_hash        text not null,
  role                 text default 'admin',        -- 'admin' | 'super_admin'
  department_access    jsonb,                        -- null = all departments
  is_active            boolean default true,
  must_change_password boolean default false,
  tenant_id            uuid,                          -- the business this login belongs to (null = platform super admin)
  employee_id          text,                          -- set for employee portal logins (role = 'employee')
  last_login           timestamptz,
  created_at           timestamptz default now()
);

-- ── Registrations (public sign-ups from the landing, approved in the admin) ──
create table if not exists registrations (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  company       text,
  email         text not null,
  phone         text,
  module        text,                                 -- demo they chose: Attendance | Payroll | Directory | All-in-One
  username      text not null,
  password_hash text not null,
  role          text default 'admin',
  status        text default 'pending',              -- pending | approved | rejected
  tenant_id     uuid,                                 -- set on approval (= this registration's id)
  reviewed_by   text,
  reviewed_at   timestamptz,
  created_at    timestamptz default now()
);

-- ── Payroll ──────────────────────────────────────────────────────────────────
create table if not exists payroll_settings (
  tenant_id  uuid primary key,
  settings   jsonb not null,
  updated_at timestamptz default now()
);
create table if not exists payroll_runs (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null default '00000000-0000-0000-0000-000000000000',
  period_start date not null,
  period_end   date not null,
  pay_date     date,
  status       text default 'draft',        -- draft | final
  created_by   text,
  created_at   timestamptz default now()
);
create table if not exists payslips (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null default '00000000-0000-0000-0000-000000000000',
  run_id      uuid references payroll_runs(id) on delete cascade,
  employee_id text not null,
  data        jsonb not null,
  gross       numeric default 0,
  deductions  numeric default 0,
  net         numeric default 0,
  created_at  timestamptz default now()
);
create index if not exists payslips_emp_idx on payslips(tenant_id, employee_id);
create index if not exists payroll_runs_tenant_idx on payroll_runs(tenant_id, period_start);

-- ── RPC: trusted server clock (kiosks sync to this) ──────────────────────────
create or replace function get_server_time()
returns timestamptz language sql stable as $$ select now() $$;

-- ── Realtime: the app live-refreshes on changes to these tables ──────────────
do $$ begin
  alter publication supabase_realtime add table employees;
  exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table attendance;
  exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table leaves;
  exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table roles;
  exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table notifications;
  exception when duplicate_object then null; end $$;

-- ── Row Level Security ───────────────────────────────────────────────────────
-- The front-end talks to these tables directly with the anon key (the app does
-- its own login/role checks). RLS is enabled with permissive policies so the
-- anon key works; tighten these when you move auth server-side.
do $$
declare t text;
begin
  foreach t in array array['employees','attendance','leaves','roles','notifications','audit_log','admin_accounts','registrations','payroll_settings','payroll_runs','payslips']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists "anon full access" on %I', t);
    execute format('create policy "anon full access" on %I for all using (true) with check (true)', t);
  end loop;
end $$;

-- ── Seed: first super-admin (admin / admin) — CHANGE THE PASSWORD after login ─
insert into admin_accounts (username, password_hash, role, is_active, must_change_password)
values ('admin', encode('admin'::bytea, 'base64'), 'super_admin', true, false)
on conflict (username) do nothing;
