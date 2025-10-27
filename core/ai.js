// core/ai.js
// "IA suave": devuelve ACCIONES a partir del mensaje + sesión.
// No depende de OpenAI. Usa heurísticas y tus detectores actuales.

import {
  wantsCatalog, wantsHuman, wantsLocation, wantsClose, wantsPrice,
  looksLikeFullName, detectDepartamento, detectSubzona, parseHectareas, CROP_OPTIONS
} from './intents.js';

const norm = (s='') => s.toString().trim().toLowerCase();

// Extrae cultivo si lo menciona
function detectCultivo(text) {
  const t = norm(text).normalize('NFD').replace(/\p{Diacritic}/gu,'');
  for (const c of CROP_OPTIONS) {
    const cc = c.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu,'');
    if (t.includes(cc) || t === cc) return c;
  }
  // sinónimo
  if (/\bmaiz\b/.test(t)) return 'Maíz';
  return null;
}

// Detecta "cotizar"
function wantsQuote(text) {
  const t = norm(text);
  return /(cotiza(r)?|pdf|presupuesto|enviame el pdf|armar pdf)/.test(t);
}

// Recolecta "acciones" a partir del texto
export async function aiDecide(message, session) {
  const actions = [];
  const t = message || '';

  // Atajos/utilidades (prioridad)
  if (wantsClose(t)) actions.push({ action: 'want_close' });
  if (wantsHuman(t)) actions.push({ action: 'want_human' });
  if (wantsCatalog(t)) actions.push({ action: 'want_catalog' });
  if (wantsLocation(t)) actions.push({ action: 'want_location' });

  // Datos (slots)
  if (looksLikeFullName(t)) actions.push({ action: 'set_name', value: t.trim() });

  const dep = detectDepartamento(t);
  if (dep) actions.push({ action: 'set_departamento', value: dep });

  const sub = detectSubzona(t);
  if (sub) actions.push({ action: 'set_subzona', value: sub });

  const cult = detectCultivo(t);
  if (cult) actions.push({ action: 'set_cultivo', value: cult });

  const ha = parseHectareas(t);
  if (Number.isFinite(ha)) actions.push({ action: 'set_hectareas', value: ha });

  if (/camp(_|a)?_?verano|\bverano\b/i.test(t)) actions.push({ action: 'set_campana', value: 'Verano' });
  if (/camp(_|a)?_?invierno|\binvierno\b/i.test(t)) actions.push({ action: 'set_campana', value: 'Invierno' });

  // Cierre
  if (wantsPrice(t) || wantsQuote(t)) actions.push({ action: 'want_quote' });

  // Si no detectamos nada útil: smalltalk para reencarrilar
  if (actions.length === 0) actions.push({ action: 'smalltalk' });

  return actions;
}
