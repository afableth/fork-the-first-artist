/**
 * Invite validation — how the claim flow knows an artist was actually invited.
 *
 * Two sources, checked in this order:
 *
 * 1. **Env allowlist** (`INVITE_TOKENS`, comma-separated). Always checked; this
 *    is the whole source in dev mode. In live mode it stays usable as an
 *    operator override, because a token seeded there is just as one-time.
 * 2. **The HCS topic** (live mode). The steward announces a token to the claim
 *    topic (`type: 'invite'`); the claim API reads the topic back through the
 *    mirror node and treats it as the source of truth — same tamper-evident
 *    log that later receives the claim itself.
 *
 * One-time semantics: a token is consumed by
 *  - the local `used-invites.jsonl` (fast path, works in dev), and
 *  - any `type: 'claim'` event on the topic carrying the token's hash
 *    (authoritative in live mode, so even a wiped local state cannot re-issue).
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from './config.ts';
import { fetchTopicMessages, tokenHash } from './hcs.ts';

export interface Invite {
  token: string;
  /** who vouched — from the steward's announcement */
  inviter?: string;
  artistName?: string;
  issuedAt?: string;
  expiresAt?: string;
  /** where the token was found */
  source: 'allowlist' | 'topic';
}

export type InviteError =
  | 'INVITE_UNKNOWN'
  | 'INVITE_EXPIRED'
  | 'INVITE_REVOKED'
  | 'INVITE_USED';

export type InviteCheck = { ok: true; invite: Invite } | { ok: false; reason: InviteError };

function checkAllowlist(cfg: Config, token: string): InviteCheck {
  if (!cfg.inviteTokens.includes(token)) return { ok: false, reason: 'INVITE_UNKNOWN' };
  return { ok: true, invite: { token, source: 'allowlist' } };
}

/** Read the invite's lifecycle off the HCS topic. Live mode only. */
async function checkTopic(
  cfg: Config,
  fetchImpl: typeof fetch,
  token: string,
  now: number,
): Promise<InviteCheck> {
  const messages = await fetchTopicMessages(cfg, fetchImpl);
  const hash = tokenHash(token);
  const events = messages.map((m) => m.message);

  // A claim event carrying this token's hash means it was redeemed — even if
  // the local used-list was lost.
  if (events.some((e) => e.type === 'claim' && e.inviteTokenHash === hash)) {
    return { ok: false, reason: 'INVITE_USED' };
  }
  if (events.some((e) => e.type === 'invite-revoke' && e.token === token)) {
    return { ok: false, reason: 'INVITE_REVOKED' };
  }
  const announced = events.filter((e) => e.type === 'invite' && e.token === token);
  if (announced.length === 0) return { ok: false, reason: 'INVITE_UNKNOWN' };
  // last announcement wins (a re-announcement may extend the expiry)
  const latest = announced[announced.length - 1] as {
    token: string;
    inviter?: string;
    artistName?: string;
    issuedAt?: string;
    expiresAt?: string;
  };
  if (latest.expiresAt && Date.parse(latest.expiresAt) < now) {
    return { ok: false, reason: 'INVITE_EXPIRED' };
  }
  return {
    ok: true,
    invite: {
      token,
      inviter: latest.inviter,
      artistName: latest.artistName,
      issuedAt: latest.issuedAt,
      expiresAt: latest.expiresAt,
      source: 'topic',
    },
  };
}

/**
 * Full invite check. Allowlist first (both modes); in live mode fall through
 * to the topic. Dev mode never touches the network — the mock HCS ids are not
 * on any real topic, so a mirror query there would be meaningless.
 */
export async function validateInvite(
  cfg: Config,
  fetchImpl: typeof fetch,
  token: string,
  now = Date.now(),
): Promise<InviteCheck> {
  const local = checkAllowlist(cfg, token);
  if (local.ok || cfg.mode === 'dev') return local;
  return checkTopic(cfg, fetchImpl, token, now);
}

// ── local one-time bookkeeping ──────────────────────────────────────────────

const USED_FILE = 'used-invites.jsonl';

/** Has this token been redeemed locally? (fast path; the topic check is the backstop) */
export async function isInviteUsedLocally(cfg: Config, token: string): Promise<boolean> {
  const hash = tokenHash(token);
  let raw: string;
  try {
    raw = await readFile(join(cfg.dataDir, USED_FILE), 'utf8');
  } catch {
    return false; // no log yet — nothing used
  }
  return raw.split('\n').some((line) => {
    if (!line.trim()) return false;
    try {
      return (JSON.parse(line) as { tokenHash?: string }).tokenHash === hash;
    } catch {
      return false;
    }
  });
}

/** Append a redemption record. Only the token's **hash** is persisted. */
export async function markInviteUsed(
  cfg: Config,
  record: { token: string; name: string; at: string },
): Promise<void> {
  await mkdir(cfg.dataDir, { recursive: true });
  const line = JSON.stringify({
    at: record.at,
    tokenHash: tokenHash(record.token),
    name: record.name,
  });
  await appendFile(join(cfg.dataDir, USED_FILE), `${line}\n`, 'utf8');
}
