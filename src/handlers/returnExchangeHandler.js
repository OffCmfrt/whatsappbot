const whatsappService = require('../services/whatsappService');
const branding = require('../config/branding');

class ReturnExchangeHandler {
    async handle(phone, message, lang = 'en') {
        const lowerMessage = message.toLowerCase().trim();
        const isReturn = lowerMessage.includes('return');
        const isExchange = lowerMessage.includes('exchange');

        if (!isReturn && !isExchange) return false;

        if (isReturn) await this.sendReturnButton(phone, lang);
        if (isExchange) await this.sendExchangeButton(phone, lang);

        return true;
    }

    async sendReturnButton(phone, lang = 'en') {
        const { translate } = require('../utils/translations');
        const body = [
            `⚫ *OFFCOMFRT — INITIATE A RETURN*`,
            ``,
            ``,
            `▫️ To file a return request, please visit our returns page.`,
            ``,
            `▫️ *Important:* Return requests must be submitted within *2 days of delivery*.`,
            `▫️ Items should be unused, with original tags and packaging intact.`,
            ``,
            `▫️ Our team reviews all return requests within 24 to 48 hours.`,
            ``,
            ``
        ].join('\n');

        try {
            await whatsappService.sendCtaUrlMessage(
                phone,
                body,
                'Start Return',
                'https://www.offcomfrt.in/pages/return',
                branding.logoUrl,
                null
            );
        } catch {
            await whatsappService.sendMessage(phone, body);
        }
    }

    async sendExchangeButton(phone, lang = 'en') {
        const { translate } = require('../utils/translations');
        const body = [
            `⚫ *OFFCOMFRT — INITIATE AN EXCHANGE*`,
            ``,
            ``,
            `▫️ To swap to a different size, please visit our exchange page.`,
            ``,
            `▫️ *Important:* Exchange requests must be submitted within *2 days of delivery*.`,
            `▫️ Exchanges are subject to stock availability.`,
            ``,
            `▫️ Our team reviews all exchange requests within 24 to 48 hours.`,
            ``,
            ``
        ].join('\n');

        try {
            await whatsappService.sendCtaUrlMessage(
                phone,
                body,
                'Start Exchange',
                'https://www.offcomfrt.in/pages/exchange',
                branding.logoUrl,
                null
            );
        } catch {
            await whatsappService.sendMessage(phone, body);
        }
    }
}

module.exports = new ReturnExchangeHandler();
