// OffComfrt Branding Configuration

module.exports = {
    // Logo / brand banner URL (publicly accessible)
    logoUrl: process.env.OFFCOMFRT_LOGO_URL || 'https://res.cloudinary.com/dwv8chikg/image/upload/v1770717176/Screenshot_2026-02-10_152241_htvwkf.jpg',

    // Brand name
    brandName: 'OffComfrt',

    // Tagline
    tagline: 'Hope you do good in life.',

    // Website
    website: 'offcomfrt.in',

    // Social media
    instagram: '@offcomfrt',

    // Branded footer (appended to all text messages)
    footer: '',

    // Multi-language footers
    footers: {
        en: '',
        hi: '',
        ta: '',
        te: '',
        kn: '',
        ml: ''
    },

    // When to include logo image header
    includeLogo: {
        welcome: true,
        orderStatus: true,
        orderHistory: true,
        returnExchange: true,
        returnCreated: true,
        faq: true,
        broadcast: true
    }
};
