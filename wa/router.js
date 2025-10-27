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
  waSendText, waSendButtons, waUploadMediaFromFile, waSendDocument, waSendImage
} from './send.js';
import { parseCartFromText } from './parse.js';
import { buildQuote } from '../src/quote.js';
import { sheetsAppendFromSession } from '../src/sheets.js';
import { loadCatalog, searchProductByText, getImagePathForName } from '../core/catalog.js';

const router = express.Router();
const catalog = loadCatalog();

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
    case 'add_item': {
      const { qty, name } = a.value || {};
      if (!name) break;
      s.items = s.items || [];
      s.items.push({ name, qty: Number(qty) || 1, price: null });
      break;
    }
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
    s.items = s.items || [];

    // Pausa por asesor humano
    if (s.pausedUntil && Date.now() < s.pausedUntil) {
      if (/bot|continuar|reanudar/i.test(msg?.text?.body || '')) {
        s.pausedUntil = 0;
        await waSendText(fromId, '🤖 ¡Aquí estoy de vuelta! Sigamos con tu cotización.');
      } else {
        await waSendText(fromId, '🧑‍💼 Te derivé con un asesor. Escribí "continuar" para volver conmigo.');
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

    // (NUEVO) Imagen: intentar reconocer por caption contra catálogo
    if (type === 'image') {
      const caption = msg.image?.caption || '';
      if (caption) {
        const found = searchProductByText(catalog, caption);
        if (found) {
          s.items.push({ name: found.name, qty: 1, price: null });
          await waSendText(fromId, `🖼️ Perfecto, identifiqué *${found.name}*. Lo agrego a tu cotización.`);
          // opcional: reenviar la misma imagen de nuestro catálogo para confirmar
          const mediaId = await waUploadMediaFromFile(found.file, 'image/jpeg', `${found.name}.jpg`);
          if (mediaId) await waSendImage(fromId, mediaId, `Confirmación: ${found.name}`);
        } else {
          await waSendText(fromId, 'Recibí la imagen. ¿Me confirmás el nombre del producto para agregarlo a la cotización?');
        }
      } else {
        await waSendText(fromId, 'Recibí la imagen. Si me escribís el nombre del producto, lo agrego a tu cotización 😉');
      }
    }

    if (config.DEBUG_LOGS) console.log('[IN <-]', type, incomingText);

    // Atajos utilitarios inmediatos
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
      await waSendText(fromId, '🧑‍💼 Te conecto con un asesor. Pauso el bot por 4 horas. Para volver escribí "continuar".');
      saveSession(fromId, s);
      return res.sendStatus(200);
    }
    if (wantsClose(incomingText)) {
      s.stage = 'closed';
      await waSendText(fromId, '✅ Conversación finalizada. ¡Gracias por contactarnos!');
      saveSession(fromId, s);
      return res.sendStatus(200);
    }

    // Carrito pegado (texto con viñetas)
    if (type === 'text' && !/dep_|sub_|crop_|ha_|camp_|do_quote/.test(incomingText)) {
      const cart = parseCartFromText(incomingText);
      if (cart?.items?.length) {
        s.items = s.items.concat(cart.items);
        s.stage = 'checkout';
      }
    }

    // IA suave: acciones
    const actions = await aiDecide(incomingText, s);
    for (const a of actions) applyActionToSession(s, a);

    // Acciones utilitarias (por IA)
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
      await waSendText(fromId, '🧑‍💼 Te conecto con un asesor y pauso el bot por 4 horas. Para volver conmigo, escribí "continuar".');
      saveSession(fromId, s);
      return res.sendStatus(200);
    }
    if (actions.some(a => a.action === 'want_close')) {
      s.stage = 'closed';
      await waSendText(fromId, '✅ Conversación finalizada. ¡Gracias por contactarnos!');
      saveSession(fromId, s);
      return res.sendStatus(200);
    }

    // Disponibilidad por texto (consultar catálogo)
    if (actions.some(a => a.action === 'want_availability')) {
      const query = actions.find(a => a.action === 'want_availability')?.value || '';
      const found = searchProductByText(catalog, query);
      if (found) {
        s.items.push({ name: found.name, qty: 1, price: null });
        await waSendText(fromId, `Sí, contamos con *${found.name}*. Lo agrego a tu cotización 👌`);
        const mediaId = await waUploadMediaFromFile(found.file, 'image/jpeg', `${found.name}.jpg`);
        if (mediaId) await waSendImage(fromId, mediaId, found.name);
      } else {
        await waSendText(fromId, 'Podría estar con otro nombre. ¿Me pasás cómo figura el producto? O mandá una foto :)');
      }
    }

    // Envíos / Pago (responder breve y reencarrilar)
    if (actions.some(a => a.action === 'want_shipping')) {
      await waSendText(fromId, '🚚 Sí, hacemos envíos. Para estimar costo y plazo, ¿en qué *Departamento* estás?');
      await waSendButtons(fromId, 'Elegí tu *Departamento*:', btnsDepartamento());
    }
    if (actions.some(a => a.action === 'want_payment')) {
      await waSendText(fromId, '💳 Aceptamos efectivo, QR y transferencia. ¿Querés que avance con tu cotización?');
    }

    // ¿Listo para cotizar?
    const ready = hasEnoughForQuote(s) || actions.some(a => a.action === 'want_quote') || wantsPrice(incomingText);
    if (ready) {
      s.stage = 'checkout';
      await waSendText(fromId, `${summaryText(s)}\n\n¿Generamos tu PDF de cotización?`);
      await waSendButtons(fromId, 'Generar PDF de cotización', btnCotizar());
      saveSession(fromId, s);
      return res.sendStatus(200);
    }

    // Si falta algo, pedir SOLO lo faltante
    const missing = nextMissingSlot(s);
    if (missing) {
      // tono amable y vendedor
      switch (missing) {
        case 'departamento':
          await waSendText(fromId, 'Para darte el mejor precio con envío, decime tu *Departamento* 😊');
          break;
        case 'hectareas':
          await waSendText(fromId, 'Anotá cuántas *Hectáreas* trabajás. Podés escribir el número.');
          break;
        default:
          // cae en askForSlot
          break;
      }
      await askForSlot(fromId, missing);
    } else {
      if (actions.some(a => a.action === 'smalltalk')) {
        await waSendText(fromId, '🙂 Te leo. Si querés, ya te preparo el PDF. ¿Vamos con *Campaña* o directo a *Cotizar*?');
        await waSendButtons(fromId, 'Elegí *Campaña* o Cotizar:', [
          { id: 'camp_verano', title: 'Verano' },
          { id: 'camp_invierno', title: 'Invierno' },
          { id: 'do_quote', title: '🧾 Cotizar' }
        ]);
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
