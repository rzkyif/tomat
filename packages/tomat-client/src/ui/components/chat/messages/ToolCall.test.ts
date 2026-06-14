// ToolCall's askUser answer assembly for the kind-discriminated questions:
// diff and image auto-submit from one click, files (multiselect) and table
// collect through the Submit button, and table answers come back as
// column-keyed records of the edited grid.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/svelte";
import ToolCall from "./ToolCall.svelte";
import type { AskUserQuestion, Message } from "$lib/util/types";
import { settingsState } from "$stores";
import { expansionState } from "$stores/expansion.svelte";

beforeEach(() => {
  settingsState.currentSettings["layout.alignment"] = "center";
  expansionState.clear();
});

function awaitingMsg(questions: AskUserQuestion[]): Message {
  return {
    id: "m1",
    role: "tool",
    callId: "call-1",
    toolName: "demo_tool",
    status: "awaiting_user",
    ephemera: { askUser: { requestId: "req-1", questions, answers: null } },
  };
}

function renderAwaiting(questions: AskUserQuestion[]) {
  expansionState.set("tc-1", true);
  const onAnswer = vi.fn();
  const utils = render(ToolCall, {
    props: { id: "tc-1", msg: awaitingMsg(questions), onAnswer },
  });
  return { ...utils, onAnswer };
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === text,
  );
  if (!btn) throw new Error(`no button with text "${text}"`);
  return btn;
}

describe("ToolCall askUser kinds", () => {
  it("diff: clicking Accept auto-submits the verdict", async () => {
    const { container, onAnswer } = renderAwaiting([
      { kind: "diff", question: "Apply this change?", before: "a\nb", after: "a\nc" },
    ]);
    expect(container.textContent).toContain("Apply this change?");
    await fireEvent.click(buttonByText(container, "Accept"));
    expect(onAnswer).toHaveBeenCalledWith("req-1", ["accept"]);
  });

  it("diff: clicking Reject auto-submits the verdict", async () => {
    const { container, onAnswer } = renderAwaiting([
      { kind: "diff", question: "Apply this change?", before: "a", after: "b" },
    ]);
    await fireEvent.click(buttonByText(container, "Reject"));
    expect(onAnswer).toHaveBeenCalledWith("req-1", ["reject"]);
  });

  it("files multiselect: picked paths submit via the Submit button", async () => {
    const { container, onAnswer } = renderAwaiting([
      {
        kind: "files",
        question: "Which files?",
        entries: [
          { path: "/dl/a.txt", label: "a.txt" },
          { path: "/dl/b.txt", label: "b.txt" },
          { path: "/dl/c.txt", label: "c.txt" },
        ],
        multiselect: true,
      },
    ]);
    await fireEvent.click(buttonByText(container, "a.txt"));
    await fireEvent.click(buttonByText(container, "c.txt"));
    expect(onAnswer).not.toHaveBeenCalled();
    await fireEvent.click(buttonByText(container, "Submit"));
    expect(onAnswer).toHaveBeenCalledWith("req-1", [["/dl/a.txt", "/dl/c.txt"]]);
  });

  it("image: clicking an action auto-submits its value", async () => {
    const { container, onAnswer } = renderAwaiting([
      {
        kind: "image",
        question: "Keep this image?",
        dataB64: "aGk=",
        mime: "image/png",
        actions: [
          { label: "Keep", value: "keep" },
          { label: "Discard", value: "discard" },
        ],
      },
    ]);
    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toBe("data:image/png;base64,aGk=");
    await fireEvent.click(buttonByText(container, "Discard"));
    expect(onAnswer).toHaveBeenCalledWith("req-1", ["discard"]);
  });

  it("table: edited rows submit as column-keyed records", async () => {
    const { container, onAnswer } = renderAwaiting([
      {
        kind: "table",
        question: "Check the rows.",
        columns: ["item", "amount"],
        rows: [
          ["coffee", "4.50"],
          ["lunch", "12.00"],
        ],
      },
    ]);
    const inputs = Array.from(container.querySelectorAll<HTMLInputElement>("table input"));
    expect(inputs.map((i) => i.value)).toEqual(["coffee", "4.50", "lunch", "12.00"]);
    await fireEvent.input(inputs[1], { target: { value: "5.00" } });
    await fireEvent.click(buttonByText(container, "Submit"));
    expect(onAnswer).toHaveBeenCalledWith("req-1", [
      [
        { item: "coffee", amount: "5.00" },
        { item: "lunch", amount: "12.00" },
      ],
    ]);
  });

  it("table: row add and remove reshape the submitted records", async () => {
    const { container, onAnswer } = renderAwaiting([
      {
        kind: "table",
        question: "Check the rows.",
        columns: ["name"],
        rows: [["amy"], ["bo"]],
      },
    ]);
    // Remove the first row, add a fresh one, fill it in.
    const removeButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button[title='Remove row']"),
    );
    await fireEvent.click(removeButtons[0]);
    await fireEvent.click(buttonByText(container, "Add Row"));
    const inputs = Array.from(container.querySelectorAll<HTMLInputElement>("table input"));
    expect(inputs.map((i) => i.value)).toEqual(["bo", ""]);
    await fireEvent.input(inputs[1], { target: { value: "cy" } });
    await fireEvent.click(buttonByText(container, "Submit"));
    expect(onAnswer).toHaveBeenCalledWith("req-1", [[{ name: "bo" }, { name: "cy" }]]);
  });

  it("legacy choice questions still auto-submit a single-select pick", async () => {
    const { container, onAnswer } = renderAwaiting([
      {
        question: "Pick a color.",
        options: [
          { label: "Red", value: "red" },
          { label: "Blue", value: "blue" },
        ],
      },
    ]);
    await fireEvent.click(buttonByText(container, "Blue"));
    expect(onAnswer).toHaveBeenCalledWith("req-1", ["blue"]);
  });
});
