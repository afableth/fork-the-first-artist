/**
 * Invite validation: the allowlist path (dev), the HCS-topic path (live, against
 * a fake mirror node), and the local one-time bookkeeping. No network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../src/config.ts';
import { isInviteUsedLocally, markInviteUsed, validateInvite } from '../src/invites.ts';
import { tokenHash } from '../src/hcs.ts';

const TOPIC = '0.0.999';
const MIRROR = 'https://mirror.example';

function makeCfg(over: Partial<Config> = {}): Config {
  return {
    mode: 'live',
    port: 8404,
    rpcUrl: undefined,
    parentName: undefined,
    parentOwnerKey: undefined,
    registryAddress: '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e',
    resolverAddress: undefined,
    hederaNetwork: 'hedera:testnet',
    hcsClaimTopicId: TOPIC,
    hcsAccountId: undefined,
    hcsPrivateKey: undefined,
    mirrorNodeUrl: MIRROR,
    inviteTokens: [],
    dataDir: './data',
    ...over,
  };
}

/** A fake mirror-node response: mirror API shape, base64-encoded JSON messages. */
function pageOf(events: object[], next?: string): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      messages: events.map((e, i) => ({
        consensus_timestamp: `1730000000.${String(i).padStart(9, '0')}`,
        sequence_number: i,
        message: Buffer.from(JSON.stringify(e)).toString('base64'),
      })),
      links: { next: next ?? null },
    }),
  } as unknown as Response;
}

function makeFetch(pages: Map<string, Response>, calls: string[] = []): typeof fetch {
  const fn = async (url: RequestInfo | URL): Promise<Response> => {
    const u = String(url);
    calls.push(u);
    const page = pages.get(u);
    if (!page) throw new Error(`unexpected fetch: ${u}`);
    return page;
  };
  return fn as typeof fetch;
}

const firstUrl = `${MIRROR}/api/v1/topics/${TOPIC}/messages?limit=100`;
const FUTURE = new Date(Date.now() + 3600_000).toISOString();
const PAST = new Date(Date.now() - 3600_000).toISOString();

const inviteEvent = (token: string, over: object = {}) => ({ type: 'invite', token, inviter: 'Steward S', artistName: 'shaka', expiresAt: FUTURE, ...over });

// a fetch that must never be called — proves dev mode stays offline
const noNetwork: typeof fetch = (() => {
  throw new Error('network access is not allowed in dev mode');
}) as typeof fetch;

test('invites: dev mode uses the allowlist and never touches the network', async () => {
  const cfg = makeCfg({ mode: 'dev', inviteTokens: ['tok-1'] });
  const ok = await validateInvite(cfg, noNetwork, 'tok-1');
  assert.deepEqual(ok, { ok: true, invite: { token: 'tok-1', source: 'allowlist' } });
  const miss = await validateInvite(cfg, noNetwork, 'tok-other');
  assert.deepEqual(miss, { ok: false, reason: 'INVITE_UNKNOWN' });
});

test('invites: live mode reads the announcement from the topic', async () => {
  const cfg = makeCfg();
  const calls: string[] = [];
  const fetch = makeFetch(new Map([[firstUrl, pageOf([inviteEvent('tok-topic')])]]), calls);
  const check = await validateInvite(cfg, fetch, 'tok-topic');
  assert.equal(check.ok, true);
  assert.equal((check as { ok: true; invite: { source: string; inviter?: string } }).invite.source, 'topic');
  assert.equal((check as { ok: true; invite: { inviter?: string } }).invite.inviter, 'Steward S');
  assert.equal(calls.length, 1);
});

