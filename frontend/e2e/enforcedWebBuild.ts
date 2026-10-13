import { spawn, spawnSync } from 'node:child_process';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { createServer as createHttpServer, request as httpRequest, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';

import { frontendServerEnv } from './frontendEnv';
import { answer, headerValues, parseNginxConf, type Header, type NginxPlan } from './nginxEmulator';

/**
 * The production web build, served the way production serves it, for the CSP
 * journey (ADR 0009 phase (b), #3067).
 *
 * The rest of the browser lane drives the Expo dev server, which never runs the
 * steps under test here. This builds the real thing instead:
 *
 * 1. `expo export --platform web` against the lane backend, with the same env
 *    builder the dev server uses;
 * 2. `web-hardening/sri.js stamp`, the post-export step the Docker image runs;
 * 3. `web-hardening/csp.js`, rendering `nginx.conf` with the API origin baked into
 *    that bundle;
 *
 * and serves `dist` with the headers the rendered conf would send, through
 * `nginxEmulator`. The bundle's API origin must be https (`config.ts` refuses
 * anything else in a production build), so the lane backend is fronted by a
 * TLS proxy with a throwaway self-signed certificate; the browser context runs
 * with `ignoreHTTPSErrors`. The page and the API are different origins, as
 * they are in production, so the narrowed `connect-src` is genuinely exercised.
 */

const FRONTEND_DIR = join(__dirname, '..');
const EXPO_CLI = join(FRONTEND_DIR, 'node_modules', 'expo', 'bin', 'cli');
const LOOPBACK = '127.0.0.1';
/** Metro workers for the export: the lane shares its host with other work. */
const EXPORT_WORKERS = '2';
const CERT_DAYS = '1';

/**
 * A port `DEV_ORIGINS` (backend/src/main.py) already allows for `ENV=e2e`, so
 * the backend's CORS answers the page's origin. The habits demo spec uses the
 * same port only while its own spec runs; specs run one at a time.
 */
export const ENFORCED_FRONTEND_PORT = 8080;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export interface EnforcedBuild {
  /** Where the export landed. */
  dist: string;
  /** The rendered conf the static server answers with. */
  plan: NginxPlan;
  /** The single enforced policy the rendered conf sends. */
  policy: string;
  /** Scratch space to remove at teardown. */
  workDir: string;
}

/** Run `command` to completion, throwing with its output on a non-zero exit. */
function run(command: string, args: string[], env: typeof process.env): Promise<void> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: FRONTEND_DIR,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const append = (chunk: Buffer): void => {
      output += chunk.toString();
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', rejectRun);
    child.on('close', (code) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${args.join(' ')} exited ${String(code)}\n${output}`));
    });
  });
}

/**
 * Export, stamp and render a production build whose API is `apiOrigin`.
 *
 * Metro's transform cache is keyed on file contents, not on `EXPO_PUBLIC_*`
 * values, so an export that reuses the shared cache can ship another build's
 * API URL (observed: a cached `config.ts` with an empty one). `TMPDIR` points
 * this export's cache at its own empty directory, so the bundle is built from
 * this env alone.
 */
export async function buildEnforcedWebApp(apiOrigin: string): Promise<EnforcedBuild> {
  const workDir = mkdtempSync(join(tmpdir(), 'adepthood-csp-'));
  const dist = join(workDir, 'dist');
  const cacheDir = join(workDir, 'tmp');
  const env = { ...frontendServerEnv(apiOrigin, process.env), TMPDIR: cacheDir, TMP: cacheDir };
  mkdirSync(cacheDir);
  const node = process.execPath;
  await run(
    node,
    [
      EXPO_CLI,
      'export',
      '--platform',
      'web',
      '--output-dir',
      dist,
      '--max-workers',
      EXPORT_WORKERS,
    ],
    env,
  );
  await run(node, ['web-hardening/sri.js', 'stamp', dist], env);
  const conf = join(workDir, 'default.conf');
  await run(node, ['web-hardening/csp.js', 'nginx.conf', conf], env);
  const plan = parseNginxConf(readFileSync(conf, 'utf8'));
  const policies = new Set(headerValues(plan, 'Content-Security-Policy'));
  if (policies.size !== 1) {
    throw new Error(`expected one rendered policy, found ${String(policies.size)}`);
  }
  return { dist, plan, policy: [...policies][0] ?? '', workDir };
}

export function removeBuild(build: EnforcedBuild | undefined): void {
  if (build) rmSync(build.workDir, { recursive: true, force: true });
}

export interface StaticServer {
  url: string;
  /** When true, every `.js` response gains one trailing byte: a tampered bundle. */
  tamperScripts: boolean;
  close: () => Promise<void>;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose) => {
    server.closeAllConnections();
    server.close(() => resolveClose());
  });
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, LOOPBACK, () => resolveListen((server.address() as AddressInfo).port));
  });
}

function setHeaders(headers: readonly Header[], set: (name: string, value: string) => void): void {
  for (const [name, value] of headers) set(name, value);
}

/** Serve `build.dist` on `port` with the rendered conf's routing and headers. */
export async function serveWithNginxHeaders(
  build: EnforcedBuild,
  port: number,
): Promise<StaticServer> {
  const root = resolve(build.dist);
  const exists = (file: string): boolean => {
    const path = resolve(join(root, decodeURIComponent(file)));
    return path.startsWith(root + sep) && existsSync(path) && statSync(path).isFile();
  };
  const handle: StaticServer = { url: '', tamperScripts: false, close: () => Promise.resolve() };
  const server = createHttpServer((req, res) => {
    const uri = new URL(req.url ?? '/', `http://${LOOPBACK}`).pathname;
    const decided = answer(build.plan, uri, exists);
    setHeaders(decided.headers, (name, value) => res.setHeader(name, value));
    if (decided.file === null) {
      res.writeHead(decided.status).end();
    } else {
      const path = join(root, decodeURIComponent(decided.file));
      const type = CONTENT_TYPES[extname(path)] ?? 'application/octet-stream';
      res.writeHead(decided.status, { 'Content-Type': type });
      if (handle.tamperScripts && path.endsWith('.js')) {
        res.end(Buffer.concat([readFileSync(path), Buffer.from('\n')]));
      } else {
        createReadStream(path).pipe(res);
      }
    }
  });
  const bound = await listen(server, port);
  handle.url = `http://${LOOPBACK}:${String(bound)}`;
  handle.close = () => closeServer(server);
  return handle;
}

