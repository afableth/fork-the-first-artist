/**
 * The claim flow end-to-end, in-process: real HTTP server on an ephemeral
 * loopback port, fake issuer + fake HCS + fake mirror fetch. This is the
 * offline proof of ens/PLAN.md §3; the chain side is exercised separately on
 * Sepolia by an operator (see scripts/ and README — never in CI).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet } from 'ethers';
import { createApp, type ClaimDeps } from '../src/claim-api.ts';
import { claimMessage, type IssueInput, type IssueResult, type Issuer } from '../src/registry.ts';
import { tokenHash, type HcsEvent } from '../src/hcs.ts';
import { DEFAULT_REGISTRY_ADDRESS, type Config } from '../src/config.ts';

// ── fixtures ────────────────────────────────────────────────────────────────

const WALLET = Wallet.createRandom();
const OTHER_WALLET = Wallet.createRandom();

class FakeIssuer implements Issuer {
  readonly parentName = 'oso.eth';
  issued: IssueInput[] = [];

  async issue(input: IssueInput): Promise<IssueResult> {
    this.issued.push(input);
    if (input.label === 'taken') throw new Error('NAME_TAKEN: shaka.oso.eth is already owned by 0x00000000000000000000000000000000000dead1');
    if (input.label === 'boom') throw new Error('provider blew up http://secret-rpc-url/endpoint');
    return {
      name: `${input.label}.oso.eth`,
      node: '0x' + 'ab'.repeat(32),
      owner: input.owner,
      registryTxHash: '0xregistry-tx',
      resolverTxHashes: ['0xresolver-tx-1', '0xresolver-tx-2'],
      records: [{ key: 'com.hedera.account', value: '0.0.12345' }],
    };
  }
}

function makeCfg(over: Partial<Config> = {}): Config {
  return {
    mode: 'dev',
    port: 0,
    rpcUrl: 'https://sepolia.example',
    parentName: 'oso.eth',
    parentOwnerKey: '0x' + '11'.repeat(32),
    registryAddress: DEFAULT_REGISTRY_ADDRESS,
    resolverAddress: '0x' + '22'.repeat(20),
    hederaNetwork: 'hedera:testnet',
    hcsClaimTopicId: undefined,
    hcsAccountId: undefined,
    hcsPrivateKey: undefined,
    mirrorNodeUrl: 'https://mirror.example',
    inviteTokens: ['tok-1', 'tok-2'],
    dataDir: './data',
    ...over,
  };
}

const SIGNATURE = WALLET.signMessageSync(claimMessage('shaka', 'oso.eth'));
const SIGNATURE_TAKEN = WALLET.signMessageSync(claimMessage('taken', 'oso.eth'));
const SIGNATURE_BOOM = WALLET.signMessageSync(claimMessage('boom', 'oso.eth'));

function claimBody(over: Record<string, unknown> = {}, signature: string = SIGNATURE): Record<string, unknown> {
  return {
    artistName: 'shaka',
    wallet: WALLET.address,
    hederaPayoutAccount: '0.0.12345',
    signature: SIGNATURE,
    inviteToken: 'tok-1',
    profileUrl: 'https://profile.example/shaka',
    avatarUrl: 'https://profile.example/shaka.png',
    agentUrl: 'https://agent.example/shaka',
    ...over,
  };
}

/** Start the app on an ephemeral loopback port, run fn(base, app), stop it. */
async function withServer(
  cfg: Config,
  deps: ClaimDeps,
  fn: (base: string, app: ReturnType<typeof createApp>) => Promise<void>,
): Promise<void> {
  const app = createApp(cfg, deps);
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  assert(address && typeof address === 'object');
  try {
    await fn(`http://127.0.0.1:${address.port}`, app);
  } finally {
    app.server.close();
  }
}

async function post(base: string, body: unknown, path = '/api/claim'): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ── tests ───────────────────────────────────────────────────────────────────

