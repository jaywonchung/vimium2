export function samplePdf(origin) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [4 0 R 6 0 R 8 0 R] /Count 3 >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (let page = 0; page < 3; page++) {
    const labels = page === 0
      ? [
        "External link one",
        "External link two",
        "Jump to page 2",
        "Plain blue text without a link",
      ]
      : page === 1
      ? ["External link on page 2"]
      : [];
    if (page === 0) {
      labels[6] = "Needle alpha";
      labels[22] = "Needle beta";
    }
    if (page === 1) labels[18] = "Needle gamma";
    const stream = "BT /F1 18 Tf 0 0 1 rg 50 740 Td " +
      Array.from(
        { length: 25 },
        (_, line) =>
          `(${
            labels[line] ?? `Vimium2 integration page ${page + 1} line ${line + 1}`
          }) Tj 0 -25 Td`,
      ).join("\n") + "\nET";
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${
        5 + page * 2
      } 0 R ${
        page === 0 ? "/Annots [10 0 R 11 0 R 12 0 R]" : page === 1 ? "/Annots [13 0 R]" : ""
      } >>`,
    );
    objects.push(
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    );
  }
  for (
    const [y, destination] of [
      [740, `/A << /S /URI /URI (${origin}/linked?one) >>`],
      [715, `/A << /S /URI /URI (${origin}/linked?two) >>`],
      [690, "/Dest [6 0 R /XYZ 0 792 null]"],
      [740, `/A << /S /URI /URI (${origin}/linked?page2) >>`],
    ]
  ) {
    objects.push(
      `<< /Type /Annot /Subtype /Link /Rect [50 ${y - 4} 310 ${
        y + 18
      }] /Border [0 0 0] ${destination} >>`,
    );
  }
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const start = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}
