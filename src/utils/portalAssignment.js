/**
 * Shared utility: assign a new support ticket to the correct portal
 * based on the current time-period (shift) configuration.
 *
 * A portal is "active for now" when it is is_active=true and the current
 * IST wall-clock time falls inside its window:
 *   - auto        → shift_start / shift_end columns
 *   - time_based  → config.time_start / config.time_end
 *
 * Among the active portals selection is round-robin, respecting the optional
 * max_tickets capacity limit. This lets an auto portal and a time-based portal
 * that share the same period (e.g. 9-5 "9-5 Support" + "Atharva D") split new
 * tickets evenly. When an auto portal is picked the ticket is stamped with its
 * portal_id; when a time-based portal is picked the ticket is left unassigned
 * (portal_id NULL) so it is claimed dynamically by created-time matching — this
 * keeps time-based ticket counts (which count only unassigned rows) accurate.
 */

const { dbAdapter } = require('../database/db');
const { getCurrentIST } = require('./timezone');

// In-memory round-robin cursor (reset on process restart – good enough)
let rrCursor = 0;

// True when `currentTime` (minutes-of-day, IST) falls inside [start, end).
// Handles overnight windows (e.g. 21:00–06:00). Returns null for missing/invalid times.
function timeInWindow(currentTime, startStr, endStr) {
    if (!startStr || !endStr) return null;
    const [startH, startM] = String(startStr).split(':').map(Number);
    const [endH, endM] = String(endStr).split(':').map(Number);
    if ([startH, startM, endH, endM].some(n => !Number.isFinite(n))) return null;

    const startTime = startH * 60 + startM;
    const endTime = endH * 60 + endM;

    if (endTime < startTime) {
        return currentTime >= startTime || currentTime < endTime;
    }
    return currentTime >= startTime && currentTime < endTime;
}

/**
 * Return all active auto/time-based portals whose window covers `now` (IST).
 * Auto portals without a shift window are considered always-active.
 */
async function getActivePortalsForNow() {
    const portals = await dbAdapter.query(
        "SELECT id, name, type, config, shift_start, shift_end, max_tickets, assigned_count " +
        "FROM support_portals WHERE type IN ('auto', 'time_based') AND is_active = true"
    );

    if (!portals || portals.length === 0) return [];

    // Windows are configured in IST, so the "current time" must also be evaluated in IST —
    // NOT server local time (Render runs in UTC, which previously shifted every window by
    // +5:30 and made portals active during the wrong hours).
    const istNow = getCurrentIST();
    const currentTime = istNow.getUTCHours() * 60 + istNow.getUTCMinutes();

    return portals.filter(portal => {
        if (portal.type === 'auto') {
            const res = timeInWindow(currentTime, portal.shift_start, portal.shift_end);
            return res === null ? true : res; // no shift window = always active
        }

        // time_based: window comes from the JSON config
        let config = portal.config;
        try {
            config = typeof config === 'string' ? JSON.parse(config) : config;
        } catch (e) {
            config = null;
        }
        if (!config || !config.time_start || !config.time_end) return false;
        return timeInWindow(currentTime, config.time_start, config.time_end) === true;
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
 * High-level helper: round-robin across the portals active *right now* and
 * decide how a new ticket is assigned.
 *   - auto portal picked       → return its id (ticket is stamped with portal_id)
 *   - time-based portal picked → return null   (ticket stays unassigned and is
 *                                               claimed dynamically by its window)
 * Returns null when no portal matches / all are at capacity.
 */
async function getPortalIdForNewTicket() {
    try {
        const activePortals = await getActivePortalsForNow();
        if (activePortals.length === 0) return null;

        const selected = selectPortalForAssignment(activePortals);
        if (!selected) return null;

        // Time-based portals do not take explicit ownership — leaving portal_id NULL lets the
        // created-time matcher assign the ticket and keeps its dynamic count correct.
        if (selected.type !== 'auto') {
            return null;
        }

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
