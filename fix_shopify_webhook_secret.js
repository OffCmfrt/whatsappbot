// Shopify Webhook Secret Fix Script
// This script helps you diagnose and fix the HMAC verification issue

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

console.log('╔══════════════════════════════════════════════════════════════╗');
console.log('║     SHOPIFY WEBHOOK SECRET DIAGNOSTIC TOOL                 ║');
console.log('╚══════════════════════════════════════════════════════════════╝\n');

// Check if .env file exists
const envPath = path.join(__dirname, '.env');
if (!fs.existsSync(envPath)) {
    console.error('❌ .env file not found!');
    console.log('Please create a .env file based on .env.example');
    process.exit(1);
}

// Read .env file
const envContent = fs.readFileSync(envPath, 'utf8');
const envLines = envContent.split('\n');

// Find SHOPIFY_WEBHOOK_SECRET
let currentSecret = null;
let secretLineIndex = -1;

for (let i = 0; i < envLines.length; i++) {
    const line = envLines[i].trim();
    if (line.startsWith('SHOPIFY_WEBHOOK_SECRET=')) {
        currentSecret = line.substring('SHOPIFY_WEBHOOK_SECRET='.length).trim();
        secretLineIndex = i;
        break;
    }
}

console.log('📋 Current Configuration:');
console.log('─'.repeat(60));

if (currentSecret) {
    console.log(`✅ SHOPIFY_WEBHOOK_SECRET is set`);
    console.log(`   Current value (first 8 chars): ${currentSecret.substring(0, 8)}...`);
    console.log(`   Length: ${currentSecret.length} characters`);
} else {
    console.log('❌ SHOPIFY_WEBHOOK_SECRET is NOT set in .env file');
}

console.log('\n📝 Instructions to Fix:');
console.log('─'.repeat(60));
console.log('1️⃣  Go to your Shopify Admin Dashboard');
console.log('2️⃣  Navigate to: Settings → Notifications → Webhooks');
console.log('3️⃣  Find the webhook endpoints for your app');
console.log('4️⃣  Click on the webhook to view details');
console.log('5️⃣  Copy the "Webhook secret" (it looks like: whsec_xxxxxxxxxxxx)');
console.log('6️⃣  Update your .env file with the correct secret');
console.log('7️⃣  Restart your server\n');

console.log('🔧 How to Update:');
console.log('─'.repeat(60));

if (currentSecret) {
    console.log('Option 1: Manual Update');
    console.log('  - Open .env file');
    console.log('  - Find the line: SHOPIFY_WEBHOOK_SECRET=...');
    console.log('  - Replace with the correct secret from Shopify');
    console.log('');
    console.log('Option 2: Use this script (interactive)');
    console.log('  - Run: node fix_shopify_webhook_secret.js --update');
    console.log('  - Paste your new webhook secret when prompted');
} else {
    console.log('You need to add the SHOPIFY_WEBHOOK_SECRET to your .env file:');
    console.log('');
    console.log('Add this line to your .env file:');
    console.log('  SHOPIFY_WEBHOOK_SECRET=your_webhook_secret_from_shopify');
    console.log('');
    console.log('Or run this script interactively:');
    console.log('  node fix_shopify_webhook_secret.js --add');
}

console.log('\n⚠️  Important Notes:');
console.log('─'.repeat(60));
console.log('• The webhook secret is different from your API key or password');
console.log('• It\'s specifically for webhook HMAC verification');
console.log('• Each Shopify app/webhook can have a different secret');
console.log('• After updating, you MUST restart your server');
console.log('• The secret should look like: whsec_abc123... or a long random string');

console.log('\n🧪 Testing:');
console.log('─'.repeat(60));
console.log('After updating the secret:');
console.log('1. Restart your server');
console.log('2. Trigger a test order in Shopify');
console.log('3. Check the logs - you should NO LONGER see HMAC verification failed');
console.log('4. You should see successful order processing without duplicates\n');

// Check if --update flag is provided
if (process.argv.includes('--update') || process.argv.includes('--add')) {
    console.log('\n🔄 Interactive Update Mode:');
    console.log('─'.repeat(60));
    
    const readline = require('readline');
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    rl.question('\nEnter your Shopify webhook secret: ', (newSecret) => {
        if (!newSecret || newSecret.trim() === '') {
            console.log('❌ No secret provided. Exiting.');
            rl.close();
            process.exit(1);
        }

        newSecret = newSecret.trim();
        
        if (secretLineIndex >= 0) {
            // Update existing
            envLines[secretLineIndex] = `SHOPIFY_WEBHOOK_SECRET=${newSecret}`;
            console.log('✅ Updated existing SHOPIFY_WEBHOOK_SECRET');
        } else {
            // Add new
            envLines.push(`\n# Shopify Webhook Secret\nSHOPIFY_WEBHOOK_SECRET=${newSecret}`);
            console.log('✅ Added SHOPIFY_WEBHOOK_SECRET to .env file');
        }

        // Write back to .env
        fs.writeFileSync(envPath, envLines.join('\n'), 'utf8');
        
        console.log('\n✅ .env file updated successfully!');
        console.log('⚠️  IMPORTANT: Restart your server for changes to take effect');
        console.log('   Run: npm start (or restart your deployment)\n');
        
        rl.close();
        process.exit(0);
    });
}
