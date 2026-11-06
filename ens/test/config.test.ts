/**
 * Config validation. Runs against explicit env vars (not the developer's .env):
 * the process cwd is moved to a fresh temp dir at load, so a local ens/.env can
 * never leak into these results.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_REGISTRY_ADDRESS, isValidName, loadConfig, requireIssueConfig } from '../src/config.ts';

process.chdir(mkdtempSync(join(tmpdir(), 'ens-config-test-')));

/** Set env vars for one test, restore whatever was there afterwards. */
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    saved.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('config: defaults boot with zero credentials', () => {
  withEnv({ ENS_MODE: undefined, PORT: undefined, ENS_REGISTRY_ADDRESS: undefined, MIRROR_NODE_URL: undefined, INVITE_TOKENS: undefined, ENS_DATA_DIR: undefined }, () => {
    const cfg = loadConfig();
    assert.equal(cfg.mode, 'dev');
    assert.equal(cfg.port, 8404);
    assert.equal(cfg.registryAddress, DEFAULT_REGISTRY_ADDRESS);
    assert.equal(cfg.mirrorNodeUrl, 'https://testnet.mirrornode.hedera.com');
    assert.deepEqual(cfg.inviteTokens, []);
    assert.equal(cfg.parentName, undefined);
  });
});

test('config: a bad mode is rejected, not defaulted', () => {
  withEnv({ ENS_MODE: 'prod' }, () => {
    assert.throws(() => loadConfig(), /ENS_MODE/);
  });
});

test('config: contract addresses must be addresses', () => {
  withEnv({ ENS_REGISTRY_ADDRESS: 'not-an-address' }, () => {
    assert.throws(() => loadConfig(), /ENS_REGISTRY_ADDRESS/);
  });
  withEnv({ ENS_RESOLVER_ADDRESS: '0x123' }, () => {
    assert.throws(() => loadConfig(), /ENS_RESOLVER_ADDRESS/);
  });
});

test('config: the parent name is validated — it is never invented', () => {
  withEnv({ ENS_PARENT_NAME: 'not a name' }, () => {
    assert.throws(() => loadConfig(), /ENS_PARENT_NAME/);
  });
  withEnv({ ENS_PARENT_NAME: 'OSO.ETH' }, () => {
    // structural check passes (isValidName lowercases); issuing lowercases too
    assert.equal(loadConfig().parentName, 'OSO.ETH');
  });
});

test('config: HCS topic ids must look like 0.0.123', () => {
  withEnv({ HCS_CLAIM_TOPIC_ID: '999' }, () => {
    assert.throws(() => loadConfig(), /HCS_CLAIM_TOPIC_ID/);
  });
});

test('config: INVITE_TOKENS parse with whitespace and empties', () => {
  withEnv({ INVITE_TOKENS: ' a , b ,, c ' }, () => {
    assert.deepEqual(loadConfig().inviteTokens, ['a', 'b', 'c']);
  });
});

test('config: requireIssueConfig names every missing piece', () => {
  withEnv({ ENS_RPC_URL: undefined, ENS_PARENT_NAME: undefined, ENS_PARENT_OWNER_KEY: undefined, ENS_RESOLVER_ADDRESS: undefined }, () => {
    const cfg = loadConfig();
    assert.throws(
      () => requireIssueConfig(cfg),
      (err: Error) =>
        err.message.includes('ENS_RPC_URL') &&
        err.message.includes('ENS_PARENT_NAME') &&
        err.message.includes('ENS_PARENT_OWNER_KEY') &&
        err.message.includes('ENS_RESOLVER_ADDRESS'),
    );
  });
});

test('config: requireIssueConfig passes once the operator configures issuing', () => {
  withEnv({ ENS_RPC_URL: 'https://sepolia.example', ENS_PARENT_NAME: 'oso.eth', ENS_PARENT_OWNER_KEY: '0x11', ENS_RESOLVER_ADDRESS: '0x2222222222222222222222222222222222222222' }, () => {
    const c = requireIssueConfig(loadConfig());
    assert.equal(c.parentName, 'oso.eth');
    assert.equal(c.rpcUrl, 'https://sepolia.example');
  });
});

test('config: isValidName structural check', () => {
  assert.equal(isValidName('oso.eth'), true);
  assert.equal(isValidName('a.b.eth'), true);
  assert.equal(isValidName('eth'), false);
  assert.equal(isValidName('oso .eth'), false);
  assert.equal(isValidName('-oso.eth'), false);
  assert.equal(isValidName('oso-.eth'), false);
});
