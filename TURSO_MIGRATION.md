# Turso Database Migration Guide

## ✅ Turso Free Tier (Verified)

**Generous Free Tier - Perfect for Your Bot:**
- ✅ **9 GB storage** (18x more than Supabase!)
- ✅ **1 billion row reads/month** (unlimited for your use case)
- ✅ **25 million row writes/month** (more than enough)
- ✅ **Unlimited bandwidth** - NO EGRESS CHARGES! 🎉
- ✅ **500 databases**
- ✅ **3 locations per database**
- ✅ **No credit card required**

**This completely solves your bandwidth problem!**

---

## Migration Steps

### Step 1: Create Turso Account

1. Go to: **https://app.turso.tech/signup**
2. Sign up with GitHub, Google, or Email
3. Verify your email if required

### Step 2: Create Database (Web Dashboard)

1. In Turso dashboard, click **"Create Database"**
2. **Database name**: `whatsapp-bot`
3. **Location**: Select **Singapore** or **Mumbai** (closest to India)
4. Click **"Create"**

### Step 3: Get Connection Credentials (Web Dashboard)

1. Click on your newly created database (`whatsapp-bot`)
2. Go to **"Connect"** tab or **"Settings"** tab
3. You'll see:
   - **Database URL**: Something like `libsql://whatsapp-bot-yourname.turso.io`
   - Click **"Create Token"** or **"Generate Token"**
   - Copy the **Auth Token** (starts with `eyJ...`)

**Save both:**
- ✅ Database URL
- ✅ Auth Token

### Step 4: Run Database Schema (Web Dashboard)

1. In your database dashboard, go to **"SQL Console"** or **"Query"** tab
2. Copy the entire contents of `src/database/turso_schema.sql`
3. Paste into the SQL console
4. Click **"Execute"** or **"Run"**
5. You should see "Success" messages for each table created

**Verify tables:**
- Go to **"Tables"** tab
- You should see: `customers`, `orders`, `messages`, `broadcasts`, `offers`, `returns`, `exchanges`

### Step 5: Update Environment Variables

Add to your `.env` file:

```env
# Turso Database
TURSO_DATABASE_URL=libsql://whatsapp-bot-yourname.turso.io
TURSO_AUTH_TOKEN=eyJ...your-token-here...

# Comment out Supabase (keep as backup)
# SUPABASE_URL=your_supabase_project_url
# SUPABASE_ANON_KEY=your_supabase_anon_key
```

### Step 4: Run Database Schema

The schema has already been created at `src/database/turso_schema.sql`.

**Apply schema:**
```powershell
cd d:\projects\offcomfrtoffcial\whatsapp-bot
turso db shell whatsapp-bot < src/database/turso_schema.sql
```

**Verify tables were created:**
```powershell
turso db shell whatsapp-bot
# In the shell:
.tables
.exit
```

### Step 5: Install Turso SDK

```powershell
npm install @libsql/client
```

### Step 6: Update Render Environment Variables

1. Go to Render Dashboard → Your Service
2. Go to **Environment** tab
3. Add new variables:
   - `TURSO_DATABASE_URL` = your database URL
   - `TURSO_AUTH_TOKEN` = your auth token
4. **Remove or comment out** Supabase variables
5. Click **Save Changes**

### Step 8: Deploy

The code is already updated to support Turso. Just:

```powershell
git add .
git commit -m "Migrate to Turso database"
git push
```

Render will auto-deploy!

### Step 9: Verify Migration

1. Check Render logs for "✅ Turso connection successful"
2. Send a test WhatsApp message
3. **Verify data in Turso Dashboard:**
   - Go to https://app.turso.tech
   - Click your database
   - Go to **"Tables"** tab → **"customers"**
   - You should see your test customer data

---

## Rollback Plan

If something goes wrong:

1. Uncomment Supabase variables in `.env` and Render
2. Comment out Turso variables
3. Redeploy

---

## Benefits After Migration

- ✅ **No more egress charges** - unlimited bandwidth
- ✅ **18x more storage** - 9 GB vs 500 MB
- ✅ **Faster queries** - SQLite is extremely fast
- ✅ **Better scaling** - 1B reads/month vs Supabase limits
- ✅ **Edge deployment** - Can replicate globally

---

## Expected Downtime

**~5 minutes** during deployment

---

## Need Help?

- Turso Docs: https://docs.turso.tech
- Discord: https://tur.so/discord
- If migration fails, just rollback to Supabase
