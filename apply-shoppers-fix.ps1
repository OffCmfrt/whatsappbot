# Apply Store Shoppers Performance Fix - May 5, 2026
# This script will apply indexes to optimize slow shoppers queries

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Store Shoppers Performance Fix" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "This fix will optimize:" -ForegroundColor Yellow
Write-Host "  - COUNT(DISTINCT order_id) queries (currently ~200-400ms)" -ForegroundColor White
Write-Host "  - SELECT queries with multiple subqueries (currently ~200ms)" -ForegroundColor White
Write-Host "  - Expected improvement: 10-20x faster (<20ms)" -ForegroundColor Green
Write-Host ""

$MigrationFile = "src\database\fix_shoppers_performance.sql"

if (-Not (Test-Path $MigrationFile)) {
    Write-Host "ERROR: Migration file not found: $MigrationFile" -ForegroundColor Red
    exit 1
}

Write-Host "Migration file: $MigrationFile" -ForegroundColor Green
Write-Host ""
Write-Host "Choose your database type:" -ForegroundColor Yellow
Write-Host "1. Turso (SQLite) - RECOMMENDED" -ForegroundColor White
Write-Host "2. PlanetScale (MySQL)" -ForegroundColor White
Write-Host "3. Local SQLite" -ForegroundColor White
Write-Host "4. Skip (I'll apply manually)" -ForegroundColor White
Write-Host ""

$choice = Read-Host "Enter choice (1-4)"

switch ($choice) {
    "1" {
        Write-Host ""
        Write-Host "Turso Migration Instructions:" -ForegroundColor Cyan
        Write-Host "======================================" -ForegroundColor Cyan
        Write-Host ""
        Write-Host "Option 1: Using Turso CLI" -ForegroundColor Yellow
        Write-Host "Run this command in your terminal:" -ForegroundColor White
        Write-Host ""
        Write-Host "turso db shell <your-database-name> < src\database\fix_shoppers_performance.sql" -ForegroundColor Green
        Write-Host ""
        Write-Host "Option 2: Using Turso Web Console" -ForegroundColor Yellow
        Write-Host "1. Go to https://turso.tech" -ForegroundColor White
        Write-Host "2. Open your database" -ForegroundColor White
        Write-Host "3. Click 'SQL Console'" -ForegroundColor White
        Write-Host "4. Copy and paste the contents of: src\database\fix_shoppers_performance.sql" -ForegroundColor White
        Write-Host "5. Click 'Execute'" -ForegroundColor White
        Write-Host ""
        Write-Host "Replace <your-database-name> with your actual Turso database name" -ForegroundColor Yellow
    }
    "2" {
        Write-Host ""
        Write-Host "PlanetScale Migration:" -ForegroundColor Cyan
        Write-Host "Run this command in your terminal:" -ForegroundColor Yellow
        Write-Host ""
        Write-Host "mysql -h <host> -u <user> -p <database-name> < src\database\fix_shoppers_performance.sql" -ForegroundColor Green
        Write-Host ""
        Write-Host "Replace <host>, <user>, and <database-name> with your PlanetScale credentials" -ForegroundColor Yellow
        Write-Host "You can also use the PlanetScale web console to run the SQL directly" -ForegroundColor Yellow
    }
    "3" {
        Write-Host ""
        $dbPath = Read-Host "Enter path to your SQLite database file"
        if (Test-Path $dbPath) {
            Write-Host ""
            Write-Host "Applying migration to: $dbPath" -ForegroundColor Green
            sqlite3 $dbPath < $MigrationFile
            if ($LASTEXITCODE -eq 0) {
                Write-Host "✅ Migration applied successfully!" -ForegroundColor Green
            } else {
                Write-Host "❌ Migration failed. Error code: $LASTEXITCODE" -ForegroundColor Red
            }
        } else {
            Write-Host "❌ Database file not found: $dbPath" -ForegroundColor Red
        }
    }
    "4" {
        Write-Host ""
        Write-Host "Manual application instructions:" -ForegroundColor Cyan
        Write-Host "1. Open your database management tool" -ForegroundColor White
        Write-Host "2. Copy the contents of: src\database\fix_shoppers_performance.sql" -ForegroundColor White
        Write-Host "3. Execute the SQL in your database" -ForegroundColor White
        Write-Host "4. The migration is safe to run multiple times (uses IF NOT EXISTS)" -ForegroundColor White
    }
    default {
        Write-Host "Invalid choice. Please run the script again." -ForegroundColor Red
    }
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "What was optimized:" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "1. ✅ Replaced 5 correlated subqueries with 1 LEFT JOIN" -ForegroundColor Green
Write-Host "2. ✅ Added composite indexes for common filter patterns" -ForegroundColor Green
Write-Host "3. ✅ Optimized COUNT(DISTINCT) queries" -ForegroundColor Green
Write-Host "4. ✅ Added covering index for frequent queries" -ForegroundColor Green
Write-Host ""
Write-Host "Expected Results:" -ForegroundColor Cyan
Write-Host "  - COUNT queries: ~200ms → <20ms (10x faster)" -ForegroundColor Green
Write-Host "  - SELECT queries: ~200ms → <30ms (7x faster)" -ForegroundColor Green
Write-Host "  - Overall page load: 600ms → <100ms" -ForegroundColor Green
Write-Host ""
Write-Host "After applying, monitor your Render logs to verify the improvement" -ForegroundColor Yellow
Write-Host ""
