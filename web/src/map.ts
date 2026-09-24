/**
 * The map, the risk overlay and the report markers.
 *
 * Two things here are load-bearing rather than incidental:
 *
 * 1. Every Amazon Location request is rewritten to this origin so it travels
 *    through CloudFront and hits the long-lived tile cache. The style
 *    descriptor hands back absolute `maps.geo.<region>.amazonaws.com` URLs for
 *    tiles, glyphs and sprites; left alone they would bypass the cache
 *    entirely, and tile requests are the dominant cost of this system at any
 *    real usage. This rewrite is the cost control.
 *
 * 2. The risk overlay is inserted *below* the basemap's label layers, so
 *    street names stay readable through it. A risk overlay that hides the
 *    street you are trying to identify has defeated its own purpose.
 */

import {
  GeolocateControl,
  Map as MapLibreMap,
  NavigationControl,
  ScaleControl,
  type GeoJSONSource,
} from "maplibre-gl";
import type { FeatureCollection } from "geojson";

import type { FloodReport, RiskCell } from "./api.ts";
import { colourFor, matchByView, type MapView } from "./levels.ts";
import { registerRiskPatterns } from "./patterns.ts";
import type { Theme } from "./theme.ts";

const RISK_SOURCE = "risk-cells";
const REPORTS_SOURCE = "flood-reports";
const ROUTE_SOURCE = "safe-route";
const ROUTE_POINTS_SOURCE = "route-points";
const SEARCH_PIN_SOURCE = "search-pin";

export const RISK_LAYERS = {
  fill: "risk-fill",
  pattern: "risk-pattern",
  outline: "risk-outline",
  label: "risk-label",
} as const;

/** Labels use the basemap's own font stack; anything else renders as blank. */
const FONT_BOLD = ["Amazon Ember Bold", "Noto Sans Bold"];

/**
 * How much of the map each edge's chrome covers.
 *
 * Every camera move has to be told, or a pin flown to the centre lands under
 * the reading card and the feature looks broken rather than occluded. The
 * numbers mirror the overlay offsets in styles.css; if those change, these do.
 *
 * Measured at 390x844: the navbar occupies y=0 to y=56, the disclaimer starts
 * at y=779, and the gauge rail occupies x=266 to x=378. `right` is 124 rather
 * than the 90 the design preview used, because the rail was widened to 112px
 * to keep its labels at 12px without wrapping them to three lines.
 *
 * `top` is 260, taken from the reading card's TALLEST state rather than its
 * usual one: in English the card ends at y~215, but in Twi or Ga the
 * draft-translation notice runs to three lines and pushes it to y~249. Sizing
 * this to the common case would hide a searched pin for exactly the users
 * already reading the app in a second language.
 */
export const MAP_PADDING = { top: 260, bottom: 130, left: 16, right: 124 } as const;

// Shared with the pre-map viewport maths so the two cannot disagree.
import { type Bbox } from "./viewport.ts";
export type { Bbox };

/** A calculated route, ready to draw. */
export interface DrawnRoute {
  coordinates: Array<[number, number]>;
  origin: [number, number];
  destination: [number, number];
}

export interface MapHandles {
  map: MapLibreMap;
  setRisk(cells: RiskCell[]): void;
  setReports(reports: FloodReport[]): void;
  /** Repaint the overlay in the other vocabulary. Data is not re-fetched. */
  setView(view: MapView): void;
  /** Recolour the overlay in place. Patterns are re-registered, not repainted. */
  setTheme(theme: Theme): void;
  /** Draw a route, or clear it with null. */
  setRoute(route: DrawnRoute | null): void;
  /** Frame a route so both ends are on screen at once. */
  frameRoute(route: DrawnRoute): void;
  /**
   * Mark a searched place and move to it, or clear the mark with null.
   *
   * The pin is the point of the search feature as much as the answer is:
   * geocoding Accra returns the wrong junction often enough that the user has
   * to be shown WHERE the reading applies before trusting it.
   */
  setSearchPin(place: { longitude: number; latitude: number; title: string } | null): void;
  viewportBbox(): Bbox;
  /** Current zoom, so the caller can decide whether the overlay is meaningful. */
  zoom(): number;
}

/**
 * Route an Amazon Location URL back through this origin.
 *
 * Also guarantees the API key rides along: the descriptor omits it from glyph
 * and sprite URLs, which would otherwise be rejected.
 */
