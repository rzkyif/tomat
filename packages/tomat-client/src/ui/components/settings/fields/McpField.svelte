<script lang="ts">
  import { onMount } from "svelte";
  import { errMessage, type McpServer } from "@tomat/shared";
  import { confirmState, mcpState } from "$stores";
  import type { ParsedQuery } from "$lib/objects/query";
  import { type MenuRow, showObjectActionMenu } from "$lib/objects/menu";
  import type { Accent } from "@tomat/shared/ui/components/objects/object-types";
  import ObjectManager from "$components/ui/ObjectManager.svelte";
  import ObjectCard from "$components/ui/ObjectCard.svelte";
  import ObjectDetailHeader from "@tomat/shared/ui/components/objects/ObjectDetailHeaderView.svelte";
  import ObjectDetailScroll from "@tomat/shared/ui/components/objects/ObjectDetailScrollView.svelte";
  import McpDetail from "./McpDetail.svelte";

  let { horizontal = false }: { horizontal?: boolean } = $props();

  let query = $state("");
  let selectedItem = $state<McpServer | null>(null);
  let reloadKey = $state(0);

  onMount(() => void mcpState.refresh());

  function statusBadge(s: McpServer): { label: string; accent?: Accent } {
    switch (s.status) {
      case "connected":
        return { label: "Connected", accent: "green" };
      case "connecting":
        return { label: "Connecting", accent: "yellow" };
      case "error":
        return { label: "Error", accent: "red" };
      default:
        return { label: s.enabled ? "Disconnected" : "Off" };
    }
  }

  function load({ query: q }: { offset: number; limit: number; query: ParsedQuery }) {
    const text = q.text.toLowerCase();
    const list = mcpState.servers.filter(
      (s) => !text || s.name.toLowerCase().includes(text),
    );
    return Promise.resolve({ items: list, done: true });
  }

  function cardMenuRows(s: McpServer): MenuRow[] {
    return [
      {
        id: "reconnect",
        label: "Reconnect",
        onSelect: () => void mcpState.reconnect(s.id),
      },
      {
        id: "delete",
        label: "Delete",
        onSelect: () =>
          confirmState.request({
            title: "Delete MCP server",
            message: `Delete "${s.name}"? Its tools, prompts, and resources will be removed.`,
            destructive: true,
            confirmLabel: "Delete",
            onConfirm: async () => {
              await mcpState.delete(s.id);
              reloadKey++;
            },
          }),
      },
    ];
  }

  async function newServer() {
    try {
      const created = await mcpState.create({
        name: "New server",
        kind: "stdio",
        enabled: false,
      });
      reloadKey++;
      selectedItem = created;
    } catch (e) {
      confirmState.alert({ title: "Couldn't create server", message: errMessage(e) });
    }
  }
</script>

<ObjectManager
  {load}
  idOf={(s) => s.id}
  getById={(id) => mcpState.servers.find((s) => s.id === id)}
  searchPlaceholder="Search MCP servers"
  bind:query
  bind:selectedItem
  bind:reloadKey
  hasMenu
  onMenu={() =>
    showObjectActionMenu([
      { id: "new", label: "New MCP Server", onSelect: () => void newServer() },
    ])}
>
  {#snippet card(item, open)}
    <ObjectCard
      label={item.name}
      description={item.kind === "stdio" ? item.command : item.url}
      meta={`${item.toolCount} tools · ${item.promptCount} prompts · ${item.resourceCount} resources`}
      badges={[statusBadge(item)]}
      menuRows={cardMenuRows(item)}
      onOpen={open}
    />
  {/snippet}
  {#snippet detail(item)}
    <ObjectDetailHeader title={item.name} subtitle={item.kind === "stdio" ? "Local (stdio)" : "Remote"} />
    <ObjectDetailScroll>
      <McpDetail server={item} {horizontal} reload={() => reloadKey++} />
    </ObjectDetailScroll>
  {/snippet}
  {#snippet empty()}
    <div class="flex flex-col items-center justify-center gap-1 py-12 text-center">
      {#if query.trim()}
        <div class="text-base text-default-700">No matching servers</div>
      {:else}
        <div class="text-base text-default-700">No MCP servers yet</div>
        <div class="text-sm text-default-500">
          Use the menu to add a Model Context Protocol server.
        </div>
      {/if}
    </div>
  {/snippet}
</ObjectManager>
