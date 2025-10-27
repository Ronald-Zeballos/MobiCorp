// core/faq.js
import { norm, slugify, searchProductByText } from './catalog.js';

/** Devuelve { text, suggestions: [productName,…] } */
export function getAdvice(message = '', catalog) {
  const t = norm(message);

  // Listado general
  if (/(que productos hay|qué productos hay|que venden|catálogo|catalogo)/.test(t)) {
    const names = catalog.products.slice(0, 6).map(p => `• ${p.name}`).join('\n');
    return {
      text: `Tenemos varios productos en stock:\n${names}\n\n¿Querés que te recomiende según tu cultivo o problema?`,
      suggestions: []
    };
  }

  // Herbicidas por cultivo (ejemplos)
  if (/herbicida/.test(t) && /(soja|soya)/.test(t)) {
    return {
      text: 'Para *Soja*, te puedo sugerir estas opciones. Confirmame cuál te interesa y lo agrego a tu cotización:',
      suggestions: pickExisting(catalog, ['Glisato', 'Layer'])
    };
  }
  if (/herbicida/.test(t) && /(maiz|maíz)/.test(t)) {
    return {
      text: 'Para *Maíz*, estas opciones son frecuentes. ¿Avanzo con alguna?',
      suggestions: pickExisting(catalog, ['Layer', 'Glisato'])
    };
  }

  // Plagas/enfermedades (ejemplos)
  if (/(chinche|chince)/.test(t)) {
    return {
      text: 'Para *chinche verde pequeña*, te puedo ofrecer estas alternativas:',
      suggestions: pickExisting(catalog, ['Nicoxam', 'Trench'])
    };
  }
  if (/(trips|oruga)/.test(t)) {
    return {
      text: 'Para control de *trips/orugas*, estas opciones son comunes:',
      suggestions: pickExisting(catalog, ['Nicoxam'])
    };
  }
  if (/(hongo|hongos|roya|mancha)/.test(t)) {
    return {
      text: 'Para problemas de *hongos* (roya/manchas), puedo sugerirte:',
      suggestions: pickExisting(catalog, ['Trench'])
    };
  }

  // Fallback: buscar por texto libre en catálogo
  const match = searchProductByText(catalog, t);
  if (match) {
    return {
      text: `Te convendría *${match.name}*. ¿Lo agrego a tu cotización?`,
      suggestions: [match.name]
    };
  }

  // Fallback genérico
  return {
    text: 'Contame un poco más (cultivo, problema o producto) y te recomiendo la mejor opción 😊',
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
