# Professional Auto-Distribute Feature - Testing Guide

## Overview
This guide provides comprehensive testing instructions for the enhanced Professional Auto-Distribute feature with ultra-detailed capabilities.

---

## Pre-Deployment Steps

### 1. Database Migration
Run the migration script to add new columns and tables:

```bash
node migrate_auto_distribute.js
```

Expected output:
```
🚀 Starting Auto-Distribute Feature Migration...

📦 Adding advanced distribution columns to support_portals...
   ✅ Added max_tickets column
   ✅ Added shift_start column
   ✅ Added shift_end column
   ✅ Added is_active column
   ✅ Added distribution_rule column
   ✅ Added assigned_count column
   ✅ Added priority_level column

📊 Creating distribution_history table...
   ✅ distribution_history table created
   ✅ Indexes created for distribution_history

✅ Migration completed successfully!
```

### 2. Start Development Server
```bash
npm start
```

---

## Testing Scenarios

### Test 1: Round Robin Distribution (Basic)

**Steps:**
1. Navigate to Support Tickets section in dashboard
2. Click "Auto Distribute" button
3. Select "Round Robin" mode
4. Set Number of Portals: 3
5. Set Name Prefix: "Agent"
6. Click Next → Next → Distribute Tickets

**Expected Result:**
- ✅ 3 portals created (Agent 1, Agent 2, Agent 3)
- ✅ Tickets distributed evenly across portals
- ✅ Results modal shows distribution summary
- ✅ Each portal card shows ticket count

---

### Test 2: Filter Based Distribution

**Steps:**
1. Click "Auto Distribute" button
2. Select "Filter Based" mode
3. Configure filters:
   - Date From: 2025-01-01
   - Date To: 2025-12-31
   - Time From: 09:00
   - Time To: 17:00
   - Status: Open (checked)
4. Set Number of Portals: 2
5. Click Next → Next → Distribute Tickets

**Expected Result:**
- ✅ Only tickets matching date/time range are distributed
- ✅ Filter preview shows matching ticket count
- ✅ 2 portals created with filtered tickets
- ✅ Results show distribution statistics

---

### Test 3: Shift Based Distribution (Time Routing)

**Steps:**
1. Click "Auto Distribute" button
2. Select "Shift Based" mode
3. Configure shifts:
   - Morning Shift: 09:00 - 17:00
   - Evening Shift: 17:00 - 01:00
   - Night Shift: 01:00 - 09:00
4. Click Next → Next → Distribute Tickets

**Expected Result:**
- ✅ 3 portals created (one per shift)
- ✅ Tickets assigned based on creation time:
  - Tickets created 9AM-5PM → Morning Shift portal
  - Tickets created 5PM-1AM → Evening Shift portal
  - Tickets created 1AM-9AM → Night Shift portal
- ✅ Portal cards show shift time badges
- ✅ Active/inactive status based on current time

**Verification:**
```sql
-- Check ticket assignments
SELECT 
    p.name,
    p.shift_start,
    p.shift_end,
    COUNT(t.id) as ticket_count
FROM support_portals p
LEFT JOIN support_tickets t ON p.id = t.portal_id
WHERE p.type = 'auto'
GROUP BY p.id;
```

---

### Test 4: Workload Balanced Distribution

**Steps:**
1. Create 2 portals manually first with different ticket counts
2. Click "Auto Distribute" button
3. Select "Workload Balanced" mode
4. Set Number of Portals: 2
5. Click Next → Next → Distribute Tickets

**Expected Result:**
- ✅ New tickets assigned to portal with fewer tickets
- ✅ Workload indicators show capacity percentage
- ✅ Color coding: Green (<70%), Yellow (70-90%), Red (>90%)
- ✅ Balanced distribution achieved

---

### Test 5: Portal Capacity Limits

**Steps:**
1. Click "Auto Distribute" button
2. Select any mode
3. In Settings step, set Max Tickets per Portal: 10
4. Complete distribution with 50 tickets

**Expected Result:**
- ✅ No portal receives more than 10 tickets
- ✅ Some tickets may remain unassigned if capacity exceeded
- ✅ Warning shown in preview if capacity is low
- ✅ Portal cards show capacity percentage

---

### Test 6: Portal Cards Enhancement

**Steps:**
1. Navigate to Support Portals section
2. View existing portals

**Expected Result:**
- ✅ Portal cards show:
  - Portal name and type badge
  - Shift time badge (if shift-based)
  - Active/Inactive status badge
  - Ticket count
  - Workload progress bar with percentage
  - Copy Link, Clear, Delete actions
- ✅ Inactive portals appear faded (opacity: 0.6)
- ✅ Workload bar color changes based on capacity

---

### Test 7: Distribution History

**Steps:**
1. Perform multiple distributions
2. Check database:

```sql
SELECT * FROM distribution_history ORDER BY created_at DESC LIMIT 10;
```

**Expected Result:**
- ✅ Each distribution recorded with:
  - distribution_type (round_robin, filter_based, shift_based, workload_balanced)
  - portal_count
  - ticket_count
  - filters_applied (JSON)
  - created_at timestamp

---

### Test 8: API Endpoints

#### 8.1 Get Distribution Stats
```bash
curl -H "Authorization: Bearer YOUR_TOKEN" \
  http://localhost:3000/api/support-portals/distribution-stats
```

