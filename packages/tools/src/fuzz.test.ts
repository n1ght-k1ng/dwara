import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { DwaraError, quoteArgv } from '@dwara/core';
import { createRegistry } from './index.js';

/**
 * Property tests over every registered tool's input.
 *
 * `escape.test.ts` already proves `quoteArgv` survives arbitrary bytes. That is a
 * necessary guarantee and not a sufficient one: escaping only helps if the
 * model's value arrives at it as **one argv element**. A tool that split a value
 * on spaces, or built `sh -c "... $value ..."`, would be quoted perfectly and
 * still injected.
 *
 * So the properties here are about the shape of what a tool builds, not about
 * bytes:
 *
 *   1. A tool either rejects an input or produces argv; it never throws an
 *      untyped error at the pipeline.
 *   2. **The number of argv elements does not depend on the content of a string
 *      the model chose.** This is the injection property: splitting is the bug,
 *      and a payload full of spaces, semicolons and newlines must produce exactly
 *      as many elements as a boring value of the same shape.
 *   3. No tool hands model-controlled text to a shell. `sh -c` / `bash -c` with
 *      an interpolated value is the one construction that defeats escaping, and
 *      CLAUDE.md forbids it outright.
 */

/** Strings chosen to break a naive command builder. */
const payload = (): fc.Arbitrary<string> =>
  fc.oneof(
    // Shell syntax that matters only if a value is spliced into a command line.
    fc.constantFrom(
      '; rm -rf /',
      '&& id',
      '| cat /etc/shadow',
      '$(id)',
      '`id`',
      '${IFS}id',
      "' ; id ; '",
      '" ; id ; "',
      'a b c',
      '--',
      '-',
      '--filter=x',
      '../../etc/shadow',
      '/etc/nginx/../shadow',
      '~/.ssh/id_ed25519',
      '*',
      '?',
      '!',
      '\\',
      "''",
      '%s',
      '$PATH',
      'nginx nginx',
    ),
    // Printable junk, and unicode that is not a control character.
    fc.stringMatching(/^[\x20-\x7e]{0,32}$/),
    // Built from a string so the source stays ASCII, and because a regex literal
    // here trips no-control-regex -- matching control characters is the point.
    // eslint-disable-next-line no-control-regex
    fc.string({ maxLength: 32 }).filter((s) => !new RegExp('[\\u0000-\\u001f\\u007f]').test(s)),
  );

/**
 * A valid-shaped input per tool, with the fields a model controls marked.
 *
 * Written out rather than generated from the zod schemas: a schema says what
 * parses, not what is a realistic call, and a generated `path` would be rejected
 * by the allow-list before any command was built — which would make the suite
 * pass by never reaching the thing it is testing.
 */
const CASES: readonly {
  tool: string;
  base: Record<string, unknown>;
  /** Fields whose value a model picks, and a benign value of the same shape. */
  fields: Record<string, string>;
}[] = [
  { tool: 'host_overview', base: { host: 'lab-api' }, fields: {} },
  {
    tool: 'service_status',
    base: { host: 'lab-api', unit: 'nginx' },
    fields: { unit: 'nginx' },
  },
  {
    tool: 'tail_logs',
    base: { host: 'lab-api', source: 'unit', unit: 'nginx', lines: 20 },
    fields: { unit: 'nginx', grep: 'error' },
  },
  {
    tool: 'disk_usage',
    base: { host: 'lab-api', path: '/var/log' },
    fields: { path: '/var/log' },
  },
  { tool: 'open_ports', base: { host: 'lab-api' }, fields: {} },
  { tool: 'docker_ps', base: { host: 'lab-api' }, fields: {} },
  {
    tool: 'container_logs',
    base: { host: 'lab-api', container: 'lab-app', lines: 20 },
    fields: { container: 'lab-app' },
  },
  {
    tool: 'container_inspect',
    base: { host: 'lab-api', container: 'lab-app' },
    fields: { container: 'lab-app' },
  },
  { tool: 'cert_expiry', base: { host: 'lab-api' }, fields: {} },
  {
    // The one with the path guard, so the one most worth fuzzing. Most generated
    // paths are refused by the allow-list, which is the correct answer and what
    // the properties accept -- what matters is that a refusal is typed and that
    // an accepted path never escapes its argv slot.
    tool: 'read_config',
    base: { host: 'lab-api', path: '/etc/nginx/nginx.conf' },
    fields: { path: '/etc/nginx/nginx.conf' },
  },
  { tool: 'security_audit', base: { host: 'lab-api' }, fields: {} },
  {
    tool: 'restart_service',
    base: { host: 'lab-api', unit: 'nginx' },
    fields: { unit: 'nginx' },
  },
  {
    tool: 'restart_container',
    base: { host: 'lab-api', container: 'lab-app' },
    fields: { container: 'lab-app' },
  },
  {
    tool: 'rotate_logs',
    base: { host: 'lab-api', paths: ['/var/log/app.log'] },
    fields: {},
  },
  { tool: 'prune_images', base: { host: 'lab-api' }, fields: { olderThan: '24h' } },
];

const registry = createRegistry();

/** Builds argv for an input, or reports why it was refused. */
function attempt(
  name: string,
  args: Record<string, unknown>,
): { ok: true; argv: readonly string[][] } | { ok: false; typed: boolean } {
  const tool = registry.get(name);
  if (tool === undefined) throw new Error(`no such tool: ${name}`);

  const parsed = tool.validate(args);
  if (!parsed.ok) return { ok: false, typed: true };

  try {
    const built = tool.build(parsed.value);
    // A staged tool has no `build`; its commands are exercised by its own tests
    // with a fake Ctx, because they depend on output this test cannot provide.
    if (built === undefined) return { ok: true, argv: [] };
    return { ok: true, argv: built.map((command) => [...command.argv]) };
  } catch (error) {
    return { ok: false, typed: error instanceof DwaraError };
  }
}

