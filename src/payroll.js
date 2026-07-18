// ═══════════════════════════════════════════════════════════════════════════
// BilisOps Payroll Engine — Philippine statutory rules, 2026 defaults.
// Every number here is a DEFAULT; tenants edit them in Payroll → Settings and
// the edited copy is stored per tenant (payroll_settings). Finalized payslips
// snapshot their full breakdown, so later rate changes never rewrite history.
// ═══════════════════════════════════════════════════════════════════════════

// ── 2026 legal defaults (verified July 2026) ─────────────────────────────────
// ratesVersion: bump this whenever the statutory sections below change (new
// government rates, new holiday list). Tenants whose saved settings carry an
// older version see an "updated rates available" banner and can apply the new
// statutory tables with one click — their own customizations are kept.
export const PH_PAYROLL_DEFAULTS = {
  ratesVersion: '2026.1',

  // Pay basis
  payFrequency: 'semi-monthly',      // 'semi-monthly' | 'monthly'
  workDaysPerMonth: 26,              // divisor for daily rate  (companies use 26, 22, 21.75…)
  hoursPerDay: 8,

  // SSS (RA 11199 — 15% total since 2025)
  sss: {
    rateEmployee: 5.0,               // % of Monthly Salary Credit
    rateEmployer: 10.0,
    mscFloor: 5000,
    mscCeiling: 35000,
    mscStep: 500,
    ecSmall: 10,                     // employer EC, MSC below ecThreshold
    ecBig: 30,
    ecThreshold: 15000,
  },

  // PhilHealth (UHC — 5% split 50/50)
  philhealth: {
    rateTotal: 5.0,                  // % of basic salary
    employeeSharePct: 50,            // employee % of the premium
    salaryFloor: 10000,
    salaryCeiling: 100000,
  },

  // Pag-IBIG / HDMF
  pagibig: {
    rateEmployee: 2.0,               // % of compensation
    rateEmployer: 2.0,
    salaryCap: 10000,                // max fund salary (₱200 each at 2%)
  },

  // BIR withholding — TRAIN law ANNUAL brackets (2023-onwards schedule)
  // {over, base, rate} → tax = base + rate% × (taxable − over)
  taxBrackets: [
    { over: 0,        base: 0,        rate: 0  },
    { over: 250000,   base: 0,        rate: 15 },
    { over: 400000,   base: 22500,    rate: 20 },
    { over: 800000,   base: 102500,   rate: 25 },
    { over: 2000000,  base: 402500,   rate: 30 },
    { over: 8000000,  base: 2202500,  rate: 35 },
  ],

  // Labor Code premiums (legal minimums — companies may pay more)
  premiums: {
    overtimePct: 25,                 // ordinary-day OT, % added per hour
    nightDiffPct: 10,                // 10 PM – 6 AM (not auto-computed in v1)
    restDayPct: 30,                  // worked rest day, % added
    specialHolidayPct: 30,           // worked special non-working day, % added
    regularHolidayPct: 100,          // worked regular holiday, % added
    regularHolidayUnworkedPaid: true,// monthly-paid employees keep base pay
  },

  // Deduction behaviour
  deductions: {
    contributionsCutoff: 'second',   // 'first' | 'second' | 'split' (semi-monthly runs)
    deductLates: true,
    deductAbsences: true,
  },

  // This year's holiday calendar — tenant edits/adds local holidays
  // type: 'regular' | 'special'
  holidays: [
    { date: '2026-01-01', name: "New Year's Day",          type: 'regular' },
    { date: '2026-02-25', name: 'EDSA Revolution',         type: 'special' },
    { date: '2026-04-02', name: 'Maundy Thursday',         type: 'regular' },
    { date: '2026-04-03', name: 'Good Friday',             type: 'regular' },
    { date: '2026-04-04', name: 'Black Saturday',          type: 'special' },
    { date: '2026-04-09', name: 'Araw ng Kagitingan',      type: 'regular' },
    { date: '2026-05-01', name: 'Labor Day',               type: 'regular' },
    { date: '2026-06-12', name: 'Independence Day',        type: 'regular' },
    { date: '2026-08-21', name: 'Ninoy Aquino Day',        type: 'special' },
    { date: '2026-08-31', name: 'National Heroes Day',     type: 'regular' },
    { date: '2026-11-01', name: "All Saints' Day",         type: 'special' },
    { date: '2026-11-30', name: 'Bonifacio Day',           type: 'regular' },
    { date: '2026-12-08', name: 'Immaculate Conception',   type: 'special' },
    { date: '2026-12-25', name: 'Christmas Day',           type: 'regular' },
    { date: '2026-12-30', name: 'Rizal Day',               type: 'regular' },
    { date: '2026-12-31', name: "New Year's Eve",          type: 'special' },
  ],
};

