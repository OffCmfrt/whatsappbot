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
const oldLine = '\u3164\u3164\u3164\u3164━━━━━━\u3164\u3164\u3164\u3164';
// Use 9 Non-Breaking Spaces for a more standard width that doesn't push too far right
const newLine = '\xA0\xA0\xA0\xA0\xA0\xA0\xA0\xA0\xA0━━━━━━\xA0\xA0\xA0\xA0\xA0\xA0\xA0\xA0\xA0';

files.forEach(f => {
    let content = fs.readFileSync(f, 'utf8');
    let changed = false;
    
    if(content.includes(oldLine)) {
        content = content.replace(new RegExp(oldLine, 'g'), newLine);
        changed = true;
    }

    if(changed) {
        fs.writeFileSync(f, content);
        console.log(`Updated ${f} for new centering`);
    }
});