describe('tool input fuzzing', () => {
  it('covers every tool that builds its commands up front', () => {
    // Staged tools sequence their own commands against output this suite cannot
    // provide, so they are covered by their own tests with a fake Ctx. Everything
    // else must appear in CASES, so a new tool cannot be added without someone
    // deciding how it gets fuzzed.
    const staged = new Set(['edit_config', 'rollback']);
    const named = new Set(CASES.map((item) => item.tool));

    for (const tool of registry.list()) {
      if (staged.has(tool.name)) continue;
      expect(named.has(tool.name), `${tool.name} has no fuzz case`).toBe(true);
    }
  });

  for (const { tool, base, fields } of CASES) {
    const fieldNames = Object.keys(fields);
    if (fieldNames.length === 0) continue;

    it(`${tool}: argv element count never depends on a value's content`, () => {
      fc.assert(
        fc.property(fc.constantFrom(...fieldNames), payload(), (field, nasty) => {
          const benign = fields[field]!;

          const safe = attempt(tool, { ...base, [field]: benign });
          const hostile = attempt(tool, { ...base, [field]: nasty });

          // Refusing is always an acceptable answer, and it must be typed.
          if (!hostile.ok) return hostile.typed;
          if (!safe.ok) return true;

          // Same number of commands, and the same number of arguments in each:
          // a value that split would change one of these.
          if (hostile.argv.length !== safe.argv.length) return false;
          return hostile.argv.every(
            (argv, index) => argv.length === (safe.argv[index]?.length ?? -1),
          );
        }),
        { numRuns: 300 },
      );
    });

    it(`${tool}: a value lands in the same argv slots whatever it contains`, () => {
      // Stated positionally rather than by substring. The first version of this
      // asked how many arguments *contained* the payload, and fast-check
      // immediately produced "c" — which is in `systemctl`, and in half the
      // flags besides. Coincidental substrings say nothing; which slots changed
      // says everything, because a value that escaped its slot is the bug.
      fc.assert(
        fc.property(fc.constantFrom(...fieldNames), payload(), payload(), (field, a, b) => {
          const benign = attempt(tool, { ...base, [field]: fields[field]! });
          const first = attempt(tool, { ...base, [field]: a });
          const second = attempt(tool, { ...base, [field]: b });

          if (!benign.ok) return true;
          if (!first.ok) return first.typed;
          if (!second.ok) return second.typed;

          const slots = (built: readonly string[][]): string =>
            JSON.stringify(
              built.flatMap((argv, command) =>
                argv.flatMap((arg, index) =>
                  arg === benign.argv[command]?.[index] ? [] : [[command, index]],
                ),
              ),
            );

          return slots(first.argv) === slots(second.argv);
        }),
        { numRuns: 300 },
      );
    });

    it(`${tool}: whatever is built survives quoting`, () => {
      fc.assert(
        fc.property(fc.constantFrom(...fieldNames), payload(), (field, nasty) => {
          const result = attempt(tool, { ...base, [field]: nasty });
          if (!result.ok) return result.typed;

          for (const argv of result.argv) {
            try {
              quoteArgv(argv);
            } catch (error) {
              // Only the documented refusal is acceptable here.
              if (!(error instanceof DwaraError) || error.code !== 'UNSAFE_ARGUMENT') return false;
            }
          }
          return true;
        }),
        { numRuns: 300 },
      );
    });
  }

  it('never builds a command touching a denied path, however it is spelled', () => {
    // The guard is lexical first and then re-checks the resolved path, because
    // `readlink -f /etc/nginx/../shadow` really is /etc/shadow on a real host.
    // Here the lexical half is what can be tested without a host: no accepted
    // path may name a denied file after normalisation.
    const denied = [
      '/etc/shadow',
      '/etc/sudoers',
      '/root/.ssh/id_ed25519',
      '/home/dwara/.ssh/id_rsa',
      '/etc/ssl/private/server.key',
      '/srv/app/.env',
      '/home/dwara/.pgpass',
    ];

    const spellings = (path: string): string[] => [
      path,
      `/etc/nginx/..${path}`,
      `/var/log/../..${path}`,
      `//${path}`,
      path.replace('/', '//'),
      `/etc/./nginx/./..${path}`,
    ];

    for (const target of denied) {
      for (const spelling of spellings(target)) {
        for (const tool of ['read_config', 'disk_usage']) {
          const result = attempt(tool, { host: 'lab-api', path: spelling });
          if (!result.ok) {
            expect(result.typed, `${tool} threw an untyped error for ${spelling}`).toBe(true);
            continue;
          }
          // If it was accepted, the built command must not name the denied file.
          for (const argv of result.argv) {
            for (const arg of argv) {
              expect(
                arg.includes(target),
                `${tool} accepted ${spelling} and built a command naming ${target}`,
              ).toBe(false);
            }
          }
        }
      }
    }
  });

  it('no tool ever hands anything to a shell', () => {
    // The one construction escaping cannot save, and CLAUDE.md rule 1 forbids it.
    const shells = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'eval']);

    for (const { tool, base, fields } of CASES) {
      for (const field of ['', ...Object.keys(fields)]) {
        const args = field === '' ? base : { ...base, [field]: '; id' };
        const result = attempt(tool, args);
        if (!result.ok) continue;

        for (const argv of result.argv) {
          const verb = (argv[0] ?? '').split('/').pop() ?? '';
          expect(shells.has(verb), `${tool} builds a ${verb} command`).toBe(false);
          expect(argv).not.toContain('-c');
        }
      }
    }
  });
});
