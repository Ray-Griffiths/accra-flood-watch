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
import { envelopeOf, type Coverage } from "./pilot.ts";
import {
  RISK_MIN_ZOOM,
  clampBbox,
  isUsableBbox,
  viewportBboxFor,
  type Bbox,
} from "./viewport.ts";
import { DetailSheet, type CellDetail } from "./detail.ts";
import { stylesForView, type MapView } from "./levels.ts";
import { DEFAULT_ZOOM, RISK_LAYERS, createMap, installOverlays, type MapHandles } from "./map.ts";
import { ReportFlow } from "./reporting.ts";
import { RouteFlow, type RouteState } from "./route-flow.ts";
import { decideView, hasConfirmedCell } from "./view.ts";
import {
  checkSupport,
  rememberWatch,
  unwatchPlace,
  watchPlace,
  watchedCells,
} from "./watch.ts";


const elements = {
  map: document.querySelector<HTMLElement>("#map")!,
  status: document.querySelector<HTMLElement>("#status")!,
  legend: document.querySelector<HTMLElement>("#legend")!,
  viewBar: document.querySelector<HTMLElement>(".view-bar")!,
  viewReason: document.querySelector<HTMLElement>("#view-reason")!,
  viewOptions: document.querySelectorAll<HTMLButtonElement>(".view-toggle__option"),
  reportButton: document.querySelector<HTMLButtonElement>("#report-button")!,
  routeButton: document.querySelector<HTMLButtonElement>("#route-button")!,
  routePrompt: document.querySelector<HTMLElement>("#route-prompt")!,
  routeCancel: document.querySelector<HTMLButtonElement>("#route-cancel")!,
  detailSheet: document.querySelector<HTMLElement>("#detail-sheet")!,
  reportSheet: document.querySelector<HTMLElement>("#report-sheet")!,
  routeSheet: document.querySelector<HTMLElement>("#route-sheet")!,
};

let handles: MapHandles | null = null;
let currentReports: FloodReport[] = [];
let currentCells: RiskCell[] = [];
let refreshTimer: number | undefined;

/** What the user last chose, if anything. Null means "follow the weather". */
let manualView: MapView | null = null;
let activeView: MapView = "now";
/** The newest risk response, so the toggle re-decides against current weather. */
let lastRisk: RiskResponse | null = null;

function setStatus(text: string, state: "ok" | "warn" | "error" | "pending"): void {
  elements.status.textContent = text;
  elements.status.className = `status status--${state}`;
}

/**
 * Reflect the routing state in the chrome around the map.
 *
 * While a destination is being chosen the map must stay uncovered, so the
 * instruction goes in a thin bar rather than a sheet over the thing being
 * tapped, and the button that started it becomes the way out.
 */
function renderRouteState(state: RouteState): void {
  const picking = state === "picking";
  elements.routePrompt.hidden = !picking;
  elements.routeButton.setAttribute("aria-pressed", String(picking));
  elements.map.classList.toggle("map--picking", picking);
  // Reporting stays available throughout; somebody may be standing in the
  // water they are trying to route around.
}

/**
 * The legend states every band three ways — swatch, texture and word — so it
 * is readable under glare and without colour vision.
 *
 * It is rebuilt per view rather than shown twice: a legend listing words the
 * map is not currently painting is worse than no legend at all.
 */
