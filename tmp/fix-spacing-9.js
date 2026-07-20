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

// Current 6-braille divider
const currentDivider = '\u2800\u2800\u2800\u2800\u2800\u2800━━━━\u2800\u2800\u2800\u2800\u2800\u2800';

// New: 10-braille divider with a forced invisible newline at the very beginning to push it off the ceiling
const newDivider = '\u2800\\n\u2800\u2800\u2800\u2800\u2800\u2800\u2800\u2800\u2800\u2800━━━━\u2800\u2800\u2800\u2800\u2800\u2800\u2800\u2800\u2800\u2800';

files.forEach(f => {
    let content = fs.readFileSync(f, 'utf8');
    
    if (content.includes(currentDivider)) {
        content = content.replace(new RegExp(currentDivider, 'g'), newDivider);
        fs.writeFileSync(f, content);
        console.log(`Updated ${f} with final 10-character centering + top padding ceiling drop`);
    } else if (content.includes('\\n\\n⚫ *OFFCOMFRT*')) {
        // Just in case we need to verify things.
    }
});
