/**
 * The corpus the hook is judged against.
 *
 * A committed data file rather than inline test cases, so the threat model can
 * cite it and Phase 6's red-team work can extend it without touching the tests.
 *
 * Every case here was written against **measured** `shell-quote` behaviour, not
 * assumed behaviour. That distinction earned its place: three times in this
 * project a guard has been written against a shape the parser does not actually
 * produce. The four that matter most, all confirmed by running the parser:
 *
 * - **`ssh $HOST` parses to `['ssh', '']`.** The variable is replaced by an
 *   empty string, so the host silently disappears. A detector looking for a
 *   managed hostname finds nothing and waves it through.
 * - **Backticks are not interpreted.** `` `ssh lab-api x` `` parses to
 *   ``['`ssh', 'lab-api', 'x`']`` — the verb token carries a leading backtick,
 *   so an equality check on `'ssh'` misses it entirely.
 * - **Unbalanced quotes do not throw.** `ssh lab-api"` parses cleanly to
 *   `['ssh', 'lab-api']`, so a parse failure cannot be relied on to catch
 *   malformed input.
 * - **`xargs ssh` has no host at all.** It comes from stdin, which is not
 *   knowable at hook time.
 *
 * Quote-splitting (`s''sh`) and backslashes (`\\ssh`) are both normalised back
 * to `ssh` by the parser, so they need no special handling — but they are in
 * the corpus so that a future parser change which stops normalising them fails
 * a test instead of opening a hole.
 */

/** What the hook must do with a command. */
export type Expectation =
  /** A managed host is reachable; refuse. */
  | 'deny'
  /** Nothing managed is involved; stay out of the way. */
  | 'allow'
  /** Cannot be read with confidence and mentions managed infrastructure. */
  | 'unreadable';

export interface EvasionCase {
  readonly command: string;
  readonly expect: Expectation;
  /** Why this case exists. Read when a test fails. */
  readonly why: string;
}

/**
 * Hosts the corpus treats as managed.
 *
 * `lab-*` plus two bare aliases, matching the testbed's SSH config.
 */
export const CORPUS_HOSTS: readonly string[] = [
  'lab-api',
  'lab-db',
  'lab-cache',
  'lab-queue',
  'lab-staging',
] as const;

/** Direct, unobfuscated reach for a managed host. */
const DIRECT: readonly EvasionCase[] = [
  { command: 'ssh lab-api', expect: 'deny', why: 'the plainest case there is' },
  {
    command: "ssh dwara@lab-api 'systemctl restart nginx'",
    expect: 'deny',
    why: 'a user@host form with a remote command',
  },
  { command: 'ssh lab-db uptime', expect: 'deny', why: 'a different managed host' },
  {
    command: 'ssh -o StrictHostKeyChecking=no lab-api',
    expect: 'deny',
    why: 'options before the host must not hide it',
  },
  {
    command: 'ssh -i ~/.ssh/id_ed25519 -p 2201 lab-api',
    expect: 'deny',
    why: 'several option pairs before the host',
  },
  {
    command: 'ssh -J bastion lab-api',
    expect: 'deny',
    why: 'reached through a jump host; the destination is still managed',
  },
  {
    command: 'scp ./patch.conf lab-api:/etc/nginx/conf.d/',
    expect: 'deny',
    why: 'copying a file in is a change, and scp is the obvious way round edit_config',
  },
  {
    command: 'scp lab-api:/var/log/syslog .',
    expect: 'deny',
    why: 'copying out bypasses the redactor entirely',
  },
  {
    command: 'rsync -avz ./dist/ lab-api:/srv/app/',
    expect: 'deny',
    why: 'rsync is scp with more reach',
  },
  { command: 'sftp lab-api', expect: 'deny', why: 'another file transfer route' },
  { command: 'mosh lab-api', expect: 'deny', why: 'a shell by another name' },
  {
    command: '/usr/bin/ssh lab-api',
    expect: 'deny',
    why: 'an absolute path; the verb must be matched on its basename',
  },
  {
    command: 'ssh\tlab-api',
    expect: 'deny',
    why: 'a tab rather than a space still separates tokens',
  },
];