// Merge a tenant's saved settings over the defaults (deep enough for our shape).
export function mergeSettings(saved) {
  const d = PH_PAYROLL_DEFAULTS;
  if (!saved) return JSON.parse(JSON.stringify(d));
  return {
    ...d, ...saved,
    // Settings saved before versioning existed count as outdated ('0') so the
    // rates-update banner shows once and stamps them on apply.
    ratesVersion: saved.ratesVersion || '0',
    sss: { ...d.sss, ...(saved.sss||{}) },
    philhealth: { ...d.philhealth, ...(saved.philhealth||{}) },
    pagibig: { ...d.pagibig, ...(saved.pagibig||{}) },
    premiums: { ...d.premiums, ...(saved.premiums||{}) },
    deductions: { ...d.deductions, ...(saved.deductions||{}) },
    taxBrackets: saved.taxBrackets?.length ? saved.taxBrackets : d.taxBrackets,
    holidays: saved.holidays?.length ? saved.holidays : d.holidays,
  };
}

// Overwrite ONLY the statutory sections with the platform's current tables,
// keeping every tenant customization (pay basis, premiums, toggles, extra
// holidays they added that aren't in the standard list).
export function applyStatutoryUpdate(settings) {
  const d = PH_PAYROLL_DEFAULTS;
  const stdDates = new Set(d.holidays.map(h => h.date));
  const customHolidays = (settings.holidays || []).filter(h => !stdDates.has(h.date));
  return {
    ...settings,
    ratesVersion: d.ratesVersion,
    sss: { ...d.sss },
    philhealth: { ...d.philhealth },
    pagibig: { ...d.pagibig },
    taxBrackets: JSON.parse(JSON.stringify(d.taxBrackets)),
    holidays: [...JSON.parse(JSON.stringify(d.holidays)), ...customHolidays],
  };
}

const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;

// ── Statutory contributions (all MONTHLY amounts) ────────────────────────────
export function computeSSS(monthlySalary, s) {
  const c = s.sss;
  const msc = Math.min(c.mscCeiling, Math.max(c.mscFloor, Math.round(monthlySalary / c.mscStep) * c.mscStep));
  return {
    msc,
    employee: r2(msc * c.rateEmployee / 100),
    employer: r2(msc * c.rateEmployer / 100),
    ec: msc < c.ecThreshold ? c.ecSmall : c.ecBig,
  };
}

export function computePhilHealth(monthlySalary, s) {
  const c = s.philhealth;
  const base = Math.min(c.salaryCeiling, Math.max(c.salaryFloor, monthlySalary));
  const premium = base * c.rateTotal / 100;
  const employee = r2(premium * c.employeeSharePct / 100);
  return { premium: r2(premium), employee, employer: r2(premium - employee) };
}

export function computePagibig(monthlySalary, s) {
  const c = s.pagibig;
  const base = Math.min(c.salaryCap, monthlySalary);
  return { employee: r2(base * c.rateEmployee / 100), employer: r2(base * c.rateEmployer / 100) };
}

