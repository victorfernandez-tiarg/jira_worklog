const express = require('express');
const router  = express.Router();
const fs      = require('fs');
const path    = require('path');
const { requireAuth } = require('./auth');

const PF_FILE  = path.join(__dirname, '../data/person_functions.json');
const VALID_FN = new Set(['DEV','QA','PM','UX','INFRA','VARIOS','STAFFING','DIR','CORP']);

// Lazy-require worklogs to invalidate its in-memory cache when we save
function _reloadWorklogs() {
  try { require('./worklogs').reloadPersonFunctions(); } catch { /* ignorar */ }
}

// ─── GET /api/person-functions ────────────────────────────────────────────
router.get('/', requireAuth, (req, res) => {
  try {
    if (!fs.existsSync(PF_FILE)) return res.json({});
    res.json(JSON.parse(fs.readFileSync(PF_FILE, 'utf-8')));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── PUT /api/person-functions/:name — crear/actualizar una persona ───────
router.put('/:name', requireAuth, express.json(), (req, res) => {
  const name = decodeURIComponent(req.params.name).trim();
  const { funcion } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Nombre requerido' });
  if (!VALID_FN.has(funcion))
    return res.status(400).json({ error: `Función inválida. Válidas: ${[...VALID_FN].join(', ')}` });

  try {
    let data = {};
    if (fs.existsSync(PF_FILE)) data = JSON.parse(fs.readFileSync(PF_FILE, 'utf-8'));
    data[name] = funcion;
    fs.writeFileSync(PF_FILE, JSON.stringify(data, null, 2), 'utf-8');
    _reloadWorklogs();
    res.json({ ok: true, name, funcion });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── DELETE /api/person-functions/:name ──────────────────────────────────
router.delete('/:name', requireAuth, (req, res) => {
  const name = decodeURIComponent(req.params.name).trim();
  try {
    let data = {};
    if (fs.existsSync(PF_FILE)) data = JSON.parse(fs.readFileSync(PF_FILE, 'utf-8'));
    delete data[name];
    fs.writeFileSync(PF_FILE, JSON.stringify(data, null, 2), 'utf-8');
    _reloadWorklogs();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
