// The proxy and the certificate authorities for the requests Circle makes itself: the model,
// model lists, models.dev, webfetch, websearch, the update check, `circle update`'s release
// lookup and MCP servers reached by URL. All of them use fetch (the model SDKs too), so one
// setting at start covers them. As in the Python releases, HTTPS_PROXY, HTTP_PROXY and
// NO_PROXY choose the proxy, and SSL_CERT_FILE and SSL_CERT_DIR name certificate authorities
// to trust. Those are added to the ones Node.js trusts already (its own list and
// NODE_EXTRA_CA_CERTS); they do not replace them.
import http from 'node:http';
import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export interface NetworkSetup {
  // Certificate authorities added from SSL_CERT_FILE and SSL_CERT_DIR
  certificates: number;
  proxy: boolean;
  // What could not be used, one line each
  problems: string[];
  // Puts back what was there before (tests)
  restore(): void;
}

const PEM = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

function pemCertificates(path: string): string[] {
  const text = readFileSync(path, 'latin1');
  return (text.match(PEM) ?? []).filter((pem) => {
    try {
      new X509Certificate(pem);
      return true;
    } catch {
      return false;
    }
  });
}

// SSL_CERT_FILE: one PEM bundle. SSL_CERT_DIR: folders (separated as in PATH) of PEM files,
// as OpenSSL reads them; every file in them is read, hashed names or not.
export function extraCertificates(env: NodeJS.ProcessEnv = process.env): {
  certificates: string[];
  problems: string[];
} {
  const certificates: string[] = [];
  const problems: string[] = [];
  const file = env.SSL_CERT_FILE?.trim();
  if (file) {
    try {
      const found = pemCertificates(file);
      if (found.length) certificates.push(...found);
      else problems.push(`SSL_CERT_FILE has no PEM certificate: ${file}`);
    } catch (error) {
      problems.push(`SSL_CERT_FILE cannot be read: ${reason(error)}`);
    }
  }
  for (const folder of (env.SSL_CERT_DIR ?? '').split(delimiter)) {
    if (!folder.trim()) continue;
    let names: string[];
    try {
      names = readdirSync(folder);
    } catch (error) {
      problems.push(`SSL_CERT_DIR cannot be read: ${reason(error)}`);
      continue;
    }
    const before = certificates.length;
    for (const name of names.sort()) {
      const path = join(folder, name);
      try {
        if (statSync(path).isFile())
          certificates.push(...pemCertificates(path));
      } catch {
        // A broken link or an unreadable file in a certificate folder is skipped, as OpenSSL does.
      }
    }
    if (certificates.length === before)
      problems.push(`SSL_CERT_DIR has no PEM certificate: ${folder}`);
  }
  return { certificates: [...new Set(certificates)], problems };
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const PROXY_VARIABLES = [
  'https_proxy',
  'HTTPS_PROXY',
  'http_proxy',
  'HTTP_PROXY',
];

// Called once at start, before the first request. Never throws: a setting that cannot be used
// is returned in `problems` for the caller to show. (tls.setDefaultCACertificates is in
// Node.js 24.5 and later, http.setGlobalProxyFromEnv in 24.14 and later; releases ship 24.21.)
export function configureNetwork(
  env: NodeJS.ProcessEnv = process.env,
): NetworkSetup {
  const undo: (() => void)[] = [];
  const { certificates, problems } = extraCertificates(env);
  let added = 0;
  if (certificates.length) {
    if (typeof tls.setDefaultCACertificates !== 'function')
      problems.push(
        `Node.js ${process.version} cannot add SSL_CERT_FILE or SSL_CERT_DIR; use NODE_EXTRA_CA_CERTS or Node.js 24.5 or later`,
      );
    else {
      const previous = tls.getCACertificates('default');
      try {
        tls.setDefaultCACertificates([...previous, ...certificates]);
        undo.push(() => tls.setDefaultCACertificates(previous));
        added = certificates.length;
      } catch (error) {
        problems.push(`certificates could not be added: ${reason(error)}`);
      }
    }
  }
  let proxy = false;
  if (PROXY_VARIABLES.some((name) => env[name]?.trim())) {
    if (typeof http.setGlobalProxyFromEnv === 'function')
      try {
        undo.push(http.setGlobalProxyFromEnv(env));
        proxy = true;
      } catch (error) {
        problems.push(`the proxy setting cannot be used: ${reason(error)}`);
      }
    else if (env.NODE_USE_ENV_PROXY === '1') proxy = true;
    else
      problems.push(
        `Node.js ${process.version} cannot use HTTPS_PROXY or HTTP_PROXY; use Node.js 24.14 or later`,
      );
  }
  return {
    certificates: added,
    proxy,
    problems,
    restore: () => {
      for (const step of [...undo].reverse()) step();
    },
  };
}

// A failed certificate check, anywhere in an error's chain of causes (fetch wraps it).
export function isCertificateError(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 5; depth++) {
    const code = (current as { code?: unknown }).code;
    if (
      typeof code === 'string' &&
      /CERT|SELF_SIGNED|UNABLE_TO_(VERIFY|GET_ISSUER)/.test(code)
    )
      return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export const TLS_HINT =
  'the TLS certificate could not be verified; if your network inspects HTTPS, set SSL_CERT_FILE to its CA bundle';
