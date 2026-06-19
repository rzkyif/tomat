<script lang="ts" module>
  // marked, highlight.js, marked-highlight, and the hljs CSS are deferred to
  // first use so they do not land in the initial bundle. ~600KB of JS stays
  // off the critical-path for empty-session launches.
  type MarkedModule = typeof import("marked");
  let rendererReady: Promise<MarkedModule["marked"]> | null = null;

  function ensureRenderer(): Promise<MarkedModule["marked"]> {
    if (rendererReady) return rendererReady;
    rendererReady = (async () => {
      const [hljsMod, markedMod, markedHighlightMod] = await Promise.all([
        import("highlight.js"),
        import("marked"),
        import("marked-highlight"),
        import("highlight.js/styles/atom-one-dark.css"),
      ]);
      const hljs = hljsMod.default;
      const { marked } = markedMod;
      const { markedHighlight } = markedHighlightMod;
      marked.use(
        markedHighlight({
          langPrefix: "hljs language-",
          highlight(code, lang) {
            const language = hljs.getLanguage(lang) ? lang : "plaintext";
            return hljs.highlight(code, { language }).value;
          },
        }),
      );
      return marked;
    })();
    return rendererReady;
  }

  const ALLOWED_TAGS = [
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "p",
    "strong",
    "em",
    "del",
    "ul",
    "ol",
    "li",
    "code",
    "pre",
    "a",
    "img",
    "blockquote",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
    "hr",
    "br",
    "div",
    "span",
    "input",
    "mark",
    "kbd",
    "sub",
    "sup",
    "details",
    "summary",
  ];

  const ALLOWED_ATTR = [
    "href",
    "src",
    "alt",
    "class",
    "type",
    "checked",
    "disabled",
    "start",
    "value",
    "reversed",
  ];
</script>

