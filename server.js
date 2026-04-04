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

async function initDB() {
  // ── Core tables ──────────────────────────────────────────────────
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
      id TEXT PRIMARY KEY,
      emp_id TEXT NOT NULL,
      date TEXT NOT NULL,
      amount REAL NOT NULL,
      note TEXT DEFAULT '',
      type TEXT DEFAULT 'payment'
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

  // ── Safe column migrations ──────────────────────────────────────
  await pool.query("ALTER TABLE attendance ADD COLUMN IF NOT EXISTS daily_wage REAL DEFAULT 0").catch(()=>{});
  await pool.query("ALTER TABLE attendance ADD COLUMN IF NOT EXISTS ot_wage REAL DEFAULT 0").catch(()=>{});
  await pool.query("ALTER TABLE attendance ADD COLUMN IF NOT EXISTS daily_salary REAL DEFAULT 0").catch(()=>{});
  await pool.query("ALTER TABLE attendance ADD COLUMN IF NOT EXISTS paid_amount REAL DEFAULT 0").catch(()=>{});
  await pool.query("ALTER TABLE payments ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'payment'").catch(()=>{});
  await pool.query("ALTER TABLE payments ALTER COLUMN period DROP NOT NULL").catch(()=>{});

  // ── Migrate existing attendance records ─────────────────────────
  // Fill daily_wage from employee record where not set
  await pool.query(`
    UPDATE attendance a SET
      daily_wage = COALESCE(NULLIF(a.daily_wage,0), e.daily_wage),
      ot_wage = CASE WHEN e.gender='female' THEN
        COALESCE((SELECT value::REAL FROM settings WHERE key='femaleOT'),100)
        ELSE COALESCE((SELECT value::REAL FROM settings WHERE key='maleOT'),50) END
    FROM employees e WHERE a.emp_id = e.id AND a.daily_wage = 0
  `).catch(()=>{});

  // Compute daily_salary for existing records that have 0
  await pool.query(`
    UPDATE attendance SET daily_salary =
      CASE
        WHEN status='present'  THEN daily_wage
        WHEN status='halfday'  THEN daily_wage * 0.5
        WHEN status='overtime' THEN daily_wage + ot_wage
        WHEN status='leave'    THEN 0
        WHEN status='absent'   THEN 0
        ELSE daily_wage
      END
    WHERE daily_salary = 0 AND daily_wage > 0
  `).catch(()=>{});

  // ── Migrate advances table to payments ──────────────────────────
  const hasAdv = await pool.query(
    "SELECT EXISTS(SELECT FROM information_schema.tables WHERE table_name='advances')"
  ).catch(()=>({rows:[{exists:false}]}));
  if (hasAdv.rows[0].exists) {
    await pool.query(`
      INSERT INTO payments (id, emp_id, date, amount, note, type)
      SELECT id, emp_id, date, amount, COALESCE(note,''), 'advance'
      FROM advances
      ON CONFLICT (id) DO NOTHING
    `).catch(()=>{});
  }

  // ── Default settings ────────────────────────────────────────────
  const defs = {femaleDay:"350",femaleOT:"100",maleDay:"800",maleOT:"50"};
  for (const [k,v] of Object.entries(defs)) {
    await pool.query("INSERT INTO settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING",[k,v]);
  }

  // ── Default varieties ───────────────────────────────────────────
  const vars = [["virali","விராலி"],["gundumanjal","குண்டுமஞ்சள்"],["erode","ஈரோடு"],["salem","சேலம்"],["local","உள்ளூர்"]];
  for (const [id,name] of vars) {
    await pool.query("INSERT INTO varieties (id,name,name_ta) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING",[id,name,name]);
  }

  console.log("✅ DB ready — Daily salary system v3");
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2,7);

// Helper: compute daily_salary from status + wages
function computeSalary(status, dailyWage, otWage) {
  if (status === "present")  return dailyWage;
  if (status === "halfday")  return Math.round(dailyWage * 0.5 * 100) / 100;
  if (status === "overtime") return dailyWage + otWage;
  if (status === "leave")    return 0;
  return 0;
}

