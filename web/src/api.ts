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

export interface ClientConfig {
  pilotArea: PilotArea;
  cellPrecision: number;
  map: {
    styleUrl: string;
    key: string;
    style: string;
  };
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
}

export interface RiskResponse {
  cells: RiskCell[];
  cellCount?: number;
  basis?: string;
  forecastAvailable?: boolean;
  generatedAt?: string;
  outsidePilotArea?: boolean;
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
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
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
    // The handlers return a `detail` field; fall back to the status if the
    // body is empty or not JSON, which is what a gateway error looks like.
    let detail = `The service returned ${response.status}.`;
    try {
      const body = (await response.json()) as { detail?: string; title?: string };
      detail = body.detail ?? body.title ?? detail;
    } catch {
      /* keep the status-based message */
    }
    throw new ApiError(response.status, detail);
  }

  return (await response.json()) as T;
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
