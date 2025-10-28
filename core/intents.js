// core/intents.js

// --- Normalizador base ---
const norm = (s = '') =>
  s.toString().trim().toLowerCase()
    .normalize('NFD').replace(/\p{Diacritic}/gu, '');

// ---- Detectores de intención por texto libre ----
export function wantsCatalog(text = '') {
  const t = norm(text);
  return /\b(catalogo|catálogo|catalog|ver productos|lista de precios)\b/.test(t);
}
export function wantsLocation(text = '') {
  const t = norm(text);
  return /\b(ubicacion|ubicación|mapa|donde estan|dónde están|como llegar|cómo llegar)\b/.test(t);
}
export function wantsHuman(text = '') {
  const t = norm(text);
  return /\b(asesor|humano|agente|hablar con alguien|soporte)\b/.test(t);
}
export function wantsClose(text = '') {
  const t = norm(text);
  return /\b(fin|terminar|gracias|chau|cerrar|finalizar)\b/.test(t);
}
export function wantsPrice(text = '') {
  const t = norm(text);
  return /\b(precio|cotizar|cotizacion|cotización|presupuesto)\b/.test(t);
}
export function wantsOpenIA(text = '') {
  const t = norm(text);
  return /\b(dudas|ia|preguntas|chat|soporte)\b/.test(t);
}

export function looksLikeFullName(text = '') {
  const t = (text ?? '').trim();
  return t.split(/\s+/).length >= 2 && /^[a-zA-ZñÑáéíóúÁÉÍÓÚ\s'.-]+$/.test(t);
}

// ---- Catálogos / opciones visibles ----
export const DEPARTAMENTOS = [
  'Santa Cruz','Beni','Pando','La Paz','Cochabamba','Oruro','Potosí','Chuquisaca','Tarija'
];

export const SUBZONAS_SCZ = [
  'Norte Integrado','Chiquitania','Vallegrande','Cordillera','Andrés Ibáñez','Warnes','Obispo Santistevan'
];

export const CROP_OPTIONS = ['Soya','Maíz','Trigo','Arroz','Girasol','Otro…'];

export const HA_RANGES = ['<50','50-100','100-300','300-500','>500','Otra…'];

// ---- Parsers / detectores de campos ----
export function detectDepartamento(text = '') {
  const t = norm(text);
  return DEPARTAMENTOS.find(d => norm(d) === t) || null;
}
export function detectSubzona(text = '') {
  const t = norm(text);
  return SUBZONAS_SCZ.find(z => norm(z) === t) || null;
}
export function parseHectareas(text = '') {
  const t = norm(text).replace(',', '.');
  const m = t.match(/(\d+(\.\d+)?)/);
  if (m) return Number(m[1]);
  if (HA_RANGES.includes(text)) return text;
  return null;
}

// ---- Heurística de cultivo desde texto libre ----
export function detectCropFromText(text = '') {
  const n = norm(text);
  if (/\b(soja|soya)\b/.test(n)) return 'Soya';
  if (/\b(maiz|maíz)\b/.test(n)) return 'Maíz';
  if (/\b(trigo)\b/.test(n)) return 'Trigo';
  if (/\b(arroz)\b/.test(n)) return 'Arroz';
  if (/\b(girasol)\b/.test(n)) return 'Girasol';
  return null;
}