<script lang="ts">
  import DOMPurify from "dompurify";
  import { tick } from "svelte";
  import { platform } from "$lib/platform";
  import { getLogger } from "$lib/util/log";

  const log = getLogger("markdown");

  let { content, isStreaming = false }: { content: string; isStreaming?: boolean } = $props();

  // Open links from rendered (untrusted, model-authored) markdown in the system
  // browser instead of letting them navigate the app webview in-frame. Without
  // this, a prompt-injected link could replace the trusted app chrome
  // (window-takeover / phishing). DOMPurify already strips javascript: hrefs.
  function handleLinkClick(e: MouseEvent) {
    const anchor = (e.target as HTMLElement | null)?.closest("a");
    const href = anchor?.getAttribute("href");
    if (!href || !/^https?:\/\//i.test(href)) return;
    e.preventDefault();
    void platform()
      .openExternal(href)
      .catch((e) => log.warn("openExternal failed", e));
  }

  // svelte-ignore non_reactive_update
  // oxlint-disable-next-line no-unassigned-vars
  let container: HTMLDivElement;

  let renderedHtml = $state<string | null>(null);
  // Attach the external-link interceptor once via delegation on the container
  // (rather than an inline handler on a static element, which trips a11y lints).
  let linkHandlerAttached = false;

  // Streaming flushes fire ~33x/s. Parsing + sanitizing + re-highlighting the
  // full (growing) message on every one is O(n^2) over the answer length and
  // pins a CPU core on long replies. While streaming we coalesce to at most one
  // parse per STREAM_PARSE_THROTTLE_MS (still feels live) and always run a final
  // parse when streaming ends so the completed message renders cleanly.
  const STREAM_PARSE_THROTTLE_MS = 120;
  let lastParseAt = 0;
  let throttleTimer: ReturnType<typeof setTimeout> | undefined;
  // Bumped per parse so a superseded async parse can't overwrite a newer one.
  let parseGen = 0;

  function wrapTables(node: HTMLDivElement) {
    const tables = node.querySelectorAll("table");
    tables.forEach((table) => {
      if (!table.parentElement?.classList.contains("table-scroller")) {
        const wrapper = document.createElement("div");
        wrapper.className = "table-wrapper";
        const scroller = document.createElement("div");
        scroller.className = "table-scroller tomat-scroll";
        table.parentNode?.insertBefore(wrapper, table);
        wrapper.appendChild(scroller);
        scroller.appendChild(table);
      }
    });
  }

  function wrapCodeBlocks(node: HTMLDivElement) {
    const pres = node.querySelectorAll("pre");
    pres.forEach((pre) => {
      if (!pre.parentElement?.classList.contains("code-scroller")) {
        const wrapper = document.createElement("div");
        wrapper.className = "code-wrapper";
        const scroller = document.createElement("div");
        scroller.className = "code-scroller tomat-scroll-dark";
        pre.parentNode?.insertBefore(wrapper, pre);
        wrapper.appendChild(scroller);
        scroller.appendChild(pre);
      }
    });
  }

  function renderNow(text: string) {
    const gen = ++parseGen;
    lastParseAt = Date.now();
    ensureRenderer()
      .then((marked) => {
        if (gen !== parseGen) return; // a newer parse superseded this one
        renderedHtml = DOMPurify.sanitize(marked.parse(text) as string, {
          ALLOWED_TAGS,
          ALLOWED_ATTR,
          ALLOW_DATA_ATTR: false,
        });
        tick().then(() => {
          if (container) {
            if (!linkHandlerAttached) {
              container.addEventListener("click", handleLinkClick);
              linkHandlerAttached = true;
            }
            wrapTables(container);
            wrapCodeBlocks(container);
          }
        });
      })
      .catch((err) => {
        if (gen !== parseGen) return;
        // The lazily-loaded markdown renderer (marked / highlight.js) failed to
        // import. Don't leave a permanent loading spinner: fall back to escaped
        // plain text, and reset the cached loader so a later message retries.
        log.error("markdown renderer failed to load; showing plain text", err);
        rendererReady = null;
        renderedHtml = DOMPurify.sanitize(text, { ALLOWED_TAGS: [], ALLOWED_ATTR: [] });
      });
  }

  $effect(() => {
    const text = content;
    const streaming = isStreaming;
    if (!text) {
      renderedHtml = null;
      return;
    }
    if (!streaming) {
      // Final or non-streamed render: parse the complete text immediately and
      // drop any pending throttled parse.
      if (throttleTimer) {
        clearTimeout(throttleTimer);
        throttleTimer = undefined;
      }
      renderNow(text);
      return;
    }
    // Streaming: coalesce to a coarse cadence. A trailing timer always reads the
    // freshest `content`, so no streamed chunk is lost.
    if (throttleTimer) return;
    const elapsed = Date.now() - lastParseAt;
    if (elapsed >= STREAM_PARSE_THROTTLE_MS) {
      renderNow(text);
    } else {
      throttleTimer = setTimeout(() => {
        throttleTimer = undefined;
        renderNow(content);
      }, STREAM_PARSE_THROTTLE_MS - elapsed);
    }
  });

  $effect(() => {
    return () => {
      if (throttleTimer) clearTimeout(throttleTimer);
    };
  });
</script>

{#if content}
  {#if renderedHtml === null}
    <i class="i-line-md:loading-loop text-3xl"></i>
  {:else}
    <div bind:this={container} class="markdown-content min-w-0 overflow-hidden">
      {@html renderedHtml}
    </div>
  {/if}
{/if}

<style lang="scss">
  :global(.markdown) {
    :global(*:first-child) {
      margin-top: 0 !important;
    }
    :global(*:last-child) {
      margin-bottom: 0 !important;
    }

    :global(h1) {
      font-size: 2em;
      font-weight: 700;
      line-height: 1.25;
      margin-top: 0.75em;
      margin-bottom: 0.25em;
    }
    :global(h2) {
      font-size: 1.5em;
      font-weight: 600;
      margin-top: 0.75em;
      margin-bottom: 0.25em;
    }
    :global(h3) {
      font-size: 1.25em;
      font-weight: 600;
      margin-top: 0.75em;
      margin-bottom: 0.25em;
    }
    :global(h4) {
      font-size: 1em;
      font-weight: 600;
      margin-top: 0.75em;
      margin-bottom: 0.25em;
    }
    :global(h5) {
      font-size: 0.875em;
      font-weight: 600;
      margin-top: 0.75em;
      margin-bottom: 0.25em;
    }
    :global(h6) {
      font-size: 0.85em;
      font-weight: 600;
      margin-top: 0.75em;
      margin-bottom: 0.25em;
      color: var(--default-500);
    }

    :global(p) {
      margin-top: 0;
      margin-bottom: 10px;
    }
    :global(strong) {
      font-weight: 700;
    }
    :global(em) {
      font-style: italic;
    }
    :global(del) {
      text-decoration: line-through;
      opacity: 0.7;
    }
    :global(mark) {
      background-color: var(--accent-yellow-200);
      color: inherit;
    }
    :global(sub) {
      font-size: 75%;
      line-height: 0;
      position: relative;
      vertical-align: baseline;
      bottom: -0.25em;
    }
    :global(sup) {
      font-size: 75%;
      line-height: 0;
      position: relative;
      vertical-align: baseline;
      top: -0.5em;
    }

    :global(ol) {
      list-style: decimal;
      margin-top: 0;
      margin-bottom: 1em;
      padding-left: 2em;
    }
    :global(ul) {
      list-style: disc;
      margin-top: 0;
      margin-bottom: 1em;
      padding-left: 2em;
    }
    :global(li + li) {
      margin-top: 0.25em;
    }
    :global(li > p) {
      margin-top: 1em;
    }
    :global(li > ol),
    :global(li > ul) {
      margin-top: 0;
      margin-bottom: 0;
    }
    :global(ol ol),
    :global(ul ol) {
      list-style-type: lower-roman;
    }
    :global(ul ul ol),
    :global(ul ol ol),
    :global(ol ul ol),
    :global(ol ol ol) {
      list-style-type: lower-alpha;
    }

    /* Display-only task-list checkboxes. The interactive ui/Checkbox.svelte
       component mirrors this look (box + check glyph); keep them in sync. */
    :global(li:has(input[type="checkbox"])) {
      list-style: none;
      margin-left: -2em;
      align-items: flex-start;
      position: relative;
      padding-left: 2em;
    }
    :global(input[type="checkbox"]) {
      position: absolute;
      opacity: 0;
      width: 0;
      height: 0;
    }
    :global(li:has(input[type="checkbox"]))::before {
      content: "";
      position: absolute;
      left: 0.45em;
      top: 0.15em;
      width: 1.1em;
      height: 1.1em;
      background: var(--default-50);
      border: 2px solid var(--default-700);
      border-radius: 0.25em;
    }
    :global(input[type="checkbox"]:checked + *) {
      opacity: 0.7;
    }
    :global(li:has(input[type="checkbox"]:checked))::before {
      content: "✓";
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: bold;
    }

    :global(.code-wrapper) {
      overflow: hidden;
      border-radius: 6px;
      margin-bottom: 1em;
      background-color: var(--code-bg);
      :global(pre) {
        border-radius: 0;
        margin-bottom: 0;
      }
    }
    :global(.code-scroller) {
      overflow-x: auto;
      overflow-y: clip;
    }
    :global(pre) {
      display: flex;
      line-height: 1.45;
      background-color: var(--code-bg);
      border-radius: 6px;
      padding: 1em;
      margin-bottom: 1em;
      :global(code) {
        overflow: clip;
        font-size: 0.9em;
        font-family: var(--font-mono);
        background: transparent;
        padding: 0;
        color: white;
      }
    }
    :global(code) {
      background-color: var(--code-bg-inline);
      color: white;
      padding: 0.15em 0.4em;
      border-radius: 6px;
      margin-left: 0.25em;
      margin-right: 0.25em;
      font-size: 0.8em;
      font-family: var(--font-mono);
    }
    :global(kbd) {
      display: inline-block;
      padding: 0.25em;
      font:
        11px ui-monospace,
        SFMono-Regular,
        SF Mono,
        Menlo,
        Consolas,
        Liberation Mono,
        monospace;
      line-height: 10px;
      vertical-align: middle;
      background-color: var(--default-100);
      border: solid 1px var(--default-300);
      border-radius: 6px;
      box-shadow: inset 0 -1px 0 var(--default-300);
    }

    :global(a) {
      color: inherit;
      text-decoration: underline;
      text-underline-offset: 0.2em;
    }

    :global(img) {
      max-width: 100%;
      height: auto;
      border-radius: 0.5em;
      margin: 0.75em 0;
    }

    :global(blockquote) {
      border-left: 4px solid currentColor;
      padding: 0 1em;
      margin: 0 0 1em 0;
      :global(> :first-child) {
        margin-top: 0;
      }
      :global(> :last-child) {
        margin-bottom: 0;
      }
    }

    :global(details) {
      display: block;
    }
    :global(summary) {
      display: list-item;
      cursor: pointer;
    }

    :global(.table-wrapper) {
      max-height: 600px;
      overflow: clip;
      border-radius: 0.5em;
      margin-bottom: 1em;
      background: var(--default-50);
      color: var(--default-800);
    }
    :global(.table-scroller) {
      max-height: 600px;
      overflow: auto;
    }
    :global(table) {
      width: max-content;
      min-width: 100%;
      border-collapse: collapse;
      margin-bottom: 0;
      font-size: 0.95em;
      font-variant: tabular-nums;
    }
    :global(th) {
      background-color: var(--default-100);
      font-weight: 600;
      text-align: left;
      padding: 6px 13px;
      position: sticky;
      top: 0;
    }
    :global(td) {
      padding: 6px 13px;
      border-bottom: 1px solid var(--default-200);
    }
    :global(tr:last-child td) {
      border-bottom: none;
    }

    :global(hr) {
      border: none;
      border-top: 2px solid var(--default-700);
      margin: 1.5em 0;
    }
  }

  :global(html.dark .markdown) {
    :global(h6) {
      color: var(--default-d-500);
    }
    :global(mark) {
      background-color: var(--accent-yellow-d-200);
      color: var(--accent-yellow-d-900);
    }
    :global(kbd) {
      background-color: var(--default-d-100);
      border-color: var(--default-d-300);
      color: var(--default-d-800);
      box-shadow: inset 0 -1px 0 var(--default-d-300);
    }
    :global(.table-wrapper) {
      background: var(--default-d-50);
      color: var(--default-d-800);
    }
    :global(th) {
      background-color: var(--default-d-100);
    }
    :global(td) {
      border-bottom-color: var(--default-d-200);
    }
    :global(hr) {
      border-top-color: var(--default-d-700);
    }
    :global(li:has(input[type="checkbox"]))::before {
      background: var(--default-d-50);
      border-color: var(--default-d-700);
    }
  }
</style>
