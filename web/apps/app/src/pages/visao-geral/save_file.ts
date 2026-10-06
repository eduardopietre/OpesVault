/** Gives the user a file to keep (the browser's download); nothing is uploaded. */
export function saveTextFile(name: string, text: string, type = "text/html;charset=utf-8"): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  // The download has started when the click returns; the address can go.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
