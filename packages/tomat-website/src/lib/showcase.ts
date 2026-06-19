import gsap from "gsap";

// Helpers for scripting a feature-showcase timeline: a virtual cursor that moves
// to, hovers, and clicks elements inside a stage, plus simulated typing and
// scrolling. Targets are resolved lazily by CSS selector (queried inside the
// stage at tween time) so elements that only appear mid-timeline still resolve.

export type Timeline = gsap.core.Timeline;
type Pos = number | string | undefined;

// App-surface dimensions, derived from the client's fixed 700x1200 window
// (tauri.conf.json) and rendered 1:1 in the demo.
//   APP_W: chat/settings content width = window 700 - the panel's max-w cap
//          (5rem) -> 620; also the bubble `max-w-[calc(100vw-5rem)]` value.
//   APP_H: the tallest surface, the settings panel at 80vh of 1200 = 960.
//   APP_SHADOW: outward reach of the bubble drop shadow + blur halo, so the box
//          leaves room for it instead of clipping the top/bottom edges.
export const APP_W = 620;
export const APP_H = 960;
export const APP_SHADOW = 20;

export class Demo {
  constructor(
    private cursor: HTMLElement,
    private stage: HTMLElement,
  ) {}

  private q(sel: string): HTMLElement | null {
    return this.stage.querySelector<HTMLElement>(sel);
  }

  /** The stage's render scale: the showcase frame is sized at a fixed design
   *  resolution and CSS-`transform: scale()`d to fit. `getBoundingClientRect`
   *  returns scaled (on-screen) pixels while `offsetWidth` stays the unscaled
   *  layout width, so their ratio recovers the active scale. The cursor's
   *  translate lives in the stage's UNSCALED local space (the ancestor transform
   *  scales it), so every position below is divided back by this. */
  private scale(): number {
    const w = this.stage.getBoundingClientRect().width;
    const o = this.stage.offsetWidth;
    return o ? w / o : 1;
  }

  /** Center of `el` in the stage's unscaled local coordinate space. */
  private center(el: HTMLElement): { x: number; y: number } {
    const r = el.getBoundingClientRect();
    const s = this.stage.getBoundingClientRect();
    const k = this.scale();
    return { x: (r.left - s.left + r.width / 2) / k, y: (r.top - s.top + r.height / 2) / k };
  }

  /** Place the cursor instantly at fractional stage coordinates (0..1). Uses the
   *  unscaled layout size so the fraction maps into the cursor's local space. */
  placeFrac(fx: number, fy: number): void {
    gsap.set(this.cursor, { x: this.stage.offsetWidth * fx, y: this.stage.offsetHeight * fy });
  }

  /** Tween the cursor to a target element (lazily resolved). */
  move(tl: Timeline, sel: string, opts: { duration?: number; at?: Pos } = {}): void {
    tl.to(
      this.cursor,
      {
        duration: opts.duration ?? 0.7,
        ease: "power2.inOut",
        x: () => {
          const el = this.q(sel);
          return el ? this.center(el).x : (gsap.getProperty(this.cursor, "x") as number);
        },
        y: () => {
          const el = this.q(sel);
          return el ? this.center(el).y : (gsap.getProperty(this.cursor, "y") as number);
        },
      },
      opts.at,
    );
  }

  /** Toggle the `data-hover` attribute (resolves to the same styles as :hover). */
  hover(tl: Timeline, sel: string, on: boolean, at?: Pos): void {
    tl.add(() => {
      const el = this.q(sel);
      if (!el) return;
      if (on) el.setAttribute("data-hover", "");
      else el.removeAttribute("data-hover");
    }, at);
  }

  /** A click: a brief cursor press + a flash of `data-active`, then `fn`. */
  click(tl: Timeline, sel: string, fn?: () => void, at?: Pos): void {
    tl.to(
      this.cursor,
      { scale: 0.82, duration: 0.07, yoyo: true, repeat: 1, ease: "power1.inOut" },
      at,
    ).add(() => {
      const el = this.q(sel);
      if (el) {
        el.setAttribute("data-active", "");
        gsap.delayedCall(0.18, () => el.removeAttribute("data-active"));
      }
      fn?.();
    });
  }

  /** Type `text` character by character into a setter (e.g. a `$state` writer). */
  type(
    tl: Timeline,
    set: (v: string) => void,
    text: string,
    opts: { duration?: number; at?: Pos } = {},
  ): void {
    const o = { n: 0 };
    tl.to(
      o,
      {
        n: text.length,
        duration: opts.duration ?? text.length * 0.055,
        ease: "none",
        snap: { n: 1 },
        onUpdate: () => set(text.slice(0, Math.round(o.n))),
      },
      opts.at,
    );
  }

  /** A still hold of `dur` seconds. */
  hold(tl: Timeline, dur: number, at?: Pos): void {
    tl.to({}, { duration: dur }, at);
  }

  /** Smoothly scroll an element's `scrollTop` from its current value to `target`. */
  scroll(
    tl: Timeline,
    getEl: () => HTMLElement | undefined,
    target: number,
    opts: { duration?: number; at?: Pos } = {},
  ): void {
    const o = { v: 0 };
    let from = 0;
    tl.to(
      o,
      {
        v: 1,
        duration: opts.duration ?? 1.6,
        ease: "power1.inOut",
        onStart: () => {
          from = getEl()?.scrollTop ?? 0;
        },
        onUpdate: () => {
          const el = getEl();
          if (el) el.scrollTop = from + (target - from) * o.v;
        },
      },
      opts.at,
    );
  }
}
