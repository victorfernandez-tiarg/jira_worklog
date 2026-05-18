/* ═══════════════════════════════════════════════════════
   Jira Worklog Dashboard — Lógica Frontend
   ═══════════════════════════════════════════════════════ */

'use strict';

// ─── Estado global ─────────────────────────────────────
let reportData = null;
let sortState  = {};   // { tableId: { col, asc } }
// Caché cliente: evita llamadas al servidor si el rango está cubierto
let cachedRange   = null;  // { from, to }
let cachedDetalle = [];    // todos los rows del rango cargado
// ─── Init ───────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  setDefaultDates();
  await checkAuthStatus();
  await checkMappingStatus();
  await cargarMapping();  // carga la tabla de mapping al iniciar
});

// ─── Autenticación ──────────────────────────────────────
async function checkAuthStatus() {
  try {
    const res = await fetch('/auth/status');
    const data = await res.json();
    const badge = document.getElementById('auth-status');
    const btnLogin  = document.getElementById('btn-login');
    const btnLogout = document.getElementById('btn-logout');

    if (data.authenticated) {
      badge.className = 'badge badge-green';
      badge.textContent = data.mode === 'oauth'
        ? `✓ ${data.user?.displayName || 'Conectado (OAuth)'}`
        : '✓ Conectado (API Token)';
      btnLogout.classList.toggle('hidden', data.mode !== 'oauth');
    } else {
      badge.className = 'badge badge-orange';
      badge.textContent = data.mode === 'oauth' ? '⚠ Sin autenticar' : '⚠ Configurar .env';
      if (data.mode === 'oauth') btnLogin.classList.remove('hidden');
    }
  } catch {
    // silencioso
  }
}

async function logout() {
  await fetch('/auth/logout');
  location.reload();
}

// ─── Mapping ────────────────────────────────────────────
async function checkMappingStatus() {
  try {
    const res  = await fetch('/api/mapping/status');
    const data = await res.json();
    updateMappingBadge(data);
  } catch { /* silencioso */ }
}

function updateMappingBadge(data) {
  const el = document.getElementById('mapping-status');
  if (data.loaded) {
    el.innerHTML = `<span class="badge badge-green">✓ Mapping: ${data.totalClaves} claves cargadas</span>`;
  } else {
    el.innerHTML = `<span class="badge badge-orange">⚠ Mapping no cargado — subí el archivo para enriquecer el reporte</span>`;
  }
}

