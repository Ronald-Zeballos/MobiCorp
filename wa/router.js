// wa/router.js
import express from 'express';
import { config } from '../env.js';
import { loadSession, saveSession } from '../core/session.js';
import { aiDecide } from '../core/ai.js';
import {
  wantsCatalog, wantsHuman, wantsLocation, wantsClose, wantsPrice,
  looksLikeFullName, detectDepartamento, detectSubzona, parseHectareas,
  DEPARTAMENTOS, SUBZONAS_SCZ
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
import { loadCatalog, searchProductByText, findProductBySlug, slugify } from '../core/catalog.js';
import { getAdvice } from '../core/faq.js';

const router = express.Router();
const catalog = loadCatalog();

// =========================
// Idempotencia (TTL 5 min)
// =========================
const processed = new Map();
const TTL = 5 * 60 * 1000;
function seen(wamid) {
  const now = Date.now();
  for (const [k, v] of processed) if (now - v > TTL) processed.delete(k);
  if (processed.has(wamid)) return true;
  processed.set(wamid, now);
  return false;
}

// ===============
// Utilidades
// ===============
const normalize = (s = '') =>
  s.normalize('NFD').replace(/\p{Diacritic}+/gu, '').toLowerCase().trim();

function isMenuCommand(t = '') {
  return /\b(volver|menu|menú|inicio|principal)\b/i.test(t || '');
}

function exitModes(s) {
  s.mode = null;
}

// Detectar cultivo por texto libre
function detectCropFromText(text) {
  const n = normalize(text);
  if (/\b(soja|soya)\b/.test(n)) return 'Soya';
  if (/\b(maiz|maiz|maíz)\b/.test(n)) return 'Maíz';
  if (/\b(trigo)\b/.test(n)) return 'Trigo';
  if (/\b(arroz)\b/.test(n)) return 'Arroz';
  if (/\b(girasol)\b/.test(n)) return 'Girasol';
  return null;
}

function goHome(to, s) {
  exitModes(s);
  s.awaitingSlot = null;
  s.awaitingAt = 0;
  s.slotRetries = {}; // reset
  waSendText(
    to,
    '🏠 Volvimos al menú principal. Decime si querés *Cotizar*, ver *Catálogo* o hacer *Preguntas/Dudas*.'
  );
  return waSendButtons(to, 'Puedo ayudarte con:', [
    { id: 'btn_quote', title: '🧾 Cotizar' },
    { id: 'btn_catalog', title: 'Catálogo' },
    { id: 'btn_faq', title: 'Preguntas / Dudas' },
    { id: 'btn_human', title: 'Hablar con asesor' }
  ]);
}

// ================================
// Orquestación (flujo conversado)
// ================================
function hasEnoughForQuote(s) {
  const base = s.departamento && s.cultivo && (s.hectareas !== null && s.hectareas !== undefined) && s.campana;
  const subOk = (s.departamento === 'Santa Cruz') ? !!(s.subzona) : true;
  const cartOk = s.items && s.items.length > 0;
  return (base && subOk) || (cartOk && s.departamento);
}

function nextMissingSlot(s) {
  if (!s.cultivo) return 'cultivo';
  if (s.hectareas === null || s.hectareas === undefined) return 'hectareas';
  if (!s.campana) return 'campana';
  if (!s.departamento) return 'departamento';
  if (s.departamento === 'Santa Cruz' && !s.subzona) return 'subzona';
  return null; // nombre al final
}

// cool-down y contadores para evitar loops
function shouldAskSlot(s, slot) {
  s.slotRetries = s.slotRetries || {};
  const now = Date.now();
  if (s.awaitingSlot === slot && s.awaitingAt && (now - s.awaitingAt) < 20000) {
    return false; // menos de 20s desde el último pedido del mismo slot
  }
  s.awaitingSlot = slot;
  s.awaitingAt = now;
  s.slotRetries[slot] = s.slotRetries[slot] || 0;
  return true;
}
function bumpRetryAndMaybeOfferMenu(to, s, slot) {
  s.slotRetries = s.slotRetries || {};
  s.slotRetries[slot] = (s.slotRetries[slot] || 0) + 1;
  // Tras 2 intentos, ofrecer menú en vez de insistir:
  if (s.slotRetries[slot] >= 2) {
    waSendText(to, '🙂 Si preferís, escribí *volver* para regresar al menú, o elegí una opción debajo:');
    return goHome(to, s);
  }
  return null;
}

async function askForSlot(to, slot, s) {
  if (!shouldAskSlot(s, slot)) return; // evitar spam
  s.hinted = s.hinted || {};
  const hint = s.hinted[slot] ? '' : '\nSi te equivocaste, escribí *volver* para ir al menú.';
  s.hinted[slot] = true;

  switch (slot) {
    case 'cultivo':
      return waSendButtons(to, `¿Para qué *cultivo* es? Elegí una opción:${hint}`, btnsCultivos());
    case 'hectareas':
      await waSendButtons(to, `¿Cuántas *hectáreas* vas a trabajar?${hint}`, btnsHectareas());
      return waSendText(to, 'También podés escribir el número (ej: 120).');
    case 'campana':
      return waSendButtons(to, `¿Para qué *campaña*?${hint}`, btnsCampana());
    case 'departamento':
      return waSendButtons(to, `¿En qué *Departamento* estás?${hint}`, btnsDepartamento());
    case 'subzona':
      return waSendButtons(to, `Seleccioná tu *Subzona* en Santa Cruz:${hint}`, btnsSubzonaSCZ());
  }
}

function applyActionToSession(s, a) {
  switch (a.action) {
    case 'set_name':
      if (!s.name && looksLikeFullName(a.value)) s.name = a.value;
      break;
    case 'set_departamento': {
      const dep = detectDepartamento(a.value) || a.value;
      if (dep) { s.departamento = dep; if (dep !== 'Santa Cruz') s.subzona = s.subzona || null; s.awaitingSlot = null; s.awaitingAt = 0; }
      break;
    }
    case 'set_subzona': {
      const sub = detectSubzona(a.value) || a.value;
      if (sub) { s.subzona = sub; s.awaitingSlot = null; s.awaitingAt = 0; }
      break;
    }
    case 'set_cultivo':
      s.cultivo = a.value; s.awaitingSlot = null; s.awaitingAt = 0; break;
    case 'set_hectareas': {
      const h = parseHectareas(String(a.value));
      if (Number.isFinite(h)) { s.hectareas = h; s.awaitingSlot = null; s.awaitingAt = 0; }
      break;
    }
    case 'set_campana':
      s.campana = a.value; s.awaitingSlot = null; s.awaitingAt = 0; break;
    case 'add_item': {
      const { qty, name } = a.value || {};
      if (!name) break;
      s.items = s.items || [];
      s.items.push({ name, qty: Number(qty) || 1, price: null });
      break;
    }
  }
}

// ===========================
// GET /wa/webhook (verify)
// ===========================
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

// ============================
// POST /wa/webhook (messages)
// ============================
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

    let s = loadSession(fromId);
    s.lastWamid = wamid;
    s.stage = s.stage || 'discovery';
    s.items = s.items || [];

    // Pausa por asesor humano
    if (s.pausedUntil && Date.now() < s.pausedUntil) {
      const txt = msg?.text?.body || '';
      if (/bot|continuar|reanudar/i.test(txt)) {
        s.pausedUntil = 0;
        await waSendText(fromId, '🤖 ¡Aquí estoy de vuelta! Sigamos con tu cotización.');
      } else {
        await waSendText(fromId, '🧑‍💼 Estás con un asesor. Escribí "continuar" para volver conmigo.');
        saveSession(fromId, s);
        return res.sendStatus(200);
      }
    }

    // Saludo
    if (!s.greeted) {
      s.greeted = true;
      await waSendText(
        fromId,
        '👋 ¡Bienvenido/a a *NewChem Agroquímicos*! Contame, ¿qué necesitás hoy?\n' +
        'Podés escribirme el producto, pegar tu lista, o mandarme una foto con el nombre. ' +
        'Si querés regresar al menú, escribí *volver*.'
      );
      await waSendButtons(fromId, 'Puedo ayudarte con:', [
        { id: 'btn_quote', title: '🧾 Cotizar' },
        { id: 'btn_catalog', title: 'Catálogo' },
        { id: 'btn_faq', title: 'Preguntas / Dudas' },
        { id: 'btn_human', title: 'Hablar con asesor' }
      ]);
      saveSession(fromId, s);
      return res.sendStatus(200);
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

    // Comando menú
    if (isMenuCommand(incomingText)) {
      await goHome(fromId, s);
      saveSession(fromId, s);
      return res.sendStatus(200);
    }

    // Botones
    if (incomingText === 'btn_catalog') {
      exitModes(s);
      await waSendText(fromId, `🛒 Catálogo: ${config.CATALOG_URL || 'No disponible'}`);
      await waSendText(fromId, 'Decime qué producto te interesa y te lo cotizo 😉\nEscribí *volver* para regresar al menú.');
      saveSession(fromId, s);
      return res.sendStatus(200);
    }
    if (incomingText === 'btn_human') {
      s.pausedUntil = Date.now() + 4 * 60 * 60 * 1000;
      await waSendText(fromId, '🧑‍💼 Te conecto con un asesor ahora mismo.');
      await waSendText(fromId, '📞 +591 65900645\n👉 https://wa.me/59165900645');
      await waSendText(fromId, 'Para volver conmigo en cualquier momento, escribí *continuar*.');
      saveSession(fromId, s);
      return res.sendStatus(200);
    }
    if (incomingText === 'btn_quote') {
      exitModes(s);
      const missing = nextMissingSlot(s) || 'cultivo';
      await waSendText(fromId, '¡Perfecto! Armemos tu cotización rápido 😊');
      await askForSlot(fromId, missing, s);
      saveSession(fromId, s);
      return res.sendStatus(200);
    }
    if (incomingText === 'btn_faq') {
      s.mode = 'faq';
      await waSendText(fromId,
        'Genial, contame tu consulta (ej: "¿qué herbicida para soja?", "me atacan chinches", "¿qué me recomendás?").\n' +
        'Cuando quieras regresar al menú, escribí *volver*.'
      );
      saveSession(fromId, s);
      return res.sendStatus(200);
    }

    // Dep/Sub
    if (incomingText?.startsWith?.('dep_')) {
      const idx = Number(incomingText.split('_')[1]);
      const dep = DEPARTAMENTOS[idx];
      if (dep) {
        s.departamento = dep;
        if (dep === 'Santa Cruz') {
          await waSendButtons(fromId, 'Seleccioná tu *Subzona* en Santa Cruz:', btnsSubzonaSCZ());
        } else {
          await waSendButtons(fromId, 'Genial. ¿Para qué *Cultivo* es?', btnsCultivos());
          s.stage = 'product';
        }
        s.awaitingSlot = null; s.awaitingAt = 0;
        saveSession(fromId, s);
        return res.sendStatus(200);
      }
    }
    if (incomingText?.startsWith?.('sub_')) {
      const idx = Number(incomingText.split('_')[1]);
      const sub = SUBZONAS_SCZ[idx];
      if (sub) {
        s.subzona = sub;
        await waSendButtons(fromId, 'Perfecto. ¿Qué *Cultivo* vas a trabajar?', btnsCultivos());
        s.stage = 'product';
        s.awaitingSlot = null; s.awaitingAt = 0;
        saveSession(fromId, s);
        return res.sendStatus(200);
      }
    }

    // Cultivo/HA/Campaña
    if (incomingText?.startsWith?.('crop_')) {
      const id = incomingText.split('_')[1] || '';
      const map = { soya: 'Soya', maiz: 'Maíz', trigo: 'Trigo', arroz: 'Arroz', girasol: 'Girasol', otro: 'Otro' };
      const cult = map[id];
      if (cult) {
        s.cultivo = cult;
        s.awaitingSlot = null; s.awaitingAt = 0;
        exitModes(s);
        await waSendButtons(fromId, '¿Cuántas *hectáreas* vas a trabajar?', btnsHectareas());
        saveSession(fromId, s);
        return res.sendStatus(200);
      }
    }
    if (incomingText?.startsWith?.('ha_')) {
      const val = incomingText.slice(3);
      const num = Number(val.replace(/[^\d]/g, ''));
      if (Number.isFinite(num) && num > 0) { s.hectareas = num; s.awaitingSlot = null; s.awaitingAt = 0; }
      exitModes(s);
      await waSendButtons(fromId, '¿Para qué *campaña*?', btnsCampana());
      saveSession(fromId, s);
      return res.sendStatus(200);
    }
    if (incomingText?.startsWith?.('camp_')) {
      const id = incomingText.split('_')[1] || '';
      s.campana = (id === 'verano') ? 'Verano' : (id === 'invierno') ? 'Invierno' : null;
      if (s.campana) {
        s.awaitingSlot = null; s.awaitingAt = 0;
        exitModes(s);
        if (!s.departamento) {
          await waSendButtons(fromId, '¿En qué *Departamento* estás?', btnsDepartamento());
        } else {
          s.stage = 'checkout';
          await waSendText(fromId, `${summaryText(s)}\n\n¿Generamos tu PDF de cotización?`);
          await waSendButtons(fromId, '¿Listo para *Cotizar*?', btnCotizar());
        }
        saveSession(fromId, s);
        return res.sendStatus(200);
      }
    }

    // add_ desde FAQ
    if (incomingText?.startsWith?.('add_')) {
      const slug = incomingText.slice(4);
      const p = findProductBySlug(catalog, slug);
      if (p) {
        s.items.push({ name: p.name, qty: 1, price: null });
        exitModes(s);
        await waSendText(fromId, `🛒 Agregué *${p.name}* a tu cotización.`);
        s.stage = s.stage || 'product';
        if (!s.cultivo) await waSendButtons(fromId, '¿Para qué *cultivo* es?', btnsCultivos());
        else if (s.hectareas == null) await waSendButtons(fromId, '¿Cuántas *hectáreas*?', btnsHectareas());
        else if (!s.campana) await waSendButtons(fromId, '¿Para qué *campaña*?', btnsCampana());
        else {
          s.stage = 'checkout';
          await waSendText(fromId, `${summaryText(s)}\n\n¿Generamos tu PDF de cotización?`);
          await waSendButtons(fromId, '¿Listo para *Cotizar*?', btnCotizar());
        }
        saveSession(fromId, s);
        return res.sendStatus(200);
      }
    }

    // Imagen → reconocer por caption
    if (type === 'image') {
      const caption = msg.image?.caption || '';
      if (config.DEBUG_LOGS) console.log('[IMG] caption:', caption);
      if (caption) {
        const found = searchProductByText(catalog, caption);
        if (found) {
          s.items.push({ name: found.name, qty: 1, price: null });
          await waSendText(fromId, `🖼️ Identifiqué *${found.name}*. Lo agrego a tu cotización.`);
          s.stage = s.stage || 'product';
        } else {
          await waSendText(fromId, 'Recibí la imagen. Para reconocer el producto, escribime el *nombre* tal como figura en el envase (o en nuestro catálogo).');
        }
      } else {
        await waSendText(fromId, 'Recibí la imagen. Escribime el *nombre del producto* y lo agrego 😉');
      }
      saveSession(fromId, s);
      return res.sendStatus(200);
    }

    // Atajos globales
    if (wantsCatalog(incomingText)) {
      await waSendText(fromId, `🛒 Catálogo: ${config.CATALOG_URL || 'No disponible'}`);
      await waSendText(fromId, 'Decime qué producto te interesa y te lo cotizo 😉\nEscribí *volver* para regresar al menú.');
      saveSession(fromId, s);
      return res.sendStatus(200);
    }
    if (wantsLocation(incomingText)) {
      if (config.STORE_LAT && config.STORE_LNG) {
        await waSendText(fromId, `📍 Estamos aquí: https://www.google.com/maps?q=${config.STORE_LAT},${config.STORE_LNG}`);
      } else {
        await waSendText(fromId, '📍 Nuestra ubicación estará disponible pronto.');
      }
      saveSession(fromId, s);
      return res.sendStatus(200);
    }
    if (wantsHuman(incomingText)) {
      s.pausedUntil = Date.now() + 4 * 60 * 60 * 1000;
      await waSendText(fromId, '🧑‍💼 Te conecto con un asesor.');
      await waSendText(fromId, '📞 +591 65900645\n👉 https://wa.me/59165900645');
      await waSendText(fromId, 'Para volver conmigo, escribí *continuar*.');
      saveSession(fromId, s);
      return res.sendStatus(200);
    }
    if (wantsClose(incomingText)) {
      s.stage = 'closed';
      await waSendText(fromId, '✅ Conversación finalizada. ¡Gracias por contactarnos!');
      saveSession(fromId, s);
      return res.sendStatus(200);
    }

    // Carrito pegado
    if (type === 'text' && !/^(dep_|sub_|crop_|ha_|camp_|do_quote|add_)/.test(incomingText)) {
      const cart = parseCartFromText(incomingText);
      if (cart?.items?.length) {
        s.items = s.items.concat(cart.items);
        s.stage = 'checkout';
      }
    }

    // IA suave
    const actions = await aiDecide(incomingText, s);
    for (const a of actions) applyActionToSession(s, a);

    if (actions.some(a => a.action === 'want_catalog')) {
      await waSendText(fromId, `🛒 Catálogo: ${config.CATALOG_URL || 'No disponible'}`);
      await waSendText(fromId, 'Decime qué producto te interesa y te lo cotizo 😉');
      saveSession(fromId, s);
      return res.sendStatus(200);
    }
    if (actions.some(a => a.action === 'want_location')) {
      if (config.STORE_LAT && config.STORE_LNG) {
        await waSendText(fromId, `📍 Estamos aquí: https://www.google.com/maps?q=${config.STORE_LAT},${config.STORE_LNG}`);
      } else {
        await waSendText(fromId, '📍 Nuestra ubicación estará disponible pronto.');
      }
      saveSession(fromId, s);
      return res.sendStatus(200);
    }
    if (actions.some(a => a.action === 'want_human')) {
      s.pausedUntil = Date.now() + 4 * 60 * 60 * 1000;
      await waSendText(fromId, '🧑‍💼 Te conecto con un asesor.');
      await waSendText(fromId, '📞 +591 65900645\n👉 https://wa.me/59165900645');
      await waSendText(fromId, 'Para volver conmigo, escribí *continuar*.');
      saveSession(fromId, s);
      return res.sendStatus(200);
    }
    if (actions.some(a => a.action === 'want_close')) {
      s.stage = 'closed';
      await waSendText(fromId, '✅ Conversación finalizada. ¡Gracias por contactarnos!');
      saveSession(fromId, s);
      return res.sendStatus(200);
    }

    // FAQ (solo si el usuario envía TEXTO)
    if ((s.mode === 'faq' && type === 'text') || actions.some(a => a.action === 'want_advice')) {
      const raw = actions.find(a => a.action === 'want_advice')?.value || incomingText || '';
      const adv = getAdvice(raw, catalog);
      await waSendText(fromId, adv.text);
      if (adv.suggestions?.length) {
        const btns = adv.suggestions.slice(0, 3).map(name => ({
          id: `add_${slugify(name)}`,
          title: `➕ ${name}`.slice(0, 20)
        }));
        await waSendButtons(fromId, '¿Querés agregar alguno a tu cotización?', btns);
      } else {
        await waSendButtons(fromId, '¿Te ayudo a elegir por *cultivo*?', btnsCultivos());
      }
      // si no fue texto, salimos para evitar loops; si fue texto, seguimos en FAQ
      if (type !== 'text') exitModes(s);
      saveSession(fromId, s);
      return res.sendStatus(200);
    }

    // Disponibilidad por texto
    if (actions.some(a => a.action === 'want_availability')) {
      const query = actions.find(a => a.action === 'want_availability')?.value || '';
      const found = searchProductByText(catalog, query);
      if (found) {
        s.items.push({ name: found.name, qty: 1, price: null });
        await waSendText(fromId, `Sí, contamos con *${found.name}*. Lo agrego a tu cotización 👌`);
      } else {
        await waSendText(fromId, 'Puede figurar con otro nombre. ¿Me lo decís o me mandás una foto con el nombre?');
      }
    }

    // Envíos / Pago
    if (actions.some(a => a.action === 'want_shipping')) {
      await waSendText(fromId, '🚚 Sí, hacemos envíos. Para estimar costo y plazo, ¿en qué *Departamento* estás?');
      await waSendButtons(fromId, 'Elegí tu *Departamento*:', btnsDepartamento());
      saveSession(fromId, s);
      return res.sendStatus(200);
    }
    if (actions.some(a => a.action === 'want_payment')) {
      await waSendText(fromId, '💳 Aceptamos efectivo, QR y transferencia. ¿Querés que avance con tu cotización?');
    }

    // ¿Listo para cotizar?
    const ready = hasEnoughForQuote(s) || actions.some(a => a.action === 'want_quote') || wantsPrice(incomingText);
    if (ready) {
      s.stage = 'checkout';
      await waSendText(fromId,
        `${summaryText(s)}\n\n` +
        '🧠 Si querés ajustar algo, decime. Si está bien, generamos el PDF:'
      );
      await waSendButtons(fromId, '¿Listo para *Cotizar*?', btnCotizar());
      saveSession(fromId, s);
      return res.sendStatus(200);
    }

    // Si falta algo, intentar cubrir por texto libre (especial cultivo)
    const missing = nextMissingSlot(s);
    if (type === 'text' && missing === 'cultivo' && !/^btn_/.test(incomingText)) {
      const guess = detectCropFromText(incomingText);
      if (guess) {
        s.cultivo = guess;
      }
    }

    // Falta algo: pedir SOLO lo que falta, con anti-loop
    if (nextMissingSlot(s)) {
      const slot = nextMissingSlot(s);
      if (type === 'text' && !detectCropFromText(incomingText) && slot === 'cultivo') {
        // off-topic simpático
        const math = incomingText.match(/^\s*(\d+)\s*\+\s*(\d+)\s*$/);
        if (math) {
          const a = Number(math[1]), b = Number(math[2]);
          await waSendText(fromId, `😄 Eso es *${a + b}*. Ahora, para ayudarte mejor ¿te muestro opciones por *cultivo*?`);
        } else {
          await waSendText(fromId, '🙂 Te leo. Para afinar la recomendación, necesito el *cultivo*.');
        }
      }
      await askForSlot(fromId, slot, s);
      bumpRetryAndMaybeOfferMenu(fromId, s, slot);
      saveSession(fromId, s);
      return res.sendStatus(200);
    } else {
      // Smalltalk sin cambios → reencarrilar
      if (actions.some(a => a.action === 'smalltalk')) {
        await waSendText(fromId, '😉 Todo listo por aquí. ¿Avanzo con el PDF o querés ajustar *Campaña*? Escribí *volver* para el menú.');
        await waSendButtons(fromId, 'Elegí *Campaña* o Cotizar:', [
          { id: 'camp_verano', title: 'Verano' },
          { id: 'camp_invierno', title: 'Invierno' },
          { id: 'do_quote', title: '🧾 Cotizar' }
        ]);
        saveSession(fromId, s);
        return res.sendStatus(200);
      }
    }

    // Cierre: generar PDF
    if (s.stage === 'checkout' && (incomingText === 'do_quote' || wantsPrice(incomingText))) {
      if (!s.name) {
        s.stage = 'checkout_wait_name';
        await waSendText(fromId, '📄 Casi listo. ¿A nombre de quién emitimos la cotización? (Nombre y apellido)');
        saveSession(fromId, s);
        return res.sendStatus(200);
      }
      const { path: pdfPath, filename } = await buildQuote(s, fromId);
      const mediaId = await waUploadMediaFromFile(pdfPath, 'application/pdf', filename);
      if (mediaId) {
        await waSendDocument(fromId, mediaId, filename, '🧾 Cotización generada automáticamente.');
      } else {
        await waSendText(fromId, 'No pude subir el PDF a WhatsApp. Intentá de nuevo en un momento.');
      }
      try { await sheetsAppendFromSession(s, fromId, 'closed'); } catch {}
      s.stage = 'closed';
      saveSession(fromId, s);
      return res.sendStatus(200);
    }

    // Nombre → cotizar
    if (s.stage === 'checkout_wait_name' && looksLikeFullName(incomingText)) {
      s.name = incomingText.trim();
      const { path: pdfPath, filename } = await buildQuote(s, fromId);
      const mediaId = await waUploadMediaFromFile(pdfPath, 'application/pdf', filename);
      if (mediaId) {
        await waSendDocument(fromId, mediaId, filename, '🧾 Cotización lista. ¡Gracias!');
      } else {
        await waSendText(fromId, 'No pude subir el PDF a WhatsApp. Intentá de nuevo en un momento.');
      }
      try { await sheetsAppendFromSession(s, fromId, 'closed'); } catch {}
      s.stage = 'closed';
      saveSession(fromId, s);
      return res.sendStatus(200);
    }

    saveSession(fromId, s);
    res.sendStatus(200);
  } catch (e) {
    console.error('[WEBHOOK] Error:', e);
    res.sendStatus(200);
  }
});

export default router;
