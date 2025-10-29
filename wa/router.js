// wa/router.js
import express from "express";
import { config } from "../env.js";
import { loadSession, saveSession } from "../core/session.js";
import { commandFromText, isMenuText,
  DEPARTAMENTOS, SUBZONAS_SCZ, CROP_OPTIONS, HA_RANGES,
  detectDepartamento, detectSubzona, parseHectareas, looksLikeFullName } from "../core/intents.js";
import { loadCatalog, bestProductMatch } from "../core/catalog.js";
import { chatIA, transcribeAudioFile } from "../src/aichat.js";
import {
  waSendText, waSendButtons, waSendList,
  waUploadMediaFromFile, waSendDocument, waSendImageFromFile,
  waGetMediaUrl, waDownloadMedia
} from "./send.js";
import { buildQuote } from "../src/quote.js";
import { sheetsAppendFromSession } from "../src/sheets.js";

// Clientes persistentes (opcional)
import { getClient, upsertClient } from "../core/clients.js";

const router = express.Router();
const catalog = loadCatalog();

// ====== Helpers UI ======
function homeListBody() {
  return (
`👋 ¡Hola! Soy AgroBot, el asistente virtual de NewChem Agroquímicos.
Estoy para ayudarte a comprar, resolver dudas y ubicar nuestra tienda.

📋 Opciones disponibles

🛒 Quiero comprar       → escribí: cotizar
🧾 Ver catálogo         → escribí: catálogo
🔎 Saber de un producto → escribí: producto
📍 Ubicación            → escribí: ubicación
🕒 Horarios             → escribí: horarios
👩‍💼 Hablar con un asesor → escribí: asesor
🧠 IA interactiva       → escribí: dudas`
  );
}
function homeSections() {
  return [{
    title: "Seleccioná una opción",
    rows: [
      { id: "menu_cotizar",   title: "🛒 Cotizar" },
      { id: "menu_catalogo",  title: "🧾 Ver catálogo" },
      { id: "menu_producto",  title: "🔎 Saber de un producto" },
      { id: "menu_ubicacion", title: "📍 Ubicación" },
      { id: "menu_horarios",  title: "🕒 Horarios" },
      { id: "menu_asesor",    title: "👩‍💼 Hablar con un asesor" },
      { id: "menu_dudas",     title: "🧠 IA interactiva" }
    ]
  }];
}

async function sendHome(to, s) {
  s.mode = "menu";
  await waSendList(
    to,
    "AgroBot – NewChem",
    homeListBody(),
    homeSections(),
    "Escribí *volver* en cualquier momento para regresar aquí."
  );
}

// ====== Slots cotización ======
function nextMissing(s) {
  if (!s.cultivo) return "cultivo";
  if (s.hectareas == null) return "hectareas";
  if (!s.campana) return "campana";
  if (!s.departamento) return "departamento";
  if (s.departamento === "Santa Cruz" && !s.subzona) return "subzona";
  return null;
}
function shouldAskSlot(s, slot) {
  s.slotRetries = s.slotRetries || {};
  const now = Date.now();
  if (s.awaitingSlot === slot && s.awaitingAt && (now - s.awaitingAt) < 20000) return false;
  s.awaitingSlot = slot; s.awaitingAt = now;
  s.slotRetries[slot] = s.slotRetries[slot] || 0;
  return true;
}
async function askSlot(to, s, slot) {
  if (!shouldAskSlot(s, slot)) return;
  switch (slot) {
    case "cultivo":
      return waSendButtons(to, "¿Para qué *cultivo* es?", CROP_OPTIONS.map((c,i)=>({id:`crop_${i}`, title: c})));
    case "hectareas":
      await waSendButtons(to, "¿Cuántas *hectáreas* vas a trabajar?", HA_RANGES.map((h,i)=>({id:`ha_${i}`, title: h})));
      return waSendText(to, "También podés escribir el número (ej: 120).");
    case "campana":
      return waSendButtons(to, "¿Para qué *campaña*?", [
        {id:"camp_verano", title:"Verano"},
        {id:"camp_invierno", title:"Invierno"}
      ]);
    case "departamento":
      return waSendButtons(to, "¿En qué *Departamento* estás?", DEPARTAMENTOS.map((d,i)=>({id:`dep_${i}`, title: d})));
    case "subzona":
      return waSendButtons(to, "Seleccioná tu *Subzona* en Santa Cruz:", SUBZONAS_SCZ.map((z,i)=>({id:`sub_${i}`, title: z})));
  }
}
function resetSlotCooldown(s) {
  s.awaitingSlot = null; s.awaitingAt = 0;
}

