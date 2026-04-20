/**
 * Figures out where a specific character inside a `<textarea>` ends up on
 * the screen. Used to anchor the snippet autocomplete dropdown right
 * below the caret. Works by cloning the textarea's styles into a hidden
 * div, dropping a marker at the right spot, and measuring it.
 */

/** Computed-style properties that influence text layout; copying these onto
 *  the mirror div reproduces the textarea's wrapping behavior. Kept as an
 *  `as const` tuple so the keys match both `CSSStyleDeclaration` (reads) and
 *  `CSSStyleDeclaration`-writable indexers (writes). */
const MIRROR_COPY_PROPS = [
  "boxSizing",
  "width",
  "height",
  "overflowX",
  "overflowY",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "fontStyle",
  "fontVariant",
  "fontWeight",
  "fontStretch",
  "fontSize",
  "fontSizeAdjust",
  "lineHeight",
  "fontFamily",
  "textAlign",
  "textTransform",
  "textIndent",
  "textDecoration",
  "letterSpacing",
  "wordSpacing",
  "tabSize",
] as const satisfies readonly (keyof CSSStyleDeclaration)[];

export interface CaretPosition {
  top: number;
  left: number;
}

/**
 * Returns the viewport-relative `{ top, left }` of the caret position at
 * `index` inside `textarea`, with `top` already shifted down by one line
 * height + 4px so callers can anchor a dropdown directly.
 */
export function measureCaretAt(textarea: HTMLTextAreaElement, index: number): CaretPosition {
  const mirror = document.createElement("div");
  const cs = window.getComputedStyle(textarea);

  for (const prop of MIRROR_COPY_PROPS) {
    const value = cs.getPropertyValue(prop as string);
    mirror.style.setProperty(prop as string, value);
  }

  mirror.style.position = "absolute";
  mirror.style.top = "-9999px";
  mirror.style.left = "-9999px";
  mirror.style.visibility = "hidden";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.overflowWrap = "break-word";
  mirror.textContent = textarea.value.substring(0, index);

  const marker = document.createElement("span");
  marker.textContent = "\u200b";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);

  const markerRect = marker.getBoundingClientRect();
  const taRect = textarea.getBoundingClientRect();
  const mirrorRect = mirror.getBoundingClientRect();

  // Translate the mirror-relative marker position to viewport coords using
  // the textarea's top-left as the origin (mirror and textarea share the
  // same content-box layout).
  const top = taRect.top + (markerRect.top - mirrorRect.top) - textarea.scrollTop;
  const left = taRect.left + (markerRect.left - mirrorRect.left) - textarea.scrollLeft;

  document.body.removeChild(mirror);

  // Anchor the dropdown just below the current line.
  const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
  return { top: top + lineHeight + 4, left };
}