/** Wrapped, nested or otherwise disguised. */
const WRAPPED: readonly EvasionCase[] = [
  {
    command: 'DEBUG=1 ssh lab-api',
    expect: 'deny',
    why: 'an environment prefix sits in front of the verb',
  },
  {
    command: 'FOO=1 BAR=2 ssh lab-api',
    expect: 'deny',
    why: 'several environment prefixes',
  },
  { command: 'sudo ssh lab-api', expect: 'deny', why: 'a wrapper the walker must step past' },
  { command: 'env ssh lab-api', expect: 'deny', why: 'env as a wrapper' },
  { command: 'timeout 5 ssh lab-api', expect: 'deny', why: 'timeout takes an argument first' },
  { command: 'nohup ssh lab-api &', expect: 'deny', why: 'backgrounded' },
  { command: 'nice -n 10 ssh lab-api', expect: 'deny', why: 'nice with a flag pair' },
  {
    command: 'command ssh lab-api',
    expect: 'deny',
    why: 'the shell builtin that bypasses aliases',
  },
  { command: 'bash -c "ssh lab-api hostname"', expect: 'deny', why: 'one level of bash -c' },
  { command: "sh -c 'ssh lab-api'", expect: 'deny', why: 'sh rather than bash' },
  {
    command: 'bash -c \'bash -c "ssh lab-api"\'',
    expect: 'deny',
    why: 'two levels; recursion cannot stop at one',
  },
  { command: 'eval "ssh lab-api"', expect: 'deny', why: 'eval takes a string to run' },
  { command: 'zsh -c "ssh lab-api"', expect: 'deny', why: 'a third shell' },
  {
    command: '$(ssh lab-api hostname)',
    expect: 'deny',
    why: 'command substitution; the parser flattens it into ordinary tokens',
  },
  {
    command: 'echo "$(ssh lab-api hostname)"',
    expect: 'deny',
    why: 'substitution nested inside a quoted argument',
  },
  {
    command: '`ssh lab-api hostname`',
    expect: 'deny',
    why: 'backticks are NOT interpreted: the verb token arrives as "`ssh"',
  },
  {
    command: 'echo `ssh lab-api uptime`',
    expect: 'deny',
    why: 'backticks as an argument, same stray-character problem',
  },
  { command: 'ssh lab-api; echo done', expect: 'deny', why: 'a semicolon separator' },
  { command: 'echo hi && ssh lab-api', expect: 'deny', why: 'after a conditional' },
  { command: 'false || ssh lab-api', expect: 'deny', why: 'after an or' },
  { command: 'echo lab-api | ssh lab-api', expect: 'deny', why: 'after a pipe' },
  {
    command: 's'.concat("''", 'sh lab-api'),
    expect: 'deny',
    why: 'quote splitting, which the parser normalises back to ssh',
  },
  {
    command: '\\ssh lab-api',
    expect: 'deny',
    why: 'a leading backslash, also normalised away',
  },
  {
    command: 'ssh lab-api -- systemctl restart nginx',
    expect: 'deny',
    why: 'a -- separator before the remote command',
  },
];

