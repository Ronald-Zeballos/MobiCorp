// wa/router.js
import express from 'express';
import { config } from '../env.js';
import { loadSession, saveSession } from '../core/session.js';
import { aiDecide } from '../core/ai.js';
import {
  wantsCatalog, wantsHuman, wantsLocation, wantsClose, wantsPrice,
  looksLikeFullName, detectDepartamento, detectSubzona, parseHectareas
} from '../core/intents.js';
import {
  btnsDepartamento, btnsSubzonaSCZ, btnsCultivos,
  btnsHectareas, btnsCampana, btnCotizar, summaryText
} from '../core/flow.js';
import {
  waSendText, waSendButtons, waUploadMediaFromFile, waSendDocument
} from './send.js';
import { parseCartFromText } from './parse.js';
import { buildQuote } from '../src/quote.js';
import { sheetsAppendFromSession } from '../src/sheets.js';

const router = express.Router();

// ------- Idempotencia (TTL 5 min) -------
const processed = new Map();
const TTL = 5 * 60 * 1000;
function seen(wamid) {
  const now = Date.now();
  for (const [k, v] of processed) if (now - v > TTL) processed.delete(k);
  if (processed.has(wamid)) return true;
  processed.set(wamid, now);
  return false;
}

// ------- Utils de orquestación (flujo abierto) -------
function hasEnoughForQuote(s) {
  const base = s.name && s.departamento && s.cultivo && (s.hectareas !== null && s.hectareas !== undefined) && s.campana;
  const subOk = (s.departamento === 'Santa Cruz') ? !!s.subzona : true;
  const cartOk = s.items && s.items.length > 0;
  return (base && subOk) || (cartOk && s.name && s.departamento);
}

function nextMissingSlot(s) {
  if (!s.name) return 'name';
  if (!s.departamento) return 'departamento';
  if (s.departamento === 'Santa Cruz' && !s.subzona) return 'subzona';
  if (!s.cultivo) return 'cultivo';
  if (s.hectareas === null || s.hectareas === undefined) return 'hectareas';
  if (!s.campana) return 'campana';
  return null;
}

async function askForSlot(to, slot) {
  switch (slot) {
    case 'name':
      return waSendText(to, '¿Cómo te llamas? (Nombre y apellido)');
    case 'departamento':
      return waSendButtons(to, 'Elegí tu *Departamento*:', btnsDepartamento());
    case 'subzona':
      return waSendButtons(to, 'Seleccioná tu *Subzona* en Santa Cruz:', btnsSubzonaSCZ());
    case 'cultivo':
      return waSendButtons(to, 'Seleccioná tu *Cultivo*:', btnsCultivos());
    case 'hectareas':
      await waSendButtons(to, '¿Cuántas *Hectáreas*?', btnsHectareas());
      return waSendText(to, 'También podés escribir la cantidad (por ejemplo: 120).');
    case 'campana':
      return waSendButtons(to, '¿Para qué *Campaña*?', btnsCampana());
    default:
      return null;
  }
}

function applyActionToSession(s, a) {
  switch (a.action) {
    case 'set_name': if (!s.name && looksLikeFullName(a.value)) s.name = a.value; break;
    case 'set_departamento': {
      const dep = detectDepartamento(a.value) || a.value;
      if (dep) { s.departamento = dep; if (dep !== 'Santa Cruz') s.subzona = s.subzona || null; }
      break;
    }
    case 'set_subzona': {
      const sub = detectSubzona(a.value) || a.value;
      if (sub) s.subzona = sub;
      break;
    }
    case 'set_cultivo': s.cultivo = a.value; break;
    case 'set_hectareas': {
      const h = parseHectareas(String(a.value));
      if (Number.isFinite(h)) s.hectareas = h;
      break;
    }
    case 'set_campana': s.campana = a.value; break;
    // add_cart_items lo manejamos afuera con parseCartFromText
  }
}

