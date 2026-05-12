/**
 * Script de utilidad: genera el archivo mapping_sample.xlsx
 * Ejecutar una sola vez: node scripts/generate_sample_mapping.js
 */
const XLSX = require('xlsx');
const path = require('path');
const fs   = require('fs');

const rows = [
  { 'Clave': 'PROJ-1',  'Centro de Costo': 'CC-001', 'Prod / Improductivo': 'Productivo',   'Proyecto': 'Portal Cliente',    'Nombre': 'Juan Pérez',    'Funcion': 'Desarrollador', 'Nombre nomina': 'PEREZ JUAN' },
  { 'Clave': 'PROJ-2',  'Centro de Costo': 'CC-001', 'Prod / Improductivo': 'Productivo',   'Proyecto': 'Portal Cliente',    'Nombre': 'Juan Pérez',    'Funcion': 'Desarrollador', 'Nombre nomina': 'PEREZ JUAN' },
  { 'Clave': 'PROJ-3',  'Centro de Costo': 'CC-002', 'Prod / Improductivo': 'Improductivo', 'Proyecto': 'Soporte Interno',   'Nombre': 'María García',  'Funcion': 'QA Analyst',    'Nombre nomina': 'GARCIA MARIA' },
  { 'Clave': 'MOBILE-1','Centro de Costo': 'CC-003', 'Prod / Improductivo': 'Productivo',   'Proyecto': 'App Móvil v2',      'Nombre': 'Carlos López',  'Funcion': 'Tech Lead',     'Nombre nomina': 'LOPEZ CARLOS' },
  { 'Clave': 'MOBILE-2','Centro de Costo': 'CC-003', 'Prod / Improductivo': 'Productivo',   'Proyecto': 'App Móvil v2',      'Nombre': 'Carlos López',  'Funcion': 'Tech Lead',     'Nombre nomina': 'LOPEZ CARLOS' },
  { 'Clave': 'OPS-1',   'Centro de Costo': 'CC-004', 'Prod / Improductivo': 'Improductivo', 'Proyecto': 'Infraestructura',   'Nombre': 'Ana Martínez',  'Funcion': 'DevOps',        'Nombre nomina': 'MARTINEZ ANA' },
];

const ws = XLSX.utils.json_to_sheet(rows);
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, 'Mapping');

const outDir = path.join(__dirname, '../data');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const outPath = path.join(outDir, 'mapping_sample.xlsx');
XLSX.writeFile(wb, outPath);
console.log('✓ mapping_sample.xlsx generado en', outPath);