function sameOriginLocationUrl(url: string, key: string): string | null {
  if (!/^https:\/\/maps\.geo\.[a-z0-9-]+\.amazonaws\.com\//.test(url)) return null;

  const source = new URL(url);
  const rewritten = new URL(source.pathname + source.search, window.location.origin);
  if (!rewritten.searchParams.has("key")) {
    rewritten.searchParams.set("key", key);
  }
  return rewritten.toString();
}

/**
 * Opening zoom.
 *
 * Exported because the first risk request is computed for this zoom before
 * the map exists. If the two ever disagreed, the opening fetch would ask for
 * a different box from the one drawn.
 */
export const DEFAULT_ZOOM = 14;

export function createMap(
  container: HTMLElement,
  styleUrl: string,
  apiKey: string,
  /** Framing only: the envelope around every covered area. */
  envelope: Bbox,
  centre: [number, number],
): MapLibreMap {
  const [west, south, east, north] = envelope;

  const map = new MapLibreMap({
    container,
    style: styleUrl,
    center: centre,
    zoom: DEFAULT_ZOOM,
    minZoom: 11,
    maxZoom: 18,
    // Keeps the user near the ground the terrain grid actually covers, with
    // enough slack to see where coverage ends. Slack only -- the risk overlay
    // itself is drawn from the areas, so panning into the margin shows the
    // basemap and no overlay, which is the honest picture.
    maxBounds: [
      [west - 0.05, south - 0.05],
      [east + 0.05, north + 0.05],
    ],
    attributionControl: { compact: true },
    // A phone in the rain does not want to accidentally tilt the map.
    pitchWithRotate: false,
    dragRotate: false,
    transformRequest: (url: string) => {
      const rewritten = sameOriginLocationUrl(url, apiKey);
      return rewritten ? { url: rewritten } : { url };
    },
  });

  map.addControl(new NavigationControl({ showCompass: false }), "top-right");
  map.addControl(
    new GeolocateControl({
      positionOptions: { enableHighAccuracy: true },
      trackUserLocation: true,
    }),
    "top-right",
  );
  map.addControl(new ScaleControl({ maxWidth: 100, unit: "metric" }), "bottom-left");

  return map;
}

/**
 * Amazon Location serves a dark variant of the same style from the same
 * endpoint. Verified against the live stack: `color-scheme=Light` is
 * byte-identical to omitting the parameter, and `Dark` returns a genuinely
 * different descriptor with the same 160 layers.
 *
 * `color-scheme` is already in the TileCachePolicy query-string whitelist in
 * template.yaml, so the two variants get separate cache keys instead of
 * colliding. This needs no backend or CloudFormation change.
 */
export function styleUrlForTheme(styleUrl: string, theme: Theme): string {
  const separator = styleUrl.includes("?") ? "&" : "?";
  return `${styleUrl}${separator}color-scheme=${theme === "dark" ? "Dark" : "Light"}`;
}

/**
 * `setStyle` drops every source AND every registered image, which is why
 * `installOverlays` has always been written to be callable twice. The camera
 * is captured and restored explicitly: setStyle only preserves it when it
 * judges the new style compatible, and relying on that is how a theme switch
 * silently recentres the map.
 */
export function applyBasemapTheme(
  map: MapLibreMap,
  styleUrl: string,
  theme: Theme,
  reinstall: () => void,
): void {
  const camera = {
    center: map.getCenter(),
    zoom: map.getZoom(),
    bearing: map.getBearing(),
    pitch: map.getPitch(),
  };

  map.once("styledata", () => {
    reinstall();
    map.jumpTo(camera);
  });

  map.setStyle(styleUrlForTheme(styleUrl, theme));
}

/** The id of the first symbol layer, so the overlay slots in beneath labels. */
function firstSymbolLayerId(map: MapLibreMap): string | undefined {
  return map.getStyle()?.layers?.find((layer) => layer.type === "symbol")?.id;
}

function emptyCollection(): FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

/**
 * Add the overlay sources and layers. Called once the style is ready, and
 * again if the style ever reloads (which drops both sources and images).
 */
export function installOverlays(map: MapLibreMap, theme: Theme): MapHandles {
  let activeTheme: Theme = theme;
  let currentView: MapView = "now";
  registerRiskPatterns(map, activeTheme);

  if (!map.getSource(RISK_SOURCE)) {
    map.addSource(RISK_SOURCE, { type: "geojson", data: emptyCollection() });
  }
  if (!map.getSource(REPORTS_SOURCE)) {
    map.addSource(REPORTS_SOURCE, { type: "geojson", data: emptyCollection() });
  }
  if (!map.getSource(ROUTE_SOURCE)) {
    map.addSource(ROUTE_SOURCE, { type: "geojson", data: emptyCollection() });
  }
  if (!map.getSource(ROUTE_POINTS_SOURCE)) {
    map.addSource(ROUTE_POINTS_SOURCE, { type: "geojson", data: emptyCollection() });
  }

  if (!map.getSource(SEARCH_PIN_SOURCE)) {
    map.addSource(SEARCH_PIN_SOURCE, { type: "geojson", data: emptyCollection() });
  }

  const beforeId = firstSymbolLayerId(map);

  if (!map.getLayer(RISK_LAYERS.fill)) {
    map.addLayer(
      {
        id: RISK_LAYERS.fill,
        type: "fill",
        source: RISK_SOURCE,
        paint: {
          "fill-color": matchByView("now", (s) => colourFor(s, activeTheme), "#5b8ca6") as never,
          "fill-opacity": matchByView("now", (s) => s.opacity, 0.25) as never,
        },
      },
      beforeId,
    );
  }

  // The shape channel. Sits over the flat fill so both are visible at once:
  // colour for people who can use it, texture for people who cannot.
  if (!map.getLayer(RISK_LAYERS.pattern)) {
    map.addLayer(
      {
        id: RISK_LAYERS.pattern,
        type: "fill",
        source: RISK_SOURCE,
        paint: {
          "fill-pattern": matchByView("now", (s) => s.pattern, "risk-dots") as never,
          "fill-opacity": 0.55,
        },
      },
      beforeId,
    );
  }

  if (!map.getLayer(RISK_LAYERS.outline)) {
    map.addLayer(
      {
        id: RISK_LAYERS.outline,
        type: "line",
        source: RISK_SOURCE,
        paint: {
          "line-color": matchByView("now", (s) => colourFor(s, activeTheme), "#5b8ca6") as never,
          "line-width": matchByView("now", (s) => s.outlineWidth, 0.5) as never,
          "line-opacity": 0.9,
        },
      },
      beforeId,
    );
  }

  // The word. Third independent channel, and the one that survives a
  // screenshot, a photocopy, or a phone in direct sunlight.
  if (!map.getLayer(RISK_LAYERS.label)) {
    map.addLayer({
      id: RISK_LAYERS.label,
      type: "symbol",
      source: RISK_SOURCE,
      // Only once cells are big enough for the word to fit inside one.
      minzoom: 15.5,
      layout: {
        "text-field": ["get", "nowLabel"],
        "text-font": FONT_BOLD,
        "text-size": 11,
        "text-allow-overlap": false,
        "text-ignore-placement": false,
      },
      paint: {
        "text-color": "#1b1b1b",
        "text-halo-color": "#ffffff",
        "text-halo-width": 1.6,
      },
    });
  }

  // The route sits above the risk overlay -- it is the answer to a question
  // the user just asked, and it has to be followable across cells of every
  // colour. A white casing under the line keeps it legible over a dark red
  // fill as well as over a pale one.
  if (!map.getLayer("route-casing")) {
    map.addLayer({
      id: "route-casing",
      type: "line",
      source: ROUTE_SOURCE,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#ffffff", "line-width": 10, "line-opacity": 0.95 },
    });
  }

  if (!map.getLayer("route-line")) {
    map.addLayer({
      id: "route-line",
      type: "line",
      source: ROUTE_SOURCE,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#0b3d5c", "line-width": 5 },
    });
  }

  if (!map.getLayer("route-endpoints")) {
    map.addLayer({
      id: "route-endpoints",
      type: "circle",
      source: ROUTE_POINTS_SOURCE,
      paint: {
        "circle-radius": 8,
        "circle-color": ["match", ["get", "role"], "destination", "#0b3d5c", "#ffffff"],
        "circle-stroke-color": "#0b3d5c",
        "circle-stroke-width": 3,
      },
    });
  }

  // The search pin sits above the overlay and the route. It answers "which
  // place is this reading about", so anything covering it defeats it.
  if (!map.getLayer("search-pin")) {
    map.addLayer({
      id: "search-pin",
      type: "circle",
      source: SEARCH_PIN_SOURCE,
      paint: {
        "circle-radius": 10,
        "circle-color": "#ffffff",
        "circle-stroke-color": "#0b3d5c",
        "circle-stroke-width": 4,
      },
    });
  }

  if (!map.getLayer("search-pin-label")) {
    map.addLayer({
      id: "search-pin-label",
      type: "symbol",
      source: SEARCH_PIN_SOURCE,
      layout: {
        "text-field": ["get", "title"],
        "text-font": FONT_BOLD,
        "text-size": 13,
        "text-offset": [0, 1.4],
        "text-anchor": "top",
        "text-max-width": 12,
      },
      paint: {
        "text-color": "#0b3d5c",
        "text-halo-color": "#ffffff",
        "text-halo-width": 2,
      },
    });
  }

  // Reports sit above everything, including labels and the route. They are the
  // most current thing on the map and outrank the model.
  if (!map.getLayer("reports-halo")) {
    map.addLayer({
      id: "reports-halo",
      type: "circle",
      source: REPORTS_SOURCE,
      paint: {
        "circle-radius": 14,
        "circle-color": "#6b0000",
        "circle-opacity": 0.18,
      },
    });
  }

  if (!map.getLayer("reports-dot")) {
    map.addLayer({
      id: "reports-dot",
      type: "circle",
      source: REPORTS_SOURCE,
      paint: {
        "circle-radius": 7,
        "circle-color": "#6b0000",
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 2.5,
      },
    });
  }

  if (!map.getLayer("reports-label")) {
    map.addLayer({
      id: "reports-label",
      type: "symbol",
      source: REPORTS_SOURCE,
      layout: {
        "text-field": ["get", "depthLabel"],
        "text-font": FONT_BOLD,
        "text-size": 12,
        "text-offset": [0, 1.4],
        "text-anchor": "top",
        "text-allow-overlap": false,
      },
      paint: {
        "text-color": "#6b0000",
        "text-halo-color": "#ffffff",
        "text-halo-width": 2,
      },
    });
  }

  const setData = (id: string, data: FeatureCollection): void => {
    const source = map.getSource(id);
    if (source && "setData" in source) {
      (source as GeoJSONSource).setData(data);
    }
  };

  return {
    map,
    setRisk: (cells) => setData(RISK_SOURCE, riskCollection(cells)),
    setReports: (reports) => setData(REPORTS_SOURCE, reportCollection(reports)),
    setView: (view) => {
      currentView = view;
      applyView(map, view, activeTheme);
    },
    setTheme: (next) => {
      activeTheme = next;
      registerRiskPatterns(map, activeTheme);
      applyView(map, currentView, activeTheme);
    },
    setRoute: (route) => {
      setData(ROUTE_SOURCE, route ? routeCollection(route) : emptyCollection());
      setData(ROUTE_POINTS_SOURCE, route ? routePointCollection(route) : emptyCollection());
    },
    frameRoute: (route) => {
      const lons = route.coordinates.map(([lon]) => lon);
      const lats = route.coordinates.map(([, lat]) => lat);
      map.fitBounds(
        [
          [Math.min(...lons), Math.min(...lats)],
          [Math.max(...lons), Math.max(...lats)],
        ],
        // The chrome insets, with a deeper floor: the route sheet opens over
        // the bottom of the map, and a route that ends underneath it has not
        // been shown. The other three edges come from MAP_PADDING so the
        // gauge rail is accounted for here too -- at the old right: 40 the
        // end of an eastbound route sat behind it.
        { padding: { ...MAP_PADDING, bottom: 220 }, duration: 600 },
      );
    },
    setSearchPin: (place) => {
      if (!place) {
        setData(SEARCH_PIN_SOURCE, emptyCollection());
        return;
      }

      setData(SEARCH_PIN_SOURCE, {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: [place.longitude, place.latitude] },
            properties: { title: place.title },
          },
        ],
      });

      // Zoom in far enough that the risk overlay is drawn -- arriving at a
      // place with no cells painted would answer the question with a blank.
      // `padding` replaces the hand-tuned `offset: [0, -60]` that used to lift
      // the target above the old action bar. The offset only knew about the
      // bottom; the insets know about the reading card and the rail as well,
      // so a pin now lands in the band that is actually visible.
      map.flyTo({
        center: [place.longitude, place.latitude],
        zoom: Math.max(map.getZoom(), 16),
        padding: MAP_PADDING,
        duration: 800,
      });
    },
    viewportBbox: () => {
      const b = map.getBounds();
      return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
    },
    zoom: () => map.getZoom(),
  };
}

