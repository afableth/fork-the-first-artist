/**
 * Direct issuing for rehearsals — the claim API does this too, but the demo
 * needs a path that does not depend on the frontend being up (ens/PLAN.md §2:
 * "issue.ts — issue a subname + set records (core)").
 *
 *   node scripts/issue.ts --label shaka --wallet 0x… \
 *     --hedera 0.0.12345 --url https://… --avatar https://… --agent https://…
 *
 * Requires ENS_RPC_URL, ENS_PARENT_NAME, ENS_PARENT_OWNER_KEY,
 * ENS_RESOLVER_ADDRESS (see .env.example). Writes no HCS event — the audit log
 * entry belongs to the claim flow; manual rehearsal issues stay off the topic.
 */
import { isAddress } from 'ethers';
import { loadConfig } from '../src/config.ts';
import { createChainIssuer } from '../src/registry.ts';

interface Args {
  [key: string]: string | undefined;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i]?.startsWith('--')) {
      args[argv[i]!.slice(2)] = argv[i + 1];
      i++;
    }
  }
  return args;
}

const USAGE = `usage: node scripts/issue.ts --label <label> --wallet <0x…>
  [--hedera 0.0.123] [--url <profile-url>] [--avatar <image-url>]
  [--agent <agent-url>] [--claim-tx <hcs-tx-id>]

required env: ENS_RPC_URL, ENS_PARENT_NAME, ENS_PARENT_OWNER_KEY, ENS_RESOLVER_ADDRESS`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.label || !args.wallet) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  if (!isAddress(args.wallet)) {
    console.error(`--wallet is not an address: ${args.wallet}`);
    process.exitCode = 1;
    return;
  }

  const cfg = loadConfig();
  const issuer = createChainIssuer(cfg); // throws a setup-naming error if incomplete
  const result = await issuer.issue({
    label: args.label,
    owner: args.wallet,
    records: {
      hederaAccount: args.hedera,
      profileUrl: args.url,
      avatar: args.avatar,
      agentUrl: args.agent,
      claimTx: args['claim-tx'],
    },
  });

  console.log(JSON.stringify(result, null, 2));
  if (result.registryTxHash) {
    console.error(`\nissued ${result.name} — verify resolution: npm run resolve -- --name ${result.name}`);
  } else {
    console.error(`\n${result.name} already owned by ${result.owner}; records refreshed (repair path)`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
