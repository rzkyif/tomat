// snippet expansion. Pure transform — drives the @trigger substitution
// + placement semantics that snake through the UI's input pipeline.

import { describe, expect, it } from "vitest";
import {
  applySnippets,
  normalizeTrigger,
  type Snippet,
  type SnippetPlacement,
  validateTrigger,
} from "./snippets";

const snippet = (
  trigger: string,
  text: string,
  placement: SnippetPlacement = "insert-user",
): Snippet => ({
  id: `id-${trigger}`,
  name: trigger,
  trigger,
  placement,
  text,
});

describe("normalizeTrigger", () => {
  it("forces a leading @ and strips internal whitespace", () => {
    expect(normalizeTrigger("foo")).toBe("@foo");
    expect(normalizeTrigger("@foo bar")).toBe("@foobar");
    expect(normalizeTrigger("@@@x")).toBe("@x");
  });
  it("returns empty string for whitespace-only input", () => {
    expect(normalizeTrigger("   ")).toBe("");
    expect(normalizeTrigger("@")).toBe("");
  });
});

describe("validateTrigger", () => {
  it("requires non-empty leading-@ alphanumeric+_-", () => {
    expect(validateTrigger("", [])).toMatch(/required/);
    expect(validateTrigger("foo", [])).toMatch(/start with @/);
    expect(validateTrigger("@!", [])).toMatch(/letters/);
    expect(validateTrigger("@hello-world_1", [])).toBeNull();
  });
  it("rejects duplicates against the existing-list", () => {
    expect(validateTrigger("@foo", ["@foo"])).toMatch(/already used/);
    expect(validateTrigger("@bar", ["@foo"])).toBeNull();
  });
});

describe("applySnippets", () => {
  it("returns raw text unchanged when no snippets are defined", () => {
    expect(applySnippets("hello @foo", [])).toEqual({ userText: "hello @foo" });
  });

  it("leaves unknown @triggers in place", () => {
    expect(applySnippets("hello @unknown world", [snippet("@known", "X")])).toEqual({
      userText: "hello @unknown world",
    });
  });

  it("does NOT match @ inside identifiers (email@domain)", () => {
    const out = applySnippets("contact email@foo", [snippet("@foo", "replaced")]);
    expect(out.userText).toBe("contact email@foo");
  });

  it("insert-user substitutes inline", () => {
    const out = applySnippets("hi @greet world", [snippet("@greet", "hello")]);
    expect(out.userText).toBe("hi hello world");
  });

  it("prepend-user and append-user join with blank lines", () => {
    const out = applySnippets("middle @intro @outro", [
      snippet("@intro", "INTRO", "prepend-user"),
      snippet("@outro", "OUTRO", "append-user"),
    ]);
    // Triggers themselves disappear; middle text is preserved + sandwiched.
    expect(out.userText).toBe("INTRO\n\nmiddle\n\nOUTRO");
  });

  it("replace-user wins over inline / prepend / append", () => {
    const out = applySnippets("ignored @drop", [snippet("@drop", "EVERYTHING", "replace-user")]);
    expect(out.userText).toBe("EVERYTHING");
  });

  it("system-prompt placements only populate systemOverride", () => {
    const out = applySnippets("hello @sys", [snippet("@sys", "you are a cat", "prepend-system")]);
    // @sys disappears from the user text; the system override carries it.
    expect(out.userText).toBe("hello");
    expect(out.systemOverride).toEqual({ prepend: "you are a cat" });
  });

  it("replace-system / prepend-system / append-system can co-exist", () => {
    const out = applySnippets("@a @b @c text", [
      snippet("@a", "A", "prepend-system"),
      snippet("@b", "B", "replace-system"),
      snippet("@c", "C", "append-system"),
    ]);
    expect(out.systemOverride).toEqual({
      prepend: "A",
      replace: "B",
      append: "C",
    });
  });

  it("is case-insensitive on the trigger lookup", () => {
    const out = applySnippets("hi @GREET there", [snippet("@greet", "hello")]);
    expect(out.userText).toBe("hi hello there");
  });
});
