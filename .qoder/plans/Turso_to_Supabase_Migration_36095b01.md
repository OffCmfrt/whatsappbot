# Turso to Supabase Migration Plan

## Overview

Migrate the WhatsApp bot from Turso (libSQL/SQLite) to Supabase (PostgreSQL). The core change is rewriting the single database adapter in `src/database/db.js` and converting all SQLite-specific SQL to PostgreSQL-compatible SQL across the codebase.

**Current state:** 1 adapter file (`db.js`), 17+ consumer files using `dbAdapter`, 14 database tables, SQLite-specific syntax scattered across routes/services/models.

---

## Phase 1: Supabase Project Setup & Schema Conversion

### Task 1.1: Create Supabase project and configure environment
- Create a new Supabase project at supabase.com
- Copy `SUPABASE_URL` and `SUPABASE_ANON_KEY` (or service_role key for server-side) into `.env`
- The `@supabase/supabase-js` package is already in `package.json` (v2.38.4)
- Also add `pg` driver (already in `package.json` at v8.11.3) for direct SQL queries

### Task 1.2: Create PostgreSQL schema file (`src/database/supabase_schema.sql`)
Convert all 14 tables from SQLite to PostgreSQL syntax. Key changes per table:

| SQLite | PostgreSQL |
|--------|-----------|
| `INTEGER PRIMARY KEY AUTOINCREMENT` | `SERIAL PRIMARY KEY` or `BIGSERIAL PRIMARY KEY` |
| `TEXT` (for JSON) | `JSONB` |
| `DATETIME DEFAULT CURRENT_TIMESTAMP` | `TIMESTAMPTZ DEFAULT NOW()` |
| `BOOLEAN DEFAULT 0` | `BOOLEAN DEFAULT FALSE` |
| `REAL` | `NUMERIC(10,2)` or `DOUBLE PRECISION` |
| `CREATE INDEX IF NOT EXISTS` | `CREATE INDEX IF NOT EXISTS` (compatible) |
| `CREATE TRIGGER ... AFTER UPDATE` | `CREATE OR REPLACE FUNCTION ... RETURNS TRIGGER` (PostgreSQL function+trigger) |

**Full table list to convert:**
1. `customers` - phone UNIQUE, order_count, preferred_language
2. `orders` - foreign key to customers(phone), tags column
3. `conversations` - context as JSONB
4. `messages` - wa_message_id, customer_phone FK
5. `broadcasts` - title, message, segment
6. `offers` - discount_code, expires_at
7. `support_portals` - slug UNIQUE, config as JSONB, distribution columns
8. `support_tickets` - portal_id FK, ticket_number UNIQUE, is_read, reengagement columns
9. `returns` - items as JSONB, FK to orders+customers
10. `exchanges` - old_items/new_items as JSONB, FK to orders+customers
11. `store_shoppers` - items_json as JSONB, UNIQUE(phone,order_id), conversation_lock_until
12. `shopper_confirmations` - UNIQUE(phone,order_id)
13. `follow_up_campaigns` - template_name, status, counter columns
14. `follow_up_recipients` - FK to campaigns+shoppers, wa_message_id
15. `message_reads` - UNIQUE(message_id)
16. `distribution_history` - distribution_type, portal/ticket counts
17. `system_settings` - key TEXT PRIMARY KEY, value
18. `abandoned_carts` - checkout_id UNIQUE, cart_items as JSONB
19. `broadcast_queue` - phone, message, status, template_data as JSONB
20. `automation_config` - key, content (referenced in messageHandler.js)

### Task 1.3: Convert SQLite triggers to PostgreSQL functions
6 triggers need conversion to PostgreSQL trigger functions:
- `update_customers_timestamp`
- `update_orders_timestamp`
- `update_conversations_timestamp`
- `update_returns_timestamp`
- `update_exchanges_timestamp`
- `update_store_shoppers_timestamp`
- `update_follow_up_campaigns_timestamp`
- `update_abandoned_carts_timestamp`

### Task 1.4: Run the schema in Supabase SQL Editor
- Execute `supabase_schema.sql` in Supabase Dashboard > SQL Editor
- Verify all tables, indexes, and triggers created successfully

---

## Phase 2: Rewrite Database Adapter (`src/database/db.js`)

### Task 2.1: Replace libSQL client with PostgreSQL pool
Current `db.js` uses `@libsql/client`. Replace with `pg` Pool (already in dependencies):

```
Current:  const tursoClient = createLibSQLClient({ url, authToken })
New:      const { Pool } = require('pg'); const pool = new Pool({ connectionString: process.env.DATABASE_URL })
```

Connection string format: `postgresql://postgres:[password]@[host]:5432/postgres`

### Task 2.2: Rewrite `DatabaseAdapter` methods for PostgreSQL
The adapter class has 6 methods that need rewriting:

