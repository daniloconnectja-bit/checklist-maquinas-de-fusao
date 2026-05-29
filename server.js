const express = require('express');
const { Pool } = require('pg');
const session = require('express-session');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'checklist-secret-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 } // 8 horas
}));

// ── INIT DB ─────────────────────────────────────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS machines (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS checklist_items (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      order_index INT DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS checklist_runs (
      id SERIAL PRIMARY KEY,
      machine_id INT REFERENCES machines(id),
      technician_name TEXT NOT NULL,
      week_number INT NOT NULL,
      year INT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS checklist_responses (
      id SERIAL PRIMARY KEY,
      run_id INT REFERENCES checklist_runs(id) ON DELETE CASCADE,
      item_id INT REFERENCES checklist_items(id),
      status TEXT CHECK (status IN ('ok', 'divergencia')) NOT NULL
    );
  `);

  // Seed machines
  const machines = [
    'MAQUINA DE FUSAO SIGNAL FIRE - AI-10',
    'MAQUINA DE FUSAO SIGNAL FIRE - AI-9',
    'MAQUINA DE FUSAO OVERTEK - T-43',
    'MAQUINA DE FUSAO OVERTEK - T-45'
  ];
  for (const name of machines) {
    await pool.query(
      `INSERT INTO machines (name) SELECT $1 WHERE NOT EXISTS (SELECT 1 FROM machines WHERE name=$1)`,
      [name]
    );
  }

  // Seed checklist items
  const items = [
    'Clivador',
    'Estilete',
    'Identificador de Fibra',
    'Alicate CF3',
    'Álcool Isopropílico',
    'Tubete',
    'Tesoura'
  ];
  for (let i = 0; i < items.length; i++) {
    await pool.query(
      `INSERT INTO checklist_items (name, order_index) SELECT $1, $2 WHERE NOT EXISTS (SELECT 1 FROM checklist_items WHERE name=$1)`,
      [items[i], i]
    );
  }

  console.log('DB inicializado.');
}

// ── AUTH ─────────────────────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password === (process.env.ADMIN_PASSWORD || 'connectfeliz')) {
    req.session.isAdmin = true;
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: 'Senha incorreta' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  res.json({ isAdmin: !!req.session.isAdmin });
});

// ── MACHINES ─────────────────────────────────────────────────────────────────
app.get('/api/machines', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM machines ORDER BY id');
  res.json(rows);
});

// ── CHECKLIST ITEMS ──────────────────────────────────────────────────────────
app.get('/api/items', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM checklist_items ORDER BY order_index');
  res.json(rows);
});

// ── CHECK: já fez essa semana? ───────────────────────────────────────────────
app.get('/api/checklist/status', async (req, res) => {
  const { machine_id, week, year } = req.query;
  const { rows } = await pool.query(
    `SELECT cr.id, cr.technician_name, cr.created_at,
            json_agg(json_build_object('item_id', rp.item_id, 'status', rp.status, 'item_name', ci.name) ORDER BY ci.order_index) as responses
     FROM checklist_runs cr
     JOIN checklist_responses rp ON rp.run_id = cr.id
     JOIN checklist_items ci ON ci.id = rp.item_id
     WHERE cr.machine_id=$1 AND cr.week_number=$2 AND cr.year=$3
     GROUP BY cr.id`,
    [machine_id, week, year]
  );
  res.json(rows[0] || null);
});

// ── SUBMIT CHECKLIST ─────────────────────────────────────────────────────────
app.post('/api/checklist/submit', async (req, res) => {
  const { machine_id, technician_name, week_number, year, responses } = req.body;
  if (!machine_id || !technician_name || !week_number || !year || !responses?.length) {
    return res.status(400).json({ error: 'Dados incompletos' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Remove run anterior da mesma semana/máquina se existir
    await client.query(
      `DELETE FROM checklist_runs WHERE machine_id=$1 AND week_number=$2 AND year=$3`,
      [machine_id, week_number, year]
    );

    const runRes = await client.query(
      `INSERT INTO checklist_runs (machine_id, technician_name, week_number, year) VALUES ($1,$2,$3,$4) RETURNING id`,
      [machine_id, technician_name, week_number, year]
    );
    const run_id = runRes.rows[0].id;

    for (const r of responses) {
      await client.query(
        `INSERT INTO checklist_responses (run_id, item_id, status) VALUES ($1,$2,$3)`,
        [run_id, r.item_id, r.status]
      );
    }

    await client.query('COMMIT');
    res.json({ ok: true, run_id });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: 'Erro ao salvar checklist' });
  } finally {
    client.release();
  }
});

// ── HISTÓRICO (admin) ────────────────────────────────────────────────────────
app.get('/api/history', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT cr.id, cr.machine_id, cr.week_number, cr.year, cr.technician_name, cr.created_at,
           m.name as machine_name,
           COUNT(rp.id) FILTER (WHERE rp.status='ok') as ok_count,
           COUNT(rp.id) FILTER (WHERE rp.status='divergencia') as div_count
    FROM checklist_runs cr
    JOIN machines m ON m.id = cr.machine_id
    JOIN checklist_responses rp ON rp.run_id = cr.id
    GROUP BY cr.id, m.name
    ORDER BY cr.created_at DESC
    LIMIT 100
  `);
  res.json(rows);
});

app.get('/api/history/:run_id', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT rp.status, ci.name as item_name
    FROM checklist_responses rp
    JOIN checklist_items ci ON ci.id = rp.item_id
    WHERE rp.run_id=$1
    ORDER BY ci.order_index
  `, [req.params.run_id]);
  res.json(rows);
});

// ── DIVERGÊNCIAS ATIVAS (por máquina, última semana) ─────────────────────────
app.get('/api/divergencias', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT m.name as machine_name, ci.name as item_name, cr.technician_name,
           cr.week_number, cr.year, cr.created_at
    FROM checklist_responses rp
    JOIN checklist_runs cr ON cr.id = rp.run_id
    JOIN machines m ON m.id = cr.machine_id
    JOIN checklist_items ci ON ci.id = rp.item_id
    WHERE rp.status = 'divergencia'
      AND cr.created_at >= NOW() - INTERVAL '30 days'
    ORDER BY cr.created_at DESC
  `);
  res.json(rows);
});

// Fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

initDB().then(() => {
  app.listen(PORT, () => console.log(`Checklist rodando na porta ${PORT}`));
}).catch(err => {
  console.error('Erro ao inicializar DB:', err);
  process.exit(1);
});
