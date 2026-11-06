/**
 * Hedera Consensus Service — the claim audit log.
 *
 * Every claim (and every invite announcement) is appended to one HCS topic:
 * public, timestamped by consensus, tamper-evident. Same topic family and the
 * same best-effort rule as payments/: an unhappy audit topic must never fail a
 * claim that has already been issued, so a submission failure is logged and
 * reported as a `null` id rather than thrown at the artist.
 *
 * | Mode | `submitToHcs` returns |
 * |---|---|
 * | `dev`  | `hcs-mock-<sha256 prefix>` — stable synthetic id, clearly synthetic |
 * | `live` | the real topic message id, `"<txId>@<status>"` |
 *
 * The same module also **reads** the topic back through the mirror node: invite
 * tokens are announced there by the steward, so claim validation (see
 * invites.ts) treats the topic itself as the source of truth in live mode.
 */
import { createHash } from 'node:crypto';
import type { Config } from './config.ts';

export type HcsEvent = Record<string, unknown> & { type: string };

/** Stable, clearly-synthetic id for dev mode, derived from the event payload. */
export function mockHcsId(event: HcsEvent): string {
  return `hcs-mock-${createHash('sha256').update(JSON.stringify(event)).digest('hex').slice(0, 16)}`;
}

/** Short hash of an invite token — logged instead of the raw one-time secret. */
export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

/**
 * Append one event to the claim topic.
 *
 * @returns a topic message id, or `null` when the audit write failed. Never
 *          throws in dev mode; in live mode it throws only when the caller did
 *          not configure Hedera at all (a config bug, not a transient failure).
 */
export async function submitToHcs(cfg: Config, event: HcsEvent): Promise<string | null> {
  if (cfg.mode === 'dev' || !cfg.hcsClaimTopicId) {
    return mockHcsId(event);
  }
  if (!cfg.hcsAccountId || !cfg.hcsPrivateKey) {
    throw new Error('HCS_ACCOUNT_ID and HCS_PRIVATE_KEY are required to submit to the claim topic');
  }

  // Dynamic import: dev mode must run with the Hedera SDK absent (same rule as payments/).
  const { Client, PrivateKey, TopicMessageSubmitTransaction } = await import('@hiero-ledger/sdk');

  // `Client.forName` wants `testnet`/`mainnet`, not the CAIP-2 `hedera:testnet`.
  const client = Client.forName(cfg.hederaNetwork.replace('hedera:', '')) as never as {
    setOperator(id: string, key: unknown): unknown;
  };
  client.setOperator(cfg.hcsAccountId, PrivateKey.fromStringECDSA(cfg.hcsPrivateKey));

  const resp = await new TopicMessageSubmitTransaction()
    .setTopicId(cfg.hcsClaimTopicId)
    .setMessage(JSON.stringify(event))
    .execute(client as never);
  const receipt = await resp.getReceipt(client as never);
  return `${resp.transactionId.toString()}@${receipt.status.toString()}`;
}

/** One decoded message from the mirror node, JSON-parsed. Unparsable ones are skipped. */
export interface TopicMessage {
  /** consensus timestamp, e.g. `1730000000.123456789` */
  consensusTimestamp: string;
  sequenceNumber: number;
  message: HcsEvent;
}

/**
 * Read the whole topic through the mirror node REST API, oldest-first, following
 * pagination. Messages that are not JSON (or not objects) are skipped — the
 * topic may legitimately carry unrelated traffic.
 */
export async function fetchTopicMessages(
  cfg: Config,
  fetchImpl: typeof fetch = fetch,
): Promise<TopicMessage[]> {
  if (!cfg.hcsClaimTopicId) return [];
  const out: TopicMessage[] = [];
  let url: string | undefined =
    `${cfg.mirrorNodeUrl}/api/v1/topics/${cfg.hcsClaimTopicId}/messages?limit=100`;
  while (url) {
    const resp = await fetchImpl(url);
    if (!resp.ok) throw new Error(`mirror node returned ${resp.status} for ${url}`);
    const page = (await resp.json()) as {
      messages?: { consensus_timestamp: string; sequence_number: number; message: string }[];
      links?: { next?: string | null };
    };
    for (const m of page.messages ?? []) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.from(m.message, 'base64').toString('utf8'));
      } catch {
        continue; // not our JSON — skip, do not fail the read
      }
      if (parsed && typeof parsed === 'object' && 'type' in parsed) {
        out.push({
          consensusTimestamp: m.consensus_timestamp,
          sequenceNumber: m.sequence_number,
          message: parsed as HcsEvent,
        });
      }
    }
    const next = page.links?.next;
    // the mirror node returns a relative path in links.next
    url = next ? new URL(next, cfg.mirrorNodeUrl).toString() : undefined;
  }
  return out;
}
