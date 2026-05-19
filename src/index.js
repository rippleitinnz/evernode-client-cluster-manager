'use strict';

/**
 * evernode-cluster-manager
 *
 * Drop-in npm module for HotPocket contracts on Evernode.
 * Implements the correct official everpocket node-joining flow:
 *   1. New node acquired as non-UNL (pubkey not in existing UNL)
 *   2. New node syncs state/ledger via HPFS without voting
 *   3. New node sends MATURED message to existing UNL nodes
 *   4. Existing UNL nodes mark node as acknowledged in cluster.json
 *   5. After MATURITY_LCL_THRESHOLD ledgers, node promoted to UNL
 *
 * Usage:
 *   const ClusterManager = require('evernode-cluster-manager');
 *   const VERSION = '1.0.0';
 *   const contract = async (ctx) => {
 *     if (await ClusterManager.init(ctx, VERSION)) return;
 *     // your business logic here
 *   };
 *   const hpc = new HotPocket.Contract();
 *   hpc.init(contract);
 *
 * Readonly handlers (per-node, no consensus):
 *   status, readCfg, readPatchCfg, readEnvVars, readLog, readContractLog
 *
 * Consensus handlers (all UNL nodes must agree):
 *   upgrade, addNode, removeNode, removePeer
 *
 * Autonomous handlers (no user input required):
 *   matured (received from new non-UNL node)
 *   checkAndPromoteMatured (runs every consensus round)
 *   checkAndSendMatured (runs every consensus round on non-UNL nodes)
 */

const fs            = require('fs');
const child_process = require('child_process');
// everpocket is lazy-required only when needed to avoid bundle issues

// ── Constants ──────────────────────────────────────────────────

const BUNDLE                        = 'bundle.zip';
const HP_CFG_OVERRIDE               = 'hp.cfg.override';
const CONTRACT_CFG                  = 'contract.config';
const INSTALL_SCRIPT                = 'install.sh';
const PATH_CFG                      = '../patch.cfg';
const BACKUP_PATH_CFG               = '../patch.cfg.bk';
const HP_POST_EXEC                  = 'post_exec.sh';
const POST_EXEC_ERR                 = 'post_exec.err';
const BACKUP_PREFIX                 = 'backup';
const MAX_BACKUPS                   = 5;
const CLUSTER_JSON                  = 'cluster.json';
const CLUSTER_INFO                  = '../../seed/cluster.info'; // bootstrap file for new node, outside consensus state
const MATURITY_LCL_THRESHOLD        = 8;
const MAX_ACKNOWLEDGE_ATTEMPTS      = 3;
const ACKNOWLEDGE_RETRY_LCL_THRESHOLD = 8;

// ── Helpers ────────────────────────────────────────────────────

const send = async (user, obj) => user.send(obj);

let postExecErrors = {};

const loadPostExecErrors = () => {
    if (!fs.existsSync(POST_EXEC_ERR)) return;
    try { postExecErrors = JSON.parse(fs.readFileSync(POST_EXEC_ERR, 'utf8')); } catch { postExecErrors = {}; }
    fs.rmSync(POST_EXEC_ERR);
};

const pruneOldBackups = () => {
    try {
        const entries = fs.readdirSync('.', { withFileTypes: true });
        const backups = entries
            .filter(e => e.isDirectory() && e.name.startsWith(`${BACKUP_PREFIX}-`))
            .map(e => e.name).sort();
        const excess = backups.length - MAX_BACKUPS;
        for (let i = 0; i < excess; i++) {
            child_process.execSync(`rm -rf ./${backups[i]}`);
        }
    } catch(e) {}
};

// ── cluster.json helpers ───────────────────────────────────────

const loadCluster = () => {
    try {
        if (fs.existsSync(CLUSTER_JSON))
            return JSON.parse(fs.readFileSync(CLUSTER_JSON, 'utf8'));
    } catch(e) {}
    return { initialized: false, nodes: [] };
};

const saveCluster = (data) => {
    fs.writeFileSync(CLUSTER_JSON, JSON.stringify(data, null, 2));
};

// ── patch.cfg helpers ──────────────────────────────────────────

const addPeerToPatchCfg = (domain, peerPort) => {
    try {
        const raw = fs.readFileSync(PATH_CFG, 'utf8');
        const cfg = JSON.parse(raw);
        if (!cfg.mesh) cfg.mesh = {};
        if (!cfg.mesh.known_peers) cfg.mesh.known_peers = [];
        const peerStr = `${domain}:${peerPort}`;
        if (!cfg.mesh.known_peers.includes(peerStr)) {
            cfg.mesh.known_peers.push(peerStr);
            fs.writeFileSync(PATH_CFG, JSON.stringify(cfg, null, 4));
            console.log(`[ClusterManager] Added peer to patch.cfg: ${peerStr}`);
        }
    } catch(e) {
        console.log(`[ClusterManager] patch.cfg peer add failed: ${e.message}`);
    }
};

