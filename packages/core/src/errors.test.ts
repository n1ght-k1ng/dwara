import { describe, expect, it } from 'vitest';
import { DwaraError } from './errors.js';

describe('DwaraError', () => {
  it('carries a code, details and a hint', () => {
    const err = new DwaraError('SUDO_PASSWORD_REQUIRED', 'sudo wants a password', {
      details: { host: 'lab-api' },
      hint: 'add a sudoers entry',
    });

    expect(err.code).toBe('SUDO_PASSWORD_REQUIRED');
    expect(err.details).toEqual({ host: 'lab-api' });
    expect(err.toJSON()).toEqual({
      code: 'SUDO_PASSWORD_REQUIRED',
      message: 'sudo wants a password',
      details: { host: 'lab-api' },
      hint: 'add a sudoers entry',
    });
  });

  it('omits an absent hint rather than serialising undefined', () => {
    expect(new DwaraError('INTERNAL', 'boom').toJSON()).not.toHaveProperty('hint');
  });

  it('preserves an existing DwaraError when wrapping', () => {
    const original = new DwaraError('TIMEOUT', 'too slow');
    expect(DwaraError.from(original)).toBe(original);
  });

  it('wraps anything else, keeping the cause', () => {
    const cause = new Error('underlying');
    const wrapped = DwaraError.from(cause, 'COMMAND_FAILED');

    expect(wrapped.code).toBe('COMMAND_FAILED');
    expect(wrapped.message).toBe('underlying');
    expect(wrapped.cause).toBe(cause);
    expect(DwaraError.from('a string').message).toBe('a string');
  });

  it('recognises its own instances', () => {
    expect(DwaraError.is(new DwaraError('INTERNAL', 'x'))).toBe(true);
    expect(DwaraError.is(new Error('x'))).toBe(false);
    expect(DwaraError.is(null)).toBe(false);
  });
});
