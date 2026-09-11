// Builds a tiny, fully synthetic 2-page PDF with one external link annotation
// (page 1 -> https://example.com/) and one internal link annotation
// (page 1 -> page 2), for annotations.e2e.mjs only. Never real deck content.
export function buildAnnotationsPdf() {
  const objects = [];
  // Index 0 is reserved by the PDF spec (the free-list head); real objects start at 1.
  const push = (body) => { objects.push(body); return objects.length; };

  const catalogNum = push(''); // placeholder, filled in after we know the pages object number
  const pagesNum = push(''); // placeholder
  const page1ContentNum = push('<< /Length 44 >>\nstream\nBT /F1 18 Tf 20 100 Td (Page one) Tj ET\nendstream');
  const page2ContentNum = push('<< /Length 44 >>\nstream\nBT /F1 18 Tf 20 100 Td (Page two) Tj ET\nendstream');
  const fontNum = push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const page2Num = push(''); // placeholder, referenced by the internal-link annotation's Dest
  const extLinkNum = push(
    '<< /Type /Annot /Subtype /Link /Rect [10 150 90 190] /Border [0 0 0]' +
    ' /A << /Type /Action /S /URI /URI (https://example.com/) >> >>'
  );
  const intLinkNum = push(
    `<< /Type /Annot /Subtype /Link /Rect [10 100 90 140] /Border [0 0 0]` +
    ` /Dest [${page2Num} 0 R /XYZ null null null] >>`
  );
  const page1Num = push(
    `<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 200 200]` +
    ` /Resources << /Font << /F1 ${fontNum} 0 R >> >>` +
    ` /Contents ${page1ContentNum} 0 R /Annots [${extLinkNum} 0 R ${intLinkNum} 0 R] >>`
  );

  objects[pagesNum - 1] = `<< /Type /Pages /Kids [${page1Num} 0 R ${page2Num} 0 R] /Count 2 >>`;
  objects[page2Num - 1] =
    `<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 200 200]` +
    ` /Resources << /Font << /F1 ${fontNum} 0 R >> >>` +
    ` /Contents ${page2ContentNum} 0 R >>`;
  objects[catalogNum - 1] = `<< /Type /Catalog /Pages ${pagesNum} 0 R >>`;

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogNum} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

  return Buffer.from(pdf, 'latin1');
}
