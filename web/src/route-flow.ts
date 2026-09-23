/**
 * "Get me there without walking through water."
 *
 * The interaction is two taps, for the same reason reporting is: the person
 * doing this is outdoors, under time pressure, deciding whether to set off.
 * Tap the button, tap where you are going. Origin comes from the device while
 * they are choosing; if the device refuses, the map centre stands in and the
 * sheet says so rather than pretending.
 *
 * There is no place search. GeoPlaces is a server-side call and a second
 * endpoint, and a text box is slower than pointing at a map you are already
 * looking at. Pointing is also the only method that works when you do not know
 * what the junction is called, which in Accra is most junctions.
 *
 * Three rules from the project's safety list are enforced in what this renders:
 * a lengthened route says so, a refused route says so plainly and advises not
 * travelling, and there is never a "route anyway" escape hatch from either.
 */

import {
  ApiError,
  calculateRoute,
  type RouteResponse,
  type TravelMode,
} from "./api.ts";
import { isInsideCoverage, type Coverage } from "./pilot.ts";
import { COMMUTE_LABELS, forgetCommute, loadCommute, saveCommute } from "./commute.ts";
import { attachSheetBehaviour, type SheetBehaviour } from "./sheet.ts";

export type RouteState = "idle" | "picking" | "calculating" | "shown";

export interface RouteFlowCallbacks {
  /** Fired when a trip is saved or forgotten, so the shell can update. */
  onCommuteChanged?: () => void;
  /** Where the trip starts if the device will not say. */
  mapCentre: () => [number, number];
  /**
   * Draw or clear the route on the map. Endpoints are the ones asked for, not
   * the ones the route snapped to: the marker belongs where the user pointed.
   */
  onRoute: (
    route: RouteResponse | null,
    origin: [number, number],
    destination: [number, number],
  ) => void;
  /** State changes drive the map's click handling and the prompt bar. */
  onState: (state: RouteState) => void;
}

export class RouteFlow {
  private readonly root: HTMLElement;
  private readonly body: HTMLElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly behaviour: SheetBehaviour;

  private state: RouteState = "idle";
  /** The journey just calculated, so it can be offered for saving. */
  private lastJourney: { origin: [number, number]; destination: [number, number]; mode: TravelMode } | null =
    null;
  private mode: TravelMode = "walking";
  private origin: [number, number] | null = null;
  private originFromDevice = false;

  constructor(
    root: HTMLElement,
    private readonly callbacks: RouteFlowCallbacks,
    private readonly coverage: Coverage,
  ) {
    this.root = root;
    this.body = root.querySelector<HTMLElement>(".sheet__body")!;
    this.closeButton = root.querySelector<HTMLButtonElement>(".sheet__close")!;
    this.closeButton.addEventListener("click", () => this.cancel());
    this.behaviour = attachSheetBehaviour(root, () => this.cancel());
  }

  get currentState(): RouteState {
    return this.state;
  }

  /**
   * Begin. The sheet closes so the map is unobstructed for the destination
   * tap; the prompt bar carries the instruction instead.
   */
  start(): void {
    this.setState("picking");
    this.root.hidden = true;
    this.behaviour.closed();
    this.callbacks.onRoute(null, this.callbacks.mapCentre(), this.callbacks.mapCentre());
    void this.locate();
  }

  cancel(): void {
    this.setState("idle");
    this.root.hidden = true;
    this.behaviour.closed();
    this.callbacks.onRoute(null, this.callbacks.mapCentre(), this.callbacks.mapCentre());
  }

  /** Called when the user taps the map while picking a destination. */
  chooseDestination(destination: [number, number]): void {
    if (this.state !== "picking") return;
    void this.send(destination);
  }

  private setState(state: RouteState): void {
    this.state = state;
    this.callbacks.onState(state);
  }

