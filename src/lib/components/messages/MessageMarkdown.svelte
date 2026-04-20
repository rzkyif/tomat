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

  let { content }: { content: string } = $props();

  // svelte-ignore non_reactive_update
  // oxlint-disable-next-line no-unassigned-vars
  let container: HTMLDivElement;

  let renderedHtml = $state<string | null>(null);

  function wrapTables(node: HTMLDivElement) {
    const tables = node.querySelectorAll("table");
    tables.forEach((table) => {
      if (!table.parentElement?.classList.contains("table-scroller")) {
        const wrapper = document.createElement("div");
        wrapper.className = "table-wrapper";
        const scroller = document.createElement("div");
        scroller.className = "table-scroller";
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
        scroller.className = "code-scroller";
        pre.parentNode?.insertBefore(wrapper, pre);
        wrapper.appendChild(scroller);
        scroller.appendChild(pre);
      }
    });
  }

  $effect(() => {
    const text = content;
    if (!text) {
      renderedHtml = null;
      return;
    }
    let cancelled = false;
    ensureRenderer().then((marked) => {
      if (cancelled) return;
      renderedHtml = DOMPurify.sanitize(marked.parse(text) as string, {
        ALLOWED_TAGS,
        ALLOWED_ATTR,
        ALLOW_DATA_ATTR: false,
      });
      tick().then(() => {
        if (container) {
          wrapTables(container);
          wrapCodeBlocks(container);
        }
      });
    });
    return () => {
      cancelled = true;
    };
  });
</script>

{#if content}
  {#if renderedHtml === null}
    <i class="i-line-md:loading-alt-loop text-3xl"></i>
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
      color: #59636e;
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
      background-color: #fff8c5;
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
      background: white;
      border: 2px solid black;
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
      background-color: #1e1e1e;
      :global(pre) {
        border-radius: 0;
        margin-bottom: 0;
      }
    }
    :global(.code-scroller) {
      overflow-x: auto;
      overflow-y: clip;
    }
    :global(.code-scroller::-webkit-scrollbar) {
      width: 8px;
      height: 8px;
    }
    :global(.code-scroller::-webkit-scrollbar-track) {
      background: rgba(255, 255, 255, 0.05);
    }
    :global(.code-scroller::-webkit-scrollbar-thumb) {
      background: rgba(255, 255, 255, 0.2);
      border-radius: 4px;
    }
    :global(.code-scroller::-webkit-scrollbar-thumb:hover) {
      background: rgba(255, 255, 255, 0.3);
    }
    :global(pre) {
      display: flex;
      line-height: 1.45;
      background-color: #1e1e1e;
      border-radius: 6px;
      padding: 1em;
      margin-bottom: 1em;
      :global(code) {
        overflow: clip;
        font-size: 0.9em;
        font-family: "SF Mono", Monaco, Consolas, "Liberation Mono", monospace;
        background: transparent;
        padding: 0;
        color: white;
      }
    }
    :global(code) {
      background-color: rgba(30, 30, 30, 0.75);
      color: white;
      padding: 0.15em 0.4em;
      border-radius: 6px;
      margin-left: 0.25em;
      margin-right: 0.25em;
      font-size: 0.8em;
      font-family: "SF Mono", Monaco, Consolas, "Liberation Mono", monospace;
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
      background-color: #f6f8fa;
      border: solid 1px rgba(0, 0, 0, 0.2);
      border-radius: 6px;
      box-shadow: inset 0 -1px 0 rgba(0, 0, 0, 0.2);
    }

    :global(a) {
      color: rgb(59, 130, 246);
      text-decoration: underline;
      text-underline-offset: 0.2em;
      &:hover {
        color: rgb(37, 99, 235);
      }
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
      background: white;
    }
    :global(.table-scroller) {
      max-height: 600px;
      overflow: auto;
    }
    :global(.table-scroller::-webkit-scrollbar) {
      width: 8px;
      height: 8px;
    }
    :global(.table-scroller::-webkit-scrollbar-track) {
      background: white;
    }
    :global(.table-scroller::-webkit-scrollbar-thumb) {
      background: rgba(0, 0, 0, 0.2);
    }
    :global(.table-scroller::-webkit-scrollbar-thumb:hover) {
      background: rgba(0, 0, 0, 0.3);
    }
    :global(.table-scroller::-webkit-scrollbar-corner) {
      background: white;
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
      background-color: #eee;
      font-weight: 600;
      text-align: left;
      padding: 6px 13px;
      position: sticky;
      top: 0;
    }
    :global(td) {
      padding: 6px 13px;
      border-bottom: 1px solid rgba(0, 0, 0, 0.1);
    }
    :global(tr:last-child td) {
      border-bottom: none;
    }

    :global(hr) {
      border: none;
      border-top: 2px solid black;
      margin: 1.5em 0;
    }
  }

  :global(html.dark .markdown) {
    :global(h6) {
      color: #9ca3af;
    }
    :global(mark) {
      background-color: #854d0e;
      color: #fef9c3;
    }
    :global(kbd) {
      background-color: #2d2d2d;
      border-color: rgba(255, 255, 255, 0.2);
      color: #e5e7eb;
      box-shadow: inset 0 -1px 0 rgba(255, 255, 255, 0.1);
    }
    :global(.table-wrapper) {
      background: #1e1e1e;
    }
    :global(.table-scroller::-webkit-scrollbar-track) {
      background: #1e1e1e;
    }
    :global(.table-scroller::-webkit-scrollbar-thumb) {
      background: rgba(255, 255, 255, 0.2);
    }
    :global(.table-scroller::-webkit-scrollbar-thumb:hover) {
      background: rgba(255, 255, 255, 0.3);
    }
    :global(.table-scroller::-webkit-scrollbar-corner) {
      background: #1e1e1e;
    }
    :global(th) {
      background-color: #2d2d2d;
    }
    :global(td) {
      border-bottom-color: rgba(255, 255, 255, 0.1);
    }
    :global(hr) {
      border-top-color: #6b7280;
    }
    :global(li:has(input[type="checkbox"]))::before {
      background: #2d2d2d;
      border-color: #9ca3af;
    }
  }
</style>
