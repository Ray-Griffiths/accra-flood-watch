/**
 * Fill patterns for the risk overlay, drawn to a canvas at load time.
 *
 * This is the "shape" half of the shape-and-label-as-well-as-colour rule.
 * Generating them here rather than shipping four PNGs keeps the bundle small
 * and means the pattern stays crisp on a high-density phone screen, which is
 * what almost every user will be holding.
 */

import type { Map as MapLibreMap } from "maplibre-gl";

import { LEVEL_STYLES, RISK_LEVELS, TERRAIN_BANDS, TERRAIN_STYLES, type LevelStyle } from "./levels.ts";

/** Drawn at 2x and registered with pixelRatio 2, so it is sharp on retina. */
const TILE = 16;
const SCALE = 2;

type PatternKind =
  | "dots"
  | "hatch"
  | "cross"
  | "solid"
  | "bands-sparse"
  | "bands-medium"
  | "bands-dense";

const PATTERN_KIND: Record<string, PatternKind> = {
  "risk-dots": "dots",
  "risk-hatch": "hatch",
  "risk-cross": "cross",
  "risk-solid": "solid",
  // Horizontal rather than diagonal: the terrain view has to be unmistakable
  // as a different kind of statement, and level lines are what ground and
  // standing water both look like.
  "terrain-sparse": "bands-sparse",
  "terrain-medium": "bands-medium",
  "terrain-dense": "bands-dense",
};

/** Gap between bands, in tile units. Tighter banding reads as worse ground. */
const BAND_SPACING: Record<string, number> = {
  "bands-sparse": 8,
  "bands-medium": 5,
  "bands-dense": 3,
};

function draw(kind: PatternKind, colour: string): ImageData | null {
  const canvas = document.createElement("canvas");
  canvas.width = TILE * SCALE;
  canvas.height = TILE * SCALE;

  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.scale(SCALE, SCALE);
  ctx.strokeStyle = colour;
  ctx.fillStyle = colour;
  ctx.lineCap = "round";

  switch (kind) {
    case "dots":
      // Sparse and quiet. Low risk should not compete for attention.
      ctx.beginPath();
      ctx.arc(TILE / 4, TILE / 4, 1.1, 0, Math.PI * 2);
      ctx.arc((TILE * 3) / 4, (TILE * 3) / 4, 1.1, 0, Math.PI * 2);
      ctx.fill();
      break;

    case "hatch":
      ctx.lineWidth = 2;
      strokeDiagonal(ctx, "forward");
      break;

    case "cross":
      // Two directions read as denser and more urgent than one, before any
      // colour is perceived at all.
      ctx.lineWidth = 2;
      strokeDiagonal(ctx, "forward");
      strokeDiagonal(ctx, "back");
      break;

    case "solid":
      ctx.fillRect(0, 0, TILE, TILE);
      break;

    case "bands-sparse":
    case "bands-medium":
    case "bands-dense":
      ctx.lineWidth = 1.5;
      strokeBands(ctx, BAND_SPACING[kind] ?? 6);
      break;
  }

  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

/**
 * Horizontal level lines, drawn on the half-pixel so they stay crisp rather
 * than smearing across two rows.
 */
function strokeBands(ctx: CanvasRenderingContext2D, spacing: number): void {
  ctx.beginPath();
  for (let y = spacing / 2; y < TILE; y += spacing) {
    ctx.moveTo(0, Math.floor(y) + 0.5);
    ctx.lineTo(TILE, Math.floor(y) + 0.5);
  }
  ctx.stroke();
}

/** Draws a tiling diagonal: three passes so the pattern joins across edges. */
function strokeDiagonal(ctx: CanvasRenderingContext2D, direction: "forward" | "back"): void {
  ctx.beginPath();
  for (let offset = -TILE; offset <= TILE; offset += TILE / 2) {
    if (direction === "forward") {
      ctx.moveTo(offset, TILE);
      ctx.lineTo(offset + TILE, 0);
    } else {
      ctx.moveTo(offset, 0);
      ctx.lineTo(offset + TILE, TILE);
    }
  }
  ctx.stroke();
}

/**
 * Register one pattern per risk level and per terrain band with the map.
 *
 * Both vocabularies are registered up front rather than on demand, because
 * switching views must be instant: a user who taps the toggle and waits for a
 * texture to appear has been shown an empty map at the moment they asked a
 * question of it.
 *
 * Safe to call more than once: a style reload drops registered images, so the
 * caller re-runs this on `styledata` rather than tracking it.
 */
export function registerRiskPatterns(map: MapLibreMap): void {
  const styles: LevelStyle[] = [
    ...RISK_LEVELS.map((level) => LEVEL_STYLES[level]),
    ...TERRAIN_BANDS.map((band) => TERRAIN_STYLES[band]),
  ];

  for (const style of styles) {
    if (map.hasImage(style.pattern)) continue;

    const kind = PATTERN_KIND[style.pattern];
    if (!kind) continue;

    const image = draw(kind, style.colour);
    if (!image) continue;

    map.addImage(style.pattern, image, { pixelRatio: SCALE });
  }
}
