/**
 * Keyboard behaviour shared by the three bottom sheets.
 *
 * Each sheet grew its own close button and its own `focus()` call, and the
 * result was inconsistent in the way that only shows up if you put the mouse
 * down: the detail sheet closed on Escape, while the two sheets marked
 * `aria-modal="true"` — the ones that actually trap the user — did not, and
 * neither held focus inside itself. A dialog a keyboard user can tab out of,
 * and cannot dismiss, is worse than one that was never announced as a dialog.
 *
 * Three behaviours, applied from one place:
 *
 *   - Escape closes, but only the sheet that is actually open. A single
 *     document-level listener per sheet would otherwise fire for all of them.
 *   - Focus is trapped inside a sheet that claims `aria-modal="true"`, and
 *     deliberately NOT trapped in one that does not. The detail sheet is
 *     non-modal on purpose: it explains the cell you tapped while you keep
 *     reading the map behind it.
 *   - Focus returns to whatever opened the sheet. Without this, dismissing a
 *     sheet drops the caret back at the top of the document, and a keyboard
 *     user has to walk the whole page to get back to the button they pressed.
 */

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function focusableWithin(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    // A control inside a collapsed branch is in the DOM but not reachable, and
    // cycling onto it would park focus somewhere invisible.
    (element) => element.offsetParent !== null || element === document.activeElement,
  );
}

export interface SheetBehaviour {
  /** Call when the sheet becomes visible, after its content is in the DOM. */
  opened(): void;
  /** Call when the sheet is hidden. Restores focus to the opener. */
  closed(): void;
}

/**
 * Wire Escape, focus trapping and focus restoration into one sheet.
 *
 * `isOpen` is read rather than tracked here so there is a single source of
 * truth: the sheet's own `hidden` attribute, which is what the rest of the
 * code already sets.
 */
export function attachSheetBehaviour(
  root: HTMLElement,
  close: () => void,
): SheetBehaviour {
  const modal = root.getAttribute("aria-modal") === "true";
  let opener: HTMLElement | null = null;

  const isOpen = (): boolean => !root.hidden;

  document.addEventListener("keydown", (event) => {
    if (!isOpen()) return;

    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }

    if (!modal || event.key !== "Tab") return;

    const focusable = focusableWithin(root);
    if (focusable.length === 0) return;

    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const active = document.activeElement;

    // Wrap at both ends. Without the shift branch, back-tabbing off the first
    // control escapes the dialog into the page behind it.
    if (event.shiftKey && (active === first || !root.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  });

  return {
    opened(): void {
      const active = document.activeElement;
      opener = active instanceof HTMLElement && !root.contains(active) ? active : opener;
    },
    closed(): void {
      // Only pull focus back if it is still inside the sheet being closed.
      // Moving it otherwise would yank the caret away from wherever the user
      // has since navigated to.
      if (opener && root.contains(document.activeElement)) opener.focus();
      opener = null;
    },
  };
}
