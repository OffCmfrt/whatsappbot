// Multi-language translations for WhatsApp bot
// Supported languages: English, Hindi, Tamil, Telugu, Kannada, Malayalam

const translations = {
    // English
    en: {
        welcome: (name) => `Hello ${name}, welcome to *Offcomfrt*.\n\nHow can we assist you today?\n\n*Track Orders* — Send your order ID\n*Returns and Exchanges* — Within 2 days of delivery\n*FAQs* — Shipping, payments, and more\n\nType *help* or select from the menu below.`,

        languageMenu: "Please select your preferred language:\n1. English\n2. Hindi\n3. Tamil\n4. Telugu\n5. Kannada\n6. Malayalam",

        languageSet: (lang) => `Language updated to *${lang}*.`,

        help: "We can help you with the following:\n\n*Track Order* — Send your order ID or AWB number\n*Order History* — Type \"orders\"\n*Returns* — Type \"return\" (within 2 days of delivery)\n*Exchanges* — Type \"exchange\" (within 2 days of delivery)\n*Change Language* — Type \"language\"",

        orderNotFound: "Order not found. Please verify your order ID and try again.",
        orderStatus: "*Order Status*",
        orderId: "Order ID",
        status: "Status",
        courier: "Courier",
        expectedDelivery: "Expected Delivery",

        returnInitiated: "*Return Request*\n\nPlease send your Order ID to proceed.",
        returnCreated: "Return request created successfully.\nPickup will be scheduled shortly.",



        error: "We encountered an issue. Please try again shortly."
    },

    // Hindi
    hi: {
        welcome: (name) => `${name}, *Offcomfrt* में आपका स्वागत है।\n\nआज हम आपकी किस प्रकार सहायता कर सकते हैं?\n\n*ऑर्डर ट्रैक करें* — अपना ऑर्डर ID भेजें\n*वापसी और बदलाव* — डिलीवरी के 2 दिनों के भीतर\n*सामान्य प्रश्न* — शिपिंग, भुगतान, और अधिक\n\n*help* टाइप करें या नीचे मेनू से चुनें।`,

        languageMenu: "कृपया अपनी भाषा चुनें:\n1. English\n2. हिंदी\n3. தமிழ்\n4. తెలుగు\n5. ಕನ್ನಡ\n6. മലయാളം",

        languageSet: (lang) => `भाषा *${lang}* में अपडेट की गई।`,

        help: "हम आपकी सहायता कर सकते हैं:\n\n*ऑर्डर ट्रैक करें* — ऑर्डर ID भेजें\n*ऑर्डर इतिहास* — \"orders\" टाइप करें\n*वापसी* — \"return\" टाइप करें (डिलीवरी के 2 दिनों के भीतर)\n*बदलाव* — \"exchange\" टाइप करें (डिलीवरी के 2 दिनों के भीतर)\n*भाषा बदलें* — \"language\" टाइप करें",

        orderNotFound: "ऑर्डर नहीं मिला। कृपया ऑर्डर ID जांचें।",
        orderStatus: "*ऑर्डर स्थिति*",
        orderId: "ऑर्डर ID",
        status: "स्थिति",
        courier: "कूरियर",
        expectedDelivery: "अपेक्षित डिलीवरी",

        returnInitiated: "*वापसी अनुरोध*\n\nकृपया अपना ऑर्डर ID भेजें।",
        returnCreated: "वापसी अनुरोध बनाया गया।\nपिकअप जल्द शेड्यूल किया जाएगा।",



        error: "कुछ समस्या हुई। कृपया पुनः प्रयास करें।"
    },

    // Tamil
    ta: {
        welcome: (name) => `${name}, *Offcomfrt* க்கு வரவேற்கிறோம்.\n\nஇன்று நாங்கள் எவ்வாறு உதව முடியும்?\n\n*ஆர்டர் கண்காணிப்பு* — ஆர்டர் ID அனுப்பவும்\n*திரும்பப்பெறுதல் மற்றும் பரிமாற்றம்* — டெலிவரிக்கு 2 நாட்களுக்குள்\n\n*help* என தட்டச்சு செய்யவும்.`,

        languageMenu: "தயவுசெய்து உங்கள் மொழியைத் தேர்ந்தெடுக்கவும்:\n1. English\n2. हिंदी\n3. தமிழ்\n4. తెలుగు\n5. ಕನ್ನಡ\n6. മലയാളം",

        languageSet: (lang) => `மொழி *${lang}* ஆக மாற்றப்பட்டது.`,

        help: "நாங்கள் உங்களுக்கு உதவ முடியும்:\n\n*ஆர்டர் கண்காணிப்பு* — ஆர்டர் ID அனுப்பவும்\n*ஆர்டர் வரலாறு* — \"orders\" தட்டச்சு செய்யவும்\n*திரும்பப்பெறுதல்* — \"return\" தட்டச்சு செய்யவும்\n*மொழியை மாற்று* — \"language\" தட்டச்சு செய்யவும்",

        orderNotFound: "ஆர்டர் கிடைக்கவில்லை. ஆர்டர் ID சரிபார்க்கவும்.",
        orderStatus: "*ஆர்டர் நிலை*",
        orderId: "ஆர்டர் ID",
        status: "நிலை",
        courier: "கூரியர்",
        expectedDelivery: "எதிர்பார்க்கப்படும் டெலிவரி",

        returnInitiated: "*திரும்பப்பெறுதல் கோரிக்கை*\n\nதயவுசெய்து ஆர்டர் ID அனுப்பவும்.",
        returnCreated: "திரும்பப்பெறுதல் கோரிக்கை சமர்ப்பிக்கப்பட்டது.\nபிக்கப் விரைவில் திட்டமிடப்படும்.",



        error: "ஏதோ சிக்கல் ஏற்பட்டது. மீண்டும் முயற்சிக்கவும்."
    },

    // Telugu
    te: {
        welcome: (name) => `${name}, *Offcomfrt* కు స్వాగతం.\n\nమేము ఈరోజు ఎలా సహాయం చేయగలం?\n\n*ఆర్డర్ ట్రాకింగ్* — ఆర్డర్ ID పంపండి\n*రిటర్న్ మరియు ఎక్స్ఛేంజ్* — డెలివరీ తర్వాత 2 రోజులలో\n\n*help* టైప్ చేయండి.`,

        languageMenu: "దయచేసి మీ భాషను ఎంచుకోండి:\n1. English\n2. हिंदी\n3. தமிழ்\n4. తెలుగు\n5. ಕನ್ನಡ\n6. മലയാളം",

        languageSet: (lang) => `భాష *${lang}* కు అప్డేట్ చేయబడింది.`,

        help: "మేము సహాయం చేయగలం:\n\n*ఆర్డర్ ట్రాకింగ్* — ఆర్డర్ ID పంపండి\n*ఆర్డర్ చరిత్ర* — \"orders\" టైప్ చేయండి\n*రిటర్న్స్* — \"return\" టైప్ చేయండి\n*భాష మార్చండి* — \"language\" టైప్ చేయండి",

        orderNotFound: "ఆర్డర్ కనుగొనబడలేదు. ఆర్డర్ ID తనిఖీ చేయండి.",
        orderStatus: "*ఆర్డర్ స్థితి*",
        orderId: "ఆర్డర్ ID",
        status: "స్థితి",
        courier: "కొరియర్",
        expectedDelivery: "అంచనా డెలివరీ",

        returnInitiated: "*రిటర్న్ అభ్యర్థన*\n\nదయచేసి ఆర్డర్ ID పంపండి.",
        returnCreated: "రిటర్న్ అభ్యర్థన సృష్టించబడింది.\nపికప్ త్వరలో షెడ్యూల్ చేయబడుతుంది.",



        error: "ఏదో తప్పు జరిగింది. దయచేసి మళ్లీ ప్రయత్నించండి."
    },

    // Kannada
    kn: {
        welcome: (name) => `${name}, *Offcomfrt* ಗೆ ಸ್ವಾಗತ.\n\nಇಂದು ನಾವು ಹೇಗೆ ಸಹಾಯ ಮಾಡಬಹುದು?\n\n*ಆರ್ಡರ್ ಟ್ರ್ಯಾಕಿಂಗ್* — ಆರ್ಡರ್ ID ಕಳುಹಿಸಿ\n*ರಿಟರ್ನ್ ಮತ್ತು ಎಕ್ಸ್ಚೇಂಜ್* — ಡೆಲಿವರಿಯ 2 ದಿನಗಳಲ್ಲಿ\n\n*help* ಟೈಪ್ ಮಾಡಿ.`,

        languageMenu: "ದಯವಿಟ್ಟು ನಿಮ್ಮ ಭಾಷೆಯನ್ನು ಆಯ್ಕೆಮಾಡಿ:\n1. English\n2. हिंदी\n3. தமிழ்\n4. తెలుగు\n5. ಕನ್ನಡ\n6. മലയാളം",

        languageSet: (lang) => `ಭಾಷೆ *${lang}* ಗೆ ಅಪ್ಡೇಟ್ ಆಗಿದೆ.`,

        help: "ನಾವು ಸಹಾಯ ಮಾಡಬಲ್ಲೆವು:\n\n*ಆರ್ಡರ್ ಟ್ರ್ಯಾಕಿಂಗ್* — ಆರ್ಡರ್ ID ಕಳುಹಿಸಿ\n*ಆർಡರ್ ಇತಿಹಾಸ* — \"orders\" ಟೈಪ್ ಮಾಡಿ\n*ರಿಟರ್ನ್ಸ್* — \"return\" ಟೈಪ್ ಮಾಡಿ\n*ಭಾಷೆ ಬದಲಾಯಿಸಿ* — \"language\" ಟೈಪ್ ಮಾಡಿ",

        orderNotFound: "ಆರ್ಡರ್ ಸಿಗಲಿಲ್ಲ. ಆರ್ಡರ್ ID ಪರಿಶೀಲಿಸಿ.",
        orderStatus: "*ಆರ್ಡರ್ ಸ್ಥಿತಿ*",
        orderId: "ಆರ್ಡರ್ ID",
        status: "ಸ್ಥಿತಿ",
        courier: "ಕೊರಿಯರ್",
        expectedDelivery: "ನಿರೀಕ್ಷಿತ ವಿತರಣೆ",

        returnInitiated: "*ರಿಟರ್ನ್ ವಿನಂತಿ*\n\nದಯವಿಟ್ಟು ಆರ್ಡರ್ ID ಕಳುಹಿಸಿ.",
        returnCreated: "ರಿಟರ್ನ್ ವಿನಂತಿ ಸಲ್ಲಿಸಲಾಗಿದೆ.\nಪಿಕಪ್ ಶೀಘ್ರವೇ ನಿಗದಿಪಡಿಸಲಾಗುವುದು.",



        error: "ಸಮಸ್ಯೆ ಉಂಟಾಗಿದೆ. ದಯವಿಟ್ಟು ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ."
    },

    // Malayalam
    ml: {
        welcome: (name) => `${name}, *Offcomfrt* ലേക്ക് സ്വാഗതം.\n\nഇന്ത് ഞങ്ങൾ എങ്ങനെ സഹായിക്കാം?\n\n*ഓർഡർ ട്രാക്കിംഗ്* — ഓർഡർ ID അയയ്ക്കുക\n*റിട്ടേൺ, എക്സ്ചേഞ്ച്* — ഡെലിവറി കഴിഞ്ഞ 2 ദിവസത്തിനുള്ളിൽ\n\n*help* എന്ന് ടൈപ്പ് ചെയ്യുക.`,

        languageMenu: "ദയവായി നിങ്ങളുടെ ഭാഷ തിരഞ്ഞെടുക്കുക:\n1. English\n2. हिंदी\n3. தமிழ்\n4. తెలుగు\n5. ಕನ್ನಡ\n6. മലയാളം",

        languageSet: (lang) => `ഭാഷ *${lang}* ആയി അപ്ഡേറ്റ് ചെയ്തു.`,

        help: "ഞങ്ങൾ സഹായിക്കാം:\n\n*ഓർഡർ ട്രാക്കിംഗ്* — ഓർഡർ ID അയയ്ക്കുക\n*ഓർഡർ ചരിത്രം* — \"orders\" ടൈപ്പ് ചെയ്യുക\n*റിട്ടേൺ* — \"return\" ടൈപ്പ് ചെയ്യുക\n*ഭാഷ മാറ്റുക* — \"language\" ടൈപ്പ് ചെയ്യുക",

        orderNotFound: "ഓർഡർ കണ്ടെത്തിയില്ല. ഓർഡർ ID പരിശോധിക്കുക.",
        orderStatus: "*ഓർഡർ സ്റ്റാറ്റസ്*",
        orderId: "ഓർഡർ ID",
        status: "സ്റ്റാറ്റസ്",
        courier: "കൊറിയർ",
        expectedDelivery: "പ്രതീക്ഷിക്കുന്ന ഡെലിവറി",

        returnInitiated: "*റിട്ടേൺ അഭ്യർത്ഥന*\n\nദയവായി ഓർഡർ ID അയയ്ക്കുക.",
        returnCreated: "റിട്ടേൺ അഭ്യർത്ഥന സമർപ്പിച്ചു.\nപിക്കപ്പ് ഉടൻ ഷെഡ്യൂൾ ചെയ്യും.",



        error: "എന്തോ പ്രശ്നമുണ്ടായി. ദയവായി വീണ്ടും ശ്രമിക്കുക."
    }
};

// Language names for display
const languageNames = {
    en: 'English',
    hi: 'Hindi',
    ta: 'Tamil',
    te: 'Telugu',
    kn: 'Kannada',
    ml: 'Malayalam'
};

// Get translation
// params can be a string (passed directly to function) or an object
function translate(key, lang = 'en', params = null) {
    const langData = translations[lang] || translations.en;
    const value = langData[key];

    if (typeof value === 'function') {
        return value(params);
    }

    return value || translations.en[key] || key;
}

// Get language name
function getLanguageName(code) {
    return languageNames[code] || 'English';
}

// Check if language is supported
function isLanguageSupported(code) {
    return translations.hasOwnProperty(code);
}

module.exports = {
    translations,
    translate,
    getLanguageName,
    isLanguageSupported,
    languageNames
};
