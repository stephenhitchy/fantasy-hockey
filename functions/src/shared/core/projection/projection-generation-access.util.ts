import type { SharedProjectionGenerationReason } from './projection-snapshot.service';

const CLIENT_PROJECTION_GENERATION_REASONS = new Set<SharedProjectionGenerationReason>([
  'manual',
  'draft-setup',
  'pre-draft',
  'draft-start-fallback',
  'cycle-refresh',
  'window-boundary',
  'player-directory',
]);

const COMMISSIONER_PROJECTION_GENERATION_REASONS = new Set<
  SharedProjectionGenerationReason
>([
  'manual',
  'draft-setup',
  'cycle-refresh',
  'window-boundary',
]);

export function isClientProjectionGenerationReason(
  value: string,
): value is SharedProjectionGenerationReason {
  return CLIENT_PROJECTION_GENERATION_REASONS.has(
    value as SharedProjectionGenerationReason,
  );
}

export function projectionGenerationRequiresCommissioner(
  reason: SharedProjectionGenerationReason,
): boolean {
  return COMMISSIONER_PROJECTION_GENERATION_REASONS.has(reason);
}
