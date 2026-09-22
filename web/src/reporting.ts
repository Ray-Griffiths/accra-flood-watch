/**
 * One-tap water depth reporting.
 *
 * The person using this is standing in water, in the rain, holding a phone
 * they do not want to drop, and they are not going to fill in a form. So the
 * flow is: one tap to open, one tap to say how deep. Two taps total, and the
 * location resolves in the background while they are choosing.
 *
 * Location comes from the device, and if the device refuses we fall back to
 * the point the map is centred on rather than dead-ending. Refusing to accept
 * a report because a permission prompt was dismissed would lose exactly the
 * reports that matter most.
 *
 * A device fix from outside the pilot area is treated the same way as no fix
 * at all. It is a real position and the phone is not wrong — the area simply
 * is not covered yet, and sending it would earn a 422 and a console error in
 * place of an explanation.
 */

import { ApiError, submitReport, type Depth, type SubmitResult } from "./api.ts";
import { isInsideCoverage, type Coverage } from "./pilot.ts";
import { enqueue, MAX_QUEUE_AGE_MINUTES } from "./queue.ts";
import { attachSheetBehaviour, type SheetBehaviour } from "./sheet.ts";

const DEPTH_CHOICES: Array<{ depth: Depth; label: string; hint: string }> = [
  { depth: "ankle", label: "Ankle deep", hint: "Passable on foot" },
  { depth: "knee", label: "Knee deep", hint: "Hard to walk through" },
  { depth: "waist", label: "Waist deep", hint: "Dangerous — do not wade" },
  { depth: "impassable", label: "Impassable", hint: "Nobody can get through" },
];

export interface ReportOrigin {
  latitude: number;
  longitude: number;
  /**
   * How the position was obtained, so the sheet can say so honestly.
   *
   * `outside-area` is distinct from `map-centre` because the two need
   * different sentences: one means we could not find you, the other means we
   * found you and you are not somewhere this map covers.
   */
  source: "device" | "map-centre" | "outside-area";
  accuracyMetres?: number;
}

export class ReportFlow {
  private readonly root: HTMLElement;
  private readonly body: HTMLElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly behaviour: SheetBehaviour;
  private origin: ReportOrigin | null = null;
  private submitting = false;

  constructor(
    root: HTMLElement,
    private readonly mapCentre: () => [number, number],
    private readonly onAccepted: (result: SubmitResult) => void,
    private readonly coverage: Coverage,
  ) {
    this.root = root;
    this.body = root.querySelector<HTMLElement>(".sheet__body")!;
    this.closeButton = root.querySelector<HTMLButtonElement>(".sheet__close")!;
    this.closeButton.addEventListener("click", () => this.close());
    this.behaviour = attachSheetBehaviour(root, () => this.close());
  }

  close(): void {
    this.root.hidden = true;
    this.behaviour.closed();
  }

  /** Opens the sheet and starts locating. Both happen at once, not in turn. */
  open(): void {
    this.origin = null;
    this.submitting = false;
    this.renderChooser("Finding your location…");
    this.behaviour.opened();
    this.root.hidden = false;
    this.closeButton.focus();
    void this.locate();
  }

