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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS employees (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, gender TEXT DEFAULT 'female',
      phone TEXT DEFAULT '', daily_wage REAL DEFAULT 0, emp_type TEXT DEFAULT 'worker',
      active BOOLEAN DEFAULT true, created_at DATE DEFAULT CURRENT_DATE
    );
    CREATE TABLE IF NOT EXISTS attendance (
      id SERIAL PRIMARY KEY, emp_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      date TEXT NOT NULL, status TEXT NOT NULL, UNIQUE(emp_id, date)
    );
    CREATE TABLE IF NOT EXISTS advances (
      id TEXT PRIMARY KEY, emp_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      date TEXT NOT NULL, amount REAL NOT NULL, note TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY, emp_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      date TEXT NOT NULL, amount REAL NOT NULL, period TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS varieties (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, name_ta TEXT DEFAULT '', active BOOLEAN DEFAULT true
    );
    CREATE TABLE IF NOT EXISTS purchases (
      id TEXT PRIMARY KEY, date TEXT NOT NULL, farmer TEXT NOT NULL, phone TEXT DEFAULT '',
      vehicle TEXT DEFAULT '', variety_id TEXT DEFAULT '', loads_json TEXT DEFAULT '[]',
      total_net_weight REAL DEFAULT 0, deduction_per_ton REAL DEFAULT 50,
      deduction REAL DEFAULT 0, final_weight REAL DEFAULT 0,
      price_per_kg REAL DEFAULT 0, total_amount REAL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sales (
      id TEXT PRIMARY KEY, date TEXT NOT NULL, farmer TEXT NOT NULL, phone TEXT DEFAULT '',
      variety_id TEXT DEFAULT '', bags_json TEXT DEFAULT '[]',
      total_weight REAL DEFAULT 0, price_per_kg REAL DEFAULT 0, total_amount REAL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS processing (
      id TEXT PRIMARY KEY, date TEXT NOT NULL, farmer TEXT DEFAULT '', variety_id TEXT DEFAULT '',
      fresh_weight REAL NOT NULL, after_boiling REAL DEFAULT 0, after_drying REAL DEFAULT 0,
      final_weight REAL DEFAULT 0, yield_percent REAL DEFAULT 0,
      status TEXT DEFAULT 'fresh', notes TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS market_sales (
      id TEXT PRIMARY KEY, date TEXT NOT NULL, processed_qty REAL DEFAULT 0,
      quintal REAL DEFAULT 0, rate_per_quintal REAL DEFAULT 0, revenue REAL DEFAULT 0,
      variety_id TEXT DEFAULT '', notes TEXT DEFAULT ''
    );
  `);

  // Add columns safely
  await pool.query("ALTER TABLE processing ADD COLUMN IF NOT EXISTS raw_used REAL DEFAULT 0").catch(()=>{});
  await pool.query("ALTER TABLE processing ADD COLUMN IF NOT EXISTS quintal REAL DEFAULT 0").catch(()=>{});
  await pool.query("ALTER TABLE attendance ADD COLUMN IF NOT EXISTS ot_amount REAL DEFAULT 0").catch(()=>{});

  // Default settings — only wage + OT (NO soil deduction)
  const defs = {dailyWage:"350",otRate:"100",femaleDay:"350",femaleOT:"100",maleDay:"800",maleOT:"50"};
  for (const [k,v] of Object.entries(defs)) {
    await pool.query("INSERT INTO settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING",[k,v]);
  }
  // Default varieties
  const vars = [["virali","விராலி"],["gundumanjal","குண்டுமஞ்சள்"],["erode","ஈரோடு"],["salem","சேலம்"],["local","உள்ளூர்"]];
  for (const [id,name] of vars) {
    await pool.query("INSERT INTO varieties (id,name,name_ta) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING",[id,name,name]);
  }
  console.log("✅ DB ready");
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2,7);

// ═══ SETTINGS ═══
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

// ═══ VARIETIES ═══
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

// ═══ EMPLOYEES ═══
app.get("/api/employees", async (req,res) => {
  const {rows} = await pool.query("SELECT * FROM employees WHERE active=true ORDER BY created_at DESC");
  res.json(rows);
});
app.post("/api/employees", async (req,res) => {
  const {name,gender,phone,daily_wage,emp_type} = req.body; const id = uid();
  await pool.query("INSERT INTO employees (id,name,gender,phone,daily_wage,emp_type) VALUES ($1,$2,$3,$4,$5,$6)",
    [id,name,gender||"female",phone||"",daily_wage||0,emp_type||"worker"]);
  res.json({id,name,gender});
});
app.put("/api/employees/:id", async (req,res) => {
  const {name,gender,phone,daily_wage,emp_type} = req.body;
  await pool.query("UPDATE employees SET name=COALESCE($1,name),gender=COALESCE($2,gender),phone=COALESCE($3,phone),daily_wage=COALESCE($4,daily_wage),emp_type=COALESCE($5,emp_type) WHERE id=$6",
    [name,gender,phone,daily_wage,emp_type,req.params.id]);
  res.json({ok:true});
});
app.delete("/api/employees/:id", async (req,res) => {
  // Soft delete — preserve history
  await pool.query("UPDATE employees SET active=false WHERE id=$1",[req.params.id]);
  res.json({ok:true});
});

// ═══ ATTENDANCE ═══
app.get("/api/attendance", async (req,res) => {
  const {from,to} = req.query;
  const {rows} = from&&to ?
    await pool.query("SELECT * FROM attendance WHERE date>=$1 AND date<=$2",[from,to]) :
    await pool.query("SELECT * FROM attendance ORDER BY date DESC LIMIT 500");
  res.json(rows);
});
app.post("/api/attendance", async (req,res) => {
  const {emp_id,date,status} = req.body;
  if(!status) await pool.query("DELETE FROM attendance WHERE emp_id=$1 AND date=$2",[emp_id,date]);
  else await pool.query("INSERT INTO attendance (emp_id,date,status) VALUES ($1,$2,$3) ON CONFLICT (emp_id,date) DO UPDATE SET status=$3",[emp_id,date,status]);
  res.json({ok:true});
});
app.post("/api/attendance/bulk", async (req,res) => {
  const {date,emp_ids,status} = req.body;
  for (const eid of emp_ids) await pool.query("INSERT INTO attendance (emp_id,date,status) VALUES ($1,$2,$3) ON CONFLICT (emp_id,date) DO NOTHING",[eid,date,status]);
  res.json({ok:true});
});

// ═══ ADVANCES ═══
app.get("/api/advances", async (req,res) => {
  const {emp_id,month} = req.query; let sql="SELECT * FROM advances WHERE 1=1"; const p=[]; let i=1;
  if(emp_id){sql+=` AND emp_id=$${i++}`;p.push(emp_id);}
  if(month){sql+=` AND date LIKE $${i++}`;p.push(month+"%");}
  sql+=" ORDER BY date DESC";
  res.json((await pool.query(sql,p)).rows);
});
app.post("/api/advances", async (req,res) => {
  const {emp_id,date,amount,note}=req.body; const id=uid();
  await pool.query("INSERT INTO advances (id,emp_id,date,amount,note) VALUES ($1,$2,$3,$4,$5)",[id,emp_id,date,amount,note||""]);
  res.json({id});
});
app.delete("/api/advances/:id", async (req,res) => {
  await pool.query("DELETE FROM advances WHERE id=$1",[req.params.id]); res.json({ok:true});
});

// ═══ PAYMENTS ═══
app.get("/api/payments", async (req,res) => {
  const {emp_id,period}=req.query; let sql="SELECT * FROM payments WHERE 1=1"; const p=[]; let i=1;
  if(emp_id){sql+=` AND emp_id=$${i++}`;p.push(emp_id);}
  if(period){sql+=` AND period=$${i++}`;p.push(period);}
  res.json((await pool.query(sql+" ORDER BY date DESC",p)).rows);
});
app.post("/api/payments", async (req,res) => {
  const {emp_id,date,amount,period}=req.body; const id=uid();
  await pool.query("INSERT INTO payments (id,emp_id,date,amount,period) VALUES ($1,$2,$3,$4,$5)",[id,emp_id,date,amount,period]);
  res.json({id});
});
app.delete("/api/payments/:id", async (req,res) => {
  await pool.query("DELETE FROM payments WHERE id=$1",[req.params.id]); res.json({ok:true});
});

// ═══ PURCHASES ═══
app.get("/api/purchases", async (req,res) => {
  const {year,farmer}=req.query; let sql="SELECT p.*,v.name as variety_name,v.name_ta as variety_ta FROM purchases p LEFT JOIN varieties v ON p.variety_id=v.id WHERE 1=1"; const prm=[]; let i=1;
  if(year){sql+=` AND p.date LIKE $${i++}`;prm.push(year+"%");}
  if(farmer){sql+=` AND p.farmer=$${i++}`;prm.push(farmer);}
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

// ═══ SALES ═══
app.get("/api/sales", async (req,res) => {
  const {year,farmer}=req.query; let sql="SELECT s.*,v.name as variety_name,v.name_ta as variety_ta FROM sales s LEFT JOIN varieties v ON s.variety_id=v.id WHERE 1=1"; const prm=[]; let i=1;
  if(year){sql+=` AND s.date LIKE $${i++}`;prm.push(year+"%");}
  if(farmer){sql+=` AND s.farmer=$${i++}`;prm.push(farmer);}
  sql+=" ORDER BY s.date DESC";
  const {rows}=await pool.query(sql,prm);
  rows.forEach(r=>{r.bags=JSON.parse(r.bags_json||"[]");});
  res.json(rows);
});
app.post("/api/sales", async (req,res) => {
  const s=req.body; const id=uid();
  // Stock check
  if(s.variety_id){
    const bought=(await pool.query("SELECT COALESCE(SUM(final_weight),0) as t FROM purchases WHERE variety_id=$1",[s.variety_id])).rows[0].t;
    const sold=(await pool.query("SELECT COALESCE(SUM(total_weight),0) as t FROM sales WHERE variety_id=$1",[s.variety_id])).rows[0].t;
    const procLoss=(await pool.query("SELECT COALESCE(SUM(fresh_weight-final_weight),0) as t FROM processing WHERE variety_id=$1 AND status='done'",[s.variety_id])).rows[0].t;
    const stock=Number(bought)-Number(sold)-Number(procLoss);
    if(s.total_weight>stock) return res.status(400).json({error:"போதுமான இருப்பு இல்லை! Stock: "+stock.toFixed(1)+"kg"});
  }
  await pool.query(`INSERT INTO sales (id,date,farmer,phone,variety_id,bags_json,total_weight,price_per_kg,total_amount)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id,s.date,s.farmer,s.phone||"",s.variety_id||"",JSON.stringify(s.bags||[]),s.total_weight,s.price_per_kg,s.total_amount]);
  res.json({id});
});
app.delete("/api/sales/:id", async (req,res) => {
  await pool.query("DELETE FROM sales WHERE id=$1",[req.params.id]); res.json({ok:true});
});