const removePeerFromPatchCfg = (domain, peerPort) => {
    try {
        const raw = fs.readFileSync(PATH_CFG, 'utf8');
        const cfg = JSON.parse(raw);
        const peerStr = `${domain}:${peerPort}`;
        if (cfg.mesh?.known_peers) {
            cfg.mesh.known_peers = cfg.mesh.known_peers.filter(p => p !== peerStr);
            fs.writeFileSync(PATH_CFG, JSON.stringify(cfg, null, 4));
            console.log(`[ClusterManager] Removed peer from patch.cfg: ${peerStr}`);
        }
    } catch(e) {
        console.log(`[ClusterManager] patch.cfg peer remove failed: ${e.message}`);
    }
};

// ── Readonly handlers ──────────────────────────────────────────

const handleStatus = async (user, ctx, version) => {
    await send(user, {
        type: 'status', version, lcl: ctx.lclSeqNo || 0,
        readonly: ctx.readonly, contractId: ctx.contractId, publicKey: ctx.publicKey
    });
};

const handleReadCfg = async (user, ctx, version) => {
    try {
        const raw = fs.readFileSync('/contract/cfg/hp.cfg', 'utf8');
        const cfg = JSON.parse(raw);
        await send(user, { type: 'readCfg', version, lcl: ctx.lclSeqNo, cfg });
    } catch(e) {
        await send(user, { type: 'error', message: e.message });
    }
};

const handleReadPatchCfg = async (user, ctx, version) => {
    try {
        const cfg = await ctx.getConfig();
        await send(user, { type: 'readPatchCfg', version, lcl: ctx.lclSeqNo, cfg });
    } catch(e) {
        await send(user, { type: 'error', message: e.message });
    }
};

const handleReadEnvVars = async (user, ctx, version) => {
    try {
        let raw;
        try {
            raw = fs.readFileSync('/contract/env.vars', 'utf8');
        } catch(e) {
            if (e.code === 'ENOENT') {
                raw = '(env.vars not present on this host — standard Sashimono installation)';
            } else {
                throw e;
            }
        }
        await send(user, { type: 'readEnvVars', version, lcl: ctx.lclSeqNo, content: raw });
    } catch(e) {
        await send(user, { type: 'error', message: e.message });
    }
};

const handleReadLog = async (user, msg, version) => {
    try {
        const n = parseInt(msg.lines) || 100;
        const lines = child_process.execSync(`tail -${n} /contract/log/hp.log 2>/dev/null || echo "no log"`).toString();
        await send(user, { type: 'readLog', version, lines });
    } catch(e) {
        await send(user, { type: 'error', message: e.message });
    }
};

const handleReadContractLog = async (user, msg, version) => {
    try {
        const n = parseInt(msg.lines) || 100;
        const logFile = msg.logFile === 'stderr' ? 'rw.stderr.log' : 'rw.stdout.log';
        const lines = child_process.execSync(`tail -${n} /contract/log/contract/${logFile} 2>/dev/null || echo "no log"`).toString();
        await send(user, { type: 'readContractLog', version, logFile, lines });
    } catch(e) {
        await send(user, { type: 'error', message: e.message });
    }
};

// ── Cluster state readers ─────────────────────────────────────

const handleReadClusterJson = async (user, ctx, version) => {
    try {
        const data = JSON.parse(fs.readFileSync(CLUSTER_JSON, 'utf8'));
        await send(user, { type: 'readClusterJson', version, lcl: ctx.lclSeqNo, data });
    } catch(e) {
        await send(user, { type: 'error', message: e.message });
    }
};

const handleReadAuthorizedPubkey = async (user, ctx, version) => {
    try {
        const pubkey = fs.readFileSync('authorized_pubkey.txt', 'utf8').trim();
        await send(user, { type: 'readAuthorizedPubkey', version, lcl: ctx.lclSeqNo, pubkey });
    } catch(e) {
        await send(user, { type: 'error', message: e.message });
    }
};

// ── Bootstrap peer selection ──────────────────────────────────
/**
 * handleGetBootstrapPeer — readonly handler, returns the best peer for a new
 * node to bootstrap from. Prioritises original deploy nodes (most stable),
 * then promoted nodes by earliest promotion. Excludes self.
 * Called by cluster-manager opAddNode() before writing initCfg.
 */
