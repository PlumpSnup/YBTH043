// Builds the web page in two forms from page.html:
//   index.html                 - loads jbeam2ror.js and test/sample.js next to it (for hosting the folder)
//   dist/jbeam2ror.html        - everything inlined into one self-contained file
'use strict';
const fs = require('fs');
const path = require('path');
const here = __dirname;
const page = fs.readFileSync(path.join(here, 'page.html'), 'utf8');
const lib = fs.readFileSync(path.join(here, 'jbeam2ror.js'), 'utf8');
const sample = fs.readFileSync(path.join(here, 'test', 'sample.js'), 'utf8');

const wrapDoc = (body) => `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n</head>\n<body>\n${body}\n</body>\n</html>\n`;

fs.writeFileSync(path.join(here, 'index.html'), wrapDoc(page.replace('<!--LIB-->', '<script src="jbeam2ror.js"></script>\n<script src="test/sample.js"></script>')));
fs.mkdirSync(path.join(here, 'dist'), { recursive: true });
const inline = page.replace('<!--LIB-->', () => `<script>\n${lib}\n</script>\n<script>\n${sample}\n</script>`);
fs.writeFileSync(path.join(here, 'dist', 'jbeam2ror.html'), wrapDoc(inline));
fs.writeFileSync(path.join(here, 'dist', 'artifact.html'), inline); // body-only variant for hosts that add their own skeleton
console.log('Built index.html and dist/jbeam2ror.html');
