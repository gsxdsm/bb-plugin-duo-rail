// Pure logic shared by the content script and its tests. No DOM access here.

export type Side = "left" | "right";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowLayout {
  edge: "none" | "leading" | "trailing";
  behavior: "automatic" | "disabled";
  occlusions: Rect[];
  /**
   * Where a top bar can sit beside the status bar (UIKit's top bar layout
   * guide), when the app reports it. Its right edge is where the free space
   * beside the time ends.
   */
  topBar?: Rect | null;
}

/**
 * Room left for the time and status icons beside a reported occlusion. The
 * occlusion only covers the camera cut-out; the time and icons are drawn to
 * its left. Used only when the app does not report `topBar`.
 */
export const STATUS_GLYPH_ALLOWANCE = 160;

/**
 * The x where the status bar's content starts in the top row (the time and
 * icons on the right), or null when nothing in the band says so. Prefers the
 * app's top bar guide; otherwise the leftmost occlusion in the band's right
 * half minus an allowance for the time and icons.
 */
export function statusStartX(input: {
  layout: WindowLayout | null;
  bandHeight: number;
  viewportWidth: number;
}): number | null {
  const topBar = input.layout?.topBar;
  if (topBar && topBar.width > 0) {
    const end = topBar.x + topBar.width;
    return end < input.viewportWidth - 1 ? end : null;
  }
  const inBand = (input.layout?.occlusions ?? []).filter(
    (r) =>
      r.y < input.bandHeight &&
      r.y + r.height > 0 &&
      r.x + r.width / 2 > input.viewportWidth / 2,
  );
  if (inBand.length === 0) return null;
  return Math.min(...inBand.map((r) => r.x)) - STATUS_GLYPH_ALLOWANCE;
}

/** The capability a bb app advertises when it can expand the rail natively. */
export const RAIL_EXPANSION_CAPABILITY = "rail-expansion";
/** The native request that turns the vertical bar off (expanded) or back on. */
export const SET_RAIL_EXPANDED = "set-rail-expanded";

export interface RailNative {
  capabilities?: unknown;
  request?: (kind: string, payload: unknown) => Promise<unknown>;
}

/** True when the shell can expand the rail natively. */
export function supportsNativeRailExpansion(
  native: RailNative | null,
): native is RailNative & {
  request: (kind: string, payload: unknown) => Promise<unknown>;
} {
  return (
    native !== null &&
    typeof native.request === "function" &&
    Array.isArray(native.capabilities) &&
    native.capabilities.includes(RAIL_EXPANSION_CAPABILITY)
  );
}

/**
 * Serialises `set-rail-expanded` requests. Only one request is in flight at a
 * time. Calls made meanwhile collapse to the latest wanted state, so rapid
 * taps end at whatever the user asked for last. A request is skipped when the
 * native side already holds that state.
 */
export class NativeRailController {
  private wanted: boolean | null = null;
  private applied: boolean | null;
  private chain: Promise<void> = Promise.resolve();
  private disposed = false;
  /** Whether this controller ever asked native to expand. */
  private expandedByUs = false;

  constructor(
    private readonly native: {
      request: (kind: string, payload: unknown) => Promise<unknown>;
    },
    /** What the native side currently holds, if known (e.g. from the window layout). */
    initial: boolean | null = null,
    private readonly onError: (error: unknown) => void = () => {},
  ) {
    this.applied = initial;
  }

  /** The state the last successful request left native in, or null if unknown. */
  get nativeExpanded(): boolean | null {
    return this.applied;
  }

  /** Records a state the native side reported on its own (e.g. a layout event). */
  observe(expanded: boolean): void {
    this.applied = expanded;
  }

  /** Asks native for `expanded`. Resolves once the queue has caught up. */
  set(expanded: boolean): Promise<void> {
    if (this.disposed) return this.chain;
    this.wanted = expanded;
    if (expanded) this.expandedByUs = true;
    this.chain = this.chain.then(() => this.flush());
    return this.chain;
  }

