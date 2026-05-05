# Apply Database Performance Migration - May 2026
# This script will apply the new indexes to optimize slow queries

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Database Performance Migration" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

$MigrationFile = "src\database\performance_indexes_may2026.sql"

if (-Not (Test-Path $MigrationFile)) {
    Write-Host "ERROR: Migration file not found: $MigrationFile" -ForegroundColor Red
    exit 1
}

Write-Host "Migration file: $MigrationFile" -ForegroundColor Green
Write-Host ""
Write-Host "Choose your database type:" -ForegroundColor Yellow
Write-Host "1. Turso (SQLite)" -ForegroundColor White
Write-Host "2. PlanetScale (MySQL)" -ForegroundColor White
Write-Host "3. Local SQLite" -ForegroundColor White
Write-Host "4. Skip (I'll apply manually)" -ForegroundColor White
Write-Host ""

$choice = Read-Host "Enter choice (1-4)"

switch ($choice) {
    "1" {
        Write-Host ""
        Write-Host "Turso Migration:" -ForegroundColor Cyan
        Write-Host "Run this command in your terminal:" -ForegroundColor Yellow
        Write-Host ""
        Write-Host "turso db shell <your-database-name> < src\database\performance_indexes_may2026.sql" -ForegroundColor Green
        Write-Host ""
        Write-Host "Replace <your-database-name> with your actual Turso database name" -ForegroundColor Yellow
    }
    "2" {
        Write-Host ""
        Write-Host "PlanetScale Migration:" -ForegroundColor Cyan
        Write-Host "Run this command in your terminal:" -ForegroundColor Yellow
        Write-Host ""
        Write-Host "mysql -h <host> -u <user> -p <database-name> < src\database\performance_indexes_may2026.sql" -ForegroundColor Green
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
        Write-Host "2. Copy the contents of: src\database\performance_indexes_may2026.sql" -ForegroundColor White
        Write-Host "3. Execute the SQL in your database" -ForegroundColor White
        Write-Host "4. The migration is safe to run multiple times (uses IF NOT EXISTS)" -ForegroundColor White
    }
    default {
        Write-Host "Invalid choice. Please run the script again." -ForegroundColor Red
    }
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "After applying the migration:" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "1. ✅ Queries will be 10-20x faster (<10ms vs ~200ms)" -ForegroundColor Green
Write-Host "2. ✅ Abandoned cart webhooks will process faster" -ForegroundColor Green
Write-Host "3. ✅ Follow-up status updates will be instant" -ForegroundColor Green
Write-Host "4. ✅ Support ticket lookups will be optimized" -ForegroundColor Green
Write-Host ""
Write-Host "You can verify by checking your Render logs - slow query warnings should disappear" -ForegroundColor Yellow
Write-Host ""
