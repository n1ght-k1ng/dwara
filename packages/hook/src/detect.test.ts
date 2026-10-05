import { describe, expect, it } from 'vitest';
import { inspect } from './detect.js';
import { CORPUS_HOSTS, EVASION_CASES, MUST_NOT_PASS } from './evasions.js';

describe('the evasion corpus', () => {
  it('is large enough to be worth something', () => {
    // PLAN.md asks for at least 60 cases.
    expect(EVASION_CASES.length).toBeGreaterThanOrEqual(60);
  });

  it('has no duplicate commands hiding a thin corpus', () => {
    const seen = new Set(EVASION_CASES.map((item) => item.command));
    expect(seen.size).toBe(EVASION_CASES.length);
  });
});

describe.each(EVASION_CASES)('$command', ({ command, expect: wanted, why }) => {
  it(`is ${wanted} — ${why}`, () => {
    expect(inspect(command, CORPUS_HOSTS).kind, why).toBe(wanted);
  });
});

describe('zero false negatives', () => {
  it('lets nothing through that must not pass', () => {
    // The criterion from PLAN.md, asserted as one statement rather than
    // inferred from a page of green ticks.
    const escaped = MUST_NOT_PASS.filter(
      (item) => inspect(item.command, CORPUS_HOSTS).kind === 'allow',
    );

    expect(escaped.map((item) => item.command)).toEqual([]);
  });

  it('names the host and the verb when it denies, so the message can be useful', () => {
    const verdict = inspect('scp ./x lab-db:/tmp', CORPUS_HOSTS);

    expect(verdict).toEqual({ kind: 'deny', verb: 'scp', host: 'lab-db' });
  });

  it('says why when it cannot read a command', () => {
    const verdict = inspect('ssh $HOST', CORPUS_HOSTS);

    expect(verdict.kind).toBe('unreadable');
    expect(verdict.kind === 'unreadable' && verdict.reason).toContain('variable');
  });
});

describe('when Dwara manages nothing', () => {
  it('allows everything, including commands it would otherwise refuse', () => {
    // The plugin is installed globally; most projects do not use Dwara. A hook
    // that blocked anyway would be uninstalled rather than configured.
    for (const item of EVASION_CASES) {
      expect(inspect(item.command, []).kind, item.command).toBe('allow');
    }
  });
});

describe('host matching', () => {
  it('matches only the hosts it was given', () => {
    expect(inspect('ssh lab-api', ['lab-api']).kind).toBe('deny');
    expect(inspect('ssh lab-api', ['lab-db']).kind).toBe('allow');
  });

  it('does not match a host that merely contains a managed name', () => {
    // `lab-api-staging` is a different machine from `lab-api`.
    expect(inspect('ssh lab-api-staging', ['lab-api']).kind).toBe('allow');
    expect(inspect('ssh notlab-api', ['lab-api']).kind).toBe('allow');
  });

  it('strips the user from user@host', () => {
    expect(inspect('ssh root@lab-api', ['lab-api'])).toMatchObject({ host: 'lab-api' });
    expect(inspect('scp f admin@lab-db:/tmp', ['lab-db'])).toMatchObject({ host: 'lab-db' });
  });

  it('reads the destination out of a path argument, either side', () => {
    expect(inspect('scp lab-api:/var/log/x .', ['lab-api']).kind).toBe('deny');
    expect(inspect('scp . lab-api:/var/log/x', ['lab-api']).kind).toBe('deny');
  });

  it('is not fooled by a port that looks like a path separator', () => {
    // `-p 2201` is an option value, not a destination.
    expect(inspect('ssh -p 2201 unmanaged', ['lab-api']).kind).toBe('allow');
  });
});

describe('recursion bounds', () => {
  it('refuses a command nested past any sane depth rather than looping', () => {
    let command = 'ssh lab-api';
    for (let i = 0; i < 12; i += 1) command = `bash -c ${JSON.stringify(command)}`;

    // Either it reads all the way down and denies, or it gives up and says so.
    // What it must not do is allow, or spin.
    expect(inspect(command, CORPUS_HOSTS).kind).not.toBe('allow');
  });
});
