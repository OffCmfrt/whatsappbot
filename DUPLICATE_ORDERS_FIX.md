# Shoppers Hub Duplicate Orders Fix

## Problem
The Shoppers Hub was displaying duplicate orders, even though the database had a `UNIQUE(phone, order_id)` constraint. This constraint allowed the same `order_id` to appear multiple times if associated with different phone numbers.

## Root Causes Identified

1. **Weak Unique Constraint**: The existing `UNIQUE(phone, order_id)` constraint allowed duplicates of the same `order_id` with different phones
2. **Missing Query-Level Deduplication**: The database queries didn't use `GROUP BY order_id` to ensure unique results
3. **Race Conditions**: Multiple webhooks firing simultaneously could create duplicate entries before the unique constraint kicked in

## Solutions Applied

### 1. Database Query Fixes (Immediate Impact)

**File**: `src/routes/adminRoutes.js`

Updated all shopper queries to use `GROUP BY s.order_id` instead of `GROUP BY s.id`:

- **Main shoppers endpoint** (line ~1467): Added `GROUP BY s.order_id`
- **Recent confirmed orders** (line ~2397): Changed to `GROUP BY s.order_id` and `ORDER BY MAX(s.updated_at) DESC`
- **Export endpoints** (lines ~1820, ~2003): Changed to `GROUP BY s.order_id` with proper aggregate functions

**Impact**: Even if duplicates exist in the database, queries now return only one row per order_id.

### 2. Database Cleanup (29 Duplicates Removed)

**Script**: `cleanup_duplicate_shoppers.js`

Ran cleanup script which:
- Scanned for duplicate entries
- Found and deleted **29 duplicate records**
- Verified all duplicates removed
- Final stats: 2,656 total entries, 2,656 unique orders

### 3. Database Constraint Enhancement (Permanent Fix)

**Script**: `apply_shopper_unique_index.js`
**SQL**: `src/database/fix_shopper_duplicates.sql`

Created a **UNIQUE index** on `order_id` alone:
```sql
CREATE UNIQUE INDEX idx_store_shoppers_order_id_unique ON store_shoppers(order_id);
```

**Impact**: Database now **rejects** any attempt to insert duplicate order_ids at the database level.

## Verification

To verify the fix is working, you can:

1. **Check for duplicates**:
```sql
SELECT order_id, COUNT(*) as count 
FROM store_shoppers 
GROUP BY order_id 
HAVING COUNT(*) > 1;
```
Should return 0 rows.

2. **View the indexes**:
```sql
SELECT name, sql FROM sqlite_master 
WHERE type='index' AND tbl_name='store_shoppers';
```
Should show `idx_store_shoppers_order_id_unique`.

## Maintenance

If duplicates ever reappear, run:
```bash
node cleanup_duplicate_shoppers.js
```

This script is safe to run periodically and will only delete actual duplicates.

## Technical Details

### Why GROUP BY order_id instead of s.id?
- `GROUP BY s.id` doesn't help because each row has a unique `id`
- `GROUP BY s.order_id` ensures only one row per order is returned
- SQLite automatically picks the first row encountered for each group

### Why use MAX(s.updated_at) in ORDER BY?
- When using GROUP BY, non-grouped columns need aggregate functions in ORDER BY
- `MAX(s.updated_at)` ensures we sort by the most recent update for each order

### UNIQUE Index vs UNIQUE Constraint
- The existing constraint was `UNIQUE(phone, order_id)` - allows same order_id with different phones
- The new index is `UNIQUE(order_id)` - ensures each order_id appears only once
- Both work together for maximum protection

## Files Modified

1. `src/routes/adminRoutes.js` - Query deduplication
2. `src/database/fix_shopper_duplicates.sql` - SQL schema fix
3. `cleanup_duplicate_shoppers.js` - Already existed, used for cleanup
4. `apply_shopper_unique_index.js` - New script to apply index

## Result

✅ **Zero duplicate orders** shown in Shoppers Hub
✅ **Database-level prevention** of future duplicates
✅ **Query-level protection** even if database constraints fail
✅ **29 existing duplicates** cleaned up
