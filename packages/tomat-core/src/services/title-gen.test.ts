// title sanitizer. Pure transform over LLM output. Covers the bits
// that matter most for UI hygiene (length cap, `<think>` strip, prefix
// normalization).

import { assertEquals } from "@std/assert";
import { __sanitizeForTesting as sanitize } from "./title-gen.ts";

Deno.test("sanitize: strips <think>...</think> blocks the model may leak", () => {
  assertEquals(sanitize("<think>hmm</think>Quick Recipe"), "Quick Recipe");
});

Deno.test("sanitize: drops everything after the first line", () => {
  assertEquals(sanitize("Title One\nIgnored second line"), "Title One");
});

Deno.test("sanitize: strips a 'Title:' / 'title -' prefix the model re-emits", () => {
  assertEquals(sanitize("Title: Hello World"), "Hello World");
  assertEquals(sanitize("title - Hello World"), "Hello World");
  assertEquals(sanitize("TITLE: Hello"), "Hello");
});

Deno.test("sanitize: strips surrounding quotes and trailing punctuation", () => {
  assertEquals(sanitize(`"Hello"`), "Hello");
  assertEquals(sanitize("'Hello'"), "Hello");
  assertEquals(sanitize("Hello!"), "Hello");
  assertEquals(sanitize("Hello..."), "Hello");
});

Deno.test("sanitize: caps length at 80 chars", () => {
  const long = "a".repeat(200);
  assertEquals(sanitize(long).length, 80);
});

Deno.test("sanitize: collapses runs of whitespace", () => {
  assertEquals(sanitize("Hello   World\t\t!"), "Hello World");
});

Deno.test("sanitize: returns empty string when input collapses to nothing", () => {
  assertEquals(sanitize(""), "");
  assertEquals(sanitize("<think>only</think>"), "");
  assertEquals(sanitize(`"  "`), "");
});
