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

  /** Queues a final restore (only if this plugin expanded native) and stops accepting new states. */
  dispose(): Promise<void> {
    if (this.disposed) return this.chain;
    const restore = this.applied === true || (this.expandedByUs && this.applied !== false);
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
 * bar to the top: inside the top safe-area band, vertically centred, on
 * whichever end of the band is clear of the status pill and camera.
 */
export function placeRestoreInTopBand(input: {
  insetTop: number;
  viewportWidth: number;
  occlusions: Rect[];
  size: number;
  margin?: number;
}): { left: number; top: number } {
  const margin = input.margin ?? 12;
  const top = Math.max(4, Math.round((input.insetTop - input.size) / 2));
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
  const left = !overlaps(leftEnd) ? leftEnd : !overlaps(rightEnd) ? rightEnd : leftEnd;
  return { left: Math.round(left), top };
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
