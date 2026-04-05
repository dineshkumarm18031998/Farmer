-- ═══════════════════════════════════════════════════════════════
-- 🟡 மஞ்சள் தம்பி — PostgreSQL Schema v3
-- Run: psql $DATABASE_URL -f schema.sql
-- Safe to run multiple times (idempotent)
-- ═══════════════════════════════════════════════════════════════

-- ── 1. CREATE ALL TABLES ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS employees (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    gender      TEXT NOT NULL DEFAULT 'female',
    phone       TEXT DEFAULT '',
    daily_wage  REAL DEFAULT 0,
    emp_type    TEXT DEFAULT 'worker',
    active      BOOLEAN DEFAULT true,
    created_at  DATE DEFAULT CURRENT_DATE
);

CREATE TABLE IF NOT EXISTS attendance (
    id            SERIAL PRIMARY KEY,
    emp_id        TEXT NOT NULL REFERENCES employees(id),
    date          TEXT NOT NULL,
    status        TEXT NOT NULL,
    daily_wage    REAL DEFAULT 0,
    ot_wage       REAL DEFAULT 0,
    daily_salary  REAL DEFAULT 0,
    paid_amount   REAL DEFAULT 0,
    UNIQUE(emp_id, date)
);

CREATE TABLE IF NOT EXISTS payments (
    id            TEXT PRIMARY KEY,
    emp_id        TEXT NOT NULL,
    paid_date     TEXT NOT NULL DEFAULT '',
    amount        REAL NOT NULL,
    period_from   TEXT DEFAULT '',
    period_to     TEXT DEFAULT '',
    period_label  TEXT DEFAULT '',
    note          TEXT DEFAULT '',
    type          TEXT DEFAULT 'payment'
);

CREATE TABLE IF NOT EXISTS varieties (
    id       TEXT PRIMARY KEY,
    name     TEXT NOT NULL,
    name_ta  TEXT DEFAULT '',
    active   BOOLEAN DEFAULT true
);

