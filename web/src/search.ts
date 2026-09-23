/**
 * Search for a place by name and find out whether it is flooded.
 *
 * The flow people actually want: type "Kaneshie Market", get an answer. Panning
 * a map to a junction you can already name is work, and it is work done
 * one-handed, outdoors, under time pressure.
 *
 * Two constraints shaped this more than anything else.
 *
 * **It floats over the map rather than taking a band of its own.** The layout
 * fits a 390x844 phone with about 17px to spare in the worst case, and the
 * project has already been pushed into scrolling once by a band that grew.
 * A search bar in the document flow would have done it again, so this sits on
 * top of the map where it costs no vertical budget at all.
 *
 * **A match is a candidate, not a verdict.** Geocoding Accra is uneven --
 * "Ring Road Central" returns a bank branch, and "Kwame Nkrumah Circle"
 * returns two positions two kilometres apart. So the result list shows the
 * name the service matched and the level beside it, and choosing one moves
 * the map and drops a pin so the user can see WHERE the answer is about before
 * believing it. The app never announces "Odorkor is not flooded" off a pin the
 * user has not seen.
 */

import { ApiError, searchPlaces, type PlaceResult } from "./api.ts";
import { levelStyle } from "./levels.ts";

/** Wait after the last keystroke before searching. Every call is billed. */
const DEBOUNCE_MS = 450;

/** Below this a query matches half of Accra and costs a request to find out. */
const MIN_QUERY_CHARS = 3;

export interface SearchCallbacks {
  /** Move the map to a chosen place and mark it. */
  onChoose(result: PlaceResult): void;
  /** Clear any pin the search dropped. */
  onClear(): void;
}

/**
 * What to say about a matched place, before any of it reaches the DOM.
 *
 * Pure and exported because this is where the feature can do harm. A place the
 * grid has never scored must read as "not covered", never as a level and never
 * as anything a glancing user could take for an all-clear -- and that is a
 * claim worth asserting against fixed inputs rather than trusting to the
 * branch below being written correctly once.
 */
export type ResultTone = "level" | "uncovered";

export interface ResultBadge {
  text: string;
  tone: ResultTone;
  /** Only set when the badge is reporting an actual risk level. */
  colour?: string;
  level?: string;
}

export function describeResult(result: PlaceResult): ResultBadge {
  if (!result.covered) {
    return { text: "Outside the area this covers", tone: "uncovered" };
  }
  if (!result.level) {
    return { text: "No reading for this spot", tone: "uncovered" };
  }

  const style = levelStyle(result.level);
  return { text: style.label, tone: "level", colour: style.colour, level: result.level };
}

export class PlaceSearch {
  private readonly root: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly results: HTMLElement;
  private readonly clearButton: HTMLButtonElement;

  private readonly callbacks: SearchCallbacks;

  private timer: number | undefined;
  /** Rising counter so a slow earlier response cannot overwrite a newer one. */
  private generation = 0;

  // Assigned in the body rather than written as a constructor parameter
  // property: that form is TypeScript that must be compiled rather than
  // stripped, so it puts the whole module out of reach of
  // `node --test --experimental-strip-types`.
  constructor(root: HTMLElement, callbacks: SearchCallbacks) {
    this.callbacks = callbacks;
    this.root = root;
    this.input = root.querySelector<HTMLInputElement>(".search__input")!;
    this.results = root.querySelector<HTMLElement>(".search__results")!;
    this.clearButton = root.querySelector<HTMLButtonElement>(".search__clear")!;

    // Searching on submit as well as on a settled pause: somebody who has
    // finished typing and pressed the key should not wait out the debounce.
    this.input.addEventListener("input", () => this.schedule());
    this.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        window.clearTimeout(this.timer);
        void this.run();
      }
      if (event.key === "Escape") this.reset();
    });

    this.clearButton.addEventListener("click", () => {
      this.reset();
      this.input.focus();
    });

    this.paintClearButton();
  }

  private schedule(): void {
    this.paintClearButton();
    window.clearTimeout(this.timer);

    if (this.input.value.trim().length < MIN_QUERY_CHARS) {
      this.results.replaceChildren();
      this.results.hidden = true;
      return;
    }

    this.timer = window.setTimeout(() => void this.run(), DEBOUNCE_MS);
  }

  private paintClearButton(): void {
    this.clearButton.hidden = this.input.value.length === 0;
  }

  private async run(): Promise<void> {
    const query = this.input.value.trim();
    if (query.length < MIN_QUERY_CHARS) return;

    const generation = ++this.generation;
    this.renderMessage("Searching…");

    try {
      const response = await searchPlaces(query);
      // A response from a query the user has already moved on from must not
      // replace what is on screen now.
      if (generation !== this.generation) return;

      if (response.failed) {
        this.renderMessage(response.message ?? "Search is not responding just now.");
        return;
      }
      if (response.results.length === 0) {
        this.renderMessage(response.message ?? `Nothing found for "${query}".`);
        return;
      }

      this.renderResults(response.results);
    } catch (error) {
      if (generation !== this.generation) return;
      this.renderMessage(
        error instanceof ApiError ? error.message : "Could not search just now.",
      );
    }
  }

  private renderMessage(text: string): void {
    const p = document.createElement("p");
    p.className = "search__message";
    p.textContent = text;
    this.results.replaceChildren(p);
    this.results.hidden = false;
  }

  private renderResults(results: readonly PlaceResult[]): void {
    const list = document.createElement("ul");
    list.className = "search__list";

    for (const result of results) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "search__result";

      const title = document.createElement("span");
      title.className = "search__result-title";
      title.textContent = result.title;

      const state = document.createElement("span");
      state.className = "search__result-state";

      const badge = describeResult(result);
      state.textContent = badge.text;
      state.classList.add(`search__result-state--${badge.tone}`);
      if (badge.colour) state.style.setProperty("--level-colour", badge.colour);
      if (badge.level) state.dataset["level"] = badge.level;

      button.append(title, state);
      button.addEventListener("click", () => {
        this.results.hidden = true;
        this.input.blur();
        this.callbacks.onChoose(result);
      });

      item.append(button);
      list.append(item);
    }

    // The honest caption. It is here because the failure mode of this feature
    // is a confident answer about the wrong junction, and the user is the only
    // one who can catch that.
    const caveat = document.createElement("p");
    caveat.className = "search__caveat";
    caveat.textContent = "Tap one to see it on the map and check it is the right place.";

    this.results.replaceChildren(list, caveat);
    this.results.hidden = false;
  }

  /** Empty the box, drop the results, and remove the pin. */
  reset(): void {
    window.clearTimeout(this.timer);
    this.generation += 1;
    this.input.value = "";
    this.results.replaceChildren();
    this.results.hidden = true;
    this.paintClearButton();
    this.callbacks.onClear();
  }

  /** Close the result list without discarding what was typed or the pin. */
  collapse(): void {
    this.results.hidden = true;
  }
}