test('invites: expired, revoked, used and unknown tokens are all rejected', async () => {
  const cfg = makeCfg();
  const events = [
    inviteEvent('tok-expired', { expiresAt: PAST }),
    { type: 'invite-revoke', token: 'tok-revoked' },
    { type: 'claim', inviteTokenHash: tokenHash('tok-used') },
  ];
  const fetch = makeFetch(new Map([[firstUrl, pageOf(events)]]));
  for (const [token, reason] of [
    ['tok-expired', 'INVITE_EXPIRED'],
    ['tok-revoked', 'INVITE_REVOKED'],
    ['tok-used', 'INVITE_USED'],
    ['tok-never', 'INVITE_UNKNOWN'],
  ] as const) {
    const check = await validateInvite(cfg, fetch, token);
    assert.deepEqual(check, { ok: false, reason }, token);
  }
});

test('invites: pagination is followed until the invite is found', async () => {
  const cfg = makeCfg();
  const secondUrl = `${MIRROR}/api/v1/topics/${TOPIC}/messages?limit=100&page=2`;
  const calls: string[] = [];
  const fetch = makeFetch(
    new Map([
      [firstUrl, pageOf([{ type: 'invite', token: 'someone-else' }], '/api/v1/topics/0.0.999/messages?limit=100&page=2')],
      [secondUrl, pageOf([inviteEvent('tok-page2')])],
    ]),
    calls,
  );
  const check = await validateInvite(cfg, fetch, 'tok-page2');
  assert.equal(check.ok, true);
  assert.equal(calls.length, 2);
});

test('invites: non-JSON topic traffic is skipped, not fatal', async () => {
  const cfg = makeCfg();
  const junk = {
    consensus_timestamp: '1730000000.000000000',
    sequence_number: 0,
    message: Buffer.from('some other project announced this here').toString('base64'),
  };
  const page = {
    ok: true,
    status: 200,
    json: async () => ({ messages: [junk, ...[]], links: { next: null } }),
  } as unknown as Response;
  const page2 = pageOf([inviteEvent('tok-junk')]);
  const fetch = makeFetch(new Map([[firstUrl, page], [`${firstUrl}&page=2`, page2]]));
  // hmm — junk alone yields no messages; add the invite after a junk page via next
  const pageWithJunkAndNext = {
    ok: true,
    status: 200,
    json: async () => ({
      messages: [junk],
      links: { next: '/api/v1/topics/0.0.999/messages?limit=100&page=2' },
    }),
  } as unknown as Response;
  void page;
  const fetch2 = makeFetch(new Map([[firstUrl, pageWithJunkAndNext], [`${firstUrl}&page=2`, page2]]));
  const check = await validateInvite(cfg, fetch2, 'tok-junk');
  assert.equal(check.ok, true);
  void fetch;
});

test('invites: the allowlist works in live mode too (operator override)', async () => {
  const cfg = makeCfg({ inviteTokens: ['tok-override'] });
  const check = await validateInvite(cfg, noNetwork, 'tok-override');
  assert.deepEqual(check, { ok: true, invite: { token: 'tok-override', source: 'allowlist' } });
});

test('invites: re-announcement — the latest expiry wins', async () => {
  const cfg = makeCfg();
  const fetch = makeFetch(
    new Map([[firstUrl, pageOf([inviteEvent('tok-renewed', { expiresAt: PAST }), inviteEvent('tok-renewed', { expiresAt: FUTURE })])]]),
  );
  assert.equal((await validateInvite(cfg, fetch, 'tok-renewed')).ok, true);
});

test('invites: local one-time bookkeeping stores only the hash', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ens-invites-'));
  try {
    const cfg = makeCfg({ dataDir: dir });
    assert.equal(await isInviteUsedLocally(cfg, 'tok-1'), false);
    await markInviteUsed(cfg, { token: 'tok-1', name: 'shaka.oso.eth', at: new Date().toISOString() });
    assert.equal(await isInviteUsedLocally(cfg, 'tok-1'), true);
    assert.equal(await isInviteUsedLocally(cfg, 'tok-2'), false);
    const raw = await readFile(join(dir, 'used-invites.jsonl'), 'utf8');
    assert.equal(raw.includes('tok-1'), false, 'raw token must never hit the disk');
    assert.equal(raw.includes(tokenHash('tok-1')), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
