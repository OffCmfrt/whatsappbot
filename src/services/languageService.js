const { dbAdapter } = require('../database/db');
const { translate, getLanguageName, isLanguageSupported, languageNames } = require('../utils/translations');

class LanguageService {
    // Get customer's preferred language
    static async getCustomerLanguage(phone) {
        try {
            const customers = await dbAdapter.select('customers', { phone }, { limit: 1 });
            const data = customers[0];

            if (!data) {
                console.log(`⚠️ No language preference found for ${phone}, defaulting to English`);
                return 'en'; // Default to English
            }

            const lang = data.preferred_language || 'en';
            console.log(`🌐 Customer ${phone} language: ${lang}`);
            return lang;
        } catch (error) {
            console.error('Error getting customer language:', error);
            return 'en';
        }
    }

    // Set customer's preferred language
    static async setCustomerLanguage(phone, langCode) {
        try {
            if (!isLanguageSupported(langCode)) {
                throw new Error(`Language ${langCode} not supported`);
            }

            console.log(`🔄 Updating language for ${phone} to: ${langCode}`);

            await dbAdapter.update('customers', { preferred_language: langCode }, { phone });

            console.log(`✅ Language updated successfully for ${phone}`);
            return true;
        } catch (error) {
            console.error('Error setting customer language:', error);
            return false;
        }
    }

    // Get language selection menu
    static getLanguageMenu(currentLang = 'en') {
        return translate('languageMenu', currentLang);
    }

    // Parse language selection from user input
    static parseLanguageSelection(input) {
        if (!input) return null;
        const cleanInput = input.trim().toLowerCase();

        // Map number selections to language codes
        const numberMap = {
            '1': 'en',
            '2': 'hi',
            '3': 'ta',
            '4': 'te',
            '5': 'kn',
            '6': 'ml'
        };

        // Check if input is a number
        if (numberMap[cleanInput]) {
            return numberMap[cleanInput];
        }

        // Check if input matches language code
        if (isLanguageSupported(cleanInput)) {
            return cleanInput;
        }

        // Check if input matches language name (partial match)
        const langCode = Object.keys(languageNames).find(code => {
            const name = languageNames[code].toLowerCase();
            return name.includes(cleanInput) || cleanInput.includes(name.split(' ')[0]);
        });

        return langCode || null;
    }

    // Check if message is a language change request
    static isLanguageCommand(message) {
        const cleanMsg = message.trim().toLowerCase();
        const languageKeywords = [
            'language', 'lang', 'भाषा', 'மொழி', 'భాష', 'ಭಾಷೆ', 'ഭാഷ',
            'change language', 'select language', 'switch language'
        ];

        return languageKeywords.some(keyword => cleanMsg.includes(keyword));
    }

    // Get translated message
    static translate(key, lang, params = {}) {
        return translate(key, lang, params);
    }

    // Get language name
    static getLanguageName(code) {
        return getLanguageName(code);
    }
}

module.exports = LanguageService;