// ═══ SETTINGS ═══════════════════════════════════════════════════════
app.get("/api/settings", async (req,res) => {
  const {rows} = await pool.query("SELECT key,value FROM settings");
  const obj = {}; rows.forEach(r => {obj[r.key]=r.value;}); res.json(obj);
});
app.put("/api/settings", async (req,res) => {
  for (const [k,v] of Object.entries(req.body)) {
    await pool.query("INSERT INTO settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2",[k,String(v)]);
  }
  res.json({ok:true});
});

// ═══ VARIETIES ══════════════════════════════════════════════════════
app.get("/api/varieties", async (req,res) => {
  const {rows} = await pool.query("SELECT * FROM varieties WHERE active=true ORDER BY name");
  res.json(rows);
});
app.post("/api/varieties", async (req,res) => {
  const {name,name_ta} = req.body; const id = uid();
  await pool.query("INSERT INTO varieties (id,name,name_ta) VALUES ($1,$2,$3)",[id,name,name_ta||name]);
  res.json({id});
});
app.put("/api/varieties/:id", async (req,res) => {
  const {name,name_ta} = req.body;
  await pool.query("UPDATE varieties SET name=$1,name_ta=$2 WHERE id=$3",[name,name_ta||name,req.params.id]);
  res.json({ok:true});
});
app.delete("/api/varieties/:id", async (req,res) => {
  await pool.query("UPDATE varieties SET active=false WHERE id=$1",[req.params.id]);
  res.json({ok:true});
});

// ═══ EMPLOYEES ══════════════════════════════════════════════════════
app.get("/api/employees", async (req,res) => {
  const {rows} = await pool.query("SELECT * FROM employees ORDER BY active DESC, created_at DESC");
  res.json(rows);
});
app.post("/api/employees", async (req,res) => {
  const {name,gender,phone,daily_wage,emp_type} = req.body; const id = uid();
  await pool.query("INSERT INTO employees (id,name,gender,phone,daily_wage,emp_type) VALUES ($1,$2,$3,$4,$5,$6)",
    [id,name,gender||"female",phone||"",daily_wage||0,emp_type||"worker"]);
  res.json({id,name,gender});
});
app.put("/api/employees/:id", async (req,res) => {
  const {name,gender,phone,daily_wage} = req.body;
  await pool.query("UPDATE employees SET name=COALESCE($1,name),gender=COALESCE($2,gender),phone=COALESCE($3,phone),daily_wage=COALESCE($4,daily_wage) WHERE id=$5",
    [name,gender,phone,daily_wage,req.params.id]);
  res.json({ok:true});
});
app.delete("/api/employees/:id", async (req,res) => {
  await pool.query("UPDATE employees SET active=false WHERE id=$1",[req.params.id]);
  res.json({ok:true});
});

// ═══ ATTENDANCE ══════════════════════════════════════════════════════
// GET attendance for a date range — returns daily records with salary info
app.get("/api/attendance", async (req,res) => {
  const {from, to, emp_id} = req.query;
  let sql = "SELECT a.*, e.name, e.gender FROM attendance a JOIN employees e ON a.emp_id=e.id WHERE 1=1";
  const p = [];
  let i = 1;
  if (from) { sql += ` AND a.date >= $${i++}`; p.push(from); }
  if (to)   { sql += ` AND a.date <= $${i++}`; p.push(to); }
  if (emp_id) { sql += ` AND a.emp_id = $${i++}`; p.push(emp_id); }
  sql += " ORDER BY a.date ASC";
  const {rows} = await pool.query(sql, p);
  res.json(rows);
});

