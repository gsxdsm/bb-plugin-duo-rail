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
  const fits = (left: number) =>
    left >= margin && left <= rightEnd && !overlaps(left);
  if (fitsBand) {
    // Sit right next to the time: beside the status pill, the widest
    // occlusion in the band, on its inner side (left of a pill at the top
    // right, right of one at the top left).
    const gap = 8;
    const pill = input.occlusions
      .filter((r) => r.y < input.insetTop && r.y + r.height > 0)
      .sort((a, b) => b.width - a.width)[0];
    if (pill) {
      const pillOnRight = pill.x + pill.width / 2 > input.viewportWidth / 2;
      const beside = pillOnRight
        ? pill.x - gap - input.size
        : pill.x + pill.width + gap;
      if (fits(beside)) {
        return { left: Math.round(beside), top, placement: "band" };
      }
    }
  }
  // Otherwise: in the band, prefer the left end; below the header, prefer the
  // right end, away from bb's sidebar control.
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
