# Fix: Broadcasts Table Missing `created_by` Column

## Error
```
Could not find the 'created_by' column of 'broadcasts' in the schema cache
```

## Solution

### Option 1: Run SQL in Supabase Dashboard (Recommended - 2 minutes)

1. **Go to Supabase Dashboard**: https://supabase.com/dashboard
2. **Navigate to**: Your Project → SQL Editor
3. **Copy and paste this SQL**:

```sql
ALTER TABLE broadcasts 
ADD COLUMN IF NOT EXISTS created_by VARCHAR(100);
```

4. **Click "Run"**
5. **Verify** by running:

```sql
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'broadcasts';
```

You should see `created_by` in the results.

### Option 2: Use the Migration File

I've created a migration file at:
`src/database/fix_broadcasts_table.sql`

Run it in Supabase SQL Editor.

## After Running the Fix

1. **Restart your Render service** (or wait for auto-deploy)
2. **Test the broadcast feature** in your admin dashboard
3. The error should be gone! ✅

## Why This Happened

The `broadcasts` table was created in your Supabase database before the `created_by` column was added to the schema file. This is a one-time fix.
