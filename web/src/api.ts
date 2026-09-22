/**
 * Typed client for the Accra Flood Watch API.
 *
 * Every call is same-origin: CloudFront forwards /api/* to API Gateway, so
 * there is no CORS preflight on the critical path and no second DNS lookup on
 * a phone with a poor connection.
 */

export interface PilotArea {
  name: string;
  /** west, south, east, north */
  bbox: [number, number, number, number];
  /** lon, lat */
  centre: [number, number];
}

export interface CoverageAreaResponse {
  id: string;
  name: string;
  /** west, south, east, north */
  bbox: [number, number, number, number];
}

/**
 * The ground the terrain grid covers, as a list of named areas.
 *
 * `envelope` frames the map and is never a boundary test: with disjoint areas
 * it spans the gaps between them.
 */
export interface CoverageResponse {
  description: string;
  areas: CoverageAreaResponse[];
  envelope: [number, number, number, number];
  centre: [number, number];
}

export interface ClientConfig {
  /**
   * Optional only because a browser holding this bundle may briefly talk to a
   * deployment that predates it. `pilotArea` is the fallback for that window.
   */
  coverage?: CoverageResponse;
  pilotArea: PilotArea;
  cellPrecision: number;
  map: {
    styleUrl: string;
    key: string;
    style: string;
  };
  /**
   * Public VAPID key, or null when push is not provisioned on this stack.
   * Null means the watch control is not offered at all, rather than offered
   * and failing after the user has granted a permission.
   */
  pushPublicKey: string | null;
}

export interface RiskCell {
  cell: string;
  bounds: { west: number; south: number; east: number; north: number };
  score: number;
  level: string;
  basis: string;
  explanation: string;
  susceptibility: number;
  hand: number;
  historicalFloodPoint?: string;
  updatedAt?: string;
  /** How this ground behaves in rain. A permanent property, not a warning. */
  terrainBand?: string;
  terrainExplanation?: string;
}

/**
 * Is rain coming at all?
 *
 * Separate from the score, which cannot express it: a 3mm day and a 0mm day
 * both land at `low`, but only one of them is a day on which the warning map
 * has anything to say.
 */
export type RainOutlook = "none" | "light" | "significant";

export interface RiskResponse {
  cells: RiskCell[];
  cellCount?: number;
  basis?: string;
  forecastAvailable?: boolean;
  /** Null when the forecast feed was down. Never read null as "no rain". */
  rainOutlook?: RainOutlook | null;
  rainfall?: { next6hMm: number; next24hMm: number } | null;
  generatedAt?: string;
  outsideCoverage?: boolean;
  /** Previous name for `outsideCoverage`, still sent during deploy skew. */
  outsidePilotArea?: boolean;
  /**
   * The viewport needed more partitions than one request returns, so these
   * cells are part of it rather than all of it. Never draw a truncated
   * response without saying so: a blank corner and low risk look identical.
   */
  truncated?: boolean;
  message?: string;
}

export interface FloodReport {
  cell: string;
  depth: string;
  depthLabel: string;
  latitude: number;
  longitude: number;
  ageMinutes: number;
  ageLabel: string;
  submittedAt: string;
}

export interface ReportsResponse {
  reports: FloodReport[];
  reportCount: number;
  truncated?: boolean;
  outsideCoverage?: boolean;
  generatedAt: string;
}

export type Depth = "ankle" | "knee" | "waist" | "impassable";

export interface SubmitResult {
  accepted: boolean;
  cell: string;
  depth: Depth;
  depthLabel: string;
  submittedAt: string;
  expiresAt: string;
  level: "reported" | "confirmed";
  recentReports: number;
  message: string;
}

/**
 * An API failure the interface can explain to a person.
 *
 * `status` is kept because the difference between "you are outside the pilot
 * area" (422) and "the service is down" (5xx) is the difference between two
 * completely different things to tell the user.
 */
