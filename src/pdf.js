import fs from "fs";
import path from "path";
import PDFDocument from "pdfkit";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "..", "data", "tmp");

const GRID = "#A3A3A3";
const SAFE = {
  headerBG: "#F1F5F9",
  rowBG: "#FFFFFF",
  totalBG: "#F6E3A1",
  grid: GRID
};

function ensureOut() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

function fillRect(doc, x, y, w, h, color) {
  doc.save();
  doc.fillColor(color);
  doc.rect(x, y, w, h).fill();
  doc.restore();
}

function strokeRect(doc, x, y, w, h, color = SAFE.grid, width = 0.6) {
  doc.save();
  doc.strokeColor(color);
  doc.lineWidth(width);
  doc.rect(x, y, w, h).stroke();
  doc.restore();
}

function money(n) {
  const s = Number(n || 0).toFixed(2);
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function fmtDate() {
  try {
    return new Intl.DateTimeFormat("es-BO", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric"
    }).format(new Date());
  } catch {
    const d = new Date();
    const pad = (v) => String(v).padStart(2, "0");
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
  }
}

export async function createQuotePdf({
  clienteNombre,
  tipoCliente,
  ubicacion,
  tipoEspacio,
  servicio,
  items
}) {
  ensureOut();
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const safeName = (clienteNombre || "cliente").replace(/\s+/g, "_");
  const filename = `cotizacion_${safeName}_${ts}.pdf`;
  const outPath = path.join(OUT_DIR, filename);

  const doc = new PDFDocument({ size: "A4", margin: 36 });
  const stream = fs.createWriteStream(outPath);
  doc.pipe(stream);

  const pageW = doc.page.width;
  const pageH = doc.page.height;
  const xMargin = 36;
  const usableW = pageW - xMargin * 2;

  let y = 28;
  doc
    .font("Helvetica-Bold")
    .fontSize(16)
    .fillColor("#111")
    .text("COTIZACIÓN MOBICORP", 0, y, { align: "center" });
  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor("#666")
    .text(fmtDate(), 0, y + 2, { align: "right" })
    .fillColor("black");

  y = 86;

  const addLine = (label, val) => {
    doc
      .font("Helvetica-Bold")
      .fontSize(10)
      .text(`${label}: `, xMargin, y, { continued: true });
    doc.font("Helvetica").fontSize(10).text(String(val ?? "-"));
    y += 16;
  };

  addLine("Cliente", clienteNombre || "-");
  addLine("Tipo de cliente", tipoCliente || "-");
  addLine("Ubicación", ubicacion || "-");
  addLine("Tipo de espacio", tipoEspacio || "-");
  addLine("Servicio", servicio || "-");

  y += 8;

  const cols = [
    {
      key: "name",
      label: "Producto",
      w: usableW - (70 + 90 + 100),
      align: "left"
    },
    { key: "qty", label: "Cantidad", w: 70, align: "right" },
    { key: "price", label: "Precio (Bs)", w: 90, align: "right" },
    { key: "amount", label: "Subtotal (Bs)", w: 100, align: "right" }
  ];
  const tableX = xMargin;
  const tableW = cols.reduce((a, c) => a + c.w, 0);

  const headerH = 26;
  fillRect(doc, tableX, y, tableW, headerH, SAFE.headerBG);
  doc.fillColor("#111").font("Helvetica-Bold").fontSize(9);
  {
    let cx = tableX;
    for (const cdef of cols) {
      const innerX = cx + 6;
      doc.text(cdef.label, innerX, y + (headerH - 10) / 2, {
        width: cdef.w - 12,
        align: "center"
      });
      strokeRect(doc, cx, y, cdef.w, headerH, SAFE.grid, 0.6);
      cx += cdef.w;
    }
  }
  y += headerH;

  const ensureSpace = (need = 100) => {
    if (y + need > pageH - 60) {
      doc.addPage();
      y = 42;
    }
  };

  const rowPadV = 6;
  const minRowH = 20;

  doc.fontSize(9).fillColor("black");

  let subtotal = 0;
  for (const it of items || []) {
    const qty = Number(it.qty || 1);
    const price = Number(it.price || 0);
    const sub = qty * price;
    subtotal += sub;

    const cellTexts = [
      String(it.name || "-"),
      money(qty),
      price ? money(price) : "-",
      sub ? money(sub) : "-"
    ];

    const cellHeights = [];
    for (let i = 0; i < cols.length; i++) {
      const w = cols[i].w - 12;
      const h = doc.heightOfString(cellTexts[i], {
        width: w,
        align: cols[i].align || "left"
      });
      cellHeights.push(Math.max(h + rowPadV * 2, minRowH));
    }
    const rowH = Math.max(...cellHeights);
    ensureSpace(rowH + 10);

    fillRect(doc, tableX, y, tableW, rowH, SAFE.rowBG);

    let tx = tableX;
    for (let i = 0; i < cols.length; i++) {
      const cdef = cols[i];
      const innerX = tx + 6;
      const innerW = cdef.w - 12;
      strokeRect(doc, tx, y, cdef.w, rowH, SAFE.grid, 0.5);
      doc
        .fillColor("#111")
        .font(cdef.key === "name" ? "Helvetica-Bold" : "Helvetica")
        .text(cellTexts[i], innerX, y + rowPadV, {
          width: innerW,
          align: cdef.align || "left"
        });
      tx += cdef.w;
    }
    y += rowH;
  }

  ensureSpace(50);
  const leftW = cols
    .slice(0, cols.length - 1)
    .reduce((a, c) => a + c.w, 0);
  const totalH = 28;

  strokeRect(doc, tableX, y, leftW, totalH, SAFE.grid, 0.6);
  doc
    .font("Helvetica-Bold")
    .fillColor("#111")
    .text("Total", tableX, y + (totalH - 10) / 2, {
      width: leftW,
      align: "center"
    });

  const totalX = tableX + leftW;
  const totalW = cols[cols.length - 1].w;
  fillRect(doc, totalX, y, totalW, totalH, SAFE.totalBG);
  strokeRect(doc, totalX, y, totalW, totalH, SAFE.grid, 0.6);
  doc
    .font("Helvetica-Bold")
    .fillColor("#111")
    .text(`Bs ${money(subtotal)}`, totalX + 8, y + (totalH - 10) / 2, {
      width: totalW - 16,
      align: "right"
    });
  y += totalH + 14;

  ensureSpace(40);
  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor("#444")
    .text(
      "*Precios en Bolivianos. Validez referencial 7 días. Sujeto a stock disponible y confirmación comercial.",
      xMargin,
      y,
      { width: usableW }
    );
  y = doc.y + 10;

  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor("#444")
    .text(
      "Showroom Mobicorp: ver ubicación en Google Maps:",
      xMargin,
      y,
      { width: usableW }
    );
  y = doc.y + 2;
  doc
    .fillColor("#0b57d0")
    .text(
      "https://maps.app.goo.gl/Ya8bUjnVAYkEsUiD6?g_st=iw",
      xMargin,
      y,
      { width: usableW }
    );

  y = doc.y + 12;
  doc.save();
  doc
    .moveTo(xMargin, y)
    .lineTo(xMargin + usableW, y)
    .strokeColor(SAFE.grid)
    .lineWidth(0.6)
    .stroke();
  doc.restore();
  y += 10;

  doc
    .font("Helvetica")
    .fontSize(10)
    .fillColor("#111")
    .text(
      "Gracias por confiar en Mobicorp. Si necesitás ajustar cantidades, agregar productos o revisar alternativas, respondé este mensaje y te ayudamos.",
      xMargin,
      y,
      { width: usableW }
    );

  doc.end();
  await new Promise((res) => stream.on("finish", res));
  return { path: outPath, filename };
}
