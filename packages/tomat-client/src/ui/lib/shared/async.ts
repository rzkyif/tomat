// Small async helpers shared across the client.

/** Reject if `p` doesn't settle within `ms`. Used to bound deferred core calls
 *  on the boot path so a wedged request fails fast (and loud) instead of
 *  hanging invisibly. The losing timer is always cleared. */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}
