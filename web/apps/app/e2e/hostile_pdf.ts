/**
 * A hostile synthetic PDF, made on the spot (nothing is kept in the repository). It carries what a malicious file
 * may carry: a JavaScript action on open and on a page, a launch action, an embedded file, a link to a script URL,
 * text that looks like markup and formulas, a very long page tree and a Kids loop. The app must read it (or refuse
 * it) without executing anything and without hanging.
 */
import { PDFArray, PDFDocument, PDFName, PDFString, StandardFonts } from "pdf-lib";

export const HOSTILE_TEXT = [
  `<img src=x onerror="window.__pwned=10">`,
  `=HYPERLINK("https://evil.test/x","clique")`,
  `javascript:window.__pwned=11`,
  `+cmd|' /C calc'!A0`,
].join(" ");

export async function hostilePdf(pages = 1500): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const context = doc.context;

  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([300, 200]);
    page.drawText(i === 0 ? HOSTILE_TEXT.slice(0, 60) : `Pagina ${i}`, { x: 10, y: 150, size: 8, font });
    if (i === 0) {
      // JavaScript and launch actions on the page itself, and a link annotation to a script URL.
      page.node.set(
        PDFName.of("AA"),
        context.obj({
          O: { Type: "Action", S: "JavaScript", JS: PDFString.of("window.__pwned=12; app.alert('pwned')") },
        }),
      );
      page.node.set(
        PDFName.of("Annots"),
        context.obj([
          context.obj({
            Type: "Annot",
            Subtype: "Link",
            Rect: [0, 0, 300, 200],
            A: { Type: "Action", S: "URI", URI: PDFString.of("javascript:window.__pwned=13") },
          }),
          context.obj({
            Type: "Annot",
            Subtype: "Link",
            Rect: [0, 0, 300, 200],
            A: { Type: "Action", S: "Launch", F: PDFString.of("calc.exe") },
          }),
        ]),
      );
    }
  }

  // On open: JavaScript, plus names with a JavaScript tree and an embedded file.
  doc.catalog.set(
    PDFName.of("OpenAction"),
    context.obj({ Type: "Action", S: "JavaScript", JS: PDFString.of("window.__pwned=14; this.exportDataObject({})") }),
  );
  doc.catalog.set(
    PDFName.of("AA"),
    context.obj({ WC: { Type: "Action", S: "JavaScript", JS: PDFString.of("window.__pwned=15") } }),
  );
  await doc.attach(Buffer.from("MZ not a program"), "evil.exe", {
    mimeType: "application/x-msdownload",
    description: HOSTILE_TEXT,
  });

  // A loop in the page tree: the root lists itself among its kids.
  const pagesRef = doc.catalog.get(PDFName.of("Pages"));
  const root = doc.catalog.lookup(PDFName.of("Pages"));
  const kids = (root as unknown as { get(name: PDFName): unknown }).get(PDFName.of("Kids"));
  if (pagesRef && kids instanceof PDFArray) kids.push(pagesRef);

  doc.setTitle(HOSTILE_TEXT);
  doc.setAuthor(`<script>window.__pwned=16</script>`);
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}
