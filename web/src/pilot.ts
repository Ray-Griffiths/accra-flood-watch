/**
 * Is a position inside the area this project actually covers?
 *
 * The server checks this too, and rejects anything outside — a report outside
 * the grid would be a point on a map the terrain model knows nothing about.
 * The problem was that the browser knew the boundary all along (it arrives in
 * `/api/config`) and did not consult it: it would take the device's GPS fix,
 * send it, and let the server refuse. Somebody a few streets outside Circle got
 * a failed report and a console error instead of an explanation.
 *
 * So this runs before the request, and the answer changes what the interface
 * says rather than what the server returns.
 */

/** west, south, east, north — the order `/api/config` and `/api/risk` use. */
export type Bbox = readonly [number, number, number, number];

export function isInsidePilotArea(
  bbox: Bbox,
  longitude: number,
  latitude: number,
): boolean {
  const [west, south, east, north] = bbox;
  return (
    Number.isFinite(longitude) &&
    Number.isFinite(latitude) &&
    longitude >= west &&
    longitude <= east &&
    latitude >= south &&
    latitude <= north
  );
}
