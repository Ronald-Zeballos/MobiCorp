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

const GRAPH_BASE = "https://graph.facebook.com/v20.0";
const PHONE_ID = config.WHATSAPP_PHONE_ID;
const TOKEN = config.WHATSAPP_TOKEN;

// URLs fijas de negocio
const DEFAULT_CATALOG_URL = "https://mobicorp.netlify.app/catalogo";
const MOBICORP_MAPS_URL =
  "https://maps.app.goo.gl/Ya8bUjnVAYkEsUiD6?g_st=iw";

// ================== Helpers ==================

function normalize(s = "") {
  return s
    .normalize("NFD")
    .replace(/\p{Diacritic}+/gu, "")
    .toLowerCase()
    .trim();
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
    "buen dia",
    "buenas tardes",
    "buenas noches",
    "que tal",
    "que tal",
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
  const fallback = config.CATALOG_URL || DEFAULT_CATALOG_URL;

  if (key.includes("oficina"))
    return config.CATALOG_URL_OFICINA || fallback;
  if (key.includes("hogar"))
    return config.CATALOG_URL_HOGAR || fallback;
  if (key.includes("local"))
    return config.CATALOG_URL_LOCAL || fallback;
  if (
    key.includes("consultorio") ||
    key.includes("clinica") ||
    key.includes("clinica")
  )
    return config.CATALOG_URL_CONSULTORIO || fallback;
  return config.CATALOG_URL_OTRO || fallback;
}

// Detectar intención de ubicación
function wantsLocation(text = "") {
  const n = normalize(text);
  if (!n) return false;
  return (
    n.includes("ubicacion") ||
    n.includes("direccion") ||
    n.includes("donde estan") ||
    n.includes("donde se encuentran") ||
    n.includes("como llegar") ||
    n.includes("ubicados")
  );
}

// Detectar intención de catálogo
function wantsCatalog(text = "") {
  const n = normalize(text);
  if (!n) return false;
  return (
    n.includes("catalogo") ||
    n.includes("catalogo") ||
    n.includes("catalog") ||
    n.includes("ver productos") ||
    n.includes("ver muebles") ||
    n.includes("lista de muebles")
  );
}

async function sendLocationMessage(to) {
  await waSendText(
    to,
    `📍 Esta es la ubicación de *Mobicorp*:\n${MOBICORP_MAPS_URL}\n\nPodés abrir el mapa para ver cómo llegar.`
  );
}

async function sendCatalogMessage(to, tipoEspacio, nombre) {
  const url = getCatalogUrl(tipoEspacio || "");
  const saludoNombre = nombre ? `${nombre}, ` : "";
  const espacioLabel = tipoEspacio
    ? `para espacios de tipo *${tipoEspacio}*`
    : "con todo nuestro portafolio de muebles";

  await waSendText(
    to,
    `🪑 Perfecto ${saludoNombre}te comparto nuestro *catálogo en línea* ${espacioLabel}:\n${url}\n\nAhí podés ver modelos, medidas y estilos. Cuando tengas tu selección, usá el botón *“Enviar a WhatsApp / Solicitar cotización”* y armamos tu propuesta automáticamente.`
  );
}

// Limpiar solo datos de cotización, no el perfil del cliente
function resetQuoteData(s) {
  s.items = [];
  s.subtotalPreliminar = null;
  s.totalCalculado = null;
  s.tipoServicio = null;
  s.rawCartText = null;
  return s;
}

// Descargar media de WhatsApp (para audios)
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

// Contact card (por si luego lo usan)
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

// =============== Menús y pantallas ===============

async function sendMainMenu(to, nombre) {
  const saludo = nombre ? `Hola ${nombre}` : "Hola";
  await waSendList(
    to,
    `👋 ${saludo}, soy el asistente virtual de *Mobicorp*.\n¿En qué te puedo ayudar hoy?`,
    [
      {
        id: "menu_producto",
        title: "Saber sobre un producto",
        description: "Modelos, usos, recomendaciones y estilos."
      },
      {
        id: "menu_cotizar",
        title: "Solicitar una cotización",
        description: "Armamos una propuesta para tu proyecto."
      }
    ]
  );
}

