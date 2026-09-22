import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME, VERSION } from './index.js';

describe('@dwara/mcp-server', () => {
  it('reports its package identity', () => {
    expect(PACKAGE_NAME).toBe('@dwara/mcp-server');
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