// ------- GET /wa/webhook (verify) -------
router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === config.VERIFY_TOKEN) {
    if (config.DEBUG_LOGS) console.log('[META] Verify OK');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ------- POST /wa/webhook (messages) -------
router.post('/webhook', async (req, res) => {
  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const msg = value?.messages?.[0];
    if (!msg) return res.sendStatus(200);

    const wamid = msg.id;
    if (seen(wamid)) return res.sendStatus(200);

    const fromId = msg.from;
    const type = msg.type;
    const profileName = value?.contacts?.[0]?.profile?.name;

    let s = loadSession(fromId);
    s.lastWamid = wamid;
    s.stage = s.stage || 'discovery';

    // Pausa por asesor humano
    if (s.pausedUntil && Date.now() < s.pausedUntil) {
      if (/bot|continuar|reanudar/i.test(msg?.text?.body || '')) {
        s.pausedUntil = 0;
        await waSendText(fromId, '🤖 He vuelto. Continuemos con tu solicitud.');
      } else {
        await waSendText(fromId, '🧑‍💼 Derivado a asesor. Escribe "continuar" para volver con el bot.');
        saveSession(fromId, s);
        return res.sendStatus(200);
      }
    }

    // Normalizar entrada
    let incomingText = '';
    if (type === 'text') incomingText = msg.text?.body || '';
    if (type === 'interactive') {
      const n = msg.interactive?.button_reply || msg.interactive?.list_reply;
      if (n?.id) incomingText = n.id;
    }
    if (type === 'button') incomingText = msg.button?.text || msg.button?.payload || '';
    if (type === 'location') {
      s.userLocation = { lat: msg.location?.latitude, lng: msg.location?.longitude };
      await waSendText(fromId, '📍 ¡Gracias! Guardé tu ubicación para la cotización.');
    }
    if (config.DEBUG_LOGS) console.log('[IN <-]', type, incomingText);

    // 0) Atajos globales inmediatos
    if (wantsCatalog(incomingText)) {
      await waSendText(fromId, `🛒 Catálogo: ${config.CATALOG_URL || 'No disponible'}`);
    }
    if (wantsLocation(incomingText)) {
      if (config.STORE_LAT && config.STORE_LNG) {
        await waSendText(fromId, `📍 Estamos aquí: https://www.google.com/maps?q=${config.STORE_LAT},${config.STORE_LNG}`);
      } else {
        await waSendText(fromId, '📍 Nuestra ubicación estará disponible pronto.');
      }
    }
    if (wantsHuman(incomingText)) {
      s.pausedUntil = Date.now() + 4 * 60 * 60 * 1000; // 4h
      await waSendText(fromId, '🧑‍💼 Te conectamos con un asesor. El bot se pausará por 4 horas.');
      saveSession(fromId, s);
      return res.sendStatus(200);
    }
    if (wantsClose(incomingText)) {
      s.stage = 'closed';
      await waSendText(fromId, '✅ Conversación finalizada. ¡Gracias por contactarnos!');
      saveSession(fromId, s);
      return res.sendStatus(200);
    }

    // 1) Carrito pegado (atajo a checkout)
    if (type === 'text' && !/dep_|sub_|crop_|ha_|camp_|do_quote/.test(incomingText)) {
      const cart = parseCartFromText(incomingText);
      if (cart?.items?.length) {
        s.items = cart.items;
        s.stage = 'checkout';
      }
    }

    // 2) IA suave: decidir acciones
    const actions = await aiDecide(incomingText, s);
    for (const a of actions) applyActionToSession(s, a);

    // 3) Respuestas utilitarias (ya priorizadas arriba, pero por si vinieron por IA)
    if (actions.some(a => a.action === 'want_catalog')) {
      await waSendText(fromId, `🛒 Catálogo: ${config.CATALOG_URL || 'No disponible'}`);
    }
    if (actions.some(a => a.action === 'want_location')) {
      if (config.STORE_LAT && config.STORE_LNG) {
        await waSendText(fromId, `📍 Estamos aquí: https://www.google.com/maps?q=${config.STORE_LAT},${config.STORE_LNG}`);
      } else {
        await waSendText(fromId, '📍 Nuestra ubicación estará disponible pronto.');
      }
    }
    if (actions.some(a => a.action === 'want_human')) {
      s.pausedUntil = Date.now() + 4 * 60 * 60 * 1000;
      await waSendText(fromId, '🧑‍💼 Te conectamos con un asesor. El bot se pausará por 4 horas.');
      saveSession(fromId, s);
      return res.sendStatus(200);
    }
    if (actions.some(a => a.action === 'want_close')) {
      s.stage = 'closed';
      await waSendText(fromId, '✅ Conversación finalizada. ¡Gracias por contactarnos!');
      saveSession(fromId, s);
      return res.sendStatus(200);
    }

    // 4) ¿Listo para cotizar?
    const ready = hasEnoughForQuote(s) || actions.some(a => a.action === 'want_quote') || wantsPrice(incomingText);
    if (ready) {
      s.stage = 'checkout';
      await waSendText(fromId, `${summaryText(s)}\n\n¿Generamos tu PDF de cotización?`);
      await waSendButtons(fromId, 'Generar PDF de cotización', btnCotizar());
      saveSession(fromId, s);
      return res.sendStatus(200);
    }

    // 5) Si falta algo, pedí SOLO lo que falta (flujo abierto)
    const missing = nextMissingSlot(s);
    if (missing) {
      await askForSlot(fromId, missing);
    } else {
      // Smalltalk / sin cambios: reencarrilar amablemente
      if (actions.some(a => a.action === 'smalltalk')) {
        await waSendText(fromId, '🙂 Te escucho. Si querés, puedo ir preparando tu cotización. ¿Definimos *Campaña*?');
        await waSendButtons(fromId, 'Elegí *Campaña*:', btnsCampana());
      }
    }

    saveSession(fromId, s);
    res.sendStatus(200);
  } catch (e) {
    console.error('[WEBHOOK] Error:', e);
    res.sendStatus(200);
  }
});

export default router;
