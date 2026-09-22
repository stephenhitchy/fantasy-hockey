import {
  normalizeEmailVerificationCode,
  normalizeEmailVerificationInvite,
  verificationEmailMatchesSession,
} from './email-verification-continuation.util';

describe('email verification continuation', () => {
  it('accepts only bounded action codes and valid six-character invite codes', () => {
    expect(normalizeEmailVerificationCode('  one-time-code  ')).toBe('one-time-code');
    expect(normalizeEmailVerificationCode('')).toBe('');
    expect(normalizeEmailVerificationCode('x'.repeat(2_049))).toBe('');
    expect(normalizeEmailVerificationInvite(' ice123 ')).toBe('ICE123');
    expect(normalizeEmailVerificationInvite('not-valid')).toBe('');
  });

  it('only resumes automatically for the account whose email was verified', () => {
    expect(verificationEmailMatchesSession('Manager@Example.com', 'manager@example.com')).toBe(true);
    expect(verificationEmailMatchesSession('manager@example.com', 'other@example.com')).toBe(false);
    expect(verificationEmailMatchesSession('', 'manager@example.com')).toBe(false);
  });
});
