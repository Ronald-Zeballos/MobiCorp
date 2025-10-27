// core/ai.js
import OpenAI from "openai";

// Cliente OpenAI opcional (no rompe si no hay API key)
export const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

// Utilidades de normalización y títulos
export const norm = (t = "") =>
  t.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
export const title = (s = "") =>
  String(s)
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());

// Catálogos de ubicaciones
export const DEPARTAMENTOS = [
  "Santa Cruz",
  "Cochabamba",
  "La Paz",
  "Chuquisaca",
  "Tarija",
  "Oruro",
  "Potosí",
  "Beni",
  "Pando",
];

const SUBZONAS_SCZ = [
  "Norte Integrado",
  "Norte",
  "Este",
  "Sur",
  "Valles",
  "Chiquitania",
];

// === Parsers / NLU “clásicos” (sin LLM) ===
export function parseHectareas(text = "") {
  //  "300 ha" | "300" | "301–500 ha" | "100-300"
  const m1 = String(text).match(/(\d{1,6}(?:[.,]\d{1,2})?)\s*(ha|hect[aá]reas?)/i);
  if (m1) return m1[1].replace(",", ".");
  const m2 = String(text).match(/^\s*(\d{1,6}(?:[.,]\d{1,2})?)\s*$/);
  if (m2) return m2[1].replace(",", ".");
  // Rango legible
  const m3 = String(text).match(/(\d{1,6})\s*[–-]\s*(\d{1,6})/);
  if (m3) return `${m3[1]}–${m3[2]}`;
  return null;
}

export function detectDepartamento(text = "") {
  const t = norm(text);
  for (const d of DEPARTAMENTOS) {
    if (t.includes(norm(d))) return d;
  }
  return null;
}

export function detectSubzona(text = "") {
  const t = norm(text);
  for (const z of SUBZONAS_SCZ) {
    if (t.includes(norm(z))) return z;
  }
  return null;
}

export function shouldCloseNow(text = "") {
  // Señales de intención de cierre / avanzar a PDF
  const t = norm(text);
  return /(cotizar|proforma|finalizar|cerrar pedido|generar pdf|enviar pedido)/i.test(t);
}

// === Visión (opcional): detectar producto desde imagen ===
// Devuelve { match:true, producto:"GLISATO" } o null sin match.
// Para producción puedes afinar con embeddings + nombres de archivo en /image.
export async function detectProductFromImage({ url, b64 } = {}) {
  if (!openai) return null;
  try {
    const msg = [
      {
        role: "system",
        content:
          "Eres un verificador de productos. Devuelves solo el nombre comercial si reconoces uno de estos: GLISATO, DRIER, LAYER, NICOXAM, TRENCH. Si no estás seguro, responde 'NONE'.",
      },
      {
        role: "user",
        content: [
          { type: "text", text: "¿Qué producto del catálogo aparece?" },
          url
            ? { type: "image_url", image_url: { url } }
            : { type: "input_image", image_data: b64 },
        ],
      },
    ];
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: msg,
      temperature: 0,
    });
    const raw = resp.choices?.[0]?.message?.content?.trim() || "NONE";
    const name = raw.toUpperCase().replace(/[^A-Z]/g, "");
    const known = ["GLISATO", "DRIER", "LAYER", "NICOXAM", "TRENCH"];
    if (known.includes(name)) return { match: true, producto: name };
    return null;
  } catch {
    return null;
  }
}