// POST — mark one day attendance, snapshot wages, compute + store daily_salary
app.post("/api/attendance", async (req,res) => {
  const {emp_id, date, status} = req.body;

  // Clear record if status empty
  if (!status) {
    await pool.query("DELETE FROM attendance WHERE emp_id=$1 AND date=$2", [emp_id, date]);
    return res.json({ok:true});
  }

  // Get employee wage + settings
  const emp = (await pool.query("SELECT * FROM employees WHERE id=$1", [emp_id])).rows[0];
  if (!emp) return res.status(404).json({error:"Employee not found"});
  const settings = {};
  (await pool.query("SELECT key,value FROM settings")).rows.forEach(r => { settings[r.key] = Number(r.value); });

  const dailyWage = emp.daily_wage > 0 ? emp.daily_wage :
    (emp.gender === "female" ? (settings.femaleDay||350) : (settings.maleDay||800));
  const otWage = emp.gender === "female" ? (settings.femaleOT||100) : (settings.maleOT||50);
  const dailySalary = computeSalary(status, dailyWage, otWage);

  await pool.query(`
    INSERT INTO attendance (emp_id, date, status, daily_wage, ot_wage, daily_salary, paid_amount)
    VALUES ($1,$2,$3,$4,$5,$6,0)
    ON CONFLICT (emp_id, date) DO UPDATE SET
      status=$3, daily_wage=$4, ot_wage=$5, daily_salary=$6
  `, [emp_id, date, status, dailyWage, otWage, dailySalary]);

  res.json({ok:true, daily_salary:dailySalary});
});

// POST bulk — mark all employees on a specific day
app.post("/api/attendance/bulk", async (req,res) => {
  const {date, emp_ids, status} = req.body;
  const settings = {};
  (await pool.query("SELECT key,value FROM settings")).rows.forEach(r => { settings[r.key] = Number(r.value); });

  for (const eid of emp_ids) {
    const emp = (await pool.query("SELECT * FROM employees WHERE id=$1", [eid])).rows[0];
    if (!emp) continue;
    const dailyWage = emp.daily_wage > 0 ? emp.daily_wage :
      (emp.gender === "female" ? (settings.femaleDay||350) : (settings.maleDay||800));
    const otWage = emp.gender === "female" ? (settings.femaleOT||100) : (settings.maleOT||50);
    const dailySalary = computeSalary(status, dailyWage, otWage);
    await pool.query(`
      INSERT INTO attendance (emp_id,date,status,daily_wage,ot_wage,daily_salary,paid_amount)
      VALUES ($1,$2,$3,$4,$5,$6,0)
      ON CONFLICT (emp_id,date) DO NOTHING
    `, [eid, date, status, dailyWage, otWage, dailySalary]);
  }
  res.json({ok:true});
});

// POST — pay a single day (full, partial, or undo)
app.post("/api/attendance/pay-day", async (req,res) => {
  const {emp_id, date, paid_amount} = req.body;
  const amt = Math.max(0, Number(paid_amount)||0);
  await pool.query(
    "UPDATE attendance SET paid_amount=$1 WHERE emp_id=$2 AND date=$3",
    [amt, emp_id, date]
  );
  // Log payment
  if (amt > 0) {
    await pool.query(
      "INSERT INTO payments (id,emp_id,date,amount,note,type) VALUES ($1,$2,$3,$4,$5,$6)",
      [uid(), emp_id, new Date().toISOString().slice(0,10), amt, `நாள் சம்பளம் ${date}`, 'payment']
    );
  }
  res.json({ok:true});
});

