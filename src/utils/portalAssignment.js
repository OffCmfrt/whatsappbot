/**
 * Shared utility: assign a new support ticket to the correct portal
 * based on the current time-period (shift) configuration.
 *
 * Active portals are those with type='auto', is_active=true, and whose
 * shift_start/shift_end window covers the current wall-clock time.
 *
 * Among matching portals the selection is round-robin, respecting the
 * optional max_tickets capacity limit.
 */

const { dbAdapter } = require('../database/db');

// In-memory round-robin cursor (reset on process restart – good enough)
let rrCursor = 0;

/**
 * Return all active portals whose shift window covers `now`.
 * Portals without shift times are considered always-active.
 */
async function getActivePortalsForNow() {
    const portals = await dbAdapter.query(
        "SELECT id, name, shift_start, shift_end, max_tickets, assigned_count " +
        "FROM support_portals WHERE type = 'auto' AND is_active = true"
    );

    if (!portals || portals.length === 0) return [];

    const now = new Date();
    const currentTime = now.getHours() * 60 + now.getMinutes();

    return portals.filter(portal => {
        if (!portal.shift_start || !portal.shift_end) return true; // no shift = always active

        const [startH, startM] = portal.shift_start.split(':').map(Number);
        const [endH, endM] = portal.shift_end.split(':').map(Number);
        const startTime = startH * 60 + startM;
        const endTime = endH * 60 + endM;

        // Handle overnight shifts (e.g. 17:00 – 01:00)
        if (endTime < startTime) {
            return currentTime >= startTime || currentTime < endTime;
        }
        return currentTime >= startTime && currentTime < endTime;
    });
}

/**
 * Pick one portal from `portals` using round-robin, skipping any that
 * have reached their max_tickets capacity.  Returns null when none is
 * available.
 */
function selectPortalForAssignment(portals) {
    if (!portals || portals.length === 0) return null;

    for (let attempt = 0; attempt < portals.length; attempt++) {
        const idx = (rrCursor + attempt) % portals.length;
        const portal = portals[idx];

        const assigned = portal.assigned_count || 0;
        const max = portal.max_tickets || null;

        if (!max || assigned < max) {
            rrCursor = (idx + 1) % portals.length; // advance for next call
            return portal;
        }
    }
    return null; // all portals at capacity
}

/**
 * High-level helper: find the right portal for *right now* and return
 * its id (or null if no portal matches / all are full).
 */
async function getPortalIdForNewTicket() {
    try {
        const activePortals = await getActivePortalsForNow();
        if (activePortals.length === 0) return null;

        const selected = selectPortalForAssignment(activePortals);
        if (!selected) return null;

        // Increment assigned_count so the next call sees updated load
        await dbAdapter.run(
            'UPDATE support_portals SET assigned_count = assigned_count + 1 WHERE id = ?',
            [selected.id]
        );

        return selected.id;
    } catch (err) {
        console.error('[PORTAL-ASSIGN] Error selecting portal:', err.message);
        return null;
    }
}

module.exports = {
    getActivePortalsForNow,
    selectPortalForAssignment,
    getPortalIdForNewTicket
};
