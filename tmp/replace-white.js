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

    // Replace all white circles with the small white square (often referred to as white diamond)
    content = content.replace(/⚪/g, '▫️');

    if (content !== original) {
        fs.writeFileSync(f, content);
        console.log(`Replaced ⚪ with ▫️ in ${f}`);
    }
});
