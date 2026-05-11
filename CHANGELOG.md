# Changelog

All notable changes to `evernode-client-cluster-manager` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[1.2.1]: https://github.com/rippleitinnz/evernode-client-cluster-manager/releases/tag/v1.2.1
