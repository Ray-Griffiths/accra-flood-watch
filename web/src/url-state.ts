/**
 * What the address bar can ask the app to do.
 *
 * Two things arrive this way and they are deliberately the same mechanism:
 *
 *   ?at=lon,lat      Someone shared a place. Accra talks about flooding on
 *                    WhatsApp, and until now this app could not join that
 *                    conversation -- there was no way to send anybody "this
 *                    junction is under water".
 *   ?action=report   A PWA shortcut, from long-pressing the installed icon.
 *   ?action=route
 *
 * Every intent here reaches a state the ordinary interface can also reach. A
 * link cannot put the app somewhere a user could not have navigated to, which
 * is what keeps this from becoming a second, unaudited way in.
 *
 * Parsing is total: anything malformed yields `{}` rather than throwing. A
 * shared link that has been mangled by a messaging app should open the map,
 * not an error.
 */

export type LinkAction = "report" | "route";

export interface LinkIntent {
  /** A shared place, as [longitude, latitude]. */
  at?: [number, number];
  /** A flow to open on arrival, from an installed-app shortcut. */
  action?: LinkAction;
}

function parseAt(raw: string | null): [number, number] | undefined {
  if (!raw) return undefined;

  const parts = raw.split(",").map((value) => Number.parseFloat(value.trim()));
  if (parts.length !== 2) return undefined;

  const [lon, lat] = parts as [number, number];
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return undefined;
  if (Math.abs(lon) > 180 || Math.abs(lat) > 90) return undefined;

  return [lon, lat];
}

export function readIntent(search: string): LinkIntent {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return {};
  }

  const intent: LinkIntent = {};

  const at = parseAt(params.get("at"));
  if (at) intent.at = at;

  const action = params.get("action");
  if (action === "report" || action === "route") intent.action = action;

  return intent;
}

/**
 * Coordinate precision in a shared link.
 *
 * Six decimals is about 11cm, which is far more than a 152m grid cell needs
 * and more than a phone's own fix justifies. Five is ~1.1m: still well inside
 * one cell, and it keeps the link short enough to survive being pasted into a
 * chat without wrapping.
 */
const SHARE_PRECISION = 5;

/** A link that reopens this exact place, for pasting into a message. */
export function shareUrlFor(
  centre: readonly [number, number],
  origin: string,
): string {
  const url = new URL(origin);
  // Replace rather than append: sharing from a page that was itself opened
  // from a link must not accumulate one ?at= after another.
  url.search = "";
  url.searchParams.set(
    "at",
    `${centre[0].toFixed(SHARE_PRECISION)},${centre[1].toFixed(SHARE_PRECISION)}`,
  );
  return url.toString();
}

/**
 * Drop the intent from the address bar once it has been acted on.
 *
 * Without this, a shared link stays in the URL and a reload re-opens the
 * sheet over wherever the user has since panned to -- and the PWA shortcut
 * would re-open the report flow every single time the app is resumed.
 */
export function clearIntent(): void {
  if (typeof history === "undefined" || !history.replaceState) return;
  history.replaceState(null, "", window.location.pathname);
}
