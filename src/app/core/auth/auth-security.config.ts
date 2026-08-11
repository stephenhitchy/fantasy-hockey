/**
 * Browser-facing authentication requirements.
 *
 * Firebase Authentication remains the final authority. These values are the
 * production-safe fallback used while the browser loads the project policy.
 * The Firebase policy is intentionally configured to match this baseline.
 */
export const MINIMUM_PASSWORD_LENGTH = 12;
export const MAXIMUM_PASSWORD_LENGTH = 128;
export const REQUIRE_PASSWORD_LOWERCASE = false;
export const REQUIRE_PASSWORD_UPPERCASE = true;
export const REQUIRE_PASSWORD_NUMERIC = true;
export const REQUIRE_PASSWORD_NON_ALPHANUMERIC = true;
export const RECENT_AUTHENTICATION_WINDOW_SECONDS = 15 * 60;

export type PasswordRequirementId =
  | 'minimum-length'
  | 'maximum-length'
  | 'lowercase'
  | 'uppercase'
  | 'numeric'
  | 'non-alphanumeric';

export interface PasswordRequirementState {
  id: PasswordRequirementId;
  label: string;
  met: boolean;
  required: boolean;
}

export interface PasswordPolicyEvaluation {
  isValid: boolean;
  source: 'firebase' | 'fallback';
  requirements: PasswordRequirementState[];
  checkedAt: number;
  warning: string;
}

function hasLowercase(value: string): boolean {
  return /[a-z]/.test(value);
}

function hasUppercase(value: string): boolean {
  return /[A-Z]/.test(value);
}

function hasNumeric(value: string): boolean {
  return /[0-9]/.test(value);
}

function hasNonAlphanumeric(value: string): boolean {
  return /[^A-Za-z0-9]/.test(value);
}

export function evaluatePasswordAgainstFallbackPolicy(
  password: string,
): PasswordPolicyEvaluation {
  const requirements: PasswordRequirementState[] = [
    {
      id: 'minimum-length',
      label: `At least ${MINIMUM_PASSWORD_LENGTH} characters`,
      met: password.length >= MINIMUM_PASSWORD_LENGTH,
      required: true,
    },
    {
      id: 'maximum-length',
      label: `No more than ${MAXIMUM_PASSWORD_LENGTH} characters`,
      met: password.length <= MAXIMUM_PASSWORD_LENGTH,
      required: true,
    },
    ...(REQUIRE_PASSWORD_LOWERCASE
      ? [{
          id: 'lowercase' as const,
          label: 'At least one lowercase letter',
          met: hasLowercase(password),
          required: true,
        }]
      : []),
    ...(REQUIRE_PASSWORD_UPPERCASE
      ? [{
          id: 'uppercase' as const,
          label: 'At least one capital letter',
          met: hasUppercase(password),
          required: true,
        }]
      : []),
    ...(REQUIRE_PASSWORD_NUMERIC
      ? [{
          id: 'numeric' as const,
          label: 'At least one number',
          met: hasNumeric(password),
          required: true,
        }]
      : []),
    ...(REQUIRE_PASSWORD_NON_ALPHANUMERIC
      ? [{
          id: 'non-alphanumeric' as const,
          label: 'At least one special character, such as !, @, #, or $',
          met: hasNonAlphanumeric(password),
          required: true,
        }]
      : []),
  ];

  return {
    isValid: requirements.every((requirement) => !requirement.required || requirement.met),
    source: 'fallback',
    requirements,
    checkedAt: Date.now(),
    warning: '',
  };
}

export function passwordMeetsRegistrationPolicy(password: string): boolean {
  return evaluatePasswordAgainstFallbackPolicy(password).isValid;
}

export function getMissingPasswordRequirements(
  evaluation: PasswordPolicyEvaluation,
): PasswordRequirementState[] {
  return evaluation.requirements.filter(
    (requirement) => requirement.required && !requirement.met,
  );
}

export function formatMissingPasswordRequirements(
  evaluation: PasswordPolicyEvaluation,
): string {
  const labels = getMissingPasswordRequirements(evaluation).map(
    (requirement) => requirement.label.toLowerCase(),
  );

  if (labels.length === 0) {
    return '';
  }

  if (labels.length === 1) {
    return labels[0] ?? '';
  }

  return `${labels.slice(0, -1).join(', ')}, and ${labels.at(-1)}`;
}

export function passwordRequirementSummary(): string {
  return `Use ${MINIMUM_PASSWORD_LENGTH}–${MAXIMUM_PASSWORD_LENGTH} characters with a capital letter, number, and special character.`;
}