// Annual-bracket withholding, applied to a MONTHLY taxable amount.
export function computeMonthlyTax(monthlyTaxable, brackets) {
  const annual = monthlyTaxable * 12;
  let b = brackets[0];
  for (const br of brackets) if (annual > br.over) b = br;
  const annualTax = b.base + (annual - b.over) * b.rate / 100;
  return r2(Math.max(0, annualTax) / 12);
}

// ── Payslip computation for one employee over one pay period ─────────────────
// emp: employee row (monthly_rate, allowance, schedule{restDays,shiftEnd,…})
// rows: attendance rows within [periodStart, periodEnd] (app-shaped records)
// approvedLeaves: approved leave rows for this employee
// settings: merged payroll settings
// opts: { periodStart, periodEnd, deductContributions:boolean, periodsPerMonth }
export function computePayslip(emp, rows, approvedLeaves, settings, opts) {
  const S = settings;
  const monthlyRate = Number(emp.monthly_rate ?? emp.monthlyRate) || 0;
  const allowance = Number(emp.allowance) || 0;
  const dailyRate = monthlyRate / S.workDaysPerMonth;
  const hourlyRate = dailyRate / S.hoursPerDay;
  const minuteRate = hourlyRate / 60;
  const periodsPerMonth = opts.periodsPerMonth ?? (S.payFrequency === 'monthly' ? 1 : 2);
  const basePay = monthlyRate / periodsPerMonth;
  const periodAllowance = allowance / periodsPerMonth;

  const holidayMap = Object.fromEntries((S.holidays||[]).map(h => [h.date, h.type]));
  const restDays = new Set(emp.schedule?.restDays || ['Saturday','Sunday']);
  const byDate = Object.fromEntries(rows.map(r => [r.date, r]));
  const onLeave = d => approvedLeaves.some(l => l.date_from <= d && d <= l.date_to);

  // Walk each calendar day of the period (local-date safe — no UTC shifting)
  const isoOf = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const days = [];
  for (let dt = new Date(opts.periodStart + 'T00:00:00'); ; dt.setDate(dt.getDate() + 1)) {
    const iso = isoOf(dt);
    if (iso > opts.periodEnd) break;
    days.push({ iso, dow: dt.toLocaleDateString('en-US', { weekday: 'long' }) });
  }

  let otHours = 0, lateMins = 0, absences = 0;
  let otPay = 0, holidayPay = 0, restDayPay = 0, lateDed = 0, absenceDed = 0;
  const dayNotes = [];

  for (const { iso, dow } of days) {
    const rec = byDate[iso];
    const holiday = holidayMap[iso];               // 'regular' | 'special' | undefined
    const isRest = restDays.has(dow);
    const worked = !!(rec && rec.timeIn);

    if (worked) {
      const hrs = Number(rec.hoursWorked) || 0;
      // Premium on top of base pay for special days actually worked
      if (holiday === 'regular')      { holidayPay += hrs * hourlyRate * (S.premiums.regularHolidayPct / 100); dayNotes.push(`${iso}: regular holiday worked (+${S.premiums.regularHolidayPct}%)`); }
      else if (holiday === 'special') { holidayPay += hrs * hourlyRate * (S.premiums.specialHolidayPct / 100); dayNotes.push(`${iso}: special day worked (+${S.premiums.specialHolidayPct}%)`); }
      else if (isRest)                { restDayPay += hrs * hourlyRate * (S.premiums.restDayPct / 100); dayNotes.push(`${iso}: rest day worked (+${S.premiums.restDayPct}%)`); }
      // Overtime past scheduled shift end, counted in 30-minute blocks
      const sched = rec.scheduleOverride ? { ...emp.schedule, ...rec.scheduleOverride } : (emp.schedule || {});
      if (rec.timeOut && sched.shiftEnd) {
        const toM = t => { const [h, m] = String(t).split(':').map(Number); return (h||0)*60 + (m||0); };
        const otMin = Math.floor(Math.max(0, toM(rec.timeOut) - toM(sched.shiftEnd)) / 30) * 30;
        if (otMin > 0) { otHours += otMin / 60; otPay += (otMin / 60) * hourlyRate * (1 + S.premiums.overtimePct / 100); }
      }
      if (S.deductions.deductLates && (rec.lateMinutes || 0) > 0) { lateMins += rec.lateMinutes; lateDed += rec.lateMinutes * minuteRate; }
    } else {
      // Not worked: absent only if it was a scheduled workday with no approved leave
      const paidHoliday = holiday === 'regular' && S.premiums.regularHolidayUnworkedPaid;
      if (!isRest && !holiday && !onLeave(iso) && S.deductions.deductAbsences) { absences += 1; absenceDed += dailyRate; }
      if (paidHoliday) dayNotes.push(`${iso}: regular holiday (paid, unworked)`);
    }
  }

  // Statutory contributions (monthly amounts, applied per the cutoff setting)
  const sss = computeSSS(monthlyRate, S);
  const ph = computePhilHealth(monthlyRate, S);
  const pg = computePagibig(monthlyRate, S);
  let cShare = 0; // fraction of the monthly contribution deducted THIS period
  if (periodsPerMonth === 1) cShare = 1;
  else if (S.deductions.contributionsCutoff === 'split') cShare = 0.5;
  else cShare = opts.deductContributions ? 1 : 0;
  const sssDed = r2(sss.employee * cShare), phDed = r2(ph.employee * cShare), pgDed = r2(pg.employee * cShare);

  // Withholding tax on taxable income (gross earnings − statutory contributions)
  const taxableThisPeriod = Math.max(0, basePay + otPay + holidayPay + restDayPay - lateDed - absenceDed - (sss.employee + ph.employee + pg.employee) / periodsPerMonth);
  const tax = r2(computeMonthlyTax(taxableThisPeriod * periodsPerMonth, S.taxBrackets) / periodsPerMonth);

  const earnings = [
    { label: `Basic pay (${S.payFrequency})`, amount: r2(basePay) },
    ...(periodAllowance > 0 ? [{ label: 'Allowance (non-taxable)', amount: r2(periodAllowance) }] : []),
    ...(otPay > 0 ? [{ label: `Overtime — ${otHours.toFixed(1)} h (+${S.premiums.overtimePct}%)`, amount: r2(otPay) }] : []),
    ...(holidayPay > 0 ? [{ label: 'Holiday premium', amount: r2(holidayPay) }] : []),
    ...(restDayPay > 0 ? [{ label: `Rest day premium (+${S.premiums.restDayPct}%)`, amount: r2(restDayPay) }] : []),
  ];
  const deductions = [
    ...(lateDed > 0 ? [{ label: `Lates — ${lateMins} min`, amount: r2(lateDed) }] : []),
    ...(absenceDed > 0 ? [{ label: `Absences — ${absences} day${absences>1?'s':''}`, amount: r2(absenceDed) }] : []),
    ...(sssDed > 0 ? [{ label: 'SSS', amount: sssDed }] : []),
    ...(phDed > 0 ? [{ label: 'PhilHealth', amount: phDed }] : []),
    ...(pgDed > 0 ? [{ label: 'Pag-IBIG', amount: pgDed }] : []),
    ...(tax > 0 ? [{ label: 'Withholding tax', amount: tax }] : []),
  ];
  const gross = r2(earnings.reduce((s, e) => s + e.amount, 0));
  const totalDeductions = r2(deductions.reduce((s, d) => s + d.amount, 0));

  return {
    earnings, deductions, gross, totalDeductions, net: r2(gross - totalDeductions),
    meta: {
      monthlyRate, dailyRate: r2(dailyRate), hourlyRate: r2(hourlyRate),
      otHours, lateMins, absences, dayNotes,
      employer: { sss: sss.employer, ec: sss.ec, philhealth: ph.employer, pagibig: pg.employer },
      period: { start: opts.periodStart, end: opts.periodEnd },
    },
  };
}

export const peso = n => '₱' + (Number(n)||0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
