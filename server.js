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

app.use(express.json({ limit: '1mb' })); // fotos agora são URLs Cloudinary
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'checklist-secret-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 12 * 60 * 60 * 1000 }
}));

// ── INIT DB ──────────────────────────────────────────────────────────────────
async function initDB() {
  // Cria tabelas novas
  await pool.query(`
    CREATE TABLE IF NOT EXISTS technicians (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      cpf TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL DEFAULT 'Técnico',
      level TEXT NOT NULL DEFAULT 'Júnior',
      matricula TEXT,
      rg TEXT,
      setor TEXT,
      unidade TEXT,
      nascimento DATE,
      admissao DATE,
      demissao DATE,
      sexo TEXT,
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS machines (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      active BOOLEAN DEFAULT TRUE
    );

    CREATE TABLE IF NOT EXISTS checklist_templates (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      frequency TEXT NOT NULL DEFAULT 'weekly',
      active BOOLEAN DEFAULT TRUE
    );

    CREATE TABLE IF NOT EXISTS checklist_items (
      id SERIAL PRIMARY KEY,
      template_id INT REFERENCES checklist_templates(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      order_index INT DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS checklist_runs (
      id SERIAL PRIMARY KEY,
      template_id INT REFERENCES checklist_templates(id),
      machine_id INT REFERENCES machines(id),
      technician_id INT REFERENCES technicians(id),
      frequency TEXT NOT NULL DEFAULT 'weekly',
      period_key TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS checklist_responses (
      id SERIAL PRIMARY KEY,
      run_id INT REFERENCES checklist_runs(id) ON DELETE CASCADE,
      item_id INT REFERENCES checklist_items(id),
      status TEXT CHECK (status IN ('ok', 'nao')) NOT NULL,
      photo TEXT
    );
  `);

  // Migrações seguras para bancos existentes
  const migrations = [
    `ALTER TABLE checklist_responses ADD COLUMN IF NOT EXISTS photo TEXT`,
    `ALTER TABLE machines ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT TRUE`,
    `ALTER TABLE checklist_items ADD COLUMN IF NOT EXISTS template_id INT`,
    `ALTER TABLE checklist_runs ADD COLUMN IF NOT EXISTS template_id INT`,
    `ALTER TABLE checklist_runs ADD COLUMN IF NOT EXISTS technician_id INT`,
    `ALTER TABLE checklist_runs ADD COLUMN IF NOT EXISTS frequency TEXT DEFAULT 'weekly'`,
    `ALTER TABLE checklist_runs ADD COLUMN IF NOT EXISTS period_key TEXT`,
    // Novos campos do técnico
    `ALTER TABLE technicians ADD COLUMN IF NOT EXISTS matricula TEXT`,
    `ALTER TABLE technicians ADD COLUMN IF NOT EXISTS rg TEXT`,
    `ALTER TABLE technicians ADD COLUMN IF NOT EXISTS setor TEXT`,
    `ALTER TABLE technicians ADD COLUMN IF NOT EXISTS unidade TEXT`,
    `ALTER TABLE technicians ADD COLUMN IF NOT EXISTS nascimento DATE`,
    `ALTER TABLE technicians ADD COLUMN IF NOT EXISTS admissao DATE`,
    `ALTER TABLE technicians ADD COLUMN IF NOT EXISTS demissao DATE`,
    `ALTER TABLE technicians ADD COLUMN IF NOT EXISTS sexo TEXT`,
  ];
  for (const sql of migrations) {
    await pool.query(sql).catch(() => {});
  }

  // Migra period_key de runs antigas que não tinham esse campo
  await pool.query(`
    UPDATE checklist_runs SET
      period_key = year::text || '-W' || LPAD(week_number::text, 2, '0'),
      frequency = 'weekly'
    WHERE period_key IS NULL AND week_number IS NOT NULL
  `).catch(() => {});

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

  // Seed template padrão
  const tmpl = await pool.query(
    `INSERT INTO checklist_templates (name, frequency)
     SELECT 'Checklist Padrão', 'weekly'
     WHERE NOT EXISTS (SELECT 1 FROM checklist_templates LIMIT 1)
     RETURNING id`
  );

  if (tmpl.rows.length > 0) {
    const tid = tmpl.rows[0].id;
    const items = ['Clivador','Estilete','Identificador de Fibra','Alicate CF3','Álcool Isopropílico','Tubete','Tesoura'];
    for (let i = 0; i < items.length; i++) {
      await pool.query(
        `INSERT INTO checklist_items (template_id, name, order_index) VALUES ($1,$2,$3)`,
        [tid, items[i], i]
      );
    }
  }

  // Se há um template mas itens sem template_id (migração de banco antigo), associá-los
  const firstTemplate = await pool.query(`SELECT id FROM checklist_templates ORDER BY id LIMIT 1`);
  if (firstTemplate.rows.length > 0) {
    const tid = firstTemplate.rows[0].id;
    await pool.query(`UPDATE checklist_items SET template_id=$1 WHERE template_id IS NULL`, [tid]).catch(()=>{});
  }

  console.log('✅ DB inicializado');
}