/** Nothing managed is involved; the hook must stay out of the way. */
const INNOCENT: readonly EvasionCase[] = [
  { command: 'ssh my-vps', expect: 'allow', why: 'a host no policy names' },
  { command: 'ssh git@github.com', expect: 'allow', why: 'a forge, not managed infrastructure' },
  { command: 'git push origin main', expect: 'allow', why: 'git over SSH to somewhere unmanaged' },
  { command: 'git clone git@github.com:me/repo.git', expect: 'allow', why: 'cloning' },
  { command: 'scp ./a.txt backup-box:/tmp', expect: 'allow', why: 'scp to an unmanaged host' },
  { command: 'rsync -a ./a/ ./b/', expect: 'allow', why: 'a purely local rsync' },
  { command: 'grep ssh /etc/hosts', expect: 'allow', why: 'the word ssh as a search term' },
  {
    command: 'echo "ssh lab-api"',
    expect: 'allow',
    why: 'the text as a string argument to echo, not a command being run',
  },
  {
    command: 'cat notes.md | grep lab-api',
    expect: 'allow',
    why: 'a managed hostname appearing as data',
  },
  { command: 'dwara doctor', expect: 'allow', why: 'Dwara itself' },
  { command: 'pnpm test', expect: 'allow', why: 'ordinary development' },
  { command: 'ls -la /etc/ssh', expect: 'allow', why: 'a path that contains ssh' },
  {
    command: 'docker ps',
    expect: 'allow',
    why: 'local docker, which reaches no managed host',
  },
  {
    command: 'ssh-keygen -t ed25519 -f ./key',
    expect: 'allow',
    why: 'ssh-keygen is not ssh and reaches nothing',
  },
  {
    command: 'ssh-add ~/.ssh/id_ed25519',
    expect: 'allow',
    why: 'another ssh- prefixed tool that connects to nothing',
  },
  {
    command: 'man ssh',
    expect: 'allow',
    why: 'ssh as an argument rather than the program',
  },
  {
    command: 'which ssh',
    expect: 'allow',
    why: 'asking where it is, not running it',
  },
];

/**
 * Cannot be read with confidence, and mentions managed infrastructure.
 *
 * These are the cases where guessing is the failure. The hook refuses and says
 * it could not read the command, which is a different and more honest answer
 * than either allowing or claiming to have found something.
 */
const UNREADABLE: readonly EvasionCase[] = [
  {
    command: 'ssh $HOST',
    expect: 'unreadable',
    why: 'the parser yields ["ssh", ""]: the host is erased, so it cannot be cleared',
  },
  {
    command: 'ssh "$TARGET" systemctl restart nginx',
    expect: 'unreadable',
    why: 'a quoted variable, erased the same way',
  },
  {
    command: 'ssh ${HOST}',
    expect: 'unreadable',
    why: 'brace form, erased the same way',
  },
  {
    command: 'ssh lab-$(echo api)',
    expect: 'unreadable',
    why: 'a host assembled by substitution; the parser leaves "lab-$" and operators',
  },
  {
    command: 'ssh *-api',
    expect: 'unreadable',
    why: 'a glob in the host position, which the parser hands back unresolved',
  },
  {
    command: 'cat hosts.txt | xargs ssh',
    expect: 'unreadable',
    why: 'the host comes from stdin and is not knowable at hook time',
  },
  {
    command: 'cat hosts.txt | xargs -I{} ssh {} uptime',
    expect: 'unreadable',
    why: 'the same, with a placeholder standing in for the host',
  },
  {
    command: 'bash -c "ssh $H"',
    expect: 'unreadable',
    why: 'a variable inside a nested shell string',
  },
  {
    command: 'eval "$CMD"',
    expect: 'unreadable',
    why: 'eval of a variable: the whole command is unknown',
  },
  {
    command: 'bash ./deploy.sh',
    expect: 'allow',
    why: 'a script file whose contents the hook cannot see; the dedicated-key setup is what covers this, and blocking every script would make the plugin unusable',
  },
];

/** Every case, in one table. */
export const EVASION_CASES: readonly EvasionCase[] = [
  ...DIRECT,
  ...WRAPPED,
  ...INNOCENT,
  ...UNREADABLE,
];

/** Cases that must never be allowed through. PLAN.md: zero false negatives. */
export const MUST_NOT_PASS: readonly EvasionCase[] = EVASION_CASES.filter(
  (item) => item.expect !== 'allow',
);
