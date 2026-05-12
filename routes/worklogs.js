const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { buildJiraClient, requireAuth } = require('./auth');
const { getMapping } = require('./mapping');
const { getPersonas } = require('./personas');
const reportCache = require('./reportCache');

const LAST_REPORT = path.join(__dirname, '../data/last_report.json');
const DATA_DIR    = path.join(__dirname, '../data');

// ─── Carga prefix_mapping.json ────────────────────────────────────────────
function getPrefixMap() {
  try {
    const p = path.join(DATA_DIR, 'prefix_mapping.json');
    if (!fs.existsSync(p)) return {};
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
    const out = {};
    for (const [k, v] of Object.entries(raw)) out[k.toUpperCase()] = v;
    return out;
  } catch { return {}; }
}

// ─── Helper: construir sub-conjunto desde caché ───────────────────────────
function buildSubset(entry, from, to) {
  const detalle = entry.data.detalle.filter(r => r.fecha >= from && r.fecha <= to);
  const totalHoras = Math.round(detalle.reduce((s, r) => s + r.horasLogueadas, 0) * 100) / 100;
  return {
    meta: {
      from, to,
      fromCache: true,
      generatedAt: entry.data.meta.generatedAt,
      totalIssues: new Set(detalle.map(r => r.issueKey)).size,
      totalEntradas: detalle.length,
      totalHoras
    },
    detalle,
    resumenPersona:     calcularResumenPersona(detalle),
    resumenProyecto:    calcularResumenProyecto(detalle),
    resumenCentroCosto: calcularResumenCC(detalle)
  };
}

// ─── POST /api/worklogs/extract?from=YYYY-MM-DD&to=YYYY-MM-DD ─────────────
router.post('/extract', requireAuth, async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to)
    return res.status(400).json({ error: 'Parámetros requeridos: from, to (YYYY-MM-DD)' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to))
    return res.status(400).json({ error: 'Formato de fecha inválido. Usá YYYY-MM-DD' });

  // Caché hit
  const hit = reportCache.find(from, to);
  if (hit) {
    console.log(`[cache] hit ${from}→${to}`);
    return res.json(buildSubset(hit, from, to));
  }

  try {
    const jira       = buildJiraClient(req);
    const mapping    = getMapping();
    const personas   = getPersonas();
    const prefixMap  = getPrefixMap();

    // 1. Buscar issues con worklogs en el rango
    let allIssues = [];
    let startAt   = 0;
    while (true) {
      const r = await jira.post('/search/jql', {
        jql: `worklogDate >= "${from}" AND worklogDate <= "${to}" ORDER BY updated DESC`,
        fields: 'summary,issuetype,project,status,assignee,worklog',
        startAt,
        maxResults: 100
      });
      const batch = r.data.issues || [];
      allIssues = allIssues.concat(batch);
      if (allIssues.length >= r.data.total || !batch.length) break;
      startAt += 100;
    }

    // 2. Fetch paralelo de worklogs para issues con paginación (>20)
    const needFull = allIssues.filter(
      iss => (iss.fields.worklog?.total || 0) > (iss.fields.worklog?.worklogs?.length || 0)
    );
    const extraWl = {};
    await Promise.all(needFull.map(async iss => {
      try {
        const all = [];
        let start = 0;
        while (true) {
          const r = await jira.get(`/issue/${iss.key}/worklog`, { params: { startAt: start, maxResults: 100 } });
          all.push(...(r.data.worklogs || []));
          if (all.length >= r.data.total || !r.data.worklogs?.length) break;
          start += 100;
        }
        extraWl[iss.key] = all;
      } catch { extraWl[iss.key] = []; }
    }));

    // 3. Construir filas
    const rows = [];
    for (const issue of allIssues) {
      const key      = issue.key;
      const fields   = issue.fields;
      const worklogs = extraWl[key] ?? fields.worklog?.worklogs ?? [];
      const mapRow   = mapping[key] || {};
      const prefix   = key.split('-')[0].toUpperCase();
      const pm       = prefixMap[prefix] || {};

      for (const wl of worklogs) {
        const started = (wl.started || '').substring(0, 10);
        if (!started || started < from || started > to) continue;

        const email = (wl.author?.emailAddress || '').toLowerCase();
        const p     = personas[email] || {};
        const hours = Math.round((wl.timeSpentSeconds / 3600) * 100) / 100;

        rows.push({
          fecha:            started,
          issueKey:         key,
          issueSummary:     fields.summary || '',
          proyecto:         fields.project?.name || '',
          tipoIssue:        fields.issuetype?.name || '',
          estado:           fields.status?.name || '',
          autor:            wl.author?.displayName || '',
          autorEmail:       email,
          horasLogueadas:   hours,
          segundosLogueados: wl.timeSpentSeconds || 0,
          centroCosto:      pm.centroCosto      || mapRow['Centro de Costo']      || '',
          prodImproductivo: pm.prodImproductivo || mapRow['Prod / Improductivo']  || '',
          proyectoMapeado:  mapRow['Proyecto']  || '',
          nombre:           p.nombreNomina      || mapRow['Nombre']               || '',
          funcion:          p.funcion           || mapRow['Funcion']              || '',
          nombreNomina:     p.nombreNomina      || mapRow['Nombre nomina']        || ''
        });
      }
    }

    // 4. Resúmenes
    const resumenPersona     = calcularResumenPersona(rows);
    const resumenProyecto    = calcularResumenProyecto(rows);
    const resumenCentroCosto = calcularResumenCC(rows);

    const payload = {
      meta: {
        from, to,
        generatedAt:   new Date().toISOString(),
        totalIssues:   allIssues.length,
        totalEntradas: rows.length,
        totalHoras:    Math.round(rows.reduce((s, r) => s + r.horasLogueadas, 0) * 100) / 100
      },
      detalle: rows,
      resumenPersona,
      resumenProyecto,
      resumenCentroCosto
    };

    // Persistir en disco y caché
    try { fs.writeFileSync(LAST_REPORT, JSON.stringify(payload, null, 2), 'utf-8'); } catch {}
    reportCache.set(from, to, payload);

    res.json(payload);

  } catch (err) {
    console.error('Error al extraer worklogs:', err.response?.data || err.message);
    res.status(500).json({
      error: 'Error al consultar Jira',
      detail: err.response?.data?.errorMessages || err.message
    });
  }
});


