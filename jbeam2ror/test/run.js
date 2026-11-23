// End-to-end test: build the sample mod, convert it, validate the .truck output,
// and check the physics-specific expectations.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const J2R = require('../jbeam2ror.js');
const { validate } = require('./validate-truck.js');

let failed = 0;
const check = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failed++; };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'j2r-'));
  execFileSync(process.execPath, [path.join(__dirname, 'make-sample.js'), dir]);
  const src = async (p) => ({ name: path.basename(p), entries: await J2R.openZip(await fs.openAsBlob(p)) });
  const lib = await J2R.loadLibrary([await src(path.join(dir, 'testcar_mod.zip')), await src(path.join(dir, 'common.zip'))]);

  // Parser edge cases
  const p = J2R.parseJBeam('{"a": [1 2 3] /*c*/ "b": {"x": -.5, "y": FLT_MAX,} // tail\n "c": "$=1+2"}');
  check(p.a.length === 3 && p.b.x === -0.5 && p.b.y === 'FLT_MAX' && p.c === '$=1+2', 'relaxed JBeam syntax parses');
  check(J2R.evalExpression('$a * 2 + max(1, $b) ^ 2', (v) => ({ $a: 3, $b: 2 })[v]) === 10, 'expressions evaluate');
  check(J2R.evalExpression('$a > 1 and 5 or 7', () => 0) === 7, 'Lua-style and/or');

  const r = J2R.convert(lib, {});
  const truck = r.truck;
  const v = validate(truck);
  check(v.ok, `generated .truck passes the RoR syntax checks${v.ok ? '' : ': ' + v.errors.slice(0, 5).join('; ')}`);
  check(/^minimass\n0\.01, l$/m.test(truck), 'minimass override present (no 50 kg default)');
  check(/^enable_advanced_deformation$/m.test(truck), 'advanced deformation enabled');
  check(r.report.stats.config === 'sport', 'picked the .pc configuration');
  check(/tire_F_195/.test(JSON.stringify(lib.configs[0].data)) && /0\.315, 0\.195, 12/.test(truck), 'tire chosen by the .pc applied to the front wheels');
  check(/52000, 3500, 0\.3, 0\.3, 1\.08/.test(truck), '.pc variable override reached the front springs');
  check(r.report.stats.drivenWheels === 2, 'rear wheels driven via powertrain connectedWheel');
  check(/^engine\n\d+, \d+, 300, 3\.9, 3\.4, 1, 3\.6, 2\.2, 1\.5, 1\.15, 0\.9, 0\.75, -1$/m.test(truck), 'engine/gearbox/final drive converted');
  check(r.report.selfTest && r.report.selfTest.stable, 'physics self-test passes');

  // Node masses must be the BeamNG ones
  const m = /^\d+, [-\d.]+, [-\d.]+, [-\d.]+, l, 28 ;b0l$/m.test(truck);
  check(m, 'node masses copied exactly');

  // node numbers by BeamNG name (from the ;name comments)
  const num = (name) => (truck.match(new RegExp(`^(\\d+), .* ;${name}$`, 'm')) || [])[1];

  // Steering signs: left and right hydros must have opposite factors that turn the wheels right on "right"
  const hy = [...truck.matchAll(/^(\d+), (\d+), (-?[\d.]+), [ni]$/gm)].filter((x) => x[1] === num('fs1l') || x[1] === num('fs1r')).sort((a, b) => (a[1] === num('fs1l') ? -1 : 1)).map((x) => +x[3]);
  check(hy.length === 2 && hy[0] < 0 && hy[1] > 0, `steering factors ${hy.join(', ')}`);

  // Wheels: axis order consistent (left wheel node1 inner, right wheel node1 outer)
  check(new RegExp(`12, ${num('fw1l')}, ${num('fw2l')}, 9999`).test(truck) && new RegExp(`12, ${num('fw2r')}, ${num('fw1r')}, 9999`).test(truck), 'wheel axes ordered for forward drive');

  // Defaults that keep BeamNG cars from floating / hidden under their skeleton in RoR
  const cabLines = truck.slice(truck.indexOf('\ncab\n')).split('\n').slice(2).filter((l) => /^\d/.test(l));
  check(cabLines.length > 0 && cabLines.every((l) => l.endsWith(', n')), 'body panels drawn but not solid (no RoR self-collision push)');
  const beamLines = truck.slice(truck.indexOf('\nbeams\n')).split('\n').slice(2).filter((l) => /^\d+, \d+/.test(l)).slice(0, 50);
  check(beamLines.every((l) => /, s?i$/.test(l)), 'beam skeleton hidden by default');

  // Zip round-trip
  const zip = J2R.buildModZip(r);
  const back = await J2R.openZip(new Blob([zip]));
  check(back.length === 2 && new TextDecoder().decode(await back[0].read()) === truck, 'output zip round-trips');

  console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