CREATE TABLE IF NOT EXISTS purchases (
    id                TEXT PRIMARY KEY,
    date              TEXT NOT NULL,
    farmer            TEXT NOT NULL,
    phone             TEXT DEFAULT '',
    vehicle           TEXT DEFAULT '',
    variety_id        TEXT DEFAULT '',
    loads_json        TEXT DEFAULT '[]',
    total_net_weight  REAL DEFAULT 0,
    deduction_per_ton REAL DEFAULT 50,
    deduction         REAL DEFAULT 0,
    final_weight      REAL DEFAULT 0,
    price_per_kg      REAL DEFAULT 0,
    total_amount      REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sales (
    id            TEXT PRIMARY KEY,
    date          TEXT NOT NULL,
    farmer        TEXT NOT NULL,
    phone         TEXT DEFAULT '',
    variety_id    TEXT DEFAULT '',
    bags_json     TEXT DEFAULT '[]',
    total_weight  REAL DEFAULT 0,
    price_per_kg  REAL DEFAULT 0,
    total_amount  REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS processing (
    id            TEXT PRIMARY KEY,
    date          TEXT NOT NULL,
    farmer        TEXT DEFAULT '',
    variety_id    TEXT DEFAULT '',
    fresh_weight  REAL NOT NULL,
    after_boiling REAL DEFAULT 0,
    after_drying  REAL DEFAULT 0,
    final_weight  REAL DEFAULT 0,
    yield_percent REAL DEFAULT 0,
    status        TEXT DEFAULT 'fresh',
    notes         TEXT DEFAULT '',
    raw_used      REAL DEFAULT 0,
    quintal       REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS market_sales (
    id                TEXT PRIMARY KEY,
    date              TEXT NOT NULL,
    processed_qty     REAL DEFAULT 0,
    quintal           REAL DEFAULT 0,
    rate_per_quintal  REAL DEFAULT 0,
    revenue           REAL DEFAULT 0,
    variety_id        TEXT DEFAULT '',
    notes             TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- ── 2. ADD MISSING COLUMNS TO EXISTING TABLES (migration safe) ──
-- employees
ALTER TABLE employees ADD COLUMN IF NOT EXISTS phone       TEXT DEFAULT '';
ALTER TABLE employees ADD COLUMN IF NOT EXISTS daily_wage  REAL DEFAULT 0;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS emp_type    TEXT DEFAULT 'worker';
ALTER TABLE employees ADD COLUMN IF NOT EXISTS active      BOOLEAN DEFAULT true;

-- attendance — ADD COLUMNS FIRST before any UPDATE queries
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS daily_wage   REAL DEFAULT 0;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS ot_wage      REAL DEFAULT 0;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS daily_salary REAL DEFAULT 0;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS paid_amount  REAL DEFAULT 0;

-- payments — ADD COLUMNS FIRST before any UPDATE queries
ALTER TABLE payments ADD COLUMN IF NOT EXISTS paid_date    TEXT DEFAULT '';
ALTER TABLE payments ADD COLUMN IF NOT EXISTS period_from  TEXT DEFAULT '';
ALTER TABLE payments ADD COLUMN IF NOT EXISTS period_to    TEXT DEFAULT '';
ALTER TABLE payments ADD COLUMN IF NOT EXISTS period_label TEXT DEFAULT '';
ALTER TABLE payments ADD COLUMN IF NOT EXISTS type         TEXT DEFAULT 'payment';

-- purchases / sales
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS variety_id TEXT DEFAULT '';
ALTER TABLE sales     ADD COLUMN IF NOT EXISTS variety_id TEXT DEFAULT '';

-- ── 3. DATA MIGRATIONS (run AFTER columns exist) ──────────────

-- Fill payments.paid_date from old 'date' column
UPDATE payments SET paid_date   = date      WHERE paid_date = '' AND date IS NOT NULL;
UPDATE payments SET period_from = paid_date WHERE period_from = '';
UPDATE payments SET period_to   = paid_date WHERE period_to = '';

-- Fill attendance wages from employee record
UPDATE attendance a SET
    daily_wage = COALESCE(NULLIF(a.daily_wage, 0), e.daily_wage),
    ot_wage = CASE
        WHEN e.gender = 'female' THEN COALESCE((SELECT value::REAL FROM settings WHERE key='femaleOT'), 100)
        ELSE COALESCE((SELECT value::REAL FROM settings WHERE key='maleOT'), 50)
    END
FROM employees e
WHERE a.emp_id = e.id AND a.daily_wage = 0;

-- Compute and store daily_salary for existing records
UPDATE attendance SET daily_salary =
    CASE
        WHEN status = 'present'  THEN daily_wage
        WHEN status = 'halfday'  THEN ROUND(daily_wage * 0.5 * 100) / 100
        WHEN status = 'overtime' THEN daily_wage + ot_wage
        ELSE 0
    END
WHERE daily_salary = 0 AND daily_wage > 0;

-- Migrate old advances table → payments with type='advance'
DO $$
BEGIN
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'advances') THEN
        INSERT INTO payments (id, emp_id, paid_date, amount, period_from, period_to, period_label, note, type)
        SELECT id, emp_id, date, amount, date, date, 'முன்பணம்', COALESCE(note,''), 'advance'
        FROM advances
        ON CONFLICT (id) DO NOTHING;
    END IF;
END $$;

-- ── 4. INDEXES ────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_att_emp_date ON attendance(emp_id, date);
CREATE INDEX IF NOT EXISTS idx_att_date     ON attendance(date);
CREATE INDEX IF NOT EXISTS idx_pay_emp      ON payments(emp_id);
CREATE INDEX IF NOT EXISTS idx_pay_date     ON payments(paid_date);

-- ── 5. DEFAULT SETTINGS ───────────────────────────────────────
INSERT INTO settings(key,value) VALUES ('femaleDay','350') ON CONFLICT(key) DO NOTHING;
INSERT INTO settings(key,value) VALUES ('femaleOT','100')  ON CONFLICT(key) DO NOTHING;
INSERT INTO settings(key,value) VALUES ('maleDay','800')   ON CONFLICT(key) DO NOTHING;
INSERT INTO settings(key,value) VALUES ('maleOT','50')     ON CONFLICT(key) DO NOTHING;

-- ── 6. DEFAULT VARIETIES ──────────────────────────────────────
INSERT INTO varieties(id,name,name_ta) VALUES ('virali','விராலி','விராலி')             ON CONFLICT(id) DO NOTHING;
INSERT INTO varieties(id,name,name_ta) VALUES ('gundumanjal','குண்டுமஞ்சள்','குண்டுமஞ்சள்') ON CONFLICT(id) DO NOTHING;
INSERT INTO varieties(id,name,name_ta) VALUES ('erode','ஈரோடு','ஈரோடு')              ON CONFLICT(id) DO NOTHING;
INSERT INTO varieties(id,name,name_ta) VALUES ('salem','சேலம்','சேலம்')              ON CONFLICT(id) DO NOTHING;
INSERT INTO varieties(id,name,name_ta) VALUES ('local','உள்ளூர்','உள்ளூர்')           ON CONFLICT(id) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════
-- SCHEMA SUMMARY
-- ═══════════════════════════════════════════════════════════════
-- attendance.daily_salary — stored at mark time, never recalc if paid
-- attendance.paid_amount  — 0=unpaid, partial ok, =daily_salary → LOCKED
-- payments                — history log only (not used for salary calc)
-- advances table          — MERGED into payments with type='advance'
-- STATUS allowed          — present | halfday | overtime | leave (NO absent)
-- LOCK rule               — paid_amount >= daily_salary = cell locked in UI
-- ═══════════════════════════════════════════════════════════════
