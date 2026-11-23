// Regression tests for JBeam features found in real mods (all data here is made up).
'use strict';
const J2R = require('../jbeam2ror.js');

let failed = 0;
const check = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failed++; };

const H = ['name', 'hubGroup', 'group', 'node1:', 'node2:', 'nodeS', 'nodeArm:', 'wheelDir'];
const box = [];
for (const [i, y] of [-1.5, 0, 1.5].entries()) for (const [s, x] of [['l', 0.6], ['r', -0.6]]) { box.push([`b${i}${s}`, x, y, 0.3]); box.push([`t${i}${s}`, x, y, 0.9]); }
const boxBeams = [];
const ids = box.map((n) => n[0]);
for (let a = 0; a < ids.length; a++) for (let b = a + 1; b < ids.length; b++) boxBeams.push([ids[a], ids[b]]);

const parts = {
  car: {
    slotType: 'main',
    slots: [['type', 'default', 'description'], ['car_body', 'car_body', ''], ['car_susp_F', 'car_susp_F', ''], ['car_susp_R', 'car_susp_R', ''], ['car_engine', 'car_engine', ''], ['car_glass', 'car_glass', '']],
    refNodes: [['ref:', 'back:', 'left:', 'up:'], ['b1l', 'b2l', 'b1r', 't1l']],
    variables: [['name', 'type', 'unit', 'category', 'default', 'min', 'max', 'title', 'description'], ['$trackoffset_F', 'range', '', '', 0.01, 0, 0.05, '', '']],
  },
  car_body: {
    slotType: 'car_body',
    nodes: [['id', 'posX', 'posY', 'posZ'], { nodeWeight: 20 }, ...box],
    beams: [['id1:', 'id2:'], { beamSpring: 2001000, beamDamp: 100 }, ...boxBeams],
    components: { headerNodePos: { x: 0.2, y: -1.2, z: 0.5 } },
  },
  car_glass: { slotType: 'car_glass', nodes: [['id', 'posX', 'posY', 'posZ'], { nodeWeight: 23.5 }, ['t1l', 0.6, 0, 0.9]] },
  car_engine: {
    slotType: 'car_engine',
    nodes: [['id', 'posX', 'posY', 'posZ'], { nodeWeight: 30 }, ['hdr', '$=$components.headerNodePos.x', '$=$components.headerNodePos.y', '$=$components.headerNodePos.z']],
    beams: [['id1:', 'id2:'], { beamSpring: 2001000, beamDamp: 100 }, ['hdr', 'b0l'], ['hdr', 'b0r'], ['hdr', 't0l'], ['hdr', 'b1l']],
    powertrain: [['type', 'name', 'inputName', 'inputIndex'], ['combustionEngine', 'mainEngine', 'dummy', 0], ['manualGearbox', 'gearbox', 'mainEngine', 1],
      ['differential', 'differential_F', 'gearbox', 1], ['shaft', 'wheelaxleFL', 'differential_F', 1], ['shaft', 'wheelaxleFR', 'differential_F', 2]],
    mainEngine: { torque: [['rpm', 'torque'], [0, 0], [3000, 150], [6000, 120]], idleRPM: 800, maxRPM: 6500 },
    gearbox: { gearRatios: [-3, 0, 3.5, 2, 1.3, 1] },
    differential_F: { gearRatio: 4.1 },
  },
};
for (const [S, s, y] of [['F', 'f', -1.3], ['R', 'r', 1.3]]) {
  parts[`car_susp_${S}`] = {
    slotType: `car_susp_${S}`,
    slots: [['type', 'default', 'description'], [`wheel_${S}`, `wheel_14x6_${S}`, '', { nodeOffset: { x: `$=case($trackwidth_${S} == nil, $trackoffset_F + 0.2, $trackwidth_${S})`, y, z: 0.3 } }], [`car_wheeldata_${S}`, `car_wheeldata_${S}`, '']],
    nodes: [['id', 'posX', 'posY', 'posZ'], { nodeWeight: 4 }, [`${s}h${'l'}`, 0.55, y, 0.35], [`${s}h${'r'}`, -0.55, y, 0.35], [`${s}t${'l'}`, 0.55, y, 0.8], [`${s}t${'r'}`, -0.55, y, 0.8], { nodeWeight: 1 }, [`${s}c${'l'}`, 0.55, y, 0.6], [`${s}c${'r'}`, -0.55, y, 0.6]],
    beams: [['id1:', 'id2:'], { beamSpring: 3001000, beamDamp: 100 },
      ...['l', 'r'].flatMap((d) => [[`${s}h${d}`, `b${S === 'F' ? 0 : 2}${d}`], [`${s}h${d}`, `b1${d}`], [`${s}t${d}`, `t${S === 'F' ? 0 : 2}${d}`], [`${s}t${d}`, `t1${d}`], [`${s}t${d}`, `b1${d}`], [`${s}w1${d}`, `${s}h${d}`], [`${s}w2${d}`, `${s}h${d}`], [`${s}w1${d}`, `b1${d}`], [`${s}w2${d}`, `b1${d}`]]),
      { beamType: '|BOUNDED', beamSpring: 30000, beamDamp: 2000, beamLimitSpring: 200000, beamLimitDamp: 3000 },
      ...['l', 'r'].map((d) => [`${s}h${d}`, `${s}t${d}`, { precompressionRange: 0.08, shortBoundRange: 0.1, longBoundRange: 0.12 }]),
      { beamType: '|BOUNDED', beamSpring: 0, beamDamp: 50, beamLimitSpring: 1500000, beamLimitDamp: 100 },
      ...['l', 'r'].map((d) => [`${s}t${d}`, `${s}w2${d}`, { shortBoundRange: 0.005, longBoundRange: 0.01 }]),
      { beamType: '|NORMAL', beamSpring: 20000, beamDamp: 10 },
      ...['l', 'r'].map((d) => [`${s}c${d}`, `${s}t${d}`]),
      { beamType: '|NORMAL' }],
    rails: { [`strut_${S}L`]: { 'links:': [`${s}h${'l'}`, `${s}t${'l'}`] }, [`strut_${S}R`]: { 'links:': [`${s}h${'r'}`, `${s}t${'r'}`] } },
    slidenodes: [['id:', 'railName', 'attached', 'fixToRail', 'tolerance', 'spring', 'strength', 'capStrength'], [`${s}c${'l'}`, `strut_${S}L`, true, true, 0, 900000, 'FLT_MAX', 'FLT_MAX'], [`${s}c${'r'}`, `strut_${S}R`, true, true, 0, 900000, 'FLT_MAX', 'FLT_MAX']],
    pressureWheels: [H, { brakeTorque: S === 'F' ? 1500 : 800, parkingTorque: S === 'F' ? 0 : 900 }],
    powertrain: [['type', 'name', 'inputName', 'inputIndex'], ['shaft', `spindle${S}L`, `wheelaxle${S}L`, 1, { connectedWheel: `${S}L` }], ['shaft', `spindle${S}R`, `wheelaxle${S}R`, 1, { connectedWheel: `${S}R` }]],
  };
  parts[`wheel_14x6_${S}`] = {
    slotType: `wheel_${S}`,
    slots: [['type', 'default', 'description'], [`tire_${S}`, `tire_${S}_185_65_14_standard`, '']], // tire not included: rebuilt from its name
    nodes: [['id', 'posX', 'posY', 'posZ'], { nodeWeight: 4.5 }, [`${s}w1r`, -0.4, 0, 0], [`${s}w2r`, -0.6, 0, 0], [`${s}w1l`, 0.4, 0, 0], [`${s}w2l`, 0.6, 0, 0]],
    beams: [['id1:', 'id2:'], { beamSpring: 1501000, beamDamp: 25 }, [`${s}w1r`, `${s}w2r`], [`${s}w1l`, `${s}w2l`]],
    pressureWheels: [H, { hasTire: false, hubRadius: 0.18, numRays: 16, hubNodeWeight: 0.4 }],
  };
  parts[`car_wheeldata_${S}`] = {
    slotType: `car_wheeldata_${S}`,
    pressureWheels: [H, [`${S}L`, '', '', `${s}w1l`, `${s}w2l`, 9999, `${s}hl`, 1], [`${S}R`, '', '', `${s}w2r`, `${s}w1r`, 9999, `${s}hr`, -1], { brakeTorque: 0 }],
  };
}

