/**
 * Wrapping server output so a model reads it as data.
 *
 * Everything a host says is untrusted (CLAUDE.md rule 7). A log line, a config
 * comment, a container name or an HTTP response body can all be written by
 * whoever controls the host — or by an attacker who has already got there — and
 * the model reading them has no way to tell that apart from Dwara's own words.
 *
 * The real defences against that are structural and live elsewhere: typed
 * tools, the policy engine, the destructive floor, human approval for config
 * changes. This module adds the two cheap things on top: say plainly that the
 * content is data, and flag content that is trying to be instructions.
 */

/** Why a payload was flagged. */
export type SuspicionKind =
  | 'addresses-model'
  | 'instruction-override'
  | 'targets-dwara'
  | 'credential-request'
  | 'hidden-text';

export interface Suspicion {
  readonly kind: SuspicionKind;
  /** What matched, trimmed and capped — itself already redacted. */
  readonly excerpt: string;
}

/** Server output, marked as data, with anything suspicious noted. */
export interface Envelope<T> {
  /**
   * Constant marker. Present so a client, a log reader or a human skimming a
   * transcript can see at a glance that the payload came from a host.
   */
  readonly source: 'untrusted-server-output';
  readonly host: string;
  readonly tool: string;
  readonly data: T;
  /** Empty when nothing looked like an injection attempt. */
  readonly suspicions: readonly Suspicion[];
  /** True when output hit the transport cap. */
  readonly truncated: boolean;
}

interface Detector {
  readonly kind: SuspicionKind;
  readonly pattern: RegExp;
}

/**
 * Heuristics for text that is addressing the model rather than describing the
 * system.
 *
 * These are deliberately narrow. A broad rule would fire on ordinary sysadmin
 * prose — "ignore this warning", "you must restart nginx" — and an operator who
 * stops trusting the flags is worse off than one who never had them.
 */
const DETECTORS: readonly Detector[] = [
  {
    kind: 'instruction-override',
    pattern:
      /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+|your\s+|the\s+)?(?:previous|prior|earlier|above|system|initial)\s+(?:instruction|prompt|rule|direction|message)/i,
  },
  {
    kind: 'addresses-model',
    pattern:
      // `act as a ...` is deliberately absent: "acts as a reverse proxy",
      // "act as a load balancer" are ordinary infrastructure prose, and a
      // detector that fires on those teaches the reader to ignore all of them.
      /\b(?:you\s+are\s+now|from\s+now\s+on\s+you|pretend\s+to\s+be|new\s+instructions?\s*:|system\s+prompt\s*:|<\/?(?:system|assistant|user)>)/i,
  },
  {
    kind: 'targets-dwara',
    pattern:
      /\b(?:dwara|the\s+policy|policy\.yaml|audit\s+log)\b[^\n]{0,60}?\b(?:disable|bypass|ignore|skip|turn\s+off|remove|delete|overwrite)\b/i,
  },
  {
    kind: 'targets-dwara',
    pattern:
      /\b(?:disable|bypass|skip|turn\s+off)\b[^\n]{0,40}?\b(?:approval|policy|safety|guardrail|restriction|audit)/i,
  },
  {
    kind: 'credential-request',
    pattern:
      // The gap allows dots: the things worth exfiltrating live at paths like
      // ~/.ssh/id_ed25519, and excluding dots meant the rule could never reach
      // past the first one.
      /\b(?:send|post|upload|exfiltrate|curl|email|transmit)\b[^\n]{0,60}?(?:credential|password|private\s+key|\btoken\b|\.ssh|id_rsa|id_ed25519|\/etc\/shadow)/i,
  },
  {
    kind: 'hidden-text',
    // Zero-width characters and ANSI cursor manipulation: no reason for either
    // to appear in a config file or a log line, and both hide text from a human
    // reading the same output.
    //
    // Built from a string so the source stays ASCII. Written as a regex literal,
    // the escapes get normalised into the literal invisible characters, which
    // is the very hazard this rule detects.
    // eslint-disable-next-line no-control-regex -- matching ESC is the point
    pattern: new RegExp('[\\u200b-\\u200f\\u2060\\ufeff]|\\u001b\\[[0-9;]*[A-Za-z]'),
  },
];

/** Scans text for content that reads as instructions to the model. */
export function findSuspicions(text: string): Suspicion[] {
  const found: Suspicion[] = [];
  const seen = new Set<SuspicionKind>();

  for (const detector of DETECTORS) {
    const match = detector.pattern.exec(text);
    if (!match) continue;
    // One finding per kind is enough to warn; a planted file could otherwise
    // fill the result with hundreds of near-identical flags.
    if (seen.has(detector.kind)) continue;
    seen.add(detector.kind);

    found.push({ kind: detector.kind, excerpt: excerpt(text, match.index) });
  }

  return found;
}

/** A short, single-line window around a match. */
function excerpt(text: string, index: number): string {
  const start = Math.max(0, index - 20);
  return text
    .slice(start, start + 120)
    .replace(/\s+/g, ' ')
    .trim();
}

export interface WrapOptions {
  readonly host: string;
  readonly tool: string;
  readonly truncated?: boolean;
  /**
   * Text to scan, when the payload is structured and the suspicious content
   * would be inside it. Already redacted by the caller.
   */
  readonly scan?: string;
}

/**
 * Wraps a payload as untrusted server output.
 *
 * Suspicious content is flagged, never blocked. Blocking would hand anyone who
 * can write to a log file a denial-of-service against the diagnosis — write
 * "ignore all previous instructions" into an nginx error log and the tool that
 * reads it stops working. Flagging keeps the evidence available and tells the
 * reader to treat it with care.
 */
export function wrap<T>(data: T, options: WrapOptions): Envelope<T> {
  const scanned = options.scan ?? (typeof data === 'string' ? data : (JSON.stringify(data) ?? ''));

  return {
    source: 'untrusted-server-output',
    host: options.host,
    tool: options.tool,
    data,
    suspicions: findSuspicions(scanned),
    truncated: options.truncated ?? false,
  };
}
