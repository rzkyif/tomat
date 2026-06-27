import type { ComponentProps } from "svelte";
import type { OmitSnippetProps } from "./types.ts";
import type CoresFieldView from "../components/settings/CoresFieldView.svelte";

export const coresFieldSamples = {
  current: {
    draftName: "Studio Mac",
    baseUrl: "https://192.168.1.20:8787",
    isCurrent: true,
    devices: [
      { id: "d1", name: "Studio Mac", lastSeenLabel: "active now", isMe: true },
      { id: "d2", name: "Work Laptop", lastSeenLabel: "last seen 3 minutes ago", isMe: false },
      { id: "d3", name: "Pixel 8", lastSeenLabel: "last seen 2 hours ago", isMe: false },
    ],
  },
  mintedCode: {
    draftName: "Studio Mac",
    baseUrl: "https://192.168.1.20:8787",
    isCurrent: true,
    mintedCode: "428 913",
    mintedExpiresLabel: "expires in 5 minutes",
    devices: [{ id: "d1", name: "Studio Mac", lastSeenLabel: "active now", isMe: true }],
  },
  noDevices: {
    draftName: "Studio Mac",
    baseUrl: "https://192.168.1.20:8787",
    isCurrent: true,
    devices: [],
  },
  devicesLoading: {
    draftName: "Studio Mac",
    baseUrl: "https://192.168.1.20:8787",
    isCurrent: true,
    devices: null,
  },
  devicesError: {
    draftName: "Studio Mac",
    baseUrl: "https://192.168.1.20:8787",
    isCurrent: true,
    devices: null,
    devicesError: "Could not reach the Core.",
  },
  codeCopied: {
    draftName: "Studio Mac",
    baseUrl: "https://192.168.1.20:8787",
    isCurrent: true,
    mintedCode: "428 913",
    mintedExpiresLabel: "expires in 5 minutes",
    codeCopied: true,
    devices: [{ id: "d1", name: "Studio Mac", lastSeenLabel: "active now", isMe: true }],
  },
  remote: {
    draftName: "Home Server",
    baseUrl: "https://core.example.com:8787",
    isCurrent: false,
  },
} satisfies Record<string, OmitSnippetProps<ComponentProps<typeof CoresFieldView>>>;