async function uploadMapping(input) {
  const file = input.files[0];
  if (!file) return;

  const formData = new FormData();
  formData.append('mapping', file);

  showInfo('Subiendo mapping...');
  try {
    const res  = await fetch('/api/mapping/upload', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error desconocido');
    // Invalidar caché cliente: el mapping cambió, el próximo reporte debe recalcular
    cachedRange   = null;
    cachedDetalle = [];
    await cargarMapping();  // refrescar tabla de mapping
    hideError();
    alert(`✓ ${data.message}`);
  } catch (err) {
    showError(`Error al subir mapping: ${err.message}`);
  }
  input.value = '';
}

// ─── Rangos de fechas ───────────────────────────────────
function setDefaultDates() {
  const params = new URLSearchParams(window.location.search);
  const urlFrom = params.get('from');
  const urlTo   = params.get('to');
  if (urlFrom && /^\d{4}-\d{2}-\d{2}$/.test(urlFrom) && urlTo && /^\d{4}-\d{2}-\d{2}$/.test(urlTo)) {
    document.getElementById('date-from').value = urlFrom;
    document.getElementById('date-to').value   = urlTo;
    return;
  }
  const today = new Date();
  const from  = new Date(today.getFullYear(), today.getMonth(), 1);
  document.getElementById('date-from').value = fmt(from);
  document.getElementById('date-to').value   = fmt(today);
}

function setRange(type) {
  const today = new Date();
  let from, to = new Date(today);

  switch (type) {
    case 'thisWeek': {
      const day = today.getDay() || 7;
      from = new Date(today); from.setDate(today.getDate() - day + 1);
      break;
    }
    case 'lastWeek': {
      const day = today.getDay() || 7;
      to   = new Date(today); to.setDate(today.getDate() - day);
      from = new Date(to);    from.setDate(to.getDate() - 6);
      break;
    }
    case 'thisMonth':
      from = new Date(today.getFullYear(), today.getMonth(), 1);
      break;
    case 'lastMonth':
      from = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      to   = new Date(today.getFullYear(), today.getMonth(), 0);
      break;
  }
  document.getElementById('date-from').value = fmt(from);
  document.getElementById('date-to').value   = fmt(to);
}

function fmt(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// ─── Generar Reporte ────────────────────────────────────
async function generarReporte() {
  const from = document.getElementById('date-from').value;
  const to   = document.getElementById('date-to').value;

  if (!from || !to) { showError('Seleccioná fecha de inicio y fin.'); return; }
  if (from > to)    { showError('La fecha de inicio debe ser anterior a la de fin.'); return; }

  // Actualizar URL para que sea compartible/bookmarkeable
  const url = new URL(window.location.href);
  url.searchParams.set('from', from);
  url.searchParams.set('to', to);
  history.replaceState({}, '', url.toString()); 

  hideError();
  hideWarning();
  setLoading(true, 'Extrayendo datos de Jira...');
  document.getElementById('kpis').classList.add('hidden');
  document.getElementById('report-section').classList.add('hidden');

  // ─── Re-render local si el rango ya está en caché cliente ───────────
  if (cachedRange && from >= cachedRange.from && to <= cachedRange.to) {
    const data = filtrarLocal(from, to);
    reportData = data;
    await renderReport(data);
    setLoading(false);
    return;
  }

  // Mensaje de progreso dinámico (el script puede tardar ~30s en instancias grandes)
  const msgs = [
    'Extrayendo datos de Jira...',
    'Buscando issues con worklogs...',
    'Procesando worklogs por persona...',
    'Aplicando mapping...',
    'Calculando resúmenes...'
  ];
  let msgIdx = 0;
  const msgTimer = setInterval(() => {
    msgIdx = (msgIdx + 1) % msgs.length;
    const el = document.getElementById('loader-msg');
    if (el) el.textContent = msgs[msgIdx];
  }, 4000);

  try {
    const res  = await fetch(`/api/worklogs/extract?from=${from}&to=${to}`, { method: 'POST' });
    const data = await res.json();
    clearInterval(msgTimer);

    if (!res.ok) throw new Error(data.detail || data.error || 'Error del servidor');

    reportData = data;
    cachedRange   = { from: data.meta.from, to: data.meta.to };
    cachedDetalle = data.detalle;
    await renderReport(data);
    setLoading(false);
  } catch (err) {
    clearInterval(msgTimer);
    setLoading(false);
    showError(`Error al generar reporte: ${err.message}`);
  }
}
// ─── Filtrado local (sin llamada al servidor) ────────────────────────
function filtrarLocal(from, to) {
  const detalle = cachedDetalle.filter(r => r.fecha >= from && r.fecha <= to);
  const issues  = new Set(detalle.map(r => r.issueKey));
  const totalHoras = Math.round(detalle.reduce((s, r) => s + r.horasLogueadas, 0) * 100) / 100;
  return {
    meta: {
      from, to, fromCache: true,
      totalIssues:   issues.size,
      totalEntradas: detalle.length,
      totalHoras
    },
    detalle,
    resumenPersona:     calcResumenPersona(detalle),
    resumenProyecto:    calcResumenProyecto(detalle),
    resumenCentroCosto: calcResumenCC(detalle)
  };
}

function calcResumenPersona(rows) {
  const map = {};
  for (const r of rows) {
    const key = r.autorEmail || r.autor;
    if (!map[key]) map[key] = {
      autor: r.autor, autorEmail: r.autorEmail, email: r.autorEmail,
      nombre: r.nombre, funcion: r.funcion, nombreNomina: r.nombreNomina,
      centroCosto: r.centroCosto, totalHoras: 0, entradas: 0
    };
    map[key].totalHoras += r.horasLogueadas;
    map[key].entradas += 1;
  }
  return Object.values(map)
    .map(r => ({ ...r, totalHoras: Math.round(r.totalHoras * 100) / 100 }))
    .sort((a, b) => b.totalHoras - a.totalHoras);
}

function calcResumenProyecto(rows) {
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

function calcResumenCC(rows) {
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
      totalHoras:   Math.round(r.totalHoras   * 100) / 100,
      productivo:   Math.round(r.productivo   * 100) / 100,
      improductivo: Math.round(r.improductivo * 100) / 100
    }))
    .sort((a, b) => b.totalHoras - a.totalHoras);
}
// ─── Render ─────────────────────────────────────────────
async function renderReport(data) {
  // KPIs
  const kpis = document.getElementById('kpis');
  document.getElementById('kpi-horas').textContent    = data.meta.totalHoras.toLocaleString('es-AR');
  document.getElementById('kpi-personas').textContent = data.resumenPersona.length;
  document.getElementById('kpi-issues').textContent   = data.meta.totalIssues;
  document.getElementById('kpi-entradas').textContent = data.meta.totalEntradas;
  // Mostrar el período real del reporte (no el del selector)
  const periodoEl = document.getElementById('kpi-periodo');
  if (periodoEl) periodoEl.textContent = `${data.meta.from}  →  ${data.meta.to}`;
  kpis.classList.remove('hidden');

  const maxHorasPersona  = Math.max(...data.resumenPersona.map(r => r.totalHoras), 1);
  const maxHorasProyecto = Math.max(...data.resumenProyecto.map(r => r.totalHoras), 1);
  const maxHorasCC       = Math.max(...data.resumenCentroCosto.map(r => r.totalHoras), 1);

  // Tabla Personas — con click-to-edit
  await cargarPersonasCache();
  const tbodyPersonas = document.querySelector('#tbl-personas tbody');
  if (tbodyPersonas) {
    if (!data.resumenPersona.length) {
      tbodyPersonas.innerHTML = '<tr><td colspan="3" style="text-align:center;color:var(--text-soft);padding:20px">Sin datos</td></tr>';
    } else {
      tbodyPersonas.innerHTML = data.resumenPersona.map(r => {
        const p  = personasCache[r.autorEmail || r.email] || {};
        const fn = p.funcion || r.funcion || '–';
        return `<tr class="persona-row" data-email="${escHtml(r.autorEmail || r.email || '')}">
          <td>${escHtml(r.autor)}</td>
          <td>${escHtml(fn)}</td>
          <td class="num">${r.totalHoras.toLocaleString('es-AR', {minimumFractionDigits:2, maximumFractionDigits:2})}</td>
        </tr>`;
      }).join('');

      // Adjuntar handlers vía closure — evita pasar email como string en HTML
      const trEls = tbodyPersonas.querySelectorAll('tr.persona-row');
      data.resumenPersona.forEach((persona, i) => {
        if (trEls[i]) {
          trEls[i].addEventListener('click', () => togglePersonaDetalle(trEls[i], persona));
        }
      });
    }
  }

  // Tabla Proyectos
  const totalHorasProy = data.resumenProyecto.reduce((s, r) => s + r.totalHoras, 0);
  const tbodyProy = document.querySelector('#tbl-proyectos tbody');
  if (tbodyProy) {
    if (!data.resumenProyecto.length) {
      tbodyProy.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--text-soft);padding:20px">Sin datos</td></tr>';
    } else {
      tbodyProy.innerHTML = data.resumenProyecto.map(r => {
        const pct = totalHorasProy > 0 ? (r.totalHoras / totalHorasProy * 100).toFixed(1) : '0.0';
        return `<tr class="proyecto-row" data-proy="${escHtml(r.proyecto)}">
          <td>${escHtml(r.proyecto)}</td>
          <td class="num">${r.totalHoras.toLocaleString('es-AR', {minimumFractionDigits:2, maximumFractionDigits:2})}</td>
          <td class="num">${pct}%</td>
          <td class="num">${r.personas}</td>
        </tr>`;
      }).join('');
      // Event delegation — un solo listener en el tbody, robusto ante ordenamiento
      tbodyProy.onclick = function(e) {
        const tr = e.target.closest('tr.proyecto-row');
        if (!tr) return;
        const proy = data.resumenProyecto.find(p => p.proyecto === tr.dataset.proy);
        if (proy) toggleProyectoDetalle(tr, proy);
      };
    }
  }

  // Tabla Centro de Costo
  fillTable('tbl-cc', data.resumenCentroCosto, r => {
    const pct = r.totalHoras > 0 ? Math.round(r.productivo / r.totalHoras * 100) : 0;
    return [
      r.centroCosto,
      r.totalHoras.toLocaleString('es-AR'),
      r.productivo.toLocaleString('es-AR'),
      r.improductivo.toLocaleString('es-AR'),
      `<div class="bar-wrap"><div class="bar-bg"><div class="bar-fill prod" style="width:${pct}%"></div></div>${pct}%</div>`
    ];
  });

  // Tabla Detalle
  const jiraBase = window._jiraBase || '';
  fillTable('tbl-detalle', data.detalle, r => [
    r.fecha,
    jiraBase
      ? `<a class="issue-link" href="${jiraBase}/browse/${r.issueKey}" target="_blank">${r.issueKey}</a>`
      : r.issueKey,
    r.issueSummary,
    r.autor,
    r.nombreNomina || '–',
    r.proyectoMapeado || r.proyecto,
    r.centroCosto || '–',
    r.prodImproductivo || '–',
    r.horasLogueadas.toLocaleString('es-AR')
  ]);

  // Tabla Distribución %
  renderDistribucion(data.resumenCentroCosto);

  document.getElementById('report-section').classList.remove('hidden');
}

// ─── Render: Distribución % por CC ─────────────────────────
let _chartCC = null;  // instancia Chart.js reutilizable

