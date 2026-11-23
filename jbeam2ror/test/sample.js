// Builds a small synthetic BeamNG-style vehicle mod (and a fake "common.zip") for testing.
// The geometry is made up; it only mimics how real JBeam mods are structured.
// Works in Node (module.exports) and the browser (J2R_SAMPLE global, needs J2R).
(function (root) {
'use strict';
function buildSample(J2R) {
// --- chassis nodes (BeamNG coords: front = -Y, up = +Z, left = +X) ---
const chassis = [];
const ys = [-2.0, -1.0, 0.0, 1.0, 2.0];
for (const [i, y] of ys.entries()) {
  for (const [side, x] of [['l', 0.6], ['r', -0.6]]) {
    chassis.push([`b${i}${side}`, x, y, 0.35]);
    chassis.push([`t${i}${side}`, x, y, 0.95]);
  }
}
const nodeRows = chassis.map((n) => JSON.stringify(n)).join('\n        ');
const beams = [];
const id = (k, s, h) => `${h}${k}${s}`;
for (let k = 0; k < ys.length; k++) {
  for (const s of ['l', 'r']) beams.push([id(k, s, 'b'), id(k, s, 't')]);
  beams.push([id(k, 'l', 'b'), id(k, 'r', 'b')], [id(k, 'l', 't'), id(k, 'r', 't')], [id(k, 'l', 'b'), id(k, 'r', 't')], [id(k, 'r', 'b'), id(k, 'l', 't')]);
  if (k + 1 < ys.length) {
    for (const s of ['l', 'r']) {
      for (const h of ['b', 't']) beams.push([id(k, s, h), id(k + 1, s, h)]);
      beams.push([id(k, s, 'b'), id(k + 1, s, 't')], [id(k, s, 't'), id(k + 1, s, 'b')]);
    }
    beams.push([id(k, 'l', 'b'), id(k + 1, 'r', 'b')], [id(k, 'l', 't'), id(k + 1, 'r', 't')]);
  }
}
const beamRows = beams.map((b) => JSON.stringify(b)).join(' '); // no commas between rows on purpose

const tris = [];
for (let k = 0; k + 1 < ys.length; k++) {
  tris.push([id(k, 'l', 't'), id(k + 1, 'l', 't'), id(k + 1, 'r', 't')], [id(k, 'l', 't'), id(k + 1, 'r', 't'), id(k, 'r', 't')]);
  for (const s of ['l', 'r']) tris.push([id(k, s, 'b'), id(k + 1, s, 'b'), id(k + 1, s, 't')], [id(k, s, 'b'), id(k + 1, s, 't'), id(k, s, 't')]);
}

const main = `{
/* main part */
"testcar": {
    "information": {"authors": "test", "name": "Test Car"},
    "slotType": "main",
    "slots": [
        ["type", "default", "description"],
        ["testcar_suspension_F", "testcar_suspension_F", "Front Suspension"],
        ["testcar_suspension_R", "testcar_suspension_R", "Rear Suspension"],
        ["testcar_engine", "testcar_engine_v6", "Engine"],
    ],
    "variables": [
        ["name", "type", "unit", "category", "default", "min", "max", "title", "description"],
        ["$spring_F", "range", "N/m", "Suspension", 45000, 10000, 90000, "Front spring", ""],
        ["$spring_R", "range", "N/m", "Suspension", 50000, 10000, 90000, "Rear spring", ""],
        ["$damp", "range", "N/m/s", "Suspension", 3500, 1000, 8000, "Damping", ""],
    ],
    "refNodes": [
        ["ref:", "back:", "left:", "up:"],
        ["b2l", "b3l", "b2l_l", "t2l"],
    ],
    "camerasInternal": [
        ["type", "x", "y", "z", "fov", "id1:", "id2:", "id3:", "id4:", "id5:", "id6:"],
        ["dash", 0.35, -0.2, 1.15, 65, "t2l", "t2r", "t1l", "t1r", "b2l", "b2r"],
    ],
    "nodes": [
        ["id", "posX", "posY", "posZ"],
        {"nodeWeight": 28},
        {"frictionCoef": 0.6},
        ${nodeRows}
        ["b2l_l", 0.75, 0.0, 0.35, {"nodeWeight": 2}],
    ],
    "beams": [
        ["id1:", "id2:"],
        {"beamSpring": 4001000, "beamDamp": 150, "beamDeform": "$=40000*2", "beamStrength": "FLT_MAX"},
        ${beamRows}
        ["b2l_l", "b2l"], ["b2l_l", "t2l"], ["b2l_l", "b1l"], ["b2l_l", "b3l"],
        ["b0l", "missing_node", {"optional": true}],
        {"beamPrecompression": 1, "beamType": "|NORMAL"}
    ],
    "triangles": [
        ["id1:", "id2:", "id3:"],
        ${tris.map((t) => JSON.stringify(t)).join(',\n        ')},
    ],
}
}`;

function suspension(axle, y, springVar) {
  const A = axle; // 'f' or 'r'
  const W = A.toUpperCase();
  const k = y < 0 ? 1 : 3; // chassis station next to the axle
  return `
"testcar_suspension_${W}": {
    "information": {"name": "${W} suspension"},
    "slotType": "testcar_suspension_${W}",
    "slots": [
        ["type", "default", "description"],
        ["wheel_${W}", "steelwheel_15_${W}", "Wheels"],
        ["testcar_wheeldata_${W}", "testcar_wheeldata_${W}", "Spindles"]
    ],
    "nodes": [
        ["id", "posX", "posY", "posZ"],
        {"nodeWeight": 5.5},
        ["${A}w1l", 0.68, ${y}, 0.3], ["${A}w2l", 0.88, ${y}, 0.3],
        ["${A}w1r", -0.68, ${y}, 0.3], ["${A}w2r", -0.88, ${y}, 0.3],
        {"nodeWeight": 3},
        ["${A}s1l", 0.70, ${y + 0.14}, 0.32], ["${A}s1r", -0.70, ${y + 0.14}, 0.32],
        ${A === 'f' ? '["rack", 0.0, ' + (y + 0.14) + ', 0.35],' : ''}
    ],
    "beams": [
        ["id1:", "id2:"],
        {"beamSpring": 3001000, "beamDamp": 120, "beamDeform": 90000, "beamStrength": 250000},
        ${['l', 'r'].map((s) => `["${A}w1${s}", "${A}w2${s}"], ["${A}w1${s}", "${A}s1${s}"], ["${A}w2${s}", "${A}s1${s}"],
        ["${A}w1${s}", "b${k}${s}"], ["${A}w1${s}", "b${k - 1}${s}"], ["${A}w2${s}", "b${k}${s}"], ["${A}w2${s}", "b${k - 1}${s}"],
        ["${A}s1${s}", "b${k}${s}"], ["${A}s1${s}", "b${k + 1}${s}"], ["${A}w1${s}", "t${k}${s}"]`).join(',\n        ')},
        ${A === 'f' ? '["rack", "b1l"], ["rack", "b1r"], ["rack", "b2l"], ["rack", "b2r"], ["rack", "t1l"], ["rack", "t1r"],' : ''}
        // springs and dampers
        {"beamType": "|BOUNDED", "beamSpring": "${springVar}", "beamDamp": "$damp", "beamPrecompression": 1.08,
         "beamShortBound": 0.3, "beamLongBound": 0.3, "beamLimitSpring": 2000000, "beamLimitDamp": 2000}
        ["${A}w2l", "t${k}l"], ["${A}w2r", "t${k}r"],
        {"beamType": "|NORMAL", "beamPrecompression": 1, "beamShortBound": 1, "beamLongBound": 1}
    ],
    ${A === 'f' ? `"hydros": [
        ["id1:", "id2:"],
        {"beamSpring": 3001000, "beamDamp": 100},
        ["fs1l", "rack", {"inputFactor": -1, "inRate": 0.4, "outRate": 0.4, "inLimit": 0.85, "outLimit": 1.15}],
        ["fs1r", "rack", {"inputFactor": 1, "inRate": 0.4, "outRate": 0.4, "inLimit": 0.85, "outLimit": 1.15}],
    ],` : ''}
    "pressureWheels": [
        ["name", "hubGroup", "group", "node1:", "node2:", "nodeS", "nodeArm:", "wheelDir"],
        {"enableBrakes": true, "brakeTorque": ${A === 'f' ? 2000 : 1300}, "parkingTorque": ${A === 'f' ? 0 : 1000}},
    ],
},
"testcar_wheeldata_${W}": {
    "slotType": "testcar_wheeldata_${W}",
    "pressureWheels": [
        ["name", "hubGroup", "group", "node1:", "node2:", "nodeS", "nodeArm:", "wheelDir"],
        ["${W}L", "wheel_${W}L", "tire_${W}L", "${A}w1l", "${A}w2l", 9999, "${A}s1l", 1],
        ["${W}R", "wheel_${W}R", "tire_${W}R", "${A}w1r", "${A}w2r", 9999, "${A}s1r", -1],
        {"enableBrakes": false}
    ],
}`;
}

const susp = `{${suspension('f', -1.3, '$spring_F')},${suspension('r', 1.3, '$spring_R')}}`;

const engine = `{
"testcar_engine_v6": {
    "information": {"name": "V6"},
    "slotType": "testcar_engine",
    "powertrain": [
        ["type", "name", "inputName", "inputIndex"],
        ["combustionEngine", "mainEngine", "dummy", 0],
        ["manualGearbox", "gearbox", "mainEngine", 1],
        ["shaft", "driveshaft", "gearbox", 1],
        ["differential", "differential_R", "driveshaft", 1],
        ["shaft", "wheelaxleRL", "differential_R", 1, {"connectedWheel": "RL"}],
        ["shaft", "wheelaxleRR", "differential_R", 2, {"connectedWheel": "RR"}],
    ],
    "mainEngine": {
        "torque": [["rpm", "torque"], [0, 0], [1000, 210], [2500, 280], [4500, 300], [6000, 260], [7000, 210]],
        "idleRPM": 850, "maxRPM": 7000, "inertia": 0.15,
    },
    "gearbox": {"gearRatios": [-3.4, 0, 3.6, 2.2, 1.5, 1.15, 0.9, 0.75]},
    "differential_R": {"gearRatio": 3.9},
    "nodes": [["id", "posX", "posY", "posZ"], {"nodeWeight": 30}, ["e1l", 0.3, -1.6, 0.5], ["e1r", -0.3, -1.6, 0.5], ["e2l", 0.3, -1.0, 0.6], ["e2r", -0.3, -1.0, 0.6]],
    "beams": [["id1:", "id2:"], {"beamSpring": 5001000, "beamDamp": 200, "beamDeform": 300000, "beamStrength": "FLT_MAX"},
        ["e1l", "e1r"], ["e2l", "e2r"], ["e1l", "e2l"], ["e1r", "e2r"], ["e1l", "e2r"], ["e1r", "e2l"],
        ["e1l", "b0l"], ["e1l", "b1l"], ["e1r", "b0r"], ["e1r", "b1r"], ["e2l", "b1l"], ["e2r", "b1r"], ["e2l", "t1l"], ["e2r", "t1r"], ["e1l", "t0l"], ["e1r", "t0r"]],
}
}`;

const pc = `{
  "format": 2,
  "model": "testcar",
  "parts": {"testcar_engine": "testcar_engine_v6", "wheel_F": "steelwheel_15_F", "tire_F": "tire_F_195_65_15"},
  "vars": {"$spring_F": 52000},
}`;

// "common" content: wheels and tires live in BeamNG's common.zip in real life.
const common = `{
"steelwheel_15_F": {
    "slotType": "wheel_F",
    "slots": [["type", "default", "description"], ["tire_F", "tire_F_185_65_15", "Front Tires"]],
    "pressureWheels": [["name","hubGroup","group","node1:","node2:","nodeS","nodeArm:","wheelDir"],
        {"hubRadius": 0.19, "hubWidth": 0.15, "hubNodeWeight": 0.6, "numRays": 16}],
},
"steelwheel_15_R": {
    "slotType": "wheel_R",
    "slots": [["type", "default", "description"], ["tire_R", "tire_R_185_65_15", "Rear Tires"]],
    "pressureWheels": [["name","hubGroup","group","node1:","node2:","nodeS","nodeArm:","wheelDir"],
        {"hubRadius": 0.19, "hubWidth": 0.15, "hubNodeWeight": 0.6, "numRays": 16}],
},
"tire_F_185_65_15": {"slotType": "tire_F", "pressureWheels": [["name","hubGroup","group","node1:","node2:","nodeS","nodeArm:","wheelDir"], {"radius": 0.305, "tireWidth": 0.185, "nodeWeight": 0.32, "pressurePSI": 30}]},
"tire_F_195_65_15": {"slotType": "tire_F", "pressureWheels": [["name","hubGroup","group","node1:","node2:","nodeS","nodeArm:","wheelDir"], {"radius": 0.315, "tireWidth": 0.195, "nodeWeight": 0.34, "pressurePSI": 32}]},
"tire_R_185_65_15": {"slotType": "tire_R", "pressureWheels": [["name","hubGroup","group","node1:","node2:","nodeS","nodeArm:","wheelDir"], {"radius": 0.305, "tireWidth": 0.185, "nodeWeight": 0.32, "pressurePSI": 30}]},
}`;

  const modZip = J2R.makeZip([
    { path: 'vehicles/testcar/testcar.jbeam', data: main },
    { path: 'vehicles/testcar/testcar_suspension.jbeam', data: susp },
    { path: 'vehicles/testcar/testcar_engine.jbeam', data: engine },
    { path: 'vehicles/testcar/sport.pc', data: pc },
  ]);
  const commonZip = J2R.makeZip([{ path: 'vehicles/common/wheels/common_wheels.jbeam', data: common }]);
  return { modZip, commonZip };
}
if (typeof module !== 'undefined' && module.exports) module.exports = { buildSample };
else root.J2R_SAMPLE = { buildSample };
})(typeof self !== 'undefined' ? self : this);