// ═══ PROCESSING (AUTO-ENGINE from remaining raw stock) ═══
app.get("/api/processing", async (req,res) => {
  const {rows}=await pool.query("SELECT p.*,v.name as variety_name,v.name_ta as variety_ta FROM processing p LEFT JOIN varieties v ON p.variety_id=v.id ORDER BY p.date DESC");
  res.json(rows);
});

// Auto-process: takes ALL remaining raw stock
app.post("/api/processing/auto", async (req,res) => {
  const p=req.body; const id=uid();
  // Calculate remaining raw stock (variety-wise or total)
  const varFilter = p.variety_id ? " AND variety_id='"+p.variety_id+"'" : "";
  const totalBought = Number((await pool.query("SELECT COALESCE(SUM(final_weight),0) as t FROM purchases WHERE 1=1"+varFilter)).rows[0].t);
  const totalSeedSold = Number((await pool.query("SELECT COALESCE(SUM(total_weight),0) as t FROM sales WHERE 1=1"+varFilter)).rows[0].t);
  const alreadyProcessed = Number((await pool.query("SELECT COALESCE(SUM(raw_used),0) as t FROM processing WHERE 1=1"+varFilter)).rows[0].t);
  const remainingRaw = totalBought - totalSeedSold - alreadyProcessed;

  if(remainingRaw <= 0) return res.status(400).json({error:"பச்சை இருப்பு இல்லை! Raw stock: 0 kg"});

  // Fixed formulas (Erode model)
  const freshWt = remainingRaw;
  const afterBoiling = freshWt * 0.95;
  const afterDrying = afterBoiling * 0.22;
  const finalPolished = afterDrying * 0.93;
  const yieldPct = (finalPolished / freshWt) * 100;
  const quintal = finalPolished / 100;

  await pool.query(`INSERT INTO processing (id,date,farmer,variety_id,fresh_weight,after_boiling,after_drying,final_weight,yield_percent,status,notes,raw_used,quintal)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [id, p.date||new Date().toISOString().slice(0,10), p.farmer||"", p.variety_id||"",
     freshWt, afterBoiling, afterDrying, finalPolished, yieldPct, "done", p.notes||"",
     freshWt, quintal]);

  res.json({id, fresh_weight:freshWt, after_boiling:afterBoiling, after_drying:afterDrying,
    final_weight:finalPolished, yield_percent:yieldPct, quintal:quintal});
});

// Manual processing (override)
app.post("/api/processing", async (req,res) => {
  const p=req.body; const id=uid();
  const fw=p.fresh_weight||0;
  const ab=fw*0.95; const ad=ab*0.22; const fp=ad*0.93;
  const yp=fw>0?(fp/fw)*100:0; const q=fp/100;
  await pool.query(`INSERT INTO processing (id,date,farmer,variety_id,fresh_weight,after_boiling,after_drying,final_weight,yield_percent,status,notes,raw_used,quintal)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [id,p.date||new Date().toISOString().slice(0,10),p.farmer||"",p.variety_id||"",fw,ab,ad,fp,yp,p.status||"done",p.notes||"",fw,q]);
  res.json({id,after_boiling:ab,after_drying:ad,final_weight:fp,yield_percent:yp,quintal:q});
});

