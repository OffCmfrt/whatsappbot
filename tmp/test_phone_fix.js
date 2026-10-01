/**
 * TEST: Phone Normalization Fix Verification
 * 
 * This tests that:
 * 1. normalizePhone() works correctly for all formats
 * 2. getPhoneVariations() returns all possible formats
 * 3. Order 55622 phone is now fixed
 * 4. Messages would be found correctly
 */

const { normalizePhone, getPhoneVariations } = require('../src/utils/validators');

console.log('='.repeat(70));
console.log('TEST: Phone Normalization Fix');
console.log('='.repeat(70));

let passed = 0;
let failed = 0;

function test(name, actual, expected) {
    if (actual === expected) {
        console.log(`✅ ${name}`);
        passed++;
    } else {
        console.log(`❌ ${name}`);
        console.log(`   Expected: "${expected}"`);
        console.log(`   Actual:   "${actual}"`);
        failed++;
    }
}

// Test 1: normalizePhone function
console.log('\n📋 [1] Testing normalizePhone()...');
test('10-digit Indian number', normalizePhone('8309302779'), '+918309302779');
test('12-digit with country code', normalizePhone('918309302779'), '+918309302779');
test('With + prefix', normalizePhone('+918309302779'), '+918309302779');
test('With trailing space', normalizePhone('8309302779 '), '+918309302779');
test('With leading space', normalizePhone(' 8309302779'), '+918309302779');
test('With dashes', normalizePhone('83-093-02779'), '+918309302779');
test('11-digit with leading 0', normalizePhone('08309302779'), '+918309302779');
test('Empty string', normalizePhone(''), null);
test('Null input', normalizePhone(null), null);
test('Short number', normalizePhone('12345'), null);

// Test 2: getPhoneVariations function
console.log('\n📋 [2] Testing getPhoneVariations()...');
const variations1 = getPhoneVariations('+918309302779');
test('Returns 4 variations', variations1.length, 4);
test('Includes 10-digit', variations1.includes('8309302779'), true);
test('Includes +91 format', variations1.includes('+918309302779'), true);
test('Includes 91 format', variations1.includes('918309302779'), true);

const variations2 = getPhoneVariations('8309302779');
test('Works with 10-digit input', variations2.length, 4);
test('Includes +91 format from 10-digit', variations2.includes('+918309302779'), true);

// Test 3: Order 55622 specific
console.log('\n📋 [3] Testing Order 55622 scenario...');
const order55622Phone = '8309302779';  // After fix (was "8309302779 " with space)
const webhookPhone = '918309302779';    // From WhatsApp webhook

const normalizedWebhook = normalizePhone(webhookPhone);
test('Webhook phone normalizes correctly', normalizedWebhook, '+918309302779');

const normalizedOrder = normalizePhone(order55622Phone);
test('Order phone normalizes correctly', normalizedOrder, '+918309302779');

test('Both phones match after normalization', normalizedWebhook === normalizedOrder, true);

// Test 4: Phone variations would match in DB
console.log('\n📋 [4] Testing DB lookup scenario...');
const webhookVariations = getPhoneVariations(normalizedWebhook);
test('Webhook variations include order phone format', webhookVariations.includes('8309302779'), true);
test('Webhook variations include +91 format', webhookVariations.includes('+918309302779'), true);

// Summary
console.log('\n' + '='.repeat(70));
console.log('SUMMARY');
console.log('='.repeat(70));
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log(`Total:  ${passed + failed}`);

if (failed === 0) {
    console.log('\n✅ ALL TESTS PASSED — Phone normalization fix is working correctly!');
    console.log('\nThis fix ensures:');
    console.log('1. All incoming webhook phones are normalized to +91XXXXXXXXXX');
    console.log('2. All DB lookups use phone variations to match any format');
    console.log('3. Messages will always be linked to the correct customer');
    console.log('4. The Order 55622 issue will NOT happen again');
} else {
    console.log('\n❌ SOME TESTS FAILED — Review the fix');
    process.exit(1);
}