(async () => {
  const zip = J2R.makeZip([{ path: 'vehicles/car/car.jbeam', data: JSON.stringify(parts) }]);
  const lib = await J2R.loadLibrary([{ name: 'car.zip', entries: await J2R.openZip(new Blob([zip])) }]);
  const r = J2R.convert(lib, { debug: 'quiet' });
  const D = r._debug;
  const P = (id) => D.nodes.get(id).pos;

  check(Math.abs(P('fw1l')[0] - (0.4 + 0.21)) < 1e-9 && Math.abs(P('fw1r')[0] + (0.4 + 0.21)) < 1e-9, 'slot nodeOffset: x mirrored per side, and "$x == nil" works for undefined variables');
  check(Math.abs(P('hdr')[0] - 0.2) < 1e-9 && Math.abs(P('hdr')[1] - 0.5) < 1e-9, '$components values resolve in node positions');
  check(D.nodes.get('t1l').weight === 23.5, 'a later part overrides a node defined earlier (BeamNG load order)');
  const w = D.wheels.find((x) => x.name === 'FL');
  check(w && Math.abs(w.radius - (14 * 0.0254 / 2 + 0.185 * 0.65)) < 1e-6, 'missing base-game tire rebuilt from its name');
  check(w && w.brakeTorque === 1500 && D.wheels.find((x) => x.name === 'RL').parkTorque === 900, 'brake settings reach wheel rows in a later part');
  check(D.wheels.filter((x) => x.propulsed).map((x) => x.name).sort().join() === 'FL,FR', 'only wheels whose spindle chain reaches the engine are driven');
  const spring = D.shocks.find((x) => x.a === 'fhl' && x.b === 'ftl');
  const L = Math.hypot(...P('fhl').map((v, i) => v - P('ftl')[i]));
  check(spring && Math.abs(spring.precomp - (L + 0.08) / L) < 1e-9 && Math.abs(spring.sb - 0.1 / (L + 0.08)) < 1e-9, 'precompressionRange / shortBoundRange (metres) converted');
  check(spring && spring.hardK > 200000, 'bump-stop stiffness carried into the RoR shock limit');
  check(D.beams.some((x) => x.a === 'ftl' && x.b === 'fw2l' && x.spring === 1500000), 'limiter with almost no free play becomes a stiff beam');
  check(/^slidenodes$/m.test(r.truck) && /, s900000, b1000000000, t0$/m.test(r.truck), 'slidenodes written for RoR');
  check(r.report.selfTest.stable, 'drop test passes');
  check(require('./validate-truck.js').validate(r.truck).ok, '.truck passes the syntax checks');
  console.log(failed ? `\n${failed} check(s) failed` : '\nAll feature checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
