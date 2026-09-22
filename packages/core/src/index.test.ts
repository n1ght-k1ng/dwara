import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME, VERSION } from './index.js';

describe('@dwara/core', () => {
  it('reports its package identity', () => {
    expect(PACKAGE_NAME).toBe('@dwara/core');
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
