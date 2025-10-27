// core/faq.js
import { norm, searchProductByText } from './catalog.js';

const EMO = ['😊','😉','✨','👍','🙌','🧑‍🌾','🌱','🛒','✅'];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/** Devuelve { text, suggestions: [productName,…] } */
export function getAdvice(message = '', catalog) {
  const t = norm(message);

  // Listado general
  if (/(que productos hay|qué productos hay|que venden|catálogo|catalogo)/.test(t)) {
    const names = catalog.products.slice(0, 6).map(p => `• ${p.name}`).join('\n');
    return {
      text: `${pick(EMO)} Tenemos stock de varios productos:\n${names}\n\n¿Querés que te recomiende según tu *cultivo* o el *problema* que estás viendo?`,
      suggestions: []
    };
  }

  // Herbicidas por cultivo (ejemplos)
  if (/herbicida/.test(t) && /(soja|soya)/.test(t)) {
    return {
      text: `Para *Soja*, estas opciones andan muy bien ${pick(EMO)}\nConfirmame cuál te interesa y lo agrego:`,
      suggestions: pickExisting(catalog, ['Glisato', 'Layer'])
    };
  }
  if (/herbicida/.test(t) && /(maiz|maíz)/.test(t)) {
    return {
      text: `Para *Maíz*, estas dos son de las más usadas ${pick(EMO)}\n¿Con cuál avanzamos?`,
      suggestions: pickExisting(catalog, ['Layer', 'Glisato'])
    };
  }

  // Plagas/enfermedades (ejemplos)
  if (/(chinche|chince)/.test(t)) {
    return {
      text: `Para *chinche verde pequeña*, te sugiero estas alternativas ${pick(EMO)}:`,
      suggestions: pickExisting(catalog, ['Nicoxam', 'Trench'])
    };
  }
  if (/(trips|oruga)/.test(t)) {
    return {
      text: `Para control de *trips/orugas*, estas opciones funcionan muy bien ${pick(EMO)}:`,
      suggestions: pickExisting(catalog, ['Nicoxam'])
    };
  }
  if (/(hongo|hongos|roya|mancha)/.test(t)) {
    return {
      text: `Para problemas de *hongos* (roya/manchas), podés considerar ${pick(EMO)}:`,
      suggestions: pickExisting(catalog, ['Trench'])
    };
  }

  // Fallback: buscar por texto libre
  const match = searchProductByText(catalog, t);
  if (match) {
    return {
      text: `Por lo que contás, *${match.name}* te va a rendir muy bien ${pick(EMO)}. ¿Lo agrego a tu cotización?`,
      suggestions: [match.name]
    };
  }

  // Fallback genérico, invitando a "volver"
  return {
    text: `¡Te acompaño! Contame un poco más (cultivo, problema o producto) y te recomiendo la mejor opción ${pick(EMO)}.\nSi no necesitás nada más, escribí *volver* para ir al menú principal.`,
    suggestions: []
  };
}

function pickExisting(catalog, names = []) {
  const present = [];
  for (const n of names) {
    const m = searchProductByText(catalog, n);
    if (m) present.push(m.name);
  }
  return present;
}
