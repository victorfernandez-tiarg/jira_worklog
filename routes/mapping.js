const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');
const router = express.Router();
const reportCache = require('./reportCache');

// Ruta donde se guarda el mapping actual
const MAPPING_FILE = path.join(__dirname, '../data/mapping.json');
const MAPPING_SAMPLE = path.join(__dirname, '../data/mapping_sample.xlsx');

// Estado en memoria (se recarga desde disco al iniciar)
let currentMapping = {};

// Cargar mapping al iniciar
function loadMapping() {
  try {
    if (fs.existsSync(MAPPING_FILE)) {
      const raw = fs.readFileSync(MAPPING_FILE, 'utf-8');
      currentMapping = JSON.parse(raw);
      console.log(`  Mapping cargado: ${Object.keys(currentMapping).length} entradas`);
    }
  } catch (e) {
    console.error('Error cargando mapping:', e.message);
  }
}
loadMapping();

function getMapping() {
  return currentMapping;
}

// ─── Multer: upload en memoria ─────────────────────────────────────────────
const ALLOWED_MIME = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
  'application/vnd.ms-excel',                                           // xls
  'text/csv',
  'application/csv',
  'text/plain'
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!['.xlsx', '.xls', '.csv'].includes(ext)) {
      return cb(new Error('Solo se aceptan archivos .xlsx, .xls o .csv'));
    }
    // Validar MIME reportado por el browser (segunda capa)
    if (file.mimetype && !ALLOWED_MIME.has(file.mimetype)) {
      return cb(new Error('Tipo MIME no permitido'));
    }
    cb(null, true);
  }
});

// ─── POST /api/mapping/upload ──────────────────────────────────────────────
router.post('/upload', upload.single('mapping'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió archivo' });

  try {
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    if (rows.length === 0) {
      return res.status(400).json({ error: 'El archivo está vacío o no tiene filas de datos' });
    }

    // Construir objeto: clave del issue → datos de mapping
    const newMapping = {};
    for (const row of rows) {
      const key = (row['Clave'] || row['clave'] || row['KEY'] || row['key'] || '').toString().trim();
      if (!key) continue;
      newMapping[key] = {
        'Centro de Costo': row['Centro de Costo'] || row['centro_costo'] || '',
        'Prod / Improductivo': row['Prod / Improductivo'] || row['prod_improductivo'] || '',
        'Proyecto': row['Proyecto'] || row['proyecto'] || '',
        'Nombre': row['Nombre'] || row['nombre'] || '',
        'Funcion': row['Funcion'] || row['funcion'] || '',
        'Nombre nomina': row['Nombre nomina'] || row['nombre_nomina'] || ''
      };
    }

    // Guardar en disco
    if (!fs.existsSync(path.dirname(MAPPING_FILE))) {
      fs.mkdirSync(path.dirname(MAPPING_FILE), { recursive: true });
    }
    fs.writeFileSync(MAPPING_FILE, JSON.stringify(newMapping, null, 2), 'utf-8');
    currentMapping = newMapping;
    reportCache.clear(); // invalidar caché de reportes al cambiar el mapping

    res.json({
      ok: true,
      message: `Mapping actualizado: ${Object.keys(newMapping).length} claves cargadas`,
      preview: Object.entries(newMapping).slice(0, 5).map(([k, v]) => ({ clave: k, ...v }))
    });
  } catch (err) {
    console.error('Error procesando mapping:', err.message);
    res.status(500).json({ error: 'Error procesando el archivo: ' + err.message });
  }
});

// ─── GET /api/mapping/status ───────────────────────────────────────────────
router.get('/status', (req, res) => {
  res.json({
    loaded: Object.keys(currentMapping).length > 0,
    totalClaves: Object.keys(currentMapping).length,
    preview: Object.entries(currentMapping).slice(0, 10).map(([k, v]) => ({ clave: k, ...v }))
  });
});

// ─── GET /api/mapping/entries — lista completa para el editor ─────────────
router.get('/entries', (req, res) => {
  const entries = Object.entries(currentMapping).map(([clave, v]) => ({ clave, ...v }));
  res.json(entries);
});

// ─── PUT /api/mapping/entry — agregar o actualizar una entrada ────────────
router.put('/entry', express.json(), (req, res) => {
  const { clave, ...fields } = req.body || {};
  const key = (clave || '').toString().trim().toUpperCase();
  if (!key) return res.status(400).json({ error: 'La clave del issue es requerida' });

  currentMapping[key] = {
    'Centro de Costo':    (fields['Centro de Costo']    || '').toString().trim(),
    'Prod / Improductivo':(fields['Prod / Improductivo']|| '').toString().trim(),
    'Proyecto':           (fields['Proyecto']           || '').toString().trim(),
    'Nombre':             (fields['Nombre']             || '').toString().trim(),
    'Funcion':            (fields['Funcion']            || '').toString().trim(),
    'Nombre nomina':      (fields['Nombre nomina']      || '').toString().trim()
  };

  saveMapping();
  res.json({ ok: true, clave: key, entry: currentMapping[key] });
});

// ─── DELETE /api/mapping/entry/:key ───────────────────────────────────────
router.delete('/entry/:key', (req, res) => {
  const key = (req.params.key || '').toString().trim().toUpperCase();
  if (!currentMapping[key]) return res.status(404).json({ error: 'Clave no encontrada' });
  delete currentMapping[key];
  saveMapping();
  res.json({ ok: true });
});

// ─── GET /api/mapping/download-sample ─────────────────────────────────────
router.get('/download-sample', (req, res) => {
  res.download(MAPPING_SAMPLE, 'mapping_ejemplo.xlsx');
});

function saveMapping() {
  fs.writeFileSync(MAPPING_FILE, JSON.stringify(currentMapping, null, 2), 'utf-8');
  reportCache.clear(); // invalidar cach\u00e9 de reportes al cambiar el mapping
}

module.exports = router;
module.exports.getMapping = getMapping;