/**
 * Repaint the overlay in the other vocabulary.
 *
 * Both readings already ride on every feature, so this is a paint change and
 * nothing more — no refetch, no source swap, no second set of layers. That is
 * the reason the switch can be instant on a phone with a bad connection, which
 * is the only condition under which it matters.
 */
function applyView(map: MapLibreMap, view: MapView, theme: Theme): void {
  if (!map.getLayer(RISK_LAYERS.fill)) return;

  map.setPaintProperty(
    RISK_LAYERS.fill,
    "fill-color",
    matchByView(view, (s) => colourFor(s, theme), "#5b8ca6") as never,
  );
  map.setPaintProperty(
    RISK_LAYERS.fill,
    "fill-opacity",
    matchByView(view, (s) => s.opacity, 0.25) as never,
  );
  map.setPaintProperty(
    RISK_LAYERS.pattern,
    "fill-pattern",
    matchByView(view, (s) => s.pattern, "risk-dots") as never,
  );
  map.setPaintProperty(
    RISK_LAYERS.outline,
    "line-color",
    matchByView(view, (s) => colourFor(s, theme), "#5b8ca6") as never,
  );
  map.setPaintProperty(
    RISK_LAYERS.outline,
    "line-width",
    matchByView(view, (s) => s.outlineWidth, 0.5) as never,
  );
  map.setLayoutProperty(RISK_LAYERS.label, "text-field", [
    "get",
    view === "terrain" ? "terrainLabel" : view === "later" ? "laterLabel" : "nowLabel",
  ] as never);

  // Reports are observations, not model output. They stay visible in both
  // views: somebody standing in water is the most current thing on this map
  // whichever question the user is asking of it.
}

