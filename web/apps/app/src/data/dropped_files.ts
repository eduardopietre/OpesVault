/**
 * Files dropped anywhere in the app wait here until Importar e revisar takes them (desktop
 * `ImportPage.import_paths`, called by the main window for a drop on any page). The shell fills the store and
 * goes to the page; the page consumes the files once, when it is mounted or as soon as more arrive.
 */
const waiting: File[] = [];
const listeners = new Set<() => void>();

/** Puts dropped files in line to be imported. */
export function addDroppedFiles(files: Iterable<File>): number {
  const before = waiting.length;
  waiting.push(...files);
  const added = waiting.length - before;
  if (added) for (const listener of [...listeners]) listener();
  return added;
}

/** Hands over every file that is waiting; they will not be given again. */
export function takeDroppedFiles(): File[] {
  return waiting.splice(0, waiting.length);
}

export function hasDroppedFiles(): boolean {
  return waiting.length > 0;
}

/** Calls `listener` whenever files arrive; returns the way to stop. */
export function subscribeDroppedFiles(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
