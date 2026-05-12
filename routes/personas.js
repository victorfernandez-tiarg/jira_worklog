const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();

const PERSONAS_FILE = path.join(__dirname, '../data/personas.json');

// Cargar en memoria al iniciar
let personas = {};
try {
  if (fs.existsSync(PERSONAS_FILE)) {
    personas = JSON.parse(fs.readFileSync(PERSONAS_FILE, 'utf-8'));
  }
} catch (e) {
  console.error('Error cargando personas:', e.message);
}

function save() {
  fs.writeFileSync(PERSONAS_FILE, JSON.stringify(personas, null, 2), 'utf-8');
}

function getPersonas() { return personas; }

// ─── GET /api/personas ─────────────────────────────────────────────────────
router.get('/', (req, res) => {
  res.json(Object.entries(personas).map(([email, v]) => ({ email, ...v })));
});

// ─── PUT /api/personas — crear o actualizar por email ─────────────────────
router.put('/', express.json(), (req, res) => {
  const { email, ...fields } = req.body || {};
  const key = (email || '').toString().trim().toLowerCase();
  if (!key) return res.status(400).json({ error: 'El email es requerido' });

  personas[key] = {
    centroCosto:    (fields.centroCosto    || '').toString().trim(),
    funcion:        (fields.funcion        || '').toString().trim(),
    nombreNomina:   (fields.nombreNomina   || '').toString().trim(),
    prodImproductivo: (fields.prodImproductivo || '').toString().trim()
  };
  save();
  res.json({ ok: true, email: key, entry: personas[key] });
});

module.exports = router;
module.exports.getPersonas = getPersonas;
