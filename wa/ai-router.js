// wa/ai-router.js
import { aiExtractFields, aiIdentifyProductFromPhoto, quickIntent, shouldCloseNow } from "../core/ai.js";
import { smartAskNext, askForQuoteConfirmation, DEPARTAMENTOS, SUBZONAS_SCZ } from "../core/flow.js";
import { sendCatalogLink, sendImage, sendText, sendButtons, sendList } from "./send.js";
import { sendAutoQuotePDF } from "../src/quote.js";

const ui = {
  text: sendText,
  buttons: sendButtons,
  list: sendList,
  image: sendImage
};

// Normaliza selección de listas/botones
function applySelection(id, s) {
  if (!id) return;
  if (id.startsWith("DPTO_")) {
    s.vars.departamento = id.replace("DPTO_","");
    s.vars.subzona = null;
    return;
  }
  if (id.startsWith("SUBZ_")) {
    const key = id.replace("SUBZ_","");
    const mapa = {NORTE:"Norte", ESTE:"Este", SUR:"Sur", VALLES:"Valles", CHIQUITANIA:"Chiquitania"};
    s.vars.subzona = mapa[key] || key;
    return;
  }
  if (id.startsWith("CROP_")) {
    const v = id.replace("CROP_","");
    if (v === "Otro") s.vars.cultivos = [];
    else s.vars.cultivos = [v];
    return;
  }
  if (id.startsWith("HA_")) {
    const label = {
      HA_0_100:'0–100 ha', HA_101_300:'101–300 ha', HA_301_500:'301–500 ha',
      HA_1000_3000:'1,000–3,000 ha', HA_3001_5000:'3,001–5,000 ha', HA_5000_MAS:'+5,000 ha'
    }[id] || '—';
    s.vars.hectareas = label;
    return;
  }
  if (id.startsWith("CAMP_")) {
    s.vars.campana = id.replace("CAMP_","");
    return;
  }
}

export async function handleIncoming({ fromId, s, msg }) {
  const type = msg.type;

  // === 1) Foto: IA visión intenta reconocer producto del catálogo
  if (type === "image") {
    const url = msg.image?.link || msg.image?.url;
    if (url) {
      const match = await aiIdentifyProductFromPhoto(url);
      if (match) {
        await ui.image(fromId, { localName: `${match}.jpg` }); // si tienes /image/Nombre.jpg
        await ui.text(fromId, `Parece *${match}*. ¿Deseas cotizarlo?`);
        await sendCatalogLink(fromId);
      } else {
        await ui.text(fromId, "Recibí la imagen 👍. No pude identificar el producto con certeza. ¿Me indicas el nombre?");
      }
    }
    return await smartAskNext(fromId, s, ui);
  }

  // === 2) Interactivos (botones/listas)
  if (type === "interactive") {
    const id = msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id;
    applySelection(id, s);
    if (id === "ACTION_GENERAR_PDF") {
      return await generateQuote(fromId, s);
    }
    return await smartAskNext(fromId, s, ui);
  }

  // === 3) Texto libre → IA extrae info
  if (type === "text") {
    const text = (msg.text?.body || "").trim();
    // Intent rápido
    const qi = quickIntent(text);
    if (qi === "ask_catalog") {
      await sendCatalogLink(fromId);
      return await smartAskNext(fromId, s, ui);
    }
    if (qi === "handoff") {
      await ui.text(fromId, "¡Claro! Avisé a un asesor para que te escriba por este chat. Pauso el asistente un momento 🙌");
      s.meta = s.meta || {}; s.meta.human = true;
      return;
    }

    // IA estructurada
    const out = await aiExtractFields(text, s);
    if (out?.nombre && !s.profileName) s.profileName = out.nombre;
    if (out?.departamento && !s.vars.departamento) s.vars.departamento = out.departamento;
    if (out?.subzona && !s.vars.subzona) s.vars.subzona = out.subzona;
    if (out?.cultivo && (!s.vars.cultivos || !s.vars.cultivos.length)) s.vars.cultivos = [out.cultivo];
    if (out?.hectareas && !s.vars.hectareas) s.vars.hectareas = out.hectareas;
    if (out?.campana && !s.vars.campana) s.vars.campana = out.campana;

    if (out?.intent === "ready_to_quote" || shouldCloseNow(s)) {
      return await askForQuoteConfirmation(fromId, s, ui);
    }
    return await smartAskNext(fromId, s, ui);
  }
}

// ==== Cierre lineal ====
async function generateQuote(fromId, s) {
  try {
    const pdf = await sendAutoQuotePDF(fromId, s);
    if (pdf?.mediaId) {
      await ui.text(fromId, "📄 ¡Listo! Te envié tu *cotización en PDF*. Si deseas ajustar cantidades o agregar productos, dime y lo recalculamos.");
    } else {
      await ui.text(fromId, "Generé tu PDF, pero no pude adjuntarlo automáticamente. Avísame y lo reintento.");
    }
    // opcional: activar modo humano
    s.meta = s.meta || {}; s.meta.human = true;
  } catch (e) {
    await ui.text(fromId, "No pude generar el PDF ahora. ¿Te parece si lo intento nuevamente o prefieres que te contacte un asesor?");
  }
}
