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
import { flush as flushQueue, pendingCount } from "./queue.ts";
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
import {
  DEFAULT_ZOOM,
  RISK_LAYERS,
  applyBasemapTheme,
  createMap,
  installOverlays,
  styleUrlForTheme,
  type DrawnRoute,
  type MapHandles,
} from "./map.ts";
import {
  nextChoice,
  readStoredChoice,
  resolveTheme,
  storeChoice,
  type Theme,
  type ThemeChoice,
} from "./theme.ts";
import { ReportFlow } from "./reporting.ts";
import { PlaceSearch } from "./search.ts";
import { loadCommute } from "./commute.ts";
import {
  LOCALES,
  LOCALE_NAMES,
  detectLocale,
  isDraftLocale,
  isLocale,
  setLocale,
  t,
} from "./i18n.ts";
import { clearIntent, readIntent, shareUrlFor } from "./url-state.ts";
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
  search: document.querySelector<HTMLElement>("#search")!,
  language: document.querySelector<HTMLElement>(".language")!,
  languageSelect: document.querySelector<HTMLSelectElement>("#language-select")!,
  tagline: document.querySelector<HTMLElement>("#tagline")!,
  status: document.querySelector<HTMLElement>("#status")!,
  legend: document.querySelector<HTMLElement>("#legend")!,
  themeToggle: document.querySelector<HTMLButtonElement>("#theme-toggle")!,
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
/**
 * A drawn route and a search pin, held so a theme switch can put them back.
 * `setStyle` drops every source, and somebody who has just found a way around
 * the water must not lose it because they changed the colours.
 */
let currentRoute: DrawnRoute | null = null;
let currentPin: { longitude: number; latitude: number; title: string } | null = null;

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
let themeChoice: ThemeChoice = readStoredChoice(window.localStorage);
let activeTheme: Theme = resolveTheme(themeChoice, darkQuery.matches);

let refreshTimer: number | undefined;
let pollTimer: number | undefined;
/**
 * A shared place waiting for its cell to arrive.
 *
 * `?at=` flies the map somewhere that is almost never inside the OPENING
 * viewport, so the cells needed to open the detail sheet have not been
 * fetched when the link is first handled. Holding the point until a refresh
 * brings its cell in is what makes a shared link actually land on the reading
 * it was sent to show -- which is the entire payload of sharing one.
 */
let pendingShare: [number, number] | null = null;
/** Set once the shell is built, so a background refresh can open the sheet. */
let sharedSheet: DetailSheet | null = null;
/** Cells the server says residents have confirmed since the last scoring run. */
let confirmedByReports = new Set<string>();

/** Paint the interface. The map is a separate, heavier step. */
function applyThemeToDocument(theme: Theme): void {
  document.documentElement.dataset["theme"] = theme;
  elements.themeToggle.setAttribute(
    "aria-label",
    theme === "dark" ? "Switch to light theme" : "Switch to dark theme",
  );
  // The theme-colour meta drives the browser chrome around the PWA; leaving it
  // on the old navy is the one place a stale colour is visible outside the app.
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "dark" ? "#0a1218" : "#e6ecef");
}

/**
 * How often to re-read while the app is open and on screen.
 *
 * Until now the map only refreshed on a pan or on returning to the tab, so
 * somebody watching a storm develop — holding the phone, not touching it —
 * saw the same reading for an hour. That is the one situation where this
 * application has something new to say every few minutes.
 *
 * Five minutes against an hourly scoring job is deliberately faster than the
 * data changes: reports arrive continuously and are what move a cell to
 * confirmed. The requests are cheap — /api/risk is cached at the edge for 60s,
 * so a screenful of users mostly share one origin read.
 */
