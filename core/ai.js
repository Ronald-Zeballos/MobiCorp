// core/ai.js
import {
  wantsCatalog, wantsHuman, wantsLocation, wantsClose, wantsPrice,
  looksLikeFullName, detectDepartamento, detectSubzona, parseHectareas, CROP_OPTIONS
} from './intents.js';

const norm = (s='') => s.toString().trim().toLowerCase()
  .normalize('NFD').replace(/\p{Diacritic}/gu, '');

function detectCultivo(text) {
  const t = norm(text);
  for (const c of CROP_OPTIONS) {
    const cc = norm(c);
    if (t.includes(cc) || t === cc) return c;
  }
  if (/\bmaiz\b/.test(t)) return 'Maíz';
  return null;
}

function wantsQuote(text) {
  const t = norm(text);
  return /(cotiza|cotizame|presupuesto|pdf|precio|cuanto sale|cuánto sale)/.test(t);
}
function wantsAvailability(text) {
  const t = norm(text);
  return /(tiene(n)?|hay|maneja(n)?|trabaja(n)?|disponible|stock)/.test(t);
}
function wantsShipping(text) {
  const t = norm(text);
  return /(envio|envio(s)?|envian|envían|entrega|delivery|mandan)/.test(t);
}
function wantsPayment(text) {
  const t = norm(text);
  return /(pago|pagar|medios de pago|qr|transferencia|efectivo|tarjeta|factura)/.test(t);
}
function addItemIntent(text) {
  const t = norm(text);
  const m = t.match(/(agrega|agregame|suma|sumame|anade|añade)\s+(\d+)\s+(de\s+)?(.+)/);
  if (m) return { qty: Number(m[2]), name: m[4] };
  return null;
}

export async function aiDecide(message, session) {
  const actions = [];
  const t = message || '';

  // Atajos/utilidades
  if (wantsClose(t)) actions.push({ action: 'want_close' });
  if (wantsHuman(t)) actions.push({ action: 'want_human' });
  if (wantsCatalog(t)) actions.push({ action: 'want_catalog' });
  if (wantsLocation(t)) actions.push({ action: 'want_location' });

  if (wantsAvailability(t)) actions.push({ action: 'want_availability', value: t });
  if (wantsShipping(t)) actions.push({ action: 'want_shipping' });
  if (wantsPayment(t)) actions.push({ action: 'want_payment' });

  const add = addItemIntent(t);
  if (add) actions.push({ action: 'add_item', value: add });

  // Slots
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

  if (actions.length === 0) actions.push({ action: 'smalltalk' });
  return actions;
}