// ── HELPERS ──────────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session.techId || req.session.isAdmin) return next();
  res.status(401).json({ error: 'Não autenticado' });
}
function requireAdmin(req, res, next) {
  if (req.session.isAdmin) return next();
  res.status(403).json({ error: 'Acesso negado' });
}
function cleanCPF(cpf) { return (cpf || '').replace(/\D/g, ''); }
function getPeriodKey(frequency, date = new Date()) {
  if (frequency === 'daily') return date.toISOString().slice(0, 10);
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2,'0')}`;
}

// ── AUTH ──────────────────────────────────────────────────────────────────────
app.post('/api/auth/cpf', async (req, res) => {
  try {
    const cpf = cleanCPF(req.body.cpf);
    if (!cpf || cpf.length !== 11) return res.status(400).json({ error: 'CPF inválido' });
    const { rows } = await pool.query(`SELECT * FROM technicians WHERE cpf=$1 AND active=TRUE`, [cpf]);
    if (!rows.length) return res.status(404).json({ error: 'CPF não encontrado ou técnico inativo' });
    const tech = rows[0];
    req.session.techId = tech.id;
    req.session.techName = tech.name;
    res.json({ ok: true, technician: { id: tech.id, name: tech.name, role: tech.role, level: tech.level } });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erro interno' }); }
});

app.post('/api/auth/admin', (req, res) => {
  const { password } = req.body;
  if (password === (process.env.ADMIN_PASSWORD || 'connectfeliz')) {
    req.session.isAdmin = true;
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: 'Senha incorreta' });
  }
});

app.post('/api/auth/logout', (req, res) => { req.session.destroy(); res.json({ ok: true }); });

app.get('/api/auth/me', (req, res) => {
  if (req.session.isAdmin) return res.json({ isAdmin: true });
  if (req.session.techId) return res.json({ isAdmin: false, techId: req.session.techId, techName: req.session.techName });
  res.json({ isAdmin: false, techId: null });
});

// ── MACHINES ──────────────────────────────────────────────────────────────────
app.get('/api/machines', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM machines WHERE active=TRUE ORDER BY id`);
    res.json(rows);
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erro ao buscar máquinas' }); }
});
app.post('/api/machines', requireAdmin, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Nome obrigatório' });
    const { rows } = await pool.query(`INSERT INTO machines (name) VALUES ($1) RETURNING *`, [name.trim()]);
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: 'Erro ao salvar' }); }
});
app.put('/api/machines/:id', requireAdmin, async (req, res) => {
  try {
    const { name, active } = req.body;
    const { rows } = await pool.query(`UPDATE machines SET name=$1, active=$2 WHERE id=$3 RETURNING *`, [name, active !== false, req.params.id]);
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: 'Erro ao salvar' }); }
});
app.delete('/api/machines/:id', requireAdmin, async (req, res) => {
  await pool.query(`UPDATE machines SET active=FALSE WHERE id=$1`, [req.params.id]);
  res.json({ ok: true });
});