// POST — bulk pay: distribute amount across unpaid days chronologically
app.post("/api/attendance/pay-bulk", async (req,res) => {
  const {emp_id, from, to, total_amount} = req.body;
  let remaining = Number(total_amount)||0;
  if (remaining <= 0) return res.json({ok:true, distributed:[]});

  // Get all unpaid/partial days in range, sorted oldest first
  const {rows} = await pool.query(
    "SELECT * FROM attendance WHERE emp_id=$1 AND date>=$2 AND date<=$3 AND daily_salary > paid_amount ORDER BY date ASC",
    [emp_id, from, to]
  );

  const distributed = [];
  for (const row of rows) {
    if (remaining <= 0) break;
    const balance = row.daily_salary - row.paid_amount;
    const toPay = Math.min(balance, remaining);
    const newPaid = row.paid_amount + toPay;
    await pool.query(
      "UPDATE attendance SET paid_amount=$1 WHERE emp_id=$2 AND date=$3",
      [newPaid, emp_id, row.date]
    );
    distributed.push({date: row.date, paid: toPay, total_paid: newPaid, salary: row.daily_salary});
    remaining -= toPay;
  }

  // Log bulk payment
  const totalPaid = Number(total_amount) - remaining;
  if (totalPaid > 0) {
    await pool.query(
      "INSERT INTO payments (id,emp_id,date,amount,note,type) VALUES ($1,$2,$3,$4,$5,$6)",
      [uid(), emp_id, new Date().toISOString().slice(0,10), totalPaid, `வரம்பு சம்பளம் ${from} முதல் ${to}`, 'payment']
    );
  }
  res.json({ok:true, distributed, remaining_unallocated: remaining});
});

// POST — mark all days in range as fully paid
app.post("/api/attendance/pay-full-range", async (req,res) => {
  const {emp_id, from, to} = req.body;
  const {rows} = await pool.query(
    "UPDATE attendance SET paid_amount=daily_salary WHERE emp_id=$1 AND date>=$2 AND date<=$3 AND daily_salary>0 RETURNING date, daily_salary",
    [emp_id, from, to]
  );
  const total = rows.reduce((s,r) => s + Number(r.daily_salary), 0);
  if (total > 0) {
    await pool.query(
      "INSERT INTO payments (id,emp_id,date,amount,note,type) VALUES ($1,$2,$3,$4,$5,$6)",
      [uid(), emp_id, new Date().toISOString().slice(0,10), total, `முழு சம்பளம் ${from} முதல் ${to}`, 'payment']
    );
  }
  res.json({ok:true, total_paid: total, days: rows.length});
});

// POST — mark all days in range as unpaid
app.post("/api/attendance/unpay-range", async (req,res) => {
  const {emp_id, from, to} = req.body;
  await pool.query(
    "UPDATE attendance SET paid_amount=0 WHERE emp_id=$1 AND date>=$2 AND date<=$3",
    [emp_id, from, to]
  );
  res.json({ok:true});
});

// ═══ PAYMENTS LOG ════════════════════════════════════════════════════
app.get("/api/payments", async (req,res) => {
  const {emp_id} = req.query;
  const {rows} = await pool.query(
    "SELECT * FROM payments WHERE emp_id=$1 ORDER BY date DESC LIMIT 100",
    [emp_id]
  );
  res.json(rows);
});
app.post("/api/payments", async (req,res) => {
  const {emp_id,date,amount,note,type} = req.body; const id=uid();
  await pool.query("INSERT INTO payments (id,emp_id,date,amount,note,type) VALUES ($1,$2,$3,$4,$5,$6)",
    [id,emp_id,date,amount,note||"",type||"payment"]);
  res.json({id});
});
app.delete("/api/payments/:id", async (req,res) => {
  await pool.query("DELETE FROM payments WHERE id=$1",[req.params.id]);
  res.json({ok:true});
});

// Keep old advances endpoint for compatibility
app.post("/api/advances", async (req,res) => {
  const {emp_id,date,amount,note} = req.body; const id=uid();
  await pool.query("INSERT INTO payments (id,emp_id,date,amount,note,type) VALUES ($1,$2,$3,$4,$5,'advance')",
    [id,emp_id,date,amount,note||""]);
  res.json({id});
});
app.delete("/api/advances/:id", async (req,res) => {
  await pool.query("DELETE FROM payments WHERE id=$1",[req.params.id]);
  res.json({ok:true});
});

