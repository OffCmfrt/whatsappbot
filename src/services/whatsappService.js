const axios = require('axios');
const { dbAdapter } = require('../database/db');
const Customer = require('../models/Customer');

class WhatsAppService {
    constructor() {
        this.accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
        this.phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
        this.apiVersion = 'v21.0'; // Stable version

        // Robust check for placeholder values
        const isPlaceholder = (val) => !val || val.includes('your_') || val.includes('YOUR_');
        
        if (isPlaceholder(this.phoneNumberId)) {
            console.warn('⚠️ CRITICAL: WHATSAPP_PHONE_NUMBER_ID is missing or set to a placeholder!');
        }
        if (isPlaceholder(this.accessToken)) {
            console.warn('⚠️ CRITICAL: WHATSAPP_ACCESS_TOKEN is missing or set to a placeholder!');
        }

        this.baseURL = `https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId || 'MISSING_ID'}`;
        this.wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
        this.wabaBaseURL = `https://graph.facebook.com/${this.apiVersion}/${this.wabaId || 'MISSING_WABA'}`;
        
        console.log(`📡 WhatsApp Service Initialized (Base URL: ${this.baseURL})`);
    }

    // Log an outgoing message to the messages table (non-blocking)
    async _logOutgoing(phone, messageContent, messageType = 'outgoing', waMessageId = null) {
        try {
            const cleanPhone = phone.replace(/\D/g, '');
            const formattedPhone = cleanPhone.startsWith('91') ? `+${cleanPhone}` : `+91${cleanPhone}`;

            // Ensure customer exists before inserting message (FK constraint)
            // Using cached Customer.findByPhone to reduce reads
            try {
                const existing = await Customer.findByPhone(formattedPhone);
                if (!existing) {
                    await dbAdapter.insert('customers', {
                        phone: formattedPhone,
                        name: '',
                        created_at: new Date().toISOString(),
                        updated_at: new Date().toISOString()
                    });
                }
            } catch (custErr) {
                // Customer might already exist (race condition), ignore
            }

            await dbAdapter.insert('messages', {
                customer_phone: formattedPhone,
                message_type: messageType,
                message_content: typeof messageContent === 'string' ? messageContent.substring(0, 4000) : '[Non-text message]',
                status: 'sent',
                created_at: new Date().toISOString(),
                wa_message_id: waMessageId
            });

            // Cleanup: Keep only last 200 messages per customer (auto-delete older messages)
            await this._cleanupOldMessages(formattedPhone);
        } catch (logErr) {
            console.error('[WA] Failed to log outgoing message:', logErr.message);
        }
    }

