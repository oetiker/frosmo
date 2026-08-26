/**
 * Persistence.
 *
 * Everything the app remembers goes through here: calibration, settings, high
 * scores. Two reasons for the indirection. Safari in private mode throws on
 * localStorage writes, and an unhandled quota error during calibration would
 * lose the one piece of state that is genuinely annoying to recreate. And this
 * is the seam where a syncer — krptk, next door — would later attach to carry
 * progress between a family's devices without this app growing a backend.
 */

const PREFIX = "frosmo:";

export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function remove(key: string): void {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    /* nothing sensible to do */
  }
}
