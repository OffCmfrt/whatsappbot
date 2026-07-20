# Direct Support Ticket Bot

## Goal
Replace the long routing pipeline in [processMessage](file:///c:/Users/SARVESH/Desktop/OFFcomfrt/whatsappbot-main/src/handlers/messageHandler.js#L31-L279) with a thin path that creates a support ticket on every inbound message. Order-confirmation template buttons (`shop_confirm`, `shop_cancel`, `shop_edit`) and their follow-up state (`awaiting_edit_details`) keep working exactly as today.

## Scope
- File touched: `src/handlers/messageHandler.js` only.
- No DB schema change. `support_tickets` already has `ticket_number`, `customer_phone`, `customer_name`, `message`, `status='open'`, `is_read=0` ([turso_schema.sql L108-L120](file:///c:/Users/SARVESH/Desktop/OFFcomfrt/whatsappbot-main/src/database/turso_schema.sql#L108-L120)).
- Webhook entry stays the same: `server.js` line 223 → `messageHandler.processMessage(from, messageBody, senderName)`.

## Task 1 — Identify what to KEEP in `processMessage`
These blocks remain unchanged:
1. `sanitizeInput` + early return on empty.
2. `Customer.getOrCreate(phone, senderName)`.
3. Incoming-message logging (`logMessage`).
4. **Conversation lock / 48h quiet period** block (lines 47-64) — still blocks automated replies during quiet period and still lets `shop_confirm` / `shop_cancel` / `shop_edit` / `confirm order` / `cancel order` / `edit details` buttons pass through.
5. `awaiting_edit_details` state handler (lines 172-224) — required because `shop_edit` sets this state; it must keep capturing the customer's edit text into `store_shoppers`.
6. Button-command routing for `shop_confirm`, `shop_cancel`, `shop_edit` ONLY → forwarded to existing `handleCommand` cases (lines 367-473). Those cases stay byte-for-byte identical.

## Task 2 — Remove the automated routing branches
Delete from `processMessage` (in this order):
- New-user language prompt block (lines 67-74).
- `lang_*` selection block (lines 80-91).
- `LanguageService.isLanguageCommand` branch (lines 94-97).
- Generic `isCommand` → `handleCommand` branch (lines 100-104). Replace with a narrow whitelist that only matches the three shopper button IDs (case-insensitive).
- `awaiting_support_query` state block (lines 116-169) — no longer needed because every message now becomes a ticket. Also drop the `orderId && convState==='awaiting_support_query'` shortcut.
- `returnExchangeHandler.handle` (lines 229-230).
- `handleSizeQuery` call (lines 233-234).
- `faqHandler.handle` (lines 237-238).
- Pure-phone-number → order history (lines 241-251).
- `extractOrderId` → order status lookup (lines 253-257).
- Fallback "type *help* or *menu*" prompt (lines 260-263).

## Task 3 — Insert the direct ticket-creation path
After the conversation-lock check, the `awaiting_edit_details` handler, and the shop_* button passthrough, the function ends with this single block (mirrors current lines 128-168, kept identical so behavior is well-tested):

```js
// Default path: every other inbound message becomes a support ticket
const name = customer.name || senderName || 'Customer';

// Append to an existing OPEN ticket if one exists
const existingTicket = await dbAdapter.query(
    'SELECT id, ticket_number FROM support_tickets WHERE customer_phone = ? AND status = ? ORDER BY created_at DESC LIMIT 1',
    [phone, 'open']
);

if (existingTicket && existingTicket.length > 0) {
    const ticketId = existingTicket[0].id;
    const existingNumber = existingTicket[0].ticket_number;
    await dbAdapter.query(
        `UPDATE support_tickets
         SET message = message || '\n\n---\n' || ?,
             is_read = 0,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [cleanMessage, ticketId]
    );
    await whatsappService.sendMessage(
        phone,
        `⚫ *OFFCOMFRT — SUPPORT*\n\n▫️ *Thank you, ${name}.*\n▫️ Your message has been added to ticket *${existingNumber}*.\n▫️ Our team will respond within *24 hours*.\n▫️ If urgent, write to *support@offcomfrt.in*.`
    );
} else {
    const ticketNumber = generateTicketNumber();
    await dbAdapter.query(
        'INSERT INTO support_tickets (ticket_number, customer_phone, customer_name, message, is_read) VALUES (?, ?, ?, ?, 0)',
        [ticketNumber, phone, name, cleanMessage]
    );
    await whatsappService.sendMessage(
        phone,
        `⚫ *OFFCOMFRT — SUPPORT*\n\n▫️ *Thank you, ${name}.*\n▫️ Your query has been received.\n▫️ Ticket Number: *${ticketNumber}*\n\n▫️ Our team will respond within *24 hours*.\n▫️ If urgent, write to *support@offcomfrt.in*.`
    );
}
return;
```

The existing `generateTicketNumber()` helper at the top of the file is reused.

## Task 4 — Trim now-unused imports / methods
- Remove top-level requires that become dead: `orderStatusHandler`, `orderHistoryHandler`, `faqHandler`, `followUpService` (only used by [updateFollowUpResponse](file:///c:/Users/SARVESH/Desktop/OFFcomfrt/whatsappbot-main/src/handlers/messageHandler.js#L618-L664) — keep that and its require), `returnExchangeHandler`, `welcomeMessage`/`helpMessage` template imports, and `extractOrderId` from validators.
  - Keep `LanguageService` (still used by `shop_*` cases? — re-check). It is referenced by `handleCommand` `welcome/menu/help/status/menu_language/menu_contact_support` cases. Since `processMessage` will no longer route to those cases, those branches in `handleCommand` become unreachable but are safe to leave. To keep the diff small, **leave `handleCommand` and its other cases as-is**; only `processMessage` is rewired.
- Methods like `handleSizeQuery`, `handleUnsubscribe`, `sendMainMenu`, `sendRichResponse`, `handleLanguageSelection` stay in the file (no caller from new flow, but they cause no harm and are referenced in `handleCommand`). Removing them is outside the requested scope.

## Task 5 — Manual verification (after edits)
1. Send a normal text from a fresh number → expect a new `TKT-YYYY-XXXX` ticket reply, no menu, no FAQ.
2. Send a second text from the same number while ticket is `open` → expect "added to ticket TKT-..." reply, single row in DB with both messages joined by `---`.
3. Trigger an order confirmation template, click **Confirm Order** → expect the existing "Order Confirmed" message; no ticket created.
4. Click **Edit Details**, then send a free-text edit → expect "Edit Request Received"; the text is stored in `store_shoppers.customer_message`, not in `support_tickets`.
5. With `conversation_lock_until` set in the future for a phone, send a non-button text → expect zero outbound messages (quiet period still honored).

## Out of Scope
- Dashboard / portal UI changes.
- Removing dead methods or template files.
- Any change to webhook signature verification, broadcast, abandoned-cart, or follow-up cron flows.