const handleGetBootstrapPeer = async (user, ctx, version) => {
    try {
        const cluster = loadCluster();
        if (!cluster.initialized || !cluster.nodes.length) {
            await send(user, { type: 'error', message: 'cluster not initialized' });
            return;
        }

        // Filter: UNL only, active, not self, has domain and peerPort
        const candidates = cluster.nodes
            .filter(n => n.isUnl && n.status === 'active' && n.pubkey !== ctx.publicKey && n.domain && n.peerPort);

        if (!candidates.length) {
            await send(user, { type: 'error', message: 'no suitable bootstrap peer found' });
            return;
        }

        // Sort: original deploy nodes first (no addedToUnlOnLcl = most stable),
        // then promoted nodes by earliest promotion (longest serving = most reliable).
        candidates.sort((a, b) => {
            const aOrig = a.addedToUnlOnLcl === undefined;
            const bOrig = b.addedToUnlOnLcl === undefined;
            if (aOrig && bOrig) return 0;
            if (aOrig) return -1;
            if (bOrig) return 1;
            return a.addedToUnlOnLcl - b.addedToUnlOnLcl;
        });

        const peer = candidates[0];
        console.log(`[ClusterManager] Bootstrap peer selected: ${peer.domain}:${peer.peerPort}`);
        await send(user, { type: 'getBootstrapPeer', version, domain: peer.domain, peerPort: peer.peerPort, pubkey: peer.pubkey });
    } catch(e) {
        await send(user, { type: 'error', message: e.message });
    }
};

// ── Consensus handlers ─────────────────────────────────────────

const handleUpgrade = async (user, bundleBase64, ctx, version) => {
    const backup = `${BACKUP_PREFIX}-${ctx.timestamp}`;
    try {
        child_process.execSync(`mkdir -p ../${backup} && cp -r ./* ../${backup}/ 2>/dev/null || true`);
        pruneOldBackups();

        fs.writeFileSync(BUNDLE, Buffer.from(bundleBase64, 'base64'), { mode: 0o644 });
        child_process.execSync(`/usr/bin/unzip -o ${BUNDLE} && rm -f ${BUNDLE}`);

        let hpCfg = {};
        if (fs.existsSync(HP_CFG_OVERRIDE)) {
            hpCfg = JSON.parse(fs.readFileSync(HP_CFG_OVERRIDE, 'utf8'));
            fs.rmSync(HP_CFG_OVERRIDE);
        }

        if (hpCfg.contract) {
            let contractCfg = {};
            if (fs.existsSync(CONTRACT_CFG))
                contractCfg = JSON.parse(fs.readFileSync(CONTRACT_CFG, 'utf8'));
            contractCfg = { ...contractCfg, ...hpCfg.contract };
            // Use log level from hp.cfg.override if provided, otherwise preserve existing or default to dbg
            const logLevel = hpCfg.log?.log_level || contractCfg.log?.log_level || 'dbg';
            contractCfg.log = { log_level: logLevel };
            // Apply roundtime from hp.cfg.override if provided
            if (hpCfg.contract?.consensus?.roundtime) {
                if (!contractCfg.consensus) contractCfg.consensus = {};
                contractCfg.consensus.roundtime = hpCfg.contract.consensus.roundtime;
            }
            fs.writeFileSync(CONTRACT_CFG, JSON.stringify(contractCfg, null, 2), { mode: 0o644 });
        }

        if (hpCfg.mesh?.known_peers?.length > 0) {
            await ctx.updatePeers(hpCfg.mesh.known_peers);
        }

        const postExecScript = `#!/bin/bash
cp ${PATH_CFG} ${BACKUP_PATH_CFG}

function print_err() {
    local error=$1
    log=$(jq . ${POST_EXEC_ERR})
    for key in $(jq -c 'keys[]' <<<$log); do
        log=$(jq ".$key = \\"$error\\"" <<<$log)
    done
    echo $log >${POST_EXEC_ERR}
}

function rollback() {
    [ -f ${BACKUP_PATH_CFG} ] && mv ${BACKUP_PATH_CFG} ${PATH_CFG}
    return 0
}

function upgrade() {
    [ -f "${CONTRACT_CFG}" ] && jq -s '.[0] * (.[1] | del(.unl))' ${PATH_CFG} ${CONTRACT_CFG} > /tmp/hp-patch-tmp.cfg && mv /tmp/hp-patch-tmp.cfg ${PATH_CFG}
    LOG_LEVEL=$(jq -r '.log.log_level // "dbg"' ${CONTRACT_CFG} 2>/dev/null || echo "dbg")
    ROUNDTIME=$(jq -r '.consensus.roundtime // empty' ${CONTRACT_CFG} 2>/dev/null)
    jq --arg ll "$LOG_LEVEL" '.log.log_level = $ll' ${PATH_CFG} > /tmp/hp-patch-tmp.cfg && mv /tmp/hp-patch-tmp.cfg ${PATH_CFG}
    jq --arg ll "$LOG_LEVEL" '.log.log_level = $ll' /contract/cfg/hp.cfg > /tmp/hp-cfg-tmp.cfg && mv /tmp/hp-cfg-tmp.cfg /contract/cfg/hp.cfg
    if [ -n "$ROUNDTIME" ]; then
        jq --argjson rt "$ROUNDTIME" '.contract.consensus.roundtime = $rt' ${PATH_CFG} > /tmp/hp-patch-tmp.cfg && mv /tmp/hp-patch-tmp.cfg ${PATH_CFG}
    fi
    if [ -f "${INSTALL_SCRIPT}" ]; then
        echo "${INSTALL_SCRIPT} found. Executing..."
        chmod +x ${INSTALL_SCRIPT}
        ./${INSTALL_SCRIPT}
        installcode=$?
        rm ${INSTALL_SCRIPT}
        if [ "$installcode" -eq "0" ]; then
            echo "${INSTALL_SCRIPT} executed successfully."
            return 0
        else
            echo "${INSTALL_SCRIPT} ended with exit code: $installcode"
            print_err "InstallScriptFailed"
            return 1
        fi
    fi
}

upgrade
upgradecode=$?

if [ "$upgradecode" -eq "0" ]; then
    echo "Upgrade successful."
else
    echo "Upgrade failed. Rolling back."
    rollback
fi

exit $?
`;
        postExecErrors[user.publicKey] = 'success';
        fs.writeFileSync(POST_EXEC_ERR, JSON.stringify(postExecErrors, null, 2), { mode: 0o644 });
        fs.writeFileSync(HP_POST_EXEC, postExecScript, { mode: 0o777 });

        await send(user, { type: 'upgradeResult', status: 'ok', version });
    } catch(e) {
        try { child_process.execSync(`cp -r ./${backup}/* ./ && rm -rf ./${backup}`); } catch {}
        await send(user, { type: 'upgradeResult', status: 'error', error: e.message });
    }
};

