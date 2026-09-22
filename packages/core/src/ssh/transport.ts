import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execa, type Subprocess } from 'execa';
import { DwaraError } from '../errors.js';
import type { RawResult, RemoteCommand } from '../types.js';
import { quoteArgv } from './escape.js';

/** Transport-wide settings. */
export interface TransportOptions {
  /** Passed to `ssh -F`. Omitted to use the user's own `~/.ssh/config`. */
  readonly sshConfigPath?: string;
  /** Where the ControlMaster sockets live. */
  readonly controlDir?: string;
  /** Cap per stream. Output beyond it is discarded and flagged. */
  readonly maxOutputBytes?: number;
  /** Used when a command does not set its own. */
  readonly defaultTimeoutMs?: number;
}

/** 64 KB per stream, per DESIGN section 7. */
export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Stderr that means sudo wanted a password rather than that the command failed. */
const SUDO_PASSWORD = /sudo:.*(password is required|no tty present|a terminal is required)/i;

/** Stderr that means ssh never got as far as running anything. */
const SSH_FAILURE =
  /(Permission denied \(|Could not resolve hostname|Connection refused|Connection timed out|No route to host|Host key verification failed|Operation timed out|kex_exchange_identification)/;

/**
 * Runs commands on a host through the system `ssh` binary.
 *
 * Dwara never reimplements SSH. Shelling out to the real client means the
 * user's existing config, keys, agent, jump hosts and known_hosts all keep
 * working, and it keeps key handling out of this codebase entirely.
 */
export class SshTransport {
  private readonly sshConfigPath: string | undefined;
  private readonly controlDir: string;
  private readonly maxOutputBytes: number;
  private readonly defaultTimeoutMs: number;
  private controlDirReady = false;

  constructor(options: TransportOptions = {}) {
    this.sshConfigPath = options.sshConfigPath;
    this.controlDir = options.controlDir ?? join(homedir(), '.dwara');
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * The full `ssh` argument vector for a command.
   *
   * Exposed so tests and `dwara doctor` can show exactly what would run without
   * running it.
   *
   * `BatchMode=yes` is not negotiable: it makes ssh fail instead of prompting,
   * so an agent can never be silently waiting on a passphrase, and a host that
   * needs interaction is reported as broken rather than hanging.
   */
  buildArgs(host: string, command: RemoteCommand): string[] {
    const argv = command.sudo === true ? ['sudo', '-n', ...command.argv] : [...command.argv];

    const args = ['-o', 'BatchMode=yes'];
    if (this.sshConfigPath !== undefined) args.unshift('-F', this.sshConfigPath);

    args.push(
      '-o',
      'ControlMaster=auto',
      '-o',
      `ControlPath=${join(this.controlDir, 'cm-%C')}`,
      '-o',
      'ControlPersist=60s',
      '--',
      host,
      quoteArgv(argv),
    );

    return args;
  }

  /**
   * Runs one command and returns what the host said.
   *
   * Everything in the result is untrusted data: it is captured, capped and
   * handed back, never interpreted.
   *
   * @throws DwaraError `SSH_CONNECT_FAILED`, `SUDO_PASSWORD_REQUIRED`, `TIMEOUT`
   *   or `UNSAFE_ARGUMENT`. A non-zero exit from the remote command is *not* an
   *   error — that is a result, and the caller's tool decides what it means.
   */
  async run(host: string, command: RemoteCommand): Promise<RawResult> {
    const args = this.buildArgs(host, command);
    const timeoutMs = command.timeoutMs > 0 ? command.timeoutMs : this.defaultTimeoutMs;
    const startedAt = Date.now();

    await this.ensureControlDir();

    const subprocess = execa('ssh', args, {
      // The timeout is enforced below rather than by execa. execa's own timeout
      // kills the client but then waits for its stdio to close, and the
      // persistent ControlMaster holds those descriptors open until the remote
      // command ends — so a 2s timeout took as long as the command it was meant
      // to cut short.
      buffer: false,
      reject: false,
      stdin: command.stdin === undefined ? 'ignore' : 'pipe',
      // Nothing about a remote command should depend on the developer's shell.
      extendEnv: false,
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: homedir() },
    });

    if (command.stdin !== undefined) {
      subprocess.stdin?.end(command.stdin);
    }

    const stdout = this.collect(subprocess, 'stdout');
    const stderr = this.collect(subprocess, 'stderr');

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      subprocess.kill('SIGKILL');
      // Tearing the pipes down is what actually unblocks the wait, since the
      // ControlMaster is still holding its ends of them. Anything the command
      // had already produced has been captured by the readers above.
      //
      // Note this bounds how long Dwara waits, not how long the remote command
      // runs: a process started through a multiplexed connection keeps going.
      // Nothing here is mutating, and Phase 3's mutating tools snapshot before
      // they act, so a command outliving its timeout is recoverable.
      subprocess.stdout?.destroy();
      subprocess.stderr?.destroy();
    }, timeoutMs);

    let exitCode: number;
    try {
      const result = await subprocess;
      exitCode = result.exitCode ?? 0;
    } catch (cause) {
      exitCode = (cause as { exitCode?: number }).exitCode ?? 255;
    } finally {
      clearTimeout(timer);
    }

    const out = await stdout;
    const err = await stderr;
    const durationMs = Date.now() - startedAt;

    if (timedOut) {
      throw new DwaraError('TIMEOUT', `command on "${host}" exceeded ${timeoutMs}ms`, {
        details: { host, timeoutMs, argv: [...command.argv] },
        hint: "raise the tool's timeout, or narrow what the command asks for",
      });
    }

    if (SUDO_PASSWORD.test(err.text)) {
      throw new DwaraError('SUDO_PASSWORD_REQUIRED', `sudo on "${host}" asked for a password`, {
        details: { host, argv: [...command.argv] },
        hint: sudoersHint(command.argv),
      });
    }

    // ssh exits 255 on its own failures, but so can a remote command. The
    // stderr pattern is what separates the two; when it is ambiguous the
    // result is passed through rather than guessed at, so a tool sees the real
    // exit code instead of a fabricated connection error.
    if (exitCode === 255 && SSH_FAILURE.test(err.text)) {
      throw new DwaraError('SSH_CONNECT_FAILED', `cannot reach "${host}" over SSH`, {
        details: { host, stderr: err.text.slice(0, 500) },
        hint: 'check `ssh <host>` by hand, and that the key needs no passphrase (Dwara runs with BatchMode=yes)',
      });
    }

    return {
      argv: [...command.argv],
      exitCode,
      stdout: out.text,
      stderr: err.text,
      truncated: out.truncated || err.truncated,
      durationMs,
    };
  }

  /**
   * Reads a stream up to the cap.
   *
   * Beyond the cap bytes are dropped rather than the child being killed: a
   * chatty command should still yield a usable exit code and the first 64 KB,
   * which is where the answer nearly always is. Memory stays bounded either way.
   */
  private async collect(
    subprocess: Subprocess,
    stream: 'stdout' | 'stderr',
  ): Promise<{ text: string; truncated: boolean }> {
    const source = subprocess[stream];
    if (!source) return { text: '', truncated: false };

    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;

    try {
      for await (const chunk of source) {
        const buffer = Buffer.from(chunk as Uint8Array);
        if (size >= this.maxOutputBytes) {
          truncated = true;
          continue;
        }
        const room = this.maxOutputBytes - size;
        if (buffer.length > room) {
          chunks.push(buffer.subarray(0, room));
          size += room;
          truncated = true;
        } else {
          chunks.push(buffer);
          size += buffer.length;
        }
      }
    } catch {
      // A stream torn down by a timeout or a kill is expected; whatever was
      // read before that is still worth returning.
    }

    return { text: Buffer.concat(chunks).toString('utf8'), truncated };
  }

  private async ensureControlDir(): Promise<void> {
    if (this.controlDirReady) return;
    await mkdir(this.controlDir, { recursive: true, mode: 0o700 });
    this.controlDirReady = true;
  }
}

/** The sudoers line that would have let this command run. */
function sudoersHint(argv: readonly string[]): string {
  const program = argv[0] ?? 'command';
  return [
    `Dwara only ever uses \`sudo -n\`; it will not prompt for or store a password.`,
    `Allow this command without one, for example:`,
    `  <user> ALL=(root) NOPASSWD: ${program}`,
    `then re-run \`dwara doctor\`.`,
  ].join('\n');
}