async function sendB1(to) {
  await waSendText(
    to,
    "Perfecto, armemos tu cotización 😊\n\nPara comenzar, ¿cuál es tu *nombre completo* (nombre y apellido)?"
  );
}

async function sendB2(to, nombre, { first = false } = {}) {
  const prefix = first ? `Gracias, ${nombre}.\n\n` : "";
  await waSendList(to, `${prefix}¿Nos escribís como:`, [
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
    { id: "dpto_otro", title: "Otro departamento" }
  ]);
}

async function sendSCZoneMenu(to) {
  await waSendList(to, "¿En qué *zona de Santa Cruz* estás?", [
    { id: "scz_norte", title: "Zona Norte" },
    { id: "scz_sur", title: "Zona Sur" },
    { id: "scz_este", title: "Zona Este" },
    { id: "scz_oeste", title: "Zona Oeste" }
  ]);
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
      { id: "esp_otro", title: "Otro tipo de espacio" }
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

// Simular precios si no vienen del backend
function simulatePrices(session) {
  const min = 200;
  const max = 500;
  let subtotal = 0;

  session.items = (session.items || []).map((it) => {
    const qty = Number(it.qty || 1);
    let price = Number(it.price || 0);

    if (!price) {
      const raw = Math.random() * (max - min) + min;
      price = Math.round(raw / 10) * 10; // precios redondeados
    }

    const sub = price * qty;
    subtotal += sub;

    return {
      ...it,
      price,
      subtotal: sub
    };
  });

  session.subtotalPreliminar = subtotal;
  return session;
}

async function generateAndSendQuote(fromId, s) {
  try {
    s = await djangoFillCartPrices(s, fromId);
  } catch (e) {
    console.error("[DJANGO] Error al completar precios:", e.message);
  }

  // Si no hay precios, simulamos
  const allNoPrice = (s.items || []).every(
    (it) => !it.price || Number(it.price) === 0
  );
  if (allNoPrice) {
    s = simulatePrices(s);
  } else {
    let subtotal = 0;
    s.items = (s.items || []).map((it) => {
      const qty = Number(it.qty || 1);
      const price = Number(it.price || 0);
      const sub = price * qty;
      subtotal += sub;
      return { ...it, subtotal: sub };
    });
    if (!s.subtotalPreliminar) {
      s.subtotalPreliminar = subtotal;
    }
  }

  const total =
    s.subtotalPreliminar ||
    s.items.reduce((acc, it) => acc + ((it.price || 0) * (it.qty || 1)), 0);
  s.totalCalculado = total;

  const detalle = renderProductosDetalle(s.items);
  const nombre = s.nombre || "Cliente";

  const texto = [
    `Perfecto, ${nombre}.`,
    "Con la información que compartiste, esta es tu *cotización preliminar*:",
    "",
    "COTIZACIÓN MOBICORP",
    `Cliente: ${nombre} – ${s.tipoCliente || "-"}`,
    `Ciudad / zona: ${s.ciudad || "-"} – ${s.zona || "-"}`,
    `Tipo de espacio: ${s.tipoEspacio || "-"}`,
    "",
    "Productos seleccionados:",
    detalle,
    "",
    `Servicio: ${s.tipoServicio || "A definir junto al asesor"}`,
    "",
    `TOTAL APROXIMADO: ${humanTotal(total)}`,
    "(Monto referencial, sujeto a stock y verificación final).",
    "",
    "A continuación te envío la *cotización formal en PDF*."
  ].join("\n");

  await waSendText(fromId, texto);

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
      "Listo 🙌\nTe enviamos la *cotización formal de Mobicorp en PDF*.\nSi luego querés ver alternativas o hacer ajustes, escribime por aquí y te ayudo."
    );
  } catch (e) {
    console.error("[PDF] error", e);
    await waSendText(
      fromId,
      "No pude generar el PDF en este momento. Podés intentar más tarde o pedir que te contacte un ejecutivo de ventas."
    );
  }

  try {
    await djangoSendOrder(s, fromId, {
      pdfFilename: pdfFilename || null
    });
  } catch (e) {
    console.error("[DJANGO] Error al enviar orden final:", e.message);
  }

  s.flow = "ia";
  s.stage = "IA_ALTERNATIVAS";
  return s;
}

