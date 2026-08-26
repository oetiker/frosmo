import { describe, expect, it } from "vitest";
import { Stabiliser } from "../src/vision/stability.js";

const obs = (key: string, x: number, y: number) => ({ key, x, y, value: key });

describe("Stabiliser", () => {
  it("withholds a detection until it has been seen consistently", () => {
    const s = new Stabiliser<string>({ promoteAfter: 3, radius: 10 });
    s.update([obs("A", 10, 10)]);
    expect(s.stable()).toHaveLength(0);
    s.update([obs("A", 11, 10)]);
    expect(s.stable()).toHaveLength(0);
    s.update([obs("A", 10, 11)]);
    expect(s.stable().map((t) => t.key)).toEqual(["A"]);
  });

  it("keeps a stable detection alive through a brief occlusion", () => {
    const s = new Stabiliser<string>({ promoteAfter: 2, forgetAfter: 3, radius: 10 });
    s.update([obs("A", 10, 10)]);
    s.update([obs("A", 10, 10)]);
    expect(s.stable()).toHaveLength(1);

    s.update([]);
    s.update([]);
    expect(s.stable()).toHaveLength(1);
  });

  it("drops a detection that stays away", () => {
    const s = new Stabiliser<string>({ promoteAfter: 2, forgetAfter: 2, radius: 10 });
    for (let i = 0; i < 6; i++) s.update([obs("A", 10, 10)]);
    for (let i = 0; i < 12; i++) s.update([]);
    expect(s.update([])).toHaveLength(0);
  });

  it("never promotes something that only flickers", () => {
    const s = new Stabiliser<string>({ promoteAfter: 4, forgetAfter: 3, radius: 10 });
    for (let i = 0; i < 10; i++) {
      s.update(i % 2 === 0 ? [obs("A", 10, 10)] : []);
      expect(s.stable()).toHaveLength(0);
    }
  });

  it("follows a token as it slides, without duplicating it", () => {
    const s = new Stabiliser<string>({ promoteAfter: 2, radius: 12, smoothing: 1 });
    for (let x = 10; x <= 50; x += 8) s.update([obs("A", x, 20)]);
    const tracked = s.stable();
    expect(tracked).toHaveLength(1);
    expect(tracked[0].x).toBeCloseTo(50, 5);
  });

  it("treats a jump beyond the radius as a different thing", () => {
    const s = new Stabiliser<string>({ promoteAfter: 1, radius: 10 });
    s.update([obs("A", 10, 10)]);
    const tracked = s.update([obs("A", 90, 90)]);
    expect(tracked).toHaveLength(2);
  });

  it("does not confuse two different characters at the same spot", () => {
    const s = new Stabiliser<string>({ promoteAfter: 1, radius: 20 });
    const tracked = s.update([obs("A", 10, 10), obs("B", 12, 11)]);
    expect(tracked.map((t) => t.key).sort()).toEqual(["A", "B"]);
  });

  it("smooths jitter rather than following it", () => {
    const s = new Stabiliser<string>({ promoteAfter: 1, radius: 20, smoothing: 0.3 });
    s.update([obs("A", 10, 10)]);
    s.update([obs("A", 20, 10)]);
    expect(s.stable()[0].x).toBeLessThan(15);
  });
});
