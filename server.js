const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// ── Helper: compute daily salary ──────────────────────────────────
function computeSalary(status, dailyWage, otWage) {
  if (status === "present")  return Math.round(dailyWage * 100) / 100;
  if (status === "halfday")  return Math.round(dailyWage * 0.5 * 100) / 100;
  if (status === "overtime") return Math.round((dailyWage + otWage) * 100) / 100;
  if (status === "leave")    return 0;
  return 0;
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS employees (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      gender TEXT DEFAULT 'female',
      phone TEXT DEFAULT '',
      daily_wage REAL DEFAULT 0,
      emp_type TEXT DEFAULT 'worker',
      active BOOLEAN DEFAULT true,
      created_at DATE DEFAULT CURRENT_DATE
    );

    CREATE TABLE IF NOT EXISTS attendance (
      id SERIAL PRIMARY KEY,
      emp_id TEXT NOT NULL REFERENCES employees(id),
      date TEXT NOT NULL,
      status TEXT NOT NULL,
      daily_wage REAL DEFAULT 0,
      ot_wage REAL DEFAULT 0,
      daily_salary REAL DEFAULT 0,
      paid_amount REAL DEFAULT 0,
      UNIQUE(emp_id, date)
    );

    CREATE TABLE IF NOT EXISTS payments (
      id            TEXT PRIMARY KEY,
      emp_id        TEXT NOT NULL,
      paid_date     TEXT DEFAULT '',
      amount        REAL NOT NULL,
      period_from   TEXT DEFAULT '',
      period_to     TEXT DEFAULT '',
      period_label  TEXT DEFAULT '',
      note          TEXT DEFAULT '',
      type          TEXT DEFAULT 'payment'
    );

    CREATE TABLE IF NOT EXISTS varieties (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      name_ta TEXT DEFAULT '',
      active BOOLEAN DEFAULT true
    );

    CREATE TABLE IF NOT EXISTS purchases (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      farmer TEXT NOT NULL,
      phone TEXT DEFAULT '',
      vehicle TEXT DEFAULT '',
      variety_id TEXT DEFAULT '',
      loads_json TEXT DEFAULT '[]',
      total_net_weight REAL DEFAULT 0,
      deduction_per_ton REAL DEFAULT 50,
      deduction REAL DEFAULT 0,
      final_weight REAL DEFAULT 0,
      price_per_kg REAL DEFAULT 0,
      total_amount REAL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS sales (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      farmer TEXT NOT NULL,
      phone TEXT DEFAULT '',
      variety_id TEXT DEFAULT '',
      bags_json TEXT DEFAULT '[]',
      total_weight REAL DEFAULT 0,
      price_per_kg REAL DEFAULT 0,
      total_amount REAL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS processing (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      farmer TEXT DEFAULT '',
      variety_id TEXT DEFAULT '',
      fresh_weight REAL NOT NULL,
      after_boiling REAL DEFAULT 0,
      after_drying REAL DEFAULT 0,
      final_weight REAL DEFAULT 0,
      yield_percent REAL DEFAULT 0,
      status TEXT DEFAULT 'fresh',
      notes TEXT DEFAULT '',
      raw_used REAL DEFAULT 0,
      quintal REAL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS market_sales (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      processed_qty REAL DEFAULT 0,
      quintal REAL DEFAULT 0,
      rate_per_quintal REAL DEFAULT 0,
      revenue REAL DEFAULT 0,
      variety_id TEXT DEFAULT '',
      notes TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Safe column migrations — ALL ADD COLUMN before any UPDATE
  const migrations = [
    // attendance
    "ALTER TABLE attendance ADD COLUMN IF NOT EXISTS daily_wage REAL DEFAULT 0",
    "ALTER TABLE attendance ADD COLUMN IF NOT EXISTS ot_wage REAL DEFAULT 0",
    "ALTER TABLE attendance ADD COLUMN IF NOT EXISTS daily_salary REAL DEFAULT 0",
    "ALTER TABLE attendance ADD COLUMN IF NOT EXISTS paid_amount REAL DEFAULT 0",
    // payments — add ALL missing columns including note
    "ALTER TABLE payments ADD COLUMN IF NOT EXISTS note TEXT DEFAULT ''",
    "ALTER TABLE payments ADD COLUMN IF NOT EXISTS paid_date TEXT DEFAULT ''",
    "ALTER TABLE payments ADD COLUMN IF NOT EXISTS period_from TEXT DEFAULT ''",
    "ALTER TABLE payments ADD COLUMN IF NOT EXISTS period_to TEXT DEFAULT ''",
    "ALTER TABLE payments ADD COLUMN IF NOT EXISTS period_label TEXT DEFAULT ''",
    "ALTER TABLE payments ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'payment'",
    // Remove NOT NULL constraints that break old data
    "ALTER TABLE payments ALTER COLUMN paid_date DROP NOT NULL",
    "ALTER TABLE payments ALTER COLUMN period_from DROP NOT NULL",
    "ALTER TABLE payments ALTER COLUMN period_to DROP NOT NULL",
    // employees
    "ALTER TABLE employees ADD COLUMN IF NOT EXISTS phone TEXT DEFAULT ''",
    "ALTER TABLE employees ADD COLUMN IF NOT EXISTS daily_wage REAL DEFAULT 0",
    "ALTER TABLE employees ADD COLUMN IF NOT EXISTS emp_type TEXT DEFAULT 'worker'",
    "ALTER TABLE employees ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT true",
    // purchases / sales
    "ALTER TABLE purchases ADD COLUMN IF NOT EXISTS variety_id TEXT DEFAULT ''",
    "ALTER TABLE sales ADD COLUMN IF NOT EXISTS variety_id TEXT DEFAULT ''",
  ];
  for (const m of migrations) await pool.query(m).catch(() => {});

  // Fix payments.paid_date if old schema used 'date' column
  await pool.query("UPDATE payments SET paid_date=date WHERE paid_date='' AND date IS NOT NULL").catch(() => {});

  // Migrate existing attendance — fill wages + compute salary where missing
  await pool.query(`
    UPDATE attendance a SET
      daily_wage = COALESCE(NULLIF(a.daily_wage,0), e.daily_wage),
      ot_wage = CASE WHEN e.gender='female'
        THEN COALESCE((SELECT value::REAL FROM settings WHERE key='femaleOT'),100)
        ELSE COALESCE((SELECT value::REAL FROM settings WHERE key='maleOT'),50) END
    FROM employees e WHERE a.emp_id=e.id AND a.daily_wage=0
  `).catch(() => {});

  await pool.query(`
    UPDATE attendance SET daily_salary =
      CASE
        WHEN status='present'  THEN daily_wage
        WHEN status='halfday'  THEN ROUND(daily_wage*0.5*100)/100
        WHEN status='overtime' THEN daily_wage+ot_wage
        ELSE 0
      END
    WHERE daily_salary=0 AND daily_wage>0
  `).catch(() => {});

  // Migrate old advances table → payments
  const hasAdv = await pool.query("SELECT EXISTS(SELECT FROM information_schema.tables WHERE table_name='advances')").catch(() => ({ rows: [{ exists: false }] }));
  if (hasAdv.rows[0].exists) {
    await pool.query(`
      INSERT INTO payments (id,emp_id,paid_date,amount,period_from,period_to,period_label,note,type)
      SELECT id,emp_id,date,amount,date,date,'முன்பணம்',COALESCE(note,''),'advance'
      FROM advances ON CONFLICT (id) DO NOTHING
    `).catch(() => {});
  }

  // Migrate old payments table (with period column)
  await pool.query(`
    UPDATE payments SET
      period_from = COALESCE(NULLIF(period_from,''), paid_date),
      period_to   = COALESCE(NULLIF(period_to,''),   paid_date)
    WHERE period_from=''
  `).catch(() => {});

  // Default settings
  const defs = { femaleDay: "350", femaleOT: "100", maleDay: "800", maleOT: "50" };
  for (const [k, v] of Object.entries(defs)) {
    await pool.query("INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO NOTHING", [k, v]);
  }

  // Default varieties
  const vars = [["virali","விராலி"],["gundumanjal","குண்டுமஞ்சள்"],["erode","ஈரோடு"],["salem","சேலம்"],["local","உள்ளூர்"]];
  for (const [id, name] of vars) {
    await pool.query("INSERT INTO varieties(id,name,name_ta) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING", [id, name, name]);
  }

  console.log("✅ மஞ்சள் தம்பி DB v3 ready");
}

// ══════════════════════════════════════════════════════════════════
// SETTINGS
// ══════════════════════════════════════════════════════════════════
app.get("/api/settings", async (req, res) => {
  const { rows } = await pool.query("SELECT key,value FROM settings");
  const obj = {}; rows.forEach(r => { obj[r.key] = r.value; }); res.json(obj);
});
app.put("/api/settings", async (req, res) => {
  for (const [k, v] of Object.entries(req.body)) {
    await pool.query("INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2", [k, String(v)]);
  }
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════
// VARIETIES
// ══════════════════════════════════════════════════════════════════
app.get("/api/varieties", async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM varieties WHERE active=true ORDER BY name");
  res.json(rows);
});
app.post("/api/varieties", async (req, res) => {
  const { name, name_ta } = req.body; const id = uid();
  await pool.query("INSERT INTO varieties(id,name,name_ta) VALUES($1,$2,$3)", [id, name, name_ta || name]);
  res.json({ id });
});
app.put("/api/varieties/:id", async (req, res) => {
  const { name, name_ta } = req.body;
  await pool.query("UPDATE varieties SET name=$1,name_ta=$2 WHERE id=$3", [name, name_ta || name, req.params.id]);
  res.json({ ok: true });
});
app.delete("/api/varieties/:id", async (req, res) => {
  await pool.query("UPDATE varieties SET active=false WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════
// EMPLOYEES
// ══════════════════════════════════════════════════════════════════
app.get("/api/employees", async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM employees ORDER BY active DESC, created_at DESC");
  res.json(rows);
});
app.post("/api/employees", async (req, res) => {
  const { name, gender, phone, daily_wage, emp_type } = req.body; const id = uid();
  await pool.query("INSERT INTO employees(id,name,gender,phone,daily_wage,emp_type) VALUES($1,$2,$3,$4,$5,$6)",
    [id, name, gender || "female", phone || "", daily_wage || 0, emp_type || "worker"]);
  res.json({ id, name, gender });
});
app.put("/api/employees/:id", async (req, res) => {
  const { name, gender, phone, daily_wage } = req.body;
  await pool.query("UPDATE employees SET name=COALESCE($1,name),gender=COALESCE($2,gender),phone=COALESCE($3,phone),daily_wage=COALESCE($4,daily_wage) WHERE id=$5",
    [name, gender, phone, daily_wage, req.params.id]);
  res.json({ ok: true });
});
app.delete("/api/employees/:id", async (req, res) => {
  await pool.query("UPDATE employees SET active=false WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════
// ATTENDANCE — with LOCK protection + no duplicate salary
// ══════════════════════════════════════════════════════════════════
app.get("/api/attendance", async (req, res) => {
  const { from, to, emp_id } = req.query;
  let sql = "SELECT a.*,e.name,e.gender FROM attendance a JOIN employees e ON a.emp_id=e.id WHERE 1=1";
  const p = []; let i = 1;
  if (from)   { sql += ` AND a.date>=$${i++}`; p.push(from); }
  if (to)     { sql += ` AND a.date<=$${i++}`; p.push(to); }
  if (emp_id) { sql += ` AND a.emp_id=$${i++}`; p.push(emp_id); }
  sql += " ORDER BY a.date ASC, e.name ASC";
  const { rows } = await pool.query(sql, p);
  res.json(rows);
});

// Mark attendance — LOCK guard + no duplicate salary
app.post("/api/attendance", async (req, res) => {
  const { emp_id, date, status } = req.body;

  // Clear record
  if (!status) {
    const existing = (await pool.query("SELECT paid_amount,daily_salary FROM attendance WHERE emp_id=$1 AND date=$2", [emp_id, date])).rows[0];
    if (existing && existing.paid_amount > 0) {
      return res.status(423).json({ error: "LOCKED", message: "இந்த நாள் சம்பளம் கொடுக்கப்பட்டது. திருத்த unlock செய்யவும்." });
    }
    await pool.query("DELETE FROM attendance WHERE emp_id=$1 AND date=$2", [emp_id, date]);
    return res.json({ ok: true });
  }

  // Check lock — if fully paid, reject status change
  const existing = (await pool.query("SELECT paid_amount,daily_salary,status FROM attendance WHERE emp_id=$1 AND date=$2", [emp_id, date])).rows[0];
  if (existing && existing.paid_amount > 0 && existing.paid_amount >= existing.daily_salary) {
    return res.status(423).json({ error: "LOCKED", message: "இந்த நாள் சம்பளம் கொடுக்கப்பட்டது 🔒\nதிருத்த [Unlock] செய்யவும்." });
  }

  // Get employee + settings
  const emp = (await pool.query("SELECT * FROM employees WHERE id=$1", [emp_id])).rows[0];
  if (!emp) return res.status(404).json({ error: "Employee not found" });
  const settings = {};
  (await pool.query("SELECT key,value FROM settings")).rows.forEach(r => { settings[r.key] = Number(r.value); });

  const dailyWage = emp.daily_wage > 0 ? emp.daily_wage :
    (emp.gender === "female" ? (settings.femaleDay || 350) : (settings.maleDay || 800));
  const otWage = emp.gender === "female" ? (settings.femaleOT || 100) : (settings.maleOT || 50);
  const dailySalary = computeSalary(status, dailyWage, otWage);

  // UPSERT — single record guaranteed by UNIQUE(emp_id, date)
  // paid_amount is preserved on update — never reset
  await pool.query(`
    INSERT INTO attendance(emp_id,date,status,daily_wage,ot_wage,daily_salary,paid_amount)
    VALUES($1,$2,$3,$4,$5,$6,0)
    ON CONFLICT(emp_id,date) DO UPDATE SET
      status=$3, daily_wage=$4, ot_wage=$5, daily_salary=$6
  `, [emp_id, date, status, dailyWage, otWage, dailySalary]);

  res.json({ ok: true, daily_salary: dailySalary });
});

// Bulk attendance
app.post("/api/attendance/bulk", async (req, res) => {
  const { date, emp_ids, status } = req.body;
  const settings = {};
  (await pool.query("SELECT key,value FROM settings")).rows.forEach(r => { settings[r.key] = Number(r.value); });
  for (const eid of emp_ids) {
    const emp = (await pool.query("SELECT * FROM employees WHERE id=$1", [eid])).rows[0];
    if (!emp) continue;
    const existing = (await pool.query("SELECT paid_amount,daily_salary FROM attendance WHERE emp_id=$1 AND date=$2", [eid, date])).rows[0];
    if (existing && existing.paid_amount >= existing.daily_salary && existing.daily_salary > 0) continue; // skip locked
    const dw = emp.daily_wage > 0 ? emp.daily_wage : (emp.gender === "female" ? (settings.femaleDay || 350) : (settings.maleDay || 800));
    const ow = emp.gender === "female" ? (settings.femaleOT || 100) : (settings.maleOT || 50);
    const sal = computeSalary(status, dw, ow);
    await pool.query(`
      INSERT INTO attendance(emp_id,date,status,daily_wage,ot_wage,daily_salary,paid_amount)
      VALUES($1,$2,$3,$4,$5,$6,0)
      ON CONFLICT(emp_id,date) DO NOTHING
    `, [eid, date, status, dw, ow, sal]);
  }
  res.json({ ok: true });
});

// UNLOCK a paid day (sets paid_amount=0 so it can be edited)
app.post("/api/attendance/unlock", async (req, res) => {
  const { emp_id, date } = req.body;
  await pool.query("UPDATE attendance SET paid_amount=0 WHERE emp_id=$1 AND date=$2", [emp_id, date]);
  res.json({ ok: true });
});

// Pay a single day
app.post("/api/attendance/pay-day", async (req, res) => {
  const { emp_id, date, paid_amount } = req.body;
  const amt = Math.max(0, Number(paid_amount) || 0);
  await pool.query("UPDATE attendance SET paid_amount=$1 WHERE emp_id=$2 AND date=$3", [amt, emp_id, date]);
  res.json({ ok: true });
});

// Pay full range — mark all unpaid days paid + create payment log
app.post("/api/attendance/pay-full-range", async (req, res) => {
  const { emp_id, from, to, period_label } = req.body;
  const { rows } = await pool.query(
    "UPDATE attendance SET paid_amount=daily_salary WHERE emp_id=$1 AND date>=$2 AND date<=$3 AND daily_salary>0 AND paid_amount<daily_salary RETURNING date,daily_salary",
    [emp_id, from, to]
  );
  const total = rows.reduce((s, r) => s + Number(r.daily_salary), 0);
  const paidDate = new Date().toISOString().slice(0, 10);
  // Build label from actual dates if not provided
  const label = period_label || (from === to ? from : `${from} → ${to}`);
  if (total > 0) {
    await pool.query(
      "INSERT INTO payments(id,emp_id,paid_date,amount,period_from,period_to,period_label,note,type) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'payment')",
      [uid(), emp_id, paidDate, total, from, to, label, ""]
    );
  }
  res.json({ ok: true, total_paid: total, days: rows.length });
});

// Bulk distribute payment across unpaid days (oldest first)
app.post("/api/attendance/pay-bulk", async (req, res) => {
  const { emp_id, from, to, total_amount, period_label } = req.body;
  let remaining = Number(total_amount) || 0;
  if (remaining <= 0) return res.json({ ok: true, distributed: [] });

  const { rows } = await pool.query(
    "SELECT * FROM attendance WHERE emp_id=$1 AND date>=$2 AND date<=$3 AND daily_salary>paid_amount AND daily_salary>0 ORDER BY date ASC",
    [emp_id, from, to]
  );

  const distributed = [];
  for (const row of rows) {
    if (remaining <= 0) break;
    const bal = row.daily_salary - row.paid_amount;
    const toPay = Math.min(bal, remaining);
    const newPaid = row.paid_amount + toPay;
    await pool.query("UPDATE attendance SET paid_amount=$1 WHERE emp_id=$2 AND date=$3", [newPaid, emp_id, row.date]);
    distributed.push({ date: row.date, paid: toPay, total_paid: newPaid, salary: row.daily_salary });
    remaining -= toPay;
  }

  const totalPaid = (Number(total_amount) || 0) - remaining;
  if (totalPaid > 0) {
    await pool.query(
      "INSERT INTO payments(id,emp_id,paid_date,amount,period_from,period_to,period_label,note,type) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'payment')",
      [uid(), emp_id, new Date().toISOString().slice(0, 10), totalPaid, from, to, period_label || `${from} முதல் ${to}`, "பகுதி சம்பளம்"]
    );
  }
  res.json({ ok: true, distributed, remaining_unallocated: remaining });
});

// Revert a payment — undo paid_amount for the period + delete payment log
app.post("/api/payments/:id/revert", async (req, res) => {
  const pay = (await pool.query("SELECT * FROM payments WHERE id=$1", [req.params.id])).rows[0];
  if (!pay) return res.status(404).json({ error: "Payment not found" });

  // Reset paid_amount to 0 for all days in that period
  await pool.query(
    "UPDATE attendance SET paid_amount=0 WHERE emp_id=$1 AND date>=$2 AND date<=$3",
    [pay.emp_id, pay.period_from, pay.period_to]
  );
  await pool.query("DELETE FROM payments WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
});

// Edit payment amount
app.put("/api/payments/:id", async (req, res) => {
  const { amount } = req.body;
  const pay = (await pool.query("SELECT * FROM payments WHERE id=$1", [req.params.id])).rows[0];
  if (!pay) return res.status(404).json({ error: "Payment not found" });

  const newAmt = Number(amount) || 0;
  const diff = newAmt - Number(pay.amount); // positive = paid more, negative = paid less

  if (diff < 0) {
    // Paid less — remove from last days first
    const { rows } = await pool.query(
      "SELECT * FROM attendance WHERE emp_id=$1 AND date>=$2 AND date<=$3 AND paid_amount>0 ORDER BY date DESC",
      [pay.emp_id, pay.period_from, pay.period_to]
    );
    let toRemove = Math.abs(diff);
    for (const row of rows) {
      if (toRemove <= 0) break;
      const reduce = Math.min(Number(row.paid_amount), toRemove);
      await pool.query("UPDATE attendance SET paid_amount=$1 WHERE emp_id=$2 AND date=$3", [row.paid_amount - reduce, pay.emp_id, row.date]);
      toRemove -= reduce;
    }
  } else if (diff > 0) {
    // Paid more — fill remaining days
    const { rows } = await pool.query(
      "SELECT * FROM attendance WHERE emp_id=$1 AND date>=$2 AND date<=$3 AND daily_salary>paid_amount ORDER BY date ASC",
      [pay.emp_id, pay.period_from, pay.period_to]
    );
    let toAdd = diff;
    for (const row of rows) {
      if (toAdd <= 0) break;
      const canAdd = row.daily_salary - row.paid_amount;
      const add = Math.min(canAdd, toAdd);
      await pool.query("UPDATE attendance SET paid_amount=$1 WHERE emp_id=$2 AND date=$3", [row.paid_amount + add, pay.emp_id, row.date]);
      toAdd -= add;
    }
  }

  await pool.query("UPDATE payments SET amount=$1 WHERE id=$2", [newAmt, req.params.id]);
  res.json({ ok: true });
});

app.delete("/api/payments/:id", async (req, res) => {
  await pool.query("DELETE FROM payments WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════
// SALARY REPORTS
// ══════════════════════════════════════════════════════════════════

// Current unpaid — employees with any unpaid balance
app.get("/api/salary/current", async (req, res) => {
  const emps = (await pool.query("SELECT * FROM employees ORDER BY active DESC, name ASC")).rows;
  const settings = {};
  (await pool.query("SELECT key,value FROM settings")).rows.forEach(r => { settings[r.key] = Number(r.value); });

  const result = [];
  for (const emp of emps) {
    // Get all unpaid/partial days
    const { rows: unpaidDays } = await pool.query(
      "SELECT * FROM attendance WHERE emp_id=$1 AND daily_salary>paid_amount AND daily_salary>0 ORDER BY date ASC",
      [emp.id]
    );
    if (unpaidDays.length === 0) continue;

    let days = 0, ot = 0, hd = 0, leaveCount = 0;
    let totalSalary = 0, totalPaid = 0;
    unpaidDays.forEach(a => {
      if (a.status === "present")       { days++; }
      else if (a.status === "overtime") { days++; ot++; }
      else if (a.status === "halfday")  { hd++; }
      else if (a.status === "leave")    { leaveCount++; }
      totalSalary += Number(a.daily_salary) || 0;
      totalPaid   += Number(a.paid_amount)  || 0;
    });

    const balance = totalSalary - totalPaid;
    const periodFrom = unpaidDays[0].date;
    const periodTo   = unpaidDays[unpaidDays.length - 1].date;

    result.push({
      ...emp,
      days, ot, hd, leaveCount,
      effectiveDays: days + hd * 0.5,
      totalSalary, totalPaid, balance,
      periodFrom, periodTo,
      unpaidDays
    });
  }
  res.json(result);
});

// Full salary report for any date range (used in salary detail modal)
app.get("/api/salary/range", async (req, res) => {
  const { from, to, emp_id } = req.query;
  if (!from || !to || !emp_id) return res.status(400).json({ error: "from, to, emp_id required" });

  const { rows: attRows } = await pool.query(
    "SELECT * FROM attendance WHERE emp_id=$1 AND date>=$2 AND date<=$3 ORDER BY date ASC",
    [emp_id, from, to]
  );

  let totalSalary = 0, totalPaid = 0;
  attRows.forEach(a => {
    totalSalary += Number(a.daily_salary) || 0;
    totalPaid   += Number(a.paid_amount)  || 0;
  });

  res.json({ attRows, totalSalary, totalPaid, balance: totalSalary - totalPaid });
});

// Payment history per employee + cumulative totals
app.get("/api/salary/history", async (req, res) => {
  try {
    const { emp_id } = req.query;
    const emps = emp_id
      ? (await pool.query("SELECT * FROM employees WHERE id=$1", [emp_id])).rows
      : (await pool.query("SELECT * FROM employees ORDER BY name ASC")).rows;

    const today = new Date().toISOString().slice(0, 10);
    const monday = (() => {
      const d = new Date();
      d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
      return d.toISOString().slice(0, 10);
    })();
    const monthStart = today.slice(0, 7) + "-01";
    const yearStart  = today.slice(0, 4) + "-01-01";

    // Check which columns actually exist in payments table
    const colCheck = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name='payments' ORDER BY ordinal_position"
    );
    const cols = colCheck.rows.map(r => r.column_name);
    const hasDate     = cols.includes("date");
    const hasPaidDate = cols.includes("paid_date");

    const result = [];
    for (const emp of emps) {
      // Build ORDER BY dynamically based on existing columns
      let orderExpr = hasPaidDate ? "paid_date" : (hasDate ? "date" : "id");

      const { rows: payments } = await pool.query(
        `SELECT * FROM payments WHERE emp_id=$1 ORDER BY ${orderExpr} DESC NULLS LAST`,
        [emp.id]
      );
      if (payments.length === 0) continue;

      // Normalize each payment — resolve effective date from whatever column exists
      const normalized = payments.map(function(p) {
        // paid_date is primary; fall back to old 'date' column if it exists
        const effDate = (hasPaidDate && p.paid_date) ? p.paid_date
                      : (hasDate && p.date) ? p.date
                      : p.period_from || today;

        let lbl = p.period_label || "";
        if (!lbl) {
          if (p.period_from && p.period_to && p.period_from !== p.period_to) {
            lbl = p.period_from + " \u2192 " + p.period_to;
          } else if (p.period_from) {
            lbl = p.period_from;
          } else if (p.period) {
            lbl = p.period; // very old schema
          }
        }
        return Object.assign({}, p, { paid_date: effDate, period_label: lbl });
      });

      const weekTotal  = normalized.filter(p => (p.paid_date || "") >= monday).reduce((s, p) => s + Number(p.amount), 0);
      const monthTotal = normalized.filter(p => (p.paid_date || "") >= monthStart).reduce((s, p) => s + Number(p.amount), 0);
      const yearTotal  = normalized.filter(p => (p.paid_date || "") >= yearStart).reduce((s, p) => s + Number(p.amount), 0);
      const allTotal   = normalized.reduce((s, p) => s + Number(p.amount), 0);

      result.push(Object.assign({}, emp, { payments: normalized, weekTotal, monthTotal, yearTotal, allTotal }));
    }
    res.json(result);
  } catch (e) {
    console.error("History error:", e.message);
    res.status(500).json({ error: "History query failed: " + e.message });
  }
});

// Debug — check what's in payments table
app.get("/api/debug/payments", async (req, res) => {
  try {
    const cols = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='payments' ORDER BY ordinal_position")).rows.map(r => r.column_name);
    const rows = (await pool.query("SELECT * FROM payments ORDER BY id DESC LIMIT 20")).rows;
    res.json({ columns: cols, count: rows.length, rows });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// Keep old endpoint for backward compat
app.get("/api/reports/salary", async (req, res) => {
  const { from, to } = req.query;
  const f = from || (new Date().toISOString().slice(0, 7) + "-01");
  const t = to || new Date().toISOString().slice(0, 10);
  const emps = (await pool.query("SELECT * FROM employees ORDER BY name ASC")).rows;
  const result = [];
  for (const emp of emps) {
    const { rows: att } = await pool.query("SELECT * FROM attendance WHERE emp_id=$1 AND date>=$2 AND date<=$3 ORDER BY date ASC", [emp.id, f, t]);
    let days=0,ot=0,hd=0,leaveCount=0,totalSalary=0,totalPaid=0;
    att.forEach(a=>{
      if(a.status==="present")days++;
      else if(a.status==="overtime"){days++;ot++;}
      else if(a.status==="halfday")hd++;
      else if(a.status==="leave")leaveCount++;
      totalSalary+=Number(a.daily_salary)||0;totalPaid+=Number(a.paid_amount)||0;
    });
    result.push({...emp,days,ot,hd,leaveCount,effectiveDays:days+hd*0.5,totalSalary,totalPaid,balance:totalSalary-totalPaid,hasActivity:att.length>0,attendanceRows:att});
  }
  res.json(result);
});

// ══════════════════════════════════════════════════════════════════
// PURCHASES / SALES / PROCESSING / MARKET / DASHBOARD / REPORTS
// ══════════════════════════════════════════════════════════════════
app.get("/api/purchases", async (req, res) => {
  const { rows } = await pool.query("SELECT p.*,v.name as variety_name,v.name_ta as variety_ta FROM purchases p LEFT JOIN varieties v ON p.variety_id=v.id ORDER BY p.date DESC");
  rows.forEach(r => { r.loads = JSON.parse(r.loads_json || "[]"); }); res.json(rows);
});
app.post("/api/purchases", async (req, res) => {
  const p = req.body; const id = uid();
  await pool.query("INSERT INTO purchases(id,date,farmer,phone,vehicle,variety_id,loads_json,total_net_weight,deduction_per_ton,deduction,final_weight,price_per_kg,total_amount) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
    [id,p.date,p.farmer,p.phone||"",p.vehicle||"",p.variety_id||"",JSON.stringify(p.loads||[]),p.total_net_weight,p.deduction_per_ton,p.deduction,p.final_weight,p.price_per_kg,p.total_amount]);
  res.json({ id });
});
app.delete("/api/purchases/:id", async (req, res) => { await pool.query("DELETE FROM purchases WHERE id=$1",[req.params.id]); res.json({ok:true}); });

app.get("/api/sales", async (req, res) => {
  const { rows } = await pool.query("SELECT s.*,v.name_ta as variety_ta FROM sales s LEFT JOIN varieties v ON s.variety_id=v.id ORDER BY s.date DESC");
  rows.forEach(r => { r.bags = JSON.parse(r.bags_json || "[]"); }); res.json(rows);
});
app.post("/api/sales", async (req, res) => {
  const s = req.body; const id = uid();
  await pool.query("INSERT INTO sales(id,date,farmer,phone,variety_id,bags_json,total_weight,price_per_kg,total_amount) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [id,s.date,s.farmer,s.phone||"",s.variety_id||"",JSON.stringify(s.bags||[]),s.total_weight,s.price_per_kg,s.total_amount]);
  res.json({ id });
});
app.delete("/api/sales/:id", async (req, res) => { await pool.query("DELETE FROM sales WHERE id=$1",[req.params.id]); res.json({ok:true}); });

app.get("/api/processing", async (req, res) => {
  const { rows } = await pool.query("SELECT p.*,v.name_ta as variety_ta FROM processing p LEFT JOIN varieties v ON p.variety_id=v.id ORDER BY p.date DESC");
  res.json(rows);
});
app.post("/api/processing/auto", async (req, res) => {
  const p = req.body; const id = uid(); const fw = Number(p.fresh_weight)||0;
  const ab=Math.round(fw*0.95*10)/10,ad=Math.round(ab*0.22*10)/10,fp=Math.round(ad*0.93*10)/10;
  const yp=fw>0?(fp/fw)*100:0,q=fp/100;
  await pool.query("INSERT INTO processing(id,date,farmer,variety_id,fresh_weight,after_boiling,after_drying,final_weight,yield_percent,status,notes,raw_used,quintal) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
    [id,p.date||new Date().toISOString().slice(0,10),p.farmer||"",p.variety_id||"",fw,ab,ad,fp,yp,"done",p.notes||"",fw,q]);
  res.json({id,after_boiling:ab,after_drying:ad,final_weight:fp,yield_percent:yp,quintal:q});
});
app.delete("/api/processing/:id", async (req, res) => { await pool.query("DELETE FROM processing WHERE id=$1",[req.params.id]); res.json({ok:true}); });

app.get("/api/market-sales", async (req, res) => {
  const { rows } = await pool.query("SELECT m.*,v.name_ta as variety_ta FROM market_sales m LEFT JOIN varieties v ON m.variety_id=v.id ORDER BY m.date DESC");
  res.json(rows);
});
app.post("/api/market-sales", async (req, res) => {
  const s = req.body; const id = uid();
  const quintal = s.processed_qty/100, revenue = quintal*(s.rate_per_quintal||0);
  await pool.query("INSERT INTO market_sales(id,date,processed_qty,quintal,rate_per_quintal,revenue,variety_id,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
    [id,s.date||new Date().toISOString().slice(0,10),s.processed_qty,quintal,s.rate_per_quintal||0,revenue,s.variety_id||"",s.notes||""]);
  res.json({id,quintal,revenue});
});
app.delete("/api/market-sales/:id", async (req, res) => { await pool.query("DELETE FROM market_sales WHERE id=$1",[req.params.id]); res.json({ok:true}); });

app.get("/api/dashboard", async (req, res) => {
  const q = async (sql) => Number((await pool.query(sql)).rows[0].t);
  const tp=await q("SELECT COALESCE(SUM(final_weight),0) as t FROM purchases");
  const ts=await q("SELECT COALESCE(SUM(total_weight),0) as t FROM sales");
  const tpr=await q("SELECT COALESCE(SUM(raw_used),0) as t FROM processing WHERE status='done'");
  const tpq=await q("SELECT COALESCE(SUM(final_weight),0) as t FROM processing WHERE status='done'");
  const tms=await q("SELECT COALESCE(SUM(processed_qty),0) as t FROM market_sales");
  const trev=await q("SELECT COALESCE(SUM(revenue),0) as t FROM market_sales");
  const tpa=await q("SELECT COALESCE(SUM(total_amount),0) as t FROM purchases");
  const tsa=await q("SELECT COALESCE(SUM(total_amount),0) as t FROM sales");
  res.json({totalPurchased:tp,totalSeedSold:ts,remainingRaw:tp-ts-tpr,totalProcessedQty:tpq,processedStock:tpq-tms,totalMarketSold:tms,totalRevenue:trev,totalPurchaseAmt:tpa,totalSeedAmt:tsa,profit:trev+tsa-tpa});
});

app.get("/api/reports/profit", async (req, res) => {
  const q = async (sql) => Number((await pool.query(sql)).rows[0].t);
  const tp=await q("SELECT COALESCE(SUM(total_amount),0) as t FROM purchases");
  const ts=await q("SELECT COALESCE(SUM(total_amount),0) as t FROM sales");
  const tpk=await q("SELECT COALESCE(SUM(final_weight),0) as t FROM purchases");
  const tsk=await q("SELECT COALESCE(SUM(total_weight),0) as t FROM sales");
  res.json({totalPurchase:tp,totalSale:ts,profit:ts-tp,stockKg:tpk-tsk});
});

app.get("/api/reports/stock", async (req, res) => {
  const varieties=(await pool.query("SELECT * FROM varieties WHERE active=true")).rows;
  const result=[];
  for(const v of varieties){
    const bought=Number((await pool.query("SELECT COALESCE(SUM(final_weight),0) as t FROM purchases WHERE variety_id=$1",[v.id])).rows[0].t);
    const sold=Number((await pool.query("SELECT COALESCE(SUM(total_weight),0) as t FROM sales WHERE variety_id=$1",[v.id])).rows[0].t);
    result.push({...v,bought,sold,stock:bought-sold});
  }
  res.json(result);
});

app.get("/", (req, res) => res.json({ status: "ok", app: "மஞ்சள் தம்பி v3" }));

const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => console.log(`🟡 மஞ்சள் தம்பி API v3 on port ${PORT}`));
}).catch(err => {
  console.error("DB error:", err);
  app.listen(PORT, () => console.log(`🟡 API running (DB error)`));
});
