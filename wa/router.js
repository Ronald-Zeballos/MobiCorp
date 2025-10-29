// wa/router.js
import express from "express";
import fetch from "node-fetch";
import { config } from "../env.js";
import { loadSession, saveSession } from "../core/session.js";
import { loadCatalog } from "../core/catalog.js";
import {
  waSendText,
  waSendList,
  waSendDocument,
  waUploadMediaFromFile,
  waSendImage
} from "./send.js";
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
  { key: "trench",  name: "Trench",  img: "Trench.jpg"  },
  { key: "nicoxam", name: "Nicoxam", img: "Nicoxam.jpg" } // por si luego lo usas
];

// ========= Helpers =========
function normalize(s = "") {
  return s.normalize("NFD").replace(/\p{Diacritic}+/gu, "").toLowerCase().trim();
}

// Mini-menú en texto (fallback)
function humanMenu() {
  return (
`📋 *Opciones disponibles*

🛒 *Quiero comprar*       → cotizar
🧾 *Ver catálogo*         → catalogo
🔎 *Saber de un producto*  → producto
📍 *Ubicación*            → ubicacion
🕒 *Horarios*             → horarios
👩‍💼 *Hablar con un asesor* → asesor
🧠 *IA interactiva*       → dudas`
  );
}

// ===== Botón universal "Volver al menú" (lista de 1 ítem) =====
async function sendBackList(to, text = "¿Querés hacer otra cosa?") {
  await waSendList(to, text, [{ id: "go_menu", title: "⬅️ Volver al menú" }]);
}

// ===== Menú principal =====
async function sendIntroList(to, { returned = false } = {}) {
  const headline = returned
    ? "👋 ¡Bienvenido de nuevo! ¿En qué te ayudo ahora?"
    : "👋 Soy *AgroBot*, asistente virtual de *NewChem Agroquímicos*.\nEstoy para ayudarte a comprar, resolver dudas y ubicar nuestras sucursales.";
  await waSendText(to, headline);

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

// Descargar media de WhatsApp (para audios/voice)
async function downloadWaMedia(mediaId) {
  const meta1 = await fetch(`${GRAPH_BASE}/${mediaId}`, {
    headers: { Authorization: `Bearer ${TOKEN}` }
  });
  if (!meta1.ok) throw new Error("[WA] no media meta");
  const j1 = await meta1.json();
  const url = j1?.url;
  if (!url) throw new Error("[WA] empty media url");

  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) throw new Error("[WA] download error");
  const buf = Buffer.from(await res.arrayBuffer());
  return buf;
}