function renderDistribucion(resumenCC) {
  const totalHoras = resumenCC.reduce((s, r) => s + r.totalHoras, 0);
  if (!totalHoras) return;

  // Ordenar por horas desc
  const sorted = [...resumenCC].sort((a, b) => b.totalHoras - a.totalHoras);

  // Tabla
  const tbody = document.querySelector('#tbl-dist tbody');
  if (tbody) {
    tbody.innerHTML = sorted.map(r => {
      const pct = (r.totalHoras / totalHoras * 100);
      const pctStr = pct.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const fillW = Math.round(pct);
      return `<tr>
        <td>${escHtml(r.centroCosto || 'Sin CC')}</td>
        <td class="num">${r.totalHoras.toLocaleString('es-AR', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td>
        <td class="num">
          <div class="dist-pct-bar">
            <div class="dist-pct-track"><div class="dist-pct-fill" style="width:${fillW}%"></div></div>
            ${pctStr}%
          </div>
        </td>
      </tr>`;
    }).join('');
  }
  const totalEl = document.getElementById('dist-total-horas');
  if (totalEl) totalEl.textContent = totalHoras.toLocaleString('es-AR', {minimumFractionDigits: 2, maximumFractionDigits: 2});

  // Gráfico de torta
  const canvas = document.getElementById('chart-cc');
  if (!canvas || typeof Chart === 'undefined') return;

  // Paleta de colores variada
  const PALETTE = [
    '#4F81BD','#C0504D','#9BBB59','#8064A2','#4BACC6','#F79646',
    '#2C4770','#8B0000','#2E7D32','#4A148C','#006064','#BF360C',
    '#0D47A1','#880E4F','#1B5E20','#311B92','#004D40','#E65100',
    '#37474F','#795548'
  ];
  const labels = sorted.map(r => r.centroCosto || 'Sin CC');
  const values = sorted.map(r => parseFloat((r.totalHoras / totalHoras * 100).toFixed(2)));
  const colors = sorted.map((_, i) => PALETTE[i % PALETTE.length]);

  if (_chartCC) { _chartCC.destroy(); _chartCC = null; }

  _chartCC = new Chart(canvas, {
    type: 'doughnut',
    plugins: [ChartDataLabels],
    data: {
      labels,
      datasets: [{ data: values, backgroundColor: colors, borderWidth: 2, borderColor: '#fff' }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: {
          position: 'right',
          labels: { font: { size: 12 }, boxWidth: 14, padding: 10 }
        },
        tooltip: { enabled: false },
        datalabels: {
          formatter: (val) => val >= 4 ? `${val.toLocaleString('es-AR', {minimumFractionDigits: 1, maximumFractionDigits: 1})}%` : '',
          font: { size: 11, weight: '700' },
          color: '#fff'
        }
      }
    }
  });
}

// ═══════════════════════════════════════════════════════════
// GRÁFICOS INTERACTIVOS
// ═══════════════════════════════════════════════════════════
const _charts = {};  // instancias Chart.js reutilizables

const PALETTE = [
  '#4F81BD','#C0504D','#9BBB59','#8064A2','#4BACC6','#F79646',
  '#2C4770','#8B0000','#2E7D32','#4A148C','#006064','#BF360C',
  '#0D47A1','#880E4F','#1B5E20','#311B92','#004D40','#E65100',
  '#37474F','#795548','#00838F','#558B2F'
];

function renderGraficos() {
  if (!reportData) return;

  const filFun  = document.getElementById('fil-funcion')?.value  || '';
  const filCC   = document.getElementById('fil-cc')?.value       || '';
  const filProd = document.getElementById('fil-prod')?.value     || '';

  // Poblar selects la primera vez
  poblarSelectGraficos();

  // Filtrar detalle
  let rows = reportData.detalle;
  if (filFun)  rows = rows.filter(r => r.funcion === filFun);
  if (filCC)   rows = rows.filter(r => r.centroCosto === filCC);
  if (filProd) rows = rows.filter(r => r.prodImproductivo === filProd);

  // ── 1. Horas por persona (top 15) ─────────────────────────
  {
    const map = {};
    for (const r of rows) {
      map[r.autor] = (map[r.autor] || 0) + r.horasLogueadas;
    }
    const sorted = Object.entries(map).sort((a,b) => b[1]-a[1]).slice(0, 15);
    renderBar('chart-personas', sorted.map(x=>x[0]), sorted.map(x=>Math.round(x[1]*100)/100), 'Horas', PALETTE, 'y');
  }

  // ── 2. Horas por función ───────────────────────────────────
  {
    const map = {};
    for (const r of rows) {
      const key = r.funcion || 'Sin función';
      map[key] = (map[key] || 0) + r.horasLogueadas;
    }
    const sorted = Object.entries(map).sort((a,b) => b[1]-a[1]);
    renderDoughnut('chart-funciones', sorted.map(x=>x[0]), sorted.map(x=>Math.round(x[1]*100)/100));
  }

  // ── 3. Horas por CC ────────────────────────────────────────
  {
    const map = {};
    for (const r of rows) {
      const key = r.centroCosto || 'Sin CC';
      map[key] = (map[key] || 0) + r.horasLogueadas;
    }
    const sorted = Object.entries(map).sort((a,b) => b[1]-a[1]);
    renderBar('chart-cc-bar', sorted.map(x=>x[0]), sorted.map(x=>Math.round(x[1]*100)/100), 'Horas', PALETTE, 'y');
  }

  // ── 4. Evolución temporal ──────────────────────────────────
  {
    const map = {};
    for (const r of rows) {
      map[r.fecha] = (map[r.fecha] || 0) + r.horasLogueadas;
    }
    const dates  = Object.keys(map).sort();
    const values = dates.map(d => Math.round(map[d]*100)/100);
    renderLine('chart-timeline', dates, values);
  }
}

function poblarSelectGraficos() {
  if (!reportData) return;
  const selFun = document.getElementById('fil-funcion');
  const selCC  = document.getElementById('fil-cc');
  if (!selFun || !selCC) return;

  // Solo poblar una vez (si ya tiene opciones, no repoblar)
  if (selFun.options.length > 1) return;

  const funciones = [...new Set(reportData.detalle.map(r => r.funcion).filter(Boolean))].sort();
  const ccs       = [...new Set(reportData.detalle.map(r => r.centroCosto).filter(Boolean))].sort();

  funciones.forEach(f => {
    const o = document.createElement('option'); o.value = f; o.textContent = f;
    selFun.appendChild(o);
  });
  ccs.forEach(c => {
    const o = document.createElement('option'); o.value = c; o.textContent = c;
    selCC.appendChild(o);
  });
}

