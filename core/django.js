// core/django.js
// Envío de leads desde el bot de WhatsApp hacia tu backend Django

import fetch from "node-fetch";
import { config } from "../env.js";

/**
 * sendLeadToDjango(payload)
 * payload: objeto con todos los datos del flujo (nombre, ciudad, etc).
 */
export async function sendLeadToDjango(payload) {
  const url = config.DJANGO_WA_URL || process.env.DJANGO_WA_URL;
  const apiKey = config.DJANGO_WA_API_KEY || process.env.DJANGO_WA_API_KEY;

  if (!url || !apiKey) {
    console.warn(
      "[DJANGO] Falta DJANGO_WA_URL o DJANGO_WA_API_KEY. No envío lead."
    );
    return;
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": apiKey, // tu backend Django debe validar esto
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "(sin body)");
      console.error("[DJANGO] Error al enviar lead:", res.status, text);
    } else if (process.env.DEBUG_LOGS === "1") {
      const json = await res.json().catch(() => ({}));
      console.log("[DJANGO] Lead enviado OK:", json);
    }
  } catch (e) {
    console.error("[DJANGO] Error de red hacia Django:", e);
  }
}
