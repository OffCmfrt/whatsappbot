const whatsappService = require('../services/whatsappService');
const followUpService = require('../services/followUpService');
const LanguageService = require('../services/languageService');
const Customer = require('../models/Customer');
const { dbAdapter } = require('../database/db');
const { sanitizeInput } = require('../utils/validators');

// Generate unique ticket number
function generateTicketNumber() {
    const year = new Date().getFullYear();
    const random = Math.floor(Math.random() * 9000 + 1000); // 4-digit random number
    return `TKT-${year}-${random}`;
}

class MessageHandler {
    // Main message processing entry point
    // Behavior: every inbound text creates (or appends to) a support ticket.
    // Exceptions: order-template button clicks (shop_confirm/cancel/edit) keep
    // their original automation, and the 48h conversation lock is still honored.
    async processMessage(phone, message, senderName = null) {
        try {
            // Sanitize input
            const cleanMessage = sanitizeInput(message);

            if (!cleanMessage) return;

            // Ensure customer exists in database
            const customer = await Customer.getOrCreate(phone, senderName);

            // Log incoming message for analytics/support
            console.log(`📥 [${phone}] ${senderName || 'User'}: "${cleanMessage}"`);
            await this.logMessage(phone, cleanMessage, 'incoming');

            // Identify shopper template-button clicks (these keep their existing flow)
            const buttonCommandMap = {
                'shop_confirm': 'shop_confirm',
                'confirm order': 'shop_confirm',
                'shop_cancel': 'shop_cancel',
                'cancel order': 'shop_cancel',
                'shop_edit': 'shop_edit',
                'edit details': 'shop_edit',
                'edit details(size, add.)': 'shop_edit'
            };
            const buttonCommand = buttonCommandMap[cleanMessage.toLowerCase()] || null;

            // Check if customer has an active conversation lock (48-hour quiet period)
            // This prevents bot automation after order confirmation template is sent
            const activeLock = await dbAdapter.query(
                'SELECT id, order_id, conversation_lock_until FROM store_shoppers WHERE phone = ? AND conversation_lock_until > datetime(\'now\') ORDER BY created_at DESC LIMIT 1',
                [phone]
            );

            if (activeLock && activeLock.length > 0) {
                if (!buttonCommand) {
                    console.log(`[QUIET PERIOD] Blocking automated response for ${phone} (locked until ${activeLock[0].conversation_lock_until})`);
                    return;
                }
                console.log(`[QUIET PERIOD] Allowing button click: ${cleanMessage} for ${phone}`);
            }

            // Get conversation state — still needed so the edit-details capture
            // (set by the shop_edit case) can collect the customer's free-text edit.
            const convRows = await dbAdapter.query(
                'SELECT state FROM conversations WHERE customer_phone = ? ORDER BY updated_at DESC LIMIT 1',
                [phone]
            );
            const convState = convRows?.[0]?.state || null;

            // Capture edit-details follow-up text after the customer pressed Edit Details
            if (convState === 'awaiting_edit_details' && !buttonCommand) {
                const now = new Date().toISOString();
                try {
                    const convContextRows = await dbAdapter.query(
                        'SELECT context FROM conversations WHERE customer_phone = ? ORDER BY updated_at DESC LIMIT 1',
                        [phone]
                    );
                    let targetOrderId = null;
                    try {
                        const context = JSON.parse(convContextRows?.[0]?.context || '{}');
                        targetOrderId = context.order_id;
                    } catch (e) {}

                    const shopperRows = await dbAdapter.query(
                        'SELECT response_count, customer_message FROM store_shoppers WHERE phone = ? AND order_id = ?',
                        [phone, targetOrderId]
                    );
                    const currentCount = shopperRows?.[0]?.response_count || 0;
                    const existingMessage = shopperRows?.[0]?.customer_message || '';
                    const updatedMessage = existingMessage
                        ? `${existingMessage}\n---\n${cleanMessage}`
                        : cleanMessage;

                    await dbAdapter.query(
                        `UPDATE store_shoppers 
                         SET customer_message = ?, 
                             last_response_at = ?,
                             response_count = ?
                         WHERE phone = ? AND order_id = ?`,
                        [updatedMessage, now, currentCount + 1, phone, targetOrderId]
                    );
                    console.log(`[EDIT] Captured edit request from ${phone} for order ${targetOrderId}: ${cleanMessage.substring(0, 50)}...`);
                } catch (dbErr) {
                    console.error('[EDIT] Failed to save edit request:', dbErr.message);
                }

                await dbAdapter.query(
                    'UPDATE conversations SET state = NULL WHERE customer_phone = ?',
                    [phone]
                );

                await whatsappService.sendMessage(
                    phone,
                    `📝 *Edit Request Received*\n\n▫️ *Thank you!*\n▫️ Your request has been saved:\n"${cleanMessage.substring(0, 100)}${cleanMessage.length > 100 ? '...' : ''}"\n\n▫️ Our team will review and update your order.`
                );
                return;
            }

            // Route the three shopper button clicks to their existing handlers
            if (buttonCommand) {
                const lang = customer.preferred_language || 'en';
                await this.handleCommand(phone, buttonCommand, senderName, lang);
                return;
            }

            // Default path: every other inbound message becomes a support ticket
            const name = customer.name || senderName || 'Customer';

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

        } catch (error) {
            console.error(`❌ [${phone}] Error processing message:`, error.message);
            if (error.response?.data) console.error('Meta API Error Details:', JSON.stringify(error.response.data, null, 2));

            // Best-effort fallback notification
            try {
                await whatsappService.sendMessage(
                    phone,
                    '📱 *OffComfrt*\n\n▫️ We encountered an issue processing your request.\n▫️ Please try again or write to *support@offcomfrt.in*.'
                );
            } catch (sentErr) {
                console.error(`❌ [${phone}] Even fallback message failed:`, sentErr.message);
            }
        }
    }

