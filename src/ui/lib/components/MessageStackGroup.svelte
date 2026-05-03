<script lang="ts">
  import type { Snippet } from "svelte";
  import { onDestroy, tick } from "svelte";
  import { SvelteMap } from "svelte/reactivity";
  import type { Message } from "$lib/shared/types";
  import { settingsState } from "$lib/state";
  import { expansionState } from "$lib/state/expansion.svelte";
  import { BASE_MS, getDuration } from "$lib/shared/animations";
  import Bubble from "./Bubble.svelte";

  let {
    messages,
    item,
  }: {
    messages: Message[];
    /** Render snippet for each message. Receives the per-message neighbor
     *  flags so the inner Bubble can drop the corresponding corner radius. */
    item: Snippet<
      [
        {
          msg: Message;
          idx: number;
          neighborLeft: boolean;
          neighborRight: boolean;
        },
      ]
    >;
  } = $props();

  let alignment = $derived(settingsState.getAlignment());

  // Two display modes:
  //   - "horizontal": single non-wrapping row. Bodies clipped to the small
  //     bubble height; container scrolls along the inline axis with shift +
  //     wheel; auto-scrolls to the latest bubble on each insert; edge fades
  //     mark scrollable directions. New stacks always start here.
  //   - "expanded": multi-row flex-wrap. Per-bubble Expandables behave as
  //     today (chevron toggles body); an X close-bubble is prepended at the
  //     alignment-leading edge; clicking it collapses every Expandable in
  //     the stack and reverts to "horizontal".
  //
  // The user can toggle between them via stack click / X click; that's
  // tracked in `userMode`. The actual `mode` is forced to "expanded" when
  // either of these is true:
  //   - `awaitingInput`: a tool call needs the user (status `awaiting_user`).
  //     The X close-bubble is hidden in this case; dismissing makes no
  //     sense while the tool blocks on input.
  //   - `anyExpanded`: any message in the stack has its body open. Keeping
  //     the row in horizontal mode while a bubble is expanded would make the
  //     bubble's body invisible (clipped by `max-h-8`), so the stack snaps
  //     to expanded layout to surface the body. This also enforces the rule
  //     that horizontal stacks only contain collapsed bubbles.
  // When neither holds, `mode` reverts to whatever `userMode` was last set
  // to (default horizontal).
  let userMode = $state<"horizontal" | "expanded">("horizontal");
  let awaitingInput = $derived(
    messages.some(
      (msg) => msg.role === "tool" && msg.toolCall?.status === "awaiting_user",
    ),
  );
  // Layout-relevant per-bubble expansion state. Mirrors `expansionState[id]`
  // immediately on open (so the chain breaks and the body has room to
  // animate in right away), but lags the close transition by the body
  // animation duration so the chain doesn't unbreak before the body has
  // finished collapsing.
  const layoutExpanded = new SvelteMap<string, boolean>();
  const transitionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  $effect(() => {
    for (const msg of messages) {
      if (msg.id === undefined) continue;
      const id = msg.id;
      const real = expansionState.get(id) ?? false;
      const layout = layoutExpanded.get(id) ?? false;
      if (real === layout) {
        // States agree: cancel any pending close-delay (e.g. user toggled
        // back open during the delay window).
        const t = transitionTimers.get(id);
        if (t) {
          clearTimeout(t);
          transitionTimers.delete(id);
        }
        continue;
      }
      if (real) {
        // Opening: apply layout state immediately so basis-full /
        // chain-break and the unclamped wrapper are in place before the
        // body's open transition starts.
        const t = transitionTimers.get(id);
        if (t) {
          clearTimeout(t);
          transitionTimers.delete(id);
        }
        layoutExpanded.set(id, true);
        continue;
      }
      // Closing: hold the layout state until the body's close transition
      // finishes, then mirror.
      if (transitionTimers.has(id)) continue;
      const duration = getDuration(BASE_MS);
      if (duration === 0) {
        layoutExpanded.set(id, false);
        continue;
      }
      const t = setTimeout(() => {
        // Re-read at firing time in case the user toggled back open during
        // the delay.
        const current = expansionState.get(id) ?? false;
        layoutExpanded.set(id, current);
        transitionTimers.delete(id);
      }, duration);
      transitionTimers.set(id, t);
    }
  });
  onDestroy(() => {
    for (const t of transitionTimers.values()) clearTimeout(t);
    transitionTimers.clear();
  });
  // Layout-expanded is enough on its own for `mode`: it tracks open
  // immediately and stays open through the close transition.
  let anyLayoutExpanded = $derived(messages.some(isMsgLayoutExpanded));
  // True when the bubbles' natural total width exceeds the available
  // container width, i.e. when a horizontal layout would actually need to
  // scroll. Updated by the ResizeObserver below. When false, the stack has
  // no use for the horizontal/expanded toggle: there's nothing hidden past
  // an edge to reveal, so we stay in expanded layout (no clipping, no X
  // close-bubble) regardless of `userMode`.
  let overflows = $state(false);
  let mode = $derived<"horizontal" | "expanded">(
    awaitingInput || anyLayoutExpanded || !overflows ? "expanded" : userMode,
  );

  let wrapper: HTMLDivElement | undefined = $state();
  // True when the flex-wrap row spans more than one line. When this happens
  // we bypass the per-bubble neighbor calc and force every bubble in the
  // group to render with the less-rounded corners on both sides; wrapping
  // visually breaks the chain along directions that don't map cleanly to
  // "left neighbor" / "right neighbor", so a uniform treatment looks better.
  let wrapped = $state(false);

  function checkWrap() {
    if (!wrapper || mode !== "expanded") {
      wrapped = false;
      return;
    }
    const kids = Array.from(wrapper.children) as HTMLElement[];
    if (kids.length < 2) {
      wrapped = false;
      return;
    }
    const top = kids[0].offsetTop;
    wrapped = kids.some((k) => k.offsetTop !== top);
  }

  // Sum the natural offsetWidths of the bubble children + flex gaps and
  // compare against the wrapper's clientWidth to decide whether horizontal
  // layout would actually overflow. Skipped whenever a bubble is forced
  // expanded (immediate or delayed) because `basis-full` in that case
  // inflates a child's offsetWidth to the full row, which would falsely
  // report overflow. While forced-expanded the flag's value is irrelevant
  // anyway; mode is already pinned to "expanded".
  function checkOverflow() {
    if (!wrapper) return;
    if (anyLayoutExpanded || awaitingInput) return;
    const kids = Array.from(wrapper.children) as HTMLElement[];
    if (kids.length === 0) {
      overflows = false;
      return;
    }
    const total = kids.reduce((sum, k) => sum + k.offsetWidth, 0);
    // gap-1 = 0.25rem = 4px between siblings.
    const gaps = Math.max(0, kids.length - 1) * 4;
    overflows = total + gaps > wrapper.clientWidth + 1;
  }

  // Edge-fade insets (set as CSS vars on the wrapper). Non-zero on a side
  // means there's hidden content past that edge, so the mask gradient fades
  // to transparent over a `--fade-*` band; zero collapses the band so the
  // edge stays opaque.
  function updateFade() {
    if (!wrapper) return;
    if (mode !== "horizontal") {
      wrapper.style.setProperty("--fade-left", "0px");
      wrapper.style.setProperty("--fade-right", "0px");
      return;
    }
    const left = wrapper.scrollLeft > 4 ? "1rem" : "0px";
    const remainingRight =
      wrapper.scrollWidth - wrapper.scrollLeft - wrapper.clientWidth;
    const right = remainingRight > 4 ? "1rem" : "0px";
    wrapper.style.setProperty("--fade-left", left);
    wrapper.style.setProperty("--fade-right", right);
  }

  // Sticky-scroll-to-end state: the stack pins itself to the latest bubble
  // by default, and only stops doing so once the user explicitly scrolls
  // away. Re-pins as soon as they scroll back to the end. Detection is
  // position-based (lastElementChild's leading edge inside the wrapper),
  // not event-source based, so programmatic `scrollIntoView` calls land at
  // the end and immediately clear `userScrolled` on the resulting scroll
  // event, avoiding the in-flight ambiguity of `behavior: "smooth"`.
  let userScrolled = $state(false);

  function isAtEnd(): boolean {
    if (!wrapper || !wrapper.lastElementChild) return true;
    const wrapperRect = wrapper.getBoundingClientRect();
    const lastRect = wrapper.lastElementChild.getBoundingClientRect();
    // flex-row-reverse (right alignment): lastElementChild visually sits at
    // the wrapper's left. "end" means its left edge fits inside.
    if (alignment === "right") {
      return lastRect.left >= wrapperRect.left - 4;
    }
    // LTR (left/center alignment): lastElementChild is at the right edge.
    return lastRect.right <= wrapperRect.right + 4;
  }

  function pinToEnd() {
    if (!wrapper || mode !== "horizontal") return;
    if (userScrolled) return;
    if (!wrapper.lastElementChild) return;
    wrapper.lastElementChild.scrollIntoView({
      inline: "nearest",
      block: "nearest",
      behavior: "instant",
    });
  }

  $effect(() => {
    // Re-attach observers whenever the message list or mode changes. This
    // also doubles as the trigger that pins the stack to the end after any
    // structural change (new bubble, bubble auto-collapsed, mode flipped),
    // since pinToEnd is gated on `userScrolled` it's safe to over-call.
    void messages;
    void mode;
    if (!wrapper) return;
    const ro = new ResizeObserver(() => {
      checkWrap();
      checkOverflow();
      updateFade();
      pinToEnd();
    });
    ro.observe(wrapper);
    for (const child of Array.from(wrapper.children)) ro.observe(child);
    const onScroll = () => {
      updateFade();
      if (mode !== "horizontal") return;
      userScrolled = !isAtEnd();
    };
    wrapper.addEventListener("scroll", onScroll, { passive: true });
    checkWrap();
    checkOverflow();
    updateFade();
    // Wait one tick so the layout reflows from the message/mode change
    // before measuring `lastElementChild` for scrollIntoView.
    void tick().then(pinToEnd);
    return () => {
      ro.disconnect();
      wrapper?.removeEventListener("scroll", onScroll);
    };
  });

  // Immediate expansion: reads `expansionState` directly. Used for `mode`
  // forcing on open (so the wrapper unclamps the moment the body starts to
  // animate in) and for the body's own visibility. `expansionState` is the
  // ground truth.
  function isMsgExpanded(msg: Message): boolean {
    if (msg.id === undefined) return false;
    return expansionState.get(msg.id) ?? false;
  }
  // Delayed expansion: reads the layoutExpanded view that lags real
  // expansion in both directions. Used for layout-side decisions (mode flip
  // back to horizontal, basis-full per bubble, X-adjacency neighbour flags)
  // so the chain break/unbreak only happens after the body's transition has
  // had time to play.
  function isMsgLayoutExpanded(msg: Message): boolean {
    if (msg.id === undefined) return false;
    return layoutExpanded.get(msg.id) ?? false;
  }

  // Collapse every Expandable in the stack. Used when the user dismisses the
  // expanded mode via the X bubble. The spec is that the stack returns to
  // a clean horizontal row with no per-bubble bodies open.
  function collapseAll() {
    for (const msg of messages) {
      if (msg.id !== undefined) expansionState.set(msg.id, false);
    }
  }

  // Whether the X bubble has a non-expanded message touching it in the row.
  // Reads the delayed view so the X's own corner-radius adjustment doesn't
  // pop the moment a neighbour starts to expand/collapse. It follows the
  // chain break/unbreak.
  let xHasTrailingNeighbor = $derived(
    mode === "expanded" &&
      messages.length > 0 &&
      !isMsgLayoutExpanded(messages[0]),
  );

  function neighbors(idx: number): {
    neighborLeft: boolean;
    neighborRight: boolean;
  } {
    if (wrapped) return { neighborLeft: true, neighborRight: true };
    // Per-bubble expansion only forces row breaks in expanded mode (where
    // `basis-full` activates). In horizontal mode bodies are clipped, so an
    // expansionState-true bubble still flows in line and keeps its DOM
    // neighbours. Layout-expanded (delayed) view is used here so the
    // neighbour flags don't pop on/off mid-animation.
    const horizontal = mode === "horizontal";
    const thisExpanded = !horizontal && isMsgLayoutExpanded(messages[idx]);
    if (thisExpanded) {
      return { neighborLeft: false, neighborRight: false };
    }
    const prevExpanded =
      !horizontal && idx > 0 && isMsgLayoutExpanded(messages[idx - 1]);
    const nextExpanded =
      !horizontal &&
      idx < messages.length - 1 &&
      isMsgLayoutExpanded(messages[idx + 1]);
    // The X bubble at DOM[0] in expanded mode is the DOM-prev of messages[0].
    // It's hidden whenever a tool is blocking on user input OR the natural
    // width fits the row (no scroll to dismiss into); see `mode` and the X
    // render guard below.
    const xPresent = mode === "expanded" && !awaitingInput && overflows;
    const hasDomPrev = (idx > 0 && !prevExpanded) || (idx === 0 && xPresent);
    const hasDomNext = idx < messages.length - 1 && !nextExpanded;
    if (alignment === "right") {
      // flex-row-reverse: DOM[i+1] is visually to the LEFT of DOM[i]
      return { neighborLeft: hasDomNext, neighborRight: hasDomPrev };
    }
    return { neighborLeft: hasDomPrev, neighborRight: hasDomNext };
  }

  // Capture-phase click handler: in horizontal mode, intercept clicks before
  // they reach descendants (chevrons, context-menu hooks) so the only effect
  // of clicking anywhere on the stack is to expand it. `stopPropagation` on
  // the captured event prevents the at-target dispatch, so the underlying
  // bubble's own click listeners never fire.
  function handleStackClickCapture(e: MouseEvent) {
    if (mode !== "horizontal") return;
    e.stopPropagation();
    userMode = "expanded";
  }

  function handleXClick(e: MouseEvent) {
    e.stopPropagation();
    collapseAll();
    userMode = "horizontal";
    // The main effect re-runs on the resulting `mode` change and pins the
    // stack to the end (gated by `userScrolled`).
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  bind:this={wrapper}
  role="presentation"
  class="flex gap-1 w-fit max-w-[calc(100vw-5rem)] stack-group"
  class:flex-wrap={mode === "expanded"}
  class:overflow-x-auto={mode === "horizontal"}
  class:no-scrollbar={mode === "horizontal"}
  class:pointer-events-auto={mode === "horizontal"}
  class:pointer-events-none={mode === "expanded"}
  class:cursor-pointer={mode === "horizontal"}
  class:flex-row-reverse={alignment === "right"}
  class:mr-auto={alignment === "left"}
  class:ml-auto={alignment === "right"}
  class:mx-auto={alignment === "center"}
  class:justify-center={alignment === "center" && mode === "expanded"}
  class:stack-horizontal={mode === "horizontal"}
  onclickcapture={handleStackClickCapture}
>
  {#if mode === "expanded" && !awaitingInput && overflows}
    <!-- X close-bubble: visually leads the stack (DOM[0] sits at the
         alignment-leading edge under flex-row-reverse / row). Hovering the
         wrapper applies the same `filter: invert(1) hue-rotate(180deg)` used
         elsewhere for the inverted-progress overlay, so the inversion looks
         and feels consistent across the app. Hidden while a bubble in the
         stack is auto-forcing expanded mode (e.g., a tool awaiting user
         input). The user shouldn't be able to dismiss the request. -->
    <div class="bubble-x-wrapper">
      <Bubble
        selectedAlignment={alignment}
        size="small"
        extraClass="hover:cursor-pointer flex items-center justify-center !px-2 w-8"
        neighborLeft={alignment === "right" && xHasTrailingNeighbor}
        neighborRight={alignment !== "right" && xHasTrailingNeighbor}
        onclick={handleXClick}
      >
        <i class="i-material-symbols-close-rounded text-base"></i>
      </Bubble>
    </div>
  {/if}
  {#each messages as msg, idx (msg.id ?? idx)}
    {@const n = neighbors(idx)}
    {@const expanded = mode === "expanded" && isMsgLayoutExpanded(msg)}
    <!-- Per-bubble flex item.
         - Horizontal mode: `max-h-8 overflow-hidden` clips any expanded
           body so all bubbles share the small-bubble height; `flex-shrink-0`
           keeps the bubble at its natural width so the row overflows into
           the scroll container.
         - Expanded mode + this bubble expanded: `basis-full` promotes it to
           its own row inside the flex-wrap container; siblings reflow above
           and below. Keeping the wrapper stable across mode toggles means
           the bubble component identity is preserved, so slide-in
           animations don't replay. -->
    <div
      class:basis-full={expanded}
      class:flex={expanded}
      class:justify-start={expanded && alignment === "left"}
      class:justify-end={expanded && alignment === "right"}
      class:justify-center={expanded && alignment === "center"}
      class:max-h-8={mode === "horizontal"}
      class:overflow-hidden={mode === "horizontal"}
      class:flex-shrink-0={mode === "horizontal"}
    >
      {@render item({
        msg,
        idx,
        neighborLeft: n.neighborLeft,
        neighborRight: n.neighborRight,
      })}
    </div>
  {/each}
</div>

<style>
  .stack-group {
    --fade-left: 0px;
    --fade-right: 0px;
  }
  /* Mask out content past the scrollable edges so users see a soft hint
     (rather than a hard cutoff) that more bubbles exist beyond the viewport.
     `--fade-*` flips between 0 and 2rem from the scroll listener; when both
     are 0 the gradient is solid black, leaving the bubble row fully opaque. */
  .stack-horizontal {
    mask-image: linear-gradient(
      to right,
      transparent 0,
      black var(--fade-left),
      black calc(100% - var(--fade-right)),
      transparent 100%
    );
    -webkit-mask-image: linear-gradient(
      to right,
      transparent 0,
      black var(--fade-left),
      black calc(100% - var(--fade-right)),
      transparent 100%
    );
  }
  .bubble-x-wrapper {
    transition: filter 0.1s ease-in-out;
  }
  .bubble-x-wrapper:hover {
    filter: invert(1) hue-rotate(180deg);
  }
</style>
