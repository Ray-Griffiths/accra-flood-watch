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
import { matchByLevel } from "./levels.ts";
import { registerRiskPatterns } from "./patterns.ts";

const RISK_SOURCE = "risk-cells";
const REPORTS_SOURCE = "flood-reports";

export const RISK_LAYERS = {
  fill: "risk-fill",
  pattern: "risk-pattern",
  outline: "risk-outline",
  label: "risk-label",
} as const;

/** Labels use the basemap's own font stack; anything else renders as blank. */
const FONT_BOLD = ["Amazon Ember Bold", "Noto Sans Bold"];

type Bbox = [number, number, number, number];

export interface MapHandles {
  map: MapLibreMap;
  setRisk(cells: RiskCell[]): void;
  setReports(reports: FloodReport[]): void;
  viewportBbox(): Bbox;
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

export function createMap(
  container: HTMLElement,
  styleUrl: string,
  apiKey: string,
  pilotBbox: Bbox,
  centre: [number, number],
): MapLibreMap {
  const [west, south, east, north] = pilotBbox;

  const map = new MapLibreMap({
    container,
    style: styleUrl,
    center: centre,
    zoom: 14,
    minZoom: 11,
    maxZoom: 18,
    // Keeps the user inside the area the terrain grid actually covers, with
    // enough slack to see where the pilot area ends.
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
export function installOverlays(map: MapLibreMap): MapHandles {
  registerRiskPatterns(map);

  if (!map.getSource(RISK_SOURCE)) {
    map.addSource(RISK_SOURCE, { type: "geojson", data: emptyCollection() });
  }
  if (!map.getSource(REPORTS_SOURCE)) {
    map.addSource(REPORTS_SOURCE, { type: "geojson", data: emptyCollection() });
  }

  const beforeId = firstSymbolLayerId(map);

  if (!map.getLayer(RISK_LAYERS.fill)) {
    map.addLayer(
      {
        id: RISK_LAYERS.fill,
        type: "fill",
        source: RISK_SOURCE,
        paint: {
          "fill-color": matchByLevel((s) => s.colour, "#2b83ba") as never,
          "fill-opacity": matchByLevel((s) => s.opacity, 0.25) as never,
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
          "fill-pattern": matchByLevel((s) => s.pattern, "risk-dots") as never,
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
          "line-color": matchByLevel((s) => s.colour, "#2b83ba") as never,
          "line-width": matchByLevel((s) => s.outlineWidth, 0.5) as never,
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
        "text-field": ["get", "levelLabel"],
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

  // Reports sit above everything, including labels. They are the most
  // current thing on the map and outrank the model.
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
    viewportBbox: () => {
      const b = map.getBounds();
      return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
    },
  };
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
        level: cell.level,
        levelLabel: levelWord(cell.level),
        score: cell.score,
        basis: cell.basis,
        explanation: cell.explanation,
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
