
# AI Copilot Pro -- Full-Screen Command Center

## Current State

The copilot is a 380x540px floating panel (`ai-copilot.js`) with:
- Basic chat interface calling `/api/admin/ai/chat`
- Simple learned replies manager (pin/edit/delete)
- Suggest-reply button injected into support chat modals
- Backend: `agent.js` (tool-calling loop), `tools.js` (14 tools), `aiStore.js`, `learning.js`, `suggestReply.js`

Both admin dashboard and shoppers hub use near-identical frontend code (the shoppers version is a dark-themed copy with hardcoded Render URL).

---

## 1. New Full-Page Route -- `/ai-copilot`

### 1.1 Backend route registration
- **`server.js`**: Serve the new copilot page for authenticated users at `/ai-copilot`
- **Admin dashboard** (`public/dashboard/index.html`): Add a sidebar/nav link "AI Copilot" that navigates to `/ai-copilot`
- **Shoppers Hub** (`public/portal/index.html`): Same nav link addition

### 1.2 New page: `public/dashboard/ai-copilot.html`
A full-page layout with:
- **Left sidebar** (240px, collapsible on mobile) with 5 sections:
  - **Chat** -- the conversational copilot (upgraded from the floating panel)
  - **Training** -- detailed panel to train the AI (learned replies, golden examples, bulk import)
  - **Actions** -- quick-action launcher for batch operations
  - **Analytics** -- AI usage stats, insight cards, ticket category analysis
  - **Workflows** -- visual automation builder (simplified rule-based, not full Zapier)
- **Main content area** that renders the selected section
- Top bar with model info, daily usage indicator, and settings gear

### 1.3 New page: `public/portal/ai-copilot.html`
Same structure, dark-themed to match the Shoppers Hub, with shoppers-specific action set.

---

## 2. Chat Section (Upgraded)

Reuse the existing `/api/admin/ai/chat` backend. The chat UI gets:
- **Full-height conversation** (no 540px cap)
- **Rich message rendering**: tables for data results, colored status badges for ticket/shipment updates, inline tracking timelines
- **Action confirmation cards** (upgraded from current yellow box): show a structured preview of what will happen (e.g., "Will send WhatsApp to +91 XXXXX to 12 recipients") with expand/collapse
- **Quick-action chips** above the input: pre-built prompts like "Open tickets today", "Pending shipments", "Top customer issues this week"
- **Conversation branching**: save useful conversations as training examples with one click

Files: `public/dashboard/js/ai-copilot-pro/chat.js`

---

## 3. Training Panel

A dedicated section to teach and curate the AI, replacing the current basic learned-replies overlay.

### 3.1 Learned Replies Manager (upgraded)
- **Table view** with columns: Question Pattern, Approved Reply, Uses, Resolved Boost, Pinned, Last Updated
- **Inline editing** (no more `prompt()` dialogs)
- **Bulk actions**: select multiple rows to pin/unpin/delete/export
- **CSV/JSON import**: upload a file of Q&A pairs to bulk-train the AI
- **Filter/sort**: by category, usage count, date, pinned status
- **Test mode**: type a customer question and see which learned examples the AI would retrieve (uses `/ai/learned` + `findSimilarExamples`)

### 3.2 Golden Examples
- Hand-curated, pinned examples with variable placeholders (`{{order_id}}`, `{{name}}`, etc.)
- Visual placeholder highlighter (shows variables in a distinct color)
- Preview how a golden example renders with real customer data

### 3.3 AI Behavior Settings
- Toggle AI on/off
- Adjust tone (formal/casual/bilingual)
- Set max daily limits
- Configure which tools the AI can use (checkboxes)
- Enable/disable specific tool categories (read-only vs actions)

Backend additions needed in `adminRoutes.js`:
- `POST /ai/learned/import` -- bulk CSV/JSON import
- `GET /ai/learned/test` -- test retrieval for a question
- `PUT /ai/settings` -- save AI behavior settings

Files: `public/dashboard/js/ai-copilot-pro/training.js`

---

## 4. Actions Panel -- Batch Operations & Quick Actions

### 4.1 Admin Dashboard Actions
- **Batch ticket operations**: Select criteria (status, date range, portal) and bulk resolve/close/assign tickets
- **Bulk WhatsApp**: Compose a message, select audience segment (all customers, open tickets, specific portal), preview recipient count, send with confirmation
- **Broadcast campaign creator**: Title, message, segment selection, schedule/send-later, all from within the copilot
- **Shipment batch actions**: List unshipped orders, select carrier, book shipments in bulk
- **Smart ticket triage**: AI analyzes open tickets and suggests category + priority + auto-assign to portals

### 4.2 Shoppers Hub Actions
- **Order management**: View pending orders, bulk update status, mark as shipped
- **Shipment operations**: Book shipments, schedule pickups, track AWBs -- all from the copilot
- **Customer communication**: Send WhatsApp updates to shoppers about their orders
- **Inventory alerts**: AI flags low-stock or out-of-stock items from recent orders

Each action shows a confirmation preview before execution. All mutating actions go through the existing pending-action confirmation flow.

