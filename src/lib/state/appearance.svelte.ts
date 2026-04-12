import { browser } from "$app/environment";

const mql = browser ? window.matchMedia("(prefers-color-scheme: dark)") : null;

export function applyTheme(theme: string) {
  if (!browser) return;
  const isDark = theme === "dark" || (theme === "auto" && mql!.matches);
  document.documentElement.classList.toggle("dark", isDark);
}

export function applyTextSize(size: number) {
  if (!browser) return;
  document.documentElement.style.fontSize = `${size}px`;
}

export function listenSystemTheme(callback: () => void): () => void {
  if (!mql) return () => {};
  mql.addEventListener("change", callback);
  return () => mql.removeEventListener("change", callback);
}
