-- ═══════════════════════════════════════════════════════════════════════════
-- MIGRATION: full HR suite — Payroll, Employee portal accounts, Leave approvals
-- Run ONCE on your existing project: SQL Editor → paste → Run.
-- (Fresh installs don't need this — schema.sql already includes everything.)
-- ═══════════════════════════════════════════════════════════════════════════

-- Employee portal logins: link an account to an employee record
alter table admin_accounts add column if not exists employee_id text;

-- Employee pay setup (used by Payroll)
alter table employees add column if not exists monthly_rate   numeric default 0;
alter table employees add column if not exists allowance      numeric default 0;   -- non-taxable allowance per month
alter table employees add column if not exists sss_no         text;
alter table employees add column if not exists philhealth_no  text;
alter table employees add column if not exists pagibig_no     text;
alter table employees add column if not exists tin_no         text;

-- Leave approvals + offset requests (employees file, admins approve)
alter table leaves add column if not exists status       text default 'approved';  -- pending | approved | rejected
alter table leaves add column if not exists reviewed_by  text;
alter table leaves add column if not exists offset_hours numeric;                  -- for leave_type = 'offset'

-- Payroll settings: one row per tenant, the whole config as jsonb
create table if not exists payroll_settings (
  tenant_id  uuid primary key,
  settings   jsonb not null,
  updated_at timestamptz default now()
);

-- Payroll runs (a pay period computed for all employees)
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

-- Payslips (one per employee per run; data jsonb = full line-item breakdown)
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

-- RLS for the new tables (same permissive posture as the rest)
do $$
declare t text;
begin
  foreach t in array array['payroll_settings','payroll_runs','payslips']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists "anon full access" on %I', t);
    execute format('create policy "anon full access" on %I for all using (true) with check (true)', t);
  end loop;
end $$;
