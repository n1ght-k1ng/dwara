import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME, VERSION } from './index.js';

describe('@dwara/tools', () => {
  it('reports its package identity', () => {
    expect(PACKAGE_NAME).toBe('@dwara/tools');
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
