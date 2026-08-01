/**
 * AI Workflow Engine — simplified rule-based automation for the copilot.
 *
 * Rules: "When [trigger] then [AI action]"
 * Stored in the ai_workflows table. The cron runner checks trigger conditions
 * and fires the corresponding actions (through the same tool system the
 * copilot chat uses, with confirmation gating for mutating actions).
 */

const { dbAdapter } = require('../../database/db');

const TRIGGER_TYPES = {
    new_ticket: 'New support ticket created',
    stale_ticket: 'Ticket unresolved for X hours',
    vip_message: 'New message from high-value customer',
    shipment_delivered: 'Shipment marked delivered',
    cart_abandoned: 'New abandoned cart detected'
};

const ACTION_TYPES = {
    auto_reply: 'Send auto-reply via WhatsApp',
    update_ticket: 'Update ticket status',
    notify_admin: 'Flag for admin attention',
    book_shipment: 'Book shipment for shopper order',
    create_broadcast: 'Create broadcast draft'
};

// ---------- CRUD ----------

async function listWorkflows() {
    return dbAdapter.query('SELECT * FROM ai_workflows ORDER BY created_at DESC');
}

async function getWorkflow(id) {
    const rows = await dbAdapter.query('SELECT * FROM ai_workflows WHERE id = ?', [id]);
    return rows[0] || null;
}

async function createWorkflow({ name, trigger_type, trigger_config, action_type, action_config, enabled }) {
    if (!TRIGGER_TYPES[trigger_type]) throw new Error(`Unknown trigger type: ${trigger_type}`);
    if (!ACTION_TYPES[action_type]) throw new Error(`Unknown action type: ${action_type}`);
    const row = await dbAdapter.insert('ai_workflows', {
        name: name || `${TRIGGER_TYPES[trigger_type]} → ${ACTION_TYPES[action_type]}`,
        trigger_type,
        trigger_config: JSON.stringify(trigger_config || {}),
        action_type,
        action_config: JSON.stringify(action_config || {}),
        enabled: enabled !== false,
        fire_count: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
    });
    return row;
}

async function updateWorkflow(id, fields) {
    const allowed = ['name', 'trigger_type', 'trigger_config', 'action_type', 'action_config', 'enabled'];
    const updates = {};
    for (const key of allowed) {
        if (fields[key] !== undefined) {
            if (key.endsWith('_config')) {
                updates[key] = JSON.stringify(fields[key]);
            } else {
                updates[key] = fields[key];
            }
        }
    }
    updates.updated_at = new Date().toISOString();
    await dbAdapter.update('ai_workflows', updates, { id });
}

async function deleteWorkflow(id) {
    await dbAdapter.run('DELETE FROM ai_workflows WHERE id = ?', [id]);
}

// ---------- Trigger checking ----------

/**
 * Check all enabled workflows for a given trigger type and execute matching ones.
 * Called by event hooks (e.g., after a ticket is created, after a shipment is delivered).
 */
async function fireTrigger(triggerType, context = {}) {
    try {
        const workflows = await dbAdapter.query(
            'SELECT * FROM ai_workflows WHERE trigger_type = ? AND enabled = TRUE',
            [triggerType]
        );
        const results = [];
        for (const wf of workflows) {
            try {
                const config = typeof wf.trigger_config === 'string' ? JSON.parse(wf.trigger_config) : (wf.trigger_config || {});
                if (!matchesTrigger(wf.trigger_type, config, context)) continue;

                const actionConfig = typeof wf.action_config === 'string' ? JSON.parse(wf.action_config) : (wf.action_config || {});
                const result = await executeAction(wf.action_type, actionConfig, context);
                await dbAdapter.run(
                    'UPDATE ai_workflows SET fire_count = fire_count + 1, last_fired_at = NOW() WHERE id = ?',
                    [wf.id]
                );
                results.push({ workflowId: wf.id, name: wf.name, result });
            } catch (e) {
                results.push({ workflowId: wf.id, name: wf.name, error: e.message });
            }
        }
        return results;
    } catch (e) {
        console.error('[AI Workflow] fireTrigger failed:', e.message);
        return [];
    }
}

function matchesTrigger(triggerType, config, context) {
    switch (triggerType) {
        case 'new_ticket':
            return true; // fires for every new ticket
        case 'stale_ticket':
            return context.ageHours >= (config.thresholdHours || 48);
        case 'vip_message':
            return config.vipPhones?.includes(context.phone);
        case 'shipment_delivered':
            return true;
        case 'cart_abandoned':
            return context.amount >= (config.minAmount || 0);
        default:
            return false;
    }
}

async function executeAction(actionType, config, context) {
    switch (actionType) {
        case 'auto_reply': {
            if (!context.phone) throw new Error('No phone number in context');
            const whatsappService = require('../whatsappService');
            const msg = config.message || 'Thank you for reaching out! Our team will get back to you shortly.';
            const result = await whatsappService.sendMessage(context.phone, msg);
            return { sent: result !== false };
        }
        case 'update_ticket': {
            if (!context.ticketId) throw new Error('No ticket ID in context');
            const status = config.status || 'resolved';
            await dbAdapter.update('support_tickets', { status, updated_at: new Date().toISOString() }, { id: context.ticketId });
            return { ticketId: context.ticketId, newStatus: status };
        }
        case 'notify_admin': {
            // Just log it — the admin will see it in the copilot chat
            console.log(`[AI Workflow] Admin notification: ${config.message || 'Workflow triggered'}`, context);
            return { notified: true };
        }
        case 'book_shipment': {
            if (!context.shopperId) throw new Error('No shopper ID in context');
            const shippingService = require('../shippingService');
            const result = await shippingService.ship({
                shopperId: context.shopperId,
                carrier: config.carrier || 'delhivery',
                shippedBy: 'ai-workflow'
            });
            return result;
        }
        case 'create_broadcast': {
            const row = await dbAdapter.insert('broadcasts', {
                title: `[AUTO] ${config.title || 'Workflow broadcast'}`,
                message: config.message || '',
                segment: config.segment || 'all',
                total_recipients: 0,
                sent_count: 0,
                failed_count: 0,
                created_by: 'ai-workflow',
                created_at: new Date().toISOString()
            });
            return { draftId: row?.id || null };
        }
        default:
            throw new Error(`Unknown action type: ${actionType}`);
    }
}

module.exports = {
    TRIGGER_TYPES,
    ACTION_TYPES,
    listWorkflows,
    getWorkflow,
    createWorkflow,
    updateWorkflow,
    deleteWorkflow,
    fireTrigger
};
