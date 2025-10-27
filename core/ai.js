// core/ai.js
import OpenAI from 'openai';
import { config } from '../env.js';
import {
  wantsCatalog, wantsHuman, wantsLocation, wantsClose, wantsPrice,
  looksLikeFullName, detectDepartamento, detectSubzona, parseHectareas, CROP_OPTIONS
} from './intents.js';
import { searchProductByText } from './catalog.js';

const norm = (s='') => s.toString().trim().toLowerCase()
  .normalize('NFD').replace(/\p{Diacritic}/gu, '');

const openai = config.OPENAI_API_KEY ? new OpenAI({ apiKey: config.OPENAI_API_KEY }) : null;

// ---- cultivo
function detectCultivo(text) {
  const t = norm(text);
  for (const c of CROP_OPTIONS) {
    const cc = norm(c);
    if (t.includes(cc) || t === cc) return c;
  }
  if (/\bmaiz\b/.test(t)) return 'Maíz';
  if (/\bsoja|soya\b/.test(t)) return 'Soya';
  return null;
}

// ---- intents rápidas
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
  return /(pago|pagar|medios de pago|qr|transferencia|efectivo|tarjeta|factura)/i.test(t);
}
function wantsAdvice(text) {
  const t = norm(text);
  return /(recomend|consej|que me recomend|que usar|que producto|plaga|maleza|herbicida|insecticida|fungicida|chinche|trips|roya|mancha)/.test(t);
}
function addItemIntent(text) {
  const t = norm(text);
  const m = t.match(/(agrega|agregame|suma|sumame|anade|añade)\s+(\d+)\s+(de\s+)?(.+)/);
  if (m) return { qty: Number(m[2]), name: m[4] };
  return null;
}

// ---- slots por texto libre (heurístico)
export async function aiExtractFields(text = '', s = {}) {
  const out = {};
  if (looksLikeFullName(text)) out.nombre = text.trim();

  const dep = detectDepartamento(text); if (dep) out.departamento = dep;
  const sub = detectSubzona(text); if (sub) out.subzona = sub;
  const cult = detectCultivo(text); if (cult) out.cultivo = cult;

  const ha = parseHectareas(text); if (Number.isFinite(ha) || ha) out.hectareas = ha;
  if (/camp(_|a)?_?verano|\bverano\b/i.test(text)) out.campana = 'Verano';
  if (/camp(_|a)?_?invierno|\binvierno\b/i.test(text)) out.campana = 'Invierno';

  const ready = hasEnoughForQuoteLike({
    ...s,
    departamento: out.departamento ?? s.departamento,
    subzona: out.subzona ?? s.subzona,
    cultivo: out.cultivo ?? s.cultivo,
    hectareas: (out.hectareas ?? s.hectareas),
    campana: out.campana ?? s.campana,
    items: s.items || []
  });

  if (ready || wantsPrice(text) || wantsQuote(text)) out.intent = 'ready_to_quote';
  return out;
}

export function quickIntent(text = '') {
  const t = norm(text);
  if (/\b(catalogo|catálogo|ver productos|lista de precios)\b/.test(t)) return 'ask_catalog';
  if (/\b(asesor|humano|agente|hablar con alguien|soporte|llamar)\b/.test(t)) return 'handoff';
  return null;
}

export function shouldCloseNow(s) { return hasEnoughForQuoteLike(s); }

function hasEnoughForQuoteLike(s) {
  const base = s.departamento && s.cultivo && (s.hectareas !== null && s.hectareas !== undefined) && s.campana;
  const subOk = (s.departamento === 'Santa Cruz') ? !!(s.subzona) : true;
  const cartOk = s.items && s.items.length > 0;
  return (base && subOk) || (cartOk && s.departamento);
}

// ---- visión con OpenAI (buffer de imagen)
export async function aiIdentifyProductFromPhoto(buffer, catalog) {
  if (!openai) return { hit: false, reason: 'no_openai' };
  try {
    const b64 = buffer.toString('base64');
    const prompt = `
Eres experto en agroquímicos en Bolivia. Analiza la etiqueta.
Devuelve SOLO JSON:
{
  "is_agro": boolean,
  "label": "texto principal de la etiqueta",
  "notes": "breve",
  "category": "agroquimico|bebida|alimento|otro"
}`;

    const resp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      messages: [
        { role: 'system', content: 'Responde exclusivamente JSON válido.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } }
          ]
        }
      ]
    });

    const raw = resp.choices?.[0]?.message?.content?.trim() || '{}';
    let parsed; try { parsed = JSON.parse(raw); } catch { parsed = {}; }

    const label = String(parsed.label || '').trim();
    const isAgro = !!parsed.is_agro;
    const category = String(parsed.category || '').toLowerCase() || 'otro';

    if (!label) return { hit: false, label: '', category };
    const match = searchProductByText(catalog, label);
    if (isAgro && match) return { hit: true, product: match, label, category: 'agroquimico' };
    return { hit: false, label, category };
  } catch {
    return { hit: false, reason: 'vision_error' };
  }
}

// ---- decisor clásico (compat)
export async function aiDecide(message, session) {
  const actions = [];
  const t = message || '';

  if (wantsClose(t)) actions.push({ action: 'want_close' });
  if (wantsHuman(t)) actions.push({ action: 'want_human' });
  if (wantsCatalog(t)) actions.push({ action: 'want_catalog' });
  if (wantsLocation(t)) actions.push({ action: 'want_location' });

  if (wantsAdvice(t)) actions.push({ action: 'want_advice', value: t });
  if (wantsAvailability(t)) actions.push({ action: 'want_availability', value: t });
  if (wantsShipping(t)) actions.push({ action: 'want_shipping' });
  if (wantsPayment(t)) actions.push({ action: 'want_payment' });

  const add = addItemIntent(t);
  if (add) actions.push({ action: 'add_item', value: add });

  if (looksLikeFullName(t)) actions.push({ action: 'set_name', value: t.trim() });

  const dep = detectDepartamento(t); if (dep) actions.push({ action: 'set_departamento', value: dep });
  const sub = detectSubzona(t); if (sub) actions.push({ action: 'set_subzona', value: sub });
  const cult = detectCultivo(t); if (cult) actions.push({ action: 'set_cultivo', value: cult });

  const ha = parseHectareas(t);
  if (Number.isFinite(ha) || ha) actions.push({ action: 'set_hectareas', value: ha });

  if (/camp(_|a)?_?verano|\bverano\b/i.test(t)) actions.push({ action: 'set_campana', value: 'Verano' });
  if (/camp(_|a)?_?invierno|\binvierno\b/i.test(t)) actions.push({ action: 'set_campana', value: 'Invierno' });

  if (wantsPrice(t) || wantsQuote(t)) actions.push({ action: 'want_quote' });

  if (actions.length === 0) actions.push({ action: 'smalltalk' });
  return actions;
}
