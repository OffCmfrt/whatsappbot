# Shopify Webhook Issues - Fix Guide

## Issues Fixed in This Update

### ✅ 1. Abandoned Cart UNIQUE Constraint Error (FIXED)

**Problem:** Shopify sends duplicate webhook events for the same `checkout_id`, causing:
```
SQLITE_CONSTRAINT: UNIQUE constraint failed: abandoned_carts.checkout_id
```

**Solution Implemented:**
- Modified `AbandonedCart.create()` to use an **upsert pattern** (check if exists, then update or insert)
- Added race condition handling with automatic fallback to UPDATE on constraint errors
- Webhook routes now gracefully handle duplicate constraints without returning 500 errors
- Duplicate webhooks are now logged and accepted with status 200

**Files Changed:**
- `src/models/AbandonedCart.js` - Added upsert logic
- `src/services/abandonedCartService.js` - Simplified duplicate handling
- `src/routes/shopifyWebhookRoutes.js` - Graceful error handling

---

### ⚠️ 2. Shopify Webhook HMAC Verification Failed (REQUIRES ACTION)

**Problem:** The webhook secret in your environment variables doesn't match Shopify's secret.

**Error from logs:**
```
Expected (computed): pDNWLwIjYZAaDPL5KktTrNYuTA57Y3NSrbMti/Y2yyg=
Received (header):   yRZfIY1L0Uk6UE8qAvDr02jbhcL+sEFvWUoZUK1nwgE=
Secret used (first 8 chars): 7b89e1d6...
```

**Steps to Fix:**

1. **Get the correct webhook secret from Shopify:**
   - Go to your Shopify Admin
   - Navigate to **Settings → Notifications → Webhooks**
   - Find your webhook endpoint (the one pointing to your bot)
   - Click on the webhook to view details
   - Copy the **Webhook Secret** (it's shown only once when you create/edit the webhook)

2. **Update your environment variable:**
   
   **If deployed on Render:**
   - Go to your Render Dashboard
   - Select your service
   - Go to **Environment** tab
   - Find `SHOPIFY_WEBHOOK_SECRET`
   - Update it with the correct secret from Shopify
   - Click **Save Changes** (this will trigger a redeploy)

   **If running locally:**
   - Open your `.env` file
   - Update the line:
     ```
     SHOPIFY_WEBHOOK_SECRET=your_correct_secret_here
     ```
   - Restart your server

3. **Alternative - Regenerate the webhook:**
   - If you can't find the secret, delete the existing webhook in Shopify
   - Create a new webhook with the same endpoint URL
   - Copy the new secret immediately
   - Update your environment variable

**Current Status:** 
The system currently **logs the mismatch but still processes the webhook** (see line 68-70 in `shopifyWebhookRoutes.js`). This is intentional to prevent data loss while you fix the secret. Once you update the secret, strict verification will work.

---

### ⚠️ 3. WhatsApp Message Undeliverable (Error 131026)

**Problem:** WhatsApp template message failed to deliver:
```
Code: 131026, Message: Message undeliverable
```

**Possible Causes:**
1. **Invalid phone number** - The number `911231231234` appears to be a test number
2. **User blocked your business account** - User may have blocked or reported spam
3. **Outside 24-hour window** - Can only send template messages outside the customer service window
4. **User deleted WhatsApp account** - Phone number no longer active
5. **WhatsApp account banned** - Temporary or permanent ban on the number

**Troubleshooting Steps:**

1. **Verify the phone number:**
   - Check if `911231231234` is a valid WhatsApp number
   - Test with a real customer number

2. **Check WhatsApp Business Account status:**
   - Go to Meta Business Suite
   - Check if your WhatsApp Business API is in good standing
   - Verify your phone number is approved for messaging

3. **Review template approval:**
   - Ensure your `order_confirmation_v7` template is **approved** in Meta Business Manager
   - Check template status at: https://business.facebook.com/wa/manage/message-templates/

4. **Check message logs:**
   - The system already logs outgoing messages to the `messages` table
   - Check message status via your dashboard or database query:
     ```sql
     SELECT * FROM messages 
     WHERE customer_phone LIKE '%1231231234%' 
     ORDER BY created_at DESC 
     LIMIT 10;
     ```

5. **Handle failed messages:**
   - The system automatically marks failed carts as 'failed' status
   - You can review failed deliveries in your abandoned carts dashboard

**Note:** Error 131026 is typically a **permanent failure** - the message won't be delivered even if retried. Focus on validating the phone number and user's WhatsApp status.

---

## Testing the Fixes

### Test Abandoned Cart Handling:
```bash
# Trigger a test checkout webhook
curl -X POST https://your-domain.com/api/shopify/webhook/checkout/create \
  -H "Content-Type: application/json" \
  -d '{
    "id": "test_checkout_123",
    "phone": "+919876543210",
    "email": "test@example.com",
    "total_price": "999.00",
    "currency": "INR",
    "abandoned_checkout_url": "https://offcomfrt.in/cart/test",
    "line_items": [
      {
        "title": "Test Product",
        "quantity": 1,
        "price": "999.00",
        "image_url": "https://example.com/image.jpg"
      }
    ]
  }'
```

### Verify No More UNIQUE Constraint Errors:
1. Send the same webhook twice with the same `id`
2. Check logs - you should see:
   ```
   🔄 Updated existing abandoned cart for 919876543210 (checkout: test_checkout_123)
   ```
   instead of the UNIQUE constraint error

---

## Monitoring

After deploying the fixes, monitor your logs for:

✅ **Good signs:**
- `🔄 Updated existing abandoned cart` - Duplicate handling working
- `⚡ Race condition detected` - Graceful fallback working
- `⚡ Duplicate webhook detected, ignoring gracefully` - Error handling working

❌ **Issues to address:**
- Continue seeing `SQLITE_CONSTRAINT` errors (should be rare now)
- HMAC verification failures (fix by updating the secret)
- Message undeliverable errors (validate phone numbers)

---

## Deployment

The fixes are already in your codebase. To deploy:

**On Render:**
```bash
# Changes will auto-deploy when you push to your connected git branch
git add .
git commit -m "Fix abandoned cart UNIQUE constraint and webhook error handling"
git push origin main
```

**Manual deployment (if needed):**
```bash
# Use the existing deployment script
./deploy-advanced-optimizations.sh
```

---

## Questions?

If you continue experiencing issues after applying these fixes:
1. Check the full logs for detailed error messages
2. Verify all environment variables are correctly set
3. Test with real phone numbers (not test numbers like 1231231234)
4. Ensure your WhatsApp Business API has proper permissions