function riskCollection(cells: RiskCell[]): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: cells.map((cell) => ({
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [cell.bounds.west, cell.bounds.south],
            [cell.bounds.east, cell.bounds.south],
            [cell.bounds.east, cell.bounds.north],
            [cell.bounds.west, cell.bounds.north],
            [cell.bounds.west, cell.bounds.south],
          ],
        ],
      },
      properties: {
        cell: cell.cell,
        // Both readings ride on every feature so the view can be switched
        // without a second request.
        level: cell.level,
        nowLabel: levelWord(cell.level),
        // Empty string rather than a level when the forecast feed was down,
        // so the later view paints nothing instead of painting calm.
        levelLater: cell.levelLater ?? "",
        laterLabel: cell.levelLater ? levelWord(cell.levelLater) : "",
        terrainBand: cell.terrainBand ?? "",
        terrainLabel: terrainWord(cell.terrainBand),
        score: cell.score,
        basis: cell.basis,
        explanation: cell.explanation,
        terrainExplanation: cell.terrainExplanation ?? "",
        hand: cell.hand,
        susceptibility: cell.susceptibility,
        historicalFloodPoint: cell.historicalFloodPoint ?? "",
        updatedAt: cell.updatedAt ?? "",
      },
    })),
  };
}

/** Duplicated from levels.ts deliberately: the map needs a plain string. */
function levelWord(level: string): string {
  switch (level) {
    case "confirmed":
      return "FLOODED";
    case "high":
      return "HIGH";
    case "watch":
      return "WATCH";
    default:
      return "LOW";
  }
}

/**
 * The terrain word shown inside a cell.
 *
 * Phrased about the ground rather than about today, so a screenshot of the
 * terrain view can never be mistaken for a warning that was issued.
 */
function terrainWord(band: string | undefined): string {
  switch (band) {
    case "floods-first":
      return "FLOODS FIRST";
    case "floods-heavy":
      return "HEAVY RAIN";
    case "usually-dry":
      return "USUALLY DRY";
    default:
      return "";
  }
}

function routeCollection(route: DrawnRoute): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "LineString", coordinates: route.coordinates },
        properties: {},
      },
    ],
  };
}

function routePointCollection(route: DrawnRoute): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: route.origin },
        properties: { role: "origin" },
      },
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: route.destination },
        properties: { role: "destination" },
      },
    ],
  };
}

function reportCollection(reports: FloodReport[]): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: reports.map((report) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [report.longitude, report.latitude] },
      properties: {
        cell: report.cell,
        depth: report.depth,
        depthLabel: report.depthLabel,
        ageLabel: report.ageLabel,
        submittedAt: report.submittedAt,
      },
    })),
  };
}
