-- ═══════════════════════════════════════════════
-- 🌾 பண்ணை மேலாண்மை — PostgreSQL Schema
-- ═══════════════════════════════════════════════
-- Tables auto-created by server.js on first start
-- This file is for reference only
-- ═══════════════════════════════════════════════

-- 👥 தொழிலாளர்கள் (Workers)
CREATE TABLE IF NOT EXISTS employees (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    gender TEXT NOT NULL DEFAULT 'female',
    created_at DATE DEFAULT CURRENT_DATE
);

-- 📋 வருகை பதிவு (Attendance)
CREATE TABLE IF NOT EXISTS attendance (
    id SERIAL PRIMARY KEY,
    emp_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    status TEXT NOT NULL,
    UNIQUE(emp_id, date)
);

-- 💸 முன்பணம் (Advances)
CREATE TABLE IF NOT EXISTS advances (
    id TEXT PRIMARY KEY,
    emp_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    amount REAL NOT NULL,
    note TEXT DEFAULT ''
);

-- 💰 சம்பளம் கொடுத்தது (Salary Payments)
CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    emp_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    amount REAL NOT NULL,
    period TEXT NOT NULL
);

-- 🛒 கொள்முதல் (Purchases)
CREATE TABLE IF NOT EXISTS purchases (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    farmer TEXT NOT NULL,
    phone TEXT DEFAULT '',
    vehicle TEXT DEFAULT '',
    loads_json TEXT DEFAULT '[]',
    total_net_weight REAL DEFAULT 0,
    deduction_per_ton REAL DEFAULT 50,
    deduction REAL DEFAULT 0,
    final_weight REAL DEFAULT 0,
    price_per_kg REAL DEFAULT 0,
    total_amount REAL DEFAULT 0
);

-- 💵 விற்பனை (Sales)
CREATE TABLE IF NOT EXISTS sales (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    farmer TEXT NOT NULL,
    phone TEXT DEFAULT '',
    bags_json TEXT DEFAULT '[]',
    total_weight REAL DEFAULT 0,
    price_per_kg REAL DEFAULT 0,
    total_amount REAL DEFAULT 0
);

-- ⚙️ அமைப்புகள் (Settings)
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