  private async locate(): Promise<void> {
    const centre = this.mapCentre();
    const fallback: ReportOrigin = {
      longitude: centre[0],
      latitude: centre[1],
      source: "map-centre",
    };

    if (!("geolocation" in navigator)) {
      this.origin = fallback;
      this.renderChooser(null);
      return;
    }

    try {
      const position = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 10_000,
          maximumAge: 30_000,
        });
      });
      const { latitude, longitude, accuracy } = position.coords;

      // A good fix from outside the covered area is not usable. Falling back
      // to the map centre keeps the report possible — somebody reporting a
      // junction they can see on screen is still a valid report — but the
      // sheet has to say which position it is about to send.
      this.origin = isInsideCoverage(this.coverage.areas, longitude, latitude)
        ? { latitude, longitude, source: "device", accuracyMetres: accuracy }
        : { ...fallback, source: "outside-area" };
    } catch {
      this.origin = fallback;
    }

    // Only re-render if the sheet is still open; the user may have closed it
    // while the device was still thinking.
    if (!this.root.hidden) this.renderChooser(null);
  }

  private renderChooser(locating: string | null): void {
    const heading = document.createElement("h2");
    heading.className = "sheet__title";
    heading.textContent = "How deep is the water?";

    const where = document.createElement("p");
    where.className = "sheet__where";
    if (locating) {
      where.textContent = locating;
    } else if (this.origin?.source === "device") {
      const accuracy = this.origin.accuracyMetres;
      where.textContent = accuracy
        ? `Using your location, accurate to about ${Math.round(accuracy)} m.`
        : "Using your location.";
    } else if (this.origin?.source === "outside-area") {
      where.textContent =
        `You are outside the area this map covers (${this.coverage.description}). ` +
        "This will be reported at the centre of the map — move the map to the place you mean first.";
      where.classList.add("sheet__where--fallback");
    } else {
      where.textContent =
        "Could not get your location, so this will be reported at the centre of the map. Move the map first if that is wrong.";
      where.classList.add("sheet__where--fallback");
    }

    const choices = document.createElement("div");
    choices.className = "depth-choices";
    for (const choice of DEPTH_CHOICES) {
      choices.append(this.depthButton(choice));
    }

    const privacy = document.createElement("p");
    privacy.className = "sheet__privacy";
    privacy.textContent =
      "No name, no account, no device id. Your report disappears automatically after 24 hours.";

    this.body.replaceChildren(heading, where, choices, privacy);
  }

  private depthButton(choice: (typeof DEPTH_CHOICES)[number]): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `depth-choice depth-choice--${choice.depth}`;

    const label = document.createElement("span");
    label.className = "depth-choice__label";
    label.textContent = choice.label;

    const hint = document.createElement("span");
    hint.className = "depth-choice__hint";
    hint.textContent = choice.hint;

    button.append(label, hint);
    button.addEventListener("click", () => void this.send(choice.depth));
    return button;
  }

  private async send(depth: Depth): Promise<void> {
    // The location request may still be in flight on a slow fix.
    if (!this.origin) {
      const centre = this.mapCentre();
      this.origin = { longitude: centre[0], latitude: centre[1], source: "map-centre" };
    }
    if (this.submitting) return;
    this.submitting = true;

    this.renderPending();

    // Stamped before the request goes out, so a report that ends up queued
    // records when the water was seen rather than when it eventually sent.
    const observedAt = new Date().toISOString();

    try {
      const result = await submitReport(
        this.origin.latitude,
        this.origin.longitude,
        depth,
        observedAt,
      );
      this.renderAccepted(result);
      this.onAccepted(result);
    } catch (error) {
      // Only an unreachable service is worth holding for. Anything the server
      // answered -- outside coverage, a malformed depth -- it will answer the
      // same way in ten minutes, and queuing it would promise the user
      // something that is never going to happen.
      if (error instanceof ApiError && error.status === 0) {
        const held = enqueue({
          latitude: this.origin.latitude,
          longitude: this.origin.longitude,
          depth,
          observedAt,
        });
        if (held) {
          this.renderQueued();
          return;
        }
      }
      this.renderFailure(error);
    } finally {
      this.submitting = false;
    }
  }

  /**
   * The report is kept, and the user is told exactly that.
   *
   * Deliberately not dressed up as success: nothing is on the map yet, and
   * somebody who believes their warning is live when it is sitting in
   * localStorage has been misled about the one thing they came here to do.
   */
  private renderQueued(): void {
    const heading = document.createElement("h2");
    heading.className = "sheet__title";
    heading.textContent = "Saved — not sent yet";

    const message = document.createElement("p");
    message.className = "sheet__message";
    message.textContent =
      "You are offline, so your report is saved on this phone and will send by itself " +
      `when the connection comes back. If that takes more than ${MAX_QUEUE_AGE_MINUTES} ` +
      "minutes it will be discarded, because by then it no longer describes the water.";

    const done = document.createElement("button");
    done.type = "button";
    done.className = "button button--primary";
    done.textContent = "Done";
    done.addEventListener("click", () => this.close());

    this.body.replaceChildren(heading, message, done);
    done.focus();
  }

  private renderPending(): void {
    const p = document.createElement("p");
    p.className = "sheet__pending";
    p.textContent = "Sending your report…";
    this.body.replaceChildren(p);
  }

  private renderAccepted(result: SubmitResult): void {
    const heading = document.createElement("h2");
    heading.className = "sheet__title";
    heading.textContent = "Thank you";

    const message = document.createElement("p");
    message.className = "sheet__message";
    message.textContent = result.message;

    const done = document.createElement("button");
    done.type = "button";
    done.className = "button button--primary";
    done.textContent = "Done";
    done.addEventListener("click", () => this.close());

    this.body.replaceChildren(heading, message, done);
    done.focus();
  }

  private renderFailure(error: unknown): void {
    const heading = document.createElement("h2");
    heading.className = "sheet__title";
    heading.textContent = "Report not sent";

    const message = document.createElement("p");
    message.className = "sheet__message sheet__message--error";
    message.textContent =
      error instanceof ApiError
        ? error.message
        : "Something went wrong sending your report. Please try again.";

    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "button button--primary";
    retry.textContent = "Try again";
    retry.addEventListener("click", () => this.renderChooser(null));

    this.body.replaceChildren(heading, message, retry);
    retry.focus();
  }
}