// ================== Router ==================

const router = express.Router();

router.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === config.VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

router.post("/webhook", async (req, res) => {
  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const msg = value?.messages?.[0];
    if (!msg) return res.sendStatus(200);

    const fromId = msg.from;
    let s = loadSession(fromId) || {};
    s.flow = s.flow || "inicio";
    s.stage = s.stage || null;
    s.items = s.items || [];
    s.history = s.history || [];
    s.flags = s.flags || {};

    // NO tomamos el nombre del perfil automáticamente para evitar saludos raros
    // El nombre solo se define cuando el usuario lo escribe en B1.

    const type = msg.type;
    let textIn = "";

    if (type === "text") textIn = (msg.text?.body || "").trim();
    if (type === "interactive") {
      const b = msg.interactive?.button_reply || msg.interactive?.list_reply;
      textIn = b?.id || "";
    }

    const nx = normalize(textIn);

    // ===== Comandos globales =====
    if (nx === "reiniciar" || nx === "reset") {
      s = {
        flow: "inicio",
        stage: "MENU_INICIO",
        items: [],
        history: [],
        flags: {}
      };
      await waSendText(
        fromId,
        "🔄 Empezamos una nueva atención desde cero."
      );
      await sendMainMenu(fromId, null);
      saveSession(fromId, s);
      return res.sendStatus(200);
    }

    if (nx === "volver" || nx === "menu" || nx === "inicio") {
      resetQuoteData(s);
      s.flow = "inicio";
      s.stage = "MENU_INICIO";
      await waSendText(
        fromId,
        "⬅️ Volvimos al menú principal para que elijas cómo continuar."
      );
      await sendMainMenu(fromId, s.nombre || null);
      saveSession(fromId, s);
      return res.sendStatus(200);
    }

    // ===== AUDIO / VOICE -> Whisper + IA + atajos ubicación / catálogo =====
    if (type === "audio" || type === "voice") {
      const mediaId = msg.audio?.id || msg.voice?.id;
      try {
        const buf = await downloadWaMedia(mediaId);
        const { text } = await transcribeAudio(buf, "wa_audio.ogg");

        if (!text) {
          await waSendText(
            fromId,
            "No pude interpretar bien el audio. ¿Podés repetirlo o escribirme tu consulta por mensaje?"
          );
          saveSession(fromId, s);
          return res.sendStatus(200);
        }

        // Atajos por audio: ubicación / catálogo
        if (wantsLocation(text)) {
          await sendLocationMessage(fromId);
          try {
            const speech = await synthesizeSpeech(
              "Te envié nuestra ubicación en el mapa para que puedas llegar fácilmente.",
              `mobicorp_loc_${Date.now()}.mp3`
            );
            if (speech?.path) {
              const mediaOut = await waUploadMediaFromFile(
                speech.path,
                "audio/mpeg",
                speech.filename
              );
              if (mediaOut) {
                await waSendAudio(fromId, mediaOut);
              }
            }
          } catch (e) {
            console.error("[TTS loc] error", e);
          }
          saveSession(fromId, s);
          return res.sendStatus(200);
        }

        if (wantsCatalog(text)) {
          await sendCatalogMessage(fromId, s.tipoEspacio, s.nombre);
          try {
            const speech = await synthesizeSpeech(
              "Te compartí el catálogo en línea de Mobicorp. Ahí podés ver los muebles y después enviarnos tu selección por WhatsApp.",
              `mobicorp_cat_${Date.now()}.mp3`
            );
            if (speech?.path) {
              const mediaOut = await waUploadMediaFromFile(
                speech.path,
                "audio/mpeg",
                speech.filename
              );
              if (mediaOut) {
                await waSendAudio(fromId, mediaOut);
              }
            }
          } catch (e) {
            console.error("[TTS cat] error", e);
          }
          saveSession(fromId, s);
          return res.sendStatus(200);
        }

        // Audio normal → IA (modo asesor)
        s.flow = "ia";
        if (!s.stage || !s.stage.startsWith("IA_")) {
          s.stage = "IA_PRODUCTO";
        }

        s.history.push({ role: "user", content: text });
        const out = await chatIA(
          text,
          s.history,
          "Sos el asistente de Mobicorp. Responde de forma clara, profesional y cercana sobre mobiliario, proyectos de oficinas y espacios. Si el usuario pide cosas que no tengan que ver con el negocio, respondé brevemente y recordale que también podés ayudarle con productos o cotizaciones. No inventes precios exactos ni condiciones comerciales que no estén en el contexto."
        );
        s.history.push({ role: "assistant", content: out });

        await waSendText(
          fromId,
          `🗣️ Esto fue lo que entendí de tu audio:\n"${text}"\n\nTe respondo así:`
        );
        await waSendText(fromId, out);

        // También devolvemos audio de la respuesta
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
            }
          }
        } catch (e) {
          console.error("[TTS] error", e);
        }

        await waSendList(fromId, "¿Cómo querés continuar?", [
          { id: "ia_continuar", title: "Seguir preguntando" },
          { id: "ia_cotizar", title: "Quiero una cotización" },
          { id: "ia_volver_menu", title: "Volver al inicio" }
        ]);

        saveSession(fromId, s);
        return res.sendStatus(200);
      } catch (e) {
        console.error("[WHISPER] err", e);
        await waSendText(
          fromId,
          "Hay un problema al procesar el audio en este momento. Por ahora respondeme por texto y te ayudo desde aquí."
        );
        saveSession(fromId, s);
        return res.sendStatus(200);
      }
    }

    // ===== Atajos por texto: ubicación / catálogo =====
    if (type === "text" && textIn) {
      if (wantsLocation(textIn)) {
        await sendLocationMessage(fromId);
        saveSession(fromId, s);
        return res.sendStatus(200);
      }
      if (wantsCatalog(textIn)) {
        await sendCatalogMessage(fromId, s.tipoEspacio, s.nombre);
        saveSession(fromId, s);
        return res.sendStatus(200);
      }
    }

    // ===== Intentar detectar carrito pegado (catálogo web) =====
    let parsedCart = null;
    if (type === "text" && textIn && s.stage !== "B1") {
      parsedCart = parseCartFromText(textIn);
    }

    if (parsedCart && parsedCart.items.length) {
      resetQuoteData(s);
      s.items = parsedCart.items;
      s.subtotalPreliminar = parsedCart.subtotal;
      s.rawCartText = textIn;

      const hasFullDatos =
        s.nombre && s.tipoCliente && s.departamento && s.zona && s.tipoEspacio;

      if (!hasFullDatos && !s.stage) {
        s.flow = "inicio";
        s.stage = "B1";
        await waSendText(
          fromId,
          `👋 Hola, recibí tu selección desde el *catálogo web de Mobicorp*.\n\nEsto es lo que seleccionaste:\n${renderProductosDetalle(
            s.items
          )}\n\nPara preparar tu cotización formal necesito algunos datos rápidos.`
        );
        await waSendText(
          fromId,
          "Para comenzar, ¿cuál es tu *nombre completo* (nombre y apellido)?"
        );
        saveSession(fromId, s);
        return res.sendStatus(200);
      }

      if (hasFullDatos) {
        s = await generateAndSendQuote(fromId, s);
        saveSession(fromId, s);
        return res.sendStatus(200);
      }

      await waSendText(
        fromId,
        "Perfecto, ya tengo tu selección de productos. Terminemos unos datos más y enseguida te envío la cotización."
      );
      saveSession(fromId, s);
      return res.sendStatus(200);
    }

    // ===========================================================
    // FLUJO 1: INICIO / MENÚ PRINCIPAL / DATOS BÁSICOS
    // ===========================================================
    if (s.flow === "inicio") {
      // Menú inicio si no hay stage
      if (!s.stage) {
        s.stage = "MENU_INICIO";
        await sendMainMenu(fromId, s.nombre || null);
        saveSession(fromId, s);
        return res.sendStatus(200);
      }

      // ----- Menú principal -----
      if (s.stage === "MENU_INICIO") {
        if (nx === "menu_producto") {
          s.flow = "ia";
          s.stage = "IA_PRODUCTO";
          await waSendText(
            fromId,
            "Perfecto. Contame qué producto, línea de muebles o tipo de proyecto tenés en mente y te asesoro."
          );
          saveSession(fromId, s);
          return res.sendStatus(200);
        }

        if (nx === "menu_cotizar") {
          const hasPerfil =
            s.nombre &&
            s.tipoCliente &&
            s.departamento &&
            s.zona &&
            s.tipoEspacio;

          resetQuoteData(s);

          if (hasPerfil) {
            const labelCiudad = `${s.ciudad || s.departamento || "-"} – ${
              s.zona || "-"
            }`;
            await waSendText(
              fromId,
              `Genial, ${s.nombre}. Uso tus datos registrados para esta nueva cotización:\n\n• Tipo de cliente: ${s.tipoCliente}\n• Ciudad / zona: ${labelCiudad}\n• Tipo de espacio: ${s.tipoEspacio}\n\nTe comparto directamente el catálogo para que elijas los muebles.`
            );
            await sendCatalogMessage(fromId, s.tipoEspacio, s.nombre);
            s.stage = "B6_WAIT_WEB";
            saveSession(fromId, s);
            return res.sendStatus(200);
          }

          s.stage = "B1";
          await sendB1(fromId);
          saveSession(fromId, s);
          return res.sendStatus(200);
        }

        if (textIn) {
          await waSendText(
            fromId,
            "Para continuar elegí una de las opciones del menú: *Saber sobre un producto* o *Solicitar una cotización*."
          );
          await sendMainMenu(fromId, s.nombre || null);
          saveSession(fromId, s);
          return res.sendStatus(200);
        }
      }

      // ---------- B1: pedir nombre ----------
      if (s.stage === "B1") {
        if (!textIn) {
          await waSendText(
            fromId,
            "Necesito tu *nombre completo* (nombre y apellido) para personalizar la cotización."
          );
          saveSession(fromId, s);
          return res.sendStatus(200);
        }
        if (!isLikelyName(textIn)) {
          await waSendText(
            fromId,
            "Por favor indicame tu *nombre completo* (nombre y apellido) para avanzar con la cotización."
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
            "Excelente. ¿Cuál es el *nombre de la empresa* desde la que nos contactás?"
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
          "No pude identificar el tipo de cliente. Indicá si sos *Empresa*, *Arquitecto / Diseñador* o *Particular*, o usá el botón *Elegir*."
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
            "Por favor indicame el *nombre de la empresa* para registrar correctamente tu cotización."
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
            "Perfecto. ¿De qué *departamento* de Bolivia nos escribís?"
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

      if (s.stage === "B3_WAIT_OTHER") {
        if (!textIn || isGreeting(textIn)) {
          await waSendText(
            fromId,
            "Decime el nombre del *departamento* desde donde nos contactás."
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

      if (s.stage === "B3_SCZ") {
        if (nx === "scz_norte" || textIn.toLowerCase().includes("norte")) {
          s.zonaMacro = "Norte";
        } else if (nx === "scz_sur" || textIn.toLowerCase().includes("sur")) {
          s.zonaMacro = "Sur";
        } else if (nx === "scz_este" || textIn.toLowerCase().includes("este")) {
          s.zonaMacro = "Este";
        } else if (nx === "scz_oeste" || textIn.toLowerCase().includes("oeste")) {
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
          `Perfecto. ¿En qué *barrio o zona específica* de Santa Cruz (${s.zonaMacro}) estás?`
        );
        saveSession(fromId, s);
        return res.sendStatus(200);
      }

      // ---------- B4: zona / barrio ----------
      if (s.stage === "B4") {
        if (!textIn || isGreeting(textIn)) {
          const ciudadLabel = s.ciudad || s.departamento || "tu ciudad";
          await waSendText(
            fromId,
            `Indicame en qué *zona o barrio* de ${ciudadLabel} estás. Por ejemplo: Equipetrol, Centro, Sur, etc.`
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
          lower.includes("clinica")
        ) {
          s.tipoEspacio = "Consultorio / clínica";
        } else if (nx === "esp_otro") {
          s.stage = "B5_WAIT_OTHER";
          await waSendText(
            fromId,
            "Contame brevemente qué tipo de espacio es. Por ejemplo: sala de reuniones, cowork, recepción, sala de espera, etc."
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

        // Si ya hay items (vienen del catálogo), cotizamos directo
        if (s.items && s.items.length) {
          s = await generateAndSendQuote(fromId, s);
          saveSession(fromId, s);
          return res.sendStatus(200);
        }

        // Si aún no hay items, mandamos catálogo
        s.stage = "B6";
        await sendCatalogMessage(fromId, s.tipoEspacio, s.nombre);
        s.stage = "B6_WAIT_WEB";
        saveSession(fromId, s);
        return res.sendStatus(200);
      }

      if (s.stage === "B5_WAIT_OTHER") {
        if (!textIn || isGreeting(textIn)) {
          await waSendText(
            fromId,
            "Necesito una breve descripción del tipo de espacio para poder asesorarte mejor."
          );
          saveSession(fromId, s);
          return res.sendStatus(200);
        }
        s.tipoEspacio = textIn.trim();

        if (s.items && s.items.length) {
          s = await generateAndSendQuote(fromId, s);
          saveSession(fromId, s);
          return res.sendStatus(200);
        }

        s.stage = "B6";
        await sendCatalogMessage(fromId, s.tipoEspacio, s.nombre);
        s.stage = "B6_WAIT_WEB";
        saveSession(fromId, s);
        return res.sendStatus(200);
      }

      if (s.stage === "B6_WAIT_WEB") {
        await waSendText(
          fromId,
          "Cuando finalices tu selección en el catálogo, tocá *“Enviar a WhatsApp / Solicitar cotización”* y voy a leer tu pedido automáticamente para armar la propuesta."
        );
        saveSession(fromId, s);
        return res.sendStatus(200);
      }
    }

    // ===========================================================
    // FLUJO 2: IA (PRODUCTO / ALTERNATIVAS)
    // ===========================================================
    if (s.flow === "ia") {
      // ----- IA_PRODUCTO: consultas generales -----
      if (s.stage === "IA_PRODUCTO") {
        if (!textIn) {
          await waSendText(
            fromId,
            "Contame qué producto, línea de muebles o tipo de proyecto querés revisar y te asesoro."
          );
          saveSession(fromId, s);
          return res.sendStatus(200);
        }

        if (nx === "ia_continuar") {
          await waSendText(
            fromId,
            "Perfecto, enviame otra consulta sobre productos, medidas, estilos o combinaciones y te sigo ayudando."
          );
          saveSession(fromId, s);
          return res.sendStatus(200);
        }

        if (nx === "ia_cotizar") {
          resetQuoteData(s);
          s.flow = "inicio";
          s.stage = "B1";
          await waSendText(
            fromId,
            "Genial, avancemos con una cotización personalizada para tu proyecto."
          );
          await sendB1(fromId);
          saveSession(fromId, s);
          return res.sendStatus(200);
        }

        if (nx === "ia_volver_menu") {
          resetQuoteData(s);
          s.flow = "inicio";
          s.stage = "MENU_INICIO";
          await sendMainMenu(fromId, s.nombre || null);
          saveSession(fromId, s);
          return res.sendStatus(200);
        }

        s.history.push({ role: "user", content: textIn });
        const out = await chatIA(
          textIn,
          s.history,
          "Sos el asistente de Mobicorp. Responde de forma clara, profesional y cercana sobre mobiliario, proyectos de oficinas, espacios comerciales y del hogar. Si el usuario pregunta cosas fuera de contexto, respondé breve y ofrecé volver al menú principal o solicitar una cotización. No inventes precios exactos ni políticas comerciales no mencionadas."
        );
        s.history.push({ role: "assistant", content: out });

        await waSendText(fromId, out);
        await waSendList(fromId, "¿Cómo querés continuar?", [
          { id: "ia_continuar", title: "Seguir preguntando" },
          { id: "ia_cotizar", title: "Quiero una cotización" },
          { id: "ia_volver_menu", title: "Volver al inicio" }
        ]);
        saveSession(fromId, s);
        return res.sendStatus(200);
      }

      // ----- IA_ALTERNATIVAS: ajustar cotización existente -----
      if (s.stage === "IA_ALTERNATIVAS") {
        if (!textIn) {
          await waSendText(
            fromId,
            "Indícame qué te gustaría ajustar: presupuesto, cantidad de puestos, tipo de sillas, estilos, etc."
          );
          saveSession(fromId, s);
          return res.sendStatus(200);
        }

        if (nx === "ia_volver_menu") {
          resetQuoteData(s);
          s.flow = "inicio";
          s.stage = "MENU_INICIO";
          await sendMainMenu(fromId, s.nombre || null);
          saveSession(fromId, s);
          return res.sendStatus(200);
        }

        const context = [
          `Cliente: ${s.nombre || "-"}`,
          `Tipo de cliente: ${s.tipoCliente || "-"}`,
          `Ciudad / zona: ${s.ciudad || "-"} – ${s.zona || "-"}`,
          `Tipo de espacio: ${s.tipoEspacio || "-"}`,
          `Servicio: ${s.tipoServicio || "-"}`,
          `Listado actual de productos:\n${renderProductosDetalle(s.items)}`
        ].join("\n");

        s.history.push({ role: "user", content: textIn });
        const out = await chatIA(
          textIn,
          s.history,
          `El usuario ya tiene una cotización de Mobicorp con los siguientes datos:\n${context}\nProponer alternativas de configuración, combinaciones de productos y recomendaciones. No inventar precios exactos. Mantener tono profesional y cercano.`
        );
        s.history.push({ role: "assistant", content: out });

        await waSendText(fromId, out);
        await waSendText(
          fromId,
          "Si alguna de las alternativas te interesa, contame qué cambio te gustaría aplicar y lo adaptamos sobre tu cotización. También podés escribir *volver* para regresar al menú principal."
        );
        saveSession(fromId, s);
        return res.sendStatus(200);
      }
    }

    // ===== Fallback =====
    await waSendText(
      fromId,
      "Soy el asistente virtual de Mobicorp. Puedo ayudarte a resolver dudas sobre productos o preparar una cotización para tu proyecto. Escribí *volver* para ir al menú principal o *reiniciar* para empezar de cero."
    );
    saveSession(fromId, s);
    return res.sendStatus(200);
  } catch (e) {
    console.error("[WEBHOOK] Error:", e);
    return res.sendStatus(200);
  }
});

export default router;
