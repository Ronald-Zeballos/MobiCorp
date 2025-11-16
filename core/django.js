// core/django.js
import fetch from "node-fetch";
import { config } from "../env.js";

const BASE = (config.DJANGO_WA_URL || "").replace(/\/+$/, "");
const API_KEY = config.DJANGO_WA_API_KEY || null;

// ---------------------------------------------------------------------------
// Helpers básicos
// ---------------------------------------------------------------------------
function ensureBase() {
  if (!BASE) {
    console.warn("[DJANGO] DJANGO_WA_URL no configurada, NO envío nada.");
    return false;
  }
  return true;
}

function buildHeaders() {
  const h = { "Content-Type": "application/json" };
  // Solo manda la API key si existe
  if (API_KEY) {
    h["X-API-Key"] = API_KEY;
  }
  return h;
}

// ---------------------------------------------------------------------------
// 1) Completar precios del carrito desde el backend
//    Usa tus entidades Producto / PrecioPropio y devuelve price/subtotal.
// ---------------------------------------------------------------------------
/**
 * Pide al backend que complete precios del carrito.
 *
 * Esperamos que el backend exponga algo tipo:
 *   POST /api/wa/cart/preview/
 *   body:
 *   {
 *     canal: "whatsapp",
 *     ciudad: "...",
 *     zona: "...",
 *     items: [
 *       { skuInterno, nombre, cantidad }
 *     ]
 *   }
 *
 * y devuelva:
 *   {
 *     items: [
 *       { skuInterno, nombre, cantidad, precioUnitario, subtotal }
 *     ],
 *     subtotal: 1234.56,
 *     moneda: "BOB"
 *   }
 *
 * Nada explota si el backend aún no está listo: loguea y deja los precios como están.
 */
export async function djangoFillCartPrices(session, fromId) {
  if (!ensureBase()) return;

  if (!Array.isArray(session.items) || !session.items.length) {
    return;
  }

  // Ajusta este path al endpoint real de tu backend
  const url = `${BASE}/api/wa/cart/preview/`;

  const itemsPayload = session.items.map((it) => ({
    skuInterno: it.sku || it.code || null,
    nombre: it.name,
    cantidad: it.qty || 1
  }));

  const payload = {
    canal: "whatsapp",     // CanalVenta.WHATSAPP
    ciudad: session.ciudad || null,
    zona: session.zona || null,
    items: itemsPayload
  };

  try {
    console.log("[DJANGO] Enviando carrito para precios ->", url);
    const res = await fetch(url, {
      method: "POST",
      headers: buildHeaders(),
      body: JSON.stringify(payload)
    });

    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_) {
      console.warn("[DJANGO] Respuesta preview no es JSON:", text?.slice(0, 300));
    }

    console.log("[DJANGO] preview status", res.status);

    if (!res.ok || !data) {
      console.warn("[DJANGO] preview no OK, dejo precios como estaban.");
      return;
    }

    // Merge precios devueltos
    if (Array.isArray(data.items)) {
      const bySku = new Map();
      for (const it of data.items) {
        const key = (it.skuInterno || it.sku || it.nombre || "").toLowerCase();
        if (key) bySku.set(key, it);
      }

      session.items = session.items.map((it) => {
        const key = (it.sku || it.code || it.name || "").toLowerCase();
        const match = bySku.get(key);
        if (match) {
          const qty = match.cantidad ?? it.qty ?? 1;
          const price = match.precioUnitario ?? match.precio ?? it.price ?? 0;
          const subtotal =
            match.subtotal ?? (price * qty);

          return {
            ...it,
            qty,
            price,
            subtotal
          };
        }
        return it;
      });
    }

    if (typeof data.subtotal === "number") {
      session.subtotalPreliminar = data.subtotal;
    } else {
      // calculamos subtotal si no vino
      session.subtotalPreliminar = session.items.reduce(
        (acc, it) => acc + ((it.price || 0) * (it.qty || 1)),
        0
      );
    }

    if (data.moneda) {
      session.moneda = data.moneda; // "BOB" / "USD"
    }
  } catch (e) {
    console.error("[DJANGO] Error al pedir precios:", e);
  }
}

