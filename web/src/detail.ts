/**
 * The sheet that opens when a cell is tapped.
 *
 * Its whole reason for existing is the rule that every risk level explains
 * itself in plain language. A colour on a map is an assertion; this is where
 * the assertion is justified, in words, with the thing it was derived from.
 * A user who cannot interrogate a warning will not trust it, and a warning
 * that is not trusted is a warning that is ignored.
 */

import { levelStyle, terrainStyle, type MapView } from "./levels.ts";
import { attachSheetBehaviour, type SheetBehaviour } from "./sheet.ts";

export interface CellDetail {
  cell: string;
  level: string;
  score: number;
  basis: string;
  explanation: string;
  hand: number;
  susceptibility: number;
  historicalFloodPoint?: string;
  updatedAt?: string;
  /** How this ground behaves in rain, independent of today's weather. */
  terrainBand?: string;
  terrainExplanation?: string;
  /**
   * Which question the map is currently answering. The sheet has to answer
   * the same one: opening a terrain cell and being shown today's risk score
   * is how a user concludes the map is lying to them.
   */
  view: MapView;
  /** Middle of the cell, for anything that needs a coordinate. */
  centre: [number, number];
  /** Reports standing in this cell right now, newest first. */
  reports: Array<{ depthLabel: string; ageLabel: string }>;
  /** How often flooding has been reported here. Absent when never. */
  history?: string;
}

/**
 * Renders the "alert me about this place" control, or nothing when push is
 * unavailable. Injected rather than built in, so this file stays about
 * presenting a cell and the permission dance lives with the rest of the
 * push code.
 */
export type WatchSectionRenderer = (detail: CellDetail) => HTMLElement | null;

export class DetailSheet {
  private readonly root: HTMLElement;
  private readonly body: HTMLElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly behaviour: SheetBehaviour;

  constructor(
    root: HTMLElement,
    private readonly renderWatch?: WatchSectionRenderer,
    /**
     * Share this place. Injected for the same reason the watch control is:
     * the Web Share API and its clipboard fallback are a platform dance that
     * does not belong in a file about presenting a cell.
     */
    private readonly onShare?: (detail: CellDetail) => void,
  ) {
    this.root = root;
    this.body = root.querySelector<HTMLElement>(".sheet__body")!;
    this.closeButton = root.querySelector<HTMLButtonElement>(".sheet__close")!;

    this.closeButton.addEventListener("click", () => this.close());
    // Escape now fires only while THIS sheet is open. The previous listener
    // ran on every keypress regardless, so Escape in the report sheet also
    // closed a detail sheet nobody could see.
    this.behaviour = attachSheetBehaviour(root, () => this.close());
  }

  close(): void {
    this.root.hidden = true;
    this.behaviour.closed();
  }

  show(detail: CellDetail): void {
    const terrain = detail.view === "terrain";
    const style = terrain ? terrainStyle(detail.terrainBand ?? "") : levelStyle(detail.level);

    this.body.replaceChildren(
      terrain
        ? this.heading(style.label, `var(${style.cssVariable})`, detail.susceptibility, "Terrain score")
        : this.heading(style.label, `var(${style.cssVariable})`, detail.score, "Risk score"),
      this.explanation(detail),
      // Reports are observations of the world, not model output, so they are
      // shown in both views. Somebody standing in water is worth knowing about
      // whichever question was being asked.
      ...(detail.reports.length > 0 ? [this.reports(detail)] : []),
      ...compact([this.history(detail)]),
      this.provenance(detail),
      ...compact([this.shareButton(detail), this.renderWatch?.(detail) ?? null]),
    );

    this.behaviour.opened();
    this.root.hidden = false;
    // Focus moves to the close button so a keyboard or screen-reader user is
    // inside the sheet rather than still back on the map.
    this.closeButton.focus();
  }


  /**
   * "Send this to someone."
   *
   * The single most useful thing a person can do with a flood warning is pass
   * it on, and until this existed the app had no way to be passed on -- there
   * was no URL that meant anything. Nothing renders if no handler was given,
   * so the sheet degrades to what it was.
   */
  private shareButton(detail: CellDetail): HTMLElement | null {
    if (!this.onShare) return null;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "button button--secondary sheet__share";
    button.textContent = "Share this place";
    button.addEventListener("click", () => this.onShare?.(detail));
    return button;
  }


  /**
   * How often this place has flooded before.
   *
   * The one thing this project knows that nobody publishes. It sits below the
   * live reading rather than beside it, because it answers a different
   * question: not "is it flooded now" but "is this a place that floods".
   */
  private history(detail: CellDetail): HTMLElement | null {
    if (!detail.history) return null;

    const p = document.createElement("p");
    p.className = "sheet__history";
    p.textContent = detail.history;
    return p;
  }

  private heading(label: string, colour: string, score: number, term: string): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "sheet__heading";

    const badge = document.createElement("span");
    badge.className = "level-badge";
    badge.textContent = label;
    badge.style.setProperty("--level-colour", colour);

    const scoreEl = document.createElement("span");
    scoreEl.className = "sheet__score";
    scoreEl.textContent = `${term} ${Math.round(score)} of 100`;

    wrap.append(badge, scoreEl);
    return wrap;
  }

  private explanation(detail: CellDetail): HTMLElement {
    const p = document.createElement("p");
    p.className = "sheet__explanation";
    // Server-authored sentence. The server owns the wording so the phrasing
    // cannot drift between the map, a push alert and a route explanation.
    const text =
      detail.view === "terrain" && detail.terrainExplanation
        ? detail.terrainExplanation
        : detail.explanation;
    p.textContent = capitalise(text);
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

    const rows: Array<[string, string]> =
      detail.view === "terrain"
        ? [
            // No "based on" row: the terrain view has exactly one source and
            // saying so every time adds words without adding information.
            ["Height above nearest drain", `${detail.hand.toFixed(1)} m`],
          ]
        : [
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

function compact(nodes: Array<HTMLElement | null>): HTMLElement[] {
  return nodes.filter((node): node is HTMLElement => node !== null);
}

function capitalise(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}