/**
 * handleAddNode — registers a new node in cluster.json as non-UNL.
 * Does NOT add to UNL immediately. The node will be promoted after
 * it sends a MATURED message to existing UNL nodes.
 *
 * msg fields:
 *   pubkey       - new node's public key
 *   ip           - new node's domain
 *   peerPort     - new node's peer port
 *   userPort     - new node's user port
 *   existingNodes - array of {pubkey, domain, userPort, peerPort} for current UNL nodes
 */
const handleAddNode = async (user, msg, ctx, version) => {
    const { pubkey, ip, peerPort, userPort, existingNodes } = msg;
    if (!pubkey || !ip || !peerPort) {
        await send(user, { type: 'error', message: 'addNode requires pubkey, ip, peerPort' });
        return;
    }
    try {
        const cluster = loadCluster();

        // Initialize cluster.json with existing UNL nodes on first use
        if (!cluster.initialized) {
            const cfg = await ctx.getConfig();
            for (const unlPubkey of cfg.unl) {
                if (!cluster.nodes.find(n => n.pubkey === unlPubkey)) {
                    // Try to get connection details from existingNodes passed by cluster-manager
                    const existingNode = (existingNodes || []).find(n => n.pubkey === unlPubkey);
                    cluster.nodes.push({
                        pubkey: unlPubkey,
                        domain: existingNode ? existingNode.domain : null,
                        userPort: existingNode ? existingNode.userPort : null,
                        peerPort: existingNode ? existingNode.peerPort : null,
                        isUnl: true,
                        status: 'active'
                    });
                }
            }
            cluster.initialized = true;
            console.log(`[ClusterManager] Initialized cluster.json with ${cluster.nodes.length} UNL nodes.`);
        }

        // Add new node as non-UNL pending
        if (!cluster.nodes.find(n => n.pubkey === pubkey)) {
            cluster.nodes.push({
                pubkey,
                domain: ip,
                peerPort: parseInt(peerPort),
                userPort: parseInt(userPort || 0),
                isUnl: false,
                status: 'created',
                createdOnLcl: ctx.lclSeqNo,
                acknowledgeTries: 0,
                lastAckSentLcl: 0
            });
            console.log(`[ClusterManager] Registered ${pubkey.slice(0,20)}... as non-UNL in cluster.json`);
        }

        saveCluster(cluster);

        // Add new node's peer to patch.cfg on existing UNL nodes (not on the new node itself)
        if (ctx.publicKey !== pubkey) {
            addPeerToPatchCfg(ip, peerPort);
        }

        // Update patch.cfg known_peers with full UNL peer list for cold restart resilience.
        // Note: checkAndPromoteMatured also calls ctx.updateConfig() after promotion to rewrite
        // the full peer list. These are sequential (different consensus rounds), not concurrent.
        try {
            const patchCfg = await ctx.getConfig();
            if (!patchCfg.mesh) patchCfg.mesh = {};
            patchCfg.mesh.known_peers = cluster.nodes
                .filter(n => n.isUnl && n.domain && n.peerPort)
                .map(n => `${n.domain}:${n.peerPort}`);
            await ctx.updateConfig(patchCfg);
            console.log(`[ClusterManager] Updated patch.cfg known_peers (${patchCfg.mesh.known_peers.length} peers)`);
        } catch(e) {
            console.log(`[ClusterManager] patch.cfg peer update failed: ${e.message}`);
        }

        await send(user, { type: 'addNode', status: 'ok', version, lcl: ctx.lclSeqNo });
    } catch(e) {
        await send(user, { type: 'error', message: e.message });
    }
};