| Method | Key Changes |
|--------|------------|
| `query(sql, params)` | Use `pool.query(sql, params)` - PG uses `$1,$2` params OR pass array. Result rows are in `result.rows` |
| `run(sql, params)` | PG: `result.rowCount` instead of `rowsAffected`, `result.rows[0]?.id` instead of `lastInsertRowid` |
| `insert(table, data)` | Use `RETURNING id` clause to get inserted ID; PG returns `result.rows[0].id` |
| `select(table, where, options)` | Same logic, PG-compatible |
| `update(table, data, where)` | Same logic, PG-compatible |
| `delete(table, where)` | Same logic, PG-compatible |

**Critical:** PostgreSQL uses `$1, $2, $3` parameter placeholders by default, NOT `?`. The adapter must convert `?` placeholders to `$1, $2, $3...` format, OR use the `pg` package's parameterized query support that accepts arrays.

**Decision:** Implement a `?`-to-`$N` converter in the adapter so that all existing SQL throughout the codebase continues to work without rewriting every query. This is the safest approach.

### Task 2.3: Rewrite `initializeDatabase()` function
- Remove all `ALTER TABLE ... ADD COLUMN` defensive migrations (PostgreSQL handles schema via explicit migrations, not runtime ALTERs)
- Replace with a migration tracking system or simply rely on the schema being created upfront
- Remove `PRAGMA` calls (broadcastService.js line 296 uses `PRAGMA table_info`)

### Task 2.4: Rewrite `testConnection()`
Replace `tursoClient.execute('SELECT 1')` with `pool.query('SELECT 1')`

---

## Phase 3: Fix SQLite-Specific SQL Across Codebase

### Task 3.1: Fix SQLite date functions in `adminRoutes.js`
3 locations with SQLite-specific date functions:

**Line 1705:** `ABS(julianday(s1.created_at) - julianday(s2.created_at)) <= 1`
PostgreSQL: `ABS(EXTRACT(EPOCH FROM (s1.created_at - s2.created_at)) / 86400) <= 1`

**Line 2600:** `datetime('now', '-30 days')`
PostgreSQL: `NOW() - INTERVAL '30 days'`

**Line 2610:** `datetime('now', '-7 days')`
PostgreSQL: `NOW() - INTERVAL '7 days'`

### Task 3.2: Fix `INSERT OR REPLACE` in `messageHandler.js`
2 locations (lines 353, 464) use `INSERT OR REPLACE INTO conversations`:
PostgreSQL: Use `INSERT INTO conversations ... ON CONFLICT (customer_phone) DO UPDATE SET ...`

### Task 3.3: Fix `INSERT OR IGNORE` in `adminRoutes.js`
Line 2424: `INSERT OR IGNORE INTO message_reads`
PostgreSQL: `INSERT INTO message_reads ... ON CONFLICT (message_id) DO NOTHING`

### Task 3.4: Fix `ON CONFLICT` syntax in `Settings.js` and `shopifyService.js`
- Settings.js line 93: `ON CONFLICT(key) DO UPDATE SET ... excluded.value` - this is already PostgreSQL-compatible, no change needed
- shopifyService.js line 352: `ON CONFLICT(phone) DO UPDATE SET` - already compatible

### Task 3.5: Fix `PRAGMA table_info` in `broadcastService.js`
Line 296: `PRAGMA table_info(broadcast_queue)` 
PostgreSQL: `SELECT column_name FROM information_schema.columns WHERE table_name = 'broadcast_queue'`

### Task 3.6: Fix `SQLITE_CONSTRAINT` error check in `AbandonedCart.js`
Line 41: `error.code === 'SQLITE_CONSTRAINT'`
PostgreSQL: `error.code === '23505'` (unique_violation) or check `error.constraint`

### Task 3.7: Fix `lastInsertRowid` references
In `adminRoutes.js` (lines 3054, 3247, 3279), references to `result.lastInsertRowid`:
PostgreSQL adapter will return `result.rows[0].id` via `RETURNING id` clause. Ensure the adapter's `insert()` and `run()` methods map this correctly.

### Task 3.8: Fix `CURRENT_TIMESTAMP` in raw SQL
Several queries use `CURRENT_TIMESTAMP` which works in both SQLite and PostgreSQL - no change needed.

### Task 3.9: Fix `expireOldCarts` in `AbandonedCart.js`
Line 173: `expired_at = CURRENT_TIMESTAMP` - works in PostgreSQL, no change needed.

---

## Phase 4: Data Migration Script

### Task 4.1: Create `scripts/migrate_turso_to_supabase.js`
Write a Node.js migration script that:
1. Connects to Turso (source) and Supabase (destination) simultaneously
2. Reads all data from each Turso table in batches (to handle large tables like `messages`)
3. Inserts into Supabase tables with proper type conversion
4. Key conversions:
   - `TEXT` JSON fields -> `JSONB` (need `JSON.parse()` then re-insert)
   - `DATETIME` strings -> `TIMESTAMPTZ` (PostgreSQL auto-converts ISO strings)
   - `BOOLEAN 0/1` -> `true/false`
