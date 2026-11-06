/**
 * The claim API — the route the frontend "Claim your name" button calls.
 *
 * Flow (ens/PLAN.md §3, in order — every step can short-circuit with a code):
 *
 *   1. parse the request          → 400 with the exact missing fields
 *   2. issuing configured?        → 503 setup error naming the env vars
 *   3. invite check               → 403/409/410 (see invites.ts)
 *   4. wallet signature (EIP-191) → 401 when it does not recover to the wallet
 *   5. issue via the Issuer       → 409 name taken / 502 chain error
 *   6. HCS audit log (best-effort) → a failure never fails an issued claim
 *   7. persist + consume invite   → 201 { name, txHash, resolverTxHashes, hcsTxId }
 *
 * No keys are shared: the artist signs; the server verifies and only then lets
 * the parent-owner wallet (configured server-side) do the issuing.
 *
 * `createApp()` is separate from `start()` (same pattern as payments/) so tests
 * drive the app in-process on an ephemeral port.
 */
import { createServer, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isAddress, verifyMessage } from 'ethers';
import { loadConfig, requireIssueConfig, type Config } from './config.ts';
import { sendJson, readBody, parseJson, log, type Ctx } from './http.ts';
import { claimMessage, createChainIssuer, normalizeLabel, type Issuer } from './registry.ts';
import { submitToHcs, tokenHash, type HcsEvent } from './hcs.ts';
import { isInviteUsedLocally, markInviteUsed, validateInvite } from './invites.ts';

export interface ClaimRequest {
  /** the requested subname label, e.g. `shaka` → `shaka.<parent>` */
  artistName: string;
  /** human-readable artist name for the audit log (optional) */
  displayName?: string;
  /** the artist's own payout wallet — must sign the claim message */
  wallet: string;
  /** Hedera payout account ID, written to the `com.hedera.account` record */
  hederaPayoutAccount: string;
  /** EIP-191 signature of claimMessage(artistName, parentName) */
  signature: string;
  /** one-time steward invite token */
  inviteToken: string;
  profileUrl?: string;
  avatarUrl?: string;
  agentUrl?: string;
}

export interface ClaimDeps {
  /** override for tests; defaults to the real chain issuer */
  issuer?: Issuer;
  /** override for tests; defaults to submitToHcs */
  hcs?: (event: HcsEvent) => Promise<string | null>;
  /** override for tests; defaults to global fetch (mirror node reads) */
  fetchImpl?: typeof fetch;
  /** injectable clock so invite-expiry tests do not sleep */
  now?: () => number;
}

export interface App {
  server: Server;
  cfg: Config;
}

const REQUIRED_FIELDS = ['artistName', 'wallet', 'hederaPayoutAccount', 'signature', 'inviteToken'] as const;

const CLAIMS_FILE = 'claims.jsonl';

/** The HTTP status each invite rejection maps to. */
const INVITE_STATUS: Record<string, number> = {
  INVITE_UNKNOWN: 403,
  INVITE_EXPIRED: 410,
  INVITE_REVOKED: 410,
  INVITE_USED: 409,
};

