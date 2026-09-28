import { X509Certificate } from 'node:crypto';
import { z } from 'zod';
import { Risk, type ToolDef } from '@dwara/core';
import { READ_TIMEOUT_MS, at, hostField } from './common.js';

const input = z
  .object({
    host: hostField,
    port: z.number().int().min(1).max(65535).default(443).describe('TLS port to connect to.'),
    servername: z
      .string()
      .min(1)
      .optional()
      .describe('SNI name to request. Needed when the host serves several certificates.'),
    target: z
      .string()
      .min(1)
      .default('127.0.0.1')
      .describe('Address to connect to from the host itself. Defaults to loopback.'),
  })
  .strict();

type Input = z.output<typeof input>;

export interface CertificateInfo {
  readonly subject: string;
  readonly issuer: string;
  readonly validFrom: string;
  readonly validTo: string;
  readonly daysRemaining: number;
  readonly expired: boolean;
  readonly selfSigned: boolean;
  readonly fingerprint256: string;
  readonly subjectAltNames: string | undefined;
}

export interface CertExpiry {
  readonly endpoint: string;
  readonly certificate: CertificateInfo | undefined;
  /** Certificates presented above the leaf, nearest first. */
  readonly chain: readonly { readonly subject: string; readonly validTo: string }[];
  readonly assessment: string;
  readonly error?: string;
}

/**
 * How long the certificate on a TLS port has left.
 *
 * One remote command, not a pipeline. `openssl s_client -showcerts` prints the
 * chain as PEM and Node's own `X509Certificate` reads it here — which keeps
 * `argv` a real argument vector rather than a shell string, and needs no
 * dependency.
 */
export const certExpiry: ToolDef<Input, CertExpiry> = {
  name: 'cert_expiry',
  risk: Risk.Read,
  description: [
    'The TLS certificate a host is serving on a port: subject, issuer, validity dates,',
    'days remaining, whether it is self-signed, and the chain above it.',
    '',
    'Check `daysRemaining` and `expired`. An expired certificate breaks clients while',
    'leaving the web server itself perfectly healthy — service_status will say "active"',
    'and open_ports will show the port listening, so this is the only tool that will',
    'tell you. A negative `daysRemaining` means it expired that many days ago.',
    '',
    '`selfSigned` true is expected in a test environment and a finding in production.',
    'Pass `servername` when the host serves several sites, otherwise you get whichever',
    'certificate is the default for that port.',
  ].join('\n'),
  input,

  build: (params) => [
    {
      argv: [
        'openssl',
        's_client',
        '-connect',
        `${params.target}:${params.port}`,
        ...(params.servername === undefined ? [] : ['-servername', params.servername]),
        '-showcerts',
      ],
      // s_client waits on stdin for input to forward; an empty stdin makes it
      // print the handshake and exit instead of hanging until the timeout.
      stdin: '',
      timeoutMs: READ_TIMEOUT_MS,
    },
  ],

  parse: (raws) => {
    const raw = at(raws, 0);
    const endpoint = argAfter(raw.argv, '-connect') ?? '';
    const pems =
      raw.stdout.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];

    if (pems.length === 0) {
      const reason = raw.stderr.trim().split('\n')[0] || 'no certificate was presented';
      return {
        endpoint,
        certificate: undefined,
        chain: [],
        assessment: `could not read a certificate from ${endpoint}`,
        error: reason.slice(0, 200),
      };
    }

    let leaf: CertificateInfo;
    try {
      leaf = describe(new X509Certificate(pems[0]!));
    } catch (err) {
      return {
        endpoint,
        certificate: undefined,
        chain: [],
        assessment: 'the host presented something that is not a usable certificate',
        error: err instanceof Error ? err.message : String(err),
      };
    }

    const chain = pems.slice(1).flatMap((pem) => {
      try {
        const cert = new X509Certificate(pem);
        return [{ subject: oneLine(cert.subject), validTo: cert.validTo }];
      } catch {
        return [];
      }
    });

    return { endpoint, certificate: leaf, chain, assessment: assess(leaf) };
  },
};

function describe(cert: X509Certificate): CertificateInfo {
  const validTo = new Date(cert.validTo);
  // Rounded towards zero from whole days, so "expires today" never reads as 1.
  const daysRemaining = Math.floor((validTo.getTime() - Date.now()) / 86_400_000);

  return {
    subject: oneLine(cert.subject),
    issuer: oneLine(cert.issuer),
    validFrom: cert.validFrom,
    validTo: cert.validTo,
    daysRemaining,
    expired: daysRemaining < 0,
    selfSigned: cert.subject === cert.issuer,
    fingerprint256: cert.fingerprint256,
    subjectAltNames: cert.subjectAltName,
  };
}

function assess(cert: CertificateInfo): string {
  const self = cert.selfSigned ? ', and it is self-signed' : '';

  if (cert.expired) {
    return `expired ${Math.abs(cert.daysRemaining)} day(s) ago; clients are failing while the server itself looks healthy${self}`;
  }
  if (cert.daysRemaining <= 7)
    return `expires in ${cert.daysRemaining} day(s), which is urgent${self}`;
  if (cert.daysRemaining <= 30)
    return `expires in ${cert.daysRemaining} day(s), worth renewing now${self}`;
  return `valid for another ${cert.daysRemaining} day(s)${self}`;
}

function oneLine(value: string): string {
  return value.replace(/\s*\n\s*/g, ', ').trim();
}

function argAfter(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}
