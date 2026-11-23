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
    const re = /\s*(?:(\d+\.?\d*(?:[eE][-+]?\d+)?|\.\d+(?:[eE][-+]?\d+)?)|(\$[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)|([A-Za-z_][A-Za-z0-9_.]*)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")|(\.\.|~=|==|!=|<=|>=|&&|\|\||[-+*/%^(),<>?:!]))/y;
    let p = 0;
    while (p < src.length) {
      re.lastIndex = p;
      const m = re.exec(src);
      if (!m) { if (/^\s*$/.test(src.slice(p))) break; throw new Error(`bad expression: ${src}`); }
      p = re.lastIndex;
      if (m[1] !== undefined) toks.push({ t: 'num', v: parseFloat(m[1]) });
      else if (m[2] !== undefined) toks.push({ t: 'var', v: m[2] });
      else if (m[3] !== undefined) toks.push({ t: 'id', v: m[3] });
      else if (m[4] !== undefined) toks.push({ t: 'str', v: m[4].slice(1, -1) });
      else if (m[5] !== undefined) toks.push({ t: 'op', v: m[5] });
    }
    let k = 0;
    const peek = () => toks[k];
    const isOp = (v) => toks[k] && (toks[k].t === 'op' || toks[k].t === 'id') && toks[k].v === v;
    const eat = (v) => { if (!isOp(v)) throw new Error(`expected ${v} in ${src}`); k++; };

    function primary() {
      const t = toks[k++];
      if (!t) throw new Error(`unexpected end in ${src}`);
      if (t.t === 'num' || t.t === 'str') return t.v;
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
    function concat() {
      let v = add();
      while (isOp('..')) { k++; const r = add(); v = String(v === null ? 'nil' : v) + String(r === null ? 'nil' : r); }
      return v;
    }
    function comparison() {
      let v = concat();
      for (;;) {
        const t = peek();
        if (!t || t.t !== 'op') return v;
        if (t.v === '<') { k++; v = v < concat(); }
        else if (t.v === '>') { k++; v = v > concat(); }
        else if (t.v === '<=') { k++; v = v <= concat(); }
        else if (t.v === '>=') { k++; v = v >= concat(); }
        else if (t.v === '==') { k++; v = v === concat(); }
        else if (t.v === '~=' || t.v === '!=') { k++; v = v !== concat(); }
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
    // visibleBeams: draw the node/beam skeleton in RoR (off: it hides the body and costs FPS)
    // cabCollision: make body panels solid. Off by default: RoR always self-collides solid
    // panels with the vehicle's own nodes, and BeamNG cars have many nodes right next to
    // their panels, which makes the car push itself apart and float.
    opts = Object.assign({ cab: true, visibleBeams: false, cabCollision: false }, opts || {});
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
    // Same order as BeamNG: a part first, then the parts in its slots, in slot order.
    // Modifier rows carry over from part to part in this order (so tire/brake settings
    // reach the wheel rows in a later "wheeldata" part), and when two parts define the
    // same node the later one wins. Slot options (e.g. nodeOffset) apply to the whole
    // subtree under that slot.
    const order = []; // [{entry, slotOptions}]
    const missingParts = [];
    // Base-game tires (in BeamNG's common.zip) follow a naming scheme, e.g.
    // tire_F_175_70_13_standard = 175 mm wide, 70 % sidewall, 13-inch rim. When the
    // part itself isn't available we rebuild its physical size from the name.
    const synthesized = [];
    // Base-game wheels (e.g. wheel_23b_16x8_F) are rebuilt from one of the mod's own
    // wheels for the same axle, resized to the rim in the name, since BeamNG wheels
    // share the same node layout.
    function synthesizeWheel(name) {
      const m = /^(?:wheel|steelwheel|.*wheel).*?_(\d{2})x(\d{1,2}(?:\.\d+)?)_([FR])(?:_[A-Za-z0-9]+)?$/i.exec(name);
      if (!m) return null;
      const side = m[3].toUpperCase();
      const rim = +m[1] * 0.0254, width = +m[2] * 0.0254;
      let template = null;
      for (const e of lib.parts.values()) {
        const st = String(e.part.slotType || '');
        if (!new RegExp(`^wheel_${side}(_|$)`).test(st) || !Array.isArray(e.part.nodes) || !Array.isArray(e.part.pressureWheels)) continue;
        if (!template || e.source < template.source) template = e;
      }
      if (!template) return null;
      const part = JSON.parse(JSON.stringify(template.part));
      part.pressureWheels.push({ hubRadius: rim / 2 + 0.0, hubWidth: width });
      // Point the tire slot at whatever tire the configuration picked for this rim size
      if (Array.isArray(part.slots) && isHeaderRow(part.slots[0])) {
        const want = Object.keys(pcParts).find((k) => new RegExp(`^tire_${side}_${m[1]}x`, 'i').test(k))
          || Object.keys(pcParts).find((k) => new RegExp(`^tire_${side}(_|$)`, 'i').test(k) && /\d{3}_\d{2}_\d{2}/.test(String(pcParts[k])) && String(pcParts[k]).includes(`_${m[1]}_`));
        part.slots = [part.slots[0]].concat(part.slots.slice(1).map((r) => {
          if (!Array.isArray(r) || !/^tire_/i.test(String(r[0]))) return r;
          const rr = r.slice();
          if (want) { rr[0] = want; rr[1] = pcParts[want]; }
          return rr;
        }));
      }
      synthesized.push(`${name} (${m[1]}-inch rim, using the mod's ${template.name} as the pattern)`);
      return { name, file: '(rebuilt from the part name)', part, source: template.source };
    }
    function synthesizeTire(name) {
      // tire_F_175_70_13 = width mm, sidewall %, rim inches; tire_F_210_600_16 = width mm, overall diameter mm, rim inches
      const m = /^tire_([FR])_(\d{3})_(\d{2,3})_(\d{2})(?:_([A-Za-z0-9]+))?/.exec(name);
      if (!m) return null;
      const width = +m[2] / 1000, rim = +m[4] * 0.0254;
      const radius = +m[3] >= 100 ? +m[3] / 2000 : rim / 2 + width * (+m[3] / 100);
      const aspect = (radius - rim / 2) / width;
      const kind = (m[5] || '').toLowerCase();
      const psi = /offroad|mud|allterrain|truck/.test(kind) ? 26 : /race|slick|sport|semi/.test(kind) ? 32 : 29;
      const grip = /race|slick|semi/.test(kind) ? 1.15 : /sport/.test(kind) ? 1.05 : 1.0;
      synthesized.push(`${name} (${Math.round(width * 1000)} mm wide, ${(radius * 2).toFixed(3)} m tall)`);
      return {
        name,
        file: '(rebuilt from the part name)',
        part: {
          slotType: `tire_${m[1]}`,
          pressureWheels: [
            ['name', 'hubGroup', 'group', 'node1:', 'node2:', 'nodeS', 'nodeArm:', 'wheelDir'],
            { hasTire: true, radius, tireWidth: width, numRays: 16, pressurePSI: psi, nodeWeight: Math.max(0.18, Math.min(0.6, width * aspect * 2.2)), frictionCoef: grip },
          ],
        },
      };
    }
    const used = new Set();
    function resolve(name, slotOptions, depth) {
      if (depth > 40) { warn('Slot tree is too deep (circular slots?)'); return; }
      let entry = lib.parts.get(name);
      if (!entry) entry = synthesizeTire(name) || synthesizeWheel(name);
      if (!entry) { missingParts.push(name); return; }
      if (used.has(name)) return;
      used.add(name);
      const part = entry.part;
      order.push({ entry, slotOptions: slotOptions || null });
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
          const own = isDict(row[row.length - 1]) ? row[row.length - 1] : null;
          const opt = own || slotOptions ? Object.assign({}, slotOptions || {}, own || {}) : null;
          resolve(chosen, opt, depth + 1);
        }
      }
    }
    resolve(mainName, null, 0);
    if (synthesized.length) warn(`Wheels/tires from the base game (not in the mod) were rebuilt from their part names: ${synthesized.join('; ')}`);
    if (missingParts.length) {
      const physical = missingParts.filter((n) => !/bulb|incandescent|led_|halogen|occupant|soundscape|horn|license|skin|paint|decal|interior_|mirror_glass|lettering|badge/i.test(n));
      const cosmetic = missingParts.length - physical.length;
      if (physical.length) warn(`Parts not found (they come from the base game or another mod): ${physical.join(', ')}. The car is converted without them.`);
      if (cosmetic) warn(`${cosmetic} lighting/sound/cosmetic part(s) from the base game were skipped; they don't affect physics.`);
    }

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
    // Newer JBeam: parts publish values in a "components" section, read as $components.a.b
    const components = {};
    const deepMerge = (dst, src) => { for (const [k2, v2] of Object.entries(src)) { if (isDict(v2) && isDict(dst[k2])) deepMerge(dst[k2], v2); else dst[k2] = v2; } };
    for (const { entry } of order) if (isDict(entry.part.components)) deepMerge(components, entry.part.components);
    const varCache = new Map();
    const varStack = new Set();
    function lookupVar(name) {
      if (varCache.has(name)) return varCache.get(name);
      if (name.startsWith('$components.')) {
        let v = components;
        for (const key of name.split('.').slice(1)) v = isDict(v) ? v[key] : undefined;
        v = v === undefined ? null : evalValue(v);
        varCache.set(name, v);
        return v;
      }
      if (!varDefs.has(name)) return null; // undefined = nil, as in BeamNG (e.g. "$x == nil" checks)
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
        if (/^\$[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/.test(v)) return lookupVar(v);
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
    let dupNodes = 0;
    for (const { cols, props } of rowsOf('nodes')) {
      const id = cols.id;
      if (id === undefined || id === null) continue;
      let x = num(cols.posX, NaN), y = num(cols.posY, NaN), z = num(cols.posZ, NaN);
      if (!isFinite(x) || !isFinite(y) || !isFinite(z)) { warn(`Node ${id} has an invalid position; skipped`); continue; }
      const off = props.nodeOffset;
      // BeamNG mirrors the x offset: nodes on the left (+x) move by +x, on the right by -x
      if (isDict(off)) { x += Math.sign(x) * num(off.x, 0); y += num(off.y, 0); z += num(off.z, 0); }
      if (nodes.has(String(id))) dupNodes++;
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
    if (dupNodes) warn(`${dupNodes} node(s) are defined by more than one part (normal for BeamNG cars); the last definition is used, as in BeamNG`);

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
    for (const { cols, props, part } of rowsOf('beams')) {
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
      const L = v3.len(v3.sub(nodes.get(String(a)).pos, nodes.get(String(b)).pos));
      if (L < 1e-4) continue;
      // Newer JBeam gives preload and travel limits in metres (*Range); older files as ratios.
      const preRange = num(props.precompressionRange, NaN);
      let precomp = isFinite(preRange) ? (L + preRange) / L : num(props.beamPrecompression, 1);
      if (!(precomp > 0)) precomp = 1;
      const L0 = L * precomp;
      const isBounded = type === 'BOUNDED';
      const isGasStrut = type === 'NORMAL' && Math.abs(precomp - 1) > 1e-4 && bp.spring < 2e6;
      if (isBounded || isGasStrut) {
        let damp = bp.damp;
        const reb = num(props.beamDampRebound, NaN);
        if (isFinite(reb)) damp = (damp + reb) / 2;
        const rangeOr = (rangeKey, ratioKey, def) => {
          const r = num(props[rangeKey], NaN);
          if (isFinite(r)) return Math.max(0, r);
          const q = num(props[ratioKey], def);
          return isFinite(q) ? Math.max(0, q) * L0 : 100;
        };
        const sbM = isBounded ? rangeOr('shortBoundRange', 'beamShortBound', 1) : 0.95 * L0;
        const lbM = isBounded ? rangeOr('longBoundRange', 'beamLongBound', 1) : 10 * L0;
        const limitK = isBounded ? Math.max(0, num(props.beamLimitSpring, 0)) : 0;
        const limitD = isBounded ? Math.max(0, num(props.beamLimitDamp, 0)) : 0;
        if (isBounded && limitK > 0 && bp.spring < 0.05 * limitK && Math.max(sbM, lbM) <= 0.02) {
          // A limiter with (almost) no free play: hinge, latch or mount. Same as a stiff beam.
          const key = [a, b].map(String).sort().join('|');
          if (!beamKeys.has(key)) {
            beamKeys.add(key);
            beams.push({ a: String(a), b: String(b), spring: limitK, damp: Math.max(damp, limitD), deform: bp.deform, strength: bp.strength, support: false, limiter: { part, sbM, lbM } });
          }
          continue;
        }
        // RoR stiffens a shock past its bound as k + (T - k) * overshoot_in_metres, so to
        // reach BeamNG's limit stiffness right at the bound we pick T accordingly.
        const bm = Math.max(0.01, Math.min(sbM, lbM));
        const hard = (k, lim) => (lim > 0 ? Math.max(0, k + (lim - k) / bm) : k);
        shocks.push({
          a: String(a), b: String(b), spring: bp.spring, damp,
          sb: Math.min(1, sbM / L0), lb: Math.min(100, lbM / L0),
          precomp: Math.min(3, Math.max(0.2, precomp)),
          hardK: Math.min(5e8, hard(bp.spring, limitK)), hardD: Math.min(5e5, hard(damp, limitD)),
          deform: bp.deform, strength: bp.strength,
        });
        continue;
      }
      if (type === 'SUPPORT' && precomp < 0.999) {
        // A push-only stop that is slack until squashed to precomp * L (BeamNG crush and
        // steering-lock stops). RoR support beams can't be pre-shortened, so use a RoR
        // shock: free inside the bounds, then stiffening to BeamNG's spring past the stop.
        const stopM = (1 - precomp) * L;
        shocks.push({
          a: String(a), b: String(b), spring: 0, damp: 0,
          sb: Math.min(1, 1 - precomp), lb: 100, precomp: 1,
          hardK: Math.min(5e8, bp.spring / Math.max(0.01, stopM)), hardD: Math.min(5e5, bp.damp / Math.max(0.01, stopM)),
          deform: bp.deform, strength: bp.strength, stop: true,
        });
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
        steeringHydros.push({ a: String(a), b: String(b), bngFactor: f, explicitFactor: props.factor !== undefined, ...bp });
      } else {
        beams.push({ a: String(a), b: String(b), ...bp, support: false });
      }
    }

    // -- unsupported sections ------------------------------------------------
    const pairKey = (a, b) => [String(a), String(b)].sort().join('|');
    // -- latches: BeamNG couplers that start coupled (doors, hood, tailgate) ------
    // RoR has no auto-couplers, so each becomes breakable beams with the coupler's
    // strength. Coupler node pairs usually sit on top of each other; then the door-side
    // node is tied to the body-side node's neighbours instead.
    let latches = 0;
    {
      const adjB = new Map();
      for (const b of beams) {
        if (!adjB.has(b.a)) adjB.set(b.a, new Set()); if (!adjB.has(b.b)) adjB.set(b.b, new Set());
        adjB.get(b.a).add(b.b); adjB.get(b.b).add(b.a);
      }
      const seen = new Set();
      for (const { entry } of order) {
        for (const v of Object.values(entry.part)) {
          if (!isDict(v) || !Array.isArray(v.couplerNodes) || !isHeaderRow(v.couplerNodes[0])) continue;
          const h = v.couplerNodes[0].map((x) => x.replace(/:$/, ''));
          const i1 = h.indexOf('cid1'), i2 = h.indexOf('cid2'), iS = h.indexOf('autoCouplingStrength');
          if (i1 < 0 || i2 < 0) continue;
          for (const raw of v.couplerNodes.slice(1)) {
            if (!Array.isArray(raw)) continue;
            const row = evalValue(raw);
            const a = String(row[i1]), b = String(row[i2]);
            if (!hasNode(a) || !hasNode(b) || a === b || seen.has(pairKey(a, b))) continue;
            seen.add(pairKey(a, b));
            const strength = Math.max(5000, num(row[iS], 30000));
            const latch = (x, y) => beams.push({ a: x, b: y, spring: 1001000, damp: 50, deform: BIG, strength, support: false, latch: true });
            const pa = nodes.get(a).pos, pb = nodes.get(b).pos;
            if (v3.len(v3.sub(pa, pb)) > 0.003) { latch(a, b); latches++; continue; }
            const doorSide = adjB.get(b) || new Set();
            const cands = [...(adjB.get(a) || [])].filter((n2) => n2 !== b && !doorSide.has(n2))
              .map((n2) => [n2, v3.len(v3.sub(nodes.get(n2).pos, pb))]).filter((x) => x[1] > 0.02).sort((x, y) => x[1] - y[1]).slice(0, 3);
            for (const [n2] of cands) latch(b, n2);
            if (cands.length) latches++;
          }
        }
      }
    }
    if (latches) warn(`${latches} latch(es) (doors, hood, tailgate) converted to breakable beams; they hold shut like in BeamNG but can't be opened and re-closed`);

    // -- slidenodes on rails (e.g. spring seats sliding along a strut) -----------
    const rails = {};
    for (const { entry } of order) {
      const r0 = entry.part.rails;
      if (isDict(r0)) for (const [rn, rv] of Object.entries(evalValue(r0))) if (isDict(rv)) rails[rn] = rv;
    }
    const slidenodes = [];
    for (const { cols, props } of rowsOf('slidenodes')) {
      const id = cols.id, rail = rails[String(cols.railName)];
      if (!hasNode(id) || !rail) continue;
      if (cols.attached === false) continue;
      const links = (rail['links:'] || rail.links || []).map(String).filter(hasNode);
      if (links.length < 2 || links.includes(String(id))) continue;
      if (rail.looped) links.push(links[0]);
      slidenodes.push({
        id: String(id), rail: links,
        spring: Math.max(0, num(cols.spring, num(props.spring, 1e6))),
        strength: Math.max(0, num(cols.strength, FLT_MAX)),
        tolerance: Math.max(0, num(cols.tolerance, 0)),
      });
    }
    for (const sec of ['torsionbars', 'thrusters', 'rotators']) {
      for (const r of rowsOf(sec)) {
        if (sec === 'torsionbars') warn('Torsion bars (anti-roll bars) have no RoR equivalent; the car may roll a little more in corners');
        else if (sec === 'rotators') warn('"rotators" (brake discs / hub rotators) are not converted');
        else warn(`"${sec}" are not converted`);
        break;
      }
    }

    if (slidenodes.length) {
      const have = new Set([...beams, ...shocks, ...steeringHydros].map((b) => pairKey(b.a, b.b)));
      for (const sn of slidenodes) {
        for (let q = 0; q + 1 < sn.rail.length; q++) {
          const k2 = pairKey(sn.rail[q], sn.rail[q + 1]);
          if (have.has(k2) || sn.rail[q] === sn.rail[q + 1]) continue;
          have.add(k2);
          beams.push({ a: sn.rail[q], b: sn.rail[q + 1], spring: 0, damp: 0, deform: BIG, strength: BIG, support: false, rail: true });
        }
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
    const engineDev = [...devices.values()].find((d) => /combustionEngine|electricMotor/i.test(d.type));
    // A wheel is driven only if the chain of powertrain devices from its spindle/axle
    // leads back to the engine (every wheel has a spindle, driven or not).
    const reachesEngine = (name) => {
      let dn = name, guard = 0;
      while (dn && devices.has(dn) && guard++ < 40) {
        if (devices.get(dn) === engineDev) return true;
        dn = devices.get(dn).input;
      }
      return false;
    };
    const driven = new Set();
    const wheelDevice = new Map();
    for (const d of devices.values()) {
      const data = deviceData(d.name);
      const cw = d.props.connectedWheel || data.connectedWheel;
      if (!cw) continue;
      wheelDevice.set(String(cw), d.name);
      if (engineDev && reachesEngine(d.name)) driven.add(String(cw));
    }
    for (const w of wheelDefs.values()) if (num(w.props.propulsed, 0) > 0) driven.add(w.name);

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
      // 12 rays: same wheel mass in fewer, heavier tread nodes = far more stable in RoR
      const rays = Math.round(Math.min(12, Math.max(8, num(p.numRays, 12))));
      const tireW = num(p.nodeWeight, 0.35), hubW = num(p.hubNodeWeight, 0.6);
      const bngRays = Math.round(Math.min(64, Math.max(6, num(p.numRays, 16))));
      let mass = 2 * bngRays * (tireW + hubW); // BeamNG's wheel mass (hub + tyre nodes)
      mass = Math.min(200, Math.max(4, mass));
      const nodeMass = mass / (2 * rays);
      const psi = num(p.pressurePSI, 30);
      const { spring, damp } = rorTyre(nodeMass, radius, Math.min(1.2e6, Math.max(1.5e5, 13000 * psi)));
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
        // amount: the mod's own factor when it gives one, else ~30 degrees of lock from geometry
        let mag = h.explicitFactor && isFinite(h.bngFactor) && Math.abs(h.bngFactor) > 0.005 ? Math.min(0.5, Math.abs(h.bngFactor)) : Math.min(0.5, Math.max(0.02, (lever * 0.52) / L0));
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
      // RoR's clutch is a spring between engine and wheel speed: torque = clutchForce * (rpm
      // difference). On slipping light car wheels RoR's defaults (5000-10000) overshoot every
      // physics step, so the torque slams between +max and -max and the wheels shake apart.
      // Stable when clutchForce * dt * 9.55 / I_wheels < ~1, with I_wheels = sum m r^2 of the
      // driven wheels; we use half that. RoR's engine inertia is in rpm units
      // (rpm += dt * torque / inertia), i.e. BeamNG's kg m^2 divided by 9.55, kept large
      // enough that the engine side of the clutch loop is stable in top gear too.
      const drivenW = wheels.filter((w) => w.propulsed);
      const Iw = drivenW.reduce((s2, w) => s2 + w.mass * w.radius * w.radius, 0) || 2;
      const clutchForce = Math.round(Math.max(80, Math.min(5000, 0.5 * Iw / (PHYSICS_DT * 9.5493))));
      const Gtop = Math.min(...fwdGears) * finalDrive;
      const inertia = Math.max(num(ed.inertia, 0.15) / 9.5493, 0.6 * clutchForce * PHYSICS_DT / (Gtop * Gtop * 0.5), 0.02);
      engine = {
        clutchForce, inertia: +inertia.toFixed(4),
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
    for (const sn of slidenodes) {
      const axis = v3.norm(v3.sub(nodes.get(sn.rail[sn.rail.length - 1]).pos, nodes.get(sn.rail[0]).pos));
      const t1 = v3.norm(v3.cross(axis, Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
      const t2 = v3.cross(axis, t1);
      addT(sn.id, t1, sn.spring, 0); addT(sn.id, t2, sn.spring, 0);
    }
    // Two per-node mass thresholds:
    //  - local: the node's own stiffest direction, assuming its neighbours hold still.
    //    A node below it is unstable no matter what (exact for symplectic Euler).
    //  - safe: adds the coupling to every neighbour (Gershgorin bound); a node above it
    //    can never be the cause of a blow-up. Used only if the local fix isn't enough.
    const localMass = new Map(), safeMass = new Map();
    const dt2 = PHYSICS_DT * PHYSICS_DT;
    for (const nd of nodes.values()) {
      const t = tensors.get(nd.id);
      if (!t) continue;
      const lk = maxEigenSym(t.K), lc = maxEigenSym(t.C);
      localMass.set(nd.id, 1.25 * (lk * dt2 + 2 * lc * PHYSICS_DT) / 4);
      safeMass.set(nd.id, 1.1 * ((lk + t.ks) * dt2 + 2 * (lc + t.cs) * PHYSICS_DT) / 4);
    }
    const adj = new Map();
    const link = (a, b) => { if (!adj.has(a)) adj.set(a, []); adj.get(a).push(b); };
    for (const b of [...beams, ...shocks, ...steeringHydros]) { link(b.a, b.b); link(b.b, b.a); }

    const originalMass = [...nodes.values()].reduce((s, nd) => s + nd.weight, 0);
    const origWeight = new Map([...nodes.values()].map((nd) => [nd.id, nd.weight]));
    const touched = new Set();
    let movedMass = 0;
    // Raise a node to `need`, borrowing the extra weight from heavier neighbours that
    // can spare it (keeping the car's total weight and balance), adding only the rest.
    const raise = (id, need) => {
      const nd = nodes.get(id);
      if (!(need > nd.weight)) return;
      let missing = need - nd.weight;
      const near = new Set(adj.get(id) || []);
      for (const j of [...near]) for (const j2 of adj.get(j) || []) near.add(j2);
      near.delete(id);
      const donors = [...near]
        .map((j) => nodes.get(j))
        .filter((d) => d && !touched.has(d.id))
        .map((d) => ({ d, spare: d.weight - Math.max(localMass.get(d.id) || 0, safeMass.get(d.id) || 0, origWeight.get(d.id) * 0.6) }))
        .filter((x) => x.spare > 0);
      const totalSpare = donors.reduce((s2, x) => s2 + x.spare, 0);
      const take = Math.min(missing, totalSpare);
      if (take > 0) for (const x of donors) { const dm = take * x.spare / totalSpare; x.d.weight -= dm; }
      movedMass += take;
      nd.weight = need;
      touched.add(id);
    };
    const applyMass = (map, onlyIds) => {
      // heaviest requirement first, so donors aren't drained by small fixes
      const ids = [...map.keys()].filter((id) => (!onlyIds || onlyIds.has(id)) && map.get(id) > nodes.get(id).weight)
        .sort((x, y) => map.get(y) / nodes.get(y).weight - map.get(x) / nodes.get(x).weight);
      for (const id of ids) raise(id, map.get(id));
      return ids.length;
    };

    let selfTest = null;
    const sim = () => { const r0 = simulateDrop(nodes, beams, shocks, steeringHydros, wheels, up, slidenodes); if (opts.debug && opts.debug !== "quiet") console.log("[sim]", r0.stable, r0.firstBlow, "touched", touched.size, "mass", [...nodes.values()].reduce((s2, nd) => s2 + nd.weight, 0).toFixed(0)); return r0; };
    const fixOn = opts.massFix !== false;
    if (opts.selfTest === false) {
      if (fixOn) { applyMass(localMass); applyMass(safeMass); }
    } else {
      // 1) Exact BeamNG masses.
      selfTest = sim();
      // 2) Fix the nodes that are unstable on their own.
      if (!selfTest.stable && fixOn) {
        applyMass(localMass);
        const links = [...beams.map((b) => ({ a: b.a, b: b.b, k: b.spring, c: b.damp })),
          ...shocks.map((x) => ({ a: x.a, b: x.b, k: x.spring, c: x.damp })),
          ...steeringHydros.map((h) => ({ a: h.a, b: h.b, k: h.spring, c: h.damp }))];
        stabilizeModes(nodes, links, raise, 400);
        selfTest = sim();
      }
      // 3) Around wherever it still blows up, apply the guaranteed-stable mass, growing the area.
      let area = new Set();
      for (let round = 0; round < 6 && !selfTest.stable && fixOn; round++) {
        if (selfTest.firstBlow && selfTest.firstBlow.node) area.add(selfTest.firstBlow.node);
        for (const id of selfTest.hotNodes.slice(0, 3)) area.add(id);
        const grown = new Set(area);
        for (const id of area) for (const nb of adj.get(id) || []) grown.add(nb);
        area = grown;
        applyMass(safeMass, area);
        selfTest = sim();
      }
      // 4) Last resort: the guaranteed-stable mass everywhere.
      if (!selfTest.stable && fixOn) { applyMass(safeMass); selfTest = sim(); }
      if (!selfTest.stable) warn('Self-test: the vehicle still looked unstable after the automatic fixes. It may shake or break apart in RoR.');
    }
    const finalMass = [...nodes.values()].reduce((s, nd) => s + nd.weight, 0);
    const addedMass = finalMass - originalMass;
    if (touched.size) {
      warn(`${touched.size} node(s) were too light for their beams at RoR's 2000 Hz physics step. They were made heavier by moving ${movedMass.toFixed(1)} kg from neighbouring nodes` +
        (addedMass > 0.05 ? ` and adding ${addedMass.toFixed(1)} kg (${(100 * addedMass / originalMass).toFixed(1)}% of the body)` : ', so the total weight is unchanged'));
    }

    // -- drive test: full throttle from standstill in 1st gear with RoR's engine/clutch maths --
    let driveTest = null;
    if (engine && selfTest && selfTest.stable && opts.selfTest !== false && wheels.some((w) => w.propulsed)) {
      const G = engine.gears[0] * engine.finalDrive;
      const ref = [...nodes.keys()][0];
      const st = simulateDrop(nodes, beams, shocks, steering, wheels, up, slidenodes, {
        seconds: 3.5, probe: [ref, ref],
        drive: { ratio: G, torque: engine.torque, clutchForce: engine.clutchForce, inertia: engine.inertia, idle: engine.idle, maxRPM: engine.shiftUp },
      });
      const p0 = st.probe[Math.floor(st.probe.length * 0.25)] || st.probe[0], p1 = st.probe[st.probe.length - 1];
      const dist = p0 && p1 ? Math.hypot(p1[3] - p0[3], p1[4] - p0[4]) : 0;
      driveTest = { ok: !st.firstBlow && dist > 2, metres: +dist.toFixed(1), seconds: +((p1[0] - p0[0]) || 0).toFixed(1), exploded: !!st.firstBlow };
      if (!driveTest.ok) warn(driveTest.exploded ? 'Drive test: the driven wheels became unstable under full throttle. Expect shaking when accelerating hard.' : 'Drive test: the car barely moved under full throttle in first gear.');
    }

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
      L.push('; set_beam_defaults before each group = stiffness RoR blends in past the travel limits (bump stops)');
      for (const [g, list] of groupBy(shocks, (s) => `${fmt(s.hardK)}, ${fmt(s.hardD)}, ${fmt(s.deform)}, ${fmt(s.strength)}`)) {
        L.push(`set_beam_defaults ${g}`);
        L.push('shocks');
        for (const s of list) L.push(`${N(s.a)}, ${N(s.b)}, ${fmt(s.spring)}, ${fmt(s.damp)}, ${fmt(s.sb, 4)}, ${fmt(s.lb, 4)}, ${fmt(s.precomp, 4)}, ${opts.visibleBeams ? 'n' : 'i'}`);
      }
      L.push('');
    }

    if (slidenodes.length) {
      L.push('; Nodes that slide along a rail (e.g. spring seats on a strut): node, rail nodes, S=spring, B=break force, T=tolerance');
      L.push('slidenodes');
      for (const sn of slidenodes) L.push(`${N(sn.id)}, ${sn.rail.map(N).join(', ')}, s${fmt(sn.spring)}, b${fmt(sn.strength)}, t${fmt(sn.tolerance, 4)}`);
      L.push('');
    }

    if (steering.length) {
      L.push('; Steering (direction worked out from the steering-arm geometry)');
      for (const [g, list] of groupBy(steering, groupKey)) {
        L.push(`set_beam_defaults ${g}`);
        L.push('hydros');
        for (const h of list) L.push(`${N(h.a)}, ${N(h.b)}, ${fmt(h.factor, 4)}, ${opts.visibleBeams ? 'n' : 'i'}`);
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
      L.push('; Traction control: stops wheelspin from shaking the light tyre nodes apart (toggle in RoR)');
      L.push('TractionControl 2, 0.25, 1, 20, mode: ON');
      L.push('');
      L.push('engoption');
      L.push('; inertia, type, clutch force (both tuned so the engine/clutch/wheel loop is stable at RoR\'s 2000 Hz step)');
      L.push(`${fmt(engine.inertia, 4)}, ${engine.type}, ${engine.clutchForce}`);
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
      for (const t of cabTris) L.push(`${t.ids.map(N).join(', ')}, ${t.collide && opts.cabCollision ? 'c' : 'n'}`);
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
      driveTest: driveTest ? (driveTest.ok ? `passed (${driveTest.metres} m in ${driveTest.seconds} s from standstill, 1st gear)` : 'FAILED') : 'skipped',
      selfTest: selfTest ? (selfTest.stable ? `passed (settled, max beam strain ${(selfTest.maxStrain*100).toFixed(1)}%)` : 'FAILED') : 'skipped',
      engine: engine ? `${Math.round(engine.torque)} Nm, ${engine.gears.length} gears, final drive ${engine.finalDrive.toFixed(2)}` : 'none',
    };
    const fileName = `${fileBase}.truck`;
    return {
      _debug: opts.debug ? { nodes, beams, shocks, steeringHydros, steering, wheels, slidenodes, up } : undefined,
      truck,
      fileBase,
      files: [
        { path: fileName, data: truck },
        { path: `${fileBase}.material`, data: material },
      ],
      report: { warnings, stats, selfTest, driveTest, loadErrors: lib.errors.slice(0, 50) },
    };
  }

  /**
   * Minimal soft-body simulation with the same integrator and time step as RoR
   * (semi-implicit Euler at 2000 Hz). Drops the vehicle onto flat ground for 2.5 s.
   * Wheels are built exactly like RoR's "wheels" section (ActorSpawner::BuildWheel*):
   * two rings of tread nodes with tyre/rim beams, the spokes being RoR shocks that
   * stiffen toward the engine's default beam values when stretched.
   */
  function simulateDrop(nodes, beams, shocks, hydros, wheels, up, slidenodes, extra) {
    extra = extra || {};
    const ids = [...nodes.keys()];
    const ix = new Map(ids.map((id, i) => [id, i]));
    const nChassis = ids.length;
    const n = nChassis + wheels.reduce((s, w) => s + 2 * w.rays, 0);
    const pos = new Float64Array(n * 3), vel = new Float64Array(n * 3), frc = new Float64Array(n * 3), mass = new Float64Array(n);
    const owner = new Array(n).fill(null); // wheel name for generated tread nodes
    // Rotate so that "up" is +Y for the ground test
    const yAxis = v3.norm(up);
    const P = (p) => [p[0], v3.dot(p, yAxis), p[2]];
    for (let i = 0; i < nChassis; i++) {
      const nd = nodes.get(ids[i]);
      const q = P(nd.pos);
      pos[i * 3] = q[0]; pos[i * 3 + 1] = q[1]; pos[i * 3 + 2] = q[2];
      mass[i] = nd.weight;
    }
    const springs = [];
    const addIdx = (i, j, k, c, precomp, deform, shock) => {
      const dx = pos[j * 3] - pos[i * 3], dy = pos[j * 3 + 1] - pos[i * 3 + 1], dz = pos[j * 3 + 2] - pos[i * 3 + 2];
      const L = Math.hypot(dx, dy, dz);
      if (L < 1e-6) return;
      springs.push({ i, j, k, c, L0: L * precomp, Lr: L, deform, shock: shock || null });
    };
    let next = nChassis;
    const wheelRings = [];
    const eng = { log: [] };
    const spoke = { sb: 0.66, lb: 0, hardK: 9000000, hardD: 12000 }; // RoR DEFAULT_SPRING / DEFAULT_DAMP
    for (const w of wheels) {
      const a = ix.get(w.n1), b = ix.get(w.n2);
      const pa = [pos[a * 3], pos[a * 3 + 1], pos[a * 3 + 2]], pb = [pos[b * 3], pos[b * 3 + 1], pos[b * 3 + 2]];
      const axis = v3.norm(v3.sub(pb, pa));
      let ray = v3.scale(v3.norm(v3.cross(axis, Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0])), w.radius);
      const ang = -Math.PI / w.rays, ca = Math.cos(ang), sa = Math.sin(ang);
      const rot = (v) => v3.add(v3.add(v3.scale(v, ca), v3.scale(v3.cross(axis, v), sa)), v3.scale(axis, v3.dot(axis, v) * (1 - ca)));
      const base = next;
      wheelRings.push({ w, a, b, base, count: 2 * w.rays, arm: ix.get(w.arm) });
      for (let r = 0; r < w.rays; r++) {
        for (const [hub, hp] of [[a, pa], [b, pb]]) {
          const q = v3.add(hp, ray);
          ray = rot(ray);
          pos[next * 3] = q[0]; pos[next * 3 + 1] = q[1]; pos[next * 3 + 2] = q[2];
          mass[next] = w.mass / (2 * w.rays);
          owner[next] = w.name;
          next++;
        }
      }
      for (let r = 0; r < w.rays; r++) {
        const o = base + r * 2, inn = o + 1, no = base + ((r + 1) % w.rays) * 2, ni = no + 1;
        addIdx(a, o, w.spring, w.damp, 1, Infinity, spoke);
        addIdx(b, inn, w.spring, w.damp, 1, Infinity, spoke);
        addIdx(b, o, w.spring, w.damp, 1, Infinity);
        addIdx(a, inn, w.spring, w.damp, 1, Infinity);
        addIdx(o, inn, w.spring, w.damp, 1, Infinity);
        addIdx(o, no, w.spring, w.damp, 1, Infinity);
        addIdx(inn, ni, w.spring, w.damp, 1, Infinity);
        addIdx(inn, no, w.spring, w.damp, 1, Infinity);
      }
    }
    const addSpring = (a, b, k, c, precomp, deform, shock) => {
      const i = ix.get(a), j = ix.get(b);
      const dx = pos[j * 3] - pos[i * 3], dy = pos[j * 3 + 1] - pos[i * 3 + 1], dz = pos[j * 3 + 2] - pos[i * 3 + 2];
      const L = Math.hypot(dx, dy, dz);
      if (L < 1e-6) return;
      springs.push({ i, j, k, c, L0: L * precomp, Lr: L, deform, shock: shock || null });
    };
    for (const b of beams) { addSpring(b.a, b.b, b.spring, b.damp, 1, b.deform); if (b.support && springs.length) springs[springs.length - 1].support = true; }
    for (const s of shocks) addSpring(s.a, s.b, s.spring, s.damp, s.precomp, Infinity, s);
    const hydroStart = springs.length;
    for (const h of hydros) addSpring(h.a, h.b, h.spring, h.damp, 1, h.deform);
    const hydroSprings = springs.slice(hydroStart).map((sp, q) => ({ sp, factor: hydros[q] && hydros[q].factor || 0, L: sp.L0 }));
    const slides = (slidenodes || []).map((sn) => ({ i: ix.get(sn.id), rail: sn.rail.map((r) => ix.get(r)), k: sn.spring }));
    // Ground: lowest wheel bottom (or lowest node) sits 2 cm above y=0
    let ground = Infinity;
    for (let i = 0; i < n; i++) ground = Math.min(ground, pos[i * 3 + 1]);
    ground -= 0.02;
    const dt = PHYSICS_DT, g = 9.81;
    const steps = Math.round((extra.seconds || 2.5) / dt);
    const probe = [];
    let fastest = null, maxSpeedLate = 0, maxSpeedMid = 0, blew = false, firstBlow = null;
    const energy = new Float64Array(n);
    for (let s = 0; s < steps; s++) {
      if (extra.steer !== undefined && s * dt > 1) {
        // RoR: steering right (cstate > 0) sets L = L0 * (1 - cstate * factor); ramp over 0.5 s
        const cs = extra.steer * Math.min(1, (s * dt - 1) / 0.5);
        for (const h of hydroSprings) h.sp.L0 = h.L * (1 - cs * h.factor);
      }
      if (extra.probe && s % 200 === 0) {
        const [pa, pb] = extra.probe.map((id) => ix.get(id));
        probe.push([+(s * dt).toFixed(2), Math.atan2(pos[pb * 3 + 2] - pos[pa * 3 + 2], pos[pb * 3] - pos[pa * 3]) * 180 / Math.PI, pos[pa * 3 + 1], pos[pa * 3], pos[pa * 3 + 2], Math.hypot(pos[pb * 3] - pos[pa * 3], pos[pb * 3 + 1] - pos[pa * 3 + 1], pos[pb * 3 + 2] - pos[pa * 3 + 2])]);
      }
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
      // RoR engine + clutch (Engine::UpdateEngine / CalcDifferentials), full throttle in one gear
      let engT = 0;
      if (extra.drive && s * dt > 1) {
        const dv = extra.drive;
        if (eng.rpm === undefined) eng.rpm = dv.idle;
        // wheel spin as RoR measures it: mean tread speed / radius of the driven wheels
        let spin = 0, nw = 0;
        for (const wr of wheelRings) {
          if (!wr.w.propulsed) continue;
          const a3 = wr.a * 3, b3 = wr.b * 3;
          const ax = v3.norm([pos[b3] - pos[a3], pos[b3 + 1] - pos[a3 + 1], pos[b3 + 2] - pos[a3 + 2]]);
          let sp = 0;
          for (let q = 0; q < wr.count; q++) {
            const o = wr.base + q, inner = (q % 2) ? wr.b : wr.a;
            const r = [pos[o * 3] - pos[inner * 3], pos[o * 3 + 1] - pos[inner * 3 + 1], pos[o * 3 + 2] - pos[inner * 3 + 2]];
            const d = v3.scale(v3.cross(ax, r), 1 / (v3.len(r) || 1));
            sp += (vel[o * 3] - vel[inner * 3]) * d[0] + (vel[o * 3 + 1] - vel[inner * 3 + 1]) * d[1] + (vel[o * 3 + 2] - vel[inner * 3 + 2]) * d[2];
          }
          spin += sp / wr.count / wr.w.radius; nw++;
        }
        const wheelRpm = (spin / Math.max(1, nw)) * 60 / (2 * Math.PI);
        const G = dv.ratio;
        const thr = 1.5 * dv.torque * G;
        let clutchT = (eng.rpm / G - wheelRpm) * dv.clutchForce;
        clutchT = Math.max(-thr, Math.min(thr, clutchT));
        const curveT = eng.rpm < dv.maxRPM * 1.25 ? dv.torque : 0;
        eng.rpm += dt * (curveT - clutchT / G) / dv.inertia;
        eng.rpm = Math.max(dv.idle * 0.5, eng.rpm);
        engT = clutchT / Math.max(1, nw);
        eng.maxAbsT = Math.max(eng.maxAbsT || 0, Math.abs(engT));
        if (s % 400 === 0) eng.log.push([+(s * dt).toFixed(1), Math.round(eng.rpm), Math.round(wheelRpm), Math.round(engT)]);
      }
      // drive torque on driven wheels, as RoR's CalcWheels (plus the reaction on the arm node)
      if ((extra.torque || extra.drive) && s * dt > 1) {
        const T = extra.drive ? engT : extra.torque * Math.min(1, (s * dt - 1) / 0.3);
        for (const wr of wheelRings) {
          if (!wr.w.propulsed) continue;
          const a3 = wr.a * 3, b3 = wr.b * 3;
          let ax = [pos[b3] - pos[a3], pos[b3 + 1] - pos[a3 + 1], pos[b3 + 2] - pos[a3 + 2]];
          ax = v3.norm(ax);
          const per = T / wr.count;
          for (let q = 0; q < wr.count; q++) {
            const o = wr.base + q, inner = (q % 2) ? wr.b : wr.a;
            const r = [pos[o * 3] - pos[inner * 3], pos[o * 3 + 1] - pos[inner * 3 + 1], pos[o * 3 + 2] - pos[inner * 3 + 2]];
            const il = 1 / (v3.len(r) || 1);
            const d = v3.scale(v3.cross(ax, r), il);
            frc[o * 3] += d[0] * per * il; frc[o * 3 + 1] += d[1] * per * il; frc[o * 3 + 2] += d[2] * per * il;
          }
          if (wr.arm !== undefined) {
            const da = v3.len(v3.sub([pos[wr.arm * 3], pos[wr.arm * 3 + 1], pos[wr.arm * 3 + 2]], [pos[a3], pos[a3 + 1], pos[a3 + 2]]));
            const db = v3.len(v3.sub([pos[wr.arm * 3], pos[wr.arm * 3 + 1], pos[wr.arm * 3 + 2]], [pos[b3], pos[b3 + 1], pos[b3 + 2]]));
            const near = da < db ? wr.a : wr.b, n3 = near * 3, m3 = wr.arm * 3;
            const rr = [pos[m3] - pos[n3], pos[m3 + 1] - pos[n3 + 1], pos[m3 + 2] - pos[n3 + 2]];
            const radius = v3.sub(rr, v3.scale(ax, v3.dot(rr, ax)));
            const offset = v3.len(v3.sub(rr, radius));
            const rlen = v3.len(radius);
            if (rlen > 0.01 && offset * 2 < rlen) {
              const cf = v3.scale(v3.cross(ax, v3.scale(radius, 1 / rlen)), (0.5 * T / rlen) * (1 - (offset * 2) / rlen));
              frc[m3] -= cf[0]; frc[m3 + 1] -= cf[1]; frc[m3 + 2] -= cf[2];
              frc[n3] += cf[0]; frc[n3 + 1] += cf[1]; frc[n3 + 2] += cf[2];
            }
          }
        }
      }
      // slidenodes: pull the node back onto the nearest point of its rail (sideways only)
      for (const sl of slides) {
        const p3 = sl.i * 3;
        let best = null, bd = Infinity;
        for (let q = 0; q + 1 < sl.rail.length; q++) {
          const a3 = sl.rail[q] * 3, b3 = sl.rail[q + 1] * 3;
          const ex = pos[b3] - pos[a3], ey = pos[b3 + 1] - pos[a3 + 1], ez = pos[b3 + 2] - pos[a3 + 2];
          const e2 = ex * ex + ey * ey + ez * ez || 1e-12;
          let t = ((pos[p3] - pos[a3]) * ex + (pos[p3 + 1] - pos[a3 + 1]) * ey + (pos[p3 + 2] - pos[a3 + 2]) * ez) / e2;
          t = Math.max(0, Math.min(1, t));
          const cx = pos[a3] + t * ex, cy = pos[a3 + 1] + t * ey, cz = pos[a3 + 2] + t * ez;
          const d2 = (pos[p3] - cx) ** 2 + (pos[p3 + 1] - cy) ** 2 + (pos[p3 + 2] - cz) ** 2;
          if (d2 < bd) { bd = d2; best = [cx, cy, cz, a3, b3, t]; }
        }
        if (!best) continue;
        const fx = -sl.k * (pos[p3] - best[0]), fy = -sl.k * (pos[p3 + 1] - best[1]), fz = -sl.k * (pos[p3 + 2] - best[2]);
        frc[p3] += fx; frc[p3 + 1] += fy; frc[p3 + 2] += fz;
        const a3 = best[3], b3 = best[4], t = best[5];
        frc[a3] -= fx * (1 - t); frc[a3 + 1] -= fy * (1 - t); frc[a3 + 2] -= fz * (1 - t);
        frc[b3] -= fx * t; frc[b3 + 1] -= fy * t; frc[b3 + 2] -= fz * t;
      }
      for (const sp of springs) {
        const i3 = sp.i * 3, j3 = sp.j * 3;
        const dx = pos[j3] - pos[i3], dy = pos[j3 + 1] - pos[i3 + 1], dz = pos[j3 + 2] - pos[i3 + 2];
        const L = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-9;
        const ux = dx / L, uy = dy / L, uz = dz / L;
        const vr = (vel[j3] - vel[i3]) * ux + (vel[j3 + 1] - vel[i3 + 1]) * uy + (vel[j3 + 2] - vel[i3 + 2]) * uz;
        let k = sp.k, c = sp.c;
        const diff = L - sp.L0;
        if (sp.support && diff > 0) { k = 0; c *= 0.1; }
        if (sp.shock) {
          // RoR SHOCK1: past a bound, blend toward the hard values by the overshoot in metres
          const lo = sp.shock.sb * sp.L0, hi = sp.shock.lb * sp.L0;
          const x = diff > hi ? diff - hi : (diff < -lo ? -diff - lo : 0);
          if (x > 0) { k += (sp.shock.hardK - k) * x; c += (sp.shock.hardD - c) * x; }
        }
        let f = k * diff + c * vr;
        // plastic deformation like BeamNG/RoR: past the threshold the rest length gives way
        if (!sp.shock && Math.abs(sp.k * diff) > sp.deform) {
          const lim = Math.sign(diff) * sp.deform;
          sp.L0 = L - lim / sp.k;
          f = lim + c * vr;
        }
        frc[i3] += f * ux; frc[i3 + 1] += f * uy; frc[i3 + 2] += f * uz;
        frc[j3] -= f * ux; frc[j3 + 1] -= f * uy; frc[j3 + 2] -= f * uz;
      }
      for (let i = 0; i < n; i++) {
        const i3 = i * 3, im = dt / mass[i];
        vel[i3] += frc[i3] * im; vel[i3 + 1] += frc[i3 + 1] * im; vel[i3 + 2] += frc[i3 + 2] * im;
        pos[i3] += vel[i3] * dt; pos[i3 + 1] += vel[i3 + 1] * dt; pos[i3 + 2] += vel[i3 + 2] * dt;
      }
      if (s % 10 === 0 || s === steps - 1) {
        for (let i = 0; i < n; i++) {
          const sp2 = vel[i * 3] ** 2 + vel[i * 3 + 1] ** 2 + vel[i * 3 + 2] ** 2;
          if (!isFinite(sp2) || sp2 > 60 * 60) { if (!blew) { blew = true; firstBlow = i < nChassis ? { node: ids[i], t: +(s * dt).toFixed(4) } : { node: null, wheel: owner[i], t: +(s * dt).toFixed(4) }; } }
          energy[i] = Math.max(energy[i], isFinite(sp2) ? sp2 : 1e30);
          if (s > steps * 0.7) { const spd = Math.sqrt(sp2) || Infinity; if (spd > maxSpeedLate) { maxSpeedLate = spd; fastest = i < nChassis ? ids[i] : 'wheel ' + owner[i]; } }
          else if (s > steps * 0.4) maxSpeedMid = Math.max(maxSpeedMid, Math.sqrt(sp2) || Infinity);
        }
        if (blew) break;
      }
    }
    // Strain check: a beam stretched/compressed by more than 50% means the structure collapsed
    let maxStrain = 0, collapsed = 0;
    for (const sp of springs) {
      if (sp.shock) continue;
      const i3 = sp.i * 3, j3 = sp.j * 3;
      const L = Math.hypot(pos[j3] - pos[i3], pos[j3 + 1] - pos[i3 + 1], pos[j3 + 2] - pos[i3 + 2]);
      const strain = Math.abs(L - sp.Lr) / sp.Lr;
      if (isFinite(strain)) maxStrain = Math.max(maxStrain, strain); else maxStrain = Infinity;
      if (!(strain < 0.5)) collapsed++;
    }
    // Unstable = blew up, collapsed, or motion still growing late in the test. Parts that
    // are free to swing (doors, hood) or a car still gently settling are not instability.
    const growing = maxSpeedLate > 1.5 && maxSpeedLate > maxSpeedMid * 1.25;
    const stable = !blew && collapsed === 0 && maxSpeedLate < 15 && !growing;
    let watched = null;
    if (extra.watch) {
      const ws = new Set(extra.watch.map((id) => ix.get(id)));
      watched = springs.filter((sp) => (ws.has(sp.i) || ws.has(sp.j)) && sp.i < nChassis && sp.j < nChassis).map((sp) => {
        const L = Math.hypot(pos[sp.j * 3] - pos[sp.i * 3], pos[sp.j * 3 + 1] - pos[sp.i * 3 + 1], pos[sp.j * 3 + 2] - pos[sp.i * 3 + 2]);
        return { a: ids[sp.i], b: ids[sp.j], k: sp.k, dL: L - sp.Lr, L0shift: sp.L0 - sp.Lr * (sp.shock ? sp.shock.precomp : 1), shock: !!sp.shock, force: sp.k * (L - sp.L0) };
      }).sort((x, y) => Math.abs(y.force) - Math.abs(x.force));
    }
    // Nodes with the most kinetic energy are the likely culprits
    const order = [...energy.keys()].sort((a, b) => energy[b] - energy[a]);
    const hotNodes = stable ? [] : order.filter((i) => i < nChassis).slice(0, Math.max(1, Math.ceil(nChassis * 0.03))).map((i) => ids[i]);
    let minY = Infinity;
    for (let i = 0; i < n; i++) minY = Math.min(minY, pos[i * 3 + 1]);
    let contact = null;
    if (extra.probe) {
      contact = wheelRings.map((wr) => {
        let lo = Infinity;
        for (let q = 0; q < wr.count; q++) lo = Math.min(lo, pos[(wr.base + q) * 3 + 1]);
        let chassisLo = Infinity;
        for (const id of [wr.w.n1, wr.w.n2]) chassisLo = Math.min(chassisLo, pos[ix.get(id) * 3 + 1]);
        return { wheel: wr.w.name, treadBottomAboveGround: +(lo - ground).toFixed(3), axleHeight: +(chassisLo - ground).toFixed(3) };
      });
    }
    return { stable, engine: extra.drive ? eng : undefined, contact, fastest, watched, probe, firstBlow, maxSpeedMid: +maxSpeedMid.toFixed(3), maxSpeedLate: +maxSpeedLate.toFixed(3), maxStrain: +maxStrain.toFixed(3), collapsedBeams: collapsed, hotNodes, seconds: 2.5 };
  }

  /**
   * Finds the fastest vibration modes of the whole node/beam network and slows down
   * any that RoR's integrator can't handle. Stability of semi-implicit Euler needs,
   * for every mode, eig(M^-1 (K dt^2 + 2 C dt)) < 4. We take the largest eigenvalue
   * of the symmetric form M^-1/2 B M^-1/2 by power iteration, see which nodes move in
   * that mode, and make just those heavier (via `raise`). Repeat until all modes fit.
   */
  function stabilizeModes(nodes, links, raise, maxRounds) {
    const ids = [...nodes.keys()];
    const ix = new Map(ids.map((id, i) => [id, i]));
    const n = ids.length;
    const dt = PHYSICS_DT;
    const L = [];
    for (const l of links) {
      const i = ix.get(l.a), j = ix.get(l.b);
      if (i === undefined || j === undefined) continue;
      const d = v3.norm(v3.sub(nodes.get(l.b).pos, nodes.get(l.a).pos));
      const w = l.k * dt * dt + 2 * l.c * dt;
      if (w > 0) L.push({ i, j, d, w });
    }
    const target = 4 / 1.1; // 10 % margin; the drop test then confirms
    let v = new Float64Array(n * 3);
    for (let q = 0; q < v.length; q++) v[q] = Math.sin(q * 12.9898) * 0.5 + 0.5;
    let rounds = 0, lambda = 0;
    const sq = new Float64Array(n);
    const y = new Float64Array(n * 3);
    for (; rounds < maxRounds; rounds++) {
      for (let i = 0; i < n; i++) sq[i] = 1 / Math.sqrt(nodes.get(ids[i]).weight);
      for (let it = 0; it < 120; it++) {
        y.fill(0);
        for (const { i, j, d, w } of L) {
          const xi = sq[i], xj = sq[j];
          const rel = (v[i * 3] * xi - v[j * 3] * xj) * d[0] + (v[i * 3 + 1] * xi - v[j * 3 + 1] * xj) * d[1] + (v[i * 3 + 2] * xi - v[j * 3 + 2] * xj) * d[2];
          const f = w * rel;
          y[i * 3] += f * d[0] * xi; y[i * 3 + 1] += f * d[1] * xi; y[i * 3 + 2] += f * d[2] * xi;
          y[j * 3] -= f * d[0] * xj; y[j * 3 + 1] -= f * d[1] * xj; y[j * 3 + 2] -= f * d[2] * xj;
        }
        let norm = 0;
        for (let q = 0; q < y.length; q++) norm += y[q] * y[q];
        norm = Math.sqrt(norm);
        if (!(norm > 0)) return { rounds, lambda: 0 };
        lambda = norm;
        for (let q = 0; q < y.length; q++) v[q] = y[q] / norm;
      }
      if (lambda < target) break;
      let pmax = 0;
      const part = new Float64Array(n);
      for (let i = 0; i < n; i++) { part[i] = v[i * 3] ** 2 + v[i * 3 + 1] ** 2 + v[i * 3 + 2] ** 2; pmax = Math.max(pmax, part[i]); }
      const factor = Math.min(4, (lambda / target) * 1.05);
      for (let i = 0; i < n; i++) {
        if (part[i] < 0.15 * pmax) continue;
        const nd = nodes.get(ids[i]);
        raise(ids[i], nd.weight * (1 + (factor - 1) * Math.min(1, part[i] / (0.5 * pmax))));
      }
    }
    return { rounds, lambda };
  }

  /**
   * Tyre spring/damping for a RoR "wheels" wheel that stays stable while spinning.
   * Each tread node (mass m) has 6 tyre/rim beams and 4 tread neighbours: stability of
   * RoR's integrator needs 11 * (k dt^2 + 2 c dt) / m < 4 (Gershgorin bound). RoR also
   * stiffens the two spokes of a node as it is flung outward by x metres:
   * k += 9e6 x, c += 12000 x (DEFAULT_SPRING / DEFAULT_DAMP, hard-coded in RoR). At tread
   * speed v, x ~= m v^2 / (r * 2k). We pick the k nearest the real tyre's stiffness that
   * keeps every mode stable up to vMax, with as much damping as remains.
   */
  function rorTyre(m, r, kWanted, vMax) {
    vMax = vMax || 60;
    const dt = PHYSICS_DT, budget = (4 / 1.15) * m / 11;
    const cost = (k, c, v) => {
      const x = m * v * v / r / (2 * k);
      return (k + 9e6 * x) * dt * dt + 2 * (c + 12000 * x) * dt;
    };
    let best = null;
    for (let k = 1e5; k <= 2e6; k *= 1.05) {
      // most damping that still fits at vMax (and at rest), capped at 30 % of critical
      const cFit = Math.min((budget - cost(k, 0, vMax)) / (2 * dt), (budget - cost(k, 0, 0)) / (2 * dt));
      const c = Math.min(0.3 * 2 * Math.sqrt(k * m), cFit);
      if (c < 15) continue;
      const score = Math.abs(Math.log(k / kWanted));
      if (!best || score < best.score) best = { score, spring: k, damp: c };
    }
    if (best) return { spring: Math.round(best.spring), damp: +best.damp.toFixed(1) };
    // Very light wheels: fall back to what is stable at rest
    const k = Math.min(kWanted, 0.4 * budget / (dt * dt));
    return { spring: Math.round(k), damp: +Math.max(5, (budget - k * dt * dt) / (2 * dt) * 0.6).toFixed(1) };
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

  const api = { _simulateDrop: simulateDrop, parseJBeam, evalExpression, openZip, makeZip, loadLibrary, listVehicles, convert, buildModZip, filesToEntries, crc32 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.J2R = api;
})(typeof self !== 'undefined' ? self : this);
