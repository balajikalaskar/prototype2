export function normalizeText(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

export function nullableText(value: string | undefined): string | null {
  return value ? normalizeText(value) || null : null;
}