function renderLegend(view: MapView): void {
  const list = document.createElement("ul");
  list.className = "legend__list";

  for (const [value, style] of stylesForView(view)) {
    const item = document.createElement("li");
    item.className = "legend__item";

    const swatch = document.createElement("span");
    swatch.className = `legend__swatch legend__swatch--${value}`;
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

/**
 * Settle which question the map is answering, and say so.
 *
 * Called after every risk response and after every tap on the toggle, so the
 * decision is re-taken against the newest forecast rather than being latched
 * at load. Weather changes while the app is open; that is the entire point of
 * the hourly job behind it.
 */
function applyViewDecision(): void {
  const decision = decideView({
    outlook: lastRisk?.rainOutlook,
    anyConfirmed: hasConfirmedCell(currentCells),
    manual: manualView,
  });

  // A safety rule that overrules a choice consumes it. Otherwise the map
  // would silently snap back to terrain the moment the rain passed, which is
  // a change the user never asked for and would not be watching for.
  if (decision.overrodeChoice) manualView = null;

  activeView = decision.view;
  handles?.setView(activeView);
  renderLegend(activeView);

  elements.viewReason.textContent = decision.reason;
  elements.viewBar.classList.toggle("view-bar--overridden", decision.overrodeChoice);

  for (const option of elements.viewOptions) {
    option.setAttribute("aria-pressed", String(option.dataset["view"] === activeView));
  }
}

/** Say what the map is showing and how current it is. Never imply more. */
function describeRisk(risk: RiskResponse, cached?: { ageLabel: string }): void {
  if (cached) {
    setStatus(`Showing saved data from ${cached.ageLabel}. Not current.`, "warn");
    return;
  }

  if (risk.outsideCoverage ?? risk.outsidePilotArea) {
    setStatus(risk.message ?? "Outside the area this map covers.", "warn");
    return;
  }

  // A truncated response is part of the viewport drawn as though it were all
  // of it. Saying so matters more than it looks: the missing part renders
  // exactly like ground at low risk.
  if (risk.truncated) {
    setStatus("Showing part of this view only — zoom in to see every street.", "warn");
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

/**
 * The box the map is about to show, worked out before the map exists.
 *
 * Clamped to the coverage envelope so the opening request does not ask for
 * ground off the edge of the grid. The server clips too; this only keeps the
 * request small.
 */
function openingViewport(centre: [number, number], envelope: Bbox): Bbox {
  const rect = elements.map.getBoundingClientRect();
  // The container is sized by CSS flex, so it normally has real dimensions
  // before MapLibre touches it. Falling back to the window keeps the opening
  // request the right order of size if it does not.
  const width = rect.width > 0 ? rect.width : window.innerWidth;
  const height = rect.height > 0 ? rect.height : window.innerHeight;

  return clampBbox(viewportBboxFor(centre, DEFAULT_ZOOM, width, height), envelope);
}

async function refreshForViewport(): Promise<void> {
  if (!handles) return;

  // Below the overlay zoom a 152m cell is a few pixels, and the viewport needs
  // more partitions than one request returns. Rather than draw a fraction of
  // the picture at a size nobody can read, say what is happening and clear it.
  // An overlay that is silently incomplete is worse than no overlay: blank
  // ground and safe ground look the same.
  if (handles.zoom() < RISK_MIN_ZOOM) {
    currentCells = [];
    handles.setRisk([]);
    handles.setReports([]);
    setStatus("Zoom in to see street-level flood risk.", "warn");
    return;
  }

  const bbox = handles.viewportBbox();

  const [risk, reports] = await Promise.allSettled([fetchRisk(bbox), fetchReports(bbox)]);

  if (risk.status === "fulfilled") {
    currentCells = risk.value.cells;
    handles.setRisk(currentCells);
    storeRisk(bbox, risk.value);
    lastRisk = risk.value;
    describeRisk(risk.value);
    applyViewDecision();
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
    susceptibility: match.susceptibility,
    historicalFloodPoint: match.historicalFloodPoint,
    updatedAt: match.updatedAt,
    terrainBand: match.terrainBand,
    terrainExplanation: match.terrainExplanation,
    view: activeView,
    centre: [
      (match.bounds.west + match.bounds.east) / 2,
      (match.bounds.south + match.bounds.north) / 2,
    ],
    reports: currentReports
      .filter((report) => report.cell === cell)
      .map((report) => ({ depthLabel: report.depthLabel, ageLabel: report.ageLabel })),
  });
}

/**
 * The "alert me about this place" control inside the detail sheet.
 *
 * Lives on a cell rather than as a global button because the thing being
 * watched is a place, and the user has just told us which one by tapping it.
 * Asking for a notification permission at that moment has an obvious reason
 * attached; asking on page load does not, and a refused permission is
 * permanent until somebody goes digging in browser settings.
 */
function renderWatchSection(
  detail: CellDetail,
  publicKey: string | null,
  support: ReturnType<typeof checkSupport>,
): HTMLElement | null {
  // Nothing at all rather than a disabled button: an unexplained dead control
  // is worse than no control.
  if (!support.supported || !publicKey) return null;

  const section = document.createElement("section");
  section.className = "watch";

  const status = document.createElement("p");
  status.className = "watch__status";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "button button--secondary watch__button";

  const paint = (): void => {
    const watching = watchedCells().has(detail.cell);
    button.textContent = watching ? "Stop alerting me" : "Alert me about this place";
    status.textContent = watching
      ? "You will be told when flooding becomes likely here."
      : "Get one alert if flooding becomes likely here, and one if people start reporting water.";
    status.classList.toggle("watch__status--on", watching);
  };

  button.addEventListener("click", () => {
    const watching = watchedCells().has(detail.cell);
    button.disabled = true;
    status.textContent = watching ? "Cancelling…" : "Setting up alerts…";

    const action = watching
      ? unwatchPlace(detail.centre[1], detail.centre[0])
      : watchPlace(detail.centre[1], detail.centre[0], publicKey);

    void action
      .then((result) => {
        rememberWatch(detail.cell, result?.watching ?? false);
        paint();
        if (result) status.textContent = result.message;
      })
      .catch((error: unknown) => {
        // Say what went wrong. A control that silently does nothing is a
        // control the user assumes worked.
        status.textContent =
          error instanceof Error ? error.message : "Could not change your alerts. Try again.";
        status.classList.add("watch__status--error");
      })
      .finally(() => {
        button.disabled = false;
      });
  });

  paint();
  section.append(button, status);
  return section;
}

function showFatal(message: string): void {
  setStatus(message, "error");
  elements.reportButton.disabled = true;
}

async function start(): Promise<void> {
  renderLegend(activeView);
  setStatus("Loading flood risk…", "pending");

  for (const option of elements.viewOptions) {
    option.addEventListener("click", () => {
      const chosen = option.dataset["view"];
      if (chosen !== "now" && chosen !== "terrain") return;
      manualView = chosen;
      // Re-decided rather than applied: a choice the safety rules refuse is
      // refused visibly, with the reason next to the button that refused it.
      applyViewDecision();
    });
  }

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

  // Prefer the area list. `pilotArea` is the fallback for the window between
  // a stack deploy and the web sync, when this bundle may be talking to a
  // deployment that predates it.
  const coverage: Coverage = config.coverage
    ? {
        areas: config.coverage.areas,
        description: config.coverage.description,
        envelope: config.coverage.envelope,
      }
    : {
        areas: [
          {
            id: "pilot",
            name: config.pilotArea.name,
            bbox: config.pilotArea.bbox,
          },
        ],
        description: config.pilotArea.name,
        envelope: config.pilotArea.bbox,
      };

  const envelope = (envelopeOf(coverage.areas) ?? coverage.envelope) as Bbox;
  const centre = config.coverage?.centre ?? config.pilotArea.centre;

  // The opening request goes out before the map exists, so that the overlay is
  // in flight while the style and tiles load. It used to ask for the whole
  // covered area, which over a catchment is thousands of cells and megabytes
  // of it off-screen. The viewport is computed instead, from the same centre,
  // zoom and container size the map is about to use.
  const openingBbox = openingViewport(centre, envelope);
  const riskPromise = isUsableBbox(openingBbox)
    ? fetchRisk(openingBbox).catch((error: unknown) => error as Error)
    : Promise.resolve(new Error("No usable opening viewport."));

  const map = createMap(
    elements.map,
    config.map.styleUrl,
    config.map.key,
    envelope,
    centre,
  );

  // Push may not be provisioned on this stack, and the browser may not do it
  // at all. Both are decided once, here, so no control is ever offered that
  // would fail after the user had already granted a permission.
  const support = checkSupport(config.pushPublicKey);
  const detailSheet = new DetailSheet(elements.detailSheet, (detail) =>
    renderWatchSection(detail, config.pushPublicKey, support),
  );

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
    coverage,
  );

  elements.reportButton.addEventListener("click", () => reportFlow.open());

  const mapCentre = (): [number, number] => {
    const centre = map.getCenter();
    return [centre.lng, centre.lat];
  };

  const routeFlow = new RouteFlow(elements.routeSheet, {
    mapCentre,
    onRoute: (result, origin, destination) => {
      if (!result || !result.found) {
        // A refused route clears the map. Leaving the previous line drawn
        // beside a "do not travel" message is how somebody follows the line.
        handles?.setRoute(null);
        return;
      }
      const drawn = { coordinates: result.geometry.coordinates, origin, destination };
      handles?.setRoute(drawn);
      handles?.frameRoute(drawn);
    },
    onState: renderRouteState,
  }, coverage);

  elements.routeButton.addEventListener("click", () => {
    if (routeFlow.currentState === "picking") routeFlow.cancel();
    else routeFlow.start();
  });
  elements.routeCancel.addEventListener("click", () => routeFlow.cancel());

  map.on("load", () => {
    handles = installOverlays(map);

    void riskPromise.then((result) => {
      if (result instanceof Error) {
        const cached = loadRisk();
        if (cached && handles) {
          handles.setRisk(cached.risk.cells);
          currentCells = cached.risk.cells;
          lastRisk = cached.risk;
          describeRisk(cached.risk, cached);
          applyViewDecision();
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
      storeRisk(openingBbox, result);
      lastRisk = result;
      describeRisk(result);
      applyViewDecision();
    });

    void fetchReports(openingBbox)
      .then((response) => {
        currentReports = response.reports;
        handles?.setReports(currentReports);
      })
      .catch(() => {
        /* Reports are additive. Their absence is not worth an error banner. */
      });

    map.on("moveend", scheduleRefresh);

    // One click handler on the map, not on the risk layers, so a destination
    // can be chosen anywhere -- including over water, a park, or a gap in the
    // grid. Binding this to the cells would make the untappable places the
    // ones a person is most likely to be heading for.
    map.on("click", (event) => {
      if (routeFlow.currentState === "picking") {
        routeFlow.chooseDestination([event.lngLat.lng, event.lngLat.lat]);
        return;
      }

      const features = map.queryRenderedFeatures(event.point, {
        layers: [RISK_LAYERS.fill, RISK_LAYERS.pattern].filter((id) => map.getLayer(id)),
      });
      const cell = features[0]?.properties?.["cell"];
      if (typeof cell === "string") openDetailFor(cell, detailSheet);
    });

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