/**
 * handleRemoveNode — removes a node from UNL and cluster.json.
 */
const handleRemoveNode = async (user, msg, ctx, version) => {
    const { pubkey } = msg;
    if (!pubkey) {
        await send(user, { type: 'error', message: 'removeNode requires pubkey' });
        return;
    }
    try {
        const cfg = await ctx.getConfig();
        const updated = cfg.unl.filter(k => k !== pubkey);
        if (updated.length === cfg.unl.length) {
            await send(user, { type: 'error', message: 'Node not found in UNL' });
            return;
        }
        if (updated.length < 2) {
            await send(user, { type: 'error', message: 'Cannot remove — would break quorum' });
            return;
        }
        cfg.unl = updated;
        await ctx.updateConfig(cfg);

        // Remove from cluster.json
        const cluster = loadCluster();
        const node = cluster.nodes.find(n => n.pubkey === pubkey);
        cluster.nodes = cluster.nodes.filter(n => n.pubkey !== pubkey);
        saveCluster(cluster);

        // Update patch.cfg known_peers with remaining UNL peers for cold restart resilience
        try {
            const patchCfg = await ctx.getConfig();
            if (!patchCfg.mesh) patchCfg.mesh = {};
            patchCfg.mesh.known_peers = cluster.nodes
                .filter(n => n.isUnl && n.domain && n.peerPort)
                .map(n => `${n.domain}:${n.peerPort}`);
            await ctx.updateConfig(patchCfg);
            console.log(`[ClusterManager] Updated patch.cfg known_peers (${patchCfg.mesh.known_peers.length} peers)`);
        } catch(e) {
            console.log(`[ClusterManager] patch.cfg peer update failed: ${e.message}`);
        }

        // Remove peer from patch.cfg AND from hpcore's live req_known_remotes
        let peerStr = null;
        if (node && node.domain && node.peerPort) {
            removePeerFromPatchCfg(node.domain, node.peerPort);
            peerStr = `${node.domain}:${node.peerPort}`;
        } else if (msg.ip && msg.peerPort) {
            removePeerFromPatchCfg(msg.ip, msg.peerPort);
            peerStr = `${msg.ip}:${msg.peerPort}`;
        }

        // Flush hpcore's live retry queue so it stops trying to reconnect to the removed node.
        // Without this the contract's UNL/patch.cfg cleanup leaves req_known_remotes untouched
        // and every node keeps logging "Trying to connect <ghost>" every ~4 seconds forever.
        if (peerStr) {
            console.log(`[ClusterManager] handleRemoveNode flushing req_known_remotes: ${peerStr}`);
            try {
                await ctx.updatePeers([], [peerStr]);
                console.log(`[ClusterManager] updatePeers flush succeeded: ${peerStr}`);
            } catch(e) {
                console.log(`[ClusterManager] updatePeers flush failed: ${e.message}`);
            }
        } else {
            console.log(`[ClusterManager] handleRemoveNode: no peerStr resolved, skipping updatePeers`);
        }

        await send(user, { type: 'removeNode', status: 'ok', version, newUnlCount: cfg.unl.length, lcl: ctx.lclSeqNo });
    } catch(e) {
        await send(user, { type: 'error', message: e.message });
    }
};

/**
 * handleRemovePeer — removes a peer from patch.cfg without removing from UNL.
 */