    // Handle specific commands
    async handleCommand(phone, command, senderName, lang = 'en') {
        const { dbAdapter } = require('../database/db');
        const getDynamicTemplate = async (key, defaultFunc) => {
            try {
                const config = await dbAdapter.query('SELECT * FROM automation_config WHERE key = ?', [key]);
                if (config && config.length > 0) return JSON.parse(config[0].content);
            } catch (err) {}
            return { answer: defaultFunc(senderName) };
        };

        switch (command) {
            case 'welcome': {
                await this.sendMainMenu(phone, senderName, lang);
                break;
            }

            case 'menu': {
                await this.sendMainMenu(phone, senderName, lang);
                break;
            }

            case 'help': {
                // If user is non-English, use the translation. Otherwise, allow DB override for English.
                let helpMessageText;
                if (lang === 'en') {
                    const templateData = await getDynamicTemplate('help_message', helpMessage);
                    helpMessageText = templateData.answer || templateData.content;
                } else {
                    helpMessageText = LanguageService.translate('help', lang);
                }
                
                await this.sendRichResponse(phone, { answer: helpMessageText }, senderName);
                break;
            }

            case 'support': {
                // Trigger support ticket flow
                try {
                    await dbAdapter.query(
                        'INSERT OR REPLACE INTO conversations (customer_phone, state, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)',
                        [phone, 'awaiting_support_query']
                    );
                    console.log(`[SUPPORT] State set for ${phone}: awaiting_support_query`);
                } catch (dbErr) {
                    console.error('[SUPPORT] Failed to set conversation state:', dbErr.message);
                }
                const supportMsg = lang !== 'en'
                    ? `📱 *OffComfrt*\n\n${LanguageService.translate('help', lang).split('\n')[0]}\n\n▫️ Please type your question below.\n▫️ Our team will respond within *24 hours*.`
                    : `🎧 *Contact Support*\n\n▫️ Please type your question or concern below and send it.\n\n▫️ Our team will review and respond within *24 hours*.`;
                await whatsappService.sendMessage(phone, supportMsg);
                break;
            }

            case 'history':
                await orderHistoryHandler.handle(phone, null, lang);
                break;

            case 'status': {
                const statusPrompt = lang === 'en'
                    ? '📱 *OffComfrt*\n\n▫️ Please send your *Order ID* or AWB number to check status.\n\n▫️ Or select an option below.'
                    : '📱 *OffComfrt*\n\n' + LanguageService.translate('orderStatus', lang) + '\n\n▫️ Please send your Order ID or AWB number.';
                await whatsappService.sendListMessage(
                    phone,
                    statusPrompt,
                    'Menu',
                    [{
                        title: 'Orders',
                        rows: [
                            { id: 'track_order', title: 'Track Order', description: 'Track your current order' },
                            { id: 'order_history', title: 'My Orders', description: 'View all your orders' }
                        ]
                    }],
                    null,
                    null
                );
                break;
            }

            case 'unsubscribe':
                await this.handleUnsubscribe(phone);
                break;

            case 'menu_language':
                await this.handleLanguageSelection(phone, null, null);
                break;

            case 'menu_contact_support': {
                try {
                    await dbAdapter.query(
                        'INSERT OR REPLACE INTO conversations (customer_phone, state, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)',
                        [phone, 'awaiting_support_query']
                    );
                    console.log(`[SUPPORT] State set for ${phone}: awaiting_support_query`);
                } catch (dbErr) {
                    console.error('[SUPPORT] Failed to set conversation state:', dbErr.message);
                }
                const supportMsg = lang !== 'en'
                    ? `📱 *OffComfrt*\n\n${LanguageService.translate('help', lang).split('\n')[0]}\n\n▫️ Please type your question below.\n▫️ Our team will respond within *24 hours*.`
                    : `🎧 *Contact Support*\n\n▫️ Please type your question or concern below and send it.\n\n▫️ Our team will review and respond within *24 hours*.`;
                await whatsappService.sendMessage(phone, supportMsg);
                break;
            }

            case 'shop_confirm': {
                const confirmMsg = "Customer confirmed order via WhatsApp";
                const now = new Date().toISOString();
                
                // First, find the most recent PENDING order for this customer
                const pendingOrders = await dbAdapter.query(
                    'SELECT id, order_id FROM store_shoppers WHERE phone = ? AND status = \'pending\' ORDER BY created_at DESC LIMIT 1',
                    [phone]
                );
                
                if (!pendingOrders || pendingOrders.length === 0) {
                    console.log(`[WARN] No pending order found for ${phone} to confirm`);
                    await whatsappService.sendMessage(phone, "⚠️ *No Pending Orders*\n\n▫️ You don't have any pending orders to confirm.\n▫️ If you have multiple orders, please confirm each one separately.");
                    break;
                }
                
                const targetOrderId = pendingOrders[0].id;
                console.log(`[CONFIRM] Confirming order ${targetOrderId} for ${phone}`);
                
                // Update only that specific order
                await dbAdapter.query(
                    `UPDATE store_shoppers 
                     SET status = 'confirmed', 
                         updated_at = ?,
                         confirmed_by = 'whatsapp',
                         customer_message = COALESCE(customer_message || '\n---\n', '') || ?,
                         response_count = COALESCE(response_count, 0) + 1,
                         last_response_at = ?
                     WHERE id = ?`,
                    [now, confirmMsg, now, targetOrderId]
                );
                
                // Update follow-up recipients if this was from a follow-up campaign
                await this.updateFollowUpResponse(phone, 'confirmed');
                
                await whatsappService.sendMessage(phone, "✅ *Order Confirmed*\n\n▫️ *Thank you for confirming your order.*\n▫️ We are processing it and will notify you once it has been shipped.");
                break;
            }

            case 'shop_cancel': {
                const cancelMsg = "Customer requested cancellation via WhatsApp";
                const now = new Date().toISOString();
                
                // First, find the most recent PENDING order for this customer
                const pendingOrders = await dbAdapter.query(
                    'SELECT id, order_id FROM store_shoppers WHERE phone = ? AND status = \'pending\' ORDER BY created_at DESC LIMIT 1',
                    [phone]
                );
                
                if (!pendingOrders || pendingOrders.length === 0) {
                    console.log(`[WARN] No pending order found for ${phone} to cancel`);
                    await whatsappService.sendMessage(phone, "⚠️ *No Pending Orders*\n\n▫️ You don't have any pending orders to cancel.\n▫️ If you need help with an existing order, please contact support.");
                    break;
                }
                
                const targetOrderId = pendingOrders[0].id;
                console.log(`[CANCEL] Cancelling order ${targetOrderId} for ${phone}`);
                
                // Update only that specific order
                await dbAdapter.query(
                    `UPDATE store_shoppers 
                     SET status = 'cancelled', 
                         updated_at = ?,
                         confirmed_by = 'whatsapp',
                         customer_message = COALESCE(customer_message || '\n---\n', '') || ?,
                         response_count = COALESCE(response_count, 0) + 1,
                         last_response_at = ?
                     WHERE id = ?`,
                    [now, cancelMsg, now, targetOrderId]
                );
                
                // Update follow-up recipients if this was from a follow-up campaign
                await this.updateFollowUpResponse(phone, 'cancelled');
                
                await whatsappService.sendMessage(phone, "❌ *Order Cancellation*\n\n▫️ *Order Cancellation Request Received.*\n▫️ Our team will process the cancellation.\n▫️ If the order has not been shipped yet, it will be cancelled shortly.");
                break;
            }

            case 'shop_edit': {
                // Find the most recent order for this customer to edit
                const recentShopper = await dbAdapter.query(
                    'SELECT id, order_id FROM store_shoppers WHERE phone = ? ORDER BY created_at DESC LIMIT 1',
                    [phone]
                );
                const targetOrderId = recentShopper?.[0]?.order_id || null;
                const targetShopperId = recentShopper?.[0]?.id || null;
                
                if (targetShopperId) {
                    await dbAdapter.update('store_shoppers', { status: 'edit_details', updated_at: new Date().toISOString(), confirmed_by: 'whatsapp' }, { id: targetShopperId });
                }
                
                // Update follow-up recipients if this was from a follow-up campaign
                await this.updateFollowUpResponse(phone, 'edit_details');
                
                // Set conversation state to capture the edit request message
                try {
                    await dbAdapter.query(
                        'INSERT OR REPLACE INTO conversations (customer_phone, state, context, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)',
                        [phone, 'awaiting_edit_details', JSON.stringify({ order_id: targetOrderId })]
                    );
                    console.log(`[EDIT] State set for ${phone}: awaiting_edit_details (order: ${targetOrderId})`);
                } catch (dbErr) {
                    console.error('[EDIT] Failed to set conversation state:', dbErr.message);
                }
                await whatsappService.sendMessage(phone, "📝 *Edit Order Details*\n\n▫️ *Edit Details Requested.*\n▫️ Please type the changes you would like to make (address, size, etc.)\n▫️ Our support team will update it for you.");
                break;
            }

            default:
                // Don't automatically send menu for unknown commands
                await whatsappService.sendMessage(
                    phone,
                    `📱 *OffComfrt*\n\n▫️ I didn't understand that command.\n▫️ Type *help* or *menu* to see available options.`,
                );
        }
    }

