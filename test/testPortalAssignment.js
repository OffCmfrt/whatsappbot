/**
 * Standalone test for portal assignment logic.
 * Run: node test/testPortalAssignment.js
 *
 * Tests the time-window matching, active-portal filtering (auto + time-based),
 * round-robin selection and the even-split assignment rule — all without a
 * database connection. The pure logic below mirrors src/utils/portalAssignment.js.
 */

// ─── Inline the pure logic (same as portalAssignment.js) ────────────────

let rrCursor = 0;

// True when `currentTime` (minutes-of-day, IST) falls inside [start, end).
// Handles overnight windows. Returns null for missing/invalid times.
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

// Mirrors getActivePortalsForNow(): auto → shift columns, time_based → config window.
function getActiveForTime(portals, currentTime) {
    return portals.filter(portal => {
        if (portal.type === 'auto') {
            const res = timeInWindow(currentTime, portal.shift_start, portal.shift_end);
            return res === null ? true : res; // no shift window = always active
        }
        const config = portal.config || null;
        if (!config || !config.time_start || !config.time_end) return false;
        return timeInWindow(currentTime, config.time_start, config.time_end) === true;
    });
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

// Mirrors getPortalIdForNewTicket(): auto → its id (stamped); time_based → null (dynamic).
function resolveAssignment(activePortals) {
    const selected = selectPortalForAssignment(activePortals);
    if (!selected) return null;
    if (selected.type !== 'auto') return null;
    return selected.id;
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
console.log('📌 Time-window matching (timeInWindow)');

// 9-5 window
assert(timeInWindow(9 * 60, '09:00', '17:00') === true, '9-5 matches at 09:00');
assert(timeInWindow(12 * 60, '09:00', '17:00') === true, '9-5 matches at 12:00');
assert(timeInWindow(16 * 60 + 59, '09:00', '17:00') === true, '9-5 matches at 16:59');
assert(timeInWindow(17 * 60, '09:00', '17:00') === false, '9-5 does NOT match at 17:00');
assert(timeInWindow(8 * 60, '09:00', '17:00') === false, '9-5 does NOT match at 08:00');

// 5-9 window
assert(timeInWindow(17 * 60, '17:00', '21:00') === true, '5-9 matches at 17:00');
assert(timeInWindow(20 * 60 + 30, '17:00', '21:00') === true, '5-9 matches at 20:30');
assert(timeInWindow(21 * 60, '17:00', '21:00') === false, '5-9 does NOT match at 21:00');

// Overnight window (22:00-06:00)
assert(timeInWindow(22 * 60, '22:00', '06:00') === true, 'Overnight matches at 22:00');
assert(timeInWindow(0, '22:00', '06:00') === true, 'Overnight matches at 00:00');
assert(timeInWindow(5 * 60 + 59, '22:00', '06:00') === true, 'Overnight matches at 05:59');
assert(timeInWindow(6 * 60, '22:00', '06:00') === false, 'Overnight does NOT match at 06:00');
assert(timeInWindow(12 * 60, '22:00', '06:00') === false, 'Overnight does NOT match at 12:00');

// Missing/invalid
assert(timeInWindow(12 * 60, null, null) === null, 'Missing window → null');
assert(timeInWindow(12 * 60, 'bad', '17:00') === null, 'Invalid window → null');

// 2. Active-portal filtering for the real 9-5 / 5-9 setup
console.log('\n📌 Active-portal filtering (auto + time-based)');

const support95 = { id: 1, name: '9-5 Support', type: 'auto', shift_start: '09:00', shift_end: '17:00', assigned_count: 0, max_tickets: null };
const atharva = { id: 2, name: 'Atharva D', type: 'time_based', config: { time_start: '09:00', time_end: '17:00' }, assigned_count: 0, max_tickets: null };
const nitin = { id: 3, name: 'NITIN', type: 'time_based', config: { time_start: '17:00', time_end: '21:00' }, assigned_count: 0, max_tickets: null };

const allPortals = [support95, atharva, nitin];

const at10 = getActiveForTime(allPortals, 10 * 60);
assertEqual(at10.length, 2, 'At 10:00 → 2 active (9-5 Support + Atharva)');
assert(at10.find(p => p.id === 1) && at10.find(p => p.id === 2), 'At 10:00 → 9-5 Support and Atharva active');
assert(!at10.find(p => p.id === 3), 'At 10:00 → NITIN not active');

const at18 = getActiveForTime(allPortals, 18 * 60);
assertEqual(at18.length, 1, 'At 18:00 → 1 active (NITIN)');
assert(at18.find(p => p.id === 3), 'At 18:00 → NITIN active');

const at22 = getActiveForTime(allPortals, 22 * 60);
assertEqual(at22.length, 0, 'At 22:00 → no portal active (outside all windows)');

// 3. Even split during 9-5 between auto (stamped) and time-based (unassigned)
console.log('\n📌 Even split during 9-5 (auto id vs time-based null)');

rrCursor = 0;
const active95 = getActiveForTime(allPortals, 10 * 60); // [support95, atharva]
let autoCount = 0;
let dynamicCount = 0;
const results = [];
for (let i = 0; i < 10; i++) {
    const r = resolveAssignment(active95);
    results.push(r);
    if (r === 1) autoCount++;       // stamped to 9-5 Support
    else if (r === null) dynamicCount++; // left for Atharva (dynamic)
}
assertEqual(autoCount, 5, '10 tickets → 5 stamped to 9-5 Support');
assertEqual(dynamicCount, 5, '10 tickets → 5 left unassigned for Atharva');
assert(results[0] === 1 && results[1] === null, 'Alternates auto, then time-based');

// 4. During 5-9 everything is dynamic (NITIN claims via time match)
console.log('\n📌 5-9 period → all unassigned for NITIN');

rrCursor = 0;
const active59 = getActiveForTime(allPortals, 18 * 60); // [nitin]
let allNull = true;
for (let i = 0; i < 5; i++) {
    if (resolveAssignment(active59) !== null) allNull = false;
}
assert(allNull, '5-9 tickets → all null (claimed dynamically by NITIN)');

// 5. Round-robin selection
console.log('\n📌 Round-robin selection');

rrCursor = 0;
const rr = [
    { id: 10, name: 'A', assigned_count: 0, max_tickets: null },
    { id: 20, name: 'B', assigned_count: 0, max_tickets: null },
    { id: 30, name: 'C', assigned_count: 0, max_tickets: null },
];
assertEqual(selectPortalForAssignment(rr).id, 10, 'First pick → A (id=10)');
assertEqual(selectPortalForAssignment(rr).id, 20, 'Second pick → B (id=20)');
assertEqual(selectPortalForAssignment(rr).id, 30, 'Third pick → C (id=30)');
assertEqual(selectPortalForAssignment(rr).id, 10, 'Fourth pick → wraps to A (id=10)');

// 6. Capacity-aware selection
console.log('\n📌 Capacity-aware selection');

rrCursor = 0;
const capped = [
    { id: 1, name: 'Full', assigned_count: 5, max_tickets: 5 },
    { id: 2, name: 'Available', assigned_count: 2, max_tickets: 5 },
    { id: 3, name: 'Also Available', assigned_count: 0, max_tickets: 5 },
];
assertEqual(selectPortalForAssignment(capped).id, 2, 'Skips full portal → picks Available (id=2)');
assertEqual(selectPortalForAssignment(capped).id, 3, 'Next → picks Also Available (id=3)');

const allFull = [
    { id: 1, name: 'X', assigned_count: 10, max_tickets: 10 },
    { id: 2, name: 'Y', assigned_count: 10, max_tickets: 10 },
];
assertEqual(selectPortalForAssignment(allFull), null, 'All at capacity → returns null');
assertEqual(selectPortalForAssignment([]), null, 'Empty list → returns null');
assertEqual(selectPortalForAssignment(null), null, 'Null list → returns null');

// ─── Summary ─────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(40)}`);
console.log(`🏁 Results: ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(40)}\n`);

process.exit(failed > 0 ? 1 : 0);
