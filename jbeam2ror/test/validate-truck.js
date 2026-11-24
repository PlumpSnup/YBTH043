// Checks a generated .truck against the rules of RoR's parser (RigDef_Parser.cpp):
// minimum argument counts per section, consecutive node numbering, and that every
// node reference exists. Usage: node validate-truck.js file.truck
'use strict';
const fs = require('fs');

function validate(text) {
  const errors = [];
  const lines = text.split(/\r?\n/);
  const minArgs = { nodes: 4, beams: 2, shocks: 7, hydros: 3, wheels: 14, cameras: 3, cinecam: 11, engine: 7, engoption: 1, torquecurve: 2, brakes: 1, globals: 2, minimass: 1, texcoords: 3, cab: 3, slidenodes: 3, fusedrag: 3, flexbodies: 10, props: 10, flares2: 6, materialflarebindings: 2, exhausts: 2 };
  const nodeRefCols = { beams: [0, 1], shocks: [0, 1], hydros: [0, 1], wheels: [3, 4, 5, 8], cameras: [0, 1, 2], cinecam: [3, 4, 5, 6, 7, 8, 9, 10], texcoords: [0], cab: [0, 1, 2], fusedrag: [0, 1], flexbodies: [0, 1, 2], props: [0, 1, 2], flares2: [0, 1, 2], exhausts: [0, 1] };
  const keywords = new Set([...Object.keys(minArgs), 'submesh', 'end', 'enable_advanced_deformation', 'set_beam_defaults']);
  let section = null, nodeCount = 0, sawTitle = false, ended = false, wheelNodes = 0, cinecams = 0;
  const texNodes = new Set();
  const refs = [];
  const counts = {};
  lines.forEach((raw, ln) => {
    const line = raw.replace(/;.*$/, '').trim();
    if (!line) return;
    if (!sawTitle) { sawTitle = true; return; }
    if (ended) { errors.push(`line ${ln + 1}: content after 'end'`); return; }
    const kw = line.split(/[\s,]+/)[0];
    if (kw === 'set_node_defaults') { const a2 = line.split(/[\s,]+/).filter(Boolean); if (a2.length < 2 || a2.slice(1).some((x) => isNaN(+x))) errors.push(`line ${ln + 1}: bad set_node_defaults`); return; }
    if (kw.startsWith('forset')) {
      // RoR quirk: anything odd (or a trailing separator) silently adds node 0
      if (section !== 'flexbodies') errors.push(`line ${ln + 1}: forset outside flexbodies`);
      const body = line.slice(6).replace(/^[\s:,]+/, '');
      if (!/^\d+(-\d+)?(,\d+(-\d+)?)*$/.test(body)) errors.push(`line ${ln + 1}: bad forset "${body.slice(0, 40)}"`);
      for (const r of body.split(',')) for (const x of r.split('-')) refs.push([ln + 1, x, 'generated']);
      return;
    }
    if (kw === 'add_animation') {
      if (section !== 'props') errors.push(`line ${ln + 1}: add_animation outside props`);
      const parts = line.slice(14).split(',').map((x) => x.trim());
      if (parts.length < 4 || parts.slice(0, 3).some((x) => isNaN(+x)) || !parts.some((x) => /^source:\s*\w+/.test(x)) || !parts.some((x) => /^mode:\s*[xyz]-(rotation|offset)/.test(x))) errors.push(`line ${ln + 1}: bad add_animation`);
      return;
    }
    if (/^tractioncontrol$/i.test(kw)) { if (!/^TractionControl\s+[\d.]+\s*,\s*[\d.]+/i.test(line)) errors.push(`line ${ln + 1}: bad TractionControl line`); return; }
    if (/^[a-z]/i.test(line) && keywords.has(kw)) {
      if (kw === 'set_beam_defaults') {
        const a = line.split(/[\s,]+/).filter(Boolean);
        if (a.length < 2) errors.push(`line ${ln + 1}: set_beam_defaults needs a value`);
        if (a.slice(1).some((x, q) => q !== 5 && isNaN(+x))) errors.push(`line ${ln + 1}: bad number in set_beam_defaults`);
        if (a.length > 6 && !/^[\w/.-]+$/.test(a[6])) errors.push(`line ${ln + 1}: bad beam material in set_beam_defaults`);
        return;
      }
      if (kw === 'end') { ended = true; return; }
      section = kw;
      return;
    }
    if (/^[a-z]/i.test(line)) { errors.push(`line ${ln + 1}: unexpected keyword-like line "${line.slice(0, 40)}"`); return; }
    if (!section) { errors.push(`line ${ln + 1}: data outside a section`); return; }
    const args = line.split(/\s*,\s*|\s+/).filter(Boolean);
    counts[section] = (counts[section] || 0) + 1;
    if (minArgs[section] && args.length < minArgs[section]) errors.push(`line ${ln + 1} (${section}): needs ${minArgs[section]} args, has ${args.length}`);
    if (section === 'nodes') {
      if (+args[0] !== nodeCount) errors.push(`line ${ln + 1}: node number ${args[0]}, expected ${nodeCount}`);
      nodeCount++;
      for (const c of [1, 2, 3, 5]) if (args[c] !== undefined && !isFinite(+args[c])) errors.push(`line ${ln + 1}: bad number "${args[c]}"`);
      if (args[5] !== undefined && !(+args[5] > 0)) errors.push(`line ${ln + 1}: node mass must be > 0`);
    }
    if (section === 'texcoords') texNodes.add(args[0]);
    if (section === 'props' && (!/\.mesh$/i.test(args[9] || '') || args.slice(3, 9).some((x) => isNaN(+x)))) errors.push(`line ${ln + 1}: bad prop`);
    if (section === 'props' && /dashboard|^seat|^beacon|^lightb|^pale|^spinprop/i.test(args[9] || '') ) errors.push(`line ${ln + 1}: prop mesh name "${args[9]}" would be taken as a RoR special prop`);
    if (section === 'flares2' && !['f', 'h', 'g', 't', 'b', 'R', 's', 'l', 'r', 'u', 'd'].includes(args[6])) errors.push(`line ${ln + 1}: bad flare type ${args[6]}`);
    if (section === 'materialflarebindings' && (!/^\d+$/.test(args[0]) || +args[0] >= (counts.flares2 || 0))) errors.push(`line ${ln + 1}: binding to a flare that does not exist`);
    if (section === 'wheels') { wheelNodes += 2 * (+args[2] || 0); }
    if (section === 'cinecam') cinecams++;
    if (section === 'flexbodies' && !/\.mesh$/i.test(args[9] || '')) errors.push(`line ${ln + 1}: flexbody mesh should be a .mesh file`);
    if (section === 'slidenodes') {
      // node, rail nodes..., then options starting with a letter (S spring, B break, T tolerance ...)
      const nodeArgs = args.filter((x) => /^\d+$/.test(x));
      const opt = args.filter((x) => !/^\d+$/.test(x));
      if (nodeArgs.length < 3) errors.push(`line ${ln + 1}: slidenode needs a node and at least 2 rail nodes`);
      for (const o of opt) if (!/^[SBTRGDC][\w.]*$/i.test(o) || (/^[SBTRGD]/i.test(o) && isNaN(+o.slice(1)))) errors.push(`line ${ln + 1}: bad slidenode option "${o}"`);
      for (const x of nodeArgs) refs.push([ln + 1, x, false]);
    }
    if (section === 'cab') for (const c of [0, 1, 2]) if (!texNodes.has(args[c])) errors.push(`line ${ln + 1}: cab node ${args[c]} has no texcoord`);
    if (section === 'engine' && !args.slice(6).some((g) => +g > 0)) errors.push(`line ${ln + 1}: engine has no forward gear`);
    if (section === 'wheels') {
      if (!['0', '1', '2', '3', '4'].includes(args[6])) errors.push(`line ${ln + 1}: bad braking value ${args[6]}`);
      if (!['0', '1', '2'].includes(args[7])) errors.push(`line ${ln + 1}: bad propulsion value ${args[7]}`);
      if (args[3] === args[4]) errors.push(`line ${ln + 1}: wheel axle nodes identical`);
    }
    for (const c of nodeRefCols[section] || []) refs.push([ln + 1, args[c], section === 'wheels' && c === 5]);
  });
  for (const [ln, r, allow] of refs) {
    if (allow === true && r === '9999') continue;
    // forset may name the nodes RoR generates: cinecam nodes, then the wheels' tread nodes
    const limit = allow === 'generated' ? nodeCount + cinecams + wheelNodes : nodeCount;
    if (!/^\d+$/.test(r) || +r >= limit) errors.push(`line ${ln}: node reference "${r}" does not exist`);
  }
  if (!ended) errors.push("missing 'end'");
  if (!counts.nodes) errors.push('no nodes');
  return { ok: errors.length === 0, errors, counts };
}

module.exports = { validate };
if (require.main === module) {
  const r = validate(fs.readFileSync(process.argv[2], 'utf8'));
  console.log(r.ok ? 'OK' : r.errors.join('\n'), JSON.stringify(r.counts));
  process.exit(r.ok ? 0 : 1);
}