// ─── GET /api/worklogs/cached — sirve el último JSON (uso interno) ─────────
router.get('/cached', (req, res) => {
  if (!fs.existsSync(LAST_REPORT)) {
    return res.status(404).json({ error: 'Sin reporte previo.' });
  }
  try {
    res.json(JSON.parse(fs.readFileSync(LAST_REPORT, 'utf-8')));
  } catch (e) {
    res.status(500).json({ error: 'Error leyendo el reporte: ' + e.message });
  }
});

// ─── GET /api/worklogs?from=YYYY-MM-DD&to=YYYY-MM-DD ──────────────────────
router.get('/', requireAuth, async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) {
    return res.status(400).json({ error: 'Parámetros requeridos: from, to (YYYY-MM-DD)' });
  }

  try {
    const jira = buildJiraClient(req);

    // Guardia de solo lectura: intercepta cualquier intento de escritura
    const WRITE_METHODS = ['put', 'delete', 'patch'];
    WRITE_METHODS.forEach(method => {
      jira[method] = () => { throw new Error('Operación de escritura bloqueada: este cliente es de solo lectura.'); };
    });

    const mapping = getMapping();

    // 1. Buscar todos los issues con worklogs en el rango
    // POST a /search/jql es el método de búsqueda (solo lectura) que exige la API de Jira Cloud v3
    let allIssues = [];
    let startAt = 0;
    const maxResults = 100;

    while (true) {
      const jqlRes = await jira.post('/search/jql', {
        jql: `worklogDate >= "${from}" AND worklogDate <= "${to}" ORDER BY updated DESC`,
        fields: ['summary','issuetype','project','status','assignee','worklog'],
        startAt,
        maxResults
      });

      const issues = jqlRes.data.issues || [];
      allIssues = allIssues.concat(issues);

      if (allIssues.length >= jqlRes.data.total || issues.length === 0) break;
      startAt += maxResults;
    }

    // 2. Para cada issue, extraer worklogs dentro del rango
    const rows = [];

    for (const issue of allIssues) {
      let worklogs = issue.fields.worklog?.worklogs || [];

      // Si hay más de 20 worklogs, Jira los pagina → fetching completo
      if ((issue.fields.worklog?.total || 0) > 20) {
        const wlRes = await jira.get(`/issue/${issue.key}/worklog`);
        worklogs = wlRes.data.worklogs || [];
      }

      for (const wl of worklogs) {
        const started = wl.started?.substring(0, 10);
        if (!started || started < from || started > to) continue;

        const issueKey = issue.key;
        const map = mapping[issueKey] || {};

        rows.push({
          fecha: started,
          issueKey,
          issueSummary: issue.fields.summary,
          proyecto: issue.fields.project?.name || '',
          tipoIssue: issue.fields.issuetype?.name || '',
          estado: issue.fields.status?.name || '',
          autor: wl.author?.displayName || '',
          autorEmail: wl.author?.emailAddress || '',
          horasLogueadas: Math.round((wl.timeSpentSeconds / 3600) * 100) / 100,
          segundosLogueados: wl.timeSpentSeconds,
          // Columnas del mapping
          centroCosto: map['Centro de Costo'] || map['centro_costo'] || '',
          prodImproductivo: map['Prod / Improductivo'] || map['prod_improductivo'] || '',
          proyectoMapeado: map['Proyecto'] || map['proyecto'] || '',
          nombre: map['Nombre'] || map['nombre'] || '',
          funcion: map['Funcion'] || map['funcion'] || '',
          nombreNomina: map['Nombre nomina'] || map['nombre_nomina'] || ''
        });
      }
    }

    // 3. Calcular resúmenes
    const resumenPersona = calcularResumenPersona(rows);
    const resumenProyecto = calcularResumenProyecto(rows);
    const resumenCentroCosto = calcularResumenCC(rows);

    res.json({
      meta: {
        from,
        to,
        totalIssues: allIssues.length,
        totalEntradas: rows.length,
        totalHoras: Math.round(rows.reduce((a, r) => a + r.horasLogueadas, 0) * 100) / 100
      },
      detalle: rows,
      resumenPersona,
      resumenProyecto,
      resumenCentroCosto
    });

  } catch (err) {
    console.error('Error al obtener worklogs:', err.response?.data || err.message);
    res.status(500).json({
      error: 'Error al consultar Jira',
      detail: err.response?.data?.errorMessages || err.message
    });
  }
});