**Expected Response:**
```json
{
  "success": true,
  "history": [...],
  "portalStats": [...],
  "summary": {
    "totalDistributions": 5,
    "totalPortals": 10,
    "avgUtilization": 65
  }
}
```

#### 8.2 Get Active Shifts
```bash
curl -H "Authorization: Bearer YOUR_TOKEN" \
  http://localhost:3000/api/support-portals/active-shifts
```

**Expected Response:**
```json
{
  "success": true,
  "activePortals": [...],
  "totalPortals": 3,
  "currentTime": "14:30"
}
```

#### 8.3 Rebalance Tickets
```bash
curl -X POST \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"portalIds": [1, 2, 3]}' \
  http://localhost:3000/api/support-portals/rebalance
```

**Expected Response:**
```json
{
  "success": true,
  "message": "50 tickets rebalanced across 3 portals",
  "stats": [...]
}
```

---

### Test 9: Export Distribution Results

**Steps:**
1. Complete a distribution
2. In results modal, click "Export Results"

**Expected Result:**
- ✅ CSV file downloaded with columns:
  - Portal Name
  - Tickets
  - Shift Start
  - Shift End
  - Link
  - Password
- ✅ File named: `distribution-results-YYYY-MM-DD.csv`

---

### Test 10: Edge Cases

#### 10.1 No Tickets Match Filters
- Set filter date range with no tickets
- **Expected:** Error message "No tickets match the specified filters"

#### 10.2 Overlapping Shift Times
- Create shifts with overlapping times
- **Expected:** Ticket assigned to first matching shift

#### 10.3 Overnight Shifts
- Create shift: 22:00 - 06:00
- Create ticket at 23:30
- **Expected:** Ticket assigned to overnight shift portal

#### 10.4 Portal Capacity Exceeded
- Set max tickets: 5
- Try to distribute 50 tickets across 2 portals
- **Expected:** Only 10 tickets assigned, 40 remain unassigned

#### 10.5 Single Portal
- Try to distribute with count: 1
- **Expected:** Validation error "Count must be between 2 and 20"

---

## UI/UX Testing Checklist

### Wizard Flow
- [ ] Step 1: Mode selection cards highlight on click
- [ ] Step 2: Configuration panel changes based on mode
- [ ] Step 3: Settings form validates properly
- [ ] Step 4: Preview table shows accurate data
- [ ] Previous/Next buttons work correctly
- [ ] Cancel button closes modal and resets form

### Visual Design
- [ ] Wizard progress indicators update correctly
- [ ] Mode cards have hover effects
- [ ] Form inputs have proper focus states
- [ ] Buttons have loading states during API calls
- [ ] Success/error toasts appear correctly
- [ ] Modal animations are smooth

### Responsive Design
- [ ] Wizard works on mobile screens (< 768px)
- [ ] Filter rows stack vertically on mobile
- [ ] Preview table scrolls horizontally on small screens
- [ ] Portal cards stack on mobile
- [ ] All buttons are touch-friendly

---

## Performance Testing

### Large Dataset Test
1. Create 1000+ support tickets
2. Run auto-distribute with 10 portals
3. **Expected:** Distribution completes in < 5 seconds

### Concurrent Users
1. Open dashboard in multiple browser tabs
2. Run distribution from one tab
3. **Expected:** Other tabs see updated portals on refresh

---

## Troubleshooting

### Issue: Migration fails with "duplicate column"
**Solution:** This is normal if columns already exist. The script handles this gracefully.

### Issue: Portal cards don't show workload indicators
**Solution:** Ensure `max_tickets` is set for portals. Workload % requires a capacity limit.

### Issue: Shift-based distribution not assigning tickets
**Solution:** 
1. Check ticket `created_at` times
2. Verify shift time ranges cover ticket times
3. Check for overnight shift logic (end < start)

### Issue: Wizard doesn't advance to next step
**Solution:** 
1. Check browser console for errors
2. Verify all required fields are filled
3. Validate form inputs meet constraints

---

## Post-Deployment Verification

1. ✅ Database migration completed successfully
2. ✅ All 4 distribution modes work correctly
3. ✅ Portal cards show enhanced information
4. ✅ Distribution history is recorded
5. ✅ Export functionality works
6. ✅ API endpoints return correct data
7. ✅ UI is responsive on all screen sizes
8. ✅ No console errors in browser
9. ✅ Server logs show no errors
10. ✅ Backward compatibility maintained (existing portals work)

---

## Success Metrics

- **Functionality:** All 10 test scenarios pass
- **Performance:** Distribution of 1000 tickets < 5 seconds
- **UX:** Zero JavaScript errors in console
- **Data Integrity:** All tickets properly assigned
- **Backward Compatibility:** Existing portals unaffected

---

## Next Steps After Testing

1. Deploy to production
2. Monitor distribution history for first 24 hours
3. Gather user feedback on wizard UX
4. Analyze workload balance across portals
5. Consider adding scheduled auto-distribution feature

---

## Support

If you encounter any issues during testing:
1. Check server logs for errors
2. Review browser console for JavaScript errors
3. Verify database schema matches expected structure
4. Test API endpoints directly with curl/Postman
5. Check network tab for failed API requests
