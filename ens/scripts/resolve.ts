/**
 * Read-only resolution check — the demo screen's proof.
 *
 *   node scripts/resolve.ts --name shaka.oso.eth
 *
 * Needs only ENS_RPC_URL (no key): registry owner, resolver address, `addr`
 * and every text record the project writes. A fresh name shows
 * `"owner": null` — that is the before-picture for the demo video.
 */
import { loadConfig } from '../src/config.ts';
import { readName } from '../src/registry.ts';

async function main(): Promise<void> {
  const i = process.argv.indexOf('--name');
  const name = i === -1 ? undefined : process.argv[i + 1];
  if (!name) {
    console.error('usage: node scripts/resolve.ts --name <label>.<parent>');
    process.exitCode = 1;
    return;
  }
  const cfg = loadConfig();
  const result = await readName(cfg, name);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