function limpiarFiltrosGraficos() {
  ['fil-funcion','fil-cc','fil-prod'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  // Forzar repoblado de selects en próximo render
  const selFun = document.getElementById('fil-funcion');
  if (selFun) while (selFun.options.length > 1) selFun.remove(1);
  const selCC = document.getElementById('fil-cc');
  if (selCC) while (selCC.options.length > 1) selCC.remove(1);
  renderGraficos();
}

function renderBar(canvasId, labels, data, label, colors, indexAxis) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || typeof Chart === 'undefined') return;
  if (_charts[canvasId]) { _charts[canvasId].destroy(); }
  const total = data.reduce((s, v) => s + v, 0);

  // Qué filtro controla este gráfico
  const filterMap = { 'chart-cc-bar': 'fil-cc', 'chart-personas': null };
  const filterId = filterMap[canvasId];

  _charts[canvasId] = new Chart(canvas, {
    type: 'bar',
    plugins: [ChartDataLabels],
    data: {
      labels,
      datasets: [{
        label,
        data,
        backgroundColor: colors.slice(0, labels.length),
        borderRadius: 4,
        borderSkipped: false
      }]
    },
    options: {
      indexAxis: indexAxis || 'x',
      responsive: true,
      cursor: filterId ? 'pointer' : 'default',
      onClick: filterId ? (evt, elements) => {
        if (!elements.length) return;
        const clicked = labels[elements[0].index];
        const sel = document.getElementById(filterId);
        if (!sel) return;
        // Toggle: si ya estaba activo, limpiar
        if (sel.value === clicked) {
          sel.value = '';
        } else {
          sel.value = clicked;
          // Si la opción no existe aún en el select, agregarla
          if (!Array.from(sel.options).find(o => o.value === clicked)) {
            const o = document.createElement('option');
            o.value = clicked; o.textContent = clicked;
            sel.appendChild(o);
          }
        }
        renderGraficos();
      } : undefined,
      plugins: {
        legend: { display: false },
        tooltip: { enabled: false },
        datalabels: {
          anchor: 'end',
          align: 'end',
          formatter: (val) => {
            const pct = total > 0 ? (val / total * 100).toFixed(1) : 0;
            return `${val.toLocaleString('es-AR')} hs (${pct}%)`;
          },
          font: { size: 10, weight: '600' },
          color: 'var(--text)',
          clip: false
        }
      },
      layout: { padding: { right: indexAxis === 'y' ? 120 : 0, top: indexAxis !== 'y' ? 24 : 0 } },
      scales: {
        x: { ticks: { font: { size: 11 } }, grid: { display: indexAxis !== 'y' } },
        y: { ticks: { font: { size: 11 } }, grid: { display: indexAxis === 'y' } }
      }
    }
  });
}

function renderDoughnut(canvasId, labels, data) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || typeof Chart === 'undefined') return;
  if (_charts[canvasId]) { _charts[canvasId].destroy(); }
  const total = data.reduce((s, v) => s + v, 0);

  // chart-funciones → filtro por función
  const filterId = canvasId === 'chart-funciones' ? 'fil-funcion' : null;

  _charts[canvasId] = new Chart(canvas, {
    type: 'doughnut',
    plugins: [ChartDataLabels],
    data: {
      labels,
      datasets: [{ data, backgroundColor: PALETTE.slice(0, labels.length), borderWidth: 2, borderColor: '#fff' }]
    },
    options: {
      responsive: true,
      onClick: filterId ? (evt, elements) => {
        if (!elements.length) return;
        const clicked = labels[elements[0].index];
        const sel = document.getElementById(filterId);
        if (!sel) return;
        sel.value = sel.value === clicked ? '' : clicked;
        renderGraficos();
      } : undefined,
      plugins: {
        legend: { position: 'right', labels: { font: { size: 11 }, boxWidth: 12, padding: 8 } },
        tooltip: { enabled: false },
        datalabels: {
          formatter: (val) => {
            const pct = total > 0 ? (val / total * 100).toFixed(1) : 0;
            return pct >= 4 ? `${pct}%` : '';
          },
          font: { size: 11, weight: '700' },
          color: '#fff'
        }
      }
    }
  });
}

function renderLine(canvasId, labels, data) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || typeof Chart === 'undefined') return;
  if (_charts[canvasId]) { _charts[canvasId].destroy(); }
  _charts[canvasId] = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Horas',
        data,
        fill: true,
        tension: 0.3,
        borderColor: '#4F81BD',
        backgroundColor: 'rgba(79,129,189,.15)',
        pointRadius: 3,
        pointHoverRadius: 6
      }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: { label: ctx => ` ${ctx.parsed.y.toLocaleString('es-AR')} hs` }
        }
      },
      scales: {
        x: { ticks: { font: { size: 10 }, maxRotation: 45 } },
        y: { ticks: { font: { size: 11 } }, beginAtZero: true }
      }
    }
  });
}

function barCell(val, max) {
  const pct = max > 0 ? Math.round(val / max * 100) : 0;
  return `<div class="bar-wrap">
    <div class="bar-bg"><div class="bar-fill" style="width:${pct}%"></div></div>
    <span>${val.toLocaleString('es-AR')}</span>
  </div>`;
}

function fillTable(id, rows, mapper) {
  const tbody = document.querySelector(`#${id} tbody`);
  if (!tbody) return;
  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="99" style="text-align:center;color:var(--text-soft);padding:20px">Sin datos para el período seleccionado</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(r => {
    const cells = mapper(r);
    return '<tr>' + cells.map((c, i) => {
      const isNum = typeof c === 'number' || (typeof c === 'string' && /^\d[\d.,]*$/.test(c.trim()));
      return `<td${isNum ? ' class="num"' : ''}>${c}</td>`;
    }).join('') + '</tr>';
  }).join('');
}

// ─── Tabs ───────────────────────────────────────────────
let _graficosFilterState = { funcion: '', cc: '', prod: '' };

function switchTab(tabId) {
  // Guardar estado de filtros de gráficos antes de salir
  _graficosFilterState = {
    funcion: document.getElementById('fil-funcion')?.value || '',
    cc:      document.getElementById('fil-cc')?.value      || '',
    prod:    document.getElementById('fil-prod')?.value    || ''
  };

  document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.tab').forEach(el => el.classList.remove('active'));
  document.getElementById(tabId).classList.remove('hidden');
  event.target.classList.add('active');

  // Restaurar filtros de gráficos al volver a esa tab
  if (tabId === 'tab-graficos') {
    const selFun = document.getElementById('fil-funcion');
    const selCC  = document.getElementById('fil-cc');
    const selProd = document.getElementById('fil-prod');
    if (selFun && _graficosFilterState.funcion) selFun.value = _graficosFilterState.funcion;
    if (selCC  && _graficosFilterState.cc)      selCC.value  = _graficosFilterState.cc;
    if (selProd && _graficosFilterState.prod)   selProd.value = _graficosFilterState.prod;
  }
}

// ─── Filtro de tabla ────────────────────────────────────
function filterTable(tableId, query) {
  const q = query.toLowerCase();
  const rows = document.querySelectorAll(`#${tableId} tbody tr`);
  rows.forEach(tr => {
    if (tr.classList.contains('persona-detail-row') || tr.classList.contains('proyecto-detail-row')) return;
    tr.style.display = tr.textContent.toLowerCase().includes(q) ? '' : 'none';
  });
}