// ─── Helpers de resumen ────────────────────────────────────────────────────
function calcularResumenPersona(rows) {
  const map = {};
  for (const r of rows) {
    const key = r.autorEmail || r.autor;
    if (!map[key]) {
      map[key] = {
        autor: r.autor,
        email: r.autorEmail,
        nombre: r.nombre,
        funcion: r.funcion,
        nombreNomina: r.nombreNomina,
        centroCosto: r.centroCosto,
        totalHoras: 0,
        entradas: 0
      };
    }
    map[key].totalHoras += r.horasLogueadas;
    map[key].entradas += 1;
  }
  return Object.values(map)
    .map(r => ({ ...r, totalHoras: Math.round(r.totalHoras * 100) / 100 }))
    .sort((a, b) => b.totalHoras - a.totalHoras);
}

function calcularResumenProyecto(rows) {
  const map = {};
  for (const r of rows) {
    const key = r.proyectoMapeado || r.proyecto;
    if (!map[key]) map[key] = { proyecto: key, totalHoras: 0, entradas: 0, personas: new Set() };
    map[key].totalHoras += r.horasLogueadas;
    map[key].entradas += 1;
    map[key].personas.add(r.autorEmail || r.autor);
  }
  return Object.values(map)
    .map(r => ({ ...r, totalHoras: Math.round(r.totalHoras * 100) / 100, personas: r.personas.size }))
    .sort((a, b) => b.totalHoras - a.totalHoras);
}

function calcularResumenCC(rows) {
  const map = {};
  for (const r of rows) {
    const key = r.centroCosto || 'Sin Centro de Costo';
    if (!map[key]) map[key] = { centroCosto: key, totalHoras: 0, productivo: 0, improductivo: 0 };
    map[key].totalHoras += r.horasLogueadas;
    if ((r.prodImproductivo || '').toLowerCase().includes('productivo') &&
        !(r.prodImproductivo || '').toLowerCase().includes('improductivo')) {
      map[key].productivo += r.horasLogueadas;
    } else {
      map[key].improductivo += r.horasLogueadas;
    }
  }
  return Object.values(map)
    .map(r => ({
      ...r,
      totalHoras: Math.round(r.totalHoras * 100) / 100,
      productivo: Math.round(r.productivo * 100) / 100,
      improductivo: Math.round(r.improductivo * 100) / 100
    }))
    .sort((a, b) => b.totalHoras - a.totalHoras);
}

module.exports = router;
