import { describe, expect, it } from "vitest";
import { generateFloor, MAP_H, MAP_W } from "./floor.js";
import { buildNav, findPath, nearestWalkable } from "./guild-nav.js";

const layout = (n: number, seed: number) => {
  const f = generateFloor(n, seed);
  return JSON.stringify([f.start, f.exit, f.zones, f.props.length, f.mobs.map((m) => [m.kind, m.x, m.y])]);
};

describe("floor generator", () => {
  it("is big", () => {
    const f = generateFloor(1);
    expect([f.w, f.h]).toEqual([MAP_W, MAP_H]);
    expect(f.w * f.h).toBeGreaterThan(64 * 44 * 2);
  });

  it("gives the same map for the same floor and seed, so a room can share one", () => {
    expect(layout(5, 1234)).toBe(layout(5, 1234));
  });

  it("gives a different map for a different seed", () => {
    const seen = new Set([1, 2, 3, 4, 5, 6].map((s) => layout(5, s)));
    expect(seen.size).toBe(6);
  });

  it("always has a walkable way from the entry to the exit, whatever the seed", () => {
    for (const n of [1, 10, 25, 40]) {
      for (const seed of [0, 1, 2, 3, 4, 5, 6, 7]) {
        const f = generateFloor(n, seed), nav = buildNav(f.nav);
        const path = findPath(nav, nearestWalkable(nav, f.start[0] + 1, f.start[1]), nearestWalkable(nav, f.exit[0] - 1, f.exit[1]));
        expect(path.length, `floor ${n} seed ${seed}`).toBeGreaterThan(0);
      }
    }
  });

  it("keeps floor 1's bat and the boss on boss floors", () => {
    expect(generateFloor(1, 77).mobs.some((m) => m.kind === "bat")).toBe(true);
    expect(generateFloor(10, 77).mobs.some((m) => m.boss)).toBe(true);
  });
});