    // Handle size chart / measurement queries — redirect to support
    async handleSizeQuery(phone, message, lang = 'en') {
        const lowerMessage = message.toLowerCase();

        // Keywords that indicate the user is asking about sizing / measurements
        // 'size' alone is included so simple "Size" messages get redirected before
        // the FAQ handler returns the full size guide from the database
        const sizeKeywords = [
            'size', 'size chart', 'size guide', 'sizing chart', 'sizing guide',
            'fit guide', 'fit chart', 'measurements', 'measurement',
            'chest', 'waist', 'shoulder', 'sleeve',
            'dimensions', 'dimension', 'what size', 'which size',
            'fits me', 'will it fit', 'fitting', 'body size',
            'how to measure'
        ];

        const isSizeQuery = sizeKeywords.some(kw => lowerMessage.includes(kw));
        if (!isSizeQuery) return false;

        const sizeRedirectMsg = lang !== 'en'
            ? `📱 *OffComfrt*\n\n▫️ For sizing questions, please contact our support team.\n\n▫️ Type "support" to reach out.\n▫️ Our team will respond within *24 hours*.`
            : `📏 *Size Help*\n\n▫️ For sizing and measurement questions, please contact our support team.\n\n▫️ Type "support" to reach out.\n▫️ Our team will respond within *24 hours*.`;

        await whatsappService.sendMessage(phone, sizeRedirectMsg);
        return true;
    }

