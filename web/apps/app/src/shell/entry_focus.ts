/**
 * Focus when the window of a project appears. After the project list (a dialog just closed, its buttons gone) the
 * keyboard user must land in the page's content; but when the page is loaded straight into the window, focus stays
 * at the top of the document so that the first Tab reaches "Pular para o conteúdo".
 */
let fromScreens = false;

/** The project list (or another screen before the window) was shown: the next window takes focus. */
export function markScreenShown(): void {
  fromScreens = true;
}

/** True once after a screen preceded the window. */
export function takeEntryFocus(): boolean {
  const value = fromScreens;
  fromScreens = false;
  return value;
}
