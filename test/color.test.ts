import { describe, expect, it } from "vitest";
import { classifyColor, hueDistance, rgbToHsv } from "../src/vision/color.js";

describe("rgbToHsv", () => {
  it("converts the primaries", () => {
    expect(rgbToHsv(255, 0, 0)).toMatchObject({ h: 0, s: 1, v: 1 });
    expect(rgbToHsv(0, 255, 0).h).toBeCloseTo(120, 6);
    expect(rgbToHsv(0, 0, 255).h).toBeCloseTo(240, 6);
  });

  it("reports zero saturation for greys", () => {
    expect(rgbToHsv(128, 128, 128).s).toBe(0);
    expect(rgbToHsv(0, 0, 0)).toMatchObject({ s: 0, v: 0 });
  });
});

describe("classifyColor", () => {
  const named = (r: number, g: number, b: number, palette?: Parameters<typeof classifyColor>[3]) =>
    classifyColor(r, g, b, palette ?? {})!;

  it("names saturated tokens", () => {
    expect(named(220, 30, 30).color).toBe("red");
    expect(named(240, 140, 20).color).toBe("orange");
    expect(named(40, 170, 60).color).toBe("green");
    expect(named(40, 90, 220).color).toBe("blue");
    expect(named(140, 60, 200).color).toBe("purple");
  });

  it("declines a sample with no colour in it", () => {
    // Paper, the tiles' own faces, a shadow on the table. Every blob occupancy
    // finds is asked this question, and under a printed sheet most of them are
    // the sheet — a classifier obliged to answer calls all of them white, at
    // high confidence, because they genuinely are.
    expect(classifyColor(245, 244, 246)).toBeNull();
    expect(classifyColor(225, 227, 221)).toBeNull(); // measured from the rig
    expect(classifyColor(120, 122, 118)).toBeNull();
    expect(classifyColor(20, 18, 24)).toBeNull();
  });

  it("names them when a caller says it might see them", () => {
    // They are real colours; they are just never assumed.
    expect(named(245, 244, 246, { palette: ["red", "white"] }).color).toBe("white");
    expect(named(120, 122, 118, { palette: ["grey"] }).color).toBe("grey");
    expect(named(20, 18, 24, { palette: ["black"] }).color).toBe("black");
  });

  it("survives the dimming a token gets at the far edge of the play area", () => {
    // Same hue, half the brightness: still the same token colour.
    expect(named(110, 15, 15).color).toBe("red");
    expect(named(20, 85, 30).color).toBe("green");
  });

  it("reports low confidence exactly between two buckets", () => {
    const between = named(...hueRgb(42));
    expect(["orange", "yellow"]).toContain(between.color);
    expect(between.confidence).toBeLessThan(0.25);

    const dead = named(...hueRgb(120));
    expect(dead.color).toBe("green");
    expect(dead.confidence).toBeGreaterThan(0.9);
  });

  it("restricts to a game's palette when asked", () => {
    expect(named(240, 140, 20, { palette: ["red", "blue"] }).color).toBe("red");
  });
});

describe("hueDistance", () => {
  it("wraps around the colour wheel", () => {
    expect(hueDistance(350, 10)).toBe(20);
    expect(hueDistance(10, 350)).toBe(20);
    expect(hueDistance(0, 180)).toBe(180);
  });
});

/** Fully saturated, full value RGB for a hue. */
function hueRgb(h: number): [number, number, number] {
  const c = 255;
  const x = Math.round(c * (1 - Math.abs(((h / 60) % 2) - 1)));
  if (h < 60) return [c, x, 0];
  if (h < 120) return [x, c, 0];
  if (h < 180) return [0, c, x];
  if (h < 240) return [0, x, c];
  if (h < 300) return [x, 0, c];
  return [c, 0, x];
}