  /**
   * Queues a final restore and stops accepting new states. Restores when
   * native is (or may be) expanded: it is known expanded, an expansion is
   * still wanted (queued or in flight, so `applied` may not show it yet), or
   * this plugin expanded it and the state is unknown. The restore runs after
   * any in-flight request, so native never stays expanded.
   */
  dispose(): Promise<void> {
    if (this.disposed) return this.chain;
    const restore =
      this.applied === true ||
      this.wanted === true ||
      (this.expandedByUs && this.applied === null);
    this.disposed = true;
    if (!restore) return this.chain;
    this.wanted = false;
    this.chain = this.chain.then(() => this.flush());
    return this.chain;
  }

  private async flush(): Promise<void> {
    const target = this.wanted;
    if (target === null || target === this.applied) return;
    try {
      await this.native.request(SET_RAIL_EXPANDED, { expanded: target });
      this.applied = target;
    } catch (error) {
      // Leave the state unknown so the next call retries.
      this.applied = null;
      this.onError(error);
    }
  }
}

/**
 * The rail side to use. Native expansion removes the rail's inset, so inset
 * detection finds nothing. While the app reports the vertical bar disabled,
 * keep the last known side so the plugin can still offer Restore.
 */
export function resolveRailSide(input: {
  detected: Side | null;
  layout: WindowLayout | null;
  nativeSupported: boolean;
  lastKnown: Side | null;
}): Side | null {
  if (input.detected !== null) return input.detected;
  if (input.nativeSupported && input.layout?.behavior === "disabled") {
    return input.lastKnown ?? "right";
  }
  return null;
}

/**
 * Where to put the Restore button once native expansion has moved the status
 * bar to the top. When the top safe-area band is tall enough (the folded
 * cover screen: about 82pt), the button sits inside it, vertically centred,
 * right next to the status pill that holds the time (falling back to
 * whichever end is clear of it). When the band is
 * too thin (e.g. the unfolded inner screen), it would land on bb's header
 * controls, so it goes just below the header row at the right end instead,
 * again avoiding any reported occlusion.
 */
export function placeRestoreInTopBand(input: {
  insetTop: number;
  viewportWidth: number;
  occlusions: Rect[];
  size: number;
  margin?: number;
  /** Height of bb's header row below the top inset (`--bb-app-chrome-row-height`). */
  chromeRowHeight?: number;
  /** Where the time and status icons start (see `statusStartX`); null if unknown. */
  statusStart?: number | null;
}): { left: number; top: number; placement: "band" | "below-header" } {
  const margin = input.margin ?? 12;
  const pad = 4;
  const fitsBand = input.insetTop >= input.size + 2 * pad;
  const top = fitsBand
    ? Math.round((input.insetTop - input.size) / 2)
    : Math.round(input.insetTop + (input.chromeRowHeight ?? 48) + 8);
  const overlaps = (left: number) =>
    input.occlusions.some(
      (r) =>
        r.x < left + input.size &&
        r.x + r.width > left &&
        r.y < top + input.size &&
        r.y + r.height > top,
    );
  const leftEnd = margin;
  const rightEnd = input.viewportWidth - input.size - margin;
  if (fitsBand && input.statusStart != null) {
    // Right next to the time: just left of where the status content starts.
    const beside = input.statusStart - 8 - input.size;
    if (beside >= margin && !overlaps(beside)) {
      return { left: Math.round(beside), top, placement: "band" };
    }
  }
  // Otherwise: in the band, the left end (clear of a top-right status bar);
  // below the header, the right end, away from bb's sidebar control.
  const [first, second] = fitsBand ? [leftEnd, rightEnd] : [rightEnd, leftEnd];
  const left = !overlaps(first) ? first : !overlaps(second) ? second : first;
  return { left: Math.round(left), top, placement: fitsBand ? "band" : "below-header" };
}

/** The navigator fields that tell an iOS WebKit page apart (iPadOS reports MacIntel with touch). */
export interface BrowserPlatform {
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
}

export function isIOSWebKit({ userAgent, platform, maxTouchPoints }: BrowserPlatform): boolean {
  const isAppleWebKit = /\bAppleWebKit\//u.test(userAgent);
  const isIOSDevice =
    /\b(?:iPad|iPhone|iPod)\b/u.test(userAgent) || (platform === "MacIntel" && maxTouchPoints > 1);
  return isAppleWebKit && isIOSDevice;
}

