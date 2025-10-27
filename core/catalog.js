// core/catalog.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const IMG_DIR = path.join(ROOT, 'images');
const DATA_DIR = path.join(ROOT, 'data');
const PRICES_FILE = path.join(DATA_DIR, 'prices.json');

export const norm = (s = '') =>
  s.toString().trim().toLowerCase()
    .normalize('NFD').replace(/\p{Diacritic}/gu, '');

export function slugify(name) {
  return norm(name).replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, '-');
}

function loadPrices() {
  try {
    if (!fs.existsSync(PRICES_FILE)) return {};
    const raw = fs.readFileSync(PRICES_FILE, 'utf8');
    return JSON.parse(raw) || {};
  } catch { return {}; }
}

/** Carga el catálogo desde ./images (cada archivo = un producto) */
export function loadCatalog() {
  if (!fs.existsSync(IMG_DIR)) return { products: [], bySlug: new Map(), prices: {} };
  const files = fs.readdirSync(IMG_DIR).filter(f => /\.(png|jpe?g|webp)$/i.test(f));

  const products = files.map(f => {
    const base = f.replace(/\.(png|jpe?g|webp)$/i, '');
    const name = base.replace(/[_\-]+/g, ' ').trim();
    const slug = slugify(name);
    return { name, slug, file: path.join(IMG_DIR, f) };
  });

  const bySlug = new Map(products.map(p => [p.slug, p]));
  const prices = loadPrices(); // { slug: number }
  return { products, bySlug, prices };
}

function scoreMatch(base, q) {
  if (base === q) return 100;
  if (base.includes(q)) return 80;
  const qWords = q.split(' ').filter(Boolean);
  let hits = 0;
  for (const w of qWords) if (base.includes(w)) hits++;
  return hits ? 40 + hits * 5 : 0;
}

export function searchProductByText(catalog, text = '') {
  const q = norm(text).replace(/[^a-z0-9]+/g, ' ').trim();
  if (!q) return null;
  let best = null, bestScore = -1;
  for (const p of catalog.products) {
    const score = scoreMatch(p.slug.replace(/-/g, ' '), q);
    if (score > bestScore) { best = p; bestScore = score; }
  }
  return bestScore > 0 ? best : null;
}

export function getImagePathForName(catalog, name = '') {
  const found = searchProductByText(catalog, name);
  return found ? found.file : null;
}

export function findProductBySlug(catalog, slug = '') {
  return catalog.bySlug?.get(slug) || null;
}

export function getPriceBySlug(catalog, slug) {
  const v = catalog.prices?.[slug];
  return (typeof v === 'number' && Number.isFinite(v)) ? v : null;
}
