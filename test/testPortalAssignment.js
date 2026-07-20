/**
 * Standalone test for portal assignment logic.
 * Run: node test/testPortalAssignment.js
 *
 * Tests the time-window matching and round-robin selection
 * without requiring a database connection.
 */

// ─── Inline the pure logic (same as portalAssignment.js) ────────────────

let rrCursor = 0;

function matchPortalToTime(portal, currentTime) {
    if (!portal.shift_start || !portal.shift_end) return true;

    const [startH, startM] = portal.shift_start.split(':').map(Number);
    const [endH, endM] = portal.shift_end.split(':').map(Number);
    const startTime = startH * 60 + startM;
    const endTime = endH * 60 + endM;

    if (endTime < startTime) {
        return currentTime >= startTime || currentTime < endTime;
    }
    return currentTime >= startTime && currentTime < endTime;
}

function selectPortalForAssignment(portals) {
    if (!portals || portals.length === 0) return null;

    for (let attempt = 0; attempt < portals.length; attempt++) {
        const idx = (rrCursor + attempt) % portals.length;
        const portal = portals[idx];

        const assigned = portal.assigned_count || 0;
        const max = portal.max_tickets || null;

        if (!max || assigned < max) {
            rrCursor = (idx + 1) % portals.length;
            return portal;
        }
    }
    return null;
}

// ─── Test helpers ────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, label) {
    if (condition) {
        console.log(`  ✅ ${label}`);
        passed++;
    } else {
        console.error(`  ❌ ${label}`);
        failed++;
    }
}

function assertEqual(actual, expected, label) {
    assert(actual === expected, `${label} (got ${actual}, expected ${expected})`);
}

// ─── Tests ───────────────────────────────────────────────────────────────

console.log('\n🧪 Portal Assignment Tests\n');

// 1. Time-window matching
console.log('📌 Time-window matching');

const morningPortal = { id: 1, name: '9-5 Agent', shift_start: '09:00', shift_end: '17:00', assigned_count: 0, max_tickets: null };
const eveningPortal = { id: 2, name: '5-9 Agent', shift_start: '17:00', shift_end: '21:00', assigned_count: 0, max_tickets: null };
const overnightPortal = { id: 3, name: 'Night Agent', shift_start: '22:00', shift_end: '06:00', assigned_count: 0, max_tickets: null };
const alwaysPortal = { id: 4, name: 'Always On', shift_start: null, shift_end: null, assigned_count: 0, max_tickets: null };

// 9-5 window
assert(matchPortalToTime(morningPortal, 9 * 60) === true, '9-5 portal matches at 09:00');
assert(matchPortalToTime(morningPortal, 12 * 60) === true, '9-5 portal matches at 12:00');
assert(matchPortalToTime(morningPortal, 16 * 60 + 59) === true, '9-5 portal matches at 16:59');
assert(matchPortalToTime(morningPortal, 17 * 60) === false, '9-5 portal does NOT match at 17:00');
assert(matchPortalToTime(morningPortal, 8 * 60) === false, '9-5 portal does NOT match at 08:00');

// 5-9 window
assert(matchPortalToTime(eveningPortal, 17 * 60) === true, '5-9 portal matches at 17:00');
assert(matchPortalToTime(eveningPortal, 20 * 60 + 30) === true, '5-9 portal matches at 20:30');
assert(matchPortalToTime(eveningPortal, 21 * 60) === false, '5-9 portal does NOT match at 21:00');

// Overnight window (22:00-06:00)
assert(matchPortalToTime(overnightPortal, 22 * 60) === true, 'Overnight portal matches at 22:00');
assert(matchPortalToTime(overnightPortal, 23 * 60 + 30) === true, 'Overnight portal matches at 23:30');
assert(matchPortalToTime(overnightPortal, 0) === true, 'Overnight portal matches at 00:00');
assert(matchPortalToTime(overnightPortal, 3 * 60) === true, 'Overnight portal matches at 03:00');
assert(matchPortalToTime(overnightPortal, 5 * 60 + 59) === true, 'Overnight portal matches at 05:59');
assert(matchPortalToTime(overnightPortal, 6 * 60) === false, 'Overnight portal does NOT match at 06:00');
assert(matchPortalToTime(overnightPortal, 12 * 60) === false, 'Overnight portal does NOT match at 12:00');

