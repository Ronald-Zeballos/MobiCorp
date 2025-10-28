// wa/router.js
import express from 'express';
import { config } from '../env.js';
import { loadSession, saveSession } from '../core/session.js';
import {
  wantsCatalog, wantsHuman, wantsLocation, wantsClose, wantsPrice,
  looksLikeFullName, detectDepartamento, detectSubzona, parseHectareas,
  detectCropFromText, wantsOpenIA
} from '../core/intents.js';
import { waSendText, waUploadMediaFromFile, waSendDocument } from './send.js';
import { buildQuote } from '../src/quote.js';
import { sheetsAppendFromSession } from '../src/sheets.js';
import { chatIA } from '../src/aichat.js';

// Persistencia de clientes (saludo por nombre / lastSeen)
import { getClient, upsertClient } from '../core/clients.js';

const router = express.Router();

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

// --- helpers de UI texto (menú) ---
function menuText() {
  return [
    '📋 *Opciones disponibles*',
    '',
    '🛒 *Quiero comprar*       → escribí: *cotizar*',
    '🧾 *Ver catálogo*         → escribí: *catálogo*',
    '🔎 *Saber de un producto* → escribí: *producto*',
    '📍 *Ubicación*            → escribí: *ubicación*',
    '🕒 *Horarios*             → escribí: *horarios*',
    '👩‍💼 *Hablar con un asesor* → escribí: *asesor*',
    '🧠 *IA interactiva*       → escribí: *dudas*'
  ].join('\n');
}

async function showHome(to, s, intro = false) {
  s.mode = 'menu';
  s.awaitingSlot = null;
  s.awaitingAt = 0;
  if (intro) {
    const nombre = s.name || s.profileName || getClient(to)?.name || null;
    await waSendText(to,
      `👋 ¡Hola${nombre ? ` *${nombre}*` : ''}! Soy *AgroBot*, el asistente virtual de *NewChem Agroquímicos*.\n` +
      'Estoy para ayudarte a comprar, resolver dudas y ubicar nuestra tienda.\n\n' +
      menuText()
    );
  } else {
    await waSendText(to, menuText());
  }
}

