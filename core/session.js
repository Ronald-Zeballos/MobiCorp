// core/session.js (ESM, exports nombrados)
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
    // ====== NUEVO ======
    module: 'menu',        // menu | comprar | catalogo | producto_info | ubicacion | horarios | humano | ia_chat
    greeted: false,        // saludo de bienvenida una sola vez
    // ====================
    stage: 'discovery',        // (se sigue usando en “comprar”)
    pausedUntil: 0,
    name: null,
    departamento: null,
    subzona: null,
    cultivo: null,
    hectareas: null,
    campana: null,
    items: [],
    lastWamid: null
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
    // saneo por si faltan nuevos campos
    return { ...createDefault(id), ...json };
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