  /**
   * Resolve the starting point while the user is still choosing where to go.
   *
   * Never blocks the flow: a device that is slow or refuses simply leaves the
   * map centre standing, which the result sheet then labels.
   */
  private async locate(): Promise<void> {
    const centre = this.callbacks.mapCentre();
    this.origin = centre;
    this.originFromDevice = false;

    if (!("geolocation" in navigator)) return;

    try {
      const position = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 10_000,
          maximumAge: 30_000,
        });
      });
      // Only adopt it if the user has not already tapped and sent, and only
      // if it is somewhere this project covers. A fix from outside coverage
      // is a real position that the route service will refuse, so
      // adopting it turns every routing attempt into a 400. The map centre is
      // inside the area by construction, so it stands instead.
      const [longitude, latitude] = [position.coords.longitude, position.coords.latitude];
      if (this.state === "picking" && isInsideCoverage(this.coverage.areas, longitude, latitude)) {
        this.origin = [longitude, latitude];
        this.originFromDevice = true;
      }
    } catch {
      /* The map centre stands. The sheet will say so. */
    }
  }

  private async send(destination: [number, number]): Promise<void> {
    const origin = this.origin ?? this.callbacks.mapCentre();
    this.setState("calculating");
    this.renderPending();
    this.behaviour.opened();
    this.root.hidden = false;

    try {
      const result = await calculateRoute(origin, destination, this.mode);
      this.setState("shown");
      this.lastJourney = { origin, destination, mode: this.mode };
      this.render(result, origin, destination);
      this.callbacks.onRoute(result, origin, destination);
    } catch (error) {
      this.setState("shown");
      this.renderFailure(error, destination);
    }
  }

  private renderPending(): void {
    const p = document.createElement("p");
    p.className = "sheet__pending";
    p.textContent = "Working out a way round the water…";
    this.body.replaceChildren(p);
  }

  private render(
    result: RouteResponse,
    origin: [number, number],
    destination: [number, number],
  ): void {
    const heading = document.createElement("h2");
    heading.className = "sheet__title";

    const explanation = document.createElement("p");
    // Server-authored. The server owns the wording so the phrasing cannot
    // drift between the map, an alert and this sheet.
    explanation.textContent = result.explanation;

    const children: HTMLElement[] = [heading, explanation];

    if (result.found) {
      heading.textContent =
        this.mode === "walking" ? "Walking route" : "Driving route";
      explanation.className = "sheet__explanation";

      children.push(this.summary(result.durationSeconds, result.distanceMetres));

      // The rule is that a lengthened route says so. The server already says
      // it in the sentence above; this repeats it as a figure, because a
      // number is what somebody checks against the time they have.
      if (result.detour && result.detour.extraSeconds >= 60) {
        children.push(
          this.callout(
            "warn",
            `Going around the water adds about ${Math.round(
              result.detour.extraSeconds / 60,
            )} minutes.`,
          ),
        );
      }
    } else {
      heading.textContent =
        result.reason === "flooded" ? "Do not travel this way" : "No route found";
      explanation.className = "sheet__explanation sheet__message--error";

      // Deliberately no "show it anyway" control. The safety rule is that we
      // never silently fall back to a route through water; offering the fall
      // back explicitly is the same failure with a consent form attached.
      if (result.reason === "flooded") {
        children.push(
          this.callout(
            "danger",
            "Six inches of moving water is enough to take you off your feet, and a flooded road can hide an open drain.",
          ),
        );
      }
    }

    children.push(this.footnote(origin, destination));
    children.push(this.actions());

    this.body.replaceChildren(...children);
    this.closeButton.focus();
  }

  private summary(durationSeconds: number, distanceMetres: number): HTMLElement {
    const dl = document.createElement("dl");
    dl.className = "sheet__provenance";

    const minutes = Math.max(1, Math.round(durationSeconds / 60));
    const distance =
      distanceMetres < 1000
        ? `${Math.round(distanceMetres / 10) * 10} m`
        : `${(distanceMetres / 1000).toFixed(1)} km`;

    for (const [term, value] of [
      ["Time", `About ${minutes} ${minutes === 1 ? "minute" : "minutes"}`],
      ["Distance", distance],
    ] as Array<[string, string]>) {
      const dt = document.createElement("dt");
      dt.textContent = term;
      const dd = document.createElement("dd");
      dd.textContent = value;
      dl.append(dt, dd);
    }

    return dl;
  }

  private callout(kind: "warn" | "danger", text: string): HTMLElement {
    const p = document.createElement("p");
    p.className = `callout callout--${kind}`;
    p.textContent = text;
    return p;
  }

  /** Where the trip was measured from, stated rather than assumed. */
  private footnote(origin: [number, number], destination: [number, number]): HTMLElement {
    const p = document.createElement("p");
    p.className = "sheet__privacy";
    p.textContent = this.originFromDevice
      ? `From your location to the point you chose (${destination[1].toFixed(4)}, ${destination[0].toFixed(4)}).`
      : `Could not get your location, so this starts from the centre of the map (${origin[1].toFixed(4)}, ${origin[0].toFixed(4)}).`;
    if (!this.originFromDevice) p.classList.add("sheet__where--fallback");
    return p;
  }

  private actions(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "sheet__actions";

    const again = document.createElement("button");
    again.type = "button";
    again.className = "button button--primary";
    again.textContent = "Pick another destination";
    again.addEventListener("click", () => this.start());

    const other = document.createElement("button");
    other.type = "button";
    other.className = "button button--secondary";
    other.textContent = this.mode === "walking" ? "Show driving instead" : "Show walking instead";
    other.addEventListener("click", () => {
      this.mode = this.mode === "walking" ? "driving" : "walking";
      this.start();
    });

    wrap.append(again, other, this.commuteButton());
    return wrap;
  }

  /**
   * Save this trip, or forget it.
   *
   * Offered only after a route has actually been worked out, so what gets
   * saved is a journey the user has seen and accepted rather than a pair of
   * taps that may have gone somewhere they did not mean.
   */
  private commuteButton(): HTMLElement {
    const saved = loadCommute();
    const button = document.createElement("button");
    button.type = "button";
    button.className = "button button--secondary";

    if (saved) {
      button.textContent = "Forget my saved trip";
      button.addEventListener("click", () => {
        forgetCommute();
        button.replaceWith(this.commuteButton());
      });
      return button;
    }

    button.textContent = "Save this trip";
    button.addEventListener("click", () => {
      if (!this.lastJourney) return;
      saveCommute({ ...this.lastJourney, label: COMMUTE_LABELS[0] });
      button.replaceWith(this.commuteButton());
      this.callbacks.onCommuteChanged?.();
    });
    return button;
  }

  /**
   * Re-run the saved journey without picking anything.
   *
   * The whole point of the feature: the morning question is "can I get to
   * work", and it should cost one tap rather than two map picks.
   */
  checkSavedCommute(): void {
    const saved = loadCommute();
    if (!saved) return;

    this.mode = saved.mode;
    this.origin = saved.origin;
    this.originFromDevice = false;
    void this.send(saved.destination);
  }

  private renderFailure(error: unknown, destination: [number, number]): void {
    const heading = document.createElement("h2");
    heading.className = "sheet__title";
    heading.textContent = "Could not work out a route";

    const message = document.createElement("p");
    message.className = "sheet__message sheet__message--error";
    message.textContent =
      error instanceof ApiError
        ? error.message
        : "Something went wrong working out the route. Please try again.";

    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "button button--primary";
    retry.textContent = "Try again";
    retry.addEventListener("click", () => void this.send(destination));

    this.body.replaceChildren(heading, message, retry);
    retry.focus();
  }
}
