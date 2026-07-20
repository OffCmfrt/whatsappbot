# PRD: Support Ticket Flow Simplification

**Product:** OffComfrt WhatsApp Bot  
**Feature:** Support Ticket Lifecycle — Simplified Customer-Facing Flow  
**Status:** Implemented  
**Date:** June 30, 2026  

---

## Problem Statement

The previous support ticket flow was frustrating for customers:

1. **Annoying button prompts** — When a customer had an open ticket older than 48 hours, every message triggered a "Keep Existing Ticket / Create New Ticket" button prompt before their message was actually sent.
2. **Two-step ticket creation** — When no ticket existed, the bot first asked the customer to "describe your issue", then created the ticket only on the *next* message. This added unnecessary friction.
3. **Confusing UX** — Customers just wanted to send their message and get help, not navigate ticket management UI.

---

## Goals

- Remove all intermediate prompts and button clicks from the ticket flow
- Every customer message should immediately do something useful (create or append to a ticket)
- Give customers a simple text command to create a new ticket when they explicitly want one
- Reduce the number of messages a customer sends before their issue is logged to **one**

---

## New Flow

### Scenario 1: No Open Ticket Exists
**Trigger:** Customer sends any message and has no open support ticket.

**Behavior:**
- A new support ticket is created immediately with the customer's message as the ticket content.
- Customer receives a confirmation with the ticket number.

**Customer sees:**
```
Customer: "I want to return my order"

Bot: ⚫ OFFCOMFRT — SUPPORT
     ▫️ Thank you, <Name>.
     ▫️ Your query has been received.
     ▫️ Ticket Number: TKT-260630-4821
     ▫️ Our team will respond within 24 hours.
```

---

### Scenario 2: Open Ticket Exists — Normal Message
**Trigger:** Customer sends any message and has an open support ticket.

**Behavior:**
- The message is automatically appended to the existing open ticket.
- No confirmation, no prompts — seamless.

**Customer sees:**
```
Customer: "Also, the color was wrong"

(Message is silently appended to the existing ticket — no bot reply)
```

---

### Scenario 3: Open Ticket Exists — Customer Wants a New Ticket
**Trigger:** Customer types **"create new ticket"** (case-insensitive) while an open ticket exists.

**Behavior:**
- The existing open ticket is marked as **resolved**.
- A brand new ticket is created with the message "create new ticket" as the initial content.
- Customer receives a confirmation with the new ticket number.

**Customer sees:**
```
Customer: "create new ticket"

Bot: ⚫ OFFCOMFRT — SUPPORT
     ▫️ New ticket created, <Name>.
     ▫️ Ticket Number: TKT-260630-7193
     ▫️ Our team will respond within 24 hours.
```

---

## Removed Behaviors

| Old Behavior | Status |
|---|---|
| "Keep Existing Ticket / Create New Ticket" button prompt (48h+ tickets) | **Removed** |
| "Please describe your question or issue" first-step prompt | **Removed** |
| `awaiting_ticket_choice` conversation state | **Removed** |
| `awaiting_customer_question` conversation state | **Removed** |
| `append_to_ticket` / `create_new_ticket` button click handlers | **Removed** |

---

## Technical Details

### File Modified
`src/handlers/messageHandler.js` — `processMessage()` method

### Decision Logic (Pseudocode)
```
if (open ticket exists for this phone):
    if (message == "create new ticket"):
        resolve old ticket
        create new ticket with message
        send confirmation
    else:
        append message to existing ticket (silent)
else:
    create new ticket with message
    send confirmation
```

### Database Changes
- No schema changes required.
- `support_tickets.status` is set to `'resolved'` when customer explicitly creates a new ticket.
- `conversations` table no longer uses `awaiting_ticket_choice` or `awaiting_customer_question` states for this flow.

### Ticket Number Format
`TKT-YYMMDD-XXXX` where:
- `YYMMDD` = date of creation
- `XXXX` = random 4-digit number (with collision retry up to 5 attempts, then epoch-ms fallback)

---

## Edge Cases

| Case | Handling |
|---|---|
| Customer sends "Create New Ticket" (capitalized) | Works — comparison is case-insensitive |
| Customer has multiple open tickets | Only the most recent open ticket is considered |
| Customer types "create new ticket" with no open ticket | Falls into Scenario 1 — creates a new ticket normally |
| Ticket already resolved by admin before customer sends | Falls into Scenario 1 — creates a new ticket |

---

## Future Considerations

- **Additional aliases** for new ticket command: "new ticket", "new issue", "different issue"
- **Ticket status visibility**: Let customers check their ticket status via a command
- **Auto-resolve stale tickets**: Automatically resolve tickets older than N days to keep the queue clean
