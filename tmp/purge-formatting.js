const fs = require('fs');
const path = require('path');

function walk(dir) {
    let results = [];
    const list = fs.readdirSync(dir);
    list.forEach(file => {
        if(file.includes('node_modules')) return;
        file = path.join(dir, file);
        if (fs.statSync(file).isDirectory()) {
            results = results.concat(walk(file));
        } else if (file.endsWith('.js')) {
            results.push(file);
        }
    });
    return results;
}

const files = walk('./src');

files.forEach(f => {
    let content = fs.readFileSync(f, 'utf8');
    let original = content;

    // Purge the current complex dividers:
    // \u2800\n\u2800\u2800\u2800\u2800\u2800\u2800\u2800\u2800\u2800\u2800━━━━\u2800\u2800\u2800\u2800\u2800\u2800\u2800\u2800\u2800\u2800
    // and older formatting remnants across all files
    content = content.replace(/\\n\\n\u2800\\n\u2800{10}━━━━\u2800{10}/g, '');
    content = content.replace(/\\n\u2800\\n\u2800{10}━━━━\u2800{10}/g, '');
    content = content.replace(/\u2800\\n\u2800{10}━━━━\u2800{10}\\n\\n/g, '');
    content = content.replace(/\u2800\\n\u2800{10}━━━━\u2800{10}\\n/g, '');
    content = content.replace(/\u2800\\n\u2800{10}━━━━\u2800{10}/g, '');
    
    // Purge specific black circles and replace with suitable alternatives if they are static headers
    content = content.replace(/⚫ \*OFFCOMFRT — CONTACT SUPPORT\*/g, '🎧 *Contact Support*');
    content = content.replace(/⚫ \*OFFCOMFRT — ORDER CONFIRMED\*/g, '✅ *Order Confirmed*');
    content = content.replace(/⚫ \*OFFCOMFRT — CANCELLATION\*/g, '❌ *Order Cancellation*');
    content = content.replace(/⚫ \*OFFCOMFRT — EDIT ORDER\*/g, '📝 *Edit Order Details*');
    
    // Fallbacks for any remaining formatting
    content = content.replace(/⚫ \*OFFCOMFRT\*/g, '📱 *OffComfrt*');
    content = content.replace(/⚫ OFFCOMFRT/g, '📱 OffComfrt');
    content = content.replace(/⚪ /g, '🔸 ');
    content = content.replace(/▫️ /g, '🔸 ');
    content = content.replace(/⠀\\n⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀━━━━⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀\\n/g, '');
    content = content.replace(/\\n⠀\\n⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀━━━━⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀/g, '');

    if (content !== original) {
        fs.writeFileSync(f, content);
        console.log(`Purged formatting from ${f}`);
    }
});