// ─── Ordenamiento ───────────────────────────────────────
function sortTable(tableId, colIndex) {
  const table = document.getElementById(tableId);
  const tbody = table.querySelector('tbody');
  // Colapsar y destruir charts antes de reordenar
  tbody.querySelectorAll('tr.persona-detail-row, tr.proyecto-detail-row').forEach(r => r.remove());
  tbody.querySelectorAll('tr.persona-row.expanded, tr.proyecto-row.expanded').forEach(r => {
    r.classList.remove('expanded');
    const cid = r.dataset.chartId;
    if (cid && _proyCharts[cid]) { _proyCharts[cid].destroy(); delete _proyCharts[cid]; }
  });
  const rows  = Array.from(tbody.querySelectorAll('tr'));

  const state = sortState[tableId] || { col: -1, asc: true };
  const asc   = (state.col === colIndex) ? !state.asc : true;
  sortState[tableId] = { col: colIndex, asc };

  rows.sort((a, b) => {
    const aText = a.cells[colIndex]?.textContent.trim() || '';
    const bText = b.cells[colIndex]?.textContent.trim() || '';
    const aNum  = parseFloat(aText.replace(/[.,\s]/g, '').replace(',', '.'));
    const bNum  = parseFloat(bText.replace(/[.,\s]/g, '').replace(',', '.'));
    const cmp   = (!isNaN(aNum) && !isNaN(bNum))
      ? aNum - bNum
      : aText.localeCompare(bText, 'es', { numeric: true });
    return asc ? cmp : -cmp;
  });

  rows.forEach(r => tbody.appendChild(r));
}

// ─── Export ─────────────────────────────────────────────
function exportarExcel(tipo) {
  if (!reportData) return;
  const { rows, nombre } = getExportData(tipo);
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Reporte');
  XLSX.writeFile(wb, `${nombre}.xlsx`);
}

function exportarCSV(tipo) {
  if (!reportData) return;
  const { rows, nombre } = getExportData(tipo);
  const ws  = XLSX.utils.json_to_sheet(rows);
  const csv = XLSX.utils.sheet_to_csv(ws);
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `${nombre}.csv`;
  a.click(); URL.revokeObjectURL(url);
}

function getExportData(tipo) {
  const from = document.getElementById('date-from').value;
  const to   = document.getElementById('date-to').value;
  const rango = `${from}_al_${to}`;

  switch (tipo) {
    case 'resumenPersona':
      return { rows: reportData.resumenPersona, nombre: `personas_${rango}` };
    case 'resumenProyecto':
      return { rows: reportData.resumenProyecto, nombre: `proyectos_${rango}` };
    case 'resumenCentroCosto':
      return { rows: reportData.resumenCentroCosto, nombre: `centro_costo_${rango}` };
    case 'detalle':
    default:
      return { rows: reportData.detalle, nombre: `detalle_worklogs_${rango}` };
  }
}

// ─── UI Helpers ─────────────────────────────────────────
function setLoading(on, msg) {
  document.getElementById('loader').classList.toggle('hidden', !on);
  document.getElementById('btn-generar').disabled = on;
  if (on && msg) {
    const el = document.getElementById('loader-msg');
    if (el) el.textContent = msg;
  }
}

function showError(msg) {
  hideWarning();
  const el = document.getElementById('error-msg');
  el.textContent = '⚠ ' + msg;
  el.classList.remove('hidden');
}

function hideError() {
  document.getElementById('error-msg').classList.add('hidden');
}

function showWarning(html) {
  const el = document.getElementById('warning-msg');
  el.innerHTML = html;
  el.classList.remove('hidden');
}

function hideWarning() {
  document.getElementById('warning-msg').classList.add('hidden');
}

function showInfo(msg) {
  const el = document.getElementById('error-msg');
  el.style.background = '#e3fcef'; el.style.color = 'var(--success)'; el.style.border = '1px solid #abf5d1';
  el.textContent = msg;
  el.classList.remove('hidden');
}

// ═══════════════════════════════════════════════════════════
// MODAL: editar persona (click en fila de tabla Por Persona)
// ═══════════════════════════════════════════════════════════

let personasCache = {};   // email → { centroCosto, funcion, prod, nombreNomina }

async function cargarPersonasCache() {
  try {
    const res  = await fetch('/api/personas');
    const list = await res.json();
    personasCache = {};
    list.forEach(p => { personasCache[p.email] = p; });
  } catch { /* silencioso */ }
}

function abrirModalPersona(email, nombre) {
  const p = personasCache[email] || {};
  document.getElementById('pm-email').value    = email;
  document.getElementById('modal-titulo').textContent = `Editar: ${nombre}`;
  document.getElementById('pm-cc').value       = p.centroCosto      || '';
  document.getElementById('pm-funcion').value  = p.funcion          || '';
  document.getElementById('pm-prod').value     = p.prodImproductivo || '';
  document.getElementById('pm-nomina').value   = p.nombreNomina     || '';
  document.getElementById('persona-modal-backdrop').classList.remove('hidden');
  document.getElementById('persona-modal').classList.remove('hidden');
  document.getElementById('pm-funcion').focus();
}

function cerrarModalPersona() {
  document.getElementById('persona-modal-backdrop').classList.add('hidden');
  document.getElementById('persona-modal').classList.add('hidden');
}

// Cerrar con Escape
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') cerrarModalPersona();
});

