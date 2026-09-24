/*
 * Layout and DOM-contract verification for Accra Flood Watch.
 *
 * Paste into the devtools console on a 390x844 viewport. Everything here was
 * a real bug at some point during the redesign, and three of them were
 * invisible in a screenshot.
 */
(() => {
  const SELECTORS = [
    "#status", "#tagline", "#map", "#legend", "#search", ".search__input",
    ".search__clear", ".search__results", ".language", "#language-select",
    ".view-bar", "#view-reason", ".view-toggle__option[data-view]",
    ".navbar", ".navbar__name", "#nav-menu", "#navbar-controls", "#draft-notice",
    "#route-button", "#route-prompt", ".route-prompt__text", "#route-cancel",
    "#report-button", "#report-button .report-button__label",
    "#detail-sheet", "#route-sheet", "#report-sheet",
    "#detail-sheet .sheet__body", "#detail-sheet .sheet__close",
    ".disclaimer strong", "#theme-toggle",
  ];
  const missing = SELECTORS.filter((s) => !document.querySelector(s));

  const OVERLAYS = [".navbar", ".ov-read", ".rail", ".ov-seg", ".ov-dock", ".ov-legal"];
  const boxes = OVERLAYS
    .map((s) => [s, document.querySelector(s)])
    .filter(([, el]) => el && getComputedStyle(el).display !== "none")
    .map(([s, el]) => [s, el.getBoundingClientRect()]);

  const overlaps = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const [an, a] = boxes[i], [bn, b] = boxes[j];
      if (!(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top)) {
        overlaps.push(`${an} x ${bn}`);
      }
    }
  }

  const legal = document.querySelector(".ov-legal")?.getBoundingClientRect();
  const report = {
    missingSelectors: missing,
    overlaps,
    pageScrolls: document.body.scrollHeight > window.innerHeight + 1,
    scrollHeight: document.body.scrollHeight,
    viewportHeight: window.innerHeight,
    disclaimerFullyVisible: legal ? legal.bottom <= window.innerHeight + 1 : false,
  };
  console.table(report);
  const ok = !missing.length && !overlaps.length && !report.pageScrolls && report.disclaimerFullyVisible;
  console.log(ok ? "PASS" : "FAIL", report);
  return report;
})();
