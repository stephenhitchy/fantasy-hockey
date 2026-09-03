function normalizeDraftSearchValue(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLocaleLowerCase();
}

export function matchesDraftPlayerSearch(
  searchTerm: string,
  candidateValues: readonly string[],
): boolean {
  const normalizedSearch = normalizeDraftSearchValue(searchTerm);

  if (!normalizedSearch) {
    return true;
  }

  return candidateValues.some((value) =>
    normalizeDraftSearchValue(value).includes(normalizedSearch),
  );
}
