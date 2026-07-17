// ─────────────────────────────────────────────────────────────────────────────
// DATA LAYER
// Production: a real Supabase client (shared backend for the landing, app,
// admin, and kiosk APK across domains). Set VITE_SUPABASE_URL and
// VITE_SUPABASE_ANON_KEY in .env (see .env.example) — Supabase → Settings → API.
//
// Local dev fallback: when those env vars are NOT set, a tiny localStorage stub
// stands in so the app still runs fully offline. Every stub table starts EMPTY;
// the only seeded row is one admin account (admin / admin).
// ─────────────────────────────────────────────────────────────────────────────
import { createClient } from '@supabase/supabase-js'

const SUPA_URL  = import.meta.env.VITE_SUPABASE_URL
const SUPA_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY

// ── Local stub (dev only) ────────────────────────────────────────────────────
const PREFIX = 'ac_db_';
const uid = () => (crypto?.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(36).slice(2));
const nowISO = () => new Date().toISOString();

function loadTable(name) {
  try { return JSON.parse(localStorage.getItem(PREFIX + name) || '[]'); }
  catch { return []; }
}
function saveTable(name, rows) {
  try { localStorage.setItem(PREFIX + name, JSON.stringify(rows)); } catch {}
}

const ok = (data = null) => ({ data, error: null });

class Query {
  constructor(table) {
    this.table = table;
    this._op = 'select';
    this._payload = null;
    this._conflict = null;
    this._filters = [];
    this._order = null;
    this._limit = null;
    this._single = null;
  }
  select() { if (this._op === 'noop') this._op = 'select'; return this; }
  insert(rows) { this._op = 'insert'; this._payload = rows; return this; }
  update(vals) { this._op = 'update'; this._payload = vals; return this; }
  upsert(rows, opts) { this._op = 'upsert'; this._payload = rows; this._conflict = opts?.onConflict || null; return this; }
  delete() { this._op = 'delete'; return this; }

  eq(c, v)  { this._filters.push(r => r[c] === v); return this; }
  neq(c, v) { this._filters.push(r => r[c] !== v); return this; }
  in(c, vs) { this._filters.push(r => vs.includes(r[c])); return this; }
  is(c, v)  { this._filters.push(r => (v === null ? r[c] === null || r[c] === undefined : r[c] === v)); return this; }
  not(c, _op, v) { this._filters.push(r => !(v === null ? r[c] === null || r[c] === undefined : r[c] === v)); return this; }
  gte(c, v) { this._filters.push(r => r[c] >= v); return this; }
  lte(c, v) { this._filters.push(r => r[c] <= v); return this; }
  order(c, opts) { this._order = { c, asc: opts?.ascending !== false }; return this; }
  limit(n) { this._limit = n; return this; }

  maybeSingle() { this._single = 'maybe'; return this._exec(); }
  single() { this._single = 'single'; return this._exec(); }
  then(res, rej) { return this._exec().then(res, rej); }

  _match(rows) { return rows.filter(r => this._filters.every(f => f(r))); }

  _exec() {
    return new Promise(resolve => {
      let rows = loadTable(this.table);

      if (this._op === 'insert' || this._op === 'upsert') {
        const incoming = (Array.isArray(this._payload) ? this._payload : [this._payload]).map(r => ({ ...r }));
        for (const row of incoming) {
          if (row.id === undefined || row.id === null) row.id = uid();
          if (row.created_at === undefined) row.created_at = nowISO();
        }
        if (this._op === 'upsert' && this._conflict) {
          const keys = this._conflict.split(',').map(s => s.trim());
          for (const row of incoming) {
            const idx = rows.findIndex(existing => keys.every(k => existing[k] === row[k]));
            if (idx >= 0) rows[idx] = { ...rows[idx], ...row };
            else rows.push(row);
          }
        } else {
          rows.push(...incoming);
        }
        saveTable(this.table, rows);
        return resolve(ok(incoming));
      }

      if (this._op === 'update') {
        const matched = this._match(rows);
        for (const r of matched) Object.assign(r, this._payload);
        saveTable(this.table, rows);
        return resolve(ok(matched));
      }

      if (this._op === 'delete') {
        const keep = rows.filter(r => !this._filters.every(f => f(r)));
        saveTable(this.table, keep);
        return resolve(ok(null));
      }

      // select
      let out = this._match(rows);
      if (this._order) {
        const { c, asc } = this._order;
        out = [...out].sort((a, b) => {
          const av = a[c], bv = b[c];
          if (av === bv) return 0;
          if (av === null || av === undefined) return 1;
          if (bv === null || bv === undefined) return -1;
          return (av < bv ? -1 : 1) * (asc ? 1 : -1);
        });
      }
      if (this._limit != null) out = out.slice(0, this._limit);
      if (this._single) return resolve(ok(out[0] ?? null));
      return resolve(ok(out));
    });
  }
}

