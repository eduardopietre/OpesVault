/** Offers a Blob to save (the browser's download). Nothing is uploaded; large sealed files stay a Blob. */
export function saveBlob(name: string, blob: Blob): void {
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
