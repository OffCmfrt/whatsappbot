-- Fix broadcasts table - Add missing created_by column
-- Run this in Supabase SQL Editor

-- Add created_by column if it doesn't exist
ALTER TABLE broadcasts 
ADD COLUMN IF NOT EXISTS created_by VARCHAR(100);

-- Verify the column was added
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'broadcasts';
