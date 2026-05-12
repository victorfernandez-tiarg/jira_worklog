/**
 * reportCache.js — Caché en memoria para reportes de worklogs.
 * TTL: 30 minutos. Permite encontrar hits por rango cubierto (sub-rangos).
 */

'use strict';

const TTL = 30 * 60 * 1000; // 30 min en ms
const _cache = new Map();    // 'from_to' → { from, to, data, ts }

/**
 * Busca una entrada cuyo rango cubra [from, to].
 * Ignora entradas expiradas.
 */
function find(from, to) {
  for (const entry of _cache.values()) {
    if (Date.now() - entry.ts > TTL) continue;
    if (from >= entry.from && to <= entry.to) return entry;
  }
  return null;
}

/** Guarda un resultado en caché. */
function set(from, to, data) {
  // Limpiar entradas expiradas antes de insertar
  for (const [key, entry] of _cache.entries()) {
    if (Date.now() - entry.ts > TTL) _cache.delete(key);
  }
  _cache.set(`${from}_${to}`, { from, to, data, ts: Date.now() });
}

/** Invalida toda la caché (llamar cuando cambia el mapping). */
function clear() {
  _cache.clear();
}

module.exports = { find, set, clear };