const handleRemovePeer = async (user, msg, ctx, version) => {
    const { peerIp, peerPort } = msg;
    if (!peerIp || !peerPort) {
        await send(user, { type: 'error', message: 'removePeer requires peerIp and peerPort' });
        return;
    }
    try {
        removePeerFromPatchCfg(peerIp, peerPort);

        // Also flush from hpcore's live retry queue
        const peerStr = `${peerIp}:${peerPort}`;
        console.log(`[ClusterManager] handleRemovePeer flushing req_known_remotes: ${peerStr}`);
        try {
            await ctx.updatePeers([], [peerStr]);
            console.log(`[ClusterManager] handleRemovePeer updatePeers succeeded: ${peerStr}`);
        } catch(e) {
            console.log(`[ClusterManager] handleRemovePeer updatePeers failed: ${e.message}`);
        }

        await send(user, { type: 'removePeer', status: 'ok', version });
    } catch(e) {
        await send(user, { type: 'error', message: e.message });
    }
};

/**
 * handleMatured — called when a non-UNL node connects and sends MATURED.
 * Marks the node as acknowledged in cluster.json.
 * After MATURITY_LCL_THRESHOLD ledgers, checkAndPromoteMatured will add to UNL.
 */
const handleMatured = async (user, msg, ctx, version) => {
    const newPubkey = msg.data || msg.pubkey;
    if (!newPubkey) {
        await send(user, { type: 'maturity_ack', status: 'error', message: 'pubkey required' });
        return;
    }
    // Verify the connecting user IS the node claiming to be matured
    if (user.publicKey !== newPubkey) {
        console.log(`[ClusterManager] MATURED rejected: sender ${user.publicKey.slice(0,20)} != claimed ${newPubkey.slice(0,20)}`);
        await send(user, { type: 'maturity_ack', status: 'error', message: 'pubkey mismatch' });
        return;
    }
    const cluster = loadCluster();
    const node = cluster.nodes.find(n => n.pubkey === newPubkey);
    if (!node) {
        console.log(`[ClusterManager] MATURED rejected: ${newPubkey.slice(0,20)} not in cluster.json`);
        await send(user, { type: 'maturity_ack', status: 'error', message: 'node not registered' });
        return;
    }
    if (node.isUnl) {
        // Already promoted
        await send(user, { type: 'maturity_ack', status: 'ok' });
        return;
    }
    if (node.status !== 'acknowledged') {
        node.status = 'acknowledged';
        node.acknowledgedOnLcl = ctx.lclSeqNo;
        node.acknowledgeTries = (node.acknowledgeTries || 0) + 1;
        saveCluster(cluster);
        console.log(`[ClusterManager] MATURED received from ${newPubkey.slice(0,20)} at LCL ${ctx.lclSeqNo}`);
    }
    await send(user, { type: 'maturity_ack', status: 'ok' });
};

// ── Autonomous round handlers ──────────────────────────────────

/**
 * checkAndPromoteMatured — runs every consensus round on UNL nodes.
 * Checks cluster.json for acknowledged nodes past the threshold and promotes them to UNL.
 */