// ---------------------------------------------------------------------------
// 2) Enviar pedido final (Cliente + Pedido + Detalles)
//    Acá usamos tus entidades Cliente, Pedido, PedidoDetalle, Moneda, CanalVenta.
// ---------------------------------------------------------------------------
/**
 * Envía el pedido final al backend cuando ya generaste el PDF.
 *
 * Propuesta de payload (lo que deberías soportar en el backend):
 *
 * POST /api/wa/orders/
 * {
 *   canal: "whatsapp",
 *   cliente: {
 *     nombreCompleto,
 *     email,
 *     telefono,
 *     zona,
 *     ciudad,
 *     pais,
 *     canalOrigen: "whatsapp"
 *   },
 *   pedido: {
 *     montoTotal,
 *     moneda: "BOB",
 *     observaciones,
 *     urlPdfCotizacion
 *   },
 *   items: [
 *     {
 *       skuInterno,
 *       nombre,
 *       cantidad,
 *       precioUnitario,
 *       precioLista,
 *       descuentoPorcentaje,
 *       subtotal
 *     }
 *   ],
 *   meta: { ...info extra opcional... }
 * }
 */
export async function djangoSendOrder(session, fromId, extra = {}) {
  if (!ensureBase()) return;

  // Ajusta este path al endpoint real de tu backend
  const url = `${BASE}/api/wa/orders/`;

  const total =
    session.totalCalculado ??
    session.subtotalPreliminar ??
    session.items?.reduce(
      (acc, it) => acc + ((it.price || 0) * (it.qty || 1)),
      0
    ) ??
    0;

  const itemsPayload = (session.items || []).map((it) => {
    const qty = it.qty || 1;
    const price = it.price || 0;
    const subtotal = it.subtotal ?? (price * qty);

    return {
      skuInterno: it.sku || it.code || null,
      nombre: it.name,
      cantidad: qty,
      precioUnitario: price,
      precioLista: price,          // por ahora igual; backend puede ajustar
      descuentoPorcentaje: 0,      // por ahora sin descuento
      subtotal: subtotal
    };
  });

  const clientePayload = {
    nombreCompleto: session.nombre || "",
    email: session.email || "",
    telefono: fromId || "",
    zona: session.zona || "",
    ciudad: session.ciudad || "",
    pais: "Bolivia",
    canalOrigen: "whatsapp"   // CanalVenta.WHATSAPP
  };

  const pedidoPayload = {
    montoTotal: total,
    moneda: session.moneda || "BOB", // Moneda.BOB por defecto
    observaciones:
      extra.observaciones ||
      `Cotización generada desde bot de WhatsApp. Tipo cliente: ${session.tipoCliente || "-"}. Espacio: ${session.tipoEspacio || "-"}.`,
    urlPdfCotizacion: extra.pdfUrl || null
  };

  const payload = {
    canal: "whatsapp",
    cliente: clientePayload,
    pedido: pedidoPayload,
    items: itemsPayload,
    meta: {
      waId: fromId,
      flow: session.flow,
      stage: session.stage,
      tipoCliente: session.tipoCliente,
      tipoEspacio: session.tipoEspacio,
      tipoServicio: session.tipoServicio,
      departamento: session.departamento,
      rawCartText: session.rawCartText || null,
      pdfFilename: extra.pdfFilename || null,
      quoteId: extra.quoteId || null
    }
  };

  try {
    console.log("[DJANGO] Enviando orden final ->", url);
    const res = await fetch(url, {
      method: "POST",
      headers: buildHeaders(),
      body: JSON.stringify(payload)
    });

    const body = await res.text();
    console.log(
      "[DJANGO] order status",
      res.status,
      "body:",
      body?.slice(0, 400)
    );
  } catch (e) {
    console.error("[DJANGO] Error al enviar orden:", e);
  }
}