export class ApiError extends Error {
  // Declared and assigned rather than written as a constructor parameter
  // property. The parameter-property form is TypeScript that has to be
  // *compiled* rather than stripped, so it cannot be loaded by
  // `node --test --experimental-strip-types` -- which quietly put this whole
  // module out of reach of the test runner, and is how the error-field bug
  // above went unnoticed. Vite would have built either form.
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { cache: "no-store", ...init });
  } catch {
    throw new ApiError(0, "Cannot reach the service. Check your connection.");
  }

  if (!response.ok) {
    throw new ApiError(response.status, await readErrorMessage(response));
  }

  // A JSON endpoint that answers with HTML is CloudFront serving the shell in
  // place of the API -- a custom error response, or a behaviour that has
  // stopped matching /api/*. Saying so beats the `SyntaxError` that parsing it
  // would throw, which reads like a bug in this file.
  if (!isJson(response)) {
    throw new ApiError(response.status, "The service sent an unexpected reply. Try again.");
  }

  return (await response.json()) as T;
}

function isJson(response: Response): boolean {
  return (response.headers.get("content-type") ?? "").includes("json");
}

/**
 * The sentence the handler wrote, or an honest substitute.
 *
 * `lib/http.ts` returns `{ error }`, and reading the wrong field here is not a
 * cosmetic failure: it replaces "that location is outside the area this
 * covers" with "the service returned 422", which tells the user nothing they
 * can act on. `detail` and `title` are accepted too so that a gateway-shaped
 * error body is still read rather than discarded.
 */
async function readErrorMessage(response: Response): Promise<string> {
  const fallback = `The service returned ${response.status}.`;
  if (!isJson(response)) return fallback;

  try {
    const body = (await response.json()) as {
      error?: unknown;
      detail?: unknown;
      title?: unknown;
    };
    for (const candidate of [body.error, body.detail, body.title]) {
      if (typeof candidate === "string" && candidate.trim() !== "") return candidate;
    }
  } catch {
    /* Body was empty or malformed. The status is all there is to say. */
  }

  return fallback;
}

export function fetchConfig(): Promise<ClientConfig> {
  return request<ClientConfig>("/api/config");
}

/** bbox is west,south,east,north in degrees. */
export function fetchRisk(bbox: [number, number, number, number]): Promise<RiskResponse> {
  return request<RiskResponse>(`/api/risk?bbox=${bbox.join(",")}`);
}

export function fetchReports(bbox: [number, number, number, number]): Promise<ReportsResponse> {
  return request<ReportsResponse>(`/api/reports?bbox=${bbox.join(",")}`);
}

export interface WatchResult {
  watching: boolean;
  cell: string;
  message: string;
}

/**
 * Register or cancel an alert for a place.
 *
 * The subscription is the browser's own opaque push registration. Nothing
 * about the person goes with it.
 */
export function saveWatch(
  latitude: number,
  longitude: number,
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  action: "watch" | "unwatch",
): Promise<WatchResult> {
  return request<WatchResult>("/api/watch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, latitude, longitude, subscription }),
  });
}

export type TravelMode = "walking" | "driving";

/**
 * A route request answered. `found: false` is a successful answer, not an
 * error: "every way through is flooded" is the most important thing this
 * endpoint can say, and it says it with a 200.
 */
export interface RouteFound {
  found: true;
  mode: TravelMode;
  geometry: { type: "LineString"; coordinates: Array<[number, number]> };
  distanceMetres: number;
  durationSeconds: number;
  avoided: { blocked: number; likely: number; hazardsInArea: number };
  detour: { extraSeconds: number; extraMetres: number } | null;
  explanation: string;
}

export interface RouteNotFound {
  found: false;
  mode: TravelMode;
  reason: "flooded" | "no-route";
  blockedCells?: number;
  explanation: string;
}

export type RouteResponse = RouteFound | RouteNotFound;

export function calculateRoute(
  origin: [number, number],
  destination: [number, number],
  mode: TravelMode,
): Promise<RouteResponse> {
  return request<RouteResponse>("/api/route", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ origin, destination, mode }),
  });
}

export function submitReport(
  latitude: number,
  longitude: number,
  depth: Depth,
): Promise<SubmitResult> {
  return request<SubmitResult>("/api/reports", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ latitude, longitude, depth }),
  });
}
