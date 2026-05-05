-- Migration script to remove default value from preferred_language column in customers table

-- For PostgreSQL or compatible DBMS
ALTER TABLE customers ALTER COLUMN preferred_language DROP DEFAULT;

-- Optionally ensure preferred_language can accept NULL (if needed)
ALTER TABLE customers ALTER COLUMN preferred_language DROP NOT NULL;

-- You can run this script using your DB migration tool or manually execute in your DB client
