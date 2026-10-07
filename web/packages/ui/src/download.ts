/**
 * Offers a file to save (the browser's download). Nothing is uploaded: the bytes go from this tab to the
 * device. A Blob is offered as it is, so a large sealed file is never copied into memory again.
 */
export function saveFile(name: string, content: Blob | Uint8Array | string, type = "application/octet-stream"): void {
  const blob = content instanceof Blob ? content : new Blob([content as BlobPart], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.rel = "noopener";
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  // The browser has taken the file by the time the task queue turns; a large one gets longer to be sure.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export const CSV_TYPE = "text/csv;charset=utf-8";
export const HTML_TYPE = "text/html;charset=utf-8";
