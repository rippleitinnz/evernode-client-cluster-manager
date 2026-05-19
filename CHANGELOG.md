# Changelog

----

## [1.3.1] — 2026-05-19

### Added

- **Dynamic log level from `hp.cfg.override` in `handleUpgrade`.** When `hp.cfg.override` contains a `log` section with `log_level`, the upgrade handler now passes it through to `contract.config` and the `post_exec.sh` script applies it dynamically via `jq`. Previously `post_exec.sh` had `log_level` hardcoded to `"dbg"` — now it reads the value from `contract.config` at runtime. Note: takes effect on next container restart on current hpcore versions. A hpcore PR ([EvernodeXRPL/hpcore](https://github.com/EvernodeXRPL/hpcore)) has been raised to allow dynamic log level change without restart.

- **Dynamic roundtime from `hp.cfg.override` in `handleUpgrade`.** When `hp.cfg.override` contains `contract.consensus.roundtime`, the upgrade handler now stores it in `contract.config` and `post_exec.sh` applies it to `patch.cfg` via `jq`. hpcore reads `consensus.roundtime` dynamically from `patch.cfg` each ledger — confirmed taking effect within one consensus round on a live cluster without any container restart.

### Fixed

- **DEP0128 deprecation warning fixed.** Corrected `"main"` field in `package.json` from `"dist/index.js"` to `"index.js"` and added `"type": "commonjs"`. The contract build script copies the ncc bundle directly to the package root (not into a `dist/` subdirectory), so the previous `main` path was wrong. Node.js 20 was logging `Invalid 'main' field` to `rw.stderr.log` every contract execution round. Warning is now gone.


All notable changes to `evernode-client-cluster-manager` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0] — 2026-05-19

### Fixed

- **MATURED flow now works correctly.** `checkAndSendMatured` uses `require('hotpocket-js-client')` which was previously a dynamic inline require inside the function body. ncc cannot statically bundle dynamic requires, so the module was never included in the compiled output and the function silently failed every round. Moved to a top-level static require so ncc bundles it correctly.

- **`CLUSTER_INFO` path corrected.** The constant `../../seed/cluster.info` never resolved to a valid path inside the contract container — `cluster.info` was never read. The new node always fell back to `loadCluster()` reading `cluster.json` from HPFS-synced state. This worked incidentally but meant new nodes had no peer list until HPFS sync completed.

### Added

- **Full peer mesh maintenance via `patch.cfg`.** On every `addNode`, `removeNode`, and node promotion, the full UNL peer list is written to `patch.cfg` `mesh.known_peers` via `ctx.updateConfig()`. This is the correct authoritative mechanism — `patch.cfg` is what hpcore reads on startup. Previously nodes only had their single bootstrap peer in `known_peers`, meaning a cold restart with a dead bootstrap peer left the node isolated.

- **`checkAndPromoteMatured` updates full peer list via `ctx.updatePeers`.** After promoting a new node to UNL, all existing UNL nodes receive the complete peer list as a live update — not just the single new peer as before.

### Changed

- **`cluster.info` written with full UNL peer list** (previously only anchor node + new node). No memo size constraint applies here — `cluster.info` is a bundle file, not a transaction memo. Gives new nodes multiple peers to try when sending MATURED, eliminating dependency on a single bootstrap peer.

### Removed

- `updateHpCfgPeers` helper (direct `/contract/cfg/hp.cfg` write). hpcore overwrites `hp.cfg` each consensus round from `patch.cfg`, so direct writes do not persist. The correct persistence mechanism is `ctx.updateConfig()` writing to `patch.cfg`.

---

## [1.2.2] — 2026-05-14

### Removed

- **`purgePeers` handler.** Used hpcore's OVERWRITE mode (`ctx.updatePeers(peers, "*")`) which is fundamentally unsafe to invoke from a multi-node contract: every UNL node runs the handler in the same consensus round, so every node tears down all live peer sessions simultaneously. This collapses the cluster. The handler had no safe usage pattern and was a footgun for any downstream contract that imported the package and exposed the input type. The ghost-peer use case it was originally designed for is now handled correctly by `removeNode` and `removePeer` (since 1.2.1) using FORCE mode on a single peer at a time.

### Cleaned up

- Removed orphan `heartbeat()` function (defined but never called from `init()`; downstream contracts implement their own keepalives if needed).
- Removed unused `HP_CLIENT_TIMEOUT` constant.
- Removed dead `HEARTBEAT_INTERVAL` constant (only used by the removed `heartbeat()`).
- Cleaned `/***N;***/` inline comment artefacts on threshold constants.

### Handler count

Down from 15 to 14 user-facing handlers (9 readonly + 5 consensus). `matured` is consensus but is a node-to-node signal, not a user-facing operation.

## [1.2.1] — 2026-05-11

### Fixed

- **Ghost peer retries after node removal.** When a node was removed via `opRemoveNode`, the contract correctly updated the UNL and `patch.cfg.known_peers`, but hpcore's in-memory `req_known_remotes` list was never told. Every UNL node would then log `Trying to connect <removed-node>:<port>` every ~4 seconds indefinitely, even after the removed instance was destroyed. The same behaviour also occurred when a node's lease expired naturally — the dead node remained in the retry queue forever.

  `handleRemoveNode` now calls `ctx.updatePeers([], [peerStr])` after the UNL update, which routes through hpcore's `update_peer_list(FORCE, ...)` path (`p2p/p2p.cpp:582`). This surgically removes the single named peer from `req_known_remotes` and closes any live session to it, without touching any other peer entry or session. The fix is FORCE-mode only — it does **not** use OVERWRITE mode, which is the mechanism that broke consensus in earlier removal attempts.

  `handleRemovePeer` was updated with the same flush so it works as a manual escape hatch for legacy ghost peers left behind by pre-1.2.1 removals.

### Verified

- Traced the fix path through hpcore source: `sc.cpp:1163` → `p2p.cpp:582-604` → erase from `req_known_remotes` + `mark_for_closure` on the live session.
- Confirmed FORCE mode is surgical (single peer only) and cannot reproduce the OVERWRITE-mode side effects that caused consensus failures in earlier attempts.
- Tested twice on a live 10-node cluster:
  - Healthy node added then removed via `opRemoveNode` → no retry spam afterwards.
  - Node allowed to expire naturally (lease ended), retry spam appeared as expected, then `opRemoveNode` produced the hpcore log line `Removing <host>:<port> from known peer list.` and all retries stopped immediately.

### Notes

- hpcore validates `contract_id` on the peer challenge handshake (`peer_comm_session.cpp:112`), so ghost retries could not enter consensus with another contract that happened to land on the same host:port — but they could still leak the contract_id and create log noise. This is now resolved.

## [1.2.0] — Prior version

Released and ran on the cluster; no formal changelog entry retained.

## [1.1.x and earlier] — Prior versions

Earlier work included attempts at ghost-peer cleanup using OVERWRITE-mode peer updates. These were destructive — clearing every peer's `req_known_remotes` simultaneously across the cluster broke consensus — and were reverted. 1.2.1 is the first proven safe and effective fix for the ghost-peer problem.

There may still be unused helper code in `src/index.js` left over from those earlier approaches. A code audit is planned.

[1.3.0]: https://github.com/rippleitinnz/evernode-client-cluster-manager/releases/tag/v1.3.0
[1.2.2]: https://github.com/rippleitinnz/evernode-client-cluster-manager/releases/tag/v1.2.2
[1.2.1]: https://github.com/rippleitinnz/evernode-client-cluster-manager/releases/tag/v1.2.1
