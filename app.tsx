// bb-plugin-duo-rail — frontend entry.
//
// On a folded iPhone Duo the cover screen keeps a side rail beside the camera.
// iOS reports it to the bb WebView as a left or right safe-area inset, and the
// bb shell pads its content by that inset, so the chat stops short of the
// rail. This plugin detects the rail and, when expanded, rewrites the shell's
// safe-area insets: the side inset drops to zero so the chat fills the rail,
// and the top inset grows into a strip that holds the status bar and camera.
//
// Pieces:
// - a content script that detects the rail and owns every DOM change;
// - an app overlay that feeds plugin settings to that script;
// - a thread action ("Expand into rail" / "Restore side rail") that toggles
//   the layout per device.
//
// The bb iOS app reports the window layout on window.bb.native.windowLayout:
// the vertical bar's edge and behavior, and the system occlusions (camera,
// status bar) in window points. With it, the rail comes from the vertical bar
// itself and the cap covers exactly the occluded block at the top of the rail.
// When the app's "Status bar at top" setting turns the vertical bar off, iOS
// moves the status bar to the top and removes the rail, so the plugin stands
// down. Older bb apps fall back to inset detection and cameraAreaHeight.
//
// Apps that advertise the "rail-expansion" capability expand natively: the
// expand/restore controls send `set-rail-expanded`, the app turns the vertical
// bar off (status bar to the top, rail inset removed) or back on, and the CSS
// expansion is not used. The plugin keeps the rail side while the inset is
// gone, shows Restore in the top band, and restores native on Off or unload.
import { useEffect, useSyncExternalStore } from "react";
import {
  definePluginApp,
  experimental_usePluginId,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import {
  computeTopRow,
  headerFitsTopRow,
  placeInLeftRail,
  isIOSWebKit,
  isUnfoldedScreen,
  NativeRailController,
  placeRestoreInTopBand,
  resolveRailSide,
  statusStartX,
  supportsNativeRailExpansion,
  type Rect,
  type Side,
  type WindowLayout,
  viewportWithoutFocusZoom,
} from "./rail-logic";

type Mode = "auto" | "manual" | "off";

interface DuoState {
  mode: Mode;
  /** Height of the camera + status bar block at the top of the rail. */
  cameraAreaHeight: number;
  /** The window layout the bb app reports, or null for older apps and browsers. */
  windowLayout: WindowLayout | null;
  /** Bottom of the occluded block at the top of the rail, measured from the app's occlusions. */
  measuredCameraBlock: number | null;
  /** Points kept clear on the rail side; 0 lets the chat fill the rail. */
  sideInset: number;
  /** The user's per-device choice; null follows the mode. */
  override: boolean | null;
  /** The side the rail is on, or null when no rail is detected. */
  railSide: Side | null;
  /** The app has the vertical bar off (status bar at the top) at our request. */
  nativeExpanded: boolean;
  /** Native expansion failed; fall back to the CSS expansion. */
  nativeFailed: boolean;
}

const DEFAULT_CAMERA_AREA_HEIGHT = 240;
const TOGGLE_SIZE = 36;
const ATTR_RAIL = "data-bb-duo-rail";
const ATTR_EXPANDED = "data-bb-duo-rail-expanded";
const VAR_CAMERA = "--bb-duo-camera-height";
const VAR_SIDE = "--bb-duo-side-inset";
/** Unfolded + status bar at the top: bb's thread header moves up into the status row. */
const ATTR_TOP_ROW = "data-bb-duo-top-row";
const VAR_ROW_HEIGHT = "--bb-duo-top-row-height";
const VAR_ROW_RESERVE = "--bb-duo-top-row-reserve";
/** Restore in the top row matches bb's header icon buttons. */
const ROW_TOGGLE_SIZE = 32;

// ---------------------------------------------------------------------------
// Store shared by the content script, the settings bridge and the action.

let state: DuoState = {
  mode: "auto",
  cameraAreaHeight: DEFAULT_CAMERA_AREA_HEIGHT,
  windowLayout: null,
  measuredCameraBlock: null,
  sideInset: 0,
  override: null,
  railSide: null,
  nativeExpanded: false,
  nativeFailed: false,
};
const listeners = new Set<() => void>();
let overrideKey = "bb-plugin:duo-rail:expanded";

function setState(patch: Partial<DuoState>) {
  const next = { ...state, ...patch };
  if (
    next.mode === state.mode &&
    next.cameraAreaHeight === state.cameraAreaHeight &&
    next.windowLayout === state.windowLayout &&
    next.measuredCameraBlock === state.measuredCameraBlock &&
    next.sideInset === state.sideInset &&
    next.override === state.override &&
    next.railSide === state.railSide &&
    next.nativeExpanded === state.nativeExpanded &&
    next.nativeFailed === state.nativeFailed
  ) {
    return;
  }
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getState() {
  return state;
}

/** The block to keep clear at the top of the rail, in page points. */
function railBlockHeight(s: DuoState): number {
  return s.measuredCameraBlock ?? s.cameraAreaHeight;
}

/** The side to expand into, or null to leave bb's layout alone. */
function expandedSide(s: DuoState): Side | null {
  if (s.railSide === null || s.mode === "off") return null;
  const expanded = s.override ?? s.mode === "auto";
  return expanded ? s.railSide : null;
}

function readOverride(): boolean | null {
  try {
    const raw = window.localStorage.getItem(overrideKey);
    return raw === "1" ? true : raw === "0" ? false : null;
  } catch {
    return null;
  }
}

function writeOverride(value: boolean) {
  try {
    window.localStorage.setItem(overrideKey, value ? "1" : "0");
  } catch {
    // Private mode or storage disabled: the toggle still works for this session.
  }
  setState({ override: value });
}

function parseMode(value: unknown): Mode {
  return value === "manual" || value === "off" ? value : "auto";
}

function parseCameraAreaHeight(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(400, Math.max(0, Math.round(value)))
    : DEFAULT_CAMERA_AREA_HEIGHT;
}

interface NativeBridge {
  windowLayout?: unknown;
  capabilities?: unknown;
  request?: (kind: string, payload: unknown) => Promise<unknown>;
  subscribe?: (listener: (event: unknown) => void) => () => void;
}

const LAST_SIDE_KEY = "bb-plugin:duo-rail:last-side";

function readLastSide(): Side | null {
  try {
    const raw = window.localStorage.getItem(LAST_SIDE_KEY);
    return raw === "left" || raw === "right" ? raw : null;
  } catch {
    return null;
  }
}

function writeLastSide(side: Side) {
  try {
    window.localStorage.setItem(LAST_SIDE_KEY, side);
  } catch {
    // Storage disabled: the side is still kept for this session.
  }
}

function nativeBridge(): NativeBridge | null {
  const root = (window as unknown as { bb?: { native?: unknown } }).bb;
  const native = root?.native;
  return typeof native === "object" && native !== null
    ? (native as NativeBridge)
    : null;
}

function isRect(value: unknown): value is Rect {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return ["x", "y", "width", "height"].every(
    (key) => typeof r[key] === "number" && Number.isFinite(r[key]),
  );
}

/** The bb app's window layout, or null when the shell does not report one. */
function readWindowLayout(): WindowLayout | null {
  const raw = nativeBridge()?.windowLayout;
  if (typeof raw !== "object" || raw === null) return null;
  const { verticalBar, occlusions, topBar } = raw as {
    verticalBar?: { edge?: unknown; behavior?: unknown };
    occlusions?: unknown;
    topBar?: unknown;
  };
  const edge = verticalBar?.edge;
  const behavior = verticalBar?.behavior;
  if (edge !== "none" && edge !== "leading" && edge !== "trailing") return null;
  if (behavior !== "automatic" && behavior !== "disabled") return null;
  if (!Array.isArray(occlusions)) return null;
  return {
    edge,
    behavior,
    occlusions: occlusions.filter(isRect),
    topBar: isRect(topBar) ? topBar : null,
  };
}

function sameWindowLayout(a: WindowLayout | null, b: WindowLayout | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function parseSideInset(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(120, Math.max(0, Math.round(value)))
    : 0;
}

// ---------------------------------------------------------------------------
// CSS. bb pads its shell with Tailwind arbitrary classes such as
// `pr-[env(safe-area-inset-right)]`; these rules match those class names and
// replace the env() value. Rules only apply while <html> carries
// data-bb-duo-rail-expanded, so the stylesheet is inert everywhere else.

const ON = (side: Side) => `html[${ATTR_EXPANDED}="${side}"]`;
const ANY = `html[${ATTR_EXPANDED}]`;
const cls = (name: string) => `[class*="${name}"]`;

const CSS = `
@media (pointer: coarse) {
  input:not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="submit"]),
  textarea,
  [contenteditable]:not([contenteditable="false"]) {
    font-size: max(1rem, 1em) !important;
  }
}
${ANY} {
  --bb-duo-side: var(${VAR_SIDE}, 0px);
  --bb-duo-camera: var(${VAR_CAMERA}, ${DEFAULT_CAMERA_AREA_HEIGHT}px);
}

/* Below the camera block, the chat, transcript and composer fill the rail. */
${ON("right")} ${cls("pr-[env(safe-area-inset-right)]")} { padding-right: var(--bb-duo-side) !important; }
${ON("left")} ${cls("pl-[env(safe-area-inset-left)]")} { padding-left: var(--bb-duo-side) !important; }
html[${ATTR_RAIL}="right"] [data-sidebar="panel"] > [data-sidebar="sidebar"] {
  padding-right: max(0px, calc(env(safe-area-inset-right) - (100vw - var(--sidebar-width-mobile, min(86vw, 360px))))) !important;
}
/* Mid-height edge controls (lightbox next/previous) may use the rail too;
   anything also pinned to the top keeps its safe position. */
${ON("right")} ${cls("right-[max(0.5rem,env(safe-area-inset-right))]")}:not(${cls("top-[max(")}) { right: calc(0.5rem + var(--bb-duo-side)) !important; }
${ON("left")} ${cls("left-[max(0.5rem,env(safe-area-inset-left))]")}:not(${cls("top-[max(")}) { left: calc(0.5rem + var(--bb-duo-side)) !important; }

/* The header row stays beside the camera block, never under it. */
${ON("right")} [data-testid="app-page-header-content-row"] { margin-right: env(safe-area-inset-right) !important; }
${ON("left")} [data-testid="app-page-header-content-row"] { margin-left: env(safe-area-inset-left) !important; }

/* Opaque cap over the camera and status bar, below the header row, so the
   transcript scrolls under it instead of colliding with the status icons. */
.bb-duo-cap {
  position: fixed;
  top: calc(env(safe-area-inset-top) + var(--bb-app-chrome-row-height, 3rem));
  height: max(0px, calc(var(--bb-duo-camera) - env(safe-area-inset-top) - var(--bb-app-chrome-row-height, 3rem)));
  z-index: 30;
  background: var(--background);
  pointer-events: none;
  display: none;
}
${ON("right")} .bb-duo-cap { display: block; right: 0; width: env(safe-area-inset-right); }
${ON("left")} .bb-duo-cap { display: block; left: 0; width: env(safe-area-inset-left); }

/* Expand / restore toggle: always in the rail, just below the camera block.
   The script sets left/top from the measured rail. */
:is(.bb-duo-toggle, .bb-duo-sidebar) {
  position: fixed;
  z-index: 45;
  box-sizing: border-box;
  width: ${TOGGLE_SIZE}px;
  height: ${TOGGLE_SIZE}px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 9999px;
  border: 1px solid var(--border);
  background: var(--background);
  color: var(--foreground);
  box-shadow: 0 2px 8px -2px rgb(0 0 0 / 0.35);
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
}
:is(.bb-duo-toggle, .bb-duo-sidebar)[hidden] { display: none !important; }
/* Stay out of the way of bb's sheets, drawers and dialogs. */
body:has([role="dialog"]:not([data-state="closed"]), [role="alertdialog"]:not([data-state="closed"]), [data-vaul-drawer]:not([data-state="closed"])) :is(.bb-duo-toggle, .bb-duo-sidebar, .bb-duo-cap) { display: none !important; }
:is(.bb-duo-toggle, .bb-duo-sidebar):active { background: var(--accent); }
:is(.bb-duo-toggle, .bb-duo-sidebar):focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
:is(.bb-duo-toggle, .bb-duo-sidebar) svg { width: 18px; height: 18px; }

/* Unfolded with the status bar at the top: bb's thread header (title, its
   menu and controls) moves up into the status row and stops short of the
   time; the rest of the page starts below that row. The sidebar column keeps
   its own top inset. */
html[${ATTR_TOP_ROW}] [data-app-content-shell] { padding-top: 0 !important; }
html[${ATTR_TOP_ROW}] [data-app-content-shell] header:has([data-testid="app-page-header-content-row"]) {
  height: var(${VAR_ROW_HEIGHT}, var(--bb-app-chrome-row-height, 3rem)) !important;
  display: flex !important;
  align-items: center !important;
  padding-right: var(${VAR_ROW_RESERVE}, 0px) !important;
}
html[${ATTR_TOP_ROW}] [data-app-content-shell] header [data-testid="app-page-header-content-row"] { flex: 1 1 auto; min-width: 0; }
/* Restore sits in that row or the left rail like one of bb's icon buttons. */
html[${ATTR_TOP_ROW}] .bb-duo-toggle,
.bb-duo-toggle[data-compact] {
  width: ${ROW_TOGGLE_SIZE}px;
  height: ${ROW_TOGGLE_SIZE}px;
  border-radius: 8px;
  border-color: transparent;
  background: transparent;
  box-shadow: none;
  color: var(--muted-foreground, var(--foreground));
}
html[${ATTR_TOP_ROW}] .bb-duo-toggle:active,
.bb-duo-toggle[data-compact]:active { background: var(--accent); }
`;

// Lucide maximize-2 / minimize-2, drawn in currentColor.
const SVG_OPEN =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
const ICON_EXPAND = `${SVG_OPEN}<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" x2="14" y1="3" y2="10"/><line x1="3" x2="10" y1="21" y2="14"/></svg>`;
const ICON_SIDEBAR = `${SVG_OPEN}<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/></svg>`;
const ICON_RESTORE = `${SVG_OPEN}<polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" x2="21" y1="10" y2="3"/><line x1="3" x2="10" y1="21" y2="14"/></svg>`;

// ---------------------------------------------------------------------------
// Rail detection: a hidden probe padded by every safe-area inset.

function detectRail(probe: HTMLElement, layout: WindowLayout | null): Side | null {
  const style = getComputedStyle(probe);
  const left = parseFloat(style.paddingLeft) || 0;
  const right = parseFloat(style.paddingRight) || 0;
  if (Math.max(left, right) < 1) return null;
  if (layout !== null) {
    // The app reports the vertical bar itself. Turned off, iOS has moved the
    // status bar to the top and there is no rail to expand into.
    if (layout.behavior === "disabled" || layout.edge === "none") return null;
    return right >= left ? "right" : "left";
  }
  // A notched phone only gets side insets in landscape, so landscape is
  // ignored there. The folded Duo's rail is a side inset in portrait. The
  // unfolded Duo also keeps a rail when held sideways; it is recognised by a
  // shorter screen or window side of at least 500pt, wider than any
  // single-screen iPhone.
  const portrait = window.innerHeight > window.innerWidth;
  const unfoldedDuo =
    Math.max(
      Math.min(window.screen.width, window.screen.height),
      Math.min(window.innerWidth, window.innerHeight),
    ) >= 500;
  if (!portrait && !unfoldedDuo) return null;
  return right >= left ? "right" : "left";
}

/**
 * The bottom of the occlusions in the upper half of the rail: the camera, Live
 * Activities and the status bar column. Null without a reported layout.
 */
function measureCameraBlock(
  probe: HTMLElement,
  side: Side | null,
  layout: WindowLayout | null,
): number | null {
  if (side === null || layout === null) return null;
  const style = getComputedStyle(probe);
  const rail = parseFloat(side === "right" ? style.paddingRight : style.paddingLeft) || 0;
  const start = side === "right" ? window.innerWidth - rail : 0;
  const end = start + rail;
  const bottoms = layout.occlusions
    .filter(
      (r) =>
        r.x < end && r.x + r.width > start && r.y < window.innerHeight / 2,
    )
    .map((r) => r.y + r.height);
  return bottoms.length === 0 ? null : Math.ceil(Math.max(...bottoms));
}

/**
 * Live content-script mounts in this page, shared across plugin bundle
 * generations (a reload loads a new bundle, so module state is not shared).
 */
const liveMounts: { count: number } = ((window as unknown as Record<string, unknown>)
  .__bbDuoRailLiveMounts ??= { count: 0 }) as { count: number };
/** How long a disposed copy waits before restoring the vertical bar. */
const RESTORE_GRACE_MS = 1500;

/** bb's header row height in px, read from `--bb-app-chrome-row-height` (3rem today). */
function chromeRowHeightPx(root: HTMLElement): number {
  const style = getComputedStyle(root);
  const raw = style.getPropertyValue("--bb-app-chrome-row-height").trim();
  const value = parseFloat(raw);
  if (!Number.isFinite(value)) return 48;
  return raw.endsWith("rem") ? value * (parseFloat(style.fontSize) || 16) : value;
}

function mountLayout({ signal }: { signal: AbortSignal }) {
  const root = document.documentElement;

  const native = nativeBridge();
  const nativeSupported = supportsNativeRailExpansion(native);
  const initialLayout = readWindowLayout();
  const controller = supportsNativeRailExpansion(native)
    ? new NativeRailController(
        native,
        initialLayout === null ? null : initialLayout.behavior === "disabled",
        (error) => {
          console.warn("[duo-rail] set-rail-expanded failed; using CSS expansion", error);
          setState({ nativeFailed: true });
        },
      )
    : null;
  let lastSide = readLastSide();
  liveMounts.count += 1;
  // A page reload or navigation also tears this script down. Only restore the
  // vertical bar for a real unload (plugin disabled or removed), not then.
  let pageGoingAway = false;
  const markPageGoingAway = () => {
    pageGoingAway = true;
  };
  window.addEventListener("beforeunload", markPageGoingAway, { signal });
  window.addEventListener("pagehide", markPageGoingAway, { signal });

  const style = document.createElement("style");
  style.setAttribute("data-bb-plugin", "duo-rail");
  style.textContent = CSS;
  document.head.appendChild(style);

  const probe = document.createElement("div");
  probe.setAttribute("aria-hidden", "true");
  probe.setAttribute("data-bb-plugin", "duo-rail");
  probe.style.cssText =
    "position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;" +
    "padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);";
  document.body.appendChild(probe);

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "bb-duo-toggle";
  toggle.setAttribute("data-bb-plugin", "duo-rail");
  toggle.setAttribute("data-testid", "duo-rail-toggle");
  toggle.hidden = true;
  toggle.addEventListener(
    "click",
    () => writeOverride(expandedSide(getState()) === null),
    { signal },
  );
  document.body.appendChild(toggle);
  let toggleExpanded: boolean | null = null;

  // Opens bb's sidebar through its own trigger; the SDK has no sidebar API.
  const sidebarButton = document.createElement("button");
  sidebarButton.type = "button";
  sidebarButton.className = "bb-duo-sidebar";
  sidebarButton.setAttribute("data-bb-plugin", "duo-rail");
  sidebarButton.setAttribute("data-testid", "duo-rail-sidebar");
  sidebarButton.setAttribute("aria-label", "Show sidebar");
  sidebarButton.title = "Show sidebar";
  sidebarButton.innerHTML = ICON_SIDEBAR;
  sidebarButton.hidden = true;
  sidebarButton.addEventListener(
    "click",
    () => {
      const trigger =
        document.querySelector<HTMLElement>(
          '[data-testid="app-sidebar-trigger-overlay"] [data-sidebar="trigger"]',
        ) ?? document.querySelector<HTMLElement>('[data-sidebar="trigger"]');
      trigger?.click();
    },
    { signal },
  );
  document.body.appendChild(sidebarButton);

  const cap = document.createElement("div");
  cap.className = "bb-duo-cap";
  cap.setAttribute("aria-hidden", "true");
  cap.setAttribute("data-bb-plugin", "duo-rail");
  document.body.appendChild(cap);

  /** Centres the toggle in the rail, just below the camera block. */
  /** Restore's spot in the left side rail when unfolded and expanded natively, if there is room. */
  const leftRailSpot = (s: DuoState) => {
    if (!s.nativeExpanded || !isUnfoldedScreen(window.screen)) return null;
    const trigger = document.querySelector<HTMLElement>(
      '[data-testid="app-sidebar-trigger-overlay"] [data-sidebar="trigger"]',
    );
    const b = trigger?.getBoundingClientRect();
    return placeInLeftRail({
      insetTop: parseFloat(getComputedStyle(probe).paddingTop) || 0,
      anchor: b && b.width > 0 ? { x: b.left, y: b.top, width: b.width, height: b.height } : null,
      size: ROW_TOGGLE_SIZE,
    });
  };

  /**
   * The unfolded top row's geometry, or null when it does not apply: not
   * unfolded (screen size, so the keyboard can't flip it), not expanded
   * natively, plugin off, or bb's header too wide to fit beside the time.
   */
  const topRowGeometry = (s: DuoState) => {
    if (!s.nativeExpanded || s.mode === "off" || s.railSide === null) return null;
    if (!isUnfoldedScreen(window.screen)) return null;
    const row = document.querySelector<HTMLElement>('[data-testid="app-page-header-content-row"]');
    if (!row) return null;
    const insetTop = parseFloat(getComputedStyle(probe).paddingTop) || 0;
    const geometry = computeTopRow({
      insetTop,
      chromeRowHeight: chromeRowHeightPx(root),
      viewportWidth: window.innerWidth,
      statusStart: statusStartX({
        layout: s.windowLayout,
        bandHeight: Math.max(insetTop, chromeRowHeightPx(root)),
        viewportWidth: window.innerWidth,
      }),
      size: ROW_TOGGLE_SIZE,
      railToggle: leftRailSpot(s),
    });
    // bb's controls are the row's last, fixed-width group; the title shrinks.
    const controls = row.lastElementChild as HTMLElement | null;
    const rowEnd = window.innerWidth - geometry.reserveRight + 8;
    const fits = headerFitsTopRow({
      rowLeft: row.getBoundingClientRect().left,
      controlsWidth: controls && controls !== row.firstElementChild ? controls.getBoundingClientRect().width : 0,
      toggleLeft: rowEnd,
    });
    return fits ? geometry : null;
  };

  const placeToggle = (s: DuoState) => {
    toggle.removeAttribute("data-compact");
    if (s.railSide === null) return;
    const probeStyle = getComputedStyle(probe);
    if (s.nativeExpanded) {
      // The status bar is at the top now. Restore goes right next to the
      // time: from the app's top bar guide, or a conservative estimate.
      const insetTop = parseFloat(probeStyle.paddingTop) || 0;
      const statusStart = statusStartX({
        layout: s.windowLayout,
        bandHeight: Math.max(insetTop, chromeRowHeightPx(root)),
        viewportWidth: window.innerWidth,
      });
      const row = root.hasAttribute(ATTR_TOP_ROW) ? topRowGeometry(s) : null;
      if (row) {
        root.style.setProperty(VAR_ROW_HEIGHT, `${row.rowHeight}px`);
        root.style.setProperty(VAR_ROW_RESERVE, `${row.reserveRight}px`);
        toggle.style.left = `${row.toggle.left}px`;
        toggle.style.top = `${row.toggle.top}px`;
        return;
      }
      const railSpot = leftRailSpot(s);
      if (railSpot) {
        toggle.setAttribute("data-compact", "");
        toggle.style.left = `${railSpot.left}px`;
        toggle.style.top = `${railSpot.top}px`;
        return;
      }
      const spot = placeRestoreInTopBand({
        insetTop,
        viewportWidth: window.innerWidth,
        occlusions: s.windowLayout?.occlusions ?? [],
        size: TOGGLE_SIZE,
        chromeRowHeight: chromeRowHeightPx(root),
        statusStart,
      });
      toggle.style.left = `${spot.left}px`;
      toggle.style.top = `${spot.top}px`;
      return;
    }
    const rail =
      parseFloat(s.railSide === "right" ? probeStyle.paddingRight : probeStyle.paddingLeft) || 0;
    const top = Math.max(parseFloat(probeStyle.paddingTop) || 0, railBlockHeight(s)) + 12;
    const centre = s.railSide === "right" ? window.innerWidth - rail / 2 - 6 : rail / 2 + 6;
    const left = Math.min(
      Math.max(4, centre - TOGGLE_SIZE / 2),
      window.innerWidth - TOGGLE_SIZE - 4,
    );
    toggle.style.left = `${Math.round(left)}px`;
    toggle.style.top = `${Math.round(top)}px`;
    sidebarButton.style.left = `${Math.round(left)}px`;
    sidebarButton.style.top = `${Math.round(top + TOGGLE_SIZE + 10)}px`;
  };

  setState({ override: readOverride() });

  const apply = () => {
    const s = getState();
    if (s.railSide && s.mode !== "off") root.setAttribute(ATTR_RAIL, s.railSide);
    else root.removeAttribute(ATTR_RAIL);
    const side = expandedSide(s);
    const useNative = controller !== null && !s.nativeFailed;
    if (controller !== null && s.railSide !== null) {
      // Off restores native; otherwise native follows expand / restore.
      void controller.set(s.mode !== "off" && side !== null);
    }
    // Natively the app removes the rail inset itself; CSS expansion is the
    // fallback for older apps and browsers.
    if (side && !useNative) root.setAttribute(ATTR_EXPANDED, side);
    else root.removeAttribute(ATTR_EXPANDED);
    root.style.setProperty(VAR_CAMERA, `${railBlockHeight(s)}px`);
    root.style.setProperty(VAR_SIDE, `${s.sideInset}px`);
    if (topRowGeometry(s)) root.setAttribute(ATTR_TOP_ROW, "");
    else {
      root.removeAttribute(ATTR_TOP_ROW);
      root.style.removeProperty(VAR_ROW_HEIGHT);
      root.style.removeProperty(VAR_ROW_RESERVE);
    }

    toggle.hidden = s.railSide === null || s.mode === "off";
    // Only while the rail is free: expanded, the chat covers that spot.
    sidebarButton.hidden = s.railSide === null || s.mode === "off" || side !== null;
    placeToggle(s);
    const expanded = side !== null;
    if (expanded !== toggleExpanded) {
      toggleExpanded = expanded;
      const label = expanded ? "Restore side rail" : "Expand chat into side rail";
      toggle.innerHTML = expanded ? ICON_RESTORE : ICON_EXPAND;
      toggle.setAttribute("aria-label", label);
      toggle.setAttribute("aria-pressed", String(expanded));
      toggle.title = label;
    }
  };

  const sync = () => {
    const reported = readWindowLayout();
    const windowLayout = sameWindowLayout(reported, getState().windowLayout)
      ? getState().windowLayout
      : reported;
    const detected = detectRail(probe, windowLayout);
    if (detected !== null && detected !== lastSide) {
      lastSide = detected;
      writeLastSide(detected);
    }
    const nativeExpanded =
      nativeSupported && windowLayout?.behavior === "disabled";
    if (windowLayout !== null) controller?.observe(windowLayout.behavior === "disabled");
    const railSide = resolveRailSide({
      detected,
      layout: windowLayout,
      nativeSupported,
      lastKnown: lastSide,
    });
    setState({
      windowLayout,
      railSide,
      nativeExpanded,
      measuredCameraBlock: measureCameraBlock(probe, detected, windowLayout),
    });
  };

  let frame = 0;
  const measure = () => {
    cancelAnimationFrame(frame);
    // Insets settle a frame after a resize or rotation.
    frame = requestAnimationFrame(() => {
      sync();
      // Width changes (sidebar, rotation) don't change plugin state, but they
      // decide whether the header fits the top row: re-apply directly.
      apply();
      if (observeShell()) retryUntilMounted();
    });
  };

  const unsubscribe = subscribe(apply);
  window.addEventListener("resize", measure, { signal });
  window.addEventListener("orientationchange", measure, { signal });
  window.visualViewport?.addEventListener("resize", measure, { signal });
  const onStorage = (event: StorageEvent) => {
    if (event.key === overrideKey) setState({ override: readOverride() });
  };
  window.addEventListener("storage", onStorage, { signal });

  // The probe is padded by the safe-area insets, so its border box changes
  // whenever they do: when the app turns the vertical bar on or off, also while
  // another screen covers the page and no resize event follows.
  const insetObserver = new ResizeObserver(() => measure());
  insetObserver.observe(probe, { box: "border-box" });
  // The top row's fit depends on the content area's width, which the sidebar
  // changes without a window resize.
  // The header row and bb's sidebar toggle mount (and change size) after this
  // script, as threads load and the sidebar opens or closes.
  const shellObserver = new ResizeObserver(() => measure());
  const observed = new Map<string, Element>();
  const OBSERVE = [
    "[data-app-content-shell]",
    '[data-testid="app-page-header-content-row"]',
    '[data-testid="app-sidebar-trigger-overlay"] [data-sidebar="trigger"]',
  ];
  const observeShell = () => {
    let missing = false;
    for (const selector of OBSERVE) {
      const el = document.querySelector(selector);
      const previous = observed.get(selector);
      if (el === previous) continue;
      if (previous) shellObserver.unobserve(previous);
      if (el) {
        shellObserver.observe(el);
        observed.set(selector, el);
      } else {
        observed.delete(selector);
        missing = true;
      }
    }
    return missing;
  };
  // Until they exist, look again shortly (bounded), so the first load gets the
  // right layout without waiting for a resize.
  let retries = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const retryUntilMounted = () => {
    clearTimeout(retryTimer);
    if (!observeShell()) {
      retries = 0;
      return;
    }
    if (retries++ < 25) retryTimer = setTimeout(() => {
      measure();
      retryUntilMounted();
    }, 400);
  };
  retryUntilMounted();
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  const unsubscribeNative = nativeBridge()?.subscribe?.((event) => {
    if (
      typeof event === "object" &&
      event !== null &&
      (event as { type?: unknown }).type === "window-layout"
    ) {
      measure();
      // Safe-area insets can settle after the layout event arrives.
      clearTimeout(settleTimer);
      settleTimer = setTimeout(measure, 300);
    }
  });

  sync();
  apply();

  return () => {
    // Leave the app as we found it when the plugin goes away: restore the
    // vertical bar if we turned it off. A reload or navigation also tears this
    // script down, sometimes before pagehide fires, so the restore waits a
    // tick: an unloading page never runs the timer, a disabled plugin does.
    // A plugin reload or update unmounts this copy and mounts a new one at
    // once, so the restore also waits until it is clear no copy is live.
    liveMounts.count -= 1;
    if (controller !== null) {
      setTimeout(() => {
        if (!pageGoingAway && liveMounts.count === 0) void controller.dispose();
      }, RESTORE_GRACE_MS);
    }
    cancelAnimationFrame(frame);
    clearTimeout(settleTimer);
    insetObserver.disconnect();
    shellObserver.disconnect();
    clearTimeout(retryTimer);
    unsubscribeNative?.();
    unsubscribe();
    style.remove();
    probe.remove();
    toggle.remove();
    sidebarButton.remove();
    cap.remove();
    root.removeAttribute(ATTR_RAIL);
    root.removeAttribute(ATTR_EXPANDED);
    root.style.removeProperty(VAR_CAMERA);
    root.style.removeProperty(VAR_SIDE);
    root.removeAttribute(ATTR_TOP_ROW);
    root.style.removeProperty(VAR_ROW_HEIGHT);
    root.style.removeProperty(VAR_ROW_RESERVE);
  };
}

// ---------------------------------------------------------------------------
// React pieces.

/** Feeds plugin settings into the store; renders nothing. */
function SettingsBridge() {
  const pluginId = experimental_usePluginId();
  const { values, isLoading } = useSettings();
  useEffect(() => {
    const key = `bb-plugin:${pluginId}:expanded`;
    if (key !== overrideKey) {
      overrideKey = key;
      setState({ override: readOverride() });
    }
  }, [pluginId]);
  useEffect(() => {
    if (isLoading) return;
    setState({
      mode: parseMode(values?.mode),
      cameraAreaHeight: parseCameraAreaHeight(values?.cameraAreaHeight),
      sideInset: parseSideInset(values?.sideInset),
    });
  }, [
    isLoading,
    values?.mode,
    values?.cameraAreaHeight,
    values?.sideInset,
  ]);
  return null;
}

function useDuoState() {
  return useSyncExternalStore(subscribe, getState, getState);
}

// Stops iOS zooming in when a field gets focus on wide screens (an unfolded
// Duo). Independent of the rail and of `mode`. Restores the viewport on unload.
function mountFocusZoomGuard() {
  if (!isIOSWebKit(navigator)) return;
  const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (!viewport) return;
  const original = viewport.content;
  const capped = viewportWithoutFocusZoom(original);
  if (capped === null) return;
  viewport.content = capped;
  return () => {
    if (viewport.content === capped) viewport.content = original;
  };
}

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "duo-rail-layout",
    mount: mountLayout,
  });

  app.contentScripts.register({
    id: "duo-rail-focus-zoom",
    mount: mountFocusZoomGuard,
  });

  app.slots.experimental_appOverlay({
    id: "duo-rail-settings",
    component: SettingsBridge,
  });

  app.slots.experimental_threadAction({
    id: "duo-rail-toggle",
    title: "Expand into side rail",
    icon: "Maximize2",
    group: "duo-rail",
    placement: "header",
    useData: () => useDuoState(),
    item: ({ data }) => {
      if (data.railSide === null || data.mode === "off") return null;
      const expanded = expandedSide(data) !== null;
      return {
        label: expanded ? "Restore side rail" : "Expand into rail",
        icon: expanded ? "Minimize2" : "Maximize2",
        run: () => writeOverride(!expanded),
      };
    },
  });
});
