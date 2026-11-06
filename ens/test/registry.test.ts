/**
 * Pure name/record helpers — the math and the exact signature message. No
 * network: the chain-backed issuer is exercised through the claim API tests
 * with a fake, and on Sepolia by an operator (never in CI).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { concat, id, keccak256, namehash } from 'ethers';
import { claimMessage, labelHash, normalizeLabel, recordTuples, TEXT_KEYS } from '../src/registry.ts';

test('registry: label normalization', () => {
  assert.equal(normalizeLabel('Shaka '), 'shaka');
  assert.equal(normalizeLabel('ARTIST-2'), 'artist-2');
  for (const bad of ['', '  ', '-sh', 'sh-', 'has space', 'a'.repeat(64), 'Shaka!']) {
    assert.throws(() => normalizeLabel(bad), /INVALID_LABEL/, `expected rejection of ${JSON.stringify(bad)}`);
  }
});

test('registry: labelhash is keccak of the normalized label', () => {
  assert.equal(labelHash('shaka'), id('shaka'));
  assert.equal(labelHash('Shaka'), id('shaka')); // case-insensitive, like the registry expects
  assert.notEqual(labelHash('shaka'), labelHash('shaka2'));
});

test('registry: namehash composition matches ENS', () => {
  // the well-known hash of the `eth` node
  assert.equal(namehash('eth'), '0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae');
  // a two-label parent composes from the eth node
  assert.equal(namehash('oso.eth'), keccak256(concat([namehash('eth'), id('oso')])));
  // and a subname composes from the parent — the node the claim API writes under
  assert.equal(namehash('shaka.oso.eth'), keccak256(concat([namehash('oso.eth'), id('shaka')])));
});

test('registry: the claim message is exact and normalization-proof', () => {
  assert.equal(claimMessage('shaka', 'oso.eth'), 'I am shaka, claiming shaka.oso.eth');
  assert.equal(claimMessage('Shaka ', 'OSO.ETH'), 'I am shaka, claiming shaka.oso.eth');
});

test('registry: records are written in TEXT_KEYS order, empties skipped', () => {
  const tuples = recordTuples({
    agentUrl: 'https://agent.example',
    hederaAccount: '0.0.12345',
    profileUrl: 'https://profile.example',
  });
  assert.deepEqual(
    tuples.map((t) => t.key),
    [TEXT_KEYS.profileUrl, TEXT_KEYS.hederaAccount, TEXT_KEYS.agentUrl],
  );
  assert.deepEqual(recordTuples({ avatar: '   ' }), []); // whitespace-only counts as unset
  assert.deepEqual(recordTuples(undefined), []);
});