function makeChannel() {
  const ch = { on() { return ch; }, subscribe() { return ch; }, unsubscribe() { return ch; } };
  return ch;
}

function makeLocalStub() {
  // One-time seed: a single super-admin so the portal can be opened. Nothing else.
  if (!localStorage.getItem(PREFIX + '_seeded')) {
    saveTable('admin_accounts', [{
      id: 'admin-1',
      username: 'admin',
      password_hash: btoa('admin'),
      role: 'super_admin',
      is_active: true,
      must_change_password: false,
      department_access: null,
      last_login: null,
      created_at: nowISO(),
    }]);
    localStorage.setItem(PREFIX + '_seeded', '1');
  }
  return {
    from(table) { return new Query(table); },
    channel() { return makeChannel(); },
    removeChannel() {},
    async rpc(name) {
      if (name === 'get_server_time') return ok(nowISO());
      if (name === 'record_rfid_scan') return ok({ status: 'error', message: 'No RFID backend configured in local mode.' });
      return ok(null);
    },
  };
}

// ── Pick the real client when configured, else the local stub ────────────────
const baseClient = (SUPA_URL && SUPA_ANON)
  ? createClient(SUPA_URL, SUPA_ANON)
  : makeLocalStub();

export const isLiveBackend = !!(SUPA_URL && SUPA_ANON);

// ─────────────────────────────────────────────────────────────────────────────
// MULTI-TENANCY
// Every approved registration becomes a TENANT (its id = the registration id).
// All business data rows carry a tenant_id. This wrapper makes that automatic
// for every query in the app:
//   • writes  → tenant_id is stamped onto inserted/upserted rows
//   • reads   → filtered to the signed-in tenant (super admin sees everything)
//   • upserts → conflict targets are rewritten to include tenant_id
// Call setTenant(id) after login / setTenant(null) on logout.
// NOTE: with the anon key this is app-level separation (fine for a pilot);
// hard isolation needs server-side auth + RLS per tenant.
// ─────────────────────────────────────────────────────────────────────────────
const SENTINEL_TENANT = '00000000-0000-0000-0000-000000000000'; // platform-owned rows (super admin)
const SCOPED_TABLES = ['employees','attendance','leaves','roles','notifications','audit_log','payroll_settings','payroll_runs','payslips'];

let TENANT_ID = null;
export function setTenant(id) { TENANT_ID = id || null; }
export function getTenant() { return TENANT_ID; }

export const supabase = {
  from(table) {
    const b = baseClient.from(table);
    if (!SCOPED_TABLES.includes(table)) return b;
    const tid = TENANT_ID;                       // read filter only when a tenant is active
    const writeTid = TENANT_ID || SENTINEL_TENANT; // writes are always stamped
    const stamp = r => Array.isArray(r) ? r.map(x => ({ tenant_id: writeTid, ...x })) : ({ tenant_id: writeTid, ...r });
    return {
      select: (...a) => { const q = b.select(...a); return tid ? q.eq('tenant_id', tid) : q; },
      insert: (rows) => b.insert(stamp(rows)),
      upsert: (rows, o) => b.upsert(stamp(rows), o?.onConflict ? { ...o, onConflict: [...new Set(['tenant_id', ...o.onConflict.split(',')])].join(',') } : o),
      update: (v) => { const q = b.update(v); return tid ? q.eq('tenant_id', tid) : q; },
      delete: () => { const q = b.delete(); return tid ? q.eq('tenant_id', tid) : q; },
    };
  },
  channel: (...a) => baseClient.channel(...a),
  removeChannel: (...a) => baseClient.removeChannel(...a),
  rpc: (...a) => baseClient.rpc(...a),
};