export function createApp(cfg: Config, deps: ClaimDeps = {}): App {
  /**
   * The issuer is built lazily: `createChainIssuer` throws when issuing is not
   * configured, and /health must work before the owner has picked a parent.
   */
  let issuer: Issuer | undefined;
  const getIssuer = (): Issuer => (deps.issuer ?? (issuer ??= createChainIssuer(cfg)));
  const hcsSubmit = deps.hcs ?? ((event: HcsEvent) => submitToHcs(cfg, event));
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());

  const server = createServer((req, res) => {
    void (async () => {
      // CORS for the browser frontend teammate: it signs with the artist's
      // wallet in the browser and posts here.
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
      res.setHeader('access-control-allow-headers', 'content-type');
      if (req.method === 'OPTIONS') return void res.writeHead(204).end();

      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const started = Date.now();

      let ctx: Ctx;
      try {
        const raw = req.method === 'GET' || req.method === 'HEAD' ? '' : await readBody(req);
        ctx = { req, res, url, raw, body: parseJson(raw) };
      } catch (err) {
        sendJson(res, 400, { error: 'BAD_REQUEST', message: (err as Error).message });
        return;
      }

      try {
        if (url.pathname === '/health' && req.method === 'GET') {
          return sendJson(res, 200, {
            ok: true,
            mode: cfg.mode,
            parentName: cfg.parentName ?? null,
            issuing: {
              rpc: Boolean(cfg.rpcUrl),
              registry: true,
              resolver: Boolean(cfg.resolverAddress),
              parentOwnerKey: Boolean(cfg.parentOwnerKey),
            },
            hcs: { topic: cfg.hcsClaimTopicId ?? null },
            mirrorNode: cfg.mirrorNodeUrl,
            uptimeSec: Math.round(process.uptime()),
          });
        }

        if (url.pathname === '/claims/recent' && req.method === 'GET') {
          return sendJson(res, 200, { claims: await readRecentClaims(cfg) });
        }

        if (url.pathname === '/api/claim' && req.method === 'POST') {
          return await handleClaim(ctx, cfg, { issuer: getIssuer(), hcsSubmit, fetchImpl, now });
        }

        sendJson(res, 404, { error: 'NOT_FOUND' });
      } catch (err) {
        // last-resort guard: a bug must be a clean 500, not a dead socket
        log.error('unhandled request error', { path: url.pathname, error: (err as Error).message });
        if (!res.headersSent) sendJson(res, 500, { error: 'INTERNAL', message: 'internal error' });
      } finally {
        log.info('request', { method: req.method, path: url.pathname, status: res.statusCode, ms: Date.now() - started });
      }
    })();
  });

  return { server, cfg };
}

