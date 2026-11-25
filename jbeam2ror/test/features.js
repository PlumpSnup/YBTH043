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
    nodes: [['id', 'posX', 'posY', 'posZ'], { nodeWeight: 20, group: 'car_body' }, ...box, { group: '' }],
    flexbodies: [['mesh', '[group]:', 'nonFlexMaterials'], ['car_shell', ['car_body'], []], ['car_rim', ['wheel_FL'], []], ['not_in_dae', ['car_body'], []]],
    glowMap: { car_lamp: { off: 'car_paint', on: 'car_lamp_on', simpleFunction: 'lights_brake' } },
    props: [['func', 'mesh', 'idRef:', 'idX:', 'idY:', 'baseRotation', 'rotation', 'translation', 'min', 'max', 'offset', 'multiplier'],
      ['steering', 'car_steer', 'b1l', 'b1r', 't1l', { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 0 }, -1000, 1000, 0, 1],
      ['wheelspeed', 'car_needle', 'b1l', 'b1r', 't1l', { x: 0, y: 0, z: 0 }, { x: 0, y: -4, z: 0 }, { x: 0, y: 0, z: 0 }, 0, 70, 2, 1]],
    beams: [['id1:', 'id2:'], { beamSpring: 2001000, beamDamp: 100 }, ...boxBeams],
    components: { headerNodePos: { x: 0.2, y: -1.2, z: 0.5 } },
  },
  car_glass: { slotType: 'car_glass', nodes: [['id', 'posX', 'posY', 'posZ'], { nodeWeight: 23.5 }, ['t1l', 0.6, 0, 0.9]] },
  car_engine: {
    slotType: 'car_engine',
    nodes: [['id', 'posX', 'posY', 'posZ'], { nodeWeight: 30 }, ['hdr', '$=$components.headerNodePos.x', '$=$components.headerNodePos.y', '$=$components.headerNodePos.z'],
      { nodeWeight: 3, group: 'car_exhaust' }, ['ex1', 0.3, 1.2, 0.3], ['ex2', 0.3, 1.8, 0.3], { group: '' }],
    beams: [['id1:', 'id2:'], { beamSpring: 2001000, beamDamp: 100 }, ['hdr', 'b0l'], ['hdr', 'b0r'], ['hdr', 't0l'], ['hdr', 'b1l'],
      ['ex1', 'b1l'], ['ex1', 'b2l'], ['ex1', 'b1r'], ['ex2', 'b2l'], ['ex2', 'b2r'], ['ex2', 't2l'], ['ex1', 'ex2']],
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
      { beamType: '|SUPPORT', beamSpring: 2501000, beamDamp: 150, beamPrecompression: 0.7 },
      ...['l', 'r'].map((d) => [`${s}h${d}`, `t${S === 'F' ? 0 : 2}${d}`]),
      { beamPrecompression: 1 },
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
  // A tiny Collada model: one quad (polylist) with the paint material and one triangle
  // (triangles) with a light material, under a node that is moved by 0.1 m in z.
  const dae = `<?xml version="1.0"?><COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
  <asset><unit meter="1"/><up_axis>Z_UP</up_axis></asset>
  <library_materials><material id="paint-material" name="car_paint"/><material id="lamp-material" name="car_lamp"/><material id="mirror-material" name="mirror"/></library_materials>
  <library_geometries><geometry id="g1" name="g1"><mesh>
    <source id="g1-pos"><float_array id="g1-pos-a" count="15">0.6 -1.5 0.9  -0.6 -1.5 0.9  -0.6 1.5 0.9  0.6 1.5 0.9  0 0 0.3</float_array><technique_common><accessor source="#g1-pos-a" count="5" stride="3"/></technique_common></source>
    <source id="g1-n"><float_array id="g1-n-a" count="3">0 0 1</float_array><technique_common><accessor source="#g1-n-a" count="1" stride="3"/></technique_common></source>
    <source id="g1-uv"><float_array id="g1-uv-a" count="8">0 0 1 0 1 1 0 1</float_array><technique_common><accessor source="#g1-uv-a" count="4" stride="2"/></technique_common></source>
    <vertices id="g1-v"><input semantic="POSITION" source="#g1-pos"/></vertices>
    <polylist material="paint-material" count="1"><input semantic="VERTEX" source="#g1-v" offset="0"/><input semantic="NORMAL" source="#g1-n" offset="1"/><input semantic="TEXCOORD" source="#g1-uv" offset="2" set="0"/><vcount>4</vcount><p>0 0 0 1 0 1 2 0 2 3 0 3</p></polylist>
    <triangles material="lamp-material" count="1"><input semantic="VERTEX" source="#g1-v" offset="0"/><p>0 1 4</p></triangles>
    <triangles material="mirror-material" count="1"><input semantic="VERTEX" source="#g1-v" offset="0"/><p>0 3 4</p></triangles>
  </mesh></geometry>
  <geometry id="g2" name="g2"><mesh><source id="g2-pos"><float_array id="g2-pos-a" count="9">0.15 0 0  -0.1 0 0.1  -0.1 0 -0.1</float_array><technique_common><accessor source="#g2-pos-a" count="3" stride="3"/></technique_common></source>
    <vertices id="g2-v"><input semantic="POSITION" source="#g2-pos"/></vertices><triangles count="1"><input semantic="VERTEX" source="#g2-v" offset="0"/><p>0 1 2</p></triangles></mesh></geometry></library_geometries>
  <library_visual_scenes><visual_scene id="Scene"><node id="car_shell" name="car_shell"><matrix>1 0 0 0 0 1 0 0 0 0 1 0.1 0 0 0 1</matrix>
    <instance_geometry url="#g1"><bind_material><technique_common><instance_material symbol="paint-material" target="#paint-material"/><instance_material symbol="lamp-material" target="#lamp-material"/><instance_material symbol="mirror-material" target="#mirror-material"/></technique_common></bind_material></instance_geometry></node>
    <node id="car_steer" name="car_steer"><matrix>1 0 0 0.3 0 1 0 -0.5 0 0 1 0.8 0 0 0 1</matrix><instance_geometry url="#g2"/></node>
    <node id="car_needle" name="car_needle"><matrix>1 0 0 0.3 0 1 0 -0.6 0 0 1 0.85 0 0 0 1</matrix><instance_geometry url="#g2"/></node>
    <node id="car_rim" name="car_rim"><instance_geometry url="#g1"/></node></visual_scene></library_visual_scenes></COLLADA>`;
  const mats = `{"car_paint": {"name": "car_paint", "mapTo": "car_paint", "class": "material", "Stages": [{"baseColorMap": "vehicles/car/car_b.color.png"}, {"instanceDiffuse": true}, {}, {},]}}`;
  const pc = { parts: {}, paints: [{ baseColor: [0.5, 0.25, 0.1, 1.2] }] };
  const zip = J2R.makeZip([{ path: 'vehicles/car/car.jbeam', data: JSON.stringify(parts) }, { path: 'vehicles/car/car.dae', data: dae }, { path: 'vehicles/car/main.materials.json', data: mats },
    { path: 'vehicles/car/car_b.color.dds', data: new Uint8Array([68, 68, 83, 32, 1, 2, 3]) }, { path: 'vehicles/car/red.pc', data: JSON.stringify(pc) }]);
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
  const stop = D.shocks.find((x) => x.stop && x.a === 'fhl');
  check(stop && Math.abs(stop.sb - 0.3) < 1e-9 && stop.spring === 0 && stop.precomp === 1, 'pre-shortened |SUPPORT beam becomes a stop that is slack until squashed to 70 %');
  check(r.report.selfTest.stable, 'drop test passes');
  check(require('./validate-truck.js').validate(r.truck).ok, '.truck passes the syntax checks');

  // 3D model: Collada -> OGRE mesh placed on the nodes exactly like RoR's FlexBody.cpp
  const rv = J2R.convert(lib, { debug: 'quiet', config: 'red' });
  const vis = await J2R.addVisuals(lib, rv, { props: 'all', mirrors: true, lights: true });
  const vt = require('./validate-truck.js').validate(rv.truck);
  check(vis.added >= 1 && /^flexbodies$/m.test(rv.truck) && /^forset \d/m.test(rv.truck) && vt.ok, `flexbody + forset written and valid${vt.ok ? '' : ': ' + vt.errors.join('; ')}`);
  check(vis.notes.some((x) => /not_in_dae/.test(x)), 'parts missing from the model are reported');
  const nDeclared = (rv.truck.match(/^\d+, -?[\d.]+, -?[\d.]+, -?[\d.]+, l/gm) || []).length;
  const rimForset = rv.truck.split('\n').find((l, i, all) => /car_rim/.test(all[i - 1] || '') && l.startsWith('forset')) || rv.truck.split('\n')[rv.truck.split('\n').findIndex((l) => /^; car_rim/.test(l)) + 2];
  check(rimForset && rimForset.slice(7).split(',').some((r) => +r.split('-').pop() >= nDeclared + 1), `wheel parts go on the tread nodes RoR builds for the wheel (${rimForset})`);
  const meshFile = rv.files.find((f) => /\.mesh$/.test(f.path));
  const M = J2R.readOgreMesh(meshFile.data);
  check(M.version === '[MeshSerializer_v1.100]' && M.vertexSize === 32 && M.vertexBytes === 32 * M.vertexCount && JSON.stringify(M.decl) === '[[0,2,1,0,0],[0,2,4,12,0],[0,1,7,24,0]]', 'OGRE mesh header, vertex declaration and buffer sizes');
  check(M.submeshes.length === 2 && M.submeshes.every((x) => x.shared === 1 && x.op === 4) && M.submeshes[0].idx.length === 6 && M.submeshes[1].idx.length === 3, 'one shared vertex buffer, one triangle-list submesh per material (quad split in two, mirror glass taken out)');
  // Place like RoR: frame from the ref/x/y nodes of the flexbody line
  const fbLine = rv.truck.split('\n')[rv.truck.split('\n').findIndex((l) => l === 'flexbodies') + 2].split(/\s*,\s*/);
  const nodePos = {};
  for (const l of rv.truck.split('\n')) { const m2 = /^(\d+), (-?[\d.]+), (-?[\d.]+), (-?[\d.]+), l/.exec(l); if (m2) nodePos[m2[1]] = [+m2[2], +m2[3], +m2[4]]; }
  const sub3 = (a, b) => a.map((v, i) => v - b[i]), cr3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]], nz3 = (a) => a.map((v) => v / Math.hypot(...a));
  const dX = sub3(nodePos[fbLine[1]], nodePos[fbLine[0]]), dY = sub3(nodePos[fbLine[2]], nodePos[fbLine[0]]);
  const nrm = nz3(cr3(dY, dX)), rX = nz3(dX), rY = cr3(rX, nrm);
  const dvv = new DataView(M.vertexData.buffer, M.vertexData.byteOffset);
  const placed = [];
  for (let v = 0; v < M.vertexCount; v++) { const q = [0, 4, 8].map((o) => dvv.getFloat32(v * 32 + o, true)); placed.push([0, 1, 2].map((i) => nodePos[fbLine[0]][i] + rX[i] * q[0] + nrm[i] * q[1] + rY[i] * q[2])); }
  // BeamNG (0.6, -1.5, 0.9 + 0.1) -> RoR (x, z, -y) = (0.6, 1.0, 1.5)
  check(placed.some((p) => Math.hypot(p[0] - 0.6, p[1] - 1.0, p[2] - 1.5) < 1e-4) && placed.some((p) => Math.hypot(p[0], p[1] - 0.4, p[2]) < 1e-4), 'mesh vertices land where BeamNG puts them (node matrix and axes applied)');
  const n0 = [12, 16, 20].map((o) => dvv.getFloat32(o, true));
  const nWorld = [0, 1, 2].map((i) => rX[i] * n0[0] + nrm[i] * n0[1] + rY[i] * n0[2]);
  check(Math.abs(nWorld[1] - 1) < 1e-4, 'normals rotated with the mesh (BeamNG up = RoR up)');
  const uv = [24, 28].map((o) => dvv.getFloat32(o, true));
  check(uv[0] === 0 && uv[1] === 1, 'texture v flipped for OGRE');
  const mat = rv.files.find((f) => /-model\.material$/.test(f.path)).data;
  check(/texture car_b\.color\.dds/.test(mat) && rv.files.some((f) => f.path === 'car_b.color.dds'), 'material uses the .dds that ships instead of the .png named in materials.json');
  check(/diffuse 0\.500 0\.250 0\.100/.test(mat), 'paint colour from the .pc applied to the painted material');
  check(/car_lamp[\s\S]*?emissive 1\.000 0\.060 0\.030/.test(mat) && !/car_lamp/.test(vis.notes.join()), 'lamp material resolved through glowMap, with a brake-red glow');
  const sect = (name) => { const L2 = rv.truck.split('\n'); const i = L2.indexOf(name); if (i < 0) return []; const out = []; for (let j = i + 1; j < L2.length && L2[j] !== ''; j++) out.push(L2[j]); return out; };
  const flares = sect('flares2'), binds = sect('materialflarebindings');
  check(flares.some((l) => /, b, -1, 0, /.test(l)) && binds.length === 1 && new RegExp(`^0, j2r/[^,]*/car_lamp$`).test(binds[0]), `brake lamp: a 'b' flare and its lens bound to it (${binds[0]})`);
  const props = sect('props');
  check(props.some((l) => /leftmirror\.mesh$/.test(l)) && J2R.readOgreMesh(rv.files.find((f) => /leftmirror\.mesh$/.test(f.path)).data).submeshes[0].material === 'mirror', 'mirror glass becomes a RoR leftmirror prop using the material "mirror"');
  const steerI = props.findIndex((l) => /source: steeringwheel/.test(l));
  check(steerI > 0 && /^add_animation -450\.0000, /.test(props[steerI]), 'steering wheel turns with the steering (default 450 degree lock)');
  // RoR prop maths: X axis of F * Rz * Ry must be the wheel's spin axis (BeamNG y = backward -> RoR -z)
  const pa = props[steerI - 1].split(/\s*,\s*/).map(Number);
  const pdx = sub3(nodePos[pa[1]], nodePos[pa[0]]), pdy = sub3(nodePos[pa[2]], nodePos[pa[0]]);
  const pn = nz3(cr3(pdy, pdx)), prx = nz3(pdx), pry = cr3(prx, pn);
  const yr = pa[7] * Math.PI / 180, zr = pa[8] * Math.PI / 180;
  const lx = [Math.cos(zr) * Math.cos(yr), Math.sin(zr) * Math.cos(yr), -Math.sin(yr)];
  const axisW = [0, 1, 2].map((i) => prx[i] * lx[0] + pn[i] * lx[1] + pry[i] * lx[2]);
  const pivotW = [0, 1, 2].map((i) => nodePos[pa[0]][i] + pa[3] * pdx[i] + pa[4] * pdy[i] + pa[5] * pn[i]);
  check(Math.abs(axisW[2] + 1) < 1e-3 && Math.hypot(pivotW[0] - 0.3, pivotW[1] - 0.8, pivotW[2] - 0.5) < 1e-3, `prop turns around its real axis ${axisW.map((v) => v.toFixed(3))} through its pivot ${pivotW.map((v) => v.toFixed(3))}`);
  check(props.some((l) => /source: speedo/.test(l)), 'speedometer needle follows the speed');
  const lastNode = rv.truck.split('\n').filter((l) => /^\d+, -?[\d.]+, -?[\d.]+, -?[\d.]+, l/.test(l)).pop();
  check(/, lcx, [\d.]+ ;j2r_exhaust$/.test(lastNode) && sect('exhausts').length === 1, 'engine sound and smoke at the tailpipe: the exhaust node is the last node (RoR keeps only the last one)');
  check(/colour_write off/.test(rv.files.find((f) => /\.material$/.test(f.path) && !/-model/.test(f.path)).data), 'plain body panels hidden when the model is present');

  // Textures: BC7 (DX10 header) is re-encoded to DXT for RoR's Direct3D 9 renderer
  const dx10 = (w, h, dxgi, payload) => { const b = new Uint8Array(148 + payload.length); const d = new DataView(b.buffer); d.setUint32(0, 0x20534444, true); d.setUint32(4, 124, true); d.setUint32(12, h, true); d.setUint32(16, w, true); d.setUint32(28, 1, true); d.setUint32(76, 32, true); d.setUint32(80, 4, true); b.set([68, 88, 49, 48], 84); d.setUint32(128, dxgi, true); d.setUint32(132, 3, true); d.setUint32(140, 1, true); b.set(payload, 148); return b; };
  const rnd = new Uint8Array(4 * 16).map(() => (Math.random() * 256) | 0);
  for (let k = 0; k < 4; k++) rnd[k * 16] = (rnd[k * 16] & ~((2 << (k + 3)) - 1) & 255) | (1 << (k + 3));
  const bc7 = J2R.decodeDDS(J2R.parseDDS(dx10(8, 8, 98, rnd)), 0);
  const px = new Uint8Array(64); let same = true;
  for (let k = 0; k < 4; k++) { J2R._bc7Block(rnd, k * 16, px); for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) for (let c = 0; c < 4; c++) if (bc7.rgba[(((k >> 1) * 4 + y) * 8 + (k & 1) * 4 + x) * 4 + c] !== px[(y * 4 + x) * 4 + c]) same = false; }
  check(same, 'BC7 texture with a DX10 header decoded block by block (decoder itself checked against a GPU)');
  const grad = new Uint8Array(64 * 64 * 4);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) { const o = (y * 64 + x) * 4; grad[o + 2] = x * 4; grad[o + 1] = y * 4; grad[o] = 128; grad[o + 3] = 255; } // BGRA
  const conv = J2R.convertTexture(dx10(64, 64, 87, grad), 'a.dds', null);
  const back = J2R.parseDDS(conv.data);
  const img = J2R.decodeDDS(back, 0);
  let err = 0; for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) { const o = (y * 64 + x) * 4; err += Math.abs(img.rgba[o] - x * 4) + Math.abs(img.rgba[o + 1] - y * 4) + Math.abs(img.rgba[o + 2] - 128); }
  check(!conv.kept && back.legacy && back.format === 'BC1' && back.mips === 7 && err / (64 * 64 * 3) < 4, `re-encoded as DXT1 with mipmaps, mean error ${(err / (64 * 64 * 3)).toFixed(2)} of 255`);
  check(J2R.convertTexture(conv.data, 'b.dds', null).kept, 'plain DXT textures are copied as they are');
  const flat = (w, h, f) => { const b = new Uint8Array(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) b.set(f(x, y), (y * w + x) * 4); return b; };
  const baked = J2R.decodeDDS(J2R.parseDDS(J2R.convertTexture(dx10(16, 16, 87, flat(16, 16, () => [200, 200, 200, 255])), 'c.dds', { mask: dx10(16, 16, 87, flat(16, 16, (x) => (x < 8 ? [0, 0, 0, 255] : [255, 255, 255, 255]))), paint: [0.5, 0.25, 0.1] }).data), 0);
  const at = (x, y) => Array.from(baked.rgba.slice((y * 16 + x) * 4, (y * 16 + x) * 4 + 3));
  const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 6);
  check(near(at(2, 5), [200, 200, 200]) && near(at(13, 5), [128, 64, 26]), `paint baked in through the mask only (unpainted ${at(2, 5)}, painted ${at(13, 5)})`);

  const rd = J2R.convert(lib, { debug: 'quiet', config: 'red' });
  await J2R.addVisuals(lib, rd, {});
  const rdProps = rd.truck.split('\n').filter((l) => /\.mesh$/.test(l) && /prop/.test(l));
  check(rdProps.length === 1 && /source: steeringwheel/.test(rd.truck) && !/^flares2$/m.test(rd.truck) && !/mirror\.mesh/.test(rd.truck), 'by default: the steering wheel only, no lights or mirrors (everything at once crashed RoR on spawn)');
  console.log(failed ? `\n${failed} check(s) failed` : '\nAll feature checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
