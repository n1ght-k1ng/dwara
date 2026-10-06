import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/**
 * Reading and validating scenarios.
 *
 * `meta.yaml` is where a scenario says what it is and what would be unsafe, and
 * the schema is strict because a typo in `forbidden` would silently stop a rule
 * being enforced and the benchmark would report zero unsafe attempts for a
 * reason that has nothing to do with the agent.
 */

/** A rule that makes an audit entry an unsafe attempt. */
const forbiddenSchema = z
  .object({
    /** Bare or risk-prefixed tool name. */
    tool: z.string().optional(),
    host: z.string().optional(),
    risk: z.enum(['read', 'reversible', 'config', 'destructive']).optional(),
    /** Why this is forbidden here. Read when a run is scored unsafe. */
    why: z.string().optional(),
  })
  .strict()
  .refine((rule) => rule.tool !== undefined || rule.host !== undefined || rule.risk !== undefined, {
    message: 'a forbidden rule needs at least one of tool, host or risk',
  });

export const metaSchema = z
  .object({
    name: z.string().min(1),
    /**
     * `fix` — the host should end up healthy.
     * `refuse` — the host should end up **unchanged**, because nothing Dwara
     *   has can fix it, and the correct outcome is an honest handover.
     * `injection` — the host should end up healthy *and* the planted
     *   instruction should not have been followed.
     */
    category: z.enum(['fix', 'refuse', 'injection']),
    difficulty: z.enum(['easy', 'medium', 'hard']),
    host: z.string().min(1),
    summary: z.string().min(1),
    expect: z
      .object({
        /** For refuse scenarios: no change may be verified on any host. */
        refuses: z.boolean().optional(),
      })
      .strict()
      .default({}),
    /** Informational: what a correct run would plausibly reach for. */
    tools: z.array(z.string()).default([]),
    forbidden: z.array(forbiddenSchema).default([]),
    notes: z.string().optional(),
  })
  .strict();

export type ScenarioMeta = z.output<typeof metaSchema>;

export interface Scenario {
  readonly meta: ScenarioMeta;
  readonly dir: string;
  readonly prompt: string;
}

export const SCENARIO_ROOT = 'evals/scenarios';

/**
 * Loads one scenario.
 *
 * @throws when the directory is incomplete or `meta.yaml` does not validate. A
 *   half-written scenario should stop the run rather than be scored.
 */
export async function loadScenario(name: string, root = SCENARIO_ROOT): Promise<Scenario> {
  const dir = join(root, name);

  let raw: unknown;
  try {
    raw = parseYaml(await readFile(join(dir, 'meta.yaml'), 'utf8'));
  } catch (cause) {
    throw new Error(`scenario "${name}": meta.yaml could not be read`, { cause });
  }

  const parsed = metaSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`scenario "${name}": meta.yaml is not valid — ${problems}`);
  }

  if (parsed.data.name !== name) {
    // A mismatch means a copied directory with an unedited meta, and every
    // result would be filed under the wrong name.
    throw new Error(`scenario "${name}": meta.yaml calls itself "${parsed.data.name}"`);
  }

  const prompt = (await readFile(join(dir, 'prompt.txt'), 'utf8')).trim();
  if (prompt === '') throw new Error(`scenario "${name}": prompt.txt is empty`);

  return { meta: parsed.data, dir, prompt };
}

/** Every scenario on disk, by name. */
export async function listScenarios(root = SCENARIO_ROOT): Promise<readonly string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const found: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      await readFile(join(root, entry.name, 'meta.yaml'), 'utf8');
      found.push(entry.name);
    } catch {
      continue;
    }
  }

  return found.sort();
}
