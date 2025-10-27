// wa/ai-router.js
import { aiDecideNext, aiMatchCatalogFromImage } from "../core/ai.js";
import { S } from "../server.js"; // si S no está exportado, muévelo a un módulo compartido
import { toText, askNombre, askDepartamento, askSubzonaSCZ, askSubzonaLibre,
         askCultivo, askCultivoLibre, askHectareas, askHectareasLibre,
         askCampana, askCategory, summaryText } from "./router-helpers.js"; // extrae helpers en este archivo
import fs from "fs";

const CATALOG = JSON.parse(fs.readFileSync("./knowledge/catalog.json","utf8"));

export async function handleAIText({ fromId, text }) {
  const s = S(fromId);
  const out = await aiDecideNext({ message: text, session: s });

  // Merge entidades “suaves”
  const e = out.entities || {};
  if (e.nombre && !s.profileName) s.profileName = e.nombre;
  if (e.departamento && !s.vars.departamento) s.vars.departamento = e.departamento;
  if (e.subzona && !s.vars.subzona) s.vars.subzona = e.subzona;
  if (e.cultivo && (!s.vars.cultivos || !s.vars.cultivos.length)) s.vars.cultivos = [e.cultivo];
  if (e.hectareas && !s.vars.hectareas) s.vars.hectareas = String(e.hectareas);
  if (e.campana && !s.vars.campana) s.vars.campana = e.campana;

  if (Array.isArray(out.cart) && out.cart.length) {
    s.vars.cart = out.cart;
  }

  // Router por acción
  switch (out.action) {
    case "ask_nombre":       return askNombre(fromId);
    case "ask_departamento": return askDepartamento(fromId);
    case "ask_subzona": {
      if (s.vars.departamento === "Santa Cruz") return askSubzonaSCZ(fromId);
      return askSubzonaLibre(fromId);
    }
    case "ask_cultivo":      return askCultivo(fromId);
    case "ask_hectareas":    return askHectareas(fromId);
    case "ask_campana":      return askCampana(fromId);
    case "add_to_cart": {
      if (!s.vars.cart) s.vars.cart = [];
      if (e.producto) s.vars.cart.push({ nombre:e.producto, cantidad:e.cantidad || "1 unid" });
      await toText(fromId, "Añadido al carrito. ¿Deseas algo más o prefieres cotizar?");
      return;
    }
    case "show_catalog":     return askCategory(fromId);
    case "summarize":        return toText(fromId, summaryText(s));
    case "close_quote": {
      // dejamos que tu flujo existente valide y muestre botón Cotizar
      return toText(fromId, summaryText(s)).then(() =>
        toText(fromId, "¿Listo para *cotizar*? Escribe *Cotizar* o usa el botón.")
      );
    }
    case "handoff_human":    return toText(fromId, "Listo. Aviso a un asesor para que te contacte por este chat. 🙌");
    case "smalltalk":
    default:
      return toText(fromId, "Perfecto. ¿Te ayudo a elegir producto o prefieres ver el catálogo?");
  }
}

export async function handleAIImage({ fromId, imageUrl }) {
  const s = S(fromId);
  const res = await aiMatchCatalogFromImage({ imageUrl, catalog: CATALOG });

  if (res?.match && res.confidence >= 0.6) {
    s.vars.cart = s.vars.cart || [];
    s.vars.cart.push({ nombre: res.match.nombre, presentacion: res.match.presentacion || null, cantidad: "1 unid" });
    await toText(fromId, `Creo que es *${res.match.nombre}* (confianza ${(res.confidence*100).toFixed(0)}%). Lo añadí al carrito. ¿Deseas cotizar o agregar otro?`);
  } else {
    await toText(fromId, "No estoy 100% seguro del producto. ¿Puedes confirmar el *nombre* o mandarme una foto más nítida de la etiqueta frontal?");
  }
}
