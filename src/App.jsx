import { useState, useEffect, useRef, useCallback, useMemo, Component } from "react";
import { supabase, setTenant, getTenant } from './supabase.js';
import { PH_PAYROLL_DEFAULTS, mergeSettings, applyStatutoryUpdate, computePayslip, computeSSS, computePhilHealth, computePagibig, peso } from './payroll.js';
import { FaceEnroll } from './FaceEnroll.jsx';
import { loadFaceModels, detectFace, buildMatcher, MATCH_THRESHOLD } from './face.js';

// ─── UTILS ───────────────────────────────────────────────────────────────────
// All dates/times are expressed in PHILIPPINE time (Asia/Manila), regardless of the
// device's own timezone setting. To avoid trusting a wrong device clock, we keep an
// OFFSET against the Supabase server's clock (synced when online) and apply it to the
// "now" used everywhere. Offline, it falls back to the last-known offset (or the device).
const PH_TZ = 'Asia/Manila';
let TIME_OFFSET_MS = (()=>{ try{ const v=localStorage.getItem('attendancehq_time_offset'); const n=v?Number(v):0; return Number.isFinite(n)?n:0; }catch{ return 0; } })();
const setTimeOffset = (ms) => { if(Number.isFinite(ms)){ TIME_OFFSET_MS=ms; try{ localStorage.setItem('attendancehq_time_offset', String(ms)); }catch{} } };
// Authoritative "now": device clock corrected by the server offset.
const nowDate = () => new Date(Date.now() + TIME_OFFSET_MS);
const localDateStr = (d=nowDate()) => {
  const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:PH_TZ,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(d).map(x=>[x.type,x.value]));
  return `${p.year}-${p.month}-${p.day}`;
};
// Current wall-clock time in Manila as "HH:MM" (24h) — used to stamp scans.
const phTimeStr = (d=nowDate()) => {
  const p=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:PH_TZ,hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(d).map(x=>[x.type,x.value]));
  return `${p.hour}:${p.minute}`;
};
// Minutes-since-midnight in Manila time (for "now" comparisons in status logic).
const phNowMins = (d=nowDate()) => { const [h,m]=phTimeStr(d).split(":").map(Number); return (h||0)*60+(m||0); };
// Day-of-week index (0=Sun) in Manila time.
const phDayIdx = (d=nowDate()) => new Date(localDateStr(d)+"T00:00:00").getDay();
const getToday  = () => localDateStr();
const daysAgoStr = n => { const d=nowDate(); d.setDate(d.getDate()-n); return localDateStr(d); };
const fmt       = t => { if (!t) return "—"; const [h,m]=String(t).split(":"); const hr=+h; return `${hr%12||12}:${m} ${hr<12?"AM":"PM"}`; };
const fmtDate   = d => { if (!d) return ""; return new Date(d+"T00:00:00").toLocaleDateString("en-PH",{month:"short",day:"numeric",year:"numeric"}); };
const toMins    = t => { if (!t) return 0; const [h,m]=String(t).split(":").map(Number); return (h||0)*60+(m||0); };
// Blank/missing values must fall back to the default — Number("")/Number(null) are 0, which
// silently turned a cleared form field into a 0-minute break allowance (every break = over).
const numOr     = (v,def) => { if(v===''||v===null||v===undefined) return def; const n=Number(v); return Number.isFinite(n)?n:def; };
// Breaks aren't tied to scan order (someone may take their long break first). We classify a
// break by its DURATION: longer than BREAK_LUNCH_THRESHOLD minutes = a LUNCH break (judged vs
// the lunch cap); anything shorter = a COFFEE break (judged vs the coffee cap). This keeps the
// over-limit check and the icon matching the break's real nature, not which slot it was scanned
// into — so a 56-min break taken first is lunch, and a later 20-min break is coffee.
const BREAK_LUNCH_THRESHOLD = 30; // minutes — a break longer than this counts as lunch
const classifyBreakDur = (dur) => dur > BREAK_LUNCH_THRESHOLD ? 'lunch' : 'coffee';
// Minutes between two "HH:MM" times, 0 when either end is missing (break still open / never taken).
const breakSpan = (s,e) => s&&e ? Math.max(0,toMins(e)-toMins(s)) : 0;
// Tenure since a join date → "2 yr 3 mo" style, plus total months
function tenureFrom(dateStr) {
  if (!dateStr) return {label:"—", months:0};
  const start=new Date(String(dateStr).slice(0,10)+"T00:00:00");
  if (isNaN(start)) return {label:"—", months:0};
  const now=new Date();
  let months=(now.getFullYear()-start.getFullYear())*12+(now.getMonth()-start.getMonth());
  if (now.getDate()<start.getDate()) months--;
  months=Math.max(0,months);
  const y=Math.floor(months/12), m=months%12;
  const parts=[]; if(y>0)parts.push(`${y} yr`); if(m>0)parts.push(`${m} mo`);
  return {label: parts.length?parts.join(" "):"<1 mo", months};
}
// Department matcher supporting "all" | single name | {multi:[names]}
const deptMatch = (activeDept, dept) => {
  if (!activeDept || activeDept==="all") return true;
  if (typeof activeDept==="object" && Array.isArray(activeDept.multi)) return activeDept.multi.includes(dept);
  return dept===activeDept;
};
const deptLabel = (activeDept) => {
  if (!activeDept || activeDept==="all") return "";
  if (typeof activeDept==="object") return activeDept.multi.join(", ");
  return activeDept;
};
const DAYS_OF_WEEK = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];
const DAY_NAMES    = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
const DEFAULT_SCHEDULE = { shiftStart:"08:00", shiftEnd:"17:00", gracePeriod:10, coffeeBreak:15, lunchBreak:60, restDays:["Saturday","Sunday"] };
// Run every schedule through this before persisting — a blank field must never be stored
// as a 0-minute allowance (an admin can still type an explicit 0 deliberately).
const sanitizeSchedule = s => ({ ...s,
  shiftStart:  s.shiftStart || DEFAULT_SCHEDULE.shiftStart,
  shiftEnd:    s.shiftEnd   || DEFAULT_SCHEDULE.shiftEnd,
  gracePeriod: numOr(s.gracePeriod, DEFAULT_SCHEDULE.gracePeriod),
  coffeeBreak: numOr(s.coffeeBreak, DEFAULT_SCHEDULE.coffeeBreak),
  lunchBreak:  numOr(s.lunchBreak,  DEFAULT_SCHEDULE.lunchBreak),
  restDays:    Array.isArray(s.restDays) ? s.restDays : DEFAULT_SCHEDULE.restDays,
});

// Determine an employee's display status for a given day, accounting for the
// current time. Only marks "absent" AFTER shift start has passed with no time-in.
// `forToday` = true when evaluating the current day (so time-of-day matters).
function computeDisplayStatus(emp, rec, forToday, onLeave) {
  // On leave takes priority over everything except an actual scan
  // (if they scanned despite leave, we still show their attendance).
  const hasTimeIn = rec && rec.timeIn;

  // Effective schedule: per-day override on the record wins over the employee's normal schedule.
  const baseSched = (emp && emp.schedule) ? emp.schedule : DEFAULT_SCHEDULE;
  const sched = (rec && rec.scheduleOverride) ? { ...baseSched, ...rec.scheduleOverride } : baseSched;
  const restDays = Array.isArray(sched.restDays) ? sched.restDays : DEFAULT_SCHEDULE.restDays;
  const shiftStart = sched.shiftStart || DEFAULT_SCHEDULE.shiftStart;
  const grace = numOr(sched.gracePeriod, 0);

  // Weekday should come from the RECORD's date for past days, not today.
  const refDate = (rec && rec.date) ? new Date(String(rec.date).slice(0,10)+"T00:00:00") : new Date();
  const dayName = DAY_NAMES[refDate.getDay()];
  // Per-day override can force this date OFF or WORKING regardless of weekly rest days.
  const ovDayType = (rec && rec.scheduleOverride && rec.scheduleOverride.dayType) || "normal";
  const isRestDay = ovDayType==="off" ? true : ovDayType==="work" ? false : restDays.includes(dayName);

  const recIsToday = forToday || (rec && rec.date && String(rec.date).slice(0,10) >= getToday());
  const isLateNow = hasTimeIn ? (toMins(rec.timeIn) > (toMins(shiftStart) + grace)) : false;

  // Expected shift length (minutes), minus the unpaid break
  const shiftEnd = sched.shiftEnd || DEFAULT_SCHEDULE.shiftEnd;
  const breakDur = numOr(sched.coffeeBreak, 0) + numOr(sched.lunchBreak, 0);
  const expectedMins = Math.max(0, (toMins(shiftEnd) - toMins(shiftStart)) - breakDur);

  // If they actually scanned, show attendance (scan overrides leave).
  if (hasTimeIn) {
    if (rec.isDayOffScan) return "day-off";
    if (ovDayType === "off") return "rest-day";
    if (rec.timeOut) {
      // Worked duration = (out - in) minus break time actually taken.
      // Use the real coffee/lunch fields (legacy break_start/end kept as a fallback for old rows).
      let workedMins = toMins(rec.timeOut) - toMins(rec.timeIn);
      if (rec.coffeeStart && rec.coffeeEnd) workedMins -= (toMins(rec.coffeeEnd) - toMins(rec.coffeeStart));
      if (rec.lunchStart && rec.lunchEnd)   workedMins -= (toMins(rec.lunchEnd)  - toMins(rec.lunchStart));
      if (!rec.coffeeStart && !rec.lunchStart && rec.breakStart && rec.breakEnd) workedMins -= (toMins(rec.breakEnd) - toMins(rec.breakStart));
      workedMins = Math.max(0, workedMins);
      const workedHrs = workedMins/60;
      // Undertime: under 4.5h. Half day: 4.5h up to (expected minus 1h). Else full present/late.
      const fullThreshold = expectedMins>0 ? Math.max(expectedMins-60, 4.5*60) : 7.5*60;
      if (workedHrs < 4.5) return "undertime";
      if (workedMins < fullThreshold) return "half-day";
      return isLateNow ? "late" : "present";
    }
    // Timed in but NOT timed out yet.
    // Stay "working" until 15 hours have passed since time-in; after that → No Time-Out.
    {
      const recDateStr = (rec && rec.date) ? String(rec.date).slice(0,10) : getToday();
      const timeInMs = new Date(`${recDateStr}T${rec.timeIn}:00`).getTime();
      const hoursSince = (Date.now() - timeInMs) / (1000*60*60);
      if (hoursSince >= 15) return "incomplete";   // 15h elapsed, still no time-out
      return isLateNow ? "late" : "working";
    }
  }

  // No scan: leave wins next. Suspension and a filed Half Day get their own distinct status
  // instead of collapsing into the generic "On Leave" bucket.
  if (onLeave) return onLeave==="suspension"?"suspended":onLeave==="halfday"?"halfday-leave":"on-leave";

  // Don't count as absent for dates BEFORE the employee joined.
  // Floor = explicit startDate if set, else the system createdAt date.
  const evalDate = (rec && rec.date) ? String(rec.date).slice(0,10) : getToday();
  const joinFloor = (emp && (emp.startDate || emp.createdAt)) ? String(emp.startDate || emp.createdAt).slice(0,10) : null;
  if (joinFloor && evalDate < joinFloor) return "n/a";

  // Future dates: nobody has scanned yet, so never "absent" — show as scheduled/upcoming
  // (still honor rest days). This keeps Manpower Planning correct for advance dates.
  if (evalDate > getToday()) return isRestDay ? "rest-day" : "upcoming";

  // No time-in, not on leave.
  if (forToday) {
    if (isRestDay) return "rest-day";
    const nowMins = phNowMins();
    if (nowMins < toMins(shiftStart) + 60) return "upcoming";
    return "absent";
  }
  // Past day, no scan, not on leave: absent (unless it was a rest day)
  if (isRestDay) return "rest-day";
  return "absent";
}

// Recompute late minutes against an employee's CURRENT schedule (so schedule edits apply live)
function liveLateMinutes(emp, rec) {
  if (!emp || !rec || !rec.timeIn || rec.isDayOffScan) return 0;
  const base = emp.schedule || DEFAULT_SCHEDULE;
  const sched = rec.scheduleOverride ? { ...base, ...rec.scheduleOverride } : base;
  const grace = numOr(sched.gracePeriod, 0);
  const shiftStart = sched.shiftStart || DEFAULT_SCHEDULE.shiftStart;
  const late = toMins(rec.timeIn) > (toMins(shiftStart) + grace) ? toMins(rec.timeIn) - toMins(shiftStart) : 0;
  return Math.max(0, late);
}

// Overtime in MINUTES, counted only past the (override-aware) shift end,
// rounded DOWN to 30-minute blocks. Under 30 min → 0. Requires a time-out.
function liveOvertimeMins(emp, rec) {
  if (!emp || !rec || !rec.timeIn || !rec.timeOut || rec.isDayOffScan) return 0;
  const base = emp.schedule || DEFAULT_SCHEDULE;
  const sched = rec.scheduleOverride ? { ...base, ...rec.scheduleOverride } : base;
  const shiftEnd = sched.shiftEnd || DEFAULT_SCHEDULE.shiftEnd;
  const past = toMins(rec.timeOut) - toMins(shiftEnd);
  if (past < 30) return 0;
  return Math.floor(past / 30) * 30; // round down to nearest 30 min
}
const fmtHrs = mins => { const h=Math.floor(mins/60), m=mins%60; if(h&&m)return `${h}h ${m}m`; if(h)return `${h}h`; return `${m}m`; };

// Recompute over-break against the CURRENT (override-aware) schedule instead of trusting the
// frozen rec.*Over values, so a schedule correction applies immediately.
// PER-BREAK BY DURATION: each break is judged against the cap for its type — a break longer than
// BREAK_LUNCH_THRESHOLD counts as lunch (vs the lunch cap), a shorter one as coffee (vs the
// coffee cap) — regardless of the order it was taken.
// The returned {coffee,lunch} are the overages of the 1st/2nd break SLOTS (for the inline chips).
function liveBreakOver(emp, rec) {
  if (!emp || !rec) return { coffee:0, lunch:0, total:0 };
  const base = emp.schedule || DEFAULT_SCHEDULE;
  const sched = rec.scheduleOverride ? { ...base, ...rec.scheduleOverride } : base;
  const coffeeLimit=numOr(sched.coffeeBreak,15), lunchLimit=numOr(sched.lunchBreak,60);
  const coffeeTaken=breakSpan(rec.coffeeStart,rec.coffeeEnd), lunchTaken=breakSpan(rec.lunchStart,rec.lunchEnd);
  // >30 min → judge vs lunch cap, else vs coffee cap.
  const overOf = d => d<=0 ? 0 : Math.max(0, d - (d>BREAK_LUNCH_THRESHOLD ? lunchLimit : coffeeLimit));
  const coffee=overOf(coffeeTaken), lunch=overOf(lunchTaken);
  return { coffee, lunch, total:coffee+lunch };
}
function liveOverBreakMinutes(emp, rec) { return liveBreakOver(emp, rec).total; }

// Check if an employee is on leave for a given date (YYYY-MM-DD) from a leaves array.
// Returns the leave_type string (truthy, so existing `if(onLeave)` checks still work
// unchanged) so callers that care — like computeDisplayStatus — can tell Suspension and
// Half Day apart from a regular leave instead of everything collapsing into "On Leave".
function isOnLeave(leaves, empId, dateStr) {
  if (!Array.isArray(leaves)) return false;
  // Only APPROVED leaves count toward attendance (pending/rejected requests don't).
  const l = leaves.find(l => l.employee_id===empId && (l.status??'approved')==='approved' && String(l.date_from).slice(0,10) <= dateStr && dateStr <= String(l.date_to).slice(0,10));
  return l ? (l.leave_type||"leave") : false;
}

// Write an audit-log entry (best-effort; never blocks the main action)
async function logAudit(actor, action, target, details) {
  try {
    await supabase.from('audit_log').insert({
      actor: (actor && actor.username) || "unknown",
      action, target: target||null, details: details||null,
    });
  } catch {}
}

const statusCls = s => ({
  present:"bg-emerald-100 text-emerald-700 border-emerald-200",
  late:"bg-amber-100 text-amber-700 border-amber-200",
  absent:"bg-red-100 text-red-700 border-red-200",
  "on-break":"bg-blue-100 text-blue-700 border-blue-200",
  "day-off":"bg-purple-100 text-purple-700 border-purple-200",
  incomplete:"bg-orange-100 text-orange-700 border-orange-200",
  upcoming:"bg-sky-100 text-sky-700 border-sky-200",
  "rest-day":"bg-gray-100 text-gray-500 border-gray-200",
  working:"bg-teal-100 text-teal-700 border-teal-200",
  "on-leave":"bg-brand-100 text-brand-700 border-brand-200",
  "half-day":"bg-brand-100 text-brand-700 border-brand-200",
  "halfday-leave":"bg-brand-100 text-brand-700 border-brand-200",
  suspended:"bg-rose-100 text-rose-700 border-rose-200",
  undertime:"bg-orange-100 text-orange-700 border-orange-200",
  "n/a":"bg-gray-50 text-gray-300 border-gray-100",
}[s] || "bg-gray-100 text-gray-500 border-gray-200");

function Badge({ status }) {
  const label = status==="on-break"?"On Break":status==="day-off"?"Day Off":status==="incomplete"?"No Time-Out":status==="upcoming"?"Upcoming":status==="rest-day"?"Rest Day":status==="working"?"Working":status==="on-leave"?"On Leave":status==="half-day"?"Half Day":status==="halfday-leave"?"Half Day":status==="suspended"?"Suspended":status==="undertime"?"Undertime":status==="n/a"?"—":status;
  return <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold border capitalize ${statusCls(status)}`}>{label}</span>;
}

// ─── SESSION PERSISTENCE ──────────────────────────────────────────────────────
const SESSION_KEY = 'attendancehq_session';
const saveSession = (user) => { try { localStorage.setItem(SESSION_KEY, JSON.stringify(user)); } catch{} };
const loadSession = () => { try { const s=localStorage.getItem(SESSION_KEY); return s?JSON.parse(s):null; } catch{ return null; } };
const clearSession = () => { try { localStorage.removeItem(SESSION_KEY); } catch{} };

// Separate, per-device kiosk login. Uses its own localStorage key so logging in on one
// kiosk browser never touches the admin portal's session or any other kiosk device's session.
const KIOSK_SESSION_KEY = 'attendancehq_kiosk_session';
const saveKioskSession = (user) => { try { localStorage.setItem(KIOSK_SESSION_KEY, JSON.stringify(user)); } catch{} };
const loadKioskSession = () => { try { const s=localStorage.getItem(KIOSK_SESSION_KEY); return s?JSON.parse(s):null; } catch{ return null; } };
const clearKioskSession = () => { try { localStorage.removeItem(KIOSK_SESSION_KEY); } catch{} };

// ─── OFFLINE SCAN QUEUE ───────────────────────────────────────────────────────
// When the kiosk is offline, scans are saved here and replayed to Supabase on reconnect.
const SCAN_QUEUE_KEY = 'attendancehq_scan_queue';
const loadScanQueue = () => { try { const s=localStorage.getItem(SCAN_QUEUE_KEY); return s?JSON.parse(s):[]; } catch { return []; } };
const saveScanQueue = (q) => { try { localStorage.setItem(SCAN_QUEUE_KEY, JSON.stringify(q)); } catch{} };
const enqueueScan = (payload) => { const q=loadScanQueue(); q.push(payload); saveScanQueue(q); };

// ─── DB HELPERS ───────────────────────────────────────────────────────────────
function rowToEmp(row) {
  // Always return a complete, valid schedule so nothing downstream can crash
  const s = row.schedule || {};
  const schedule = {
    shiftStart:    s.shiftStart    || DEFAULT_SCHEDULE.shiftStart,
    shiftEnd:      s.shiftEnd      || DEFAULT_SCHEDULE.shiftEnd,
    gracePeriod:   numOr(s.gracePeriod,   DEFAULT_SCHEDULE.gracePeriod),
    coffeeBreak:   numOr(s.coffeeBreak,   DEFAULT_SCHEDULE.coffeeBreak),
    lunchBreak:    numOr(s.lunchBreak,    DEFAULT_SCHEDULE.lunchBreak),
    restDays:      Array.isArray(s.restDays) ? s.restDays : DEFAULT_SCHEDULE.restDays,
  };
  return { id:row.id, name:row.name, position:row.position, department:row.department, role:row.role||'Staff', contact:row.contact||'', qrCode:row.qr_code||'', rfidUid:row.rfid_uid||'', faceDescriptors:Array.isArray(row.face_descriptors)?row.face_descriptors:[], status:row.status, empType:row.emp_type||'Regular', createdAt:row.created_at?String(row.created_at).slice(0,10):null, startDate:row.start_date?String(row.start_date).slice(0,10):null, schedule,
    monthlyRate:Number(row.monthly_rate)||0, allowance:Number(row.allowance)||0, sssNo:row.sss_no||'', philhealthNo:row.philhealth_no||'', pagibigNo:row.pagibig_no||'', tinNo:row.tin_no||'', bankName:row.bank_name||'', bankAccount:row.bank_account||'' };
}
function rowToAttRec(row) {
  return {
    employeeId:row.employee_id, date:String(row.date).slice(0,10),
    timeIn:     row.time_in    ?row.time_in.slice(0,5)    :null,
    breakStart: row.break_start?row.break_start.slice(0,5):null,
    breakEnd:   row.break_end  ?row.break_end.slice(0,5)  :null,
    coffeeStart:row.coffee_start?row.coffee_start.slice(0,5):null,
    coffeeEnd:  row.coffee_end ?row.coffee_end.slice(0,5) :null,
    lunchStart: row.lunch_start?row.lunch_start.slice(0,5):null,
    lunchEnd:   row.lunch_end  ?row.lunch_end.slice(0,5)  :null,
    coffeeOver: row.coffee_over||0,
    lunchOver:  row.lunch_over ||0,
    timeOut:    row.time_out   ?row.time_out.slice(0,5)   :null,
    lateMinutes:     row.late_minutes      ||0,
    overBreakMinutes:row.over_break_minutes||0,
    hoursWorked:     row.hours_worked      ||0,
    status:          row.status,
    isDayOffScan:    row.is_day_off_scan   ||false,
    isIncomplete:    row.is_incomplete     ||false,
    scheduleOverride:row.schedule_override ||null,
    manualEntry:     row.manual_entry      ||false,
    timeInSrc:       row.time_in_src       ||null,
    timeOutSrc:      row.time_out_src      ||null,
    remarks:         row.remarks           ||null,
  };
}
function buildAttMap(rows) {
  const out={};
  for (const row of rows) { const rec=rowToAttRec(row); if(!out[rec.date]) out[rec.date]={}; out[rec.date][rec.employeeId]=rec; }
  return out;
}

// ─── TOAST ───────────────────────────────────────────────────────────────────
function Toast({ toasts, remove }) {
  return (
    <div className="fixed top-5 right-5 z-[9999] flex flex-col gap-2 pointer-events-none">
      {toasts.map(t=>(
        <div key={t.id} className={`pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-2xl shadow-xl text-sm font-medium border
          ${t.type==="success"?"bg-emerald-50 text-emerald-800 border-emerald-200":
            t.type==="warning"?"bg-amber-50 text-amber-800 border-amber-200":
            t.type==="error"  ?"bg-red-50 text-red-800 border-red-200"
                              :"bg-blue-50 text-blue-800 border-blue-200"}`}>
          <span>{t.type==="success"?"✓":t.type==="warning"?"⚠":t.type==="error"?"✕":"ℹ"}</span>
          <span>{t.message}</span>
          <button onClick={()=>remove(t.id)} className="ml-2 opacity-40 hover:opacity-100 text-lg leading-none">×</button>
        </div>
      ))}
    </div>
  );
}

// ─── QR CODE ─────────────────────────────────────────────────────────────────
let jsQRPromise=null;
function loadJsQR() {
  if (window.jsQR) return Promise.resolve(window.jsQR);
  if (jsQRPromise) return jsQRPromise;
  jsQRPromise=new Promise((res,rej)=>{ const s=document.createElement("script"); s.src="https://cdnjs.cloudflare.com/ajax/libs/jsQR/1.4.0/jsQR.min.js"; s.onload=()=>res(window.jsQR); s.onerror=rej; document.head.appendChild(s); });
  return jsQRPromise;
}
let qrLibPromise=null;
function loadQRLib() {
  if (window.QRCode) return Promise.resolve(window.QRCode);
  if (qrLibPromise) return qrLibPromise;
  qrLibPromise=new Promise((res,rej)=>{ const s=document.createElement("script"); s.src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"; s.onload=()=>res(window.QRCode); s.onerror=rej; document.head.appendChild(s); });
  return qrLibPromise;
}
function RealQRCode({ value, size=176 }) {
  const ref=useRef(null); const [failed,setFailed]=useState(false);
  useEffect(()=>{ let c=false; if(!ref.current) return; ref.current.innerHTML="";
    loadQRLib().then(QRCode=>{ if(c||!ref.current) return; ref.current.innerHTML=""; new QRCode(ref.current,{text:value,width:size,height:size,colorDark:"#0f172a",colorLight:"#ffffff",correctLevel:QRCode.CorrectLevel.M}); }).catch(()=>{if(!c)setFailed(true);});
    return ()=>{c=true;};
  },[value,size]);
  if (failed) return <div className="flex items-center justify-center text-xs font-bold text-gray-700 bg-gray-100 rounded" style={{width:size,height:size}}>{value}</div>;
  return <div ref={ref} style={{width:size,height:size}} className="flex items-center justify-center [&>img]:mx-auto"/>;
}

// Bulk-print QR ID cards on A4 (3 columns × 4 rows = 12 per page)
async function printQRCards(emps) {
  if (!emps || emps.length===0) { alert("No employees to print."); return; }
  const QRCode = await loadQRLib();
  // Generate QR data URLs reliably (wait a tick for each to render, prefer canvas)
  const cards = [];
  for (const e of emps) {
    const tmp=document.createElement("div");
    tmp.style.position="absolute"; tmp.style.left="-9999px"; document.body.appendChild(tmp);
    new QRCode(tmp,{text:String(e.id),width:150,height:150,colorDark:"#0f172a",colorLight:"#ffffff",correctLevel:QRCode.CorrectLevel.H});
    await new Promise(r=>setTimeout(r,60)); // let it paint
    let src="";
    const canvas=tmp.querySelector("canvas");
    const img=tmp.querySelector("img");
    if (canvas) { try { src=canvas.toDataURL("image/png"); } catch {} }
    if (!src && img && img.src) src=img.src;
    document.body.removeChild(tmp);
    cards.push({...e, qr:src});
  }
  const html=`<!doctype html><html><head><title>QR ID Cards</title><style>
    @page { size: A4; margin: 10mm; }
    * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; margin:0; }
    .grid { display:grid; grid-template-columns:repeat(3,1fr); gap:6mm; }
    .card { border:1.5px solid #0f172a; border-radius:10px; padding:8px; text-align:center; page-break-inside:avoid; display:flex; flex-direction:column; align-items:center; }
    .card .brand { font-size:9px; font-weight:800; letter-spacing:1px; color:#475569; margin-bottom:4px; text-transform:uppercase; }
    .card img { width:130px; height:130px; }
    .card .id { font-family:monospace; font-size:11px; font-weight:700; margin-top:4px; color:#0f172a; }
    .card .name { font-size:13px; font-weight:800; margin-top:3px; color:#0f172a; line-height:1.1; }
    .card .pos { font-size:10px; color:#64748b; margin-top:2px; }
    .card .dept { font-size:9px; color:#94a3b8; margin-top:1px; }
  </style></head><body>
    <div class="grid">
      ${cards.map(c=>`<div class="card">
        <div class="brand">BilisOps</div>
        <img src="${c.qr}"/>
        <div class="id">${c.id}</div>
        <div class="name">${(c.name||"").replace(/</g,"&lt;")}</div>
        <div class="pos">${(c.position||"").replace(/</g,"&lt;")}</div>
        <div class="dept">${(c.department||"").replace(/</g,"&lt;")}</div>
      </div>`).join("")}
    </div>
    <script>window.onload=()=>{setTimeout(()=>window.print(),400);};<\/script>
  </body></html>`;
  const w=window.open("","_blank");
  if (!w) { alert("Please allow pop-ups to print."); return; }
  w.document.write(html); w.document.close();
}

// ─── SCHEDULE FORM ────────────────────────────────────────────────────────────
function ScheduleForm({ value, onChange }) {
  const set=(k,v)=>onChange({...value,[k]:v});
  const toggleDay=d=>set("restDays",value.restDays.includes(d)?value.restDays.filter(x=>x!==d):[...value.restDays,d]);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        {[{k:"shiftStart",l:"Shift Start",t:"time"},{k:"shiftEnd",l:"Shift End",t:"time"},{k:"gracePeriod",l:"Grace Period (min)",t:"number"},{k:"coffeeBreak",l:"Coffee Break (min)",t:"number"},{k:"lunchBreak",l:"Lunch Break (min)",t:"number"}].map(({k,l,t})=>(
          <div key={k}><label className="text-xs font-bold text-gray-500 uppercase tracking-wider block mb-1">{l}</label>
            <input type={t} value={value[k]??""} onChange={e=>set(k,t==="number"?(e.target.value===""?"":+e.target.value):e.target.value)} className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-200"/></div>
        ))}
      </div>
      <div><label className="text-xs font-bold text-gray-500 uppercase tracking-wider block mb-2">Rest Days</label>
        <div className="flex flex-wrap gap-1.5">
          {DAYS_OF_WEEK.map(d=>(
            <button key={d} type="button" onClick={()=>toggleDay(d)}
              className={`px-3 py-1.5 rounded-xl text-xs font-semibold border transition-colors ${value.restDays.includes(d)?"bg-brand-500 text-white border-brand-500":"bg-gray-50 text-gray-600 border-gray-200 hover:border-slate-400"}`}>{d.slice(0,3)}</button>
          ))}
        </div>
      </div>
      <div className="bg-slate-50 rounded-2xl p-3.5 border border-slate-100 text-xs grid grid-cols-2 gap-y-1.5">
        <span className="text-gray-400">Shift</span><span className="font-semibold text-gray-700">{fmt(value.shiftStart)} – {fmt(value.shiftEnd)}</span>
        <span className="text-gray-400">Coffee Break</span><span className="font-semibold text-gray-700">{value.coffeeBreak} min</span>
        <span className="text-gray-400">Lunch Break</span><span className="font-semibold text-gray-700">{value.lunchBreak} min</span>
        <span className="text-gray-400">Grace</span><span className="font-semibold text-gray-700">{value.gracePeriod} min</span>
        <span className="text-gray-400">Rest Days</span><span className="font-semibold text-gray-700">{value.restDays.join(", ")||"None"}</span>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// LANDING PAGE
// ════════════════════════════════════════════════════════════════════════════
// ─── Icon set ───────────────────────────────────────────────────────────────
// Clean, single-weight line icons (Lucide-style) so the whole UI shares ONE
// visual language instead of a grab-bag of emoji + geometric glyphs.
function Icon({ name, className="w-5 h-5" }) {
  const paths = {
    dashboard: <><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></>,
    employees: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></>,
    directory: <><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2.2"/><path d="M5.5 16.5a3.5 3.5 0 0 1 7 0"/><path d="M15 9.5h4M15 13.5h4"/></>,
    schedules: <><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></>,
    leaves: <><path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2Z"/></>,
    manpower: <><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M9 12h6M9 16h4"/></>,
    behavior: <><path d="M3 3v18h18"/><path d="M18 9l-5 5-3-3-4 4"/></>,
    reports: <><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v5h5"/><path d="M8 13h8M8 17h5"/></>,
    accounts: <><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></>,
    logout: <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></>,
    menu: <><path d="M3 12h18M3 6h18M3 18h18"/></>,
    scan: <><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><rect x="7.5" y="7.5" width="9" height="9" rx="1"/></>,
    lock: <><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></>,
    face: <><circle cx="12" cy="12" r="9"/><path d="M9 10h.01M15 10h.01"/><path d="M8.5 14.5a4 4 0 0 0 7 0"/></>,
    edit: <><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></>,
    qr: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3M20 14v.01M14 20v.01M17 20h.01M20 17v3"/></>,
    pause: <><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></>,
    play: <><path d="M6 4l14 8-14 8Z"/></>,
    trash: <><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></>,
    payroll: <><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01M18 12h.01"/></>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    puzzle: <><path d="M9 4a2 2 0 0 1 4 0v1h3a1 1 0 0 1 1 1v3h1a2 2 0 0 1 0 4h-1v3a1 1 0 0 1-1 1h-3v-1a2 2 0 0 0-4 0v1H6a1 1 0 0 1-1-1v-3H4a2 2 0 0 1 0-4h1V6a1 1 0 0 1 1-1h3Z"/></>,
    bolt: <><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></>,
    shield: <><path d="M12 3l8 3v5c0 5-3.5 8-8 10-4.5-2-8-5-8-10V6l8-3z"/><path d="M9 12l2 2 4-4"/></>,
    userplus: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/></>,
    mail: <><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></>,
    building: <><rect x="4" y="3" width="16" height="18" rx="1.5"/><path d="M9 8h.01M15 8h.01M9 12h.01M15 12h.01M9 16h6"/></>,
    check: <><path d="M20 6 9 17l-5-5"/></>,
  };
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>{paths[name]||null}</svg>;
}

// ── Module entitlements ──────────────────────────────────────────────────────
// Which parts of the suite a tenant can use, from the demo/plan they registered
// for. null/undefined modules = everything (super admin, legacy accounts).
const ALL_MODULES = ['attendance','payroll','directory'];
const modulesOf = m =>
  m === 'Attendance' ? ['attendance'] :
  m === 'Payroll'    ? ['payroll']    :
  m === 'Directory'  ? ['directory']  : ALL_MODULES;
const hasMod = (user, m) => !user?.modules || user.modules.includes(m);
// Admin pages an account can be granted (page_access). null = all pages.
const PAGE_OPTIONS=[["dashboard","Dashboard"],["employees","Employees"],["directory","Directory"],["schedules","Schedules"],["leaves","Leave"],["manpower","Manpower"],["behavior","Behavior"],["reports","Reports"],["payroll","Payroll"]];
const canPage = (user, k) => !user?.pageAccess || user.pageAccess.includes(k);

// Brand mark — green rounded square with a white lightning bolt (inverted = white tile, green bolt).
function BrandMark({ className="w-10 h-10 rounded-2xl", inverted=false }) {
  return (
    <div className={`${inverted?"bg-white":"bg-brand-500 shadow-brand"} flex items-center justify-center shrink-0 ${className}`}>
      <svg viewBox="0 0 24 24" className="w-1/2 h-1/2" fill={inverted?"#5ac56b":"white"}><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
    </div>
  );
}

function LandingPage({ onSelect }) {
  const [regModule,setRegModule]=useState(null);   // non-null → register popup open, value = chosen module
  const [showDemo,setShowDemo]=useState(false);     // demo chooser popup
  const DEMOS=[
    {key:"Attendance", icon:"clock",     desc:"QR & face check-in, schedules, and live reports."},
    {key:"Payroll",    icon:"payroll",   desc:"Automated pay runs, computations, and payslips."},
    {key:"Directory",  icon:"directory", desc:"Employee records, org structure, and documents."},
    {key:"All-in-One", icon:"dashboard", desc:"The complete BilisOps HR suite in one account."},
  ];
  return (
    <div className="scene-3d-light relative min-h-screen bg-gradient-to-b from-white via-mist to-brand-50">
      {/* Demo chooser popup — pick a module, then register for that demo */}
      {showDemo&&(
        <div className="!fixed inset-0 bg-slate-900/25 !z-[100] flex items-center justify-center p-4 sm:p-6" onClick={()=>setShowDemo(false)}>
          <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] overflow-y-auto p-6 sm:p-8" onClick={e=>e.stopPropagation()}>
            <button onClick={()=>setShowDemo(false)} title="Close" className="absolute top-4 right-4 w-9 h-9 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 flex items-center justify-center text-lg">✕</button>
            <h1 className="text-2xl font-black text-ink">Choose your demo</h1>
            <p className="text-gray-500 text-sm mt-1 mb-5">Pick the module you want to try — your trial account starts there.</p>
            <div className="grid sm:grid-cols-2 gap-3">
              {DEMOS.map(({key,icon,desc})=>(
                <button key={key} onClick={()=>{setShowDemo(false);setRegModule(key);}}
                  className="group text-left border border-gray-200 hover:border-brand-400 rounded-xl p-4 transition-colors">
                  <div className="w-10 h-10 bg-brand-50 text-brand-600 rounded-lg flex items-center justify-center mb-3 group-hover:bg-brand-500 group-hover:text-white transition-colors"><Icon name={icon} className="w-5 h-5"/></div>
                  <div className="font-black text-ink text-sm mb-1">{key}</div>
                  <div className="text-gray-500 text-xs leading-relaxed">{desc}</div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      {/* Register popup — sign-ups happen right here on the landing, no redirect */}
      {regModule&&(
        <div className="!fixed inset-0 bg-slate-900/25 !z-[100] flex items-center justify-center p-4 sm:p-6" onClick={()=>setRegModule(null)}>
          <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[85vh] overflow-y-auto p-6 sm:p-8" onClick={e=>e.stopPropagation()}>
            <button onClick={()=>setRegModule(null)} title="Close" className="sticky top-0 float-right -mt-2 -mr-2 w-9 h-9 rounded-lg bg-white hover:bg-gray-100 text-gray-400 hover:text-gray-600 flex items-center justify-center text-lg z-10">✕</button>
            <RegisterForm module={regModule} onSignIn={()=>{setRegModule(null);onSelect("admin-login");}} onAfterDone={()=>setRegModule(null)} afterDoneLabel="Done"/>
          </div>
        </div>
      )}
      <div className="grid-floor-light"/>
      {/* Top bar — sticky so the brand and actions stay visible while scrolling */}
      <header className="!fixed top-0 inset-x-0 z-40 bg-white/85 backdrop-blur border-b border-gray-100">
        <div className="max-w-6xl mx-auto px-6 sm:px-8 h-16 sm:h-20 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <BrandMark className="w-10 h-10 rounded-2xl"/>
            <div className="leading-tight">
              <div className="text-lg font-black text-ink tracking-tight">BilisOps</div>
              <div className="text-[11px] font-bold text-brand-600 -mt-0.5">Smart Attendance</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={()=>{const el=document.getElementById('offer'); if(el) window.scrollTo({top: el.getBoundingClientRect().top + window.scrollY - 96, behavior:'smooth'});}} className="hidden sm:inline-flex text-sm font-bold text-gray-600 hover:text-brand-700 px-4 py-2.5 transition-colors">Solutions</button>
            <button onClick={()=>onSelect("admin-login")} className="text-sm font-bold text-gray-600 hover:text-brand-700 px-4 py-2.5 transition-colors">Sign in</button>
            <button onClick={()=>setRegModule("All-in-One")} className="flex items-center gap-2 bg-brand-500 text-white text-sm font-bold px-5 py-2.5 rounded-full hover:bg-brand-600 transition-colors shadow-brand">Register <span>→</span></button>
          </div>
        </div>
      </header>
      {/* Spacer for the fixed header */}
      <div className="h-16 sm:h-20"/>

      {/* Hero */}
      <section className="relative z-10 max-w-3xl mx-auto px-6 text-center pt-10 sm:pt-16 pb-12 rise">
        <div className="inline-flex items-center gap-2 bg-white border border-brand-100 text-brand-700 text-xs font-bold px-4 py-1.5 rounded-full shadow-sm mb-6">
          <span className="w-2 h-2 bg-brand-500 rounded-full animate-pulse"/> HRIS &amp; customizable HR tools
        </div>
        <h1 className="text-4xl sm:text-6xl font-black text-ink tracking-tight leading-[1.05]">
          Run your entire HR, the <span className="text-brand-600">bilis</span> way.
        </h1>
        <p className="text-gray-500 mt-5 text-base sm:text-lg leading-relaxed max-w-xl mx-auto">
          BilisOps builds HRIS and custom HR tools — payroll, attendance, and everything your team runs on. One platform, tailored to how you work.
        </p>
        <div className="flex flex-col sm:flex-row items-center justify-center gap-3 mt-8">
          <button onClick={()=>setRegModule("All-in-One")} className="w-full sm:w-auto flex items-center justify-center gap-2 bg-brand-500 text-white text-sm font-bold px-7 py-3.5 rounded-full hover:bg-brand-600 transition-colors shadow-brand"><Icon name="userplus" className="w-5 h-5"/> Get started free</button>
          <button onClick={()=>setShowDemo(true)} className="w-full sm:w-auto flex items-center justify-center gap-2 bg-white text-ink text-sm font-bold px-7 py-3.5 rounded-full border border-gray-200 hover:border-brand-300 transition-colors shadow-sm"><Icon name="dashboard" className="w-5 h-5"/> See the demo</button>
        </div>
      </section>

      {/* Offerings */}
      <section id="offer" className="relative z-10 max-w-6xl mx-auto px-6 pt-6 pb-4 scroll-mt-24">
        <div className="text-center max-w-2xl mx-auto mb-8">
          <h2 className="text-2xl sm:text-3xl font-black text-ink">One platform for all your HR needs</h2>
          <p className="text-gray-500 mt-3 text-sm sm:text-base">Pick a module or let us tailor one to your workflow — from a single tool to a full HRIS suite.</p>
        </div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-5 rise" style={{animationDelay:'.1s'}}>
          {[
            {icon:"employees",title:"HRIS",           desc:"Employee records, org structure, documents, and self-service in one place."},
            {icon:"payroll",  title:"Payroll",        desc:"Automated pay runs, computations, payslips, and compliance."},
            {icon:"clock",    title:"Attendance & Time",desc:"QR & face check-in, schedules, breaks, overtime, and leaves."},
            {icon:"puzzle",   title:"Custom HR Tools", desc:"Need something specific? We build HR tools around your exact process."},
          ].map(({icon,title,desc})=>(
            <div key={title} className="card-3d group bg-white border border-gray-100 hover:border-brand-300 rounded-3xl p-6 text-left shadow-sm">
              <div className="w-12 h-12 bg-brand-50 text-brand-600 border border-brand-100 rounded-2xl flex items-center justify-center mb-4 group-hover:bg-brand-500 group-hover:text-white group-hover:shadow-brand transition-all"><Icon name={icon} className="w-6 h-6"/></div>
              <div className="text-ink font-black text-lg mb-1.5">{title}</div>
              <div className="text-gray-500 text-sm leading-relaxed">{desc}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Live sample — Attendance Dashboard */}
      <section className="relative z-10 max-w-6xl mx-auto px-6 py-12">
        <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-brand-500 to-brand-700 p-8 sm:p-12 shadow-brand rise">
          <div className="absolute -top-16 -right-10 w-64 h-64 bg-white/10 rounded-full"/>
          <div className="absolute -bottom-24 -left-16 w-80 h-80 bg-white/10 rounded-full"/>
          <div className="relative flex flex-col lg:flex-row items-start lg:items-center justify-between gap-6">
            <div className="max-w-xl">
              <span className="inline-flex items-center gap-2 bg-white/20 text-white text-xs font-bold px-3 py-1 rounded-full mb-4"><span className="w-1.5 h-1.5 bg-white rounded-full animate-pulse"/> Live sample</span>
              <h2 className="text-2xl sm:text-4xl font-black text-white leading-tight">Attendance Dashboard</h2>
              <p className="text-white/80 mt-3 text-sm sm:text-base leading-relaxed">Our first ready-to-use module — a complete attendance system with QR &amp; facial check-in, live monitoring, schedules, leaves, and exportable reports. Try the real thing right now.</p>
              <div className="flex flex-wrap gap-2 mt-5">
                {["Live dashboard","QR & Face kiosk","Schedules & leaves","Reports"].map(t=>(
                  <span key={t} className="bg-white/15 text-white text-xs font-semibold px-3 py-1.5 rounded-full">{t}</span>
                ))}
              </div>
            </div>
            <div className="flex flex-col gap-3 w-full lg:w-auto shrink-0">
              <button onClick={()=>onSelect("admin-login")} className="flex items-center justify-center gap-2 bg-white text-brand-700 text-sm font-black px-7 py-3.5 rounded-full hover:bg-brand-50 transition-colors shadow-lg">Open the demo <span>→</span></button>
              <div className="flex gap-2">
                <button onClick={()=>onSelect("kiosk")} className="flex-1 flex items-center justify-center gap-1.5 bg-white/15 hover:bg-white/25 text-white text-xs font-bold px-4 py-2.5 rounded-full transition-colors"><Icon name="scan" className="w-4 h-4"/> QR</button>
                <button onClick={()=>onSelect("facial-kiosk")} className="flex-1 flex items-center justify-center gap-1.5 bg-white/15 hover:bg-white/25 text-white text-xs font-bold px-4 py-2.5 rounded-full transition-colors"><Icon name="face" className="w-4 h-4"/> Face</button>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Complete HRIS module callout */}
      <section className="relative z-10 max-w-6xl mx-auto px-6 pb-14">
        <div className="grid md:grid-cols-2 gap-5 items-stretch">
          <div className="bg-white border border-gray-100 rounded-3xl p-8 shadow-sm rise">
            <div className="w-12 h-12 bg-brand-50 text-brand-600 rounded-2xl flex items-center justify-center mb-4"><Icon name="shield" className="w-6 h-6"/></div>
            <h3 className="text-xl font-black text-ink">Complete HRIS module — available now</h3>
            <p className="text-gray-500 mt-2 text-sm leading-relaxed">Beyond the sample, the full HRIS suite is ready: employee records, payroll, analytics, and self-service. We tailor and deploy it to fit your organization.</p>
            <div className="mt-5 grid grid-cols-2 gap-2.5">
              {[["employees","Employee records"],["payroll","Payroll runs"],["behavior","HR analytics"],["accounts","Roles & access"]].map(([ic,l])=>(
                <div key={l} className="flex items-center gap-2 text-sm font-semibold text-gray-700"><span className="w-7 h-7 bg-brand-50 text-brand-600 rounded-lg flex items-center justify-center shrink-0"><Icon name={ic} className="w-4 h-4"/></span>{l}</div>
              ))}
            </div>
          </div>
          <div className="relative overflow-hidden bg-gradient-to-br from-brand-500 to-brand-700 rounded-3xl p-8 shadow-brand flex flex-col justify-center rise" style={{animationDelay:'.1s'}}>
            <div className="absolute -top-10 -right-8 w-40 h-40 bg-white/10 rounded-full"/>
            <h3 className="relative text-2xl font-black text-white leading-tight">Ready for the full suite?</h3>
            <p className="relative text-white/80 mt-3 text-sm leading-relaxed">Let's map BilisOps to your team — start with attendance, then add payroll and the complete HRIS as you grow.</p>
            <a href="mailto:hello@bilisops.com" className="relative mt-6 inline-flex items-center justify-center gap-2 bg-white text-brand-700 text-sm font-bold px-6 py-3.5 rounded-full hover:bg-brand-50 transition-colors self-start shadow-lg">Talk to us <span>→</span></a>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="relative z-10 border-t border-gray-100 bg-white/60 backdrop-blur">
        <div className="max-w-6xl mx-auto px-6 py-6 flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <BrandMark className="w-8 h-8 rounded-xl"/>
            <span className="text-sm font-black text-ink">BilisOps <span className="text-gray-400 font-semibold">— Smart Attendance &amp; HR tools</span></span>
          </div>
          <div className="text-xs text-gray-400">© {new Date().getFullYear()} BilisOps. HRIS &amp; customizable HR tools.</div>
        </div>
      </footer>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// REGISTER — a visitor requests an account. Saved to `registrations` as pending;
// a super admin approves it in the admin panel, which creates the login.
// ════════════════════════════════════════════════════════════════════════════
// The form itself — reused by the standalone RegisterPage AND the landing's popup.
// Styled like the BilisOps trial form: single column, plain labels, email = login.
function RegisterForm({ onSignIn, onAfterDone, afterDoneLabel="Back to sign in →", addToast, module="All-in-One" }) {
  const [f,setF]=useState({business:"",name:"",email:"",phone:"",password:"",confirm:""});
  const [show,setShow]=useState(false); const [err,setErr]=useState(""); const [loading,setLoading]=useState(false); const [done,setDone]=useState(false);
  const set=(k,v)=>{ setF(p=>({...p,[k]:v})); setErr(""); };
  const inputCls="w-full border border-gray-300 rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-brand-200 focus:border-brand-500 bg-white placeholder:text-gray-400";
  const labelCls="text-sm font-semibold text-gray-800 block mb-1.5";
  const submit=async()=>{
    if(!f.business.trim()){ setErr("Business name is required."); return; }
    if(!f.email.trim()||!/\S+@\S+\.\S+/.test(f.email)){ setErr("Enter a valid email address."); return; }
    if(f.password.length<6){ setErr("Password must be at least 6 characters."); return; }
    if(f.password!==f.confirm){ setErr("Passwords do not match."); return; }
    setLoading(true); setErr("");
    try{
      const email=f.email.trim().toLowerCase();
      const {data:existing}=await supabase.from('admin_accounts').select('id').eq('username',email).maybeSingle();
      if(existing){ setErr("An account with that email already exists."); setLoading(false); return; }
      const row={
        name:(f.name.trim()||f.business.trim()), company:f.business.trim(), email,
        username:email, password_hash:btoa(f.password), role:'admin', status:'pending',
      };
      // Try with phone + chosen module; older databases without those columns get a retry without them.
      let {error}=await supabase.from('registrations').insert({...row, phone:f.phone.trim()||null, module});
      if(error && /phone|module/.test(error.message)) ({error}=await supabase.from('registrations').insert(row));
      if(error) throw error;
      setDone(true); addToast?.("Registration submitted.","success");
    }catch(e){ setErr("Failed: "+e.message); }
    setLoading(false);
  };
  if (done) return (
    <div className="flex flex-col items-center text-center py-6">
      <div className="w-16 h-16 bg-brand-50 text-brand-600 rounded-2xl flex items-center justify-center mb-5"><Icon name="check" className="w-8 h-8"/></div>
      <h1 className="text-2xl font-black text-ink">Registration submitted</h1>
      <p className="text-gray-500 text-sm mt-2 max-w-xs">Thanks, {(f.name||f.business).split(" ")[0]}! An admin will review your request and activate your account.</p>
      <button onClick={onAfterDone} className="mt-6 bg-brand-500 text-white font-bold px-6 py-3 rounded-xl hover:bg-brand-600 transition-colors text-sm shadow-brand">{afterDoneLabel}</button>
    </div>
  );
  return (
    <>
      <h1 className="text-2xl font-black text-ink">Start your free trial</h1>
      <span className="inline-block bg-brand-50 text-brand-700 border border-brand-100 text-xs font-bold px-3 py-1 rounded-lg mt-2 mb-5">Plan: Free Trial · {module}</span>
      <div className="space-y-4">
        {err&&<div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-lg">⚠ {err}</div>}
        <div><label className={labelCls}>Business Name <span className="text-red-500">*</span></label>
          <input value={f.business} onChange={e=>set("business",e.target.value)} placeholder="e.g. Allen Apparel Co." className={inputCls}/></div>
        <div><label className={labelCls}>Your Name</label>
          <input value={f.name} onChange={e=>set("name",e.target.value)} placeholder="e.g. Allen Roldan" className={inputCls}/></div>
        <div><label className={labelCls}>Email <span className="text-red-500">*</span></label>
          <input type="email" value={f.email} onChange={e=>set("email",e.target.value)} placeholder="you@business.com" className={inputCls}/></div>
        <div><label className={labelCls}>Phone</label>
          <input value={f.phone} onChange={e=>set("phone",e.target.value)} placeholder="09xx-xxx-xxxx" className={inputCls}/></div>
        <div><label className={labelCls}>Password <span className="text-red-500">*</span></label>
          <div className="relative">
            <input type={show?"text":"password"} value={f.password} onChange={e=>set("password",e.target.value)} placeholder="Create a password" className={inputCls+" pr-12"}/>
            <button type="button" onClick={()=>setShow(s=>!s)} className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400">{show?"🙈":"👁"}</button>
          </div>
        </div>
        <div><label className={labelCls}>Confirm Password <span className="text-red-500">*</span></label>
          <input type={show?"text":"password"} value={f.confirm} onChange={e=>set("confirm",e.target.value)} onKeyDown={e=>e.key==="Enter"&&submit()} placeholder="Re-enter your password" className={inputCls}/></div>
        <p className="text-xs text-gray-500">This is what you'll use to log into your BilisOps dashboard.</p>
        <button onClick={submit} disabled={loading} className="w-full bg-brand-500 text-white font-bold py-3.5 rounded-xl hover:bg-brand-600 disabled:opacity-60 transition-all active:scale-[0.98] text-sm shadow-brand">{loading?"Submitting…":"Create account →"}</button>
        <p className="text-center text-xs text-gray-400">Already have an account? <button onClick={onSignIn} className="font-bold text-brand-600 hover:text-brand-700">Sign in</button></p>
      </div>
    </>
  );
}

// Standalone register page (used by the ?screen=register deep link on the app domain).
function RegisterPage({ onBack, onDone, addToast }) {
  return (
    <div className="scene-3d-light min-h-screen bg-gradient-to-br from-white via-mist to-brand-50 flex items-center justify-center p-4 sm:p-6">
      <div className="grid-floor-light"/>
      <div className="relative z-10 w-full max-w-4xl bg-white rounded-3xl shadow-2xl overflow-hidden grid md:grid-cols-2 rise">
        {/* Brand panel */}
        <div className="relative hidden md:flex flex-col justify-between bg-gradient-to-br from-brand-500 to-brand-700 p-9 overflow-hidden">
          <div className="absolute -top-16 -right-16 w-56 h-56 bg-white/10 rounded-full"/>
          <div className="absolute -bottom-20 -left-10 w-64 h-64 bg-white/10 rounded-full"/>
          <div className="relative flex items-center gap-3">
            <BrandMark className="w-10 h-10 rounded-2xl" inverted/>
            <div className="leading-tight"><div className="text-xl font-black text-white">BilisOps</div><div className="text-[11px] font-bold text-white/70 -mt-0.5">Smart Attendance</div></div>
          </div>
          <div className="relative">
            <h2 className="text-3xl font-black text-white leading-tight">Get started with BilisOps.</h2>
            <p className="text-white/80 text-sm mt-2 leading-relaxed">Create your account to access HRIS, attendance, and custom HR tools. An admin reviews new sign-ups before access is granted.</p>
            <div className="mt-6 space-y-2.5">
              {["Free to register","Reviewed by an admin","Full HRIS when approved"].map(t=>(
                <div key={t} className="flex items-center gap-2.5 text-white/90 text-sm font-semibold"><span className="w-5 h-5 bg-white/20 rounded-full flex items-center justify-center shrink-0"><Icon name="check" className="w-3 h-3"/></span>{t}</div>
              ))}
            </div>
          </div>
        </div>
        {/* Form panel */}
        <div className="p-8 sm:p-10">
          {onBack&&<button onClick={onBack} className="flex items-center gap-2 text-gray-400 hover:text-brand-600 text-sm font-semibold mb-6 transition-colors">← Back</button>}
          <RegisterForm onSignIn={onDone} onAfterDone={onDone} addToast={addToast}/>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// EMPLOYEE PORTAL — self-service for employees: own attendance, file leave or
// offset requests, view & print payslips.
// ════════════════════════════════════════════════════════════════════════════
function EmployeePortal({ account, onLogout, addToast }) {
  const [tab,setTab]=useState("attendance"); // attendance | leave | payslips
  const [emp,setEmp]=useState(null); const [rows,setRows]=useState([]); const [myLeaves,setMyLeaves]=useState([]);
  const [slips,setSlips]=useState([]); const [runsById,setRunsById]=useState({});
  const [slipModal,setSlipModal]=useState(null); const [loading,setLoading]=useState(true);
  const [lv,setLv]=useState({date_from:getToday(),date_to:getToday(),leave_type:"leave",offset_hours:"",reason:""});
  const [filing,setFiling]=useState(false);
  const TODAY=getToday();

  const load=useCallback(async()=>{
    setLoading(true);
    const eid=account.employeeId;
    const [{data:e},{data:att},{data:lvs},{data:ps},{data:rns}]=await Promise.all([
      supabase.from('employees').select('*').eq('id',eid).maybeSingle(),
      supabase.from('attendance').select('*').eq('employee_id',eid).order('date',{ascending:false}).limit(45),
      supabase.from('leaves').select('*').eq('employee_id',eid).order('created_at',{ascending:false}).limit(30),
      supabase.from('payslips').select('*').eq('employee_id',eid).order('created_at',{ascending:false}).limit(24),
      supabase.from('payroll_runs').select('*'),
    ]);
    setEmp(e?rowToEmp(e):null);
    setRows((att||[]).map(rowToAttRec));
    setMyLeaves(lvs||[]);
    const rb=Object.fromEntries((rns||[]).map(r=>[r.id,r]));
    setRunsById(rb);
    setSlips((ps||[]).filter(s=>rb[s.run_id]?.status==='final'));
    setLoading(false);
  },[account.employeeId]);
  useEffect(()=>{ load(); },[load]);

  const fileLeave=async()=>{
    if(!lv.date_from||!lv.date_to){ addToast("Pick the dates.","error"); return; }
    if(lv.date_to<lv.date_from){ addToast("End date can't be before start date.","error"); return; }
    if(lv.leave_type==="offset"&&!(Number(lv.offset_hours)>0)){ addToast("Enter the offset hours.","error"); return; }
    setFiling(true);
    const baseRow={employee_id:account.employeeId, date_from:lv.date_from, date_to:lv.date_to,
      leave_type:lv.leave_type, reason:lv.reason||null, filed_by:account.username};
    let {error}=await supabase.from('leaves').insert({...baseRow, status:'pending', offset_hours:lv.leave_type==="offset"?Number(lv.offset_hours):null});
    // Pre-migration databases lack status/offset columns — retry with the basic row.
    if(error&&/status|offset_hours/.test(error.message)) ({error}=await supabase.from('leaves').insert(baseRow));
    if(!error) await supabase.from('notifications').insert({type:'leave-request',title:`${lv.leave_type==="offset"?"Offset":"Leave"} request — ${emp?.name||account.username}`,message:`${emp?.name||account.username} filed ${lv.leave_type} for ${lv.date_from}${lv.date_to!==lv.date_from?" → "+lv.date_to:""}. Review it in Leave.`,employee_id:account.employeeId,department:emp?.department||null});
    setFiling(false);
    if(error){ addToast("Failed: "+error.message,"error"); return; }
    addToast("Request submitted — your admin will review it.","success");
    setLv({date_from:TODAY,date_to:TODAY,leave_type:"leave",offset_hours:"",reason:""});
    load();
  };

  const periodLabel=s=>{ const r=runsById[s.run_id]; return r?`${fmtDate(r.period_start)} – ${fmtDate(r.period_end)}`:fmtDate(String(s.created_at).slice(0,10)); };
  const stBadge=s=>s==='approved'?"bg-brand-50 text-brand-700 border-brand-200":s==='rejected'?"bg-red-50 text-red-700 border-red-200":"bg-amber-50 text-amber-700 border-amber-200";
  const todayRec=rows.find(r=>r.date===TODAY);

  return (
    <div className="min-h-screen bg-gradient-to-br from-mist via-white to-brand-50/40 flex flex-col">
      <header className="bg-white/85 backdrop-blur border-b border-gray-100 sticky top-0 z-20">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <BrandMark className="w-9 h-9 rounded-xl"/>
            <div className="leading-tight"><div className="font-black text-sm text-ink">BilisOps</div><div className="text-[10px] font-bold text-brand-600 -mt-0.5">My Portal</div></div>
          </div>
          <button onClick={onLogout} className="flex items-center gap-1.5 text-gray-500 hover:text-red-600 hover:bg-red-50 text-xs font-bold px-3 py-2 rounded-xl transition-colors"><Icon name="logout" className="w-4 h-4"/> Sign out</button>
        </div>
      </header>
      <main className="flex-1 w-full max-w-3xl mx-auto px-4 sm:px-6 py-6">
        {loading?<div className="text-center py-20 text-gray-400 text-sm">Loading your portal…</div>:<>
        {/* Greeting card */}
        <div className="bg-gradient-to-br from-brand-500 to-brand-700 rounded-3xl p-6 text-white shadow-brand mb-5">
          <div className="text-xs font-bold text-white/70 uppercase tracking-wider">Welcome back</div>
          <div className="text-2xl font-black mt-0.5">{emp?.name||account.username}</div>
          <div className="text-white/70 text-sm">{emp?.position||""}{emp?.department?` · ${emp.department}`:""}</div>
          <div className="mt-3 inline-flex items-center gap-2 bg-white/15 rounded-full px-3 py-1.5 text-xs font-bold">
            {todayRec?.timeIn?`Today: in ${fmt(todayRec.timeIn)}${todayRec.timeOut?` · out ${fmt(todayRec.timeOut)}`:" · still in"}`:"No scan yet today"}
          </div>
        </div>
        {/* Tabs */}
        <div className="flex gap-2 mb-5">
          {[["attendance","My Attendance","clock"],["leave","Leave & Offset","leaves"],["payslips","Payslips","payroll"]].map(([k,l,ic])=>(
            <button key={k} onClick={()=>setTab(k)} className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-xs font-bold border transition-colors ${tab===k?"bg-brand-500 text-white border-brand-500 shadow-brand":"bg-white text-gray-600 border-gray-200 hover:border-brand-300"}`}><Icon name={ic} className="w-4 h-4"/> {l}</button>
          ))}
        </div>

        {tab==="attendance"&&(
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
            <div className="px-5 py-3.5 border-b border-gray-100 font-bold text-gray-800 text-sm">Last 45 days</div>
            <div className="overflow-x-auto"><table className="w-full text-sm">
              <thead><tr className="border-b border-gray-100 bg-gray-50/60">{["Date","In","Out","Late","Hours"].map(h=><th key={h} className="text-left text-xs font-semibold text-gray-400 uppercase tracking-wider px-4 py-2.5">{h}</th>)}</tr></thead>
              <tbody className="divide-y divide-gray-50">
                {rows.length===0?<tr><td colSpan={5} className="text-center py-10 text-gray-400 text-sm">No attendance yet.</td></tr>
                 :rows.map(r=>(
                  <tr key={r.date}>
                    <td className="px-4 py-2.5 text-xs font-semibold text-gray-700 whitespace-nowrap">{fmtDate(r.date)}</td>
                    <td className="px-4 py-2.5 font-mono text-xs">{r.timeIn?fmt(r.timeIn):"—"}</td>
                    <td className="px-4 py-2.5 font-mono text-xs">{r.timeOut?fmt(r.timeOut):"—"}</td>
                    <td className="px-4 py-2.5 text-xs">{r.lateMinutes>0?<span className="text-amber-600 font-bold">{r.lateMinutes}m</span>:<span className="text-gray-300">—</span>}</td>
                    <td className="px-4 py-2.5 text-xs font-mono">{r.hoursWorked||"—"}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </div>
        )}

        {tab==="leave"&&(
          <div className="space-y-5">
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
              <h2 className="font-bold text-gray-800 text-sm mb-3">File a request</h2>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="text-xs font-bold text-gray-500 uppercase block mb-1">Type</label>
                  <select value={lv.leave_type} onChange={e=>setLv(p=>({...p,leave_type:e.target.value}))} className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm">
                    <option value="leave">Leave (whole day)</option><option value="halfday">Half day</option><option value="offset">Offset (use OT hours)</option>
                  </select></div>
                {lv.leave_type==="offset"?(
                  <div><label className="text-xs font-bold text-gray-500 uppercase block mb-1">Offset hours</label>
                    <input type="number" min="1" value={lv.offset_hours} onChange={e=>setLv(p=>({...p,offset_hours:e.target.value}))} placeholder="e.g. 4" className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm"/></div>
                ):<div/>}
                <div><label className="text-xs font-bold text-gray-500 uppercase block mb-1">From</label>
                  <input type="date" value={lv.date_from} onChange={e=>setLv(p=>({...p,date_from:e.target.value}))} className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm"/></div>
                <div><label className="text-xs font-bold text-gray-500 uppercase block mb-1">To</label>
                  <input type="date" value={lv.date_to} onChange={e=>setLv(p=>({...p,date_to:e.target.value}))} className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm"/></div>
              </div>
              <div className="mt-3"><label className="text-xs font-bold text-gray-500 uppercase block mb-1">Reason</label>
                <textarea value={lv.reason} onChange={e=>setLv(p=>({...p,reason:e.target.value}))} rows={2} placeholder={lv.leave_type==="offset"?"Which OT are you offsetting? (e.g. OT last Saturday)":"Short reason"} className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm"/></div>
              <button disabled={filing} onClick={fileLeave} className="mt-3 w-full bg-brand-500 text-white text-sm font-bold py-3 rounded-xl hover:bg-brand-600 disabled:opacity-50 shadow-brand">{filing?"Submitting…":"Submit request"}</button>
            </div>
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
              <div className="px-5 py-3.5 border-b border-gray-100 font-bold text-gray-800 text-sm">My requests</div>
              <div className="divide-y divide-gray-50">
                {myLeaves.length===0?<div className="text-center py-10 text-gray-400 text-sm">Nothing filed yet.</div>
                 :myLeaves.map(l=>(
                  <div key={l.id} className="px-5 py-3 flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-gray-800 capitalize">{l.leave_type}{l.offset_hours?` · ${l.offset_hours}h`:""}</div>
                      <div className="text-xs text-gray-400">{fmtDate(l.date_from)}{l.date_to!==l.date_from?` → ${fmtDate(l.date_to)}`:""}{l.reason?` · ${l.reason}`:""}</div>
                    </div>
                    <span className={`text-xs font-bold px-2.5 py-1 rounded-full border capitalize shrink-0 ${stBadge(l.status??'approved')}`}>{l.status??'approved'}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {tab==="payslips"&&(
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
            <div className="px-5 py-3.5 border-b border-gray-100 font-bold text-gray-800 text-sm">My payslips</div>
            <div className="divide-y divide-gray-50">
              {slips.length===0?<div className="text-center py-10 text-gray-400 text-sm">No payslips yet — they appear here when payroll is finalized.</div>
               :slips.map(s=>(
                <div key={s.id} className="px-5 py-3.5 flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-gray-800">{periodLabel(s)}</div>
                    <div className="text-xs text-gray-400">Net pay: <span className="font-mono font-bold text-brand-700">{peso(s.net)}</span></div>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <button onClick={()=>setSlipModal(s)} className="text-xs font-bold px-3 py-2 rounded-xl bg-gray-100 text-gray-700 hover:bg-gray-200">View</button>
                    <button onClick={()=>printPayslip(s, emp, "", periodLabel(s))} className="text-xs font-bold px-3 py-2 rounded-xl bg-brand-500 text-white hover:bg-brand-600">🖨 Print</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        </>}
      </main>

      {slipModal&&(
        <div className="fixed inset-0 bg-slate-900/25 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={()=>setSlipModal(null)}>
          <div className="bg-white rounded-3xl w-full max-w-md max-h-[85vh] overflow-y-auto shadow-2xl p-7" onClick={e=>e.stopPropagation()}>
            <div className="flex items-center justify-between mb-1">
              <h2 className="font-black text-ink">Payslip</h2>
              <button onClick={()=>setSlipModal(null)} className="w-9 h-9 rounded-lg hover:bg-gray-100 text-gray-400">✕</button>
            </div>
            <div className="text-xs text-gray-400 mb-4">{periodLabel(slipModal)}</div>
            <div className="text-xs font-bold text-brand-700 uppercase tracking-wider mb-1">Earnings</div>
            {slipModal.data.earnings.map((e,i)=><div key={i} className="flex justify-between text-sm py-1 border-b border-gray-50"><span className="text-gray-600">{e.label}</span><span className="font-mono">{peso(e.amount)}</span></div>)}
            <div className="text-xs font-bold text-red-600 uppercase tracking-wider mt-3 mb-1">Deductions</div>
            {slipModal.data.deductions.map((d,i)=><div key={i} className="flex justify-between text-sm py-1 border-b border-gray-50"><span className="text-gray-600">{d.label}</span><span className="font-mono">−{peso(d.amount)}</span></div>)}
            <div className="mt-4 bg-brand-50 border border-brand-200 rounded-2xl px-4 py-3 flex justify-between font-black text-brand-800"><span>NET PAY</span><span className="font-mono">{peso(slipModal.net)}</span></div>
            <button onClick={()=>printPayslip(slipModal, emp, "", periodLabel(slipModal))} className="mt-4 w-full bg-brand-500 text-white text-sm font-bold py-3 rounded-xl hover:bg-brand-600 shadow-brand">🖨 Print payslip</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// KIOSK CHOOSER — the single kiosk APK: after admin login, pick QR or Facial.
// ════════════════════════════════════════════════════════════════════════════
function KioskChooser({ adminUser, onPick, onLogout, online }) {
  return (
    <div className="scene-3d-light relative min-h-screen bg-gradient-to-b from-white via-mist to-brand-50 flex flex-col">
      <div className="grid-floor-light"/>
      {/* Header */}
      <header className="relative z-10 flex items-center justify-between px-5 sm:px-8 h-16 border-b border-gray-100">
        <div className="flex items-center gap-2.5">
          <BrandMark className="w-9 h-9 rounded-xl"/>
          <div className="leading-tight">
            <div className="font-black text-sm text-ink">BilisOps</div>
            <div className="text-[10px] font-bold text-brand-600 -mt-0.5">Smart Attendance</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-[10px] font-bold px-2.5 py-1 rounded-full border ${online?"bg-brand-50 text-brand-700 border-brand-100":"bg-amber-50 text-amber-700 border-amber-200"}`}>{online?"● Online":"● Offline"}</span>
          <button onClick={onLogout} title="Sign out" className="flex items-center gap-1.5 text-gray-500 hover:text-red-600 hover:bg-red-50 text-xs font-bold px-3 py-2 rounded-xl transition-colors"><Icon name="logout" className="w-4 h-4"/> Sign out</button>
        </div>
      </header>

      {/* Chooser */}
      <div className="relative z-10 flex-1 flex flex-col items-center justify-center p-6">
        <div className="text-center mb-8 rise">
          <div className="inline-flex items-center gap-2 bg-white border border-brand-100 text-brand-700 text-xs font-bold px-4 py-1.5 rounded-full shadow-sm mb-4">
            <span className="w-2 h-2 bg-brand-500 rounded-full animate-pulse"/> {adminUser?.username?`Signed in as ${adminUser.username}`:"Kiosk ready"}
          </div>
          <h1 className="text-3xl sm:text-4xl font-black text-ink tracking-tight">Choose a kiosk</h1>
          <p className="text-gray-500 mt-2 text-sm sm:text-base">Pick how employees will check in on this device.</p>
        </div>
        <div className="flex flex-col sm:flex-row gap-5 w-full max-w-2xl rise" style={{animationDelay:'.1s'}}>
          {[
            {key:"kiosk",       icon:"scan",title:"QR Code Kiosk", desc:"Employees scan a QR code to clock in, break, and out."},
            {key:"facial-kiosk",icon:"face",title:"Facial Kiosk",  desc:"Hands-free check-in using face recognition."},
          ].map(({key,icon,title,desc})=>(
            <button key={key} onClick={()=>onPick(key)}
              className="card-3d flex-1 group bg-white border border-gray-100 hover:border-brand-300 rounded-3xl p-8 text-center shadow-sm">
              <div className="w-16 h-16 mx-auto bg-brand-50 text-brand-600 border border-brand-100 rounded-2xl flex items-center justify-center mb-5 group-hover:bg-brand-500 group-hover:text-white group-hover:shadow-brand transition-all"><Icon name={icon} className="w-8 h-8"/></div>
              <div className="text-ink font-black text-xl mb-2">{title}</div>
              <div className="text-gray-500 text-sm leading-relaxed">{desc}</div>
              <div className="mt-5 inline-flex items-center gap-1.5 text-brand-600 text-sm font-bold">Open <span className="group-hover:translate-x-1 transition-transform">→</span></div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// ADMIN LOGIN
// ════════════════════════════════════════════════════════════════════════════
function AdminLogin({ onLogin, onBack, onRegister }) {
  const [u,setU]=useState(""); const [p,setP]=useState("");
  const [show,setShow]=useState(false); const [err,setErr]=useState(""); const [loading,setLoading]=useState(false);
  const [mustChange,setMustChange]=useState(null); // holds the account row when a forced change is needed
  const [np,setNp]=useState(""); const [cp,setCp]=useState("");
  const submit = async () => {
    if (!u||!p) { setErr("Please enter your credentials."); return; }
    setLoading(true); setErr("");
    try {
      const {data,error}=await supabase.from('admin_accounts').select('*').eq('username',u.trim().toLowerCase()).eq('is_active',true).maybeSingle();
      if (error) throw error;
      if (!data||data.password_hash!==btoa(p)) { setErr("Incorrect username or password."); setLoading(false); return; }
      if (data.must_change_password) { setMustChange(data); setLoading(false); return; } // force password change first
      await supabase.from('admin_accounts').update({last_login:new Date().toISOString()}).eq('id',data.id);
      // Tenant accounts are entitled to the module(s) they registered for.
      let modules=null;
      if (data.tenant_id && data.role!=='employee') {
        const {data:reg}=await supabase.from('registrations').select('module').eq('id',data.tenant_id).maybeSingle();
        modules=modulesOf(reg?.module);
      }
      const user={id:data.id,username:data.username,role:data.role,departmentAccess:data.department_access||null,tenantId:data.tenant_id||null,employeeId:data.employee_id||null,pageAccess:Array.isArray(data.page_access)&&data.page_access.length?data.page_access:null,modules,loginTime:new Date().toLocaleTimeString("en-PH")};
      onLogin(user);
    } catch(e) { setErr("Login failed: "+e.message); setLoading(false); }
  };
  const submitNewPassword = async () => {
    if (!np||!cp) { setErr("Fill in both fields."); return; }
    if (np.length<6) { setErr("Password must be at least 6 characters."); return; }
    if (np!==cp) { setErr("Passwords do not match."); return; }
    if (btoa(np)===mustChange.password_hash) { setErr("Choose a different password from the temporary one."); return; }
    setLoading(true); setErr("");
    try {
      await supabase.from('admin_accounts').update({password_hash:btoa(np),must_change_password:false,last_login:new Date().toISOString()}).eq('id',mustChange.id);
      let modules=null;
      if (mustChange.tenant_id && mustChange.role!=='employee') {
        const {data:reg}=await supabase.from('registrations').select('module').eq('id',mustChange.tenant_id).maybeSingle();
        modules=modulesOf(reg?.module);
      }
      const user={id:mustChange.id,username:mustChange.username,role:mustChange.role,departmentAccess:mustChange.department_access||null,tenantId:mustChange.tenant_id||null,employeeId:mustChange.employee_id||null,pageAccess:Array.isArray(mustChange.page_access)&&mustChange.page_access.length?mustChange.page_access:null,modules,loginTime:new Date().toLocaleTimeString("en-PH")};
      onLogin(user);
    } catch(e) { setErr("Failed: "+e.message); setLoading(false); }
  };
  return (
    <div className="scene-3d-light min-h-screen bg-gradient-to-br from-white via-mist to-brand-50 flex items-center justify-center p-4 sm:p-6">
      <div className="grid-floor-light"/>
      <div className="relative z-10 w-full max-w-4xl bg-white rounded-3xl shadow-2xl overflow-hidden grid md:grid-cols-2 rise">
        {/* Brand panel */}
        <div className="relative hidden md:flex flex-col justify-between bg-gradient-to-br from-brand-500 to-brand-700 p-9 overflow-hidden">
          <div className="absolute -top-16 -right-16 w-56 h-56 bg-white/10 rounded-full"/>
          <div className="absolute -bottom-20 -left-10 w-64 h-64 bg-white/10 rounded-full"/>
          <div className="relative flex items-center gap-3">
            <BrandMark className="w-10 h-10 rounded-2xl" inverted/>
            <div className="leading-tight">
              <div className="text-xl font-black text-white">BilisOps</div>
              <div className="text-[11px] font-bold text-white/70 -mt-0.5">Smart Attendance</div>
            </div>
          </div>
          <div className="relative">
            <h2 className="text-3xl font-black text-white leading-tight">Welcome back.</h2>
            <p className="text-white/80 text-sm mt-2 leading-relaxed">Manage attendance, schedules, and reports — all in one fast, simple dashboard.</p>
            <div className="mt-6 space-y-2.5">
              {["Live attendance dashboard","Smart schedules & leaves","Instant exportable reports"].map(t=>(
                <div key={t} className="flex items-center gap-2.5 text-white/90 text-sm font-semibold">
                  <span className="w-5 h-5 bg-white/20 rounded-full flex items-center justify-center shrink-0"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"/></svg></span>{t}
                </div>
              ))}
            </div>
          </div>
        </div>
        {/* Form panel */}
        <div className="p-8 sm:p-10">
          {onBack&&<button onClick={onBack} className="flex items-center gap-2 text-gray-400 hover:text-brand-600 text-sm font-semibold mb-6 transition-colors">← Back</button>}
          <div className="w-12 h-12 bg-brand-50 text-brand-600 rounded-2xl flex items-center justify-center mb-4"><Icon name={mustChange?"settings":"lock"} className="w-6 h-6"/></div>
          <h1 className="text-2xl font-black text-ink">{mustChange?"Set your password":"Admin sign in"}</h1>
          <p className="text-gray-500 text-sm mt-1 mb-6">{mustChange?"First login — please choose a new password":"Enter your credentials to continue"}</p>
          {mustChange?(
            <div className="space-y-5">
              {err&&<div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-2xl">⚠ {err}</div>}
              <div className="bg-amber-50 border border-amber-200 text-amber-700 text-xs px-4 py-3 rounded-2xl">Welcome, <span className="font-bold">{mustChange.username}</span>! For security, set a new password before continuing.</div>
              <div><label className="text-xs font-bold text-gray-500 uppercase tracking-wider block mb-2">New Password</label>
                <input type={show?"text":"password"} value={np} onChange={e=>{setNp(e.target.value);setErr("");}} placeholder="At least 6 characters" className="w-full border border-gray-200 rounded-2xl px-4 py-3.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-200 focus:border-brand-400 bg-gray-50"/></div>
              <div><label className="text-xs font-bold text-gray-500 uppercase tracking-wider block mb-2">Confirm Password</label>
                <div className="relative">
                  <input type={show?"text":"password"} value={cp} onChange={e=>{setCp(e.target.value);setErr("");}} onKeyDown={e=>e.key==="Enter"&&submitNewPassword()} placeholder="Re-enter new password" className="w-full border border-gray-200 rounded-2xl px-4 py-3.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-200 focus:border-brand-400 bg-gray-50 pr-12"/>
                  <button type="button" onClick={()=>setShow(s=>!s)} className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400">{show?"🙈":"👁"}</button>
                </div>
              </div>
              <button onClick={submitNewPassword} disabled={loading} className="w-full bg-brand-500 text-white font-bold py-4 rounded-2xl hover:bg-brand-600 disabled:opacity-60 transition-all active:scale-[0.98] text-sm shadow-brand">
                {loading?"Saving…":"Confirm & Continue →"}
              </button>
            </div>
          ):(
          <div className="space-y-5">
            {err&&<div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-2xl">⚠ {err}</div>}
            <div><label className="text-xs font-bold text-gray-500 uppercase tracking-wider block mb-2">Username</label>
              <input value={u} onChange={e=>{setU(e.target.value);setErr("");}} onKeyDown={e=>e.key==="Enter"&&submit()} placeholder="Username or email" className="w-full border border-gray-200 rounded-2xl px-4 py-3.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-200 focus:border-brand-400 bg-gray-50"/></div>
            <div><label className="text-xs font-bold text-gray-500 uppercase tracking-wider block mb-2">Password</label>
              <div className="relative">
                <input type={show?"text":"password"} value={p} onChange={e=>{setP(e.target.value);setErr("");}} onKeyDown={e=>e.key==="Enter"&&submit()} placeholder="Enter password" className="w-full border border-gray-200 rounded-2xl px-4 py-3.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-200 focus:border-brand-400 bg-gray-50 pr-12"/>
                <button type="button" onClick={()=>setShow(s=>!s)} className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400">{show?"🙈":"👁"}</button>
              </div>
            </div>
            <button onClick={submit} disabled={loading} className="w-full bg-brand-500 text-white font-bold py-4 rounded-2xl hover:bg-brand-600 disabled:opacity-60 transition-all active:scale-[0.98] text-sm shadow-brand">
              {loading?"Signing in…":"Sign In →"}
            </button>
            {onRegister&&<p className="text-center text-xs text-gray-400">Don't have an account? <button type="button" onClick={onRegister} className="font-bold text-brand-600 hover:text-brand-700">Register</button></p>}
          </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// EMPLOYEE KIOSK
// ════════════════════════════════════════════════════════════════════════════
function EmployeeKiosk({ employees, allAttendance, onScan, onBack, onKioskLogout }) {
  const [clock,setClock]=useState(nowDate());
  const [log,setLog]=useState([]);
  const [scanning,setScan]=useState(false);
  const [result,setResult]=useState(null);
  const [camOn,setCamOn]=useState(false);
  const [input,setInput]=useState("");
  const [err,setErr]=useState("");
  const [qrSupported,setQrSupported]=useState(false);
  const [online,setOnline]=useState(navigator.onLine!==false);
  const [pending,setPending]=useState(loadScanQueue().length);
  const vidRef=useRef(null); const streamRef=useRef(null); const detectRef=useRef(null);
  const lastScanRef=useRef({});
  const processScanRef=useRef(null);

  useEffect(()=>{ const t=setInterval(()=>setClock(nowDate()),1000); return ()=>clearInterval(t); },[]);
  useEffect(()=>{
    const up=()=>setOnline(true), down=()=>setOnline(false);
    window.addEventListener('online',up); window.addEventListener('offline',down);
    const t=setInterval(()=>{ setOnline(navigator.onLine!==false); setPending(loadScanQueue().length); }, 3000);
    return ()=>{ window.removeEventListener('online',up); window.removeEventListener('offline',down); clearInterval(t); };
  },[]);

  const TODAY=getToday();
  const today=allAttendance[TODAY]||{};
  const getNext=id=>{ const r=today[id];
    // No time-in yet → must time in first
    if(!r||!r.timeIn) return "time-in";
    // Already timed out → all done
    if(r.timeOut) return "done";
    // A break is currently open (started but not ended) → must end it first
    if(r.coffeeStart&&!r.coffeeEnd) return "break1-end";
    if(r.lunchStart&&!r.lunchEnd) return "break2-end";
    // Both breaks fully done → time out
    if(r.coffeeEnd&&r.lunchEnd) return "time-out";
    // Coffee done, lunch not started → start lunch
    if(r.coffeeEnd&&!r.lunchStart) return "break2-start";
    // Nothing started yet → start coffee break
    if(!r.coffeeStart) return "break1-start";
    // Fallback
    return "time-out"; };
  const AL={"time-in":"Time In","break1-start":"Start Break","break1-end":"End Break","break2-start":"Start Break","break2-end":"End Break","time-out":"Time Out",done:"Completed"};
  const AG={"time-in":"from-emerald-500 to-emerald-700","break1-start":"from-sky-500 to-sky-700","break1-end":"from-sky-600 to-sky-800","break2-start":"from-sky-500 to-sky-700","break2-end":"from-sky-600 to-sky-800","time-out":"from-rose-500 to-rose-700"};
  const AI={"time-in":"🟢","break1-start":"☕","break1-end":"✅","break2-start":"☕","break2-end":"✅","time-out":"🔴"};

  const processScan=scanned=>{
    if (scanning) return;
    const raw=(scanned||"").trim();
    const up=raw.toUpperCase();
    // Match the scanned value against the existing badge/QR code first (so old ID cards
    // keep working), then fall back to the Employee ID. Case-insensitive on both.
    const emp=employees.find(e=>(e.qrCode&&e.qrCode.trim().toUpperCase()===up)||(e.id||"").toUpperCase()===up);
    if (!emp||emp.status!=="active") { setErr("Employee not found or inactive."); return; }
    const id=emp.id; // use the real employee ID for all attendance records below
    const dayName=DAY_NAMES[phDayIdx()];
    // A per-day override (Day Off / Working set by an admin) must win over the weekly rest
    // days — otherwise someone marked "Working" on their usual rest day still gets flagged
    // as a day-off scan, and someone given a one-off day off doesn't.
    const ov=today[id]?.scheduleOverride;
    const ovDayType=ov?.dayType||"normal";
    const restDays=Array.isArray(ov?.restDays)?ov.restDays:emp.schedule.restDays;
    const isRestDay=ovDayType==="off"?true:ovDayType==="work"?false:restDays.includes(dayName);
    const action=getNext(id);
    if (action==="done") { setErr("All scans completed for today."); return; }
    const COOLDOWN=120000; // 2 minutes — after ANY scan, the same person is locked out this long
    const last=lastScanRef.current[id];
    // Block ANY repeat scan from the same person within the window. Critical: this stops the
    // camera from running a held-up QR straight through time-in → break → time-out by itself.
    if (last && (Date.now()-last.timestamp)<COOLDOWN) {
      const secsLeft=Math.ceil((COOLDOWN-(Date.now()-last.timestamp))/1000);
      setResult({emp,action:last.action,time:last.time,duplicate:true,secsLeft});
      setTimeout(()=>setResult(null),3000); return;
    }
    const now=phTimeStr();
    // Register the cooldown IMMEDIATELY (synchronously, BEFORE the async save) so the camera's
    // next 600ms detection of the same QR is blocked before this scan even finishes saving.
    lastScanRef.current[id]={action,time:now,timestamp:Date.now()};
    setScan(true); setErr("");
    onScan(id,action,now,isRestDay,extra=>{
      setResult({emp,action,time:now,isRestDay,...extra});
      setLog(p=>[{id:Date.now(),empName:emp.name,empId:id,action,time:now,isRestDay},...p.slice(0,11)]);
      setTimeout(()=>setResult(null),1800); // overlay clears fast so the next person can scan
    });
    setScan(false); setInput("");
  };
  // Keep ref always pointing to latest processScan to avoid stale closures in intervals
  useEffect(()=>{ processScanRef.current=processScan; });

  const startCam=async()=>{
    setErr("");
    if (!navigator.mediaDevices?.getUserMedia) { setErr("Camera not supported."); return; }
    try {
      let s; try{s=await navigator.mediaDevices.getUserMedia({video:{facingMode:"environment"}});}catch{s=await navigator.mediaDevices.getUserMedia({video:true});}
      streamRef.current=s; setCamOn(true);
      if ("BarcodeDetector" in window) {
        setQrSupported(true);
        const detector=new window.BarcodeDetector({formats:["qr_code"]});
        detectRef.current=setInterval(async()=>{ if(!vidRef.current||vidRef.current.readyState<2) return; try{const codes=await detector.detect(vidRef.current);if(codes.length>0){const v=codes[0].rawValue?.trim().toUpperCase();if(v)processScanRef.current(v);}}catch{} },600);
      } else {
        // Fallback: use jsQR for Firefox / older Safari
        loadJsQR().then(jsQR=>{
          if (!jsQR) { setQrSupported(false); return; }
          setQrSupported(true);
          const canvas=document.createElement("canvas");
          const ctx=canvas.getContext("2d",{willReadFrequently:true});
          detectRef.current=setInterval(()=>{
            if(!vidRef.current||vidRef.current.readyState<2) return;
            canvas.width=vidRef.current.videoWidth; canvas.height=vidRef.current.videoHeight;
            if(!canvas.width||!canvas.height) return;
            ctx.drawImage(vidRef.current,0,0,canvas.width,canvas.height);
            const img=ctx.getImageData(0,0,canvas.width,canvas.height);
            const code=jsQR(img.data,img.width,img.height,{inversionAttempts:"dontInvert"});
            if(code?.data){ const v=code.data.trim().toUpperCase(); if(v) processScanRef.current(v); }
          },600);
        }).catch(()=>setQrSupported(false));
      }
    } catch(e) {
      if(e?.name==="NotAllowedError") setErr("Camera permission denied.");
      else if(e?.name==="NotFoundError") setErr("No camera found.");
      else setErr("Camera error: "+(e?.message||"unknown"));
    }
  };
  useEffect(()=>{ if(camOn&&streamRef.current&&vidRef.current){vidRef.current.srcObject=streamRef.current;vidRef.current.play().catch(()=>{});} },[camOn]);
  const stopCam=()=>{ if(detectRef.current){clearInterval(detectRef.current);detectRef.current=null;} streamRef.current?.getTracks().forEach(t=>t.stop()); streamRef.current=null; if(vidRef.current)vidRef.current.srcObject=null; setCamOn(false); };
  useEffect(()=>()=>{ if(detectRef.current)clearInterval(detectRef.current); streamRef.current?.getTracks().forEach(t=>t.stop()); },[]);

  const activeEmps=employees.filter(e=>e.status==="active");

  return (
    <div className="min-h-screen bg-mist text-gray-800 flex flex-col">
      <header className="flex items-center justify-between px-4 sm:px-8 py-3 sm:py-5 border-b border-gray-200 shrink-0">
        <div className="flex items-center gap-2 sm:gap-3">
          <BrandMark className="w-8 h-8 sm:w-9 sm:h-9 rounded-xl"/>
          <div><div className="font-black text-xs sm:text-sm">BilisOps</div><div className="text-gray-400 text-[10px] sm:text-xs">Employee Kiosk</div></div>
          <span className={`ml-1 text-[10px] font-bold px-2 py-0.5 rounded-full border ${online?"bg-emerald-500/15 text-emerald-300 border-emerald-500/30":"bg-amber-500/20 text-amber-300 border-amber-500/40"}`}>{online?"● Online":"● Offline"}{pending>0?` · ${pending} queued`:""}</span>
        </div>
        <div className="text-center">
          <div className="text-xl sm:text-4xl font-black tabular-nums">{clock.toLocaleTimeString("en-PH",{hour:"2-digit",minute:"2-digit",second:"2-digit",timeZone:PH_TZ})}</div>
          <div className="text-gray-400 text-[9px] sm:text-xs mt-0.5 hidden xs:block">{clock.toLocaleDateString("en-PH",{weekday:"short",month:"short",day:"numeric",timeZone:PH_TZ})} · PH time</div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={onKioskLogout} title="Log out this kiosk" className="border border-gray-200 hover:border-gray-300 text-gray-400 hover:text-gray-900 text-xs font-semibold px-3 sm:px-4 py-2 rounded-xl transition-colors"><Icon name="logout" className="w-4 h-4"/></button>
          <button onClick={onBack} className="border border-gray-200 hover:border-gray-300 text-gray-400 hover:text-gray-900 text-xs font-semibold px-3 sm:px-4 py-2 rounded-xl transition-colors">←</button>
        </div>
      </header>
      <div className="flex-1 flex flex-col md:flex-row overflow-y-auto md:overflow-hidden">
        <div className="flex-1 flex flex-col items-center justify-center p-4 sm:p-8 gap-4 sm:gap-5 relative min-h-[60vh] md:min-h-0">
          {result&&(
            <div className="absolute inset-0 z-20 bg-slate-900/30 backdrop-blur-md flex items-center justify-center">
              {result.duplicate?(
                <div className="bg-white rounded-3xl p-10 text-center shadow-2xl max-w-sm w-full mx-6 border border-gray-100">
                  <div className="text-6xl mb-4">🔁</div>
                  <div className="text-2xl font-black mb-1 text-ink">Already Scanned</div>
                  <div className="text-gray-400 text-sm mb-5">Ignored to prevent duplicates</div>
                  <div className="text-ink font-bold text-xl">{result.emp.name}</div>
                  <div className="mt-4 bg-gray-100 rounded-2xl px-5 py-3 text-sm text-gray-600"><span className="font-bold text-gray-900">{AL[result.action]}</span> at <span className="font-mono font-bold text-gray-900">{fmt(result.time)}</span></div>
                  <div className="mt-3 text-xs text-gray-400">Next scan in ~{result.secsLeft}s</div>
                </div>
              ):result.isRestDay?(
                <div className="bg-gradient-to-br from-brand-500 to-brand-700 rounded-3xl p-10 text-center shadow-2xl max-w-sm w-full mx-6">
                  <div className="text-6xl mb-4">📅</div>
                  <div className="text-3xl font-black mb-2 text-white">Day Off</div>
                  <div className="text-white/90 font-bold text-xl">{result.emp.name}</div>
                  <div className="text-white/60 text-sm mt-1">{result.emp.department}</div>
                  <div className="mt-5 bg-black/15 rounded-2xl px-4 py-3 text-sm font-semibold text-white">⚠ Today is your scheduled rest day</div>
                  <div className="mt-3 text-white/70 text-sm">Please contact your manager.</div>
                  <div className="mt-3 text-white/50 text-xs">Scan logged at {fmt(result.time)}</div>
                </div>
              ):(
                <div className={`bg-gradient-to-br ${AG[result.action]} rounded-3xl p-10 text-center shadow-2xl max-w-sm w-full mx-6`}>
                  <div className="text-6xl mb-4">{AI[result.action]}</div>
                  <div className="text-3xl font-black mb-2">{AL[result.action]}</div>
                  <div className="text-white/90 font-bold text-xl">{result.emp.name}</div>
                  <div className="text-white/50 text-sm mt-1">{result.emp.department}</div>
                  <div className="mt-4 font-mono text-3xl font-black">{fmt(result.time)}</div>
                  {(result.lateMinutes||0)>0&&<div className="mt-3 bg-black/20 rounded-2xl px-4 py-2 text-sm font-semibold">⚠ {result.lateMinutes} min late</div>}
                  {(result.overBreak||0)>0&&<div className="mt-2 bg-black/20 rounded-2xl px-4 py-2 text-sm font-semibold">⚠ {result.overBreak} min over break</div>}
                </div>
              )}
            </div>
          )}
          <div className="relative w-[88vw] h-[88vw] max-w-[420px] max-h-[420px] sm:w-80 sm:h-80 md:w-72 md:h-72 rounded-3xl overflow-hidden border-2 border-gray-200 bg-mist shadow-lg">
            {camOn?<video ref={vidRef} autoPlay playsInline muted className="w-full h-full object-cover"/>
              :<div className="w-full h-full flex flex-col items-center justify-center gap-3 text-gray-400"><span className="text-6xl">📷</span><span className="text-sm">Camera is off</span></div>}
            {camOn&&<>
              <div className="absolute top-3 left-3 w-7 h-7 border-t-2 border-l-2 border-white rounded-tl-lg"/>
              <div className="absolute top-3 right-3 w-7 h-7 border-t-2 border-r-2 border-white rounded-tr-lg"/>
              <div className="absolute bottom-3 left-3 w-7 h-7 border-b-2 border-l-2 border-white rounded-bl-lg"/>
              <div className="absolute bottom-3 right-3 w-7 h-7 border-b-2 border-r-2 border-white rounded-br-lg"/>
              <div className="absolute inset-x-8 top-1/2 h-0.5 bg-white/30 animate-pulse"/>
              <div className={`absolute top-2 left-1/2 -translate-x-1/2 text-[10px] font-bold px-2 py-0.5 rounded-full ${qrSupported?"bg-emerald-500/80":"bg-amber-500/80"} text-white`}>{qrSupported?"● Live QR":"Camera on"}</div>
            </>}
          </div>
          <button onClick={camOn?stopCam:startCam} className={`px-6 py-2.5 rounded-2xl font-bold text-sm transition-all ${camOn?"bg-rose-600 hover:bg-rose-500":"bg-gray-100 hover:bg-gray-100 border border-gray-200"}`}>{camOn?"📵 Stop Camera":"📷 Start Camera"}</button>
          <div className="w-full max-w-xs space-y-3">
            <p className="text-gray-400 text-xs text-center">Point your QR code at the camera to record attendance.</p>
            {err&&<p className="text-red-400 text-xs text-center">{err}</p>}
          </div>
        </div>
        <div className="w-full md:w-80 border-t md:border-t-0 md:border-l border-gray-200 flex flex-col shrink-0 max-h-[40vh] md:max-h-none">
          <div className="px-6 py-4 border-b border-gray-200"><div className="font-bold text-sm">Recent Scans</div><div className="text-gray-400 text-xs mt-0.5">{log.length} this session</div></div>
          <div className="flex-1 overflow-y-auto p-4 space-y-2">
            {log.length===0?<div className="text-center py-12 text-gray-300 text-sm">No scans yet</div>
              :log.map(l=>(
                <div key={l.id} className={`border rounded-2xl px-4 py-3 flex items-center justify-between ${l.isRestDay?"bg-purple-500/10 border-purple-500/20":"bg-white border-gray-200"}`}>
                  <div><div className="text-sm font-semibold text-gray-800 truncate w-32">{l.empName}</div><div className="text-xs text-gray-400 mt-0.5">{l.isRestDay?"⚠ Day Off":AL[l.action]}</div></div>
                  <div className="font-mono text-xs text-gray-500 bg-gray-100 px-2 py-1 rounded-lg">{fmt(l.time)}</div>
                </div>
              ))
            }
          </div>
          <div className="border-t border-gray-200 p-5">
            <div className="text-gray-400 text-xs font-bold uppercase tracking-wider mb-3">Today's Status</div>
            <div className="space-y-2">
              {activeEmps.map(e=>{
                const next=getNext(e.id);
                return (<div key={e.id} className="flex items-center justify-between">
                  <span className="text-gray-500 text-xs truncate w-28">{e.name.split(" ")[0]}</span>
                  <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${next==="done"?"bg-emerald-500/20 text-emerald-400":next==="time-in"?"bg-gray-500/20 text-gray-400":"bg-blue-500/20 text-blue-300"}`}>
                    {next==="done"?"✓ Done":next==="time-in"?"Not in":AL[next]}
                  </span>
                </div>);
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// RFID MONITOR (TEST)
// The attendance write happens entirely SERVER-SIDE: the WiFi reader calls the
// `record_rfid_scan` Postgres RPC, which resolves the card, advances the Time In →
// Break → Time Out sequence, and writes the `attendance` row by itself — no kiosk
// required. This screen is a READ-ONLY live monitor: it never writes attendance,
// it just watches taps come in (so it can never double-process). Its manual box
// calls the SAME server RPC, so browser testing takes the identical path.
// ════════════════════════════════════════════════════════════════════════════
function RfidKiosk({ employees, allAttendance, onBack }) {
  const [clock,setClock]=useState(nowDate());
  const [feed,setFeed]=useState([]);
  const [result,setResult]=useState(null);
  const [manual,setManual]=useState("");
  const [sending,setSending]=useState(false);
  const [online,setOnline]=useState(navigator.onLine!==false);
  const empRef=useRef(employees);
  useEffect(()=>{ empRef.current=employees; },[employees]);

  useEffect(()=>{ const t=setInterval(()=>setClock(nowDate()),1000); return ()=>clearInterval(t); },[]);
  useEffect(()=>{
    const up=()=>setOnline(true), down=()=>setOnline(false);
    window.addEventListener('online',up); window.addEventListener('offline',down);
    return ()=>{ window.removeEventListener('online',up); window.removeEventListener('offline',down); };
  },[]);

  const AL={"time-in":"Time In","break1-start":"Start Break","break1-end":"End Break","break2-start":"Start Break","break2-end":"End Break","time-out":"Time Out"};

  // Watch taps land in `rfid_scans` — READ ONLY. The server already recorded the
  // attendance; here we only surface that a card was tapped and by whom.
  useEffect(()=>{
    const ch=supabase.channel('rfid-monitor-ch')
      .on('postgres_changes',{event:'INSERT',schema:'public',table:'rfid_scans'},payload=>{
        const uid=payload.new?.uid; if(!uid) return;
        const up=uid.trim().toUpperCase();
        const emp=empRef.current.find(e=>e.rfidUid&&e.rfidUid.trim().toUpperCase()===up);
        setFeed(p=>[{key:payload.new.id||Date.now(),uid,name:emp?emp.name:null,at:phTimeStr()},...p.slice(0,20)]);
      }).subscribe();
    return ()=>{ supabase.removeChannel(ch); };
  },[]);

  // Manual test — calls the exact server function the reader calls.
  const sendManual=async()=>{
    const v=manual.trim(); if(!v||sending) return;
    setSending(true); setManual("");
    try {
      const {data,error}=await supabase.rpc('record_rfid_scan',{p_uid:v});
      if(error) throw error;
      setResult(data||{status:'error'});
    } catch(e){ setResult({status:'error',message:e.message}); }
    setSending(false);
    setTimeout(()=>setResult(null),2800);
  };

  // Derive each employee's current stage from today's record (display only).
  const TODAY=getToday();
  const today=allAttendance[TODAY]||{};
  const stageOf=r=>{ if(!r||!r.timeIn) return "Not in";
    if(r.timeOut) return "Done";
    if(r.coffeeStart&&!r.coffeeEnd) return "On break";
    if(r.lunchStart&&!r.lunchEnd) return "On break";
    if(r.coffeeEnd&&r.lunchEnd) return "Working";
    if(r.coffeeEnd) return "Working";
    return "Working"; };
  const activeEmps=employees.filter(e=>e.status==="active");

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-800 text-white flex flex-col">
      <header className="flex items-center justify-between px-4 sm:px-8 py-3 sm:py-5 border-b border-white/10 shrink-0">
        <div className="flex items-center gap-2 sm:gap-3">
          <div className="w-8 h-8 sm:w-9 sm:h-9 bg-white/10 border border-white/20 rounded-xl flex items-center justify-center font-black text-sm">A</div>
          <div><div className="font-black text-xs sm:text-sm">BilisOps</div><div className="text-white/30 text-[10px] sm:text-xs">RFID Monitor</div></div>
          <span className="ml-1 text-[10px] font-bold px-2 py-0.5 rounded-full border bg-amber-500/15 text-amber-300 border-amber-500/30">TEST</span>
          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${online?"bg-emerald-500/15 text-emerald-300 border-emerald-500/30":"bg-amber-500/20 text-amber-300 border-amber-500/40"}`}>{online?"● Online":"● Offline"}</span>
        </div>
        <div className="text-center">
          <div className="text-xl sm:text-4xl font-black tabular-nums">{clock.toLocaleTimeString("en-PH",{hour:"2-digit",minute:"2-digit",second:"2-digit",timeZone:PH_TZ})}</div>
          <div className="text-white/30 text-[9px] sm:text-xs mt-0.5 hidden xs:block">{clock.toLocaleDateString("en-PH",{weekday:"short",month:"short",day:"numeric",timeZone:PH_TZ})} · PH time</div>
        </div>
        <button onClick={onBack} className="border border-white/20 hover:border-white/40 text-white/40 hover:text-white text-xs font-semibold px-3 sm:px-4 py-2 rounded-xl transition-colors">←</button>
      </header>
      <div className="flex-1 flex flex-col md:flex-row overflow-y-auto md:overflow-hidden">
        <div className="flex-1 flex flex-col items-center justify-center p-4 sm:p-8 gap-5 relative min-h-[60vh] md:min-h-0">
          {result&&(
            <div className="absolute inset-0 z-20 bg-slate-900/30 backdrop-blur-md flex items-center justify-center">
              {result.status==='ok'?(
                <div className="bg-gradient-to-br from-emerald-600 to-emerald-900 rounded-3xl p-10 text-center shadow-2xl max-w-sm w-full mx-6">
                  <div className="text-6xl mb-4">✅</div>
                  <div className="text-3xl font-black mb-2">{AL[result.action]||result.action}</div>
                  <div className="text-white/90 font-bold text-xl">{result.name}</div>
                  <div className="mt-4 font-mono text-3xl font-black">{fmt(result.time)}</div>
                  {(result.late||0)>0&&<div className="mt-3 bg-black/20 rounded-2xl px-4 py-2 text-sm font-semibold">⚠ {result.late} min late</div>}
                </div>
              ):result.status==='unknown_card'?(
                <div className="bg-gradient-to-br from-slate-700 to-slate-900 rounded-3xl p-10 text-center shadow-2xl max-w-sm w-full mx-6 border border-white/10">
                  <div className="text-6xl mb-4">❓</div>
                  <div className="text-2xl font-black mb-1">Tag Not Found</div>
                  <div className="text-white/50 text-sm mb-4">This card isn't linked to an employee.</div>
                  <div className="bg-white/10 rounded-2xl px-5 py-3 text-sm text-white/70">UID <span className="font-mono font-bold text-white">{result.card_uid}</span></div>
                  <div className="mt-3 text-xs text-white/30">Add this UID to an employee in the Admin portal to enroll the card.</div>
                </div>
              ):result.status==='done'?(
                <div className="bg-gradient-to-br from-emerald-700 to-emerald-900 rounded-3xl p-10 text-center shadow-2xl max-w-sm w-full mx-6">
                  <div className="text-6xl mb-4">🏁</div>
                  <div className="text-2xl font-black mb-1">All Done</div>
                  <div className="text-white/90 font-bold text-xl">{result.name}</div>
                  <div className="text-white/50 text-sm mt-1">All scans completed for today.</div>
                </div>
              ):result.status==='duplicate'?(
                <div className="bg-gradient-to-br from-slate-700 to-slate-900 rounded-3xl p-10 text-center shadow-2xl max-w-sm w-full mx-6 border border-white/10">
                  <div className="text-6xl mb-4">🔁</div>
                  <div className="text-2xl font-black mb-1">Too Soon</div>
                  <div className="text-white/50 text-sm mb-4">2-minute cooldown after each scan — ignored.</div>
                  <div className="text-white/90 font-bold text-xl">{result.name}</div>
                  {result.secs_left>0&&<div className="mt-3 text-xs text-white/30">Try again in ~{result.secs_left}s</div>}
                </div>
              ):(
                <div className="bg-gradient-to-br from-rose-700 to-rose-900 rounded-3xl p-10 text-center shadow-2xl max-w-sm w-full mx-6">
                  <div className="text-6xl mb-4">✕</div>
                  <div className="text-2xl font-black mb-1">Error</div>
                  <div className="text-white/60 text-sm mt-1 break-words">{result.message||'Scan failed.'}</div>
                </div>
              )}
            </div>
          )}
          <div className="w-[70vw] h-[70vw] max-w-[320px] max-h-[320px] rounded-3xl border-2 border-white/20 bg-black/40 shadow-2xl flex flex-col items-center justify-center gap-4">
            <span className="text-7xl">🪪</span>
            <span className="text-white/40 text-sm font-semibold text-center px-6">Just tap a card — it records automatically</span>
            <span className="flex items-center gap-2 text-[11px] text-white/30"><span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"/>Server is recording · monitor only</span>
          </div>
          <div className="w-full max-w-xs space-y-2">
            <p className="text-white/25 text-[11px] text-center">No reader handy? Type a UID to test the server function.</p>
            <div className="flex gap-2">
              <input value={manual} onChange={e=>setManual(e.target.value)} onKeyDown={e=>e.key==="Enter"&&sendManual()} placeholder="Enter UID…" className="flex-1 bg-white/5 border border-white/15 rounded-xl px-3 py-2 text-sm text-white placeholder-white/25 focus:outline-none focus:border-white/40 font-mono"/>
              <button onClick={sendManual} disabled={sending} className="bg-white/10 hover:bg-white/15 border border-white/20 rounded-xl px-4 py-2 text-sm font-bold disabled:opacity-50">{sending?"…":"Send"}</button>
            </div>
          </div>
        </div>
        <div className="w-full md:w-80 border-t md:border-t-0 md:border-l border-white/10 flex flex-col shrink-0 max-h-[45vh] md:max-h-none">
          <div className="px-6 py-4 border-b border-white/10"><div className="font-bold text-sm">Live Taps</div><div className="text-white/30 text-xs mt-0.5">{feed.length} this session · recorded by server</div></div>
          <div className="overflow-y-auto p-4 space-y-2 border-b border-white/10" style={{maxHeight:'40%'}}>
            {feed.length===0?<div className="text-center py-8 text-white/20 text-sm">No taps yet</div>
              :feed.map(f=>(
                <div key={f.key} className="border rounded-2xl px-4 py-2.5 flex items-center justify-between bg-white/5 border-white/10">
                  <div><div className="text-sm font-semibold text-white/90 truncate w-32">{f.name||<span className="text-amber-300">Unknown card</span>}</div><div className="text-[11px] text-white/35 mt-0.5 font-mono">{f.uid}</div></div>
                  <div className="font-mono text-xs text-white/60 bg-white/10 px-2 py-1 rounded-lg">{fmt(f.at)}</div>
                </div>
              ))
            }
          </div>
          <div className="px-6 py-3 border-b border-white/10"><div className="text-white/25 text-xs font-bold uppercase tracking-wider">Today's Status</div></div>
          <div className="flex-1 overflow-y-auto p-4 space-y-2">
            {activeEmps.map(e=>{ const st=stageOf(today[e.id]);
              return (<div key={e.id} className="flex items-center justify-between">
                <span className="text-white/60 text-xs truncate w-28">{e.name.split(" ")[0]}</span>
                <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${st==="Done"?"bg-emerald-500/20 text-emerald-400":st==="Not in"?"bg-gray-500/20 text-gray-400":st==="On break"?"bg-sky-500/20 text-sky-300":"bg-teal-500/20 text-teal-300"}`}>{st}</span>
              </div>);
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// FACIAL KIOSK — facial recognition
// The camera continuously looks for a face; a recognized employee is clocked
// through the SAME time-in → breaks → time-out sequence (onScan/handleScan) the
// QR kiosk uses. A manual-ID fallback stays available (face not enrolled, bad
// lighting, camera trouble). Faces are matched against enrolled 128-D descriptors.
// ════════════════════════════════════════════════════════════════════════════
// Device-level kiosk preferences (per tablet, stored locally)
const KIOSK_PREFS_KEY='bilisops_kiosk_prefs';
const loadKioskPrefs=()=>{ try{ return {autoStandby:true,idleSecs:60,...JSON.parse(localStorage.getItem(KIOSK_PREFS_KEY)||'{}')}; }catch{ return {autoStandby:true,idleSecs:60}; } };
const saveKioskPrefs=p=>{ try{ localStorage.setItem(KIOSK_PREFS_KEY,JSON.stringify(p)); }catch{} };

function FacialKiosk({ employees, allAttendance, onScan, onBack, onKioskLogout, quietRefresh, addToast }) {
  const [clock,setClock]=useState(nowDate());
  const [log,setLog]=useState([]);
  const [scanning,setScan]=useState(false);
  const [result,setResult]=useState(null);
  const [camOn,setCamOn]=useState(false);
  const [faceState,setFaceState]=useState("idle"); // idle | loading | scanning | error
  const [seen,setSeen]=useState(null); // {name, pct} | {unknown:true} | null — live recognition feedback
  const [input,setInput]=useState("");
  const [showManual,setShowManual]=useState(false);
  const [err,setErr]=useState("");
  const [online,setOnline]=useState(navigator.onLine!==false);
  const [pending,setPending]=useState(loadScanQueue().length);
  const vidRef=useRef(null); const streamRef=useRef(null); const detectRef=useRef(null);
  const lastScanRef=useRef({});
  const stableRef=useRef({id:null,count:0}); // consecutive-match counter before a scan fires
  const busyRef=useRef(false); // one detection in flight at a time
  // ── Standby: after idleSecs with no face, dim to a screensaver; the camera keeps
  // watching at a slow tick and WAKES the kiosk the moment a face appears. ──────
  const [standby,setStandby]=useState(false);
  const [prefs,setPrefs]=useState(loadKioskPrefs());
  const standbyRef=useRef(false); useEffect(()=>{ standbyRef.current=standby; },[standby]);
  const prefsRef=useRef(prefs);   useEffect(()=>{ prefsRef.current=prefs; },[prefs]);
  const lastFaceRef=useRef(Date.now());
  const tickRef=useRef(0);
  // ── Kiosk settings (⚙): standby prefs + on-device face enrollment ───────────
  const [showSettings,setShowSettings]=useState(false);
  const [enrollEmp,setEnrollEmp]=useState(null); const [enrollSaving,setEnrollSaving]=useState(false);
  const camWasOnRef=useRef(false);
  const openSettings=()=>{ setStandby(false); lastFaceRef.current=Date.now(); camWasOnRef.current=camOn; if(camOn) stopCam(); setShowSettings(true); };
  const closeSettings=()=>{ setShowSettings(false); setEnrollEmp(null); if(camWasOnRef.current) startCam(); };
  const savePrefs=p=>{ setPrefs(p); saveKioskPrefs(p); };
  const saveEnrollment=async(desc)=>{
    if(!enrollEmp) return;
    setEnrollSaving(true);
    const {error}=await supabase.from('employees').update({face_descriptors:desc}).eq('id',enrollEmp.id);
    setEnrollSaving(false);
    if(error){ addToast?.("Failed to save: "+error.message,"error"); return; }
    setEnrollEmp(e=>({...e,faceDescriptors:desc}));
    addToast?.(`Face saved for ${enrollEmp.name} (${desc.length} sample${desc.length===1?"":"s"}).`,"success");
    quietRefresh?.();
  };

  useEffect(()=>{ const t=setInterval(()=>setClock(nowDate()),1000); return ()=>clearInterval(t); },[]);
  useEffect(()=>{
    const up=()=>setOnline(true), down=()=>setOnline(false);
    window.addEventListener('online',up); window.addEventListener('offline',down);
    const t=setInterval(()=>{ setOnline(navigator.onLine!==false); setPending(loadScanQueue().length); }, 3000);
    return ()=>{ window.removeEventListener('online',up); window.removeEventListener('offline',down); clearInterval(t); };
  },[]);

  const TODAY=getToday();
  const today=allAttendance[TODAY]||{};
  const getNext=id=>{ const r=today[id];
    if(!r||!r.timeIn) return "time-in";
    if(r.timeOut) return "done";
    if(r.coffeeStart&&!r.coffeeEnd) return "break1-end";
    if(r.lunchStart&&!r.lunchEnd) return "break2-end";
    if(r.coffeeEnd&&r.lunchEnd) return "time-out";
    if(r.coffeeEnd&&!r.lunchStart) return "break2-start";
    if(!r.coffeeStart) return "break1-start";
    return "time-out"; };
  const AL={"time-in":"Time In","break1-start":"Start Break","break1-end":"End Break","break2-start":"Start Break","break2-end":"End Break","time-out":"Time Out",done:"Completed"};
  const AG={"time-in":"from-emerald-500 to-emerald-700","break1-start":"from-sky-500 to-sky-700","break1-end":"from-sky-600 to-sky-800","break2-start":"from-sky-500 to-sky-700","break2-end":"from-sky-600 to-sky-800","time-out":"from-rose-500 to-rose-700"};
  const AI={"time-in":"🟢","break1-start":"☕","break1-end":"✅","break2-start":"☕","break2-end":"✅","time-out":"🔴"};

  // Matcher rebuilt whenever employees (and their enrolled descriptors) change.
  const matcher=useMemo(()=>buildMatcher(employees),[employees]);
  const enrolledCount=useMemo(()=>employees.filter(e=>e.status==="active"&&e.faceDescriptors?.length>0).length,[employees]);

  // Core scan handler for an already-resolved employee (face match or manual entry).
  const processEmp=emp=>{
    if (scanning) return;
    if (!emp||emp.status!=="active") { setErr("Employee not found or inactive."); return; }
    const id=emp.id;
    const dayName=DAY_NAMES[phDayIdx()];
    const ov=today[id]?.scheduleOverride;
    const ovDayType=ov?.dayType||"normal";
    const restDays=Array.isArray(ov?.restDays)?ov.restDays:emp.schedule.restDays;
    const isRestDay=ovDayType==="off"?true:ovDayType==="work"?false:restDays.includes(dayName);
    const action=getNext(id);
    if (action==="done") { setErr("All scans completed for today."); return; }
    const COOLDOWN=120000; // 2 min — after ANY scan the same person is locked out (stops a lingering face auto-advancing)
    const last=lastScanRef.current[id];
    if (last && (Date.now()-last.timestamp)<COOLDOWN) {
      const secsLeft=Math.ceil((COOLDOWN-(Date.now()-last.timestamp))/1000);
      setResult({emp,action:last.action,time:last.time,duplicate:true,secsLeft});
      setTimeout(()=>setResult(null),3000); return;
    }
    const now=phTimeStr();
    lastScanRef.current[id]={action,time:now,timestamp:Date.now()};
    setScan(true); setErr("");
    onScan(id,action,now,isRestDay,extra=>{
      setResult({emp,action,time:now,isRestDay,...extra});
      setLog(p=>[{id:Date.now(),empName:emp.name,empId:id,action,time:now,isRestDay},...p.slice(0,11)]);
      setTimeout(()=>setResult(null),1800);
    });
    setScan(false); setInput("");
  };
  // Manual fallback: badge/QR code first (old ID cards keep working), then Employee ID. Case-insensitive.
  const processManual=raw=>{
    const up=(raw||"").trim().toUpperCase();
    if (!up) return;
    const emp=employees.find(e=>(e.qrCode&&e.qrCode.trim().toUpperCase()===up)||(e.id||"").toUpperCase()===up);
    if (!emp) { setErr("Employee not found or inactive."); return; }
    processEmp(emp);
  };

  const startCam=async()=>{
    setErr("");
    if (!navigator.mediaDevices?.getUserMedia) { setErr("Camera not supported."); return; }
    setFaceState("loading");
    try {
      await loadFaceModels();
      let s; try{s=await navigator.mediaDevices.getUserMedia({video:{facingMode:"user"}});}catch{s=await navigator.mediaDevices.getUserMedia({video:true});}
      streamRef.current=s; setCamOn(true); setFaceState("scanning");
      lastFaceRef.current=Date.now();
      detectRef.current=setInterval(async()=>{
        if(!vidRef.current||vidRef.current.readyState<2||busyRef.current) return;
        // In standby, only check every 4th tick (~2.8s) — enough to catch a person
        // stepping up, cheap enough to run all day.
        if(standbyRef.current){ tickRef.current=(tickRef.current+1)%4; if(tickRef.current!==0) return; }
        busyRef.current=true;
        try {
          const det=await detectFace(vidRef.current);
          if (det) {
            lastFaceRef.current=Date.now();
            if (standbyRef.current) { setStandby(false); return; } // face detected → wake up
          } else if (!standbyRef.current && prefsRef.current.autoStandby
                     && Date.now()-lastFaceRef.current > prefsRef.current.idleSecs*1000) {
            setStandby(true); setSeen(null); stableRef.current={id:null,count:0}; return; // idle → sleep
          }
          if (!det) { setSeen(null); stableRef.current={id:null,count:0}; return; }
          if (!matcherRef.current) { setSeen({unknown:true}); return; }
          const best=matcherRef.current.findBestMatch(det.descriptor);
          if (best.label==="unknown") { setSeen({unknown:true}); stableRef.current={id:null,count:0}; return; }
          const emp=employeesRef.current.find(e=>e.id===best.label);
          const pct=Math.max(0,Math.round((1-best.distance/MATCH_THRESHOLD)*100));
          setSeen({name:emp?.name||best.label,pct});
          // Require 2 consecutive detections of the SAME person before acting — a single frame
          // can mis-match; two in a row (~1.4s apart) is far more reliable.
          const st=stableRef.current;
          stableRef.current = st.id===best.label ? {id:best.label,count:st.count+1} : {id:best.label,count:1};
          if (stableRef.current.count>=2 && emp) { stableRef.current={id:null,count:0}; processEmpRef.current(emp); }
        } catch {}
        finally { busyRef.current=false; }
      },700);
    } catch(e) {
      setFaceState("error");
      if(e?.name==="NotAllowedError") setErr("Camera permission denied.");
      else if(e?.name==="NotFoundError") setErr("No camera found.");
      else setErr("Camera error: "+(e?.message||"unknown"));
    }
  };
  useEffect(()=>{ if(camOn&&streamRef.current&&vidRef.current){vidRef.current.srcObject=streamRef.current;vidRef.current.play().catch(()=>{});} },[camOn]);
  const stopCam=()=>{ if(detectRef.current){clearInterval(detectRef.current);detectRef.current=null;} streamRef.current?.getTracks().forEach(t=>t.stop()); streamRef.current=null; if(vidRef.current)vidRef.current.srcObject=null; setCamOn(false); setFaceState("idle"); setSeen(null); };
  useEffect(()=>()=>{ if(detectRef.current)clearInterval(detectRef.current); streamRef.current?.getTracks().forEach(t=>t.stop()); },[]);

  // Keep refs on the latest values so the long-lived detect interval never reads a stale matcher/handler.
  const processEmpRef=useRef(processEmp); useEffect(()=>{ processEmpRef.current=processEmp; });
  const matcherRef=useRef(matcher);       useEffect(()=>{ matcherRef.current=matcher; },[matcher]);
  const employeesRef=useRef(employees);   useEffect(()=>{ employeesRef.current=employees; },[employees]);

  const activeEmps=employees.filter(e=>e.status==="active");
  const ringCls = seen ? (seen.unknown?"border-amber-400":"border-emerald-400") : "border-white/20";

  return (
    <div className="min-h-screen bg-mist text-gray-800 flex flex-col">
      <header className="flex items-center justify-between px-4 sm:px-8 py-3 sm:py-5 border-b border-gray-200 shrink-0">
        <div className="flex items-center gap-2 sm:gap-3">
          <BrandMark className="w-8 h-8 sm:w-9 sm:h-9 rounded-xl"/>
          <div><div className="font-black text-xs sm:text-sm">BilisOps</div><div className="text-gray-400 text-[10px] sm:text-xs">Facial Kiosk</div></div>
          <span className={`ml-1 text-[10px] font-bold px-2 py-0.5 rounded-full border ${online?"bg-emerald-500/15 text-emerald-300 border-emerald-500/30":"bg-amber-500/20 text-amber-300 border-amber-500/40"}`}>{online?"● Online":"● Offline"}{pending>0?` · ${pending} queued`:""}</span>
        </div>
        <div className="text-center">
          <div className="text-xl sm:text-4xl font-black tabular-nums">{clock.toLocaleTimeString("en-PH",{hour:"2-digit",minute:"2-digit",second:"2-digit",timeZone:PH_TZ})}</div>
          <div className="text-gray-400 text-[9px] sm:text-xs mt-0.5 hidden xs:block">{clock.toLocaleDateString("en-PH",{weekday:"short",month:"short",day:"numeric",timeZone:PH_TZ})} · PH time</div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={openSettings} title="Kiosk settings" className="border border-gray-200 hover:border-brand-300 text-gray-400 hover:text-brand-700 text-xs font-semibold px-3 sm:px-4 py-2 rounded-xl transition-colors"><Icon name="settings" className="w-4 h-4"/></button>
          <button onClick={onKioskLogout} title="Log out this kiosk" className="border border-gray-200 hover:border-gray-300 text-gray-400 hover:text-gray-900 text-xs font-semibold px-3 sm:px-4 py-2 rounded-xl transition-colors"><Icon name="logout" className="w-4 h-4"/></button>
          <button onClick={onBack} className="border border-gray-200 hover:border-gray-300 text-gray-400 hover:text-gray-900 text-xs font-semibold px-3 sm:px-4 py-2 rounded-xl transition-colors">←</button>
        </div>
      </header>
      {/* Standby screensaver — the camera keeps watching; a detected face (or a tap) wakes it */}
      {standby&&(
        <div onClick={()=>{setStandby(false);lastFaceRef.current=Date.now();}} className="fixed inset-0 z-40 bg-slate-950/95 flex flex-col items-center justify-center gap-6 cursor-pointer">
          <div className="float-y"><BrandMark className="w-24 h-24 rounded-3xl glow-brand"/></div>
          <div className="text-white text-2xl font-black tabular-nums">{clock.toLocaleTimeString("en-PH",{hour:"2-digit",minute:"2-digit",timeZone:PH_TZ})}</div>
          <div className="text-white/50 text-sm font-semibold animate-pulse">Step in front of the camera to check in</div>
        </div>
      )}
      {/* Kiosk settings modal */}
      {showSettings&&(
        <div className="fixed inset-0 bg-slate-900/25 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={closeSettings}>
          <div className="bg-white rounded-3xl w-full max-w-lg max-h-[88vh] overflow-y-auto shadow-2xl p-7" onClick={e=>e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-black text-ink flex items-center gap-2"><Icon name="settings" className="w-5 h-5 text-brand-600"/> Kiosk settings</h2>
              <button onClick={closeSettings} className="w-9 h-9 rounded-lg hover:bg-gray-100 text-gray-400">✕</button>
            </div>
            {/* Standby */}
            <div className="border border-gray-100 rounded-2xl p-4 mb-4">
              <h3 className="font-bold text-gray-800 text-sm mb-2">Standby mode</h3>
              <label className="flex items-center gap-2 text-sm text-gray-700 mb-3">
                <input type="checkbox" checked={prefs.autoStandby} onChange={e=>savePrefs({...prefs,autoStandby:e.target.checked})} className="accent-brand-600 w-4 h-4"/>
                Dim to screensaver when no face is seen — wakes automatically when someone steps up
              </label>
              <div className="flex items-center gap-2 text-sm text-gray-600">
                Sleep after <input type="number" min="10" value={prefs.idleSecs} onChange={e=>savePrefs({...prefs,idleSecs:Math.max(10,Number(e.target.value)||60)})} className="w-20 border border-gray-200 rounded-lg px-2 py-1.5 text-sm"/> seconds idle
              </div>
            </div>
            {/* Face enrollment */}
            <div className="border border-gray-100 rounded-2xl p-4">
              <h3 className="font-bold text-gray-800 text-sm mb-1">Register a face</h3>
              <p className="text-xs text-gray-400 mb-3">Enroll or update an employee's face right here on the kiosk. Capture 3+ samples for reliable matching.</p>
              <select value={enrollEmp?.id||""} onChange={e=>setEnrollEmp(employees.find(x=>x.id===e.target.value)||null)} className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm mb-3">
                <option value="">Select an employee…</option>
                {employees.filter(e=>e.status==="active").map(e=><option key={e.id} value={e.id}>{e.name} ({e.id}){e.faceDescriptors?.length?` — ${e.faceDescriptors.length} sample(s)`:""}</option>)}
              </select>
              {enrollEmp&&(
                <div>
                  {enrollSaving&&<div className="text-xs text-brand-600 font-bold mb-2">Saving…</div>}
                  <FaceEnroll key={enrollEmp.id} value={enrollEmp.faceDescriptors||[]} onChange={saveEnrollment}/>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      <div className="flex-1 flex flex-col md:flex-row overflow-y-auto md:overflow-hidden">
        <div className="flex-1 flex flex-col items-center justify-center p-4 sm:p-8 gap-4 sm:gap-5 relative min-h-[60vh] md:min-h-0">
          {result&&(
            <div className="absolute inset-0 z-20 bg-slate-900/30 backdrop-blur-md flex items-center justify-center">
              {result.duplicate?(
                <div className="bg-white rounded-3xl p-10 text-center shadow-2xl max-w-sm w-full mx-6 border border-gray-100">
                  <div className="text-6xl mb-4">🔁</div>
                  <div className="text-2xl font-black mb-1 text-ink">Already Scanned</div>
                  <div className="text-gray-400 text-sm mb-5">Ignored to prevent duplicates</div>
                  <div className="text-ink font-bold text-xl">{result.emp.name}</div>
                  <div className="mt-4 bg-gray-100 rounded-2xl px-5 py-3 text-sm text-gray-600"><span className="font-bold text-gray-900">{AL[result.action]}</span> at <span className="font-mono font-bold text-gray-900">{fmt(result.time)}</span></div>
                  <div className="mt-3 text-xs text-gray-400">Next scan in ~{result.secsLeft}s</div>
                </div>
              ):result.isRestDay?(
                <div className="bg-gradient-to-br from-brand-500 to-brand-700 rounded-3xl p-10 text-center shadow-2xl max-w-sm w-full mx-6">
                  <div className="text-6xl mb-4">📅</div>
                  <div className="text-3xl font-black mb-2 text-white">Day Off</div>
                  <div className="text-white/90 font-bold text-xl">{result.emp.name}</div>
                  <div className="text-white/60 text-sm mt-1">{result.emp.department}</div>
                  <div className="mt-5 bg-black/15 rounded-2xl px-4 py-3 text-sm font-semibold text-white">⚠ Today is your scheduled rest day</div>
                  <div className="mt-3 text-white/50 text-xs">Scan logged at {fmt(result.time)}</div>
                </div>
              ):(
                <div className={`bg-gradient-to-br ${AG[result.action]} rounded-3xl p-10 text-center shadow-2xl max-w-sm w-full mx-6`}>
                  <div className="text-6xl mb-4">{AI[result.action]}</div>
                  <div className="text-3xl font-black mb-2">{AL[result.action]}</div>
                  <div className="text-white/90 font-bold text-xl">{result.emp.name}</div>
                  <div className="text-white/50 text-sm mt-1">{result.emp.department}</div>
                  <div className="mt-4 font-mono text-3xl font-black">{fmt(result.time)}</div>
                  {(result.lateMinutes||0)>0&&<div className="mt-3 bg-black/20 rounded-2xl px-4 py-2 text-sm font-semibold">⚠ {result.lateMinutes} min late</div>}
                  {(result.overBreak||0)>0&&<div className="mt-2 bg-black/20 rounded-2xl px-4 py-2 text-sm font-semibold">⚠ {result.overBreak} min over break</div>}
                </div>
              )}
            </div>
          )}
          <div className={`relative w-[88vw] h-[88vw] max-w-[420px] max-h-[420px] sm:w-80 sm:h-80 md:w-72 md:h-72 rounded-3xl overflow-hidden border-2 bg-mist shadow-lg transition-colors ${ringCls}`}>
            {camOn?<video ref={vidRef} autoPlay playsInline muted className="w-full h-full object-cover -scale-x-100"/>
              :<div className="w-full h-full flex flex-col items-center justify-center gap-3 text-gray-400"><span className="text-6xl">🙂</span><span className="text-sm">{faceState==="loading"?"Loading face models…":"Camera is off"}</span></div>}
            {camOn&&<>
              <div className="absolute top-3 left-3 w-7 h-7 border-t-2 border-l-2 border-white rounded-tl-lg"/>
              <div className="absolute top-3 right-3 w-7 h-7 border-t-2 border-r-2 border-white rounded-tr-lg"/>
              <div className="absolute bottom-3 left-3 w-7 h-7 border-b-2 border-l-2 border-white rounded-bl-lg"/>
              <div className="absolute bottom-3 right-3 w-7 h-7 border-b-2 border-r-2 border-white rounded-br-lg"/>
              <div className={`absolute top-2 left-1/2 -translate-x-1/2 text-[10px] font-bold px-2 py-0.5 rounded-full ${seen&&!seen.unknown?"bg-emerald-500/80":seen?.unknown?"bg-amber-500/80":"bg-sky-500/80"} text-white whitespace-nowrap`}>
                {seen&&!seen.unknown?`● ${seen.name} · ${seen.pct}%`:seen?.unknown?"Face not recognized":"● Face scan active"}
              </div>
            </>}
          </div>
          <button onClick={camOn?stopCam:startCam} disabled={faceState==="loading"} className={`px-6 py-2.5 rounded-2xl font-bold text-sm transition-all disabled:opacity-60 ${camOn?"bg-rose-600 hover:bg-rose-500":"bg-gray-100 hover:bg-gray-100 border border-gray-200"}`}>{camOn?"📵 Stop Camera":faceState==="loading"?"⏳ Loading…":"📷 Start Camera"}</button>
          <div className="w-full max-w-xs space-y-3">
            <p className="text-gray-400 text-xs text-center">Look at the camera to record attendance.</p>
            {enrolledCount===0&&<p className="text-amber-300/80 text-xs text-center">⚠ No faces enrolled yet — enroll employees in the Admin Portal (Employees → Edit → Face).</p>}
            {err&&<p className="text-red-400 text-xs text-center">{err}</p>}
            <div className="text-center">
              <button onClick={()=>setShowManual(s=>!s)} className="text-gray-400 hover:text-gray-600 text-[11px] underline underline-offset-2 transition-colors">{showManual?"Hide manual entry":"Trouble scanning? Manual entry"}</button>
            </div>
            {showManual&&(
              <div className="flex gap-2">
                <input value={input} onChange={e=>{setInput(e.target.value);setErr("");}} onKeyDown={e=>e.key==="Enter"&&processManual(input)} placeholder="Employee ID or badge code" className="flex-1 bg-gray-100 border border-gray-200 rounded-xl px-3 py-2.5 text-sm font-mono focus:outline-none focus:border-brand-400 placeholder:text-gray-400"/>
                <button onClick={()=>processManual(input)} className="bg-gray-100 hover:bg-gray-100 border border-gray-200 text-sm font-bold px-4 rounded-xl">→</button>
              </div>
            )}
          </div>
        </div>
        <div className="w-full md:w-80 border-t md:border-t-0 md:border-l border-gray-200 flex flex-col shrink-0 max-h-[40vh] md:max-h-none">
          <div className="px-6 py-4 border-b border-gray-200"><div className="font-bold text-sm">Recent Scans</div><div className="text-gray-400 text-xs mt-0.5">{log.length} this session</div></div>
          <div className="flex-1 overflow-y-auto p-4 space-y-2">
            {log.length===0?<div className="text-center py-12 text-gray-300 text-sm">No scans yet</div>
              :log.map(l=>(
                <div key={l.id} className={`border rounded-2xl px-4 py-3 flex items-center justify-between ${l.isRestDay?"bg-purple-500/10 border-purple-500/20":"bg-white border-gray-200"}`}>
                  <div><div className="text-sm font-semibold text-gray-800 truncate w-32">{l.empName}</div><div className="text-xs text-gray-400 mt-0.5">{l.isRestDay?"⚠ Day Off":AL[l.action]}</div></div>
                  <div className="font-mono text-xs text-gray-500 bg-gray-100 px-2 py-1 rounded-lg">{fmt(l.time)}</div>
                </div>
              ))
            }
          </div>
          <div className="border-t border-gray-200 p-5">
            <div className="text-gray-400 text-xs font-bold uppercase tracking-wider mb-3">Today's Status</div>
            <div className="space-y-2">
              {activeEmps.map(e=>{
                const next=getNext(e.id);
                return (<div key={e.id} className="flex items-center justify-between">
                  <span className="text-gray-500 text-xs truncate w-28">{e.name.split(" ")[0]}</span>
                  <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${next==="done"?"bg-emerald-500/20 text-emerald-400":next==="time-in"?"bg-gray-500/20 text-gray-400":"bg-blue-500/20 text-blue-300"}`}>
                    {next==="done"?"✓ Done":next==="time-in"?"Not in":AL[next]}
                  </span>
                </div>);
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// NOTIFICATION BELL
// ════════════════════════════════════════════════════════════════════════════
function NotificationBell({ adminUser }) {
  const [notifs,setNotifs]=useState([]);
  const [open,setOpen]=useState(false);
  const unread=notifs.filter(n=>!n.is_read).length;

  const load=useCallback(async()=>{
    let q=supabase.from('notifications').select('*').order('created_at',{ascending:false}).limit(30);
    if (adminUser.role!=='super_admin'&&adminUser.departmentAccess?.length>0) q=q.in('department',adminUser.departmentAccess);
    const {data}=await q; setNotifs(data||[]);
  },[adminUser]);

  useEffect(()=>{ load(); },[load]);
  useEffect(()=>{
    const ch=supabase.channel('notif-ch').on('postgres_changes',{event:'INSERT',schema:'public',table:'notifications'},()=>load()).subscribe();
    return ()=>{ supabase.removeChannel(ch); };
  },[load]);

  const markRead=async id=>{ await supabase.from('notifications').update({is_read:true}).eq('id',id); setNotifs(p=>p.map(n=>n.id===id?{...n,is_read:true}:n)); };
  const markAll=async()=>{ const ids=notifs.filter(n=>!n.is_read).map(n=>n.id); if(!ids.length) return; await supabase.from('notifications').update({is_read:true}).in('id',ids); setNotifs(p=>p.map(n=>({...n,is_read:true}))); };

  return (
    <div className="relative">
      <button onClick={()=>setOpen(o=>!o)} className="relative border border-gray-200 text-gray-500 hover:text-gray-800 hover:border-gray-300 px-3 py-2 rounded-xl transition-colors">
        🔔{unread>0&&<span className="absolute -top-1 -right-1 bg-red-500 text-white text-xs font-black w-4 h-4 rounded-full flex items-center justify-center">{unread>9?"9+":unread}</span>}
      </button>
      {open&&(
        <div className="absolute right-0 top-12 w-80 bg-white border border-gray-100 rounded-3xl shadow-2xl z-50 overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
            <span className="font-black text-gray-900 text-sm">Notifications</span>
            {unread>0&&<button onClick={markAll} className="text-xs text-brand-600 font-semibold hover:underline">Mark all read</button>}
          </div>
          <div className="max-h-80 overflow-y-auto divide-y divide-gray-50">
            {notifs.length===0?<div className="py-8 text-center text-gray-400 text-sm">No notifications</div>
              :notifs.map(n=>(
                <div key={n.id} onClick={()=>markRead(n.id)} className={`px-5 py-3.5 cursor-pointer hover:bg-gray-50 transition-colors ${!n.is_read?"bg-brand-50/40":""}`}>
                  <div className="flex items-start gap-3">
                    <span className="text-lg shrink-0">{n.type==="day-off"?"📅":n.type==="incomplete"?"⏱️":n.type==="late"?"⏰":"ℹ"}</span>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-semibold text-gray-800">{n.title}</div>
                      <div className="text-xs text-gray-500 mt-0.5">{n.message}</div>
                      <div className="text-xs text-gray-300 mt-1">{new Date(n.created_at).toLocaleString("en-PH")}</div>
                    </div>
                    {!n.is_read&&<div className="w-2 h-2 bg-brand-500 rounded-full shrink-0 mt-1.5"/>}
                  </div>
                </div>
              ))
            }
          </div>
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// ADMIN DASHBOARD
// ════════════════════════════════════════════════════════════════════════════
function AdminDashboard({ employees, allAttendance, leaves, onCardClick, activeDept, activeRole, quietRefresh, addToast }) {
  const TODAY=getToday();
  const [dateFrom,setFrom]=useState(TODAY);
  const [dateTo,setTo]=useState(TODAY);
  const [activePreset,setActivePreset]=useState("Today"); // which range button is highlighted (null = custom)
  const [tableFilter,setTableFilter]=useState("all"); // status filter for the live table
  const isToday=dateFrom===TODAY&&dateTo===TODAY;

  const PRESETS=[
    {l:"Today",f:TODAY,t:TODAY},
    {l:"This Week",f:(()=>{const d=new Date();d.setDate(d.getDate()-((d.getDay()+6)%7));return localDateStr(d);})(),t:TODAY},
    {l:"Last 7d",f:daysAgoStr(6),t:TODAY},
    {l:"Last 14d",f:daysAgoStr(13),t:TODAY},
  ];

  const active=useMemo(()=>employees.filter(e=>e.status==="active"&&deptMatch(activeDept,e.department)&&(!activeRole||activeRole==="all"||(e.role||"Staff")===activeRole)),[employees,activeDept,activeRole]);

  const stats=useMemo(()=>{
    const days=Object.keys(allAttendance).filter(d=>d>=dateFrom&&d<=dateTo).sort();
    let tp=0,tl=0,ta=0,tdo=0,otRangeMins=0,tlv=0,tsu=0,thd=0;
    const dailyData=days.map(date=>{
      const dr=allAttendance[date]||{}; let p=0,l=0,a=0,off=0,lv=0,su=0,hd=0,ot=0;
      const isToday=date===TODAY;
      // If a PAST date has no records at all, treat it as a non-operating day (don't mark everyone absent).
      const hasAnyRecord=Object.keys(dr).length>0;
      active.forEach(emp=>{
        const rec=dr[emp.id]||{date};
        const s=computeDisplayStatus(emp,rec,isToday,isOnLeave(leaves,emp.id,date));
        if (s==="day-off") off++;
        else if (s==="absent") { if(isToday||hasAnyRecord) a++; } // skip absent on empty past days
        else if (s==="on-leave") lv++;
        else if (s==="suspended") su++;
        else if (s==="halfday-leave") hd++;
        else if (s==="upcoming"||s==="rest-day"||s==="n/a") {} // not counted
        else { p++; if (s==="late") l++; } // present/working/late/incomplete = showed up; late also tallied
        ot += liveOvertimeMins(emp, rec);
      });
      tp+=p;tl+=l;ta+=a;tdo+=off;tlv+=lv;tsu+=su;thd+=hd;otRangeMins+=ot;
      return {date,present:p,late:l,absent:a,dayOff:off,onLeave:lv,suspended:su,halfDay:hd,otMins:ot,total:active.length};
    });
    const todayRec=allAttendance[TODAY]||{};
    const otTodayMins=active.reduce((s,emp)=>s+liveOvertimeMins(emp,todayRec[emp.id]),0);
    const todayStatuses=active.map(emp=>computeDisplayStatus(emp,todayRec[emp.id],true,isOnLeave(leaves,emp.id,TODAY)));
    // Present = anyone who has clocked in today. Must match the range stats and the Reports
    // page: present/working/late plus the in-between outcomes (incomplete/half-day/undertime)
    // all count as "showed up" — otherwise the cards disagree with the report totals.
    const tdP=todayStatuses.filter(s=>s==="present"||s==="working"||s==="late"||s==="incomplete"||s==="half-day"||s==="undertime").length;
    const tdL=todayStatuses.filter(s=>s==="late").length;   // late is also shown separately
    const tdSuspended=todayStatuses.filter(s=>s==="suspended").length;
    const tdHalfDay=todayStatuses.filter(s=>s==="halfday-leave").length;
    const tdA=todayStatuses.filter(s=>s==="absent").length;
    const tdU=todayStatuses.filter(s=>s==="upcoming").length;
    const tdW=active.filter(emp=>{const r=todayRec[emp.id];return r&&r.timeIn&&!r.timeOut&&!r.isDayOffScan;}).length;
    const tdClockedOut=active.filter(emp=>{const r=todayRec[emp.id];return r&&r.timeIn&&r.timeOut&&!r.isDayOffScan;}).length; // finished working today
    const tdRest=todayStatuses.filter(s=>s==="rest-day").length;
    const tdLeave=todayStatuses.filter(s=>s==="on-leave").length;
    const total=active.length;
    // Expected today excludes rest-day, on-leave, suspended, and half-day-leave — none of
    // them are expected to show up for a normal full shift.
    const manpower=total-tdRest-tdLeave-tdSuspended-tdHalfDay;
    const tr=days.length*total||1;
    return {tp,tl,ta,tdo,tlv,tsu,thd,dailyData,days,tdP,tdL,tdA,tdU,tdW,tdClockedOut,tdRest,tdLeave,tdSuspended,tdHalfDay,total,manpower,otTodayMins,otRangeMins,presentPct:Math.round((tp/tr)*100),latePct:Math.round((tl/tr)*100),absentPct:Math.round((ta/tr)*100)};
  },[allAttendance,active,dateFrom,dateTo,TODAY,leaves]);

  const todayRec=allAttendance[TODAY]||{};
  // Attendance rate = those present out of expected (present/late + absent). Excludes upcoming & rest-day.
  const expectedToday=stats.tdP+stats.tdA;
  const rate=expectedToday>0?Math.round((stats.tdP/expectedToday)*100):0;

  // Export a per-day summary (date, totals, overtime) for the selected range as CSV.
  const exportSummary=()=>{
    const head="Date,Present,Late,Absent,Day Off,On Leave,Overtime (min),Total Workforce";
    const body=stats.dailyData.map(d=>`${d.date},${d.present},${d.late},${d.absent},${d.dayOff},${d.onLeave},${d.otMins},${d.total}`);
    const totalRow=`TOTAL,${stats.tp},${stats.tl},${stats.ta},${stats.tdo},${stats.tlv},${stats.otRangeMins},`;
    const csv=[head,...body,totalRow].join("\n");
    const blob=new Blob([csv],{type:"text/csv"});
    const a=Object.assign(document.createElement("a"),{href:URL.createObjectURL(blob),download:`attendance_summary_${dateFrom}_to_${dateTo}.csv`});
    a.click(); URL.revokeObjectURL(a.href);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-black text-gray-900">Dashboard</h1>
          <p className="text-sm text-gray-500 mt-0.5">{new Date().toLocaleDateString("en-PH",{weekday:"long",year:"numeric",month:"long",day:"numeric"})}{deptLabel(activeDept)?` — ${deptLabel(activeDept)}`:""}</p>
          {isToday&&<p className="text-xs text-gray-400 mt-1">Manpower today: <span className="font-bold text-gray-700">{stats.manpower}</span> expected{stats.tdRest>0?` · ${stats.tdRest} on rest day`:""}{stats.tdLeave>0?` · ${stats.tdLeave} on leave`:""}</p>}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={async()=>{await quietRefresh?.();}} className="px-3 py-1.5 rounded-xl text-xs font-semibold border bg-white text-slate-700 border-gray-200 hover:border-slate-400">↻ Refresh</button>
          <button onClick={exportSummary} className="px-3 py-1.5 rounded-xl text-xs font-semibold border bg-emerald-600 text-white border-emerald-600 hover:bg-emerald-500">↓ Export Summary</button>
          {PRESETS.map(({l,f,t})=>(
            <button key={l} onClick={()=>{setFrom(f);setTo(t);setActivePreset(l);}} className={`px-3 py-1.5 rounded-xl text-xs font-semibold border transition-colors ${activePreset===l?"bg-brand-500 text-white border-brand-500":"bg-white text-gray-600 border-gray-200 hover:border-slate-400"}`}>{l}</button>
          ))}
          <input type="date" value={dateFrom} max={dateTo} onChange={e=>{setFrom(e.target.value);setActivePreset(null);}} className="border border-gray-200 rounded-xl px-3 py-1.5 text-xs cursor-pointer focus:outline-none"/>
          <span className="text-gray-400 text-xs">to</span>
          <input type="date" value={dateTo} min={dateFrom} max={TODAY} onChange={e=>{setTo(e.target.value);setActivePreset(null);}} className="border border-gray-200 rounded-xl px-3 py-1.5 text-xs cursor-pointer focus:outline-none"/>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-6 gap-4">
        {[
          {l:"Present",v:isToday?stats.tdP:stats.tp,pct:isToday?Math.round((stats.tdP/Math.max(stats.manpower,1))*100):stats.presentPct,c:"bg-emerald-50 border-emerald-100 hover:border-emerald-300",i:"🟢",s:"present",sub:isToday&&stats.tdW>0?`${stats.tdW} still working`:null},
          ...(isToday?[{l:"Clocked Out",v:stats.tdClockedOut,pct:Math.round((stats.tdClockedOut/Math.max(stats.manpower,1))*100),c:"bg-slate-50 border-slate-200 hover:border-slate-300",i:"🏁",s:"present"}]:[]),
          {l:"Late",   v:isToday?stats.tdL:stats.tl,pct:isToday?Math.round((stats.tdL/Math.max(stats.manpower,1))*100):stats.latePct,  c:"bg-amber-50 border-amber-100 hover:border-amber-300",  i:"⏰",s:"late"},
          {l:"Absent", v:isToday?stats.tdA:stats.ta,pct:isToday?Math.round((stats.tdA/Math.max(stats.manpower,1))*100):stats.absentPct,c:"bg-red-50 border-red-100 hover:border-red-300",        i:"❌",s:"absent"},
          isToday
            ? {l:"Upcoming",v:stats.tdU,pct:Math.round((stats.tdU/Math.max(stats.manpower,1))*100),c:"bg-sky-50 border-sky-100 hover:border-sky-300",i:"🕒",s:"upcoming"}
            : {l:"Day Off Scans",v:stats.tdo,pct:null,c:"bg-purple-50 border-purple-100 hover:border-purple-300",i:"📅",s:"day-off"},
          {l:"On Leave",v:isToday?stats.tdLeave:stats.tlv,pct:null,c:"bg-brand-50 border-brand-100 hover:border-brand-300",i:"🌴",s:"on-leave"},
          {l:"Suspended",v:isToday?stats.tdSuspended:stats.tsu,pct:null,c:"bg-rose-50 border-rose-100 hover:border-rose-300",i:"🚫",s:"suspended"},
          {l:"Half Day",v:isToday?stats.tdHalfDay:stats.thd,pct:null,c:"bg-brand-50 border-brand-100 hover:border-brand-300",i:"🌗",s:"halfday-leave"},
        ].map(({l,v,pct,c,i,s,sub})=>(
          <button key={l} onClick={()=>onCardClick?.(s,dateFrom,dateTo)} className={`group text-left rounded-2xl p-5 border ${c} transition-colors active:scale-[0.98]`}>
            <div className="flex items-center justify-between mb-2"><span className="text-xs font-bold uppercase tracking-widest opacity-50">{l}</span><span className="text-lg">{i}</span></div>
            <div className="text-4xl font-black text-gray-900">{v}</div>
            {pct!==null&&<div className="text-xs font-semibold text-gray-500 mt-1">{pct}% of manpower</div>}
            {sub&&<div className="text-xs font-semibold text-teal-600 mt-0.5">{sub}</div>}
            {!isToday&&<div className="text-xs text-gray-300 mt-0.5">over {stats.days.length} day(s)</div>}
          </button>
        ))}
      </div>

      <div className="bg-gradient-to-r from-brand-600 to-brand-700 rounded-3xl p-6 text-white flex items-center justify-between shadow-sm">
        <div>
          <div className="text-xs font-bold uppercase tracking-widest text-white/60">Total Overtime {isToday?"Today":"(range)"}</div>
          <div className="text-4xl font-black mt-1">{fmtHrs(isToday?stats.otTodayMins:stats.otRangeMins)}</div>
          <div className="text-xs text-white/50 mt-1">Counted in 30-min blocks past each shift end</div>
        </div>
        <div className="text-5xl">⏱️</div>
      </div>

      <div className="bg-white rounded-3xl p-6 border border-gray-100 shadow-sm">
        <div className="flex justify-between items-center mb-3">
          <h2 className="font-bold text-gray-800">Attendance Rate — {isToday?"Today":fmtDate(dateFrom)+(dateFrom!==dateTo?" → "+fmtDate(dateTo):"")}</h2>
          <span className="text-3xl font-black text-gray-900">{isToday?rate:Math.round((stats.tp/Math.max(stats.tp+stats.ta,1))*100)}%</span>
        </div>
        <div className="h-4 bg-gray-100 rounded-full overflow-hidden flex">
          <div className="bg-emerald-400 transition-all duration-500" style={{width:`${isToday&&stats.total>0?(stats.tdP/stats.total)*100:(stats.tp/Math.max(stats.total*stats.days.length||1,1))*100}%`}}/>
          <div className="bg-red-300 transition-all duration-500"     style={{width:`${isToday&&stats.total>0?(stats.tdA/stats.total)*100:(stats.ta/Math.max(stats.total*stats.days.length||1,1))*100}%`}}/>
        </div>
        <div className="flex gap-5 mt-3 text-xs text-gray-500">
          <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-emerald-400 inline-block"/>Present ({isToday?stats.tdP:stats.tp})</span>
          <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-amber-400 inline-block"/>of which Late ({isToday?stats.tdL:stats.tl})</span>
          <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-red-300 inline-block"/>Absent ({isToday?stats.tdA:stats.ta})</span>
        </div>
      </div>

      {!isToday&&stats.dailyData.length>0&&(
        <div className="bg-white rounded-3xl p-6 border border-gray-100 shadow-sm">
          <h2 className="font-bold text-gray-800 mb-5">Daily Trend</h2>
          <div className="flex items-end gap-1.5 h-32 overflow-x-auto pb-2">
            {stats.dailyData.map(({date,present,late,absent,total})=>(
              <div key={date} className="flex flex-col items-center gap-1 shrink-0" style={{minWidth:32}}>
                <div className="flex flex-col justify-end w-full" style={{height:96}}>
                  {total>0&&<><div className="w-full bg-red-200 rounded-t" style={{height:`${(absent/total)*96}px`}}/>
                  <div className="w-full bg-amber-300" style={{height:`${(late/total)*96}px`}}/>
                  <div className="w-full bg-emerald-400 rounded-b" style={{height:`${(present/total)*96}px`}}/></>}
                </div>
                <div className="text-[9px] text-gray-400 whitespace-nowrap">{new Date(date+"T00:00:00").toLocaleDateString("en-PH",{month:"numeric",day:"numeric"})}</div>
              </div>
            ))}
          </div>
          <div className="flex gap-4 mt-2 text-xs text-gray-500">
            {[["bg-emerald-400","Present"],["bg-amber-300","Late"],["bg-red-200","Absent"]].map(([c,l])=>(
              <span key={l} className="flex items-center gap-1.5"><span className={`w-2.5 h-2.5 rounded-full ${c} inline-block`}/>{l}</span>
            ))}
          </div>
        </div>
      )}

      <div className="grid md:grid-cols-3 gap-5">
        {[
          {title:"⚠ Over Break",   border:"border-orange-200",list:active.filter(e=>liveOverBreakMinutes(e,todayRec[e.id])>0),  render:e=><span className="text-orange-500 font-bold text-xs">+{liveOverBreakMinutes(e,todayRec[e.id])}m</span>,empty:"No violations today"},
          {title:"⏰ Late Arrivals",border:"border-amber-200", list:active.filter(e=>computeDisplayStatus(e,todayRec[e.id],true,isOnLeave(leaves,e.id,TODAY))==="late"), render:e=><span className="text-amber-500 font-bold text-xs">+{liveLateMinutes(e,todayRec[e.id])}m</span>,   empty:"No late arrivals"},
          {title:"❌ Absent",       border:"border-red-200",   list:active.filter(e=>computeDisplayStatus(e,todayRec[e.id],true,isOnLeave(leaves,e.id,TODAY))==="absent"),render:e=><span className="text-xs text-gray-400">{e.department}</span>,empty:"No absences yet"},
        ].map(({title,border,list,render,empty})=>(
          <div key={title} className={`bg-white rounded-3xl p-5 border shadow-sm ${list.length>0?border:"border-gray-100"}`}>
            <div className="font-bold text-sm text-gray-700 mb-3">{title} <span className="opacity-40">({list.length})</span></div>
            {list.length===0?<p className="text-xs text-gray-400">{empty}</p>
              :list.map(e=>(
                <div key={e.id} className="flex justify-between items-center py-2 border-b border-gray-50 last:border-0">
                  <div><div className="text-sm font-medium text-gray-800 truncate max-w-[110px]">{e.name}</div><div className="text-xs text-gray-400">{e.position}</div></div>
                  {render(e)}
                </div>
              ))
            }
          </div>
        ))}
      </div>

      <div className="bg-white rounded-3xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between gap-3 flex-wrap">
          <h2 className="font-bold text-gray-800">Live Attendance — Today</h2>
          <select value={tableFilter} onChange={e=>setTableFilter(e.target.value)} className="border border-gray-200 rounded-xl px-3 py-2 text-xs font-semibold focus:outline-none bg-gray-50 cursor-pointer">
            <option value="all">All Statuses</option>
            <option value="present">Present</option>
            <option value="working">Working</option>
            <option value="late">Late</option>
            <option value="absent">Absent</option>
            <option value="upcoming">Upcoming</option>
            <option value="rest-day">Rest Day</option>
            <option value="on-leave">On Leave</option>
            <option value="suspended">Suspended</option>
            <option value="halfday-leave">Half Day</option>
            <option value="day-off">Day Off Scan</option>
          </select>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-gray-100 bg-gray-50/60">
              {["Employee","Shift","Time In","Break","Time Out","Late","Over Break","Status"].map(h=><th key={h} className="text-left text-xs font-semibold text-gray-400 uppercase tracking-wider px-5 py-3">{h}</th>)}
            </tr></thead>
            <tbody className="divide-y divide-gray-50">
              {(()=>{
                // Sort Z–A by name, then apply status filter
                const sorted=[...active].sort((a,b)=>b.name.localeCompare(a.name));
                const visible=sorted.filter(emp=>tableFilter==="all"||computeDisplayStatus(emp,todayRec[emp.id],true,isOnLeave(leaves,emp.id,TODAY))===tableFilter);
                if (visible.length===0) return <tr><td colSpan={8} className="text-center py-10 text-gray-400 text-sm">No employees match this filter</td></tr>;
                return visible.map(emp=>{ const rec=todayRec[emp.id]; return (
                  <tr key={emp.id} className="hover:bg-gray-50/60 transition-colors">
                    <td className="px-5 py-3.5"><div className="font-semibold text-gray-800 text-sm">{emp.name}</div><div className="text-xs text-gray-400">{emp.department}</div></td>
                    <td className="px-5 py-3.5 text-xs text-gray-500 font-mono whitespace-nowrap">{fmt(emp.schedule.shiftStart)}–{fmt(emp.schedule.shiftEnd)}</td>
                    <td className="px-5 py-3.5 font-mono text-xs text-gray-600 whitespace-nowrap">{rec?.timeIn?fmt(rec.timeIn):"—"}</td>
                    <td className="px-5 py-3.5 text-xs text-gray-600 whitespace-nowrap">
                      {(()=>{
                        const s={...emp.schedule,...(rec?.scheduleOverride||{})};
                        const cl=numOr(s.coffeeBreak,15), ll=numOr(s.lunchBreak,60);
                        const bo=liveBreakOver(emp,rec); // live per-break overage, matches the Over Break column
                        const glyph=(start,end)=>{ if(!end) return '☕'; return classifyBreakDur(toMins(end)-toMins(start),cl,ll)==='coffee'?'☕':'🍽️'; };
                        return <>
                          {rec?.coffeeStart?<div>{glyph(rec.coffeeStart,rec.coffeeEnd)} {fmt(rec.coffeeStart)}–{rec.coffeeEnd?fmt(rec.coffeeEnd):"?"}{bo.coffee>0&&<span className="text-orange-600 font-bold"> +{bo.coffee}m</span>}</div>:null}
                          {rec?.lunchStart?<div>{glyph(rec.lunchStart,rec.lunchEnd)} {fmt(rec.lunchStart)}–{rec.lunchEnd?fmt(rec.lunchEnd):"?"}{bo.lunch>0&&<span className="text-orange-600 font-bold"> +{bo.lunch}m</span>}</div>:null}
                          {!rec?.coffeeStart&&!rec?.lunchStart&&"—"}
                        </>;
                      })()}
                    </td>
                    <td className="px-5 py-3.5 font-mono text-xs text-gray-600 whitespace-nowrap">{rec?.timeOut?fmt(rec.timeOut):"—"}</td>
                    <td className="px-5 py-3.5">{liveLateMinutes(emp,rec)>0?<span className="text-amber-600 font-bold text-xs">{liveLateMinutes(emp,rec)}m</span>:<span className="text-gray-200 text-xs">—</span>}</td>
                    <td className="px-5 py-3.5">{liveOverBreakMinutes(emp,rec)>0?<span className="text-orange-600 font-bold text-xs">{liveOverBreakMinutes(emp,rec)}m</span>:<span className="text-gray-200 text-xs">—</span>}</td>
                    <td className="px-5 py-3.5"><Badge status={computeDisplayStatus(emp,rec,true,isOnLeave(leaves,emp.id,TODAY))}/></td>
                  </tr>
                );});
              })()}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// ADMIN EMPLOYEES
// ════════════════════════════════════════════════════════════════════════════
function AdminEmployees({ employees, setEmployees, addToast, onBulkImport, activeDept, activeRole, roles:managedRoles, adminUser }) {
  const [search,setSearch]=useState(""); const [deptFilter,setDept]=useState("all"); const [roleFilter,setRoleFilter]=useState("all"); const [statusFilter,setStF]=useState("all");
  const [modal,setModal]=useState(false); const [selected,setSelected]=useState(null); const [tab,setTab]=useState("info");
  const [form,setForm]=useState({id:"",name:"",position:"",department:"",role:"Staff",contact:"",qrCode:"",rfidUid:"",faceDescriptors:[],status:"active",empType:"Regular",monthlyRate:0,allowance:0,sssNo:"",philhealthNo:"",pagibigNo:"",tinNo:"",bankName:"",bankAccount:"",schedule:{...DEFAULT_SCHEDULE}});
  const [schedForm,setSchedForm]=useState({...DEFAULT_SCHEDULE});
  const [confirmDeact,setConfirmDeact]=useState(null); const [confirmDelete,setConfirmDelete]=useState(null);
  const [selIds,setSelIds]=useState([]); const [confirmBulkDel,setConfirmBulkDel]=useState(false); // bulk delete
  const [openMenu,setOpenMenu]=useState(null); // employee id whose action menu is open
  const [qrModal,setQrModal]=useState(false); const [qrSel,setQrSel]=useState([]);
  // HR document generator (COE / NTE / Contract)
  const [docEmp,setDocEmp]=useState(null);
  const [docForm,setDocForm]=useState({type:'coe',purpose:'',incidentDate:'',details:'',signatory:'',signatoryTitle:'HR Manager'});
  const [docCompany,setDocCompany]=useState('');
  const openDocs=async emp=>{ setDocEmp(emp); if(!docCompany&&adminUser?.tenantId){ const {data}=await supabase.from('registrations').select('company').eq('id',adminUser.tenantId).maybeSingle(); setDocCompany(data?.company||''); } };
  const printDoc=()=>{ printDocument(docForm.type, docEmp, docCompany, docForm); logAudit(adminUser,'document_generated',docEmp.name,docForm.type.toUpperCase()); };
  // Employee portal login management
  const [portalEmp,setPortalEmp]=useState(null); const [portalAcc,setPortalAcc]=useState(null);
  const [portalForm,setPortalForm]=useState({email:"",password:""}); const [portalBusy,setPortalBusy]=useState(false);
  const openPortal=async emp=>{
    setPortalEmp(emp); setPortalAcc(undefined); setPortalForm({email:(emp.contact||"").includes("@")?emp.contact:"",password:""});
    const {data}=await supabase.from('admin_accounts').select('id,username,is_active').eq('employee_id',emp.id).eq('role','employee').maybeSingle();
    setPortalAcc(data||null);
  };
  const createPortal=async()=>{
    const email=portalForm.email.trim().toLowerCase();
    if(!/\S+@\S+\.\S+/.test(email)){ addToast("Enter a valid email.","error"); return; }
    if(portalForm.password.length<6){ addToast("Password must be at least 6 characters.","error"); return; }
    setPortalBusy(true);
    const {data:taken}=await supabase.from('admin_accounts').select('id').eq('username',email).maybeSingle();
    if(taken){ addToast("That email already has an account.","error"); setPortalBusy(false); return; }
    const {error}=await supabase.from('admin_accounts').insert({username:email,password_hash:btoa(portalForm.password),role:'employee',employee_id:portalEmp.id,tenant_id:adminUser.tenantId||null,is_active:true,must_change_password:false});
    setPortalBusy(false);
    if(error){ addToast("Failed: "+error.message,"error"); return; }
    await logAudit(adminUser,'portal_account_created',portalEmp.name,email);
    addToast(`Portal login created for ${portalEmp.name}.`,"success");
    openPortal(portalEmp);
  };
  const resetPortalPw=async()=>{
    if(portalForm.password.length<6){ addToast("New password must be at least 6 characters.","error"); return; }
    setPortalBusy(true);
    await supabase.from('admin_accounts').update({password_hash:btoa(portalForm.password)}).eq('id',portalAcc.id);
    setPortalBusy(false); addToast("Password updated.","success"); setPortalForm(f=>({...f,password:""}));
  };
  const togglePortal=async()=>{
    await supabase.from('admin_accounts').update({is_active:!portalAcc.is_active}).eq('id',portalAcc.id);
    addToast(portalAcc.is_active?"Portal login disabled.":"Portal login enabled.","info"); openPortal(portalEmp);
  };

  useEffect(()=>{ if(typeof activeDept==="string"&&activeDept!=="all") setDept(activeDept); },[activeDept]);

  const departments=[...new Set(employees.map(e=>e.department))];
  const roles=managedRoles?.length?managedRoles:[...new Set(employees.map(e=>e.role||"Staff"))];
  const filtered=employees.filter(e=>{
    const mq=e.name.toLowerCase().includes(search.toLowerCase())||e.id.toLowerCase().includes(search.toLowerCase())||e.department.toLowerCase().includes(search.toLowerCase());
    return mq&&deptMatch(activeDept,e.department)&&(deptFilter==="all"||e.department===deptFilter)&&(!activeRole||activeRole==="all"||(e.role||"Staff")===activeRole)&&(roleFilter==="all"||(e.role||"Staff")===roleFilter)&&(statusFilter==="all"||e.status===statusFilter);
  });

  const openAdd=()=>{setForm({id:`EMP${String(employees.length+1).padStart(3,"0")}`,name:"",position:"",department:(typeof activeDept==="string"&&activeDept!=="all")?activeDept:"",role:"Staff",contact:"",qrCode:"",rfidUid:"",faceDescriptors:[],status:"active",empType:"Regular",monthlyRate:0,allowance:0,sssNo:"",philhealthNo:"",pagibigNo:"",tinNo:"",bankName:"",bankAccount:"",schedule:{...DEFAULT_SCHEDULE}});setTab("info");setModal("add");};
  const openEdit=emp=>{setSelected(emp);setForm({...emp,schedule:{...emp.schedule}});setTab("info");setModal("edit");};
  const openSchedule=emp=>{setSelected(emp);setSchedForm({...emp.schedule});setModal("schedule");};
  const openQR=emp=>{setSelected(emp);setModal("qr");};
  // Export the currently-listed employees in the SAME column format the importer accepts,
  // so you can export → edit in Excel → re-import. Respects the active search/dept/status filters.
  const exportEmployees=()=>{
    if (!filtered.length){ addToast("No employees to export.","warning"); return; }
    const head="id,name,position,department,role,contact,qrCode,status,empType,shiftStart,shiftEnd,gracePeriod,coffeeBreak,lunchBreak,restDays";
    const esc=v=>{const s=String(v??"");return /[",\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s;};
    const rows=filtered.map(e=>{const s=e.schedule||{};return [e.id,e.name,e.position,e.department,e.role||"Staff",e.contact||"",e.qrCode||"",e.status,e.empType||"Regular",s.shiftStart||"",s.shiftEnd||"",numOr(s.gracePeriod,""),numOr(s.coffeeBreak,""),numOr(s.lunchBreak,""),Array.isArray(s.restDays)?s.restDays.join(","):""].map(esc).join(",");});
    const blob=new Blob([[head,...rows].join("\n")],{type:"text/csv"});
    const a=Object.assign(document.createElement("a"),{href:URL.createObjectURL(blob),download:`employees_${getToday()}.csv`});
    a.click(); URL.revokeObjectURL(a.href); addToast(`Exported ${filtered.length} employee(s).`,"success");
  };
  const closeModal=()=>{setModal(false);setSelected(null);};

  const saveEmployee=()=>{
    if (!form.name||!form.position||!form.department){addToast("Fill in all required fields.","error");return;}
    const clean={...form,schedule:sanitizeSchedule(form.schedule||{})};
    if (modal==="edit"){setEmployees(p=>p.map(e=>e.id===form.id?clean:e));addToast(`${form.name} updated.`,"success");}
    else{ if(employees.find(e=>e.id===form.id)){addToast("Employee ID already exists.","error");return;} setEmployees(p=>[...p,clean]);addToast(`${form.name} added.`,"success"); }
    setModal(false);
  };
  const saveSchedule=()=>{setEmployees(p=>p.map(e=>e.id===selected.id?{...e,schedule:sanitizeSchedule(schedForm)}:e));addToast(`Schedule updated for ${selected.name}.`,"success");setModal(false);};
  const doDeactivate=()=>{const emp=confirmDeact;setEmployees(p=>p.map(e=>e.id===emp.id?{...e,status:e.status==="active"?"inactive":"active"}:e));addToast(`${emp.name} ${emp.status==="active"?"deactivated":"reactivated"}.`,"info");setConfirmDeact(null);};
  const doDelete=async()=>{const emp=confirmDelete;setConfirmDelete(null);const{error}=await supabase.from('employees').delete().eq('id',emp.id);if(error){addToast("Delete failed: "+error.message,"error");return;}await logAudit(adminUser,"employee_deleted",emp.name,`Deleted ${emp.id} (${emp.department})`);setEmployees(p=>p.filter(e=>e.id!==emp.id));addToast(`${emp.name} deleted.`,"info");};
  const toggleSel=id=>setSelIds(p=>p.includes(id)?p.filter(x=>x!==id):[...p,id]);
  const allOnPageSelected=filtered.length>0&&filtered.every(e=>selIds.includes(e.id));
  const toggleSelAll=()=>setSelIds(allOnPageSelected?[]:filtered.map(e=>e.id));
  const doBulkDelete=async()=>{
    const ids=[...selIds]; setConfirmBulkDel(false);
    const{error}=await supabase.from('employees').delete().in('id',ids);
    if(error){addToast("Bulk delete failed: "+error.message,"error");return;}
    await logAudit(adminUser,"employees_bulk_deleted",`${ids.length} employees`,`Deleted IDs: ${ids.join(", ")}`);
    setEmployees(p=>p.filter(e=>!ids.includes(e.id))); setSelIds([]);
    addToast(`${ids.length} employee(s) deleted.`,"info");
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div><h1 className="text-2xl font-black text-gray-900">Employees</h1><p className="text-sm text-gray-500 mt-0.5">{employees.filter(e=>e.status==="active").length} active · {employees.filter(e=>e.status==="inactive").length} inactive</p></div>
        <div className="flex gap-2">
          <button onClick={()=>{setQrSel(filtered.map(e=>e.id));setQrModal(true);}} className="bg-blue-700 text-white text-sm font-bold px-5 py-2.5 rounded-xl hover:bg-blue-600 active:scale-95">🖨 Print QR (A4)</button>
          <button onClick={exportEmployees} className="bg-emerald-600 text-white text-sm font-bold px-5 py-2.5 rounded-xl hover:bg-emerald-500 active:scale-95">↓ Export CSV</button>
          <button onClick={onBulkImport} className="bg-emerald-700 text-white text-sm font-bold px-5 py-2.5 rounded-xl hover:bg-emerald-600 active:scale-95">↑ Import CSV/Excel</button>
          <button onClick={openAdd} className="bg-brand-500 text-white text-sm font-bold px-5 py-2.5 rounded-xl hover:bg-brand-600 active:scale-95">+ Add Employee</button>
        </div>
      </div>
      <div className="flex gap-3 flex-wrap">
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search name, ID, department…" className="flex-1 min-w-[200px] border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none bg-gray-50"/>
        <select value={deptFilter} onChange={e=>setDept(e.target.value)} className="border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none bg-gray-50 cursor-pointer">
          <option value="all">All Departments</option>{departments.map(d=><option key={d} value={d}>{d}</option>)}
        </select>
        <select value={roleFilter} onChange={e=>setRoleFilter(e.target.value)} className="border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none bg-gray-50 cursor-pointer">
          <option value="all">All Roles</option>{roles.map(r=><option key={r} value={r}>{r}</option>)}
        </select>
        <select value={statusFilter} onChange={e=>setStF(e.target.value)} className="border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none bg-gray-50 cursor-pointer">
          <option value="all">All Status</option><option value="active">Active</option><option value="inactive">Inactive</option>
        </select>
      </div>
      {selIds.length>0&&(
        <div className="flex items-center justify-between bg-red-50 border border-red-200 rounded-2xl px-5 py-3">
          <span className="text-sm font-semibold text-red-700">{selIds.length} selected</span>
          <div className="flex gap-2">
            <button onClick={()=>setSelIds([])} className="text-xs font-semibold text-gray-500 px-3 py-1.5 rounded-lg hover:bg-white">Clear</button>
            <button onClick={()=>setConfirmBulkDel(true)} className="bg-red-600 text-white text-xs font-bold px-4 py-1.5 rounded-lg hover:bg-red-700 active:scale-95">🗑 Delete Selected ({selIds.length})</button>
          </div>
        </div>
      )}
      <div className="bg-white rounded-3xl border border-gray-100 shadow-sm overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-gray-100 bg-gray-50/60">
            <th className="px-4 py-3.5 w-10"><input type="checkbox" checked={allOnPageSelected} onChange={toggleSelAll} className="accent-slate-700 w-4 h-4 cursor-pointer"/></th>
            {["ID","Employee","Department","Role","Shift","Status","Actions"].map(h=><th key={h} className="text-left text-xs font-semibold text-gray-400 uppercase tracking-wider px-5 py-3.5">{h}</th>)}</tr></thead>
          <tbody className="divide-y divide-gray-50">
            {filtered.length===0?<tr><td colSpan={8} className="text-center py-12 text-gray-400">No employees found</td></tr>
              :filtered.map(emp=>(
              <tr key={emp.id} className={`hover:bg-gray-50/60 transition-colors ${selIds.includes(emp.id)?"bg-red-50/40":""}`}>
                <td className="px-4 py-4"><input type="checkbox" checked={selIds.includes(emp.id)} onChange={()=>toggleSel(emp.id)} className="accent-slate-700 w-4 h-4 cursor-pointer"/></td>
                <td className="px-5 py-4 font-mono text-xs text-gray-400">{emp.id}</td>
                <td className="px-5 py-4"><div className="font-semibold text-gray-800">{emp.name}</div><div className="text-xs text-gray-400">{emp.position}</div></td>
                <td className="px-5 py-4 text-gray-600 text-sm">{emp.department}<div className="text-xs text-gray-400 mt-0.5">{emp.empType||"Regular"}</div></td>
                <td className="px-5 py-4"><span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-slate-100 text-slate-700 border border-slate-200">{emp.role||"Staff"}</span></td>
                <td className="px-5 py-4 text-xs text-gray-500 font-mono whitespace-nowrap">{fmt(emp.schedule.shiftStart)}–{fmt(emp.schedule.shiftEnd)}</td>
                <td className="px-5 py-4"><span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold border ${emp.status==="active"?"bg-emerald-50 text-emerald-700 border-emerald-200":"bg-gray-100 text-gray-500 border-gray-200"}`}>{emp.status}</span></td>
                <td className="px-5 py-4">
                  <div className="relative inline-block">
                    <button onClick={()=>setOpenMenu(openMenu===emp.id?null:emp.id)} className="px-3 py-1.5 text-sm font-bold text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg">⋯</button>
                    {openMenu===emp.id&&(
                      <>
                        <div className="fixed inset-0 z-10" onClick={()=>setOpenMenu(null)}/>
                        <div className="absolute right-0 mt-1 w-44 bg-white border border-gray-200 rounded-xl shadow-xl z-20 overflow-hidden py-1">
                          <button onClick={()=>{setOpenMenu(null);openEdit(emp);}} className="w-full text-left px-4 py-2.5 text-sm text-gray-700 hover:bg-brand-50 flex items-center gap-2.5"><Icon name="edit" className="w-4 h-4 text-gray-400"/> Edit</button>
                          <button onClick={()=>{setOpenMenu(null);openSchedule(emp);}} className="w-full text-left px-4 py-2.5 text-sm text-gray-700 hover:bg-brand-50 flex items-center gap-2.5"><Icon name="schedules" className="w-4 h-4 text-gray-400"/> Schedule</button>
                          <button onClick={()=>{setOpenMenu(null);openQR(emp);}} className="w-full text-left px-4 py-2.5 text-sm text-gray-700 hover:bg-brand-50 flex items-center gap-2.5"><Icon name="qr" className="w-4 h-4 text-gray-400"/> QR Code</button>
                          <button onClick={()=>{setOpenMenu(null);openPortal(emp);}} className="w-full text-left px-4 py-2.5 text-sm text-gray-700 hover:bg-brand-50 flex items-center gap-2.5"><Icon name="accounts" className="w-4 h-4 text-gray-400"/> Portal Login</button>
                          <button onClick={()=>{setOpenMenu(null);openDocs(emp);}} className="w-full text-left px-4 py-2.5 text-sm text-gray-700 hover:bg-brand-50 flex items-center gap-2.5"><Icon name="reports" className="w-4 h-4 text-gray-400"/> Documents</button>
                          <button onClick={()=>{setOpenMenu(null);setConfirmDeact(emp);}} className="w-full text-left px-4 py-2.5 text-sm text-gray-700 hover:bg-brand-50 flex items-center gap-2.5"><Icon name={emp.status==="active"?"pause":"play"} className="w-4 h-4 text-gray-400"/> {emp.status==="active"?"Deactivate":"Reactivate"}</button>
                          <div className="border-t border-gray-100 my-1"/>
                          <button onClick={()=>{setOpenMenu(null);setConfirmDelete(emp);}} className="w-full text-left px-4 py-2.5 text-sm font-semibold text-red-600 hover:bg-red-50 flex items-center gap-2.5"><Icon name="trash" className="w-4 h-4"/> Delete</button>
                        </div>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {(modal==="add"||modal==="edit")&&(
        <div className="fixed inset-0 bg-slate-900/25 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={closeModal}>
          <div className="bg-white rounded-3xl w-full max-w-lg shadow-2xl overflow-hidden max-h-[90vh] flex flex-col" onClick={e=>e.stopPropagation()}>
            <div className="bg-gradient-to-r from-brand-600 to-brand-700 px-7 py-5 flex items-center justify-between shrink-0">
              <h2 className="text-lg font-black text-white">{modal==="add"?"New Employee":"Edit Employee"}</h2>
              <button onClick={closeModal} className="text-white/40 hover:text-white text-2xl">×</button>
            </div>
            <div className="flex border-b border-gray-100 shrink-0">
              {[{k:"info",l:"Info"},{k:"schedule",l:"Schedule"},{k:"pay",l:"Pay"},{k:"face",l:"Face"}].map(({k,l})=>(
                <button key={k} onClick={()=>setTab(k)} className={`flex-1 py-3.5 text-sm font-semibold transition-colors ${tab===k?"text-slate-800 border-b-2 border-brand-500":"text-gray-400 hover:text-gray-600"}`}>{l}</button>
              ))}
            </div>
            <div className="p-7 overflow-y-auto flex-1">
              {tab==="info"?(
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div><label className="text-xs font-bold text-gray-500 uppercase tracking-wider block mb-1.5">Employee ID</label>
                      <input value={form.id} disabled={modal==="edit"} onChange={e=>setForm(f=>({...f,id:e.target.value}))} className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none disabled:bg-gray-50 disabled:text-gray-400 font-mono"/></div>
                    <div><label className="text-xs font-bold text-gray-500 uppercase tracking-wider block mb-1.5">Status</label>
                      <select value={form.status} onChange={e=>setForm(f=>({...f,status:e.target.value}))} className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none"><option value="active">Active</option><option value="inactive">Inactive</option></select></div>
                  </div>
                  {[{k:"name",l:"Full Name"},{k:"position",l:"Position"},{k:"department",l:"Department"},{k:"contact",l:"Contact Number"}].map(({k,l})=>(
                    <div key={k}><label className="text-xs font-bold text-gray-500 uppercase tracking-wider block mb-1.5">{l}</label>
                      <input value={form[k]} onChange={e=>setForm(f=>({...f,[k]:e.target.value}))} className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-200"/></div>
                  ))}
                  <div><label className="text-xs font-bold text-gray-500 uppercase tracking-wider block mb-1.5">Role <span className="text-gray-300 normal-case">(rank/level — separate from Position)</span></label>
                    <select value={form.role||"Staff"} onChange={e=>setForm(f=>({...f,role:e.target.value}))} className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none">
                      {roles.map(r=><option key={r} value={r}>{r}</option>)}
                    </select>
                    <p className="text-xs text-gray-400 mt-1">Manage the list of roles in Settings.</p>
                  </div>
                  <div><label className="text-xs font-bold text-gray-500 uppercase tracking-wider block mb-1.5">Badge / QR Code <span className="text-gray-300 normal-case">(optional — existing ID-card code; leave blank to use Employee ID)</span></label>
                    <input value={form.qrCode||""} onChange={e=>setForm(f=>({...f,qrCode:e.target.value}))} placeholder="Code printed on their current badge" className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-200 font-mono"/></div>
                  <div><label className="text-xs font-bold text-gray-500 uppercase tracking-wider block mb-1.5">RFID UID <span className="text-gray-300 normal-case">(optional — the tag string the RFID reader sends for this employee's card)</span></label>
                    <input value={form.rfidUid||""} onChange={e=>setForm(f=>({...f,rfidUid:e.target.value}))} placeholder="e.g. 04A1B2C3 — tap the card on the RFID kiosk to see it" className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-200 font-mono"/></div>
                  <div><label className="text-xs font-bold text-gray-500 uppercase tracking-wider block mb-1.5">Employee Type</label>
                    <select value={form.empType||"Regular"} onChange={e=>setForm(f=>({...f,empType:e.target.value}))} className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none">
                      <option value="Regular">Regular</option><option value="Freelance">Freelance</option><option value="Direct">Direct</option>
                    </select></div>
                  <div><label className="text-xs font-bold text-gray-500 uppercase tracking-wider block mb-1.5">Start Date <span className="text-gray-300 normal-case">(optional — no absences counted before this)</span></label>
                    <input type="date" value={form.startDate||""} onChange={e=>setForm(f=>({...f,startDate:e.target.value||null}))} className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-200"/></div>
                </div>
              ):tab==="face"?(
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-bold text-gray-700">Face Enrollment</div>
                    {form.faceDescriptors?.length>0&&<span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 border border-emerald-200">✓ {form.faceDescriptors.length} sample(s)</span>}
                  </div>
                  {tab==="face"&&<FaceEnroll value={form.faceDescriptors||[]} onChange={d=>setForm(f=>({...f,faceDescriptors:d}))}/>}
                </div>
              ):tab==="pay"?(
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div><label className="text-xs font-bold text-gray-500 uppercase tracking-wider block mb-1.5">Monthly Rate (₱)</label>
                      <input type="number" value={form.monthlyRate??""} onChange={e=>setForm(f=>({...f,monthlyRate:e.target.value}))} placeholder="e.g. 25000" className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-200"/></div>
                    <div><label className="text-xs font-bold text-gray-500 uppercase tracking-wider block mb-1.5">Allowance / mo (₱, non-taxable)</label>
                      <input type="number" value={form.allowance??""} onChange={e=>setForm(f=>({...f,allowance:e.target.value}))} placeholder="0" className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-200"/></div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    {[["sssNo","SSS No."],["philhealthNo","PhilHealth No."],["pagibigNo","Pag-IBIG MID No."],["tinNo","TIN"]].map(([k,l])=>(
                      <div key={k}><label className="text-xs font-bold text-gray-500 uppercase tracking-wider block mb-1.5">{l}</label>
                        <input value={form[k]||""} onChange={e=>setForm(f=>({...f,[k]:e.target.value}))} className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-200 font-mono"/></div>
                    ))}
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div><label className="text-xs font-bold text-gray-500 uppercase tracking-wider block mb-1.5">Bank</label>
                      <input value={form.bankName||""} onChange={e=>setForm(f=>({...f,bankName:e.target.value}))} placeholder="e.g. BDO" className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-200"/></div>
                    <div><label className="text-xs font-bold text-gray-500 uppercase tracking-wider block mb-1.5">Bank Account No.</label>
                      <input value={form.bankAccount||""} onChange={e=>setForm(f=>({...f,bankAccount:e.target.value}))} placeholder="For payroll deposit" className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-200 font-mono"/></div>
                  </div>
                  <p className="text-xs text-gray-400">Used by Payroll to compute pay and statutory deductions. Daily rate = monthly ÷ work days per month (see Payroll → Settings).</p>
                </div>
              ):<ScheduleForm value={form.schedule} onChange={s=>setForm(f=>({...f,schedule:s}))}/>}
            </div>
            <div className="flex gap-3 px-7 py-5 border-t border-gray-100 shrink-0">
              <button onClick={closeModal} className="flex-1 border border-gray-200 text-gray-600 text-sm font-semibold py-3 rounded-xl hover:bg-gray-50">Cancel</button>
              <button onClick={saveEmployee} className="flex-1 bg-brand-500 text-white text-sm font-bold py-3 rounded-xl hover:bg-brand-600 active:scale-[0.98]">{modal==="add"?"Add Employee":"Save Changes"}</button>
            </div>
          </div>
        </div>
      )}

      {modal==="schedule"&&selected&&(
        <div className="fixed inset-0 bg-slate-900/25 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={closeModal}>
          <div className="bg-white rounded-3xl w-full max-w-md shadow-2xl overflow-hidden max-h-[90vh] flex flex-col" onClick={e=>e.stopPropagation()}>
            <div className="bg-gradient-to-r from-brand-700 to-brand-900 px-7 py-5 flex items-center justify-between shrink-0">
              <div><h2 className="text-lg font-black text-white">Edit Schedule</h2><p className="text-brand-300 text-xs mt-0.5">{selected.name}</p></div>
              <button onClick={closeModal} className="text-white/40 hover:text-white text-2xl">×</button>
            </div>
            <div className="p-7 overflow-y-auto flex-1"><ScheduleForm value={schedForm} onChange={setSchedForm}/></div>
            <div className="flex gap-3 px-7 py-5 border-t border-gray-100 shrink-0">
              <button onClick={closeModal} className="flex-1 border border-gray-200 text-gray-600 text-sm font-semibold py-3 rounded-xl">Cancel</button>
              <button onClick={saveSchedule} className="flex-1 bg-brand-700 text-white text-sm font-bold py-3 rounded-xl hover:bg-brand-600">Save Schedule</button>
            </div>
          </div>
        </div>
      )}

      {modal==="qr"&&selected&&(
        <div className="fixed inset-0 bg-slate-900/25 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={closeModal}>
          <div className="bg-white rounded-3xl w-full max-w-sm shadow-2xl text-center overflow-hidden" onClick={e=>e.stopPropagation()}>
            <div className="bg-gradient-to-r from-blue-700 to-blue-900 px-7 py-5 flex items-center justify-between">
              <div><h2 className="text-lg font-black text-white">QR Code</h2><p className="text-blue-300 text-xs mt-0.5">{selected.name}</p></div>
              <button onClick={closeModal} className="text-white/40 hover:text-white text-2xl">×</button>
            </div>
            <div className="p-8">
              <div className="w-44 h-44 mx-auto border-4 border-gray-900 rounded-2xl overflow-hidden bg-white flex items-center justify-center"><RealQRCode value={selected.id} size={168}/></div>
              <p className="text-xs text-gray-400 mt-4">{selected.id} · {selected.department}</p>
              <button onClick={closeModal} className="mt-5 w-full border border-gray-200 text-gray-600 text-sm font-semibold py-2.5 rounded-xl hover:bg-gray-50">Close</button>
            </div>
          </div>
        </div>
      )}

      {/* HR documents modal */}
      {docEmp&&(
        <div className="fixed inset-0 bg-slate-900/25 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={()=>setDocEmp(null)}>
          <div className="bg-white rounded-3xl p-7 max-w-md w-full max-h-[88vh] overflow-y-auto shadow-2xl" onClick={e=>e.stopPropagation()}>
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-lg font-black text-ink">Generate document</h2>
              <button onClick={()=>setDocEmp(null)} className="w-9 h-9 rounded-lg hover:bg-gray-100 text-gray-400">✕</button>
            </div>
            <p className="text-sm text-gray-500 mb-4">{docEmp.name} — {docEmp.position||"—"}</p>
            <div className="space-y-3">
              <div><label className="text-xs font-bold text-gray-500 uppercase block mb-1">Document type</label>
                <select value={docForm.type} onChange={e=>setDocForm(f=>({...f,type:e.target.value}))} className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm">
                  <option value="coe">Certificate of Employment (COE)</option>
                  <option value="coe-comp">COE with Compensation</option>
                  <option value="nte">Notice to Explain (NTE)</option>
                  <option value="contract">Employment Contract</option>
                </select></div>
              {(docForm.type==='coe'||docForm.type==='coe-comp')&&(
                <div><label className="text-xs font-bold text-gray-500 uppercase block mb-1">Purpose (optional)</label>
                  <input value={docForm.purpose} onChange={e=>setDocForm(f=>({...f,purpose:e.target.value}))} placeholder="e.g. bank loan application" className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm"/></div>
              )}
              {docForm.type==='nte'&&<>
                <div><label className="text-xs font-bold text-gray-500 uppercase block mb-1">Incident date</label>
                  <input type="date" value={docForm.incidentDate} onChange={e=>setDocForm(f=>({...f,incidentDate:e.target.value}))} className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm"/></div>
                <div><label className="text-xs font-bold text-gray-500 uppercase block mb-1">Incident details</label>
                  <textarea rows={3} value={docForm.details} onChange={e=>setDocForm(f=>({...f,details:e.target.value}))} placeholder="Describe the incident / alleged violation" className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm"/></div>
              </>}
              <div className="grid grid-cols-2 gap-3">
                <div><label className="text-xs font-bold text-gray-500 uppercase block mb-1">Signatory name</label>
                  <input value={docForm.signatory} onChange={e=>setDocForm(f=>({...f,signatory:e.target.value}))} placeholder="e.g. Maria Santos" className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm"/></div>
                <div><label className="text-xs font-bold text-gray-500 uppercase block mb-1">Signatory title</label>
                  <input value={docForm.signatoryTitle} onChange={e=>setDocForm(f=>({...f,signatoryTitle:e.target.value}))} className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm"/></div>
              </div>
              <div><label className="text-xs font-bold text-gray-500 uppercase block mb-1">Company name (on the document)</label>
                <input value={docCompany} onChange={e=>setDocCompany(e.target.value)} placeholder="Your company name" className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm"/></div>
              <button onClick={printDoc} className="w-full bg-brand-500 text-white text-sm font-bold py-3 rounded-xl hover:bg-brand-600 shadow-brand">🖨 Generate &amp; print</button>
            </div>
          </div>
        </div>
      )}
      {/* Portal login modal */}
      {portalEmp&&(
        <div className="fixed inset-0 bg-slate-900/25 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={()=>setPortalEmp(null)}>
          <div className="bg-white rounded-3xl p-7 max-w-sm w-full shadow-2xl" onClick={e=>e.stopPropagation()}>
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-lg font-black text-ink">Portal login</h2>
              <button onClick={()=>setPortalEmp(null)} className="w-9 h-9 rounded-lg hover:bg-gray-100 text-gray-400">✕</button>
            </div>
            <p className="text-sm text-gray-500 mb-4">{portalEmp.name} — self-service access (attendance, leave &amp; offset requests, payslips).</p>
            {portalAcc===undefined?<div className="text-center py-6 text-gray-400 text-sm">Loading…</div>
            :portalAcc?(
              <div className="space-y-3">
                <div className="bg-brand-50 border border-brand-100 rounded-xl px-4 py-3 text-sm">
                  <div className="font-bold text-brand-800">{portalAcc.username}</div>
                  <div className="text-xs text-brand-700">{portalAcc.is_active?"Active — can sign in at the app":"Disabled"}</div>
                </div>
                <div><label className="text-xs font-bold text-gray-500 uppercase block mb-1">New password</label>
                  <input type="text" value={portalForm.password} onChange={e=>setPortalForm(f=>({...f,password:e.target.value}))} placeholder="Set a new password" className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm"/></div>
                <div className="flex gap-2">
                  <button disabled={portalBusy} onClick={resetPortalPw} className="flex-1 bg-brand-500 text-white text-xs font-bold py-2.5 rounded-xl hover:bg-brand-600 disabled:opacity-50">Update password</button>
                  <button onClick={togglePortal} className={`flex-1 text-xs font-bold py-2.5 rounded-xl ${portalAcc.is_active?"bg-red-50 text-red-600 hover:bg-red-100":"bg-gray-100 text-gray-700 hover:bg-gray-200"}`}>{portalAcc.is_active?"Disable login":"Enable login"}</button>
                </div>
              </div>
            ):(
              <div className="space-y-3">
                <div><label className="text-xs font-bold text-gray-500 uppercase block mb-1">Email (their login)</label>
                  <input type="email" value={portalForm.email} onChange={e=>setPortalForm(f=>({...f,email:e.target.value}))} placeholder="employee@email.com" className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm"/></div>
                <div><label className="text-xs font-bold text-gray-500 uppercase block mb-1">Temporary password</label>
                  <input type="text" value={portalForm.password} onChange={e=>setPortalForm(f=>({...f,password:e.target.value}))} placeholder="Min. 6 characters" className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm"/></div>
                <button disabled={portalBusy} onClick={createPortal} className="w-full bg-brand-500 text-white text-sm font-bold py-3 rounded-xl hover:bg-brand-600 disabled:opacity-50 shadow-brand">{portalBusy?"Creating…":"Create portal login"}</button>
                <p className="text-xs text-gray-400">Share the email + password with {portalEmp.name.split(" ")[0]} — they sign in at the same app login page.</p>
              </div>
            )}
          </div>
        </div>
      )}
      {confirmDeact&&(
        <div className="fixed inset-0 bg-slate-900/25 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={()=>setConfirmDeact(null)}>
          <div className="bg-white rounded-3xl w-full max-w-sm shadow-2xl p-7 text-center" onClick={e=>e.stopPropagation()}>
            <div className="text-4xl mb-4">{confirmDeact.status==="active"?"⚠":"✅"}</div>
            <h2 className="text-lg font-black mb-2">{confirmDeact.status==="active"?"Deactivate":"Reactivate"} Employee</h2>
            <p className="text-sm text-gray-500 mb-6">{confirmDeact.name} will be {confirmDeact.status==="active"?"unable to scan":"restored"}.</p>
            <div className="flex gap-3">
              <button onClick={()=>setConfirmDeact(null)} className="flex-1 border border-gray-200 text-gray-600 text-sm font-semibold py-2.5 rounded-xl">Cancel</button>
              <button onClick={doDeactivate} className={`flex-1 text-white text-sm font-bold py-2.5 rounded-xl ${confirmDeact.status==="active"?"bg-red-600":"bg-emerald-600"}`}>{confirmDeact.status==="active"?"Deactivate":"Reactivate"}</button>
            </div>
          </div>
        </div>
      )}
      {confirmDelete&&(
        <div className="fixed inset-0 bg-slate-900/25 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={()=>setConfirmDelete(null)}>
          <div className="bg-white rounded-3xl w-full max-w-sm shadow-2xl p-7 text-center" onClick={e=>e.stopPropagation()}>
            <div className="text-4xl mb-4">🗑️</div>
            <h2 className="text-lg font-black mb-2">Delete Employee</h2>
            <p className="text-sm text-gray-500 mb-2">Permanently remove <span className="font-bold">{confirmDelete.name}</span>?</p>
            <p className="text-xs text-red-500 mb-6">This cannot be undone.</p>
            <div className="flex gap-3">
              <button onClick={()=>setConfirmDelete(null)} className="flex-1 border border-gray-200 text-gray-600 text-sm font-semibold py-2.5 rounded-xl">Cancel</button>
              <button onClick={doDelete} className="flex-1 bg-red-600 text-white text-sm font-bold py-2.5 rounded-xl hover:bg-red-700 active:scale-95">Delete</button>
            </div>
          </div>
        </div>
      )}
      {confirmBulkDel&&(
        <div className="fixed inset-0 bg-slate-900/25 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={()=>setConfirmBulkDel(false)}>
          <div className="bg-white rounded-3xl w-full max-w-sm shadow-2xl p-7 text-center" onClick={e=>e.stopPropagation()}>
            <div className="text-4xl mb-4">🗑️</div>
            <h2 className="text-lg font-black mb-2">Delete {selIds.length} Employee(s)</h2>
            <p className="text-sm text-gray-500 mb-2">Permanently remove the <span className="font-bold">{selIds.length}</span> selected employee(s)?</p>
            <p className="text-xs text-red-500 mb-6">This cannot be undone. Their attendance records will also be removed.</p>
            <div className="flex gap-3">
              <button onClick={()=>setConfirmBulkDel(false)} className="flex-1 border border-gray-200 text-gray-600 text-sm font-semibold py-2.5 rounded-xl">Cancel</button>
              <button onClick={doBulkDelete} className="flex-1 bg-red-600 text-white text-sm font-bold py-2.5 rounded-xl hover:bg-red-700 active:scale-95">Delete {selIds.length}</button>
            </div>
          </div>
        </div>
      )}
      {qrModal&&(()=>{
        const qList=filtered; // respect current search/dept/status filters
        const allSel=qList.length>0&&qList.every(e=>qrSel.includes(e.id));
        return (
        <div className="fixed inset-0 bg-slate-900/25 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={()=>setQrModal(false)}>
          <div className="bg-white rounded-3xl w-full max-w-lg shadow-2xl overflow-hidden max-h-[90vh] flex flex-col" onClick={e=>e.stopPropagation()}>
            <div className="bg-gradient-to-r from-blue-700 to-blue-900 px-7 py-5 flex items-center justify-between shrink-0">
              <div><h2 className="text-lg font-black text-white">Print QR Codes</h2><p className="text-blue-200 text-xs mt-0.5">Select who to print</p></div>
              <button onClick={()=>setQrModal(false)} className="text-white/40 hover:text-white text-2xl">×</button>
            </div>
            <div className="p-5 border-b border-gray-100 flex items-center justify-between">
              <button onClick={()=>setQrSel(allSel?[]:qList.map(e=>e.id))} className="text-xs font-bold text-blue-700 hover:underline">{allSel?"Deselect All":"Select All"}</button>
              <span className="text-xs text-gray-400">{qrSel.length} selected</span>
            </div>
            <div className="overflow-y-auto flex-1 p-3">
              {qList.map(e=>(
                <label key={e.id} className={`flex items-center gap-3 p-3 rounded-xl cursor-pointer ${qrSel.includes(e.id)?"bg-blue-50":"hover:bg-gray-50"}`}>
                  <input type="checkbox" checked={qrSel.includes(e.id)} onChange={()=>setQrSel(p=>p.includes(e.id)?p.filter(x=>x!==e.id):[...p,e.id])} className="accent-blue-600 w-4 h-4"/>
                  <div className="flex-1 min-w-0"><div className="text-sm font-semibold text-gray-800 truncate">{e.name}</div><div className="text-xs text-gray-400">{e.id} · {e.department}</div></div>
                </label>
              ))}
            </div>
            <div className="flex gap-3 px-7 py-5 border-t border-gray-100 shrink-0">
              <button onClick={()=>setQrModal(false)} className="flex-1 border border-gray-200 text-gray-600 text-sm font-semibold py-3 rounded-xl">Cancel</button>
              <button onClick={()=>{const sel=employees.filter(e=>qrSel.includes(e.id));if(sel.length===0){addToast("Select at least one.","error");return;}printQRCards(sel);setQrModal(false);}} className="flex-1 bg-blue-700 text-white text-sm font-bold py-3 rounded-xl hover:bg-blue-600">Print {qrSel.length} QR</button>
            </div>
          </div>
        </div>
        );
      })()}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// ADMIN SCHEDULE (Super Admin only)
// ════════════════════════════════════════════════════════════════════════════
function AdminSchedule({ employees, setEmployees, addToast, activeDept, isSuperAdmin, reloadData }) {
  const [editing,setEditing]=useState(null); const [schedForm,setSchedForm]=useState({...DEFAULT_SCHEDULE});
  const [search,setSearch]=useState(""); const [bulkModal,setBulk]=useState(false);
  const [bulkForm,setBulkForm]=useState({...DEFAULT_SCHEDULE}); const [bulkSel,setBulkSel]=useState([]);
  const ovFileRef=useRef(null);
  // Single-employee per-day override (day off / working / custom shift for one date)
  const [dayOv,setDayOv]=useState(null); // {emp,date,type,useShift,shiftStart,shiftEnd,gracePeriod,useBreaks,coffeeBreak,lunchBreak}
  const [dayOvSaving,setDayOvSaving]=useState(false);
  const openDayOv=emp=>setDayOv({emp,date:getToday(),type:"normal",useShift:false,shiftStart:emp.schedule.shiftStart,shiftEnd:emp.schedule.shiftEnd,gracePeriod:emp.schedule.gracePeriod,useBreaks:false,coffeeBreak:numOr(emp.schedule.coffeeBreak,15),lunchBreak:numOr(emp.schedule.lunchBreak,60)});
  const saveDayOv=async()=>{
    if(!dayOv) return;
    const override=(dayOv.useShift||dayOv.useBreaks||dayOv.type!=="normal")
      ? {shiftStart:dayOv.shiftStart,shiftEnd:dayOv.shiftEnd,gracePeriod:numOr(dayOv.gracePeriod,0),dayType:dayOv.type,
         ...(dayOv.useBreaks?{coffeeBreak:numOr(dayOv.coffeeBreak,15),lunchBreak:numOr(dayOv.lunchBreak,60)}:{})}
      : null;
    if(!override){ addToast("Pick Day Off / Working, or enable a custom shift/break allowance.","warning"); return; }
    setDayOvSaving(true);
    const {error}=await supabase.from("attendance").upsert({employee_id:dayOv.emp.id,date:dayOv.date,schedule_override:override,is_day_off_scan:false},{onConflict:"employee_id,date"});
    setDayOvSaving(false);
    if(error){ addToast("Save failed: "+error.message,"error"); return; }
    addToast(`${dayOv.type==="off"?"Day off":dayOv.type==="work"?"Working day":"Shift override"} set for ${dayOv.emp.name} on ${fmtDate(dayOv.date)}.`,"success");
    setDayOv(null); reloadData?.(); // refresh so the override shows on dashboard/reports/manpower immediately
  };

  const active=employees.filter(e=>e.status==="active"&&deptMatch(activeDept,e.department)&&e.name.toLowerCase().includes(search.toLowerCase()));
  const saveEdit=()=>{ const emp=employees.find(e=>e.id===editing); setEmployees(p=>p.map(e=>e.id===editing?{...e,schedule:sanitizeSchedule(schedForm)}:e)); addToast(`Schedule saved for ${emp?.name}. Takes effect immediately.`,"success"); setEditing(null); };
  const applyBulk=()=>{ if(!bulkSel.length){addToast("Select at least one employee.","error");return;} setEmployees(p=>p.map(e=>bulkSel.includes(e.id)?{...e,schedule:sanitizeSchedule(bulkForm)}:e)); addToast(`Applied to ${bulkSel.length} employee(s).`,"success"); setBulk(false); setBulkSel([]); };

  const downloadOvTemplate=()=>{
    const csv=`id,date,shiftStart,shiftEnd,gracePeriod\nEMP001,2026-06-20,10:00,19:00,15\nEMP002,2026-06-20,06:00,15:00,10`;
    const a=Object.assign(document.createElement("a"),{href:URL.createObjectURL(new Blob([csv],{type:"text/csv"})),download:"schedule_override_template.csv"}); a.click(); URL.revokeObjectURL(a.href);
  };
  const uploadOverrides=async e=>{
    const file=e.target.files[0]; if(!file) return;
    const text=await file.text();
    const lines=text.trim().split("\n").filter(Boolean);
    const headers=lines[0].split(",").map(h=>h.trim());
    const rows=lines.slice(1).map(line=>{ const cols=line.split(","); return Object.fromEntries(headers.map((h,i)=>[h,(cols[i]||"").trim()])); });
    let ok=0,fail=0;
    for (const r of rows) {
      const id=String(r.id||"").trim().toUpperCase(); const date=String(r.date||"").slice(0,10);
      if (!id||!date){ fail++; continue; }
      const override={}; if(r.shiftStart)override.shiftStart=r.shiftStart; if(r.shiftEnd)override.shiftEnd=r.shiftEnd; if(r.gracePeriod!=="")override.gracePeriod=numOr(r.gracePeriod,0);
      const {error}=await supabase.from("attendance").upsert({employee_id:id,date,schedule_override:override,is_day_off_scan:false},{onConflict:"employee_id,date"});
      if (error) fail++; else ok++;
    }
    addToast(`Overrides applied: ${ok} ok${fail?`, ${fail} failed`:""}.`,fail?"warning":"success");
    if (ovFileRef.current) ovFileRef.current.value="";
    reloadData?.(); // refresh so applied overrides show immediately
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div><h1 className="text-2xl font-black text-gray-900">Employee Schedules</h1><p className="text-sm text-gray-500 mt-0.5">Changes take effect immediately — even mid-shift</p></div>
        <div className="flex gap-2 flex-wrap">
          <button onClick={downloadOvTemplate} className="bg-gray-100 text-gray-700 text-sm font-bold px-4 py-2.5 rounded-xl hover:bg-gray-200">↓ Override Template</button>
          <button onClick={()=>ovFileRef.current?.click()} className="bg-brand-700 text-white text-sm font-bold px-4 py-2.5 rounded-xl hover:bg-brand-600 active:scale-95">📅 Per-Day Override CSV</button>
          <input ref={ovFileRef} type="file" accept=".csv" onChange={uploadOverrides} className="hidden"/>
          <button onClick={()=>{setBulkForm({...DEFAULT_SCHEDULE});setBulkSel([]);setBulk(true);}} className="bg-brand-700 text-white text-sm font-bold px-5 py-2.5 rounded-xl hover:bg-brand-600 active:scale-95">Bulk Update</button>
        </div>
      </div>
      <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search employee…" className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none bg-gray-50"/>
      <div className="space-y-3">
        {active.map(emp=>(
          <div key={emp.id} className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
            {editing===emp.id?(
              <div className="p-6">
                <div className="flex items-center justify-between mb-5">
                  <div><div className="font-black text-gray-900">{emp.name}</div><div className="text-xs text-gray-400 mt-0.5">{emp.position} · {emp.department}</div></div>
                  <span className="text-xs bg-brand-100 text-brand-700 font-semibold px-2.5 py-1 rounded-full border border-brand-200">Editing</span>
                </div>
                <ScheduleForm value={schedForm} onChange={setSchedForm}/>
                <div className="flex gap-3 mt-5">
                  <button onClick={()=>setEditing(null)} className="flex-1 border border-gray-200 text-gray-600 text-sm font-semibold py-2.5 rounded-xl">Cancel</button>
                  <button onClick={saveEdit} className="flex-1 bg-brand-700 text-white text-sm font-bold py-2.5 rounded-xl hover:bg-brand-600 active:scale-[0.98]">Save & Apply Now</button>
                </div>
              </div>
            ):(
              <div className="flex items-center justify-between px-5 py-4 gap-4">
                <div className="min-w-0 flex-1"><div className="font-semibold text-gray-800">{emp.name}</div><div className="text-xs text-gray-400 mt-0.5">{emp.position} · {emp.department}</div></div>
                <div className="flex items-center gap-4 shrink-0">
                  <div className="text-center"><div className="text-xs text-gray-400 mb-0.5">Shift</div><div className="text-sm font-bold text-gray-800 font-mono whitespace-nowrap">{fmt(emp.schedule.shiftStart)}–{fmt(emp.schedule.shiftEnd)}</div></div>
                  <div className="text-center"><div className="text-xs text-gray-400 mb-0.5">Breaks</div><div className="text-sm font-bold text-gray-800 whitespace-nowrap">{emp.schedule.coffeeBreak}m / {emp.schedule.lunchBreak}m</div></div>
                  <div className="text-center hidden md:block"><div className="text-xs text-gray-400 mb-0.5">Rest Days</div><div className="text-xs font-semibold text-gray-600">{emp.schedule.restDays.map(d=>d.slice(0,3)).join(", ")||"None"}</div></div>
                  <button onClick={()=>openDayOv(emp)} className="px-4 py-2 bg-brand-50 hover:bg-brand-100 text-brand-700 text-xs font-bold rounded-xl border border-brand-200 active:scale-95 whitespace-nowrap">📅 Day Override</button>
                  <button onClick={()=>{setEditing(emp.id);setSchedForm({...emp.schedule});}} className="px-4 py-2 bg-brand-50 hover:bg-brand-100 text-brand-700 text-xs font-bold rounded-xl border border-brand-200 active:scale-95">Edit</button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
      {bulkModal&&(
        <div className="fixed inset-0 bg-slate-900/25 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={()=>setBulk(false)}>
          <div className="bg-white rounded-3xl w-full max-w-lg shadow-2xl overflow-hidden" onClick={e=>e.stopPropagation()}>
            <div className="bg-gradient-to-r from-brand-700 to-brand-900 px-7 py-5 flex items-center justify-between">
              <h2 className="text-lg font-black text-white">Bulk Update Schedule</h2>
              <button onClick={()=>setBulk(false)} className="text-white/40 hover:text-white text-2xl">×</button>
            </div>
            <div className="p-7 space-y-4 max-h-[70vh] overflow-y-auto">
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs font-bold text-gray-500 uppercase tracking-wider">Select Employees</label>
                <button onClick={()=>setBulkSel(bulkSel.length===active.length?[]:active.map(e=>e.id))} className="text-xs text-brand-600 font-semibold hover:underline">{bulkSel.length===active.length?"Deselect All":"Select All"}</button>
              </div>
              {active.map(emp=>(
                <label key={emp.id} className={`flex items-center gap-3 p-3 rounded-xl border cursor-pointer mb-2 transition-colors ${bulkSel.includes(emp.id)?"bg-brand-50 border-brand-200":"bg-gray-50 border-gray-200"}`}>
                  <input type="checkbox" checked={bulkSel.includes(emp.id)} onChange={()=>setBulkSel(p=>p.includes(emp.id)?p.filter(x=>x!==emp.id):[...p,emp.id])} className="accent-brand-600 w-4 h-4"/>
                  <div><div className="text-sm font-semibold">{emp.name}</div><div className="text-xs text-gray-400">{emp.department}</div></div>
                </label>
              ))}
              <div className="border-t border-gray-100 pt-4"><label className="text-xs font-bold text-gray-500 uppercase tracking-wider block mb-3">New Schedule</label><ScheduleForm value={bulkForm} onChange={setBulkForm}/></div>
            </div>
            <div className="flex gap-3 px-7 py-5 border-t border-gray-100">
              <button onClick={()=>setBulk(false)} className="flex-1 border border-gray-200 text-gray-600 text-sm font-semibold py-3 rounded-xl">Cancel</button>
              <button onClick={applyBulk} className="flex-1 bg-brand-700 text-white text-sm font-bold py-3 rounded-xl hover:bg-brand-600">Apply to {bulkSel.length} Employee(s)</button>
            </div>
          </div>
        </div>
      )}

      {dayOv&&(
        <div className="fixed inset-0 bg-slate-900/25 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={()=>setDayOv(null)}>
          <div className="bg-white rounded-3xl w-full max-w-md shadow-2xl overflow-hidden max-h-[90vh] flex flex-col" onClick={e=>e.stopPropagation()}>
            <div className="bg-gradient-to-r from-brand-700 to-brand-900 px-7 py-5 flex items-center justify-between shrink-0">
              <div><h2 className="text-lg font-black text-white">Day Override</h2><p className="text-brand-200 text-xs mt-0.5">{dayOv.emp.name} · {dayOv.emp.department}</p></div>
              <button onClick={()=>setDayOv(null)} className="text-white/40 hover:text-white text-2xl">×</button>
            </div>
            <div className="p-7 space-y-4 overflow-y-auto flex-1">
              <div><label className="text-xs font-bold text-gray-500 uppercase tracking-wider block mb-1.5">Date</label>
                <input type="date" value={dayOv.date} min={getToday()} max={daysAgoStr(-30)} onChange={e=>setDayOv(o=>({...o,date:e.target.value}))} className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-200"/></div>
              <div>
                <label className="text-xs font-bold text-gray-500 uppercase tracking-wider block mb-2">Day Type</label>
                <div className="grid grid-cols-3 gap-2">
                  {[["normal","Normal","🗓"],["off","Day Off","🌴"],["work","Working","💼"]].map(([v,l,i])=>(
                    <button key={v} type="button" onClick={()=>setDayOv(o=>({...o,type:v}))} className={`px-2 py-2.5 rounded-xl text-xs font-semibold border transition-colors ${dayOv.type===v?"bg-brand-600 text-white border-brand-600":"bg-gray-50 text-gray-600 border-gray-200 hover:border-brand-300"}`}>{i} {l}</button>
                  ))}
                </div>
                <p className="text-xs text-gray-400 mt-2">{dayOv.type==="off"?"Excused — shows Rest Day, not absent.":dayOv.type==="work"?"Expected in even if normally a rest day.":"Keeps their normal schedule."} Applies only to {fmtDate(dayOv.date)}.</p>
              </div>
              <div className="border-t border-gray-100 pt-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={dayOv.useShift} onChange={e=>setDayOv(o=>({...o,useShift:e.target.checked}))} className="accent-brand-600 w-4 h-4"/>
                  <span className="text-sm font-bold text-gray-700">Custom shift times for this day</span>
                </label>
                {dayOv.useShift&&(
                  <div className="grid grid-cols-3 gap-3 mt-3">
                    <div><label className="text-xs font-bold text-gray-500 uppercase tracking-wider block mb-1.5">Start</label>
                      <input type="time" value={dayOv.shiftStart} onChange={e=>setDayOv(o=>({...o,shiftStart:e.target.value}))} className="w-full border border-gray-200 rounded-xl px-2 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-200"/></div>
                    <div><label className="text-xs font-bold text-gray-500 uppercase tracking-wider block mb-1.5">End</label>
                      <input type="time" value={dayOv.shiftEnd} onChange={e=>setDayOv(o=>({...o,shiftEnd:e.target.value}))} className="w-full border border-gray-200 rounded-xl px-2 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-200"/></div>
                    <div><label className="text-xs font-bold text-gray-500 uppercase tracking-wider block mb-1.5">Grace</label>
                      <input type="number" value={dayOv.gracePeriod} onChange={e=>setDayOv(o=>({...o,gracePeriod:e.target.value}))} className="w-full border border-gray-200 rounded-xl px-2 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-200"/></div>
                  </div>
                )}
              </div>
              <div className="border-t border-gray-100 pt-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={dayOv.useBreaks} onChange={e=>setDayOv(o=>({...o,useBreaks:e.target.checked}))} className="accent-brand-600 w-4 h-4"/>
                  <span className="text-sm font-bold text-gray-700">Extend break allowance for this day</span>
                </label>
                <p className="text-xs text-gray-400 mt-1">For an approved one-off exception (e.g. an 80-minute lunch) — doesn't change their normal break allowance on other days.</p>
                {dayOv.useBreaks&&(
                  <div className="grid grid-cols-2 gap-3 mt-3">
                    <div><label className="text-xs font-bold text-gray-500 uppercase tracking-wider block mb-1.5">Coffee (min)</label>
                      <input type="number" value={dayOv.coffeeBreak} onChange={e=>setDayOv(o=>({...o,coffeeBreak:e.target.value}))} className="w-full border border-gray-200 rounded-xl px-2 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-200"/></div>
                    <div><label className="text-xs font-bold text-gray-500 uppercase tracking-wider block mb-1.5">Lunch (min)</label>
                      <input type="number" value={dayOv.lunchBreak} onChange={e=>setDayOv(o=>({...o,lunchBreak:e.target.value}))} className="w-full border border-gray-200 rounded-xl px-2 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-200"/></div>
                  </div>
                )}
              </div>
            </div>
            <div className="flex gap-3 px-7 py-5 border-t border-gray-100 shrink-0">
              <button onClick={()=>setDayOv(null)} className="flex-1 border border-gray-200 text-gray-600 text-sm font-semibold py-3 rounded-xl hover:bg-gray-50">Cancel</button>
              <button onClick={saveDayOv} disabled={dayOvSaving} className="flex-1 bg-brand-700 text-white text-sm font-bold py-3 rounded-xl hover:bg-brand-600 disabled:opacity-60 active:scale-[0.98]">{dayOvSaving?"Saving…":"Save Override"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// ADMIN REPORTS
// ════════════════════════════════════════════════════════════════════════════
function AdminReports({ employees, allAttendance, leaves, addToast, initialStatus, jumpRange, activeDept, activeRole, reloadData, quietRefresh, isSuperAdmin, adminUser }) {
  const [editRec,setEditRec]=useState(null);
  const [editForm,setEditForm]=useState({timeIn:"",timeOut:"",coffeeStart:"",coffeeEnd:"",lunchStart:"",lunchEnd:"",remarks:""});
  const [ovEnabled,setOvEnabled]=useState(false);
  const [ovForm,setOvForm]=useState({shiftStart:"",shiftEnd:"",gracePeriod:""});
  const [ovDayType,setOvDayType]=useState("normal"); // normal | off | work
  const [saving,setSaving]=useState(false);
  const [plan,setPlan]=useState(null); // {empIds,date,search,type,useShift,shiftStart,shiftEnd,gracePeriod} — bulk schedule/day-off planner
  const [planSaving,setPlanSaving]=useState(false);

  // Apply Day Type / custom shift override to every selected employee for the chosen date.
  const applyPlan=async()=>{
    if(!plan.empIds.length){ addToast("Select at least one employee.","error"); return; }
    // Only include shift fields when the admin explicitly set custom times — the plan's
    // defaults (08:00–17:00) are NOT each employee's real shift, and writing them into a
    // bulk Day Off override would corrupt late/OT calculations for anyone on another shift.
    const override=(plan.useShift||plan.type!=="normal")
      ? {dayType:plan.type, ...(plan.useShift?{shiftStart:plan.shiftStart,shiftEnd:plan.shiftEnd,gracePeriod:numOr(plan.gracePeriod,0)}:{})}
      : null;
    if(!override){ addToast("Pick Day Off / Working, or enable a custom shift.","warning"); return; }
    setPlanSaving(true);
    let ok=0,fail=0;
    for (const empId of plan.empIds) {
      const {error}=await supabase.from("attendance").upsert({employee_id:empId,date:plan.date,schedule_override:override,is_day_off_scan:false},{onConflict:"employee_id,date"});
      if (error) fail++; else ok++;
    }
    setPlanSaving(false);
    addToast(`Applied to ${ok} employee(s)${fail?`, ${fail} failed`:""}.`,fail?"warning":"success");
    setPlan(null); (quietRefresh||reloadData)?.();
  };

  const openEdit=(emp,rec)=>{
    setEditRec({empId:emp.id,empName:emp.name,date:rec.date,schedule:emp.schedule,scheduleOverride:rec.scheduleOverride||null,origTimeIn:rec.timeIn||"",origTimeOut:rec.timeOut||"",timeInSrc:rec.timeInSrc||null,timeOutSrc:rec.timeOutSrc||null});
    setEditForm({timeIn:rec.timeIn||"",timeOut:rec.timeOut||"",coffeeStart:rec.coffeeStart||"",coffeeEnd:rec.coffeeEnd||"",lunchStart:rec.lunchStart||"",lunchEnd:rec.lunchEnd||"",remarks:rec.remarks||""});
    const ov=rec.scheduleOverride;
    const isManual = ov && !ov.snapshot; // a pure snapshot isn't a manual override
    setOvEnabled(!!isManual);
    setOvDayType(ov?.dayType||"normal");
    setOvForm({
      shiftStart: ov?.shiftStart||emp.schedule.shiftStart,
      shiftEnd:   ov?.shiftEnd||emp.schedule.shiftEnd,
      gracePeriod:(ov?.gracePeriod ?? emp.schedule.gracePeriod),
    });
  };
  const saveEdit=async()=>{
    setSaving(true);
    // Effective schedule for this day = override (if enabled) merged over the normal schedule.
    // If no manual override is set but a snapshot already exists on the record, keep the snapshot
    // so editing time-in/out doesn't un-freeze the day's schedule.
    const existingOv = editRec.scheduleOverride || null;
    const override = (ovEnabled||ovDayType!=="normal")
      ? {shiftStart:ovForm.shiftStart,shiftEnd:ovForm.shiftEnd,gracePeriod:numOr(ovForm.gracePeriod,0),dayType:ovDayType}
      : existingOv;
    const sched = override ? {...editRec.schedule,...override} : editRec.schedule;
    const ti=editForm.timeIn||null, to=editForm.timeOut||null;
    const cs=editForm.coffeeStart||null, ce=editForm.coffeeEnd||null, ls=editForm.lunchStart||null, le=editForm.lunchEnd||null;
    // Per-field source: only mark a time 'manual' if the admin actually CHANGED it.
    // Unchanged values keep their original source (so a phone-scanned time stays 📱).
    const tiSrc = !ti ? null : (ti!==(editRec.origTimeIn||"") ? 'manual' : (editRec.timeInSrc||'scan'));
    const toSrc = !to ? null : (to!==(editRec.origTimeOut||"") ? 'manual' : (editRec.timeOutSrc||'scan'));
    let late=0,status="absent",hours=0,incomplete=false;
    if (ti) {
      const l=Math.max(0,toMins(ti)-(toMins(sched.shiftStart)+numOr(sched.gracePeriod,0)));
      late=l>0?toMins(ti)-toMins(sched.shiftStart):0;
      status=l>0?"late":"present";
      if (to) {
        // Worked = out − in, minus each break actually taken.
        let worked=toMins(to)-toMins(ti);
        if (cs&&ce) worked-=(toMins(ce)-toMins(cs));
        if (ls&&le) worked-=(toMins(le)-toMins(ls));
        hours=Math.round(Math.max(0,worked)/60*10)/10;
      } else incomplete=true;
    }
    // Recompute over-break (duration-classified) against this day's effective schedule.
    const bo=liveBreakOver({schedule:editRec.schedule},{coffeeStart:cs,coffeeEnd:ce,lunchStart:ls,lunchEnd:le,scheduleOverride:override});
    const {error}=await supabase.from('attendance').upsert({
      employee_id:editRec.empId, date:editRec.date, time_in:ti, time_out:to,
      coffee_start:cs, coffee_end:ce, lunch_start:ls, lunch_end:le,
      coffee_over:bo.coffee, lunch_over:bo.lunch, over_break_minutes:bo.total,
      late_minutes:late, hours_worked:hours, status, is_incomplete:incomplete,
      schedule_override:override, manual_entry:true, time_in_src:tiSrc, time_out_src:toSrc,
      remarks:editForm.remarks||null,
      // A manual edit here supersedes whatever the kiosk auto-flagged at scan time (e.g. a day-off
      // scan warning) — otherwise that flag sticks forever and keeps showing "Day Off" no matter
      // what Day Type the admin picks below.
      is_day_off_scan:false,
    },{onConflict:'employee_id,date'});
    setSaving(false);
    if (error){ addToast("Save failed: "+error.message,"error"); return; }
    // Log the actual manual time-in/out change distinctly from a Day Type/shift override, so
    // the audit trail (Settings, super-admin only) clearly shows WHO manually edited a punch,
    // not just that "some override" happened.
    const timeNote = (tiSrc==='manual'||toSrc==='manual') ? ` · Manual Time In/Out set to ${ti?fmt(ti):'—'} / ${to?fmt(to):'—'}` : '';
    const dayNote = (ovDayType!=="normal"||ovEnabled) ? ` · ${ovDayType==="off"?"marked DAY OFF":ovDayType==="work"?"marked WORKING DAY":"shift "+ovForm.shiftStart+"–"+ovForm.shiftEnd}` : '';
    const remarkNote=editForm.remarks?` — "${editForm.remarks}"`:"";
    await logAudit(adminUser,"record_edit",editRec.empName,`${editRec.date}${timeNote}${dayNote}${remarkNote}`);
    addToast(`Record updated for ${editRec.empName}.`,"success");
    setEditRec(null); (quietRefresh||reloadData)?.();
  };

  const TODAY=getToday();
  const fourteenAgo=daysAgoStr(13);
  const allDates=Object.keys(allAttendance).sort();
  const earliest=allDates[0]||fourteenAgo;
  const [dateFrom,setFrom]=useState(fourteenAgo); const [dateTo,setTo]=useState(TODAY);
  const [activePreset,setActivePreset]=useState("Last 14d"); // which range button is highlighted (null = custom)
  const [status,setStatus]=useState(initialStatus||"all"); const [search,setSearch]=useState(""); const [roleFilter,setRoleFilter]=useState("all");
  const roles=useMemo(()=>[...new Set(employees.map(e=>e.role||"Staff"))],[employees]);
  useEffect(()=>{ if(initialStatus) setStatus(initialStatus); },[initialStatus]);
  // When navigated from a dashboard card, snap the date range to TODAY
  useEffect(()=>{ if(jumpRange&&jumpRange.from){ setFrom(jumpRange.from); setTo(jumpRange.to); setActivePreset(null); } },[jumpRange]);

  const PRESETS=[{l:"Today",f:TODAY,t:TODAY},{l:"This Week",f:(()=>{const d=new Date();d.setDate(d.getDate()-((d.getDay()+6)%7));return localDateStr(d);})(),t:TODAY},{l:"Last 7d",f:daysAgoStr(6),t:TODAY},{l:"Last 14d",f:earliest,t:TODAY}];

  const rows=useMemo(()=>{
    const out=[]; const active=employees.filter(e=>e.status==="active"&&deptMatch(activeDept,e.department));
    const dates=new Set(Object.keys(allAttendance).filter(d=>d>=dateFrom&&d<=dateTo));
    // TODAY must always be included when in range — early in the day nobody has scanned yet,
    // so it has no attendance rows, but the dashboard still shows live absent/upcoming counts
    // for it. Without this the report comes up empty and disagrees with the dashboard.
    if (TODAY>=dateFrom&&TODAY<=dateTo) dates.add(TODAY);
    [...dates].sort().reverse().forEach(date=>{ active.forEach(emp=>{ const rec=allAttendance[date]?.[emp.id]||{status:"absent",date}; out.push({emp,rec:{...rec,date}}); }); });
    return out;
  },[allAttendance,employees,dateFrom,dateTo,activeDept,TODAY]);

  // Live display status — recomputed against CURRENT schedule (matches badges everywhere)
  const dispOf=(emp,rec)=>{ const e=employees.find(x=>x.id===emp.id); return e?computeDisplayStatus(e,rec,rec.date===TODAY,isOnLeave(leaves,emp.id,rec.date)):(rec.isDayOffScan?"day-off":rec.status||"absent"); };
  // Status filter: "present" matches anyone who clocked in (present/working/late/incomplete)
  const matchesStatus=(emp,rec)=>{
    if (status==="all") return true;
    const s=dispOf(emp,rec);
    if (status==="present") return s==="present"||s==="working"||s==="late"||s==="incomplete"||s==="half-day"||s==="undertime";
    return s===status;
  };
  const filtered=rows.filter(({emp,rec})=>matchesStatus(emp,rec)&&(!activeRole||activeRole==="all"||(emp.role||"Staff")===activeRole)&&(roleFilter==="all"||(emp.role||"Staff")===roleFilter)&&(emp.name.toLowerCase().includes(search.toLowerCase())||emp.department.toLowerCase().includes(search.toLowerCase())));
  const days=[...new Set(filtered.map(r=>r.rec.date))];
  const totals={
    // Same "showed up" grouping as the dashboard cards and the matchesStatus filter above.
    present:filtered.filter(r=>{const s=dispOf(r.emp,r.rec);return s==="present"||s==="working"||s==="late"||s==="incomplete"||s==="half-day"||s==="undertime";}).length,
    late:   filtered.filter(r=>dispOf(r.emp,r.rec)==="late").length,
    absent: filtered.filter(r=>dispOf(r.emp,r.rec)==="absent").length,
    dayOff: filtered.filter(r=>r.rec.isDayOffScan).length,
    otMins: filtered.reduce((s,r)=>{const eo=employees.find(x=>x.id===r.emp.id)||r.emp;return s+liveOvertimeMins(eo,r.rec);},0),
  };

  const exportCSV=()=>{
    const h="Date,Employee ID,Name,Department,Position,Time In,Time Out,Late(min),Over Break(min),Overtime(min),Hours Worked,Status,Day Off,Remarks";
    const esc=v=>{const s=String(v??"");return /[",\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s;};
    const body=filtered.map(({emp:e,rec:r})=>{const eo=employees.find(x=>x.id===e.id)||e;const lm=liveLateMinutes(eo,r);const ob=liveOverBreakMinutes(eo,r);const ot=liveOvertimeMins(eo,r);const st=dispOf(e,r);return `${r.date},${e.id},"${e.name}",${e.department},${e.position},${r.timeIn||""},${r.timeOut||""},${lm},${ob},${ot},${r.hoursWorked||0},${st},${r.isDayOffScan?"Yes":"No"},${esc(r.remarks)}`;});
    const blob=new Blob([[h,...body].join("\n")],{type:"text/csv"});
    const a=Object.assign(document.createElement("a"),{href:URL.createObjectURL(blob),download:`attendance_${dateFrom}_to_${dateTo}.csv`});
    a.click(); URL.revokeObjectURL(a.href); addToast(`Exported ${filtered.length} records.`,"success");
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div><h1 className="text-2xl font-black text-gray-900">Reports</h1><p className="text-sm text-gray-500 mt-0.5">{filtered.length} records · {days.length} day(s)</p></div>
        <div className="flex gap-2">
          <button onClick={()=>setPlan({empIds:[],date:TODAY,search:"",type:"normal",useShift:false,shiftStart:"08:00",shiftEnd:"17:00",gracePeriod:10})} className="bg-brand-600 text-white text-sm font-bold px-5 py-2.5 rounded-xl hover:bg-brand-500 active:scale-95">📅 Set Schedule</button>
          <button onClick={async()=>{await (quietRefresh?quietRefresh():reloadData?.());addToast("Refreshed.","success");}} className="bg-slate-100 text-slate-700 text-sm font-bold px-5 py-2.5 rounded-xl hover:bg-slate-200 active:scale-95">↻ Refresh</button>
          <button onClick={exportCSV} className="bg-emerald-600 text-white text-sm font-bold px-5 py-2.5 rounded-xl hover:bg-emerald-500 active:scale-95">↓ Export CSV</button>
        </div>
      </div>
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
        <div className="flex flex-wrap gap-3 items-end">
          <div className="flex-1 min-w-[130px]"><label className="text-xs font-semibold text-gray-400 block mb-1.5">From</label><input type="date" value={dateFrom} max={dateTo} onChange={e=>{setFrom(e.target.value);setActivePreset(null);}} className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none cursor-pointer"/></div>
          <div className="flex-1 min-w-[130px]"><label className="text-xs font-semibold text-gray-400 block mb-1.5">To</label><input type="date" value={dateTo} min={dateFrom} max={daysAgoStr(-30)} onChange={e=>{setTo(e.target.value);setActivePreset(null);}} className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none cursor-pointer"/></div>
          <div className="flex gap-2 flex-wrap">{PRESETS.map(({l,f,t})=><button key={l} onClick={()=>{setFrom(f);setTo(t);setActivePreset(l);}} className={`px-3 py-2.5 rounded-xl text-xs font-semibold border transition-colors ${activePreset===l?"bg-brand-500 text-white border-brand-500":"bg-gray-50 text-gray-600 border-gray-200 hover:border-slate-400"}`}>{l}</button>)}</div>
        </div>
      </div>
      <div className="flex gap-3 flex-wrap">
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search employee or department…" className="flex-1 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none bg-gray-50"/>
        <select value={roleFilter} onChange={e=>setRoleFilter(e.target.value)} className="border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none bg-gray-50 cursor-pointer">
          <option value="all">All Roles</option>{roles.map(r=><option key={r} value={r}>{r}</option>)}
        </select>
        <select value={status} onChange={e=>setStatus(e.target.value)} className="border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none bg-gray-50 cursor-pointer">
          <option value="all">All Status</option>
          <option value="present">Present</option>
          <option value="working">Working</option>
          <option value="late">Late</option>
          <option value="half-day">Half Day (Worked)</option>
          <option value="undertime">Undertime</option>
          <option value="absent">Absent</option>
          <option value="upcoming">Upcoming</option>
          <option value="incomplete">No Time-Out</option>
          <option value="on-leave">On Leave</option>
          <option value="suspended">Suspended</option>
          <option value="halfday-leave">Half Day (Filed)</option>
          <option value="rest-day">Rest Day</option>
          <option value="day-off">Day Off Scan</option>
        </select>
      </div>
      <div className="flex gap-2 flex-wrap">
        {[["bg-gray-100 text-gray-700","Total",filtered.length],["bg-emerald-100 text-emerald-700","Present",totals.present],["bg-amber-100 text-amber-700","Late",totals.late],["bg-red-100 text-red-700","Absent",totals.absent],["bg-purple-100 text-purple-700","Day Off Scans",totals.dayOff],["bg-brand-100 text-brand-700","Overtime",fmtHrs(totals.otMins)]].map(([c,l,n])=>(
          <span key={l} className={`px-3 py-1 rounded-full text-xs font-semibold ${c}`}>{l}: {n}</span>
        ))}
      </div>
      <div className="bg-white rounded-3xl border border-gray-100 shadow-sm overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-gray-100 bg-gray-50/60">{["Date","Name","Dept","Time In","Time Out","Breaks","Late","O/Break","OT","Status","Edit"].map(h=><th key={h} className="text-left text-xs font-semibold text-gray-400 uppercase tracking-wider px-4 py-3.5">{h}</th>)}</tr></thead>
          <tbody className="divide-y divide-gray-50">
            {filtered.length===0?<tr><td colSpan={11} className="text-center py-14 text-gray-400">No records match your filters</td></tr>
              :filtered.map(({emp,rec},i)=>(
                <tr key={`${emp.id}-${rec.date}-${i}`} className={`hover:bg-gray-50/60 transition-colors ${rec.isDayOffScan?"bg-purple-50/30":""}`}>
                  <td className="px-4 py-3.5 text-xs font-mono text-gray-500 whitespace-nowrap">{fmtDate(rec.date)}</td>
                  <td className="px-4 py-3.5"><div className="font-semibold text-gray-800 text-sm flex items-center gap-1.5">{emp.name}{rec.remarks&&<span title={rec.remarks} className="cursor-help">📝</span>}</div><div className="text-xs text-gray-400">{emp.position}</div></td>
                  <td className="px-4 py-3.5 text-sm text-gray-600">{emp.department}</td>
                  <td className="px-4 py-3.5 font-mono text-xs text-gray-600 whitespace-nowrap">{rec.timeIn?<span className="inline-flex items-center gap-1">{fmt(rec.timeIn)}<span className="opacity-30 not-italic" title={rec.timeInSrc==="manual"?"Manually set by admin":"Phone / kiosk scan"}>{rec.timeInSrc==="manual"?"💻":"📱"}</span></span>:"—"}</td>
                  <td className="px-4 py-3.5 font-mono text-xs text-gray-600 whitespace-nowrap">{rec.timeOut?<span className="inline-flex items-center gap-1">{fmt(rec.timeOut)}<span className="opacity-30 not-italic" title={rec.timeOutSrc==="manual"?"Manually set by admin":"Phone / kiosk scan"}>{rec.timeOutSrc==="manual"?"💻":"📱"}</span></span>:"—"}</td>
                  <td className="px-4 py-3.5 font-mono text-[11px] text-gray-600 whitespace-nowrap leading-tight">{rec.coffeeStart||rec.lunchStart?<>
                    {rec.coffeeStart&&<div>{fmt(rec.coffeeStart)}–{rec.coffeeEnd?fmt(rec.coffeeEnd):"?"}</div>}
                    {rec.lunchStart&&<div>{fmt(rec.lunchStart)}–{rec.lunchEnd?fmt(rec.lunchEnd):"?"}</div>}
                  </>:<span className="text-gray-200 text-xs">—</span>}</td>
                  <td className="px-4 py-3.5">{(()=>{const eo=employees.find(x=>x.id===emp.id)||emp;const lm=liveLateMinutes(eo,rec);return lm>0?<span className="text-amber-600 font-bold text-xs">{lm}m</span>:<span className="text-gray-200 text-xs">—</span>;})()}</td>
                  <td className="px-4 py-3.5">{(()=>{const eo=employees.find(x=>x.id===emp.id)||emp;const ob=liveOverBreakMinutes(eo,rec);return ob>0?<span className="text-orange-600 font-bold text-xs">{ob}m</span>:<span className="text-gray-200 text-xs">—</span>;})()}</td>
                  <td className="px-4 py-3.5">{(()=>{const eo=employees.find(x=>x.id===emp.id)||emp;const ot=liveOvertimeMins(eo,rec);return ot>0?<span className="text-brand-600 font-bold text-xs">{fmtHrs(ot)}</span>:<span className="text-gray-200 text-xs">—</span>;})()}</td>
                  <td className="px-4 py-3.5"><Badge status={dispOf(emp,rec)}/></td>
                  <td className="px-4 py-3.5"><button onClick={()=>openEdit(emp,rec)} className="px-2.5 py-1.5 text-xs font-semibold text-brand-600 bg-brand-50 hover:bg-brand-100 rounded-lg">Edit</button></td>
                </tr>
              ))
            }
          </tbody>
        </table>
      </div>

      {editRec&&(
        <div className="fixed inset-0 bg-slate-900/25 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={()=>setEditRec(null)}>
          <div className="bg-white rounded-3xl w-full max-w-md shadow-2xl overflow-hidden max-h-[90vh] flex flex-col" onClick={e=>e.stopPropagation()}>
            <div className="bg-gradient-to-r from-brand-700 to-brand-900 px-7 py-5 flex items-center justify-between shrink-0">
              <div><h2 className="text-lg font-black text-white">Edit Time Record</h2><p className="text-brand-300 text-xs mt-0.5">{editRec.empName} · {fmtDate(editRec.date)}</p></div>
              <button onClick={()=>setEditRec(null)} className="text-white/40 hover:text-white text-2xl">×</button>
            </div>
            <div className="p-7 space-y-4 overflow-y-auto flex-1">
              <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-2.5 text-xs text-amber-700">Editing actual time-in / time-out. Late minutes and hours worked will be recalculated automatically.</div>
              <div className="grid grid-cols-2 gap-4">
                <div><label className="text-xs font-bold text-gray-500 uppercase tracking-wider block mb-1.5">Time In</label>
                  <input type="time" value={editForm.timeIn} onChange={e=>setEditForm(f=>({...f,timeIn:e.target.value}))} className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-200"/></div>
                <div><label className="text-xs font-bold text-gray-500 uppercase tracking-wider block mb-1.5">Time Out</label>
                  <input type="time" value={editForm.timeOut} onChange={e=>setEditForm(f=>({...f,timeOut:e.target.value}))} className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-200"/></div>
              </div>
              <p className="text-xs text-gray-400">Normal shift: {fmt(editRec.schedule.shiftStart)}–{fmt(editRec.schedule.shiftEnd)} · Grace {editRec.schedule.gracePeriod}m. Leave blank to clear.</p>

              <div className="border-t border-gray-100 pt-4">
                <label className="text-sm font-bold text-gray-700 block mb-2">Breaks</label>
                <div className="grid grid-cols-2 gap-4">
                  <div><label className="text-xs font-bold text-gray-500 uppercase tracking-wider block mb-1.5">Break 1 In</label>
                    <input type="time" value={editForm.coffeeStart} onChange={e=>setEditForm(f=>({...f,coffeeStart:e.target.value}))} className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-200"/></div>
                  <div><label className="text-xs font-bold text-gray-500 uppercase tracking-wider block mb-1.5">Break 1 Out</label>
                    <input type="time" value={editForm.coffeeEnd} onChange={e=>setEditForm(f=>({...f,coffeeEnd:e.target.value}))} className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-200"/></div>
                  <div><label className="text-xs font-bold text-gray-500 uppercase tracking-wider block mb-1.5">Break 2 In</label>
                    <input type="time" value={editForm.lunchStart} onChange={e=>setEditForm(f=>({...f,lunchStart:e.target.value}))} className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-200"/></div>
                  <div><label className="text-xs font-bold text-gray-500 uppercase tracking-wider block mb-1.5">Break 2 Out</label>
                    <input type="time" value={editForm.lunchEnd} onChange={e=>setEditForm(f=>({...f,lunchEnd:e.target.value}))} className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-200"/></div>
                </div>
                <p className="text-xs text-gray-400 mt-2">Break 1 = first break (coffee), Break 2 = second (lunch). Hours worked and over-break recalculate automatically. Leave blank to clear.</p>
              </div>

              <div className="border-t border-gray-100 pt-4">
                <label className="text-sm font-bold text-gray-700 block mb-2">Day Type for {fmtDate(editRec.date)}</label>
                <div className="grid grid-cols-3 gap-2 mb-3">
                  {[["normal","Normal","🗓"],["off","Day Off","🌴"],["work","Working Day","💼"]].map(([v,l,i])=>(
                    <button key={v} type="button" onClick={()=>setOvDayType(v)} className={`px-2 py-2.5 rounded-xl text-xs font-semibold border transition-colors ${ovDayType===v?"bg-brand-600 text-white border-brand-600":"bg-gray-50 text-gray-600 border-gray-200 hover:border-brand-300"}`}>{i} {l}</button>
                  ))}
                </div>
                <p className="text-xs text-gray-400 mb-3">{ovDayType==="off"?"Marked OFF this date — shows Rest Day, not counted absent.":ovDayType==="work"?"Marked WORKING this date — expected in even if it's normally a rest day.":"Uses their normal weekly schedule."} Applies only to this date.</p>

                <label className="flex items-center gap-2 cursor-pointer mb-1">
                  <input type="checkbox" checked={ovEnabled} onChange={e=>setOvEnabled(e.target.checked)} className="accent-brand-600 w-4 h-4"/>
                  <span className="text-sm font-bold text-gray-700">Also override shift times for this day</span>
                </label>
                <p className="text-xs text-gray-400 mb-3">Applies only to {fmtDate(editRec.date)} — does not change their normal schedule.</p>
                {ovEnabled&&(
                  <div className="grid grid-cols-3 gap-3">
                    <div><label className="text-xs font-bold text-gray-500 uppercase tracking-wider block mb-1.5">Shift Start</label>
                      <input type="time" value={ovForm.shiftStart} onChange={e=>setOvForm(f=>({...f,shiftStart:e.target.value}))} className="w-full border border-gray-200 rounded-xl px-2 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-200"/></div>
                    <div><label className="text-xs font-bold text-gray-500 uppercase tracking-wider block mb-1.5">Shift End</label>
                      <input type="time" value={ovForm.shiftEnd} onChange={e=>setOvForm(f=>({...f,shiftEnd:e.target.value}))} className="w-full border border-gray-200 rounded-xl px-2 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-200"/></div>
                    <div><label className="text-xs font-bold text-gray-500 uppercase tracking-wider block mb-1.5">Grace (min)</label>
                      <input type="number" value={ovForm.gracePeriod} onChange={e=>setOvForm(f=>({...f,gracePeriod:e.target.value}))} className="w-full border border-gray-200 rounded-xl px-2 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-200"/></div>
                  </div>
                )}
              </div>

              <div className="border-t border-gray-100 pt-4">
                <label className="text-xs font-bold text-gray-500 uppercase tracking-wider block mb-1.5">Remarks</label>
                <textarea value={editForm.remarks} onChange={e=>setEditForm(f=>({...f,remarks:e.target.value}))} placeholder="e.g. Traffic delay, approved by manager" rows={2} className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-200 resize-none"/>
              </div>
            </div>
            <div className="flex gap-3 px-7 py-5 border-t border-gray-100 shrink-0">
              <button onClick={()=>setEditRec(null)} className="flex-1 border border-gray-200 text-gray-600 text-sm font-semibold py-3 rounded-xl hover:bg-gray-50">Cancel</button>
              <button onClick={saveEdit} disabled={saving} className="flex-1 bg-brand-700 text-white text-sm font-bold py-3 rounded-xl hover:bg-brand-600 disabled:opacity-60 active:scale-[0.98]">{saving?"Saving…":"Save Record"}</button>
            </div>
          </div>
        </div>
      )}

      {plan&&(()=>{
        const planPool=employees.filter(e=>e.status==="active"&&deptMatch(activeDept,e.department)&&e.name.toLowerCase().includes(plan.search.toLowerCase()));
        const allSelected=planPool.length>0&&planPool.every(e=>plan.empIds.includes(e.id));
        return (
        <div className="fixed inset-0 bg-slate-900/25 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={()=>setPlan(null)}>
          <div className="bg-white rounded-3xl w-full max-w-md shadow-2xl overflow-hidden max-h-[90vh] flex flex-col" onClick={e=>e.stopPropagation()}>
            <div className="bg-gradient-to-r from-brand-700 to-brand-900 px-7 py-5 flex items-center justify-between shrink-0">
              <div><h2 className="text-lg font-black text-white">Set Schedule / Day Off</h2><p className="text-brand-300 text-xs mt-0.5">Select employees and a date (today or upcoming)</p></div>
              <button onClick={()=>setPlan(null)} className="text-white/40 hover:text-white text-2xl">×</button>
            </div>
            <div className="p-7 space-y-4 overflow-y-auto flex-1">
              <div><label className="text-xs font-bold text-gray-500 uppercase tracking-wider block mb-1.5">Date</label>
                <input type="date" value={plan.date} min={TODAY} onChange={e=>setPlan(p=>({...p,date:e.target.value}))} className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-200"/></div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs font-bold text-gray-500 uppercase tracking-wider">Employees</label>
                  <button type="button" onClick={()=>setPlan(p=>({...p,empIds:allSelected?p.empIds.filter(id=>!planPool.some(e=>e.id===id)):[...new Set([...p.empIds,...planPool.map(e=>e.id)])]}))} className="text-xs text-brand-600 font-semibold hover:underline">{allSelected?"Deselect All":"Select All"}</button>
                </div>
                <input value={plan.search} onChange={e=>setPlan(p=>({...p,search:e.target.value}))} placeholder="Search employees…" className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none bg-gray-50 mb-2"/>
                <div className="max-h-48 overflow-y-auto space-y-1.5 border border-gray-100 rounded-xl p-2">
                  {planPool.length===0?<p className="text-xs text-gray-400 text-center py-3">No employees match.</p>:planPool.map(emp=>(
                    <label key={emp.id} className={`flex items-center gap-3 p-2.5 rounded-lg border cursor-pointer transition-colors ${plan.empIds.includes(emp.id)?"bg-brand-50 border-brand-200":"bg-gray-50 border-gray-200"}`}>
                      <input type="checkbox" checked={plan.empIds.includes(emp.id)} onChange={()=>setPlan(p=>({...p,empIds:p.empIds.includes(emp.id)?p.empIds.filter(x=>x!==emp.id):[...p.empIds,emp.id]}))} className="accent-brand-600 w-4 h-4"/>
                      <div><div className="text-sm font-semibold">{emp.name}</div><div className="text-xs text-gray-400">{emp.department}</div></div>
                    </label>
                  ))}
                </div>
                {plan.empIds.length>0&&<p className="text-xs text-brand-600 mt-1.5 font-medium">{plan.empIds.length} selected</p>}
              </div>

              <div>
                <label className="text-xs font-bold text-gray-500 uppercase tracking-wider block mb-2">Day Type</label>
                <div className="grid grid-cols-3 gap-2">
                  {[["normal","Normal","🗓"],["off","Day Off","🌴"],["work","Working","💼"]].map(([v,l,i])=>(
                    <button key={v} type="button" onClick={()=>setPlan(p=>({...p,type:v}))} className={`px-2 py-2.5 rounded-xl text-xs font-semibold border transition-colors ${plan.type===v?"bg-brand-700 text-white border-brand-700":"bg-gray-50 text-gray-600 border-gray-200 hover:border-brand-300"}`}>{i} {l}</button>
                  ))}
                </div>
                <p className="text-xs text-gray-400 mt-2">{plan.type==="off"?"Excused — shows Rest Day, not absent.":plan.type==="work"?"Expected in even if normally a rest day.":"Keeps their normal schedule."} Applies only to {fmtDate(plan.date)}.</p>
              </div>

              <div className="border-t border-gray-100 pt-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={plan.useShift} onChange={e=>setPlan(p=>({...p,useShift:e.target.checked}))} className="accent-brand-600 w-4 h-4"/>
                  <span className="text-sm font-bold text-gray-700">Custom shift times for this day</span>
                </label>
                {plan.useShift&&(
                  <div className="grid grid-cols-3 gap-3 mt-3">
                    <div><label className="text-xs font-bold text-gray-500 uppercase tracking-wider block mb-1.5">Start</label>
                      <input type="time" value={plan.shiftStart} onChange={e=>setPlan(p=>({...p,shiftStart:e.target.value}))} className="w-full border border-gray-200 rounded-xl px-2 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-200"/></div>
                    <div><label className="text-xs font-bold text-gray-500 uppercase tracking-wider block mb-1.5">End</label>
                      <input type="time" value={plan.shiftEnd} onChange={e=>setPlan(p=>({...p,shiftEnd:e.target.value}))} className="w-full border border-gray-200 rounded-xl px-2 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-200"/></div>
                    <div><label className="text-xs font-bold text-gray-500 uppercase tracking-wider block mb-1.5">Grace</label>
                      <input type="number" value={plan.gracePeriod} onChange={e=>setPlan(p=>({...p,gracePeriod:e.target.value}))} className="w-full border border-gray-200 rounded-xl px-2 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-200"/></div>
                  </div>
                )}
              </div>
            </div>
            <div className="flex gap-3 px-7 py-5 border-t border-gray-100 shrink-0">
              <button onClick={()=>setPlan(null)} className="flex-1 border border-gray-200 text-gray-600 text-sm font-semibold py-3 rounded-xl hover:bg-gray-50">Cancel</button>
              <button onClick={applyPlan} disabled={planSaving} className="flex-1 bg-brand-700 text-white text-sm font-bold py-3 rounded-xl hover:bg-brand-600 disabled:opacity-60 active:scale-[0.98]">{planSaving?"Saving…":`Apply to ${plan.empIds.length} Employee(s)`}</button>
            </div>
          </div>
        </div>
        );
      })()}
    </div>
  );
}
// ════════════════════════════════════════════════════════════════════════════
// PAYROLL — Philippine-law engine (see src/payroll.js) + per-tenant settings.
// ════════════════════════════════════════════════════════════════════════════
function printPayslip(slip, emp, company, periodLabel) {
  const w = window.open('', '_blank', 'width=720,height=900');
  if (!w) return;
  const rows = arr => arr.map(x=>`<tr><td>${x.label}</td><td class="amt">${peso(x.amount)}</td></tr>`).join('');
  w.document.write(`<!DOCTYPE html><html><head><title>Payslip — ${emp?.name||slip.employee_id}</title><style>
    body{font-family:'Segoe UI',sans-serif;color:#18191f;margin:32px;font-size:13px}
    .head{display:flex;justify-content:space-between;align-items:center;border-bottom:3px solid #5ac56b;padding-bottom:12px;margin-bottom:16px}
    .brand{font-size:20px;font-weight:800}.brand span{color:#3a9c49}
    h2{font-size:15px;margin:0}.muted{color:#717171;font-size:12px}
    table{width:100%;border-collapse:collapse;margin:10px 0}
    td{padding:6px 8px;border-bottom:1px solid #eee}.amt{text-align:right;font-variant-numeric:tabular-nums}
    .sec{font-weight:800;font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#3a9c49;margin-top:14px}
    .tot td{font-weight:800;border-top:2px solid #18191f;border-bottom:none}
    .net{background:#f0fcf2;border:2px solid #5ac56b;border-radius:10px;padding:12px 16px;display:flex;justify-content:space-between;font-size:16px;font-weight:800;margin-top:16px}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:4px 24px;font-size:12px}
    @media print{body{margin:12mm}}
  </style></head><body>
    <div class="head"><div class="brand">⚡ Bilis<span>Ops</span></div><div style="text-align:right"><h2>PAYSLIP</h2><div class="muted">${company||''}</div></div></div>
    <div class="grid">
      <div><b>${emp?.name||slip.employee_id}</b> · ${emp?.position||''}</div><div style="text-align:right">Pay period: <b>${periodLabel}</b></div>
      <div class="muted">${emp?.department||''} · ID ${slip.employee_id}</div><div class="muted" style="text-align:right">Monthly rate: ${peso(slip.data.meta.monthlyRate)}</div>
      <div class="muted">SSS ${emp?.sssNo||'—'} · PhilHealth ${emp?.philhealthNo||'—'}</div><div class="muted" style="text-align:right">Pag-IBIG ${emp?.pagibigNo||'—'} · TIN ${emp?.tinNo||'—'}</div>
    </div>
    <div class="sec">Earnings</div><table>${rows(slip.data.earnings)}<tr class="tot"><td>Gross Pay</td><td class="amt">${peso(slip.gross)}</td></tr></table>
    <div class="sec">Deductions</div><table>${rows(slip.data.deductions)}<tr class="tot"><td>Total Deductions</td><td class="amt">${peso(slip.deductions)}</td></tr></table>
    <div class="net"><span>NET PAY</span><span>${peso(slip.net)}</span></div>
    <p class="muted" style="margin-top:20px">Employer contributions this month: SSS ${peso(slip.data.meta.employer.sss)} + EC ${peso(slip.data.meta.employer.ec)} · PhilHealth ${peso(slip.data.meta.employer.philhealth)} · Pag-IBIG ${peso(slip.data.meta.employer.pagibig)}</p>
    <p class="muted">Generated by BilisOps · This is a system-generated payslip.</p>
    <script>window.onload=()=>window.print()</script>
  </body></html>`);
  w.document.close();
}

// HR documents (COE, NTE, Contract) — printable, filled from employee data.
function printDocument(type, emp, company, f) {
  const w = window.open('', '_blank', 'width=760,height=940'); if (!w) return;
  const today = new Date().toLocaleDateString('en-PH', { year:'numeric', month:'long', day:'numeric' });
  const start = emp.startDate ? new Date(emp.startDate+'T00:00:00').toLocaleDateString('en-PH',{year:'numeric',month:'long',day:'numeric'}) : '____________';
  const co = company || '____________';
  let title='', body='';
  if (type==='coe' || type==='coe-comp') {
    title='CERTIFICATE OF EMPLOYMENT';
    body=`<p>TO WHOM IT MAY CONCERN:</p>
    <p>This is to certify that <b>${emp.name}</b> is employed by <b>${co}</b> as <b>${emp.position||'____________'}</b>${emp.department?` in the ${emp.department} department`:''}, from <b>${start}</b> up to the present.</p>
    ${type==='coe-comp'?`<p>${emp.name.split(' ')[0]} receives a monthly compensation of <b>${peso(emp.monthlyRate||0)}</b>.</p>`:''}
    <p>This certification is issued upon the request of the above-named employee for <b>${f.purpose||'whatever legal purpose it may serve'}</b>.</p>
    <p>Issued this ${today}.</p>`;
  } else if (type==='nte') {
    title='NOTICE TO EXPLAIN';
    body=`<p>Date: ${today}</p><p>To: <b>${emp.name}</b> — ${emp.position||''}${emp.department?`, ${emp.department}`:''}</p>
    <p>You are hereby directed to explain in writing, within <b>five (5) calendar days</b> from receipt of this notice, why no disciplinary action should be taken against you for the following incident:</p>
    <div class="box"><p><b>Date of incident:</b> ${f.incidentDate||'____________'}</p><p>${(f.details||'').replace(/\n/g,'<br>')||'____________'}</p></div>
    <p>Failure to submit your written explanation within the given period shall be deemed a waiver of your right to be heard, and the company shall decide based on available records.</p>
    <p>You may also indicate whether you request a conference/hearing on the matter.</p>`;
  } else {
    title='EMPLOYMENT AGREEMENT';
    body=`<p>This Employment Agreement is entered into on ${today} between <b>${co}</b> (the "Employer") and <b>${emp.name}</b> (the "Employee").</p>
    <p><b>1. Position.</b> The Employee is engaged as <b>${emp.position||'____________'}</b>${emp.department?` in the ${emp.department} department`:''}, starting <b>${start}</b>.</p>
    <p><b>2. Compensation.</b> The Employee shall receive a monthly salary of <b>${peso(emp.monthlyRate||0)}</b>, payable per the Employer's payroll schedule, less lawful deductions (SSS, PhilHealth, Pag-IBIG, withholding tax).</p>
    <p><b>3. Work schedule.</b> ${emp.schedule?.shiftStart||'08:00'}–${emp.schedule?.shiftEnd||'17:00'}, rest day(s): ${(emp.schedule?.restDays||[]).join(', ')||'per company policy'}.</p>
    <p><b>4. Benefits.</b> The Employee is entitled to benefits mandated by Philippine law, including 13th month pay and service incentive leave.</p>
    <p><b>5. Company policies.</b> The Employee agrees to abide by the Employer's code of conduct and policies, as amended from time to time.</p>
    <p style="margin-top:36px">SIGNED:</p>
    <table class="sig"><tr><td>_______________________<br><b>${emp.name}</b><br>Employee</td><td>_______________________<br><b>${f.signatory||'____________'}</b><br>${f.signatoryTitle||'Authorized Representative'}, ${co}</td></tr></table>`;
  }
  w.document.write(`<!DOCTYPE html><html><head><title>${title} — ${emp.name}</title><style>
    body{font-family:'Segoe UI',serif;color:#18191f;margin:48px;font-size:14px;line-height:1.7}
    .head{display:flex;justify-content:space-between;align-items:center;border-bottom:3px solid #5ac56b;padding-bottom:12px;margin-bottom:28px}
    .brand{font-size:18px;font-weight:800}.brand span{color:#3a9c49}.co{font-size:13px;color:#717171}
    h1{font-size:17px;letter-spacing:.12em;text-align:center;margin:0 0 24px}
    p{margin:0 0 14px}.box{border:1px solid #ccc;border-radius:8px;padding:12px 16px;margin:0 0 14px}
    .sig{width:100%;margin-top:28px}.sig td{width:50%;padding-top:40px}
    .sign{margin-top:56px}
    @media print{body{margin:20mm}}
  </style></head><body>
    <div class="head"><div class="brand">⚡ Bilis<span>Ops</span></div><div class="co">${co}</div></div>
    <h1>${title}</h1>${body}
    ${type!=='contract'?`<div class="sign"><p>_______________________<br><b>${f.signatory||'____________'}</b><br>${f.signatoryTitle||'Authorized Representative'}</p></div>`:''}
    <script>window.onload=()=>window.print()</script>
  </body></html>`);
  w.document.close();
}

function AdminPayroll({ employees, allAttendance, leaves, addToast, adminUser }) {
  const [view,setView]=useState("runs"); // runs | settings
  const [settings,setSettings]=useState(null);
  const [runs,setRuns]=useState([]); const [loading,setLoading]=useState(true);
  const [company,setCompany]=useState("");
  const [preview,setPreview]=useState(null); // {periodStart,periodEnd,slips:[{employee_id,data,gross,deductions,net}]}
  const [viewRun,setViewRun]=useState(null); // {run, slips}
  const [slipModal,setSlipModal]=useState(null); // {slip, emp}
  const [busy,setBusy]=useState(false); const [confirmDel,setConfirmDel]=useState(null);
  const TODAY=getToday();
  const empById=Object.fromEntries(employees.map(e=>[e.id,e]));

  const load=useCallback(async()=>{
    setLoading(true);
    // Tenant admins are auto-scoped to their row; the super admin (no tenant)
    // must target the platform's own settings row or maybeSingle() breaks the
    // moment two tenants have saved settings.
    let stQuery=supabase.from('payroll_settings').select('*');
    if(!getTenant()) stQuery=stQuery.eq('tenant_id','00000000-0000-0000-0000-000000000000');
    const [{data:st},{data:rn}]=await Promise.all([
      stQuery.maybeSingle(),
      supabase.from('payroll_runs').select('*').order('period_start',{ascending:false}).limit(24),
    ]);
    setSettings(mergeSettings(st?.settings));
    setRuns(rn||[]);
    if(adminUser?.tenantId){ const {data:reg}=await supabase.from('registrations').select('company').eq('id',adminUser.tenantId).maybeSingle(); setCompany(reg?.company||""); }
    setLoading(false);
  },[adminUser?.tenantId]);
  useEffect(()=>{ load(); },[load]);

  const saveSettings=async(next)=>{
    const toSave=next||settings;
    setBusy(true);
    const {error}=await supabase.from('payroll_settings').upsert({settings:toSave, updated_at:new Date().toISOString()},{onConflict:'tenant_id'});
    setBusy(false);
    if(error){ addToast("Failed to save: "+error.message,"error"); return; }
    addToast("Payroll settings saved.","success");
  };
  // Platform pushed new government tables? Offer a one-click apply that keeps
  // the tenant's own customizations (pay basis, premiums, extra holidays).
  const ratesOutdated=settings&&settings.ratesVersion!==PH_PAYROLL_DEFAULTS.ratesVersion;
  const applyRates=async()=>{ const next=applyStatutoryUpdate(settings); setSettings(next); await saveSettings(next); addToast(`Government rates updated to ${PH_PAYROLL_DEFAULTS.ratesVersion}.`,"success"); };

  // ── Build a run preview from attendance ────────────────────────────────────
  const makePreview=(periodStart,periodEnd,periodsPerMonth)=>{
    const S=settings;
    const active=employees.filter(e=>e.status==="active");
    const paid=active.filter(e=>(Number(e.monthlyRate)||0)>0);
    const skipped=active.length-paid.length;
    const isSecondHalf=Number(periodEnd.slice(8,10))>15;
    const deductContributions=periodsPerMonth===1?true:(S.deductions.contributionsCutoff==='second'?isSecondHalf:S.deductions.contributionsCutoff==='first'?!isSecondHalf:true);
    const slips=paid.map(emp=>{
      const rows=[];
      for(const [date,recs] of Object.entries(allAttendance)){
        if(date>=periodStart&&date<=periodEnd&&recs[emp.id]) rows.push(recs[emp.id]);
      }
      const approved=(leaves||[]).filter(l=>l.employee_id===emp.id&&(l.status??'approved')==='approved');
      const data=computePayslip(emp,rows,approved,S,{periodStart,periodEnd,deductContributions,periodsPerMonth});
      return {employee_id:emp.id, data, gross:data.gross, deductions:data.totalDeductions, net:data.net};
    });
    setPreview({periodStart,periodEnd,slips,skipped});
  };

  const periodPresets=()=>{
    const [y,m]=[TODAY.slice(0,4),TODAY.slice(5,7)];
    const last=new Date(Number(y),Number(m),0).getDate();
    return [
      {l:`${m}/01 – ${m}/15`, s:`${y}-${m}-01`, e:`${y}-${m}-15`, ppm:2},
      {l:`${m}/16 – ${m}/${last}`, s:`${y}-${m}-16`, e:`${y}-${m}-${String(last).padStart(2,'0')}`, ppm:2},
      {l:`Full month ${m}/${y}`, s:`${y}-${m}-01`, e:`${y}-${m}-${String(last).padStart(2,'0')}`, ppm:1},
    ];
  };

  const saveRun=async(finalize)=>{
    if(!preview?.slips?.length){ addToast("Nothing to save — no employees with a monthly rate.","error"); return; }
    setBusy(true);
    const {data:ins,error}=await supabase.from('payroll_runs').insert({period_start:preview.periodStart,period_end:preview.periodEnd,pay_date:TODAY,status:finalize?'final':'draft',created_by:adminUser.username});
    if(error){ setBusy(false); addToast("Failed: "+error.message,"error"); return; }
    // The real client returns no rows unless .select() is chained; the stub returns them.
    let runId=ins?.[0]?.id;
    if(!runId){
      const {data:latest}=await supabase.from('payroll_runs').select('*').order('created_at',{ascending:false}).limit(1);
      runId=latest?.[0]?.id;
    }
    if(!runId){ setBusy(false); addToast("Failed: could not read back the new run.","error"); return; }
    const {error:e2}=await supabase.from('payslips').insert(preview.slips.map(s=>({run_id:runId,employee_id:s.employee_id,data:s.data,gross:s.gross,deductions:s.deductions,net:s.net})));
    setBusy(false);
    if(e2){ addToast("Failed to save payslips: "+e2.message,"error"); return; }
    await logAudit(adminUser,'payroll_run_created',null,`${preview.periodStart} → ${preview.periodEnd} (${preview.slips.length} payslips${finalize?', finalized':', draft'})`);
    addToast(finalize?"Payroll run finalized — payslips are now visible to employees.":"Payroll run saved as draft.","success");
    setPreview(null); load();
  };

  const openRun=async run=>{
    const {data}=await supabase.from('payslips').select('*').eq('run_id',run.id).order('employee_id');
    setViewRun({run, slips:data||[]});
  };
  const finalizeRun=async run=>{ await supabase.from('payroll_runs').update({status:'final'}).eq('id',run.id); addToast("Run finalized — employees can now see their payslips.","success"); setViewRun(null); load(); };
  const deleteRun=async()=>{ const run=confirmDel; setConfirmDel(null); await supabase.from('payslips').delete().eq('run_id',run.id); await supabase.from('payroll_runs').delete().eq('id',run.id); addToast("Run deleted.","info"); setViewRun(null); load(); };
  const periodLabel=r=>`${fmtDate(r.period_start||r.periodStart)} – ${fmtDate(r.period_end||r.periodEnd)}`;

  const num=(v,def=0)=>{const n=Number(v);return Number.isFinite(n)?n:def;};
  const setS=(path,v)=>setSettings(p=>{ const c=JSON.parse(JSON.stringify(p)); const ks=path.split('.'); let o=c; while(ks.length>1)o=o[ks.shift()]; o[ks[0]]=v; return c; });

  // ── Reports: government files, bank disbursement, alphalist, 13th month ─────
  const [repRunId,setRepRunId]=useState(""); const [repSlips,setRepSlips]=useState([]);
  const [repYear,setRepYear]=useState(TODAY.slice(0,4)); const [yearData,setYearData]=useState(null);
  useEffect(()=>{ if(!repRunId){setRepSlips([]);return;} supabase.from('payslips').select('*').eq('run_id',repRunId).then(({data})=>setRepSlips(data||[])); },[repRunId]);
  const loadYear=async()=>{
    const {data:yrRuns}=await supabase.from('payroll_runs').select('*').gte('period_start',`${repYear}-01-01`).lte('period_start',`${repYear}-12-31`);
    const finals=(yrRuns||[]).filter(r=>r.status==='final');
    let slips=[];
    for(const r of finals){ const {data}=await supabase.from('payslips').select('*').eq('run_id',r.id); slips=slips.concat(data||[]); }
    setYearData({runs:finals.length, slips});
  };
  const dedAmt=(s,label)=>(s.data?.deductions||[]).filter(d=>d.label.startsWith(label)).reduce((a,d)=>a+d.amount,0);
  const basicAmt=s=>(s.data?.earnings||[]).filter(e=>e.label.startsWith('Basic pay')).reduce((a,e)=>a+e.amount,0);
  const dlCSV=(name,rows)=>{
    const csv=rows.map(r=>r.map(c=>{const v=String(c??'');return /[",\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v;}).join(',')).join('\r\n');
    const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob(["﻿"+csv],{type:'text/csv'})); a.download=name; a.click(); URL.revokeObjectURL(a.href);
  };
  const repRun=runs.find(r=>r.id===repRunId);
  const repTag=repRun?`${repRun.period_start}_${repRun.period_end}`:'';
  const dlSSS=()=>dlCSV(`SSS_${repTag}.csv`,[["Employee ID","Name","SSS No.","MSC","EE Share (this run)","ER Share (monthly)","EC (monthly)"],
    ...repSlips.map(s=>{const e=empById[s.employee_id];const c=computeSSS(s.data.meta.monthlyRate,settings);return [s.employee_id,e?.name||'',e?.sssNo||'',c.msc,dedAmt(s,'SSS').toFixed(2),c.employer.toFixed(2),c.ec];})]);
  const dlPH=()=>dlCSV(`PhilHealth_${repTag}.csv`,[["Employee ID","Name","PhilHealth No.","Monthly Basic","EE Share (this run)","ER Share (monthly)"],
    ...repSlips.map(s=>{const e=empById[s.employee_id];const c=computePhilHealth(s.data.meta.monthlyRate,settings);return [s.employee_id,e?.name||'',e?.philhealthNo||'',s.data.meta.monthlyRate,dedAmt(s,'PhilHealth').toFixed(2),c.employer.toFixed(2)];})]);
  const dlPG=()=>dlCSV(`PagIBIG_${repTag}.csv`,[["Employee ID","Name","Pag-IBIG MID","EE Share (this run)","ER Share (monthly)"],
    ...repSlips.map(s=>{const e=empById[s.employee_id];const c=computePagibig(s.data.meta.monthlyRate,settings);return [s.employee_id,e?.name||'',e?.pagibigNo||'',dedAmt(s,'Pag-IBIG').toFixed(2),c.employer.toFixed(2)];})]);
  const dl1601=()=>{const gross=repSlips.reduce((a,s)=>a+Number(s.gross),0);const allow=repSlips.reduce((a,s)=>a+(s.data?.earnings||[]).filter(e=>/Allowance/.test(e.label)).reduce((x,e)=>x+e.amount,0),0);const tax=repSlips.reduce((a,s)=>a+dedAmt(s,'Withholding tax'),0);const stat=repSlips.reduce((a,s)=>a+dedAmt(s,'SSS')+dedAmt(s,'PhilHealth')+dedAmt(s,'Pag-IBIG'),0);
    dlCSV(`BIR1601C_summary_${repTag}.csv`,[["Item","Amount"],["Total compensation",gross.toFixed(2)],["Non-taxable allowances",allow.toFixed(2)],["Statutory contributions (EE)",stat.toFixed(2)],["Taxable compensation",(gross-allow-stat).toFixed(2)],["Tax withheld",tax.toFixed(2)],["Employees",repSlips.length]]);};
  const dlBank=()=>dlCSV(`BankDisbursement_${repTag}.csv`,[["Bank","Account Number","Account Name","Amount"],
    ...repSlips.map(s=>{const e=empById[s.employee_id];return [e?.bankName||'',e?.bankAccount||'',e?.name||s.employee_id,Number(s.net).toFixed(2)];})]);
  const dl13th=()=>{if(!yearData)return;const per={};yearData.slips.forEach(s=>{per[s.employee_id]=(per[s.employee_id]||0)+basicAmt(s);});
    dlCSV(`13thMonth_accrual_${repYear}.csv`,[["Employee ID","Name","Basic Earned (finalized)","13th Month Accrued"],
    ...Object.entries(per).map(([id,b])=>[id,empById[id]?.name||'',b.toFixed(2),(b/12).toFixed(2)])]);};
  const dlAlpha=()=>{if(!yearData)return;const per={};yearData.slips.forEach(s=>{const p=per[s.employee_id]||(per[s.employee_id]={gross:0,sss:0,ph:0,pg:0,tax:0});p.gross+=Number(s.gross);p.sss+=dedAmt(s,'SSS');p.ph+=dedAmt(s,'PhilHealth');p.pg+=dedAmt(s,'Pag-IBIG');p.tax+=dedAmt(s,'Withholding tax');});
    dlCSV(`Alphalist_${repYear}.csv`,[["Employee ID","Name","TIN","Gross Compensation","SSS (EE)","PhilHealth (EE)","Pag-IBIG (EE)","Tax Withheld"],
    ...Object.entries(per).map(([id,p])=>[id,empById[id]?.name||'',empById[id]?.tinNo||'',p.gross.toFixed(2),p.sss.toFixed(2),p.ph.toFixed(2),p.pg.toFixed(2),p.tax.toFixed(2)])]);};

  if(loading||!settings) return <div className="text-center py-20 text-gray-400 text-sm">Loading payroll…</div>;

  return (
    <div>
      {ratesOutdated&&(
        <div className="bg-amber-50 border border-amber-200 rounded-2xl px-5 py-4 mb-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="text-sm text-amber-800"><b>Updated government rates are available</b> (v{PH_PAYROLL_DEFAULTS.ratesVersion}). Applying updates SSS, PhilHealth, Pag-IBIG, the tax table, and the holiday calendar — your own customizations are kept. Finalized payslips are never changed.</div>
          <button disabled={busy} onClick={applyRates} className="shrink-0 bg-brand-500 text-white text-xs font-bold px-4 py-2.5 rounded-xl hover:bg-brand-600 disabled:opacity-50 shadow-brand">Apply update</button>
        </div>
      )}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-5">
        <div>
          <h1 className="text-xl font-black text-ink flex items-center gap-2"><Icon name="payroll" className="w-5 h-5 text-brand-600"/> Payroll</h1>
          <p className="text-sm text-gray-500 mt-0.5">Philippine statutory payroll — computed straight from attendance.</p>
        </div>
        <div className="flex gap-2">
          {[["runs","Pay Runs"],["reports","Reports"],["settings","Settings"]].map(([k,l])=>(
            <button key={k} onClick={()=>setView(k)} className={`px-4 py-2 rounded-xl text-xs font-bold border transition-colors ${view===k?"bg-brand-500 text-white border-brand-500":"bg-white text-gray-600 border-gray-200 hover:border-brand-300"}`}>{l}</button>
          ))}
        </div>
      </div>

      {view==="runs"&&(
        <div className="space-y-5">
          {/* New run */}
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
            <h2 className="font-bold text-gray-800 mb-1">New pay run</h2>
            <p className="text-xs text-gray-400 mb-4">Pick a period — pay is computed for every active employee with a monthly rate (set it in Employees → Edit → Pay).</p>
            <div className="flex gap-2 flex-wrap">
              {periodPresets().map(p=>(
                <button key={p.l} onClick={()=>makePreview(p.s,p.e,p.ppm)} className="px-4 py-2.5 rounded-xl text-xs font-bold border bg-gray-50 text-gray-700 border-gray-200 hover:border-brand-400 hover:bg-brand-50 transition-colors">{p.l}</button>
              ))}
            </div>
            {preview&&(
              <div className="mt-5 border-t border-gray-100 pt-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="font-bold text-sm text-gray-800">Preview — {fmtDate(preview.periodStart)} to {fmtDate(preview.periodEnd)} <span className="text-gray-400 font-normal">({preview.slips.length} employees{preview.skipped>0?`, ${preview.skipped} skipped — no rate set`:''})</span></div>
                  <div className="flex gap-2">
                    <button disabled={busy} onClick={()=>saveRun(false)} className="px-4 py-2 rounded-xl text-xs font-bold border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-50">Save draft</button>
                    <button disabled={busy} onClick={()=>saveRun(true)} className="px-4 py-2 rounded-xl text-xs font-bold bg-brand-500 text-white hover:bg-brand-600 disabled:opacity-50 shadow-brand">{busy?"Saving…":"Finalize & release"}</button>
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead><tr className="border-b border-gray-100 bg-gray-50/60">{["Employee","Gross","Deductions","Net",""].map(h=><th key={h} className="text-left text-xs font-semibold text-gray-400 uppercase tracking-wider px-4 py-2.5">{h}</th>)}</tr></thead>
                    <tbody className="divide-y divide-gray-50">
                      {preview.slips.map(s=>(
                        <tr key={s.employee_id} className="hover:bg-gray-50/60">
                          <td className="px-4 py-3"><div className="font-semibold text-gray-800">{empById[s.employee_id]?.name||s.employee_id}</div><div className="text-xs text-gray-400">{empById[s.employee_id]?.department}</div></td>
                          <td className="px-4 py-3 font-mono text-xs">{peso(s.gross)}</td>
                          <td className="px-4 py-3 font-mono text-xs text-red-600">−{peso(s.deductions)}</td>
                          <td className="px-4 py-3 font-mono text-xs font-bold text-brand-700">{peso(s.net)}</td>
                          <td className="px-4 py-3"><button onClick={()=>setSlipModal({slip:s, emp:empById[s.employee_id], label:`${fmtDate(preview.periodStart)} – ${fmtDate(preview.periodEnd)}`})} className="text-xs font-bold text-brand-600 hover:text-brand-700">View</button></td>
                        </tr>
                      ))}
                      {preview.slips.length===0&&<tr><td colSpan={5} className="text-center py-8 text-gray-400 text-sm">No employees with a monthly rate yet — set rates in Employees → Edit → Pay.</td></tr>}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>

          {/* Past runs */}
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-100"><h2 className="font-bold text-gray-800">Pay runs <span className="opacity-40">({runs.length})</span></h2></div>
            <table className="w-full text-sm">
              <thead><tr className="border-b border-gray-100 bg-gray-50/60">{["Period","Created","Status","Actions"].map(h=><th key={h} className="text-left text-xs font-semibold text-gray-400 uppercase tracking-wider px-5 py-3">{h}</th>)}</tr></thead>
              <tbody className="divide-y divide-gray-50">
                {runs.length===0?<tr><td colSpan={4} className="text-center py-10 text-gray-400 text-sm">No pay runs yet — create your first one above.</td></tr>
                 :runs.map(r=>(
                  <tr key={r.id} className="hover:bg-gray-50/60">
                    <td className="px-5 py-3.5 font-semibold text-gray-800">{periodLabel(r)}</td>
                    <td className="px-5 py-3.5 text-xs text-gray-500">{r.created_by||"—"} · {r.created_at?fmtDate(String(r.created_at).slice(0,10)):""}</td>
                    <td className="px-5 py-3.5"><span className={`text-xs font-bold px-2.5 py-1 rounded-full border ${r.status==='final'?"bg-brand-50 text-brand-700 border-brand-200":"bg-amber-50 text-amber-700 border-amber-200"}`}>{r.status==='final'?'Finalized':'Draft'}</span></td>
                    <td className="px-5 py-3.5">
                      <div className="flex gap-1.5">
                        <button onClick={()=>openRun(r)} className="text-xs font-bold px-3 py-1.5 rounded-lg bg-gray-100 text-gray-700 hover:bg-gray-200">Open</button>
                        {r.status!=='final'&&<button onClick={()=>finalizeRun(r)} className="text-xs font-bold px-3 py-1.5 rounded-lg bg-brand-500 text-white hover:bg-brand-600">Finalize</button>}
                        <button onClick={()=>setConfirmDel(r)} className="text-gray-400 hover:text-red-600 p-1.5 rounded-lg hover:bg-red-50"><Icon name="trash" className="w-4 h-4"/></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {view==="reports"&&(
        <div className="space-y-5">
          {/* Per-run government + bank files */}
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
            <h2 className="font-bold text-gray-800 mb-1">Government &amp; bank files</h2>
            <p className="text-xs text-gray-400 mb-4">Pick a pay run, then download remittance-ready CSVs. EE shares are what was actually deducted in that run; ER shares are monthly figures.</p>
            <select value={repRunId} onChange={e=>setRepRunId(e.target.value)} className="w-full max-w-md border border-gray-200 rounded-xl px-3 py-2.5 text-sm mb-4">
              <option value="">Select a pay run…</option>
              {runs.map(r=><option key={r.id} value={r.id}>{periodLabel(r)} — {r.status==='final'?'Finalized':'Draft'}</option>)}
            </select>
            {repRunId&&(
              <div className="flex flex-wrap gap-2">
                <button onClick={dlSSS} className="text-xs font-bold px-4 py-2.5 rounded-xl bg-brand-500 text-white hover:bg-brand-600">↓ SSS contributions</button>
                <button onClick={dlPH} className="text-xs font-bold px-4 py-2.5 rounded-xl bg-brand-500 text-white hover:bg-brand-600">↓ PhilHealth</button>
                <button onClick={dlPG} className="text-xs font-bold px-4 py-2.5 rounded-xl bg-brand-500 text-white hover:bg-brand-600">↓ Pag-IBIG</button>
                <button onClick={dl1601} className="text-xs font-bold px-4 py-2.5 rounded-xl bg-brand-500 text-white hover:bg-brand-600">↓ BIR 1601-C summary</button>
                <button onClick={dlBank} className="text-xs font-bold px-4 py-2.5 rounded-xl bg-ink text-white hover:bg-gray-700">↓ Bank disbursement file</button>
              </div>
            )}
            {repRunId&&repSlips.some(s=>!empById[s.employee_id]?.bankAccount)&&(
              <p className="text-xs text-amber-600 mt-3">⚠ Some employees have no bank account on file (Employees → Edit → Pay) — their rows in the bank file will be blank.</p>
            )}
          </div>

          {/* Annual: 13th month + alphalist */}
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
            <h2 className="font-bold text-gray-800 mb-1">Year-end &amp; 13th month</h2>
            <p className="text-xs text-gray-400 mb-4">Built from finalized pay runs of the year. 13th month = total basic earned ÷ 12, tracked all year — due by December 24.</p>
            <div className="flex items-center gap-2 mb-4">
              <input type="number" value={repYear} onChange={e=>setRepYear(e.target.value)} className="w-28 border border-gray-200 rounded-xl px-3 py-2.5 text-sm"/>
              <button onClick={loadYear} className="text-xs font-bold px-4 py-2.5 rounded-xl bg-gray-100 text-gray-700 hover:bg-gray-200">Load year</button>
              {yearData&&<span className="text-xs text-gray-400">{yearData.runs} finalized run(s) · {yearData.slips.length} payslips</span>}
            </div>
            {yearData&&(()=>{ const per={}; yearData.slips.forEach(s=>{per[s.employee_id]=(per[s.employee_id]||0)+basicAmt(s);}); const entries=Object.entries(per);
              return entries.length===0?<p className="text-sm text-gray-400">No finalized payslips in {repYear} yet.</p>:(
              <>
                <div className="overflow-x-auto mb-3"><table className="w-full max-w-2xl text-sm">
                  <thead><tr className="border-b border-gray-100 bg-gray-50/60">{["Employee","Basic earned","13th month accrued"].map(h=><th key={h} className="text-left text-xs font-semibold text-gray-400 uppercase tracking-wider px-4 py-2.5">{h}</th>)}</tr></thead>
                  <tbody className="divide-y divide-gray-50">
                    {entries.map(([id,b])=>(
                      <tr key={id}><td className="px-4 py-2.5 font-semibold text-gray-800">{empById[id]?.name||id}</td><td className="px-4 py-2.5 font-mono text-xs">{peso(b)}</td><td className="px-4 py-2.5 font-mono text-xs font-bold text-brand-700">{peso(b/12)}</td></tr>
                    ))}
                    <tr className="bg-brand-50/50"><td className="px-4 py-2.5 font-black text-ink">Total</td><td className="px-4 py-2.5 font-mono text-xs font-bold">{peso(entries.reduce((a,[,b])=>a+b,0))}</td><td className="px-4 py-2.5 font-mono text-xs font-black text-brand-700">{peso(entries.reduce((a,[,b])=>a+b,0)/12)}</td></tr>
                  </tbody>
                </table></div>
                <div className="flex gap-2">
                  <button onClick={dl13th} className="text-xs font-bold px-4 py-2.5 rounded-xl bg-brand-500 text-white hover:bg-brand-600">↓ 13th month CSV</button>
                  <button onClick={dlAlpha} className="text-xs font-bold px-4 py-2.5 rounded-xl bg-brand-500 text-white hover:bg-brand-600">↓ Alphalist CSV</button>
                </div>
              </>
            );})()}
          </div>
        </div>
      )}

      {view==="settings"&&(
        <div className="space-y-5">
          <div className="bg-brand-50 border border-brand-100 rounded-2xl px-5 py-4 text-sm text-brand-800">
            Pre-loaded with the <b>2026 Philippine statutory defaults</b> (SSS 15%, PhilHealth 5%, Pag-IBIG 2%/2%, TRAIN tax table, DOLE premium rates). Edit anything — new pay runs use your values; finalized payslips are never changed retroactively.
          </div>
          <div className="grid md:grid-cols-2 gap-5">
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 space-y-3">
              <h3 className="font-bold text-gray-800">Pay basis</h3>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="text-xs font-bold text-gray-500 uppercase block mb-1">Frequency</label>
                  <select value={settings.payFrequency} onChange={e=>setS('payFrequency',e.target.value)} className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm"><option value="semi-monthly">Semi-monthly</option><option value="monthly">Monthly</option></select></div>
                <div><label className="text-xs font-bold text-gray-500 uppercase block mb-1">Work days / month</label>
                  <input type="number" value={settings.workDaysPerMonth} onChange={e=>setS('workDaysPerMonth',num(e.target.value,26))} className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm"/></div>
                <div><label className="text-xs font-bold text-gray-500 uppercase block mb-1">Hours / day</label>
                  <input type="number" value={settings.hoursPerDay} onChange={e=>setS('hoursPerDay',num(e.target.value,8))} className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm"/></div>
                <div><label className="text-xs font-bold text-gray-500 uppercase block mb-1">Contributions cutoff</label>
                  <select value={settings.deductions.contributionsCutoff} onChange={e=>setS('deductions.contributionsCutoff',e.target.value)} className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm"><option value="second">2nd half</option><option value="first">1st half</option><option value="split">Split 50/50</option></select></div>
              </div>
              <label className="flex items-center gap-2 text-sm text-gray-700"><input type="checkbox" checked={settings.deductions.deductLates} onChange={e=>setS('deductions.deductLates',e.target.checked)} className="accent-brand-600"/> Deduct lates (per minute)</label>
              <label className="flex items-center gap-2 text-sm text-gray-700"><input type="checkbox" checked={settings.deductions.deductAbsences} onChange={e=>setS('deductions.deductAbsences',e.target.checked)} className="accent-brand-600"/> Deduct absences (daily rate)</label>
            </div>

            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 space-y-3">
              <h3 className="font-bold text-gray-800">Labor Code premiums (%)</h3>
              <div className="grid grid-cols-2 gap-3">
                {[["premiums.overtimePct","Overtime"],["premiums.nightDiffPct","Night diff (10PM–6AM)"],["premiums.restDayPct","Rest day worked"],["premiums.specialHolidayPct","Special day worked"],["premiums.regularHolidayPct","Regular holiday worked"]].map(([p,l])=>(
                  <div key={p}><label className="text-xs font-bold text-gray-500 uppercase block mb-1">{l}</label>
                    <input type="number" value={p.split('.').reduce((o,k)=>o[k],settings)} onChange={e=>setS(p,num(e.target.value))} className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm"/></div>
                ))}
              </div>
              <label className="flex items-center gap-2 text-sm text-gray-700"><input type="checkbox" checked={settings.premiums.regularHolidayUnworkedPaid} onChange={e=>setS('premiums.regularHolidayUnworkedPaid',e.target.checked)} className="accent-brand-600"/> Regular holidays paid even if unworked</label>
            </div>

            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 space-y-3">
              <h3 className="font-bold text-gray-800">SSS</h3>
              <div className="grid grid-cols-2 gap-3">
                {[["sss.rateEmployee","Employee %"],["sss.rateEmployer","Employer %"],["sss.mscFloor","MSC floor ₱"],["sss.mscCeiling","MSC ceiling ₱"],["sss.ecSmall","EC below threshold ₱"],["sss.ecBig","EC at/above ₱"],["sss.ecThreshold","EC threshold ₱"],["sss.mscStep","MSC step ₱"]].map(([p,l])=>(
                  <div key={p}><label className="text-xs font-bold text-gray-500 uppercase block mb-1">{l}</label>
                    <input type="number" value={p.split('.').reduce((o,k)=>o[k],settings)} onChange={e=>setS(p,num(e.target.value))} className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm"/></div>
                ))}
              </div>
            </div>

            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 space-y-4">
              <div>
                <h3 className="font-bold text-gray-800 mb-2">PhilHealth</h3>
                <div className="grid grid-cols-2 gap-3">
                  {[["philhealth.rateTotal","Total premium %"],["philhealth.employeeSharePct","Employee share %"],["philhealth.salaryFloor","Salary floor ₱"],["philhealth.salaryCeiling","Salary ceiling ₱"]].map(([p,l])=>(
                    <div key={p}><label className="text-xs font-bold text-gray-500 uppercase block mb-1">{l}</label>
                      <input type="number" value={p.split('.').reduce((o,k)=>o[k],settings)} onChange={e=>setS(p,num(e.target.value))} className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm"/></div>
                  ))}
                </div>
              </div>
              <div>
                <h3 className="font-bold text-gray-800 mb-2">Pag-IBIG</h3>
                <div className="grid grid-cols-3 gap-3">
                  {[["pagibig.rateEmployee","Employee %"],["pagibig.rateEmployer","Employer %"],["pagibig.salaryCap","Salary cap ₱"]].map(([p,l])=>(
                    <div key={p}><label className="text-xs font-bold text-gray-500 uppercase block mb-1">{l}</label>
                      <input type="number" value={p.split('.').reduce((o,k)=>o[k],settings)} onChange={e=>setS(p,num(e.target.value))} className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm"/></div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
            <h3 className="font-bold text-gray-800 mb-1">Withholding tax brackets (annual, TRAIN law)</h3>
            <p className="text-xs text-gray-400 mb-3">tax = base + rate% × (taxable − over). Edit if the law changes.</p>
            <div className="overflow-x-auto"><table className="text-sm w-full max-w-xl">
              <thead><tr className="text-xs text-gray-400 uppercase"><th className="text-left px-2 py-1">Over ₱</th><th className="text-left px-2 py-1">Base tax ₱</th><th className="text-left px-2 py-1">Rate %</th><th/></tr></thead>
              <tbody>
                {settings.taxBrackets.map((b,i)=>(
                  <tr key={i}>
                    {["over","base","rate"].map(k=>(
                      <td key={k} className="px-2 py-1"><input type="number" value={b[k]} onChange={e=>{const v=num(e.target.value);setSettings(p=>{const c=JSON.parse(JSON.stringify(p));c.taxBrackets[i][k]=v;return c;});}} className="w-32 border border-gray-200 rounded-lg px-2 py-1.5 text-xs font-mono"/></td>
                    ))}
                    <td><button onClick={()=>setSettings(p=>({...p,taxBrackets:p.taxBrackets.filter((_,j)=>j!==i)}))} className="text-gray-300 hover:text-red-500 px-2">✕</button></td>
                  </tr>
                ))}
              </tbody>
            </table></div>
            <button onClick={()=>setSettings(p=>({...p,taxBrackets:[...p.taxBrackets,{over:0,base:0,rate:0}]}))} className="mt-2 text-xs font-bold text-brand-600 hover:text-brand-700">+ Add bracket</button>
          </div>

          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
            <h3 className="font-bold text-gray-800 mb-1">Holiday calendar</h3>
            <p className="text-xs text-gray-400 mb-3">Regular = 200% if worked (paid if unworked). Special = +30% if worked, no-work-no-pay. Add local holidays for your city.</p>
            <div className="grid sm:grid-cols-2 gap-2">
              {(settings.holidays||[]).map((h,i)=>(
                <div key={i} className="flex items-center gap-2">
                  <input type="date" value={h.date} onChange={e=>setSettings(p=>{const c=JSON.parse(JSON.stringify(p));c.holidays[i].date=e.target.value;return c;})} className="border border-gray-200 rounded-lg px-2 py-1.5 text-xs"/>
                  <input value={h.name} onChange={e=>setSettings(p=>{const c=JSON.parse(JSON.stringify(p));c.holidays[i].name=e.target.value;return c;})} className="flex-1 border border-gray-200 rounded-lg px-2 py-1.5 text-xs"/>
                  <select value={h.type} onChange={e=>setSettings(p=>{const c=JSON.parse(JSON.stringify(p));c.holidays[i].type=e.target.value;return c;})} className="border border-gray-200 rounded-lg px-2 py-1.5 text-xs"><option value="regular">Regular</option><option value="special">Special</option></select>
                  <button onClick={()=>setSettings(p=>({...p,holidays:p.holidays.filter((_,j)=>j!==i)}))} className="text-gray-300 hover:text-red-500">✕</button>
                </div>
              ))}
            </div>
            <button onClick={()=>setSettings(p=>({...p,holidays:[...(p.holidays||[]),{date:TODAY,name:"New holiday",type:"special"}]}))} className="mt-3 text-xs font-bold text-brand-600 hover:text-brand-700">+ Add holiday</button>
          </div>

          <div className="flex justify-end">
            <button disabled={busy} onClick={()=>saveSettings()} className="bg-brand-500 text-white text-sm font-bold px-6 py-3 rounded-xl hover:bg-brand-600 disabled:opacity-50 shadow-brand">{busy?"Saving…":"Save settings"}</button>
          </div>
        </div>
      )}

      {/* Run detail modal */}
      {viewRun&&(
        <div className="fixed inset-0 bg-slate-900/25 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={()=>setViewRun(null)}>
          <div className="bg-white rounded-3xl w-full max-w-3xl max-h-[85vh] overflow-y-auto shadow-2xl" onClick={e=>e.stopPropagation()}>
            <div className="px-7 py-5 border-b border-gray-100 flex items-center justify-between sticky top-0 bg-white">
              <div><h2 className="font-black text-ink">{periodLabel(viewRun.run)}</h2><div className="text-xs text-gray-400">{viewRun.slips.length} payslips · {viewRun.run.status==='final'?'Finalized':'Draft'}</div></div>
              <div className="flex gap-2">
                {viewRun.run.status!=='final'&&<button onClick={()=>finalizeRun(viewRun.run)} className="text-xs font-bold px-4 py-2 rounded-xl bg-brand-500 text-white hover:bg-brand-600">Finalize</button>}
                <button onClick={()=>setViewRun(null)} className="w-9 h-9 rounded-lg hover:bg-gray-100 text-gray-400">✕</button>
              </div>
            </div>
            <table className="w-full text-sm">
              <thead><tr className="border-b border-gray-100 bg-gray-50/60">{["Employee","Gross","Deductions","Net",""].map(h=><th key={h} className="text-left text-xs font-semibold text-gray-400 uppercase tracking-wider px-5 py-3">{h}</th>)}</tr></thead>
              <tbody className="divide-y divide-gray-50">
                {viewRun.slips.map(s=>(
                  <tr key={s.id||s.employee_id}>
                    <td className="px-5 py-3"><div className="font-semibold text-gray-800">{empById[s.employee_id]?.name||s.employee_id}</div></td>
                    <td className="px-5 py-3 font-mono text-xs">{peso(s.gross)}</td>
                    <td className="px-5 py-3 font-mono text-xs text-red-600">−{peso(s.deductions)}</td>
                    <td className="px-5 py-3 font-mono text-xs font-bold text-brand-700">{peso(s.net)}</td>
                    <td className="px-5 py-3 whitespace-nowrap">
                      <button onClick={()=>setSlipModal({slip:s, emp:empById[s.employee_id], label:periodLabel(viewRun.run)})} className="text-xs font-bold text-brand-600 hover:text-brand-700 mr-3">View</button>
                      <button onClick={()=>printPayslip(s, empById[s.employee_id], company, periodLabel(viewRun.run))} className="text-xs font-bold text-gray-500 hover:text-gray-800">🖨 Print</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Payslip detail modal */}
      {slipModal&&(
        <div className="fixed inset-0 bg-slate-900/25 backdrop-blur-sm z-[60] flex items-center justify-center p-4" onClick={()=>setSlipModal(null)}>
          <div className="bg-white rounded-3xl w-full max-w-md max-h-[85vh] overflow-y-auto shadow-2xl p-7" onClick={e=>e.stopPropagation()}>
            <div className="flex items-center justify-between mb-1">
              <h2 className="font-black text-ink">{slipModal.emp?.name||slipModal.slip.employee_id}</h2>
              <button onClick={()=>setSlipModal(null)} className="w-9 h-9 rounded-lg hover:bg-gray-100 text-gray-400">✕</button>
            </div>
            <div className="text-xs text-gray-400 mb-4">{slipModal.label}</div>
            <div className="text-xs font-bold text-brand-700 uppercase tracking-wider mb-1">Earnings</div>
            {slipModal.slip.data.earnings.map((e,i)=><div key={i} className="flex justify-between text-sm py-1 border-b border-gray-50"><span className="text-gray-600">{e.label}</span><span className="font-mono">{peso(e.amount)}</span></div>)}
            <div className="flex justify-between text-sm py-1.5 font-bold"><span>Gross</span><span className="font-mono">{peso(slipModal.slip.gross)}</span></div>
            <div className="text-xs font-bold text-red-600 uppercase tracking-wider mt-3 mb-1">Deductions</div>
            {slipModal.slip.data.deductions.map((d,i)=><div key={i} className="flex justify-between text-sm py-1 border-b border-gray-50"><span className="text-gray-600">{d.label}</span><span className="font-mono">−{peso(d.amount)}</span></div>)}
            <div className="flex justify-between text-sm py-1.5 font-bold"><span>Total deductions</span><span className="font-mono">−{peso(slipModal.slip.deductions)}</span></div>
            <div className="mt-4 bg-brand-50 border border-brand-200 rounded-2xl px-4 py-3 flex justify-between font-black text-brand-800"><span>NET PAY</span><span className="font-mono">{peso(slipModal.slip.net)}</span></div>
            <button onClick={()=>printPayslip(slipModal.slip, slipModal.emp, company, slipModal.label)} className="mt-4 w-full bg-brand-500 text-white text-sm font-bold py-3 rounded-xl hover:bg-brand-600 shadow-brand">🖨 Print payslip</button>
          </div>
        </div>
      )}

      {confirmDel&&(
        <div className="fixed inset-0 bg-slate-900/25 backdrop-blur-sm z-[60] flex items-center justify-center p-4" onClick={()=>setConfirmDel(null)}>
          <div className="bg-white rounded-3xl p-7 max-w-sm w-full shadow-2xl" onClick={e=>e.stopPropagation()}>
            <h2 className="text-lg font-black text-ink mb-2">Delete pay run</h2>
            <p className="text-sm text-gray-500 mb-5">Delete the run for <b>{periodLabel(confirmDel)}</b> and all its payslips? This can't be undone.</p>
            <div className="flex gap-3">
              <button onClick={()=>setConfirmDel(null)} className="flex-1 border border-gray-200 text-gray-600 text-sm font-semibold py-2.5 rounded-xl hover:bg-gray-50">Cancel</button>
              <button onClick={deleteRun} className="flex-1 bg-red-600 text-white text-sm font-bold py-2.5 rounded-xl hover:bg-red-700">Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// ADMIN REGISTRATIONS — review sign-ups from the Register page; approve to
// create the login account, or reject.
// ════════════════════════════════════════════════════════════════════════════
function AdminRegistrations({ adminUser, addToast }) {
  const [regs,setRegs]=useState([]); const [loading,setLoading]=useState(true);
  const [filter,setFilter]=useState("pending"); const [busy,setBusy]=useState(null); const [confirmDel,setConfirmDel]=useState(null);

  const load=async()=>{ setLoading(true); const{data}=await supabase.from('registrations').select('*').order('created_at',{ascending:false}); setRegs(data||[]); setLoading(false); };
  useEffect(()=>{ load(); },[]);

  const approve=async r=>{
    setBusy(r.id);
    // Make sure the username is still free, then create the login account.
    const {data:existing}=await supabase.from('admin_accounts').select('id').eq('username',r.username).maybeSingle();
    if(existing){ addToast("Username already taken — edit before approving.","error"); setBusy(null); return; }
    // The registration id becomes the business's TENANT ID — every row of their
    // data carries it, keeping each customer's data separate and identifiable.
    const acct={username:r.username,password_hash:r.password_hash,role:r.role||'admin',department_access:null,is_active:true,must_change_password:false};
    let {error}=await supabase.from('admin_accounts').insert({...acct, tenant_id:r.id});
    if(error && /tenant_id/.test(error.message)) ({error}=await supabase.from('admin_accounts').insert(acct));
    if(error){ addToast("Failed: "+error.message,"error"); setBusy(null); return; }
    const rev={status:'approved',reviewed_by:adminUser.username,reviewed_at:new Date().toISOString()};
    let {error:e2}=await supabase.from('registrations').update({...rev, tenant_id:r.id}).eq('id',r.id);
    if(e2 && /tenant_id/.test(e2.message)) await supabase.from('registrations').update(rev).eq('id',r.id);
    setBusy(null); addToast(`${r.name} approved — tenant created for "${r.username}".`,"success"); load();
  };
  const reject=async r=>{ setBusy(r.id); await supabase.from('registrations').update({status:'rejected',reviewed_by:adminUser.username,reviewed_at:new Date().toISOString()}).eq('id',r.id); setBusy(null); addToast(`${r.name}'s registration rejected.`,"info"); load(); };
  // Upgrade/downgrade a customer's plan — their modules re-scope on next login.
  const changePlan=async(r,module)=>{
    if(module===(r.module||"All-in-One")) return;
    const {error}=await supabase.from('registrations').update({module}).eq('id',r.id);
    if(error){ addToast("Failed: "+error.message,"error"); return; }
    await logAudit(adminUser,'plan_changed',r.company||r.name,`${r.module||'All-in-One'} → ${module}`);
    addToast(`${r.company||r.name} plan set to ${module}${r.status==='approved'?" — applies on their next login":""}.`,"success");
    load();
  };
  const doDelete=async()=>{ await supabase.from('registrations').delete().eq('id',confirmDel.id); setConfirmDel(null); addToast("Registration deleted.","info"); load(); };

  const counts={ pending:regs.filter(r=>r.status==="pending").length, approved:regs.filter(r=>r.status==="approved").length, rejected:regs.filter(r=>r.status==="rejected").length };
  const visible=regs.filter(r=>filter==="all"||r.status===filter);
  const badge=s=>s==="approved"?"bg-brand-50 text-brand-700 border-brand-200":s==="rejected"?"bg-red-50 text-red-700 border-red-200":"bg-amber-50 text-amber-700 border-amber-200";

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-5">
        <div>
          <h1 className="text-xl font-black text-ink flex items-center gap-2"><Icon name="userplus" className="w-5 h-5 text-brand-600"/> Registrations</h1>
          <p className="text-sm text-gray-500 mt-0.5">Review sign-ups from the Register page. Approving one creates its login account.</p>
        </div>
        <div className="flex gap-2">
          {[["pending",`Pending (${counts.pending})`],["approved",`Approved (${counts.approved})`],["rejected",`Rejected (${counts.rejected})`],["all","All"]].map(([k,l])=>(
            <button key={k} onClick={()=>setFilter(k)} className={`px-3 py-1.5 rounded-xl text-xs font-semibold border transition-colors ${filter===k?"bg-brand-500 text-white border-brand-500":"bg-white text-gray-600 border-gray-200 hover:border-brand-300"}`}>{l}</button>
          ))}
        </div>
      </div>
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-gray-100 bg-gray-50/60">
              {["Name","Company","Email","Demo","Phone","Submitted","Status","Actions"].map(h=><th key={h} className="text-left text-xs font-semibold text-gray-400 uppercase tracking-wider px-5 py-3">{h}</th>)}
            </tr></thead>
            <tbody className="divide-y divide-gray-50">
              {loading?<tr><td colSpan={8} className="text-center py-12 text-gray-400 text-sm">Loading…</td></tr>
               :visible.length===0?<tr><td colSpan={8} className="text-center py-12 text-gray-400 text-sm">No {filter==="all"?"":filter} registrations.</td></tr>
               :visible.map(r=>(
                <tr key={r.id} className="hover:bg-gray-50/60">
                  <td className="px-5 py-3.5"><div className="font-semibold text-gray-800">{r.name}</div>{r.tenant_id&&<div className="text-[10px] font-mono text-gray-400" title={`Tenant ID: ${r.tenant_id}`}>tenant {String(r.tenant_id).slice(0,8)}</div>}</td>
                  <td className="px-5 py-3.5 text-gray-600">{r.company||"—"}</td>
                  <td className="px-5 py-3.5 text-gray-600">{r.email}</td>
                  <td className="px-5 py-3.5">
                    {/* Plan switcher — changing it re-scopes the customer's modules on their next login */}
                    <select value={r.module||"All-in-One"} onChange={e=>changePlan(r,e.target.value)} title="Change this customer's plan"
                      className="text-xs font-bold px-2 py-1.5 rounded-lg bg-brand-50 text-brand-700 border border-brand-200 cursor-pointer hover:border-brand-400 focus:outline-none">
                      {["Attendance","Payroll","Directory","All-in-One"].map(m=><option key={m} value={m}>{m}</option>)}
                    </select>
                  </td>
                  <td className="px-5 py-3.5 text-xs text-gray-600 whitespace-nowrap">{r.phone||"—"}</td>
                  <td className="px-5 py-3.5 text-xs text-gray-500 whitespace-nowrap">{r.created_at?new Date(r.created_at).toLocaleDateString("en-PH",{month:"short",day:"numeric",year:"numeric"}):"—"}</td>
                  <td className="px-5 py-3.5"><span className={`text-xs font-bold px-2.5 py-1 rounded-full border capitalize ${badge(r.status)}`}>{r.status}</span></td>
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-1.5">
                      {r.status==="pending"&&<>
                        <button disabled={busy===r.id} onClick={()=>approve(r)} className="flex items-center gap-1 bg-brand-500 text-white text-xs font-bold px-3 py-1.5 rounded-lg hover:bg-brand-600 disabled:opacity-50"><Icon name="check" className="w-3.5 h-3.5"/> Approve</button>
                        <button disabled={busy===r.id} onClick={()=>reject(r)} className="text-xs font-bold px-3 py-1.5 rounded-lg text-gray-600 bg-gray-100 hover:bg-gray-200 disabled:opacity-50">Reject</button>
                      </>}
                      <button onClick={()=>setConfirmDel(r)} title="Delete" className="text-gray-400 hover:text-red-600 p-1.5 rounded-lg hover:bg-red-50"><Icon name="trash" className="w-4 h-4"/></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {confirmDel&&(
        <div className="fixed inset-0 bg-slate-900/25 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={()=>setConfirmDel(null)}>
          <div className="bg-white rounded-3xl p-7 max-w-sm w-full shadow-2xl" onClick={e=>e.stopPropagation()}>
            <h2 className="text-lg font-black text-ink mb-2">Delete registration</h2>
            <p className="text-sm text-gray-500 mb-3">Remove <span className="font-bold">{confirmDel.name}</span>'s registration? This can't be undone.</p>
            {confirmDel.status==='approved'&&(
              <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2.5 mb-5">⚠ This registration holds the customer's <b>plan ({confirmDel.module||"All-in-One"})</b>. Deleting it resets their account to ALL modules on next login. To change their access, use the plan dropdown instead.</p>
            )}
            <div className="flex gap-3">
              <button onClick={()=>setConfirmDel(null)} className="flex-1 border border-gray-200 text-gray-600 text-sm font-semibold py-2.5 rounded-xl hover:bg-gray-50">Cancel</button>
              <button onClick={doDelete} className="flex-1 bg-red-600 text-white text-sm font-bold py-2.5 rounded-xl hover:bg-red-700">Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
// ════════════════════════════════════════════════════════════════════════════
function AdminAccounts({ adminUser, addToast, allDepartments }) {
  const [accounts,setAccounts]=useState([]); const [loading,setLoading]=useState(true);
  const [modal,setModal]=useState(false); const [selected,setSelected]=useState(null);
  const [form,setForm]=useState({username:"",password:"",role:"admin",department_access:[],page_access:[]});
  const [pwForm,setPwForm]=useState({current:"",next:"",confirm:""});
  const [showPw,setShowPw]=useState({}); const [confirmDel,setConfirmDel]=useState(null);
  const isSuperAdmin=adminUser.role==="super_admin";

  const load=async()=>{ setLoading(true); let {data,error}=await supabase.from('admin_accounts').select('id,username,role,is_active,last_login,created_at,department_access,tenant_id,page_access').order('created_at'); if(error) ({data}=await supabase.from('admin_accounts').select('id,username,role,is_active,last_login,created_at,department_access').order('created_at')); setAccounts(data||[]); setLoading(false); };
  useEffect(()=>{ load(); },[]);

  const toggleDept=d=>setForm(f=>({...f,department_access:f.department_access.includes(d)?f.department_access.filter(x=>x!==d):[...f.department_access,d]}));

  const saveAccount=async()=>{
    if (!form.username){addToast("Username is required.","error");return;}
    if (modal==="add"&&!form.password){addToast("Password is required.","error");return;}
    const deptAccess=form.role==="super_admin"?null:(form.department_access.length>0?form.department_access:null);
    // Page access: empty selection = full access (null). Super admins always get everything.
    const pageAccess=form.role==="super_admin"?null:(form.page_access.length>0&&form.page_access.length<PAGE_OPTIONS.length?form.page_access:null);
    if (modal==="add") {
      const row={username:form.username.trim(),password_hash:btoa(form.password),role:form.role,department_access:deptAccess,is_active:true,must_change_password:true};
      let {error}=await supabase.from('admin_accounts').insert({...row,page_access:pageAccess});
      if(error&&/page_access/.test(error.message)) ({error}=await supabase.from('admin_accounts').insert(row));
      if(error){addToast("Error: "+(error.message.includes("unique")?"Username already exists.":error.message),"error");return;}
      addToast(`Account "${form.username}" created.`,"success");
    } else {
      const row={username:form.username.trim(),role:form.role,department_access:deptAccess};
      let {error}=await supabase.from('admin_accounts').update({...row,page_access:pageAccess}).eq('id',selected.id);
      if(error&&/page_access/.test(error.message)) ({error}=await supabase.from('admin_accounts').update(row).eq('id',selected.id));
      if(error){addToast("Error: "+error.message,"error");return;}
      addToast("Account updated.","success");
    }
    setModal(false); load();
  };

  const changePassword=async()=>{
    if (!pwForm.current||!pwForm.next||!pwForm.confirm){addToast("Fill in all fields.","error");return;}
    if (pwForm.next!==pwForm.confirm){addToast("New passwords do not match.","error");return;}
    if (pwForm.next.length<6){addToast("Password must be at least 6 characters.","error");return;}
    const{data}=await supabase.from('admin_accounts').select('password_hash').eq('id',selected.id).maybeSingle();
    if (!data||data.password_hash!==btoa(pwForm.current)){addToast("Current password is incorrect.","error");return;}
    await supabase.from('admin_accounts').update({password_hash:btoa(pwForm.next)}).eq('id',selected.id);
    addToast("Password changed successfully.","success"); setModal(false); setPwForm({current:"",next:"",confirm:""});
  };

  const toggleActive=async acc=>{
    if (acc.id===adminUser.id){addToast("You can't deactivate your own account.","error");return;}
    await supabase.from('admin_accounts').update({is_active:!acc.is_active}).eq('id',acc.id);
    addToast(`${acc.username} ${acc.is_active?"deactivated":"reactivated"}.`,"info"); load();
  };

  const doDelete=async()=>{
    if (confirmDel.id===adminUser.id){addToast("You can't delete your own account.","error");setConfirmDel(null);return;}
    await supabase.from('admin_accounts').delete().eq('id',confirmDel.id);
    addToast(`${confirmDel.username} deleted.`,"info"); setConfirmDel(null); load();
  };

  if (!isSuperAdmin) return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <div className="text-6xl mb-4">🔒</div>
      <h2 className="text-xl font-black text-gray-900 mb-2">Super Admin Only</h2>
      <p className="text-sm text-gray-500">Account management requires Super Admin access.</p>
    </div>
  );

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div><h1 className="text-2xl font-black text-gray-900">Admin Accounts</h1><p className="text-sm text-gray-500 mt-0.5">Manage who can log in to this portal</p></div>
        <button onClick={()=>{setForm({username:"",password:"",role:"admin",department_access:[],page_access:[]});setModal("add");}} className="bg-brand-500 text-white text-sm font-bold px-5 py-2.5 rounded-xl hover:bg-brand-600 active:scale-95">+ Add Account</button>
      </div>
      <div className="bg-brand-50 border border-brand-200 rounded-3xl p-5 flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="text-xs font-bold text-brand-500 uppercase tracking-wider mb-1">Logged in as</div>
          <div className="font-black text-gray-900 text-lg">{adminUser.username}</div>
          <div className="text-xs text-gray-500 mt-0.5 capitalize">{adminUser.role.replace("_"," ")} · Since {adminUser.loginTime}</div>
        </div>
        <div className="flex gap-2">
          <button onClick={()=>{const me=accounts.find(a=>a.id===adminUser.id);setSelected(me);setForm({username:me?.username||"",password:"",role:me?.role||"admin",department_access:me?.department_access||[],page_access:me?.page_access||[]});setModal("edit");}} className="px-4 py-2 bg-white border border-brand-200 text-brand-700 text-xs font-bold rounded-xl hover:bg-brand-100">Edit Username</button>
          <button onClick={()=>{setSelected(accounts.find(a=>a.id===adminUser.id));setPwForm({current:"",next:"",confirm:""});setModal("password");}} className="px-4 py-2 bg-brand-700 text-white text-xs font-bold rounded-xl hover:bg-brand-600">Change Password</button>
        </div>
      </div>
      <div className="bg-white rounded-3xl border border-gray-100 shadow-sm overflow-x-auto">
        {loading?<div className="py-12 text-center text-gray-400 text-sm">Loading…</div>:(
          <table className="w-full text-sm">
            <thead><tr className="border-b border-gray-100 bg-gray-50/60">{["Username","Role","Dept Access","Status","Last Login","Actions"].map(h=><th key={h} className="text-left text-xs font-semibold text-gray-400 uppercase tracking-wider px-5 py-3.5">{h}</th>)}</tr></thead>
            <tbody className="divide-y divide-gray-50">
              {accounts.map(acc=>(
                <tr key={acc.id} className={`hover:bg-gray-50/60 transition-colors ${acc.id===adminUser.id?"bg-brand-50/30":""}`}>
                  <td className="px-5 py-4"><div className="font-semibold text-gray-800">{acc.username}</div>{acc.tenant_id&&<div className="text-[10px] font-mono text-gray-400" title={`Tenant ID: ${acc.tenant_id}`}>tenant {String(acc.tenant_id).slice(0,8)}</div>}{acc.id===adminUser.id&&<div className="text-xs text-brand-500 font-semibold">← You</div>}</td>
                  <td className="px-5 py-4"><span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-slate-100 text-slate-700 border border-slate-200 capitalize">{acc.role.replace("_"," ")}</span></td>
                  <td className="px-5 py-4 text-xs text-gray-500">{acc.role==="super_admin"?"All":acc.department_access?.length>0?acc.department_access.join(", "):"All"}</td>
                  <td className="px-5 py-4"><span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold border ${acc.is_active?"bg-emerald-50 text-emerald-700 border-emerald-200":"bg-gray-100 text-gray-500 border-gray-200"}`}>{acc.is_active?"Active":"Inactive"}</span></td>
                  <td className="px-5 py-4 text-xs text-gray-500 whitespace-nowrap">{acc.last_login?new Date(acc.last_login).toLocaleString("en-PH"):"Never"}</td>
                  <td className="px-5 py-4"><div className="flex gap-1.5 flex-wrap">
                    <button onClick={()=>{setSelected(acc);setForm({username:acc.username,password:"",role:acc.role,department_access:acc.department_access||[]});setModal("edit");}} className="px-2.5 py-1.5 text-xs font-semibold text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg">Edit</button>
                    <button onClick={()=>{setSelected(acc);setPwForm({current:"",next:"",confirm:""});setModal("password");}} className="px-2.5 py-1.5 text-xs font-semibold text-brand-600 bg-brand-50 hover:bg-brand-100 rounded-lg">Password</button>
                    {acc.id!==adminUser.id&&<>
                      <button onClick={()=>toggleActive(acc)} className={`px-2.5 py-1.5 text-xs font-semibold rounded-lg ${acc.is_active?"text-red-600 bg-red-50 hover:bg-red-100":"text-emerald-600 bg-emerald-50 hover:bg-emerald-100"}`}>{acc.is_active?"Deactivate":"Reactivate"}</button>
                      <button onClick={()=>setConfirmDel(acc)} className="px-2.5 py-1.5 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 rounded-lg">Delete</button>
                    </>}
                  </div></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {(modal==="add"||modal==="edit")&&(
        <div className="fixed inset-0 bg-slate-900/25 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={()=>setModal(false)}>
          <div className="bg-white rounded-3xl w-full max-w-md shadow-2xl overflow-hidden" onClick={e=>e.stopPropagation()}>
            <div className="bg-gradient-to-r from-brand-600 to-brand-700 px-7 py-5 flex items-center justify-between">
              <h2 className="text-lg font-black text-white">{modal==="add"?"New Account":"Edit Account"}</h2>
              <button onClick={()=>setModal(false)} className="text-white/40 hover:text-white text-2xl">×</button>
            </div>
            <div className="p-7 space-y-4">
              <div><label className="text-xs font-bold text-gray-500 uppercase tracking-wider block mb-1.5">Username</label>
                <input value={form.username} onChange={e=>setForm(f=>({...f,username:e.target.value}))} className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-200"/></div>
              {modal==="add"&&<div><label className="text-xs font-bold text-gray-500 uppercase tracking-wider block mb-1.5">Password</label>
                <input type="password" value={form.password} onChange={e=>setForm(f=>({...f,password:e.target.value}))} className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-200"/></div>}
              <div><label className="text-xs font-bold text-gray-500 uppercase tracking-wider block mb-1.5">Role</label>
                <select value={form.role} onChange={e=>setForm(f=>({...f,role:e.target.value}))} className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none">
                  <option value="admin">Admin</option><option value="super_admin">Super Admin</option>
                </select></div>
              {form.role==="admin"&&(
                <div>
                  <label className="text-xs font-bold text-gray-500 uppercase tracking-wider block mb-2">Department Access</label>
                  <p className="text-xs text-gray-400 mb-2">Leave all unchecked = access to all departments.</p>
                  <div className="flex flex-wrap gap-2">
                    {allDepartments.map(d=>(
                      <button key={d} type="button" onClick={()=>toggleDept(d)}
                        className={`px-3 py-1.5 rounded-xl text-xs font-semibold border transition-colors ${form.department_access.includes(d)?"bg-brand-500 text-white border-brand-500":"bg-gray-50 text-gray-600 border-gray-200 hover:border-slate-400"}`}>{d}</button>
                    ))}
                  </div>
                  {form.department_access.length>0&&<p className="text-xs text-brand-600 mt-2 font-medium">Access: {form.department_access.join(", ")}</p>}
                </div>
              )}
              {form.role==="admin"&&(
                <div>
                  <label className="text-xs font-bold text-gray-500 uppercase tracking-wider block mb-2">Page Access</label>
                  <p className="text-xs text-gray-400 mb-2">Pick which pages this account can open. Leave all unchecked = every page their plan allows.</p>
                  <div className="flex flex-wrap gap-2">
                    {PAGE_OPTIONS.map(([k,l])=>(
                      <button key={k} type="button" onClick={()=>setForm(f=>({...f,page_access:f.page_access.includes(k)?f.page_access.filter(x=>x!==k):[...f.page_access,k]}))}
                        className={`px-3 py-1.5 rounded-xl text-xs font-semibold border transition-colors ${form.page_access.includes(k)?"bg-brand-500 text-white border-brand-500":"bg-gray-50 text-gray-600 border-gray-200 hover:border-slate-400"}`}>{l}</button>
                    ))}
                  </div>
                  {form.page_access.length>0&&<p className="text-xs text-brand-600 mt-2 font-medium">Can open: {form.page_access.map(k=>(PAGE_OPTIONS.find(([x])=>x===k)||[])[1]).join(", ")}</p>}
                </div>
              )}
              {form.role==="super_admin"&&<p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">Super Admin has full access to all departments and settings.</p>}
            </div>
            <div className="flex gap-3 px-7 pb-7">
              <button onClick={()=>setModal(false)} className="flex-1 border border-gray-200 text-gray-600 text-sm font-semibold py-3 rounded-xl hover:bg-gray-50">Cancel</button>
              <button onClick={saveAccount} className="flex-1 bg-brand-500 text-white text-sm font-bold py-3 rounded-xl hover:bg-brand-600 active:scale-[0.98]">{modal==="add"?"Create Account":"Save Changes"}</button>
            </div>
          </div>
        </div>
      )}

      {modal==="password"&&selected&&(
        <div className="fixed inset-0 bg-slate-900/25 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={()=>setModal(false)}>
          <div className="bg-white rounded-3xl w-full max-w-md shadow-2xl overflow-hidden" onClick={e=>e.stopPropagation()}>
            <div className="bg-gradient-to-r from-brand-700 to-brand-900 px-7 py-5 flex items-center justify-between">
              <div><h2 className="text-lg font-black text-white">Change Password</h2><p className="text-brand-300 text-xs mt-0.5">{selected.username}</p></div>
              <button onClick={()=>setModal(false)} className="text-white/40 hover:text-white text-2xl">×</button>
            </div>
            <div className="p-7 space-y-4">
              {[{k:"current",l:"Current Password"},{k:"next",l:"New Password"},{k:"confirm",l:"Confirm New Password"}].map(({k,l})=>(
                <div key={k}><label className="text-xs font-bold text-gray-500 uppercase tracking-wider block mb-1.5">{l}</label>
                  <div className="relative">
                    <input type={showPw[k]?"text":"password"} value={pwForm[k]} onChange={e=>setPwForm(f=>({...f,[k]:e.target.value}))} className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-200 pr-10"/>
                    <button type="button" onClick={()=>setShowPw(p=>({...p,[k]:!p[k]}))} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">{showPw[k]?"🙈":"👁"}</button>
                  </div>
                </div>
              ))}
              <p className="text-xs text-gray-400">Minimum 6 characters.</p>
            </div>
            <div className="flex gap-3 px-7 pb-7">
              <button onClick={()=>setModal(false)} className="flex-1 border border-gray-200 text-gray-600 text-sm font-semibold py-3 rounded-xl">Cancel</button>
              <button onClick={changePassword} className="flex-1 bg-brand-700 text-white text-sm font-bold py-3 rounded-xl hover:bg-brand-600 active:scale-[0.98]">Change Password</button>
            </div>
          </div>
        </div>
      )}

      {confirmDel&&(
        <div className="fixed inset-0 bg-slate-900/25 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={()=>setConfirmDel(null)}>
          <div className="bg-white rounded-3xl w-full max-w-sm shadow-2xl p-7 text-center" onClick={e=>e.stopPropagation()}>
            <div className="text-4xl mb-4">🗑️</div>
            <h2 className="text-lg font-black mb-2">Delete Account</h2>
            <p className="text-sm text-gray-500 mb-6">Permanently delete <span className="font-bold">{confirmDel.username}</span>?</p>
            <div className="flex gap-3">
              <button onClick={()=>setConfirmDel(null)} className="flex-1 border border-gray-200 text-gray-600 text-sm font-semibold py-2.5 rounded-xl">Cancel</button>
              <button onClick={doDelete} className="flex-1 bg-red-600 text-white text-sm font-bold py-2.5 rounded-xl hover:bg-red-500 active:scale-95">Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// BULK IMPORT MODAL
// ════════════════════════════════════════════════════════════════════════════
function BulkImportModal({ onClose, onImport, addToast, employees }) {
  const [rows,setRows]=useState([]); const [errors,setErrors]=useState([]);
  const [step,setStep]=useState("upload"); const [loading,setLoad]=useState(false);

  const TEMPLATE_CSV=`id,name,position,department,contact,qrCode,status,empType,shiftStart,shiftEnd,gracePeriod,coffeeBreak,lunchBreak,restDays\nEMP010,Juan Santos,Developer,Engineering,09171234567,OLD-1234,active,Regular,08:00,17:00,10,15,60,"Saturday,Sunday"\nEMP011,Maria Reyes,Designer,Design,09189876543,,active,Freelance,09:00,18:00,15,15,60,"Saturday,Sunday"`;

  const downloadTemplate=()=>{ const blob=new Blob([TEMPLATE_CSV],{type:"text/csv"}); const a=Object.assign(document.createElement("a"),{href:URL.createObjectURL(blob),download:"employee_template.csv"}); a.click(); URL.revokeObjectURL(a.href); };

  const parseCSV=text=>{
    const lines=text.trim().split("\n").filter(Boolean); if(lines.length<2) return [];
    const headers=lines[0].split(",").map(h=>h.trim().replace(/"/g,""));
    return lines.slice(1).map(line=>{ const cols=[]; let cur=""; let inQ=false; for(const ch of line){if(ch==='"'){inQ=!inQ;}else if(ch===","&&!inQ){cols.push(cur.trim());cur="";}else cur+=ch;} cols.push(cur.trim()); return Object.fromEntries(headers.map((h,i)=>[h,(cols[i]||"").replace(/"/g,"")])); });
  };

  const processFile=async e=>{
    const file=e.target.files[0]; if(!file) return;
    setStep("upload"); setErrors([]); setRows([]);
    const ext=file.name.split(".").pop().toLowerCase(); let parsed=[];
    if (ext==="csv"){ const text=await file.text(); parsed=parseCSV(text); }
    else if (ext==="xlsx"||ext==="xls"){
      if (!window.XLSX) await new Promise((res,rej)=>{const s=document.createElement("script");s.src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";s.onload=res;s.onerror=rej;document.head.appendChild(s);});
      const data=await file.arrayBuffer(); const wb=window.XLSX.read(data,{type:"array"}); parsed=window.XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{defval:""});
    } else { addToast("Only .csv or .xlsx files supported.","error"); return; }
    const errs=[]; const valid=[];
    const has=v=>v!==undefined&&v!==null&&String(v).trim()!=="";
    // Accept a few common header spellings for the existing badge/QR code column.
    const qrOf=row=>{ const v=row.qrCode??row.qr_code??row.qrcode??row.badge??row.badgeId??row.badgeID??row.QR??row.qr; return has(v)?String(v).trim():""; };
    parsed.forEach((row,i)=>{
      const id=String(row.id||"").trim().toUpperCase();
      if (!id){ errs.push(`Row ${i+2}: missing id`); return; }
      const existing=(employees||[]).find(e=>e.id===id);
      const qrCode=qrOf(row);

      if (existing) {
        // UPDATE: blank cells keep existing values
        const oldSched=existing.schedule||{};
        valid.push({
          id, mode:"update",
          name:       has(row.name)?String(row.name).trim():existing.name,
          position:   has(row.position)?String(row.position).trim():existing.position,
          department: has(row.department)?String(row.department).trim():existing.department,
          role:       has(row.role)?String(row.role).trim():(existing.role||"Staff"),
          contact:    has(row.contact)?String(row.contact).trim():existing.contact,
          qrCode:     qrCode||existing.qrCode||"",
          status:     has(row.status)&&["active","inactive"].includes(row.status)?row.status:existing.status,
          empType:    has(row.empType)?String(row.empType).trim():(existing.empType||"Regular"),
          schedule:{
            shiftStart:    has(row.shiftStart)?row.shiftStart:oldSched.shiftStart,
            shiftEnd:      has(row.shiftEnd)?row.shiftEnd:oldSched.shiftEnd,
            gracePeriod:   has(row.gracePeriod)?Number(row.gracePeriod):oldSched.gracePeriod,
            coffeeBreak:   has(row.coffeeBreak)?Number(row.coffeeBreak):numOr(oldSched.coffeeBreak,15),
            lunchBreak:    has(row.lunchBreak)?Number(row.lunchBreak):numOr(oldSched.lunchBreak,60),
            restDays:      has(row.restDays)?String(row.restDays).split(",").map(d=>d.trim()):oldSched.restDays,
          },
        });
      } else {
        // NEW: require core fields
        const missing=["name","position","department"].filter(k=>!has(row[k]));
        if (missing.length){ errs.push(`Row ${i+2} (new ${id}): missing ${missing.join(", ")}`); return; }
        valid.push({
          id, mode:"new",
          name:String(row.name).trim(), position:String(row.position).trim(), department:String(row.department).trim(),
          role:has(row.role)?String(row.role).trim():"Staff",
          contact:String(row.contact||"").trim(),
          qrCode,
          status:["active","inactive"].includes(row.status)?row.status:"active",
          empType:has(row.empType)?String(row.empType).trim():"Regular",
          schedule:{shiftStart:row.shiftStart||"08:00",shiftEnd:row.shiftEnd||"17:00",gracePeriod:Number(row.gracePeriod)||10,coffeeBreak:Number(row.coffeeBreak)||15,lunchBreak:Number(row.lunchBreak)||60,restDays:row.restDays?String(row.restDays).split(",").map(d=>d.trim()):["Saturday","Sunday"]},
        });
      }
    });
    setErrors(errs); setRows(valid);
    if (valid.length>0) setStep("preview"); else addToast("No valid rows found.","error");
  };

  const doImport=async()=>{
    setLoad(true);
    const dbRows=rows.map(e=>({id:e.id,name:e.name,position:e.position,department:e.department,role:e.role||'Staff',contact:e.contact,qr_code:e.qrCode||null,status:e.status,emp_type:e.empType||'Regular',schedule:e.schedule}));
    const{error}=await supabase.from("employees").upsert(dbRows,{onConflict:"id"});
    setLoad(false);
    if (error){addToast("Import failed: "+error.message,"error");return;}
    const news=rows.filter(r=>r.mode==="new").length, ups=rows.filter(r=>r.mode==="update").length;
    addToast(`${news} added, ${ups} updated!`,"success"); onImport(); onClose();
  };

  return (
    <div className="fixed inset-0 bg-slate-900/25 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-3xl w-full max-w-2xl shadow-2xl overflow-hidden max-h-[90vh] flex flex-col" onClick={e=>e.stopPropagation()}>
        <div className="bg-gradient-to-r from-emerald-700 to-emerald-900 px-7 py-5 flex items-center justify-between shrink-0">
          <div><h2 className="text-lg font-black text-white">Bulk Import Employees</h2><p className="text-emerald-300 text-xs mt-0.5">Upload a CSV or Excel file</p></div>
          <button onClick={onClose} className="text-white/40 hover:text-white text-2xl">×</button>
        </div>
        <div className="overflow-y-auto flex-1 p-7 space-y-5">
          {step==="upload"&&(
            <>
              <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-4 space-y-2">
                <p className="text-sm font-bold text-emerald-800">Required: <span className="font-mono">id, name, position, department</span></p>
                <p className="text-xs text-emerald-600">Optional: contact, qrCode, status, empType, shiftStart, shiftEnd, gracePeriod, coffeeBreak, lunchBreak, restDays</p>
                <p className="text-xs text-emerald-600"><span className="font-bold">qrCode</span> = the code on their existing ID badge from your old system. Leave blank to scan by Employee ID.</p>
                <button onClick={downloadTemplate} className="mt-2 text-xs bg-emerald-700 text-white font-bold px-4 py-2 rounded-xl hover:bg-emerald-600">↓ Download Template CSV</button>
              </div>
              <label className="block border-2 border-dashed border-gray-300 hover:border-emerald-400 rounded-2xl p-10 text-center cursor-pointer transition-colors">
                <div className="text-4xl mb-3">📂</div>
                <div className="font-bold text-gray-700">Click to choose a file</div>
                <div className="text-xs text-gray-400 mt-1">Supports .csv and .xlsx</div>
                <input type="file" accept=".csv,.xlsx,.xls" onChange={processFile} className="hidden"/>
              </label>
            </>
          )}
          {step==="preview"&&(
            <>
              {errors.length>0&&<div className="bg-amber-50 border border-amber-200 rounded-2xl p-4">{errors.map((e,i)=><p key={i} className="text-xs text-amber-600">{e}</p>)}</div>}
              <div className="flex items-center justify-between"><p className="text-sm font-bold">{rows.filter(r=>r.mode==="new").length} new · {rows.filter(r=>r.mode==="update").length} updates</p><button onClick={()=>setStep("upload")} className="text-xs text-gray-500 hover:underline">← Different file</button></div>
              <div className="border border-gray-100 rounded-2xl overflow-hidden overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-gray-50"><tr>{["Action","ID","Badge/QR","Name","Position","Department","Status"].map(h=><th key={h} className="text-left font-semibold text-gray-400 px-3 py-2.5">{h}</th>)}</tr></thead>
                  <tbody className="divide-y divide-gray-50">
                    {rows.map(r=>(<tr key={r.id} className="hover:bg-gray-50">
                      <td className="px-3 py-2.5"><span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${r.mode==="new"?"bg-blue-100 text-blue-700":"bg-brand-100 text-brand-700"}`}>{r.mode==="new"?"New":"Update"}</span></td>
                      <td className="px-3 py-2.5 font-mono text-gray-500">{r.id}</td>
                      <td className="px-3 py-2.5 font-mono text-gray-500">{r.qrCode?r.qrCode:<span className="text-gray-300">= ID</span>}</td><td className="px-3 py-2.5 font-semibold">{r.name}</td>
                      <td className="px-3 py-2.5 text-gray-600">{r.position}</td><td className="px-3 py-2.5 text-gray-600">{r.department}</td>
                      <td className="px-3 py-2.5"><span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${r.status==="active"?"bg-emerald-100 text-emerald-700":"bg-gray-100 text-gray-500"}`}>{r.status}</span></td>
                    </tr>))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
        <div className="flex gap-3 px-7 py-5 border-t border-gray-100 shrink-0">
          <button onClick={onClose} className="flex-1 border border-gray-200 text-gray-600 text-sm font-semibold py-3 rounded-xl">Cancel</button>
          {step==="preview"&&<button onClick={doImport} disabled={loading} className="flex-1 bg-emerald-700 text-white text-sm font-bold py-3 rounded-xl hover:bg-emerald-600 disabled:opacity-60">{loading?"Importing…":`Import ${rows.length} Employee(s)`}</button>}
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// ADMIN LEAVES — file & manage employee leaves (admin + super admin)
// ════════════════════════════════════════════════════════════════════════════
function AdminLeaves({ employees, leaves, addToast, activeDept, adminUser, reloadData }) {
  const [form,setForm]=useState({employee_id:"",date_from:getToday(),date_to:getToday(),leave_type:"leave",reason:""});
  const [saving,setSaving]=useState(false);
  const [confirmDel,setConfirmDel]=useState(null);

  const active=employees.filter(e=>e.status==="active"&&deptMatch(activeDept,e.department));
  const empName=id=>employees.find(e=>e.id===id)?.name||id;
  const empDept=id=>employees.find(e=>e.id===id)?.department||"";

  // Only show leaves for employees in the active department
  const visibleLeaves=leaves.filter(l=>{ const e=employees.find(x=>x.id===l.employee_id); return e&&deptMatch(activeDept,e.department); });

  const fileLeave=async()=>{
    if (!form.employee_id){ addToast("Select an employee.","error"); return; }
    if (!form.date_from||!form.date_to){ addToast("Pick the leave dates.","error"); return; }
    if (form.date_to<form.date_from){ addToast("End date can't be before start date.","error"); return; }
    setSaving(true);
    const baseRow={employee_id:form.employee_id, date_from:form.date_from, date_to:form.date_to,
      leave_type:form.leave_type, reason:form.reason||null, filed_by:adminUser.username};
    let {error}=await supabase.from('leaves').insert({...baseRow, status:'approved', reviewed_by:adminUser.username});
    // Pre-migration databases lack the approval columns — retry without them.
    if(error&&/status|reviewed_by/.test(error.message)) ({error}=await supabase.from('leaves').insert(baseRow));
    setSaving(false);
    if (error){ addToast("Failed to file leave: "+error.message,"error"); return; }
    await logAudit(adminUser,"leave_filed",empName(form.employee_id),`${form.leave_type} ${form.date_from}→${form.date_to}`);
    addToast(`Leave filed for ${empName(form.employee_id)}.`,"success");
    setForm({employee_id:"",date_from:getToday(),date_to:getToday(),leave_type:"leave",reason:""});
    reloadData?.();
  };
  // Approve/reject employee-filed requests (leave or offset)
  const reviewLeave=async(l,verdict)=>{
    const {error}=await supabase.from('leaves').update({status:verdict,reviewed_by:adminUser.username}).eq('id',l.id);
    if(error){ addToast("Failed: "+error.message,"error"); return; }
    await logAudit(adminUser,`leave_${verdict}`,empName(l.employee_id),`${l.leave_type} ${String(l.date_from).slice(0,10)}→${String(l.date_to).slice(0,10)}`);
    addToast(`${l.leave_type==="offset"?"Offset":"Leave"} request ${verdict}.`,verdict==='approved'?"success":"info");
    reloadData?.();
  };
  const doDelete=async()=>{
    await supabase.from('leaves').delete().eq('id',confirmDel.id);
    await logAudit(adminUser,"leave_removed",empName(confirmDel.employee_id),`${String(confirmDel.date_from).slice(0,10)}→${String(confirmDel.date_to).slice(0,10)}`);
    addToast("Leave removed.","info"); setConfirmDel(null); reloadData?.();
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-black text-gray-900">Leave Management</h1>
        <p className="text-sm text-gray-500 mt-0.5">File leaves so employees show as “On Leave” instead of absent{deptLabel(activeDept)?` — ${deptLabel(activeDept)}`:""}</p>
      </div>

      {/* File new leave */}
      <div className="bg-white rounded-3xl border border-gray-100 shadow-sm p-6">
        <h2 className="font-bold text-gray-800 mb-4">File a Leave</h2>
        <div className="grid md:grid-cols-2 gap-4">
          <div>
            <label className="text-xs font-bold text-gray-500 uppercase tracking-wider block mb-1.5">Employee</label>
            <select value={form.employee_id} onChange={e=>setForm(f=>({...f,employee_id:e.target.value}))} className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-200 bg-white">
              <option value="">— Select employee —</option>
              {active.map(e=><option key={e.id} value={e.id}>{e.name} · {e.department}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs font-bold text-gray-500 uppercase tracking-wider block mb-1.5">Leave Type</label>
            <select value={form.leave_type} onChange={e=>setForm(f=>({...f,leave_type:e.target.value}))} className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none bg-white">
              <option value="leave">Leave</option><option value="sick">Sick Leave</option><option value="vacation">Vacation</option><option value="emergency">Emergency</option><option value="suspension">Suspension</option><option value="halfday">Half Day</option>
            </select>
          </div>
          <div>
            <label className="text-xs font-bold text-gray-500 uppercase tracking-wider block mb-1.5">From</label>
            <input type="date" value={form.date_from} onChange={e=>setForm(f=>({...f,date_from:e.target.value}))} className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none cursor-pointer"/>
          </div>
          <div>
            <label className="text-xs font-bold text-gray-500 uppercase tracking-wider block mb-1.5">To</label>
            <input type="date" value={form.date_to} min={form.date_from} onChange={e=>setForm(f=>({...f,date_to:e.target.value}))} className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none cursor-pointer"/>
          </div>
          <div className="md:col-span-2">
            <label className="text-xs font-bold text-gray-500 uppercase tracking-wider block mb-1.5">Reason (optional)</label>
            <input value={form.reason} onChange={e=>setForm(f=>({...f,reason:e.target.value}))} placeholder="e.g. Family matter" className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-200"/>
          </div>
        </div>
        <button onClick={fileLeave} disabled={saving} className="mt-4 bg-brand-600 text-white text-sm font-bold px-6 py-3 rounded-xl hover:bg-brand-500 disabled:opacity-60 active:scale-95">{saving?"Filing…":"File Leave"}</button>
      </div>

      {/* Existing leaves */}
      <div className="bg-white rounded-3xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100"><h2 className="font-bold text-gray-800">Filed Leaves <span className="opacity-40">({visibleLeaves.length})</span></h2></div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-gray-100 bg-gray-50/60">{["Employee","Type","From","To","Reason","Filed By","Status",""].map(h=><th key={h} className="text-left text-xs font-semibold text-gray-400 uppercase tracking-wider px-5 py-3.5">{h}</th>)}</tr></thead>
            <tbody className="divide-y divide-gray-50">
              {visibleLeaves.length===0?<tr><td colSpan={8} className="text-center py-12 text-gray-400 text-sm">No leaves filed</td></tr>
                :visibleLeaves.map(l=>{ const st=l.status??'approved'; return (
                  <tr key={l.id} className={`hover:bg-gray-50/60 transition-colors ${st==='pending'?"bg-amber-50/40":""}`}>
                    <td className="px-5 py-3.5"><div className="font-semibold text-gray-800">{empName(l.employee_id)}</div><div className="text-xs text-gray-400">{empDept(l.employee_id)}</div></td>
                    <td className="px-5 py-3.5"><span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-brand-100 text-brand-700 border border-brand-200 capitalize">{l.leave_type}{l.offset_hours?` ${l.offset_hours}h`:""}</span></td>
                    <td className="px-5 py-3.5 text-xs text-gray-600 whitespace-nowrap">{fmtDate(String(l.date_from).slice(0,10))}</td>
                    <td className="px-5 py-3.5 text-xs text-gray-600 whitespace-nowrap">{fmtDate(String(l.date_to).slice(0,10))}</td>
                    <td className="px-5 py-3.5 text-xs text-gray-500">{l.reason||"—"}</td>
                    <td className="px-5 py-3.5 text-xs text-gray-400">{l.filed_by||"—"}</td>
                    <td className="px-5 py-3.5"><span className={`text-xs font-bold px-2.5 py-1 rounded-full border capitalize ${st==='approved'?"bg-brand-50 text-brand-700 border-brand-200":st==='rejected'?"bg-red-50 text-red-700 border-red-200":"bg-amber-50 text-amber-700 border-amber-200"}`}>{st}</span></td>
                    <td className="px-5 py-3.5 whitespace-nowrap">
                      {st==='pending'&&<>
                        <button onClick={()=>reviewLeave(l,'approved')} className="px-2.5 py-1.5 text-xs font-bold text-white bg-brand-500 hover:bg-brand-600 rounded-lg mr-1.5">Approve</button>
                        <button onClick={()=>reviewLeave(l,'rejected')} className="px-2.5 py-1.5 text-xs font-semibold text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg mr-1.5">Reject</button>
                      </>}
                      <button onClick={()=>setConfirmDel(l)} className="px-2.5 py-1.5 text-xs font-semibold text-red-600 bg-red-50 hover:bg-red-100 rounded-lg">Remove</button>
                    </td>
                  </tr>
                );})
              }
            </tbody>
          </table>
        </div>
      </div>

      {confirmDel&&(
        <div className="fixed inset-0 bg-slate-900/25 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={()=>setConfirmDel(null)}>
          <div className="bg-white rounded-3xl w-full max-w-sm shadow-2xl p-7 text-center" onClick={e=>e.stopPropagation()}>
            <div className="text-4xl mb-4">🗑️</div>
            <h2 className="text-lg font-black mb-2">Remove Leave</h2>
            <p className="text-sm text-gray-500 mb-6">Remove the leave for <span className="font-bold">{empName(confirmDel.employee_id)}</span>?</p>
            <div className="flex gap-3">
              <button onClick={()=>setConfirmDel(null)} className="flex-1 border border-gray-200 text-gray-600 text-sm font-semibold py-2.5 rounded-xl">Cancel</button>
              <button onClick={doDelete} className="flex-1 bg-red-600 text-white text-sm font-bold py-2.5 rounded-xl hover:bg-red-500">Remove</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// BEHAVIOR REPORT — late & absent totals per employee (weekly / monthly)
// ════════════════════════════════════════════════════════════════════════════
function AdminBehavior({ employees, allAttendance, leaves, activeDept }) {
  const TODAY=getToday();
  const [dateFrom,setFrom]=useState(daysAgoStr(6));
  const [dateTo,setTo]=useState(TODAY);
  const [empFilter,setEmpFilter]=useState("all");
  const [bSearch,setBSearch]=useState("");
  const [drill,setDrill]=useState(null); // {empName, kind, dates:[]}

  const PRESETS=[
    {l:"Last 7d",f:daysAgoStr(6),t:TODAY},
    {l:"Last 14d",f:daysAgoStr(13),t:TODAY},
    {l:"Last 30d",f:daysAgoStr(29),t:TODAY},
    {l:"This Month",f:(()=>{const d=new Date();return localDateStr(new Date(d.getFullYear(),d.getMonth(),1));})(),t:TODAY},
  ];
  const active=employees.filter(e=>e.status==="active"&&deptMatch(activeDept,e.department));

  // Build per-employee tallies AND capture the exact dates for late/absent
  const data=useMemo(()=>{
    const calendar=[]; { const d=new Date(dateFrom+"T00:00:00"); const end=new Date(dateTo+"T00:00:00"); while(d<=end){ calendar.push(localDateStr(d)); d.setDate(d.getDate()+1); } }
    return active.map(emp=>{
      const lateDates=[],absentDates=[],halfDates=[],underDates=[]; let present=0,leaveDays=0;
      calendar.forEach(date=>{
        if (date>TODAY) return; // don't count future days
        const dayHasRecords=Object.keys(allAttendance[date]||{}).length>0;
        const rec=allAttendance[date]?.[emp.id] || {date};
        const s=computeDisplayStatus(emp,rec,date===TODAY,isOnLeave(leaves,emp.id,date));
        if (s==="late") lateDates.push({date,timeIn:rec?.timeIn});
        else if (s==="absent") { if(date===TODAY||dayHasRecords) absentDates.push({date}); } // skip empty past days
        else if (s==="present") present++;
        else if (s==="half-day") halfDates.push({date});
        else if (s==="undertime") underDates.push({date});
        else if (s==="on-leave") leaveDays++;
      });
      return {emp,lateDates,absentDates,halfDates,underDates,present,leaveDays,
        late:lateDates.length,absent:absentDates.length,half:halfDates.length,under:underDates.length};
    });
  },[allAttendance,active,leaves,dateFrom,dateTo,TODAY]);

  const shown=data.filter(r=>(empFilter==="all"||r.emp.id===empFilter)&&(bSearch===""||r.emp.name.toLowerCase().includes(bSearch.toLowerCase())))
                  .sort((a,b)=>(b.late+b.absent)-(a.late+a.absent));

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-black text-gray-900">Employee Behavior</h1>
        <p className="text-sm text-gray-500 mt-0.5">Late & absences{deptLabel(activeDept)?` — ${deptLabel(activeDept)}`:""}</p>
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 flex flex-wrap gap-3 items-end">
        <div><label className="text-xs font-semibold text-gray-400 block mb-1.5">From</label>
          <input type="date" value={dateFrom} max={dateTo} onChange={e=>setFrom(e.target.value)} className="border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none cursor-pointer"/></div>
        <div><label className="text-xs font-semibold text-gray-400 block mb-1.5">To</label>
          <input type="date" value={dateTo} min={dateFrom} max={TODAY} onChange={e=>setTo(e.target.value)} className="border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none cursor-pointer"/></div>
        <div className="flex gap-2 flex-wrap">{PRESETS.map(({l,f,t})=><button key={l} onClick={()=>{setFrom(f);setTo(t);}} className={`px-3 py-2.5 rounded-xl text-xs font-semibold border transition-colors ${dateFrom===f&&dateTo===t?"bg-brand-500 text-white border-brand-500":"bg-gray-50 text-gray-600 border-gray-200 hover:border-slate-400"}`}>{l}</button>)}</div>
        <input value={bSearch} onChange={e=>setBSearch(e.target.value)} placeholder="Search name…" className="border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none bg-gray-50 flex-1 min-w-[150px]"/>
        <select value={empFilter} onChange={e=>setEmpFilter(e.target.value)} className="border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none bg-gray-50 cursor-pointer">
          <option value="all">All Employees</option>
          {active.map(e=><option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="bg-amber-50 border border-amber-100 rounded-2xl p-5">
          <div className="text-xs font-bold uppercase tracking-widest opacity-50">Total Late</div>
          <div className="text-4xl font-black text-gray-900 mt-1">{shown.reduce((s,r)=>s+r.late,0)}</div>
        </div>
        <div className="bg-red-50 border border-red-100 rounded-2xl p-5">
          <div className="text-xs font-bold uppercase tracking-widest opacity-50">Total Absent</div>
          <div className="text-4xl font-black text-gray-900 mt-1">{shown.reduce((s,r)=>s+r.absent,0)}</div>
        </div>
      </div>

      <div className="bg-white rounded-3xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100"><h2 className="font-bold text-gray-800">Per Employee <span className="text-xs font-normal text-gray-400">— tap a number to see the dates</span></h2></div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-gray-100 bg-gray-50/60">{["Employee","Type","Late","Absent","Half Day","Undertime","Present","On Leave"].map(h=><th key={h} className="text-left text-xs font-semibold text-gray-400 uppercase tracking-wider px-5 py-3.5">{h}</th>)}</tr></thead>
            <tbody className="divide-y divide-gray-50">
              {shown.length===0?<tr><td colSpan={8} className="text-center py-12 text-gray-400 text-sm">No data</td></tr>
                :shown.map(({emp,lateDates,absentDates,halfDates,underDates,present,leaveDays,late,absent,half,under})=>(
                  <tr key={emp.id} className="hover:bg-gray-50/60 transition-colors">
                    <td className="px-5 py-3.5"><div className="font-semibold text-gray-800">{emp.name}</div><div className="text-xs text-gray-400">{emp.department}</div></td>
                    <td className="px-5 py-3.5 text-xs text-gray-500">{emp.empType||"Regular"}</td>
                    <td className="px-5 py-3.5">{late>0?<button onClick={()=>setDrill({empName:emp.name,kind:"Late",dates:lateDates})} className="text-amber-600 font-bold hover:underline cursor-pointer">{late}</button>:<span className="text-gray-300">0</span>}</td>
                    <td className="px-5 py-3.5">{absent>0?<button onClick={()=>setDrill({empName:emp.name,kind:"Absent",dates:absentDates})} className="text-red-600 font-bold hover:underline cursor-pointer">{absent}</button>:<span className="text-gray-300">0</span>}</td>
                    <td className="px-5 py-3.5">{half>0?<button onClick={()=>setDrill({empName:emp.name,kind:"Half Day",dates:halfDates})} className="text-brand-600 font-bold hover:underline cursor-pointer">{half}</button>:<span className="text-gray-300">0</span>}</td>
                    <td className="px-5 py-3.5">{under>0?<button onClick={()=>setDrill({empName:emp.name,kind:"Undertime",dates:underDates})} className="text-orange-600 font-bold hover:underline cursor-pointer">{under}</button>:<span className="text-gray-300">0</span>}</td>
                    <td className="px-5 py-3.5 text-gray-600">{present}</td>
                    <td className="px-5 py-3.5 text-brand-600">{leaveDays||0}</td>
                  </tr>
                ))
              }
            </tbody>
          </table>
        </div>
      </div>

      {drill&&(
        <div className="fixed inset-0 bg-slate-900/25 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={()=>setDrill(null)}>
          <div className="bg-white rounded-3xl w-full max-w-sm shadow-2xl overflow-hidden" onClick={e=>e.stopPropagation()}>
            <div className="bg-gradient-to-r from-brand-600 to-brand-700 px-7 py-5 flex items-center justify-between">
              <div><h2 className="text-lg font-black text-white">{drill.kind} Dates</h2><p className="text-white/50 text-xs mt-0.5">{drill.empName} · {drill.dates.length} day(s)</p></div>
              <button onClick={()=>setDrill(null)} className="text-white/40 hover:text-white text-2xl">×</button>
            </div>
            <div className="p-5 max-h-80 overflow-y-auto divide-y divide-gray-50">
              {drill.dates.map((d,i)=>(
                <div key={i} className="flex items-center justify-between py-2.5">
                  <span className="text-sm font-medium text-gray-700">{fmtDate(d.date)}</span>
                  {d.timeIn&&<span className="text-xs font-mono text-amber-600">in {fmt(d.timeIn)}</span>}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// MANPOWER PLANNING — today's incoming / on-leave / rest-day with names
// ════════════════════════════════════════════════════════════════════════════
function AdminManpower({ employees, allAttendance, leaves, activeDept }) {
  const TODAY=getToday();
  const [viewDate,setViewDate]=useState(TODAY);
  const active=employees.filter(e=>e.status==="active"&&deptMatch(activeDept,e.department));
  const isToday=viewDate===TODAY;

  const groups=useMemo(()=>{
    const incoming=[],onLeaveL=[],restDay=[],present=[],absent=[];
    active.forEach(emp=>{
      const rec=allAttendance[viewDate]?.[emp.id] || {date:viewDate};
      const onLeave=isOnLeave(leaves,emp.id,viewDate);
      const s=computeDisplayStatus(emp,rec,isToday,onLeave);
      if (s==="on-leave"||s==="suspended"||s==="halfday-leave") onLeaveL.push(emp);
      else if (s==="rest-day") restDay.push(emp);
      else if (s==="present"||s==="late"||s==="working"||s==="half-day"||s==="undertime") present.push(emp);
      else if (s==="upcoming") incoming.push(emp);
      else if (s==="absent"||s==="incomplete") absent.push(emp);
    });
    return {incoming,onLeaveL,restDay,present,absent};
  },[active,allAttendance,leaves,viewDate,isToday]);

  const expected=active.length-groups.onLeaveL.length-groups.restDay.length;

  const Section=({title,list,color,icon})=>(
    <div className="bg-white rounded-3xl border border-gray-100 shadow-sm overflow-hidden">
      <div className={`px-5 py-4 border-b border-gray-100 flex items-center justify-between ${color}`}>
        <span className="font-bold text-sm flex items-center gap-2">{icon} {title}</span>
        <span className="text-2xl font-black">{list.length}</span>
      </div>
      <div className="divide-y divide-gray-50 max-h-72 overflow-y-auto">
        {list.length===0?<div className="px-5 py-6 text-center text-gray-400 text-sm">None</div>
          :list.map(e=>(
            <div key={e.id} className="px-5 py-3 flex items-center justify-between">
              <div><div className="font-semibold text-gray-800 text-sm">{e.name}</div><div className="text-xs text-gray-400">{e.position} · {e.department}</div></div>
              <span className="text-xs text-gray-400">{e.empType||"Regular"}</span>
            </div>
          ))
        }
      </div>
    </div>
  );

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-black text-gray-900">Manpower Planning</h1>
          <p className="text-sm text-gray-500 mt-0.5">{fmtDate(viewDate)}{deptLabel(activeDept)?` — ${deptLabel(activeDept)}`:""}</p>
        </div>
        <input type="date" value={viewDate} max={daysAgoStr(-30)} onChange={e=>setViewDate(e.target.value)} className="border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none cursor-pointer"/>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          {l:"Total Workforce",v:active.length,c:"bg-slate-50 border-slate-100"},
          {l:"Expected (manpower)",v:expected,c:"bg-emerald-50 border-emerald-100"},
          {l:"On Leave",v:groups.onLeaveL.length,c:"bg-brand-50 border-brand-100"},
          {l:"Rest Day",v:groups.restDay.length,c:"bg-gray-50 border-gray-100"},
        ].map(({l,v,c})=>(
          <div key={l} className={`rounded-2xl p-5 border ${c}`}>
            <div className="text-xs font-bold uppercase tracking-widest opacity-50">{l}</div>
            <div className="text-3xl font-black text-gray-900 mt-1">{v}</div>
          </div>
        ))}
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        {(isToday||viewDate>TODAY)&&<Section title={viewDate>TODAY?"Scheduled to Work":"Incoming (not yet in)"} list={groups.incoming} color="text-sky-700" icon="🕒"/>}
        {!(viewDate>TODAY)&&<Section title="Present / Working" list={groups.present} color="text-emerald-700" icon="🟢"/>}
        <Section title="On Leave" list={groups.onLeaveL} color="text-brand-700" icon="🌴"/>
        <Section title="Rest Day" list={groups.restDay} color="text-gray-600" icon="📅"/>
        {!(viewDate>TODAY)&&<Section title="Absent" list={groups.absent} color="text-red-700" icon="❌"/>}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// DIRECTORY — employee details, tenure, type
// ════════════════════════════════════════════════════════════════════════════
function AdminDirectory({ employees, activeDept }) {
  const [search,setSearch]=useState("");
  const [typeFilter,setTypeFilter]=useState("all");
  const list=employees
    .filter(e=>deptMatch(activeDept,e.department))
    .filter(e=>typeFilter==="all"||(e.empType||"Regular")===typeFilter)
    .filter(e=>e.name.toLowerCase().includes(search.toLowerCase())||e.id.toLowerCase().includes(search.toLowerCase())||e.department.toLowerCase().includes(search.toLowerCase()))
    .sort((a,b)=>a.name.localeCompare(b.name));
  const typeBadge=t=>({Regular:"bg-emerald-100 text-emerald-700 border-emerald-200",Freelance:"bg-amber-100 text-amber-700 border-amber-200",Direct:"bg-blue-100 text-blue-700 border-blue-200"}[t]||"bg-gray-100 text-gray-600 border-gray-200");

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-black text-gray-900">Directory</h1>
        <p className="text-sm text-gray-500 mt-0.5">{list.length} employees{deptLabel(activeDept)?` — ${deptLabel(activeDept)}`:""}</p>
      </div>
      <div className="flex gap-3 flex-wrap">
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search name, ID, department…" className="flex-1 min-w-[200px] border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none bg-gray-50"/>
        <select value={typeFilter} onChange={e=>setTypeFilter(e.target.value)} className="border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none bg-gray-50 cursor-pointer">
          <option value="all">All Types</option><option value="Regular">Regular</option><option value="Freelance">Freelance</option><option value="Direct">Direct</option>
        </select>
      </div>
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {list.map(e=>{
          const hired=e.startDate||e.createdAt;
          const t=tenureFrom(hired);
          return (
            <div key={e.id} className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-black text-gray-900 truncate">{e.name}</div>
                  <div className="text-xs text-gray-400">{e.position}</div>
                </div>
                <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold border shrink-0 ${typeBadge(e.empType||"Regular")}`}>{e.empType||"Regular"}</span>
              </div>
              <div className="mt-4 space-y-1.5 text-xs">
                <div className="flex justify-between"><span className="text-gray-400">ID</span><span className="font-mono text-gray-700">{e.id}</span></div>
                <div className="flex justify-between"><span className="text-gray-400">Department</span><span className="font-semibold text-gray-700">{e.department}</span></div>
                <div className="flex justify-between"><span className="text-gray-400">Date Hired</span><span className="font-semibold text-gray-700">{hired?fmtDate(String(hired).slice(0,10)):"—"}</span></div>
                <div className="flex justify-between"><span className="text-gray-400">Tenure</span><span className="font-semibold text-gray-700">{t.label}</span></div>
                <div className="flex justify-between"><span className="text-gray-400">Status</span><span className={`font-semibold capitalize ${e.status==="active"?"text-emerald-600":"text-gray-400"}`}>{e.status}</span></div>
                {e.contact&&<div className="flex justify-between"><span className="text-gray-400">Contact</span><span className="font-semibold text-gray-700">{e.contact}</span></div>}
              </div>
            </div>
          );
        })}
        {list.length===0&&<div className="col-span-full text-center py-12 text-gray-400 text-sm">No employees found</div>}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// SETTINGS — super-admin only: manage the Roles list + the Audit Log
// ════════════════════════════════════════════════════════════════════════════
function AdminAuditLog({ addToast, roles }) {
  const [rows,setRows]=useState([]); const [loading,setLoading]=useState(true);
  const [search,setSearch]=useState(""); const [actionFilter,setActionFilter]=useState("all");
  const [newRole,setNewRole]=useState(""); const [roleSaving,setRoleSaving]=useState(false);
  useEffect(()=>{ (async()=>{
    setLoading(true);
    const {data,error}=await supabase.from('audit_log').select('*').order('created_at',{ascending:false}).limit(500);
    if (error) addToast("Couldn't load audit log: "+error.message,"error");
    setRows(data||[]); setLoading(false);
  })(); },[]);
  const actions=[...new Set(rows.map(r=>r.action))];
  const shown=rows.filter(r=>(actionFilter==="all"||r.action===actionFilter)&&(search===""||[r.actor,r.target,r.details,r.action].join(" ").toLowerCase().includes(search.toLowerCase())));
  const fmtWhen=ts=>{ try{return new Date(ts).toLocaleString("en-PH",{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"});}catch{return ts;} };
  const actionLabel=a=>({record_edit:"Record Edit",schedule_override:"Schedule Override",leave_filed:"Leave Filed",leave_removed:"Leave Removed",employee_deleted:"Employee Deleted"}[a]||a);

  const addRole=async()=>{
    const name=newRole.trim();
    if (!name){ addToast("Enter a role name.","error"); return; }
    setRoleSaving(true);
    const {error}=await supabase.from('roles').insert({name});
    setRoleSaving(false);
    if (error){ addToast(error.message.includes("unique")?"That role already exists.":"Failed: "+error.message,"error"); return; }
    addToast(`Role "${name}" added.`,"success"); setNewRole("");
  };
  const removeRole=async name=>{
    const {error}=await supabase.from('roles').delete().eq('name',name);
    if (error){ addToast("Failed: "+error.message,"error"); return; }
    addToast(`Role "${name}" removed.`,"info");
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-black text-gray-900">⚙️ Settings</h1>
        <p className="text-sm text-gray-500 mt-0.5">Manage roles, download the kiosk app, and review the audit trail. Super-admin only.</p>
      </div>

      {/* Kiosk app download — scan with the tablet to install the QR + Facial kiosk APK */}
      <div className="bg-white rounded-3xl border border-gray-100 shadow-sm p-6">
        <h2 className="font-bold text-gray-800 mb-1">Kiosk App (Android)</h2>
        <p className="text-xs text-gray-400 mb-4">One app, both kiosks — after installing, sign in and choose <b>QR Code Kiosk</b> or <b>Facial Kiosk</b>. Scan the QR with the tablet's camera to download, then open the file to install (allow "install from unknown sources").</p>
        <div className="flex flex-col sm:flex-row items-center gap-6">
          <div className="bg-white border-2 border-brand-200 rounded-2xl p-3 shadow-sm">
            <RealQRCode value={`${window.location.origin}/BilisOps-Kiosk.apk`} size={168}/>
          </div>
          <div className="space-y-2 text-center sm:text-left">
            <div className="text-sm font-bold text-ink">BilisOps Kiosk</div>
            <div className="text-xs text-gray-400 font-mono break-all">{window.location.origin}/BilisOps-Kiosk.apk</div>
            <a href="/BilisOps-Kiosk.apk" download className="inline-flex items-center gap-2 bg-brand-500 text-white text-sm font-bold px-5 py-2.5 rounded-xl hover:bg-brand-600 transition-colors shadow-brand">↓ Download APK</a>
            <p className="text-xs text-gray-400">Works offline-first — scans queue up and sync when the tablet reconnects.</p>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-3xl border border-gray-100 shadow-sm p-6">
        <h2 className="font-bold text-gray-800 mb-1">Manage Roles</h2>
        <p className="text-xs text-gray-400 mb-4">These appear in the Role dropdown when adding/editing an employee, and in the Role filter up top.</p>
        <div className="flex gap-2 mb-4">
          <input value={newRole} onChange={e=>setNewRole(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addRole()} placeholder="e.g. Team Lead" className="flex-1 max-w-xs border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-200"/>
          <button onClick={addRole} disabled={roleSaving} className="bg-brand-500 text-white text-sm font-bold px-5 py-2.5 rounded-xl hover:bg-brand-600 disabled:opacity-60 active:scale-95">{roleSaving?"Adding…":"+ Add Role"}</button>
        </div>
        <div className="flex flex-wrap gap-2">
          {(roles||[]).length===0?<p className="text-xs text-gray-400">No roles yet.</p>:(roles||[]).map(r=>(
            <span key={r} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold bg-slate-100 text-slate-700 border border-slate-200">
              {r}<button onClick={()=>removeRole(r)} title="Remove role" className="text-slate-400 hover:text-red-600">×</button>
            </span>
          ))}
        </div>
      </div>

      <div>
        <h2 className="text-lg font-black text-gray-900">🔒 Audit Log</h2>
        <p className="text-sm text-gray-500 mt-0.5">Who changed what, and when.</p>
      </div>
      <div className="flex gap-3 flex-wrap">
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search actor, employee, details…" className="flex-1 min-w-[200px] border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none bg-gray-50"/>
        <select value={actionFilter} onChange={e=>setActionFilter(e.target.value)} className="border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none bg-gray-50 cursor-pointer">
          <option value="all">All Actions</option>
          {actions.map(a=><option key={a} value={a}>{actionLabel(a)}</option>)}
        </select>
      </div>
      <div className="bg-white rounded-3xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-gray-100 bg-gray-50/60">{["When","Who","Action","Employee","Details"].map(h=><th key={h} className="text-left text-xs font-semibold text-gray-400 uppercase tracking-wider px-5 py-3.5">{h}</th>)}</tr></thead>
            <tbody className="divide-y divide-gray-50">
              {loading?<tr><td colSpan={5} className="text-center py-12 text-gray-400">Loading…</td></tr>
                :shown.length===0?<tr><td colSpan={5} className="text-center py-12 text-gray-400">No log entries</td></tr>
                :shown.map(r=>(
                  <tr key={r.id} className="hover:bg-gray-50/60">
                    <td className="px-5 py-3 text-xs text-gray-500 whitespace-nowrap">{fmtWhen(r.created_at)}</td>
                    <td className="px-5 py-3 text-sm font-semibold text-gray-800">{r.actor}</td>
                    <td className="px-5 py-3"><span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-slate-100 text-slate-700 border border-slate-200">{actionLabel(r.action)}</span></td>
                    <td className="px-5 py-3 text-sm text-gray-600">{r.target||"—"}</td>
                    <td className="px-5 py-3 text-xs text-gray-500">{r.details||"—"}</td>
                  </tr>
                ))
              }
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// LOADING / ERROR
// ════════════════════════════════════════════════════════════════════════════
function LoadingScreen() {
  return <div className="min-h-screen bg-mist flex flex-col items-center justify-center gap-6">
    <div className="w-16 h-16 border-4 border-gray-200 border-t-brand-500 rounded-full animate-spin"/>
    <p className="text-gray-400 text-sm font-medium">Connecting to database…</p>
  </div>;
}
function ErrorScreen({ message, onRetry }) {
  return <div className="min-h-screen bg-mist flex flex-col items-center justify-center gap-6 p-8 text-center">
    <div className="text-5xl">⚠️</div>
    <div><h2 className="text-gray-800 text-xl font-black mb-2">Database connection failed</h2><p className="text-gray-400 text-sm max-w-md">{message}</p></div>
    <button onClick={onRetry} className="bg-brand-500 text-gray-800 font-bold px-6 py-3 rounded-2xl hover:bg-brand-600">Retry</button>
  </div>;
}

// ════════════════════════════════════════════════════════════════════════════
// ADMIN PORTAL SHELL
// ════════════════════════════════════════════════════════════════════════════
function AdminPortal({ employees, setEmployees, allAttendance, leaves, roles, adminUser, addToast, onLogout, reloadData, quietRefresh }) {
  // The admin-backoffice domain (VITE_APP_MODE=admin) opens on Registrations; the app opens on the dashboard.
  // Land on the page that matches the tenant's plan (admin domain → Registrations).
  const [page,setPage]=useState(
    ADMIN_ONLY ? "registrations" :
    (PAGE_OPTIONS.map(([k])=>k).find(k=>canPage(adminUser,k)&&(
      k==="employees"||k==="directory"&&hasMod(adminUser,'directory')||k==="payroll"&&hasMod(adminUser,'payroll')||["dashboard","schedules","leaves","manpower","behavior","reports"].includes(k)&&hasMod(adminUser,'attendance')
    ))||"employees")
  ); const [reportFilter,setRF]=useState("all"); const [reportRange,setReportRange]=useState(null); const [showBulk,setShowBulk]=useState(false);
  const [hovered,setHovered]=useState(false);
  const logoTaps=useRef(0); const logoTimer=useRef(null);
  const handleLogoTap=()=>{
    setHovered(false);
    if (!isSuperAdmin) return; // secret page is super-admin only
    logoTaps.current++;
    clearTimeout(logoTimer.current);
    if (logoTaps.current>=5){ logoTaps.current=0; setPage("audit"); addToast("Audit log unlocked.","info"); return; }
    logoTimer.current=setTimeout(()=>{ logoTaps.current=0; }, 1500);
  };
  const [mobileOpen,setMobileOpen]=useState(false);
  const isSuperAdmin=adminUser.role==="super_admin";
  const allDepartments=useMemo(()=>[...new Set(employees.map(e=>e.department))].sort(),[employees]);
  const accessibleDepts=useMemo(()=>{ if(isSuperAdmin||!adminUser.departmentAccess?.length) return allDepartments; return adminUser.departmentAccess; },[isSuperAdmin,adminUser.departmentAccess,allDepartments]);
  // Multi-select departments: empty set = all accessible. Persisted across reloads.
  const [selectedDepts,setSelectedDepts]=useState(()=>{ try{ const s=localStorage.getItem('attendancehq_depts'); return s?JSON.parse(s):[]; }catch{ return []; } });
  useEffect(()=>{ try{ localStorage.setItem('attendancehq_depts', JSON.stringify(selectedDepts)); }catch{} },[selectedDepts]);
  // A department filter narrowed to specific names is persisted across reloads (above). Without this,
  // a brand-new department created later would be silently excluded from that stale filter everywhere
  // (Employees, Reports, Schedules, etc.) with no visible sign why — so auto-include newly-seen
  // departments into an already-active filter as soon as they appear.
  const knownDeptsRef=useRef(null);
  useEffect(()=>{
    // Never take an empty list as the baseline — if employees haven't loaded yet, every
    // department would later count as "newly seen" and blow the saved filter wide open.
    if (knownDeptsRef.current===null) { if(allDepartments.length>0) knownDeptsRef.current=new Set(allDepartments); return; }
    const newlySeen=allDepartments.filter(d=>!knownDeptsRef.current.has(d));
    knownDeptsRef.current=new Set(allDepartments);
    if (newlySeen.length>0) setSelectedDepts(prev=>prev.length>0?[...new Set([...prev,...newlySeen])]:prev);
  },[allDepartments]);
  const [deptMenuOpen,setDeptMenuOpen]=useState(false);
  // activeDept passed to pages: "all" when none selected, the single name when one, or an array-aware matcher
  const deptList = selectedDepts.length>0 ? selectedDepts : accessibleDepts;
  // For pages, we pass a predicate-friendly value. Pages currently use activeDept==="all" or ===name.
  // To support multi, we pass "all" when all-or-none selected, else a special multi object handled below.
  const activeDept = selectedDepts.length===0
    ? (isSuperAdmin || !adminUser.departmentAccess?.length ? "all" : (accessibleDepts.length===1 ? accessibleDepts[0] : {multi:accessibleDepts}))
    : (selectedDepts.length===1 ? selectedDepts[0] : {multi:selectedDepts});

  // Role filter — a simple single-select next to the department filter. Persisted the same
  // way. Falls back to whatever roles are actually in use if the managed roles list (Settings
  // → Manage Roles) hasn't loaded or is empty yet, so the dropdown is never blank.
  const [activeRole,setActiveRole]=useState(()=>{ try{ return localStorage.getItem('attendancehq_role')||"all"; }catch{ return "all"; } });
  useEffect(()=>{ try{ localStorage.setItem('attendancehq_role', activeRole); }catch{} },[activeRole]);
  const roleOptions=useMemo(()=>{ const fromEmp=[...new Set(employees.map(e=>e.role||"Staff"))]; return [...new Set([...(roles||[]),...fromEmp])].sort(); },[roles,employees]);
  const [roleMenuOpen,setRoleMenuOpen]=useState(false);

  // Grouped navigation: parent ("mother") buttons drop down their child pages.
  const NAV_TREE=[
    {k:"dashboard",l:"Dashboard",icon:"dashboard",mod:"attendance"},
    {g:"People",icon:"employees",kids:[
      {k:"employees",l:"Employees",icon:"employees"},                     // core — every module needs the roster
      {k:"directory",l:"Directory",icon:"directory",mod:"directory"},
    ]},
    {g:"Attendance",icon:"clock",kids:[
      {k:"schedules",l:"Schedules",icon:"schedules",mod:"attendance"},
      {k:"leaves",   l:"Leave",    icon:"leaves",   mod:"attendance"},
      {k:"manpower", l:"Manpower Planning",icon:"manpower",mod:"attendance"},
      {k:"behavior", l:"Behavior", icon:"behavior", mod:"attendance"},
      {k:"reports",  l:"Reports",  icon:"reports",  mod:"attendance"},
    ]},
    {k:"payroll",  l:"Payroll",  icon:"payroll",  mod:"payroll"},
    {g:"Admin",icon:"shield",superOnly:true,kids:[
      {k:"registrations", l:"Registrations", icon:"userplus",superOnly:true},
      {k:"accounts", l:"Accounts", icon:"accounts",superOnly:true},
      {k:"audit",    l:"Settings", icon:"settings",superOnly:true},
    ]},
  ];
  const goToReports=(status,from,to)=>{setRF(status);setReportRange({from,to,n:(reportRange?.n||0)+1});setPage("reports");};
  const navOk=n=>(!n.superOnly||isSuperAdmin)&&(!n.mod||hasMod(adminUser,n.mod))&&(n.superOnly||!n.k||canPage(adminUser,n.k));
  const tree=NAV_TREE.map(n=>n.kids?{...n,kids:n.kids.filter(navOk)}:n).filter(n=>n.kids?(n.kids.length>0&&(!n.superOnly||isSuperAdmin)):navOk(n));
  const flatNav=tree.flatMap(n=>n.kids||[n]);
  const [openGroups,setOpenGroups]=useState(()=>{const o={};NAV_TREE.forEach(n=>{if(n.kids&&n.kids.some(c=>c.k===page))o[n.g]=true;});return o;});
  const toggleGroup=g=>setOpenGroups(p=>({...p,[g]:!p[g]}));
  const go=k=>{ if(k==="reports"){ setRF("all"); setReportRange(null); } setPage(k); setMobileOpen(false); quietRefresh?.(); };
  const toggleDept=d=>setSelectedDepts(p=>p.includes(d)?p.filter(x=>x!==d):[...p,d]);

  // Collapsible sidebar: a pin toggle (remembered per device) + hover-to-peek when collapsed.
  const [navPinned,setNavPinned]=useState(()=>{ try{ return localStorage.getItem('bilisops_nav_pinned')!=='0'; }catch{ return true; } });
  const setPinned=v=>{ setNavPinned(v); try{ localStorage.setItem('bilisops_nav_pinned',v?'1':'0'); }catch{} };
  const collapsed = !navPinned && !hovered;
  const sidebarW = collapsed ? "w-16" : "w-60";

  return (
    <div className="min-h-screen bg-gradient-to-br from-mist via-white to-brand-50/40 flex">
      {showBulk&&<BulkImportModal onClose={()=>setShowBulk(false)} onImport={reloadData} addToast={addToast} employees={employees}/>}

      {/* Mobile overlay */}
      {mobileOpen&&<div className="fixed inset-0 bg-slate-900/20 backdrop-blur-sm z-30 md:hidden" onClick={()=>setMobileOpen(false)}/>}

      {/* Sidebar */}
      {/* Spacer reserves the pinned width in the layout (desktop) */}
      <div className={`hidden md:block ${navPinned?"w-60":"w-16"} shrink-0 transition-all duration-200`}/>
      <aside onMouseEnter={()=>setHovered(true)} onMouseLeave={()=>setHovered(false)}
        className={`${sidebarW} ${mobileOpen?"translate-x-0 w-60":"-translate-x-full"} md:translate-x-0 fixed top-0 left-0 z-40 h-screen bg-gradient-to-b from-white to-brand-50/50 border-r border-gray-100 text-gray-600 flex flex-col transition-all duration-200 shrink-0 ${hovered&&!navPinned?"shadow-xl":""}`}>
        <button onClick={handleLogoTap} className="flex items-center gap-3 px-4 h-16 border-b border-gray-100 shrink-0 w-full text-left hover:bg-brand-50 transition-colors">
          <BrandMark className="w-9 h-9 rounded-xl"/>
          {!collapsed&&<div className="min-w-0"><div className="font-black text-sm truncate text-ink">BilisOps</div><div className="text-brand-600 text-[10px] font-bold">Smart Attendance</div></div>}
        </button>
        <nav className="flex-1 overflow-y-auto py-3 px-2 space-y-1">
          {tree.map(item=>item.kids?(
            <div key={item.g}>
              {/* Mother button — drops down its daughter pages */}
              <button onClick={()=>{ if(collapsed){ setPinned(true); setOpenGroups(p=>({...p,[item.g]:true})); } else toggleGroup(item.g); }} title={item.g}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-bold transition-colors ${item.kids.some(c=>c.k===page)?"text-brand-700 bg-brand-50/70":"text-gray-500"} hover:text-brand-700 hover:bg-brand-50`}>
                <Icon name={item.icon} className="w-5 h-5 shrink-0"/>
                {!collapsed&&<><span className="truncate flex-1 text-left">{item.g}</span><span className={`text-[10px] text-gray-400 transition-transform duration-200 ${openGroups[item.g]?"rotate-90":""}`}>▶</span></>}
              </button>
              {!collapsed&&openGroups[item.g]&&(
                <div className="mt-1 space-y-1">
                  {item.kids.map(c=>(
                    <button key={c.k} onClick={()=>go(c.k)} title={c.l}
                      className={`w-full flex items-center gap-2.5 pl-9 pr-3 py-2 rounded-xl text-[13px] font-semibold transition-colors ${page===c.k?"bg-brand-500 text-white shadow-brand":"text-gray-500 hover:text-brand-700 hover:bg-brand-50"}`}>
                      <Icon name={c.icon} className="w-4 h-4 shrink-0"/>
                      <span className="truncate">{c.l}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ):(
            <button key={item.k} onClick={()=>go(item.k)} title={item.l}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-semibold transition-colors ${page===item.k?"bg-brand-500 text-white shadow-brand":"text-gray-500 hover:text-brand-700 hover:bg-brand-50"}`}>
              <Icon name={item.icon} className="w-5 h-5 shrink-0"/>
              {!collapsed&&<span className="truncate">{item.l}</span>}
            </button>
          ))}
        </nav>
        <div className="border-t border-gray-100 p-2 space-y-1">
          <button onClick={()=>setPinned(!navPinned)} title={navPinned?"Collapse sidebar":"Expand sidebar"}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-semibold text-gray-400 hover:text-brand-700 hover:bg-brand-50 transition-colors">
            <span className={`w-5 h-5 shrink-0 flex items-center justify-center font-black transition-transform duration-200 ${navPinned?"":"rotate-180"}`}>«</span>
            {!collapsed&&<span>Collapse</span>}
          </button>
          <button onClick={onLogout} title="Sign Out" className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-semibold text-gray-500 hover:text-red-600 hover:bg-red-50 transition-colors">
            <Icon name="logout" className="w-5 h-5 shrink-0"/>{!collapsed&&<span>Sign Out</span>}
          </button>
        </div>
      </aside>

      {/* Main column */}
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="bg-white border-b border-gray-100 shadow-sm sticky top-0 z-20">
          <div className="px-4 md:px-6 flex items-center justify-between h-16 gap-3">
            <div className="flex items-center gap-3">
              <button onClick={()=>setMobileOpen(true)} className="md:hidden text-gray-500"><Icon name="menu" className="w-6 h-6"/></button>
              <h2 className="font-black text-gray-900 text-base capitalize">{flatNav.find(n=>n.k===page)?.l||page}</h2>
            </div>
            <div className="flex items-center gap-2">
              {/* Multi-select department */}
              {accessibleDepts.length>1&&(
                <div className="relative">
                  <button onClick={()=>setDeptMenuOpen(o=>!o)} className="border border-gray-200 rounded-xl px-3 py-2 text-xs font-semibold bg-gray-50 hover:border-slate-400 transition-colors flex items-center gap-2">
                    <span>{selectedDepts.length===0?"All Departments":selectedDepts.length===1?selectedDepts[0]:`${selectedDepts.length} departments`}</span>
                    <span className="text-gray-400">▾</span>
                  </button>
                  {deptMenuOpen&&(
                    <>
                      <div className="fixed inset-0 z-30" onClick={()=>setDeptMenuOpen(false)}/>
                      <div className="absolute right-0 top-11 w-56 bg-white border border-gray-100 rounded-2xl shadow-xl z-40 p-2 max-h-72 overflow-y-auto">
                        <button onClick={()=>{setSelectedDepts([]);}} className={`w-full text-left px-3 py-2 rounded-lg text-xs font-semibold ${selectedDepts.length===0?"bg-brand-500 text-white":"text-gray-600 hover:bg-gray-100"}`}>All Departments</button>
                        <div className="border-t border-gray-100 my-1"/>
                        {accessibleDepts.map(d=>(
                          <label key={d} className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium cursor-pointer ${selectedDepts.includes(d)?"bg-brand-50 text-brand-700":"text-gray-600 hover:bg-gray-100"}`}>
                            <input type="checkbox" checked={selectedDepts.includes(d)} onChange={()=>toggleDept(d)} className="accent-brand-600"/>
                            {d}
                          </label>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}
              {/* Single-select role filter — always shown (unlike Department) so it's
                  discoverable even before more than one role exists; Roles is a brand-new
                  list that starts as just "Staff" until you add more in Settings. */}
              {roleOptions.length>0&&(
                <div className="relative">
                  <button onClick={()=>setRoleMenuOpen(o=>!o)} className="border border-gray-200 rounded-xl px-3 py-2 text-xs font-semibold bg-gray-50 hover:border-slate-400 transition-colors flex items-center gap-2">
                    <span>{activeRole==="all"?"All Roles":activeRole}</span>
                    <span className="text-gray-400">▾</span>
                  </button>
                  {roleMenuOpen&&(
                    <>
                      <div className="fixed inset-0 z-30" onClick={()=>setRoleMenuOpen(false)}/>
                      <div className="absolute right-0 top-11 w-48 bg-white border border-gray-100 rounded-2xl shadow-xl z-40 p-2 max-h-72 overflow-y-auto">
                        <button onClick={()=>{setActiveRole("all");setRoleMenuOpen(false);}} className={`w-full text-left px-3 py-2 rounded-lg text-xs font-semibold ${activeRole==="all"?"bg-brand-500 text-white":"text-gray-600 hover:bg-gray-100"}`}>All Roles</button>
                        <div className="border-t border-gray-100 my-1"/>
                        {roleOptions.map(r=>(
                          <button key={r} onClick={()=>{setActiveRole(r);setRoleMenuOpen(false);}} className={`w-full text-left px-3 py-2 rounded-lg text-xs font-medium ${activeRole===r?"bg-brand-50 text-brand-700":"text-gray-600 hover:bg-gray-100"}`}>{r}</button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}
              <NotificationBell adminUser={adminUser}/>
            </div>
          </div>
        </header>
        <main className="flex-1 w-full max-w-7xl mx-auto px-4 md:px-6 py-8">
          {page==="dashboard"&&<AdminDashboard employees={employees} allAttendance={allAttendance} leaves={leaves} onCardClick={goToReports} activeDept={activeDept} activeRole={activeRole} quietRefresh={quietRefresh} addToast={addToast}/>}
          {page==="payroll"&&<AdminPayroll employees={employees} allAttendance={allAttendance} leaves={leaves} addToast={addToast} adminUser={adminUser}/>}
          {page==="employees"&&<AdminEmployees employees={employees} setEmployees={setEmployees} addToast={addToast} onBulkImport={()=>setShowBulk(true)} activeDept={activeDept} activeRole={activeRole} roles={roleOptions} adminUser={adminUser}/>}
          {page==="directory"&&<AdminDirectory employees={employees} activeDept={activeDept}/>}
          {page==="schedules"&&<AdminSchedule employees={employees} setEmployees={setEmployees} addToast={addToast} activeDept={activeDept} isSuperAdmin={isSuperAdmin} reloadData={quietRefresh}/>}
          {page==="leaves"&&<AdminLeaves employees={employees} leaves={leaves} addToast={addToast} activeDept={activeDept} adminUser={adminUser} reloadData={quietRefresh}/>}
          {page==="manpower"&&<AdminManpower employees={employees} allAttendance={allAttendance} leaves={leaves} activeDept={activeDept}/>}
          {page==="behavior"&&<AdminBehavior employees={employees} allAttendance={allAttendance} leaves={leaves} activeDept={activeDept}/>}
          {page==="reports"&&<AdminReports employees={employees} allAttendance={allAttendance} leaves={leaves} addToast={addToast} initialStatus={reportFilter} jumpRange={reportRange} activeDept={activeDept} activeRole={activeRole} reloadData={reloadData} quietRefresh={quietRefresh} isSuperAdmin={isSuperAdmin} adminUser={adminUser}/>}
          {page==="audit"&&isSuperAdmin&&<AdminAuditLog addToast={addToast} roles={roleOptions}/>}
          {page==="registrations"&&isSuperAdmin&&<AdminRegistrations adminUser={adminUser} addToast={addToast}/>}
          {page==="accounts"&&<AdminAccounts adminUser={adminUser} addToast={addToast} allDepartments={allDepartments}/>}
        </main>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// APP MODE — one codebase, several deployable builds so each piece can live on its
// OWN DOMAIN or ship as its own APK:
//   'full'    → landing + app + both kiosks (default, all-in-one dev build)
//   'landing' → MARKETING LANDING ONLY (e.g. bilisops.com) — CTAs link to the app domain
//   'app'     → LOGIN + HR app, opens on the dashboard (e.g. app.bilisops.com)
//   'admin'   → SUPER-ADMIN BACKOFFICE, opens on Registrations (e.g. admin.bilisops.com)
//   'kiosk'   → single kiosk APK: login → choose QR or Facial
//   'qr'      → QR / camera kiosk ONLY (dedicated kiosk APK)
//   'facial'  → facial-recognition kiosk ONLY (dedicated kiosk APK)
// Chosen at build time via VITE_APP_MODE (.env.landing / .env.app / .env.admin / …),
// or override live with ?mode=… in the URL. In 'landing' mode, VITE_APP_URL points the
// CTAs at the app domain.
// ════════════════════════════════════════════════════════════════════════════
const APP_MODE = (() => {
  try { const q = new URLSearchParams(window.location.search).get('mode'); if (q) return q; } catch {}
  return import.meta.env.VITE_APP_MODE || 'full';
})();
const KIOSK_ONLY   = APP_MODE === 'qr' || APP_MODE === 'facial';
const KIOSK_HOME   = APP_MODE === 'facial' ? 'facial-kiosk' : 'kiosk';
const LANDING_ONLY = APP_MODE === 'landing';
const APP_ONLY     = APP_MODE === 'app';
// 'admin' → the super-admin backoffice (its own domain): login → Registrations,
// Accounts, Settings. Separate from the customer-facing 'app'.
const ADMIN_ONLY   = APP_MODE === 'admin';
// 'kiosk' → the single kiosk APK: admin login → choose QR or Facial kiosk.
const COMBINED     = APP_MODE === 'kiosk';
// Local `npm run dev:landing` links to the local app port; production uses the real domain.
const APP_URL      = (import.meta.env.DEV && import.meta.env.VITE_APP_URL_DEV) || import.meta.env.VITE_APP_URL || '';
// Optional deep-link: ?screen=register opens the sign-up form directly (used when
// the landing lives on another domain and links people straight to registration).
const SCREEN_PARAM = (() => { try { return new URLSearchParams(window.location.search).get('screen'); } catch { return null; } })();

// ════════════════════════════════════════════════════════════════════════════
// APP ROOT
// ════════════════════════════════════════════════════════════════════════════
function AppInner() {
  // ── Restore session on load so reload does NOT log you out ────────────────
  const savedUser = loadSession();
  const savedKiosk = loadKioskSession();
  // Scope all data queries to the signed-in tenant BEFORE the first load runs.
  setTenant((savedUser||savedKiosk)?.tenantId||null);
  const [screen,        setScreen]    = useState(
    COMBINED     ? (savedKiosk ? "kiosk-choose" : "kiosk-login") :
    KIOSK_ONLY   ? KIOSK_HOME :
    LANDING_ONLY ? "landing"   :
    (SCREEN_PARAM==="register" && !savedUser) ? "register" :
    (APP_ONLY||ADMIN_ONLY) ? (savedUser ? "admin" : "admin-login") :
    (savedUser ? "admin" : "landing")
  );
  const [adminUser,     setAdminUser] = useState(savedUser);
  const [kioskUser,     setKioskUser] = useState(loadKioskSession());
  const [employees,     setEmployees] = useState([]);
  const [allAttendance, setAttendance]= useState({});
  const [leaves,        setLeaves]    = useState([]);
  const [roles,         setRoles]     = useState([]);
  const [toasts,        setToasts]    = useState([]);
  const [dbLoading,     setDbLoading] = useState(true);
  const [dbError,       setDbError]   = useState(null);

  // ── Separate loaders so realtime never wipes the whole state ──────────────
  const loadEmployees = useCallback(async () => {
    const {data,error}=await supabase.from('employees').select('*').order('id');
    if (!error) setEmployees((data||[]).map(rowToEmp));
  },[]);
  const loadAttendance = useCallback(async () => {
    const {data,error}=await supabase.from('attendance').select('*').order('date',{ascending:false});
    if (!error) setAttendance(buildAttMap(data||[]));
  },[]);
  const loadLeaves = useCallback(async () => {
    const {data,error}=await supabase.from('leaves').select('*').order('date_from',{ascending:false});
    if (!error) setLeaves(data||[]);
  },[]);
  const loadRoles = useCallback(async () => {
    const {data,error}=await supabase.from('roles').select('*').order('name');
    if (!error) setRoles((data||[]).map(r=>r.name));
  },[]);
  const loadData = useCallback(async () => {
    setDbLoading(true); setDbError(null);
    try { await Promise.all([loadEmployees(),loadAttendance(),loadLeaves(),loadRoles()]); }
    catch(e){ setDbError(e.message||'Unknown error'); }
    finally { setDbLoading(false); }
  },[loadEmployees,loadAttendance,loadLeaves,loadRoles]);

  // Quiet refresh — pulls fresh data WITHOUT showing the loading screen
  const quietRefresh = useCallback(async () => {
    try { await Promise.all([loadEmployees(),loadAttendance(),loadLeaves(),loadRoles()]); } catch{}
  },[loadEmployees,loadAttendance,loadLeaves,loadRoles]);

  // Only load business data once SOMEONE is signed in (admin, employee, or kiosk).
  // Loading before login would pull data with no tenant scope applied.
  useEffect(()=>{ if(adminUser||kioskUser) loadData(); else setDbLoading(false); },[loadData]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 15-hour missing-time-out sweep ────────────────────────────────────────
  // Flags any record with a time-in, no time-out, 15h+ elapsed, and not yet flagged.
  // Fires one notification per record. Runs on load and every 10 minutes.
  const sweepMissingTimeouts = useCallback(async () => {
    try {
      const {data}=await supabase.from('attendance').select('*').is('time_out',null).not('time_in','is',null).eq('is_incomplete',false);
      if (!data||!data.length) return;
      for (const row of data) {
        const dateStr=String(row.date).slice(0,10);
        const ms=new Date(`${dateStr}T${String(row.time_in).slice(0,5)}:00`).getTime();
        if ((Date.now()-ms)/(1000*60*60) >= 15) {
          await supabase.from('attendance').update({is_incomplete:true}).eq('id',row.id);
          const emp=(await supabase.from('employees').select('name,department').eq('id',row.employee_id).maybeSingle()).data;
          await supabase.from('notifications').insert({
            type:'incomplete', title:`Missing Time-Out — ${emp?.name||row.employee_id}`,
            message:`${emp?.name||row.employee_id} clocked in on ${dateStr} at ${String(row.time_in).slice(0,5)} but has no time-out after 15 hours.`,
            employee_id:row.employee_id, department:emp?.department||null,
          });
        }
      }
    } catch {}
  },[]);
  useEffect(()=>{
    sweepMissingTimeouts();
    const t=setInterval(sweepMissingTimeouts, 10*60*1000);
    return ()=>clearInterval(t);
  },[sweepMissingTimeouts]);

  // ── Realtime — only reload the table that changed ─────────────────────────
  useEffect(()=>{
    const ch=supabase.channel('db-all')
      .on('postgres_changes',{event:'*',schema:'public',table:'employees'}, ()=>loadEmployees())
      .on('postgres_changes',{event:'*',schema:'public',table:'attendance'},()=>loadAttendance())
      .on('postgres_changes',{event:'*',schema:'public',table:'leaves'},     ()=>loadLeaves())
      .on('postgres_changes',{event:'*',schema:'public',table:'roles'},      ()=>loadRoles())
      .subscribe();
    return ()=>{ supabase.removeChannel(ch); };
  },[loadEmployees,loadAttendance,loadLeaves,loadRoles]);

  // ── Offline scan queue: replay any queued scans to the DB when back online ──
  const flushScanQueue=useCallback(async()=>{
    let q=loadScanQueue();
    if(!q.length || navigator.onLine===false) return;
    const remaining=[];
    for(const payload of q){
      try{ const {error}=await supabase.from('attendance').upsert(payload,{onConflict:'employee_id,date'}); if(error) remaining.push(payload); }
      catch{ remaining.push(payload); }
    }
    saveScanQueue(remaining);
    const synced=q.length-remaining.length;
    if(synced>0){ const tid=Date.now(); setToasts(p=>[...p,{id:tid,message:`Synced ${synced} offline scan(s).`,type:'success'}]); setTimeout(()=>setToasts(p=>p.filter(t=>t.id!==tid)),4000); loadAttendance(); }
  },[loadAttendance]);
  useEffect(()=>{
    flushScanQueue(); // on load, in case scans were left queued from a previous session
    const onOnline=()=>flushScanQueue();
    window.addEventListener('online',onOnline);
    const t=setInterval(()=>{ if(navigator.onLine!==false) flushScanQueue(); }, 60000); // retry each minute
    return ()=>{ window.removeEventListener('online',onOnline); clearInterval(t); };
  },[flushScanQueue]);

  // ── Server-time sync: correct the device clock against Supabase's real clock ──
  const syncServerTime=useCallback(async()=>{
    if(navigator.onLine===false) return;
    try{
      const {data,error}=await supabase.rpc('get_server_time');
      if(error||!data) return;
      const serverMs=new Date(data).getTime();
      if(Number.isFinite(serverMs)) setTimeOffset(serverMs - Date.now());
    }catch{}
  },[]);
  useEffect(()=>{
    syncServerTime();
    const t=setInterval(syncServerTime, 10*60*1000); // re-sync every 10 minutes
    window.addEventListener('online',syncServerTime);
    return ()=>{ clearInterval(t); window.removeEventListener('online',syncServerTime); };
  },[syncServerTime]);

  // ── Toasts ────────────────────────────────────────────────────────────────
  const addToast=useCallback((msg,type="info")=>{ const id=Date.now(); setToasts(p=>[...p,{id,message:msg,type}]); setTimeout(()=>setToasts(p=>p.filter(t=>t.id!==id)),4000); },[]);
  const removeToast=useCallback(id=>setToasts(p=>p.filter(t=>t.id!==id)),[]);

  // ── Employee sync to Supabase ─────────────────────────────────────────────
  const setEmployeesAndSync=useCallback((updaterOrValue)=>{
    setEmployees(prev=>{
      const next=typeof updaterOrValue==="function"?updaterOrValue(prev):updaterOrValue;
      const upserts=next.filter(n=>{const old=prev.find(p=>p.id===n.id);return !old||JSON.stringify(old)!==JSON.stringify(n);});
      const deletedIds=prev.filter(p=>!next.find(n=>n.id===p.id)).map(p=>p.id);
      if (upserts.length>0) {
        const baseRows=upserts.map(e=>({id:e.id,name:e.name,position:e.position,department:e.department,role:e.role||'Staff',contact:e.contact,qr_code:e.qrCode||null,rfid_uid:e.rfidUid||null,face_descriptors:Array.isArray(e.faceDescriptors)?e.faceDescriptors:[],status:e.status,emp_type:e.empType||'Regular',start_date:e.startDate||null,schedule:e.schedule}));
        const payRows=upserts.map((e,i)=>({...baseRows[i],monthly_rate:numOr(e.monthlyRate,0),allowance:numOr(e.allowance,0),sss_no:e.sssNo||null,philhealth_no:e.philhealthNo||null,pagibig_no:e.pagibigNo||null,tin_no:e.tinNo||null,bank_name:e.bankName||null,bank_account:e.bankAccount||null}));
        supabase.from('employees').upsert(payRows).then(async({error})=>{
          // Databases that haven't run the payroll migration yet lack the pay columns — retry without them.
          if(error&&/monthly_rate|allowance|sss_no|philhealth_no|pagibig_no|tin_no|bank_name|bank_account/.test(error.message)) ({error}=await supabase.from('employees').upsert(baseRows));
          if(error) addToast('DB sync error: '+error.message,'error');
        });
      }
      if (deletedIds.length>0) supabase.from('employees').delete().in('id',deletedIds).then(({error})=>{ if(error) addToast('DB delete error: '+error.message,'error'); });
      return next;
    });
  },[addToast]);

  // ── Auth — persist session ────────────────────────────────────────────────
  const handleLogin=user=>{ saveSession(user); setAdminUser(user); setTenant(user.tenantId||null); setScreen("admin"); loadData(); };
  const handleLogout=()=>{ clearSession(); setAdminUser(null); setTenant(null); setScreen("landing"); addToast("Signed out.","info"); };
  const handleKioskLogin=user=>{ saveKioskSession(user); setKioskUser(user); setTenant(user.tenantId||null); if (COMBINED) setScreen("kiosk-choose"); loadData(); };
  const handleKioskLogout=()=>{ clearKioskSession(); setKioskUser(null); setTenant(null); setScreen(COMBINED ? "kiosk-login" : KIOSK_ONLY ? KIOSK_HOME : "landing"); addToast("Kiosk signed out.","info"); };
  // Combined APK → back returns to the kiosk chooser. Dedicated-kiosk builds have no
  // landing to return to, so "back" just re-locks the kiosk.
  const kioskBack = COMBINED ? () => setScreen("kiosk-choose") : KIOSK_ONLY ? handleKioskLogout : () => setScreen("landing");
  // Landing CTAs. When the landing is deployed on its OWN domain (landing mode),
  // send visitors to the app domain instead of switching screens in-page.
  const landingSelect = (key) => {
    if (LANDING_ONLY && APP_URL) {
      const base = APP_URL.replace(/\/+$/,'');
      const suffix = key === "kiosk" ? "/?mode=qr" : key === "facial-kiosk" ? "/?mode=facial" : key === "register" ? "/?screen=register" : "/";
      window.location.href = base + suffix;
    } else setScreen(key);
  };

  // ── Kiosk scan ────────────────────────────────────────────────────────────
  const handleScan=useCallback(async(empId,action,time,isRestDay,cb)=>{
    const TODAY=getToday();
    const emp=employees.find(e=>e.id===empId); if(!emp) return;
    const online = navigator.onLine !== false;
    // When ONLINE, read the authoritative current record from the DB so a scan never overwrites
    // newer data (admin edits / other devices). When OFFLINE, fall back to the in-memory copy.
    let existing = allAttendance[TODAY]?.[empId] || null;
    if (online) {
      try {
        const {data:curRow}=await supabase.from('attendance').select('*').eq('employee_id',empId).eq('date',TODAY).maybeSingle();
        existing = curRow ? rowToAttRec(curRow) : null;
      } catch { /* network hiccup — keep in-memory copy */ }
    }
    const rec = existing ? {...existing} : {employeeId:empId,date:TODAY,status:'absent',timeIn:null,breakStart:null,breakEnd:null,coffeeStart:null,coffeeEnd:null,lunchStart:null,lunchEnd:null,coffeeOver:0,lunchOver:0,timeOut:null,lateMinutes:0,overBreakMinutes:0,hoursWorked:0,isDayOffScan:false,timeInSrc:null,timeOutSrc:null};
    // If an admin already set a per-day override for this employee/date (e.g. an approved
    // extended break, or the snapshot frozen on an earlier scan today), it must win over the
    // employee's normal schedule for every calculation below (grace period, coffee/lunch limits).
    const sched = rec.scheduleOverride ? {...emp.schedule, ...rec.scheduleOverride} : emp.schedule;

    // ── Forgot-to-time-out check: on a fresh time-in, flag any earlier unclosed record (online only) ──
    if (online && action==='time-in' && !existing) {
      try {
        const {data:prev}=await supabase.from('attendance')
          .select('*').eq('employee_id',empId).lt('date',TODAY)
          .not('time_in','is',null).is('time_out',null).eq('is_incomplete',false)
          .order('date',{ascending:false}).limit(1).maybeSingle();
        if (prev) {
          await supabase.from('attendance').update({is_incomplete:true}).eq('id',prev.id);
          await supabase.from('notifications').insert({
            type:'incomplete', title:`Missing Time-Out — ${emp.name}`,
            message:`${emp.name} (${emp.department}) clocked in on ${prev.date} but never timed out. Please review and correct.`,
            employee_id:empId, department:emp.department,
          });
        }
      } catch {}
    }

    // ── Duplicate-action guard: if the field is already written, reject silently ──
    const alreadyDone = (
      (action==='time-in'      && rec.timeIn)      ||
      (action==='break1-start' && rec.coffeeStart) ||
      (action==='break1-end'   && rec.coffeeEnd)   ||
      (action==='break2-start' && rec.lunchStart)  ||
      (action==='break2-end'   && rec.lunchEnd)    ||
      (action==='time-out'     && rec.timeOut)
    );
    if (alreadyDone) { addToast(`Already recorded for ${emp.name}.`,'warning'); cb?.({}); return; }

    const COFFEE_LIMIT=numOr(sched.coffeeBreak,15), LUNCH_LIMIT=numOr(sched.lunchBreak,60);
    let extra={};
    let wroteSnapshot=false; // only persist schedule_override when WE create the initial snapshot below
    if (isRestDay&&action==='time-in') {
      rec.timeIn=time; rec.timeInSrc='scan'; rec.status='present'; rec.isDayOffScan=true;
      if (online) { try { await supabase.from('notifications').insert({type:'day-off',title:`Day Off Scan — ${emp.name}`,message:`${emp.name} (${emp.department}) scanned in at ${time} on their scheduled day off.`,employee_id:empId,department:emp.department}); } catch {} }
      addToast(`⚠ ${emp.name} scanned on day off. Manager notified.`,'warning');
    } else if (action==='time-in') {
      rec.timeIn=time; rec.timeInSrc='scan';
      const grace=numOr(sched.gracePeriod,0);
      const late=Math.max(0,toMins(time)-(toMins(sched.shiftStart)+grace));
      rec.lateMinutes=late>0?toMins(time)-toMins(sched.shiftStart):0;
      rec.status=late>0?'late':'present'; extra={lateMinutes:rec.lateMinutes};
      // SNAPSHOT: freeze the schedule that was active on this day, so future schedule
      // changes never rewrite this day's late/OT/status. Preserve any existing override (e.g. dayType).
      if (!rec.scheduleOverride) {
        rec.scheduleOverride = { shiftStart:sched.shiftStart, shiftEnd:sched.shiftEnd, gracePeriod:numOr(sched.gracePeriod,0), coffeeBreak:numOr(sched.coffeeBreak,15), lunchBreak:numOr(sched.lunchBreak,60), restDays:sched.restDays, snapshot:true };
        wroteSnapshot=true; // brand-new snapshot — safe to persist
      }
      addToast(late>0?`${emp.name} is ${rec.lateMinutes} min late.`:'Time In recorded.',late>0?'warning':'success');
    } else if (action==='break1-start') { rec.coffeeStart=time; addToast('Break started.','info'); }
    else if (action==='break1-end'||action==='break2-end') {
      if (action==='break1-end') rec.coffeeEnd=time; else rec.lunchEnd=time;
      // Classify THIS break by its duration: >30 min → judged vs the lunch cap, else vs the coffee cap.
      const isCoffeeSlot = action==='break1-end';
      const span  = isCoffeeSlot ? breakSpan(rec.coffeeStart,rec.coffeeEnd) : breakSpan(rec.lunchStart,rec.lunchEnd);
      const kind  = classifyBreakDur(span);
      const limit = kind==='lunch' ? LUNCH_LIMIT : COFFEE_LIMIT;
      const over  = Math.max(0, span - limit);
      if (isCoffeeSlot) rec.coffeeOver=over; else rec.lunchOver=over;
      rec.overBreakMinutes=(rec.coffeeOver||0)+(rec.lunchOver||0);
      if (over>0) extra={overBreak:over};
      addToast(over>0?`Break ${span}m — ${over}m over (${kind} cap ${limit}m)!`:`Break ${span}m. On time (${kind} cap ${limit}m).`,over>0?'warning':'success');
    } else if (action==='break2-start') { rec.lunchStart=time; addToast('Break started.','info'); }
    else if (action==='time-out') {
      rec.timeOut=time; rec.timeOutSrc='scan';
      // total worked = out - in - coffee - lunch
      let worked=toMins(time)-toMins(rec.timeIn||sched.shiftStart);
      if (rec.coffeeStart&&rec.coffeeEnd) worked-=(toMins(rec.coffeeEnd)-toMins(rec.coffeeStart));
      if (rec.lunchStart&&rec.lunchEnd) worked-=(toMins(rec.lunchEnd)-toMins(rec.lunchStart));
      rec.hoursWorked=Math.round(Math.max(0,worked)/60*10)/10;
      rec.overBreakMinutes=(rec.coffeeOver||0)+(rec.lunchOver||0);
      addToast(`Time Out — ${rec.hoursWorked}h worked.`,'success');
    }
    const payload={employee_id:rec.employeeId,date:rec.date,time_in:rec.timeIn,break_start:rec.breakStart,break_end:rec.breakEnd,coffee_start:rec.coffeeStart,coffee_end:rec.coffeeEnd,lunch_start:rec.lunchStart,lunch_end:rec.lunchEnd,coffee_over:rec.coffeeOver||0,lunch_over:rec.lunchOver||0,time_out:rec.timeOut,late_minutes:rec.lateMinutes,over_break_minutes:rec.overBreakMinutes,hours_worked:rec.hoursWorked,status:rec.status,is_day_off_scan:rec.isDayOffScan||false,time_in_src:rec.timeInSrc||null,time_out_src:rec.timeOutSrc||null};
    // Only write schedule_override when WE just created the initial snapshot. On all other
    // scans (breaks, time-out) we omit it, so an admin's manual override is never clobbered
    // by a stale in-memory copy. Omitted columns keep their existing DB value on upsert.
    if (wroteSnapshot) payload.schedule_override=rec.scheduleOverride||null;
    // Update the on-screen state immediately so the kiosk feels instant either way.
    setAttendance(prev=>({...prev,[TODAY]:{...(prev[TODAY]||{}),[empId]:rec}}));
    if (online) {
      try {
        const {error}=await supabase.from('attendance').upsert(payload,{onConflict:'employee_id,date'});
        if (error) { enqueueScan(payload); addToast('Saved offline — will sync when online.','warning'); }
      } catch { enqueueScan(payload); addToast('Saved offline — will sync when online.','warning'); }
    } else {
      enqueueScan(payload); addToast('No internet — scan saved, will sync when back online.','warning');
    }
    cb?.(extra);
  },[employees,addToast,allAttendance]);

  if (dbLoading) return <LoadingScreen/>;
  if (dbError)   return <ErrorScreen message={dbError} onRetry={loadData}/>;

  return (
    <div className="font-sans">
      <Toast toasts={toasts} remove={removeToast}/>
      {screen==="landing"     && <LandingPage onSelect={landingSelect}/>}
      {screen==="register"    && <RegisterPage onBack={(APP_ONLY||ADMIN_ONLY)?undefined:()=>setScreen("landing")} onDone={()=>setScreen("admin-login")} addToast={addToast}/>}
      {screen==="admin-login" && <AdminLogin onLogin={handleLogin} onBack={(APP_ONLY||ADMIN_ONLY)?undefined:()=>setScreen("landing")} onRegister={ADMIN_ONLY?undefined:()=>setScreen("register")}/>}
      {screen==="admin"       && adminUser && (adminUser.role==='employee'
        ? <EmployeePortal account={adminUser} onLogout={handleLogout} addToast={addToast}/>
        : <AdminPortal employees={employees} setEmployees={setEmployeesAndSync} allAttendance={allAttendance} leaves={leaves} roles={roles} adminUser={adminUser} addToast={addToast} onLogout={handleLogout} reloadData={loadData} quietRefresh={quietRefresh}/>
      )}
      {/* Combined kiosk APK: admin login → choose QR / Facial */}
      {screen==="kiosk-login"  && <AdminLogin onLogin={handleKioskLogin}/>}
      {screen==="kiosk-choose" && <KioskChooser adminUser={kioskUser} onPick={setScreen} onLogout={handleKioskLogout} online={navigator.onLine!==false}/>}
      {screen==="kiosk"       && !kioskUser && <AdminLogin onLogin={handleKioskLogin} onBack={kioskBack}/>}
      {screen==="kiosk"       && kioskUser  && <EmployeeKiosk employees={employees} allAttendance={allAttendance} onScan={handleScan} onBack={kioskBack} onKioskLogout={handleKioskLogout}/>}
      {screen==="facial-kiosk" && !kioskUser && <AdminLogin onLogin={handleKioskLogin} onBack={kioskBack}/>}
      {screen==="facial-kiosk" && kioskUser  && <FacialKiosk employees={employees} allAttendance={allAttendance} onScan={handleScan} onBack={kioskBack} onKioskLogout={handleKioskLogout} quietRefresh={quietRefresh} addToast={addToast}/>}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// ERROR BOUNDARY — shows a message instead of a blank white screen on crash
// ════════════════════════════════════════════════════════════════════════════
class ErrorBoundary extends Component {
  constructor(props){ super(props); this.state={hasError:false,msg:""}; }
  static getDerivedStateFromError(err){ return {hasError:true,msg:err?.message||"Unknown error"}; }
  componentDidCatch(err,info){ console.error("App crashed:",err,info); }
  render(){
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-mist flex flex-col items-center justify-center gap-6 p-8 text-center">
          <div className="text-5xl">😵</div>
          <div>
            <h2 className="text-gray-800 text-xl font-black mb-2">Something went wrong</h2>
            <p className="text-gray-400 text-sm max-w-md">{this.state.msg}</p>
          </div>
          <button onClick={()=>window.location.reload()} className="bg-brand-500 text-gray-800 font-bold px-6 py-3 rounded-2xl hover:bg-brand-600">Reload App</button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  return <ErrorBoundary><AppInner/></ErrorBoundary>;
}