// ═══ SALARY REPORT ═══════════════════════════════════════════════════
// Works for any date range: day, week, month, year
app.get("/api/reports/salary", async (req,res) => {
  const {from, to} = req.query;
  if (!from || !to) return res.status(400).json({error:"from and to required"});

  const emps = (await pool.query("SELECT * FROM employees ORDER BY active DESC, name ASC")).rows;
  const settings = {};
  (await pool.query("SELECT key,value FROM settings")).rows.forEach(r => { settings[r.key]=Number(r.value); });

  const result = [];
  for (const emp of emps) {
    // Get all attendance in range
    const attRows = (await pool.query(
      "SELECT * FROM attendance WHERE emp_id=$1 AND date>=$2 AND date<=$3 ORDER BY date ASC",
      [emp.id, from, to]
    )).rows;

    let days=0, ot=0, hd=0, leaveCount=0;
    let totalSalary=0, totalPaid=0;

    attRows.forEach(a => {
      if (a.status==="present")  days++;
      else if (a.status==="overtime") { days++; ot++; }
      else if (a.status==="halfday")  hd++;
      else if (a.status==="leave")    leaveCount++;
      totalSalary += Number(a.daily_salary)||0;
      totalPaid   += Number(a.paid_amount)||0;
    });

    const balance = totalSalary - totalPaid;
    const hasActivity = attRows.length > 0 || totalPaid > 0;

    result.push({
      ...emp,
      days, ot, hd, leaveCount,
      effectiveDays: days + hd*0.5,
      totalSalary, totalPaid, balance,
      isPaid: totalSalary > 0 && balance <= 0,
      hasActivity,
      attendanceRows: attRows  // daily detail for invoice
    });
  }
  res.json(result);
});

// ═══ YEARLY SALARY SUMMARY (by month) ═══════════════════════════════
app.get("/api/reports/salary/yearly", async (req,res) => {
  const {year, emp_id} = req.query;
  if (!year) return res.status(400).json({error:"year required"});

  const from = `${year}-01-01`;
  const to   = `${year}-12-31`;

  // Build monthly summary
  const months = [];
  for (let m=1; m<=12; m++) {
    const mm = String(m).padStart(2,"0");
    const mfrom = `${year}-${mm}-01`;
    const mto   = `${year}-${mm}-${new Date(year,m,0).getDate()}`;

    let sql = "SELECT SUM(daily_salary) as earned, SUM(paid_amount) as paid, COUNT(*) as days FROM attendance WHERE date>=$1 AND date<=$2";
    const p = [mfrom, mto];
    if (emp_id) { sql += " AND emp_id=$3"; p.push(emp_id); }

    const row = (await pool.query(sql, p)).rows[0];
    months.push({
      month: m, mfrom, mto,
      earned: Number(row.earned)||0,
      paid: Number(row.paid)||0,
      balance: (Number(row.earned)||0) - (Number(row.paid)||0),
      days: Number(row.days)||0
    });
  }

  // Total
  let sql2 = "SELECT SUM(daily_salary) as earned, SUM(paid_amount) as paid FROM attendance WHERE date>=$1 AND date<=$2";
  const p2 = [from, to];
  if (emp_id) { sql2 += " AND emp_id=$3"; p2.push(emp_id); }
  const total = (await pool.query(sql2, p2)).rows[0];

  res.json({
    year, months,
    totalEarned: Number(total.earned)||0,
    totalPaid: Number(total.paid)||0,
    totalBalance: (Number(total.earned)||0) - (Number(total.paid)||0)
  });
});