// ─── Detalle CC por persona (collapse inline) ────────────
function togglePersonaDetalle(tr, persona) {
  const isExpanded = tr.classList.contains('expanded');

  // Colapsar cualquier fila expandida previa
  document.querySelectorAll('#tbl-personas tbody tr.persona-row.expanded').forEach(row => {
    row.classList.remove('expanded');
    const next = row.nextElementSibling;
    if (next?.classList.contains('persona-detail-row')) next.remove();
  });

  if (isExpanded) return; // segundo clic cierra

  const email  = (persona.autorEmail || persona.email || '').toLowerCase();
  const autor  = (persona.autor || '').toLowerCase();
  const nombre =  persona.autor || '';

  // Filtrar detalle por persona — match por email (primario) o nombre (fallback)
  const rows = (reportData?.detalle || []).filter(r => {
    const rEmail = (r.autorEmail || '').toLowerCase();
    const rAutor = (r.autor || '').toLowerCase();
    if (email) return rEmail === email;
    return rAutor === autor;
  });

  const fmt = h => (Math.round(h * 100) / 100).toLocaleString('es-AR', {minimumFractionDigits:2, maximumFractionDigits:2});
  const DASH = `<span style="color:var(--text-soft)">–</span>`;

  // ── Tab 1: agrupación por CC ──────────────────────────
  const ccMap = {};
  rows.forEach(r => {
    const cc = r.centroCosto || '(Sin CC)';
    ccMap[cc] = (ccMap[cc] || 0) + r.horasLogueadas;
  });
  const ccRows = Object.entries(ccMap)
    .map(([cc, h]) => ({ cc, h: Math.round(h * 100) / 100 }))
    .sort((a, b) => b.h - a.h);
  const totalHoras = Math.round(ccRows.reduce((s, r) => s + r.h, 0) * 100) / 100;

  const ccTableHtml = ccRows.length
    ? `<table class="tbl-cc-inline">
        <thead><tr><th>Centro de Costo</th><th class="num">Horas</th></tr></thead>
        <tbody>
          ${ccRows.map(r => `<tr><td>${escHtml(r.cc)}</td><td class="num">${fmt(r.h)}</td></tr>`).join('')}
          <tr class="tbl-total"><td><strong>Total</strong></td><td class="num"><strong>${fmt(totalHoras)}</strong></td></tr>
        </tbody>
      </table>`
    : '<p style="color:var(--text-soft);font-size:.85rem">Sin datos para el período</p>';

  // ── Tab 2: matriz Mes × CC ────────────────────────────
  const monthCCMap = {};
  rows.forEach(r => {
    const m  = r.fecha.substring(0, 7);
    const cc = r.centroCosto || '(Sin CC)';
    if (!monthCCMap[m]) monthCCMap[m] = {};
    monthCCMap[m][cc] = (monthCCMap[m][cc] || 0) + r.horasLogueadas;
  });
  const months = Object.keys(monthCCMap).sort();
  const allCCs = [...new Set(rows.map(r => r.centroCosto || '(Sin CC)'))];
  const ccTotals = {};
  allCCs.forEach(cc => { ccTotals[cc] = months.reduce((s, m) => s + (monthCCMap[m]?.[cc] || 0), 0); });
  allCCs.sort((a, b) => ccTotals[b] - ccTotals[a]);

  let mensualTableHtml;
  if (!months.length) {
    mensualTableHtml = '<p style="color:var(--text-soft);font-size:.85rem">Sin datos para el período</p>';
  } else {
    const multiCC = allCCs.length > 1;
    const thCols  = multiCC ? allCCs.map(cc => `<th class="num" title="${escHtml(cc)}">${escHtml(cc)}</th>`).join('') : '';
    const bodyRows = months.map(m => {
      const rowTotal = allCCs.reduce((s, cc) => s + (monthCCMap[m]?.[cc] || 0), 0);
      const cells = multiCC
        ? allCCs.map(cc => { const h = monthCCMap[m]?.[cc] || 0; return `<td class="num">${h > 0 ? fmt(h) : DASH}</td>`; }).join('')
        : '';
      return `<tr><td>${formatMonth(m)}</td>${cells}<td class="num"><strong>${fmt(rowTotal)}</strong></td></tr>`;
    }).join('');
    const footCells = multiCC
      ? allCCs.map(cc => `<td class="num">${fmt(ccTotals[cc])}</td>`).join('')
      : '';
    mensualTableHtml =
      `<div class="tbl-scroll-x"><table class="tbl-cc-inline">
        <thead><tr><th>Mes</th>${thCols}<th class="num">${multiCC ? 'Total' : 'Horas'}</th></tr></thead>
        <tbody>
          ${bodyRows}
          <tr class="tbl-total"><td><strong>Total</strong></td>${footCells}<td class="num"><strong>${fmt(totalHoras)}</strong></td></tr>
        </tbody>
      </table></div>`;
  }

  // ── Render ────────────────────────────────────────────
  const detailRow = document.createElement('tr');
  detailRow.className = 'persona-detail-row';
  detailRow.innerHTML =
    `<td colspan="3"><div class="persona-detail-panel">
      <div class="detail-tabs">
        <button class="detail-tab active" data-tab="cc"     onclick="switchDetailTab(this,'cc')">Por CC</button>
        <button class="detail-tab"        data-tab="mensual" onclick="switchDetailTab(this,'mensual')">Evolución mensual</button>
      </div>
      <div class="detail-tab-content" data-content="cc">${ccTableHtml}</div>
      <div class="detail-tab-content hidden" data-content="mensual">${mensualTableHtml}</div>
    </div></td>`;

  tr.after(detailRow);
  tr.classList.add('expanded');
}