// ── TECHNICIANS ───────────────────────────────────────────────────────────────
app.get('/api/technicians', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM technicians ORDER BY name`);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: 'Erro' }); }
});
app.post('/api/technicians', requireAdmin, async (req, res) => {
  try {
    const { name, cpf, role, level, matricula, rg, setor, unidade, nascimento, admissao, demissao, sexo } = req.body;
    const clean = cleanCPF(cpf);
    if (!name || !clean || clean.length !== 11) return res.status(400).json({ error: 'Dados inválidos' });
    const { rows } = await pool.query(
      `INSERT INTO technicians (name, cpf, role, level, matricula, rg, setor, unidade, nascimento, admissao, demissao, sexo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [name.trim(), clean, role||'Técnico', level||'Júnior',
       matricula||null, rg||null, setor||null, unidade||null,
       nascimento||null, admissao||null, demissao||null, sexo||null]
    );
    res.json(rows[0]);
  } catch(e) {
    if (e.code === '23505') return res.status(409).json({ error: 'CPF já cadastrado' });
    res.status(500).json({ error: 'Erro ao salvar' });
  }
});
app.put('/api/technicians/:id', requireAdmin, async (req, res) => {
  try {
    const { name, cpf, role, level, active, matricula, rg, setor, unidade, nascimento, admissao, demissao, sexo } = req.body;
    const { rows } = await pool.query(
      `UPDATE technicians SET name=$1, cpf=$2, role=$3, level=$4, active=$5,
       matricula=$6, rg=$7, setor=$8, unidade=$9, nascimento=$10, admissao=$11, demissao=$12, sexo=$13
       WHERE id=$14 RETURNING *`,
      [name, cleanCPF(cpf), role, level, active !== false,
       matricula||null, rg||null, setor||null, unidade||null,
       nascimento||null, admissao||null, demissao||null, sexo||null,
       req.params.id]
    );
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: 'Erro ao salvar' }); }
});
app.delete('/api/technicians/:id', requireAdmin, async (req, res) => {
  await pool.query(`UPDATE technicians SET active=FALSE WHERE id=$1`, [req.params.id]);
  res.json({ ok: true });
});

// ── APAGAR DADOS DE TESTE ─────────────────────────────────────────────────────
app.delete('/api/admin/test-data', requireAdmin, async (req, res) => {
  try {
    await pool.query(`DELETE FROM checklist_runs`); // CASCADE apaga responses
    res.json({ ok: true, message: 'Todos os checklists foram apagados.' });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erro ao apagar dados' }); }
});

// ── TEMPLATES & ITENS ─────────────────────────────────────────────────────────
app.get('/api/templates', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM checklist_templates WHERE active=TRUE ORDER BY id`);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: 'Erro' }); }
});
app.post('/api/templates', requireAdmin, async (req, res) => {
  try {
    const { name, frequency } = req.body;
    if (!name || !['daily','weekly'].includes(frequency)) return res.status(400).json({ error: 'Dados inválidos' });
    const { rows } = await pool.query(`INSERT INTO checklist_templates (name, frequency) VALUES ($1,$2) RETURNING *`, [name.trim(), frequency]);
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: 'Erro' }); }
});
app.put('/api/templates/:id', requireAdmin, async (req, res) => {
  try {
    const { name, frequency, active } = req.body;
    const { rows } = await pool.query(`UPDATE checklist_templates SET name=$1, frequency=$2, active=$3 WHERE id=$4 RETURNING *`, [name, frequency, active !== false, req.params.id]);
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: 'Erro' }); }
});
app.get('/api/templates/:id/items', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM checklist_items WHERE template_id=$1 ORDER BY order_index`, [req.params.id]);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: 'Erro' }); }
});
app.post('/api/templates/:id/items', requireAdmin, async (req, res) => {
  try {
    const { name, order_index } = req.body;
    if (!name) return res.status(400).json({ error: 'Nome obrigatório' });
    const { rows } = await pool.query(`INSERT INTO checklist_items (template_id, name, order_index) VALUES ($1,$2,$3) RETURNING *`, [req.params.id, name.trim(), order_index || 0]);
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: 'Erro' }); }
});
app.put('/api/items/:id', requireAdmin, async (req, res) => {
  try {
    const { name, order_index } = req.body;
    const { rows } = await pool.query(`UPDATE checklist_items SET name=$1, order_index=$2 WHERE id=$3 RETURNING *`, [name, order_index || 0, req.params.id]);
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: 'Erro' }); }
});
app.delete('/api/items/:id', requireAdmin, async (req, res) => {
  await pool.query(`DELETE FROM checklist_items WHERE id=$1`, [req.params.id]);
  res.json({ ok: true });
});

