/**
 * Parser de "carrito pegado" por texto.
 * Formato esperado (flexible), líneas con viñetas:
 *  * Producto A x2 @ 150 -> 300
 *  * Herbicida XYZ 5L x1
 *  - Semilla Soya 25kg @ 220
 *
 * Devuelve:
 *   { items: [{ name, qty, price }...], subtotal }
 * ó null si no detecta ítems.
 */
export function parseCartFromText(text = '') {
  const lines = String(text)
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean);

  const items = [];
  for (const line of lines) {
    // Solo considera líneas que comienzan con viñeta
    if (!/^[*•\-]/.test(line)) continue;

    // Limpia viñeta inicial
    const clean = line.replace(/^[*•\-\u2022]\s*/, '');

    // Captura cantidad (x N) y precio (@ P)
    const mQty = clean.match(/x\s*([\d.,]+)/i);
    const mPrice = clean.match(/@\s*([\d.,]+)/);

    // Nombre = lo que queda sin "x N", "@ P" ni "-> ..."
    const name = clean
      .replace(/x\s*([\d.,]+)/i, '')
      .replace(/@\s*([\d.,]+)/, '')
      .replace(/->.*$/, '')
      .trim();

    const qty = mQty ? Number(mQty[1].replace(',', '.')) : 1;
    const price = mPrice ? Number(mPrice[1].replace(',', '.')) : null;

    if (name) items.push({ name, qty: Number.isFinite(qty) ? qty : 1, price: Number.isFinite(price) ? price : null });
  }

  if (!items.length) return null;

  const subtotal = items.reduce((acc, it) => acc + ((it.price || 0) * (it.qty || 1)), 0);
  return { items, subtotal };
}
