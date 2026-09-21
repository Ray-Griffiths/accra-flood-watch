/**
 * Accra Flood Watch — application entry point.
 *
 * Ordering here is deliberate. The risk request goes out *before* the map is
 * constructed, because the overlay carries the information that matters and
 * the basemap does not: on a slow connection the user should see which streets
 * flood while the tiles are still arriving. Tiles are context; risk is the
 * point.
 */

import {
  ApiError,
  fetchConfig,
  fetchReports,
  fetchRisk,
  type ClientConfig,
  type FloodReport,
  type RiskCell,
  type RiskResponse,
} from "./api.ts";
import { describeAge, loadRisk, storeRisk } from "./cache.ts";
import { DetailSheet } from "./detail.ts";
import { LEVEL_STYLES, RISK_LEVELS } from "./levels.ts";
import { createMap, installOverlays, RISK_LAYERS, type MapHandles } from "./map.ts";
import { ReportFlow } from "./reporting.ts";

type Bbox = [number, number, number, number];

const elements = {
  map: document.querySelector<HTMLElement>("#map")!,
  status: document.querySelector<HTMLElement>("#status")!,
  legend: document.querySelector<HTMLElement>("#legend")!,
  reportButton: document.querySelector<HTMLButtonElement>("#report-button")!,
  detailSheet: document.querySelector<HTMLElement>("#detail-sheet")!,
  reportSheet: document.querySelector<HTMLElement>("#report-sheet")!,
};

let handles: MapHandles | null = null;
let currentReports: FloodReport[] = [];
let currentCells: RiskCell[] = [];
let refreshTimer: number | undefined;

function setStatus(text: string, state: "ok" | "warn" | "error" | "pending"): void {
  elements.status.textContent = text;
  elements.status.className = `status status--${state}`;
}

/**
 * The legend states every level three ways — swatch, texture and word — so it
 * is readable under glare and without colour vision.
 */
function renderLegend(): void {
  const list = document.createElement("ul");
  list.className = "legend__list";

  for (const level of RISK_LEVELS) {
    const style = LEVEL_STYLES[level];

    const item = document.createElement("li");
    item.className = "legend__item";

    const swatch = document.createElement("span");
    swatch.className = `legend__swatch legend__swatch--${level}`;
    swatch.style.setProperty("--level-colour", style.colour);
    swatch.setAttribute("aria-hidden", "true");

    const text = document.createElement("span");
    text.className = "legend__text";

    const label = document.createElement("strong");
    label.textContent = style.label;

    const meaning = document.createElement("span");
    meaning.textContent = style.meaning;

    text.append(label, meaning);
    item.append(swatch, text);
    list.append(item);
  }

  elements.legend.replaceChildren(list);
}

/** Say what the map is showing and how current it is. Never imply more. */
function describeRisk(risk: RiskResponse, cached?: { ageLabel: string }): void {
  if (cached) {
    setStatus(`Showing saved data from ${cached.ageLabel}. Not current.`, "warn");
    return;
  }

  if (risk.outsidePilotArea) {
    setStatus(risk.message ?? "Outside the pilot area.", "warn");
    return;
  }

  if (risk.forecastAvailable) {
    const updated = risk.generatedAt ? describeAge(new Date(risk.generatedAt)) : "just now";
    setStatus(`Terrain and rainfall forecast. Updated ${updated}.`, "ok");
    return;
  }

  // The honest default today: the hourly scoring job does not exist yet, so
  // what is on screen is terrain susceptibility and must not be dressed up as
  // a live forecast.
  setStatus("Terrain only — no rainfall forecast yet.", "warn");
}

async function refreshForViewport(): Promise<void> {
  if (!handles) return;
  const bbox = handles.viewportBbox();

  const [risk, reports] = await Promise.allSettled([fetchRisk(bbox), fetchReports(bbox)]);

  if (risk.status === "fulfilled") {
    currentCells = risk.value.cells;
    handles.setRisk(currentCells);
    storeRisk(bbox, risk.value);
    describeRisk(risk.value);
  } else {
    // Degrade readably: keep whatever is already drawn and say it is stale,
    // rather than blanking a map somebody may be using to decide a route.
    const cached = loadRisk();
    setStatus(
      cached
        ? `Cannot reach the service. Showing saved data from ${cached.ageLabel}.`
        : "Cannot reach the service. Check your connection.",
      "error",
    );
  }

  if (reports.status === "fulfilled") {
    currentReports = reports.value.reports;
    handles.setReports(currentReports);
  }
}

