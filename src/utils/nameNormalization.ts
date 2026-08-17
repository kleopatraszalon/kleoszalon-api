export function normalizeNameField(value: unknown, locale = "hu-HU"): string {
  const text = String(value ?? "");
  const index = text.search(/\S/u);
  if (index < 0) return text;
  return text.slice(0, index) + text[index].toLocaleUpperCase(locale) + text.slice(index + 1);
}
