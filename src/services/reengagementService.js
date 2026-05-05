const { dbAdapter } = require('../database/db');
const whatsappService = require('./whatsappService');

class ReengagementService {
    /**
     * Check for support tickets that need re-engagement messages
     * and send them automatically
     */
    async checkAndSendReengagement() {
        try {
            console.log('[RE-ENGAGEMENT] Checking for tickets needing re-engagement...');

            // Find tickets created between 20-21 hours ago that haven't received re-engagement yet
            const tickets = await dbAdapter.query(
                `SELECT id, customer_phone, customer_name, ticket_number
                 FROM support_tickets
                 WHERE reengagement_sent = 0
                   AND status = 'open'
                   AND created_at <= datetime('now', '-20 hours')
                   AND created_at > datetime('now', '-21 hours')`,
                []
            );

            if (!tickets || tickets.length === 0) {
                console.log('[RE-ENGAGEMENT] No tickets need re-engagement at this time');
                return;
            }

            console.log(`[RE-ENGAGEMENT] Found ${tickets.length} ticket(s) needing re-engagement`);

            let successCount = 0;
            let failureCount = 0;

            for (const ticket of tickets) {
                try {
                    await this.sendReengagementMessage(ticket);
                    successCount++;
                } catch (error) {
                    console.error(`[RE-ENGAGEMENT] Failed to send re-engagement for ticket ${ticket.id}:`, error.message);
                    failureCount++;
                    
                    // Mark as sent even if failed to prevent infinite retries
                    await this.markReengagementSent(ticket.id);
                }
            }

            console.log(`[RE-ENGAGEMENT] Complete: ${successCount} succeeded, ${failureCount} failed`);
        } catch (error) {
            console.error('[RE-ENGAGEMENT] Error in checkAndSendReengagement:', error);
            throw error;
        }
    }

    /**
     * Send re-engagement message to a specific ticket
     */
    async sendReengagementMessage(ticket) {
        const { customer_phone: phone, customer_name: name, ticket_number: ticketNumber } = ticket;

        console.log(`[RE-ENGAGEMENT] Sending message to ${phone} (Ticket: ${ticketNumber})`);

        // Re-engagement message content
        const message = `⚫ *OFFCOMFRT — SUPPORT*

▫️ We apologize for the delay.
▫️ Our support team will contact you soon.

▫️ Reply to this message to keep this conversation active.
▫️ If urgent, write to *support@offcomfrt.in*.`;

        // Send WhatsApp message
        await whatsappService.sendMessage(phone, message);

        // Mark re-engagement as sent
        await this.markReengagementSent(ticket.id);

        console.log(`[RE-ENGAGEMENT] ✓ Message sent successfully for ticket ${ticketNumber}`);
    }

    /**
     * Mark a ticket as having received the re-engagement message
     */
    async markReengagementSent(ticketId) {
        await dbAdapter.query(
            `UPDATE support_tickets
             SET reengagement_sent = 1,
                 reengagement_sent_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [ticketId]
        );
    }
}

module.exports = new ReengagementService();
