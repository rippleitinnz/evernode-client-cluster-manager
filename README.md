# evernode-client-cluster-manager

Drop-in npm module that adds 14 cluster management handlers to any HotPocket contract running on Evernode. Designed for use with the [Evernode Cluster Manager](https://github.com/rippleitinnz/evernode-cluster-manager) client tool but works with any HP JS client.

## What's new in 1.3.0

**MATURED flow now works correctly.** The `checkAndSendMatured` function uses `hotpocket-js-client` to connect to existing UNL nodes and send the MATURED signal. Previously this was a dynamic inline `require()` inside the function body — ncc cannot statically bundle dynamic requires, so the module was silently missing from the compiled output and the function failed every round without error. Moved to a top-level static require so ncc bundles it correctly.

**Full peer mesh maintenance.** On every `addNode`, `removeNode`, and node promotion, the full UNL peer list is written to `patch.cfg` `mesh.known_peers` via `ctx.updateConfig()`. Previously nodes only had their single bootstrap peer in `known_peers`, meaning a cold restart with a dead bootstrap peer left the node completely isolated. `patch.cfg` is the correct persistence mechanism — hpcore reads it on startup and applies it over `hp.cfg`.

**`cluster.info` written with full UNL peer list.** Previously `cluster.info` contained only the anchor node and the new node. Now it contains all current UNL nodes, giving new nodes multiple peers to try when connecting and sending MATURED. No memo size constraint applies here — `cluster.info` is a bundle file, not a transaction memo.

**`checkAndPromoteMatured` updates full peer list via `ctx.updatePeers`.** After promoting a new node to UNL, all existing UNL nodes receive the complete peer list as a live update — not just the single new peer as before.

## What 1.2.2 fixed

Removed the `purgePeers` handler. It used hpcore's OVERWRITE mode (`ctx.updatePeers(peers, "*")`) which clears the entire `req_known_remotes` table and closes all live peer sessions at once. When sent simultaneously to every UNL node — which is what consensus does — every node tore down every peer connection in the same round, collapsing the cluster. The handler had no safe usage pattern from a multi-node contract.

The ghost-peer cleanup it was designed to address is now handled correctly and automatically by `removeNode` and `removePeer` (since 1.2.1), which use FORCE mode on a single peer at a time — surgical, safe across all nodes simultaneously. See [CHANGELOG.md](./CHANGELOG.md) for full details.

## What 1.2.1 fixed

Ghost peer retries after node removal. `handleRemoveNode` now flushes hpcore's `req_known_remotes` via `ctx.updatePeers([], [peerStr])` so removed nodes don't generate endless `Trying to connect <removed-node>` retries every ~4 seconds. `handleRemovePeer` does the same for manual cleanup of stale entries.

## Project setup

The package is a `require()` inside your contract code. Your contract lives in its own directory with a `package.json` and `index.js`. From an empty directory:

```bash
mkdir my-contract && cd my-contract
npm init -y
npm install hotpocket-nodejs-contract@0.7.4 evernode-client-cluster-manager
```

> The `npm init -y` step is mandatory. Without a `package.json` in the current directory, npm walks up looking for a parent project, finds one, and silently installs nothing — `node_modules/` is never created. If `npm install` reports "up to date, audited N packages" and no files appear, this is why.

Final layout:

```
my-contract/
├── package.json
├── index.js
└── node_modules/
    ├── hotpocket-nodejs-contract/
    └── evernode-client-cluster-manager/
```

## Usage

```js
'use strict';
const HotPocket      = require('hotpocket-nodejs-contract');
const ClusterManager = require('evernode-client-cluster-manager');

const VERSION = '1.0.0';

const contract = async (ctx) => {
    // One line — registers all handlers.
    // Returns true if a management command was handled — return early so your
    // business logic is skipped for that round.
    if (await ClusterManager.init(ctx, VERSION)) return;

    // Your business logic here
};

const hpc = new HotPocket.Contract();
hpc.init(contract);
```

## Deployment

You have two paths to a running cluster:

**Using the CLI tool (recommended):** [evernode-cluster-manager](https://github.com/rippleitinnz/evernode-cluster-manager) handles multi-node acquisition, bundling, deployment, live upgrades and ongoing cluster management. Point it at your contract directory when prompted for "Use my own contract directory" — the CLI runs `npm install`, ensures the correct ncc bundle is in place, and deploys.

**Manual deployment with evdevkit:** if you're driving Evernode directly:

```bash
# Bundle and deploy the contract
evdevkit bundle my-contract <pubkey> /usr/bin/node -a index.js
evdevkit deploy bundle.zip <domain> <user_port>
```

For multi-node clusters, manual deployment quickly becomes impractical — the bootstrap peer, UNL injection, and MATURED-flow timing are what the CLI tool exists to automate.

## Handlers

### Readonly (9)

| Type | Description |
|------|-------------|
| `status` | Ledger info, contract ID, public key, version, readonly flag |
| `readCfg` | Full running HP config from `/contract/cfg/hp.cfg` — includes mesh, user, node sections and known_peers |
| `readPatchCfg` | Contract override config via `ctx.getConfig()` |
| `readEnvVars` | Host environment variables from `/contract/env.vars` — external ports, quotas, security config |
| `readLog` | Last N lines of `hp.log` |
| `readContractLog` | Last N lines of `rw.stdout.log` or `rw.stderr.log` |
| `getBootstrapPeer` | Returns the most stable peer for a new node to bootstrap from — prioritises original deploy nodes, then promoted nodes by seniority |
| `readClusterJson` | Returns `cluster.json` from contract state — node membership, statuses, promotion history |
| `readAuthorizedPubkey` | Returns `authorized_pubkey.txt` — the management key authorized to submit consensus inputs |

### Consensus (5)

| Type | Description |
|------|-------------|
| `upgrade` | Deploy new contract bundle via base64, runs `post_exec.sh` |
| `addNode` | Register a new node as non-UNL pending MATURED signal. Writes full UNL peer list to `patch.cfg` `known_peers` for cold restart resilience |
| `removeNode` | Remove pubkey from UNL, update `patch.cfg.known_peers`, and flush hpcore's `req_known_remotes` to stop retry spam |
| `removePeer` | Manual cleanup: flush a peer from `patch.cfg.known_peers` and `req_known_remotes` without UNL changes. Useful for orphan entries |
| `matured` | Received from a non-UNL node when it has synced — marks it as acknowledged. Promoted to UNL after `MATURITY_LCL_THRESHOLD` ledgers |

Readonly handlers run on each node independently — no consensus required.
Consensus handlers require all UNL nodes to agree before executing.

### Autonomous (no input required)

These run on every consensus round inside `init()`:

- **`checkAndPromoteMatured`** — promotes acknowledged nodes to UNL after stability threshold. Writes full peer list to `patch.cfg` via `ctx.updateConfig()` and broadcasts full peer list via `ctx.updatePeers()` after each promotion. Also prunes nodes stuck in `status: created` for more than 5 moments (never acknowledged, definitively failed).
- **`checkAndSendMatured`** — runs on non-UNL nodes. Reads `cluster.info` (full UNL peer list) to find existing nodes, connects and sends MATURED signal when synced. Retries up to 3 times.

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
{ "type": "getBootstrapPeer" }
{ "type": "readClusterJson" }
{ "type": "readAuthorizedPubkey" }

// Consensus
{ "type": "upgrade", "bundle": "<base64 encoded bundle.zip>" }
{ "type": "addNode", "pubkey": "ed...", "ip": "host.example.com", "peerPort": 22865, "userPort": 26865, "existingNodes": [...] }
{ "type": "removeNode", "pubkey": "ed...", "ip": "host.example.com", "peerPort": 22865 }
{ "type": "removePeer", "peerIp": "host.example.com", "peerPort": 22865 }
{ "type": "matured", "data": "ed..." }
```

## Critical rules

- Never use non-deterministic values (`Date.now`, `Math.random`) in consensus handler outputs
- Always keep a `VERSION` constant and bump it on every upgrade so the cluster manager can track versions
- Never remove any handler — the cluster manager client depends on them
- The `upgrade` handler expects a valid `bundle.zip` containing the contract files
- `ctx.updatePeers(peers, "*")` is **not safe** to use from any consensus handler — it triggers hpcore OVERWRITE mode which closes all live peer sessions on every UNL node simultaneously. This is why 1.2.2 removed the `purgePeers` handler entirely

## Requirements

- `hotpocket-nodejs-contract` >= 0.7.4
- Node.js >= 16
- Deployed on Evernode (requires HotPocket Docker environment with `/contract/cfg/hp.cfg` and `/contract/env.vars`)

## Related

- [Evernode Cluster Manager](https://github.com/rippleitinnz/evernode-cluster-manager) — the client tool that uses this package
- [Evernode Host API](https://api.onledger.net) — host discovery API for finding deployment targets
- [CHANGELOG.md](./CHANGELOG.md) — version history
