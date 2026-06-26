// Platform selection bootstrap. Picks the desktop (tauri.ts) or android
// (mobile.ts) Platform impl from the running OS and installs it via
// setPlatform(). Called once during +layout.svelte's script init (guarded by
// `browser`), replacing the direct installTauriPlatform() call so the same
// frontend bundle runs under either native shell.
//
// `@tauri-apps/plugin-os` exposes the OS synchronously (it is injected at
// plugin init), so selection stays synchronous and lands before any child
// onMount calls platform().

import { platform as osPlatform } from "@tauri-apps/plugin-os";
import { installTauriPlatform } from "./tauri";
import { installMobilePlatform } from "./mobile";

/** True when running on a Tauri-mobile OS (Android today; iOS later). */
export function isMobilePlatform(): boolean {
  const os = osPlatform();
  return os === "android" || os === "ios";
}

/** True on Android specifically. Drives the UiContext `hasSystemBack` flag: only
 *  Android has a hardware / gesture back, so it is the only shell that drops the
 *  in-app back / close affordances (iOS and desktop keep them). */
export function isAndroidPlatform(): boolean {
  return osPlatform() === "android";
}

/** Install the Platform singleton appropriate for the current OS. */
export function installPlatform(): void {
  if (isMobilePlatform()) installMobilePlatform();
  else installTauriPlatform();
}
