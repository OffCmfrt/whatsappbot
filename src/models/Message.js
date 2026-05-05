const { dbAdapter } = require('../database/db');
const { caches, cachedQuery, generateQueryKey, invalidateCache } = require('../utils/cache');

class Message {
    // Log a message to the database
    static async log(phone, content, type = 'incoming') {
        try {
            return await dbAdapter.insert('messages', {
                customer_phone: phone,
                message_type: type,
                message_content: content,
                status: 'sent',
                created_at: new Date().toISOString()
            });
        } catch (error) {
            console.error('Error in Message.log:', error);
            return null;
        }
    }

    // Get message count
    static async getCount() {
        try {
            return await cachedQuery(
                'stats',
                'message_count',
                async () => {
                    const result = await dbAdapter.query('SELECT COUNT(*) as count FROM messages');
                    return result[0]?.count || 0;
                },
                5 * 60 * 1000 // 5 minutes TTL
            );
        } catch (error) {
            console.error('Error getting message count:', error);
            return 0;
        }
    }

    // Get recent messages
    static async getRecent(limit = 10) {
        try {
            return await dbAdapter.select('messages', {}, { orderBy: 'created_at DESC', limit });
        } catch (error) {
            console.error('Error getting recent messages:', error);
            return [];
        }
    }

    // Get messages by phone
    static async getByPhone(phone, limit = 50) {
        try {
            return await dbAdapter.select('messages', { customer_phone: phone }, { orderBy: 'created_at DESC', limit });
        } catch (error) {
            console.error('Error getting messages by phone:', error);
            return [];
        }
    }
}

module.exports = Message;
