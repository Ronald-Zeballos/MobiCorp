// wa/router.js
import express from 'express';
import { config } from '../env.js';
import { loadSession, saveSession } from '../core/session.js';
import { aiDecide, aiExtractFields, aiIdentifyProductFromPhoto, shouldCloseNow } from '../core/ai.js';
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
  waSendText, waSendButtons, waUploadMediaFromFile, waSendDocument, waDownloadMedia
} from './send.js';
import { parseCartFromText } from './parse.js';
import { buildQuote } from '../src/quote.js';
import { sheetsAppendFromSession } from '../src/sheets.js';
import { loadCatalog, searchProductByText, findProductBySlug, slugify } from '../core/catalog.js';
import { getAdvice } from '../core/faq.js';

// === NUEVO: clientes persistentes (JSON) ===
import { getClient, upsertClient } from '../core/clients.js';

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

function exitModes(s) { s.mode = null; }

function goHome(to, s) {
  exitModes(s);
  s.awaitingSlot = null;
  s.awaitingAt = 0;
  s.slotRetries = {}; // reset
  waSendText(
    to,
    '🏠 Volvimos al menú principal. Podés escribir lo que necesitás (producto, problema o cultivo). ' +
    'Si preferís botones, elegí abajo.'
  );
  return waSendButtons(to, 'Opciones rápidas:', [
    { id: 'btn_quote', title: '🧾 Cotizar' },
    { id: 'btn_catalog', title: 'Catálogo' },
    { id: 'btn_faq', title: 'Preguntas / Dudas' },
    { id: 'btn_human', title: 'Asesor' }
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
  // Tras 2 intentos, ofrecer menú:
  if (s.slotRetries[slot] >= 2) {
    waSendText(to, '🙂 Si preferís, escribí *volver* para regresar al menú, o elegí una opción debajo:');
    return goHome(to, s);
  }
  return null;
}

// IA-first: primer pedido en texto, botones recién en reintento
async function askForSlot(to, slot, s) {
  if (!shouldAskSlot(s, slot)) return; // evitar spam
  s.hinted = s.hinted || {};
  const hint = s.hinted[slot] ? '' : '\nPodés escribirlo libremente. Si te equivocaste, escribí *volver* para ir al menú.';
  s.hinted[slot] = true;

  switch (slot) {
    case 'cultivo':
      await waSendText(to, `¿Para qué *cultivo* es? (ej: Soya, Maíz, Trigo, Arroz, Girasol)${hint}`);
      if ((s.slotRetries?.[slot] || 0) >= 1) await waSendButtons(to, 'También podés elegir:', btnsCultivos());
      return;
    case 'hectareas':
      await waSendText(to, `¿Cuántas *hectáreas* vas a trabajar? (ej: 120)${hint}`);
      if ((s.slotRetries?.[slot] || 0) >= 1) await waSendButtons(to, 'Atajos:', btnsHectareas());
      return;
    case 'campana':
      await waSendText(to, `¿Para qué *campaña*? (Verano / Invierno)${hint}`);
      if ((s.slotRetries?.[slot] || 0) >= 1) await waSendButtons(to, 'Atajos:', btnsCampana());
      return;
    case 'departamento':
      await waSendText(to, `¿En qué *Departamento* estás?${hint}`);
      if ((s.slotRetries?.[slot] || 0) >= 1) await waSendButtons(to, 'Atajos:', btnsDepartamento());
      return;
    case 'subzona':
      await waSendText(to, `Seleccioná o escribí tu *Subzona* en Santa Cruz (p.ej. Norte Integrado, Chiquitania).${hint}`);
      if ((s.slotRetries?.[slot] || 0) >= 1) await waSendButtons(to, 'Atajos:', btnsSubzonaSCZ());
      return;
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
      if (Number.isFinite(h) || h) { s.hectareas = h; s.awaitingSlot = null; s.awaitingAt = 0; }
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

    // === NUEVO: recuperar cliente persistente para saludar por nombre
    const cli = getClient(fromId);
    if (cli?.name && !s.profileName) s.profileName = cli.name;

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

    // Saludo una vez por sesión (con nombre si lo tenemos)
    if (!s.greeted) {
      s.greeted = true;
      const nombre = s.name || s.profileName;
      await waSendText(
        fromId,
        `👋 ¡Bienvenido/a ${nombre ? `*${nombre}* ` : ''}a *NewChem Agroquímicos*! Contame, ¿qué necesitás hoy?\n` +
        'Podés escribirme el producto, pegar tu lista, o mandarme una foto. ' +
        'Si querés regresar al menú, escribí *volver*.'
      );
      // IA-first: mostramos botones como apoyo, no como paso obligado
      await waSendButtons(fromId, 'Atajos (opcionales):', [
        { id: 'btn_quote', title: '🧾 Cotizar' },
        { id: 'btn_catalog', title: 'Catálogo' },
        { id: 'btn_faq', title: 'Dudas' },
        { id: 'btn_human', title: 'Asesor' }
      ]);
      saveSession(fromId, s);
      return res.sendStatus(200);
    }

    // Normalizar entrada
    let incomingText = '';
    if (type === 'text') incomingText = (msg.text?.body || '').trim();
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

    // Botones de apoyo
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
      await waSendText(fromId, '¡Perfecto! Armemos tu cotización rápido 😊 (podés escribir libremente).');
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

    // === NUEVO: FOTO → IA visión (sin depender del caption)
    if (type === 'image' && msg.image?.id) {
      const mediaBuf = await waDownloadMedia(msg.image.id);
      if (mediaBuf) {
        const vision = await aiIdentifyProductFromPhoto(mediaBuf, catalog);
        if (vision.hit && vision.product) {
          s.items.push({ name: vision.product.name, qty: 1, price: null });
          await waSendText(fromId, `🖼️ Parece *${vision.product.name}*. Sí, lo vendemos 🙌 ¿Querés que lo cotice?`);
        } else {
          // fallback con caption si vino
          const caption = msg.image?.caption || '';
          if (caption) {
            const found = searchProductByText(catalog, caption);
            if (found) {
              s.items.push({ name: found.name, qty: 1, price: null });
              await waSendText(fromId, `🖼️ Identifiqué *${found.name}* por el texto. Lo agrego a tu cotización.`);
            } else {
              const label = vision.label ? `(*${vision.label}*)` : '';
              await waSendText(fromId, `Recibí tu foto ${label}. Parece *${vision.category || 'otro'}*. ` +
                `No vendemos ese producto 😅. Decime el *nombre* de un producto del catálogo y lo cotizo.`);
            }
          } else {
            const label = vision.label ? ` (*${vision.label}*)` : '';
            if (vision.category && vision.category !== 'agroquimico') {
              await waSendText(fromId, `Parece ${vision.category}${label}. ` +
                `No vendemos eso 😅. Mandame el nombre de un producto del catálogo y lo cotizo.`);
            } else {
              await waSendText(fromId, 'Recibí la imagen. No pude identificar el producto con certeza. ' +
                '¿Me indicás el *nombre comercial* tal como figura en la etiqueta?');
            }
          }
        }
      } else {
        await waSendText(fromId, 'Recibí la imagen 👍. ¿Me indicás el *nombre comercial* del producto para reconocerlo?');
      }
      // tras procesar foto, empujar al siguiente paso si corresponde
      if (hasEnoughForQuote(s)) {
        await waSendText(fromId, `${summaryText(s)}\n\n¿Generamos tu PDF de cotización?`);
        await waSendButtons(fromId, '¿Listo para *Cotizar*?', btnCotizar());
      } else {
        const missing = nextMissingSlot(s) || 'cultivo';
        await askForSlot(fromId, missing, s);
      }
      saveSession(fromId, s);
      return res.sendStatus(200);
    }

    // Dep/Sub (botones)
    if (incomingText?.startsWith?.('dep_')) {
      const idx = Number(incomingText.split('_')[1]);
      const dep = DEPARTAMENTOS[idx];
      if (dep) {
        s.departamento = dep;
        if (dep === 'Santa Cruz') {
          await waSendText(fromId, '¿Cuál es tu *Subzona* en Santa Cruz? (podés escribirla)');
          await waSendButtons(fromId, 'Atajos:', btnsSubzonaSCZ());
        } else {
          await waSendText(fromId, 'Genial. ¿Para qué *Cultivo* es? (podés escribirlo)');
          await waSendButtons(fromId, 'Atajos:', btnsCultivos());
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
        await waSendText(fromId, 'Perfecto. ¿Qué *Cultivo* vas a trabajar? (podés escribirlo)');
        await waSendButtons(fromId, 'Atajos:', btnsCultivos());
        s.stage = 'product';
        s.awaitingSlot = null; s.awaitingAt = 0;
        saveSession(fromId, s);
        return res.sendStatus(200);
      }
    }

    // Cultivo/HA/Campaña (botones de apoyo)
    if (incomingText?.startsWith?.('crop_')) {
      const id = incomingText.split('_')[1] || '';
      const map = { soya: 'Soya', maiz: 'Maíz', trigo: 'Trigo', arroz: 'Arroz', girasol: 'Girasol', otro: 'Otro' };
      const cult = map[id];
      if (cult) {
        s.cultivo = cult;
        s.awaitingSlot = null; s.awaitingAt = 0;
        exitModes(s);
        await askForSlot(fromId, 'hectareas', s);
        saveSession(fromId, s);
        return res.sendStatus(200);
      }
    }
    if (incomingText?.startsWith?.('ha_')) {
      const val = incomingText.slice(3);
      const num = Number(val.replace(/[^\d]/g, ''));
      if (Number.isFinite(num) && num > 0) { s.hectareas = num; s.awaitingSlot = null; s.awaitingAt = 0; }
      exitModes(s);
      await askForSlot(fromId, 'campana', s);
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
          await askForSlot(fromId, 'departamento', s);
        } else {
          s.stage = 'checkout';
          const now = Date.now();
          if (!s.shownSummaryAt || (now - s.shownSummaryAt) > 30000) {
            s.shownSummaryAt = now;
            await waSendText(fromId, `${summaryText(s)}\n\n¿Generamos tu PDF de cotización?`);
            await waSendButtons(fromId, '¿Listo para *Cotizar*?', btnCotizar());
          }
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
        // IA-first: pedir lo que falte con texto y solo luego botones
        const miss = nextMissingSlot(s);
        if (miss) await askForSlot(fromId, miss, s);
        else {
          s.stage = 'checkout';
          const now = Date.now();
          if (!s.shownSummaryAt || (now - s.shownSummaryAt) > 30000) {
            s.shownSummaryAt = now;
            await waSendText(fromId, `${summaryText(s)}\n\n¿Generamos tu PDF de cotización?`);
            await waSendButtons(fromId, '¿Listo para *Cotizar*?', btnCotizar());
          }
        }
        saveSession(fromId, s);
        return res.sendStatus(200);
      }
    }

    // Atajos globales por texto
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

    // Carrito pegado (texto)
    if (type === 'text' && !/^(dep_|sub_|crop_|ha_|camp_|do_quote|add_)/.test(incomingText)) {
      const cart = parseCartFromText(incomingText);
      if (cart?.items?.length) {
        s.items = s.items.concat(cart.items);
        s.stage = 'checkout';
      }
    }

    // IA estructurada (slots + intent)
    const extracted = await aiExtractFields(incomingText, s);
    if (extracted?.nombre && !s.profileName) s.profileName = extracted.nombre;
    if (extracted?.departamento && !s.departamento) s.departamento = extracted.departamento;
    if (extracted?.subzona && !s.subzona) s.subzona = extracted.subzona;
    if (extracted?.cultivo && !s.cultivo) s.cultivo = extracted.cultivo;
    if ((Number.isFinite(extracted?.hectareas) || extracted?.hectareas) && !s.hectareas) s.hectareas = extracted.hectareas;
    if (extracted?.campana && !s.campana) s.campana = extracted.campana;

    // Decisor clásico (acciones adicionales)
    const actions = await aiDecide(incomingText, s);
    for (const a of actions) applyActionToSession(s, a);

    // FAQ (texto)
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
        await waSendText(fromId, 'Podés decirme el *cultivo* (Soya, Maíz, etc.) o el *problema* (chinche, roya…) y te recomiendo 🙂');
      }
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
      await waSendText(fromId, '🚚 Sí, hacemos envíos. Para estimar costo y plazo, ¿en qué *Departamento* estás? (podés escribirlo)');
      await waSendButtons(fromId, 'Atajos:', btnsDepartamento());
      saveSession(fromId, s);
      return res.sendStatus(200);
    }
    if (actions.some(a => a.action === 'want_payment')) {
      await waSendText(fromId, '💳 Aceptamos efectivo, QR y transferencia. ¿Querés que avance con tu cotización?');
    }

    // Empujón suave si estamos esperando un slot
    if (s.awaitingSlot && type === 'text' && !/^(dep_|sub_|crop_|ha_|camp_|do_quote|add_|volver|men[úu]|menu|principal)/i.test(incomingText)) {
      await waSendText(fromId, 'Si preferís, podemos charlar en *Preguntas/Dudas*. Escribí *dudas* para entrar en ese modo, o decime lo que falta y seguimos 🙂');
    }

    // ¿Listo para cotizar?
    const ready = hasEnoughForQuote(s) || extracted?.intent === 'ready_to_quote' || actions.some(a => a.action === 'want_quote') || wantsPrice(incomingText);
    if (ready) {
      s.stage = 'checkout';
      const now = Date.now();
      if (!s.shownSummaryAt || (now - s.shownSummaryAt) > 30000) {
        s.shownSummaryAt = now;
        await waSendText(fromId,
          `${summaryText(s)}\n\n` +
          '🧠 Si querés ajustar algo, decime. Si está bien, generamos el PDF:'
        );
        await waSendButtons(fromId, '¿Listo para *Cotizar*?', btnCotizar());
      }
      saveSession(fromId, s);
      return res.sendStatus(200);
    }

    // Falta algo: pedir SOLO lo que falta, IA-first
    if (nextMissingSlot(s)) {
      const slot = nextMissingSlot(s);
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
      if (s.name) upsertClient(fromId, { name: s.name });
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
      upsertClient(fromId, { name: s.name });
      s.stage = 'closed';
      saveSession(fromId, s);
      return res.sendStatus(200);
    }

    // Guardar "lastSeen" aunque no haya cierre
    upsertClient(fromId, {});
    saveSession(fromId, s);
    res.sendStatus(200);
  } catch (e) {
    console.error('[WEBHOOK] Error:', e);
    res.sendStatus(200);
  }
});

export default router;
