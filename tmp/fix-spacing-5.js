const fs = require('fs');
const path = require('path');

function walk(dir) {
    let results = [];
    const list = fs.readdirSync(dir);
    list.forEach(file => {
        if(file.includes('node_modules')) return;
        file = path.join(dir, file);
        const stat = fs.statSync(file);
        if (stat && stat.isDirectory()) {
            results = results.concat(walk(file));
        } else if (file.endsWith('.js')) {
            results.push(file);
        }
    });
    return results;
}

const files = walk('./src');
const oldLine = '\u2800\u2800\u2800\u2800\u2800\u2800━━━━━━\u2800\u2800\u2800\u2800\u2800\u2800';

// Use a single Braille to stop WhatsApp trimming, then use 8 normal spaces for finer granular centering.
// This ensures that the line is perfectly in the centre down to the pixel on most screens.
const newLine = '\u2800        ━━━━━━        \u2800';

files.forEach(f => {
    let content = fs.readFileSync(f, 'utf8');
    let changed = false;
    
    if(content.includes(oldLine)) {
        content = content.replace(new RegExp(oldLine, 'g'), newLine);
        changed = true;
    }

    if(changed) {
        fs.writeFileSync(f, content);
        console.log(`Updated ${f} with granular space centering`);
    }
});
