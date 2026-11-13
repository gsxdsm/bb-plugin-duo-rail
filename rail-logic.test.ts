import { describe, expect, it, vi } from "vitest";
import {
  chooseTopRowMode,
  CAMERA_ONLY_MAX_WIDTH,
  computeTopRow,
  keyboardLikelyUp,
  reachesStatus,
  statusBottom,
  placeAboveRailBottom,
  placeInLeftRail,
  headerFitsTopRow,
  TOP_ROW_MIN_TITLE,
  isIOSWebKit,
  STATUS_GLYPH_ALLOWANCE,
  statusStartX,
  isUnfoldedWindow,
  NativeRailController,
  placeRestoreInTopBand,
  RAIL_EXPANSION_CAPABILITY,
  resolveRailSide,
  SET_RAIL_EXPANDED,
  supportsNativeRailExpansion,
  viewportWithoutFocusZoom,
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

  it("dispose while an expansion is still in flight restores afterwards", async () => {
    const f = fakeNative();
    const c = new NativeRailController(f.native, false);
    c.set(true);
    await flushMicrotasks(); // expand request in flight, native still reports false
    expect(c.nativeExpanded).toBe(false);
    const done = c.dispose();
    await flushMicrotasks();
    expect(f.calls.map((call) => call.payload)).toEqual([{ expanded: true }]); // nothing concurrent
    await f.succeed(); // the expansion lands
    await flushMicrotasks();
    expect(f.calls.map((call) => call.payload)).toEqual([{ expanded: true }, { expanded: false }]);
    await f.succeed();
    await done;
    expect(c.nativeExpanded).toBe(false); // not stranded expanded
    expect(f.maxInFlight).toBe(1);
  });

  it("dispose after observe(false) arrives while the expansion is in flight still restores", async () => {
    const f = fakeNative();
    const c = new NativeRailController(f.native, false);
    c.set(true);
    await flushMicrotasks(); // expand in flight
    c.observe(false); // a stale layout event reports the bar still on
    const done = c.dispose();
    await flushMicrotasks();
    await f.succeed(); // the expansion lands
    await flushMicrotasks();
    expect(f.calls.map((call) => call.payload)).toEqual([{ expanded: true }, { expanded: false }]);
    await f.succeed();
    await done;
    expect(c.nativeExpanded).toBe(false);
  });

  it("dispose with an expansion queued but not yet sent restores without expanding", async () => {
    const f = fakeNative();
    const c = new NativeRailController(f.native, false);
    c.set(true); // queued; the flush has not run yet
    const done = c.dispose();
    await flushMicrotasks();
    // The queue collapses to the final wanted state (false == applied): no requests.
    expect(f.calls).toHaveLength(0);
    await done;
    expect(c.nativeExpanded).toBe(false);
  });

  it("dispose after a failed expansion still restores", async () => {
    const f = fakeNative();
    const c = new NativeRailController(f.native, false);
    const first = c.set(true);
    await flushMicrotasks();
    await f.fail(); // state now unknown
    await first;
    const done = c.dispose();
    await flushMicrotasks();
    expect(f.calls.at(-1)?.payload).toEqual({ expanded: false });
    await f.succeed();
    await done;
    expect(c.nativeExpanded).toBe(false);
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
  // Folded cover screen with the bar off: 466pt wide, 82pt band.
  it("with the app's top bar guide, sits just left of where the time starts", () => {
    expect(
      placeRestoreInTopBand({ insetTop: 82, viewportWidth: 466, occlusions: [], size: 36, statusStart: 300 }),
    ).toEqual({ left: 256, top: 23, placement: "band" });
  });

  it("never lands on the time: a camera-only occlusion is widened by the glyph allowance", () => {
    // The device reports just the camera cut-out; the time is drawn to its left.
    const camera = { x: 380, y: 10, width: 70, height: 40 };
    const layout = { edge: "none" as const, behavior: "disabled" as const, occlusions: [camera] };
    const statusStart = statusStartX({ layout, bandHeight: 82, viewportWidth: 466 });
    expect(statusStart).toBe(380 - STATUS_GLYPH_ALLOWANCE);
    const spot = placeRestoreInTopBand({ insetTop: 82, viewportWidth: 466, occlusions: [camera], size: 36, statusStart });
    expect(spot.left + 36).toBeLessThanOrEqual(380 - STATUS_GLYPH_ALLOWANCE - 8);
  });

  it("uses the left end when the status start is unknown", () => {
    expect(
      placeRestoreInTopBand({ insetTop: 82, viewportWidth: 466, occlusions: [], size: 36, statusStart: null }),
    ).toEqual({ left: 12, top: 23, placement: "band" });
  });

  it("uses the left end when there is no room beside the time", () => {
    expect(
      placeRestoreInTopBand({ insetTop: 82, viewportWidth: 466, occlusions: [], size: 36, statusStart: 30 }),
    ).toEqual({ left: 12, top: 23, placement: "band" });
  });
});

describe("statusStartX", () => {
  const base = { edge: "none" as const, behavior: "disabled" as const, occlusions: [] };
  it("prefers the top bar guide's right edge", () => {
    const layout = { ...base, topBar: { x: 0, y: 0, width: 300, height: 82 }, occlusions: [{ x: 380, y: 0, width: 80, height: 40 }] };
    expect(statusStartX({ layout, bandHeight: 82, viewportWidth: 466 })).toBe(300);
  });
  it("ignores a full-width top bar (no status beside it)", () => {
    const layout = { ...base, topBar: { x: 0, y: 0, width: 466, height: 44 } };
    expect(statusStartX({ layout, bandHeight: 82, viewportWidth: 466 })).toBeNull();
  });
  it("ignores occlusions on the left half and below the band", () => {
    const layout = { ...base, occlusions: [{ x: 10, y: 0, width: 40, height: 40 }, { x: 400, y: 200, width: 40, height: 40 }] };
    expect(statusStartX({ layout, bandHeight: 82, viewportWidth: 466 })).toBeNull();
  });
  it("is null without a layout", () => {
    expect(statusStartX({ layout: null, bandHeight: 82, viewportWidth: 466 })).toBeNull();
  });
});

describe("Restore stays reachable on every native-expanded layout", () => {
  it("unfolded, no edge, thin top band: goes below the header at the right end", () => {
    // Unfolded inner screen with the bar off: no rail edge, a thin top inset,
    // so the band cannot hold the button without covering bb's header row.
    expect(
      placeRestoreInTopBand({ insetTop: 24, viewportWidth: 900, occlusions: [], size: 36, chromeRowHeight: 48 }),
    ).toEqual({ left: 852, top: 80, placement: "below-header" });
  });

  it("unfolded with no top inset at all still clears the header row", () => {
    const spot = placeRestoreInTopBand({ insetTop: 0, viewportWidth: 900, occlusions: [], size: 36, chromeRowHeight: 48 });
    expect(spot.placement).toBe("below-header");
    expect(spot.top).toBeGreaterThanOrEqual(48);
  });

  it("below the header, moves left if an occlusion sits at the right end", () => {
    const blocker = { x: 800, y: 60, width: 100, height: 60 };
    expect(
      placeRestoreInTopBand({ insetTop: 24, viewportWidth: 900, occlusions: [blocker], size: 36, chromeRowHeight: 48 }),
    ).toEqual({ left: 12, top: 80, placement: "below-header" });
  });

  it("keeps a rail side after reload when only the persisted side is known", () => {
    // After a reload while expanded: no inset, bar reported disabled.
    const layout = { edge: "none" as const, behavior: "disabled" as const, occlusions: [] };
    expect(resolveRailSide({ detected: null, layout, nativeSupported: true, lastKnown: "left" })).toBe("left");
    // Fresh storage (e.g. first load on the unfolded screen): still offers Restore.
    expect(resolveRailSide({ detected: null, layout, nativeSupported: true, lastKnown: null })).toBe("right");
  });

  it("a controller created while native is already expanded restores on request", async () => {
    const f = fakeNative();
    const c = new NativeRailController(f.native, true);
    const done = c.set(false);
    await flushMicrotasks();
    expect(f.calls).toEqual([{ kind: SET_RAIL_EXPANDED, payload: { expanded: false } }]);
    await f.succeed();
    await done;
    expect(c.nativeExpanded).toBe(false);
  });
});

describe("focus zoom stopgap", () => {
  const IPHONE = {
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 27_1 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
    platform: "iPhone",
    maxTouchPoints: 5,
  };
  const ANDROID = {
    userAgent:
      "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36",
    platform: "Linux armv8l",
    maxTouchPoints: 5,
  };

  it("recognizes iOS WebKit only", () => {
    expect(isIOSWebKit(IPHONE)).toBe(true);
    expect(isIOSWebKit(ANDROID)).toBe(false);
  });

  it("adds maximum-scale=1 once", () => {
    const content = "width=device-width, initial-scale=1.0, viewport-fit=cover";
    const capped = viewportWithoutFocusZoom(content);
    expect(capped).toBe(`${content}, maximum-scale=1`);
    expect(viewportWithoutFocusZoom(capped!)).toBeNull();
  });
});

describe("unfolded top row", () => {
  it("detects the unfolded screen from the window width (keyboard-proof)", () => {
    expect(isUnfoldedWindow({ innerWidth: 466 })).toBe(false); // folded cover
    expect(isUnfoldedWindow({ innerWidth: 430 })).toBe(false); // Pro Max
    expect(isUnfoldedWindow({ innerWidth: 951 })).toBe(true); // unfolded wide
    expect(isUnfoldedWindow({ innerWidth: 669 })).toBe(true); // unfolded tall
  });

  it("also accepts the app's top bar guide width as evidence", () => {
    const guide = (width: number) => ({ edge: "none" as const, behavior: "disabled" as const, occlusions: [], topBar: { x: 16, y: 26, width, height: 44 } });
    expect(isUnfoldedWindow({ innerWidth: 400 }, guide(791))).toBe(true);
    expect(isUnfoldedWindow({ innerWidth: 466 }, guide(263.7))).toBe(false); // folded
  });

  it("puts Restore just left of the time, centred in the row, and reserves both", () => {
    expect(
      computeTopRow({ insetTop: 70, chromeRowHeight: 48, viewportWidth: 1000, statusStart: 800, size: 32 }),
    ).toEqual({ rowHeight: 70, reserveRight: 248, toggle: { left: 760, top: 19 } });
  });

  it("keeps the header's own height when the band is thinner than it", () => {
    const row = computeTopRow({ insetTop: 24, chromeRowHeight: 48, viewportWidth: 1000, statusStart: 800, size: 32 });
    expect(row.rowHeight).toBe(48);
    expect(row.toggle.top).toBe(8);
  });

  it("without a known status start, still reserves room for Restore at the right end", () => {
    const row = computeTopRow({ insetTop: 70, chromeRowHeight: 48, viewportWidth: 1000, statusStart: null, size: 32 });
    expect(row.toggle.left).toBe(1000 - 12 - 32);
    expect(row.reserveRight).toBe(12 + 32 + 8);
});
});

describe("headerFitsTopRow", () => {
  it("fits when the title keeps its minimum beside bb's controls", () => {
    expect(headerFitsTopRow({ rowLeft: 65, controlsWidth: 360, toggleLeft: 700 })).toBe(true);
  });
  it("does not fit when the sidebar narrows the row", () => {
    // Sidebar open: the row starts at 336; 700 - 8 - 336 = 356 < 360 + min title.
    expect(headerFitsTopRow({ rowLeft: 336, controlsWidth: 360, toggleLeft: 700 })).toBe(false);
  });
  it("is exact at the boundary", () => {
    expect(headerFitsTopRow({ rowLeft: 0, controlsWidth: 100, toggleLeft: 100 + TOP_ROW_MIN_TITLE + 8 })).toBe(true);
    expect(headerFitsTopRow({ rowLeft: 0, controlsWidth: 100, toggleLeft: 100 + TOP_ROW_MIN_TITLE + 7 })).toBe(false);
  });
});

describe("Restore in the left side rail (unfolded)", () => {
  const trigger = { x: 0, y: 70, width: 38, height: 48 }; // bb's sidebar toggle, below the band

  it("centres over bb's sidebar toggle, in the status band above it", () => {
    expect(placeInLeftRail({ insetTop: 70, anchor: trigger, size: 32 })).toEqual({ left: 4, top: 19 });
    expect(placeInLeftRail({ insetTop: 70, anchor: { x: 6, y: 70, width: 36, height: 48 }, size: 32 })).toEqual({ left: 8, top: 19 });
  });

  it("is null when the band is too thin or the rail isn't there", () => {
    expect(placeInLeftRail({ insetTop: 30, anchor: trigger, size: 32 })).toBeNull();
    expect(placeInLeftRail({ insetTop: 70, anchor: null, size: 32 })).toBeNull();
  });

  it("with Restore in the rail, the top row only reserves the time", () => {
    const row = computeTopRow({
      insetTop: 70, chromeRowHeight: 48, viewportWidth: 1000, statusStart: 760, size: 32,
      railToggle: { left: 4, top: 19 },
    });
    expect(row).toEqual({ rowHeight: 70, reserveRight: 248, toggle: { left: 4, top: 19 } });
  });
});

describe("chooseTopRowMode", () => {
  // The user's screen: 951pt wide, sidebar open (row starts at 336), bb's
  // controls 347pt, the "…" button 28pt, the time at about 740.
  it("splits on the user's screen: title and menu up, controls below", () => {
    expect(chooseTopRowMode({ rowLeft: 336, rowEnd: 732, controlsWidth: 347, menuWidth: 28 })).toBe("split");
  });
  it("moves the whole header when everything fits (sidebar collapsed)", () => {
    expect(chooseTopRowMode({ rowLeft: 65, rowEnd: 732, controlsWidth: 347, menuWidth: 28 })).toBe("full");
  });
  it("keeps bb's normal header when even the title and menu don't fit", () => {
    expect(chooseTopRowMode({ rowLeft: 600, rowEnd: 732, controlsWidth: 347, menuWidth: 28 })).toBeNull();
  });
  it("boundaries are exact", () => {
    expect(chooseTopRowMode({ rowLeft: 0, rowEnd: 28 + TOP_ROW_MIN_TITLE + 8, controlsWidth: 999, menuWidth: 28 })).toBe("split");
    expect(chooseTopRowMode({ rowLeft: 0, rowEnd: 28 + TOP_ROW_MIN_TITLE + 7, controlsWidth: 999, menuWidth: 28 })).toBeNull();
  });
});

describe("measured iPhone Duo layouts (simulator, iOS 27.1, bar disabled)", () => {
  const disabled = (occlusions: { x: number; y: number; width: number; height: number }[], topBar: { x: number; y: number; width: number; height: number } | null) =>
    ({ edge: "none" as const, behavior: "disabled" as const, occlusions, topBar });
  const cases = [
    { name: "folded cover 466x678", w: 466, topBar: { x: 2.3, y: 26, width: 263.7, height: 44 },
      occ: [{ x: 399.7, y: 29.3, width: 37, height: 37 }, { x: 266, y: 0, width: 200, height: 82 }], time: 266 },
    { name: "unfolded wide 951x669", w: 951, topBar: { x: 16, y: 26, width: 791, height: 44 },
      occ: [{ x: 807, y: 0, width: 144, height: 82 }], time: 807 },
    { name: "unfolded tall 669x951", w: 669, topBar: { x: 16, y: 26, width: 509, height: 44 },
      occ: [{ x: 525, y: 0, width: 144, height: 82 }], time: 525 },
  ];
  for (const c of cases) {
    it(`${c.name}: the time starts at the top bar guide's end`, () => {
      expect(statusStartX({ layout: disabled(c.occ, c.topBar), bandHeight: 82, viewportWidth: c.w })).toBeCloseTo(c.time, 0);
    });
    it(`${c.name}: without the guide, the pill occlusion's left edge is used as-is`, () => {
      expect(statusStartX({ layout: disabled(c.occ, null), bandHeight: 82, viewportWidth: c.w })).toBeCloseTo(c.time, 0);
    });
  }
  it("a camera-only occlusion still leaves room for the time", () => {
    const camera = { x: 399.7, y: 29.3, width: 37, height: 37 };
    expect(camera.width).toBeLessThan(CAMERA_ONLY_MAX_WIDTH);
    expect(statusStartX({ layout: disabled([camera], null), bandHeight: 82, viewportWidth: 466 })).toBeCloseTo(399.7 - STATUS_GLYPH_ALLOWANCE, 1);
  });
  it("on the user's unfolded screen with the sidebar open, title and menu go up, controls stay below", () => {
    // Time at 807 (guide), so the row ends at 799; row starts at 336; bb's controls 367; "…" 28.
    expect(chooseTopRowMode({ rowLeft: 336, rowEnd: 799, controlsWidth: 367, menuWidth: 28 })).toBe("split");
  });
});

describe("placeAboveRailBottom", () => {
  const icon = (y: number) => ({ x: 6, y, width: 36, height: 36 });
  it("sits just above the rail's bottom control, centred on the rail", () => {
    expect(placeAboveRailBottom({ railControls: [icon(0), icon(200), icon(620)], centreX: 24, size: 32 })).toEqual({ left: 8, top: 580 });
  });
  it("steps up past a control that would overlap", () => {
    expect(placeAboveRailBottom({ railControls: [icon(0), icon(560), icon(620)], centreX: 24, size: 32 })).toEqual({ left: 8, top: 520 });
  });
  it("is null without rail controls", () => {
    expect(placeAboveRailBottom({ railControls: [], centreX: 24, size: 32 })).toBeNull();
  });
});

describe("right panel and header clearance", () => {
  it("measures the status region's bottom from the pill", () => {
    expect(statusBottom({ occlusions: [{ x: 807, y: 0, width: 144, height: 82 }], viewportWidth: 951, bandHeight: 82 })).toBe(82);
    expect(statusBottom({ occlusions: [], viewportWidth: 951, bandHeight: 82 })).toBe(82);
  });
  it("a right panel at 636..951 reaches the status region; the chat header ending at 636 doesn't", () => {
    expect(reachesStatus({ left: 636, right: 951 }, 807)).toBe(true);
    expect(reachesStatus({ left: 320, right: 636 }, 807)).toBe(false);
    expect(reachesStatus({ left: 320, right: 951 }, 807)).toBe(true);
  });
});

describe("keyboardLikelyUp (Restore stays put while typing)", () => {
  const base = { width: 951, height: 669 };
  it("is up when a field has focus and the window shrank at the same width", () => {
    expect(keyboardLikelyUp({ baseline: base, now: { width: 951, height: 350 }, editableFocused: true })).toBe(true);
  });
  it("is not up without a focused field, or for small changes", () => {
    expect(keyboardLikelyUp({ baseline: base, now: { width: 951, height: 350 }, editableFocused: false })).toBe(false);
    expect(keyboardLikelyUp({ baseline: base, now: { width: 951, height: 640 }, editableFocused: true })).toBe(false);
  });
  it("a width change (rotation, fold) is never the keyboard", () => {
    expect(keyboardLikelyUp({ baseline: base, now: { width: 669, height: 400 }, editableFocused: true })).toBe(false);
  });
  it("without a baseline it can't tell, so it isn't up", () => {
    expect(keyboardLikelyUp({ baseline: null, now: base, editableFocused: true })).toBe(false);
  });
});