test('claim: a valid claim issues the name, sets records, logs to HCS and consumes the invite', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ens-claim-'));
  const issuer = new FakeIssuer();
  const hcsEvents: HcsEvent[] = [];
  const cfg = makeCfg({ dataDir: dir });
  try {
    await withServer(cfg, { issuer, hcs: async (e) => (hcsEvents.push(e), `hcs-test-${hcsEvents.length}`) }, async (base) => {
      const resp = await post(base, claimBody());
      assert.equal(resp.status, 201);
      const body = (await resp.json()) as {
        name: string; txHash: string; resolverTxHashes: string[]; records: { key: string; value: string }[]; hcsTxId: string;
      };
      assert.equal(body.name, 'shaka.oso.eth');
      assert.equal(body.txHash, '0xregistry-tx');
      assert.equal(body.resolverTxHashes.length, 2);
      assert.equal(body.hcsTxId, 'hcs-test-1');
      assert.deepEqual(body.records, [{ key: 'com.hedera.account', value: '0.0.12345' }]);

      // the artist owns the name — not the parent owner
      assert.deepEqual(issuer.issued, [{ label: 'shaka', owner: WALLET.address, records: {
        profileUrl: 'https://profile.example/shaka',
        avatar: 'https://profile.example/shaka.png',
        hederaAccount: '0.0.12345',
        agentUrl: 'https://agent.example/shaka',
      } }]);

      // the HCS audit event binds everything the plan asks for
      assert.equal(hcsEvents[0]!.type, 'claim');
      assert.equal(hcsEvents[0]!.name, 'shaka.oso.eth');
      assert.equal(hcsEvents[0]!.wallet, WALLET.address);
      assert.equal(hcsEvents[0]!.hederaPayoutAccount, '0.0.12345');
      assert.equal(hcsEvents[0]!.inviteTokenHash, tokenHash('tok-1'));
      assert.equal(hcsEvents[0]!.inviteSource, 'allowlist');

      // local bookkeeping: claim logged, invite consumed by hash only
      const claims = await readFile(join(dir, 'claims.jsonl'), 'utf8');
      assert.equal(claims.includes('shaka.oso.eth'), true);
      const used = await readFile(join(dir, 'used-invites.jsonl'), 'utf8');
      assert.equal(used.includes('tok-1'), false, 'raw token must never hit the disk');
      assert.equal(used.includes(tokenHash('tok-1')), true);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('claim: missing fields are rejected with the exact list', async () => {
  await withServer(makeCfg(), {}, async (base) => {
    const resp = await post(base, { artistName: 'shaka' });
    assert.equal(resp.status, 400);
    const body = (await resp.json()) as { error: string; fields: string[] };
    assert.equal(body.error, 'MISSING_FIELDS');
    assert.deepEqual(body.fields, ['wallet', 'hederaPayoutAccount', 'signature', 'inviteToken']);
  });
});

test('claim: invalid label, wallet or hedera account are rejected before anything burns', async () => {
  const issuer = new FakeIssuer();
  await withServer(makeCfg(), { issuer }, async (base) => {
    for (const [over, error] of [
      [{ artistName: 'Shaka!' }, 'INVALID_LABEL'],
      [{ wallet: 'not-an-address' }, 'INVALID_WALLET'],
      [{ hederaPayoutAccount: '0.0.abc' }, 'INVALID_HEDERA_ACCOUNT'],
    ] as const) {
      const resp = await post(base, claimBody(over));
      assert.equal(resp.status, 400, JSON.stringify(over));
      assert.equal(((await resp.json()) as { error: string }).error, error);
    }
    assert.equal(issuer.issued.length, 0);
  });
});

test('claim: a wrong signature is a 401 and does not burn the invite', async () => {
  const issuer = new FakeIssuer();
  await withServer(makeCfg(), { issuer }, async (base) => {
    // someone else's key signs the same message
    const resp = await post(base, claimBody({ signature: OTHER_WALLET.signMessageSync(claimMessage('shaka', 'oso.eth')) }));
    assert.equal(resp.status, 401);
    assert.equal(((await resp.json()) as { error: string }).error, 'SIGNATURE_MISMATCH');

    // and a signature over a different name is equally worthless
    const resp2 = await post(base, claimBody({ signature: WALLET.signMessageSync(claimMessage('other', 'oso.eth')) }));
    assert.equal(resp2.status, 401);

    // the invite is still usable afterwards
    const ok = await post(base, claimBody());
    assert.equal(ok.status, 201);
    assert.equal(issuer.issued.length, 1);
  });
});

test('claim: an invite token is one-time', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ens-once-'));
  const issuer = new FakeIssuer();
  try {
    await withServer(makeCfg({ dataDir: dir }), { issuer }, async (base) => {
      assert.equal((await post(base, claimBody())).status, 201);
      const again = await post(base, claimBody({ inviteToken: 'tok-2' })); // still fine…
      assert.equal(again.status, 201);
      const third = await post(base, claimBody()); // …but tok-1 is spent
      assert.equal(third.status, 409);
      assert.equal(((await third.json()) as { error: string }).error, 'INVITE_USED');
      assert.equal(issuer.issued.length, 2);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('claim: an unknown invite is a 403', async () => {
  await withServer(makeCfg(), {}, async (base) => {
    const resp = await post(base, claimBody({ inviteToken: 'tok-never-issued' }));
    assert.equal(resp.status, 403);
    assert.equal(((await resp.json()) as { error: string }).error, 'INVITE_UNKNOWN');
  });
});

test('claim: a taken name is a 409 and does not consume the invite', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ens-taken-'));
  const issuer = new FakeIssuer();
  try {
    await withServer(makeCfg({ dataDir: dir }), { issuer }, async (base) => {
      const resp = await post(base, claimBody({ artistName: 'taken', inviteToken: 'tok-taken' }, SIGNATURE_TAKEN));
      assert.equal(resp.status, 409);
      assert.equal(((await resp.json()) as { error: string }).error, 'NAME_TAKEN');
      // tok-taken survives the failed attempt
      const ok = await post(base, claimBody({ inviteToken: 'tok-taken' }));
      assert.equal(ok.status, 201);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('claim: chain errors are sanitized — no provider message leaks to the client', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ens-chain-'));
  const issuer = new FakeIssuer();
  try {
    await withServer(makeCfg({ dataDir: dir }), { issuer }, async (base) => {
      const resp = await post(base, claimBody({ artistName: 'boom', inviteToken: 'tok-chain' }, SIGNATURE_BOOM));
      assert.equal(resp.status, 502);
      const body = (await resp.json()) as { error: string; message: string };
      assert.equal(body.error, 'CHAIN_ERROR');
      assert.equal(body.message.includes('secret-rpc-url'), false);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('claim: an HCS failure never fails an issued claim', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ens-hcs-'));
  const issuer = new FakeIssuer();
  try {
    await withServer(makeCfg({ dataDir: dir }), { issuer, hcs: async () => { throw new Error('mirror down'); } }, async (base) => {
      const resp = await post(base, claimBody({ inviteToken: 'tok-hcs' }));
      assert.equal(resp.status, 201);
      const body = (await resp.json()) as { hcsTxId: string | null };
      assert.equal(body.hcsTxId, null);
      assert.equal(issuer.issued.length, 1);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('claim: dev mode returns a synthetic HCS id when no submitter is injected', async () => {
  const issuer = new FakeIssuer();
  const dir = await mkdtemp(join(tmpdir(), 'ens-mock-'));
  try {
    await withServer(makeCfg({ dataDir: dir, mode: 'dev' }), { issuer }, async (base) => {
      const resp = await post(base, claimBody({ inviteToken: 'tok-2' }));
      assert.equal(resp.status, 201);
      const body = (await resp.json()) as { hcsTxId: string };
      assert.match(body.hcsTxId, /^hcs-mock-/);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('claim: live mode validates invites from the topic through the mirror node', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ens-live-'));
  const issuer = new FakeIssuer();
  const hcsEvents: HcsEvent[] = [];
  const cfg = makeCfg({ mode: 'live', inviteTokens: [], hcsClaimTopicId: '0.0.999', dataDir: dir });
  const mirrorUrl = `${cfg.mirrorNodeUrl}/api/v1/topics/0.0.999/messages?limit=100`;
  const inviteEvent = { type: 'invite', token: 'tok-topic', inviter: 'Steward S', expiresAt: new Date(Date.now() + 3600_000).toISOString() };
  const page = {
    ok: true,
    status: 200,
    json: async () => ({
      messages: [{ consensus_timestamp: '1730000000.0', sequence_number: 1, message: Buffer.from(JSON.stringify(inviteEvent)).toString('base64') }],
      links: { next: null },
    }),
  } as unknown as Response;
  const fetchImpl = (async (url: RequestInfo | URL) => {
    assert.equal(String(url), mirrorUrl);
    return page;
  }) as typeof fetch;
  try {
    await withServer(cfg, { issuer, hcs: async (e) => (hcsEvents.push(e), 'hcs-live-1'), fetchImpl }, async (base) => {
      const resp = await post(base, claimBody({ inviteToken: 'tok-topic' }));
      assert.equal(resp.status, 201);
      assert.equal(hcsEvents[0]!.inviteSource, 'topic');
      assert.equal(hcsEvents[0]!.inviter, 'Steward S');
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('claim: an expired topic invite is a 410', async () => {
  const issuer = new FakeIssuer();
  const cfg = makeCfg({ mode: 'live', inviteTokens: [], hcsClaimTopicId: '0.0.999' });
  const inviteEvent = { type: 'invite', token: 'tok-old', expiresAt: new Date(Date.now() - 3600_000).toISOString() };
  const page = {
    ok: true,
    status: 200,
    json: async () => ({
      messages: [{ consensus_timestamp: '1730000000.0', sequence_number: 1, message: Buffer.from(JSON.stringify(inviteEvent)).toString('base64') }],
      links: { next: null },
    }),
  } as unknown as Response;
  const fetchImpl = (async () => page) as typeof fetch;
  await withServer(cfg, { issuer, fetchImpl }, async (base) => {
    const resp = await post(base, claimBody({ inviteToken: 'tok-old' }));
    assert.equal(resp.status, 410);
    assert.equal(((await resp.json()) as { error: string }).error, 'INVITE_EXPIRED');
  });
});

test('claim: a topic claim event consumes the token even without local state', async () => {
  const issuer = new FakeIssuer();
  const cfg = makeCfg({ mode: 'live', inviteTokens: [], hcsClaimTopicId: '0.0.999' });
  const events = [
    { type: 'invite', token: 'tok-spent', expiresAt: new Date(Date.now() + 3600_000).toISOString() },
    { type: 'claim', inviteTokenHash: tokenHash('tok-spent') },
  ];
  const page = {
    ok: true,
    status: 200,
    json: async () => ({
      messages: events.map((e, i) => ({
        consensus_timestamp: `1730000000.${i}`,
        sequence_number: i,
        message: Buffer.from(JSON.stringify(e)).toString('base64'),
      })),
      links: { next: null },
    }),
  } as unknown as Response;
  const fetchImpl = (async () => page) as typeof fetch;
  await withServer(cfg, { issuer, fetchImpl }, async (base) => {
    const resp = await post(base, claimBody({ inviteToken: 'tok-spent' }));
    assert.equal(resp.status, 409);
    assert.equal(((await resp.json()) as { error: string }).error, 'INVITE_USED');
    assert.equal(issuer.issued.length, 0);
  });
});

test('claim: an unconfigured stack is a 503 that names the missing env vars', async () => {
  const issuer = new FakeIssuer();
  await withServer(makeCfg({ parentName: undefined }), { issuer }, async (base) => {
    const resp = await post(base, claimBody());
    assert.equal(resp.status, 503);
    const body = (await resp.json()) as { error: string; message: string };
    assert.equal(body.error, 'NOT_CONFIGURED');
    assert.equal(body.message.includes('ENS_PARENT_NAME'), true);
    assert.equal(issuer.issued.length, 0);
  });
});

test('claim api: /health reports what is actually configured', async () => {
  await withServer(makeCfg(), {}, async (base) => {
    const resp = await fetch(`${base}/health`);
    assert.equal(resp.status, 200);
    const body = (await resp.json()) as { ok: boolean; mode: string; parentName: string | null; hcs: { topic: string | null } };
    assert.equal(body.ok, true);
    assert.equal(body.mode, 'dev');
    assert.equal(body.parentName, 'oso.eth');
    assert.equal(body.hcs.topic, null);
  });
});

test('claim api: unknown routes are a 404, OPTIONS is a bare 204', async () => {
  await withServer(makeCfg(), {}, async (base) => {
    assert.equal((await fetch(`${base}/nope`)).status, 404);
    const options = await fetch(`${base}/api/claim`, { method: 'OPTIONS' });
    assert.equal(options.status, 204);
    assert.equal(await options.text(), '');
  });
});
