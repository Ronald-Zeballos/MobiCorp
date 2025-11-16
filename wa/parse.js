// src/parse.js

/**
 * Parser de "carrito pegado" desde el catálogo web.
 *
 * Formato esperado (flexible), líneas con viñetas tipo:
 *  * Escritorio Evo x2 @ 1500 -> 3000
 *  - Silla Nova x3 @ 850
 *
 * Devuelve:
 *   { items: [{ name, qty, price }...], subtotal }
 * o null si no detecta ítems.
 */
export function parseCartFromText(text = "") {
  const lines = String(text)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  const items = [];

  for (const line of lines) {
    if (!/^[*•\-]/.test(line)) continue;

    const clean = line.replace(/^[*•\-\u2022]\s*/, "");

    const mQty = clean.match(/x\s*([\d.,]+)/i);
    const mPrice = clean.match(/@\s*([\d.,]+)/);

    const name = clean
      .replace(/x\s*([\d.,]+)/i, "")
      .replace(/@\s*([\d.,]+)/, "")
      .replace(/->.*$/, "")
      .trim();

    const qty = mQty ? Number(mQty[1].replace(",", ".")) : 1;
    const price = mPrice ? Number(mPrice[1].replace(",", ".")) : null;

    if (name) {
      items.push({
        name,
        qty: Number.isFinite(qty) && qty > 0 ? qty : 1,
        price: Number.isFinite(price) && price >= 0 ? price : null
      });
    }
  }

  if (!items.length) return null;

  const subtotal = items.reduce(
    (acc, it) => acc + ((it.price || 0) * (it.qty || 1)),
    0
  );

  return { items, subtotal };
}
