/**
 * Builds the native right-click menu shown on chat message bubbles.
 * Different items appear depending on whether the message is from the
 * user or the assistant.
 */

import { Menu, type MenuItemOptions } from "@tauri-apps/api/menu";
import { isTauri } from "./env";
import { ttsState } from "$lib/state/tts.svelte";

type MenuItemSpec = MenuItemOptions | { item: "Separator" };

export type UserMenuCtx = {
  editing: boolean;
  isStreaming: boolean;
  onToggleEdit?: () => void;
  onReprocess?: () => void;
  onDelete?: () => void;
};

export type AgentMenuCtx = {
  messageId: string;
  isStreaming: boolean;
  result: string;
  ttsActive: boolean;
  isSpeakingThis: boolean;
  isSynthesizing: boolean;
  onReprocess?: () => void;
  onDelete?: () => void;
};

export type ReasoningMenuCtx = {
  reasoning: string;
};

async function popup(items: MenuItemSpec[]): Promise<void> {
  if (!isTauri()) return;
  const menu = await Menu.new({ items });
  await menu.popup();
}

export async function showUserMessageMenu(ctx: UserMenuCtx): Promise<void> {
  const items: MenuItemSpec[] = [];

  if (ctx.onToggleEdit) {
    items.push({
      text: ctx.editing ? "Stop Editing" : "Edit Message",
      action: () => ctx.onToggleEdit?.(),
    });
  }

  if (ctx.onReprocess && !ctx.isStreaming) {
    items.push({
      text: "Reprocess Response",
      action: () => ctx.onReprocess?.(),
    });
  }

  if (ctx.onDelete) {
    if (items.length > 0) items.push({ item: "Separator" });
    items.push({
      text: "Delete Message",
      action: () => ctx.onDelete?.(),
    });
  }

  if (items.length === 0) return;
  await popup(items);
}

export async function showAgentMessageMenu(ctx: AgentMenuCtx): Promise<void> {
  const items: MenuItemSpec[] = [];

  if (ctx.ttsActive) {
    if (ctx.isSpeakingThis) {
      items.push({
        text: "Stop Speaking",
        action: () => ttsState.reset(),
      });
    } else if (ctx.isSynthesizing) {
      items.push({
        text: "Synthesizing...",
        enabled: false,
      });
    } else {
      items.push({
        text: "Read Aloud",
        action: () => ttsState.replayMessage(ctx.messageId, ctx.result),
      });
    }
  }

  if (ctx.result) {
    if (items.length > 0) items.push({ item: "Separator" });
    items.push({
      text: "Copy Result",
      action: () => {
        void navigator.clipboard.writeText(ctx.result);
      },
    });
  }

  const tailItems: MenuItemSpec[] = [];
  if (ctx.onReprocess && !ctx.isStreaming) {
    tailItems.push({
      text: "Reprocess Message",
      action: () => ctx.onReprocess?.(),
    });
  }
  if (ctx.onDelete) {
    tailItems.push({
      text: "Delete Message",
      action: () => ctx.onDelete?.(),
    });
  }
  if (tailItems.length > 0) {
    if (items.length > 0) items.push({ item: "Separator" });
    items.push(...tailItems);
  }

  if (items.length === 0) return;
  await popup(items);
}

export async function showReasoningMessageMenu(ctx: ReasoningMenuCtx): Promise<void> {
  const items: MenuItemSpec[] = [];

  if (ctx.reasoning) {
    items.push({
      text: "Copy Thoughts",
      action: () => {
        void navigator.clipboard.writeText(ctx.reasoning);
      },
    });
  }

  if (items.length === 0) return;
  await popup(items);
}