// Enviar tarjeta de contacto al cliente (tipo contacts)
async function sendContactCard(to) {
  const name = config.ADVISOR_NAME || "Equipo Comercial";
  const role = config.ADVISOR_ROLE || "Asesor Comercial";
  const raw  = (config.ADVISOR_PHONE || "59165900645").replace(/\D/g, "");
  const phoneIntl = raw.startsWith("+" ) ? raw : (raw.startsWith("591") ? `+${raw}` : `+${raw}`);

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "contacts",
    contacts: [{
      name: { formatted_name: name, first_name: name.split(" ")[0] || name, last_name: name.split(" ").slice(1).join(" ") || "" },
      org: { company: "NewChem Agroquímicos", title: role },
      phones: [{ phone: phoneIntl, type: "CELL", wa_id: raw.replace(/^\+/, "") }]
    }]
  };

  const url = `${GRAPH_BASE}/${PHONE_ID}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const t = await res.text().catch(()=>"(no body)");
    throw new Error(`[WA contacts] ${res.status}: ${t}`);
  }
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
    s.items    = s.items || [];
    s.mode     = s.mode || "menu";
    s.history  = s.history || [];
    s.justBack = s.justBack || false;

    // Saludo inicial
    if (!s.greeted) {
      s.greeted = true;
      await sendIntroList(fromId, { returned: false });
      saveSession(fromId, s);
      return res.sendStatus(200);
    }

    // Normalizar input
    const type = msg.type;
    let textIn = "";
    if (type === "text") textIn = (msg.text?.body || "").trim();
    if (type === "interactive") {
      const b = msg.interactive?.button_reply || msg.interactive?.list_reply;
      textIn = b?.id || "";
    }
    const nx = normalize(textIn);

    // ===== Volver al menú (por botón o texto) =====
    if (nx === "go_menu" || /^(volver|menu|menú|inicio)$/.test(nx)) {
      s.mode = "menu";
      s.justBack = true;
      await sendIntroList(fromId, { returned: true });
      saveSession(fromId, s);
      return res.sendStatus(200);
    }

    // ===== AUDIO/VOICE -> WHISPER =====
    if (type === "audio" || type === "voice") {
      const mediaId = msg.audio?.id || msg.voice?.id;
      try {
        const buf = await downloadWaMedia(mediaId);
        const { text } = await transcribeAudio(buf, "wa_audio.ogg");
        if (text) {
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
      await sendBackList(fromId);
      saveSession(fromId, s);
      return res.sendStatus(200);
    }

    // ===== Manejo de selección del menú =====
    if (nx.startsWith("opt_")) {
      s.mode = ({
        "opt_cotizar":  "cotizar",
        "opt_catalogo": "catalogo",
        "opt_producto": "producto",
        "opt_ubicacion":"ubicacion",
        "opt_horarios": "horarios",
        "opt_asesor":   "asesor",
        "opt_dudas":    "dudas"
      })[nx] || "menu";
      textIn = "";
    }

    // ===== Flujos =====
    switch (s.mode) {

      // --- Ubicación ---
      case "ubicacion": {
        if (config.STORE_LAT && config.STORE_LNG) {
          await waSendText(fromId, `📍 Estamos aquí: https://www.google.com/maps?q=${config.STORE_LAT},${config.STORE_LNG}\nTe esperamos 🙌`);
        } else {
          await waSendText(fromId, "📍 Ubicación próximamente. Si querés, pedime al asesor y te pasa la dirección exacta.");
        }
        await sendBackList(fromId, "¿Algo más?");
        break;
      }

      // --- Horarios ---
      case "horarios": {
        await waSendList(fromId, "Elegí sucursal para ver horarios:", [
          { id: "hor_main", title: "🏬 Oficina Central" },
          { id: "hor_depo", title: "🏗️ Depósito" },
          { id: "go_menu",  title: "⬅️ Volver al menú" }
        ]);
        s.mode = "horarios_wait";
        break;
      }
      case "horarios_wait": {
        if (nx === "hor_main") {
          await waSendText(fromId, "🏬 *Casa Matriz*\nLun–Vie 8:30–12:30 / 14:30–18:30\nSáb 8:30–12:30");
        } else if (nx === "hor_depo") {
          await waSendText(fromId, "🏗️ *Depósito*\nLun–Vie 8:30–17:00");
        } else if (nx === "go_menu") {
          s.mode = "menu";
          s.justBack = true;
          await sendIntroList(fromId, { returned: true });
          break;
        } else if (textIn) {
          await waSendText(fromId, "Elegí una opción de la lista por favor.");
        }
        if (s.mode !== "menu") await sendBackList(fromId);
        break;
      }

      // --- Catálogo (URL) ---
      case "catalogo": {
        const url = config.CATALOG_URL || "Catálogo no disponible por ahora.";
        await waSendText(fromId, `🧾 *Catálogo*: ${url}\nSi querés, decime el producto y te asesoro.`);
        await sendBackList(fromId, "¿Querés volver al menú?");
        break;
      }

      // --- Asesor (tarjeta de contacto) ---
      case "asesor": {
        await waSendText(fromId, "👩‍💼 Te conecto con un asesor de nuestro equipo:");
        try {
          await sendContactCard(fromId);
        } catch (e) {
          console.error("[CONTACT] error", e);
          // fallback
          const raw = (config.ADVISOR_PHONE || "59165900645").replace(/\D/g, "");
          await waSendText(fromId, `Si te aparece el contacto, guardalo. Si no, escribí a: https://wa.me/${raw}`);
        }
        await sendBackList(fromId, "¿Volvemos al menú?");
        break;
      }

      // --- IA interactiva ---
      case "dudas": {
        if (!textIn) {
          await waSendText(fromId, "🧠 Contame tu consulta (texto o audio). Te oriento con cultivos, plagas, productos y logística. No invento precios.");
          await sendBackList(fromId);
          break;
        }
        s.history.push({ role: "user", content: textIn });
        const out = await chatIA(textIn, s.history);
        s.history.push({ role: "assistant", content: out });
        await waSendText(fromId, out);
        await sendBackList(fromId);
        break;
      }

      // --- Saber de un producto (envía imagen + CTA) ---
      case "producto": {
        // Si el usuario aún no escribió, ofrecé selección directa
        if (!textIn || nx === "producto") {
          await waSendList(fromId, "Decime el producto o elegí uno:", [
            { id: "pick_drier",   title: "Drier" },
            { id: "pick_glisato", title: "Glisato" },
            { id: "pick_layer",   title: "Layer" },
            { id: "pick_trench",  title: "Trench" },
            { id: "go_menu",      title: "⬅️ Volver al menú" }
          ]);
          s.mode = "producto_wait";
          break;
        }
        // Si escribió algo, seguimos mismo handler que producto_wait
        s.mode = "producto_wait";
        // No break → cae al siguiente case
      }

      case "producto_wait": {
        // Resolver producto desde botón o texto
        let prod = null;
        const mapBtn = {
          "pick_drier": "drier",
          "pick_glisato": "glisato",
          "pick_layer": "layer",
          "pick_trench": "trench"
        };
        if (mapBtn[nx]) {
          prod = KNOWN_PRODUCTS.find(p => p.key === mapBtn[nx]);
        } else if (nx) {
          prod = KNOWN_PRODUCTS.find(p => nx.includes(p.key));
        }

        if (nx === "go_menu") {
          s.mode = "menu";
          s.justBack = true;
          await sendIntroList(fromId, { returned: true });
          break;
        }

        if (prod) {
          // Enviar imagen local desde ./images/*
          try {
            const filePath = `./images/${prod.img}`;
            const mediaId  = await waUploadMediaFromFile(filePath, "image/jpeg", prod.img);
            if (mediaId) {
              await waSendImage(fromId, mediaId,
                `✅ *${prod.name}* — Calidad y desempeño comprobado.\n¿Querés avanzar con una cotización?`);
            }
          } catch (e) {
            console.error("[IMG UPLOAD] error", e);
          }

          // CTA posterior
          await waSendList(fromId, `¿Qué hacemos con *${prod.name}*?`, [
            { id: `prod_quote_${prod.key}`, title: "🧾 Cotizar este" },
            { id: "prod_other",             title: "🔎 Ver otro producto" },
            { id: "go_menu",                title: "⬅️ Volver al menú" }
          ]);
          s.mode = "producto_action";
          s.lastProduct = prod.name;
          break;
        }

        // No reconocido
        await waSendText(fromId, "Ese producto no lo tengo registrado. Probá con Drier, Glisato, Layer o Trench.");
        await sendBackList(fromId);
        break;
      }

      case "producto_action": {
        if (nx === "prod_other") {
          s.mode = "producto";
          // relanza el picker
          await waSendList(fromId, "Elegí un producto:", [
            { id: "pick_drier",   title: "Drier" },
            { id: "pick_glisato", title: "Glisato" },
            { id: "pick_layer",   title: "Layer" },
            { id: "pick_trench",  title: "Trench" },
            { id: "go_menu",      title: "⬅️ Volver al menú" }
          ]);
          break;
        }
        if (nx === "go_menu") {
          s.mode = "menu";
          s.justBack = true;
          await sendIntroList(fromId, { returned: true });
          break;
        }
        // prod_quote_*
        const m = nx.match(/^prod_quote_(.+)$/);
        if (m) {
          const key = m[1];
          const prod = KNOWN_PRODUCTS.find(p => p.key === key);
          if (prod) {
            // agregamos item base a la cotización
            s.items.push({ name: prod.name, qty: 1, price: null });
            await waSendText(fromId, `Perfecto, añadí *${prod.name}* a tu cotización (cant. 1). Podés ajustar luego.`);
            // Ofrezco continuar al flujo de cotización
            await waSendList(fromId, "¿Continuamos para generar tu PDF?", [
              { id: "opt_cotizar", title: "🧾 Generar cotización" },
              { id: "go_menu",     title: "⬅️ Volver al menú" }
            ]);
            s.mode = "menu"; // dejamos modo en menú; el botón decide
          } else {
            await waSendText(fromId, "No pude preparar ese producto. Probemos de nuevo.");
            await sendBackList(fromId);
          }
          break;
        }
        // si cae acá, recordá botón
        await sendBackList(fromId);
        break;
      }

      // --- Cotizar (flujo guiado) ---
      case "cotizar": {
        s.stage = s.stage || "ask_name";

        if (s.stage === "ask_name") {
          if (!textIn) {
            await waSendText(fromId, "🧾 Arranquemos tu cotización. ¿Cuál es tu *nombre completo*?");
            await sendBackList(fromId);
            break;
          }
          s.name = textIn.trim();
          s.stage = "ask_cultivo";
        }

        if (s.stage === "ask_cultivo") {
          if (!textIn || /nombre completo/i.test(textIn)) {
            await waSendList(fromId, "¿Para qué cultivo es?", [
              { id: "c_soya",  title: "Soya" },
              { id: "c_maiz",  title: "Maíz" },
              { id: "c_trigo", title: "Trigo" },
              { id: "go_menu", title: "⬅️ Volver al menú" }
            ]);
            break;
          }
          if (nx === "c_soya") s.cultivo = "Soya";
          else if (nx === "c_maiz") s.cultivo = "Maíz";
          else if (nx === "c_trigo") s.cultivo = "Trigo";
          else s.cultivo = textIn.trim();
          s.stage = "ask_hect";
        }

        if (s.stage === "ask_hect") {
          await waSendText(fromId, "¿Cuántas *hectáreas* vas a trabajar? (escribí el número)");
          s.stage = "wait_hect";
          await sendBackList(fromId);
          break;
        }

        if (s.stage === "wait_hect") {
          const n = Number((textIn || "").replace(/[^\d]/g, ""));
          if (!Number.isFinite(n) || n <= 0) {
            await waSendText(fromId, "Pasame un número válido de hectáreas, por favor.");
            await sendBackList(fromId);
            break;
          }
          s.hectareas = n;
          s.stage = "ask_camp";
        }

        if (s.stage === "ask_camp") {
          await waSendList(fromId, "¿Para qué campaña?", [
            { id: "camp_verano",   title: "Verano" },
            { id: "camp_invierno", title: "Invierno" },
            { id: "go_menu",       title: "⬅️ Volver al menú" }
          ]);
          s.stage = "wait_camp";
          break;
        }

        if (s.stage === "wait_camp") {
          if (nx === "camp_verano") s.campana = "Verano";
          else if (nx === "camp_invierno") s.campana = "Invierno";
          else { await waSendText(fromId, "Elegí una opción de campaña."); await sendBackList(fromId); break; }
          s.stage = "summary";
        }

        if (s.stage === "summary") {
          await waSendText(fromId,
            `✨ *Resumen para tu cotización*\n` +
            `• Cliente: ${s.name}\n` +
            `• Cultivo: ${s.cultivo}\n` +
            `• Hectáreas: ${s.hectareas}\n` +
            `• Campaña: ${s.campana}\n` +
            (s.items?.length ? `• Ítems: ${s.items.length}\n` : "") +
            `\nVoy a generar tu PDF ahora mismo.`);

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
          if (mediaId) await waSendDocument(fromId, mediaId, filename, "🧾 Tu cotización está lista.");
          await sendBackList(fromId, "¿Querés hacer otra gestión?");
          s.stage = null;
          break;
        }

        break;
      }

      // --- Default / texto suelto ---
      default: {
        // atajos por texto
        if (/^cotizar$/.test(nx)) s.mode = "cotizar";
        else if (/^catalogo$/.test(nx)) s.mode = "catalogo";
        else if (/^producto$/.test(nx)) s.mode = "producto";
        else if (/^ubicacion$/.test(nx)) s.mode = "ubicacion";
        else if (/^horarios$/.test(nx)) s.mode = "horarios";
        else if (/^asesor$/.test(nx)) s.mode = "asesor";
        else if (/^dudas?$/.test(nx)) s.mode = "dudas";
        else {
          await waSendText(fromId, "No te entendí bien. Mirá estas opciones y elegí una para seguir:\n\n" + humanMenu());
          await sendBackList(fromId);
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
