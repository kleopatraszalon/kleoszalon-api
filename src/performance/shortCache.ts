type CacheEntry<T> = {
  value?: T;
  expiresAt: number;
  pending?: Promise<T>;
};

const cache = new Map<string, CacheEntry<unknown>>();

export async function shortCache<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const existing = cache.get(key) as CacheEntry<T> | undefined;
  if (existing && existing.value !== undefined && existing.expiresAt > now) return existing.value;
  if (existing?.pending) return existing.pending;

  const pending = loader().then(
    value => {
      cache.set(key, { value, expiresAt: Date.now() + Math.max(250, ttlMs) });
      return value;
    },
    error => {
      cache.delete(key);
      throw error;
    },
  );
  cache.set(key, { value: existing?.value, expiresAt: existing?.expiresAt || 0, pending });
  return pending;
}

export function clearShortCache(prefix?: string) {
  if (!prefix) {
    cache.clear();
    return;
  }
  for (const key of cache.keys()) if (key.startsWith(prefix)) cache.delete(key);
}

export async function timed<T>(label: string, fn: () => Promise<T>, warnAfterMs = 500): Promise<T> {
  const started = Date.now();
  try {
    return await fn();
  } finally {
    const elapsed = Date.now() - started;
    if (elapsed >= warnAfterMs) console.warn(`[slow] ${label} ${elapsed}ms`);
  }
}
