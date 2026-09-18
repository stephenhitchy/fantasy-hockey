export type DraftMobileDestination = 'active' | 'bench' | null;

export function resolveDraftMobileSelectionLabel(input: {
  selected: boolean;
  destination: DraftMobileDestination;
}): string {
  if (input.selected) {
    return 'Selected';
  }

  return input.destination === 'bench' ? 'Select for Bench' : 'Select';
}
