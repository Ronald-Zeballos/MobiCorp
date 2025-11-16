// wa/router.js
import express from "express";
import fetch from "node-fetch";
import { config } from "../env.js";
import { loadSession, saveSession } from "../core/session.js";
import {
  waSendText,
  waSendList,
  waSendDocument,
  waUploadMediaFromFile,
  waSendAudio
} from "./send.js";
import { buildQuote } from "../src/quote.js";
import { chatIA, transcribeAudio, synthesizeSpeech } from "../src/aichat.js";
import { parseCartFromText } from "../src/parse.js";
import { djangoFillCartPrices, djangoSendOrder } from "../core/django.js";

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
    "que tal",
    "qué tal",
    "hey",
    "ola"
  ].some((g) => t === g || t.startsWith(g + " "));
}

function isLikelyName(text = "") {
  const t = text.trim();
  if (t.length < 3) return false;
  if (isGreeting(t)) return false;
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

// Enviar contacto de ejecutivo (lo dejamos por si lo quieren usar luego)
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

// ======== Mensajes de flujo B1–B6 ========

async function sendB1(to) {
  await waSendText(
    to,
    "👋 ¡Hola! Soy el asistente virtual de *Mobicorp*.\nTe ayudo a cotizar muebles para tu proyecto.\n\nPara empezar, ¿cuál es tu *nombre completo* (nombre y apellido)?"
  );
}

async function sendB2(to, nombre, { first = false } = {}) {
  const prefix = first ? `Gracias, ${nombre} 😊\n` : "";
  await waSendList(to, `${prefix}¿Nos escribís como…?`, [
    { id: "tipo_empresa", title: "Empresa" },
    { id: "tipo_arquitecto", title: "Arquitecto / Diseñador" },
    { id: "tipo_particular", title: "Particular" }
  ]);
}

async function sendB3(to) {
  await waSendList(to, "¿De qué *departamento* de Bolivia nos escribís?", [
    { id: "dpto_sc", title: "Santa Cruz" },
    { id: "dpto_lp", title: "La Paz" },
    { id: "dpto_cbba", title: "Cochabamba" },
    { id: "dpto_otro", title: "Otro" }
  ]);
}

async function sendSCZoneMenu(to) {
  await waSendList(
    to,
    "¿En qué *zona de Santa Cruz* estás?",
    [
      { id: "scz_norte", title: "Norte" },
      { id: "scz_sur", title: "Sur" },
      { id: "scz_este", title: "Este" },
      { id: "scz_oeste", title: "Oeste" }
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
      const unit = it.price ? `Bs ${Number(it.price).toFixed(2)}` : "sin precio";
      const sub = it.price ? ` → Bs ${(qty * it.price).toFixed(2)}` : "";
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
    s.flags = s.flags || {};

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
      await waSendText(fromId, "🔄 Reinicié la conversación para una nueva cotización.");
      await sendB1(fromId);
      saveSession(fromId, s);
      return res.sendStatus(200);
    }

    // ===== AUDIO/VOICE -> Whisper + TTS =====
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
            "Respuesta de soporte para un cliente de Mobicorp que consulta por voz."
          );
          s.history.push({ role: "assistant", content: out });

          // Texto + audio respuesta
          await waSendText(
            fromId,
            `🗣️ Te escuché decir:\n"${text}"\n\nTe respondo también en audio 👇`
          );

          try {
            const speech = await synthesizeSpeech(
              out,
              `mobicorp_${Date.now()}.mp3`
            );
            if (speech?.path) {
              const mediaOut = await waUploadMediaFromFile(
                speech.path,
                "audio/mpeg",
                speech.filename
              );
              if (mediaOut) {
                await waSendAudio(fromId, mediaOut);
              } else {
                await waSendText(fromId, out);
              }
            } else {
              await waSendText(fromId, out);
            }
          } catch (e) {
            console.error("[TTS] error", e);
            await waSendText(fromId, out);
          }
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

    // ===== Intentar detectar carrito pegado (catálogo web) =====
    let parsedCart = null;
    if (type === "text" && textIn && s.stage !== "B1") {
      parsedCart = parseCartFromText(textIn);
    }

    if (parsedCart && parsedCart.items.length) {
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

    // ===========================================================
    // FLUJO 1: INICIO WHATSAPP (B1–B6)
    // ===========================================================
    if (s.flow === "inicio") {
      // B1: saludo inicial
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
            "Decime tu *nombre completo* para avanzar, por favor (nombre y apellido)."
          );
          saveSession(fromId, s);
          return res.sendStatus(200);
        }

        if (!isLikelyName(textIn)) {
          await waSendText(
            fromId,
            "Para continuar necesito tu *nombre completo* (nombre y apellido)."
          );
          saveSession(fromId, s);
          return res.sendStatus(200);
        }

        s.nombre = textIn.trim().replace(/\s+/g, " ");
        s.stage = "B2";
        await sendB2(fromId, s.nombre, { first: true });
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
          s.stage = "B2_EMPRESA";
          await waSendText(
            fromId,
            "Perfecto 👌\n¿De qué *empresa* nos escribís?"
          );
          saveSession(fromId, s);
          return res.sendStatus(200);
        }

        if (
          nx === "tipo_arquitecto" ||
          textIn.toLowerCase().includes("arquitect") ||
          textIn.toLowerCase().includes("diseñador")
        ) {
          s.tipoCliente = "Arquitecto / Diseñador";
          s.stage = "B3";
          await sendB3(fromId);
          saveSession(fromId, s);
          return res.sendStatus(200);
        }

        if (
          nx === "tipo_particular" ||
          textIn.toLowerCase().includes("particular")
        ) {
          s.tipoCliente = "Particular";
          s.stage = "B3";
          await sendB3(fromId);
          saveSession(fromId, s);
          return res.sendStatus(200);
        }

        await waSendText(
          fromId,
          "No identifiqué el tipo de cliente. Escribí *Empresa*, *Arquitecto / Diseñador* o *Particular*, o usá el botón *Elegir*."
        );
        await sendB2(fromId, s.nombre || "allí", { first: false });
        saveSession(fromId, s);
        return res.sendStatus(200);
      }

      // ---------- B2_EMPRESA: nombre de empresa ----------
      if (s.stage === "B2_EMPRESA") {
        if (!textIn || isGreeting(textIn)) {
          await waSendText(
            fromId,
            "Decime el *nombre de la empresa* para poder registrar la cotización 🙂"
          );
          saveSession(fromId, s);
          return res.sendStatus(200);
        }
        s.nombreEmpresa = textIn.trim();
        s.stage = "B3";
        await sendB3(fromId);
        saveSession(fromId, s);
        return res.sendStatus(200);
      }

      // ---------- B3: departamento ----------
      if (s.stage === "B3") {
        if (!textIn) {
          await sendB3(fromId);
          saveSession(fromId, s);
          return res.sendStatus(200);
        }

        if (nx === "dpto_sc" || textIn.toLowerCase().includes("santa cruz")) {
          s.departamento = "Santa Cruz";
          s.ciudad = "Santa Cruz de la Sierra";
          s.stage = "B3_SCZ";
          await sendSCZoneMenu(fromId);
          saveSession(fromId, s);
          return res.sendStatus(200);
        }

        if (nx === "dpto_lp" || textIn.toLowerCase().includes("la paz")) {
          s.departamento = "La Paz";
          s.ciudad = "La Paz";
          s.stage = "B4";
          await waSendText(
            fromId,
            "¿En qué *zona o barrio* de La Paz estás?"
          );
          saveSession(fromId, s);
          return res.sendStatus(200);
        }

        if (
          nx === "dpto_cbba" ||
          textIn.toLowerCase().includes("cochabamba")
        ) {
          s.departamento = "Cochabamba";
          s.ciudad = "Cochabamba";
          s.stage = "B4";
          await waSendText(
            fromId,
            "¿En qué *zona o barrio* de Cochabamba estás?"
          );
          saveSession(fromId, s);
          return res.sendStatus(200);
        }

        if (nx === "dpto_otro") {
          s.stage = "B3_WAIT_OTHER";
          await waSendText(
            fromId,
            "Perfecto, ¿de qué *departamento* de Bolivia nos escribís?"
          );
          saveSession(fromId, s);
          return res.sendStatus(200);
        }

        // Texto libre → lo tomamos como departamento
        s.departamento = textIn.trim();
        s.ciudad = s.departamento;
        s.stage = "B4";
        await waSendText(
          fromId,
          `¿En qué *zona o barrio* de ${s.ciudad} estás?`
        );
        saveSession(fromId, s);
        return res.sendStatus(200);
      }

      // ---------- B3_WAIT_OTHER ----------
      if (s.stage === "B3_WAIT_OTHER") {
        if (!textIn || isGreeting(textIn)) {
          await waSendText(
            fromId,
            "Decime el nombre del *departamento* para poder seguir 🙂"
          );
          saveSession(fromId, s);
          return res.sendStatus(200);
        }
        s.departamento = textIn.trim();
        s.ciudad = s.departamento;
        s.stage = "B4";
        await waSendText(
          fromId,
          `¿En qué *zona o barrio* de ${s.ciudad} estás?`
        );
        saveSession(fromId, s);
        return res.sendStatus(200);
      }

      // ---------- B3_SCZ: zona macrorregión de Santa Cruz ----------
      if (s.stage === "B3_SCZ") {
        if (
          nx === "scz_norte" ||
          textIn.toLowerCase().includes("norte")
        ) {
          s.zonaMacro = "Norte";
        } else if (
          nx === "scz_sur" ||
          textIn.toLowerCase().includes("sur")
        ) {
          s.zonaMacro = "Sur";
        } else if (
          nx === "scz_este" ||
          textIn.toLowerCase().includes("este")
        ) {
          s.zonaMacro = "Este";
        } else if (
          nx === "scz_oeste" ||
          textIn.toLowerCase().includes("oeste")
        ) {
          s.zonaMacro = "Oeste";
        } else {
          await waSendText(
            fromId,
            "Elegí una de las zonas: Norte, Sur, Este u Oeste."
          );
          await sendSCZoneMenu(fromId);
          saveSession(fromId, s);
          return res.sendStatus(200);
        }

        s.stage = "B4";
        await waSendText(
          fromId,
          `Genial. ¿En qué *barrio o zona específica* de Santa Cruz (${s.zonaMacro}) estás?`
        );
        saveSession(fromId, s);
        return res.sendStatus(200);
      }

      // ---------- B4: zona/barrio ----------
      if (s.stage === "B4") {
        if (!textIn || isGreeting(textIn)) {
          const ciudadLabel = s.ciudad || s.departamento || "tu ciudad";
          await waSendText(
            fromId,
            `Decime en qué *zona o barrio* de ${ciudadLabel} estás. Ej: Equipetrol, Centro, Sur…`
          );
          saveSession(fromId, s);
          return res.sendStatus(200);
        }

        const barrio = textIn.trim();
        if (s.zonaMacro) {
          s.zona = `${s.zonaMacro} - ${barrio}`;
        } else {
          s.zona = barrio;
        }

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

        const lower = textIn.toLowerCase();

        if (nx === "esp_oficina" || lower.includes("oficina")) {
          s.tipoEspacio = "Oficina";
        } else if (nx === "esp_hogar" || lower.includes("hogar")) {
          s.tipoEspacio = "Hogar";
        } else if (nx === "esp_local" || lower.includes("local")) {
          s.tipoEspacio = "Local comercial / tienda";
        } else if (
          nx === "esp_consultorio" ||
          lower.includes("consultorio") ||
          lower.includes("clinica") ||
          lower.includes("clínica")
        ) {
          s.tipoEspacio = "Consultorio / clínica";
        } else if (nx === "esp_otro") {
          s.stage = "B5_WAIT_OTHER";
          await waSendText(
            fromId,
            "Contame brevemente qué tipo de espacio es (ej: sala de reuniones, cowork, recepción, sala de espera…)."
          );
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
            ? `Perfecto, ${s.nombre}.\nTe comparto nuestro *catálogo web* para *${s.tipoEspacio}*:\n${url}\n\nAhí podés ver modelos, precios y elegir cantidades.\n\nCuando termines tu selección, en la web tocá el botón *“Enviar a WhatsApp / Solicitar cotización”* y seguimos por acá con tu cotización automática ✅`
            : `Perfecto, ${s.nombre}.\n\nTe comparto nuestro catálogo web para *${s.tipoEspacio}*. Cuando termines tu selección, tocá el botón *“Enviar a WhatsApp / Solicitar cotización”* y seguimos por acá con tu cotización automática ✅`;
        await waSendText(fromId, msgCatalogo);
        s.stage = "B6_WAIT_WEB";
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
            ? `Perfecto, ${s.nombre}.\nTe comparto nuestro *catálogo web* para *${s.tipoEspacio}*:\n${url}\n\nAhí podés ver modelos, precios y elegir cantidades.\n\nCuando termines tu selección, en la web tocá el botón *“Enviar a WhatsApp / Solicitar cotización”* y seguimos por acá con tu cotización automática ✅`
            : `Perfecto, ${s.nombre}.\n\nTe comparto nuestro catálogo web para *${s.tipoEspacio}*. Cuando termines tu selección, tocá el botón *“Enviar a WhatsApp / Solicitar cotización”* y seguimos por acá con tu cotización automática ✅`;
        await waSendText(fromId, msgCatalogo);
        s.stage = "B6_WAIT_WEB";
        saveSession(fromId, s);
        return res.sendStatus(200);
      }

      if (s.stage === "B6_WAIT_WEB") {
        await waSendText(
          fromId,
          "Cuando termines en el catálogo, tocá *“Enviar a WhatsApp / Solicitar cotización”* y acá voy a leer automáticamente tu selección 🙌"
        );
        saveSession(fromId, s);
        return res.sendStatus(200);
      }
    }

    // ===========================================================
    // FLUJO 2: DESDE CATÁLOGO WEB (simplificado)
    // ===========================================================
    if (s.flow === "catalog") {
      // C1: confirmar listado
      if (s.stage === "C1") {
        if (nx === "cart_ok") {
          // directo a tipo de servicio (sin confirmar ubicación ni datos)
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
        } else if (nx === "cart_fix") {
          s.stage = "C1_WAIT_NEW_CART";
          await waSendText(
            fromId,
            "Perfecto, podés corregir tu selección en el catálogo y volver a tocar *“Enviar a WhatsApp”*, o pegar aquí un nuevo listado con los productos que querés."
          );
          saveSession(fromId, s);
          return res.sendStatus(200);
        } else if (textIn) {
          await waSendText(
            fromId,
            "Tocá una de las opciones: *Sí, está correcto* o *Quiero corregir algo*."
          );
          saveSession(fromId, s);
          return res.sendStatus(200);
        }
      }

      // C1_WAIT_NEW_CART: reintentar con otro listado
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

      // C3_WAIT: tipo de servicio + generar PDF + enviar a Django + cerrar flujo
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

        // Llenar precios desde Django (si disponible)
        try {
          s = await djangoFillCartPrices(s, fromId);
        } catch (e) {
          console.error("[DJANGO] Error al completar precios:", e.message);
        }

        const total =
          s.subtotalPreliminar ||
          s.items.reduce(
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
          "Ahora te envío la *cotización formal en PDF* ✅"
        ].join("\n");

        await waSendText(fromId, texto);

        // Generar PDF + enviar
        let pdfFilename = null;
        try {
          const { path: pdfPath, filename } = await buildQuote(s, fromId);
          pdfFilename = filename;
          const mediaIdOut = await waUploadMediaFromFile(
            pdfPath,
            "application/pdf",
            filename
          );
          if (mediaIdOut) {
            await waSendDocument(
              fromId,
              mediaIdOut,
              filename,
              "🧾 Tu cotización formal de Mobicorp está lista."
            );
          }
          await waSendText(
            fromId,
            "Listo 🙌\nTe enviamos la *cotización formal de Mobicorp en PDF*.\nSi después querés ver alternativas o hacer ajustes, escribime por acá y te ayudo."
          );
        } catch (e) {
          console.error("[PDF] error", e);
          await waSendText(
            fromId,
            "No pude generar el PDF ahora mismo. Podés intentar de nuevo más tarde o pedir que te contacte un ejecutivo."
          );
        }

        // Enviar orden final al backend (no rompe el flujo si falla)
        try {
          await djangoSendOrder(s, fromId, {
            pdfFilename: pdfFilename || null
          });
        } catch (e) {
          console.error("[DJANGO] Error al enviar orden final:", e.message);
        }

        // Cerrar flujo estructurado y dejar IA lista
        s.flow = "ia";
        s.stage = "IA_ALTERNATIVAS";
        saveSession(fromId, s);
        return res.sendStatus(200);
      }
    }

    // ===========================================================
    // FLUJO 3: IA (alternativas o dudas sueltas)
    // ===========================================================
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
            `El usuario ya tiene una cotización de Mobicorp con los datos siguientes:\n${context}\nDebe proponer alternativas de productos/configuraciones, sin inventar precios exactos.`
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

    // ===== Fallback =====
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
