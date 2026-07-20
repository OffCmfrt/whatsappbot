# OffComfrt Branding Guide

## Overview
The WhatsApp bot now includes OffComfrt branding in all messages, including logo support and branded footers in multiple languages.

## Features

### 1. Branded Footers
All messages automatically include a professional footer with:
- OffComfrt logo emoji 👕
- Brand name
- Tagline (in customer's language)
- Website link

### 2. Logo Images
Send OffComfrt logo with important messages like:
- Welcome messages
- Return confirmations
- Broadcast campaigns

### 3. Multi-Language Support
Footers are translated into 6 languages:
- English
- Hindi
- Tamil
- Telugu
- Kannada
- Malayalam

## Setup

### Step 1: Upload Logo
1. Upload your OffComfrt logo to a publicly accessible URL
2. Recommended: Use Supabase Storage or your website
3. Logo should be:
   - Format: PNG or JPEG
   - Size: 800x800px recommended
   - Max file size: 5MB

### Step 2: Configure Logo URL
Add to your `.env` file:
```env
OFFCOMFRT_LOGO_URL=https://your-domain.com/path/to/logo.png
```

Or update `src/config/branding.js`:
```javascript
logoUrl: 'https://offcomfrt.in/logo.png'
```

## Usage

### Send Regular Message with Branded Footer
```javascript
const whatsappService = require('./services/whatsappService');

// Automatically adds branded footer
await whatsappService.sendMessage(phone, 'Your order has been shipped!');
```

### Send Message with Logo
```javascript
const whatsappService = require('./services/whatsappService');
const branding = require('./config/branding');

// Send logo + branded message
await whatsappService.sendBrandedMessage(
    phone, 
    'Welcome to OffComfrt!',
    true,  // include logo
    branding.logoUrl
);
```

### Send Logo Only
```javascript
await whatsappService.sendImage(
    phone,
    branding.logoUrl,
    'OffComfrt - Experience comfort, delivered.'
);
```

### Add Branded Footer Manually
```javascript
const message = 'Your order is ready!';
const brandedMessage = whatsappService.addBrandedFooter(message, 'hi'); // Hindi
await whatsappService.sendMessage(phone, brandedMessage);
```

## Configuration

Edit `src/config/branding.js` to customize:

```javascript
module.exports = {
    logoUrl: 'https://offcomfrt.in/logo.png',
    brandName: 'OffComfrt',
    tagline: 'Experience comfort, delivered.',
    website: 'offcomfrt.in',
    instagram: '@offcomfrt',
    
    // Control when to show logo
    includeLogo: {
        welcome: true,
        orderStatus: false,
        returnCreated: true,

        broadcast: true
    }
};
```

## Examples

### Welcome Message with Logo
```
[OffComfrt Logo Image]

👋 Hi Naman! Welcome to OffComfrt!

I can help you with:
📦 Track orders
🔄 Returns & Exchanges

❓ FAQs

━━━━━━━━━━━━━━━
👕 OffComfrt
Experience comfort, delivered.
🌐 offcomfrt.in
```

### Order Status (No Logo)
```
📦 Order Status

Order ID: ORD-2024-001
Status: Out for Delivery
Courier: Delhivery
Expected Delivery: Tomorrow

━━━━━━━━━━━━━━━
👕 OffComfrt
Experience comfort, delivered.
🌐 offcomfrt.in
```

### Hindi Message
```
✅ आपका ऑर्डर भेज दिया गया है!

━━━━━━━━━━━━━━━
👕 OffComfrt
आराम का अनुभव, डिलीवर किया गया.
🌐 offcomfrt.in
```

## Best Practices

1. **Logo Usage**
   - Use logo for important messages only
   - Don't send logo with every message (can be annoying)
   - Good for: Welcome, returns, broadcasts
   - Skip for: Order status, FAQs

2. **Footer Consistency**
   - All messages should have branded footer
   - Use customer's language for footer
   - Keep footer format consistent

3. **Logo Quality**
   - Use high-quality PNG with transparent background
   - Square aspect ratio (1:1)
   - Optimized file size for fast loading

4. **Testing**
   - Test logo display on different devices
   - Verify footer appears correctly
   - Check multi-language footers

## Troubleshooting

### Logo Not Displaying
- Verify logo URL is publicly accessible
- Check image format (PNG/JPEG only)
- Ensure file size is under 5MB
- Test URL in browser first

### Footer Not Showing
- Check `addBrandedFooter()` is called
- Verify language code is correct
- Ensure branding config is loaded

### Wrong Language Footer
- Verify customer's `preferred_language` in database
- Check language parameter passed correctly
- Fallback to English if language not found

## API Methods

### WhatsAppService Methods

```javascript
// Send image (logo)
sendImage(to, imageUrl, caption)

// Send branded message
sendBrandedMessage(to, message, includeLogo, logoUrl)

// Add branded footer
addBrandedFooter(message, lang)

// Upload media to WhatsApp
uploadMedia(mediaUrl, mimeType)
```

## Environment Variables

```env
# Optional: Logo URL (can also set in branding.js)
OFFCOMFRT_LOGO_URL=https://your-domain.com/logo.png
```

## Notes

- Logo is sent as separate image message before text
- Small delay (500ms) between logo and text for better UX
- Branded footer adds ~3 lines to every message
- Logo URL must be HTTPS (not HTTP)
- WhatsApp caches images for faster loading

---

**Need Help?**
Contact: namanjasoria41@gmail.com | +91 9413378016
