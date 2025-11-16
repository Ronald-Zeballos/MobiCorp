// wa/router.js
import express from "express";
import fetch from "node-fetch";
import { config } from "../env.js";
import { loadSession, saveSession } from "../core/session.js";
import {
  waSendText,
  waSendList,
  waSendDocument,
  waUploadMediaFromFile
} from "./send.js";
import { buildQuote } from "../src/quote.js";
import { chatIA, transcribeAudio } from "../src/aichat.js";
import { parseCartFromText } from "../src/parse.js";

// ======== Config WhatsApp ========
const GRAPH_BASE = "https://graph.facebook.com/v20.0";
const PHONE_ID = config.WHATSAPP_PHONE_ID;
const TOKEN = config.WHATSAPP_TOKEN;

// ===== Utils =====
function normalize(s = "") {
  return s.normalize("NFD").replace(/\p{Diacritic}+/gu, "").toLowerCase().trim();
}

function humanTotal(subtotal) {
  const n = Number(subtotal || 0);
  const s = n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `Bs ${s}`;
}

// detecta “hola”, “buenas”, etc.
function isGreeting(text = "") {
  const t = normalize(text);
  if (!t) return false;
  return [
    "hola",
    "holaa",
    "holaaa",
    "buenas",
    "buen dia",
    "buen día",
    "buenas tardes",
    "buenas noches",
    "qué tal",
    "que tal",
    "hey",
    "ola"
  ].some((g) => t === g || t.startsWith(g + " "));
}

// Nombre más o menos razonable (no 1 letra, no solo saludo)
function isLikelyName(text = "") {
  const t = text.trim();
  if (t.length < 3) return false;
  if (isGreeting(t)) return false;
  // al menos dos palabras o una palabra medio larga
  const parts = t.split(/\s+/);
  if (parts.length >= 2) return true;
  return t.length >= 4;
}

