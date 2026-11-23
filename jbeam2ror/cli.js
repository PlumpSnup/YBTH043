#!/usr/bin/env node
// Command-line front end for jbeam2ror.
//   node cli.js <mod.zip | mod-folder> [--extra BeamNG/content/vehicles/common.zip ...]
//               [--model NAME] [--config NAME] [--out DIR] [--list] [--no-cab] [--hide-beams]
'use strict';
const fs = require('fs');
const path = require('path');
const J2R = require('./jbeam2ror.js');

function usage() {
  console.log(`Usage: node cli.js <mod.zip|folder> [options]

Options:
  --extra <zip|folder>  Extra content to look parts up in, e.g. BeamNG's
                        content/vehicles/common.zip (repeatable)
  --model <name>        Vehicle folder name, if the mod has several vehicles
  --config <name>       Configuration (.pc file name without extension)
  --out <dir>           Where to write the RoR mod zip (default: current dir)
  --list                List vehicles and configurations, then exit
  --no-cab              Don't create the collision/body surface
  --show-beams          Draw the node/beam skeleton in RoR
  --cab-collision       Make body panels solid (can make BeamNG cars float in RoR)`);
}

async function openSource(p) {
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    const entries = [];
    (function walk(dir) {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        const s = fs.statSync(full);
        if (s.isDirectory()) walk(full);
        else entries.push({ path: path.relative(p, full).split(path.sep).join('/'), size: s.size, read: async () => new Uint8Array(fs.readFileSync(full)) });
      }
    })(p);
    return { name: path.basename(p), entries };
  }
  const blob = await fs.openAsBlob(p);
  return { name: path.basename(p), entries: await J2R.openZip(blob) };
}

(async () => {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('-h') || args.includes('--help')) { usage(); process.exit(args.length ? 0 : 1); }
  const opts = { extra: [], cab: true, visibleBeams: false, cabCollision: false };
  let input = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--extra') opts.extra.push(args[++i]);
    else if (a === '--model') opts.model = args[++i];
    else if (a === '--config') opts.config = args[++i];
    else if (a === '--out') opts.out = args[++i];
    else if (a === '--list') opts.list = true;
    else if (a === '--no-cab') opts.cab = false;
    else if (a === '--show-beams') opts.visibleBeams = true;
    else if (a === '--cab-collision') opts.cabCollision = true;
    else if (!input) input = a;
    else { console.error(`Unknown argument: ${a}`); process.exit(1); }
  }
  const sources = [await openSource(input)];
  for (const e of opts.extra) sources.push(await openSource(e));
  const lib = await J2R.loadLibrary(sources, (m) => console.log(m));
  const vehicles = J2R.listVehicles(lib);
  if (opts.list) {
    for (const v of vehicles) console.log(`${v.model}  "${v.title}"  configs: ${v.configs.join(', ') || '(none)'}`);
    return;
  }
  const result = J2R.convert(lib, opts);
  const outDir = opts.out || '.';
  fs.mkdirSync(outDir, { recursive: true });
  const zipPath = path.join(outDir, `${result.fileBase}.zip`);
  fs.writeFileSync(zipPath, J2R.buildModZip(result));
  const s = result.report.stats;
  console.log(`\nConverted ${s.vehicle} [${s.config}]`);
  console.log(`  ${s.nodes} nodes, ${s.beams} beams, ${s.shocks} springs/dampers, ${s.steeringHydros} steering hydros`);
  console.log(`  ${s.wheels} wheels (${s.drivenWheels} driven), ${s.triangles} body triangles, ~${s.massKg} kg`);
  console.log(`  engine: ${s.engine}`);
  console.log(`  physics self-test: ${s.selfTest}`);
  if (result.report.warnings.length) {
    console.log('\nNotes:');
    for (const w of result.report.warnings) console.log(`  - ${w}`);
  }
  if (result.report.loadErrors.length) {
    console.log('\nFiles that could not be read:');
    for (const w of result.report.loadErrors) console.log(`  - ${w}`);
  }
  console.log(`\nWrote ${zipPath}\nCopy it into Documents/My Games/Rigs of Rods/mods and pick it in the vehicle selector.`);
})().catch((e) => { console.error(`Error: ${e.message}`); process.exit(1); });
