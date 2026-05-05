# PlanetScale Migration Guide

## Why PlanetScale?
- ✅ **Unlimited bandwidth** on free tier (vs 5 GB on Supabase)
- ✅ **5 GB storage** (10x more than Supabase)
- ✅ **1 billion row reads/month**
- ✅ **10 million row writes/month**
- ✅ MySQL-compatible (minimal code changes)

## Step 1: Create PlanetScale Account

1. Go to https://planetscale.com
2. Sign up with GitHub/Google
3. Create a new database: `whatsapp-bot`
4. Select region: **AWS ap-south-1 (Mumbai)** for best performance in India

## Step 2: Get Connection String

1. In PlanetScale dashboard, go to your database
2. Click **"Connect"**
3. Select **"Node.js"** from framework dropdown
4. Copy the connection string (looks like):
   ```
   mysql://username:password@host/database?ssl={"rejectUnauthorized":true}
   ```
5. **Save this** - you'll need it for `.env`

## Step 3: Run Database Schema

1. In PlanetScale dashboard, click **"Console"**
2. Copy and paste the schema from `src/database/planetscale_schema.sql`
3. Click **"Execute"**
4. Verify tables were created

## Step 4: Update Environment Variables

Update your `.env` file:

```env
# OLD - Supabase (comment out)
# SUPABASE_URL=your_supabase_project_url
# SUPABASE_ANON_KEY=your_supabase_anon_key

# NEW - PlanetScale
DATABASE_URL=mysql://username:password@host/database?ssl={"rejectUnauthorized":true}
```

## Step 5: Update Render Environment Variables

1. Go to Render dashboard
2. Select your service
3. Go to **Environment** tab
4. Add new variable:
   - Key: `DATABASE_URL`
   - Value: Your PlanetScale connection string
5. **Remove** old Supabase variables (optional)
6. Click **"Save Changes"**

## Step 6: Deploy Changes

The migration code is already prepared. Just:
1. Commit and push changes to GitHub
2. Render will auto-deploy
3. Check logs for successful connection

## Step 7: Verify Migration

1. Send a test message to your WhatsApp bot
2. Check PlanetScale console to see if data is being written
3. Test order tracking, broadcasts, etc.

## Rollback Plan (If Needed)

If something goes wrong:
1. Revert `DATABASE_URL` back to Supabase credentials
2. Redeploy
3. Everything will work as before

## Expected Downtime

**~5 minutes** during deployment

## Need Help?

If you encounter any issues during migration, check:
- Connection string is correct
- All tables were created successfully
- Render environment variables are updated