function getCatalogUrl(tipoEspacio = "") {
  const key = tipoEspacio.toLowerCase();
  if (key.includes("oficina"))
    return config.CATALOG_URL_OFICINA || config.CATALOG_URL;
  if (key.includes("hogar"))
    return config.CATALOG_URL_HOGAR || config.CATALOG_URL;
  if (key.includes("local"))
    return config.CATALOG_URL_LOCAL || config.CATALOG_URL;
  if (key.includes("consultorio") || key.includes("clinica") || key.includes("clínica"))
    return config.CATALOG_URL_CONSULTORIO || config.CATALOG_URL;
  return config.CATALOG_URL_OTRO || config.CATALOG_URL;
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

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${TOKEN}` }
  });
  if (!res.ok) throw new Error("[WA] download error");
  const buf = Buffer.from(await res.arrayBuffer());
  return buf;
}

// Enviar tarjeta de contacto (Hablar con un ejecutivo)
async function sendContactCard(to) {
  const name = config.ADVISOR_NAME || "Equipo Mobicorp";
  const role = config.ADVISOR_ROLE || "Asesor Comercial";
  const raw = (config.ADVISOR_PHONE || "59170000000").replace(/\D/g, "");
  const phoneIntl = raw.startsWith("+") ? raw : `+${raw}`;

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "contacts",
    contacts: [
      {
        name: {
          formatted_name: name,
          first_name: name.split(" ")[0] || name,
          last_name: name.split(" ").slice(1).join(" ") || ""
        },
        org: { company: "Mobicorp", title: role },
        phones: [{ phone: phoneIntl, type: "CELL", wa_id: raw.replace(/^\+/, "") }]
      }
    ]
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
    const t = await res.text().catch(() => "(no body)");
    throw new Error(`[WA contacts] ${res.status}: ${t}`);
  }
}

// ======== Mensajes de flujo ========

async function sendB1(to) {
  await waSendText(
    to,
    "👋 ¡Hola! Soy el asistente virtual de *Mobicorp*.\nTe ayudo a cotizar muebles para tu proyecto.\n\nPara empezar, ¿cuál es tu *nombre completo*? (Ej: Juan Pérez)"
  );
}

// primer intento vs repetición
async function sendB2(to, nombre, { first = false } = {}) {
  const prefix = first ? `Gracias, ${nombre} 😊\n` : "";
  await waSendList(
    to,
    `${prefix}¿Nos escribís como…?`,
    [
      { id: "tipo_empresa", title: "Empresa" },
      { id: "tipo_arquitecto", title: "Arquitecto / Diseñador" },
      { id: "tipo_particular", title: "Particular" }
    ]
  );
}

async function sendB3(to) {
  await waSendList(
    to,
    "¿Desde qué *ciudad / departamento* de Bolivia nos escribís?",
    [
      { id: "ciudad_sc", title: "Santa Cruz" },
      { id: "ciudad_lp", title: "La Paz" },
      { id: "ciudad_cbba", title: "Cochabamba" },
      { id: "ciudad_otro", title: "Otro" }
    ]
  );
}

async function sendB5(to) {
  await waSendList(
    to,
    "¿Para qué tipo de *espacio* necesitás los muebles?",
    [
      { id: "esp_oficina", title: "Oficina" },
      { id: "esp_hogar", title: "Hogar" },
      { id: "esp_local", title: "Local comercial / tienda" },
      { id: "esp_consultorio", title: "Consultorio / clínica" },
      { id: "esp_otro", title: "Otro" }
    ]
  );
}

function renderProductosDetalle(items = []) {
  if (!items.length) return "-";
  return items
    .map((it) => {
      const qty = it.qty || 1;
      const unit = it.price ? `Bs ${it.price.toFixed(2)}` : "sin precio";
      const sub = it.price ? ` → Bs ${(it.price * qty).toFixed(2)}` : "";
      return `• ${it.name} x${qty} (${unit})${sub}`;
    })
    .join("\n");
}

// ======== Router ========
const router = express.Router();

// GET verify
router.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === config.VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// POST messages
router.post("/webhook", async (req, res) => {
  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const msg = value?.messages?.[0];
    if (!msg) return res.sendStatus(200);

    const fromId = msg.from;
    let s = loadSession(fromId) || {};
    s.flow = s.flow || "inicio"; // "inicio" | "catalog" | "ia"
    s.stage = s.stage || null;
    s.items = s.items || [];
    s.history = s.history || [];
    s.flags = s.flags || {}; // banderas para validaciones

    // perfil de WhatsApp para usar como default de nombre
    const profileName = value?.contacts?.[0]?.profile?.name;
    if (!s.nombre && profileName && isLikelyName(profileName)) {
      s.nombre = profileName.trim();
    }

    const type = msg.type;
    let textIn = "";

    if (type === "text") textIn = (msg.text?.body || "").trim();
    if (type === "interactive") {
      const b = msg.interactive?.button_reply || msg.interactive?.list_reply;
      textIn = b?.id || "";
    }

    const nx = normalize(textIn);

    // ===== Comandos rápidos =====
    if (nx === "reiniciar" || nx === "reset" || nx === "inicio") {
      s = { flow: "inicio", stage: null, items: [], history: [], flags: {} };
      await waSendText(
        fromId,
        "🔄 Reinicié la conversación para una nueva cotización."
      );
      await sendB1(fromId);
      saveSession(fromId, s);
      return res.sendStatus(200);
    }

    // ===== AUDIO/VOICE → Whisper + IA (no rompe flujo) =====
    if (type === "audio" || type === "voice") {
      const mediaId = msg.audio?.id || msg.voice?.id;
      try {
        const buf = await downloadWaMedia(mediaId);
        const { text } = await transcribeAudio(buf, "wa_audio.ogg");
        if (text) {
          s.history.push({ role: "user", content: text });
          const out = await chatIA(
            text,
            s.history,
            "El usuario envía su consulta por audio mientras está cotizando muebles con Mobicorp."
          );
          s.history.push({ role: "assistant", content: out });
          await waSendText(
            fromId,
            `🗣️ *Transcripción de tu audio:*\n"${text}"\n\n${out}`
          );
        } else {
          await waSendText(
            fromId,
            "No pude oír claramente el audio. ¿Podés repetir o escribirme tu consulta?"
          );
        }
      } catch (e) {
        console.error("[WHISPER] err", e);
        await waSendText(
          fromId,
          "No pude procesar tu audio. Intentá de nuevo o escribime tu consulta."
        );
      }
      saveSession(fromId, s);
      return res.sendStatus(200);
    }

    // ===== Detectar carrito pegado desde la web (entrada C1) =====
    let parsedCart = null;
    if (type === "text" && textIn && s.stage !== "B1") {
      // solo intentamos parsear carrito si ya pasamos B1 (para no confundir el nombre con carrito)
      parsedCart = parseCartFromText(textIn);
    }

    if (parsedCart && parsedCart.items.length) {
      // Arranca flujo "Desde catálogo web"
      s.flow = "catalog";
      s.stage = "C1";
      s.items = parsedCart.items;
      s.subtotalPreliminar = parsedCart.subtotal;
      s.rawCartText = textIn;

      const nombre = s.nombre || "allí";
      await waSendText(
        fromId,
        `👋 ¡Hola ${nombre}!\nRecibí tu selección desde el *catálogo web de Mobicorp* 👌\n\nEsto es lo que elegiste:\n${renderProductosDetalle(
          s.items
        )}\n\n¿Está correcto tu listado?`
      );
      await waSendList(fromId, "Confirmá tu listado:", [
        { id: "cart_ok", title: "Sí, está correcto" },
        { id: "cart_fix", title: "Quiero corregir algo" }
      ]);

      saveSession(fromId, s);
      return res.sendStatus(200);
    }

    // ================= FLUJO 1: INICIO WHATSAPP (B1–B6) =================
    if (s.flow === "inicio") {
      // Si no hay etapa, empezamos en B1
      if (!s.stage) {
        s.stage = "B1";
        await sendB1(fromId);
        saveSession(fromId, s);
        return res.sendStatus(200);
      }

      // ---------- B1: pedir nombre ----------
      if (s.stage === "B1") {
        if (!textIn) {
          await waSendText(
            fromId,
            "Decime tu *nombre completo* para avanzar, por favor. (Ej: María García)"
          );
          saveSession(fromId, s);
          return res.sendStatus(200);
        }

        if (!isLikelyName(textIn)) {
          await waSendText(
            fromId,
            "Para continuar necesito tu *nombre completo* (nombre y apellido). Ejemplo: *Juan Pérez*."
          );
          saveSession(fromId, s);
          return res.sendStatus(200);
        }

        s.nombre = textIn.trim().replace(/\s+/g, " ");
        s.stage = "B2";
        s.flags.b2Welcomed = false;
        await sendB2(fromId, s.nombre, { first: true });
        s.flags.b2Welcomed = true;
        saveSession(fromId, s);
        return res.sendStatus(200);
      }

      // ---------- B2: tipo de cliente ----------
      if (s.stage === "B2") {
        if (!textIn) {
          await waSendText(
            fromId,
            "Elegí una opción de la lista o escribí *Empresa*, *Arquitecto* o *Particular*."
          );
          await sendB2(fromId, s.nombre || "allí", { first: false });
          saveSession(fromId, s);
          return res.sendStatus(200);
        }

        if (nx === "tipo_empresa" || textIn.toLowerCase().includes("empresa")) {
          s.tipoCliente = "Empresa";
        } else if (
          nx === "tipo_arquitecto" ||
          textIn.toLowerCase().includes("arquitect") ||
          textIn.toLowerCase().includes("diseñador")
        ) {
          s.tipoCliente = "Arquitecto / Diseñador";
        } else if (
          nx === "tipo_particular" ||
          textIn.toLowerCase().includes("particular")
        ) {
          s.tipoCliente = "Particular";
        } else {
          await waSendText(
            fromId,
            "No identifiqué el tipo de cliente. Escribí *Empresa*, *Arquitecto / Diseñador* o *Particular*, o usá el botón *Elegir*."
          );
          await sendB2(fromId, s.nombre || "allí", { first: false });
          saveSession(fromId, s);
          return res.sendStatus(200);
        }

        s.stage = "B3";
        await sendB3(fromId);
        saveSession(fromId, s);
        return res.sendStatus(200);
      }

      // ---------- B3: ciudad ----------
      if (s.stage === "B3") {
        if (!textIn) {
          await sendB3(fromId);
          saveSession(fromId, s);
          return res.sendStatus(200);
        }

        if (isGreeting(textIn)) {
          await waSendText(
            fromId,
            "Para seguir necesito saber desde qué *ciudad / departamento* de Bolivia nos escribís (por ejemplo: Santa Cruz)."
          );
          await sendB3(fromId);
          saveSession(fromId, s);
          return res.sendStatus(200);
        }

        if (nx === "ciudad_sc" || textIn.toLowerCase().includes("santa cruz")) {
          s.ciudad = "Santa Cruz";
        } else if (nx === "ciudad_lp" || textIn.toLowerCase().includes("la paz")) {
          s.ciudad = "La Paz";
        } else if (
          nx === "ciudad_cbba" ||
          textIn.toLowerCase().includes("cochabamba")
        ) {
          s.ciudad = "Cochabamba";
        } else if (nx === "ciudad_otro") {
          await waSendText(
            fromId,
            "Perfecto, ¿de qué ciudad nos escribís? Ej: Tarija, Sucre, Potosí…"
          );
          s.stage = "B3_WAIT_OTHER";
          saveSession(fromId, s);
          return res.sendStatus(200);
        } else {
          s.ciudad = textIn.trim();
        }

        s.stage = "B4";
        await waSendText(
          fromId,
          `¿En qué *zona o barrio* de ${s.ciudad} estás?`
        );
        saveSession(fromId, s);
        return res.sendStatus(200);
      }

      if (s.stage === "B3_WAIT_OTHER") {
        if (!textIn || isGreeting(textIn)) {
          await waSendText(
            fromId,
            "Decime el nombre de tu ciudad para poder ubicar mejor la propuesta 🙂"
          );
          saveSession(fromId, s);
          return res.sendStatus(200);
        }
        s.ciudad = textIn.trim();
        s.stage = "B4";
        await waSendText(
          fromId,
          `¿En qué *zona o barrio* de ${s.ciudad} estás?`
        );
        saveSession(fromId, s);
        return res.sendStatus(200);
      }

      // ---------- B4: zona/barrio ----------
      if (s.stage === "B4") {
        if (!textIn || isGreeting(textIn)) {
          await waSendText(
            fromId,
            `Decime en qué *zona o barrio* de ${s.ciudad} estás. Ej: Equipetrol, Centro, Sur…`
          );
          saveSession(fromId, s);
          return res.sendStatus(200);
        }

        s.zona = textIn.trim();
        s.stage = "B5";
        await sendB5(fromId);
        saveSession(fromId, s);
        return res.sendStatus(200);
      }

      // ---------- B5: tipo de espacio ----------
      if (s.stage === "B5") {
        if (!textIn) {
          await sendB5(fromId);
          saveSession(fromId, s);
          return res.sendStatus(200);
        }

        if (nx === "esp_oficina" || textIn.toLowerCase().includes("oficina")) {
          s.tipoEspacio = "Oficina";
        } else if (nx === "esp_hogar" || textIn.toLowerCase().includes("hogar")) {
          s.tipoEspacio = "Hogar";
        } else if (nx === "esp_local" || textIn.toLowerCase().includes("local")) {
          s.tipoEspacio = "Local comercial / tienda";
        } else if (
          nx === "esp_consultorio" ||
          textIn.toLowerCase().includes("consultorio") ||
          textIn.toLowerCase().includes("clinica") ||
          textIn.toLowerCase().includes("clínica")
        ) {
          s.tipoEspacio = "Consultorio / clínica";
        } else if (nx === "esp_otro") {
          await waSendText(
            fromId,
            "Contame brevemente qué tipo de espacio es (ej: sala de reuniones, cowork, recepción, sala de espera…)."
          );
          s.stage = "B5_WAIT_OTHER";
          saveSession(fromId, s);
          return res.sendStatus(200);
        } else if (isGreeting(textIn)) {
          await waSendText(
            fromId,
            "Elegí una de las opciones (Oficina, Hogar, Local, Consultorio) o describí el tipo de espacio."
          );
          await sendB5(fromId);
          saveSession(fromId, s);
          return res.sendStatus(200);
        } else {
          s.tipoEspacio = textIn.trim();
        }

        s.stage = "B6";
        const url = getCatalogUrl(s.tipoEspacio);
        const msgCatalogo =
          url && url.startsWith("http")
            ? `Perfecto, ${s.nombre}.\nTe comparto nuestro catálogo web para *${s.tipoEspacio}*:\n${url}\n\nAhí podés ver modelos, precios y elegir cantidades.\n\nCuando termines tu selección, en la web tocá el botón *“Enviar a WhatsApp / Solicitar cotización”* y seguimos por acá con tu cotización automática ✅`
            : `Perfecto, ${s.nombre}.\n\nTe comparto nuestro catálogo web para *${s.tipoEspacio}* (pedí el link a tu ejecutivo si aún no lo tenés).\n\nCuando termines tu selección, tocá el botón *“Enviar a WhatsApp / Solicitar cotización”* y seguimos por acá con tu cotización automática ✅`;

        await waSendText(fromId, msgCatalogo);
        s.stage = "B6_WAIT_WEB"; // esperamos carrito desde la web
        saveSession(fromId, s);
        return res.sendStatus(200);
      }

      if (s.stage === "B5_WAIT_OTHER") {
        if (!textIn || isGreeting(textIn)) {
          await waSendText(
            fromId,
            "Necesito una pequeña descripción del tipo de espacio para poder ayudarte mejor 🙂"
          );
          saveSession(fromId, s);
          return res.sendStatus(200);
        }
        s.tipoEspacio = textIn.trim();
        s.stage = "B6";
        const url = getCatalogUrl(s.tipoEspacio);
        const msgCatalogo =
          url && url.startsWith("http")
            ? `Perfecto, ${s.nombre}.\nTe comparto nuestro catálogo web para *${s.tipoEspacio}*:\n${url}\n\nAhí podés ver modelos, precios y elegir cantidades.\n\nCuando termines tu selección, en la web tocá el botón *“Enviar a WhatsApp / Solicitar cotización”* y seguimos por acá con tu cotización automática ✅`
            : `Perfecto, ${s.nombre}.\n\nTe comparto nuestro catálogo web para *${s.tipoEspacio}* (pedí el link a tu ejecutivo si aún no lo tenés).\n\nCuando termines tu selección, tocá el botón *“Enviar a WhatsApp / Solicitar cotización”* y seguimos por acá con tu cotización automática ✅`;
        await waSendText(fromId, msgCatalogo);
        s.stage = "B6_WAIT_WEB";
        saveSession(fromId, s);
        return res.sendStatus(200);
      }

      // B6_WAIT_WEB: básicamente esperamos que llegue el carrito pegado
      if (s.stage === "B6_WAIT_WEB") {
        await waSendText(
          fromId,
          "Cuando termines en el catálogo, tocá *“Enviar a WhatsApp / Solicitar cotización”* y acá voy a leer automáticamente tu selección 🙌"
        );
        saveSession(fromId, s);
        return res.sendStatus(200);
      }
    }

    // ================= FLUJO 2: DESDE CATÁLOGO WEB (C1–C5) =================
    if (s.flow === "catalog") {
      // C1 ya se maneja cuando detectamos el carrito (arriba)
      if (s.stage === "C1") {
        if (nx === "cart_ok") {
          s.stage = "C2";
          await waSendText(
            fromId,
            `Para confirmar, tengo estos datos:\nCiudad: ${s.ciudad || "-"}\nZona/barrio: ${s.zona || "-"}\n\n¿Es correcto?`
          );
          await waSendList(fromId, "Confirmá tu ubicación:", [
            { id: "loc_ok", title: "Sí, es correcto" },
            { id: "loc_change", title: "No, cambiar ubicación" }
          ]);
        } else if (nx === "cart_fix") {
          s.stage = "C1_WAIT_NEW_CART";
          await waSendText(
            fromId,
            "Perfecto, podés corregir tu selección en el catálogo y volver a tocar *“Enviar a WhatsApp”*, o pegar aquí un nuevo listado con los productos que querés."
          );
        } else if (textIn) {
          await waSendText(
            fromId,
            "Tocá una de las opciones: *Sí, está correcto* o *Quiero corregir algo*."
          );
        }
        saveSession(fromId, s);
        return res.sendStatus(200);
      }

      if (s.stage === "C1_WAIT_NEW_CART") {
        if (type === "text" && textIn) {
          const again = parseCartFromText(textIn);
          if (again && again.items.length) {
            s.items = again.items;
            s.subtotalPreliminar = again.subtotal;
            s.rawCartText = textIn;
            s.stage = "C1";
            await waSendText(
              fromId,
              `Esta es tu selección actualizada:\n${renderProductosDetalle(
                s.items
              )}\n\n¿Está correcto tu listado?`
            );
            await waSendList(fromId, "Confirmá tu listado:", [
              { id: "cart_ok", title: "Sí, está correcto" },
              { id: "cart_fix", title: "Quiero corregir algo" }
            ]);
          } else {
            await waSendText(
              fromId,
              "No pude leer productos en ese mensaje. Asegurate de pegar el listado con viñetas (• / *) y cantidades."
            );
          }
        }
        saveSession(fromId, s);
        return res.sendStatus(200);
      }

      // C2: confirmar ubicación
      if (s.stage === "C2") {
        if (nx === "loc_ok") {
          s.stage = "C3";
        } else if (nx === "loc_change") {
          s.stage = "C2_CHANGE_CITY";
          await waSendText(
            fromId,
            "Listo, actualicemos tu ubicación.\n\n¿Desde qué *ciudad / departamento* de Bolivia nos escribís?"
          );
          saveSession(fromId, s);
          return res.sendStatus(200);
        } else if (textIn) {
          await waSendText(
            fromId,
            "Elegí una opción: *Sí, es correcto* o *No, cambiar ubicación*."
          );
          saveSession(fromId, s);
          return res.sendStatus(200);
        }
      }

      if (s.stage === "C2_CHANGE_CITY") {
        if (!textIn || isGreeting(textIn)) {
          await waSendText(
            fromId,
            "Decime desde qué *ciudad / departamento* nos escribís."
          );
          saveSession(fromId, s);
          return res.sendStatus(200);
        } else {
          s.ciudad = textIn.trim();
          s.stage = "C2_CHANGE_ZONE";
          await waSendText(
            fromId,
            `¿En qué *zona o barrio* de ${s.ciudad} estás?`
          );
        }
        saveSession(fromId, s);
        return res.sendStatus(200);
      }

      if (s.stage === "C2_CHANGE_ZONE") {
        if (!textIn || isGreeting(textIn)) {
          await waSendText(
            fromId,
            `Decime en qué *zona o barrio* de ${s.ciudad} estás.`
          );
          saveSession(fromId, s);
          return res.sendStatus(200);
        } else {
          s.zona = textIn.trim();
          s.stage = "C3";
        }
        saveSession(fromId, s);
        if (s.stage !== "C3") return res.sendStatus(200);
      }

      // C3: tipo de servicio
      if (s.stage === "C3") {
        await waSendList(
          fromId,
          "¿Cómo querés que armemos la propuesta?",
          [
            { id: "srv_retiro", title: "Solo muebles (retirás en tienda)" },
            { id: "srv_entrega", title: "Muebles + entrega" },
            {
              id: "srv_entrega_armado",
              title: "Muebles + entrega + armado"
            }
          ]
        );
        s.stage = "C3_WAIT";
        saveSession(fromId, s);
        return res.sendStatus(200);
      }

      if (s.stage === "C3_WAIT") {
        if (nx === "srv_retiro") {
          s.tipoServicio = "Solo muebles (retirás en tienda)";
        } else if (nx === "srv_entrega") {
          s.tipoServicio = "Muebles + entrega";
        } else if (nx === "srv_entrega_armado") {
          s.tipoServicio = "Muebles + entrega + armado";
        } else if (textIn) {
          await waSendText(
            fromId,
            "Elegí una de las opciones de la lista para el tipo de servicio."
          );
          saveSession(fromId, s);
          return res.sendStatus(200);
        } else {
          saveSession(fromId, s);
          return res.sendStatus(200);
        }

        // pasar a C4
        s.stage = "C4";
        const total = s.subtotalPreliminar || s.items.reduce(
          (acc, it) => acc + ((it.price || 0) * (it.qty || 1)),
          0
        );
        s.totalCalculado = total;

        const detalle = renderProductosDetalle(s.items);
        const nombre = s.nombre || "Cliente";

        const texto = [
          `Perfecto, ${nombre}.`,
          "Con la información que nos diste, esta es tu *cotización preliminar*:",
          "",
          "COTIZACIÓN MOBICORP",
          `Cliente: ${nombre} – ${s.tipoCliente || "-"}`,
          `Ciudad / zona: ${s.ciudad || "-"} – ${s.zona || "-"}`,
          `Espacio: ${s.tipoEspacio || "-"}`,
          "",
          "Productos:",
          detalle,
          "",
          `Servicio: ${s.tipoServicio || "-"}`,
          "",
          `TOTAL APROXIMADO: ${humanTotal(total)}`,
          "(Referencial, sujeto a stock y verificación.)",
          "",
          "¿Generamos la *cotización formal en PDF* con estos datos?"
        ].join("\n");

        await waSendText(fromId, texto);
        await waSendList(fromId, "Elegí una opción:", [
          { id: "pdf_yes", title: "Sí, generar PDF" },
          { id: "pdf_adjust", title: "Ajustar antes" }
        ]);

        saveSession(fromId, s);
        return res.sendStatus(200);
      }

      // C4: decidir si generar PDF
      if (s.stage === "C4") {
        if (nx === "pdf_yes") {
          s.stage = "C5";
        } else if (nx === "pdf_adjust") {
          s.stage = "C1_WAIT_NEW_CART";
          await waSendText(
            fromId,
            "Genial, ajustemos antes de generar el PDF.\nPodés reenviar tu selección corregida desde la web o pegar aquí un nuevo listado con productos y cantidades."
          );
          saveSession(fromId, s);
          return res.sendStatus(200);
        } else if (textIn) {
          await waSendText(
            fromId,
            "Elegí una opción: *Sí, generar PDF* o *Ajustar antes*."
          );
          saveSession(fromId, s);
          return res.sendStatus(200);
        }
      }

      // C5: generar y enviar PDF + opciones finales
      if (s.stage === "C5") {
        try {
          const { path: pdfPath, filename } = await buildQuote(s, fromId);
          const mediaId = await waUploadMediaFromFile(
            pdfPath,
            "application/pdf",
            filename
          );
          if (mediaId) {
            await waSendDocument(
              fromId,
              mediaId,
              filename,
              "🧾 Tu cotización formal de Mobicorp está lista."
            );
          }
          await waSendText(
            fromId,
            `Listo 🙌\nTe enviamos la *cotización formal de Mobicorp en PDF*.\n\nCOT MOBICORP – ${s.nombre || "cliente"} enviada.`
          );
          await waSendList(fromId, "¿Cómo seguimos?", [
            { id: "alt_ver", title: "Ver alternativas" },
            { id: "alt_ejecutivo", title: "Hablar con un ejecutivo" }
          ]);
          s.stage = "C5_AFTER";
        } catch (e) {
          console.error("[PDF] error", e);
          await waSendText(
            fromId,
            "No pude generar el PDF ahora mismo. ¿Te parece si lo intento nuevamente o preferís que te contacte un ejecutivo?"
          );
        }
        saveSession(fromId, s);
        return res.sendStatus(200);
      }

      if (s.stage === "C5_AFTER") {
        if (nx === "alt_ver") {
          s.flow = "ia";
          s.stage = "IA_ALTERNATIVAS";
          await waSendText(
            fromId,
            "Contame qué parte querés optimizar (por ejemplo: sillas, escritorios, presupuesto máximo, estilo) y nuestra IA te sugiere *alternativas más económicas o más premium*."
          );
        } else if (nx === "alt_ejecutivo") {
          await waSendText(
            fromId,
            "Te conecto con alguien de nuestro equipo para que terminen la propuesta juntos 🙌"
          );
          try {
            await sendContactCard(fromId);
          } catch (e) {
            console.error("[CONTACT] error", e);
          }
        } else if (textIn) {
          await waSendText(
            fromId,
            "Elegí *Ver alternativas* o *Hablar con un ejecutivo* desde la lista."
          );
        }
        saveSession(fromId, s);
        return res.sendStatus(200);
      }
    }

    // ================= FLUJO 3: IA (alternativas o dudas sueltas) =================
    if (s.flow === "ia") {
      if (s.stage === "IA_ALTERNATIVAS") {
        if (!textIn) {
          await waSendText(
            fromId,
            "Decime qué querés ajustar (menos presupuesto, más diseño, otro tipo de sillas, etc.)."
          );
        } else {
          const context = [
            `Cliente: ${s.nombre || "-"}`,
            `Tipo cliente: ${s.tipoCliente || "-"}`,
            `Ciudad / zona: ${s.ciudad || "-"} – ${s.zona || "-"}`,
            `Espacio: ${s.tipoEspacio || "-"}`,
            `Servicio: ${s.tipoServicio || "-"}`,
            `Listado actual de productos:\n${renderProductosDetalle(s.items)}`
          ].join("\n");

          s.history.push({ role: "user", content: textIn });
          const out = await chatIA(
            textIn,
            s.history,
            `El usuario ya tiene una cotización de Mobicorp con los datos siguientes:\n${context}\nDebe proponer alternativas de productos/configuraciones, pero sin inventar precios exactos.`
          );
          s.history.push({ role: "assistant", content: out });

          await waSendText(fromId, out);
          await waSendText(
            fromId,
            "Si alguna de las alternativas te convence, escribime qué cambio querés y lo ajustamos en tu cotización 😊"
          );
        }
        saveSession(fromId, s);
        return res.sendStatus(200);
      }
    }

    // ===== Si nada matchea, contención básica =====
    await waSendText(
      fromId,
      "Te ayudo a cotizar muebles para tu proyecto. Podés escribir *reiniciar* para empezar una nueva cotización o reenviar tu selección desde el catálogo web."
    );
    saveSession(fromId, s);
    return res.sendStatus(200);
  } catch (e) {
    console.error("[WEBHOOK] Error:", e);
    return res.sendStatus(200);
  }
});

export default router;
