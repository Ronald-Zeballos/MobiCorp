// core/intents.js

const norm = (s = "") => s.toString().trim().toLowerCase()
  .normalize("NFD").replace(/\p{Diacritic}/gu, "");

export function isMenuText(t="") {
  const x = norm(t);
  return /\b(volver|menu|men[uú]|inicio|principal)\b/.test(x);
}

export function commandFromText(t="") {
  const x = norm(t);
  if (/\b(cotizar|comprar|precio|presupuesto)\b/.test(x)) return "cotizar";
  if (/\b(catalogo|cat[aá]logo|lista de productos)\b/.test(x)) return "catalogo";
  if (/\b(producto|saber de un producto|consulta producto)\b/.test(x)) return "producto";
  if (/\b(ubicaci[oó]n|mapa|d[oó]nde est[aá]n)\b/.test(x)) return "ubicacion";
  if (/\b(horario|horarios|atenci[oó]n)\b/.test(x)) return "horarios";
  if (/\b(asesor|humano|agente|hablar con alguien|soporte)\b/.test(x)) return "asesor";
  if (/\b(ia|dudas|preguntas|recomienda|recomend[aé]s|que me recomend)\b/.test(x)) return "dudas";
  return null;
}

// Campos de cotización
export const DEPARTAMENTOS = [
  "Santa Cruz","Beni","Pando","La Paz","Cochabamba","Oruro","Potosí","Chuquisaca","Tarija"
];

export const SUBZONAS_SCZ = [
  "Norte Integrado","Chiquitania","Vallegrande","Cordillera","Andrés Ibáñez","Warnes","Obispo Santistevan"
];

export const CROP_OPTIONS = ["Soya","Maíz","Trigo","Arroz","Girasol","Otro…"];
export const HA_RANGES = ["<50","50-100","100-300","300-500",">500","Otra…"];

export function detectDepartamento(text) {
  const t = norm(text);
  return DEPARTAMENTOS.find(d => norm(d) === t) || null;
}
export function detectSubzona(text) {
  const t = norm(text);
  return SUBZONAS_SCZ.find(z => norm(z) === t) || null;
}
export function parseHectareas(text) {
  const t = norm(text).replace(",", ".");
  const m = t.match(/(\d+(\.\d+)?)/);
  if (m) return Number(m[1]);
  if (HA_RANGES.includes(text)) return text;
  return null;
}
export function looksLikeFullName(text) {
  const s = (text ?? "").trim();
  return s.split(/\s+/).length >= 2 && /^[a-zA-ZñÑáéíóúÁÉÍÓÚ\s'.-]+$/.test(s);
}