// ====== Utilidades ======
function isInteractive(msg){ return msg.type === "interactive"; }
function getInteractiveId(msg){ return msg?.interactive?.button_reply?.id || msg?.interactive?.list_reply?.id; }
function textOf(msg) { return (msg?.text?.body || "").trim(); }

const HOURS = {
  lunvie: "Lunes a Viernes: 08:00 – 18:00",
  sab:    "Sábados: 08:30 – 13:00",
  fer:    "Feriados: Cerrado (consultar en fechas especiales)"
};
function horariosSections() {
  return [{
    title: "Horarios",
    rows: [
      { id:"hrs_lunvie", title:"Lunes a Viernes", description:"08:00 – 18:00" },
      { id:"hrs_sab",    title:"Sábados",         description:"08:30 – 13:00" },
      { id:"hrs_fer",    title:"Feriados",        description:"Consultar" }
    ]
  }];
}

// ====== Webhook VERIFY ======
router.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === config.VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// ====== Webhook RECEIVE ======
router.post("/webhook", async (req, res) => {
  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const msg = value?.messages?.[0];
    if (!msg) return res.sendStatus(200);

    const fromId = msg.from;
    const type = msg.type;

    let s = loadSession(fromId);
    s.items = s.items || [];

    // Saludo con nombre si existe
    if (!s.greeted) {
      s.greeted = true;
      const cli = getClient(fromId);
      const nombre = s.name || cli?.name || null;
      await waSendText(fromId, `👋 ¡Bienvenido/a ${nombre ? `*${nombre}* ` : ""}a *NewChem Agroquímicos*!`);
      await sendHome(fromId, s);
      saveSession(fromId, s);
      return res.sendStatus(200);
    }

    // Pausa por asesor
    if (s.pausedUntil && Date.now() < s.pausedUntil) {
      const t = textOf(msg);
      if (/continuar|bot|reanudar/i.test(t)) {
        s.pausedUntil = 0;
        await waSendText(fromId, "🤖 ¡Listo! Seguimos.");
      } else {
        await waSendText(fromId, "🧑‍💼 Estás con un asesor. Escribí *continuar* para volver conmigo.");
        saveSession(fromId, s);
        return res.sendStatus(200);
      }
    }

    // ===== Comando VOLVER
    const incomingText = type === "text" ? textOf(msg) : "";
    if (isMenuText(incomingText)) {
      await sendHome(fromId, s);
      saveSession(fromId, s);
      return res.sendStatus(200);
    }

    // ===== Interactivos (lista/botones)
    if (isInteractive(msg)) {
      const id = getInteractiveId(msg);
      // Menú principal
      if (id?.startsWith("menu_")) {
        if (id === "menu_cotizar") {
          s.mode = "cotizar";
          await waSendText(fromId, "🛒 ¡Perfecto! Armemos tu cotización.");
          await askSlot(fromId, s, nextMissing(s) || "cultivo");
        }
        if (id === "menu_catalogo") {
          await waSendText(fromId, `🧾 Catálogo: ${config.CATALOG_URL || "No disponible"}`);
          await waSendText(fromId, "Escribí *volver* para regresar al menú.");
        }
        if (id === "menu_producto") {
          s.mode = "producto";
          await waSendText(fromId, "🔎 Decime el *producto* que te interesa (ej: Drier, Nicoxam). También entiendo frases como “tenés drier?”. Escribí *volver* para el menú.");
        }
        if (id === "menu_ubicacion") {
          if (config.STORE_LAT && config.STORE_LNG) {
            await waSendText(fromId, `📍 Estamos aquí: https://www.google.com/maps?q=${config.STORE_LAT},${config.STORE_LNG}`);
          } else {
            await waSendText(fromId, "📍 Nuestra ubicación estará disponible pronto.");
          }
          await waSendText(fromId, "Escribí *volver* para regresar al menú.");
        }
        if (id === "menu_horarios") {
          await waSendList(fromId, "Horarios de atención", "Elegí una opción:", horariosSections(), "Escribí *volver* para regresar al menú.");
        }
        if (id === "menu_asesor") {
          s.pausedUntil = Date.now() + 4 * 60 * 60 * 1000;
          await waSendText(fromId, "👩‍💼 Te conecto con un asesor.");
          await waSendText(fromId, "📞 +591 65900645\n👉 https://wa.me/59165900645");
          await waSendText(fromId, "Para volver conmigo, escribí *continuar*.");
        }
        if (id === "menu_dudas") {
          s.mode = "dudas";
          await waSendText(fromId,
            "🧠 *IA interactiva*: contame tu consulta con texto o audio. " +
            "Puedo orientarte sobre cultivos, plagas, productos y logística. " +
            "No invento precios; si querés, después *cotizamos*. Escribí *volver* para el menú."
          );
        }
        saveSession(fromId, s);
        return res.sendStatus(200);
      }

      // Submenú Horarios
      if (/^hrs_/.test(id || "")) {
        if (id === "hrs_lunvie") await waSendText(fromId, `🕒 ${HOURS.lunvie}`);
        if (id === "hrs_sab")    await waSendText(fromId, `🕒 ${HOURS.sab}`);
        if (id === "hrs_fer")    await waSendText(fromId, `🕒 ${HOURS.fer}`);
        await waSendText(fromId, "Escribí *volver* para regresar al menú.");
        saveSession(fromId, s);
        return res.sendStatus(200);
      }

      // Botones slots
      if (/^dep_/.test(id)) {
        const idx = Number(id.split("_")[1]); const dep = DEPARTAMENTOS[idx];
        if (dep) { s.departamento = dep; resetSlotCooldown(s); }
        if (dep === "Santa Cruz") await askSlot(fromId, s, "subzona");
        else await askSlot(fromId, s, nextMissing(s));
        saveSession(fromId, s);
        return res.sendStatus(200);
      }
      if (/^sub_/.test(id)) {
        const idx = Number(id.split("_")[1]); const sub = SUBZONAS_SCZ[idx];
        if (sub) { s.subzona = sub; resetSlotCooldown(s); }
        await askSlot(fromId, s, nextMissing(s));
        saveSession(fromId, s);
        return res.sendStatus(200);
      }
      if (/^crop_/.test(id)) {
        const idx = Number(id.split("_")[1]); const cult = CROP_OPTIONS[idx];
        if (cult) { s.cultivo = cult === "Otro…" ? null : cult; resetSlotCooldown(s); }
        await askSlot(fromId, s, nextMissing(s));
        saveSession(fromId, s);
        return res.sendStatus(200);
      }
      if (/^ha_/.test(id)) {
        // si elige rango, no numérico; pedimos campaña
        resetSlotCooldown(s);
        await askSlot(fromId, s, "campana");
        saveSession(fromId, s);
        return res.sendStatus(200);
      }
      if (/^camp_/.test(id)) {
        s.campana = id === "camp_verano" ? "Verano" : "Invierno";
        resetSlotCooldown(s);
        await askSlot(fromId, s, nextMissing(s));
        saveSession(fromId, s);
        return res.sendStatus(200);
      }
    }

    // ===== Audio → Whisper → tratar como texto =====
    if (type === "audio") {
      // 1) Obtener URL
      const mediaId = msg.audio?.id;
      const url = mediaId ? await waGetMediaUrl(mediaId) : null;
      if (url) {
        const out = `data/tmp/wa_${fromId}_${Date.now()}.ogg`;
        await waDownloadMedia(url, out);
        const text = await transcribeAudioFile(out);
        if (text) {
          // Tratar como texto
          req.body.__transcribed_text = text;
        }
      }
    }

    // ===== Texto libre o transcripción
    const text = req.body.__transcribed_text || incomingText;

    // Atajos por texto a menú (por si no usa lista)
    const cmd = commandFromText(text);
    if (cmd) {
      if (cmd === "cotizar") {
        s.mode = "cotizar";
        await waSendText(fromId, "🛒 ¡Perfecto! Armemos tu cotización.");
        await askSlot(fromId, s, nextMissing(s) || "cultivo");
      } else if (cmd === "catalogo") {
        await waSendText(fromId, `🧾 Catálogo: ${config.CATALOG_URL || "No disponible"}`);
        await waSendText(fromId, "Escribí *volver* para regresar al menú.");
      } else if (cmd === "producto") {
        s.mode = "producto";
        await waSendText(fromId, "🔎 Decime el *producto* que te interesa (ej: Drier, Nicoxam). También entiendo “tenés drier?”. Escribí *volver* para el menú.");
      } else if (cmd === "ubicacion") {
        if (config.STORE_LAT && config.STORE_LNG) {
          await waSendText(fromId, `📍 Estamos aquí: https://www.google.com/maps?q=${config.STORE_LAT},${config.STORE_LNG}`);
        } else {
          await waSendText(fromId, "📍 Nuestra ubicación estará disponible pronto.");
        }
        await waSendText(fromId, "Escribí *volver* para regresar al menú.");
      } else if (cmd === "horarios") {
        await waSendList(fromId, "Horarios de atención", "Elegí una opción:", horariosSections(), "Escribí *volver* para el menú.");
      } else if (cmd === "asesor") {
        s.pausedUntil = Date.now() + 4 * 60 * 60 * 1000;
        await waSendText(fromId, "👩‍💼 Te conecto con un asesor.");
        await waSendText(fromId, "📞 +591 65900645\n👉 https://wa.me/59165900645");
        await waSendText(fromId, "Para volver conmigo, escribí *continuar*.");
      } else if (cmd === "dudas") {
        s.mode = "dudas";
        await waSendText(fromId,
          "🧠 *IA interactiva*: contame tu consulta con texto o audio. " +
          "Puedo orientarte sobre cultivos, plagas, productos y logística. " +
          "No invento precios; si querés, después *cotizamos*. Escribí *volver* para el menú."
        );
      }
      saveSession(fromId, s);
      return res.sendStatus(200);
    }

    // ===== Modo: SABER DE UN PRODUCTO
    if (s.mode === "producto" && (type === "text" || req.body.__transcribed_text)) {
      const match = bestProductMatch(catalog, text);
      if (match) {
        await waSendText(fromId, `✅ Sí, contamos con *${match.name}*.`);
        await waSendImageFromFile(fromId, match.file, `${match.name} – imagen de referencia`);
        await waSendText(fromId, "¿Querés que lo *agregue a tu cotización*? Escribí *cotizar* para avanzar.");
      } else {
        await waSendText(fromId, "Ups, eso parece *otro producto*. Por ahora trabajamos con Drier, Glisato, Layer, Nicoxam y Trench. ¿Querés consultar por otro o *ver catálogo*?");
      }
      saveSession(fromId, s);
      return res.sendStatus(200);
    }

    // ===== Modo: IA INTERACTIVA
    if (s.mode === "dudas" && (type === "text" || req.body.__transcribed_text)) {
      const userMsg = text;
      const reply = await chatIA(userMsg, s.aiHistory);
      s.aiHistory = (s.aiHistory || []).concat(
        { role:"user", content: userMsg },
        { role:"assistant", content: reply }
      ).slice(-16);
      await waSendText(fromId, reply);
      await waSendText(fromId, "Tip: Escribí *cotizar* si querés que armemos tu PDF, o *volver* para el menú.");
      saveSession(fromId, s);
      return res.sendStatus(200);
    }

    // ===== Modo: COTIZAR (slots por texto libre)
    if (s.mode === "cotizar" && (type === "text" || req.body.__transcribed_text)) {
      // name (solo al final)
      // Detectar posibles campos por texto
      if (!s.cultivo) {
        const m = /soya|soja|maiz|maíz|trigo|arroz|girasol/i.exec(text);
        if (m) { s.cultivo = m[0].toLowerCase().replace("soja","soya").replace("maiz","maíz"); resetSlotCooldown(s); }
      }
      if (s.hectareas == null) {
        const h = parseHectareas(text);
        if (Number.isFinite(h)) { s.hectareas = h; resetSlotCooldown(s); }
      }
      if (!s.campana) {
        if (/invierno/i.test(text)) { s.campana = "Invierno"; resetSlotCooldown(s); }
        if (/verano/i.test(text))   { s.campana = "Verano"; resetSlotCooldown(s); }
      }
      if (!s.departamento) {
        const dep = detectDepartamento(text);
        if (dep) { s.departamento = dep; resetSlotCooldown(s); }
      }
      if (s.departamento === "Santa Cruz" && !s.subzona) {
        const sub = detectSubzona(text);
        if (sub) { s.subzona = sub; resetSlotCooldown(s); }
      }

      // Pedir lo que falte
      const missing = nextMissing(s);
      if (missing) {
        await askSlot(fromId, s, missing);
        saveSession(fromId, s);
        return res.sendStatus(200);
      }

      // Resumen y PDF
      if (!s.name) {
        if (looksLikeFullName(text)) {
          s.name = text.trim();
        } else {
          await waSendText(fromId, "📄 Casi listo. ¿A nombre de quién emitimos la cotización? (Nombre y apellido)");
          saveSession(fromId, s);
          return res.sendStatus(200);
        }
      }

      const { path: pdfPath, filename } = await buildQuote(s, fromId);
      const mediaId = await waUploadMediaFromFile(pdfPath, "application/pdf", filename);
      if (mediaId) {
        await waSendDocument(fromId, mediaId, filename, "🧾 Cotización lista. ¡Gracias!");
        try { await sheetsAppendFromSession(s, fromId, "closed"); } catch {}
        if (s.name) upsertClient(fromId, { name: s.name });
        s.mode = "closed";
      } else {
        await waSendText(fromId, "No pude subir el PDF a WhatsApp. Intentá de nuevo en un momento.");
      }
      saveSession(fromId, s);
      return res.sendStatus(200);
    }

    // Si nada coincidió y el usuario está perdido → recordatorio de menú
    if (type === "text") {
      await waSendText(fromId, "¿Te ayudo con algo más? Escribí *volver* para ver el menú.");
    }

    saveSession(fromId, s);
    res.sendStatus(200);
  } catch (e) {
    console.error("[WEBHOOK] Error:", e);
    res.sendStatus(200);
  }
});

export default router;
