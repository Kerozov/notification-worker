/** Keep first occurrence; drop later items with the same normalized key. */
export function uniqueInOrder<T>(
  items: readonly T[],
  key: (item: T) => string,
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];

  for (const item of items) {
    const normalized = key(item);
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    out.push(item);
  }

  return out;
}

export function uniqueEmails(recipients: readonly string[]): string[] {
  return uniqueInOrder(recipients, (recipient) => recipient.trim().toLowerCase());
}
