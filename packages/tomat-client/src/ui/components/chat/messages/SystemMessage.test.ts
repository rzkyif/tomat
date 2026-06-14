// SystemMessage renders the system-prompt body inside an Expandable
// titled "System Prompt". Verifies content surfaces correctly.

import { beforeEach, describe, expect, it } from "vitest";
import { render } from "@testing-library/svelte";
import SystemMessage from "./SystemMessage.svelte";
import { settingsState } from "$stores";
import { expansionState } from "$stores/expansion.svelte";

beforeEach(() => {
  settingsState.currentSettings["layout.alignment"] = "center";
  expansionState.clear();
});

describe("SystemMessage", () => {
  it("renders the 'System Prompt' label by default (collapsed)", () => {
    const { container } = render(SystemMessage, {
      props: { id: "sys-1", content: "You are a helpful AI assistant." },
    });
    expect(container.textContent).toContain("System Prompt");
  });

  it("renders the body when the message is pre-expanded", () => {
    expansionState.set("sys-pre", true);
    const { container } = render(SystemMessage, {
      props: { id: "sys-pre", content: "You are a helpful AI assistant." },
    });
    expect(container.textContent).toContain("helpful AI assistant");
    const body = container.querySelector(".whitespace-pre-wrap");
    expect(body).toBeTruthy();
  });

  it("preserves whitespace + newlines in the expanded body", () => {
    expansionState.set("sys-ws", true);
    const { container } = render(SystemMessage, {
      props: { id: "sys-ws", content: "line 1\nline 2\n  indented" },
    });
    const body = container.querySelector(".whitespace-pre-wrap");
    expect(body).toBeTruthy();
    expect(body!.textContent).toBe("line 1\nline 2\n  indented");
  });
});
