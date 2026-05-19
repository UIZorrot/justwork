export function hasVisibleTitle(value: string): boolean {
  return value.trim().length > 0;
}

export function displayTitleOrFallback(value: string | undefined, fallback: string): string {
  return hasVisibleTitle(value ?? "") ? (value ?? "") : fallback;
}

export function normalizeDocTitleInput(value: string, fallback: string): string {
  return hasVisibleTitle(value) ? value : fallback;
}
