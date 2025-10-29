// src/aichat.js
// OpenAI Chat + Whisper (transcripción) — versión robusta con contexto de portafolio
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import { config } from "../env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const client = new OpenAI({ apiKey: config.OPENAI_API_KEY || process.env.OPENAI_API_KEY });
if (!client.apiKey) throw new Error("[IA] Falta OPENAI_API_KEY");

// ===== Config =====
const CHAT_MODEL     = process.env.OPENAI_MODEL       || "gpt-4o-mini";
const ASR_MODEL      = process.env.OPENAI_ASR_MODEL   || "whisper-1";
const MAX_TOKENS     = Number(process.env.AI_MAX_TOKENS     || 320);
const MAX_HISTORY    = Number(process.env.AI_MAX_HISTORY    || 8);
const RETRIES        = Number(process.env.AI_RETRIES        || 3);
const BASE_DELAY_MS  = Number(process.env.AI_BASE_DELAY_MS  || 800);
const FORCE_ES       = (process.env.AI_FORCE_SPANISH || "1") === "1";

// ===== Utils =====
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const jitter = (ms) => Math.floor(ms * (0.75 + Math.random() * 0.5));
const cleanStr = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const toNumber = (s) => Number(String(s || "").replace(/[^\d.,]/g, "").replace(",", "."));

// ===== Portafolio (contexto) =====
// IMPORTANTE: precios = 0 -> el asistente NUNCA inventa precios; solo recomienda/calcula dosis.
const PORTAFOLIO = [
  {"sku":"SEAL-20L","nombre":"SEAL","ingrediente_activo":"Atrazine 500 g/l SC","categoria":"Herbicida","cultivo":["Maíz","Sorgo"],"plaga":["Verdolaga","Quinuilla","Malva taporita","Chiori"],"dosis":"3–4 L/ha (maíz) | 3 L/ha (sorgo)","formulacion":"Herbicida selectivo de pre y postemergencia. Acción sistémica y contacto.","presentaciones":["20 L"],"precio_bs":0,"link_ficha":"https://tinyurl.com/PORTAFOLIO-NEWCHEM"},
  {"sku":"SINERGY-10-20L","nombre":"SINERGY","ingrediente_activo":"Clethodim 240 g/l EC","categoria":"Herbicida","cultivo":["Soya"],"plaga":["Rogelia","Orizahá","Cadillo","Pata de gallina","Pata de gallo"],"dosis":"0.3–0.5 L/ha","formulacion":"Herbicida selectivo post emergente. Rápida absorción y amplio uso sobre el espectro de malezas.","presentaciones":["10 L","20 L"],"precio_bs":0,"link_ficha":"https://tinyurl.com/PORTAFOLIO-NEWCHEM"},
  {"sku":"DRIER-20-200L","nombre":"DRIER","ingrediente_activo":"Paraquat dichloride 276 g/l SL","categoria":"Herbicida","cultivo":["Barbecho químico"],"plaga":["Chiori"],"dosis":"2 L/ha","formulacion":"Herbicida de contacto y desecante. Rápida acción sobre las malezas.","presentaciones":["20 L","200 L"],"precio_bs":0,"link_ficha":"https://tinyurl.com/PORTAFOLIO-NEWCHEM"},
  {"sku":"GLISATO-20-200L","nombre":"GLISATO","ingrediente_activo":"Glifosato Sal IPA 480 g/l SL","categoria":"Herbicida","cultivo":["Barbecho químico"],"plaga":["Rogelia","Torito","Verdolaga camba","Emilia","Leche leche","Sanana","Chiori","Malva taporita","Chupurujume","Maicillo"],"dosis":"2.5–3 L/ha","formulacion":"Herbicida no selectivo de acción sistémica y por translocación. Buena performance.","presentaciones":["20 L","200 L"],"precio_bs":0,"link_ficha":"https://tinyurl.com/PORTAFOLIO-NEWCHEM"},
  {"sku":"NICOXAM-10L","nombre":"NICOXAM","ingrediente_activo":"Thiametoxan 333 g/l SC","categoria":"Insecticida-Acaricida","cultivo":["Soya"],"plaga":["Chinche verde pequeño"],"dosis":"0.2–0.25 L/ha","formulacion":"Insecticida de contacto e ingestión. Excelente control para chinches.","presentaciones":["10 L"],"precio_bs":0,"link_ficha":"https://tinyurl.com/PORTAFOLIO-NEWCHEM"},
  {"sku":"TRENCH-10L","nombre":"TRENCH","ingrediente_activo":"Bifenthrin 100 g/l EC","categoria":"Insecticida-Acaricida","cultivo":["Soya"],"plaga":["Chinche café panza verde","Mosca barrenadora"],"dosis":"0.3–0.4 L/ha","formulacion":"Insecticida que actúa por contacto e ingestión. Excelente efecto de choque y volteo en plagas.","presentaciones":["10 L"],"precio_bs":0,"link_ficha":"https://tinyurl.com/PORTAFOLIO-NEWCHEM"},
  {"sku":"MEXIN-5-10L","nombre":"MEXIN","ingrediente_activo":"Abamectin 50 g/l EC","categoria":"Insecticida-Acaricida","cultivo":["Soya"],"plaga":["Ácaro"],"dosis":"0.11–0.14 L/ha","formulacion":"Insecticida-Acaricida de contacto e ingestión. Control eficaz sobre ácaros.","presentaciones":["5 L","10 L"],"precio_bs":0,"link_ficha":"https://tinyurl.com/PORTAFOLIO-NEWCHEM"},
  {"sku":"FENPRONIL-1KG","nombre":"FENPRONIL","ingrediente_activo":"Fipronil 800 g/kg WG","categoria":"Insecticida-Acaricida","cultivo":["Soya"],"plaga":["Picudo gris pequeño","Trips"],"dosis":"45–60 g/100 kg de semilla o 80 g/ha","formulacion":"Insecticida de contacto e ingestión. Altamente efectivo y contundente sobre un amplio rango de plagas.","presentaciones":["1 Kg"],"precio_bs":0,"link_ficha":"https://tinyurl.com/PORTAFOLIO-NEWCHEM"},
  {"sku":"NOATO-1KG","nombre":"NOATO","ingrediente_activo":"Emamectin Benzoato 57 g/kg WG","categoria":"Insecticida-Acaricida","cultivo":["Soya"],"plaga":["Pegador de hoja"],"dosis":"0.125–0.2 Kg/ha","formulacion":"Insecticida de contacto e ingestión. Formulación diferenciada, no tranca boquillas.","presentaciones":["1 Kg"],"precio_bs":0,"link_ficha":"https://tinyurl.com/PORTAFOLIO-NEWCHEM"},
  {"sku":"LAYER-25KG","nombre":"LAYER","ingrediente_activo":"Mancozeb 800 g/kg WP","categoria":"Fungicida","cultivo":["Soya"],"plaga":["Roya Asiática"],"dosis":"2–3 Kg/ha","formulacion":"Fungicida de contacto, preventivo, curativo, erradicante, protector-multisitio. Buen control sobre enfermedades de fin de ciclo.","presentaciones":["25 Kg"],"precio_bs":0,"link_ficha":"https://tinyurl.com/PORTAFOLIO-NEWCHEM"}
];

