const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');

// Shared cell formatting so dates and nulls look the same in both formats.
function formatCell(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value;
}

async function sendExcel(res, filename, title, columns, rows) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Tplus API';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet((title || 'Report').slice(0, 31));
  sheet.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width || 20 }));
  sheet.getRow(1).font = { bold: true };
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };

  rows.forEach((row) => {
    const values = {};
    columns.forEach((c) => {
      values[c.key] = formatCell(row[c.key]);
    });
    sheet.addRow(values);
  });

  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
  await workbook.xlsx.write(res);
  res.end();
}

// No table primitive in pdfkit, so rows are drawn by hand: a dark header band,
// zebra striping for readability, and a fresh header whenever a page fills up.
function sendPdf(res, filename, title, columns, rows) {
  const doc = new PDFDocument({ margin: 30, size: 'A4', layout: 'landscape' });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.pdf"`);
  doc.pipe(res);

  doc.fontSize(16).fillColor('#000000').text(title, { align: 'left' });
  doc
    .fontSize(9)
    .fillColor('#555555')
    .text(`Generated ${new Date().toLocaleString()} - ${rows.length} record(s)`);
  doc.moveDown(0.5);
  doc.fillColor('#000000');

  const startX = doc.page.margins.left;
  const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const colWidth = usableWidth / columns.length;
  const rowHeight = 18;
  const pageBottom = doc.page.height - doc.page.margins.bottom;
  let y = doc.y;

  function drawHeaderRow() {
    doc.rect(startX, y, usableWidth, rowHeight).fill('#333333');
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8);
    columns.forEach((c, i) => {
      doc.text(c.header, startX + i * colWidth + 2, y + 5, {
        width: colWidth - 4,
        height: rowHeight - 4,
        ellipsis: true,
        lineBreak: false,
      });
    });
    y += rowHeight;
    doc.fillColor('#000000').font('Helvetica');
  }

  drawHeaderRow();

  rows.forEach((row, idx) => {
    if (y + rowHeight > pageBottom) {
      doc.addPage();
      y = doc.page.margins.top;
      drawHeaderRow();
    }

    if (idx % 2 === 1) {
      doc.rect(startX, y, usableWidth, rowHeight).fill('#f2f2f2');
      doc.fillColor('#000000');
    }

    doc.fontSize(8);
    columns.forEach((c, i) => {
      doc.text(String(formatCell(row[c.key])), startX + i * colWidth + 2, y + 5, {
        width: colWidth - 4,
        height: rowHeight - 4,
        ellipsis: true,
        lineBreak: false,
      });
    });
    y += rowHeight;
  });

  doc.end();
}

module.exports = { sendExcel, sendPdf };
