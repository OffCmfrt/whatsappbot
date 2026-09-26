/**
 * Fix all phone numbers in the database to consistent format: +91XXXXXXXXXX
 * 
 * This script:
 * 1. Identifies phones with trailing spaces, missing country codes, etc.
 * 2. Normalizes them to +91XXXXXXXXXX format
 * 3. Updates all related tables to maintain consistency
 * 
 * Usage:
 *   node scripts/fix_phone_normalization.js           # Dry run
 *   node scripts/fix_phone_normalization.js --apply   # Apply changes
 */

require('dotenv').config();
const { Pool } = require('pg');

const APPLY = process.argv.includes('--apply');

function normalizePhone(phone) {
    if (!phone) return null;
    const cleaned = String(phone).trim().replace(/\D/g, '');
    if (cleaned.length === 10) return `+91${cleaned}`;
    if (cleaned.length === 12 && cleaned.startsWith('91')) return `+${cleaned}`;
    if (cleaned.length === 11 && cleaned.startsWith('0')) return `+91${cleaned.slice(1)}`;
    return cleaned.length >= 10 ? `+${cleaned}` : null;
}

async function main() {
    const pool = new Pool({ connectionString: process.env.SUPABASE_DB_URL });
    
    console.log('='.repeat(70));
    console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — Phone Number Normalization Fix`);
    console.log('='.repeat(70));
    
    try {
        let totalFixed = 0;
        
        // 1. Fix store_shoppers table
        console.log('\n📋 [1/5] Fixing store_shoppers.phone...');
        const shoppers = await pool.query(
            `SELECT id, phone, order_id FROM store_shoppers WHERE phone IS NOT NULL`
        );
        
        let shopperFixed = 0;
        for (const s of shoppers.rows) {
            const normalized = normalizePhone(s.phone);
            if (normalized && normalized !== s.phone) {
                console.log(`   Fix: "${s.phone}" → "${normalized}" (order: ${s.order_id})`);
                if (APPLY) {
                    await pool.query(
                        `UPDATE store_shoppers SET phone = $1 WHERE id = $2`,
                        [normalized, s.id]
                    );
                }
                shopperFixed++;
            }
        }
        console.log(`   ${shopperFixed} record(s) ${APPLY ? 'fixed' : 'need fixing'}`);
        totalFixed += shopperFixed;
        
        // 2. Fix customers table
        console.log('\n📋 [2/5] Fixing customers.phone...');
        const customers = await pool.query(
            `SELECT phone, name FROM customers WHERE phone IS NOT NULL`
        );
        
        let customerFixed = 0;
        const customerUpdates = new Map(); // old -> new
        for (const c of customers.rows) {
            const normalized = normalizePhone(c.phone);
            if (normalized && normalized !== c.phone) {
                console.log(`   Fix: "${c.phone}" → "${normalized}" (name: ${c.name})`);
                customerUpdates.set(c.phone, normalized);
                customerFixed++;
            }
        }
        
        if (APPLY && customerUpdates.size > 0) {
            for (const [oldPhone, newPhone] of customerUpdates) {
                // Check if normalized phone already exists
                const existing = await pool.query(
                    `SELECT phone FROM customers WHERE phone = $1`,
                    [newPhone]
                );
                if (existing.rows.length > 0) {
                    console.log(`   ⚠️  Skipping "${oldPhone}" → "${newPhone}" (already exists)`);
                    // Merge: update references to point to existing, then delete duplicate
                    await pool.query(
                        `UPDATE messages SET customer_phone = $1 WHERE customer_phone = $2`,
                        [newPhone, oldPhone]
                    );
                    await pool.query(
                        `UPDATE support_tickets SET customer_phone = $1 WHERE customer_phone = $2`,
                        [newPhone, oldPhone]
                    );
                    await pool.query(
                        `DELETE FROM customers WHERE phone = $1`,
                        [oldPhone]
                    );
                } else {
                    await pool.query(
                        `UPDATE customers SET phone = $1 WHERE phone = $2`,
                        [newPhone, oldPhone]
                    );
                }
            }
        }
        console.log(`   ${customerFixed} record(s) ${APPLY ? 'fixed' : 'need fixing'}`);
        totalFixed += customerFixed;
        
        // 3. Fix messages table
        console.log('\n📋 [3/5] Fixing messages.customer_phone...');
        const messages = await pool.query(
            `SELECT DISTINCT customer_phone FROM messages WHERE customer_phone IS NOT NULL`
        );
        
        let messageFixed = 0;
        for (const m of messages.rows) {
            const normalized = normalizePhone(m.customer_phone);
            if (normalized && normalized !== m.customer_phone) {
                const count = await pool.query(
                    `SELECT COUNT(*) as cnt FROM messages WHERE customer_phone = $1`,
                    [m.customer_phone]
                );
                console.log(`   Fix: "${m.customer_phone}" → "${normalized}" (${count.rows[0].cnt} messages)`);
                if (APPLY) {
                    await pool.query(
                        `UPDATE messages SET customer_phone = $1 WHERE customer_phone = $2`,
                        [normalized, m.customer_phone]
                    );
                }
                messageFixed += parseInt(count.rows[0].cnt);
            }
        }
        console.log(`   ${messageFixed} message(s) ${APPLY ? 'fixed' : 'need fixing'}`);
        totalFixed += messageFixed;
        
        // 4. Fix support_tickets table
        console.log('\n📋 [4/5] Fixing support_tickets.customer_phone...');
        const tickets = await pool.query(
            `SELECT DISTINCT customer_phone FROM support_tickets WHERE customer_phone IS NOT NULL`
        );
        
        let ticketFixed = 0;
        for (const t of tickets.rows) {
            const normalized = normalizePhone(t.customer_phone);
            if (normalized && normalized !== t.customer_phone) {
                const count = await pool.query(
                    `SELECT COUNT(*) as cnt FROM support_tickets WHERE customer_phone = $1`,
                    [t.customer_phone]
                );
                console.log(`   Fix: "${t.customer_phone}" → "${normalized}" (${count.rows[0].cnt} tickets)`);
                if (APPLY) {
                    await pool.query(
                        `UPDATE support_tickets SET customer_phone = $1 WHERE customer_phone = $2`,
                        [normalized, t.customer_phone]
                    );
                }
                ticketFixed += parseInt(count.rows[0].cnt);
            }
        }
        console.log(`   ${ticketFixed} ticket(s) ${APPLY ? 'fixed' : 'need fixing'}`);
        totalFixed += ticketFixed;
        
        // 5. Fix conversations table
        console.log('\n📋 [5/5] Fixing conversations.customer_phone...');
        const convs = await pool.query(
            `SELECT DISTINCT customer_phone FROM conversations WHERE customer_phone IS NOT NULL`
        );
        
        let convFixed = 0;
        for (const c of convs.rows) {
            const normalized = normalizePhone(c.customer_phone);
            if (normalized && normalized !== c.customer_phone) {
                console.log(`   Fix: "${c.customer_phone}" → "${normalized}"`);
                if (APPLY) {
                    await pool.query(
                        `UPDATE conversations SET customer_phone = $1 WHERE customer_phone = $2`,
                        [normalized, c.customer_phone]
                    );
                }
                convFixed++;
            }
        }
        console.log(`   ${convFixed} record(s) ${APPLY ? 'fixed' : 'need fixing'}`);
        totalFixed += convFixed;
        
        // Summary
        console.log('\n' + '='.repeat(70));
        console.log('SUMMARY');
        console.log('='.repeat(70));
        console.log(`Total records ${APPLY ? 'fixed' : 'needing fix'}: ${totalFixed}`);
        console.log(`Mode: ${APPLY ? '✅ APPLY — changes committed' : '🔍 DRY RUN — no changes made'}`);
        
        if (!APPLY && totalFixed > 0) {
            console.log('\n💡 Run with --apply to commit changes:');
            console.log('   node scripts/fix_phone_normalization.js --apply');
        }
        
    } catch (error) {
        console.error('\n❌ Error:', error.message);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
}

main();
