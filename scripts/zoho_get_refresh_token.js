/**
 * Zoho Refresh Token Helper
 * -------------------------
 * The new Zoho API Console has no "Generate" button for refresh tokens,
 * so this script runs the standard OAuth 2.0 authorization-code flow.
 *
 *   STEP 1:  node scripts/zoho_get_refresh_token.js
 *            -> prints an authorization URL. Open it in your browser and click Accept.
 *   STEP 2:  Browser redirects to your ZOHO_REDIRECT_URI with ?code=... in the
 *            address bar (the page itself may show an error — that's expected).
 *            Copy the code value from the address bar.
 *   STEP 3:  node scripts/zoho_get_refresh_token.js <paste_code_here>
 *            -> exchanges the code and prints your refresh token. Copy it into .env.
 *
 * Required .env vars: ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REDIRECT_URI
 * ZOHO_REDIRECT_URI must EXACTLY match one of the "Authorized Redirect URIs"
 * registered on your client in the Zoho API Console.
 */
require('dotenv').config();
const axios = require('axios');

// Exact scope names from the official Zoho Books + Zoho Inventory OAuth docs
const SCOPES = [
    // Zoho Books — invoices, credit notes, payments, contacts, settings
    'ZohoBooks.invoices.ALL',
    'ZohoBooks.creditnotes.ALL',
    'ZohoBooks.customerpayments.ALL',
    'ZohoBooks.contacts.ALL',
    'ZohoBooks.settings.ALL',
    // Zoho Inventory — items + stock adjustments
    'ZohoInventory.items.READ',
    'ZohoInventory.items.CREATE',
    'ZohoInventory.items.UPDATE',
    'ZohoInventory.inventoryadjustments.CREATE',
    'ZohoInventory.inventoryadjustments.READ',
    'ZohoInventory.settings.READ'
].join(',');

const domain = process.env.ZOHO_BOOKS_DOMAIN || 'zoho.in';
const ACCOUNTS_BASE = `https://accounts.${domain}`;

const clientId = process.env.ZOHO_CLIENT_ID || '';
const clientSecret = process.env.ZOHO_CLIENT_SECRET || '';
const redirectUri = process.env.ZOHO_REDIRECT_URI || '';

function fail(msg) {
    console.error('❌ ' + msg);
    process.exit(1);
}

function printAuthUrl() {
    if (!clientId) fail('ZOHO_CLIENT_ID is not set in .env');
    if (!redirectUri) fail('ZOHO_REDIRECT_URI is not set in .env — it must exactly match an Authorized Redirect URI in the API Console');

    const url =
        `${ACCOUNTS_BASE}/oauth/v2/auth` +
        `?scope=${encodeURIComponent(SCOPES)}` +
        `&client_id=${encodeURIComponent(clientId)}` +
        `&response_type=code` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&access_type=offline` +
        `&prompt=consent`;

    console.log('');
    console.log('1) Open this URL in your browser (logged into your Zoho account):');
    console.log('');
    console.log('   ' + url);
    console.log('');
    console.log('2) Click "Accept" on the consent screen.');
    console.log('3) The browser jumps to your redirect URI. The page may show an error —');
    console.log('   that is EXPECTED. Copy the value of the code= parameter from the address bar.');
    console.log('4) Run:  node scripts/zoho_get_refresh_token.js <paste_code_here>');
}

async function exchange(code) {
    if (!clientId || !clientSecret || !redirectUri) {
        fail('ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET and ZOHO_REDIRECT_URI must all be set in .env');
    }

    try {
        const res = await axios.post(`${ACCOUNTS_BASE}/oauth/v2/token`, new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri
        }));

        const refreshToken = res.data && res.data.refresh_token;
        if (!refreshToken) {
            console.error('Zoho did not return a refresh_token. Response:', JSON.stringify(res.data, null, 2));
            process.exit(1);
        }

        console.log('');
        console.log('✅ Refresh token generated — paste this into your .env:');
        console.log('');
        console.log('   ZOHO_REFRESH_TOKEN=' + refreshToken);
        console.log('');
    } catch (e) {
        const body = e.response && e.response.data;
        console.error('Token exchange failed:', body ? JSON.stringify(body) : e.message);
        process.exit(1);
    }
}

const code = process.argv[2];
if (code) {
    exchange(code);
} else {
    printAuthUrl();
}
