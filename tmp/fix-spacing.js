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
// We will use U+3164 (Hangul Filler) which WhatsApp respects as a visible character 
// and will not strip, forcing the line to stay centered.
const centeredLine = '\u3164\u3164\u3164\u3164━━━━━━\u3164\u3164\u3164\u3164';

files.forEach(f => {
    let content = fs.readFileSync(f, 'utf8');
    let changed = false;
    
    // Replace the incorrectly spaced line
    if(content.includes('      ━━━━━━      ')) {
        content = content.replace(/      ━━━━━━      /g, centeredLine);
        changed = true;
    }
    
    // Just in case it was replaced without spaces somewhere
    if(content.includes('\\n━━━━━━\\n') && !content.includes(centeredLine)) {
        content = content.replace(/\\n━━━━━━\\n/g, '\\n' + centeredLine + '\\n');
        changed = true;
    }

    if(changed) {
        fs.writeFileSync(f, content);
        console.log(`Updated ${f} for centering`);
    }
});
