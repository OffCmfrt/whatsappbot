/**
 * Probe which place_of_supply value Zoho accepts for the merged UT
 * (Dadra and Nagar Haveli and Daman and Diu) using the real #45925 customer.
 */
require('dotenv').config();
const zohoService = require('../src/services/zohoService');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const sleepGap = 12000;

async function main() {
    // 1. find customer
    const custs = await zohoService.searchCustomer({ contact_name: 'Harsh Naresh' });
    console.log('customers found:', custs.length);
    const cust = custs[0];
    if (!cust) throw new Error('customer not found');
    console.log('contact_id:', cust.contact_id);
    await sleep(3000);

    // 2. inspect stored address
    const full = await zohoRequestSafe('GET', `/contacts/${cust.contact_id}`);
    const ba = full.contact?.billing_address || {};
    console.log('billing address stored:', JSON.stringify({ state: ba.state, state_code: ba.state_code, city: ba.city, country_code: ba.country_code }));
    await sleep(3000);

    // 3. probe place_of_supply variants
    const variants = ['DH', 'DN', 'DD', '26'];
    for (const pos of variants) {
        await sleep(sleepGap);
        const payload = baseInvoice(cust.contact_id, pos);
        try {
            const inv = await zohoService.createInvoice(payload);
            const detail = await zohoService.getInvoice(inv.invoice_id);
            const taxes = new Set();
            for (const li of detail.line_items || []) for (const t of li.line_item_taxes || []) taxes.add(`${t.tax_name}${t.tax_percentage}`);
            console.log(`✅ pos='${pos}' → invoice ${detail.invoice_number} | place_of_supply=${detail.place_of_supply} | taxes: ${[...taxes].join(', ') || 'NONE'}`);
            await sleep(3000);
            await zohoService.deleteInvoice(inv.invoice_id);
            console.log(`   🗑 deleted probe invoice`);
        } catch (e) {
            console.log(`❌ pos='${pos}' → ${e.message}`);
        }
    }

    // 4. no place_of_supply at all (rely on contact address)
    await sleep(sleepGap);
    try {
        const inv = await zohoService.createInvoice(baseInvoice(cust.contact_id, null));
        const detail = await zohoService.getInvoice(inv.invoice_id);
        const taxes = new Set();
        for (const li of detail.line_items || []) for (const t of li.line_item_taxes || []) taxes.add(`${t.tax_name}${t.tax_percentage}`);
        console.log(`✅ pos=<none> → invoice ${detail.invoice_number} | place_of_supply=${detail.place_of_supply} | taxes: ${[...taxes].join(', ') || 'NONE'}`);
        await sleep(3000);
        await zohoService.deleteInvoice(inv.invoice_id);
        console.log(`   🗑 deleted probe invoice`);
    } catch (e) {
        console.log(`❌ pos=<none> → ${e.message}`);
    }
}

// raw helper for GET contact
const axios = require('axios');
async function zohoRequestSafe(method, path, force = false) {
    const token = await zohoService.getAccessToken(force);
    const tld = (process.env.ZOHO_BOOKS_DOMAIN || 'zoho.in').split('.').pop();
    const res = await axios({
        method, url: `https://www.zohoapis.${tld}/books/v3${path}`,
        headers: { Authorization: 'Zoho-oauthtoken ' + token, 'X-composer-orgid': process.env.ZOHO_ORGANIZATION_ID, 'Content-Type': 'application/json' },
        validateStatus: () => true
    });
    if (res.status === 401 && !force) return zohoRequestSafe(method, path, true);
    if (res.status >= 400) throw new Error(`Zoho ${res.status}: ${JSON.stringify(res.data)}`);
    return res.data;
}

function baseInvoice(contactId, pos) {
    const p = {
        customer_id: contactId,
        invoice_number: '',
        reference_number: 'PROBE45925-' + Date.now(),
        date: new Date().toISOString().slice(0, 10),
        payment_terms: 0,
        payment_terms_label: 'Due on receipt',
        gst_treatment: 'consumer',
        line_items: [{
            name: 'PROBE ITEM',
            quantity: 1,
            rate: 100,
            tax_id: ''
        }],
        shipping_address: {
            address: '3/957 Sea Face Road Nani Daman',
            city: 'DAMAN',
            state: 'Dadra and Nagar Haveli and Daman and Diu',
            state_code: pos || 'DH',
            zip: '396210',
            country: 'India',
            country_code: 'IN',
            attention: 'Harsh Naresh'
        }
    };
    if (pos) p.place_of_supply = pos;
    return p;
}

main().then(() => process.exit(0)).catch(e => { console.error('💥', e.message); process.exit(1); });
