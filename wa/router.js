// wa/router.js
import express from "express";
import fetch from "node-fetch";
import { config } from "../env.js";
import { loadSession, saveSession } from "../core/session.js";
import { loadCatalog, searchProductByText } from "../core/catalog.js";
import { waSendText, waSendList, waSendDocument, waUploadMediaFromFile, waSendImage } from "./send.js";
import { buildQuote } from "../src/quote.js";
import { chatIA, transcribeAudio } from "../src/aichat.js";

// ======== Config WhatsApp ========
const GRAPH_BASE = "https://graph.facebook.com/v20.0";
const PHONE_ID   = config.WHATSAPP_PHONE_ID;
const TOKEN      = config.WHATSAPP_TOKEN;

// ======== Catálogo simple (imágenes locales) ========
const KNOWN_PRODUCTS = [
  { key: "drier",   name: "Drier",   img: "Drier.jpg"   },
  { key: "glisato", name: "Glisato", img: "Glisato.jpg" },
  { key: "layer",   name: "Layer",   img: "Layer.jpg"   },
  { key: "nicoxam", name: "Nicoxam", img: "Nicoxam.jpg" },
  { key: "trench",  name: "Trench",  img: "Trench.jpg"  }
];

// ========= Helpers =========
function normalize(s=""){ return s.normalize("NFD").replace(/\p{Diacritic}+/gu,"").toLowerCase().trim(); }

function humanMenu() {
  return (
`📋 *Opciones disponibles*

🛒 *Quiero comprar*       → escribí: *cotizar*
🧾 *Ver catálogo*         → escribí: *catalogo*
🔎 *Saber de un producto*  → escribí: *producto*
📍 *Ubicación*            → escribí: *ubicacion*
🕒 *Horarios*             → escribí: *horarios*
👩‍💼 *Hablar con un asesor* → escribí: *asesor*
🧠 *IA interactiva*       → escribí: *dudas*`
  );
}

// Lista interactiva inicial
async function sendIntroList(to) {
  await waSendText(to,
`👋 ¡Hola! Soy *AgroBot*, el asistente virtual de *NewChem Agroquímicos*.
Estoy para ayudarte a comprar, resolver dudas y ubicar nuestra tienda.`);
  await waSendList(to, "Elegí una opción para continuar:", [
    { id: "opt_cotizar",  title: "🛒 Quiero comprar" },
    { id: "opt_catalogo", title: "🧾 Ver catálogo" },
    { id: "opt_producto", title: "🔎 Saber de un producto" },
    { id: "opt_ubicacion",title: "📍 Ubicación" },
    { id: "opt_horarios", title: "🕒 Horarios" },
    { id: "opt_asesor",   title: "👩‍💼 Hablar con un asesor" },
    { id: "opt_dudas",    title: "🧠 IA interactiva" },
  ]);
}

// Descargar media de WhatsApp
async function downloadWaMedia(mediaId) {
  // 1) obtener url
  const meta1 = await fetch(`${GRAPH_BASE}/${mediaId}`, {
    headers: { Authorization: `Bearer ${TOKEN}` }
  });
  if (!meta1.ok) throw new Error("[WA] no media meta");
  const j1 = await meta1.json();
  const url = j1?.url;
  if (!url) throw new Error("[WA] empty media url");

  // 2) bajar binario con token
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) throw new Error("[WA] download error");
  const buf = Buffer.from(await res.arrayBuffer());
  return buf;
}

// ======== Router ========
const router = express.Router();
const catalog = loadCatalog();