/**
 * The viewport content with `maximum-scale=1` added, or null when it already
 * sets a maximum scale. iOS zooms the page in when a field under 16px gets
 * focus; bb only sizes fields to 16px below 768pt, so an unfolded Duo zooms
 * on every focus and the composer then stays behind the keyboard. A maximum
 * scale of 1 stops that zoom. Stopgap until get-bb/bb#7511 ships.
 */
export function viewportWithoutFocusZoom(content: string): string | null {
  if (/\bmaximum-scale\s*=/u.test(content)) return null;
  return content.trim() ? `${content}, maximum-scale=1` : "maximum-scale=1";
}

/**
 * True on the unfolded Duo's inner screen. Uses the screen size only: the
 * keyboard shrinks the window, never the screen, so it can't flip this.
 * No single-screen iPhone has a shorter side of 500pt or more; the folded
 * cover screen is about 466pt.
 */
export function isUnfoldedScreen(screen: { width: number; height: number }): boolean {
  return Math.min(screen.width, screen.height) >= 500;
}

/**
 * Geometry for the unfolded top row: bb's thread header moves up into the
 * status bar's row, stopping short of the status pill, with Restore placed
 * right next to the time in the same row.
 */
export function computeTopRow(input: {
  /** The top safe-area inset: the status band. */
  insetTop: number;
  /** bb's header row height. */
  chromeRowHeight: number;
  viewportWidth: number;
  /** Where the time and status icons start (see `statusStartX`); null if unknown. */
  statusStart: number | null;
  /** Restore button size in this row. */
  size: number;
  gap?: number;
  margin?: number;
  /** Where Restore sits when it lives in the left rail instead of this row. */
  railToggle?: { left: number; top: number } | null;
}): { rowHeight: number; reserveRight: number; toggle: { left: number; top: number } } {
  const gap = input.gap ?? 8;
  const margin = input.margin ?? 12;
  const rowHeight = Math.round(Math.max(input.insetTop, input.chromeRowHeight));
  const statusStart = input.statusStart ?? input.viewportWidth - margin + gap;
  if (input.railToggle) {
    // Restore is in the rail: the row only keeps clear of the time.
    return {
      rowHeight,
      reserveRight: Math.max(0, Math.round(input.viewportWidth - statusStart + gap)),
      toggle: input.railToggle,
    };
  }
  const toggleLeft = Math.round(statusStart - gap - input.size);
  return {
    rowHeight,
    reserveRight: Math.max(0, Math.round(input.viewportWidth - toggleLeft + gap)),
    toggle: { left: toggleLeft, top: Math.round((rowHeight - input.size) / 2) },
  };
}

/** The narrowest the thread title may get in the top row before it is not worth it. */
export const TOP_ROW_MIN_TITLE = 120;

/**
 * Whether bb's header fits in the top row beside the time: the title (at
 * least TOP_ROW_MIN_TITLE) plus its fixed-width controls must fit between
 * the row's left edge and Restore. When they don't (a narrow window or an
 * open sidebar), the plugin keeps bb's normal header below the status band.
 */
export function headerFitsTopRow(input: {
  rowLeft: number;
  controlsWidth: number;
  toggleLeft: number;
  gap?: number;
}): boolean {
  const available = input.toggleLeft - (input.gap ?? 8) - input.rowLeft;
  return available >= input.controlsWidth + TOP_ROW_MIN_TITLE;
}

/**
 * Restore's spot in the left side rail on the unfolded screen: centred over
 * bb's sidebar toggle (the rail's own control), vertically centred in the
 * status band above it. Null when the band is too thin to hold the button
 * or the rail's anchor isn't on screen.
 */
export function placeInLeftRail(input: {
  insetTop: number;
  /** bb's sidebar toggle in the rail. */
  anchor: Rect | null;
  size: number;
  pad?: number;
}): { left: number; top: number } | null {
  const pad = input.pad ?? 4;
  if (!input.anchor || input.anchor.width <= 0) return null;
  if (input.insetTop < input.size + 2 * pad) return null;
  const centre = input.anchor.x + input.anchor.width / 2;
  return {
    left: Math.max(pad, Math.round(centre - input.size / 2)),
    top: Math.round((input.insetTop - input.size) / 2),
  };
}
