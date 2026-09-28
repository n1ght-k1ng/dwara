import { randomBytes } from 'node:crypto';

/**
 * One agent's run, and the budget it has spent.
 *
 * This is the piece Phase 1 deliberately left out. `evaluate()` reads
 * `actionsUsed` and never changes it, because a policy evaluator that mutated
 * state would make the same call give different answers on a retry. Something
 * had to own the counter; this is it.
 *
 * The rule that matters: **only an action that actually reached a host counts.**
 * A call refused by policy, or rejected for bad arguments, consumed nothing on
 * the far end, and charging the agent for it would mean a session could be
 * exhausted entirely by attempts that were never permitted — which is both
 * unfair and a way to deny service to the operator by spamming denied calls.
 */
export class Session {
  readonly id: string;
  /** Which client is driving, recorded in every audit entry. */
  readonly agent: string;
  readonly startedAt: string;

  private executed = 0;
  private refused = 0;

  constructor(options: { agent?: string; id?: string } = {}) {
    this.id = options.id ?? `s_${randomBytes(4).toString('hex')}`;
    this.agent = options.agent ?? 'unknown';
    this.startedAt = new Date().toISOString();
  }

  /** Actions that reached a host. This is what the policy's limit applies to. */
  get actionsUsed(): number {
    return this.executed;
  }

  /** Calls that never ran. Reported, but not charged against the budget. */
  get actionsRefused(): number {
    return this.refused;
  }

  /** Records an action that reached a host, whether or not it succeeded. */
  recordExecuted(): void {
    this.executed += 1;
  }

  /** Records a call that was refused before anything ran. */
  recordRefused(): void {
    this.refused += 1;
  }
}