// Always-active portal
assert(matchPortalToTime(alwaysPortal, 0) === true, 'Always-active portal matches at 00:00');
assert(matchPortalToTime(alwaysPortal, 12 * 60) === true, 'Always-active portal matches at 12:00');
assert(matchPortalToTime(alwaysPortal, 23 * 60 + 59) === true, 'Always-active portal matches at 23:59');

// 2. Filtering active portals for a given time
console.log('\n📌 Filtering active portals for a given time');

const allPortals = [morningPortal, eveningPortal, overnightPortal, alwaysPortal];

function getActiveForTime(portals, time) {
    return portals.filter(p => matchPortalToTime(p, time));
}

const at10am = getActiveForTime(allPortals, 10 * 60);
assertEqual(at10am.length, 2, 'At 10:00 → 2 portals active (9-5 + always)');
assert(at10am.find(p => p.id === 1), 'At 10:00 → 9-5 Agent is active');
assert(at10am.find(p => p.id === 4), 'At 10:00 → Always On is active');

const at18 = getActiveForTime(allPortals, 18 * 60);
assertEqual(at18.length, 2, 'At 18:00 → 2 portals active (5-9 + always)');
assert(at18.find(p => p.id === 2), 'At 18:00 → 5-9 Agent is active');

const at23 = getActiveForTime(allPortals, 23 * 60);
assertEqual(at23.length, 2, 'At 23:00 → 2 portals active (overnight + always)');
assert(at23.find(p => p.id === 3), 'At 23:00 → Night Agent is active');

const at1659 = getActiveForTime(allPortals, 16 * 60 + 59);
assertEqual(at1659.length, 2, 'At 16:59 → 2 portals active (9-5 + always)');

// 3. Round-robin selection
console.log('\n📌 Round-robin selection');

rrCursor = 0; // reset

const portals = [
    { id: 10, name: 'A', assigned_count: 0, max_tickets: null },
    { id: 20, name: 'B', assigned_count: 0, max_tickets: null },
    { id: 30, name: 'C', assigned_count: 0, max_tickets: null },
];

const first = selectPortalForAssignment(portals);
assertEqual(first.id, 10, 'First pick → portal A (id=10)');

const second = selectPortalForAssignment(portals);
assertEqual(second.id, 20, 'Second pick → portal B (id=20)');

const third = selectPortalForAssignment(portals);
assertEqual(third.id, 30, 'Third pick → portal C (id=30)');

const fourth = selectPortalForAssignment(portals);
assertEqual(fourth.id, 10, 'Fourth pick → wraps to portal A (id=10)');

// 4. Capacity-aware selection
console.log('\n📌 Capacity-aware selection');

rrCursor = 0;

const capped = [
    { id: 1, name: 'Full', assigned_count: 5, max_tickets: 5 },
    { id: 2, name: 'Available', assigned_count: 2, max_tickets: 5 },
    { id: 3, name: 'Also Available', assigned_count: 0, max_tickets: 5 },
];

const pick1 = selectPortalForAssignment(capped);
assertEqual(pick1.id, 2, 'Skips full portal → picks Available (id=2)');

const pick2 = selectPortalForAssignment(capped);
assertEqual(pick2.id, 3, 'Next → picks Also Available (id=3)');

// All at capacity
const allFull = [
    { id: 1, name: 'X', assigned_count: 10, max_tickets: 10 },
    { id: 2, name: 'Y', assigned_count: 10, max_tickets: 10 },
];

const noPick = selectPortalForAssignment(allFull);
assertEqual(noPick, null, 'All at capacity → returns null');

// Empty list
const emptyPick = selectPortalForAssignment([]);
assertEqual(emptyPick, null, 'Empty list → returns null');

const nullPick = selectPortalForAssignment(null);
assertEqual(nullPick, null, 'Null list → returns null');

// 5. Unlimited capacity (max_tickets = null)
console.log('\n📌 Unlimited capacity');

rrCursor = 0;
const unlimited = [
    { id: 1, name: 'U1', assigned_count: 9999, max_tickets: null },
    { id: 2, name: 'U2', assigned_count: 0, max_tickets: null },
];

const uPick = selectPortalForAssignment(unlimited);
assertEqual(uPick.id, 1, 'Unlimited capacity → still picks first (id=1) even with high count');

// ─── Summary ─────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(40)}`);
console.log(`🏁 Results: ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(40)}\n`);

process.exit(failed > 0 ? 1 : 0);
