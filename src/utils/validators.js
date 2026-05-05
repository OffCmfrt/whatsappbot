// Validate order ID format
function isValidOrderId(orderId) {
    if (!orderId) return false;

    // Remove whitespace
    const cleaned = orderId.trim();

    // Check if it's a number or alphanumeric
    // Most order IDs are numeric or alphanumeric with length 4-20
    const pattern = /^[a-zA-Z0-9-_]{4,20}$/;

    return pattern.test(cleaned);
}

// Validate AWB number
function isValidAWB(awb) {
    if (!awb) return false;

    // AWB numbers are typically 10-15 digits
    const cleaned = awb.trim().replace(/\s/g, '');
    const pattern = /^[0-9]{10,15}$/;

    return pattern.test(cleaned);
}

// Validate phone number
function isValidPhone(phone) {
    if (!phone) return false;

    // Remove all non-digit characters
    const cleaned = phone.replace(/\D/g, '');

    // Check if it's 10 digits (Indian) or 12 digits (with country code)
    return cleaned.length === 10 || cleaned.length === 12;
}

// Validate email
function isValidEmail(email) {
    if (!email) return false;

    const pattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return pattern.test(email);
}

// Extract order ID from message
function extractOrderId(message) {
    if (!message) return null;

    // Remove common prefixes but preserve case
    const cleaned = message
        .replace(/order\s*(id|number|#)?\s*:?\s*/gi, '')
        .replace(/awb\s*:?\s*/gi, '')
        .trim();

    // Order IDs are specifically 4-5 digits long
    // Match a standalone 4-5 digit number
    const matches = cleaned.match(/\b\d{4,5}\b/);

    return matches ? matches[0] : null;
}

// Sanitize user input
function sanitizeInput(input) {
    if (!input) return '';

    return input
        .trim()
        .replace(/[<>]/g, '') // Remove potential HTML tags
        .substring(0, 1000); // Limit length
}

// Check if message is a command
function isCommand(message) {
    const commands = [
        'help', 'orders', 'history', 'status', 'start', 'stop', 'welcome', 'hi', 'hello', 'hey', 
        'track_order', 'order_history', 'menu_contact_support', 'menu_return', 'menu_exchange', 
        'menu_size', 'menu_language', 'shop_confirm', 'shop_cancel', 'shop_edit',
        'confirm order', 'cancel order', 'edit details'
    ];
    const cleaned = message.toLowerCase().trim();

    return commands.includes(cleaned);
}

// Extract phone number from message
function extractPhoneNumber(message) {
    if (!message) return null;

    // Look for 10-digit Indian phone numbers or 12-digit with country code
    const patterns = [
        /\b(\d{10})\b/,           // 10 digits
        /\b(91\d{10})\b/,         // 91 followed by 10 digits
        /\b(\+91\d{10})\b/,       // +91 followed by 10 digits
        /\b(\d{3}[-.\s]?\d{3}[-.\s]?\d{4})\b/  // Formatted numbers
    ];

    for (const pattern of patterns) {
        const match = message.match(pattern);
        if (match) {
            // Clean the phone number
            const cleaned = match[1].replace(/[-.\s+]/g, '');
            // Ensure it starts with country code
            if (cleaned.length === 10) {
                return '91' + cleaned;
            }
            return cleaned;
        }
    }

    return null;
}

// Parse command from message
function parseCommand(message) {
    const cleaned = message.toLowerCase().trim();

    const commandMap = {
        'help': 'help',
        'orders': 'history',
        'history': 'history',
        'status': 'status',
        'track': 'status',
        'start': 'welcome',
        'hi': 'welcome',
        'hello': 'welcome',
        'hey': 'welcome',
        'stop': 'unsubscribe',
        'track_order': 'status',
        'order_history': 'history',
        'menu_contact_support': 'menu_contact_support',
        'menu_language': 'menu_language',
        'shop_confirm': 'shop_confirm',
        'shop_cancel': 'shop_cancel',
        'shop_edit': 'shop_edit',
        'confirm order': 'shop_confirm',
        'cancel order': 'shop_cancel',
        'edit details': 'shop_edit'
    };

    return commandMap[cleaned] || null;
}

module.exports = {
    isValidOrderId,
    isValidAWB,
    isValidPhone,
    isValidEmail,
    extractOrderId,
    extractPhoneNumber,
    sanitizeInput,
    isCommand,
    parseCommand
};
