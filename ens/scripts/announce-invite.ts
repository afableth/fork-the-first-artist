/**
 * Steward-side invite announcement.
 *
 * Generates (or accepts) a one-time token and publishes it to the claim topic
 * so the claim API can validate it (see src/invites.ts). In dev mode there is
 * no real topic — the token is printed with instructions to add it to
 * INVITE_TOKENS instead.
 *
 *   node scripts/announce-invite.ts --inviter "Steward label" --artist shaka --ttl-hours 24
 *
 * The token is printed exactly once — it travels to the artist out of band
 * (Telegram / email / in person). Only its hash is ever logged.
 */
import { randomBytes } from 'node:crypto';
import { loadConfig } from '../src/config.ts';
import { submitToHcs } from '../src/hcs.ts';
import { claimMessage } from '../src/registry.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const inviter = arg('inviter');
  const artist = arg('artist');
  const ttlHours = Number(arg('ttl-hours') ?? '24');
  if (!inviter || !Number.isFinite(ttlHours) || ttlHours <= 0) {
    console.error('usage: node scripts/announce-invite.ts --inviter "<steward label>" [--artist <label>] [--ttl-hours 24]');
    process.exitCode = 1;
    return;
  }

  const token = arg('token') ?? randomBytes(16).toString('hex');
  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + ttlHours * 3600_000).toISOString();

  if (cfg.mode === 'dev' || !cfg.hcsClaimTopicId) {
    console.log('dev mode: no topic write. Add the token to INVITE_TOKENS in .env:');
    console.log(`  INVITE_TOKENS=${[...cfg.inviteTokens, token].join(',')}`);
  } else {
    const id = await submitToHcs(cfg, {
      type: 'invite',
      token,
      inviter,
      artistName: artist ?? null,
      issuedAt,
      expiresAt,
    });
    console.log(`announced to topic ${cfg.hcsClaimTopicId}: ${id}`);
  }

  console.log(`\none-time token (share out of band, never log it):\n  ${token}`);
  if (artist && cfg.parentName) {
    console.log(`\nartist should sign exactly:\n  "${claimMessage(artist, cfg.parentName)}"`);
  }
  console.log(`expires: ${expiresAt}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
