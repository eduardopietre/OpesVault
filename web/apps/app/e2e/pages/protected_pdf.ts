/**
 * A password-protected PDF made on the spot, so that no PDF file has to be kept in the repository. It uses the
 * standard security handler (RC4, 40 bit, revision 2) and its user password is "segredo". Synthetic content only.
 */
import { createHash } from "node:crypto";

const PAD = Buffer.from("28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A", "hex");

function rc4(key: Buffer, data: Buffer): Buffer {
  const s = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i]! + key[i % key.length]!) % 256;
    [s[i], s[j]] = [s[j]!, s[i]!];
  }
  const out = Buffer.alloc(data.length);
  let a = 0;
  let b = 0;
  for (let n = 0; n < data.length; n++) {
    a = (a + 1) % 256;
    b = (b + s[a]!) % 256;
    [s[a], s[b]] = [s[b]!, s[a]!];
    out[n] = data[n]! ^ s[(s[a]! + s[b]!) % 256]!;
  }
  return out;
}

export const PROTECTED_PDF_PASSWORD = "segredo";

export function protectedPdf(): Buffer {
  const md5 = (...parts: Buffer[]) => createHash("md5").update(Buffer.concat(parts)).digest();
  const padded = (password: string) => Buffer.concat([Buffer.from(password), PAD]).subarray(0, 32);
  const docId = md5(Buffer.from("opesvault-protected-sample"));
  const o = rc4(md5(padded(PROTECTED_PDF_PASSWORD)).subarray(0, 5), padded(PROTECTED_PDF_PASSWORD));
  const permissions = Buffer.alloc(4);
  permissions.writeInt32LE(-4);
  const key = md5(padded(PROTECTED_PDF_PASSWORD), o, permissions, docId).subarray(0, 5);
  const u = rc4(key, PAD);
  const objectNumber = Buffer.alloc(3);
  objectNumber.writeUIntLE(4, 0, 3);
  const contentKey = md5(key, objectNumber, Buffer.alloc(2)).subarray(0, 10);
  const content = rc4(
    contentKey,
    Buffer.from(
      "BT /F1 24 Tf 60 760 Td (Documento protegido de exemplo) Tj 0 -40 Td /F1 14 Tf (Conteudo sintetico) Tj ET",
    ),
  );
  const hex = (data: Buffer) => `<${data.toString("hex")}>`;
  const bodies: (string | Buffer)[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [5 0 R] /Count 1 >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from("\nendstream")]),
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 3 0 R >> >> >>",
    `<< /Filter /Standard /V 1 /R 2 /O ${hex(o)} /U ${hex(u)} /P -4 >>`,
  ];
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n")];
  let length = parts[0]!.length;
  const offsets: number[] = [];
  bodies.forEach((body, index) => {
    offsets.push(length);
    const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), Buffer.from(body), Buffer.from("\nendobj\n")]);
    parts.push(chunk);
    length += chunk.length;
  });
  let tail = `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) tail += `${String(offset).padStart(10, "0")} 00000 n \n`;
  tail += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R /Encrypt 6 0 R /ID [${hex(docId)}${hex(docId)}] >>\n`;
  tail += `startxref\n${length}\n%%EOF\n`;
  parts.push(Buffer.from(tail));
  return Buffer.concat(parts);
}