function scheduleRefresh(): void {
  window.clearTimeout(refreshTimer);
  // Panning fires continuously; one request per settled viewport, not per frame.
  refreshTimer = window.setTimeout(() => void refreshForViewport(), 350);
}

function openDetailFor(cell: string, sheet: DetailSheet): void {
  const match = currentCells.find((candidate) => candidate.cell === cell);
  if (!match) return;

  sheet.show({
    cell: match.cell,
    level: match.level,
    score: match.score,
    basis: match.basis,
    explanation: match.explanation,
    hand: match.hand,
    historicalFloodPoint: match.historicalFloodPoint,
    updatedAt: match.updatedAt,
    reports: currentReports
      .filter((report) => report.cell === cell)
      .map((report) => ({ depthLabel: report.depthLabel, ageLabel: report.ageLabel })),
  });
}

function showFatal(message: string): void {
  setStatus(message, "error");
  elements.reportButton.disabled = true;
}

async function start(): Promise<void> {
  renderLegend();
  setStatus("Loading flood risk…", "pending");

  // Both requests leave now. Nothing waits on the map.
  const configPromise = fetchConfig();
  let config: ClientConfig;
  try {
    config = await configPromise;
  } catch (error) {
    // No config means no map key. Fall back to whatever was last seen, with a
    // label, rather than an empty screen.
    const cached = loadRisk();
    showFatal(
      cached
        ? `Cannot load the map right now. Last saved reading was ${cached.ageLabel}.`
        : error instanceof ApiError
          ? error.message
          : "Cannot load the map right now.",
    );
    return;
  }

  const pilotBbox = config.pilotArea.bbox;
  const riskPromise = fetchRisk(pilotBbox).catch((error: unknown) => error as Error);

  const map = createMap(
    elements.map,
    config.map.styleUrl,
    config.map.key,
    pilotBbox,
    config.pilotArea.centre,
  );

  const detailSheet = new DetailSheet(elements.detailSheet);

  const reportFlow = new ReportFlow(
    elements.reportSheet,
    () => {
      const centre = map.getCenter();
      return [centre.lng, centre.lat];
    },
    () => {
      // A new report changes the live picture immediately, so re-read rather
      // than waiting for the next pan.
      void refreshForViewport();
    },
  );

  elements.reportButton.addEventListener("click", () => reportFlow.open());

  map.on("load", () => {
    handles = installOverlays(map);

    void riskPromise.then((result) => {
      if (result instanceof Error) {
        const cached = loadRisk();
        if (cached && handles) {
          handles.setRisk(cached.risk.cells);
          currentCells = cached.risk.cells;
          describeRisk(cached.risk, cached);
        } else {
          setStatus(
            result instanceof ApiError ? result.message : "Cannot load flood risk.",
            "error",
          );
        }
        return;
      }

      currentCells = result.cells;
      handles?.setRisk(currentCells);
      storeRisk(pilotBbox, result);
      describeRisk(result);
    });

    void fetchReports(pilotBbox)
      .then((response) => {
        currentReports = response.reports;
        handles?.setReports(currentReports);
      })
      .catch(() => {
        /* Reports are additive. Their absence is not worth an error banner. */
      });

    map.on("moveend", scheduleRefresh);

    for (const layer of [RISK_LAYERS.fill, RISK_LAYERS.pattern]) {
      map.on("click", layer, (event) => {
        const cell = event.features?.[0]?.properties?.["cell"];
        if (typeof cell === "string") openDetailFor(cell, detailSheet);
      });
    }

    map.on("mouseenter", RISK_LAYERS.fill, () => {
      map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", RISK_LAYERS.fill, () => {
      map.getCanvas().style.cursor = "";
    });
  });

  // A style failure must not leave the user staring at a blank rectangle with
  // no explanation.
  map.on("error", (event) => {
    console.error("Map error", event.error);
  });

  // Coming back to the app after a while should not show a stale reading.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") scheduleRefresh();
  });
}

void start();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/service-worker.js");
  });
}