app.delete("/api/processing/:id", async (req,res) => {
  await pool.query("DELETE FROM processing WHERE id=$1",[req.params.id]); res.json({ok:true});
});

// ═══ MARKET SALES (Erode Model — sell processed qty) ═══
app.get("/api/market-sales", async (req,res) => {
  const {rows}=await pool.query("SELECT m.*,v.name_ta as variety_ta FROM market_sales m LEFT JOIN varieties v ON m.variety_id=v.id ORDER BY m.date DESC");
  res.json(rows);
});

app.post("/api/market-sales", async (req,res) => {
  const s=req.body; const id=uid();
  // Check processed stock
  const totalProcessed = Number((await pool.query("SELECT COALESCE(SUM(final_weight),0) as t FROM processing WHERE status='done'")).rows[0].t);
  const totalMarketSold = Number((await pool.query("SELECT COALESCE(SUM(processed_qty),0) as t FROM market_sales")).rows[0].t);
  const processedStock = totalProcessed - totalMarketSold;

  if(s.processed_qty > processedStock) return res.status(400).json({error:"பதப்படுத்திய இருப்பு போதவில்லை! Stock: "+processedStock.toFixed(1)+"kg"});

  const quintal = s.processed_qty / 100;
  const revenue = quintal * (s.rate_per_quintal || 0);

  await pool.query(`INSERT INTO market_sales (id,date,processed_qty,quintal,rate_per_quintal,revenue,variety_id,notes)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, s.date||new Date().toISOString().slice(0,10), s.processed_qty, quintal, s.rate_per_quintal||0, revenue, s.variety_id||"", s.notes||""]);
  res.json({id, quintal, revenue});
});

app.delete("/api/market-sales/:id", async (req,res) => {
  await pool.query("DELETE FROM market_sales WHERE id=$1",[req.params.id]); res.json({ok:true});
});

// ═══ DASHBOARD (Full Pipeline) ═══
app.get("/api/dashboard", async (req,res) => {
  const totalPurchased = Number((await pool.query("SELECT COALESCE(SUM(final_weight),0) as t FROM purchases")).rows[0].t);
  const totalSeedSold = Number((await pool.query("SELECT COALESCE(SUM(total_weight),0) as t FROM sales")).rows[0].t);
  const totalRawProcessed = Number((await pool.query("SELECT COALESCE(SUM(raw_used),0) as t FROM processing WHERE status='done'")).rows[0].t);
  const remainingRaw = totalPurchased - totalSeedSold - totalRawProcessed;
  const totalProcessedQty = Number((await pool.query("SELECT COALESCE(SUM(final_weight),0) as t FROM processing WHERE status='done'")).rows[0].t);
  const totalMarketSold = Number((await pool.query("SELECT COALESCE(SUM(processed_qty),0) as t FROM market_sales")).rows[0].t);
  const processedStock = totalProcessedQty - totalMarketSold;
  const totalQuintal = Number((await pool.query("SELECT COALESCE(SUM(quintal),0) as t FROM market_sales")).rows[0].t);
  const totalRevenue = Number((await pool.query("SELECT COALESCE(SUM(revenue),0) as t FROM market_sales")).rows[0].t);
  const totalPurchaseAmt = Number((await pool.query("SELECT COALESCE(SUM(total_amount),0) as t FROM purchases")).rows[0].t);
  const totalSeedAmt = Number((await pool.query("SELECT COALESCE(SUM(total_amount),0) as t FROM sales")).rows[0].t);
  const yieldPct = totalPurchased > 0 ? (totalProcessedQty/totalPurchased)*100 : 0;

  res.json({
    totalPurchased, totalSeedSold, remainingRaw, totalRawProcessed,
    totalProcessedQty, processedStock, totalMarketSold,
    totalQuintal, totalRevenue, totalPurchaseAmt, totalSeedAmt,
    profit: totalRevenue + totalSeedAmt - totalPurchaseAmt,
    yieldPct
  });
});

// ═══ REPORTS ═══
app.get("/api/reports/salary", async (req,res) => {
  const {month}=req.query;
  const emps=(await pool.query("SELECT * FROM employees")).rows;
  const settings={}; (await pool.query("SELECT key,value FROM settings")).rows.forEach(r=>{settings[r.key]=Number(r.value);});
  const result=[];
  for(const emp of emps){
    const att=(await pool.query("SELECT status,COUNT(*) as cnt FROM attendance WHERE emp_id=$1 AND date LIKE $2 GROUP BY status",[emp.id,month+"%"])).rows;
    let days=0,ot=0,hd=0;
    att.forEach(a=>{const c=Number(a.cnt);if(a.status==="present")days+=c;else if(a.status==="overtime"){days+=c;ot+=c;}else if(a.status==="halfday")hd+=c;});
    const dayRate=emp.daily_wage>0?emp.daily_wage:(emp.gender==="female"?(settings.femaleDay||350):(settings.maleDay||800));
    const otRate=emp.gender==="female"?(settings.femaleOT||100):(settings.maleOT||50);
    const totalDays=days+hd*0.5;
    const earned=totalDays*dayRate+ot*otRate;
    const advList=(await pool.query("SELECT id,date,amount,note FROM advances WHERE emp_id=$1 AND date LIKE $2 ORDER BY date DESC",[emp.id,month+"%"])).rows;
    const payList=(await pool.query("SELECT id,date,amount FROM payments WHERE emp_id=$1 AND period=$2 ORDER BY date DESC",[emp.id,month])).rows;
    const totalAdv=advList.reduce((s,a)=>s+Number(a.amount),0);
    const totalPaid=payList.reduce((s,p)=>s+Number(p.amount),0);
    const balance=earned-totalAdv-totalPaid;
    result.push({...emp,days,ot,hd,totalDays,earned,totalAdv,totalPaid,balance,isPaid:balance<=0&&(totalPaid>0||earned===0),advances:advList,payments:payList});
  }
  res.json(result);
});

app.get("/api/reports/profit", async (req,res) => {
  const {year}=req.query; const f=year?" WHERE date LIKE '"+year+"%'":"";
  const tp=Number((await pool.query("SELECT COALESCE(SUM(total_amount),0) as t FROM purchases"+f)).rows[0].t);
  const ts=Number((await pool.query("SELECT COALESCE(SUM(total_amount),0) as t FROM sales"+f)).rows[0].t);
  const tpk=Number((await pool.query("SELECT COALESCE(SUM(final_weight),0) as t FROM purchases"+f)).rows[0].t);
  const tsk=Number((await pool.query("SELECT COALESCE(SUM(total_weight),0) as t FROM sales"+f)).rows[0].t);
  res.json({totalPurchase:tp,totalSale:ts,profit:ts-tp,stockKg:tpk-tsk});
});

app.get("/api/reports/stock", async (req,res) => {
  // Stock by variety
  const varieties=(await pool.query("SELECT * FROM varieties WHERE active=true")).rows;
  const result=[];
  for(const v of varieties){
    const bought=Number((await pool.query("SELECT COALESCE(SUM(final_weight),0) as t FROM purchases WHERE variety_id=$1",[v.id])).rows[0].t);
    const sold=Number((await pool.query("SELECT COALESCE(SUM(total_weight),0) as t FROM sales WHERE variety_id=$1",[v.id])).rows[0].t);
    const procLoss=Number((await pool.query("SELECT COALESCE(SUM(fresh_weight-final_weight),0) as t FROM processing WHERE variety_id=$1 AND status='done'",[v.id])).rows[0].t);
    result.push({...v,bought,sold,procLoss,stock:bought-sold-Math.max(0,procLoss)});
  }
  // Untagged
  const ubought=Number((await pool.query("SELECT COALESCE(SUM(final_weight),0) as t FROM purchases WHERE variety_id='' OR variety_id IS NULL")).rows[0].t);
  const usold=Number((await pool.query("SELECT COALESCE(SUM(total_weight),0) as t FROM sales WHERE variety_id='' OR variety_id IS NULL")).rows[0].t);
  if(ubought>0||usold>0) result.push({id:"other",name:"Other",name_ta:"மற்றவை",bought:ubought,sold:usold,procLoss:0,stock:ubought-usold});
  res.json(result);
});

app.get("/api/reports/farmers", async (req,res) => {
  const {year}=req.query; const f=year?" WHERE date LIKE '"+year+"%'":"";
  const pf=(await pool.query(`SELECT farmer,COUNT(*) as count,SUM(final_weight) as kg,SUM(total_amount) as amount FROM purchases${f} GROUP BY farmer ORDER BY amount DESC`)).rows;
  const sf=(await pool.query(`SELECT farmer,COUNT(*) as count,SUM(total_weight) as kg,SUM(total_amount) as amount FROM sales${f} GROUP BY farmer ORDER BY amount DESC`)).rows;
  res.json({purchaseFarmers:pf,saleFarmers:sf});
});

// ═══ OCR ═══
app.post("/api/ocr/weight", async (req,res) => {
  try{
    const {imageBase64}=req.body;
    if(!imageBase64) return res.json({weight:null});
    const Tesseract=require("tesseract.js");
    const {data}=await Tesseract.recognize(Buffer.from(imageBase64,"base64"),"eng",{tessedit_char_whitelist:"0123456789."});
    const text=data.text.trim();
    const numbers=text.match(/\d+\.?\d*/g);
    if(numbers&&numbers.length>0){
      const weights=numbers.map(Number).filter(n=>n>=0&&n<=15000).filter(n=>String(n).length<6||String(n).includes('.'));
      weights.sort((a,b)=>{const ad=String(a).includes('.')?1:0;const bd=String(b).includes('.')?1:0;if(ad!==bd)return bd-ad;return b-a;});
      if(weights.length>0) return res.json({weight:weights[0],rawText:text,allNumbers:weights});
    }
    res.json({weight:null,rawText:text});
  }catch(e){res.json({weight:null,error:e.message});}
});

app.get("/", (req,res) => res.json({status:"ok",app:"பண்ணை மேலாண்மை v2",db:"PostgreSQL"}));

const PORT=process.env.PORT||3000;
initDB().then(()=>{
  app.listen(PORT,()=>console.log(`🌾 Farm API v2 on port ${PORT}`));
}).catch(err=>{
  console.error("DB error:",err);
  app.listen(PORT,()=>console.log(`🌾 API running (DB error)`));
});