const checkAndPromoteMatured = async (ctx) => {
    const cluster = loadCluster();
    if (!cluster.initialized) return;

    // Prune stale non-UNL nodes stuck in status:created for more than 5 moments.
    // Roundtime varies per cluster so threshold is calculated from hp.cfg in ledgers.
    // Never prunes: active UNL nodes, acknowledged (maturing) nodes, nodes without createdOnLcl.
    try {
        const hpCfg = JSON.parse(fs.readFileSync('/contract/cfg/hp.cfg', 'utf8'));
        const roundtimeMs = hpCfg.contract?.consensus?.roundtime || 5000;
        const momentInLedgers = Math.floor(3600000 / roundtimeMs);
        const STALE_THRESHOLD = momentInLedgers * 5;
        const isStale = (node) => {
            if (node.isUnl) return false;
            if (node.status === 'acknowledged') return false;
            if (node.status !== 'created') return false;
            if (node.createdOnLcl === undefined) return false;
            return (ctx.lclSeqNo - node.createdOnLcl) > STALE_THRESHOLD;
        };
        const stale = cluster.nodes.filter(isStale);
        if (stale.length > 0) {
            stale.forEach(n => console.log(`[ClusterManager] Pruning stale node ${n.pubkey.slice(0,20)} (${n.domain}) created LCL ${n.createdOnLcl} current LCL ${ctx.lclSeqNo} threshold ${STALE_THRESHOLD}`));
            cluster.nodes = cluster.nodes.filter(n => !isStale(n));
            saveCluster(cluster);
            console.log(`[ClusterManager] Pruned ${stale.length} stale node(s) from cluster.json`);
        }
    } catch(e) {
        console.log(`[ClusterManager] Stale node prune error: ${e.message}`);
    }

    const cfg = await ctx.getConfig();
    let changed = false;

    // Process one node at a time to avoid forking (per everpocket pattern)
    const pending = cluster.nodes
        .filter(n => !n.isUnl && n.status === 'acknowledged' &&
            n.acknowledgedOnLcl !== undefined &&
            (ctx.lclSeqNo - n.acknowledgedOnLcl) >= MATURITY_LCL_THRESHOLD)
        .sort((a, b) => (a.acknowledgedOnLcl || 0) - (b.acknowledgedOnLcl || 0));

    if (pending.length === 0) return;

    const node = pending[0]; // Process one at a time

    if (!cfg.unl.includes(node.pubkey)) {
        cfg.unl.push(node.pubkey);
        await ctx.updateConfig(cfg);
        console.log(`[ClusterManager] Promoted ${node.pubkey.slice(0,20)} to UNL at LCL ${ctx.lclSeqNo}`);
        changed = true;
    }

    node.isUnl = true;
    node.status = 'active';
    node.addedToUnlOnLcl = ctx.lclSeqNo;

    if (changed) {
        saveCluster(cluster);
        // Update ALL UNL peers on every node after promotion so full mesh is maintained.
        // Every node gets the complete peer list — cold restarts will always find peers.
        const fullPeerList = cluster.nodes
            .filter(n => n.isUnl && n.domain && n.peerPort)
            .map(n => `${n.domain}:${n.peerPort}`);
        if (fullPeerList.length > 0) {
            await ctx.updatePeers(fullPeerList);
            console.log(`[ClusterManager] Updated full peer mesh (${fullPeerList.length} peers): ${fullPeerList.join(', ')}`);
        }
    }
        // Update patch.cfg known_peers after promotion for cold restart resilience.
        // handleAddNode also writes known_peers when the node is first registered —
        // this rewrite after promotion ensures the full updated UNL list is persisted.
        try {
            const patchCfg = await ctx.getConfig();
            if (!patchCfg.mesh) patchCfg.mesh = {};
            patchCfg.mesh.known_peers = cluster.nodes
                .filter(n => n.isUnl && n.domain && n.peerPort)
                .map(n => `${n.domain}:${n.peerPort}`);
            await ctx.updateConfig(patchCfg);
            console.log(`[ClusterManager] Updated patch.cfg known_peers after promotion (${patchCfg.mesh.known_peers.length} peers)`);
        } catch(e) {
            console.log(`[ClusterManager] patch.cfg peer update after promotion failed: ${e.message}`);
        }
};

/**
 * checkAndSendMatured — runs every consensus round on non-UNL nodes.
 * If this node is not in the UNL, connects to UNL nodes and sends MATURED.
 */