const POLL_INTERVAL_MS = 5 * 60_000;

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
    swatch.style.setProperty("--level-colour", `var(${style.cssVariable})`);
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

  // Reports are read first so that a cell confirmed since the last scoring run
  // is already known before the risk cells are painted. Painting twice would
  // flash a `watch` cell red a moment later, which reads as the map changing
  // its mind.
  if (reports.status === "fulfilled") {
    currentReports = reports.value.reports;
    confirmedByReports = new Set(reports.value.confirmedCells ?? []);
    handles.setReports(currentReports);
  }

  if (risk.status === "fulfilled") {
    currentCells = withReportedConfirmations(risk.value.cells);
    handles.setRisk(currentCells);
    storeRisk(bbox, risk.value);
    lastRisk = risk.value;
    describeRisk(risk.value);
    applyViewDecision();
    // A shared link flew the map here; its cell has just arrived.
    if (sharedSheet) resolvePendingShare(sharedSheet);
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
}

/**
 * Open the detail sheet for a shared place, once its cell is on screen.
 *
 * Gives up quietly if the point turns out to have no cell -- a link to ground
 * outside coverage should still take you there and show the pin, rather than
 * failing visibly.
 */
function resolvePendingShare(sheet: DetailSheet): void {
  if (!pendingShare) return;

  const [lon, lat] = pendingShare;
  const match = currentCells.find(
    (cell) =>
      lon >= cell.bounds.west &&
      lon <= cell.bounds.east &&
      lat >= cell.bounds.south &&
      lat <= cell.bounds.north,
  );
  if (!match) return;

  pendingShare = null;
  openDetailFor(match.cell, sheet);
}

/**
 * Raise a cell to `confirmed` when residents have confirmed it since the last
 * scoring run.
 *
 * Only ever upgrades. The hourly job's answer is authoritative in every other
 * direction — this closes the window where a push alert has already told
 * somebody there is water in a cell the map still calls `watch`, and does
 * nothing else.
 */
function withReportedConfirmations(cells: RiskCell[]): RiskCell[] {
  if (confirmedByReports.size === 0) return cells;

  return cells.map((cell) =>
    cell.level === "confirmed" || !confirmedByReports.has(cell.cell)
      ? cell
      : { ...cell, level: "confirmed" },
  );
}

/**
 * Send anything the device held while it was offline.
 *
 * Runs on load and whenever the browser regains a connection. `online` is a
 * hint rather than a guarantee -- it fires for a captive portal too -- so a
 * failed flush simply leaves the reports queued for the next attempt.
 */
function installQueueFlush(): void {
  const attempt = (): void => {
    void flushQueue().then((result) => {
      if (result.sent > 0) {
        setStatus(
          result.sent === 1
            ? "Your saved report has been sent."
            : `${result.sent} saved reports have been sent.`,
          "ok",
        );
        // The map does not yet know about them.
        void refreshForViewport();
      } else if (result.expired > 0) {
        setStatus(
          result.expired === 1
            ? "A saved report was too old to send and has been discarded."
            : `${result.expired} saved reports were too old to send and have been discarded.`,
          "warn",
        );
      }
    });
  };

  window.addEventListener("online", attempt);
  if (pendingCount() > 0) attempt();
}

function scheduleRefresh(): void {
  window.clearTimeout(refreshTimer);
  // Panning fires continuously; one request per settled viewport, not per frame.
  refreshTimer = window.setTimeout(() => void refreshForViewport(), 350);
}

/**
 * Keep the reading current while the app is on screen, and stop the moment it
 * is not.
 *
 * Polling a hidden tab would spend a backgrounded phone's battery and data on
 * a map nobody is looking at — and browsers throttle timers there anyway, so
 * it would not even be reliable. The visibility handler already refreshes on
 * return, which covers the gap.
 */