function switchDetailTab(btn, tabName) {
  const panel = btn.closest('.persona-detail-panel');
  panel.querySelectorAll('.detail-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
  panel.querySelectorAll('.detail-tab-content').forEach(c => c.classList.toggle('hidden', c.dataset.content !== tabName));
}

function formatMonth(yyyymm) {
  const [y, m] = yyyymm.split('-');
  const names = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  return `${names[parseInt(m, 10) - 1]} ${y}`;
}

// ─── Detalle por Proyecto (collapse inline) ───────────────
function toggleProyectoDetalle(tr, proy) {
  const isExpanded = tr.classList.contains('expanded');

  // Colapsar previos y destruir charts
  document.querySelectorAll('#tbl-proyectos tbody tr.proyecto-row.expanded').forEach(row => {
    row.classList.remove('expanded');
    const cid = row.dataset.chartId;
    if (cid && _proyCharts[cid]) { _proyCharts[cid].destroy(); delete _proyCharts[cid]; }
    const next = row.nextElementSibling;
    if (next?.classList.contains('proyecto-detail-row')) next.remove();
  });

  if (isExpanded) return;

  const proyNombre = proy.proyecto;
  const rows = (reportData?.detalle || []).filter(r =>
    (r.proyectoMapeado || r.proyecto) === proyNombre
  );

  const totalHoras = Math.round(rows.reduce((s, r) => s + r.horasLogueadas, 0) * 100) / 100;
  const fmt  = h  => (Math.round(h * 100) / 100).toLocaleString('es-AR', {minimumFractionDigits:2, maximumFractionDigits:2});
  const pct  = h  => totalHoras > 0 ? (h / totalHoras * 100).toFixed(1) + '%' : '–';
  const DASH = `<span style="color:var(--text-soft)">–</span>`;

  // ── Tab Personas ──────────────────────────────────────
  const personaMap = {};
  rows.forEach(r => {
    const key = r.autorEmail || r.autor;
    if (!personaMap[key]) personaMap[key] = { nombre: r.autor, h: 0 };
    personaMap[key].h += r.horasLogueadas;
  });
  const personaRows = Object.values(personaMap)
    .map(p => ({ ...p, h: Math.round(p.h * 100) / 100 }))
    .sort((a, b) => b.h - a.h);

  const personaTableHtml = personaRows.length
    ? `<table class="tbl-cc-inline">
        <thead><tr><th>Persona</th><th class="num">Horas</th><th class="num">%</th></tr></thead>
        <tbody>
          ${personaRows.map(p =>
            `<tr><td>${escHtml(p.nombre)}</td><td class="num">${fmt(p.h)}</td><td class="num">${pct(p.h)}</td></tr>`
          ).join('')}
          <tr class="tbl-total"><td><strong>Total</strong></td><td class="num"><strong>${fmt(totalHoras)}</strong></td><td class="num"><strong>100%</strong></td></tr>
        </tbody>
      </table>`
    : '<p style="color:var(--text-soft);font-size:.85rem">Sin datos para el período</p>';

  // ── Tab Evolución mensual ─────────────────────────────
  const monthMap = {};
  rows.forEach(r => {
    const mon = r.fecha.substring(0, 7);
    monthMap[mon] = (monthMap[mon] || 0) + r.horasLogueadas;
  });
  const months     = Object.keys(monthMap).sort();
  const monthHours = months.map(m => Math.round(monthMap[m] * 100) / 100);
  const pcts       = monthHours.map(h => totalHoras > 0 ? +(h / totalHoras * 100).toFixed(1) : 0);

  const chartId = 'proy-chart-' + (++_proyChartSeq);

  const mensualContent = months.length ? `
    <div style="max-width:580px;margin-bottom:14px;padding-top:4px">
      <canvas id="${chartId}" height="130"></canvas>
    </div>
    <table class="tbl-cc-inline">
      <thead><tr><th>Mes</th><th class="num">Horas</th><th class="num">%</th></tr></thead>
      <tbody>
        ${months.map((m, i) =>
          `<tr class="tbl-monthly-row" data-month="${m}">
            <td>${formatMonth(m)}</td>
            <td class="num">${fmt(monthHours[i])}</td>
            <td class="num">${pcts[i]}%</td>
          </tr>`
        ).join('')}
        <tr class="tbl-total"><td><strong>Total</strong></td><td class="num"><strong>${fmt(totalHoras)}</strong></td><td class="num"><strong>100%</strong></td></tr>
      </tbody>
    </table>`
    : '<p style="color:var(--text-soft);font-size:.85rem">Sin datos para el período</p>';

  // ── Render ────────────────────────────────────────────
  const detailRow = document.createElement('tr');
  detailRow.className = 'proyecto-detail-row';
  detailRow.innerHTML =
    `<td colspan="4"><div class="persona-detail-panel">
      <div class="detail-tabs">
        <button class="detail-tab active" data-tab="personas" onclick="switchDetailTab(this,'personas')">Personas</button>
        <button class="detail-tab"        data-tab="mensual"  onclick="switchDetailTab(this,'mensual')">Evolución mensual</button>
      </div>
      <div class="detail-tab-content" data-content="personas">${personaTableHtml}</div>
      <div class="detail-tab-content hidden" data-content="mensual">${mensualContent}</div>
    </div></td>`;

  tr.dataset.chartId = chartId;
  tr.after(detailRow);
  tr.classList.add('expanded');
  // Asegurar que el detalle quede visible
  requestAnimationFrame(() => detailRow.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
  if (months.length) {
    requestAnimationFrame(() => {
      const canvas = document.getElementById(chartId);
      if (!canvas || !window.Chart) return;
      _proyCharts[chartId] = new Chart(canvas, {
        type: 'bar',
        data: {
          labels: months.map(formatMonth),
          datasets: [{
            data: monthHours,
            backgroundColor: '#4F81BD99',
            borderColor: '#4F81BD',
            borderWidth: 1,
            borderRadius: 4
          }]
        },
        plugins: [ChartDataLabels],
        options: {
          responsive: true,
          layout: { padding: { top: 18 } },
          plugins: {
            legend: { display: false },
            datalabels: {
              anchor: 'end', align: 'end',
              font: { size: 10, weight: '600' },
              color: '#333',
              formatter: (_v, ctx) => pcts[ctx.dataIndex] + '%'
            },
            tooltip: {
              callbacks: {
                label: ctx => ` ${ctx.raw.toLocaleString('es-AR')} h  (${pcts[ctx.dataIndex]}%)`
              }
            }
          },
          scales: {
            y: { display: false },
            x: { grid: { display: false }, ticks: { font: { size: 11 } } }
          },
          onClick: (_ev, elements) => {
            if (!elements.length) return;
            const mon = months[elements[0].index];
            // Resaltar fila en la tabla
            detailRow.querySelectorAll('.tbl-monthly-row').forEach(r =>
              r.classList.toggle('row-highlight', r.dataset.month === mon)
            );
            // Cambiar al tab mensual si no está activo
            const panel = detailRow.querySelector('.persona-detail-panel');
            const tabBtn = panel.querySelector('[data-tab="mensual"]');
            if (tabBtn && !tabBtn.classList.contains('active')) switchDetailTab(tabBtn, 'mensual');
          }
        }
      });
    });
  }
}

async function guardarPersona() {
  const email = document.getElementById('pm-email').value;
  const body  = {
    email,
    centroCosto:       document.getElementById('pm-cc').value.trim(),
    funcion:           document.getElementById('pm-funcion').value.trim(),
    prodImproductivo:  document.getElementById('pm-prod').value,
    nombreNomina:      document.getElementById('pm-nomina').value.trim()
  };

  try {
    const res = await fetch('/api/personas', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error((await res.json()).error);

    // Actualizar cache y refrescar fila en la tabla sin recargar todo
    personasCache[email] = body;
    actualizarFilaPersona(email, body);
    cachedRange = null; // invalidar caché cliente: función/cc cambió
    cachedDetalle = [];
    cerrarModalPersona();
  } catch (err) {
    alert('Error al guardar: ' + err.message);
  }
}

function actualizarFilaPersona(email, datos) {
  const rows = document.querySelectorAll('#tbl-personas tbody tr');
  rows.forEach(tr => {
    if (tr.dataset.email === email) {
      const cells = tr.querySelectorAll('td');
      if (cells[1]) cells[1].textContent = datos.funcion || '–';
    }
  });
}

// ═══════════════════════════════════════════════════════════
// MAPPING EDITOR
// ═══════════════════════════════════════════════════════════

let mappingData = [];   // cache local de entradas
let editingKey  = null; // clave que está siendo editada

// ─── Cargar tabla de mapping ────────────────────────────
async function cargarMapping() {
  try {
    const res  = await fetch('/api/mapping/entries');
    mappingData = await res.json();
    renderTablaMapping(mappingData);
    // actualizar badge
    updateMappingBadge({ loaded: mappingData.length > 0, totalClaves: mappingData.length });
  } catch { /* silencioso */ }
}

function renderTablaMapping(entries) {
  const tbody = document.querySelector('#tbl-mapping tbody');
  if (!tbody) return;

  if (!entries.length) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--text-soft);padding:20px">
      Sin entradas. Usá "+ Nueva entrada" para agregar, o subí un Excel con el botón de arriba.
    </td></tr>`;
    return;
  }

  tbody.innerHTML = entries.map(e => {
    const prod = e['Prod / Improductivo'] || '';
    const chipClass = prod === 'Productivo' ? 'chip-prod'
                    : prod === 'Improductivo' ? 'chip-improd' : 'chip-none';
    const chipLabel = prod || '–';

    return `<tr data-key="${escHtml(e.clave)}">
      <td><strong>${escHtml(e.clave)}</strong></td>
      <td>${escHtml(e['Centro de Costo'] || '–')}</td>
      <td><span class="chip ${chipClass}">${escHtml(chipLabel)}</span></td>
      <td>${escHtml(e['Proyecto'] || '–')}</td>
      <td>${escHtml(e['Nombre'] || '–')}</td>
      <td>${escHtml(e['Funcion'] || '–')}</td>
      <td>${escHtml(e['Nombre nomina'] || '–')}</td>
      <td>
        <button class="btn-icon" title="Editar" onclick="abrirFormMapping('${escHtml(e.clave)}')">✏️</button>
        <button class="btn-icon del" title="Eliminar" onclick="eliminarEntradaMapping('${escHtml(e.clave)}')">🗑️</button>
      </td>
    </tr>`;
  }).join('');
}

// ─── Abrir formulario ───────────────────────────────────
function abrirFormMapping(clave) {
  const form = document.getElementById('mapping-form');
  form.classList.remove('hidden');

  if (clave) {
    // Modo edición: precargar valores
    const entry = mappingData.find(e => e.clave === clave);
    if (!entry) return;
    editingKey = clave;
    document.getElementById('fm-clave').value    = entry.clave;
    document.getElementById('fm-clave').disabled = true; // la clave no se cambia
    document.getElementById('fm-cc').value       = entry['Centro de Costo'] || '';
    document.getElementById('fm-prod').value     = entry['Prod / Improductivo'] || '';
    document.getElementById('fm-proyecto').value = entry['Proyecto'] || '';
    document.getElementById('fm-nombre').value   = entry['Nombre'] || '';
    document.getElementById('fm-funcion').value  = entry['Funcion'] || '';
    document.getElementById('fm-nomina').value   = entry['Nombre nomina'] || '';
  } else {
    // Modo nueva entrada
    editingKey = null;
    document.getElementById('fm-clave').value    = '';
    document.getElementById('fm-clave').disabled = false;
    document.getElementById('fm-cc').value       = '';
    document.getElementById('fm-prod').value     = '';
    document.getElementById('fm-proyecto').value = '';
    document.getElementById('fm-nombre').value   = '';
    document.getElementById('fm-funcion').value  = '';
    document.getElementById('fm-nomina').value   = '';
  }

  form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  document.getElementById('fm-clave').focus();
}

function cerrarFormMapping() {
  document.getElementById('mapping-form').classList.add('hidden');
  editingKey = null;
}

// ─── Guardar entrada ────────────────────────────────────
async function guardarEntradaMapping() {
  const clave = document.getElementById('fm-clave').value.trim();
  if (!clave) { alert('La clave del issue es requerida.'); return; }

  const body = {
    clave,
    'Centro de Costo':     document.getElementById('fm-cc').value.trim(),
    'Prod / Improductivo': document.getElementById('fm-prod').value,
    'Proyecto':            document.getElementById('fm-proyecto').value.trim(),
    'Nombre':              document.getElementById('fm-nombre').value.trim(),
    'Funcion':             document.getElementById('fm-funcion').value.trim(),
    'Nombre nomina':       document.getElementById('fm-nomina').value.trim()
  };

  try {
    const res = await fetch('/api/mapping/entry', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    cerrarFormMapping();
    await cargarMapping();
  } catch (err) {
    alert('Error al guardar: ' + err.message);
  }
}

// ─── Eliminar entrada ───────────────────────────────────
async function eliminarEntradaMapping(clave) {
  if (!confirm(`¿Eliminar la entrada "${clave}"?`)) return;
  try {
    const res = await fetch(`/api/mapping/entry/${encodeURIComponent(clave)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error((await res.json()).error);
    await cargarMapping();
  } catch (err) {
    alert('Error al eliminar: ' + err.message);
  }
}

// ═══════════════════════════════════════════════════════════
// ADMIN: Funciones por Persona (person_functions.json)
// ═══════════════════════════════════════════════════════════

const FUNCIONES_VALIDAS = ['DEV','QA','PM','UX','INFRA','VARIOS','STAFFING','DIR','CORP'];
let _fnData = {};  // nombre → función

async function abrirAdminFunciones() {
  try {
    const res = await fetch('/api/person-functions');
    _fnData = res.ok ? await res.json() : {};
  } catch { _fnData = {}; }
  renderTablaFunciones();
  document.getElementById('funciones-modal-backdrop').classList.remove('hidden');
  document.getElementById('funciones-modal').classList.remove('hidden');
  document.getElementById('fn-search').value = '';
}

function cerrarAdminFunciones() {
  document.getElementById('funciones-modal-backdrop').classList.add('hidden');
  document.getElementById('funciones-modal').classList.add('hidden');
}

function renderTablaFunciones(filtro = '') {
  const tbody = document.querySelector('#tbl-funciones tbody');
  if (!tbody) return;
  const entries = Object.entries(_fnData)
    .filter(([n]) => !filtro || n.toLowerCase().includes(filtro.toLowerCase()))
    .sort(([a], [b]) => a.localeCompare(b, 'es'));

  if (!entries.length) {
    tbody.innerHTML = '<tr><td colspan="3" style="text-align:center;color:var(--text-soft);padding:16px">Sin entradas</td></tr>';
    return;
  }
  tbody.innerHTML = entries.map(([nombre, fn]) => {
    const opts = FUNCIONES_VALIDAS.map(f =>
      `<option value="${f}"${f === fn ? ' selected' : ''}>${f}</option>`).join('');
    return `<tr>
      <td>${escHtml(nombre)}</td>
      <td>
        <select class="fn-select" data-nombre="${escHtml(nombre)}" onchange="guardarFuncion(this)">
          ${opts}
        </select>
      </td>
      <td>
        <button class="btn-icon del" title="Eliminar" onclick="eliminarFuncion('${escHtml(nombre)}')">🗑</button>
      </td>
    </tr>`;
  }).join('');
}

function filtrarTablaFunciones(q) {
  renderTablaFunciones(q);
}

async function guardarFuncion(select) {
  const nombre  = select.dataset.nombre;
  const funcion = select.value;
  try {
    const res = await fetch(`/api/person-functions/${encodeURIComponent(nombre)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ funcion })
    });
    if (!res.ok) throw new Error((await res.json()).error);
    _fnData[nombre] = funcion;
    setFnStatus(`✓ Guardado: ${nombre} → ${funcion}`);
    cachedRange = null; cachedDetalle = []; // invalidar caché cliente
  } catch (err) {
    setFnStatus(`⚠ Error: ${err.message}`);
    select.value = _fnData[nombre] || FUNCIONES_VALIDAS[0]; // revertir
  }
}

async function eliminarFuncion(nombre) {
  if (!confirm(`¿Eliminar la función de "${nombre}"?`)) return;
  try {
    const res = await fetch(`/api/person-functions/${encodeURIComponent(nombre)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error((await res.json()).error);
    delete _fnData[nombre];
    renderTablaFunciones(document.getElementById('fn-search')?.value || '');
    setFnStatus(`✓ Eliminado: ${nombre}`);
    cachedRange = null; cachedDetalle = [];
  } catch (err) {
    setFnStatus(`⚠ Error: ${err.message}`);
  }
}

function agregarFilaFuncion() {
  const nombre = prompt('Nombre exacto de la persona en Jira:');
  if (!nombre?.trim()) return;
  if (_fnData[nombre.trim()]) { setFnStatus(`Ya existe: ${nombre.trim()}`); return; }
  // Agregar temporalmente y luego guardar
  _fnData[nombre.trim()] = 'VARIOS';
  renderTablaFunciones(document.getElementById('fn-search')?.value || '');
  // Auto-guardar con valor por defecto
  fetch(`/api/person-functions/${encodeURIComponent(nombre.trim())}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ funcion: 'VARIOS' })
  }).then(() => setFnStatus(`✓ Agregado: ${nombre.trim()} → VARIOS`))
    .catch(err => setFnStatus(`⚠ Error: ${err.message}`));
}

function setFnStatus(msg) {
  const el = document.getElementById('fn-status');
  if (el) { el.textContent = msg; setTimeout(() => { el.textContent = ''; }, 4000); }
}

// ─── Helper: escapar HTML ───────────────────────────────
function escHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
