/**
 * Shared, bounded HTTP(S) agents + idle-socket reaper.
 *
 * WHY THIS EXISTS (the leak it fixes):
 * On Node >= 19 the process-wide https.globalAgent has keepAlive enabled by
 * default and NO idle timeout for free (parked) sockets. Every axios call
 * that doesn't pass an explicit agent parks its TLS socket in
 * globalAgent.freeSockets after the response finishes. Render's outbound
 * NAT silently drops those idle connections (no FIN ever reaches Node), so
 * the sockets — and their native OpenSSL buffers (~100-500KB each) — are
 * never released. RSS climbs steadily in a staircase while the V8 heap
 * looks healthy: the classic native-memory leak graph.
 *
 * THE FIX: route all axios traffic through one bounded agent (small
 * maxFreeSockets) and periodically destroy free sockets that have been idle
 * too long. Destroying a free socket is always safe — it carries no
 * in-flight work and the agent opens a fresh connection on demand.
 */

const http = require('http');
const https = require('https');

// How long an idle (free) socket may live before the reaper destroys it.
// Well below the NAT silent-drop window so we never hold dead sockets.
const FREE_SOCKET_TTL_MS = 45 * 1000;

// Stamp sockets the moment they become idle so the reaper knows their age.
function instrument(agent) {
    agent.on('free', (socket) => { socket.__idleSince = Date.now(); });
    return agent;
}

// One shared keep-alive agent for ALL outbound HTTPS (Meta WhatsApp,
// Shiprocket, Delhivery, Ekart, Shopify, Zoho, AI providers...). Bounded so
// a traffic burst can never park hundreds of TLS sockets.
const sharedHttpsAgent = instrument(new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 10000,
    maxSockets: 24,     // concurrent outbound HTTPS connections
    maxFreeSockets: 6,  // idle sockets kept per host for reuse
    family: 4           // avoid IPv6 dead-route hangs on Render
}));

// Same treatment for the rare plain-HTTP call (e.g. localhost self-requests).
const sharedHttpAgent = instrument(new http.Agent({
    keepAlive: true,
    maxSockets: 16,
    maxFreeSockets: 4,
    family: 4
}));

/**
 * Destroy free sockets idle longer than maxIdleMs across the shared agents
 * AND the process-global agents (third-party SDKs may still park sockets
 * there). Returns the number of sockets destroyed. Called by the server's
 * memory watchdog every 60s.
 */
function reapIdleSockets(maxIdleMs = FREE_SOCKET_TTL_MS) {
    const now = Date.now();
    let reaped = 0;

    for (const agent of [sharedHttpsAgent, sharedHttpAgent, https.globalAgent, http.globalAgent]) {
        const free = agent && agent.freeSockets;
        if (!free) continue;
        for (const key of Object.keys(free)) {
            const list = free[key];
            if (!Array.isArray(list)) continue;
            for (const socket of list.slice()) {
                // Sockets parked before instrumentation: stamp on first
                // pass, judge on the next — never kill blindly.
                if (!socket.__idleSince) { socket.__idleSince = now; continue; }
                if (now - socket.__idleSince > maxIdleMs) {
                    socket.destroy();
                    reaped++;
                }
            }
        }
    }
    return reaped;
}

module.exports = { sharedHttpsAgent, sharedHttpAgent, reapIdleSockets, FREE_SOCKET_TTL_MS };
