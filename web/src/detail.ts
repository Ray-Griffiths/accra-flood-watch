/**
 * The sheet that opens when a cell is tapped.
 *
 * Its whole reason for existing is the rule that every risk level explains
 * itself in plain language. A colour on a map is an assertion; this is where
 * the assertion is justified, in words, with the thing it was derived from.
 * A user who cannot interrogate a warning will not trust it, and a warning
 * that is not trusted is a warning that is ignored.
 */

import { levelStyle } from "./levels.ts";

export interface CellDetail {
  cell: string;
  level: string;
  score: number;
  basis: string;
  explanation: string;
  hand: number;
  historicalFloodPoint?: string;
  updatedAt?: string;
  /** Reports standing in this cell right now, newest first. */
  reports: Array<{ depthLabel: string; ageLabel: string }>;
}

export class DetailSheet {
  private readonly root: HTMLElement;
  private readonly body: HTMLElement;
  private readonly closeButton: HTMLButtonElement;

  constructor(root: HTMLElement) {
    this.root = root;
    this.body = root.querySelector<HTMLElement>(".sheet__body")!;
    this.closeButton = root.querySelector<HTMLButtonElement>(".sheet__close")!;

    this.closeButton.addEventListener("click", () => this.close());
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") this.close();
    });
  }

  close(): void {
    this.root.hidden = true;
  }

  show(detail: CellDetail): void {
    const style = levelStyle(detail.level);

    this.body.replaceChildren(
      this.heading(style.label, style.colour, detail.score),
      this.explanation(detail),
      ...(detail.reports.length > 0 ? [this.reports(detail)] : []),
      this.provenance(detail),
    );

    this.root.hidden = false;
    // Focus moves to the close button so a keyboard or screen-reader user is
    // inside the sheet rather than still back on the map.
    this.closeButton.focus();
  }

  private heading(label: string, colour: string, score: number): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "sheet__heading";

    const badge = document.createElement("span");
    badge.className = "level-badge";
    badge.textContent = label;
    badge.style.setProperty("--level-colour", colour);

    const scoreEl = document.createElement("span");
    scoreEl.className = "sheet__score";
    scoreEl.textContent = `Risk score ${Math.round(score)} of 100`;

    wrap.append(badge, scoreEl);
    return wrap;
  }

  private explanation(detail: CellDetail): HTMLElement {
    const p = document.createElement("p");
    p.className = "sheet__explanation";
    // Server-authored sentence. The server owns the wording so the phrasing
    // cannot drift between the map, a push alert and a route explanation.
    p.textContent = capitalise(detail.explanation);
    return p;
  }

  private reports(detail: CellDetail): HTMLElement {
    const section = document.createElement("section");
    section.className = "sheet__reports";

    const heading = document.createElement("h3");
    heading.textContent =
      detail.reports.length === 1
        ? "1 person has reported water here"
        : `${detail.reports.length} people have reported water here`;

    const list = document.createElement("ul");
    for (const report of detail.reports) {
      const item = document.createElement("li");
      item.textContent = `${capitalise(report.depthLabel)} — ${report.ageLabel}`;
      list.append(item);
    }

    section.append(heading, list);
    return section;
  }

  /**
   * Where the number came from. Shown, not hidden behind an info icon: the
   * difference between "terrain says this floods" and "it is flooding now" is
   * the most important thing on this screen.
   */
  private provenance(detail: CellDetail): HTMLElement {
    const dl = document.createElement("dl");
    dl.className = "sheet__provenance";

    const rows: Array<[string, string]> = [
      ["Based on", basisLabel(detail.basis)],
      ["Height above nearest drain", `${detail.hand.toFixed(1)} m`],
    ];

    if (detail.historicalFloodPoint) {
      rows.push(["Recorded flooding", detail.historicalFloodPoint]);
    }
    rows.push(["Grid cell", detail.cell]);

    for (const [term, value] of rows) {
      const dt = document.createElement("dt");
      dt.textContent = term;
      const dd = document.createElement("dd");
      dd.textContent = value;
      dl.append(dt, dd);
    }

    return dl;
  }
}

function basisLabel(basis: string): string {
  switch (basis) {
    case "terrain-and-forecast":
      return "Terrain and rainfall forecast";
    case "reports":
      return "Reports from people on the ground";
    default:
      return "Terrain only — no rainfall forecast yet";
  }
}

function capitalise(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}