function shortHint(to) {
  return waSendText(to, '🧭 Escribí *volver* para regresar al menú.');
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
    s.slotRetries = s.slotRetries || {};

    // Recuperar cliente persistente para saludar por nombre
    const cli = getClient(fromId);
    if (cli?.name && !s.profileName) s.profileName = cli.name;

    // Pausa por asesor humano
    if (s.pausedUntil && Date.now() < s.pausedUntil) {
      const txt = msg?.text?.body || '';
      if (/bot|continuar|reanudar/i.test(txt)) {
        s.pausedUntil = 0;
        await waSendText(fromId, '🤖 ¡Aquí estoy de vuelta! Sigamos con tu atención.');
      } else {
        await waSendText(fromId, '🧑‍💼 Estás con un asesor. Escribí "continuar" para volver conmigo.');
        saveSession(fromId, s);
        return res.sendStatus(200);
      }
    }

    // Saludo + menú (solo una vez)
    if (!s.greeted) {
      s.greeted = true;
      await showHome(fromId, s, true);
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
    if (config.DEBUG_LOGS) console.log('[IN <-]', type, incomingText);

    // Comando menú global
    if (isMenuCommand(incomingText)) {
      await showHome(fromId, s, false);
      saveSession(fromId, s);
      return res.sendStatus(200);
    }

    // ======= Entradas rápidas de menú (texto) =======
    if (/^\s*cat[aá]logo\s*$/i.test(incomingText) || wantsCatalog(incomingText)) {
      await waSendText(fromId, `🧾 Nuestro catálogo: ${config.CATALOG_URL || 'No disponible aún.'}`);
      await shortHint(fromId);
      saveSession(fromId, s);
      return res.sendStatus(200);
    }
    if (/^\s*ubicaci[oó]n\s*$/i.test(incomingText) || wantsLocation(incomingText)) {
      if (config.STORE_LAT && config.STORE_LNG) {
        await waSendText(fromId, `📍 Estamos aquí: https://www.google.com/maps?q=${config.STORE_LAT},${config.STORE_LNG}`);
      } else {
        await waSendText(fromId, '📍 Nuestra ubicación estará disponible pronto.');
      }
      await shortHint(fromId);
      saveSession(fromId, s);
      return res.sendStatus(200);
    }
    if (/^\s*horarios?\s*$/i.test(incomingText)) {
      await waSendText(fromId, '🕒 L–V 8:30–12:30 y 14:30–18:30 · Sáb 8:30–12:30.');
      await shortHint(fromId);
      saveSession(fromId, s);
      return res.sendStatus(200);
    }
    if (/^\s*asesor\s*$/i.test(incomingText) || wantsHuman(incomingText)) {
      s.pausedUntil = Date.now() + 4 * 60 * 60 * 1000;
      await waSendText(fromId, '👩‍💼 Te conecto con un asesor ahora.');
      await waSendText(fromId, '📞 +591 65900645 · 👉 https://wa.me/59165900645');
      await waSendText(fromId, 'Para volver conmigo, escribí *continuar*.');
      saveSession(fromId, s);
      return res.sendStatus(200);
    }

    // ======= IA abierta =======
    if (wantsOpenIA(incomingText)) {
      s.mode = 'ia';
      await waSendText(fromId,
        '🧠 *IA interactiva activada.* Podés preguntarme lo que quieras relacionado con agricultura y nuestros productos.\n' +
        'Cuando quieras regresar, escribí *volver*.'
      );
      saveSession(fromId, s);
      return res.sendStatus(200);
    }
    if (s.mode === 'ia' && type === 'text') {
      const user = incomingText;
      if (/^\s*volver\s*$/i.test(user)) {
        await showHome(fromId, s, false);
      } else {
        const ai = await chatIA(user, s.iaHistory || []);
        s.iaHistory = (s.iaHistory || []).concat([
          { role: 'user', content: user },
          { role: 'assistant', content: ai }
        ]).slice(-10);
        await waSendText(fromId, ai + '\n\n🧭 Escribí *volver* para regresar al menú.');
      }
      saveSession(fromId, s);
      return res.sendStatus(200);
    }

    // ======= Cerrar / terminar =======
    if (wantsClose(incomingText)) {
      s.stage = 'closed';
      await waSendText(fromId, '✅ Conversación finalizada. ¡Gracias por contactarnos!');
      saveSession(fromId, s);
      return res.sendStatus(200);
    }

    // ======= Cotizar (texto) =======
    if (/^\s*cotiz(ar|a|ame)?\s*$/i.test(incomingText) || wantsPrice(incomingText)) {
      s.mode = 'cotizar';
      await waSendText(fromId,
        '🧾 *Vamos a armar tu cotización.* Podés escribir los datos directo en texto.\n' +
        'Necesito: *cultivo* → *hectáreas* → *campaña* → *departamento* (y subzona si es Santa Cruz).'
      );
      if (!s.cultivo) await waSendText(fromId, '🌱 ¿Para qué *cultivo* es? (ej: Soya, Maíz, Trigo...)');
      else if (s.hectareas == null) await waSendText(fromId, '📐 ¿Cuántas *hectáreas* vas a trabajar? (número)');
      else if (!s.campana) await waSendText(fromId, '🗓️ ¿Para qué *campaña*? (Verano/Invierno)');
      else if (!s.departamento) await waSendText(fromId, '🗺️ ¿En qué *departamento* estás?');
      saveSession(fromId, s);
      return res.sendStatus(200);
    }

    // ======= Captura suave de slots dentro de 'cotizar' =======
    if (s.mode === 'cotizar' && type === 'text') {
      const t = incomingText.trim();

      // cultivo
      if (!s.cultivo) {
        const guess = detectCropFromText(t);
        if (guess) { s.cultivo = guess; await waSendText(fromId, `✅ Cultivo: *${s.cultivo}*`); }
        else await waSendText(fromId, '🌱 Decime el *cultivo* (Soya, Maíz, Trigo, Arroz, Girasol).');
        saveSession(fromId, s); return res.sendStatus(200);
      }

      // hectáreas
      if (s.hectareas == null) {
        const n = parseHectareas(t);
        if (Number.isFinite(n)) { s.hectareas = n; await waSendText(fromId, `✅ Hectáreas: *${n}*`); }
        else await waSendText(fromId, '📐 Decime un número de hectáreas (ej: 120).');
        saveSession(fromId, s); return res.sendStatus(200);
      }

      // campaña
      if (!s.campana) {
        if (/verano/i.test(t)) s.campana = 'Verano';
        else if (/invierno/i.test(t)) s.campana = 'Invierno';
        if (s.campana) await waSendText(fromId, `✅ Campaña: *${s.campana}*`);
        else await waSendText(fromId, '🗓️ ¿Verano o Invierno?');
        saveSession(fromId, s); return res.sendStatus(200);
      }

      // departamento
      if (!s.departamento) {
        const dep = detectDepartamento(t);
        if (dep) { s.departamento = dep; await waSendText(fromId, `✅ Departamento: *${dep}*`); }
        else await waSendText(fromId, '🗺️ Decime tu *departamento* (ej: Santa Cruz, La Paz...).');
        saveSession(fromId, s); return res.sendStatus(200);
      }

      // subzona si SCZ
      if (s.departamento === 'Santa Cruz' && !s.subzona) {
        const sub = detectSubzona(t);
        if (sub) { s.subzona = sub; await waSendText(fromId, `✅ Zona: *${sub}*`); }
        else await waSendText(fromId, '📍 ¿Qué *subzona* de Santa Cruz? (Norte Integrado, Chiquitania, Vallegrande, Cordillera, Andrés Ibáñez, Warnes, Obispo Santistevan)');
        saveSession(fromId, s); return res.sendStatus(200);
      }

      // listo → pedir nombre y emitir PDF
      if (!s.name) {
        s.stage = 'checkout_wait_name';
        await waSendText(fromId, '📝 Perfecto. Para emitir tu *PDF de cotización*, ¿a nombre de quién lo hago? (Nombre y apellido)');
        saveSession(fromId, s);
        return res.sendStatus(200);
      }
    }

    // ======= Nombre → generar PDF =======
    if (s.stage === 'checkout_wait_name' && looksLikeFullName(incomingText)) {
      s.name = incomingText.trim();
      const { path: pdfPath, filename } = await buildQuote(s, fromId);
      const mediaId = await waUploadMediaFromFile(pdfPath, 'application/pdf', filename);
      if (mediaId) {
        await waSendDocument(fromId, mediaId, filename, '🧾 Cotización generada automáticamente.');
      } else {
        await waSendText(fromId, 'No pude subir el PDF a WhatsApp. Intentá de nuevo en un momento.');
      }
      try { await sheetsAppendFromSession(s, fromId, 'closed'); } catch {}
      upsertClient(fromId, { name: s.name }); // persistir cliente
      s.stage = 'closed';
      saveSession(fromId, s);
      return res.sendStatus(200);
    }

    // Guardar lastSeen aunque no haya cierre
    upsertClient(fromId, {});
    saveSession(fromId, s);
    res.sendStatus(200);
  } catch (e) {
    console.error('[WEBHOOK] Error:', e);
    res.sendStatus(200);
  }
});

export default router;
