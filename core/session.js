// core/session.js (ESM)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');                     // /core -> raíz del repo
const SESS_DIR = path.join(ROOT, 'data', 'tmp', 'sessions'); // ./data/tmp/sessions
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 días

function ensureDirs() {
  fs.mkdirSync(SESS_DIR, { recursive: true });
}
function sessPath(id) {
  return path.join(SESS_DIR, `${id}.json`);
}

export function createDefault(id) {
  return {
    _id: id,
    _ts: Date.now(),

    // Modo de orquestación
    mode: 'menu',            // 'menu' | 'cotizar' | 'catalogo' | 'producto' | 'ubicacion' | 'horarios' | 'asesor' | 'ia'
    stage: 'discovery',      // retrocompat
    pausedUntil: 0,

    // Datos del cliente / solicitud
    name: null,
    departamento: null,
    subzona: null,
    cultivo: null,
    hectareas: null,
    campana: null,
    items: [],

    // Anti-loop y UI
    awaitingSlot: null,
    awaitingAt: 0,
    slotRetries: {},
    shownSummaryAt: 0,

    // IA abierta
    iaHistory: [],

    // Otros
    greeted: false,
    lastWamid: null,
    profileName: null
  };
}

export function loadSession(id) {
  ensureDirs();
  try {
    const p = sessPath(id);
    if (!fs.existsSync(p)) return createDefault(id);
    const raw = fs.readFileSync(p, 'utf8');
    const json = JSON.parse(raw);
    if (Date.now() - (json._ts || 0) > TTL_MS) return createDefault(id);
    return json;
  } catch {
    return createDefault(id);
  }
}

export function saveSession(id, data) {
  ensureDirs();
  const s = { ...data, _ts: Date.now(), _id: id };
  fs.writeFileSync(sessPath(id), JSON.stringify(s, null, 2));
  return s;
}