function startPolling(): void {
  window.clearInterval(pollTimer);
  pollTimer = window.setInterval(() => {
    if (document.visibilityState === "visible") void refreshForViewport();
  }, POLL_INTERVAL_MS);
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

/**
 * Hand a link to this place to whatever the phone uses for sharing.
 *
 * `navigator.share` is the native sheet -- WhatsApp, SMS, anything installed
 * -- and is what somebody in Accra will actually reach for. It is not
 * everywhere, and it rejects when the user simply dismisses the sheet, which
 * is not an error and must not be reported as one. The clipboard is the
 * fallback, and saying "link copied" is the only way the user knows anything
 * happened.
 */
async function sharePlace(centre: readonly [number, number]): Promise<void> {
  const url = shareUrlFor(centre, window.location.href);
  const text = "Flood risk at this place on Accra Flood Watch";

  if (typeof navigator.share === "function") {
    try {
      await navigator.share({ title: "Accra Flood Watch", text, url });
      return;
    } catch {
      // Dismissed, or the platform refused. Fall through to the clipboard
      // rather than telling the user something went wrong.
    }
  }

  try {
    await navigator.clipboard.writeText(url);
    setStatus("Link copied. Paste it to send this place to someone.", "ok");
  } catch {
    setStatus("Could not share automatically. Copy the address bar instead.", "warn");
  }
}

/**
 * Act on whatever the address bar asked for, once.
 *
 * Applied after the first risk response so a shared place can be matched to a
 * real cell; the pin and the flight happen regardless, because a link to
 * ground the grid has not loaded yet should still take you there.
 */
function applyIntent(
  intent: ReturnType<typeof readIntent>,
  handles: MapHandles,
  detailSheet: DetailSheet,
  openReport: () => void,
  startRoute: () => void,
): void {
  if (intent.at) {
    const [lon, lat] = intent.at;
    currentPin = { longitude: lon, latitude: lat, title: "Shared place" };
    handles.setSearchPin(currentPin);

    // Parked rather than resolved here: the flight above changes the
    // viewport, and the cells for where it lands have not been fetched yet.
    pendingShare = [lon, lat];
    resolvePendingShare(detailSheet);
  }

  if (intent.action === "report") openReport();
  if (intent.action === "route") startRoute();

  // Consume it. A shortcut left in the URL would re-open the report flow on
  // every resume, and a shared link would re-open the sheet on every reload.
  clearIntent();
}

/**
 * Build the language picker and apply the chosen language.
 *
 * Re-rendering the legend and relabelling the controls is enough: the map
 * itself repaints from the same style objects, and the per-cell explanation
 * sentences are composed on the server and stay English until a native
 * speaker has reviewed them. That boundary is stated to the user rather than
 * hidden — see the draft notice below.
 */
function installLanguagePicker(onChange: () => void): void {
  const select = elements.languageSelect;

  for (const locale of LOCALES) {
    const option = document.createElement("option");
    option.value = locale;
    option.textContent = LOCALE_NAMES[locale];
    select.append(option);
  }

  const apply = (): void => {
    select.value = getActiveLocale();
    paintDraftNotice();
    applyStaticText();
    onChange();
  };

  select.addEventListener("change", () => {
    const chosen = select.value;
    if (!isLocale(chosen)) return;
    setLocale(chosen);
    apply();
  });

  setLocale(detectLocale());
  apply();
}

function getActiveLocale(): string {
  return document.documentElement.lang || "en";
}

/**
 * Say plainly when the wording on screen has not been checked.
 *
 * A draft translation of a flood warning is still worth having -- it is how
 * somebody navigates the app at all -- but presenting it as finished would be
 * claiming a confidence nobody on the project can back.
 */
function paintDraftNotice(): void {
  const existing = elements.language.querySelector(".language__notice");
  existing?.remove();

  if (!isDraftLocale()) return;

  const notice = document.createElement("p");
  notice.className = "language__notice";
  notice.setAttribute("role", "note");
  notice.textContent = t("language.draft");
  elements.language.append(notice);
}

/** Relabel the chrome that is not rebuilt on every render. */
function applyStaticText(): void {
  const setText = (selector: string, key: string): void => {
    const node = document.querySelector(selector);
    if (node) node.textContent = t(key);
  };

  for (const option of elements.viewOptions) {
    const view = option.dataset["view"];
    if (view) option.textContent = t(`view.${view}`);
  }

  setText("#report-button .report-button__label", "action.report");
  setText(".route-prompt__text", "action.route");

  const search = document.querySelector<HTMLInputElement>(".search__input");
  if (search) search.placeholder = t("search.placeholder");

  setText(".disclaimer strong", "disclaimer.lead");
}

function showFatal(message: string): void {
  setStatus(message, "error");
  elements.reportButton.disabled = true;
}

async function start(): Promise<void> {
  renderLegend(activeView);
  setStatus("Loading flood risk…", "pending");

  // Captured before anything else runs: a PWA shortcut or a shared link is
  // the first thing the user asked for, and `clearIntent` will wipe it from
  // the address bar as soon as it has been acted on.
  const intent = readIntent(window.location.search);

  // Before anything else renders, so the first paint is already in the user's
  // language rather than flashing English and then correcting itself.
  installLanguagePicker(() => {
    renderLegend(activeView);
    applyViewDecision();
  });

  for (const option of elements.viewOptions) {
    option.addEventListener("click", () => {
      const chosen = option.dataset["view"];
      if (chosen !== "now" && chosen !== "later" && chosen !== "terrain") return;
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

  // One source of truth for what this map covers. The masthead, the report
  // sheet's rejection message and the server's 422 all read the same string,
  // so extending coverage cannot leave one of them describing the old area.
  elements.tagline.textContent = coverage.description;

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

  // Painted before the map is constructed, so the first style fetched is
  // already the right one -- switching after load would cost a second style
  // download on the connection this app is trying to be careful with.
  applyThemeToDocument(activeTheme);

  const map = createMap(
    elements.map,
    styleUrlForTheme(config.map.styleUrl, activeTheme),
    config.map.key,
    envelope,
    centre,
  );

  // Push may not be provisioned on this stack, and the browser may not do it
  // at all. Both are decided once, here, so no control is ever offered that
  // would fail after the user had already granted a permission.
  const support = checkSupport(config.pushPublicKey);
  const detailSheet = new DetailSheet(
    elements.detailSheet,
    (detail) => renderWatchSection(detail, config.pushPublicKey, support),
    (detail) => void sharePlace(detail.centre),
  );
  sharedSheet = detailSheet;

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
    onCommuteChanged: () => paintRouteButton(),
    mapCentre,
    onRoute: (result, origin, destination) => {
      if (!result || !result.found) {
        // A refused route clears the map. Leaving the previous line drawn
        // beside a "do not travel" message is how somebody follows the line.
        currentRoute = null;
        handles?.setRoute(null);
        return;
      }
      const drawn = { coordinates: result.geometry.coordinates, origin, destination };
      currentRoute = drawn;
      handles?.setRoute(drawn);
      handles?.frameRoute(drawn);
    },
    onState: renderRouteState,
  }, coverage);

  // Search resolves a name to a place, drops a pin on it, and then hands the
  // question to the detail sheet -- which already renders level, score,
  // explanation, nearby reports and the watch control. The search feature adds
  // a way IN to that answer rather than a second version of it.
  const placeSearch = new PlaceSearch(elements.search, {
    onChoose: (place) => {
      currentPin = place;
      handles?.setSearchPin(place);

      // Only open the sheet when there is a real reading behind it. Every
      // field below comes from the server; none is defaulted, because the
      // sheet prints them as facts -- an invented `hand` showed up as
      // "Height above nearest drain: 0.0 m" over real ground.
      if (place.covered && place.cell && place.level && typeof place.hand === "number") {
        detailSheet.show({
          cell: place.cell,
          level: place.level,
          score: place.score ?? place.susceptibility ?? 0,
          basis: place.basis ?? "terrain-only",
          explanation: place.explanation ?? "",
          hand: place.hand,
          susceptibility: place.susceptibility ?? 0,
          historicalFloodPoint: place.historicalFloodPoint,
          history: place.history,
          updatedAt: place.updatedAt,
          terrainBand: place.terrainBand,
          terrainExplanation: place.terrainExplanation,
          view: activeView,
          centre: [place.longitude, place.latitude],
          reports: currentReports
            .filter((report) => report.cell === place.cell)
            .map((report) => ({ depthLabel: report.depthLabel, ageLabel: report.ageLabel })),
        });
      }
    },
    onClear: () => {
      currentPin = null;
      handles?.setSearchPin(null);
    },
  });

  /**
   * The route button does the common thing first.
   *
   * With a trip saved, the morning question is "can I get to work" and it
   * should cost one tap, not two map picks. The result sheet still offers
   * "Pick another destination", so the general flow is one tap further in
   * rather than gone. Reusing this button rather than adding another is also
   * what keeps the action bar the height it already is.
   */
  const paintRouteButton = (): void => {
    const saved = loadCommute();
    const label = elements.routeButton.querySelector("span:last-child");
    if (label) label.textContent = saved ? "Check my trip" : "Safe route";
  };

  elements.routeButton.addEventListener("click", () => {
    if (routeFlow.currentState === "picking") {
      routeFlow.cancel();
      return;
    }
    if (loadCommute()) routeFlow.checkSavedCommute();
    else routeFlow.start();
  });

  paintRouteButton();
  elements.routeCancel.addEventListener("click", () => routeFlow.cancel());

  const reinstallOverlays = (): void => {
    handles = installOverlays(map, activeTheme);
    handles.setView(activeView);
    // Re-push everything that was on screen. `setStyle` dropped every source,
    // and waiting for the next poll would leave the map blank for up to a
    // minute. The route matters most: somebody who just found a way around the
    // water must not lose it because they changed the colours.
    handles.setRisk(currentCells);
    handles.setReports(currentReports);
    handles.setRoute(currentRoute);
    handles.setSearchPin(currentPin);
  };

  const switchTheme = (theme: Theme): void => {
    activeTheme = theme;
    applyThemeToDocument(theme);
    renderLegend(activeView);
    applyBasemapTheme(map, config.map.styleUrl, theme, reinstallOverlays);
  };

  elements.themeToggle.addEventListener("click", () => {
    themeChoice = nextChoice(activeTheme);
    storeChoice(window.localStorage, themeChoice);
    switchTheme(resolveTheme(themeChoice, darkQuery.matches));
  });

  // A user who has never chosen keeps following their phone, so an app left
  // open across dusk comes with it.
  darkQuery.addEventListener("change", (event) => {
    if (themeChoice !== "system") return;
    switchTheme(resolveTheme("system", event.matches));
  });

  map.on("load", () => {
    handles = installOverlays(map, activeTheme);

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

      currentCells = withReportedConfirmations(result.cells);
      handles?.setRisk(currentCells);
      storeRisk(openingBbox, result);
      lastRisk = result;
      describeRisk(result);
      applyViewDecision();

      // Now that there are cells to match against, a shared place can open on
      // the right one.
      if (handles) {
        applyIntent(
          intent,
          handles,
          detailSheet,
          () => reportFlow.open(),
          () => routeFlow.start(),
        );
      }
    });

    void fetchReports(openingBbox)
      .then((response) => {
        currentReports = response.reports;
        confirmedByReports = new Set(response.confirmedCells ?? []);
        handles?.setReports(currentReports);
        // The risk response may already have been painted, so re-apply rather
        // than wait for the next pan.
        if (currentCells.length > 0 && confirmedByReports.size > 0) {
          currentCells = withReportedConfirmations(currentCells);
          handles?.setRisk(currentCells);
          applyViewDecision();
        }
      })
      .catch(() => {
        /* Reports are additive. Their absence is not worth an error banner. */
      });

    map.on("moveend", scheduleRefresh);
    // Dragging the map is the user moving on from the search. Keep the pin and
    // the typed text; just get the list out of the way of the thing it is
    // pointing at.
    map.on("dragstart", () => placeSearch.collapse());
    startPolling();
    installQueueFlush();

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
