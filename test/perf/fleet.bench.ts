/**
 * FleetView renders on every TUI frame; measure rendering and timer updates separately.
 * Dispose only after sampling: teardown between warmup and sampling unregisters the widget.
 */
import { afterAll, bench, describe } from "vitest";
import { FleetList } from "../../src/ui/fleet-list.js";
import { makeFleet, mountFleet } from "../helpers/perf-fixtures.js";

/** Fleet sizes: one agent, a normal fan-out, and a pathological one. */
const SIZES = [1, 10, 100];

/** Everything mounted here, torn down once at the end (FleetList holds a timer). */
const mounted: { dispose: () => void }[] = [];
function track<T extends { dispose: () => void }>(m: T): T {
  mounted.push(m);
  return m;
}
afterAll(() => {
  for (const m of mounted) m.dispose();
});

describe("FleetList.render (per TUI frame, below the editor)", () => {
  for (const n of SIZES) {
    const f = track(mountFleet(FleetList, makeFleet({ running: n })));
    bench(`${n} agents`, () => {
      f.render(120);
    });
  }
});

describe("FleetList.update (200ms timer)", () => {
  for (const n of SIZES) {
    const f = track(mountFleet(FleetList, makeFleet({ running: n })));
    bench(`${n} agents`, () => {
      f.update();
    });
  }
});
