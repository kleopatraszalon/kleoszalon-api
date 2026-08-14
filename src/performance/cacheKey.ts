export function scopedCacheKey(parts: Array<string | number | boolean | null | undefined>) {
  return parts.map(part => part == null || part === "" ? "-" : String(part)).join("|");
}
