import {
  validatePassword,
  type PasswordValidationStatus,
} from 'firebase/auth';

import { auth } from '../firebase-auth';
import {
  MAXIMUM_PASSWORD_LENGTH,
  MINIMUM_PASSWORD_LENGTH,
  PasswordPolicyEvaluation,
  PasswordRequirementState,
  evaluatePasswordAgainstFallbackPolicy,
} from './auth-security.config';

const PASSWORD_POLICY_TIMEOUT_MILLISECONDS = 8_000;

function withPasswordPolicyTimeout<T>(operation: Promise<T>): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error('Password policy verification timed out.')),
      PASSWORD_POLICY_TIMEOUT_MILLISECONDS,
    );
  });

  return Promise.race([operation, timeout]).finally(() => {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  });
}

function requiredBoolean(
  configured: boolean | undefined,
  fallback: boolean,
): boolean {
  return configured === true || (configured === undefined && fallback);
}

function requirement(
  id: PasswordRequirementState['id'],
  label: string,
  met: boolean | undefined,
  required: boolean,
): PasswordRequirementState | null {
  return required
    ? {
        id,
        label,
        met: met === true,
        required: true,
      }
    : null;
}

export function mapFirebasePasswordValidation(
  status: PasswordValidationStatus,
): PasswordPolicyEvaluation {
  const options = status.passwordPolicy.customStrengthOptions;
  const minimumLength = options.minPasswordLength ?? MINIMUM_PASSWORD_LENGTH;
  const maximumLength = options.maxPasswordLength ?? MAXIMUM_PASSWORD_LENGTH;
  const requirements = [
    requirement(
      'minimum-length',
      `At least ${minimumLength} characters`,
      status.meetsMinPasswordLength,
      true,
    ),
    requirement(
      'maximum-length',
      `No more than ${maximumLength} characters`,
      status.meetsMaxPasswordLength,
      true,
    ),
    requirement(
      'lowercase',
      'At least one lowercase letter',
      status.containsLowercaseLetter,
      options.containsLowercaseLetter === true,
    ),
    requirement(
      'uppercase',
      'At least one capital letter',
      status.containsUppercaseLetter,
      requiredBoolean(options.containsUppercaseLetter, true),
    ),
    requirement(
      'numeric',
      'At least one number',
      status.containsNumericCharacter,
      requiredBoolean(options.containsNumericCharacter, true),
    ),
    requirement(
      'non-alphanumeric',
      'At least one special character, such as !, @, #, or $',
      status.containsNonAlphanumericCharacter,
      requiredBoolean(options.containsNonAlphanumericCharacter, true),
    ),
  ].filter((candidate): candidate is PasswordRequirementState => candidate !== null);

  return {
    isValid: status.isValid && requirements.every((candidate) => candidate.met),
    source: 'firebase',
    requirements,
    checkedAt: Date.now(),
    warning: '',
  };
}

export async function validateRegistrationPassword(
  password: string,
): Promise<PasswordPolicyEvaluation> {
  const fallback = evaluatePasswordAgainstFallbackPolicy(password);

  try {
    const status = await withPasswordPolicyTimeout(validatePassword(auth, password));
    return mapFirebasePasswordValidation(status);
  } catch (error: unknown) {
    return {
      ...fallback,
      warning:
        error instanceof Error
          ? 'RinkRat could not refresh the Firebase password policy, so the displayed production baseline is being used. Firebase remains the final authority.'
          : 'The production password baseline is being used until Firebase policy verification is available.',
    };
  }
}
