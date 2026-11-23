// Writes the synthetic test mod and fake common.zip to a folder: node make-sample.js [dir]
'use strict';
const fs = require('fs');
const path = require('path');
const J2R = require('../jbeam2ror.js');
const { buildSample } = require('./sample.js');

const out = process.argv[2] || path.join(__dirname, 'out');
fs.mkdirSync(out, { recursive: true });
const { modZip, commonZip } = buildSample(J2R);
fs.writeFileSync(path.join(out, 'testcar_mod.zip'), modZip);
fs.writeFileSync(path.join(out, 'common.zip'), commonZip);
console.log(`Wrote ${path.join(out, 'testcar_mod.zip')} and ${path.join(out, 'common.zip')}`);
