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
import { useEffect, useSyncExternalStore } from "react";
import {
  definePluginApp,
  experimental_usePluginId,
  useSettings,
} from "@get-bb/plugin-sdk/app";

type Mode = "auto" | "manual" | "off";
type Side = "left" | "right";

interface DuoState {
  mode: Mode;
  /** Height of the camera + status bar block at the top of the rail. */
  cameraAreaHeight: number;
  /** Points kept clear on the rail side; 0 lets the chat fill the rail. */
  sideInset: number;
  /** The user's per-device choice; null follows the mode. */
  override: boolean | null;
  /** The side the rail is on, or null when no rail is detected. */
  railSide: Side | null;
}

const DEFAULT_CAMERA_AREA_HEIGHT = 240;
const TOGGLE_SIZE = 36;
const ATTR_RAIL = "data-bb-duo-rail";
const ATTR_EXPANDED = "data-bb-duo-rail-expanded";
const VAR_CAMERA = "--bb-duo-camera-height";
const VAR_SIDE = "--bb-duo-side-inset";

// ---------------------------------------------------------------------------
// Store shared by the content script, the settings bridge and the action.

let state: DuoState = {
  mode: "auto",
  cameraAreaHeight: DEFAULT_CAMERA_AREA_HEIGHT,
  sideInset: 0,
  override: null,
  railSide: null,
};
const listeners = new Set<() => void>();
let overrideKey = "bb-plugin:duo-rail:expanded";

function setState(patch: Partial<DuoState>) {
  const next = { ...state, ...patch };
  if (
    next.mode === state.mode &&
    next.cameraAreaHeight === state.cameraAreaHeight &&
    next.sideInset === state.sideInset &&
    next.override === state.override &&
    next.railSide === state.railSide
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
`;

// Lucide maximize-2 / minimize-2, drawn in currentColor.
const SVG_OPEN =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
const ICON_EXPAND = `${SVG_OPEN}<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" x2="14" y1="3" y2="10"/><line x1="3" x2="10" y1="21" y2="14"/></svg>`;
const ICON_SIDEBAR = `${SVG_OPEN}<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/></svg>`;
const ICON_RESTORE = `${SVG_OPEN}<polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" x2="21" y1="10" y2="3"/><line x1="3" x2="10" y1="21" y2="14"/></svg>`;

// ---------------------------------------------------------------------------
// Rail detection: a hidden probe padded by every safe-area inset.

function detectRail(probe: HTMLElement): Side | null {
  const style = getComputedStyle(probe);
  const left = parseFloat(style.paddingLeft) || 0;
  const right = parseFloat(style.paddingRight) || 0;
  // A notched iPhone only has side insets in landscape. A folded Duo has its
  // rail beside the camera in portrait, so a side inset in portrait is the rail.
  const portrait = window.innerHeight > window.innerWidth;
  if (!portrait || Math.max(left, right) < 1) return null;
  return right >= left ? "right" : "left";
}

function mountLayout({ signal }: { signal: AbortSignal }) {
  const root = document.documentElement;

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
  const placeToggle = (s: DuoState) => {
    if (s.railSide === null) return;
    const probeStyle = getComputedStyle(probe);
    const rail =
      parseFloat(s.railSide === "right" ? probeStyle.paddingRight : probeStyle.paddingLeft) || 0;
    const top = Math.max(parseFloat(probeStyle.paddingTop) || 0, s.cameraAreaHeight) + 12;
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
    if (side) root.setAttribute(ATTR_EXPANDED, side);
    else root.removeAttribute(ATTR_EXPANDED);
    root.style.setProperty(VAR_CAMERA, `${s.cameraAreaHeight}px`);
    root.style.setProperty(VAR_SIDE, `${s.sideInset}px`);

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

  let frame = 0;
  const measure = () => {
    cancelAnimationFrame(frame);
    // Insets settle a frame after a resize or rotation.
    frame = requestAnimationFrame(() => {
      setState({ railSide: detectRail(probe) });
      placeToggle(getState());
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

  setState({ railSide: detectRail(probe) });
  apply();

  return () => {
    cancelAnimationFrame(frame);
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
  }, [isLoading, values?.mode, values?.cameraAreaHeight, values?.sideInset]);
  return null;
}

function useDuoState() {
  return useSyncExternalStore(subscribe, getState, getState);
}

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "duo-rail-layout",
    mount: mountLayout,
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