const checkAndSendMatured = async (ctx) => {
    // Check if this node is in the UNL
    const isInUnl = ctx.unl.find(ctx.publicKey);
    if (isInUnl) return;
    // Non-UNL node reads from cluster.info (bundle bootstrap file, outside consensus state)
    let cluster;
    try {
        if (fs.existsSync(CLUSTER_INFO))
            cluster = JSON.parse(fs.readFileSync(CLUSTER_INFO, 'utf8'));
        else
            cluster = loadCluster();
    } catch { return; }
    if (!cluster || !cluster.initialized) return;
    const selfNode = cluster.nodes.find(n => n.pubkey === ctx.publicKey);
    if (!selfNode || selfNode.isUnl) return;

    const now = ctx.lclSeqNo;
    const lastAck = selfNode.lastAckSentLcl || 0;
    const tries = selfNode.acknowledgeTries || 0;

    if (tries >= MAX_ACKNOWLEDGE_ATTEMPTS) {
        console.log(`[ClusterManager] Max MATURED attempts reached for ${ctx.publicKey.slice(0,20)}`);
        return;
    }

    // Send immediately on first run, then retry every ACKNOWLEDGE_RETRY_LCL_THRESHOLD
    if (lastAck !== 0 && (now - lastAck) < ACKNOWLEDGE_RETRY_LCL_THRESHOLD) return;

    // Get UNL nodes with connection details
    const unlNodes = cluster.nodes.filter(n => n.isUnl && n.domain && n.userPort);
    if (unlNodes.length === 0) {
        console.log(`[ClusterManager] No UNL nodes with connection details found in cluster.json`);
        return;
    }

    // Update peers so new node can connect to existing UNL nodes
    const peerList = cluster.nodes
        .filter(n => n.isUnl && n.domain && n.peerPort)
        .map(n => `${n.domain}:${n.peerPort}`);
    if (peerList.length > 0) {
        await ctx.updatePeers(peerList);
        console.log(`[ClusterManager] Updated peers: ${peerList.join(', ')}`);
    }
    console.log(`[ClusterManager] Sending MATURED to ${unlNodes.length} UNL node(s) (attempt ${tries + 1})...`);

    const HPClient = require('hotpocket-js-client');
    for (const unlNode of unlNodes) {
        try {
            const keys = {
                privateKey: new Uint8Array(Buffer.from(ctx.privateKey, 'hex')),
                publicKey: new Uint8Array(Buffer.from(ctx.publicKey, 'hex'))
            };
            const client = await HPClient.createClient(
                [`wss://${unlNode.domain}:${unlNode.userPort}`],
                keys,
                { protocol: HPClient.protocols.json }
            );
            client.on(HPClient.events.contractOutput, () => {});
            const connected = await client.connect();
            if (connected) {
                const input = await client.submitContractInput(JSON.stringify({ type: 'matured', data: ctx.publicKey }));
                await input.submissionStatus;
                await client.close().catch(() => {});
                console.log(`[ClusterManager] MATURED sent to ${unlNode.domain}:${unlNode.userPort}`);
            }
        } catch(e) {
            console.log(`[ClusterManager] Failed to send MATURED to ${unlNode.domain}: ${e.message}`);
        }
    }

    selfNode.lastAckSentLcl = now;
    selfNode.acknowledgeTries = tries + 1;
    // Note: cluster was read from CLUSTER_INFO (cluster.info) if it existed, but is always
    // written back to CLUSTER_JSON (cluster.json) in the state dir. On a non-UNL node,
    // this means lastAckSentLcl and acknowledgeTries are persisted to the state-dir file,
    // not back to cluster.info. This is correct — cluster.info is a read-only bootstrap
    // file written at deploy time; cluster.json is the live mutable state.
    saveCluster(cluster);
};

// ── Public API ─────────────────────────────────────────────────

const init = async (ctx, version) => {
    loadPostExecErrors();

    for (const user of ctx.users.list()) {
        if (postExecErrors[user.publicKey]) {
            if (postExecErrors[user.publicKey] !== 'success') {
                await send(user, { type: 'upgradeResult', status: 'error', error: postExecErrors[user.publicKey] });
            }
            delete postExecErrors[user.publicKey];
        }

        for (const input of user.inputs) {
            let msg;
            try {
                const buf = await ctx.users.read(input);
                msg = JSON.parse(buf.toString());
            } catch(e) { continue; }

            if (ctx.readonly) {
                switch (msg.type) {
                    case 'status':
                        await handleStatus(user, ctx, version);
                        return true;
                    case 'readCfg':
                        await handleReadCfg(user, ctx, version);
                        return true;
                    case 'readPatchCfg':
                        await handleReadPatchCfg(user, ctx, version);
                        return true;
                    case 'readEnvVars':
                        await handleReadEnvVars(user, ctx, version);
                        return true;
                    case 'readContractLog':
                        await handleReadContractLog(user, msg, version);
                        return true;
                    case 'readLog':
                        await handleReadLog(user, msg, version);
                        return true;
                    case 'getBootstrapPeer':
                        await handleGetBootstrapPeer(user, ctx, version);
                        return true;
                    case 'readClusterJson':
                        await handleReadClusterJson(user, ctx, version);
                        return true;
                    case 'readAuthorizedPubkey':
                        await handleReadAuthorizedPubkey(user, ctx, version);
                        return true;
                }
            } else {
                switch (msg.type) {
                    case 'status':
                        await handleStatus(user, ctx, version);
                        return true;
                    case 'upgrade':
                        await handleUpgrade(user, msg.bundle, ctx, version);
                        return true;
                    case 'addNode':
                        await handleAddNode(user, msg, ctx, version);
                        return true;
                    case 'removeNode':
                        await handleRemoveNode(user, msg, ctx, version);
                        return true;
                    case 'removePeer':
                        await handleRemovePeer(user, msg, ctx, version);
                        return true;
                    case 'matured':
                        await handleMatured(user, msg, ctx, version);
                        return true;
                }
            }
        }
    }

    // Autonomous round processing (runs every consensus round regardless of user input)
    if (!ctx.readonly) {
        try { await checkAndPromoteMatured(ctx); } catch(e) { console.log('[ClusterManager] checkAndPromoteMatured error:', e.message); }
        try { await checkAndSendMatured(ctx); }    catch(e) { console.log('[ClusterManager] checkAndSendMatured error:', e.message); }
    }

    return false;
};

module.exports = { init };
