/**
 * Shared formatting helpers for human-readable display values.
 */

export function formatBytes(b: number | null | undefined): string {
  if (b == null) return "size unknown";
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(2)} GB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${b} B`;
}
