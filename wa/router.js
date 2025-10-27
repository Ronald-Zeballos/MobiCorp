// wa/router.js
import express from 'express';
import { config } from '../env.js';
import { loadSession, saveSession } from '../core/session.js';
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

// --- Idempotencia por wamid (TTL 5 min) ---
const processed = new Map();
const TTL = 5 * 60 * 1000;
function seen(id) {
  const now = Date.now();
  for (const [k, v] of processed) if (now - v > TTL) processed.delete(k);
  if (processed.has(id)) return true;
  processed.set(id, now);
  return false;
}

// --- GET /wa/webhook (verificación Meta) ---
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

// --- POST /wa/webhook (mensajes entrantes) ---
router.post('/webhook', async (req, res) => {
  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const msg = value?.messages?.[0];
    if (!msg) return res.sendStatus(200);

    const type = msg.type;
    const wamid = msg.id;
    const fromId = msg.from;

    if (seen(wamid)) return res.sendStatus(200);

    let s = loadSession(fromId);
    s.lastWamid = wamid;

    // Pausa por asesor humano
    if (s.pausedUntil && Date.now() < s.pausedUntil) {
      const t = msg?.text?.body || '';
      if (/continuar|reanudar|bot/i.test(t)) {
        s.pausedUntil = 0;
        await waSendText(fromId, '🤖 Volví. Continuemos.');
      } else {
        await waSendText(fromId, '🧑‍💼 Estás con un asesor. Escribe "continuar" para volver con el bot.');
        saveSession(fromId, s);
        return res.sendStatus(200);
      }
    }

    // Texto / botones / listas / location
    let incomingText = '';
    if (type === 'text') incomingText = msg.text?.body || '';
    if (type === 'interactive') {
      const n = msg.interactive?.button_reply || msg.interactive?.list_reply;
      if (n?.id) incomingText = n.id;
    }
    if (type === 'button') incomingText = msg.button?.text || msg.button?.payload || '';
    if (type === 'location') {
      s.userLocation = { lat: msg.location?.latitude, lng: msg.location?.longitude };
      await waSendText(fromId, '📍 ¡Gracias! Guardé tu ubicación.');
    }

    if (config.DEBUG_LOGS) console.log('[IN <-]', type, incomingText);

    // Intenciones globales
    if (wantsCatalog(incomingText)) {
      await waSendText(fromId, `🛒 Catálogo: ${config.CATALOG_URL || 'No disponible'}`);
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
      s.pausedUntil = Date.now() + 4 * 60 * 60 * 1000; // 4h
      await waSendText(fromId, '🧑‍💼 Te conectamos con un asesor. Pausamos el bot por 4 horas.');
      saveSession(fromId, s);
      return res.sendStatus(200);
    }
    if (wantsClose(incomingText)) {
      s.stage = 'closed';
      await waSendText(fromId, '✅ Conversación finalizada. ¡Gracias!');
      saveSession(fromId, s);
      return res.sendStatus(200);
    }

    // Detecta “carrito pegado” y ofrece cotizar
    if (type === 'text' && !/^(dep_|sub_|crop_|ha_|camp_|do_quote)/.test((incomingText || '').trim())) {
      const cart = parseCartFromText(incomingText);
      if (cart) {
        s.items = cart.items;
        s.stage = 'checkout';
        await waSendText(fromId, '🧺 Detecté tu carrito. Te muestro un resumen:');
        await waSendText(fromId, `${summaryText(s)}\n\n¿Generamos tu PDF de cotización?`);
        await waSendButtons(fromId, 'Generar PDF de cotización', btnCotizar());
        saveSession(fromId, s);
        return res.sendStatus(200);
      }
    }

    // FLUJO GUIADO
    if (!s.stage) s.stage = 'discovery';

    // 1) Datos iniciales
    if (s.stage === 'discovery') {
      if (!s.name) {
        if (looksLikeFullName(incomingText)) {
          s.name = incomingText.trim();
          await waSendButtons(fromId, 'Elige tu *Departamento*:', btnsDepartamento());
        } else {
          await waSendText(fromId, '¡Hola! ¿Cómo te llamas? (Nombre y apellido)');
        }
      } else if (!s.departamento) {
        const dep = incomingText.startsWith('dep_')
          ? (['Santa Cruz','Beni','Pando','La Paz','Cochabamba','Oruro','Potosí','Chuquisaca','Tarija'][Number(incomingText.split('_')[1])])
          : detectDepartamento(incomingText);
        if (dep) {
          s.departamento = dep;
          if (dep === 'Santa Cruz') {
            await waSendButtons(fromId, 'Selecciona tu *Subzona*:', btnsSubzonaSCZ());
          } else {
            await waSendButtons(fromId, 'Selecciona tu *Cultivo*:', btnsCultivos());
            s.stage = 'product';
          }
        } else {
          await waSendButtons(fromId, 'Por favor, elige un *Departamento*:', btnsDepartamento());
        }
      } else if (s.departamento === 'Santa Cruz' && !s.subzona) {
        const sub = incomingText.startsWith('sub_')
          ? (['Norte Integrado','Chiquitania','Vallegrande','Cordillera','Andrés Ibáñez','Warnes','Obispo Santistevan'][Number(incomingText.split('_')[1])])
          : detectSubzona(incomingText);
        if (sub) {
          s.subzona = sub;
          await waSendButtons(fromId, 'Selecciona tu *Cultivo*:', btnsCultivos());
          s.stage = 'product';
        } else {
          await waSendButtons(fromId, 'Elige una *Subzona* de Santa Cruz:', btnsSubzonaSCZ());
        }
      }
    }

    // 2) Producto
    if (s.stage === 'product') {
      if (!s.cultivo) {
        if (incomingText.startsWith('crop_')) {
          const idx = Number(incomingText.split('_')[1]);
          s.cultivo = ['Soya','Maíz','Trigo','Arroz','Girasol','Otro…'][idx] || 'Otro…';
          await waSendButtons(fromId, '¿Cuántas *Hectáreas*?', btnsHectareas());
        } else {
          await waSendButtons(fromId, 'Selecciona tu *Cultivo*:', btnsCultivos());
        }
      } else if (!s.hectareas) {
        if (incomingText.startsWith('ha_')) {
          const idx = Number(incomingText.split('_')[1]);
          s.hectareas = ['<50','50-100','100-300','300-500','>500','Otra…'][idx] || 'Otra…';
          await waSendButtons(fromId, '¿Para qué *Campaña*?', btnsCampana());
        } else {
          const h = parseHectareas(incomingText);
          if (h) {
            s.hectareas = h;
            await waSendButtons(fromId, '¿Para qué *Campaña*?', btnsCampana());
          } else {
            await waSendButtons(fromId, 'Elige un rango de *Hectáreas*:', btnsHectareas());
          }
        }
      } else if (!s.campana) {
        if (incomingText.startsWith('camp_')) {
          s.campana = incomingText === 'camp_verano' ? 'Verano' : 'Invierno';
          s.stage = 'checkout';
          await waSendText(fromId, `${summaryText(s)}\n\n¿Deseas una cotización en PDF?`);
          await waSendButtons(fromId, 'Generar PDF de cotización', btnCotizar());
        } else {
          await waSendButtons(fromId, 'Elige *Campaña*:', btnsCampana());
        }
      }
    }

    // 3) Checkout → generar PDF
    if (s.stage === 'checkout') {
      if (incomingText === 'do_quote' || wantsPrice(incomingText)) {
        const { path: pdfPath, filename } = await buildQuote(s, fromId);
        const mediaId = await waUploadMediaFromFile(pdfPath, 'application/pdf', filename);
        if (mediaId) {
          await waSendDocument(fromId, mediaId, filename, '🧾 Cotización generada automáticamente.');
        } else {
          await waSendText(fromId, 'No pude subir el PDF a WhatsApp. Intenta más tarde.');
        }
        // Sheets opcional (no rompe si está deshabilitado)
        try { await sheetsAppendFromSession(s, fromId, 'closed'); } catch {}
        s.stage = 'closed';
      } else {
        await waSendButtons(fromId, '¿Generamos tu PDF de cotización?', btnCotizar());
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
