import { describe, expect, it, vi } from "vitest";
import {
  NativeRailController,
  placeRestoreInTopBand,
  RAIL_EXPANSION_CAPABILITY,
  resolveRailSide,
  SET_RAIL_EXPANDED,
  supportsNativeRailExpansion,
} from "./rail-logic";

/** A fake native bridge whose requests resolve when the test says so. */
function fakeNative() {
  const calls: Array<{ kind: string; payload: unknown }> = [];
  const pending: Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void }> = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const native = {
    capabilities: ["safe-area", RAIL_EXPANSION_CAPABILITY],
    request: vi.fn((kind: string, payload: unknown) => {
      calls.push({ kind, payload });
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise((resolve, reject) => {
        pending.push({
          resolve: (v) => {
            inFlight -= 1;
            resolve(v);
          },
          reject: (e) => {
            inFlight -= 1;
            reject(e);
          },
        });
      });
    }),
  };
  return {
    native,
    calls,
    get maxInFlight() {
      return maxInFlight;
    },
    /** Resolves the oldest request with null (the shell's success value). */
    async succeed() {
      pending.shift()?.resolve(null);
      await flushMicrotasks();
    },
    async fail(error = new Error("boom")) {
      pending.shift()?.reject(error);
      await flushMicrotasks();
    },
  };
}

async function flushMicrotasks() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

describe("supportsNativeRailExpansion", () => {
  it("needs the capability and a request function", () => {
    expect(supportsNativeRailExpansion(null)).toBe(false);
    expect(supportsNativeRailExpansion({ capabilities: ["safe-area"], request: async () => null })).toBe(false);
    expect(supportsNativeRailExpansion({ capabilities: [RAIL_EXPANSION_CAPABILITY] })).toBe(false);
    expect(
      supportsNativeRailExpansion({ capabilities: [RAIL_EXPANSION_CAPABILITY], request: async () => null }),
    ).toBe(true);
  });
});

describe("NativeRailController transitions", () => {
  it("expands: sends set-rail-expanded true and records native as expanded", async () => {
    const f = fakeNative();
    const c = new NativeRailController(f.native, false);
    const done = c.set(true);
    await flushMicrotasks();
    expect(f.calls).toEqual([{ kind: SET_RAIL_EXPANDED, payload: { expanded: true } }]);
    await f.succeed();
    await done;
    expect(c.nativeExpanded).toBe(true);
  });

  it("restores: after expanding, sends set-rail-expanded false", async () => {
    const f = fakeNative();
    const c = new NativeRailController(f.native, false);
    c.set(true);
    await flushMicrotasks();
    await f.succeed();
    const done = c.set(false);
    await flushMicrotasks();
    expect(f.calls.map((call) => call.payload)).toEqual([{ expanded: true }, { expanded: false }]);
    await f.succeed();
    await done;
    expect(c.nativeExpanded).toBe(false);
  });

  it("serialises: never more than one request in flight, ending at the latest state", async () => {
    const f = fakeNative();
    const c = new NativeRailController(f.native, false);
    c.set(true);
    await flushMicrotasks(); // the expand request is now in flight
    c.set(false);
    c.set(true);
    const last = c.set(false);
    await flushMicrotasks();
    expect(f.calls).toHaveLength(1);
    await f.succeed(); // the first request (true) lands
    await flushMicrotasks();
    // The queued calls collapse to the latest wanted state: one restore.
    expect(f.calls.map((call) => call.payload)).toEqual([{ expanded: true }, { expanded: false }]);
    await f.succeed();
    await last;
    expect(f.maxInFlight).toBe(1);
    expect(c.nativeExpanded).toBe(false);
  });

  it("collapses a burst that nets out to no change into no request", async () => {
    const f = fakeNative();
    const c = new NativeRailController(f.native, false);
    c.set(true);
    await c.set(false);
    expect(f.calls).toHaveLength(0);
  });

  it("skips a request when native already holds the state", async () => {
    const f = fakeNative();
    const c = new NativeRailController(f.native, true);
    await c.set(true);
    expect(f.calls).toHaveLength(0);
  });

  it("reports a failure, forgets the state and retries on the next call", async () => {
    const f = fakeNative();
    const onError = vi.fn();
    const c = new NativeRailController(f.native, false, onError);
    const first = c.set(true);
    await flushMicrotasks();
    await f.fail();
    await first;
    expect(onError).toHaveBeenCalledTimes(1);
    expect(c.nativeExpanded).toBeNull();
    const second = c.set(true);
    await flushMicrotasks();
    expect(f.calls).toHaveLength(2);
    await f.succeed();
    await second;
    expect(c.nativeExpanded).toBe(true);
  });

  it("dispose restores native when the plugin expanded it", async () => {
    const f = fakeNative();
    const c = new NativeRailController(f.native, false);
    c.set(true);
    await flushMicrotasks();
    await f.succeed();
    const done = c.dispose();
    await flushMicrotasks();
    expect(f.calls.at(-1)?.payload).toEqual({ expanded: false });
    await f.succeed();
    await done;
    // No new requests after dispose.
    await c.set(true);
    expect(f.calls).toHaveLength(2);
  });

  it("dispose does nothing when the plugin never expanded native", async () => {
    const f = fakeNative();
    const c = new NativeRailController(f.native, null);
    await c.dispose();
    expect(f.calls).toHaveLength(0);
  });

  it("observe() tracks native changes so a matching request is skipped", async () => {
    const f = fakeNative();
    const c = new NativeRailController(f.native, false);
    c.observe(true);
    await c.set(true);
    expect(f.calls).toHaveLength(0);
  });
});

describe("resolveRailSide", () => {
  const disabled = { edge: "none" as const, behavior: "disabled" as const, occlusions: [] };
  const automatic = { edge: "trailing" as const, behavior: "automatic" as const, occlusions: [] };

  it("uses the detected side when there is one", () => {
    expect(resolveRailSide({ detected: "left", layout: automatic, nativeSupported: true, lastKnown: "right" })).toBe("left");
  });

  it("keeps the last known side while native expansion has removed the inset", () => {
    expect(resolveRailSide({ detected: null, layout: disabled, nativeSupported: true, lastKnown: "left" })).toBe("left");
    expect(resolveRailSide({ detected: null, layout: disabled, nativeSupported: true, lastKnown: null })).toBe("right");
  });

  it("finds no rail without native support or with the bar on and no inset", () => {
    expect(resolveRailSide({ detected: null, layout: disabled, nativeSupported: false, lastKnown: "left" })).toBeNull();
    expect(resolveRailSide({ detected: null, layout: automatic, nativeSupported: true, lastKnown: "left" })).toBeNull();
    expect(resolveRailSide({ detected: null, layout: null, nativeSupported: true, lastKnown: "left" })).toBeNull();
  });
});

describe("placeRestoreInTopBand", () => {
  it("centres in the top band on the end away from the status pill", () => {
    // Simulator measurement with the bar off: 466pt wide, 82pt top band,
    // status pill 200×82 at the top right.
    const pill = { x: 266, y: 0, width: 200, height: 82 };
    expect(
      placeRestoreInTopBand({ insetTop: 82, viewportWidth: 466, occlusions: [pill], size: 36 }),
    ).toEqual({ left: 12, top: 23 });
  });

  it("moves to the right end when the left end is occluded", () => {
    const pill = { x: 0, y: 0, width: 200, height: 82 };
    expect(
      placeRestoreInTopBand({ insetTop: 82, viewportWidth: 466, occlusions: [pill], size: 36 }),
    ).toEqual({ left: 418, top: 23 });
  });
});