// ── CHECKLIST STATUS ──────────────────────────────────────────────────────────
app.get('/api/checklist/status', requireAuth, async (req, res) => {
  try {
    const { template_id, machine_id } = req.query;
    const techId = req.session.isAdmin ? req.query.tech_id : req.session.techId;
    if (!techId) return res.json(null);

    const tmpl = await pool.query(`SELECT * FROM checklist_templates WHERE id=$1`, [template_id]);
    if (!tmpl.rows.length) return res.json(null);

    const periodKey = getPeriodKey(tmpl.rows[0].frequency);
    const { rows } = await pool.query(`
      SELECT cr.id, cr.created_at, t.name as technician_name,
             json_agg(json_build_object(
               'item_id', rp.item_id, 'status', rp.status,
               'item_name', ci.name, 'photo', rp.photo
             ) ORDER BY ci.order_index) as responses
      FROM checklist_runs cr
      JOIN technicians t ON t.id = cr.technician_id
      JOIN checklist_responses rp ON rp.run_id = cr.id
      JOIN checklist_items ci ON ci.id = rp.item_id
      WHERE cr.template_id=$1 AND cr.machine_id=$2 AND cr.technician_id=$3 AND cr.period_key=$4
      GROUP BY cr.id, t.name
    `, [template_id, machine_id, techId, periodKey]);

    res.json(rows[0] || null);
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erro' }); }
});

// ── SUBMIT ────────────────────────────────────────────────────────────────────
app.post('/api/checklist/submit', requireAuth, async (req, res) => {
  try {
    const { template_id, machine_id, responses } = req.body;
    const techId = req.session.techId;
    if (!techId) return res.status(403).json({ error: 'Apenas técnicos podem registrar checklists. Faça login com seu CPF.' });
    if (!template_id || !machine_id || !responses?.length) return res.status(400).json({ error: 'Dados incompletos' });

    const tmpl = await pool.query(`SELECT * FROM checklist_templates WHERE id=$1`, [template_id]);
    if (!tmpl.rows.length) return res.status(400).json({ error: 'Template inválido' });

    const { frequency } = tmpl.rows[0];
    const periodKey = getPeriodKey(frequency);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `DELETE FROM checklist_runs WHERE template_id=$1 AND machine_id=$2 AND technician_id=$3 AND period_key=$4`,
        [template_id, machine_id, techId, periodKey]
      );
      const runRes = await client.query(
        `INSERT INTO checklist_runs (template_id, machine_id, technician_id, frequency, period_key) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [template_id, machine_id, techId, frequency, periodKey]
      );
      const run_id = runRes.rows[0].id;
      for (const r of responses) {
        await client.query(
          `INSERT INTO checklist_responses (run_id, item_id, status, photo) VALUES ($1,$2,$3,$4)`,
          [run_id, r.item_id, r.status, r.photo || null]
        );
      }
      await client.query('COMMIT');
      res.json({ ok: true, run_id });
    } catch(e) {
      await client.query('ROLLBACK');
      throw e;
    } finally { client.release(); }
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erro ao salvar' }); }
});

// ── HISTÓRICO ─────────────────────────────────────────────────────────────────
app.get('/api/history', requireAuth, async (req, res) => {
  try {
    const { machine_id, limit = 100 } = req.query;
    const techFilter = req.session.isAdmin ? req.query.tech_id : req.session.techId;
    let q = `
      SELECT cr.id, cr.period_key, cr.frequency, cr.created_at,
             m.name as machine_name, t.name as technician_name, t.role, t.level,
             COUNT(rp.id) FILTER (WHERE rp.status='ok') as ok_count,
             COUNT(rp.id) FILTER (WHERE rp.status='nao') as nao_count
      FROM checklist_runs cr
      JOIN machines m ON m.id = cr.machine_id
      JOIN technicians t ON t.id = cr.technician_id
      JOIN checklist_responses rp ON rp.run_id = cr.id
      WHERE 1=1`;
    const params = [];
    if (techFilter) { params.push(techFilter); q += ` AND cr.technician_id=$${params.length}`; }
    if (machine_id) { params.push(machine_id); q += ` AND cr.machine_id=$${params.length}`; }
    q += ` GROUP BY cr.id, m.name, t.name, t.role, t.level ORDER BY cr.created_at DESC LIMIT ${parseInt(limit)}`;
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erro' }); }
});

app.get('/api/history/:run_id', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT rp.status, rp.photo, ci.name as item_name, ci.order_index
      FROM checklist_responses rp
      JOIN checklist_items ci ON ci.id = rp.item_id
      WHERE rp.run_id=$1
      ORDER BY ci.order_index
    `, [req.params.run_id]);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: 'Erro' }); }
});

