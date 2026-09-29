import { describe, expect, it } from 'vitest';
import { applyDiff, parseDiff, summariseDiff } from './diff.js';

const NGINX = [
  'server {',
  '    listen 80;',
  '    location / {',
  '        proxy_pass http://127.0.0.1:3999;',
  '    }',
  '}',
  '',
].join('\n');

/** The fix for the nginx-bad-config scenario: 3999 is wrong, 3000 is right. */
const FIX = [
  '--- a/etc/nginx/sites-enabled/lab',
  '+++ b/etc/nginx/sites-enabled/lab',
  '@@ -2,3 +2,3 @@',
  '     listen 80;',
  '     location / {',
  '-        proxy_pass http://127.0.0.1:3999;',
  '+        proxy_pass http://127.0.0.1:3000;',
  '',
].join('\n');

describe('applyDiff', () => {
  it('applies a hunk exactly where it says', () => {
    expect(applyDiff(NGINX, FIX)).toBe(NGINX.replace('3999', '3000'));
  });

  it('keeps everything it was not asked to change', () => {
    const result = applyDiff(NGINX, FIX);

    expect(result.split('\n')).toHaveLength(NGINX.split('\n').length);
    expect(result).toContain('server {');
    expect(result).toContain('    listen 80;');
  });

  it('refuses to place a hunk that does not match, rather than finding somewhere it does', () => {
    // The whole point. patch(1) would happily apply this a line or two away;
    // the bytes a human approved are the bytes that must land.
    const moved = NGINX.replace('    listen 80;', '    listen 80;\n    server_name lab;');

    expect(() => applyDiff(moved, FIX)).toThrowError(/does not match the file at line/);
  });

  it('reports which line disagreed and what it found', () => {
    const changed = NGINX.replace('3999', '4000');

    expect(() => applyDiff(changed, FIX)).toThrowError(/expected .*3999.*found .*4000/);
  });

  it('is a PLAN_MISMATCH, not a malformed input', () => {
    // The file moved under us, which is a different situation from being sent
    // nonsense, and the caller has to be able to tell them apart.
    expect(() => applyDiff(NGINX.replace('3999', '4000'), FIX)).toThrowError(
      expect.objectContaining({ code: 'PLAN_MISMATCH' }) as Error,
    );
  });

  it('adds lines without context loss', () => {
    const add = [
      '@@ -1,2 +1,3 @@',
      ' server {',
      '+    server_name lab;',
      '     listen 80;',
      '',
    ].join('\n');

    expect(applyDiff(NGINX, add)).toContain('server {\n    server_name lab;\n    listen 80;');
  });

  it('removes lines', () => {
    const remove = [
      '@@ -1,3 +1,2 @@',
      ' server {',
      '-    listen 80;',
      '     location / {',
      '',
    ].join('\n');

    expect(applyDiff(NGINX, remove)).not.toContain('listen 80');
  });

  it('applies several hunks in order', () => {
    const two = [
      '@@ -1,2 +1,2 @@',
      '-server {',
      '+server { # edited',
      '     listen 80;',
      '@@ -4,2 +4,2 @@',
      '-        proxy_pass http://127.0.0.1:3999;',
      '+        proxy_pass http://127.0.0.1:3000;',
      '     }',
      '',
    ].join('\n');

    const result = applyDiff(NGINX, two);
    expect(result).toContain('server { # edited');
    expect(result).toContain('3000');
  });

  it('refuses hunks that are out of order or overlap', () => {
    const backwards = [
      '@@ -4,1 +4,1 @@',
      '-        proxy_pass http://127.0.0.1:3999;',
      '+        proxy_pass http://127.0.0.1:3000;',
      '@@ -1,1 +1,1 @@',
      '-server {',
      '+server { # edited',
      '',
    ].join('\n');

    expect(() => applyDiff(NGINX, backwards)).toThrowError(/overlap or are out of order/);
  });

  it('ignores the file headers, so a diff cannot redirect the write', () => {
    // The tool is told which path it is editing. A `+++ b/etc/shadow` header
    // must be inert.
    const hostile = FIX.replace('+++ b/etc/nginx/sites-enabled/lab', '+++ b/etc/shadow');

    expect(applyDiff(NGINX, hostile)).toBe(NGINX.replace('3999', '3000'));
  });

  it('refuses a diff with no hunks', () => {
    expect(() => applyDiff(NGINX, '--- a/x\n+++ b/x\n')).toThrowError(/no hunks/);
    expect(() => applyDiff(NGINX, '')).toThrowError(/no hunks/);
  });

  it('refuses a hunk line that is neither context, addition nor removal', () => {
    const junk = ['@@ -1,1 +1,1 @@', ' server {', 'rm -rf /', ''].join('\n');

    expect(() => applyDiff(NGINX, junk)).toThrowError(/unreadable line/);
  });

  it('refuses a hunk that starts past the end of the file', () => {
    const far = ['@@ -900,1 +900,1 @@', '-nothing', '+something', ''].join('\n');

    expect(() => applyDiff(NGINX, far)).toThrowError(/expects at least 899 line\(s\)/);
  });

  it('treats a bare empty line as unchanged context', () => {
    // Editors and mail clients strip the leading space from context lines that
    // are otherwise empty, and a strict reader that rejected those would
    // refuse most real diffs.
    const withBlank = 'a\n\nb\n';
    const diff = ['@@ -1,3 +1,3 @@', ' a', '', '-b', '+c', ''].join('\n');

    expect(applyDiff(withBlank, diff)).toBe('a\n\nc\n');
  });

  it('preserves a trailing newline', () => {
    expect(applyDiff(NGINX, FIX).endsWith('\n')).toBe(true);
  });

  it('inserts into an empty file', () => {
    const create = ['@@ -0,0 +1,2 @@', '+first', '+second', ''].join('\n');

    expect(applyDiff('', create)).toBe('first\nsecond\n');
  });
});

describe('parseDiff and summariseDiff', () => {
  it('counts what a diff would do, for a human reading the plan', () => {
    expect(summariseDiff(FIX)).toEqual({ added: 1, removed: 1, hunks: 1 });
  });

  it('defaults a hunk without a line count to one line', () => {
    const [hunk] = parseDiff(['@@ -1 +1 @@', '-server {', '+server {}', ''].join('\n'));

    expect(hunk).toMatchObject({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 });
  });
});
