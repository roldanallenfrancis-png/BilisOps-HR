-- ═══════════════════════════════════════════════════════════════════════════
-- MIGRATION: multi-tenancy (+ phone & module on registrations)
-- Run this ONCE on your existing project: SQL Editor → paste → Run.
-- Every approved registration becomes a TENANT; all business data carries its
-- tenant_id so each customer's data is separate and easy to identify.
-- (Fresh installs don't need this — schema.sql already includes everything.)
-- ═══════════════════════════════════════════════════════════════════════════

-- Registrations: contact/demo fields + the tenant id assigned on approval
alter table registrations add column if not exists phone text;
alter table registrations add column if not exists module text;
alter table registrations add column if not exists tenant_id uuid;

-- Logins: which business each account belongs to (null = platform super admin)
alter table admin_accounts add column if not exists tenant_id uuid;

-- Business data tables: stamp every row with its tenant
alter table employees     add column if not exists tenant_id uuid not null default '00000000-0000-0000-0000-000000000000';
alter table attendance    add column if not exists tenant_id uuid not null default '00000000-0000-0000-0000-000000000000';
alter table leaves        add column if not exists tenant_id uuid not null default '00000000-0000-0000-0000-000000000000';
alter table roles         add column if not exists tenant_id uuid not null default '00000000-0000-0000-0000-000000000000';
alter table notifications add column if not exists tenant_id uuid not null default '00000000-0000-0000-0000-000000000000';
alter table audit_log     add column if not exists tenant_id uuid not null default '00000000-0000-0000-0000-000000000000';

-- Employee IDs are now unique PER TENANT (two businesses can both have EMP001)
alter table attendance drop constraint if exists attendance_employee_id_fkey;
alter table employees  drop constraint if exists employees_pkey cascade;
alter table employees  add primary key (tenant_id, id);

-- Attendance: one row per employee per day, per tenant
alter table attendance drop constraint if exists attendance_employee_id_date_key;
alter table attendance add constraint attendance_tenant_emp_date_key unique (tenant_id, employee_id, date);
alter table attendance add constraint attendance_tenant_emp_fkey
  foreign key (tenant_id, employee_id) references employees(tenant_id, id) on delete cascade;

-- Roles: role names are per tenant
alter table roles drop constraint if exists roles_pkey;
alter table roles add primary key (tenant_id, name);

-- Helpful indexes for tenant-filtered queries
create index if not exists employees_tenant_idx     on employees(tenant_id);
create index if not exists attendance_tenant_idx    on attendance(tenant_id, date);
create index if not exists leaves_tenant_idx        on leaves(tenant_id);
create index if not exists notifications_tenant_idx on notifications(tenant_id);
create index if not exists audit_log_tenant_idx     on audit_log(tenant_id);