// ═══ PURCHASES ═══════════════════════════════════════════════════════
app.get("/api/purchases", async (req,res) => {
  const {year}=req.query;
  let sql="SELECT p.*,v.name as variety_name,v.name_ta as variety_ta FROM purchases p LEFT JOIN varieties v ON p.variety_id=v.id WHERE 1=1";
  const prm=[]; if(year){sql+=` AND p.date LIKE $1`;prm.push(year+"%");}
  sql+=" ORDER BY p.date DESC";
  const {rows}=await pool.query(sql,prm);
  rows.forEach(r=>{r.loads=JSON.parse(r.loads_json||"[]");});
  res.json(rows);
});
app.post("/api/purchases", async (req,res) => {
  const p=req.body; const id=uid();
  await pool.query(`INSERT INTO purchases (id,date,farmer,phone,vehicle,variety_id,loads_json,total_net_weight,deduction_per_ton,deduction,final_weight,price_per_kg,total_amount)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [id,p.date,p.farmer,p.phone||"",p.vehicle||"",p.variety_id||"",JSON.stringify(p.loads||[]),p.total_net_weight,p.deduction_per_ton,p.deduction,p.final_weight,p.price_per_kg,p.total_amount]);
  res.json({id});
});
app.delete("/api/purchases/:id", async (req,res) => {
  await pool.query("DELETE FROM purchases WHERE id=$1",[req.params.id]); res.json({ok:true});
});

// ═══ SALES ═══════════════════════════════════════════════════════════
app.get("/api/sales", async (req,res) => {
  const {year}=req.query;
  let sql="SELECT s.*,v.name_ta as variety_ta FROM sales s LEFT JOIN varieties v ON s.variety_id=v.id WHERE 1=1";
  const prm=[]; if(year){sql+=` AND s.date LIKE $1`;prm.push(year+"%");}
  sql+=" ORDER BY s.date DESC";
  const {rows}=await pool.query(sql,prm);
  rows.forEach(r=>{r.bags=JSON.parse(r.bags_json||"[]");});
  res.json(rows);
});
app.post("/api/sales", async (req,res) => {
  const s=req.body; const id=uid();
  await pool.query("INSERT INTO sales (id,date,farmer,phone,variety_id,bags_json,total_weight,price_per_kg,total_amount) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [id,s.date,s.farmer,s.phone||"",s.variety_id||"",JSON.stringify(s.bags||[]),s.total_weight,s.price_per_kg,s.total_amount]);
  res.json({id});
});
app.delete("/api/sales/:id", async (req,res) => {
  await pool.query("DELETE FROM sales WHERE id=$1",[req.params.id]); res.json({ok:true});
});

// ═══ PROCESSING ══════════════════════════════════════════════════════
app.get("/api/processing", async (req,res) => {
  const {rows}=await pool.query("SELECT p.*,v.name_ta as variety_ta FROM processing p LEFT JOIN varieties v ON p.variety_id=v.id ORDER BY p.date DESC");
  res.json(rows);
});
app.post("/api/processing/auto", async (req,res) => {
  const p=req.body; const id=uid(); const fw=Number(p.fresh_weight)||0;
  const ab=Math.round(fw*0.95*10)/10; const ad=Math.round(ab*0.22*10)/10; const fp=Math.round(ad*0.93*10)/10;
  const yp=fw>0?(fp/fw)*100:0; const q=fp/100;
  await pool.query(`INSERT INTO processing (id,date,farmer,variety_id,fresh_weight,after_boiling,after_drying,final_weight,yield_percent,status,notes,raw_used,quintal) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [id,p.date||new Date().toISOString().slice(0,10),p.farmer||"",p.variety_id||"",fw,ab,ad,fp,yp,p.status||"done",p.notes||"",fw,q]);
  res.json({id,after_boiling:ab,after_drying:ad,final_weight:fp,yield_percent:yp,quintal:q});
});
app.delete("/api/processing/:id", async (req,res) => {
  await pool.query("DELETE FROM processing WHERE id=$1",[req.params.id]); res.json({ok:true});
});