5. Handles `AUTOINCREMENT` ID -> `SERIAL` (let PostgreSQL assign IDs or explicitly set with identity sequence reset)
6. Batch size: 500 rows per batch to avoid memory issues
7. Track progress with console logging per table

**Table migration order (respecting foreign keys):**
1. `customers` (no FK dependencies)
2. `orders` (depends on customers)
3. `conversations` (depends on customers)
4. `messages` (depends on customers)
5. `broadcasts` (no FK)
6. `offers` (no FK)
7. `system_settings` (no FK)
8. `support_portals` (no FK)
9. `support_tickets` (depends on support_portals)
10. `store_shoppers` (no FK in PG version)
11. `shopper_confirmations` (no FK)
12. `follow_up_campaigns` (no FK)
13. `follow_up_recipients` (depends on campaigns, shoppers)
14. `returns` (depends on orders, customers)
15. `exchanges` (depends on orders, customers)
16. `abandoned_carts` (no FK)
17. `broadcast_queue` (no FK)
18. `message_reads` (no FK)
19. `distribution_history` (no FK)
20. `automation_config` (no FK)

### Task 4.2: Add verification step to migration script
After migration, run COUNT(*) on each table in both databases and compare. Output a summary report.

### Task 4.3: Add sequence reset for SERIAL columns
After inserting data with explicit IDs, reset PostgreSQL sequences:
```sql
SELECT setval(pg_get_serial_sequence('"customers"', 'id'), (SELECT MAX(id) FROM "customers"));
```
Do this for all tables with SERIAL primary keys.

---

## Phase 5: Environment & Deployment Configuration

### Task 5.1: Update `.env` configuration
Replace:
```
TURSO_DATABASE_URL=...
TURSO_AUTH_TOKEN=...
```
With:
```
DATABASE_URL=postgresql://postgres:[password]@db.[project-ref].supabase.co:5432/postgres
SUPABASE_URL=https://[project-ref].supabase.co
SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
```

### Task 5.2: Update `render.yaml` / `Procfile` if needed
Ensure the deployment config doesn't hardcode Turso env vars.

### Task 5.3: Remove `@libsql/client` from `package.json`
After migration is complete and verified, remove the libsql dependency.

---

## Phase 6: Safe Cutover Procedure

### Task 6.1: Pre-cutover checklist
- [ ] Supabase schema created and verified
- [ ] Data migrated and counts verified
- [ ] All SQL dialect fixes applied and tested locally
- [ ] Environment variables configured on Render/production
- [ ] Rollback plan documented (keep Turso credentials active)

### Task 6.2: Cutover steps (with brief downtime)
1. **Stop** the running server (prevents new writes to Turso)
2. **Run** final incremental migration script (copies any rows created since last migration)
3. **Update** environment variables on hosting platform (Render)
4. **Deploy** the new code with Supabase adapter
5. **Start** the server
6. **Verify** health check, webhook processing, dashboard load
7. **Monitor** logs for any PostgreSQL errors for 30 minutes

### Task 6.3: Rollback plan
If critical issues arise within the first hour:
1. Revert environment variables to Turso credentials
2. Redeploy previous code version
3. Turso database is still intact (no data was deleted)
4. Any writes during the Supabase period would need manual reconciliation

### Task 6.4: Post-migration cleanup (after 48 hours of stable operation)
- Remove `@libsql/client` from `package.json`
- Remove `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` from hosting environment
- Delete `src/database/turso_schema.sql` (superseded by `supabase_schema.sql`)
- Update `.env.example`

---

## Files Modified Summary

| File | Change Type |
|------|------------|
| `src/database/db.js` | **Major rewrite** - replace libSQL with pg Pool, rewrite adapter methods |
| `src/database/supabase_schema.sql` | **New file** - PostgreSQL schema |
| `scripts/migrate_turso_to_supabase.js` | **New file** - data migration script |
| `src/routes/adminRoutes.js` | Fix julianday, datetime(), INSERT OR IGNORE |
| `src/handlers/messageHandler.js` | Fix INSERT OR REPLACE -> ON CONFLICT |
| `src/services/broadcastService.js` | Fix PRAGMA table_info |
| `src/models/AbandonedCart.js` | Fix SQLITE_CONSTRAINT error check |
| `.env.example` | Update database env vars |
| `package.json` | Eventually remove @libsql/client |

**No changes needed for:** `Customer.js`, `Order.js`, `Message.js`, `Settings.js`, `portalRoutes.js`, `apiRoutes.js` (they use the abstract `dbAdapter` interface which shields them from SQL dialect differences, except for the `?` placeholder issue which the adapter handles).