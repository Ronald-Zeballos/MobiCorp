// wa/router.js
import express from 'express';
import { config } from '../env.js';
import { loadSession, saveSession } from '../core/session.js';
import { aiDecide } from '../core/ai.js';
import {
  wantsCatalog, wantsHuman, wantsLocation, wantsClose, wantsPrice, wantsFAQ,
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

function detectCropFromText(text) {
  const n = normalize(text);
  if (/\b(soja|soya)\b/.test(n)) return 'Soya';
  if (/\b(maiz|maíz)\b/.test(n)) return 'Maíz';
  if (/\b(trigo)\b/.test(n)) return 'Trigo';
  if (/\b(arroz)\b/.test(n)) return 'Arroz';
  if (/\b(girasol)\b/.test(n)) return 'Girasol';
  return null;
}

// ===== MENÚ por TEXTO (sin botones) =====
function menuText() {
  return [
    '📋 *Opciones disponibles*',
    '',
    '🧾 *Quiero comprar*  → escribí: *cotizar*',
    '🛒 *Ver catálogo*    → escribí: *catálogo*',
    '🔎 *Saber de un producto* → escribí: *producto*',
    '📍 *Ubicación*       → escribí: *ubicación*',
    '🕒 *Horarios*        → escribí: *horarios*',
    '🧑‍💼 *Hablar con un asesor* → escribí: *asesor*',
    '🤖 *IA interactiva*  → escribí: *dudas*'
  ].join('\n');
}
async function sendHome(to, s, saludo = false) {
  s.module = 'menu';
  exitModes(s);
  s.awaitingSlot = null;
  s.awaitingAt = 0;
  s.slotRetries = {};
  if (saludo) {
    const nombre = s.name || s.profileName;
    await waSendText(
      to,
      `👋 ¡Hola! Soy *AgroBot*, el asistente virtual de *NewChem Agroquímicos*.\n` +
      `Estoy para ayudarte a comprar, resolver dudas y ubicar nuestra tienda${nombre ? `, *${nombre}*` : ''}.`
    );
  }
  await waSendText(to, menuText());
}

// ================================
// Lógica de “comprar” (slots)
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
// anti-loop
function shouldAskSlot(s, slot) {
  s.slotRetries = s.slotRetries || {};
  const now = Date.now();
  if (s.awaitingSlot === slot && s.awaitingAt && (now - s.awaitingAt) < 20000) return false;
  s.awaitingSlot = slot;
  s.awaitingAt = now;
  s.slotRetries[slot] = s.slotRetries[slot] || 0;
  return true;
}
function bumpRetryAndMaybeOfferMenu(to, s, slot) {
  s.slotRetries = s.slotRetries || {};
  s.slotRetries[slot] = (s.slotRetries[slot] || 0) + 1;
  if (s.slotRetries[slot] >= 2) {
    waSendText(to, '🙂 Si preferís, escribí *volver* para regresar al menú.');
    return sendHome(to, s, false);
  }
  return null;
}
async function askForSlot(to, slot, s) {
  if (!shouldAskSlot(s, slot)) return;
  s.hinted = s.hinted || {};
  const hint = s.hinted[slot] ? '' : '\nSi te equivocaste, escribí *volver* para ir al menú.';
  s.hinted[slot] = true;

  switch (slot) {
    case 'cultivo':
      return waSendButtons(to, `¿Para qué *cultivo* es?${hint}`, btnsCultivos());
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
    s.items = s.items || [];

    // cliente persistente para saludo por nombre
    const cli = getClient(fromId);
    if (cli?.name && !s.profileName) s.profileName = cli.name;

    // Pausa por asesor humano
    if (s.pausedUntil && Date.now() < s.pausedUntil) {
      const txt = msg?.text?.body || '';
      if (/bot|continuar|reanudar/i.test(txt)) {
        s.pausedUntil = 0;
        await waSendText(fromId, '🤖 ¡Aquí estoy de vuelta! Te muestro el menú.');
        await sendHome(fromId, s, false);
      } else {
        await waSendText(fromId, '🧑‍💼 Estás con un asesor. Escribí "continuar" para volver conmigo.');
      }
      saveSession(fromId, s);
      return res.sendStatus(200);
    }

    // Saludo + MENÚ por texto (una sola vez)
    if (!s.greeted) {
      s.greeted = true;
      await sendHome(fromId, s, true);
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
      await waSendText(fromId, '📍 ¡Gracias! Guardé tu ubicación para futuras entregas.');
    }
    if (config.DEBUG_LOGS) console.log('[IN <-]', type, incomingText, 'MODULE=', s.module);

    // Global: volver / menú
    if (isMenuCommand(incomingText)) {
      await sendHome(fromId, s, false);
      saveSession(fromId, s);
      return res.sendStatus(200);
    }

    const lower = (incomingText || '').toLowerCase();

    // ======= SI ESTÁS EN MENU, SOLO MENÚ =======
    if (s.module === 'menu') {
      if (wantsPrice(lower) || /\b(cotiza(r)?|presupuesto)\b/.test(lower)) {
        s.module = 'comprar';
        s.stage = 'product';
        if (!s.name && !s.profileName) {
          await waSendText(fromId, '🧾 Vamos a armar tu cotización. ¿Cuál es tu *nombre completo*?');
        } else {
          const missing = nextMissingSlot(s) || 'cultivo';
          await waSendText(fromId, '¡Perfecto! Empecemos 😊');
          await askForSlot(fromId, missing, s);
        }
        saveSession(fromId, s);
        return res.sendStatus(200);
      }
      if (wantsCatalog(lower) || /\b(cat[aá]logo)\b/.test(lower)) {
        s.module = 'catalogo';
        await waSendText(fromId, `🛒 Este es nuestro catálogo:\n${config.CATALOG_URL || 'No disponible'}`);
        await waSendText(fromId, 'Pegá aquí tu lista cuando termines. Escribí *volver* para regresar al menú.');
        saveSession(fromId, s);
        return res.sendStatus(200);
      }
      if (/\b(producto|producto_info|saber de un producto)\b/.test(lower) || lower === 'producto') {
        s.module = 'producto_info';
        await waSendText(fromId, '🔎 Decime el *nombre del producto*. Podés salir con *volver*.');
        saveSession(fromId, s);
        return res.sendStatus(200);
      }
      if (wantsLocation(lower) || /\bubicaci[oó]n\b/.test(lower)) {
        s.module = 'ubicacion';
        if (config.STORE_LAT && config.STORE_LNG) {
          await waSendText(fromId, `📍 Estamos aquí: https://www.google.com/maps?q=${config.STORE_LAT},${config.STORE_LNG}\nEscribí *volver* para el menú.`);
        } else {
          await waSendText(fromId, '📍 Nuestra ubicación estará disponible pronto.\nEscribí *volver* para el menú.');
        }
        saveSession(fromId, s);
        return res.sendStatus(200);
      }
      if (/\bhorarios?\b/.test(lower)) {
        s.module = 'horarios';
        await waSendText(fromId,
          '🕒 *Horarios de atención*\n' +
          'Lun–Vie: 08:30–12:30 y 14:30–18:30\n' +
          'Sáb: 09:00–12:30\n' +
          'Dom/Feriados: cerrado\n\n' +
          'Escribí *volver* para regresar al menú.'
        );
        saveSession(fromId, s);
        return res.sendStatus(200);
      }
      if (wantsHuman(lower) || /\basesor\b/.test(lower)) {
        s.module = 'humano';
        s.pausedUntil = Date.now() + 4 * 60 * 60 * 1000;
        await waSendText(fromId, '🧑‍💼 Te conecto con un asesor ahora mismo.');
        await waSendText(fromId, '📞 +591 65900645\n👉 https://wa.me/59165900645');
        await waSendText(fromId, 'Para volver conmigo más tarde, escribí *continuar*.');
        saveSession(fromId, s);
        return res.sendStatus(200);
      }
      if (wantsFAQ(lower) || /\bdudas\b/.test(lower)) {
        s.module = 'ia_chat';
        await waSendText(fromId,
          '🤖 *Asistente IA NewChem*\n' +
          'Contame tu consulta (ej: "¿qué herbicida para soja?", "me atacan chinches", "¿cuánta dosis para 120 ha?").\n' +
          'Si luego querés una cotización, escribí *cotizar*.\n' +
          'Para volver al menú escribí *volver*.'
        );
        saveSession(fromId, s);
        return res.sendStatus(200);
      }

      // Si no entendemos, re-mostramos el menú
      await waSendText(fromId, 'No te entendí bien. Estas son las opciones:');
      await waSendText(fromId, menuText());
      saveSession(fromId, s);
      return res.sendStatus(200);
    }

    // ======= GUARD GLOBAL: si no es “volver”, NO cambiamos de módulo =======
    const tryingToJumpMenu =
      /\b(cotiza(r)?|presupuesto|cat[aá]logo|producto|ubicaci[oó]n|horarios?|asesor|dudas)\b/.test(lower);
    if (tryingToJumpMenu && !isMenuCommand(lower)) {
      await waSendText(fromId, `Estás en *${s.module}*. Si querés volver al menú, escribí *volver*.`);
      saveSession(fromId, s);
      return res.sendStatus(200);
    }

    // ======= MÓDULO: CATALOGO =======
    if (s.module === 'catalogo') {
      if (type === 'text') {
        const cart = parseCartFromText(incomingText);
        if (cart?.items?.length) {
          s.items = s.items.concat(cart.items);
          await waSendText(fromId, `🛒 Agregué ${cart.items.length} ítem(s). Si querés generar PDF, escribí *cotizar* (volver para menú).`);
          saveSession(fromId, s);
          return res.sendStatus(200);
        }
      }
      await waSendText(fromId, 'Pegá aquí tu lista o escribí *volver* para el menú.');
      saveSession(fromId, s);
      return res.sendStatus(200);
    }

    // ======= MÓDULO: PRODUCTO_INFO =======
    if (s.module === 'producto_info') {
      if (type === 'text') {
        if (/^cotiza(r)?$/.test(lower)) {
          s.module = 'comprar';
          s.stage = 'product';
          const missing = nextMissingSlot(s) || 'cultivo';
          await waSendText(fromId, '¡Vamos a cotizar! 😊');
          await askForSlot(fromId, missing, s);
          saveSession(fromId, s);
          return res.sendStatus(200);
        }
        const p = searchProductByText(catalog, incomingText);
        if (p) {
          await waSendText(fromId, `✅ Trabajamos *${p.name}*. ¿Querés *cotizar*? (o *volver* al menú)`);
        } else {
          await waSendText(fromId, '😅 No lo encuentro en nuestro catálogo. Probá con otro nombre o escribí *volver*.');
        }
      }
      saveSession(fromId, s);
      return res.sendStatus(200);
    }

    // ======= MÓDULO: UBICACION =======
    if (s.module === 'ubicacion') {
      await waSendText(fromId, 'Para regresar al menú escribí *volver*.');
      saveSession(fromId, s);
      return res.sendStatus(200);
    }

    // ======= MÓDULO: HORARIOS =======
    if (s.module === 'horarios') {
      await waSendText(fromId, 'Para regresar al menú escribí *volver*.');
      saveSession(fromId, s);
      return res.sendStatus(200);
    }

    // ======= MÓDULO: HUMANO =======
    if (s.module === 'humano') {
      if (/bot|continuar|reanudar/i.test(lower)) {
        s.pausedUntil = 0;
        await waSendText(fromId, '🤖 ¡De vuelta! Te muestro el menú:');
        await sendHome(fromId, s, false);
      } else {
        await waSendText(fromId, '🧑‍💼 Estás con un asesor. Escribí "continuar" para volver conmigo.');
      }
      saveSession(fromId, s);
      return res.sendStatus(200);
    }

    // ======= MÓDULO: IA_CHAT =======
    if (s.module === 'ia_chat') {
      if (type === 'text') {
        // IA abierta con FAQ local
        const adv = getAdvice(incomingText, catalog);
        await waSendText(fromId, adv.text);
        // si detecta intención de cotizar
        if (/\bcotiza(r)?\b/.test(lower)) {
          s.module = 'comprar';
          s.stage = 'product';
          const missing = nextMissingSlot(s) || 'cultivo';
          await waSendText(fromId, '¡Vamos a cotizar! 😊');
          await askForSlot(fromId, missing, s);
        }
      }
      saveSession(fromId, s);
      return res.sendStatus(200);
    }

    // ======= MÓDULO: COMPRAR (flujo de slots) =======
    if (s.module === 'comprar') {
      // Botones de selección
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
      if (incomingText?.startsWith?.('crop_')) {
        const id = incomingText.split('_')[1] || '';
        const map = { soya: 'Soya', maiz: 'Maíz', trigo: 'Trigo', arroz: 'Arroz', girasol: 'Girasol', otro: 'Otro' };
        const cult = map[id];
        if (cult) {
          s.cultivo = cult;
          s.awaitingSlot = null; s.awaitingAt = 0;
          await waSendButtons(fromId, '¿Cuántas *hectáreas* vas a trabajar?', btnsHectareas());
          saveSession(fromId, s);
          return res.sendStatus(200);
        }
      }
      if (incomingText?.startsWith?.('ha_')) {
        const val = incomingText.slice(3);
        const num = Number(val.replace(/[^\d]/g, ''));
        if (Number.isFinite(num) && num > 0) { s.hectareas = num; s.awaitingSlot = null; s.awaitingAt = 0; }
        await waSendButtons(fromId, '¿Para qué *campaña*?', btnsCampana());
        saveSession(fromId, s);
        return res.sendStatus(200);
      }
      if (incomingText?.startsWith?.('camp_')) {
        const id = incomingText.split('_')[1] || '';
        s.campana = (id === 'verano') ? 'Verano' : (id === 'invierno') ? 'Invierno' : null;
        if (s.campana) {
          s.awaitingSlot = null; s.awaitingAt = 0;
          if (!s.departamento) {
            await waSendButtons(fromId, '¿En qué *Departamento* estás?', btnsDepartamento());
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

      // Texto libre dentro de COMPRAR
      if (type === 'text') {
        // nombre si lo pedimos
        if (!s.name && looksLikeFullName(incomingText)) {
          s.name = incomingText.trim();
        }
        // IA suave para extraer campos
        const actions = await aiDecide(incomingText, s);
        for (const a of actions) applyActionToSession(s, a);

        // listo para cotizar
        const ready = hasEnoughForQuote(s) || wantsPrice(incomingText);
        if (ready) {
          s.stage = 'checkout';
          const now = Date.now();
          if (!s.shownSummaryAt || (now - s.shownSummaryAt) > 30000) {
            s.shownSummaryAt = now;
            await waSendText(fromId, `${summaryText(s)}\n\n🧠 Si querés ajustar algo, decime. Si está bien, generamos el PDF:`);
            await waSendButtons(fromId, '¿Listo para *Cotizar*?', btnCotizar());
          }
          saveSession(fromId, s);
          return res.sendStatus(200);
        }

        // pedir el slot faltante
        const slot = nextMissingSlot(s);
        if (slot) {
          if (!detectCropFromText(incomingText) && slot === 'cultivo') {
            await waSendText(fromId, '🙂 Para afinar la recomendación, necesito el *cultivo*.');
          }
          await askForSlot(fromId, slot, s);
          bumpRetryAndMaybeOfferMenu(fromId, s, slot);
          saveSession(fromId, s);
          return res.sendStatus(200);
        }
      }

      // Cierre: generar PDF (botón o texto “cotizar”)
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
        await waSendText(fromId, 'Para iniciar algo nuevo, escribí *volver*.');
        saveSession(fromId, s);
        return res.sendStatus(200);
      }

      // Nombre → cotizar directo
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
        await waSendText(fromId, 'Para iniciar algo nuevo, escribí *volver*.');
        saveSession(fromId, s);
        return res.sendStatus(200);
      }

      // cualquier otra cosa en COMPRAR
      saveSession(fromId, s);
      return res.sendStatus(200);
    }

    // Guardar lastSeen
    upsertClient(fromId, {});
    saveSession(fromId, s);
    res.sendStatus(200);
  } catch (e) {
    console.error('[WEBHOOK] Error:', e);
    res.sendStatus(200);
  }
});

export default router;
