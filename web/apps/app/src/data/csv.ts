/**
 * The CSV the app writes (Livro, Relatórios), like the domain's `ledgerCsv`: fields separated by ';', a field
 * quoted when it holds ';', '"' or a line break. Free text must already be neutralized with
 * `exporting.spreadsheetText` (docs/19 achado 12); values are written as they are.
 */

/** One field, quoted when it needs to be. */
export function csvField(value: string | number): string {
  const text = String(value);
  return /[;"\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** One line, with its line break. */
export const csvRow = (fields: readonly (string | number)[]): string => fields.map(csvField).join(";") + "\n";
