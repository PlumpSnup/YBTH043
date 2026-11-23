/*
 * jbeam2ror — convert BeamNG.drive vehicle physics (JBeam) to a Rigs of Rods .truck file.
 *
 * Focus: the soft-body physics (nodes, beams, suspension, collision triangles, wheels,
 * steering, engine/gearbox) so the result loads and drives without manual fixing.
 * Visual meshes (flexbodies) are NOT converted; the body is shown as a flat-shaded
 * "cab" built from the collision triangles.
 *
 * Works in the browser (global `J2R`) and in Node (`require('./jbeam2ror.js')`).
 * No dependencies.
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------
  const PHYSICS_DT = 0.0005;          // Both BeamNG and RoR step physics at 2000 Hz.
  const FLT_MAX = 3.4028234663852886e38;
  const BIG = 1e9;                    // "Unbreakable" stand-in written to the .truck file.

  // BeamNG defaults (used when a JBeam file does not set a value).
  const BNG = {
    nodeWeight: 25,
    beamSpring: 4300000,
    beamDamp: 580,
    beamDeform: 220000,
    beamStrength: FLT_MAX,
  };

  // RoR hard limits (SimConstants.h).
  const ROR_MAX_CABS = 3000;
  const ROR_MAX_TEXCOORDS = 3000;
  const ROR_MAX_WHEELS = 64;

  // ---------------------------------------------------------------------------
  // JBeam parser (relaxed JSON: comments, optional/trailing commas, bare words)
  // ---------------------------------------------------------------------------
  function parseJBeam(text, fileName) {
    let i = 0;
    const n = text.length;
    let line = 1;

    function fail(msg) {
      throw new Error(`${fileName || 'jbeam'}:${line}: ${msg}`);
    }

    function skip() {
      for (;;) {
        if (i >= n) return;
        const c = text.charCodeAt(i);
        if (c === 10) { line++; i++; continue; }
        if (c === 32 || c === 9 || c === 13 || c === 44 /* , */ || c === 0xfeff) { i++; continue; }
        if (c === 47 /* / */) {
          const d = text.charCodeAt(i + 1);
          if (d === 47) { while (i < n && text.charCodeAt(i) !== 10) i++; continue; }
          if (d === 42) {
            i += 2;
            while (i < n && !(text.charCodeAt(i) === 42 && text.charCodeAt(i + 1) === 47)) {
              if (text.charCodeAt(i) === 10) line++;
              i++;
            }
            i += 2;
            continue;
          }
        }
        return;
      }
    }

    function parseString() {
      i++; // opening quote
      let out = '';
      let start = i;
      for (;;) {
        if (i >= n) fail('unterminated string');
        const c = text[i];
        if (c === '"') { out += text.slice(start, i); i++; return out; }
        if (c === '\\') {
          out += text.slice(start, i);
          const e = text[i + 1];
          const map = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' };
          if (e === 'u') { out += String.fromCharCode(parseInt(text.substr(i + 2, 4), 16)); i += 6; }
          else { out += (map[e] !== undefined ? map[e] : e); i += 2; }
          start = i;
          continue;
        }
        if (c === '\n') line++;
        i++;
      }
    }

    const numRe = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/y;
    const wordRe = /[A-Za-z_$][A-Za-z0-9_$.\-]*/y;

    function parseValue() {
      skip();
      if (i >= n) fail('unexpected end of file');
      const c = text[i];
      if (c === '{') return parseObject();
      if (c === '[') return parseArray();
      if (c === '"') return parseString();
      numRe.lastIndex = i;
      let m = numRe.exec(text);
      if (m) { i += m[0].length; return parseFloat(m[0]); }
      wordRe.lastIndex = i;
      m = wordRe.exec(text);
      if (m) {
        i += m[0].length;
        const w = m[0];
        if (w === 'true') return true;
        if (w === 'false') return false;
        if (w === 'null' || w === 'nil') return null;
        return w; // bare word, keep as string (e.g. FLT_MAX)
      }
      fail(`unexpected character '${c}'`);
    }

    function parseObject() {
      i++;
      const obj = {};
      for (;;) {
        skip();
        if (i >= n) fail('unterminated object');
        if (text[i] === '}') { i++; return obj; }
        let key;
        if (text[i] === '"') key = parseString();
        else {
          const v = parseValue();
          key = String(v);
        }
        skip();
        if (text[i] === ':' || text[i] === '=') i++;
        obj[key] = parseValue();
      }
    }

    function parseArray() {
      i++;
      const arr = [];
      for (;;) {
        skip();
        if (i >= n) fail('unterminated array');
        if (text[i] === ']') { i++; return arr; }
        arr.push(parseValue());
      }
    }

    const v = parseValue();
    return v;
  }

  // ---------------------------------------------------------------------------
  // Tiny expression evaluator for JBeam "$=..." expressions (Lua-ish syntax)
  // ---------------------------------------------------------------------------
  const EXPR_FUNCS = {
    min: Math.min, max: Math.max, abs: Math.abs, floor: Math.floor, ceil: Math.ceil,
    sqrt: Math.sqrt, sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin,
    acos: Math.acos, atan: Math.atan, exp: Math.exp, log: Math.log, pow: Math.pow,
    round: (x) => Math.round(x),
    clamp: (x, a, b) => Math.min(Math.max(x, a), b),
    lerp: (a, b, t) => a + (b - a) * t,
    sign: Math.sign,
    case: (...args) => {
      for (let k = 0; k + 1 < args.length; k += 2) if (truthy(args[k])) return args[k + 1];
      return args.length % 2 ? args[args.length - 1] : 0;
    },
  };
  function truthy(v) { return !(v === false || v === null || v === undefined); }

  function evalExpression(src, lookupVar) {
    const toks = [];
    const re = /\s*(?:(\d+\.?\d*(?:[eE][-+]?\d+)?|\.\d+(?:[eE][-+]?\d+)?)|(\$[A-Za-z0-9_]+)|([A-Za-z_][A-Za-z0-9_.]*)|(~=|==|!=|<=|>=|&&|\|\||[-+*/%^(),<>?:!]))/y;
    let p = 0;
    while (p < src.length) {
      re.lastIndex = p;
      const m = re.exec(src);
      if (!m) { if (/^\s*$/.test(src.slice(p))) break; throw new Error(`bad expression: ${src}`); }
      p = re.lastIndex;
      if (m[1] !== undefined) toks.push({ t: 'num', v: parseFloat(m[1]) });
      else if (m[2] !== undefined) toks.push({ t: 'var', v: m[2] });
      else if (m[3] !== undefined) toks.push({ t: 'id', v: m[3] });
      else if (m[4] !== undefined) toks.push({ t: 'op', v: m[4] });
    }
    let k = 0;
    const peek = () => toks[k];
    const isOp = (v) => toks[k] && (toks[k].t === 'op' || toks[k].t === 'id') && toks[k].v === v;
    const eat = (v) => { if (!isOp(v)) throw new Error(`expected ${v} in ${src}`); k++; };

    function primary() {
      const t = toks[k++];
      if (!t) throw new Error(`unexpected end in ${src}`);
      if (t.t === 'num') return t.v;
      if (t.t === 'var') return lookupVar(t.v);
      if (t.t === 'op' && t.v === '(') { const v = ternary(); eat(')'); return v; }
      if (t.t === 'op' && t.v === '-') return -power();
      if (t.t === 'op' && t.v === '+') return power();
      if (t.t === 'op' && t.v === '!') return !truthy(power());
      if (t.t === 'id') {
        if (t.v === 'not') return !truthy(comparison());
        if (t.v === 'true') return true;
        if (t.v === 'false') return false;
        if (t.v === 'nil') return null;
        if (t.v === 'pi' || t.v === 'math.pi') return Math.PI;
        const name = t.v.replace(/^math\./, '');
        if (isOp('(')) {
          k++;
          const args = [];
          if (!isOp(')')) { args.push(ternary()); while (isOp(',')) { k++; args.push(ternary()); } }
          eat(')');
          const f = EXPR_FUNCS[name];
          if (!f) throw new Error(`unknown function ${name}`);
          return f(...args);
        }
        throw new Error(`unknown identifier ${t.v}`);
      }
      throw new Error(`unexpected token ${t.v} in ${src}`);
    }
    function power() {
      const b = primary();
      if (isOp('^')) { k++; return Math.pow(b, unary()); }
      return b;
    }
    function unary() {
      if (isOp('-')) { k++; return -unary(); }
      if (isOp('+')) { k++; return unary(); }
      return power();
    }
    function mul() {
      let v = unary();
      for (;;) {
        if (isOp('*')) { k++; v *= unary(); }
        else if (isOp('/')) { k++; v /= unary(); }
        else if (isOp('%')) { k++; v %= unary(); }
        else return v;
      }
    }
    function add() {
      let v = mul();
      for (;;) {
        if (isOp('+')) { k++; v += mul(); }
        else if (isOp('-')) { k++; v -= mul(); }
        else return v;
      }
    }
    function comparison() {
      let v = add();
      for (;;) {
        const t = peek();
        if (!t || t.t !== 'op') return v;
        if (t.v === '<') { k++; v = v < add(); }
        else if (t.v === '>') { k++; v = v > add(); }
        else if (t.v === '<=') { k++; v = v <= add(); }
        else if (t.v === '>=') { k++; v = v >= add(); }
        else if (t.v === '==') { k++; v = v === add(); }
        else if (t.v === '~=' || t.v === '!=') { k++; v = v !== add(); }
        else return v;
      }
    }
    function and() {
      let v = comparison();
      while (isOp('and') || isOp('&&')) { k++; const r = comparison(); v = truthy(v) ? r : v; }
      return v;
    }
    function or() {
      let v = and();
      while (isOp('or') || isOp('||')) { k++; const r = and(); v = truthy(v) ? v : r; }
      return v;
    }
    function ternary() {
      const c = or();
      if (isOp('?')) { k++; const a = ternary(); eat(':'); const b = ternary(); return truthy(c) ? a : b; }
      return c;
    }
    const result = ternary();
    if (k < toks.length) throw new Error(`trailing tokens in ${src}`);
    return result;
  }

  // ---------------------------------------------------------------------------
  // Zip reading (lazy: only the needed entries are decompressed) and writing
  // ---------------------------------------------------------------------------
  async function blobBytes(blob, start, end) {
    return new Uint8Array(await blob.slice(start, end).arrayBuffer());
  }

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream !== 'undefined') {
      const ds = new DecompressionStream('deflate-raw');
      const stream = new Blob([bytes]).stream().pipeThrough(ds);
      return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    // Node without DecompressionStream
    const zlib = require('zlib');
    return new Uint8Array(zlib.inflateRawSync(bytes));
  }

  /** Read a zip's central directory from a Blob. Returns [{path, read(): Promise<Uint8Array>}]. */
  async function openZip(blob) {
    const size = blob.size;
    const tailLen = Math.min(size, 65557 + 20);
    const tail = await blobBytes(blob, size - tailLen, size);
    const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    let eocd = -1;
    for (let p = tail.length - 22; p >= 0; p--) {
      if (dv.getUint32(p, true) === 0x06054b50) { eocd = p; break; }
    }
    if (eocd < 0) throw new Error('Not a zip file (no end-of-central-directory record)');
    let count = dv.getUint16(eocd + 10, true);
    let cdSize = dv.getUint32(eocd + 12, true);
    let cdOffset = dv.getUint32(eocd + 16, true);
    // Zip64
    if (cdOffset === 0xffffffff || count === 0xffff || cdSize === 0xffffffff) {
      const loc = eocd - 20;
      if (loc >= 0 && dv.getUint32(loc, true) === 0x07064b50) {
        const off64 = Number(dv.getBigUint64(loc + 8, true));
        const rec = await blobBytes(blob, off64, off64 + 56);
        const rv = new DataView(rec.buffer, rec.byteOffset, rec.byteLength);
        if (rv.getUint32(0, true) === 0x06064b50) {
          count = Number(rv.getBigUint64(32, true));
          cdSize = Number(rv.getBigUint64(40, true));
          cdOffset = Number(rv.getBigUint64(48, true));
        }
      }
    }
    const cd = await blobBytes(blob, cdOffset, cdOffset + cdSize);
    const cv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
    const dec = new TextDecoder('utf-8');
    const entries = [];
    let p = 0;
    for (let e = 0; e < count && p + 46 <= cd.length; e++) {
      if (cv.getUint32(p, true) !== 0x02014b50) break;
      const method = cv.getUint16(p + 10, true);
      let csize = cv.getUint32(p + 20, true);
      let usize = cv.getUint32(p + 24, true);
      const nameLen = cv.getUint16(p + 28, true);
      const extraLen = cv.getUint16(p + 30, true);
      const commentLen = cv.getUint16(p + 32, true);
      let localOff = cv.getUint32(p + 42, true);
      const name = dec.decode(cd.subarray(p + 46, p + 46 + nameLen));
      // Zip64 extra field
      let x = p + 46 + nameLen;
      const xEnd = x + extraLen;
      while (x + 4 <= xEnd) {
        const id = cv.getUint16(x, true);
        const len = cv.getUint16(x + 2, true);
        if (id === 0x0001) {
          let q = x + 4;
          if (usize === 0xffffffff) { usize = Number(cv.getBigUint64(q, true)); q += 8; }
          if (csize === 0xffffffff) { csize = Number(cv.getBigUint64(q, true)); q += 8; }
          if (localOff === 0xffffffff) { localOff = Number(cv.getBigUint64(q, true)); q += 8; }
        }
        x += 4 + len;
      }
      p = xEnd + commentLen;
      if (name.endsWith('/')) continue;
      entries.push({
        path: name.replace(/\\/g, '/'),
        size: usize,
        async read() {
          const lh = await blobBytes(blob, localOff, localOff + 30);
          const lv = new DataView(lh.buffer, lh.byteOffset, lh.byteLength);
          if (lv.getUint32(0, true) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
          const start = localOff + 30 + lv.getUint16(26, true) + lv.getUint16(28, true);
          const raw = await blobBytes(blob, start, start + csize);
          if (method === 0) return raw;
          if (method === 8) return inflateRaw(raw);
          throw new Error(`unsupported compression method ${method} for ${name}`);
        },
      });
    }
    return entries;
  }

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let k = 0; k < 256; k++) {
      let c = k;
      for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[k] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let k = 0; k < bytes.length; k++) c = CRC_TABLE[(c ^ bytes[k]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  /** Build an uncompressed (stored) zip. files: [{path, data: string|Uint8Array}] -> Uint8Array */
  function makeZip(files) {
    const enc = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;
    for (const f of files) {
      const name = enc.encode(f.path);
      const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
      const crc = crc32(data);
      const lh = new Uint8Array(30 + name.length);
      const lv = new DataView(lh.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true); // UTF-8 names
      lv.setUint16(8, 0, true);
      lv.setUint16(10, 0, true); lv.setUint16(12, 0x21, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, name.length, true);
      lh.set(name, 30);
      parts.push(lh, data);
      const ch = new Uint8Array(46 + name.length);
      const cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, 0, true); cv.setUint16(14, 0x21, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, name.length, true);
      cv.setUint32(42, offset, true);
      ch.set(name, 46);
      central.push(ch);
      offset += lh.length + data.length;
    }
    const cdSize = central.reduce((s, c) => s + c.length, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);
    const all = [...parts, ...central, end];
    const out = new Uint8Array(all.reduce((s, a) => s + a.length, 0));
    let q = 0;
    for (const a of all) { out.set(a, q); q += a.length; }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Loading a mod: collect parts (.jbeam) and configurations (.pc)
  // ---------------------------------------------------------------------------
  /**
   * sources: array of { name, entries: [{path, read()}] } in priority order
   * (the mod first, then BeamNG's common.zip etc.). Returns a "library".
   */
  async function loadLibrary(sources, log) {
    log = log || (() => {});
    const dec = new TextDecoder('utf-8');
    const lib = { parts: new Map(), configs: [], models: new Map(), errors: [] };
    for (let s = 0; s < sources.length; s++) {
      const src = sources[s];
      const wanted = src.entries.filter((e) => /\.(jbeam|pc)$/i.test(e.path));
      log(`Reading ${wanted.length} files from ${src.name}…`);
      for (const e of wanted) {
        let text;
        try { text = dec.decode(await e.read()); } catch (err) { lib.errors.push(`${e.path}: ${err.message}`); continue; }
        const m = /(?:^|\/)vehicles\/([^/]+)\//i.exec(e.path);
        const model = m ? m[1] : (e.path.split('/').slice(-2, -1)[0] || '');
        let data;
        try { data = parseJBeam(text, e.path); } catch (err) { lib.errors.push(err.message); continue; }
        if (/\.pc$/i.test(e.path)) {
          if (data && typeof data === 'object') {
            lib.configs.push({ path: e.path, model, name: e.path.split('/').pop().replace(/\.pc$/i, ''), data, source: s });
          }
          continue;
        }
        if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
        for (const [partName, part] of Object.entries(data)) {
          if (!part || typeof part !== 'object' || Array.isArray(part)) continue;
          if (lib.parts.has(partName)) continue; // first source wins (mod overrides common)
          lib.parts.set(partName, { name: partName, part, file: e.path, model, source: s });
          const st = part.slotType;
          if (st === 'main' || (Array.isArray(st) && st.includes('main'))) {
            if (!lib.models.has(model) || s < lib.models.get(model).source) lib.models.set(model, { model, mainPart: partName, source: s, file: e.path });
          }
        }
      }
    }
    return lib;
  }

  /** Models that come from the first (mod) source, falling back to all. */
  function listVehicles(lib) {
    const mine = [...lib.models.values()].filter((m) => m.source === 0);
    const list = mine.length ? mine : [...lib.models.values()];
    return list.map((m) => ({
      model: m.model,
      mainPart: m.mainPart,
      title: titleOf(lib.parts.get(m.mainPart)),
      configs: lib.configs.filter((c) => c.model.toLowerCase() === m.model.toLowerCase()).map((c) => c.name).sort(),
    }));
  }

  function titleOf(entry) {
    if (!entry) return '';
    const info = entry.part.information || {};
    return info.name || entry.name;
  }

  // ---------------------------------------------------------------------------
  // Conversion
  // ---------------------------------------------------------------------------
  function isHeaderRow(r) {
    return Array.isArray(r) && r.length > 0 && r.every((c) => typeof c === 'string');
  }
  function isDict(v) { return v && typeof v === 'object' && !Array.isArray(v); }

  function num(v, def) {
    if (typeof v === 'number' && isFinite(v)) return v;
    if (v === Infinity || v === -Infinity) return v;
    if (typeof v === 'string' && v.trim() !== '' && !isNaN(+v)) return +v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    return def;
  }

  function fmt(x, digits) {
    if (x === Infinity || x > BIG) x = BIG;
    if (x === -Infinity || x < -BIG) x = -BIG;
    if (!isFinite(x)) x = 0;
    const d = digits === undefined ? 6 : digits;
    if (Math.abs(x) >= 1000) return String(Math.round(x));
    let s = x.toFixed(d);
    if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
    if (s === '-0') s = '0';
    return s;
  }

  const v3 = {
    sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
    add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
    scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
    dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
    len: (a) => Math.hypot(a[0], a[1], a[2]),
    norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
    mid: (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2],
  };

  // BeamNG is Z-up; RoR (OGRE) is Y-up. This is a proper rotation (keeps handedness).
  const toRoR = (x, y, z) => [x, z, -y];

  /**
   * Convert. opts: { model, config (name of .pc or null), cab: bool, title }
   * Returns { truck, files: [{path,data}], report: {warnings, stats}, fileBase }
   */
  function convert(lib, opts) {
    opts = Object.assign({ cab: true, visibleBeams: true }, opts || {});
    const warnings = [];
    const warnOnce = new Set();
    const warn = (msg) => { if (!warnOnce.has(msg)) { warnOnce.add(msg); warnings.push(msg); } };

    // -- pick vehicle + configuration ---------------------------------------
    const vehicles = listVehicles(lib);
    if (!vehicles.length) throw new Error('No vehicle found: no JBeam part with "slotType": "main". Is this a BeamNG vehicle mod?');
    const veh = (opts.model && vehicles.find((v) => v.model.toLowerCase() === String(opts.model).toLowerCase())) || vehicles[0];
    let pc = null;
    if (opts.config) {
      pc = lib.configs.find((c) => c.model.toLowerCase() === veh.model.toLowerCase() && c.name === opts.config);
      if (!pc) warn(`Configuration "${opts.config}" not found; using the default parts.`);
    } else if (veh.configs.length) {
      // Prefer the config named in info.json-like conventions, else the first one.
      pc = lib.configs.find((c) => c.model.toLowerCase() === veh.model.toLowerCase() && c.name === veh.configs[0]);
    }
    const pcData = pc ? pc.data : {};
    const pcParts = isDict(pcData.parts) ? pcData.parts : {};
    const pcVars = isDict(pcData.vars) ? pcData.vars : {};
    const mainName = (typeof pcData.mainPartName === 'string' && lib.parts.has(pcData.mainPartName)) ? pcData.mainPartName : veh.mainPart;

    // -- resolve the slot tree ----------------------------------------------
    // Children are placed before their parent so that, e.g., tire/wheel properties
    // (modifier rows in the tire part) apply to the wheel rows in the hub part.
    const order = []; // [{entry, slotOptions}]
    const used = new Set();
    function resolve(name, slotOptions, depth) {
      if (depth > 40) { warn('Slot tree is too deep (circular slots?)'); return; }
      const entry = lib.parts.get(name);
      if (!entry) { warn(`Part "${name}" not found (is a dependency missing? e.g. BeamNG's common.zip)`); return; }
      if (used.has(name)) return;
      used.add(name);
      const part = entry.part;
      for (const key of ['slots', 'slots2']) {
        const table = part[key];
        if (!Array.isArray(table) || !isHeaderRow(table[0])) continue;
        const header = table[0];
        const iName = header.indexOf(key === 'slots2' ? 'name' : 'type');
        const iDef = header.indexOf('default');
        for (const row of table.slice(1)) {
          if (!Array.isArray(row)) continue;
          const slotName = row[iName >= 0 ? iName : 0];
          if (typeof slotName !== 'string') continue;
          let chosen = Object.prototype.hasOwnProperty.call(pcParts, slotName) ? pcParts[slotName] : row[iDef >= 0 ? iDef : 1];
          if (typeof chosen !== 'string' || chosen === '') continue;
          const opt = isDict(row[row.length - 1]) ? row[row.length - 1] : null;
          resolve(chosen, opt, depth + 1);
        }
      }
      order.push({ entry, slotOptions: slotOptions || null });
    }
    resolve(mainName, null, 0);
    // Move the main part's children-first order but keep refNodes/cameras lookups simple.

    // -- variables -----------------------------------------------------------
    const varDefs = new Map();
    for (const { entry } of order) {
      const t = entry.part.variables;
      if (!Array.isArray(t) || !isHeaderRow(t[0])) continue;
      const h = t[0];
      const iN = h.indexOf('name'), iD = h.indexOf('default');
      for (const r of t.slice(1)) {
        if (!Array.isArray(r)) continue;
        const nm = r[iN >= 0 ? iN : 0];
        if (typeof nm === 'string' && !varDefs.has(nm)) varDefs.set(nm, r[iD >= 0 ? iD : 4]);
      }
    }
    for (const [k, v] of Object.entries(pcVars)) varDefs.set(k.startsWith('$') ? k : '$' + k, v);
    const varCache = new Map();
    const varStack = new Set();
    function lookupVar(name) {
      if (varCache.has(name)) return varCache.get(name);
      if (!varDefs.has(name)) { warn(`Variable ${name} is not defined; using 0`); return 0; }
      if (varStack.has(name)) { warn(`Circular variable ${name}`); return 0; }
      varStack.add(name);
      const v = evalValue(varDefs.get(name));
      varStack.delete(name);
      varCache.set(name, v);
      return v;
    }
    function evalValue(v) {
      if (typeof v === 'string') {
        if (v.startsWith('$=')) {
          try { return evalExpression(v.slice(2), lookupVar); } catch (e) { warn(`Could not evaluate "${v}": ${e.message}`); return 0; }
        }
        if (/^\$[A-Za-z0-9_]+$/.test(v)) return lookupVar(v);
        if (v === 'FLT_MAX') return FLT_MAX;
        if (v === '-FLT_MAX') return -FLT_MAX;
        return v;
      }
      if (Array.isArray(v)) return v.map(evalValue);
      if (isDict(v)) { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = evalValue(x); return o; }
      return v;
    }

    // -- table iteration (modifier rows carry over across parts) -------------
    function* rowsOf(section) {
      const state = {};
      for (const { entry, slotOptions } of order) {
        const table = entry.part[section];
        if (!Array.isArray(table) || !table.length || !isHeaderRow(table[0])) continue;
        const header = table[0].map((h) => h.replace(/:$/, ''));
        const saved = {};
        if (slotOptions) for (const [k, v] of Object.entries(evalValue(slotOptions))) { saved[k] = state[k]; state[k] = v; }
        for (const raw of table.slice(1)) {
          if (isDict(raw)) { Object.assign(state, evalValue(raw)); continue; }
          if (!Array.isArray(raw)) continue;
          const row = evalValue(raw);
          const cols = {};
          for (let c = 0; c < header.length && c < row.length; c++) {
            if (!isDict(row[c])) cols[header[c]] = row[c];
          }
          const inline = row.length > 0 && isDict(row[row.length - 1]) ? row[row.length - 1] : null;
          const props = inline ? Object.assign({}, state, inline) : Object.assign({}, state);
          yield { cols, props, part: entry.name };
        }
        if (slotOptions) for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete state[k]; else state[k] = saved[k]; }
      }
    }

    // Plain dict sections (refNodes may also be a table)
    function firstTable(section) {
      for (const r of rowsOf(section)) return r;
      return null;
    }

    // -- nodes ---------------------------------------------------------------
    const nodes = new Map(); // id -> node
    for (const { cols, props } of rowsOf('nodes')) {
      const id = cols.id;
      if (id === undefined || id === null) continue;
      let x = num(cols.posX, NaN), y = num(cols.posY, NaN), z = num(cols.posZ, NaN);
      if (!isFinite(x) || !isFinite(y) || !isFinite(z)) { warn(`Node ${id} has an invalid position; skipped`); continue; }
      const off = props.nodeOffset;
      if (isDict(off)) { x += num(off.x, 0); y += num(off.y, 0); z += num(off.z, 0); }
      if (nodes.has(String(id))) warn(`Node "${id}" is defined more than once; the last definition is used`);
      nodes.set(String(id), {
        id: String(id),
        pos: toRoR(x, y, z),
        weight: Math.max(0.001, num(props.nodeWeight, BNG.nodeWeight)),
        collision: props.collision !== false,
        friction: num(props.frictionCoef, 1),
      });
    }
    if (!nodes.size) throw new Error('The selected configuration has no nodes.');
    const hasNode = (id) => nodes.has(String(id));

    // -- beams ---------------------------------------------------------------
    const beams = [];
    const shocks = [];
    const steeringHydros = [];
    let skippedBeams = 0;
    const beamKeys = new Set();
    function beamProps(props) {
      return {
        spring: Math.max(0, num(props.beamSpring, BNG.beamSpring)),
        damp: Math.max(0, num(props.beamDamp, BNG.beamDamp)),
        deform: Math.max(0, num(props.beamDeform, BNG.beamDeform)),
        strength: Math.max(0, num(props.beamStrength, BNG.beamStrength)),
      };
    }
    for (const { cols, props } of rowsOf('beams')) {
      const a = cols.id1, b = cols.id2;
      if (a === undefined || b === undefined) continue;
      if (!hasNode(a) || !hasNode(b)) { if (!props.optional) skippedBeams++; continue; }
      if (String(a) === String(b)) continue;
      const type = String(props.beamType || '|NORMAL').replace(/^\|/, '').toUpperCase();
      if (type === 'BROKEN' || type === 'LBEAM' || type === 'PRESSURED') {
        if (type !== 'BROKEN') warn(`Beam type |${type} is not supported by RoR and was skipped`);
        continue;
      }
      const bp = beamProps(props);
      const precomp = num(props.beamPrecompression, 1);
      if (type === 'BOUNDED' || (type === 'NORMAL' && Math.abs(precomp - 1) > 1e-4 && bp.spring < 2e6)) {
        // Suspension springs / dampers / bump stops -> RoR shocks
        let damp = bp.damp;
        const reb = num(props.beamDampRebound, NaN);
        if (isFinite(reb)) damp = (damp + reb) / 2;
        let sb = num(props.beamShortBound, type === 'BOUNDED' ? 1 : 0.95);
        let lb = num(props.beamLongBound, type === 'BOUNDED' ? 1 : 10);
        if (!isFinite(sb) || sb > 1) sb = 1;
        if (!isFinite(lb) || lb > 100) lb = 100;
        shocks.push({ a: String(a), b: String(b), spring: bp.spring, damp, sb: Math.max(0, sb), lb: Math.max(0, lb), precomp: Math.min(2, Math.max(0.2, precomp)) });
        continue;
      }
      if (bp.spring === 0 && bp.damp === 0) continue; // no physical effect
      const key = [a, b].map(String).sort().join('|');
      if (beamKeys.has(key)) continue; // identical node pair already present
      beamKeys.add(key);
      beams.push({ a: String(a), b: String(b), ...bp, support: type === 'SUPPORT' });
    }
    if (skippedBeams) warn(`${skippedBeams} beam(s) referenced nodes that don't exist in this configuration and were skipped`);

    // -- hydros: steering ones become RoR hydros, others rigid beams ---------
    for (const { cols, props } of rowsOf('hydros')) {
      const a = cols.id1, b = cols.id2;
      if (!hasNode(a) || !hasNode(b) || String(a) === String(b)) continue;
      const src = String(props.inputSource || 'steering');
      const bp = beamProps(props);
      if (/steer/i.test(src)) {
        let f = NaN;
        if (props.factor !== undefined) f = num(props.factor, NaN);
        const inF = num(props.inputFactor, 1);
        if (!isFinite(f) && (props.inLimit !== undefined || props.outLimit !== undefined)) {
          const ext = num(props.outLimit, 2) - 1, ret = 1 - num(props.inLimit, 0);
          f = inF * (ext + ret) / 2;
        }
        if (!isFinite(f)) f = 0.1 * Math.sign(inF || 1);
        steeringHydros.push({ a: String(a), b: String(b), bngFactor: f, ...bp });
      } else {
        beams.push({ a: String(a), b: String(b), ...bp, support: false });
      }
    }

    // -- unsupported sections ------------------------------------------------
    for (const sec of ['torsionbars', 'rails', 'slidenodes', 'thrusters', 'rotators']) {
      for (const r of rowsOf(sec)) {
        if (sec === 'torsionbars') warn('Torsion bars (anti-roll bars) have no RoR equivalent; the car may roll a little more in corners');
        else if (sec === 'rotators') warn('"rotators" (brake discs / hub rotators) are not converted');
        else warn(`"${sec}" are not converted`);
        break;
      }
    }

    // -- triangles -> cab ----------------------------------------------------
    const tris = [];
    const triKeys = new Set();
    function addTri(a, b, c, props) {
      if (!hasNode(a) || !hasNode(b) || !hasNode(c)) return;
      const ids = [String(a), String(b), String(c)];
      if (ids[0] === ids[1] || ids[1] === ids[2] || ids[0] === ids[2]) return;
      const key = ids.slice().sort().join('|');
      if (triKeys.has(key)) return;
      triKeys.add(key);
      const collide = String(props.triangleType || '').toUpperCase() !== 'NONCOLLIDABLE';
      tris.push({ ids, collide });
    }
    for (const { cols, props } of rowsOf('triangles')) addTri(cols.id1, cols.id2, cols.id3, props);
    for (const { cols, props } of rowsOf('quadTriangles')) {
      addTri(cols.id1, cols.id2, cols.id3, props);
      addTri(cols.id1, cols.id3, cols.id4, props);
    }

    // -- orientation (refNodes) ---------------------------------------------
    let ref = null;
    {
      const r = firstTable('refNodes');
      if (r) ref = { ref: r.cols.ref, back: r.cols.back, left: r.cols.left, up: r.cols.up };
    }
    const allPos = [...nodes.values()].map((nd) => nd.pos);
    const bbMin = [0, 1, 2].map((k) => Math.min(...allPos.map((p) => p[k])));
    const bbMax = [0, 1, 2].map((k) => Math.max(...allPos.map((p) => p[k])));
    const center = v3.mid(bbMin, bbMax);
    let fwd = [0, 0, 1], up = [0, 1, 0], left = [1, 0, 0];
    if (ref && hasNode(ref.ref) && hasNode(ref.back) && hasNode(ref.left)) {
      const P = (id) => nodes.get(String(id)).pos;
      fwd = v3.norm(v3.sub(P(ref.ref), P(ref.back)));
      left = v3.norm(v3.sub(P(ref.left), P(ref.ref)));
      up = (ref.up && hasNode(ref.up)) ? v3.norm(v3.sub(P(ref.up), P(ref.ref))) : v3.norm(v3.cross(fwd, left));
    } else {
      warn('No valid refNodes found; assuming the standard BeamNG orientation (front = -Y)');
      ref = null;
    }
    const nearestNode = (p, exclude) => {
      let best = null, bd = Infinity;
      for (const nd of nodes.values()) {
        if (exclude && exclude.has(nd.id)) continue;
        const d = v3.len(v3.sub(nd.pos, p));
        if (d < bd) { bd = d; best = nd.id; }
      }
      return best;
    };
    if (!ref) {
      const c = nearestNode(center);
      const b = nearestNode(v3.sub(center, v3.scale(fwd, (bbMax[2] - bbMin[2]) / 3)), new Set([c]));
      const l = nearestNode(v3.add(center, v3.scale(left, (bbMax[0] - bbMin[0]) / 3)), new Set([c, b]));
      ref = { ref: c, back: b, left: l };
    }

    // -- wheels --------------------------------------------------------------
    const wheelDefs = new Map();
    for (const sec of ['pressureWheels', 'hubWheels', 'hubWheelsTSV', 'hubWheelsTSI', 'monoHubWheels', 'wheels']) {
      for (const { cols, props } of rowsOf(sec)) {
        const name = String(cols.name !== undefined ? cols.name : `${sec}${wheelDefs.size}`);
        wheelDefs.set(name, { name, sec, cols, props });
      }
    }

    // Powertrain: find driven wheels, engine, gearbox, final drive.
    const devices = new Map();
    for (const { cols, props } of rowsOf('powertrain')) {
      if (!cols.name) continue;
      devices.set(String(cols.name), { type: String(cols.type || ''), name: String(cols.name), input: cols.inputName, props });
    }
    const deviceData = (name) => {
      const out = {};
      for (const { entry } of order) if (isDict(entry.part[name])) Object.assign(out, evalValue(entry.part[name]));
      return out;
    };
    const driven = new Set();
    const wheelDevice = new Map();
    for (const d of devices.values()) {
      const data = deviceData(d.name);
      const cw = d.props.connectedWheel || data.connectedWheel;
      if (cw) { driven.add(String(cw)); wheelDevice.set(String(cw), d.name); }
    }
    for (const w of wheelDefs.values()) if (num(w.props.propulsed, 0) > 0) driven.add(w.name);

    const engineDev = [...devices.values()].find((d) => /combustionEngine|electricMotor/i.test(d.type));
    const gearboxDev = [...devices.values()].find((d) => /gearbox/i.test(d.type));

    if (engineDev && !driven.size && wheelDefs.size) {
      // Fallback: drive the rear-most axle
      const zs = [...wheelDefs.values()].filter((w) => hasNode(w.cols.node1)).map((w) => v3.dot(nodes.get(String(w.cols.node1)).pos, fwd));
      const minZ = Math.min(...zs);
      for (const w of wheelDefs.values()) if (hasNode(w.cols.node1) && v3.dot(nodes.get(String(w.cols.node1)).pos, fwd) < minZ + 0.3) driven.add(w.name);
      warn('Could not tell which wheels are driven; driving the rear axle');
    }

    const wheels = [];
    const lateral = v3.cross(up, fwd); // RoR spins wheels forward when axis = up x forward
    for (const w of wheelDefs.values()) {
      const p = w.props;
      let n1 = w.cols.node1, n2 = w.cols.node2;
      if (!hasNode(n1) || !hasNode(n2) || String(n1) === String(n2)) { warn(`Wheel "${w.name}" uses missing nodes; skipped`); continue; }
      n1 = String(n1); n2 = String(n2);
      if (v3.dot(v3.sub(nodes.get(n2).pos, nodes.get(n1).pos), lateral) < 0) { const t = n1; n1 = n2; n2 = t; }
      let arm = w.cols.nodeArm;
      if (!hasNode(arm) || String(arm) === n1 || String(arm) === n2) {
        arm = nearestNode(v3.mid(nodes.get(n1).pos, nodes.get(n2).pos), new Set([n1, n2]));
      }
      const snode = hasNode(w.cols.nodeS) ? String(w.cols.nodeS) : '9999';
      const hasTire = p.hasTire !== false;
      const radius = num(hasTire ? p.radius : (p.hubRadius || p.radius), NaN) || num(p.hubRadius, 0.3) || 0.3;
      const rays = Math.round(Math.min(40, Math.max(6, num(p.numRays, 16))));
      const tireW = num(p.nodeWeight, 0.35), hubW = num(p.hubNodeWeight, 0.6);
      let mass = 2 * rays * (tireW + hubW);
      mass = Math.min(200, Math.max(4, mass));
      const nodeMass = mass / (2 * rays);
      const psi = num(p.pressurePSI, 30);
      let spring = Math.min(1.2e6, Math.max(1e5, 13000 * psi));
      let damp = 2 * 0.5 * Math.sqrt(spring * nodeMass);
      // Explicit-integration stability limits (each tread node has ~3 springs)
      const kMax = nodeMass * Math.pow(2 / PHYSICS_DT, 2) * 0.25 / 3;
      const cMax = nodeMass * (2 / PHYSICS_DT) * 0.5 / 3;
      spring = Math.min(spring, kMax);
      damp = Math.min(damp, cMax);
      const brakeTorque = num(p.brakeTorque, 0);
      const parkTorque = num(p.parkingTorque, 0);
      const braked = p.enableBrakes === false ? 0 : (brakeTorque > 0 || p.brakeTorque === undefined) ? (parkTorque > 0 ? 1 : 4) : 0;
      wheels.push({
        name: w.name, n1, n2, snode, arm: String(arm), radius, width: num(p.tireWidth, 0.2), rays, mass, spring, damp,
        braked, propulsed: driven.has(w.name) ? 1 : 0, brakeTorque, parkTorque,
        center: v3.mid(nodes.get(n1).pos, nodes.get(n2).pos),
      });
    }
    if (wheels.length > ROR_MAX_WHEELS) { warn(`RoR supports at most ${ROR_MAX_WHEELS} wheels; extra wheels dropped`); wheels.length = ROR_MAX_WHEELS; }
    if (!wheels.length) warn('No wheels were found in this configuration');
    if (wheels.length && !wheels.some((w) => w.propulsed) && engineDev) warn('No driven wheels found');

    // -- steering direction & amount from geometry --------------------------
    const fwdOf = (p) => v3.dot(v3.sub(p, center), fwd);
    const steering = [];
    for (const h of steeringHydros) {
      const A = nodes.get(h.a).pos, B = nodes.get(h.b).pos;
      const L0 = v3.len(v3.sub(B, A));
      let best = null, bd = Infinity;
      for (const w of wheels) {
        const d = Math.min(v3.len(v3.sub(A, w.center)), v3.len(v3.sub(B, w.center)));
        if (d < bd) { bd = d; best = w; }
      }
      let factor;
      if (best && bd < 0.8 && L0 > 0.02) {
        // The end nearer the wheel is the steering arm; shortening pulls it toward the other end.
        const nearA = v3.len(v3.sub(A, best.center)) <= v3.len(v3.sub(B, best.center));
        const P = nearA ? A : B, Q = nearA ? B : A;
        const d = v3.norm(v3.sub(Q, P));
        const r = v3.sub(P, best.center);
        const yaw = v3.dot(v3.cross(r, d), up); // >0: shortening turns the wheel left
        const lever = Math.max(0.03, Math.abs(yaw));
        const wantRight = fwdOf(best.center) >= 0 ? -1 : 1; // front wheels yaw right; rear-steer opposite
        // RoR: steering right => length = L0 * (1 - factor). Aim for ~30 degrees of lock.
        let mag = Math.min(0.5, Math.max(0.02, (lever * 0.52) / L0));
        factor = (Math.sign(yaw) === wantRight || yaw === 0) ? mag : -mag;
      } else {
        factor = Math.max(-0.5, Math.min(0.5, -h.bngFactor));
      }
      steering.push({ ...h, factor });
    }

    // -- engine --------------------------------------------------------------
    let engine = null;
    if (engineDev) {
      const ed = deviceData(engineDev.name);
      let curve = [];
      if (Array.isArray(ed.torque)) {
        const t = ed.torque;
        const rows = isHeaderRow(t[0]) ? t.slice(1) : t;
        for (const r of rows) if (Array.isArray(r) && r.length >= 2) curve.push([num(r[0], 0), num(r[1], 0)]);
      }
      curve = curve.filter((c) => isFinite(c[0]) && isFinite(c[1])).sort((a, b) => a[0] - b[0]);
      let maxT = curve.length ? Math.max(...curve.map((c) => c[1])) : 0;
      if (!(maxT > 0)) { maxT = 250; warn('Engine torque curve not found; using 250 Nm'); }
      const idle = num(ed.idleRPM, 800);
      const maxRPM = num(ed.maxRPM, curve.length ? curve[curve.length - 1][0] : 6500);
      const gd = gearboxDev ? deviceData(gearboxDev.name) : {};
      let ratios = Array.isArray(gd.gearRatios) ? gd.gearRatios.map((x) => num(x, 0)) : [];
      let reverse = Math.abs(ratios.find((r) => r < 0) || 3.5);
      let fwdGears = ratios.filter((r) => r > 0);
      if (!fwdGears.length) { fwdGears = [3.5, 2.1, 1.4, 1.0, 0.8]; warn('Gear ratios not found; using a generic 5-speed'); }
      // Final drive: product of gearRatio along the path from a driven wheel up to the gearbox.
      let finalDrive = 0;
      for (const wn of driven) {
        let dn = wheelDevice.get(wn), prod = 1, guard = 0;
        while (dn && devices.has(dn) && guard++ < 30) {
          const d = devices.get(dn);
          if (d === gearboxDev || d === engineDev) break;
          const gr = num(deviceData(dn).gearRatio, num(d.props.gearRatio, 1));
          if (gr > 0) prod *= gr;
          dn = d.input;
        }
        finalDrive = Math.max(finalDrive, prod);
      }
      if (!(finalDrive > 1)) { finalDrive = 3.7; warn('Final drive ratio not found; using 3.7'); }
      const isElectric = /electric/i.test(engineDev.type);
      const shiftUp = Math.max(idle + 1500, maxRPM * 0.9);
      const shiftDown = Math.max(idle + 300, shiftUp * 0.45);
      engine = {
        shiftDown, shiftUp, torque: maxT, finalDrive, reverse, gears: fwdGears, idle,
        type: isElectric ? 'e' : (maxT > 900 ? 't' : 'c'),
        curve: curve.filter((c) => c[0] >= 0).map((c) => [c[0], Math.max(0, c[1] / maxT)]),
      };
    }

    // Brakes
    const maxBrake = Math.max(0, ...wheels.map((w) => w.brakeTorque));
    const maxPark = Math.max(0, ...wheels.map((w) => w.parkTorque));

    // -- stability: keep exact BeamNG masses unless the physics would explode ---
    // RoR integrates with semi-implicit Euler at dt = 0.5 ms. For a node of mass m
    // that is stable when (lambda_k*dt^2 + 2*lambda_c*dt) / m < 4, where lambda is the
    // largest eigenvalue of the (mass-scaled) stiffness/damping matrix. We bound
    // lambda per node with Gershgorin's theorem: stiffest direction of the node's own
    // springs plus the coupling to each neighbour. That bound is sufficient (never
    // too small), so a node that satisfies it cannot be the cause of a blow-up.
    const tensors = new Map();
    const addT = (id, d, k, c) => {
      let t = tensors.get(id);
      if (!t) { t = { K: [0, 0, 0, 0, 0, 0], C: [0, 0, 0, 0, 0, 0], ks: 0, cs: 0 }; tensors.set(id, t); }
      const o = [d[0] * d[0], d[1] * d[1], d[2] * d[2], d[0] * d[1], d[0] * d[2], d[1] * d[2]];
      for (let q = 0; q < 6; q++) { t.K[q] += k * o[q]; t.C[q] += c * o[q]; }
      t.ks += k; t.cs += c;
    };
    const addBeamT = (a, b, k, c) => {
      const d = v3.norm(v3.sub(nodes.get(b).pos, nodes.get(a).pos));
      addT(a, d, k, c); addT(b, d, k, c);
    };
    for (const b of beams) addBeamT(b.a, b.b, b.spring, b.damp);
    for (const s of shocks) addBeamT(s.a, s.b, s.spring, s.damp);
    for (const h of steeringHydros) addBeamT(h.a, h.b, h.spring, h.damp);
    const safeMass = new Map();
    for (const nd of nodes.values()) {
      const t = tensors.get(nd.id);
      if (!t) continue;
      const gk = maxEigenSym(t.K) + t.ks, gc = maxEigenSym(t.C) + t.cs;
      safeMass.set(nd.id, 1.1 * (gk * PHYSICS_DT * PHYSICS_DT + 2 * gc * PHYSICS_DT) / 4);
    }
    const originalMass = [...nodes.values()].reduce((s, nd) => s + nd.weight, 0);
    let fixedNodes = 0;
    const applySafeMass = (onlyIds) => {
      let count = 0;
      for (const nd of nodes.values()) {
        if (onlyIds && !onlyIds.has(nd.id)) continue;
        const need = safeMass.get(nd.id) || 0;
        if (need > nd.weight) { nd.weight = need; count++; }
      }
      return count;
    };

    let selfTest = null;
    if (opts.selfTest === false) {
      // No simulation available: be safe and apply the guaranteed-stable masses.
      if (opts.massFix !== false) fixedNodes = applySafeMass(null);
    } else {
      // 1) Try with the exact BeamNG masses.
      selfTest = simulateDrop(nodes, beams, shocks, steeringHydros, wheels, up);
      // 2) If it blows up, give the nodes around the trouble spot their
      //    guaranteed-stable mass (growing the area each round), and only as a last
      //    resort every node that fails the bound.
      if (!selfTest.stable && opts.massFix !== false) {
        const adj = new Map();
        const link = (a, b) => { if (!adj.has(a)) adj.set(a, []); adj.get(a).push(b); };
        for (const b of [...beams, ...shocks, ...steeringHydros]) { link(b.a, b.b); link(b.b, b.a); }
        let area = new Set();
        for (let round = 0; round < 4 && !selfTest.stable; round++) {
          for (const id of selfTest.hotNodes) area.add(id);
          const grown = new Set(area);
          for (const id of area) for (const nb of adj.get(id) || []) grown.add(nb);
          area = grown;
          fixedNodes += applySafeMass(area);
          selfTest = simulateDrop(nodes, beams, shocks, steeringHydros, wheels, up);
        }
        if (!selfTest.stable) {
          fixedNodes += applySafeMass(null);
          selfTest = simulateDrop(nodes, beams, shocks, steeringHydros, wheels, up);
        }
      }
      // 3) Anything left (contact/geometry problems): double the worst nodes and retry.
      for (let attempt = 0; attempt < 4 && !selfTest.stable && opts.massFix !== false; attempt++) {
        for (const id of selfTest.hotNodes) nodes.get(id).weight *= 2;
        fixedNodes += selfTest.hotNodes.length;
        selfTest = simulateDrop(nodes, beams, shocks, steeringHydros, wheels, up);
      }
      if (!selfTest.stable) warn('Self-test: the vehicle still looked unstable after the automatic fixes. It may shake or break apart in RoR.');
    }
    const addedMass = [...nodes.values()].reduce((s, nd) => s + nd.weight, 0) - originalMass;
    if (fixedNodes) warn(`${fixedNodes} node(s) were too light for their beams in RoR's physics and were made heavier (+${addedMass.toFixed(1)} kg in total, ${(100 * addedMass / originalMass).toFixed(1)}% of the body) to stop the vehicle exploding`);

    // -- write the .truck ----------------------------------------------------
    const idx = new Map();
    let k = 0;
    for (const id of nodes.keys()) idx.set(id, k++);
    const N = (id) => (id === '9999' ? '9999' : String(idx.get(String(id))));

    const title = (opts.title || `${veh.title || veh.model}${pc ? ' (' + pc.name + ')' : ''}`).replace(/[\r\n;]/g, ' ').trim() || 'Converted vehicle';
    const fileBase = (veh.model + (pc ? '_' + pc.name : '')).replace(/[^A-Za-z0-9_\-]+/g, '_');
    const matName = `jbeam2ror/${fileBase}/body`;
    const SAFE_DEFAULTS = 'set_beam_defaults 9000000, 12000, 1000000000, 1000000000';
    const L = [];
    L.push(title);
    L.push('');
    L.push(`; Converted from BeamNG.drive JBeam by jbeam2ror`);
    L.push(`; Source vehicle: ${veh.model}${pc ? ', configuration ' + pc.name : ''}`);
    L.push('; Physics only: flexbody meshes are not converted, the body is drawn from collision triangles.');
    L.push('');
    L.push('enable_advanced_deformation');
    L.push('');
    L.push('globals');
    L.push(`0, 0, ${matName}`);
    L.push('');
    L.push('; Keep the exact BeamNG node masses (RoR would otherwise force every node to >= 50 kg)');
    L.push('minimass');
    L.push('0.01, l');
    L.push('');
    L.push('nodes');
    for (const nd of nodes.values()) {
      const opt = 'l' + (nd.collision ? '' : 'c');
      L.push(`${N(nd.id)}, ${fmt(nd.pos[0])}, ${fmt(nd.pos[1])}, ${fmt(nd.pos[2])}, ${opt}, ${fmt(nd.weight, 4)} ;${nd.id}`);
    }
    L.push('');
    L.push('cameras');
    L.push(`${N(ref.ref)}, ${N(ref.back)}, ${N(ref.left)}`);
    L.push('');

    // Cinecam (driver view) from BeamNG's internal camera, if present
    const camRow = firstTable('camerasInternal');
    if (camRow && camRow.cols.x !== undefined) {
      const cp = toRoR(num(camRow.cols.x, 0), num(camRow.cols.y, 0), num(camRow.cols.z, 0));
      const attach = [];
      for (const key of ['id1', 'id2', 'id3', 'id4', 'id5', 'id6', 'id7', 'id8']) if (hasNode(camRow.cols[key])) attach.push(String(camRow.cols[key]));
      const ex = new Set(attach);
      while (attach.length < 8) { const nn = nearestNode(cp, ex); if (!nn) break; attach.push(nn); ex.add(nn); }
      if (attach.length === 8) {
        L.push(SAFE_DEFAULTS);
        L.push('cinecam');
        L.push(`${fmt(cp[0])}, ${fmt(cp[1])}, ${fmt(cp[2])}, ${attach.map(N).join(', ')}, 8000, 800`);
        L.push('');
      }
    }

    // Beams grouped by identical settings
    const groupKey = (b) => `${fmt(b.spring)}, ${fmt(b.damp)}, ${fmt(b.deform)}, ${fmt(b.strength)}`;
    const groups = new Map();
    for (const b of beams) { const g = groupKey(b); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(b); }
    L.push('beams');
    const vis = opts.visibleBeams ? '' : 'i';
    for (const [g, list] of groups) {
      L.push(`set_beam_defaults ${g}`);
      for (const b of list) L.push(`${N(b.a)}, ${N(b.b)}${b.support ? ', s' + vis : (vis ? ', ' + vis : '')}`);
    }
    L.push('');

    if (shocks.length) {
      L.push('; BeamNG bounded / pre-compressed beams (springs, dampers, bump stops)');
      L.push(SAFE_DEFAULTS);
      L.push('shocks');
      for (const s of shocks) L.push(`${N(s.a)}, ${N(s.b)}, ${fmt(s.spring)}, ${fmt(s.damp)}, ${fmt(s.sb, 4)}, ${fmt(s.lb, 4)}, ${fmt(s.precomp, 4)}, n`);
      L.push('');
    }

    if (steering.length) {
      L.push('; Steering (direction worked out from the steering-arm geometry)');
      for (const [g, list] of groupBy(steering, groupKey)) {
        L.push(`set_beam_defaults ${g}`);
        L.push('hydros');
        for (const h of list) L.push(`${N(h.a)}, ${N(h.b)}, ${fmt(h.factor, 4)}, n`);
      }
      L.push('');
    }

    if (wheels.length) {
      L.push('; radius, width, rays, node1, node2, snode, braked, propulsed, arm, mass, spring, damping, face material, band material');
      L.push(SAFE_DEFAULTS);
      L.push('wheels');
      for (const w of wheels) {
        L.push(`${fmt(w.radius, 4)}, ${fmt(w.width, 4)}, ${w.rays}, ${N(w.n1)}, ${N(w.n2)}, ${N(w.snode)}, ${w.braked}, ${w.propulsed}, ${N(w.arm)}, ${fmt(w.mass, 2)}, ${fmt(w.spring)}, ${fmt(w.damp, 2)}, tracks/wheelface, tracks/wheelband1 ;${w.name}`);
      }
      L.push('');
      L.push('brakes');
      L.push(`${fmt(maxBrake > 0 ? maxBrake : 2000)}, ${fmt(maxPark > 0 ? maxPark : (maxBrake > 0 ? maxBrake : 2000))}`);
      L.push('');
    }

    if (engine) {
      L.push('; shift-down rpm, shift-up rpm, torque, final drive, reverse, neutral, forward gears…');
      L.push('engine');
      L.push(`${fmt(engine.shiftDown)}, ${fmt(engine.shiftUp)}, ${fmt(engine.torque)}, ${fmt(engine.finalDrive, 3)}, ${fmt(engine.reverse, 3)}, 1, ${engine.gears.map((g) => fmt(g, 3)).join(', ')}, -1`);
      L.push('');
      L.push('engoption');
      L.push(`${engine.type === 't' ? 10 : 2}, ${engine.type}`);
      L.push('');
      if (engine.curve.length >= 2) {
        L.push('torquecurve');
        for (const c of engine.curve) L.push(`${fmt(c[0])}, ${fmt(c[1], 4)}`);
        L.push('');
      }
    }

    // Cab: collision + visible body surface
    let cabTris = opts.cab ? tris.slice() : [];
    if (cabTris.length > ROR_MAX_CABS) {
      // keep collidable ones first
      cabTris.sort((a, b) => (b.collide ? 1 : 0) - (a.collide ? 1 : 0));
      warn(`RoR supports at most ${ROR_MAX_CABS} body triangles; ${cabTris.length - ROR_MAX_CABS} were dropped`);
      cabTris = cabTris.slice(0, ROR_MAX_CABS);
    }
    let cabNodes = [];
    if (cabTris.length) {
      const set = new Set();
      for (const t of cabTris) t.ids.forEach((id) => set.add(id));
      cabNodes = [...set];
      if (cabNodes.length > ROR_MAX_TEXCOORDS) {
        warn('Too many body nodes for RoR; the visible body/collision surface was left out');
        cabTris = []; cabNodes = [];
      }
    }
    if (cabTris.length) {
      const size = v3.sub(bbMax, bbMin);
      L.push('submesh');
      L.push('texcoords');
      for (const id of cabNodes) {
        const p = nodes.get(id).pos;
        const u = (p[2] - bbMin[2]) / (size[2] || 1), v = 1 - (p[1] - bbMin[1]) / (size[1] || 1);
        L.push(`${N(id)}, ${fmt(u, 4)}, ${fmt(v, 4)}`);
      }
      L.push('cab');
      for (const t of cabTris) L.push(`${t.ids.map(N).join(', ')}, ${t.collide ? 'c' : 'n'}`);
      L.push('');
    }

    L.push('end');
    L.push('');
    const truck = L.join('\n');

    const material = [
      `material ${matName}`,
      '{',
      '\treceive_shadows on',
      '\ttechnique',
      '\t{',
      '\t\tpass',
      '\t\t{',
      '\t\t\tambient 0.45 0.47 0.52',
      '\t\t\tdiffuse 0.62 0.64 0.70',
      '\t\t\tspecular 0.2 0.2 0.2 12',
      '\t\t\tcull_hardware none',
      '\t\t\tcull_software none',
      '\t\t}',
      '\t}',
      '}',
      '',
    ].join('\n');

    const totalMass = [...nodes.values()].reduce((s, nd) => s + nd.weight, 0) + wheels.reduce((s, w) => s + w.mass, 0);
    const stats = {
      vehicle: veh.model,
      config: pc ? pc.name : '(default parts)',
      parts: order.length,
      nodes: nodes.size,
      beams: beams.length,
      shocks: shocks.length,
      steeringHydros: steering.length,
      wheels: wheels.length,
      drivenWheels: wheels.filter((w) => w.propulsed).length,
      triangles: cabTris.length,
      massKg: Math.round(totalMass),
      selfTest: selfTest ? (selfTest.stable ? `passed (settled, max beam strain ${(selfTest.maxStrain*100).toFixed(1)}%)` : 'FAILED') : 'skipped',
      engine: engine ? `${Math.round(engine.torque)} Nm, ${engine.gears.length} gears, final drive ${engine.finalDrive.toFixed(2)}` : 'none',
    };
    const fileName = `${fileBase}.truck`;
    return {
      truck,
      fileBase,
      files: [
        { path: fileName, data: truck },
        { path: `${fileBase}.material`, data: material },
      ],
      report: { warnings, stats, selfTest, loadErrors: lib.errors.slice(0, 50) },
    };
  }

  /**
   * Minimal soft-body simulation with the same integrator and time step as RoR
   * (semi-implicit Euler at 2000 Hz). Drops the vehicle onto flat ground for 2.5 s.
   * Wheels are approximated as stiff springs between the axle nodes and the ground.
   */
  function simulateDrop(nodes, beams, shocks, hydros, wheels, up) {
    const ids = [...nodes.keys()];
    const ix = new Map(ids.map((id, i) => [id, i]));
    const n = ids.length;
    const pos = new Float64Array(n * 3), vel = new Float64Array(n * 3), frc = new Float64Array(n * 3), mass = new Float64Array(n);
    // Rotate so that "up" is +Y for the ground test
    const yAxis = v3.norm(up);
    for (let i = 0; i < n; i++) {
      const nd = nodes.get(ids[i]);
      pos[i * 3] = nd.pos[0]; pos[i * 3 + 1] = v3.dot(nd.pos, yAxis); pos[i * 3 + 2] = nd.pos[2];
      mass[i] = nd.weight;
    }
    const wheelLoad = [];
    for (const w of wheels) {
      const a = ix.get(w.n1), b = ix.get(w.n2);
      mass[a] += w.mass / 2; mass[b] += w.mass / 2;
      wheelLoad.push({ a, b, r: w.radius, k: w.spring * 0.75, c: w.damp * 4 });
    }
    const springs = [];
    const addSpring = (a, b, k, c, precomp, deform) => {
      const i = ix.get(a), j = ix.get(b);
      const dx = pos[j * 3] - pos[i * 3], dy = pos[j * 3 + 1] - pos[i * 3 + 1], dz = pos[j * 3 + 2] - pos[i * 3 + 2];
      const L = Math.hypot(dx, dy, dz);
      if (L < 1e-6) return;
      springs.push({ i, j, k, c, L0: L * precomp, Lr: L, deform });
    };
    for (const b of beams) addSpring(b.a, b.b, b.spring, b.damp, 1, b.deform);
    for (const s of shocks) addSpring(s.a, s.b, s.spring, s.damp, s.precomp, Infinity);
    for (const h of hydros) addSpring(h.a, h.b, h.spring, h.damp, 1, h.deform);
    // Ground: lowest wheel bottom (or lowest node) sits 2 cm above y=0
    let ground = Infinity;
    for (const w of wheelLoad) ground = Math.min(ground, Math.min(pos[w.a * 3 + 1], pos[w.b * 3 + 1]) - w.r);
    for (let i = 0; i < n; i++) ground = Math.min(ground, pos[i * 3 + 1]);
    ground -= 0.02;
    const dt = PHYSICS_DT, g = 9.81;
    const steps = Math.round(2.5 / dt);
    let maxSpeedLate = 0, blew = false;
    const energy = new Float64Array(n);
    for (let s = 0; s < steps; s++) {
      frc.fill(0);
      for (let i = 0; i < n; i++) {
        frc[i * 3 + 1] -= mass[i] * g;
        const pen = ground - pos[i * 3 + 1];
        if (pen > 0) {
          const kg = 0.2 * mass[i] / (dt * dt), cg = 0.2 * mass[i] / dt;
          frc[i * 3 + 1] += kg * pen - cg * Math.min(0, vel[i * 3 + 1]);
          frc[i * 3] -= cg * 0.5 * vel[i * 3]; frc[i * 3 + 2] -= cg * 0.5 * vel[i * 3 + 2];
        }
      }
      for (const w of wheelLoad) {
        for (const q of [w.a, w.b]) {
          const pen = ground + w.r - pos[q * 3 + 1];
          if (pen > 0) {
            frc[q * 3 + 1] += w.k * pen - w.c * Math.min(0, vel[q * 3 + 1]);
            frc[q * 3] -= w.c * vel[q * 3]; frc[q * 3 + 2] -= w.c * vel[q * 3 + 2];
          }
        }
      }
      for (const sp of springs) {
        const i3 = sp.i * 3, j3 = sp.j * 3;
        const dx = pos[j3] - pos[i3], dy = pos[j3 + 1] - pos[i3 + 1], dz = pos[j3 + 2] - pos[i3 + 2];
        const L = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-9;
        const ux = dx / L, uy = dy / L, uz = dz / L;
        const vr = (vel[j3] - vel[i3]) * ux + (vel[j3 + 1] - vel[i3 + 1]) * uy + (vel[j3 + 2] - vel[i3 + 2]) * uz;
        let f = sp.k * (L - sp.L0) + sp.c * vr;
        // plastic deformation like BeamNG/RoR: past the threshold the rest length gives way
        if (Math.abs(sp.k * (L - sp.L0)) > sp.deform) {
          const lim = Math.sign(L - sp.L0) * sp.deform;
          sp.L0 = L - lim / sp.k;
          f = lim + sp.c * vr;
        }
        frc[i3] += f * ux; frc[i3 + 1] += f * uy; frc[i3 + 2] += f * uz;
        frc[j3] -= f * ux; frc[j3 + 1] -= f * uy; frc[j3 + 2] -= f * uz;
      }
      for (let i = 0; i < n; i++) {
        const i3 = i * 3, im = dt / mass[i];
        vel[i3] += frc[i3] * im; vel[i3 + 1] += frc[i3 + 1] * im; vel[i3 + 2] += frc[i3 + 2] * im;
        pos[i3] += vel[i3] * dt; pos[i3 + 1] += vel[i3 + 1] * dt; pos[i3 + 2] += vel[i3 + 2] * dt;
      }
      if (s % 200 === 0 || s === steps - 1) {
        for (let i = 0; i < n; i++) {
          const sp2 = vel[i * 3] ** 2 + vel[i * 3 + 1] ** 2 + vel[i * 3 + 2] ** 2;
          if (!isFinite(sp2) || sp2 > 400 * 400) { blew = true; }
          energy[i] = Math.max(energy[i], isFinite(sp2) ? sp2 : 1e30);
          if (s > steps * 0.7) maxSpeedLate = Math.max(maxSpeedLate, Math.sqrt(sp2) || Infinity);
        }
        if (blew) break;
      }
    }
    // Strain check: a beam stretched/compressed by more than 50% means the structure collapsed
    let maxStrain = 0, collapsed = 0;
    for (const sp of springs) {
      const i3 = sp.i * 3, j3 = sp.j * 3;
      const L = Math.hypot(pos[j3] - pos[i3], pos[j3 + 1] - pos[i3 + 1], pos[j3 + 2] - pos[i3 + 2]);
      const strain = Math.abs(L - sp.Lr) / sp.Lr;
      if (isFinite(strain)) maxStrain = Math.max(maxStrain, strain); else maxStrain = Infinity;
      if (!(strain < 0.5)) collapsed++;
    }
    const stable = !blew && maxSpeedLate < 3 && collapsed === 0;
    // Nodes with the most kinetic energy are the likely culprits
    const order = [...energy.keys()].sort((a, b) => energy[b] - energy[a]);
    const hotNodes = stable ? [] : order.slice(0, Math.max(1, Math.ceil(n * 0.03))).map((i) => ids[i]);
    let minY = Infinity;
    for (let i = 0; i < n; i++) minY = Math.min(minY, pos[i * 3 + 1]);
    return { stable, maxSpeedLate: +maxSpeedLate.toFixed(3), maxStrain: +maxStrain.toFixed(3), collapsedBeams: collapsed, hotNodes, seconds: 2.5 };
  }

  /** Largest eigenvalue of a symmetric 3x3 matrix given as [xx, yy, zz, xy, xz, yz]. */
  function maxEigenSym(m) {
    const [a, b, c, d, e, f] = m;
    let x = [1, 0.7, 0.4], lam = 0;
    for (let it = 0; it < 30; it++) {
      const y = [a * x[0] + d * x[1] + e * x[2], d * x[0] + b * x[1] + f * x[2], e * x[0] + f * x[1] + c * x[2]];
      const l = Math.hypot(y[0], y[1], y[2]);
      if (!(l > 0)) return 0;
      lam = l;
      x = [y[0] / l, y[1] / l, y[2] / l];
    }
    return lam;
  }

  function groupBy(list, keyFn) {
    const m = new Map();
    for (const x of list) { const kk = keyFn(x); if (!m.has(kk)) m.set(kk, []); m.get(kk).push(x); }
    return m;
  }

  /** Convenience: convert and return a ready-to-install RoR mod zip (Uint8Array). */
  function buildModZip(result) {
    return makeZip(result.files.map((f) => ({ path: f.path, data: f.data })));
  }

  /** Wrap browser File objects (from a folder pick) as entries. */
  function filesToEntries(files) {
    return [...files].map((f) => ({
      path: (f.webkitRelativePath || f.relativePath || f.name).replace(/\\/g, '/'),
      size: f.size,
      read: async () => new Uint8Array(await f.arrayBuffer()),
    }));
  }

  const api = { parseJBeam, evalExpression, openZip, makeZip, loadLibrary, listVehicles, convert, buildModZip, filesToEntries, crc32 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.J2R = api;
})(typeof self !== 'undefined' ? self : this);