    // Handle request ID tracking (REQ-XXXX to REQ-XXXXXX)
    async handleRequestId(phone, message, lang = 'en') {
        // Match REQ- followed by 4-6 digits
        const requestIdPattern = /REQ-(\d{4,6})/i;
        const match = message.match(requestIdPattern);
        
        if (!match) return false;

        const requestId = match[0]; // Full match: REQ-XXXX
        
        const trackingMsg = [
            `📦 *OFFCOMFRT — TRACK YOUR REQUEST*`,
            ``,
            ``,
            `▫️ *Request ID:* ${requestId}`,
            ``,
            `▫️ Track the status of your return/exchange request using the button below.`,
            ``,
            `▫️ Our team processes all requests within *24-48 hours*.`,
            ``,
            ``
        ].join('\n');

        try {
            await whatsappService.sendCtaUrlMessage(
                phone,
                trackingMsg,
                'Track Request',
                'https://offcomfrt.in/pages/track-request',
                null,
                null
            );
            console.log(`[REQ TRACK] Sent tracking message for ${requestId} to ${phone}`);
        } catch (err) {
            console.error(`[REQ TRACK] Failed to send tracking message:`, err.message);
            await whatsappService.sendMessage(
                phone,
                `📦 *Request Tracking*\n\n▫️ *Request ID:* ${requestId}\n\n▫️ Track your request at:\nhttps://offcomfrt.in/pages/track-request`
            );
        }

        return true;
    }