async function handleClaim(
  ctx: Ctx,
  cfg: Config,
  deps: {
    issuer: Issuer;
    hcsSubmit: (event: HcsEvent) => Promise<string | null>;
    fetchImpl: typeof fetch;
    now: () => number;
  },
): Promise<void> {
  const body = ctx.body as Partial<ClaimRequest> | undefined;
  if (!body || typeof body !== 'object') {
    return sendJson(ctx.res, 400, { error: 'BAD_REQUEST', message: 'body must be a JSON object' });
  }
  const missing = REQUIRED_FIELDS.filter((f) => !body[f] || typeof body[f] !== 'string');
  if (missing.length > 0) {
    return sendJson(ctx.res, 400, { error: 'MISSING_FIELDS', fields: missing });
  }
  const req = body as ClaimRequest;

  // (2) — a claim cannot proceed on an unconfigured stack, and the error must
  // name the env vars so the operator can fix it without reading code.
  const required = requireIssueConfig(cfg);

  // label first: cheap, and every later error message uses the normalized name
  let label: string;
  try {
    label = normalizeLabel(req.artistName);
  } catch (err) {
    return sendJson(ctx.res, 400, { error: 'INVALID_LABEL', message: (err as Error).message });
  }
  if (!isAddress(req.wallet)) {
    return sendJson(ctx.res, 400, { error: 'INVALID_WALLET', message: `not an address: ${req.wallet}` });
  }
  if (!/^0\.0\.\d{1,19}$/.test(req.hederaPayoutAccount)) {
    return sendJson(ctx.res, 400, {
      error: 'INVALID_HEDERA_ACCOUNT',
      message: `must look like 0.0.12345, got ${JSON.stringify(req.hederaPayoutAccount)}`,
    });
  }

  // (3) invite — checked before the signature so a wrong wallet cannot burn a
  // valid token: consumption only happens after a successful issue.
  const hash = tokenHash(req.inviteToken);
  if (await isInviteUsedLocally(cfg, req.inviteToken)) {
    return sendJson(ctx.res, 409, { error: 'INVITE_USED', message: 'this invite token was already redeemed' });
  }
  const invite = await validateInvite(cfg, deps.fetchImpl, req.inviteToken, deps.now());
  if (!invite.ok) {
    return sendJson(ctx.res, INVITE_STATUS[invite.reason], { error: invite.reason });
  }

  // (4) signature — EIP-191 over the exact claim message; no keys shared.
  const recovered = verifyMessage(claimMessage(label, cfg.parentName), req.signature);
  if (recovered.toLowerCase() !== req.wallet.toLowerCase()) {
    return sendJson(ctx.res, 401, {
      error: 'SIGNATURE_MISMATCH',
      message: `signature recovered ${recovered}, expected ${req.wallet}`,
    });
  }

  // (5) issue — the parent-owner wallet does the writes.
  let result;
  try {
    result = await deps.issuer.issue({
      label,
      owner: req.wallet,
      records: {
        profileUrl: req.profileUrl,
        avatar: req.avatarUrl,
        hederaAccount: req.hederaPayoutAccount,
        agentUrl: req.agentUrl,
      },
    });
  } catch (err) {
    const message = (err as Error).message;
    if (message.startsWith('NAME_TAKEN')) {
      return sendJson(ctx.res, 409, { error: 'NAME_TAKEN', message });
    }
    // sanitized: the raw provider error can contain RPC URLs — never echo it
    log.error('issue failed', { label, error: message });
    return sendJson(ctx.res, 502, { error: 'CHAIN_ERROR', message: 'the issuing transaction failed; see server logs' });
  }

  // (6) HCS audit log — best effort, never fails an issued claim.
  const at = new Date(deps.now()).toISOString();
  const event: HcsEvent = {
    type: 'claim',
    at,
    name: result.name,
    label,
    parent: cfg.parentName,
    displayName: req.displayName ?? null,
    wallet: req.wallet,
    hederaPayoutAccount: req.hederaPayoutAccount,
    registryTxHash: result.registryTxHash,
    resolverTxHashes: result.resolverTxHashes,
    inviteTokenHash: hash,
    inviteSource: invite.invite.source,
    inviter: invite.invite.inviter ?? null,
  };
  let hcsTxId: string | null;
  try {
    hcsTxId = await deps.hcsSubmit(event);
  } catch (err) {
    log.warn('hcs submit failed — claim stands, audit id null', { error: (err as Error).message });
    hcsTxId = null;
  }

  // (7) persist + consume. Local bookkeeping is best-effort too: the chain and
  // the topic are the durable state.
  try {
    await appendClaimRecord(cfg, { ...event, hcsTxId });
    await markInviteUsed(cfg, { token: req.inviteToken, name: result.name, at });
  } catch (err) {
    log.warn('local claim bookkeeping failed', { error: (err as Error).message });
  }

  log.info('claim issued', { name: result.name, wallet: req.wallet, hcsTxId });
  return sendJson(ctx.res, 201, {
    name: result.name,
    node: result.node,
    txHash: result.registryTxHash,
    resolverTxHashes: result.resolverTxHashes,
    records: result.records,
    hcsTxId,
  });
}

async function appendClaimRecord(cfg: Config, event: Record<string, unknown>): Promise<void> {
  await mkdir(cfg.dataDir, { recursive: true });
  await appendFile(join(cfg.dataDir, CLAIMS_FILE), `${JSON.stringify(event)}\n`, 'utf8');
}

async function readRecentClaims(cfg: Config, n = 20): Promise<Record<string, unknown>[]> {
  let raw: string;
  try {
    raw = await readFile(join(cfg.dataDir, CLAIMS_FILE), 'utf8');
  } catch {
    return [];
  }
  const lines = raw.split('\n').filter((l) => l.trim());
  return lines.slice(-n).reverse().map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** Start when run directly (`npm start`), not when imported by tests. */
export function startIfMain(): void {
  if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const cfg = loadConfig();
    const { server } = createApp(cfg);
    server.listen(cfg.port, () => {
      log.info('ens claim api listening', { port: cfg.port, mode: cfg.mode, parent: cfg.parentName ?? null });
    });
  }
}

startIfMain();