    // Send a text message
    async sendMessage(to, message, logType = 'outgoing') {
        try {
            // Standardize phone number
            const cleanPhone = this.formatPhoneNumber(to);

            const response = await axios.post(
                `${this.baseURL}/messages`,
                {
                    messaging_product: 'whatsapp',
                    recipient_type: 'individual',
                    to: cleanPhone,
                    type: 'text',
                    text: {
                        preview_url: false,
                        body: message
                    }
                },
                {
                    headers: {
                        'Authorization': `Bearer ${this.accessToken}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            console.log(`[OK] Message sent to ${cleanPhone}`);
            // Log outgoing message to messages table with WhatsApp message ID
            const waMsgId = response.data?.messages?.[0]?.id || null;
            this._logOutgoing(cleanPhone, message, logType, waMsgId);
            return response.data;
        } catch (error) {
            // Check for specific Meta Sandbox / Test number error
            const metaError = error.response?.data?.error;
            if (metaError && metaError.code === 131030) {
                console.warn(`⚠️ Meta API Notice: Cannot send message to ${to}. Recipient is not in the allowed list for this test account.`);
                return false;
            }
            console.error('❌ Error sending WhatsApp message:', metaError || error.message);
            if (error.response?.data) console.error('Meta API Response Detail:', JSON.stringify(error.response.data, null, 2));
            throw error;
        }
    }

    // Helper: Extract template parameters and create human-readable content
    _extractTemplateContent(templateData) {
        const templateName = templateData?.name || 'template';
        const components = templateData?.components || [];
        
        // Find body component with parameters
        const bodyComponent = components.find(c => c.type === 'body');
        if (!bodyComponent || !bodyComponent.parameters) {
            return `[Template: ${templateName}]`;
        }
        
        // Build readable content from parameters
        const paramValues = bodyComponent.parameters.map(p => p.text || '').filter(Boolean);
        
        // Return template name followed by parameter values
        // Format: [Template: name] param1 | param2 | param3
        return `[Template: ${templateName}] ${paramValues.join(' | ')}`;
    }

    // Send a formatted message with template
    async sendTemplate(to, templateData, logType = 'template') {
        try {
            const cleanPhone = this.formatPhoneNumber(to);

            const response = await axios.post(
                `${this.baseURL}/messages`,
                {
                    messaging_product: 'whatsapp',
                    to: cleanPhone,
                    type: 'template',
                    template: templateData
                },
                {
                    headers: {
                        'Authorization': `Bearer ${this.accessToken}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            console.log(`[OK] Template sent to ${cleanPhone}`);
            // Log template message to messages table with WhatsApp message ID
            const templateContent = this._extractTemplateContent(templateData);
            const waMsgId = response.data?.messages?.[0]?.id || null;
            this._logOutgoing(cleanPhone, templateContent, logType, waMsgId);
            return response.data;
        } catch (error) {
            // Check for specific Meta Sandbox / Test number error
            const metaError = error.response?.data?.error;
            if (metaError && metaError.code === 131030) {
                console.warn(`⚠️ Meta API Notice: Cannot send template to ${to}. Recipient is not in the allowed list for this test account.`);
                return false;
            }
            console.error('❌ Error sending WhatsApp template:', metaError || error.message);
            if (error.response?.data) console.error('Meta API Response Detail:', JSON.stringify(error.response.data, null, 2));
            throw error;
        }
    }

    // Send template with retry logic
    async sendTemplateWithRetry(to, templateData, maxRetries = 3) {
        for (let i = 0; i < maxRetries; i++) {
            try {
                return await this.sendTemplate(to, templateData);
            } catch (error) {
                if (i === maxRetries - 1) throw error;
                // Wait before retry (exponential backoff)
                const delayStr = 1000 * Math.pow(2, i);
                console.warn(`⚠️ Template send failed. Retrying in ${delayStr}ms...`);
                await new Promise(resolve => setTimeout(resolve, delayStr));
            }
        }
    }

    // Send an image
    async sendImage(to, imageUrl, caption = '', logType = 'outgoing') {
        try {
            const cleanPhone = this.formatPhoneNumber(to);

            const response = await axios.post(
                `${this.baseURL}/messages`,
                {
                    messaging_product: 'whatsapp',
                    recipient_type: 'individual',
                    to: cleanPhone,
                    type: 'image',
                    image: {
                        link: imageUrl,
                        caption: caption
                    }
                },
                {
                    headers: {
                        'Authorization': `Bearer ${this.accessToken}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            console.log(`[OK] Image sent to ${cleanPhone}`);
            const waMsgId = response.data?.messages?.[0]?.id || null;
            this._logOutgoing(cleanPhone, caption ? `[Image] ${caption}` : '[Image]', logType, waMsgId);
            return response.data;
        } catch (error) {
            console.error('❌ Error sending WhatsApp image:', error.response?.data || error.message);
            if (error.response?.data) console.error('Meta API Response Detail:', JSON.stringify(error.response.data, null, 2));
            throw error;
        }
    }

    // Send a CTA URL button message (tappable button that opens a URL)
    async sendCtaUrlMessage(to, bodyText, buttonLabel, url, header = null, footerText = null) {
        try {
            const cleanPhone = this.formatPhoneNumber(to);

            const messageData = {
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: cleanPhone,
                type: 'interactive',
                interactive: {
                    type: 'cta_url',
                    body: { text: bodyText },
                    action: {
                        name: 'cta_url',
                        parameters: {
                            display_text: buttonLabel,
                            url: url
                        }
                    }
                }
            };

            if (header) {
                if (typeof header === 'string' && header.startsWith('http')) {
                    messageData.interactive.header = { type: 'image', image: { link: header } };
                } else if (typeof header === 'string') {
                    messageData.interactive.header = { type: 'text', text: header.substring(0, 60) };
                }
            }

            if (footerText) {
                messageData.interactive.footer = { text: footerText.substring(0, 60) };
            }

            const response = await axios.post(`${this.baseURL}/messages`, messageData, {
                headers: { 'Authorization': `Bearer ${this.accessToken}`, 'Content-Type': 'application/json' }
            });

            console.log(`[OK] CTA URL button sent to ${cleanPhone}`);
            const waMsgId = response.data?.messages?.[0]?.id || null;
            this._logOutgoing(cleanPhone, `${bodyText}\n[${buttonLabel}]`, 'outgoing', waMsgId);
            return response.data;
        } catch (error) {
            console.error('❌ Error sending CTA URL message:', error.response?.data || error.message);
            if (error.response?.data) console.error('Meta API Response Detail:', JSON.stringify(error.response.data, null, 2));
            throw error;
        }
    }

    // Mark message as read
    async markAsRead(messageId) {
        try {
            await axios.post(
                `${this.baseURL}/messages`,
                {
                    messaging_product: 'whatsapp',
                    status: 'read',
                    message_id: messageId
                },
                {
                    headers: {
                        'Authorization': `Bearer ${this.accessToken}`,
                        'Content-Type': 'application/json'
                    }
                }
            );
        } catch (error) {
            console.error('Error marking message as read:', error.response?.data || error.message);
        }
    }

    // Send interactive button message
    async sendButtonMessage(to, bodyText, buttons, header = null, footerText = null) {
        try {
            const cleanPhone = this.formatPhoneNumber(to);

            const buttonArray = buttons.slice(0, 3).map((btn, index) => ({
                type: 'reply',
                reply: {
                    id: btn.id || `btn_${index}`,
                    title: (btn.text || btn.title || 'Button').substring(0, 20)
                }
            }));

            const messageData = {
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: cleanPhone,
                type: 'interactive',
                interactive: {
                    type: 'button',
                    body: { text: bodyText },
                    action: { buttons: buttonArray }
                }
            };

            if (header) {
                if (typeof header === 'string' && header.startsWith('http')) {
                    messageData.interactive.header = { type: 'image', image: { link: header } };
                } else if (typeof header === 'string') {
                    messageData.interactive.header = { type: 'text', text: header.substring(0, 60) };
                }
            }

            if (footerText) {
                messageData.interactive.footer = { text: footerText.substring(0, 60) };
            }

            const response = await axios.post(`${this.baseURL}/messages`, messageData, {
                headers: { 'Authorization': `Bearer ${this.accessToken}`, 'Content-Type': 'application/json' }
            });
            console.log(`[OK] Button message sent to ${cleanPhone}`);
            const waMsgId = response.data?.messages?.[0]?.id || null;
            this._logOutgoing(cleanPhone, bodyText, 'outgoing', waMsgId);
            return response.data;
        } catch (error) {
            console.error('❌ Error sending button message:', error.response?.data || error.message);
            if (error.response?.data) console.error('Meta API Response Detail:', JSON.stringify(error.response.data, null, 2));
            throw error;
        }
    }

    // Send interactive list message
    async sendListMessage(to, bodyText, buttonText, sections, headerText = null, footerText = null) {
        try {
            const cleanPhone = this.formatPhoneNumber(to);

            const messageData = {
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: cleanPhone,
                type: 'interactive',
                interactive: {
                    type: 'list',
                    body: {
                        text: bodyText
                    },
                    action: {
                        button: buttonText.substring(0, 20), // Max 20 chars
                        sections: sections
                    }
                }
            };

            // Add optional header
            if (headerText) {
                messageData.interactive.header = {
                    type: 'text',
                    text: headerText.substring(0, 60)
                };
            }

            // Add optional footer
            if (footerText) {
                messageData.interactive.footer = {
                    text: footerText.substring(0, 60)
                };
            }

            const response = await axios.post(
                `${this.baseURL}/messages`,
                messageData,
                {
                    headers: {
                        'Authorization': `Bearer ${this.accessToken}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            console.log(`[OK] List message sent to ${cleanPhone}`);
            const waMsgId = response.data?.messages?.[0]?.id || null;
            this._logOutgoing(cleanPhone, bodyText, 'outgoing', waMsgId);
            return response.data;
        } catch (error) {
            console.error('❌ Error sending list message:', error.response?.data || error.message);
            // Fallback to regular text message
            return await this.sendMessage(to, bodyText);
        }
    }

    // Format phone number for WhatsApp
    formatPhoneNumber(phone) {
        // Remove all non-digit characters
        let cleaned = phone.replace(/\D/g, '');

        // Add country code if not present (assuming India +91)
        if (!cleaned.startsWith('91') && cleaned.length === 10) {
            cleaned = '91' + cleaned;
        }

        return cleaned;
    }

    // Send message with retry logic
    async sendMessageWithRetry(to, message, maxRetries = 3) {
        for (let i = 0; i < maxRetries; i++) {
            try {
                return await this.sendMessage(to, message);
            } catch (error) {
                if (i === maxRetries - 1) throw error;

                // Wait before retry (exponential backoff)
                await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, i)));
            }
        }
    }

    // Branded message helper... removed duplicate sendImage method

    // Send branded message with OffComfrt footer
    async sendBrandedMessage(to, message, includeLogo = false, logoUrl = null) {
        try {
            // Add branded footer
            const brandedMessage = this.addBrandedFooter(message);

            // If logo requested, send logo first then message
            if (includeLogo && logoUrl) {
                await this.sendImage(to, logoUrl, '');
                await new Promise(resolve => setTimeout(resolve, 500)); // Small delay
            }

            return await this.sendMessage(to, brandedMessage);
        } catch (error) {
            console.error('Error sending branded message:', error);
            // Fallback to regular message
            return await this.sendMessage(to, message);
        }
    }

    // Add OffComfrt branded footer to message
    addBrandedFooter(message, lang = 'en') {
        const branding = require('../config/branding');
        const footer = branding.footers[lang] || branding.footers.en;
        return `${message}${footer}`;
    }

    // Upload media to WhatsApp (for logo)
    async uploadMedia(mediaUrl, mimeType = 'image/png') {
        try {
            const response = await axios.post(
                `${this.baseURL}/media`,
                {
                    messaging_product: 'whatsapp',
                    file: mediaUrl,
                    type: mimeType
                },
                {
                    headers: {
                        'Authorization': `Bearer ${this.accessToken}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            console.log(`✅ Media uploaded, ID: ${response.data.id}`);
            return response.data.id; // Returns media ID to use in messages
        } catch (error) {
            console.error('❌ Error uploading media:', error.response?.data || error.message);
            throw error;
        }
    }

    // Get official message templates from Meta
    async getTemplates() {
        try {
            const response = await axios.get(
                `${this.wabaBaseURL}/message_templates`,
                {
                    headers: {
                        'Authorization': `Bearer ${this.accessToken}`
                    }
                }
            );

            console.log(`✅ Fetched ${response.data.data?.length || 0} templates from Meta`);
            return response.data;
        } catch (error) {
            console.error('❌ Error fetching templates from Meta:', error.response?.data || error.message);
            throw error;
        }
    }

    // Send shopper confirmation template (Meta approved - order_confirmation_v7)
    // 5 Parameters: {{1}}=Name, {{2}}=Order ID, {{3}}=Amount, {{4}}=Payment Method, {{5}}=Product Details
    // Note: Size is now included within product details for each item
    async sendShopperConfirmation(to, name, orderId, amount = '', paymentMethod = '', productSize = '', productDetails = '') {
        try {
            const cleanPhone = this.formatPhoneNumber(to);
            const firstName = name ? name.split(' ')[0] : 'Customer';
            const formattedAmount = amount ? amount.toString() : 'N/A';
            const payment = paymentMethod || 'N/A';
            const details = productDetails || 'Order details available online.';

            console.log(`[OK] Sending official confirmation template (v7) to ${cleanPhone}`);

            const templateData = {
                name: 'order_confirmation_v7',
                language: { code: 'en_US' },
                components: [
                    {
                        type: 'body',
                        parameters: [
                            { type: 'text', text: firstName },
                            { type: 'text', text: orderId || 'Recent Order' },
                            { type: 'text', text: formattedAmount },
                            { type: 'text', text: payment },
                            { type: 'text', text: details.substring(0, 900) } // Safety limit
                        ]
                    }
                ]
            };

            return await this.sendTemplate(to, templateData);
        } catch (error) {
            console.error('[ERR] Error sending shopper confirmation template (v7):', error.message);
            // No fallback - only send official Meta template
            throw error;
        }
    }

    /**
     * sendRichNotification — Central helper for ALL transactional messages.
     *
     * Sends a rich interactive CTA message that looks like the order
     * confirmation screenshots: image/logo header, bold structured body,
     * clickable button, branded footer.
     *
     * Falls back to plain sendMessage() if the interactive API call fails
     * (e.g. the 24-h customer service window has closed for that number).
     *
     * @param {string} to            - Recipient phone (E.164 digits)
     * @param {object} opts
     * @param {string} opts.body          - Full message body (supports *bold*)
     * @param {string} opts.buttonLabel   - CTA button label (max 20 chars)
     * @param {string} opts.buttonUrl     - URL the button opens
     * @param {string} [opts.imageUrl]    - Header image URL (optional)
     * @param {string} [opts.footer]      - Footer text (default: branded)
     * @param {string} [opts.plainFallback] - Plain text to send if CTA fails
     */
    async sendRichNotification(to, {
        body,
        buttonLabel,
        buttonUrl,
        imageUrl = 'https://offcomfrt.in/cdn/shop/files/logo_black_1.png',
        footer = null,
        plainFallback = null
    }) {
        const cleanPhone = this.formatPhoneNumber(to);
        try {
            await this.sendCtaUrlMessage(
                cleanPhone,
                body,
                buttonLabel.substring(0, 20),
                buttonUrl,
                imageUrl,
                footer.substring(0, 60)
            );
            console.log(`[OK] Rich notification sent to ${cleanPhone}: "${buttonLabel}"`);
            return true;
        } catch (err) {
            const errDetails = err.response?.data?.error?.error_data?.details || '';
            const defaultLogo = 'https://offcomfrt.in/cdn/shop/files/logo_black_1.png';
            
            if ((errDetails.includes('media') || errDetails.includes('download')) && imageUrl !== defaultLogo) {
                console.warn(`[WARN] Media download failed for rich notification. Retrying with default logo...`);
                try {
                    await this.sendCtaUrlMessage(
                        cleanPhone,
                        body,
                        buttonLabel.substring(0, 20),
                        buttonUrl,
                        defaultLogo,
                        footer.substring(0, 60)
                    );
                    console.log(`[OK] Rich notification (fallback logo) sent to ${cleanPhone}`);
                    return true;
                } catch (retryErr) {
                    // Fall through to plain text below
                }
            }

            console.warn(`[WARN] Rich CTA failed for ${cleanPhone}, falling back to plain text. Reason: ${err.message}`);
            try {
                await this.sendMessage(cleanPhone, plainFallback || body);
                return true;
            } catch (fallbackErr) {
                console.error(`[ERR] Plain fallback also failed for ${cleanPhone}:`, fallbackErr.message);
                return false;
            }
        }
    }

    // Cleanup old messages to keep only last 200 per customer (auto-delete when limit reached)
    async _cleanupOldMessages(phone) {
        try {
            const cleanPhone = phone.replace(/\D/g, '');
            await dbAdapter.query(
                `DELETE FROM messages 
                 WHERE customer_phone = ? 
                 AND id NOT IN (
                     SELECT id FROM messages 
                     WHERE customer_phone = ? 
                     ORDER BY created_at DESC 
                     LIMIT 200
                 )`,
                [cleanPhone, cleanPhone]
            );
        } catch (error) {
            // Silent fail - cleanup is best effort
            console.error('[WA] Error cleaning up old messages:', error.message);
        }
    }
}

// Export singleton instance
module.exports = new WhatsAppService();