    // Handle unsubscribe request
    async handleUnsubscribe(phone) {
        try {
            await whatsappService.sendMessage(
                phone,
                '📱 *OffComfrt*\n\n▫️ You have been unsubscribed from promotional messages.\n\n▫️ You will continue to receive order updates.\n▫️ To resubscribe, type *START*.'
            );
        } catch (error) {
            console.error('Error handling unsubscribe:', error);
        }
    }

    // Handle language selection
    async handleLanguageSelection(phone, message, currentLang) {
        try {
            const selectedLang = LanguageService.parseLanguageSelection(message);

            if (selectedLang) {
                await LanguageService.setCustomerLanguage(phone, selectedLang);
                const langName = LanguageService.getLanguageName(selectedLang);
                const confirmMsg = LanguageService.translate('languageSet', selectedLang, langName);
                await whatsappService.sendMessage(phone, confirmMsg);
            } else {
                // Show language menu as a WhatsApp list
                await whatsappService.sendListMessage(
                    phone,
                    '⚫ OFFCOMFRT\n\n▫️ Please choose your preferred language:\n\n▫️ Select from the list below.',
                    'Select Language',
                    [{
                        title: 'Languages',
                        rows: [
                            { id: 'lang_1', title: 'English', description: 'Continue in English' },
                            { id: 'lang_2', title: 'Hindi', description: 'Hindi mein jaari rakhein' },
                            { id: 'lang_3', title: 'Tamil', description: 'Tamil' },
                            { id: 'lang_4', title: 'Telugu', description: 'Telugu' },
                            { id: 'lang_5', title: 'Kannada', description: 'Kannada' },
                            { id: 'lang_6', title: 'Malayalam', description: 'Malayalam' }
                        ]
                    }],
                    null,
                    null
                );
            }
        } catch (error) {
            console.error('Error handling language selection:', error);
        }
    }

