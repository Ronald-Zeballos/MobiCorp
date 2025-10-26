// src/pdf.js
import fs from 'fs';
import path from 'path';
import PDFDocument from 'pdfkit';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'data', 'tmp');

function ensureOut() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

export async function createQuotePdf({ name, ubicacion, cultivo, hectareas, campana, items }) {
  ensureOut();
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `cotizacion_${(name || 'cliente').replace(/\s+/g, '_')}_${ts}.pdf`;
  const outPath = path.join(OUT_DIR, filename);

  const doc = new PDFDocument({ margin: 50 });
  const stream = fs.createWriteStream(outPath);
  doc.pipe(stream);

  // Encabezado
  doc.fontSize(20).text('Cotización', { align: 'right' });
  doc.moveDown(0.2);
  doc.fontSize(10).text(`Fecha: ${new Date().toLocaleString()}`, { align: 'right' });
  doc.moveDown();

  // Datos del cliente
  doc.fontSize(12).text('Datos del cliente', { underline: true });
  doc.moveDown(0.2);
  const lines = [
    `Nombre: ${name || '-'}`,
    `Ubicación: ${ubicacion || '-'}`,
    `Cultivo: ${cultivo || '-'}`,
    `Hectáreas: ${hectareas || '-'}`,
    `Campaña: ${campana || '-'}`
  ];
  lines.forEach(l => doc.text(l));
  doc.moveDown();

  // Ítems
  doc.fontSize(12).text('Productos / Servicios', { underline: true });
  doc.moveDown(0.4);

  const headers = ['#', 'Descripción', 'Cant.', 'Precio', 'Importe'];
  const widths = [30, 280, 60, 80, 80];
  const x0 = doc.x;
  const y0 = doc.y;

  function drawRow(y, arr) {
    let x = x0;
    arr.forEach((txt, i) => {
      doc.fontSize(10).text(String(txt), x, y, { width: widths[i], continued: false });
      x += widths[i];
    });
  }

  drawRow(y0, headers);
  let y = y0 + 18;
  let subtotal = 0;

  (items || []).forEach((it, idx) => {
    const qty = it.qty || 1;
    const price = Number(it.price || 0);
    const imp = price * qty;
    subtotal += imp;
    drawRow(y, [idx + 1, it.name || '-', qty, price ? price.toFixed(2) : '-', imp ? imp.toFixed(2) : '-']);
    y += 16;
  });

  doc.moveDown();
  doc.text(''.padEnd(60, '_'));
  doc.moveDown(0.2);
  doc.fontSize(11).text(`Subtotal: ${subtotal.toFixed(2)} Bs`, { align: 'right' });
  doc.fontSize(11).text(`Total: ${subtotal.toFixed(2)} Bs`, { align: 'right' });

  doc.moveDown();
  doc.fontSize(10).text('Condiciones:', { underline: true });
  doc.fontSize(9).list([
    'Precios expresados en Bolivianos (Bs).',
    'Validez de la cotización: 7 días calendario.',
    'Sujeto a disponibilidad de stock y confirmación final.'
  ]);

  doc.end();
  await new Promise((res) => stream.on('finish', res));
  return { path: outPath, filename };
}
