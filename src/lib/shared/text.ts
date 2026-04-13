/**
 * Remove markdown syntax from LLM output so Kokoro (or any other TTS engine)
 * doesn't end up reading asterisks, backticks, URLs, or the contents of code
 * blocks aloud. Runs on the full streamed text every flush, not per sentence,
 * because `Intl.Segmenter` is not markdown-aware: if we segmented first, URLs
 * and table pipes would poison the sentence boundaries.
 *
 * Rules are a chain of `String.replace` calls - ~sub-millisecond for the
 * multi-KB buffers we see in practice. See plan doc for the full list.
 */
export function stripMarkdownForTTS(input: string): string {
  let text = input;

  // 1. Fenced code blocks. Replace with " . " so sentence boundaries on
  //    either side of the block are preserved for the segmenter. Handle
  //    unterminated fences (mid-stream) by truncating from the opener so we
  //    don't leak partial code content before the closing fence arrives.
  text = text.replace(/```[\s\S]*?```/g, " . ");
  text = text.replace(/~~~[\s\S]*?~~~/g, " . ");
  const unterminatedFence = text.search(/```|~~~/);
  if (unterminatedFence !== -1) {
    text = text.slice(0, unterminatedFence);
  }

  // 2. Un-escape markdown punctuation early so `\*star\*` becomes `*star*`
  //    before emphasis runs - otherwise emphasis mis-matches the `\*` pair
  //    and leaves dangling backslashes in the output.
  text = text.replace(/\\([*_~`[\]()#>\-\\])/g, "$1");

  // 3. Reference-style link/image definitions: `[id]: https://... "title"`.
  text = text.replace(/^[ \t]*\[[^\]]+\]:\s*\S.*$/gm, "");

  // 3. Images `![alt](url)` - keep alt text if any.
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");

  // 4. Links `[text](url)` - keep the label. Also drop `<scheme://...>` autolinks.
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  text = text.replace(/<([a-z]+:\/\/[^>]+)>/gi, "");

  // 5. Bare URLs in running prose - unreadable when voiced.
  text = text.replace(/https?:\/\/\S+/g, "");

  // 6. HTML tags.
  text = text.replace(/<[^>]+>/g, "");

  // 7. Horizontal rules.
  text = text.replace(/^[ \t]*[-*_]{3,}[ \t]*$/gm, "");

  // 8. Headings - drop the leading hashes, keep the text.
  text = text.replace(/^[ \t]*#{1,6}[ \t]+/gm, "");

  // 9. Blockquote markers.
  text = text.replace(/^[ \t]*>+[ \t]?/gm, "");

  // 10. List markers (bulleted and numbered).
  text = text.replace(/^[ \t]*(?:[-*+]|\d+\.)[ \t]+/gm, "");

  // 11. Table separator rows (| --- | :--- | ---: |).
  text = text.replace(/^[ \t]*\|?[ \t]*:?-{3,}[-:| \t]*$/gm, "");

  // 12. Table pipes: turn into commas so cells become a natural-language listing.
  text = text.replace(/[ \t]*\|[ \t]*/g, ", ");

  // 13. Inline emphasis / strikethrough. Bold before italic so `**x**` isn't
  //     partially eaten. Italic single-char variants use lookarounds to
  //     preserve `snake_case` identifiers.
  text = text.replace(/\*\*([^*\n]+?)\*\*/g, "$1");
  text = text.replace(/__([^_\n]+?)__/g, "$1");
  text = text.replace(/(?<![\w*])\*([^*\n]+?)\*(?!\w)/g, "$1");
  text = text.replace(/(?<![\w_])_([^_\n]+?)_(?!\w)/g, "$1");
  text = text.replace(/~~([^~\n]+?)~~/g, "$1");

  // 14. Inline code.
  text = text.replace(/`([^`\n]+?)`/g, "$1");

  // 15. Clean up pipe-substitution artifacts: collapse runs of ", ..." and
  //     strip leading/trailing commas, plus collapse any whitespace.
  text = text.replace(/(?:,\s*){2,}/g, ", ");
  text = text.replace(/^[\s,]+|[\s,]+$/g, "");
  text = text.replace(/\s+/g, " ");

  return text.trim();
}