export interface TlsProxy {
  origin: string;
  close: () => Promise<void>;
}

/** A throwaway self-signed certificate for 127.0.0.1, made with openssl. */
function selfSignedCertificate(dir: string): { key: Buffer; cert: Buffer } {
  const key = join(dir, 'key.pem');
  const cert = join(dir, 'cert.pem');
  const made = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      CERT_DAYS,
      '-keyout',
      key,
      '-out',
      cert,
      '-subj',
      `/CN=${LOOPBACK}`,
      '-addext',
      `subjectAltName=IP:${LOOPBACK}`,
    ],
    { encoding: 'utf8' },
  );
  if (made.status !== 0) throw new Error(`openssl could not make a certificate:\n${made.stderr}`);
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

/**
 * An https origin that forwards every request, headers and body untouched, to
 * the lane backend at `target`. CORS stays the backend's own: the page's
 * `Origin` reaches it as sent and its answer comes back as written.
 */
export async function startTlsProxy(target: string): Promise<TlsProxy> {
  const dir = mkdtempSync(join(tmpdir(), 'adepthood-csp-tls-'));
  const upstream = new URL(target);
  const server = createHttpsServer(selfSignedCertificate(dir), (req, res) => {
    const forwarded = httpRequest(
      {
        hostname: upstream.hostname,
        port: upstream.port,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: upstream.host },
      },
      (reply) => {
        res.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(res);
      },
    );
    forwarded.on('error', () => res.writeHead(502).end());
    req.pipe(forwarded);
  });
  const port = await listen(server, 0);
  return {
    origin: `https://${LOOPBACK}:${String(port)}`,
    close: async () => {
      await closeServer(server);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
