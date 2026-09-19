/** Presentation-only cursor: stored messages always retain the complete text.
 * Pacing follows the observed input cadence, capped at 240ms; done/hidden/reduced-motion
 * paths bypass animation. A timer also catches up when rAF is suspended.
 */
export interface RevealClock {
  now(): number;
  frame(callback: () => void): number;
  cancelFrame(id: number): void;
  timeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(id: ReturnType<typeof setTimeout>): void;
}
const browserClock: RevealClock = {
  now: () => performance.now(),
  frame: callback => requestAnimationFrame(callback),
  cancelFrame: id => cancelAnimationFrame(id),
  timeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: id => clearTimeout(id),
};
export class StreamReveal {
  private text = "";
  private visible: number;
  private from = 0;
  private started = 0;
  private lastFrame = 0;
  private lastArrival: number | undefined;
  private cadence = 80;
  private duration = 80;
  private frame: number | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private listeners = new Set<{ start: number; end: number; notify: () => void }>();
  private clock: RevealClock;
  constructor(live: boolean, clock: RevealClock = browserClock) {
    this.clock = clock;
    this.visible = live ? 0 : Infinity;
  }
  read(start: number, length: number) {
    return Math.max(0, Math.min(length, this.visible - start));
  }
  subscribe(start: number, length: number, notify: () => void) {
    const listener = { start, end: start + length, notify };
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private publish(next: number) {
    const previous = this.visible;
    this.visible = next;
    if (next === previous) return;
    for (const listener of this.listeners) {
      if (next < previous || (listener.end > previous && listener.start < next)) listener.notify();
    }
  }
  update(text: string, animate: boolean) {
    // Repeated renders of the same snapshot must not restart the animation.
    if (text === this.text) {
      if (!animate) this.finish();
      return;
    }
    const now = this.clock.now();
    const append = text.startsWith(this.text);
    if (append && this.lastArrival !== undefined) {
      const gap = now - this.lastArrival;
      // Ignore same-batch events. Bound long provider pauses so they cannot
      // turn into seconds of artificial display lag on the next chunk.
      if (gap >= 16) this.cadence = this.cadence * 0.5 + Math.min(gap, 220) * 0.5;
    } else if (!append) {
      this.cadence = 80;
    }
    this.lastArrival = now;
    this.text = text;
    if (!animate || !append || this.visible === Infinity) {
      this.finish();
      return;
    }
    if (this.visible >= text.length) return;
    if (this.frame !== undefined) this.clock.cancelFrame(this.frame);
    this.from = this.visible;
    // A fixed 80ms drain left an empty queue between OMP's ~144ms bursts.
    // Spread normal bursts over their arrival cadence; give larger bursts
    // more room, while keeping a strict upper bound on presentation delay.
    this.duration = Math.min(240, Math.max(80, this.cadence * 1.1,
      Math.min(240, (text.length - this.visible) * 6)));
    this.started = now;
    const tick = () => {
      this.frame = undefined;
      this.lastFrame = this.clock.now();
      const fraction = Math.min(1, (this.clock.now() - this.started) / this.duration);
      this.publish(Math.floor(this.from + (this.text.length - this.from) * fraction));
      if (fraction < 1) this.frame = this.clock.frame(tick);
      else this.cancel();
    };
    this.frame = this.clock.frame(tick);
    if (this.timer === undefined) {
      this.lastFrame = this.started;
      const watchdog = () => {
        this.timer = undefined;
        const idle = this.clock.now() - this.lastFrame;
        if (idle >= 100) this.finish();
        else this.timer = this.clock.timeout(watchdog, 100 - idle);
      };
      this.timer = this.clock.timeout(watchdog, 100);
    }
  }
  finish() {
    this.cancel();
    this.publish(this.text.length);
  }
  cancel() {
    if (this.frame !== undefined) this.clock.cancelFrame(this.frame);
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.frame = undefined;
    this.timer = undefined;
  }
}

const segmenter = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
/** Never show half an emoji, combining sequence, or surrogate pair. */
export function visiblePrefix(text: string, count: number) {
  return createVisibleTextReader(text).prefix(count);
}

/** Window follows the revealed cursor, not the received tail, so a large
 * thinking chunk cannot hide all content while the cursor catches up. */
export function visibleWindow(text: string, count: number, limit: number) {
  return createVisibleTextReader(text).window(count, limit);
}

/** One segmentation handle per text snapshot, shared by all reveal frames.
 * In particular, long thinking text must not recreate both full-text and
 * prefix segmentation handles on every frame. Boundaries still use the
 * platform grapheme algorithm, including joined emoji and combining marks. */
export function createVisibleTextReader(text: string) {
  let segments: ReturnType<Intl.Segmenter["segment"]> | undefined;
  const boundary = (count: number) => {
    if (count >= text.length) return text.length;
    if (count <= 0) return 0;
    segments ??= segmenter?.segment(text);
    return segments?.containing?.(count)?.index ?? text.length;
  };
  return {
    prefix: (count: number) => text.slice(0, boundary(count)),
    window(count: number, limit: number) {
      const end = boundary(count);
      if (end <= limit) return text.slice(0, end);
      const start = boundary(end - limit);
      // Without grapheme support, show complete text rather than split emoji.
      return text.slice(start > end - limit ? 0 : start, end);
    },
  };
}