// Índices rápidos
const ixPorNombre   = new Map(PORTAFOLIO.map(p => [p.nombre.toLowerCase(), p]));
const ixPorSku      = new Map(PORTAFOLIO.map(p => [p.sku.toLowerCase(), p]));
const ixPorCultivo  = PORTAFOLIO.reduce((m,p)=>{
  (p.cultivo||[]).forEach(c=>{ const k=c.toLowerCase(); (m.get(k)||m.set(k,[]).get(k)).push(p); });
  return m;
}, new Map());
const ixPorPlaga    = PORTAFOLIO.reduce((m,p)=>{
  (p.plaga||[]).forEach(c=>{ const k=c.toLowerCase(); (m.get(k)||m.set(k,[]).get(k)).push(p); });
  return m;
}, new Map());

// Render contexto compacto (máx ~1-2 líneas por producto)
function renderContextoPortafolio() {
  return PORTAFOLIO.map(p => {
    const cult = (p.cultivo||[]).join(", ");
    const plg  = (p.plaga||[]).join(", ");
    return `• ${p.nombre} (${p.categoria}) — IA: ${p.ingrediente_activo}. Cultivos: ${cult || "-"}; Plagas: ${plg || "-"}; Dosis: ${p.dosis}. Presentaciones: ${p.presentaciones?.join(", ") || "-"}; Ficha: ${p.link_ficha}`;
  }).join("\n");
}

// Heurística simple para detectar intención técnica
function needsPortfolio(userText) {
  const t = userText.toLowerCase();
  return [
    "dosis","l/ha","kg/ha","cultivo","soya","maíz","maiz","sorgo","plaga","chinche","roya","barbecho",
    "glisato","drier","layer","sinergy","nicoxam","trench","mexin","fenpronil","noato","seal","mancozeb","glifosato","paraquat","clethodim"
  ].some(k => t.includes(k));
}