New backend tools needed in `tools.js`:
- `batch_update_tickets` -- requiresConfirmation
- `bulk_send_whatsapp` -- requiresConfirmation  
- `batch_book_shipments` -- requiresConfirmation
- `smart_triage_tickets` -- read-only (returns AI analysis)
- `get_pending_shipments` -- read-only (for shoppers hub)

New backend routes in `adminRoutes.js`:
- `POST /ai/action/batch-tickets`
- `POST /ai/action/bulk-whatsapp`
- `POST /ai/action/batch-shipments`
- `GET /ai/action/pending-shipments`

Files: `public/dashboard/js/ai-copilot-pro/actions.js`

---

## 5. Analytics & Insights Section

### 5.1 AI Usage Dashboard
- Daily/weekly usage chart (reuse existing `/ai/usage` endpoint + Chart.js already in the dashboard)
- Cost tracking (the `cost_usd` column already exists in `ai_usage_log`)
- Tool usage breakdown (which tools are called most)
- Response quality indicators (confirmation rate, error rate)

### 5.2 Smart Insights (new)
- **Ticket category analysis**: AI groups open tickets by topic and shows a pie chart
- **Resolution time trends**: Average time-to-resolve per portal/agent
- **Top customer questions**: Most frequently asked questions (from `ai_learned_replies` sorted by uses)
- **Suggestions**: AI-generated recommendations (e.g., "3 new golden examples suggested from resolved tickets this week", "Consider adding FAQ for: COD delivery time")

New backend route:
- `GET /ai/insights` -- returns aggregated analytics + AI-generated insights

Files: `public/dashboard/js/ai-copilot-pro/analytics.js`

---

## 6. Workflows Section (Simplified Automation Builder)

A visual rule builder (not full Zapier, but practical):
- **Rule card**: "When [trigger] then [AI action]"
- **Triggers**: new ticket created, ticket unresolved for X hours, new message from VIP customer, shipment delivered
- **Actions**: auto-reply, update ticket status, notify admin, book shipment
- **Toggle on/off per rule**
- Rules stored in a new `ai_workflows` table

New backend:
- `ai_workflows` table (id, name, trigger_type, trigger_config, action_type, action_config, enabled, created_at)
- CRUD routes: `GET/POST/PUT/DELETE /ai/workflows`
- A cron-friendly function that checks trigger conditions and fires actions

Files: `public/dashboard/js/ai-copilot-pro/workflows.js`

---

## 7. Shoppers Hub Integration

The Shoppers Hub gets the same full-page copilot at `/portal/ai-copilot` with:
- Dark theme (matching existing `shoppers-ai-copilot.js` palette: `#005c4b`, `#111b21`)
- Shoppers-specific tools: `get_pending_shipments`, `batch_book_shipments`, order status updates
- Same backend API (the shoppers hub already calls `/api/admin/ai/*`)
- The FAB on the shoppers portal links to the full-page copilot instead of the small panel

---

## 8. File Structure

```
public/dashboard/
  ai-copilot.html                    -- new full-page copilot (admin)
  js/ai-copilot-pro/
    app.js                           -- main app shell (sidebar, routing, init)
    chat.js                          -- upgraded chat section
    training.js                      -- training panel
    actions.js                       -- batch operations & quick actions
    analytics.js                     -- usage charts & insights
    workflows.js                     -- automation builder

public/portal/
  ai-copilot.html                    -- new full-page copilot (shoppers hub, dark theme)
  js/ai-copilot-pro/
    app.js                           -- same structure, shoppers-themed
    chat.js
    training.js
    actions.js
    analytics.js
    workflows.js

src/services/ai/
  tools.js                           -- add new batch/bulk tools
  workflows.js                       -- new: workflow engine
  insights.js                        -- new: analytics aggregation

src/routes/
  adminRoutes.js                     -- add new AI routes for training, actions, insights, workflows
```

---

## 9. Implementation Order

1. **Backend**: New tools (`batch_update_tickets`, `bulk_send_whatsapp`, `batch_book_shipments`, `smart_triage_tickets`, `get_pending_shipments`), new routes (training import, insights, workflows CRUD), `ai_workflows` table migration
2. **Admin full-page shell**: `ai-copilot.html` + `app.js` with sidebar navigation
3. **Chat section**: `chat.js` -- port existing panel logic to full-page with rich rendering
4. **Training panel**: `training.js` -- table view, inline edit, bulk ops, CSV import, test mode
5. **Actions panel**: `actions.js` -- batch operations UI
6. **Analytics section**: `analytics.js` -- charts and insights
7. **Workflows section**: `workflows.js` -- rule builder
8. **Shoppers Hub**: Port everything to `public/portal/ai-copilot.html` with dark theme
9. **Integration**: Update FABs in both dashboards to link to the full-page copilot; keep the suggest-reply button in chat modals as-is

---

## 10. Key Design Decisions

- **No new dependencies**: Use existing Chart.js (already in dashboard), vanilla JS (no React/Vue), existing Express routes
- **Backward compatible**: The existing `ai-copilot.js` and `shoppers-ai-copilot.js` remain functional; the FAB is updated to navigate to the full-page copilot
- **Security**: All mutating batch actions go through the existing pending-action confirmation flow (same as current single-action confirms)
- **Memory-safe**: Batch operations capped at 100 items per call; workflow engine uses the existing queue pattern
- **Mobile responsive**: Sidebar collapses to a bottom nav on screens < 768px