// ── RELATÓRIO MENSAL ──────────────────────────────────────────────────────────
app.get('/api/report', requireAdmin, async (req, res) => {
  try {
    const { tech_id, month, year } = req.query;
    if (!tech_id || !month || !year) return res.status(400).json({ error: 'Parâmetros obrigatórios' });
    const techRes = await pool.query(`SELECT * FROM technicians WHERE id=$1`, [tech_id]);
    if (!techRes.rows.length) return res.status(404).json({ error: 'Técnico não encontrado' });

    const startDate = new Date(parseInt(year), parseInt(month) - 1, 1);
    const endDate = new Date(parseInt(year), parseInt(month), 1);
    const { rows } = await pool.query(`
      SELECT cr.id, cr.period_key, cr.frequency, cr.created_at,
             m.name as machine_name,
             json_agg(json_build_object(
               'item_name', ci.name, 'status', rp.status, 'photo', rp.photo
             ) ORDER BY ci.order_index) as responses,
             COUNT(rp.id) FILTER (WHERE rp.status='ok') as ok_count,
             COUNT(rp.id) FILTER (WHERE rp.status='nao') as nao_count
      FROM checklist_runs cr
      JOIN machines m ON m.id = cr.machine_id
      JOIN checklist_responses rp ON rp.run_id = cr.id
      JOIN checklist_items ci ON ci.id = rp.item_id
      WHERE cr.technician_id=$1 AND cr.created_at >= $2 AND cr.created_at < $3
      GROUP BY cr.id, m.name
      ORDER BY cr.created_at ASC
    `, [tech_id, startDate, endDate]);

    res.json({ technician: techRes.rows[0], records: rows, month: parseInt(month), year: parseInt(year) });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erro' }); }
});

// ── DIVERGÊNCIAS ──────────────────────────────────────────────────────────────
app.get('/api/divergencias', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT m.name as machine_name, ci.name as item_name,
             t.name as technician_name, t.role,
             cr.period_key, cr.created_at
      FROM checklist_responses rp
      JOIN checklist_runs cr ON cr.id = rp.run_id
      JOIN machines m ON m.id = cr.machine_id
      JOIN checklist_items ci ON ci.id = rp.item_id
      JOIN technicians t ON t.id = cr.technician_id
      WHERE rp.status = 'nao' AND cr.created_at >= NOW() - INTERVAL '30 days'
      ORDER BY cr.created_at DESC
    `);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: 'Erro' }); }
});

// Fallback SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

initDB().then(() => {
  app.listen(PORT, () => console.log(`🚀 Checklist rodando na porta ${PORT}`));
}).catch(err => {
  console.error('❌ Erro ao inicializar DB:', err);
  process.exit(1);
});
