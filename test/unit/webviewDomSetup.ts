import type { JSDOM } from "jsdom";
import { vi } from "vitest";

/**
 * jsdom implements neither SVG geometry APIs nor layout, nor `ResizeObserver`/
 * `requestAnimationFrame` (design.md's Testing Strategy jsdom caveats) — React Flow needs all
 * of these to measure/position nodes and drive its pan/zoom `<Pane>`. Stubbed once per test via
 * `vi.stubGlobal` (bare `ResizeObserver`/`requestAnimationFrame` references inside a bundled
 * library resolve through `globalThis`, not `window.*`, so `dom.window.X = ...` alone is not
 * enough once `window` itself has been swapped out via `vi.stubGlobal("window", dom.window)`).
 */
/** jsdom 30 does not implement `DOMMatrixReadOnly` at all (unlike a real browser). React Flow's
 * `updateNodeInternals` calls `new window.DOMMatrixReadOnly(style.transform)` to read the
 * current zoom out of the viewport's CSS transform; an identity matrix is enough here since
 * none of these tests drive real pan/zoom (no wheel events are dispatched). */
class StubDOMMatrixReadOnly {
  m11 = 1;
  m22 = 1;
  m33 = 1;
  m44 = 1;
  m12 = 0;
  m13 = 0;
  m14 = 0;
  m21 = 0;
  m23 = 0;
  m24 = 0;
  m31 = 0;
  m32 = 0;
  m34 = 0;
  m41 = 0;
  m42 = 0;
  m43 = 0;
  constructor() {
    /* identity regardless of input (a real `DOMMatrixReadOnly` accepts a transform-string
     * argument callers may pass; ignored here — see class doc) */
  }
}

export function stubReactFlowDom(dom: JSDOM): void {
  // Assigned directly on `dom.window` (not only via `vi.stubGlobal`): React Flow references
  // this as the *qualified* `window.DOMMatrixReadOnly`, which resolves through whatever object
  // `vi.stubGlobal("window", dom.window)` installed as the global `window` — i.e. this object.
  // jsdom's own `DOMWindow` type does not declare this property (it does not implement it), so
  // the assignment target is `unknown`-cast rather than typed against jsdom's declarations.
  (dom.window as unknown as { DOMMatrixReadOnly: unknown }).DOMMatrixReadOnly = StubDOMMatrixReadOnly;
  class StubResizeObserver {
    private readonly callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
    }
    // React Flow's node/handle measurement effects wait for at least one ResizeObserver
    // callback per observed element before they consider a node "measured" and register its
    // handle bounds in the connection lookup — without ever firing, every edge touching that
    // node is silently dropped (`error008`). Reporting a synchronous entry is enough:
    // `layoutGraph`'s own `width`/`height` (not this measurement) drives actual node sizing.
    observe(target: Element): void {
      this.callback([{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    unobserve(): void {
      /* no-op */
    }
    disconnect(): void {
      /* no-op */
    }
  }
  vi.stubGlobal("ResizeObserver", StubResizeObserver);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0) as unknown as number);
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => clearTimeout(handle));
  dom.window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
  } as Element["getBoundingClientRect"];
  // jsdom hardcodes `offsetWidth`/`offsetHeight` to 0 (it performs no real layout). React
  // Flow's `updateNodeInternals` gates its ENTIRE handle-bounds computation on
  // `dimensions.width && dimensions.height` being truthy (`@xyflow/system`'s `doUpdate`) — with
  // both stuck at 0, handle bounds are never computed, `getEdgePosition` always fails
  // `error008`, and every edge silently never renders, regardless of node measurement. A fixed
  // positive constant is enough; the real pixel size always comes from `layoutGraph`'s own
  // `width`/`height`, never from this DOM measurement.
  Object.defineProperty(dom.window.HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 100 });
  Object.defineProperty(dom.window.HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 40 });
}