// GET verify
router.get("/webhook", (req,res)=>{
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === config.VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// POST messages
router.post("/webhook", async (req,res)=>{
  try {
    const entry  = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value  = change?.value;
    const msg    = value?.messages?.[0];
    if (!msg) return res.sendStatus(200);

    const fromId = msg.from;
    let s = loadSession(fromId);
    s.items = s.items || [];
    s.mode  = s.mode || "menu";
    s.history = s.history || []; // historial para IA

    // Saludo (si primera vez en menú)
    if (!s.greeted) {
      s.greeted = true;
      await sendIntroList(fromId);
      saveSession(fromId, s);
      return res.sendStatus(200);
    }

    // Conversión input
    const type = msg.type;
    let textIn = "";
    if (type === "text")      textIn = (msg.text?.body || "").trim();
    if (type === "interactive") {
      const b = msg.interactive?.button_reply || msg.interactive?.list_reply;
      textIn = b?.id || "";
    }
    const nx = normalize(textIn);

    // ==== BACK TO MENU ====
    if (/^volver|menu|menú|inicio$/.test(nx)) {
      s.mode = "menu";
      await sendIntroList(fromId);
      saveSession(fromId, s);
      return res.sendStatus(200);
    }

    // ==== AUDIO/VOICE -> WHISPER ====
    if (type === "audio" || type === "voice") {
      const mediaId = msg.audio?.id || msg.voice?.id;
      try {
        const buf = await downloadWaMedia(mediaId);
        const { text } = await transcribeAudio(buf, "wa_audio.ogg");
        if (text) {
          // añadimos al historial y pedimos a la IA
          s.history.push({ role: "user", content: text });
          const out = await chatIA(text, s.history);
          s.history.push({ role: "assistant", content: out });
          await waSendText(fromId, `🗣️ *Transcripción:* ${text}\n\n${out}`);
        } else {
          await waSendText(fromId, "No pude oír claramente el audio. ¿Podés repetir o escribirlo?");
        }
      } catch (e) {
        console.error("[WHISPER] err", e);
        await waSendText(fromId, "No pude procesar tu audio. Intentá de nuevo o escribime tu consulta.");
      }
      saveSession(fromId, s);
      return res.sendStatus(200);
    }

    // ====== MENÚ (list selections) ======
    if (nx.startsWith("opt_")) {
      if (nx === "opt_cotizar")   s.mode = "cotizar";
      if (nx === "opt_catalogo")  s.mode = "catalogo";
      if (nx === "opt_producto")  s.mode = "producto";
      if (nx === "opt_ubicacion") s.mode = "ubicacion";
      if (nx === "opt_horarios")  s.mode = "horarios";
      if (nx === "opt_asesor")    s.mode = "asesor";
      if (nx === "opt_dudas")     s.mode = "dudas";
      textIn = ""; // seguimos flujo de cada modo
    }

    // ====== FLUJOS ======
    switch (s.mode) {
      // --- Ubicación ---
      case "ubicacion": {
        if (config.STORE_LAT && config.STORE_LNG) {
          await waSendText(fromId, `📍 Estamos aquí: https://www.google.com/maps?q=${config.STORE_LAT},${config.STORE_LNG}`);
        } else {
          await waSendText(fromId, "📍 Ubicación próximamente.");
        }
        await waSendText(fromId, "Escribí *volver* para regresar al menú.");
        break;
      }

      // --- Horarios ---
      case "horarios": {
        await waSendList(fromId, "Elegí sucursal:", [
          { id: "hor_main", title: "🏬 Casa matriz" },
          { id: "hor_depo", title: "🏗️ Depósito" },
        ]);
        s.mode = "horarios_wait";
        break;
      }
      case "horarios_wait": {
        if (nx === "hor_main") {
          await waSendText(fromId, "🏬 *Casa matriz*\nLun–Vie 8:30–12:30 / 14:30–18:30\nSáb 8:30–12:30");
        } else if (nx === "hor_depo") {
          await waSendText(fromId, "🏗️ *Depósito*\nLun–Vie 8:30–17:00");
        } else if (textIn) {
          await waSendText(fromId, "Elegí una opción de la lista o escribí *volver*.");
          saveSession(fromId, s);
          return res.sendStatus(200);
        }
        await waSendText(fromId, "Escribí *volver* para regresar al menú.");
        break;
      }

      // --- Catálogo (solo URL) ---
      case "catalogo": {
        const url = config.CATALOG_URL || "Catálogo no disponible por ahora.";
        await waSendText(fromId, `🧾 *Catálogo*: ${url}\nEscribí *volver* para regresar al menú.`);
        break;
      }

      // --- Asesor (derivación) ---
      case "asesor": {
        await waSendText(fromId, "🧑‍💼 Te contacto con un asesor:");
        await waSendText(fromId, "📞 +591 65900645\n👉 https://wa.me/59165900645");
        await waSendText(fromId, "Cuando quieras volver conmigo, escribí *volver*.");
        break;
      }

      // --- IA interactiva ---
      case "dudas": {
        if (!textIn) {
          await waSendText(fromId, "🧠 *IA interactiva*: contame tu consulta con texto o audio. Puedo orientarte sobre cultivos, plagas, productos y logística. No invento precios. Escribí *volver* para el menú.");
          break;
        }
        // chat directo con historial
        s.history.push({ role: "user", content: textIn });
        const out = await chatIA(textIn, s.history);
        s.history.push({ role: "assistant", content: out });
        await waSendText(fromId, out + "\n\n(Escribí *volver* para el menú.)");
        break;
      }

      // --- Saber de un producto (con imágenes locales) ---
      case "producto": {
        if (!textIn) {
          await waSendText(fromId, "🔎 Decime el *producto* que te interesa (ej: Drier, Nicoxam). También entiendo “tenés drier?”. Escribí *volver* para el menú.");
          break;
        }
        const prod = KNOWN_PRODUCTS.find(p => normalize(textIn).includes(p.key));
        if (prod) {
          // si tenés la imagen subida como media en Meta, deberías tener mediaId;
          // aquí enviamos *por URL* de subida previa, o por ID si ya lo tenés.
          // Para simplificar, intenta enviar la imagen desde archivo local subiéndola como media:
          try {
            const filePath = `./core/images/${prod.img}`; // ajustá ruta real
            const mediaId  = await waUploadMediaFromFile(filePath, "image/jpeg", prod.img);
            if (mediaId) await waSendImage(fromId, mediaId, `✅ Tenemos *${prod.name}*.`);
          } catch {}
          await waSendText(fromId, `✅ Tenemos *${prod.name}*. ¿Querés ver más o *cotizar*? (Escribí *volver* para menú).`);
        } else {
          await waSendText(fromId, "Ups, eso parece *otro producto*. Por ahora trabajamos con Drier, Glisato, Layer, Nicoxam y Trench. ¿Querés consultar por otro o ver *catalogo*?");
        }
        break;
      }

      // --- Cotizar (flujo básico) ---
      case "cotizar": {
        // Pedimos nombre/cultivo/hectáreas/campaña y generamos PDF
        s.stage = s.stage || "ask_name";
        if (s.stage === "ask_name") {
          if (!textIn) { await waSendText(fromId, "🧾 Vamos a armar tu cotización. ¿Cuál es tu *nombre completo*?"); break; }
          s.name = textIn.trim();
          s.stage = "ask_cultivo";
        }
        if (s.stage === "ask_cultivo") {
          if (!textIn || /nombre completo/i.test(textIn)) { await waSendList(fromId, "¿Para qué cultivo es?", [
            { id: "c_soya", title: "Soya" }, { id: "c_maiz", title: "Maíz" }, { id: "c_trigo", title: "Trigo" }
          ]); break; }
          if (nx === "c_soya") s.cultivo = "Soya";
          else if (nx === "c_maiz") s.cultivo = "Maíz";
          else if (nx === "c_trigo") s.cultivo = "Trigo";
          else s.cultivo = textIn.trim();
          s.stage = "ask_hect";
        }
        if (s.stage === "ask_hect") {
          await waSendText(fromId, "¿Cuántas *hectáreas* vas a trabajar? (escribí el número)");
          s.stage = "wait_hect";
          break;
        }
        if (s.stage === "wait_hect") {
          const n = Number(textIn.replace(/[^\d]/g,""));
          if (!Number.isFinite(n) || n<=0) { await waSendText(fromId, "Decime un número válido de hectáreas."); break; }
          s.hectareas = n;
          s.stage = "ask_camp";
        }
        if (s.stage === "ask_camp") {
          await waSendList(fromId, "¿Para qué campaña?", [
            { id: "camp_verano", title: "Verano" },
            { id: "camp_invierno", title: "Invierno" }
          ]);
          s.stage = "wait_camp";
          break;
        }
        if (s.stage === "wait_camp") {
          if (nx === "camp_verano") s.campana = "Verano";
          else if (nx === "camp_invierno") s.campana = "Invierno";
          else { await waSendText(fromId, "Elegí una opción de campaña, o escribí *volver*."); break; }
          s.stage = "summary";
        }
        if (s.stage === "summary") {
          await waSendText(fromId,
            `Perfecto, generaré una cotización con estos datos:
• Nombre: ${s.name}
• Cultivo: ${s.cultivo}
• Hectáreas: ${s.hectareas}
• Campaña: ${s.campana}
(Escribí *cotizar* otra vez si querés reiniciar.)`);
          // Generar PDF
          const { path: pdfPath, filename } = await buildQuote({
            name: s.name,
            cultivo: s.cultivo,
            hectareas: s.hectareas,
            campana: s.campana,
            departamento: s.departamento || "",
            subzona: s.subzona || "",
            items: s.items || []
          }, fromId);
          const mediaId = await waUploadMediaFromFile(pdfPath, "application/pdf", filename);
          if (mediaId) await waSendDocument(fromId, mediaId, filename, "🧾 Cotización generada.");
          await waSendText(fromId, "Escribí *volver* para ir al menú.");
          s.stage = null;
          break;
        }
        break;
      }

      // --- Menú por defecto (texto suelto) ---
      default: {
        // atajos
        if (/^cotizar$/.test(nx)) s.mode = "cotizar";
        else if (/^catalogo$/.test(nx)) s.mode = "catalogo";
        else if (/^producto$/.test(nx)) s.mode = "producto";
        else if (/^ubicacion$/.test(nx)) s.mode = "ubicacion";
        else if (/^horarios$/.test(nx)) s.mode = "horarios";
        else if (/^asesor$/.test(nx)) s.mode = "asesor";
        else if (/^dudas?$/.test(nx)) s.mode = "dudas";
        else {
          // si escribe otra cosa, recordamos menú
          await waSendText(fromId, "No te entendí bien. Estas son las opciones:\n\n" + humanMenu());
        }
        break;
      }
    }

    saveSession(fromId, s);
    res.sendStatus(200);
  } catch (e) {
    console.error("[WEBHOOK] Error:", e);
    res.sendStatus(200);
  }
});

export default router;
