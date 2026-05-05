/**
 * Pixel-precise scroll-spy + sidebar-driven scrollTo + a layout-shift
 * "anchor pin" helper for the Settings panel.
 *
 * Why not IntersectionObserver: rootMargin tricks produced visible lag at
 * section boundaries; a scroll listener that walks `groupRefs` is exact.
 *
 * Anchor pinning (`withScrollAnchor`): a single tick-and-scroll isn't
 * enough because the sidebar's slide transition keeps shifting offsets
 * for ~200 ms after our first measurement. Re-pinning per frame for the
 * full transition window tracks the anchor through the whole settle
 * process. The fallback chain (field → section → group) handles cases
 * where the original anchor gets unmounted mid-transition.
 */

import { BASE_MS, getDuration } from "$lib/shared/animations";

type AnchorEntry = { selector: string; offset: number };

export class ScrollSpy {
  scrollEl: HTMLDivElement | undefined = $state();
  viewportHeight = $state(0);
  showBottomFade = $state(true);
  selectedGroupId: string = $state("");
  groupRefs: Record<string, HTMLElement | undefined> = $state({});

  /** Set briefly during programmatic scrollTo so the scroll listener
   *  doesn't flicker `selectedGroupId` through every group on the way. */
  private isProgrammaticScroll = false;
  private getVisibleGroups: () => { id: string }[] = () => [];

  constructor(initialGroupId: string) {
    this.selectedGroupId = initialGroupId;
  }

  /** Inject the visible-groups accessor; required for scroll-spy to work. */
  setVisibleGroups(accessor: () => { id: string }[]): void {
    this.getVisibleGroups = accessor;
  }

  scrollTo(groupId: string, animEnabled: boolean): void {
    const el = this.groupRefs[groupId];
    if (!el || !this.scrollEl) return;
    this.isProgrammaticScroll = true;
    this.scrollEl.scrollTo({
      top: el.offsetTop,
      behavior: animEnabled ? "smooth" : "instant",
    });
    this.selectedGroupId = groupId;
    // 'scrollend' would be more precise but Safari/WebKit support is uneven;
    // fall back to a fixed timeout that comfortably covers a smooth scroll.
    setTimeout(() => {
      this.isProgrammaticScroll = false;
    }, 600);
  }

  updateFades(): void {
    if (!this.scrollEl) return;
    const { scrollTop, scrollHeight, clientHeight } = this.scrollEl;
    this.showBottomFade = scrollTop + clientHeight < scrollHeight - 1;
  }

  /** Recompute the active group: the last one whose header has reached
   *  (or passed) the top of the scroll viewport. */
  updateActiveGroup(searchMode: boolean): void {
    if (this.isProgrammaticScroll || searchMode || !this.scrollEl) return;
    const scrollTop = this.scrollEl.scrollTop;
    const groups = this.getVisibleGroups();
    let active = groups[0]?.id;
    for (const group of groups) {
      const el = this.groupRefs[group.id];
      if (!el) continue;
      // 1px buffer absorbs sub-pixel rounding when scrolling smoothly.
      if (el.offsetTop <= scrollTop + 1) {
        active = group.id;
      } else {
        break;
      }
    }
    if (active && active !== this.selectedGroupId) {
      this.selectedGroupId = active;
    }
  }

  onScroll(searchMode: boolean): void {
    this.updateFades();
    this.updateActiveGroup(searchMode);
  }

  /**
   * Capture the topmost field/group anchor before a layout-shifting change,
   * run the change, then re-pin the same anchor to its previous viewport
   * offset every frame for the full animation window. The fallback chain
   * (field → section → group) ensures we don't lose the anchor when the
   * original element gets unmounted (e.g. an advanced field is hidden).
   */
  withAnchor(fn: () => void): void {
    if (!this.scrollEl) {
      fn();
      return;
    }

    const scrollTop = this.scrollEl.scrollTop;
    const candidates = this.scrollEl.querySelectorAll<HTMLElement>(
      "[data-field-id], [data-group-id]",
    );
    let topAnchor: HTMLElement | null = null;
    for (const el of candidates) {
      if (el.offsetTop >= scrollTop) {
        topAnchor = el;
        break;
      }
    }

    const chain: AnchorEntry[] = [];
    if (topAnchor) {
      const offset = topAnchor.offsetTop - scrollTop;
      const fid = topAnchor.dataset.fieldId;
      const gid = topAnchor.dataset.groupId;
      if (fid) {
        chain.push({
          selector: `[data-field-id="${CSS.escape(fid)}"]`,
          offset,
        });
        // Fallback 1: the enclosing section. Pinned at offset 0 so its top
        // edge (with the sticky section header) lands at the viewport top,
        // keeps the user "in the same section" when only their specific
        // field has been hidden.
        const sectionAncestor = topAnchor.closest<HTMLElement>("[data-section-key]");
        if (sectionAncestor?.dataset.sectionKey) {
          chain.push({
            selector: `[data-section-key="${CSS.escape(sectionAncestor.dataset.sectionKey)}"]`,
            offset: 0,
          });
        }
        // Fallback 2: the enclosing group. Used when the entire section is
        // also gone (whole section marked advanced, or all of its fields
        // are advanced).
        const groupAncestor = topAnchor.closest<HTMLElement>("[data-group-id]");
        if (groupAncestor?.dataset.groupId) {
          chain.push({
            selector: `[data-group-id="${CSS.escape(groupAncestor.dataset.groupId)}"]`,
            offset: 0,
          });
        }
      } else if (gid) {
        chain.push({
          selector: `[data-group-id="${CSS.escape(gid)}"]`,
          offset,
        });
      }
    }

    fn();

    if (chain.length === 0) return;

    // Run a buffered window: full animation duration + 100ms grace so the
    // post-transition ResizeObserver tick (and any horizontal-mode flip it
    // triggers) have time to land.
    const deadline = performance.now() + getDuration(BASE_MS) + 100;

    const step = () => {
      if (!this.scrollEl) return;
      for (const entry of chain) {
        const el = this.scrollEl.querySelector<HTMLElement>(entry.selector);
        if (!el) continue;
        const target = Math.max(0, el.offsetTop - entry.offset);
        // Skip the assignment when we're already there to avoid spurious
        // scroll events stealing focus from a user-initiated scroll.
        if (Math.abs(this.scrollEl.scrollTop - target) > 0.5) {
          this.scrollEl.scrollTop = target;
        }
        break;
      }
      if (performance.now() < deadline) {
        requestAnimationFrame(step);
      }
    };

    requestAnimationFrame(step);
  }
}

export function useScrollSpy(initialGroupId: string): ScrollSpy {
  return new ScrollSpy(initialGroupId);
}