// ═══ MARKET SALES ════════════════════════════════════════════════════
app.get("/api/market-sales", async (req,res) => {
  const {rows}=await pool.query("SELECT m.*,v.name_ta as variety_ta FROM market_sales m LEFT JOIN varieties v ON m.variety_id=v.id ORDER BY m.date DESC");
  res.json(rows);
});
app.post("/api/market-sales", async (req,res) => {
  const s=req.body; const id=uid();
  const quintal=s.processed_qty/100; const revenue=quintal*(s.rate_per_quintal||0);
  await pool.query("INSERT INTO market_sales (id,date,processed_qty,quintal,rate_per_quintal,revenue,variety_id,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    [id,s.date||new Date().toISOString().slice(0,10),s.processed_qty,quintal,s.rate_per_quintal||0,revenue,s.variety_id||"",s.notes||""]);
  res.json({id,quintal,revenue});
});
app.delete("/api/market-sales/:id", async (req,res) => {
  await pool.query("DELETE FROM market_sales WHERE id=$1",[req.params.id]); res.json({ok:true});
});

// ═══ DASHBOARD ═══════════════════════════════════════════════════════
app.get("/api/dashboard", async (req,res) => {
  const tp=Number((await pool.query("SELECT COALESCE(SUM(final_weight),0) as t FROM purchases")).rows[0].t);
  const ts=Number((await pool.query("SELECT COALESCE(SUM(total_weight),0) as t FROM sales")).rows[0].t);
  const tpr=Number((await pool.query("SELECT COALESCE(SUM(raw_used),0) as t FROM processing WHERE status='done'")).rows[0].t);
  const rem=tp-ts-tpr;
  const tpq=Number((await pool.query("SELECT COALESCE(SUM(final_weight),0) as t FROM processing WHERE status='done'")).rows[0].t);
  const tms=Number((await pool.query("SELECT COALESCE(SUM(processed_qty),0) as t FROM market_sales")).rows[0].t);
  const trev=Number((await pool.query("SELECT COALESCE(SUM(revenue),0) as t FROM market_sales")).rows[0].t);
  const tpa=Number((await pool.query("SELECT COALESCE(SUM(total_amount),0) as t FROM purchases")).rows[0].t);
  const tsa=Number((await pool.query("SELECT COALESCE(SUM(total_amount),0) as t FROM sales")).rows[0].t);
  res.json({
    totalPurchased:tp, totalSeedSold:ts, remainingRaw:rem, totalRawProcessed:tpr,
    totalProcessedQty:tpq, processedStock:tpq-tms, totalMarketSold:tms,
    totalRevenue:trev, totalPurchaseAmt:tpa, totalSeedAmt:tsa,
    profit:trev+tsa-tpa
  });
});

// ═══ OTHER REPORTS ════════════════════════════════════════════════════
app.get("/api/reports/profit", async (req,res) => {
  const {year}=req.query; const f=year?` WHERE date LIKE '${year}%'`:"";
  const tp=Number((await pool.query("SELECT COALESCE(SUM(total_amount),0) as t FROM purchases"+f)).rows[0].t);
  const ts=Number((await pool.query("SELECT COALESCE(SUM(total_amount),0) as t FROM sales"+f)).rows[0].t);
  const tpk=Number((await pool.query("SELECT COALESCE(SUM(final_weight),0) as t FROM purchases"+f)).rows[0].t);
  const tsk=Number((await pool.query("SELECT COALESCE(SUM(total_weight),0) as t FROM sales"+f)).rows[0].t);
  res.json({totalPurchase:tp,totalSale:ts,profit:ts-tp,stockKg:tpk-tsk});
});
app.get("/api/reports/stock", async (req,res) => {
  const varieties=(await pool.query("SELECT * FROM varieties WHERE active=true")).rows;
  const result=[];
  for(const v of varieties){
    const bought=Number((await pool.query("SELECT COALESCE(SUM(final_weight),0) as t FROM purchases WHERE variety_id=$1",[v.id])).rows[0].t);
    const sold=Number((await pool.query("SELECT COALESCE(SUM(total_weight),0) as t FROM sales WHERE variety_id=$1",[v.id])).rows[0].t);
    result.push({...v,bought,sold,stock:bought-sold});
  }
  res.json(result);
});

app.get("/", (req,res) => res.json({status:"ok",app:"பண்ணை மேலாண்மை v3 — Daily Salary System"}));

const PORT=process.env.PORT||3000;
initDB().then(()=>{
  app.listen(PORT,()=>console.log(`🌾 Farm API v3 on port ${PORT}`));
}).catch(err=>{
  console.error("DB error:",err);
  app.listen(PORT,()=>console.log(`🌾 API running (DB error)`));
});
