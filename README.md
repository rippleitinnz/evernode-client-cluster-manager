# evernode-client-cluster-manager

Drop-in npm module that adds all 10 cluster management handlers to any HotPocket contract running on Evernode. Designed for use with the [Evernode Cluster Manager](https://github.com/rippleitinnz/evernode-cluster-manager) client tool but works with any HP JS client.

## What's new in 1.2.1

Fixes the long-standing **ghost peer** problem where a removed node would remain in hpcore's `req_known_remotes` list and trigger endless `Trying to connect <removed-node>` retries every ~4 seconds — forever, until container restart.

`handleRemoveNode` now calls `ctx.updatePeers([], [peerStr])` after the UNL update, which flushes the live retry queue on every UNL node atomically with the consensus removal. `handleRemovePeer` does the same for manual cleanup of legacy ghosts. See [CHANGELOG.md](./CHANGELOG.md) for full details.

## Install

```bash
npm install evernode-client-cluster-manager
```

## Usage

```js
const HotPocket = require('hotpocket-nodejs-contract');
const ClusterManager = require('evernode-client-cluster-manager');

const VERSION = '1.0.0';

const contract = async (ctx) => {
  // One line — registers all 10 handlers.
  // Returns true if a management command was handled — return early so your
  // business logic is skipped for that round.
  if (await ClusterManager.init(ctx, VERSION)) return;

  // Your business logic here
};

const hpc = new HotPocket.Contract();
hpc.init(contract);
```

Then build with ncc and deploy as normal:

```bash
npx ncc build src/index.js -o dist
```

## Handlers

| Type | Mode | Description |
|------|------|-------------|
| `status` | readonly | Ledger info, contract ID, public key, version, readonly flag |
| `readCfg` | readonly | Full running HP config from `/contract/cfg/hp.cfg` — includes mesh, user, node sections and known_peers |
| `readPatchCfg` | readonly | Contract override config via `ctx.getConfig()` |
| `readEnvVars` | readonly | Host environment variables from `/contract/env.vars` — external ports, quotas, security config |
| `readLog` | readonly | Last N lines of `hp.log` |
| `readContractLog` | readonly | Last N lines of `rw.stdout.log` or `rw.stderr.log` |
| `upgrade` | consensus | Deploy new contract bundle via base64, runs `post_exec.sh` |
| `addNode` | consensus | Add pubkey to UNL and peer via `ctx.updateConfig()` / `ctx.updatePeers()` |
| `removeNode` | consensus | Remove pubkey from UNL, clean `patch.cfg.known_peers`, and flush hpcore's `req_known_remotes` to stop retry spam |
| `removePeer` | consensus | Manual cleanup: flush a peer from `patch.cfg.known_peers` and `req_known_remotes` without UNL changes. Useful for legacy ghosts left behind by pre-1.2.1 removals |

Readonly handlers run on each node independently — no consensus required.
Consensus handlers require all UNL nodes to agree before executing.

## Input format

All inputs are JSON strings sent via `submitContractReadRequest` (readonly) or `submitContractInput` (consensus) from the HP JS client.

```js
// Readonly
{ "type": "status" }
{ "type": "readCfg" }
{ "type": "readPatchCfg" }
{ "type": "readEnvVars" }
{ "type": "readLog", "lines": 100 }
{ "type": "readContractLog", "lines": 100, "logFile": "stdout" }

// Consensus
{ "type": "upgrade", "bundle": "<base64 encoded bundle.zip>" }
{ "type": "addNode", "pubkey": "ed...", "ip": "host.example.com", "peerPort": 22865 }
{ "type": "removeNode", "pubkey": "ed...", "ip": "host.example.com", "peerPort": 22865 }
{ "type": "removePeer", "peerIp": "host.example.com", "peerPort": 22865 }
```

## Critical rules

- Never use non-deterministic values (`Date.now`, `Math.random`) in consensus handler outputs
- Always keep a `VERSION` constant and bump it on every upgrade so the cluster manager can track versions
- Never remove any of the 10 handlers — the cluster manager client depends on all of them
- The `upgrade` handler expects a valid `bundle.zip` containing `dist/index.js` built with `ncc`

## Requirements

- `hotpocket-nodejs-contract` >= 0.7.4
- Node.js >= 16
- Deployed on Evernode (requires HotPocket Docker environment with `/contract/cfg/hp.cfg` and `/contract/env.vars`)

## Related

- [Evernode Cluster Manager](https://github.com/rippleitinnz/evernode-cluster-manager) — the client tool that uses this package
- [Evernode Host API](https://api.onledger.net) — host discovery API for finding deployment targets
- [CHANGELOG.md](./CHANGELOG.md) — version history