// Extraer hectáreas si el usuario menciona un número con ha
function extractHectareas(userText) {
  const m = userText.match(/(\d+(?:[.,]\d+)?)\s*(ha|hect(a|á)reas?)/i);
  if (!m) return null;
  const n = toNumber(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ===== Prompt builder =====
function buildMessages(userText, history=[]) {
  const hed = FORCE_ES ? "Responde en español neutro de Bolivia." : "";
  const voice = "Tono cercano, profesional y ágil (vendedor experto, cero rodeos).";
  const safety = "Si falta dato (precio/stock/registro), dilo explícitamente. No inventes precios. Ofrece cotizar o derivar a asesor.";
  const calc = "Si el usuario brinda hectáreas, calcula necesidades totales con la dosis indicada (usar rangos: da mínimo y máximo). Ej.: 2–3 L/ha × 50 ha → 100–150 L. Redondea a envases disponibles si es útil, pero acláralo.";
  const format = "Respuestas cortas y accionables. Usa viñetas cuando beneficien la lectura. Incluye nombre comercial y IA (ingrediente activo) en recomendaciones.";
  const domain = "Contexto: agricultura boliviana; barbecho químico; plagas comunes; campañas Verano/Invierno. Evita recomendaciones fuera de etiqueta.";
  const noMed = "No des consejos de seguridad ocupacional más allá de advertencias genéricas (seguir etiqueta y MSDS).";
  const closing = "Ofrece al final *cotizar* o *hablar con un asesor* cuando corresponda.";

  const sys = [
    "Eres *AgroBot* de NewChem Agroquímicos.",
    hed, voice, safety, calc, format, domain, noMed, closing
  ].filter(Boolean).join(" ");

  const ctx = needsPortfolio(userText) ? `\n\n### Portafolio disponible (resumen)\n${renderContextoPortafolio()}` : "";

  // Compactar historial (últimos N ya vienen recortados por caller; aquí limpiamos)
  const hist = (history || []).slice(-MAX_HISTORY).map(m => ({
    role: m.role,
    content: cleanStr(m.content)
  }));

  const messages = [
    { role: "system", content: sys + ctx },
    ...hist,
    { role: "user", content: cleanStr(userText) }
  ];
  return messages;
}

// =============== Chat =================
export async function chatIA(userText, history = []) {
  const text = cleanStr(userText);
  if (!text) return "¿Podés contarme un poco más? Puedo ayudarte con cultivos, plagas, dosis o cotización.";

  // Intentos con backoff + jitter
  let attempt = 0, lastErr;
  while (attempt < RETRIES) {
    try {
      const messages = buildMessages(text, history);
      const resp = await client.chat.completions.create({
        model: CHAT_MODEL,
        messages,
        temperature: 0.4,
        max_tokens: MAX_TOKENS
      });
      const out = resp?.choices?.[0]?.message?.content?.trim();
      if (out) return out;
      return "No pude generar respuesta, ¿podemos reformular la consulta?";
    } catch (err) {
      lastErr = err;
      const status = err?.status || err?.code || 500;

      // Reintentos para cuotas/errores del servidor
      if (status === 429 || status === 500 || status === 503 || status === "ETIMEDOUT") {
        const hdr = err?.headers?.get?.("retry-after") || err?.headers?.get?.("retry-after-ms");
        const serverWaitMs = hdr ? Number(hdr) * (hdr.endsWith?.("ms") ? 1 : 1000) : 0;
        const backoff = Math.min(12000, BASE_DELAY_MS * Math.pow(2, attempt));
        await sleep(Math.max(jitter(backoff), serverWaitMs));
        attempt++;
        continue;
      }

      // Errores de input o auth: no reintentar
      if (status === 400 || status === 401 || status === 403) break;

      // fallback genérico
      break;
    }
  }
  console.error("[IA chat] fallback:", lastErr);
  return "La IA está con tráfico alto. Probá de nuevo o escribí *volver* para ir al menú.";
}

// =============== Transcripción (Whisper) ===============
/**
 * transcribeAudio(buffer, filename)
 * Devuelve { text } usando whisper-1 (language: es).
 */
export async function transcribeAudio(buffer, filename = "audio.ogg") {
  const tmpDir = path.join(__dirname, "..", "data", "tmp");
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpPath = path.join(tmpDir, filename);
  fs.writeFileSync(tmpPath, buffer);

  try {
    const result = await client.audio.transcriptions.create({
      file: fs.createReadStream(tmpPath),
      model: ASR_MODEL,
      language: "es" // prioriza español
      // prompt: "Agricultura, barbecho, glifosato, paraquat, soya, maíz, sorgo, hectáreas, dosis, L/ha, Kg/ha" // opcional para vocab
    });
    return { text: cleanStr(result?.text || "") };
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}
