// core/store.js
import fs from 'fs';
import path from 'path';

const BASE = path.resolve(process.cwd(), 'data');

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

export function loadJSON(relPath, fallback = {}) {
  try {
    const abs = path.join(BASE, relPath);
    ensureDir(path.dirname(abs));
    if (!fs.existsSync(abs)) return fallback;
    const raw = fs.readFileSync(abs, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function saveJSON(relPath, data) {
  const abs = path.join(BASE, relPath);
  ensureDir(path.dirname(abs));
  fs.writeFileSync(abs, JSON.stringify(data, null, 2));
}