    // Log message to database
    async logMessage(phone, message, type) {
        try {
            // Ensure customer exists before logging message (FK constraint)
            await Customer.getOrCreate(phone, 'Customer');

            await dbAdapter.insert('messages', {
                customer_phone: phone,
                message_type: type,
                message_content: message,
                status: 'received',
                created_at: new Date().toISOString()
            });

            // Cleanup: Keep only last 200 messages per customer
            await this.cleanupOldMessages(phone);
        } catch (error) {
            console.error('Error logging message:', error);
        }
    }

    // Cleanup old messages to keep only last 200 per customer (optimized)
    async cleanupOldMessages(phone) {
        try {
            // Normalize phone to match DB storage format (with + prefix)
            const cleanPhone = phone.replace(/\D/g, '');
            const formattedPhone = cleanPhone.startsWith('91') ? `+${cleanPhone}` : `+91${cleanPhone}`;
            
            // OPTIMIZED: Only run cleanup if customer has more than 250 messages
            // This avoids expensive DELETE queries on every message
            const countResult = await dbAdapter.query(
                'SELECT COUNT(*) as count FROM messages WHERE customer_phone = ?',
                [formattedPhone]
            );
            const messageCount = countResult[0]?.count || 0;
            
            // Only cleanup if significantly over the 200 limit
            if (messageCount <= 250) {
                return; // Skip cleanup - still within acceptable range
            }
            
            // Use a more efficient approach: delete messages older than the 200th most recent
            await dbAdapter.query(
                `DELETE FROM messages 
                 WHERE customer_phone = ? 
                 AND created_at < (
                     SELECT created_at FROM messages 
                     WHERE customer_phone = ? 
                     ORDER BY created_at DESC 
                     LIMIT 1 OFFSET 200
                 )`,
                [formattedPhone, formattedPhone]
            );
        } catch (error) {
            // Silent fail - cleanup is best effort
        }
    }

    // Update follow-up recipient response
    async updateFollowUpResponse(phone, responseType) {
        try {
            // Find the most recent follow-up recipient for this phone that hasn't responded yet
            const recipients = await dbAdapter.query(
                `SELECT r.* FROM follow_up_recipients r
                 JOIN follow_up_campaigns c ON r.campaign_id = c.id
                 WHERE r.phone = ? 
                 AND r.status IN ('sent', 'delivered', 'read')
                 AND r.response_type IS NULL
                 AND c.status IN ('running', 'completed')
                 ORDER BY r.sent_at DESC
                 LIMIT 1`,
                [phone]
            );
            
            if (recipients && recipients.length > 0) {
                const recipient = recipients[0];
                const now = new Date().toISOString();
                
                // Update recipient
                await dbAdapter.query(
                    `UPDATE follow_up_recipients 
                     SET status = ?, response_type = ?, responded_at = ?
                     WHERE id = ?`,
                    ['responded', responseType, now, recipient.id]
                );
                
                // Update campaign stats
                const statField = responseType === 'confirmed' ? 'confirmed_count' : 
                                  responseType === 'cancelled' ? 'cancelled_count' : 'edit_requested_count';
                
                await dbAdapter.query(
                    `UPDATE follow_up_campaigns 
                     SET ${statField} = ${statField} + 1, 
                         responded_count = responded_count + 1,
                         updated_at = ?
                     WHERE id = ?`,
                    [now, recipient.campaign_id]
                );
                
                console.log(`[FOLLOW-UP] Updated recipient ${phone} with response: ${responseType}`);
            }
        } catch (error) {
            console.error('[FOLLOW-UP] Error updating follow-up response:', error);
            // Silent fail - don't block the main flow
        }
    }

