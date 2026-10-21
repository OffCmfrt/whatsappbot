# Abandoned Cart Delivery Blocking Fix

## Problem

WhatsApp error code **131049** ("This message was not delivered to maintain healthy ecosystem engagement") occurs when Meta's spam protection blocks delivery to users who haven't engaged with your business recently.

### What was happening:
1. ✅ API call succeeds → cart marked as `sent_second`
2. ❌ Meta blocks delivery **asynchronously** via webhook (error 131049)
3. 🚫 `messages` table updated to 'failed', but `abandoned_carts` stays as `sent_second`
4. 📊 No way to track which carts were blocked or retry them

## Solution

### 1. Database Schema Update
Added two columns to track WhatsApp message IDs:
- `first_reminder_wamid TEXT` - stores wamid for first reminder
- `second_reminder_wamid TEXT` - stores wamid for second reminder

**Migration file**: `src/database/add_wamid_to_abandoned_carts.sql`

### 2. Model Enhancement
Added methods to `AbandonedCart` model:
- `findByWamid(wamid)` - find cart by message ID
- `updateWamid(checkoutId, reminderType, wamid)` - store message ID

### 3. Service Update
Modified `abandonedCartService.js` to:
- Capture the `wamid` from Meta API response when sending reminders
- Store the `wamid` in the database alongside the status update

### 4. Webhook Handler Enhancement
Updated `server.js` `handleStatusUpdate()` to:
- Detect error code **131049** in failed status webhooks
- Look up the abandoned cart by `wamid`
- Mark the cart as `delivery_blocked` (new status)

## New Status: `delivery_blocked`

This status indicates:
- The message was accepted by Meta's API
- But delivery was blocked by Meta's spam protection (error 131049)
- The customer likely hasn't messaged your business recently
- You **cannot** retry sending to this cart via WhatsApp

## How to Use

### Run the migration:
```bash
cd whatsappbot-main
psql "your-connection-string" -f src/database/add_wamid_to_abandoned_carts.sql
```

Or via Supabase dashboard:
1. Go to SQL Editor
2. Copy contents of `src/database/add_wamid_to_abandoned_carts.sql`
3. Run the query

### After deployment:
- New abandoned cart reminders will automatically store the `wamid`
- When error 131049 occurs, the cart will be marked as `delivery_blocked`
- You can query blocked carts:
  ```sql
  SELECT checkout_id, customer_phone, customer_name, status, created_at
  FROM abandoned_carts
  WHERE status = 'delivery_blocked'
  ORDER BY created_at DESC;
  ```

## Prevention Strategies

To reduce 131049 errors:

1. **Encourage opt-ins**: Add WhatsApp opt-in checkboxes at checkout
2. **Send fewer messages**: Consider if both reminders are necessary
3. **Improve timing**: Send reminders when users are more likely to engage
4. **Use high-quality templates**: Ensure templates are approved and well-formatted
5. **Monitor quality rating**: Check your WhatsApp quality rating in Meta Business Manager

## Files Modified

1. `src/database/db.js` - Added wamid columns to schema
2. `src/database/add_wamid_to_abandoned_carts.sql` - Migration script
3. `src/models/AbandonedCart.js` - Added `findByWamid()` and `updateWamid()`
4. `src/services/abandonedCartService.js` - Capture and store wamid
5. `server.js` - Handle error 131049 in webhook status updates

## Testing

After deployment, you can verify the fix by:
1. Checking logs for `🚫 Marked cart ... as delivery_blocked` messages
2. Querying carts with `status = 'delivery_blocked'`
3. Verifying that `first_reminder_wamid` and `second_reminder_wamid` are populated for new sends
