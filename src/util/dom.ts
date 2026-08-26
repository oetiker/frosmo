/** Tiny DOM helpers. No framework: the whole UI is five screens and a canvas. */

type Attrs = Record<string, string | number | boolean | EventListener | undefined>;
type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  return build(document.createElement(tag), attrs, children);
}

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * The same, for SVG.
 *
 * Worth the extra namespace dance where colour has to survive a print job:
 * browsers drop background colours from print output unless the user ticks
 * "background graphics", but the fill of a drawn shape is content and always
 * comes out.
 */
export function s<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): SVGElementTagNameMap[K] {
  return build(document.createElementNS(SVG_NS, tag), attrs, children);
}

function build<E extends Element>(el: E, attrs: Attrs, children: Child[]): E {
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === "html") {
      el.innerHTML = String(value);
    } else {
      // Not el.className: on an SVG element that property is read-only.
      el.setAttribute(key, String(value));
    }
  }

  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(typeof child === "string" ? document.createTextNode(child) : child);
  }

  return el;
}

export function clear(el: HTMLElement): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/**
 * Size a canvas to its CSS box at the device pixel ratio.
 *
 * Capped at 2: an iPad Pro reports 2 anyway, and uncapped this quietly
 * quadruples the fill cost on any future device that reports 3.
 */
export function fitCanvas(canvas: HTMLCanvasElement): { w: number; h: number; dpr: number } {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));

  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }

  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w, h, dpr };
}

/** Keep the screen awake during play, where supported. Silent when not. */
export async function requestWakeLock(): Promise<WakeLockSentinel | null> {
  try {
    const nav = navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<WakeLockSentinel> } };
    return (await nav.wakeLock?.request("screen")) ?? null;
  } catch {
    return null;
  }
}

/**
 * Blit an RGBA buffer into a canvas at 1:1.
 *
 * Goes through createImageData and a set() rather than `new ImageData(view)`:
 * the buffer we hold may be a view onto anything, and the ImageData
 * constructor insists on a plain ArrayBuffer.
 */
export function putRgba(
  canvas: HTMLCanvasElement,
  data: Uint8ClampedArray,
  w: number,
  h: number,
): void {
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(w, h);
  img.data.set(data);
  ctx.putImageData(img, 0, 0);
}