    // Send rich response with image and buttons
    async sendRichResponse(phone, config, nameFallback = 'Customer') {
        let text = config.answer || config.content || '';
        const branding = require('../config/branding');
        const footer = branding.footer || '';
        
        // Variable replacement
        try {
            const { dbAdapter } = require('../database/db');
            const customer = await dbAdapter.query('SELECT name FROM customers WHERE phone LIKE ?', [`%${phone.slice(-10)}`]);
            const name = (customer?.[0]?.name) || nameFallback;
            text = text.replace(/{{name}}/g, name).replace(/{{phone}}/g, phone);
        } catch (err) {}

        const header = config.image_url || config.imageUrl || null;
        const buttons = config.buttons || [];
        const ctaText = config.cta_text || config.ctaText;
        const ctaUrl = config.cta_url || config.ctaUrl;

        if (ctaUrl) {
            // Priority: CTA URL button from direct fields
            await whatsappService.sendCtaUrlMessage(phone, text, ctaText || 'Visit', ctaUrl, header, footer);
        } else if (buttons.length > 0) {
            // Secondary: Standard buttons or legacy URL buttons in array
            const urlBtn = buttons.find(b => b.url || (typeof b.id === 'string' && b.id.startsWith('http')));
            
            if (urlBtn) {
                const btnLabel = urlBtn.text || urlBtn.title || 'Visit';
                const btnUrl = urlBtn.url || urlBtn.id;
                await whatsappService.sendCtaUrlMessage(phone, text, btnLabel, btnUrl, header, footer);
            } else {
                await whatsappService.sendButtonMessage(phone, text, buttons, header, footer);
            }
        } else if (header) {
            await whatsappService.sendImage(phone, header, text + footer);
        } else {
            await whatsappService.sendMessage(phone, text + footer);
        }
    }

    // Send the rich main menu list (optionally with a personalized greeting)
    async sendMainMenu(phone, name = null, lang = 'en') {
        const { translate } = require('../utils/translations');
        const welcomeText = LanguageService.translate('welcome', lang, name || 'Customer');

        // Menu labels — translated where available, English fallback
        const menuLabels = {
            en: { track: 'Track Order', orders: 'My Orders', ret: 'Return', exc: 'Exchange', support: 'Contact Support', language: 'Language' },
            hi: { track: 'Order Track', orders: 'Mere Orders', ret: 'Return', exc: 'Exchange', support: 'Support', language: 'Bhasha' },
            ta: { track: 'Order Track', orders: 'En Orders', ret: 'Return', exc: 'Exchange', support: 'Uthavi', language: 'Mozhi' },
            te: { track: 'Order Track', orders: 'Na Orders', ret: 'Return', exc: 'Exchange', support: 'Sahayam', language: 'Bhasha' },
            kn: { track: 'Order Track', orders: 'Nanna Orders', ret: 'Return', exc: 'Exchange', support: 'Sahaya', language: 'Bhashe' },
            ml: { track: 'Order Track', orders: 'Ente Orders', ret: 'Return', exc: 'Exchange', support: 'Sahayam', language: 'Bhasha' }
        };
        const l = menuLabels[lang] || menuLabels.en;

        const bodyText = `👋 Hi ${name || 'Customer'}! Welcome to OffComfrt!\n\nI can help you with:\n📦 Track orders\n🔄 Returns & Exchanges\n❓ FAQs\n\nSelect option from the menu below`;

        await whatsappService.sendListMessage(
            phone,
            bodyText,
            'Menu',
            [{
                title: 'How can we help?',
                rows: [
                    { id: 'track_order',          title: l.track,   description: '📦 Track your current order' },
                    { id: 'order_history',         title: l.orders,  description: '🧾 View all your orders' },
                    { id: 'menu_return',           title: l.ret,     description: '🔄 Initiate a return request' },
                    { id: 'menu_exchange',         title: l.exc,     description: '🔁 Swap to a different size' },

                    { id: 'menu_contact_support',  title: l.support, description: '🎧 Reply within 24 hours' },
                    { id: 'menu_language',         title: l.language,description: '🌐 Change language preference' }
                ]
            }],
                    null,
                    null
        );
    }
}

module.exports = new MessageHandler();
