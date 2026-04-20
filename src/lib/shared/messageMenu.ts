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
  onToggleEdit?: () => void;
  onDelete?: () => void;
};

export type AgentMenuCtx = {
  messageId: string;
  isStreaming: boolean;
  hasReasoning: boolean;
  result: string;
  reasoning?: string;
  ttsActive: boolean;
  isSpeakingThis: boolean;
  isSynthesizing: boolean;
  onReprocess?: () => void;
  onDelete?: () => void;
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

  const copyItems: MenuItemSpec[] = [];
  const reasoning = ctx.reasoning;
  if (ctx.hasReasoning && reasoning) {
    copyItems.push({
      text: "Copy Thoughts",
      action: () => {
        void navigator.clipboard.writeText(reasoning);
      },
    });
  }
  if (ctx.result) {
    copyItems.push({
      text: "Copy Result",
      action: () => {
        void navigator.clipboard.writeText(ctx.result);
      },
    });
  }
  if (ctx.hasReasoning && reasoning) {
    copyItems.push({
      text: "Copy All",
      action: () => {
        const combined = `Reasoning:\n${reasoning}\n\nResult:\n${ctx.result}`;
        void navigator.clipboard.writeText(combined);
      },
    });
  }
  if (copyItems.length > 0) {
    if (items.length > 0) items.push({ item: "Separator" });
    items.push(...copyItems);
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
