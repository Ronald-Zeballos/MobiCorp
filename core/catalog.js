// core/catalog.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const IMG_DIR = path.join(ROOT, 'images');

const norm = (s = '') =>
  s.toString().trim().toLowerCase()
    .normalize('NFD').replace(/\p{Diacritic}/gu, '');

function slugify(name) {
  return norm(name).replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

/** Carga el catálogo desde ./images (cada archivo = un producto) */
export function loadCatalog() {
  if (!fs.existsSync(IMG_DIR)) return { products: [], bySlug: new Map() };
  const files = fs.readdirSync(IMG_DIR)
    .filter(f => /\.(png|jpe?g|webp)$/i.test(f));

  const products = files.map(f => {
    const base = f.replace(/\.(png|jpe?g|webp)$/i, '');
    const name = base.replace(/[_\-]+/g, ' ').trim();
    const slug = slugify(name);
    return { name, slug, file: path.join(IMG_DIR, f) };
  });

  const bySlug = new Map(products.map(p => [p.slug, p]));
  return { products, bySlug };
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
  const q = slugify(text);
  if (!q) return null;
  let best = null, bestScore = -1;
  for (const p of catalog.products) {
    const score = scoreMatch(p.slug, q);
    if (score > bestScore) { best = p; bestScore = score; }
  }
  return bestScore > 0 ? best : null;
}

export function getImagePathForName(catalog, name = '') {
  const found = searchProductByText(catalog, name);
  return found ? found.file : null;
}
