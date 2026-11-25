/*
 * jbeam2ror — convert BeamNG.drive vehicle physics (JBeam) to a Rigs of Rods .truck file.
 *
 * Focus: the soft-body physics (nodes, beams, suspension, collision triangles, wheels,
 * steering, engine/gearbox) so the result loads and drives without manual fixing.
 * The 3D model (addVisuals): Collada meshes become OGRE .mesh flexbodies that follow
 * the nodes of their part, BeamNG materials become an OGRE .material, and the colour
 * textures are copied. Without it the body is a flat-shaded "cab" from the collision
 * triangles.
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
  const CONVERTER_VERSION = 'v35';      // shown in the vehicle name so RoR logs say which converter version made it

  // Troubleshooting builds: each changes one suspect so a user can find, in the game,
  // which feature makes a vehicle unstable in RoR.
  const EXPERIMENTS = {
    A: 'Soft limits: suspension/driveshaft limiters keep their normal stiffness past the limit',
    B: 'No slidenodes: strut spring seats and the steering rack are not slide-constrained',
    C: 'Even heavier wheels: 2x the default wheel mass',
    D: 'Traction control on',
    E: 'Fixed steering: steering hydros become plain beams',
    F: 'Stronger clutch: RoR\'s default car clutch strength (5000)',
    G: 'Heavier flywheel: engine inertia 10x (revs change more slowly)',
    H: 'RoR\'s own gearbox defaults (no clutch, flywheel or shift-time tuning)',
    I: 'Traction control on + 30 % more tyre grip',
    J: 'Traction control on + 60 % more tyre grip',
    K: 'Steering link damped 10x more (against front-end wobble)',
    L: 'Rear-wheel drive only (front axle not driven)',
    M: 'Tyre nodes 1.6 kg (now the default)',
    N: 'All of K, L and M together',
    O: 'Even lighter wheels: tyre nodes 1.3 kg',
    P: 'Light wheels like BeamNG: tyre nodes 1.1 kg (less rolling drag, may shake)',
    Q: 'Very light wheels: tyre nodes 0.8 kg (least rolling drag, may shake)',
  };
  // The builds offered in the test pack right now (the wheel tests A-E are settled)
  const PACK = ['O'];

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

  async function deflateRaw(bytes) {
    if (typeof CompressionStream !== 'undefined') {
      const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    return new Uint8Array(require('zlib').deflateRawSync(bytes, { level: 9 }));
  }

  /** Build a compressed (deflate) zip. files: [{path, data}] -> Promise<Uint8Array> */
  async function makeZipCompressed(files) {
    const enc = new TextEncoder();
    const out = [];
    for (const f of files) {
      const raw = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
      out.push({ path: f.path, deflated: await deflateRaw(raw), rawLength: raw.length, crc: crc32(raw) });
    }
    return makeZip(out);
  }

  /** Build an uncompressed (stored) zip. files: [{path, data: string|Uint8Array}] -> Uint8Array */
  function makeZip(files) {
    const enc = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;
    for (const f of files) {
      const name = enc.encode(f.path);
      const raw = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
      const data = f.deflated || raw;
      const method = f.deflated ? 8 : 0;
      const usize = f.deflated ? f.rawLength : raw.length;
      const crc = f.deflated ? f.crc : crc32(raw);
      const lh = new Uint8Array(30 + name.length);
      const lv = new DataView(lh.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true); // UTF-8 names
      lv.setUint16(8, method, true);
      lv.setUint16(10, 0, true); lv.setUint16(12, 0x21, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, usize, true);
      lv.setUint16(26, name.length, true);
      lh.set(name, 30);
      parts.push(lh, data);
      const ch = new Uint8Array(46 + name.length);
      const cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, method, true);
      cv.setUint16(12, 0, true); cv.setUint16(14, 0x21, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, usize, true);
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
    const lib = { parts: new Map(), configs: [], models: new Map(), errors: [], files: new Map(), filesByName: new Map(), materialFiles: [], infos: new Map() };
    for (let s = 0; s < sources.length; s++) {
      const src = sources[s];
      for (const e of src.entries) {
        // index of every file (3D models and textures are read later, on demand)
        const key = e.path.replace(/\\/g, '/').toLowerCase();
        const rel = key.replace(/^.*?(?=(?:^|\/)(?:vehicles|art|levels)\/)/, '').replace(/^\//, '');
        for (const k2 of [key, rel]) if (!lib.files.has(k2)) lib.files.set(k2, e);
        const nm = key.split('/').pop();
        if (!lib.filesByName.has(nm)) lib.filesByName.set(nm, e);
      }
      for (const e of src.entries.filter((x) => /materials\.json$|(?:^|\/)info[^/]*\.json$/i.test(x.path))) {
        try {
          const data = parseJBeam(dec.decode(await e.read()), e.path);
          if (!isDict(data)) continue;
          if (/materials\.json$/i.test(e.path)) lib.materialFiles.push([e.path.replace(/\\/g, '/').toLowerCase().replace(/^.*?(?=vehicles\/)/, ''), data]);
          else lib.infos.set(e.path.replace(/\\/g, '/').toLowerCase().replace(/^.*?(?=vehicles\/)/, ''), data);
        } catch (err) { /* cosmetic file, ignore */ }
      }
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
    const X = opts.experiment && EXPERIMENTS[opts.experiment] ? opts.experiment : null;
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
          const slotDefault = row[iDef >= 0 ? iDef : 1];
          let chosen = Object.prototype.hasOwnProperty.call(pcParts, slotName) ? pcParts[slotName] : slotDefault;
          // An outdated configuration can name a part the mod no longer has (renamed): like
          // BeamNG, fall back to the slot's default part when that one exists.
          if (typeof chosen === 'string' && chosen && !lib.parts.has(chosen) && !/^(tire|wheel)_/i.test(chosen)) {
            // renamed into variants (e.g. x_wide -> x_wide_LHD / x_wide_RHD): take the closest one
            const fits = (n) => { const st = lib.parts.get(n).part.slotType; return st === slotName || (Array.isArray(st) && st.includes(slotName)); };
            const variants = [...lib.parts.keys()].filter((n) => n.startsWith(chosen + '_') && fits(n)).sort((a, b) => (/_LHD$/i.test(b) ? 1 : 0) - (/_LHD$/i.test(a) ? 1 : 0) || a.length - b.length);
            const pick = variants[0] || (typeof slotDefault === 'string' && slotDefault !== chosen && lib.parts.has(slotDefault) ? slotDefault : null);
            if (pick) {
              warn(`The configuration asks for part "${chosen}", which this mod doesn't have (renamed?); used "${pick}" instead.`);
              chosen = pick;
            }
          }
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
        groups: (Array.isArray(props.group) ? props.group : [props.group]).filter((x) => typeof x === 'string' && x),
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
        // Free play given as a fraction of the length (beamShortBound 0.04 = 4 %) is real travel,
        // e.g. a sliding driveshaft; only tiny play given in metres is a hinge/latch.
        const ratioBounds = !isFinite(num(props.shortBoundRange, NaN)) && !isFinite(num(props.longBoundRange, NaN));
        const noPlay = ratioBounds ? Math.max(num(props.beamShortBound, 1), num(props.beamLongBound, 1)) <= 0.01 : Math.max(sbM, lbM) <= 0.012;
        if (isBounded && limitK > 0 && bp.spring < 0.05 * limitK && noPlay) {
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
          hardK: X === 'A' ? bp.spring : Math.min(5e8, hard(bp.spring, limitK)), hardD: X === 'A' ? damp : Math.min(5e5, hard(damp, limitD)),
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
          hardK: X === 'A' ? 0 : Math.min(5e8, bp.spring / Math.max(0.01, stopM)), hardD: X === 'A' ? 0 : Math.min(5e5, bp.damp / Math.max(0.01, stopM)),
          deform: bp.deform, strength: bp.strength, stop: true,
        });
        continue;
      }
      if (bp.spring === 0 && bp.damp === 0) continue; // no physical effect
      const key = [a, b].map(String).sort().join('|');
      if (beamKeys.has(key)) continue; // identical node pair already present
      beamKeys.add(key);
      // BeamNG breaks a beam once it has stretched to deformLimitExpansion x its length (and
      // "unbreakable" body beams rely on that). RoR has no such limit, but it takes strength
      // away as a beam stretches (by stretch x stiffness), so a strength of deform + that
      // amount breaks it at the same point instead of letting it stretch like toffee.
      if (type !== 'SUPPORT' && bp.deform < BIG && bp.spring > 0) {
        const given = num(props.deformLimitExpansion, NaN);
        const limit = isFinite(given) && given > 1 ? given : (bp.strength >= 1e8 ? 1.5 : NaN);
        if (isFinite(limit)) bp.strength = Math.min(bp.strength, bp.deform + bp.spring * (limit - 1) * L);
      }
      beams.push({ a: String(a), b: String(b), ...bp, support: type === 'SUPPORT' });
    }
    if (skippedBeams) warn(`${skippedBeams} beam(s) referenced nodes that don't exist in this configuration and were skipped`);

    // -- hydros: steering ones become RoR hydros, others rigid beams ---------
    for (const { cols, props } of rowsOf('hydros')) {
      const a = cols.id1, b = cols.id2;
      if (!hasNode(a) || !hasNode(b) || String(a) === String(b)) continue;
      const src = String(props.inputSource || 'steering');
      const bp = beamProps(props);
      if (/steer/i.test(src) && X !== 'E') {
        let f = NaN;
        if (props.factor !== undefined) f = num(props.factor, NaN);
        const inF = num(props.inputFactor, 1);
        if (!isFinite(f) && (props.inLimit !== undefined || props.outLimit !== undefined)) {
          const ext = num(props.outLimit, 2) - 1, ret = 1 - num(props.inLimit, 0);
          f = inF * (ext + ret) / 2;
        }
        if (!isFinite(f)) f = 0.1 * Math.sign(inF || 1);
        steeringHydros.push({ a: String(a), b: String(b), bngFactor: f, explicitFactor: props.factor !== undefined, wheelLock: num(props.steeringWheelLock, 0), ...bp });
      } else {
        beams.push({ a: String(a), b: String(b), ...bp, support: false });
      }
    }

    // -- torsion hydros (BeamNG twists node id1 around the axis id2-id3, angle measured
    // against id4). RoR has none: a steering one becomes a normal steering hydro from id1 to
    // id4 whose length change gives the same twist.
    for (const { cols, props } of rowsOf('torsionHydros')) {
      const ids = [cols.id1, cols.id2, cols.id3, cols.id4].map(String);
      if (!ids.every(hasNode)) continue;
      const src = String(props.inputSource || 'steering');
      if (!/steer/i.test(src)) { warn(`A torsion hydro driven by "${src}" (e.g. a gear lever) has no RoR equivalent and was left out`); continue; }
      const [p1, a1, a2] = ids.slice(0, 3).map((id) => nodes.get(id).pos);
      const axis = v3.norm(v3.sub(a2, a1));
      // BeamNG's angle reference node often sits straight out along the arm, where a length
      // change can't tell left from right. Use a node that holds the steering box (same groups
      // as the axis nodes) and sits sideways to the arm's swing instead.
      const tang = v3.norm(v3.cross(axis, v3.sub(p1, a1)));
      const boxGroups = new Set([...nodes.get(ids[1]).groups, ...nodes.get(ids[2]).groups].filter((gname) => !/pitman|draglink|tierod/i.test(gname)));
      let refId = ids[3], bestScore = Math.abs(v3.dot(v3.norm(v3.sub(nodes.get(ids[3]).pos, p1)), tang));
      for (const nd of nodes.values()) {
        if (ids.includes(nd.id) || !nd.groups.some((gname) => boxGroups.has(gname) || /frame|chassis|body/i.test(gname))) continue;
        const d = v3.len(v3.sub(nd.pos, p1));
        if (d < 0.12 || d > 0.9) continue;
        const sc = Math.abs(v3.dot(v3.norm(v3.sub(nd.pos, p1)), tang)) - d * 0.05;
        if (sc > bestScore + 0.05) { bestScore = sc; refId = nd.id; }
      }
      ids[3] = refId;
      const ref = nodes.get(refId).pos;
      const rot = (p, th) => { const v = v3.sub(p, a1), c = Math.cos(th), sn = Math.sin(th); return v3.add(a1, v3.add(v3.add(v3.scale(v, c), v3.scale(v3.cross(axis, v), sn)), v3.scale(axis, v3.dot(axis, v) * (1 - c)))); };
      const f = num(props.factor, 0.5) * num(props.inputFactor, 1);
      const L0 = v3.len(v3.sub(ref, p1));
      const Lr = v3.len(v3.sub(ref, rot(p1, -f))); // BeamNG: angle = factor * input (radians); full right lock = -factor (checked in the drop-test sim: wheels turn right)
      const r = v3.len(v3.cross(v3.sub(p1, a1), axis));
      if (L0 < 0.02 || r < 0.01 || Math.abs(Lr - L0) < 1e-4) { warn('A steering torsion hydro could not be converted (its reference node is in line with the arm)'); continue; }
      const kT = num(props.spring, 350000);
      steeringHydros.push({ a: ids[0], b: ids[3], torsion: true, rorFactor: (L0 - Lr) / L0, wheelLock: num(props.steeringWheelLock, 0),
        spring: Math.min(9e6, Math.max(3e5, kT / (r * r))), damp: Math.max(200, num(props.damp, 10) / (r * r)), deform: BIG, strength: BIG });
      warn(`Steering uses a BeamNG torsion hydro (twisting the steering box); converted to a steering hydro ${ids[0]}-${ids[3]}`);
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
    for (const { cols, props } of (X === 'B' ? [] : rowsOf('slidenodes'))) {
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
    // Drive modes (e.g. a 4x4 transfer case that starts in 2hi): devices the default mode
    // disconnects don't pass power, like BeamNG at spawn.
    const disconnected = new Set();
    for (const { entry } of order) for (const sec of Object.values(entry.part)) {
      if (!isDict(sec) || typeof sec.defaultMode !== 'string' || !isDict(sec.modes) || !isDict(sec.modes[sec.defaultMode])) continue;
      const m = sec.modes[sec.defaultMode];
      for (const t of Object.values(m)) if (Array.isArray(t)) for (const row of t) {
        if (Array.isArray(row) && row[0] === 'powertrainDeviceMode' && isDict(row[1]) && /disconnect/i.test(String(row[1].mode)) && row[1].deviceName) disconnected.add(String(row[1].deviceName));
      }
    }
    if (disconnected.size) warn(`Drive mode at start: ${[...disconnected].join(', ')} disconnected (as BeamNG's default mode, e.g. 2WD on a 4x4)`);
    const reachesEngine = (name) => {
      let dn = name, guard = 0;
      while (dn && devices.has(dn) && guard++ < 40) {
        if (disconnected.has(dn)) return false;
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
    let addedWheelMass = 0;
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
      let mass = 2 * bngRays * (tireW + hubW) * (X === 'C' ? 2 : 1); // BeamNG's wheel mass (hub + tyre nodes)
      mass = Math.min(200, Math.max(4, mass));
      // Tested in RoR 2026.01: tyre nodes under ~2 kg shake apart in the game (the game's
      // tyre contact is harsher than any model we could check against), while 2.2 kg holds.
      // Make the wheel at least that heavy; the extra is taken off the body below so the
      // car keeps BeamNG's total weight.
      // 1.6 kg: tested in RoR on the Mistral and ETK - lighter (1.1, 0.8) exploded, heavier
      // (2.2) adds so much rolling drag that cars stall around 90 km/h
      const treadKg = X === 'Q' ? 0.8 : X === 'P' ? 1.1 : X === 'O' ? 1.3 : X === 'C' ? 4.4 : 1.6;
      const minTread = treadKg * 2 * rays;
      if (X === 'P' || X === 'Q') mass = minTread; // exactly this light, even if BeamNG's wheel is heavier
      if (mass < minTread) { addedWheelMass += minTread - mass; mass = minTread; }
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
        groups: [w.cols.group, w.cols.hubGroup, p.group].flatMap((g) => (Array.isArray(g) ? g : [g])).filter((g) => typeof g === 'string' && g),
        rimRadius: num(p.hubRadius, 0), tireWidth: num(p.tireWidth, 0),
      });
    }
    if (addedWheelMass > 0) {
      // Keep the vehicle's total weight: take the wheels' extra mass off the body nodes
      // (the stability pass below re-checks every node afterwards).
      const body = [...nodes.values()].reduce((s2, nd) => s2 + nd.weight, 0);
      const f = body > addedWheelMass * 4 ? (body - addedWheelMass) / body : 1;
      if (f < 1) for (const nd of nodes.values()) nd.weight *= f;
      warn(`Wheels made heavier for RoR (+${addedWheelMass.toFixed(0)} kg in total, ${f < 1 ? 'taken off the body so the total weight is unchanged' : 'added to the total'}): light tyres shake apart in RoR.`);
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
      if (h.torsion) factor = Math.max(-0.5, Math.min(0.5, h.rorFactor));
      else if (best && bd < 0.8 && L0 > 0.02) {
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
      // RoR uses the shift-down rpm both for downshifts and as the rpm above which its
      // automatic clutch bites; too high and the car revs for seconds before moving off.
      const shiftDown = Math.max(idle + 500, shiftUp * 0.3);
      // RoR's clutch is a spring between engine and wheel speed: torque = clutchForce * (rpm
      // difference). On slipping light car wheels RoR's defaults (5000-10000) overshoot every
      // physics step, so the torque slams between +max and -max and the wheels shake apart.
      // Stable when clutchForce * dt * 9.55 / I_wheels < ~1, with I_wheels = sum m r^2 of the
      // driven wheels; we use half that. RoR's engine inertia is in rpm units
      // (rpm += dt * torque / inertia), i.e. BeamNG's kg m^2 divided by 9.55, kept large
      // enough that the engine side of the clutch loop is stable in top gear too.
      const drivenW = wheels.filter((w) => w.propulsed);
      const Iw = drivenW.reduce((s2, w) => s2 + w.mass * w.radius * w.radius, 0) || 2;
      const clutchForce = X === 'F' ? 5000 : Math.round(Math.max(80, Math.min(5000, 0.5 * Iw / (PHYSICS_DT * 9.5493))));
      const Gtop = Math.min(...fwdGears) * finalDrive;
      const inertia = Math.max(num(ed.inertia, 0.15) / 9.5493, 0.6 * clutchForce * PHYSICS_DT / (Gtop * Gtop * 0.5), 0.02) * (X === 'G' ? 10 : 1);
      engine = {
        clutchForce, inertia: +inertia.toFixed(4),
        shiftDown, shiftUp, torque: maxT, finalDrive, reverse, gears: fwdGears, idle,
        type: isElectric ? 'e' : (maxT > 900 ? 't' : 'c'),
        curve: curve.filter((c) => c[0] >= 0).map((c) => [c[0], Math.max(0, c[1] / maxT)]),
      };
    }

    // Brakes
    // RoR applies one brake torque to every braked wheel; use the average of BeamNG's per-wheel
    // values so the total braking matches (the maximum made front-biased cars brake too hard).
    const brakedW = wheels.filter((w) => w.braked && w.brakeTorque > 0);
    const maxBrake = brakedW.length ? brakedW.reduce((s2, w) => s2 + w.brakeTorque, 0) / brakedW.length : 0;
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

    const stabLinks = () => [...beams.map((b) => ({ a: b.a, b: b.b, k: b.spring, c: b.damp })),
      ...shocks.map((x) => ({ a: x.a, b: x.b, k: x.spring, c: x.damp })),
      ...steeringHydros.map((h) => ({ a: h.a, b: h.b, k: h.spring, c: h.damp }))];
    let selfTest = null;
    const sim = () => { const r0 = simulateDrop(nodes, beams, shocks, steeringHydros, wheels, up, slidenodes); if (opts.debug && opts.debug !== "quiet") console.log("[sim]", r0.stable, r0.firstBlow, "touched", touched.size, "mass", [...nodes.values()].reduce((s2, nd) => s2 + nd.weight, 0).toFixed(0)); return r0; };
    const fixOn = opts.massFix !== false;
    if (opts.selfTest === false) {
      if (fixOn) { applyMass(localMass); stabilizeModes(nodes, stabLinks(), raise, 400, 1.25); }
    } else {
      // 1) Make every vibration mode comfortably stable for RoR's integrator, always: a
      //    marginal mode may survive a short, perfectly still test but grows in the game.
      if (fixOn) {
        applyMass(localMass);
        stabilizeModes(nodes, stabLinks(), raise, 400, 1.25);
      }
      selfTest = sim();
      // 2) Fix the nodes that are unstable on their own.
      if (!selfTest.stable && fixOn) {
        stabilizeModes(nodes, stabLinks(), raise, 400, 1.5);
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

    if (X === 'K' || X === 'N') for (const h of steering) h.damp *= 10;
    if (X === 'L' || X === 'N') for (const w of wheels) if (v3.dot(v3.sub(w.center, center), fwd) > 0 && wheels.some((o) => o.propulsed && v3.dot(v3.sub(o.center, center), fwd) < 0)) w.propulsed = 0;

    // -- write the .truck ----------------------------------------------------
    // Exhaust: RoR plays the engine sound at the node marked 'x' (otherwise at node 0).
    // RoR re-reads that mark for every node, so only the LAST node can carry it: add a small
    // node just behind the tailpipe (rearmost node of BeamNG's exhaust parts), tied to it.
    let exhaustDir = null;
    {
      const ex = [...nodes.values()].filter((nd) => nd.groups.some((gname) => /exhaust|muffler|tailpipe/i.test(gname)));
      if (!opts.noExhaust && ex.length >= 2 && !nodes.has('j2r_exhaust')) {
        const back = (nd) => -v3.dot(nd.pos, fwd);
        const tip = ex.reduce((a, b) => (back(b) > back(a) ? b : a));
        const prev = ex.filter((nd) => nd !== tip).reduce((a, b) => (v3.len(v3.sub(b.pos, tip.pos)) < v3.len(v3.sub(a.pos, tip.pos)) ? b : a));
        const dir = v3.norm(v3.sub(tip.pos, prev.pos));
        const third = nearestNode(tip.pos, new Set([tip.id, prev.id]));
        if (third && v3.len(v3.sub(tip.pos, prev.pos)) > 0.02) {
          nodes.set('j2r_exhaust', { id: 'j2r_exhaust', pos: v3.add(tip.pos, v3.scale(dir, 0.05)), weight: 1, collision: false, friction: 1, groups: [] });
          for (const other of [tip.id, prev.id, third]) beams.push({ a: 'j2r_exhaust', b: other, spring: 200000, damp: 40, deform: BIG, strength: BIG, support: false });
          exhaustDir = prev.id;
        }
      }
    }
    const idx = new Map();
    let k = 0;
    for (const id of nodes.keys()) idx.set(id, k++);
    const N = (id) => (id === '9999' ? '9999' : String(idx.get(String(id))));

    const title = (opts.title || `${veh.title || veh.model}${pc ? ' (' + pc.name + ')' : ''}`).replace(/[\r\n;]/g, ' ').trim() || 'Converted vehicle';
    const titleTagged = `${title} [j2r ${CONVERTER_VERSION}${X ? ' test ' + X : ''}${opts.tag ? ' ' + opts.tag : ''}]`;
    const fileBase = (veh.model + (pc ? '_' + pc.name : '') + (X ? '_test' + X : '') + (opts.tag ? '_' + opts.tag : '')).replace(/[^A-Za-z0-9_\-]+/g, '_');
    const matName = `jbeam2ror/${fileBase}/body`;
    const SAFE_DEFAULTS = 'set_beam_defaults 9000000, 12000, 1000000000, 1000000000';
    const L = [];
    L.push(titleTagged);
    if (X) L.push(`; TROUBLESHOOTING BUILD ${X}: ${EXPERIMENTS[X]}`);
    L.push('');
    L.push(`; Converted from BeamNG.drive JBeam by jbeam2ror`);
    L.push(`; Source vehicle: ${veh.model}${pc ? ', configuration ' + pc.name : ''}`);
    L.push('; The plain body panels (cab) come from the collision triangles; the 3D model, if added, is in the flexbodies section.');
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
      const opt = 'l' + (nd.collision ? '' : 'c') + (nd.id === 'j2r_exhaust' ? 'x' : '');
      L.push(`${N(nd.id)}, ${fmt(nd.pos[0])}, ${fmt(nd.pos[1])}, ${fmt(nd.pos[2])}, ${opt}, ${fmt(nd.weight, 4)} ;${nd.id}`);
    }
    L.push('');
    L.push('cameras');
    L.push(`${N(ref.ref)}, ${N(ref.back)}, ${N(ref.left)}`);
    L.push('');

    // Air drag. Without a fusedrag section RoR adds turbulent drag to EVERY node
    // (0.05 * v^2 each). A BeamNG car has ~500 nodes (plus wheel nodes), which adds up to
    // ~7000 N at 60 km/h: an invisible wall. fusedrag replaces that with one whole-body
    // drag force, 0.25 * rho * width^2 * v^2 in RoR, so width = sqrt(2 * Cd * A).
    {
      const along = (p) => v3.dot(p, fwd), side = (p) => v3.dot(p, left), height = (p) => v3.dot(p, up);
      const all = [...nodes.values()];
      const front = all.reduce((a, b) => (along(b.pos) > along(a.pos) ? b : a));
      const rear = all.reduce((a, b) => (along(b.pos) < along(a.pos) ? b : a));
      const W = Math.max(...all.map((nd) => side(nd.pos))) - Math.min(...all.map((nd) => side(nd.pos)));
      const H = Math.max(...all.map((nd) => height(nd.pos))) - Math.min(...all.map((nd) => height(nd.pos)));
      const cdA = Math.max(0.3, Math.min(3, 0.35 * 0.85 * W * H)); // typical car Cd ~0.35, frontal area ~85 % of the box
      L.push(`; Whole-body air drag (Cd*A ~ ${cdA.toFixed(2)} m^2) instead of RoR's per-node drag`);
      L.push('fusedrag');
      L.push(`${N(front.id)}, ${N(rear.id)}, ${fmt(Math.sqrt(2 * cdA), 3)}`);
      L.push('');
    }

    if (exhaustDir) {
      L.push('; exhaust smoke (the sound plays at the node marked x)');
      L.push('exhausts');
      L.push(`${N('j2r_exhaust')}, ${N(exhaustDir)}, 1, default`);
      L.push('');
    }

    // Cinecam (driver view) from BeamNG's internal camera, if present
    let numCinecams = 0; // every cinecam adds a node before RoR builds the wheel nodes
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
        numCinecams++;
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
    // The trailing "-1, tracks/beam, 0" (default diameter and material, plastic coefficient 0)
    // matters: without a plastic coefficient RoR silently raises every deform threshold
    // below 100 kN to 100 kN ("beam creak"), which makes BeamNG's soft panels (3-20 kN) solid.
    L.push('; each set_beam_defaults: spring, damping, deform, break, diameter, material, plastic coef');
    for (const [g, list] of groups) {
      L.push(`set_beam_defaults ${g}, -1, tracks/beam, 0`);
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
      if (X === 'I' || X === 'J') L.push(`set_node_defaults -1, ${X === 'I' ? 1.3 : 1.6}, -1, -1`); // tyre grip (node friction) for the test builds
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
      if (X === 'D' || X === 'I' || X === 'J') {
        L.push('; Traction control (test build)');
        L.push('TractionControl 2, 0.25, 1, 20, mode: ON');
        L.push('');
      }
      L.push('engoption');
      L.push('; inertia, type, clutch force (tuned so the engine/clutch/wheel loop is stable at RoR\'s 2000 Hz step), shift time, clutch time, post-shift time');
      // shift time 0.3 s, clutch time 0.15 s, post-shift 0.1 s (RoR defaults 0.5/0.2/0.2 lose too much speed in a small car)
      L.push(X === 'H' ? `1, ${engine.type}` : `${fmt(engine.inertia, 4)}, ${engine.type}, ${engine.clutchForce}, 0.3, 0.15, 0.1`);
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

    // -- 3D model plan (meshes are added by addVisuals, which reads the .dae files) --
    const flexbodies = [];
    const groupNodes = new Map();
    for (const nd of nodes.values()) for (const gname of nd.groups) { if (!groupNodes.has(gname)) groupNodes.set(gname, []); groupNodes.get(gname).push(idx.get(nd.id)); }
    const vec = (o, d) => (isDict(o) ? [num(o.x, d), num(o.y, d), num(o.z, d)] : null);
    for (const { cols, props, part } of rowsOf('flexbodies')) {
      if (typeof cols.mesh !== 'string' || !cols.mesh) continue;
      const g = cols['[group]'] !== undefined ? cols['[group]'] : cols.group;
      const groups = (Array.isArray(g) ? g : [g]).filter((x) => typeof x === 'string' && x);
      const set = new Set();
      for (const gname of groups) for (const n of groupNodes.get(gname) || []) set.add(n);
      const off = isDict(props.nodeOffset) ? vec(props.nodeOffset, 0) : null;
      flexbodies.push({ mesh: cols.mesh, groups, nodes: [...set], part, pos: vec(props.pos, 0), rot: vec(props.rot, 0), scale: vec(props.scale, 1), nodeOffset: off && off.some((x) => x) ? off : null });
    }
    // Paint: from the .pc, else the configuration's default paint in info_<config>.json
    let paint = null;
    const pcPaint = Array.isArray(pcData.paints) && isDict(pcData.paints[0]) ? pcData.paints[0] : null;
    if (pcPaint && Array.isArray(pcPaint.baseColor)) paint = pcPaint.baseColor.slice(0, 3).map(Number);
    if (!paint && lib.infos) {
      const m0 = veh.model.toLowerCase();
      const infoCfg = pc ? lib.infos.get(`vehicles/${m0}/info_${pc.name.toLowerCase()}.json`) : null;
      const infoMain = lib.infos.get(`vehicles/${m0}/info.json`);
      const pname = (infoCfg && (infoCfg.defaultPaintName1 || infoCfg.defaultPaint)) || (infoMain && infoMain.defaultPaintName1);
      const pd = infoMain && isDict(infoMain.paints) && typeof pname === 'string' ? infoMain.paints[pname] : null;
      if (pd && Array.isArray(pd.baseColor)) paint = pd.baseColor.slice(0, 3).map(Number);
    }
    const planNodes = [];
    for (const nd of nodes.values()) planNodes[idx.get(nd.id)] = { pos: nd.pos, groups: nd.groups, id: nd.id };
    // Light materials: BeamNG swaps them at runtime (glowMap); RoR shows the "off" look
    const materialAlias = {};
    for (const { entry } of order) if (isDict(entry.part.glowMap)) for (const [k2, v2] of Object.entries(entry.part.glowMap)) if (isDict(v2) && typeof v2.off === 'string' && !(k2 in materialAlias)) materialAlias[k2] = v2.off;
    // RoR builds each wheel's tread nodes itself, numbered after the declared nodes and the
    // cinecam nodes (ActorSpawnerFlow: nodes, cinecam, wheels), two per ray, outer ring
    // (at node1) and inner ring (at node2) alternating. Same maths as BuildWheelObjectAndNodes,
    // so wheel meshes can be attached to them and spin with the wheel.
    const bodyNodes = planNodes.map((_, i) => i);
    const planWheels = [];
    {
      let next = nodes.size + numCinecams;
      for (const w of wheels) {
        const p1 = nodes.get(w.n1).pos, p2 = nodes.get(w.n2).pos;
        const axis = v3.norm(v3.sub(p2, p1));
        let perp = v3.cross(axis, [1, 0, 0]);
        if (v3.dot(perp, perp) < 1e-12) perp = v3.cross(axis, [0, 1, 0]);
        let ray = v3.scale(v3.norm(perp), w.radius);
        const th = -2 * Math.PI / (2 * w.rays), c = Math.cos(th), sn = Math.sin(th);
        const rot = (v) => v3.add(v3.add(v3.scale(v, c), v3.scale(v3.cross(axis, v), sn)), v3.scale(axis, v3.dot(axis, v) * (1 - c)));
        const tread = [];
        for (let i = 0; i < w.rays; i++) {
          planNodes[next] = { pos: v3.add(p1, ray), groups: [], generated: true }; tread.push(next++); ray = rot(ray);
          planNodes[next] = { pos: v3.add(p2, ray), groups: [], generated: true }; tread.push(next++); ray = rot(ray);
        }
        planWheels.push({ name: w.name, groups: w.groups, n1: idx.get(w.n1), n2: idx.get(w.n2), arm: idx.get(w.arm), tread, radius: w.radius, rimRadius: w.rimRadius, tireWidth: w.tireWidth, center: w.center, axis });
      }
    }
    // Props (steering wheel, needles, pedals...): rows hold objects (rotations), so read them directly
    const propRows = [];
    for (const { entry } of order) {
      const t = entry.part.props;
      if (!Array.isArray(t) || !isHeaderRow(t[0])) continue;
      const h = t[0].map((x) => String(x).replace(/:$/, ''));
      let state = {};
      for (const raw of t.slice(1)) {
        if (isDict(raw)) { state = Object.assign({}, state, evalValue(raw)); continue; }
        if (!Array.isArray(raw)) continue;
        const row = evalValue(raw);
        const c = {};
        h.forEach((k2, i2) => { if (i2 < row.length) c[k2] = row[i2]; });
        const extra = row.length > h.length && isDict(row[row.length - 1]) ? row[row.length - 1] : {};
        const o = Object.assign({}, state, extra);
        if (typeof c.mesh !== 'string' || !c.mesh || /LIGHT$/i.test(c.mesh) || o.lightRange !== undefined) continue;
        const nid = (x) => (hasNode(x) ? idx.get(String(x)) : null);
        propRows.push({
          func: String(c.func || ''), mesh: c.mesh, ref: nid(c.idRef), nx: nid(c.idX), ny: nid(c.idY),
          rotation: vec(c.rotation, 0) || [0, 0, 0], translation: vec(c.translation, 0) || [0, 0, 0],
          min: num(c.min, -Infinity), max: num(c.max, Infinity), offset: num(c.offset, 0), multiplier: num(c.multiplier, 1), part: entry.name,
        });
      }
    }
    // Lights: every glowMap material and the light functions that switch it on
    const glow = {};
    for (const { entry } of order) if (isDict(entry.part.glowMap)) for (const [k2, v2] of Object.entries(entry.part.glowMap)) {
      if (!isDict(v2) || k2 in glow) continue;
      const sf = v2.simpleFunction;
      glow[k2] = { off: v2.off, on: v2.on, funcs: typeof sf === 'string' ? [sf] : isDict(sf) ? Object.keys(sf) : [] };
    }
    const steeringLock = Math.max(0, ...steering.map((h) => h.wheelLock || 0)) || 450;
    const visualPlan = { model: veh.model, flexbodies, paint, materialAlias, props: propRows, glow, steeringLock, shiftUpRPM: engine ? engine.shiftUp : 6000, fwd, up, nodes: planNodes, bodyNodes, wheels: planWheels, num: String };
    return {
      _engine: opts.debug ? engine : undefined,
      _debug: opts.debug ? { nodes, beams, shocks, steeringHydros, steering, wheels, slidenodes, up } : undefined,
      truck,
      fileBase,
      files: [
        { path: fileName, data: truck },
        { path: `${fileBase}.material`, data: material },
      ],
      report: { warnings, stats, selfTest, driveTest, loadErrors: lib.errors.slice(0, 50) },
      visualPlan,
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
    let seed = 12345; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5);
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
    const brokenLog = [];
    let deformEvents = 0, lateDeform = 0;
    for (const b of beams) { const n0 = springs.length; addSpring(b.a, b.b, b.spring, b.damp, 1, b.deform); if (springs.length > n0) { const sp = springs[springs.length - 1]; sp.support = !!b.support; sp.strength = b.strength; sp.name = b.a + '-' + b.b; } }
    for (const s of shocks) addSpring(s.a, s.b, s.spring, s.damp, s.precomp, Infinity, s);
    const hydroStart = springs.length;
    for (const h of hydros) addSpring(h.a, h.b, h.spring, h.damp, 1, h.deform);
    const hydroSprings = springs.slice(hydroStart).map((sp, q) => ({ sp, factor: hydros[q] && hydros[q].factor || 0, L: sp.L0 }));
    const slides = (slidenodes || []).map((sn) => ({ i: ix.get(sn.id), rail: sn.rail.map((r) => ix.get(r)), k: sn.spring }));
    // Ground: lowest wheel bottom (or lowest node) sits 2 cm above y=0
    let ground = Infinity;
    for (let i = 0; i < n; i++) ground = Math.min(ground, pos[i * 3 + 1]);
    ground -= 0.02 + (extra.dropHeight || 0);
    const dt = PHYSICS_DT, g = 9.81;
    const steps = Math.round((extra.seconds || 4) / dt);
    const probe = [];
    let fastest = null, maxSpeedLate = 0, maxSpeedMid = 0, blew = false, firstBlow = null;
    const energy = new Float64Array(n);
    // jiggle every node by up to 1 cm/s, like the rounding noise in RoR, so unstable modes show up
    for (let q = 0; q < n * 3; q++) vel[q] = rnd() * 0.02;
    if (extra.initSpeed && extra.fwd) {
      // start rolling: body at speed, each wheel spinning so its contact point is at rest
      const fw = v3.norm(extra.fwd), spin = v3.cross(up, fw);
      for (let i = 0; i < n; i++) { vel[i * 3] += fw[0] * extra.initSpeed; vel[i * 3 + 1] += fw[1] * extra.initSpeed; vel[i * 3 + 2] += fw[2] * extra.initSpeed; }
      for (const wr of wheelRings) {
        const c = [0, 1, 2].map((q) => (pos[wr.a * 3 + q] + pos[wr.b * 3 + q]) / 2), om = v3.scale(spin, extra.initSpeed / wr.w.radius);
        for (let k2 = 0; k2 < wr.count; k2++) { const i = wr.base + k2; const r = [pos[i * 3] - c[0], pos[i * 3 + 1] - c[1], pos[i * 3 + 2] - c[2]]; const add = v3.cross(om, r); vel[i * 3] += add[0]; vel[i * 3 + 1] += add[1]; vel[i * 3 + 2] += add[2]; }
      }
    }
    for (let s = 0; s < steps; s++) {
      if (extra.steer !== undefined && s * dt > 1) {
        // RoR: steering right (cstate > 0) sets L = L0 * (1 - cstate * factor); ramp over 0.5 s
        const cs = extra.steer * Math.min(1, (s * dt - 1) / 0.5);
        for (const h of hydroSprings) h.sp.L0 = h.L * (1 - cs * h.factor);
      }
      if (extra.probe && s % (extra.probeEvery || 200) === 0) {
        const [pa, pb] = extra.probe.map((id) => ix.get(id));
        probe.push([+(s * dt).toFixed(2), Math.atan2(pos[pb * 3 + 2] - pos[pa * 3 + 2], pos[pb * 3] - pos[pa * 3]) * 180 / Math.PI, pos[pa * 3 + 1], pos[pa * 3], pos[pa * 3 + 2], Math.hypot(pos[pb * 3] - pos[pa * 3], pos[pb * 3 + 1] - pos[pa * 3 + 1], pos[pb * 3 + 2] - pos[pa * 3 + 2])]);
      }
      frc.fill(0);
      for (let i = 0; i < n; i++) {
        frc[i * 3 + 1] -= mass[i] * g;
        const pen = ground - pos[i * 3 + 1];
        if (pen > 0 && !extra.rorGround) {
          const kg = 0.2 * mass[i] / (dt * dt), cg = 0.2 * mass[i] / dt;
          frc[i * 3 + 1] += kg * pen - cg * Math.min(0, vel[i * 3 + 1]);
          frc[i * 3] -= cg * 0.5 * vel[i * 3]; frc[i * 3 + 2] -= cg * 0.5 * vel[i * 3 + 2];
        }
      }
      // RoR engine + clutch (Engine::UpdateEngine / CalcDifferentials), full throttle in one gear
      let engT = 0;
      if (extra.rorEngine && s * dt > 1) {
        // exact port of RoR's engine + automatic gearbox (passed in), fed with RoR-style wheel spin
        const re = extra.rorEngine;
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
          wr.speed = sp / wr.count;
          spin += wr.speed / wr.w.radius; nw++;
        }
        re.wheel = (spin / Math.max(1, nw)) * 60 / (2 * Math.PI);
        const fwd = extra.fwd || [0, 0, 1];
        re.ref = (vel[0] * fwd[0] + vel[1] * fwd[1] + vel[2] * fwd[2]) / (wheels[0] ? wheels[0].radius : 0.3) * 60 / (2 * Math.PI);
        re.step(dt, s % 33 === 0, s * dt);
        engT = re.clutchT / Math.max(1, nw);
        if (s % 200 === 0) re.log.push([+(s * dt).toFixed(1), re.gear, Math.round(re.rpm), Math.round((vel[0] * fwd[0] + vel[1] * fwd[1] + vel[2] * fwd[2]) * 3.6), +re.clutch.toFixed(2)]);
      }
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
          wr.speed = sp / wr.count;
          spin += sp / wr.count / wr.w.radius; nw++;
        }
        const wheelRpm = (spin / Math.max(1, nw)) * 60 / (2 * Math.PI);
        if (dv.ratios) {
          // simple automatic: shift up at the shift-up rpm (0.3 s with the clutch open, like RoR)
          if (eng.gear === undefined) { eng.gear = 0; eng.shiftUntil = 0; }
          if (eng.rpm > dv.maxRPM && eng.gear < dv.ratios.length - 1 && s * dt > eng.shiftUntil) { eng.gear++; eng.shiftUntil = s * dt + 0.3; eng.shifts = (eng.shifts || 0) + 1; }
        }
        const G = dv.ratios ? dv.ratios[eng.gear] : dv.ratio;
        const clutchOpen = dv.ratios && s * dt < eng.shiftUntil;
        const thr = 1.5 * dv.torque * G;
        let clutchT = clutchOpen ? 0 : (eng.rpm / G - wheelRpm) * dv.clutchForce;
        clutchT = Math.max(-thr, Math.min(thr, clutchT));
        const curveT = eng.rpm < dv.maxRPM * 1.25 ? dv.torque : 0;
        eng.rpm += dt * (curveT - clutchT / G) / dv.inertia;
        eng.rpm = Math.max(dv.idle * 0.5, eng.rpm);
        engT = clutchT / Math.max(1, nw);
        eng.maxAbsT = Math.max(eng.maxAbsT || 0, Math.abs(engT));
        if (s % 400 === 0) eng.log.push([+(s * dt).toFixed(1), eng.gear === undefined ? 1 : eng.gear + 1, Math.round(eng.rpm), Math.round(wheelRpm), Math.round(engT)]);
      }
      // drive torque on driven wheels, as RoR's CalcWheels (plus the reaction on the arm node)
      if ((extra.torque || extra.drive || extra.rorEngine) && s * dt > 1) {
        const T0 = (extra.drive || extra.rorEngine) ? engT : extra.torque * Math.min(1, (s * dt - 1) / 0.3);
        // RoR traction control (ActorForcesEuler: pulse timer, slip > 0.25, coef = (v/w)^ratio)
        if (extra.tc) {
          eng.tcTimer = (eng.tcTimer || 0) + dt;
          if (eng.tcTimer >= 1 / extra.tc.pulse) { eng.tcTimer = 0; eng.tcPulse = !eng.tcPulse; }
        }
        const fwdV = extra.tc ? (vel[0] * extra.tc.fwd[0] + vel[1] * extra.tc.fwd[1] + vel[2] * extra.tc.fwd[2]) : 0;
        for (const wr of wheelRings) {
          if (!wr.w.propulsed) continue;
          let T = T0;
          if (extra.tc && wr.speed !== undefined) {
            const cur = Math.abs(fwdV), ws = wr.speed;
            const slip = Math.abs(ws - fwdV) / Math.max(1, cur);
            if (Math.abs(T) > 0 && Math.abs(ws) > cur && slip > 0.25) {
              if (eng.tcPulse) wr.tcCoef = Math.pow(cur / Math.abs(ws), extra.tc.ratio);
              T *= Math.pow(wr.tcCoef === undefined ? 1 : wr.tcCoef, Math.min(Math.abs(ws) / 5, 1));
              eng.tcCuts = (eng.tcCuts || 0) + 1;
            } else wr.tcCoef = 1;
          }
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
          if (x > 0) { k += (sp.shock.hardK - k) * x; c += (sp.shock.hardD - c) * x; if (!(x <= (sp.maxX || 0))) { sp.maxX = x; sp.maxF = k * diff; } }
        }
        let f = k * diff + c * vr;
        // plastic deformation as in RoR (ActorForcesEuler): the test uses the spring AND damper
        // force, so vibration alone can bend beams with low thresholds
        if (!sp.shock && sp.k > 0 && Math.abs(f) > sp.deform && Math.sign(f) === Math.sign(diff)) {
          const lim = Math.sign(diff) * sp.deform;
          sp.L0 = L - lim / sp.k;
          f = lim + (f - lim) * 0.5;
          deformEvents++;
          if (extra.deformLog) extra.deformLog.set(sp.name, (extra.deformLog.get(sp.name) || 0) + 1);
          if (s * dt > 0.5) lateDeform++;
        }
        if (extra.breaking && sp.strength !== undefined && Math.abs(f) > sp.strength) { sp.k = 0; sp.c = 0; sp.strength = undefined; sp.broken = true; brokenLog.push([+(s * dt).toFixed(3), sp.name, Math.round(Math.abs(f))]); f = 0; }
        if (sp.broken) continue;
        frc[i3] += f * ux; frc[i3 + 1] += f * uy; frc[i3 + 2] += f * uz;
        frc[j3] -= f * ux; frc[j3 + 1] -= f * uy; frc[j3 + 2] -= f * uz;
      }
      if (extra.rorGround) {
        // RoR's ground contact (Collisions.cpp primitiveCollision), asphalt ground model
        const gm = extra.rorGround;
        for (let i = 0; i < n; i++) {
          const i3 = i * 3;
          const depth = ground - pos[i3 + 1]; // RoR's 'penetration': >= 0 when at/below the surface
          if (depth < 0) continue;
          const Vn = vel[i3 + 1], Fn = frc[i3 + 1];
          let Fr = -Fn;
          // RoR: penetration_depth = solid_ground_level - penetration = -depth
          if (Vn < 0) Fr -= (0.8 * Vn - 0.2 * depth / dt) * mass[i] / dt;
          if (Fr <= 0) continue;
          const sfx = frc[i3], sfz = frc[i3 + 2];
          let sx = vel[i3], sz = vel[i3 + 2];
          const slipv = Math.hypot(sx, sz);
          if (slipv > 0) { sx /= slipv; sz /= slipv; }
          const G = Fr * gm.strength * gm.friction, msG = gm.ms * G;
          let fx, fz;
          if (slipv < gm.va && G > 0 && sfx * sfx + sfz * sfz <= msG * msG) {
            const ff = -msG * (1 - Math.exp(-slipv / gm.va));
            fx = ff * sx - sfx; fz = ff * sz - sfz;
          } else {
            const gg = gm.mc + (gm.ms - gm.mc) * Math.exp(-Math.pow(slipv / gm.vs, gm.alpha));
            const ff = -(gg + Math.min(gm.t2 * slipv, 5)) * G;
            fx = ff * sx; fz = ff * sz;
          }
          frc[i3 + 1] += Fr; frc[i3] += fx; frc[i3 + 2] += fz;
        }
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
    const overshoots = springs.filter((sp) => sp.shock && sp.maxX > 0).map((sp) => ({ a: ids[sp.i], b: ids[sp.j], x: sp.maxX, F: sp.maxF })).sort((p, q) => Math.abs(q.F) - Math.abs(p.F));
    return { deformEvents, lateDeform, stable, overshoots, broken: brokenLog, engine: extra.drive ? eng : undefined, contact, fastest, watched, probe, firstBlow, maxSpeedMid: +maxSpeedMid.toFixed(3), maxSpeedLate: +maxSpeedLate.toFixed(3), maxStrain: +maxStrain.toFixed(3), collapsedBeams: collapsed, hotNodes, seconds: +(steps * dt).toFixed(1) };
  }

  /**
   * Finds the fastest vibration modes of the whole node/beam network and slows down
   * any that RoR's integrator can't handle. Stability of semi-implicit Euler needs,
   * for every mode, eig(M^-1 (K dt^2 + 2 C dt)) < 4. We take the largest eigenvalue
   * of the symmetric form M^-1/2 B M^-1/2 by power iteration, see which nodes move in
   * that mode, and make just those heavier (via `raise`). Repeat until all modes fit.
   */
  function stabilizeModes(nodes, links, raise, maxRounds, margin) {
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
    const target = 4 / (margin || 1.25); // safety margin: RoR runs in single precision and real driving excites every mode
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

  // ===========================================================================
  // 3D model conversion: Collada (.dae) -> OGRE binary .mesh, BeamNG flexbodies ->
  // RoR flexbodies (+ forset), BeamNG materials.json -> OGRE .material + textures.
  // ===========================================================================

  /** Minimal XML parser (enough for Collada): {tag, attrs, children, text}. */
  function parseXML(text) {
    const root = { tag: '#root', attrs: {}, children: [], text: '' };
    const stack = [root];
    const n = text.length;
    let i = 0;
    const attrRe = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    const ent = (s) => (s.indexOf('&') < 0 ? s : s.replace(/&(lt|gt|amp|quot|apos);/g, (m, e) => ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" })[e]));
    while (i < n) {
      const lt = text.indexOf('<', i);
      if (lt < 0) break;
      if (lt > i) {
        const top = stack[stack.length - 1];
        const s = text.slice(i, lt);
        if (top.text || /\S/.test(s)) top.text += s;
      }
      if (text.startsWith('<!--', lt)) { const e = text.indexOf('-->', lt + 4); i = e < 0 ? n : e + 3; continue; }
      if (text.startsWith('<![CDATA[', lt)) { const e = text.indexOf(']]>', lt); stack[stack.length - 1].text += text.slice(lt + 9, e < 0 ? n : e); i = e < 0 ? n : e + 3; continue; }
      if (text[lt + 1] === '?' || text[lt + 1] === '!') { const e = text.indexOf('>', lt); i = e < 0 ? n : e + 1; continue; }
      const gt = text.indexOf('>', lt);
      if (gt < 0) break;
      if (text[lt + 1] === '/') { if (stack.length > 1) stack.pop(); i = gt + 1; continue; }
      const selfClose = text[gt - 1] === '/';
      const body = text.slice(lt + 1, selfClose ? gt - 1 : gt);
      const m = /^[^\s/>]+/.exec(body);
      const el = { tag: m ? m[0] : '', attrs: {}, children: [], text: '' };
      attrRe.lastIndex = el.tag.length;
      let a;
      while ((a = attrRe.exec(body))) el.attrs[a[1]] = ent(a[2] !== undefined ? a[2] : a[3]);
      stack[stack.length - 1].children.push(el);
      if (!selfClose) stack.push(el);
      i = gt + 1;
    }
    return root;
  }
  const xkids = (el, tag) => (el ? el.children.filter((c) => c.tag === tag) : []);
  const xkid = (el, tag) => (el ? el.children.find((c) => c.tag === tag) || null : null);
  function numbers(s, Type) {
    const parts = s.trim().split(/\s+/);
    const out = new (Type || Float64Array)(parts[0] === '' ? 0 : parts.length);
    for (let k = 0; k < out.length; k++) out[k] = +parts[k];
    return out;
  }
  // 4x4 row-major matrices (Collada convention: v' = M v, column vectors)
  const m4 = {
    id: () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    mul(a, b) { const o = new Array(16); for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) { let s = 0; for (let k = 0; k < 4; k++) s += a[r * 4 + k] * b[k * 4 + c]; o[r * 4 + c] = s; } return o; },
    rot(ax, ay, az, deg) {
      const l = Math.hypot(ax, ay, az) || 1; const x = ax / l, y = ay / l, z = az / l;
      const t = deg * Math.PI / 180, c = Math.cos(t), s = Math.sin(t), C = 1 - c;
      return [x * x * C + c, x * y * C - z * s, x * z * C + y * s, 0, y * x * C + z * s, y * y * C + c, y * z * C - x * s, 0, z * x * C - y * s, z * y * C + x * s, z * z * C + c, 0, 0, 0, 0, 1];
    },
  };

  /**
   * Parse a Collada file. Returns {meshes: Map(name -> {name, matrix, geometry, materials})}
   * where geometry = {prims: [{material, tris: [[pi, ni, ti] x3]...]}} built lazily.
   */
  function parseCollada(text) {
    const doc = parseXML(text);
    const collada = xkid(doc, 'COLLADA') || doc.children[0];
    const byId = new Map();
    (function walk(el) { if (el.attrs.id) byId.set(el.attrs.id, el); for (const c of el.children) walk(c); })(collada);
    const ref = (url) => (url && url[0] === '#' ? byId.get(url.slice(1)) : null);
    const asset = xkid(collada, 'asset');
    const unitEl = xkid(asset, 'unit');
    const unit = unitEl ? +unitEl.attrs.meter || 1 : 1;
    const upEl = xkid(asset, 'up_axis');
    const upAxis = upEl ? upEl.text.trim() : 'Z_UP';
    // Convert the file's axes to BeamNG's (Z up) and its units to metres
    let base = [unit, 0, 0, 0, 0, unit, 0, 0, 0, 0, unit, 0, 0, 0, 0, 1];
    if (upAxis === 'Y_UP') base = m4.mul([1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1], base);
    else if (upAxis === 'X_UP') base = m4.mul([0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], base);
    const meshes = new Map();
    function localMatrix(node) {
      let m = m4.id();
      for (const c of node.children) {
        if (c.tag === 'matrix') m = m4.mul(m, Array.from(numbers(c.text)));
        else if (c.tag === 'translate') { const v = numbers(c.text); m = m4.mul(m, [1, 0, 0, v[0], 0, 1, 0, v[1], 0, 0, 1, v[2], 0, 0, 0, 1]); }
        else if (c.tag === 'rotate') { const v = numbers(c.text); m = m4.mul(m, m4.rot(v[0], v[1], v[2], v[3])); }
        else if (c.tag === 'scale') { const v = numbers(c.text); m = m4.mul(m, [v[0], 0, 0, 0, 0, v[1], 0, 0, 0, 0, v[2], 0, 0, 0, 0, 1]); }
      }
      return m;
    }
    function visit(node, parentM, depth) {
      if (depth > 50) return;
      const M = m4.mul(parentM, localMatrix(node));
      for (const ig of xkids(node, 'instance_geometry')) {
        const geo = ref(ig.attrs.url);
        if (!geo) continue;
        const binds = new Map();
        const tc = xkid(xkid(ig, 'bind_material'), 'technique_common');
        for (const im of xkids(tc, 'instance_material')) {
          const mat = ref(im.attrs.target);
          binds.set(im.attrs.symbol, mat ? (mat.attrs.name || mat.attrs.id) : String(im.attrs.target || '').replace(/^#/, '').replace(/-material$/, ''));
        }
        const name = node.attrs.name || node.attrs.id || geo.attrs.name || geo.attrs.id;
        const item = { name, matrix: M, geo, binds };
        for (const key of new Set([name, node.attrs.id, geo.attrs.name].filter(Boolean))) if (!meshes.has(key)) meshes.set(key, item);
      }
      for (const inst of xkids(node, 'instance_node')) { const n2 = ref(inst.attrs.url); if (n2) visit(n2, M, depth + 1); }
      for (const ch of xkids(node, 'node')) visit(ch, M, depth + 1);
    }
    const scenes = xkid(collada, 'library_visual_scenes');
    for (const vs of xkids(scenes, 'visual_scene')) for (const nd of xkids(vs, 'node')) visit(nd, base, 0);
    return { meshes, ref };
  }

  // ===========================================================================
  // Zstandard decompressor (RFC 8878), for BeamNG's compressed .cdae models.
  // Written from the specification; checked against Node's built-in zstd.
  // ===========================================================================
  const ZSTD_LL_BASE = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 28, 32, 40, 48, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536];
  const ZSTD_LL_BITS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 3, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
  const ZSTD_ML_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 37, 39, 41, 43, 47, 51, 59, 67, 83, 99, 131, 259, 515, 1027, 2051, 4099, 8195, 16387, 32771, 65539];
  const ZSTD_ML_BITS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 3, 3, 4, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
  const ZSTD_LL_DEF = [4, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 2, 1, 1, 1, 1, 1, -1, -1, -1, -1];
  const ZSTD_ML_DEF = [1, 4, 3, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1, -1, -1];
  const ZSTD_OF_DEF = [1, 1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1];
  const highBit = (v) => 31 - Math.clz32(v);

  // Bitstream read backwards (FSE / Huffman / sequences): starts at the padding marker in the last byte
  function zBackReader(buf, start, end) {
    const last = buf[end - 1];
    if (!last) throw new Error('zstd: bad bitstream end');
    let pos = (end - 1 - start) * 8 + highBit(last); // number of bits left
    const bit = (i) => (buf[start + (i >> 3)] >> (i & 7)) & 1;
    return {
      get left() { return pos; },
      read(n) {
        if (!n) return 0;
        let v = 0;
        for (let k = n - 1; k >= 0; k--) { const i = pos - n + k; v = v * 2 + (i >= 0 ? bit(i) : 0); }
        pos -= n;
        return v;
      },
      peek(n) {
        let v = 0;
        for (let k = n - 1; k >= 0; k--) { const i = pos - n + k; v = v * 2 + (i >= 0 ? bit(i) : 0); }
        return v;
      },
      skip(n) { pos -= n; },
    };
  }

  // FSE table description (forward bitstream). Returns {probs, log, bytes}
  function zReadFseCounts(buf, at, maxSym, maxLog) {
    let bitPos = 0;
    const readBits = (n) => { let v = 0; for (let k = 0; k < n; k++, bitPos++) v |= ((buf[at + (bitPos >> 3)] >> (bitPos & 7)) & 1) << k; return v; };
    const peekBits = (n) => { const save = bitPos; const v = readBits(n); bitPos = save; return v; };
    const log = readBits(4) + 5;
    if (log > maxLog) throw new Error('zstd: FSE accuracy too large');
    let remaining = (1 << log) + 1, threshold = 1 << log, nbBits = log + 1;
    const probs = [];
    let sym = 0;
    while (remaining > 1 && sym <= maxSym) {
      const max = (2 * threshold - 1) - remaining;
      let count;
      const low = peekBits(nbBits - 1);
      if (low < max) { count = low; bitPos += nbBits - 1; }
      else { count = peekBits(nbBits); if (count >= threshold) count -= max; bitPos += nbBits; }
      count--;
      remaining -= count < 0 ? -count : count;
      probs[sym++] = count;
      if (count === 0) {
        let r;
        do { r = readBits(2); for (let k = 0; k < r; k++) probs[sym++] = 0; } while (r === 3);
      }
      while (remaining < threshold) { nbBits--; threshold >>= 1; }
    }
    if (remaining !== 1) throw new Error('zstd: bad FSE description');
    return { probs, log, bytes: (bitPos + 7) >> 3 };
  }

  function zBuildFse(probs, log) {
    const size = 1 << log, sym = new Uint16Array(size), nb = new Uint8Array(size), base = new Uint32Array(size);
    const next = [];
    let high = size - 1;
    for (let s = 0; s < probs.length; s++) if (probs[s] === -1) { sym[high--] = s; next[s] = 1; } else next[s] = probs[s];
    const step = (size >> 1) + (size >> 3) + 3, mask = size - 1;
    let p = 0;
    for (let s = 0; s < probs.length; s++) for (let i = 0; i < probs[s]; i++) { sym[p] = s; do p = (p + step) & mask; while (p > high); }
    if (p !== 0) throw new Error('zstd: bad FSE table');
    for (let u = 0; u < size; u++) { const s = sym[u]; const ns = next[s]++; nb[u] = log - highBit(ns); base[u] = (ns << nb[u]) - size; }
    return { sym, nb, base, log };
  }
  const zRle = (s) => ({ sym: new Uint16Array([s]), nb: new Uint8Array([0]), base: new Uint32Array([0]), log: 0 });

  // Huffman table for literals: returns {sym, nb, maxBits, bytes}
  function zReadHuffman(buf, at) {
    const h = buf[at];
    let weights = [], bytes;
    if (h < 128) {
      const fse = zReadFseCounts(buf, at + 1, 255, 6);
      const t = zBuildFse(fse.probs, fse.log);
      const br = zBackReader(buf, at + 1 + fse.bytes, at + 1 + h);
      let s1 = br.read(t.log), s2 = br.read(t.log);
      while (true) {
        weights.push(t.sym[s1]); s1 = t.base[s1] + br.read(t.nb[s1]);
        if (br.left < 0) { weights.push(t.sym[s2]); break; }
        weights.push(t.sym[s2]); s2 = t.base[s2] + br.read(t.nb[s2]);
        if (br.left < 0) { weights.push(t.sym[s1]); break; }
        if (weights.length > 255) throw new Error('zstd: too many Huffman weights');
      }
      bytes = 1 + h;
    } else {
      const n = h - 127;
      for (let i = 0; i < n; i++) { const b = buf[at + 1 + (i >> 1)]; weights.push(i & 1 ? b & 15 : b >> 4); }
      bytes = 1 + ((n + 1) >> 1);
    }
    let sum = 0;
    for (const w of weights) if (w) sum += 1 << (w - 1);
    const maxBits = highBit(sum) + 1;
    const rest = (1 << maxBits) - sum;
    if (rest & (rest - 1)) throw new Error('zstd: bad Huffman weights');
    weights.push(highBit(rest) + 1);
    const size = 1 << maxBits, sym = new Uint8Array(size), nb = new Uint8Array(size);
    const rankStart = [];
    let next = 0;
    for (let w = 1; w <= maxBits; w++) { rankStart[w] = next; for (const x of weights) if (x === w) next += 1 << (w - 1); }
    for (let s = 0; s < weights.length; s++) {
      const w = weights[s];
      if (!w) continue;
      const len = 1 << (w - 1);
      for (let i = rankStart[w]; i < rankStart[w] + len; i++) { sym[i] = s; nb[i] = maxBits + 1 - w; }
      rankStart[w] += len;
    }
    return { sym, nb, maxBits, bytes };
  }

  function zDecodeHuffStream(buf, start, end, t, out, oAt, count) {
    const br = zBackReader(buf, start, end);
    for (let i = 0; i < count; i++) { const v = br.peek(t.maxBits); out[oAt + i] = t.sym[v]; br.skip(t.nb[v]); }
  }

  function zstdDecompress(input) {
    let out = new Uint8Array(Math.max(1024, input.length * 4)), o = 0;
    const ensure = (n) => { if (o + n > out.length) { let sz = out.length; while (o + n > sz) sz *= 2; const nb2 = new Uint8Array(sz); nb2.set(out.subarray(0, o)); out = nb2; } };
    let p = 0;
    const u32 = (q) => input[q] | (input[q + 1] << 8) | (input[q + 2] << 16) | (input[q + 3] << 24) >>> 0;
    while (p < input.length) {
      const magic = u32(p) >>> 0;
      if ((magic & 0xFFFFFFF0) >>> 0 === 0x184D2A50) { p += 8 + u32(p + 4); continue; } // skippable frame
      if (magic !== 0xFD2FB528) throw new Error('zstd: not a zstd frame');
      p += 4;
      const fhd = input[p++];
      const fcsFlag = fhd >> 6, single = (fhd >> 5) & 1, checksum = (fhd >> 2) & 1, dictFlag = fhd & 3;
      if (!single) p++; // window descriptor
      if (dictFlag) throw new Error('zstd: dictionaries are not supported');
      p += [single ? 1 : 0, 2, 4, 8][fcsFlag];
      const frameStart = o;
      let rep = [1, 4, 8], huff = null, tLL = null, tOF = null, tML = null;
      while (true) {
        const bh = input[p] | (input[p + 1] << 8) | (input[p + 2] << 16);
        p += 3;
        const last = bh & 1, type = (bh >> 1) & 3, size = bh >> 3;
        if (type === 0) { ensure(size); out.set(input.subarray(p, p + size), o); o += size; p += size; }
        else if (type === 1) { ensure(size); out.fill(input[p], o, o + size); o += size; p += 1; }
        else if (type === 2) {
          const blockEnd = p + size;
          // ---- literals
          const lb0 = input[p], ltype = lb0 & 3, sf = (lb0 >> 2) & 3;
          let lits, litSize;
          if (ltype < 2) {
            let hdr;
            if ((sf & 1) === 0) { litSize = lb0 >> 3; hdr = 1; }
            else if (sf === 1) { litSize = (lb0 >> 4) + (input[p + 1] << 4); hdr = 2; }
            else { litSize = (lb0 >> 4) + (input[p + 1] << 4) + (input[p + 2] << 12); hdr = 3; }
            p += hdr;
            if (ltype === 0) { lits = input.subarray(p, p + litSize); p += litSize; }
            else { lits = new Uint8Array(litSize).fill(input[p]); p += 1; }
          } else {
            const hb = [3, 3, 4, 5][sf], bits = [10, 10, 14, 18][sf];
            let hv = 0;
            for (let k = hb - 1; k >= 0; k--) hv = hv * 256 + input[p + k];
            const mask = 2 ** bits;
            litSize = Math.floor(hv / 16) % mask;
            const comp = Math.floor(hv / 16 / mask) % mask;
            p += hb;
            const cEnd = p + comp;
            if (ltype === 2) { huff = zReadHuffman(input, p); p += huff.bytes; }
            else if (!huff) throw new Error('zstd: treeless literals without a table');
            lits = new Uint8Array(litSize);
            if (sf === 0) zDecodeHuffStream(input, p, cEnd, huff, lits, 0, litSize);
            else {
              const s1 = input[p] | (input[p + 1] << 8), s2 = input[p + 2] | (input[p + 3] << 8), s3 = input[p + 4] | (input[p + 5] << 8);
              const per = (litSize + 3) >> 2;
              let q = p + 6;
              const ends = [q + s1, q + s1 + s2, q + s1 + s2 + s3, cEnd];
              let oq = 0;
              for (let k = 0; k < 4; k++) { const n = k < 3 ? per : litSize - 3 * per; zDecodeHuffStream(input, q, ends[k], huff, lits, oq, n); oq += n; q = ends[k]; }
            }
            p = cEnd;
          }
          // ---- sequences
          let nSeq = input[p++];
          if (nSeq >= 128) { if (nSeq < 255) nSeq = ((nSeq - 128) << 8) + input[p++]; else { nSeq = input[p] + (input[p + 1] << 8) + 0x7F00; p += 2; } }
          let li = 0;
          if (nSeq > 0) {
            const modes = input[p++];
            const table = (mode, def, defLog, maxSym, maxLog, prev) => {
              if (mode === 0) return zBuildFse(def, defLog);
              if (mode === 1) return zRle(input[p++]);
              if (mode === 2) { const c = zReadFseCounts(input, p, maxSym, maxLog); p += c.bytes; return zBuildFse(c.probs, c.log); }
              if (!prev) throw new Error('zstd: repeat table without a previous one');
              return prev;
            };
            tLL = table(modes >> 6, ZSTD_LL_DEF, 6, 35, 9, tLL);
            tOF = table((modes >> 4) & 3, ZSTD_OF_DEF, 5, 31, 8, tOF);
            tML = table((modes >> 2) & 3, ZSTD_ML_DEF, 6, 52, 9, tML);
            const br = zBackReader(input, p, blockEnd);
            let sLL = br.read(tLL.log), sOF = br.read(tOF.log), sML = br.read(tML.log);
            for (let s = 0; s < nSeq; s++) {
              const ofc = tOF.sym[sOF], mlc = tML.sym[sML], llc = tLL.sym[sLL];
              const ofv = 2 ** ofc + br.read(ofc);
              const ml = ZSTD_ML_BASE[mlc] + br.read(ZSTD_ML_BITS[mlc]);
              const ll = ZSTD_LL_BASE[llc] + br.read(ZSTD_LL_BITS[llc]);
              let off;
              if (ofv > 3) { off = ofv - 3; rep = [off, rep[0], rep[1]]; }
              else {
                const idx = ofv - 1 + (ll === 0 ? 1 : 0);
                if (idx === 0) off = rep[0];
                else if (idx === 3) { off = rep[0] - 1; rep = [off, rep[0], rep[1]]; }
                else { off = rep[idx]; rep = idx === 1 ? [off, rep[0], rep[2]] : [off, rep[0], rep[1]]; }
              }
              ensure(ll + ml);
              out.set(lits.subarray(li, li + ll), o); o += ll; li += ll;
              if (off > o - frameStart || off <= 0) throw new Error('zstd: bad match offset');
              for (let k = 0; k < ml; k++) { out[o] = out[o - off]; o++; }
              if (s < nSeq - 1) {
                sLL = tLL.base[sLL] + br.read(tLL.nb[sLL]);
                sML = tML.base[sML] + br.read(tML.nb[sML]);
                sOF = tOF.base[sOF] + br.read(tOF.nb[sOF]);
              }
            }
          }
          const restLits = litSize - li;
          ensure(restLits);
          out.set(lits.subarray(li, litSize), o); o += restLits;
          p = blockEnd;
        } else throw new Error('zstd: reserved block type');
        if (last) break;
      }
      if (checksum) p += 4;
    }
    return out.subarray(0, o);
  }

  // ===========================================================================
  // BeamNG compiled models (.cdae, "shape MessagePack" format): Torque3D's TSShape
  // tables stored as MessagePack values, body compressed with Zstandard.
  // ===========================================================================
  function msgpackDecode(buf, pos) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let p = pos || 0;
    const td = new TextDecoder();
    const str = (n) => { const s = td.decode(buf.subarray(p, p + n)); p += n; return s; };
    const bin = (n) => { const s = buf.subarray(p, p + n); p += n; return s; };
    const arr = (n) => { const a = new Array(n); for (let i = 0; i < n; i++) a[i] = val(); return a; };
    const map = (n) => { const o = {}; for (let i = 0; i < n; i++) { const k = val(); o[k] = val(); } return o; };
    const ext = (n) => { p++; return bin(n); };
    function val() {
      const b = buf[p++];
      if (b <= 0x7f) return b;
      if (b >= 0xe0) return b - 256;
      if ((b & 0xf0) === 0x80) return map(b & 0x0f);
      if ((b & 0xf0) === 0x90) return arr(b & 0x0f);
      if ((b & 0xe0) === 0xa0) return str(b & 0x1f);
      let v;
      switch (b) {
        case 0xc0: return null; case 0xc2: return false; case 0xc3: return true;
        case 0xc4: v = buf[p]; p += 1; return bin(v);
        case 0xc5: v = dv.getUint16(p); p += 2; return bin(v);
        case 0xc6: v = dv.getUint32(p); p += 4; return bin(v);
        case 0xc7: v = buf[p]; p += 1; return ext(v);
        case 0xc8: v = dv.getUint16(p); p += 2; return ext(v);
        case 0xc9: v = dv.getUint32(p); p += 4; return ext(v);
        case 0xca: v = dv.getFloat32(p); p += 4; return v;
        case 0xcb: v = dv.getFloat64(p); p += 8; return v;
        case 0xcc: v = buf[p]; p += 1; return v;
        case 0xcd: v = dv.getUint16(p); p += 2; return v;
        case 0xce: v = dv.getUint32(p); p += 4; return v;
        case 0xcf: v = Number(dv.getBigUint64(p)); p += 8; return v;
        case 0xd0: v = dv.getInt8(p); p += 1; return v;
        case 0xd1: v = dv.getInt16(p); p += 2; return v;
        case 0xd2: v = dv.getInt32(p); p += 4; return v;
        case 0xd3: v = Number(dv.getBigInt64(p)); p += 8; return v;
        case 0xd4: return ext(1); case 0xd5: return ext(2); case 0xd6: return ext(4); case 0xd7: return ext(8); case 0xd8: return ext(16);
        case 0xd9: v = buf[p]; p += 1; return str(v);
        case 0xda: v = dv.getUint16(p); p += 2; return str(v);
        case 0xdb: v = dv.getUint32(p); p += 4; return str(v);
        case 0xdc: v = dv.getUint16(p); p += 2; return arr(v);
        case 0xdd: v = dv.getUint32(p); p += 4; return arr(v);
        case 0xde: v = dv.getUint16(p); p += 2; return map(v);
        case 0xdf: v = dv.getUint32(p); p += 4; return map(v);
      }
      throw new Error('bad MessagePack byte 0x' + b.toString(16));
    }
    const value = val();
    return { value, end: p };
  }

  /** Object names from a .cdae header, without decompressing the body. */
  function cdaeObjectNames(bytes) {
    const h = msgpackDecode(bytes, 8).value;
    return Array.isArray(h && h.objectNames) ? h.objectNames : [];
  }

  /**
   * Parse a .cdae into the same shape as parseCollada: {meshes: Map(name -> item), cdae: true}.
   * Each item has the object's node world matrix (row-major, BeamNG vehicle space) and its mesh.
   */
  function parseCdae(bytes) {
    const headDv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const head = msgpackDecode(bytes, 8);
    if (!head.value || head.value.objectNames === undefined) throw new Error('not a MessagePack .cdae');
    let body = bytes.subarray(head.end);
    if (head.value.compression) body = zstdDecompress(body);
    void headDv;
    let p = 0;
    const next = () => { const d = msgpackDecode(body, p); p = d.end; return d.value; };
    const table = () => { const n = next(), sz = next(), bin = next(); return { n, sz, bin: bin instanceof Uint8Array ? bin : new Uint8Array(0) }; };
    const dvOf = (bin) => new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
    next(); next(); next(); next(); next(); next(); // flags, smallest size/radius, radius, centre, bounds
    const nodesT = table(), objectsT = table();
    for (let i = 0; i < 4; i++) table(); // sub-shapes
    const rotT = table(), transT = table();
    for (let i = 0; i < 8; i++) table(); // animation tables
    table(); table(); table(); // object states, triggers, details
    const nNames = next();
    const names = [];
    for (let i = 0; i < nNames; i++) names.push(next());
    const nMeshes = next();
    const meshes = [];
    for (let m = 0; m < nMeshes; m++) {
      const type = next();
      if (type === 4) { meshes.push(null); continue; } // null mesh
      if (type !== 0) throw new Error(`unsupported mesh type ${type} in .cdae`);
      next(); next(); next(); next(); next(); next(); // frames, material frames, parent, bounds, centre, radius
      const verts = table(), tverts = table(); table(); /* tverts2 */ table(); /* colours */
      const normals = table(); table(); /* encoded normals */
      const prims = table(), indices = table(); table(); /* tangents */
      next(); next(); // verts per frame, flags
      meshes.push({ verts, tverts, normals, prims, indices });
    }
    next(); // sequences
    const nMats = next();
    const materials = [];
    for (let i = 0; i < nMats; i++) { materials.push(next()); next(); next(); next(); next(); next(); next(); }
    // node world matrices: parent * (rotation, translation); rotations are 16-bit quaternions
    const nd = dvOf(nodesT.bin), rd = dvOf(rotT.bin), td = dvOf(transT.bin);
    const world = [];
    const local = (i) => {
      const q = [0, 1, 2, 3].map((k) => rd.getInt16(i * 8 + k * 2, true) / 32767);
      const l = Math.hypot(...q) || 1;
      const [x, y, z, w] = q.map((v) => v / l);
      const t = [0, 1, 2].map((k) => td.getFloat32(i * 12 + k * 4, true));
      // Torque stores the inverse (conjugate) rotation
      const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
      return [1 - 2 * (yy + zz), 2 * (xy + wz), 2 * (xz - wy), t[0],
        2 * (xy - wz), 1 - 2 * (xx + zz), 2 * (yz + wx), t[1],
        2 * (xz + wy), 2 * (yz - wx), 1 - 2 * (xx + yy), t[2],
        0, 0, 0, 1];
    };
    const worldOf = (i, guard) => {
      if (world[i]) return world[i];
      const parent = nd.getInt32(i * 20 + 4, true);
      const m = parent >= 0 && parent !== i && guard < 64 ? m4.mul(worldOf(parent, guard + 1), local(i)) : local(i);
      world[i] = m;
      return m;
    };
    const od = dvOf(objectsT.bin);
    const out = new Map();
    for (let i = 0; i < objectsT.n; i++) {
      const nameIdx = od.getInt32(i * 24, true), numMeshes = od.getInt32(i * 24 + 4, true), start = od.getInt32(i * 24 + 8, true), node = od.getInt32(i * 24 + 12, true);
      const mesh = numMeshes > 0 ? meshes[start] : null;
      const name = names[nameIdx];
      if (!mesh || !name || out.has(name)) continue;
      out.set(name, { name, matrix: node >= 0 && node < nodesT.n ? worldOf(node, 0) : m4.id(), cdaeMesh: mesh, materials });
    }
    return { meshes: out, cdae: true };
  }

  /** Geometry of a .cdae object, same result as colladaGeometry. */
  function cdaeGeometry(item) {
    const m = item.cdaeMesh, M = item.matrix;
    const vd = new DataView(m.verts.bin.buffer, m.verts.bin.byteOffset, m.verts.bin.byteLength);
    const nd = new DataView(m.normals.bin.buffer, m.normals.bin.byteOffset, m.normals.bin.byteLength);
    const td = new DataView(m.tverts.bin.buffer, m.tverts.bin.byteOffset, m.tverts.bin.byteLength);
    const id = new DataView(m.indices.bin.buffer, m.indices.bin.byteOffset, m.indices.bin.byteLength);
    const pd = new DataView(m.prims.bin.buffer, m.prims.bin.byteOffset, m.prims.bin.byteLength);
    const nV = m.verts.n;
    const pos = new Float64Array(nV * 3), nrm = new Float64Array(nV * 3), uv = new Float64Array(nV * 2);
    for (let v = 0; v < nV; v++) {
      const x = vd.getFloat32(v * 12, true), y = vd.getFloat32(v * 12 + 4, true), z = vd.getFloat32(v * 12 + 8, true);
      pos[v * 3] = M[0] * x + M[1] * y + M[2] * z + M[3]; pos[v * 3 + 1] = M[4] * x + M[5] * y + M[6] * z + M[7]; pos[v * 3 + 2] = M[8] * x + M[9] * y + M[10] * z + M[11];
      if (v < m.normals.n) {
        const a = nd.getFloat32(v * 12, true), b = nd.getFloat32(v * 12 + 4, true), c = nd.getFloat32(v * 12 + 8, true);
        const nx = M[0] * a + M[1] * b + M[2] * c, ny = M[4] * a + M[5] * b + M[6] * c, nz = M[8] * a + M[9] * b + M[10] * c;
        const l = Math.hypot(nx, ny, nz) || 1;
        nrm[v * 3] = nx / l; nrm[v * 3 + 1] = ny / l; nrm[v * 3 + 2] = nz / l;
      } else nrm[v * 3 + 2] = 1;
      if (v < m.tverts.n) { uv[v * 2] = td.getFloat32(v * 8, true); uv[v * 2 + 1] = td.getFloat32(v * 8 + 4, true); }
    }
    const subs = new Map();
    for (let k = 0; k < m.prims.n; k++) {
      const start = pd.getInt32(k * 12, true), count = pd.getInt32(k * 12 + 4, true), mi = pd.getUint32(k * 12 + 8, true);
      const kind = mi >>> 30, noMat = (mi >>> 28) & 1, matIdx = mi & 0x0fffffff;
      const matName = noMat ? 'default' : item.materials[matIdx] || 'default';
      if (!subs.has(matName)) subs.set(matName, []);
      const out = subs.get(matName);
      const ix = (i) => id.getUint32((start + i) * 4, true);
      // Torque winds triangles the other way round from Collada/OGRE: flip each one
      if (kind === 0) for (let i = 0; i + 2 < count; i += 3) out.push(ix(i), ix(i + 2), ix(i + 1));
      else if (kind === 1) for (let i = 0; i + 2 < count; i++) { const a = ix(i), b = ix(i + 1), c = ix(i + 2); if (a === b || b === c || a === c) continue; if (i & 1) out.push(b, c, a); else out.push(a, c, b); }
      else if (kind === 2) for (let i = 1; i + 1 < count; i++) out.push(ix(0), ix(i + 1), ix(i));
    }
    return { pos, nrm, uv, subs: [...subs].filter(([, idx]) => idx.length).map(([material, idx]) => ({ material, idx })) };
  }

  /**
   * Triangles of one Collada mesh instance, in BeamNG vehicle space.
   * Returns {pos: Float64Array, nrm, uv, subs: [{material, idx: number[]}]} with
   * deduplicated vertices (position/normal/uv triples).
   */
  function colladaGeometry(dae, item) {
    const mesh = xkid(item.geo, 'mesh');
    if (!mesh) return null;
    const srcCache = new Map();
    function source(url) {
      if (srcCache.has(url)) return srcCache.get(url);
      const el = dae.ref(url);
      let out = null;
      if (el && el.tag === 'source') {
        const fa = xkid(el, 'float_array');
        const acc = xkid(xkid(el, 'technique_common'), 'accessor');
        if (fa) out = { data: numbers(fa.text), stride: acc ? +acc.attrs.stride || 1 : 3 };
      } else if (el && el.tag === 'vertices') {
        const p = xkids(el, 'input').find((x) => x.attrs.semantic === 'POSITION');
        const nIn = xkids(el, 'input').find((x) => x.attrs.semantic === 'NORMAL');
        out = { vertices: true, pos: p ? source(p.attrs.source) : null, nrm: nIn ? source(nIn.attrs.source) : null };
      }
      srcCache.set(url, out);
      return out;
    }
    const M = item.matrix;
    const nM = [M[0], M[1], M[2], M[4], M[5], M[6], M[8], M[9], M[10]]; // normals: rotation part (renormalised)
    const keyMap = new Map();
    const P = [], Nn = [], T = [];
    const subs = new Map();
    for (const prim of mesh.children) {
      if (!/^(triangles|polylist|polygons)$/.test(prim.tag)) continue;
      const inputs = xkids(prim, 'input').map((x) => ({ sem: x.attrs.semantic, src: source(x.attrs.source), off: +x.attrs.offset || 0, set: +x.attrs.set || 0 }));
      const vIn = inputs.find((x) => x.sem === 'VERTEX');
      if (!vIn || !vIn.src || !vIn.src.pos) continue;
      const nIn = inputs.find((x) => x.sem === 'NORMAL');
      const tIn = inputs.filter((x) => x.sem === 'TEXCOORD' && x.src).sort((a, b) => a.set - b.set)[0];
      const stride = Math.max(...inputs.map((x) => x.off)) + 1;
      const pEls = xkids(prim, 'p');
      const polys = []; // arrays of corner starts
      if (prim.tag === 'polygons') {
        for (const pe of pEls) polys.push(numbers(pe.text, Float64Array));
      } else if (pEls.length) {
        const p = numbers(pEls[0].text, Float64Array);
        if (prim.tag === 'triangles') polys.push({ p, vc: null });
        else polys.push({ p, vc: numbers((xkid(prim, 'vcount') || { text: '' }).text, Float64Array) });
      }
      const matName = item.binds.get(prim.attrs.material) || prim.attrs.material || 'default';
      if (!subs.has(matName)) subs.set(matName, []);
      const out = subs.get(matName);
      const corner = (p, at) => {
        const pi = p[at + vIn.off], ni = nIn ? p[at + nIn.off] : -1, ti = tIn ? p[at + tIn.off] : -1;
        const key = pi + ',' + ni + ',' + ti;
        let v = keyMap.get(key);
        if (v === undefined) {
          v = P.length / 3;
          keyMap.set(key, v);
          const ps = vIn.src.pos, s = pi * ps.stride;
          const x = ps.data[s], y = ps.data[s + 1], z = ps.data[s + 2];
          P.push(M[0] * x + M[1] * y + M[2] * z + M[3], M[4] * x + M[5] * y + M[6] * z + M[7], M[8] * x + M[9] * y + M[10] * z + M[11]);
          const ns = nIn ? nIn.src : vIn.src.nrm;
          const nidx = nIn ? ni : pi;
          if (ns && nidx >= 0) {
            const t2 = nidx * ns.stride, a = ns.data[t2], b = ns.data[t2 + 1], c = ns.data[t2 + 2];
            const nx = nM[0] * a + nM[1] * b + nM[2] * c, ny = nM[3] * a + nM[4] * b + nM[5] * c, nz = nM[6] * a + nM[7] * b + nM[8] * c;
            const l = Math.hypot(nx, ny, nz) || 1;
            Nn.push(nx / l, ny / l, nz / l);
          } else Nn.push(NaN, NaN, NaN);
          if (tIn && ti >= 0) { const t3 = ti * tIn.src.stride; T.push(tIn.src.data[t3], 1 - tIn.src.data[t3 + 1]); } else T.push(0, 0);
        }
        return v;
      };
      for (const poly of polys) {
        if (poly instanceof Float64Array) { // <polygons><p>: one polygon each
          const cnt = Math.floor(poly.length / stride);
          const c0 = corner(poly, 0);
          for (let k = 1; k + 1 < cnt; k++) out.push(c0, corner(poly, k * stride), corner(poly, (k + 1) * stride));
          continue;
        }
        const { p, vc } = poly;
        if (!vc) { for (let at = 0; at + 3 * stride <= p.length; at += 3 * stride) out.push(corner(p, at), corner(p, at + stride), corner(p, at + 2 * stride)); continue; }
        let at = 0;
        for (let f = 0; f < vc.length; f++) {
          const cnt = vc[f];
          if (cnt >= 3) {
            const c0 = corner(p, at);
            for (let k = 1; k + 1 < cnt; k++) out.push(c0, corner(p, at + k * stride), corner(p, at + (k + 1) * stride));
          }
          at += cnt * stride;
        }
      }
    }
    // Fill in missing normals from the faces
    const nV = P.length / 3;
    if (Nn.some((x) => Number.isNaN(x))) {
      const acc = new Float64Array(nV * 3);
      for (const idx of subs.values()) for (let t = 0; t < idx.length; t += 3) {
        const [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]];
        const e1 = [P[b * 3] - P[a * 3], P[b * 3 + 1] - P[a * 3 + 1], P[b * 3 + 2] - P[a * 3 + 2]];
        const e2 = [P[c * 3] - P[a * 3], P[c * 3 + 1] - P[a * 3 + 1], P[c * 3 + 2] - P[a * 3 + 2]];
        const fn = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        for (const v of [a, b, c]) for (let q = 0; q < 3; q++) acc[v * 3 + q] += fn[q];
      }
      for (let v = 0; v < nV; v++) if (Number.isNaN(Nn[v * 3])) { const l = Math.hypot(acc[v * 3], acc[v * 3 + 1], acc[v * 3 + 2]) || 1; for (let q = 0; q < 3; q++) Nn[v * 3 + q] = acc[v * 3 + q] / l; }
    }
    return { pos: Float64Array.from(P), nrm: Float64Array.from(Nn), uv: Float64Array.from(T), subs: [...subs].filter(([, idx]) => idx.length).map(([material, idx]) => ({ material, idx })) };
  }

  /**
   * OGRE binary mesh ([MeshSerializer_v1.100], read by OGRE 1.11 / RoR 2026.01).
   * One shared vertex buffer: position, normal, uv (32 bytes); one submesh per material.
   */
  function writeOgreMesh(pos, nrm, uv, subs) {
    const nV = pos.length / 3;
    const parts = [];
    let size = 0;
    const enc = new TextEncoder();
    // builders: each returns Uint8Array
    const u16 = (v) => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, true); return b; };
    const u32 = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); return b; };
    const bool = (v) => new Uint8Array([v ? 1 : 0]);
    const str = (s) => enc.encode(s + '\n');
    const cat = (list) => { let n = 0; for (const x of list) n += x.length; const o = new Uint8Array(n); let at = 0; for (const x of list) { o.set(x, at); at += x.length; } return o; };
    const chunk = (id, list) => { const body = cat(list); return cat([u16(id), u32(body.length + 6), body]); };
    const f32 = (arr) => { const b = new Uint8Array(arr.length * 4); const dv = new DataView(b.buffer); for (let k = 0; k < arr.length; k++) dv.setFloat32(k * 4, arr[k], true); return b; };
    // vertex buffer
    const vb = new Uint8Array(nV * 32);
    const dv = new DataView(vb.buffer);
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    let rad = 0;
    for (let v = 0; v < nV; v++) {
      const o = v * 32;
      for (let q = 0; q < 3; q++) {
        const p = pos[v * 3 + q];
        dv.setFloat32(o + q * 4, p, true);
        dv.setFloat32(o + 12 + q * 4, nrm[v * 3 + q], true);
        if (p < lo[q]) lo[q] = p;
        if (p > hi[q]) hi[q] = p;
      }
      dv.setFloat32(o + 24, uv[v * 2], true);
      dv.setFloat32(o + 28, uv[v * 2 + 1], true);
      rad = Math.max(rad, Math.hypot(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]));
    }
    if (!nV) { lo.fill(0); hi.fill(0); }
    const elem = (type, sem, off) => chunk(0x5110, [u16(0), u16(type), u16(sem), u16(off), u16(0)]);
    const geometry = chunk(0x5000, [
      u32(nV),
      chunk(0x5100, [elem(2, 1, 0), elem(2, 4, 12), elem(1, 7, 24)]), // FLOAT3 POSITION, FLOAT3 NORMAL, FLOAT2 TEXCOORD
      chunk(0x5200, [u16(0), u16(32), chunk(0x5210, [vb])]),
    ]);
    const idx32 = nV > 65535;
    const subChunks = subs.map((s) => {
      const ib = new Uint8Array(s.idx.length * (idx32 ? 4 : 2));
      const iv = new DataView(ib.buffer);
      for (let k = 0; k < s.idx.length; k++) { if (idx32) iv.setUint32(k * 4, s.idx[k], true); else iv.setUint16(k * 2, s.idx[k], true); }
      return chunk(0x4000, [str(s.ogreMaterial || s.material), bool(true), u32(s.idx.length), bool(idx32), ib, chunk(0x4010, [u16(4)])]);
    });
    const bounds = chunk(0x9000, [f32([lo[0], lo[1], lo[2], hi[0], hi[1], hi[2], rad])]);
    const names = chunk(0xA000, subs.map((s, k) => chunk(0xA100, [u16(k), str(`sub${k}`)])));
    const meshChunk = chunk(0x3000, [bool(false), geometry, ...subChunks, bounds, names]);
    parts.push(u16(0x1000), str('[MeshSerializer_v1.100]'), meshChunk);
    for (const p of parts) size += p.length;
    return cat(parts);
  }

  /** Read back an OGRE mesh written by writeOgreMesh (used by the self-checks). */
  function readOgreMesh(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let at = 0;
    const u16 = () => { const v = dv.getUint16(at, true); at += 2; return v; };
    const u32 = () => { const v = dv.getUint32(at, true); at += 4; return v; };
    const str = () => { let e = at; while (bytes[e] !== 10) e++; const s = new TextDecoder().decode(bytes.subarray(at, e)); at = e + 1; return s; };
    if (u16() !== 0x1000) throw new Error('bad header');
    const version = str();
    const out = { version, vertexCount: 0, submeshes: [], decl: [] };
    const end = bytes.length;
    function readChunks(limit) {
      while (at < limit) {
        const id = u16(), len = u32(), stop = at - 6 + len;
        if (len < 6 || stop > limit) throw new Error(`bad chunk 0x${id.toString(16)} length ${len}`);
        if (id === 0x3000) { at += 1; readChunks(stop); }
        else if (id === 0x5000) { out.vertexCount = u32(); readChunks(stop); }
        else if (id === 0x5100) readChunks(stop);
        else if (id === 0x5110) { out.decl.push([u16(), u16(), u16(), u16(), u16()]); }
        else if (id === 0x5200) { out.bind = u16(); out.vertexSize = u16(); readChunks(stop); }
        else if (id === 0x5210) { out.vertexBytes = len - 6; out.vertexData = bytes.subarray(at, stop); at = stop; }
        else if (id === 0x4000) {
          const material = str(); const shared = bytes[at++]; const ic = u32(); const i32 = bytes[at++];
          const idx = [];
          for (let k = 0; k < ic; k++) idx.push(i32 ? u32() : u16());
          const sm = { material, shared, idx };
          out.submeshes.push(sm);
          readChunks(stop);
        } else if (id === 0x4010) { out.submeshes[out.submeshes.length - 1].op = u16(); }
        else if (id === 0x9000) { out.bounds = []; for (let k = 0; k < 7; k++) { out.bounds.push(dv.getFloat32(at, true)); at += 4; } }
        else at = stop;
        if (at !== stop) throw new Error(`chunk 0x${id.toString(16)} size mismatch (${at} vs ${stop})`);
      }
    }
    readChunks(end);
    return out;
  }

  /** BeamNG materials.json definitions by material name (mapTo / name / key). */
  function loadMaterialDefs(lib) {
    const defs = new Map();
    for (const [p, data] of lib.materialFiles || []) {
      for (const [key, m] of Object.entries(data)) {
        if (!isDict(m) || (m.class && !/^material$/i.test(m.class))) continue;
        const entry = { def: m, file: p };
        for (const n of [m.mapTo, m.name, key]) if (typeof n === 'string' && !defs.has(n)) defs.set(n, entry);
      }
    }
    return defs;
  }

  /** Find a texture file: BeamNG material files name .png textures that ship as .dds. */
  function findTexture(lib, ref, fromFile) {
    if (typeof ref !== 'string' || !ref) return null;
    let p = ref.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
    const dir = (fromFile || '').toLowerCase().replace(/[^/]*$/, '');
    const cands = [];
    const base = [p];
    if (!p.includes('/') || p.startsWith('./')) base.push(dir + p.replace(/^\.\//, ''));
    for (const b of base) {
      const stem = b.replace(/\.(png|dds|jpe?g|tga|bmp)$/, '');
      cands.push(b, stem + '.dds', stem + '.png', stem + '.jpg', stem + '.jpeg');
    }
    for (const c of cands) { const e = lib.files && lib.files.get(c); if (e) return e; }
    // last resort: same file name anywhere in the mod
    const name = p.split('/').pop().replace(/\.(png|dds|jpe?g|tga|bmp)$/, '');
    for (const ext of ['.dds', '.png', '.jpg']) { const e = lib.filesByName && lib.filesByName.get(name + ext); if (e) return e; }
    return null;
  }

  /**
   * Add the car's 3D model to a convert() result: reads the mod's .dae files and
   * materials, writes one .mesh per flexbody, the flexbodies section of the .truck,
   * an OGRE material file and the textures.
   */
  async function addVisuals(lib, result, opts, log) {
    log = log || (() => {});
    opts = opts || {};
    const plan = result.visualPlan;
    const notes = [];
    const note = (m) => { notes.push(m); };
    if (!plan || !plan.flexbodies.length) { note('This configuration has no 3D model parts (flexbodies).'); return { added: 0, notes }; }
    // Which .dae file has which mesh name (quick scan of node names first)
    // .dae (Collada) first, then BeamNG's compiled .cdae, for meshes no .dae has
    const allFiles = [...new Set((lib.files || new Map()).values())];
    const daeEntries = allFiles.filter((e) => /\.dae$/i.test(e.path)).concat(allFiles.filter((e) => /\.cdae$/i.test(e.path)));
    if (!daeEntries.length) { note('No 3D model files (.dae/.cdae) in the mod, so the body stays as plain panels. Use the full mod zip.'); return { added: 0, notes }; }
    const wanted = new Set([...plan.flexbodies.map((f) => f.mesh), ...(plan.props || []).map((pr) => pr.mesh)]);
    const daeTexts = new Map();
    const dec = new TextDecoder('utf-8');
    const owner = new Map(); // mesh name -> entry
    for (const e of daeEntries) {
      log(`Scanning ${e.path}…`);
      if (/\.cdae$/i.test(e.path)) {
        const bytes = await e.read();
        let names = [];
        try { names = cdaeObjectNames(bytes); } catch (err) { note(`${e.path} is a compiled model in an older format that can't be read yet.`); continue; }
        let hitC = false;
        for (const nm of names) if (wanted.has(nm) && !owner.has(nm)) { owner.set(nm, e); hitC = true; }
        if (hitC) daeTexts.set(e, bytes);
        continue;
      }
      const text = dec.decode(await e.read());
      let hit = false;
      for (const m of text.matchAll(/<node\b[^>]*?\bname="([^"]+)"/g)) if (wanted.has(m[1]) && !owner.has(m[1])) { owner.set(m[1], e); hit = true; }
      for (const m of text.matchAll(/<node\b[^>]*?\bid="([^"]+)"/g)) if (wanted.has(m[1]) && !owner.has(m[1])) { owner.set(m[1], e); hit = true; }
      if (hit) daeTexts.set(e, text);
    }
    const parsed = new Map();
    const daeFor = (e) => {
      if (!parsed.has(e)) {
        log(`Reading 3D model ${e.path}…`);
        const src = daeTexts.get(e);
        parsed.set(e, src instanceof Uint8Array ? parseCdae(src) : parseCollada(src));
        daeTexts.delete(e);
      }
      return parsed.get(e);
    };
    const geometryOf = (dae, item) => (dae.cdae ? cdaeGeometry(item) : colladaGeometry(dae, item));

    const matDefs = loadMaterialDefs(lib);
    const model = plan.model;
    const prefix = String(result.fileBase).replace(/[^A-Za-z0-9_]+/g, '_');
    const ogreMats = new Map(); // BeamNG material -> {ogre name, text}
    const textures = new Map(); // entry -> output name
    const usedTexNames = new Set();
    const missingMats = new Set(), missingTex = new Set();
    const paint = plan.paint || [0.6, 0.6, 0.62];
    // texture jobs: key -> {entry, name, bake}
    function texName(entry, bake) {
      const key = entry.path + (bake ? '|' + bake.mask.path + '|' + bake.paint.join(',') : '');
      if (textures.has(key)) return textures.get(key).name;
      const file = entry.path.split('/').pop();
      let n = bake ? file.replace(/(\.[^.]+)$/, '_painted$1') : file;
      let k = 2;
      while (usedTexNames.has(n.toLowerCase())) n = `${k++}_${n}`;
      usedTexNames.add(n.toLowerCase());
      textures.set(key, { entry, name: n, bake });
      return n;
    }
    const c3 = (a) => a.map((x) => (+x).toFixed(3)).join(' ');
    // RoR flare type for a BeamNG glowMap material (exterior lamps only)
    const glow = plan.glow || {};
    function lightType(key) {
      const gl = glow[key];
      if (!gl) return null;
      // dashboard warning/indicator lamps switch a dashboard or gauge material, or BeamNG's invisible one
      if (/^invis|lamp|gauge|dial|decal|cluster|dash/i.test(String(gl.off || '')) || /^invis|lamp|gauge|dial|decal|cluster|dash/i.test(String(gl.on || ''))) return null;
      // function names vary: lights_lowbeam, lowbeam, signal_L_filament, lowhighbeam_filament_alt ...
      const f = gl.funcs.map((x) => String(x).toLowerCase().replace(/^lights_/, '').replace(/_?(filament|alt|light)+$/g, '').replace(/_+$/, ''));
      if (!f.length) return null;
      if (f.some((x) => /signal_?l$|turn_?l$|blinker_?l$/.test(x))) return 'l';
      if (f.some((x) => /signal_?r$|turn_?r$|blinker_?r$/.test(x))) return 'r';
      if (f.some((x) => /brake/.test(x))) return 'b';
      if (f.some((x) => /reverse/.test(x))) return 'R';
      if (f.some((x) => /fog/.test(x))) return 'g';
      if (f.some((x) => /^lowbeam$|^highbeam$/.test(x)) || (f.some((x) => /lowhighbeam|beam/.test(x)) && /head|beam/i.test(key))) return 'f';
      if (f.some((x) => /lowhighbeam|running|parking|tail|position/.test(x))) return 't'; // front ones become white sidelights
      return null;
    }
    const isTail = (key) => !!glow[key] && glow[key].funcs.some((x) => /lowhighbeam|running|tail/i.test(x));
    const LIGHT_RGB = { f: [1, 1, 0.92], h: [1, 1, 0.92], g: [1, 1, 0.85], t: [0.9, 0.06, 0.03], b: [1, 0.06, 0.03], R: [1, 1, 1], l: [1, 0.55, 0.05], r: [1, 0.55, 0.05] };
    function ogreMaterial(bngName) {
      if (ogreMats.has(bngName)) return ogreMats.get(bngName).name;
      const name = `j2r/${prefix}/${bngName}`;
      const found = matDefs.get(bngName) || matDefs.get((plan.materialAlias || {})[bngName]);
      const def = found ? found.def : null;
      if (!def) missingMats.add(bngName);
      const stages = def && Array.isArray(def.Stages) ? def.Stages.filter(isDict) : [];
      const s0 = stages[0] || {};
      const painted = stages.some((s) => s.instanceDiffuse === true);
      let tex = null, texMissing = false;
      for (const s of stages) {
        const r = s.baseColorMap || s.colorMap || s.diffuseMap;
        if (r) { tex = findTexture(lib, r, found && found.file); if (!tex) { missingTex.add(r); texMissing = true; } break; }
      }
      const hasFactor = Array.isArray(s0.baseColorFactor) || Array.isArray(s0.diffuseColor);
      let color = Array.isArray(s0.baseColorFactor) ? s0.baseColorFactor.slice(0, 3).map(Number) : Array.isArray(s0.diffuseColor) ? s0.diffuseColor.slice(0, 3).map(Number) : [1, 1, 1];
      // texture from the base game (or another car): plain grey, not white
      if (!tex && (!hasFactor || texMissing)) color = texMissing && hasFactor ? color.map((c) => Math.min(0.55, c * 0.55)) : [0.55, 0.55, 0.57];
      // Paint: BeamNG lays the paint over the colour texture through a mask (the paint
      // stage's opacityMap). With the mask we bake the paint into the texture so trim and
      // chrome keep their colour; without it the whole material is tinted.
      let bake = null;
      if (painted && tex && /\.dds$/i.test(tex.path)) {
        const ps = stages.find((st) => st.instanceDiffuse === true);
        const maskEntry = ps && ps.opacityMap && !(+ps.opacityMapUV > 0) ? findTexture(lib, ps.opacityMap, found && found.file) : null;
        if (maskEntry && /\.dds$/i.test(maskEntry.path)) bake = { mask: maskEntry, paint };
      }
      if (painted && !bake) color = color.map((c, q) => c * paint[q]);
      let alpha = 1;
      if (typeof s0.opacityFactor === 'number') alpha = s0.opacityFactor;
      else if (Array.isArray(s0.baseColorFactor) && s0.baseColorFactor.length > 3) alpha = +s0.baseColorFactor[3];
      // Glass: some mods mark it translucent, others only name it glass/window and give it an opacity map
      const glassy = /glass|window|windshield|windscreen/i.test(bngName) || /glass|window|windshield|windscreen/i.test(String((plan.materialAlias || {})[bngName] || ''));
      const translucent = !!def && (def.translucent === true || (glassy && (!!s0.opacityMap || def.translucent !== false)));
      // BeamNG glass gets its see-through look from a separate opacity map; OGRE only has the
      // colour texture's alpha, so translucent materials with an opacity map get a fixed alpha.
      if (translucent && (s0.opacityMap || glassy) && alpha >= 1) alpha = 0.35;
      const L2 = [`material ${name}`, '{', '\treceive_shadows on', '\ttechnique', '\t{', '\t\tpass', '\t\t{'];
      if (/^invis/i.test(bngName) || /^invis/i.test((plan.materialAlias || {})[bngName] || '')) { // BeamNG's invisible helper material (e.g. dashboard lamps when off)
        ogreMats.set(bngName, { name, text: [`material ${name}`, '{', '\ttechnique', '\t{', '\t\tpass', '\t\t{', '\t\t\tcolour_write off', '\t\t\tdepth_write off', '\t\t}', '\t}', '}', ''].join('\n') });
        return name;
      }
      L2.push(`\t\t\tambient ${c3(color)}`);
      L2.push(`\t\t\tdiffuse ${c3(color)} ${(+alpha).toFixed(3)}`);
      L2.push('\t\t\tspecular 0.25 0.25 0.25 1 24');
      const lt = lightType(bngName);
      if (lt) { L2.push(`\t\t\temissive ${c3(LIGHT_RGB[lt])}`); lightMats.set(name, lt); } // RoR turns this on with the lamp's flare
      if (def && def.doubleSided) L2.push('\t\t\tcull_hardware none');
      if (translucent) { L2.push('\t\t\tscene_blend alpha_blend'); L2.push('\t\t\tdepth_write off'); }
      else if (def && (def.alphaTest || +def.alphaRef > 0)) L2.push(`\t\t\talpha_rejection greater_equal ${Math.max(1, Math.min(255, Math.round(+def.alphaRef || 128)))}`);
      if (tex) {
        L2.push('\t\t\ttexture_unit', '\t\t\t{', `\t\t\t\ttexture ${texName(tex, bake)}`, '\t\t\t\ttex_address_mode wrap', '\t\t\t\tfiltering anisotropic', '\t\t\t\tmax_anisotropy 4', '\t\t\t}');
      }
      L2.push('\t\t}', '\t}', '}', '');
      ogreMats.set(bngName, { name, text: L2.join('\n') });
      return name;
    }

    const meshFiles = [];
    const lines = [];
    const missingMesh = [];
    const skippedWheel = [];
    let anchorFixed = 0;
    const mirrorTris = { left: [], right: [] };
    let mirrorsMade = 0;
    const lightTris = new Map(); // flare type -> [{p, n, a, tail}]
    const lightMats = new Map(); // OGRE material -> flare type
    const rimOf = new Map(); // wheel -> rim vertex arrays (to size the tyre)
    const wheelOf = (gname) => {
      for (const w of plan.wheels || []) if (w.groups.includes(gname)) return w;
      const m = /^(?:wheel|wheelhub|hubcap|tire|tyre)_(.+)$/i.exec(gname);
      return m ? (plan.wheels || []).find((w) => w.name.toLowerCase() === m[1].toLowerCase()) || null : null;
    };
    const wheelish = (gname) => /^(wheel|wheelhub|hubcap|tire|tyre)_/i.test(gname) || (plan.wheels || []).some((w) => w.groups.includes(gname));
    let totalVerts = 0, totalTris = 0;
    const byNum = plan.nodes; // number -> {pos, groups}
    const P0 = (n) => byNum[n].pos;
    const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
    const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    let fbIndex = 0;
    for (const fb of plan.flexbodies) {
      // Wheel parts (rims, hubcaps, discs, drums): every group belongs to a wheel, so they
      // go on the tread nodes RoR builds for that wheel and spin with it.
      let wheel = null;
      if (opts.skipWheels && fb.groups.length && fb.groups.every(wheelish)) { skippedWheel.push(fb.mesh); continue; }
      if (fb.groups.length && fb.groups.every(wheelish)) {
        wheel = fb.groups.map(wheelOf).find(Boolean) || null;
        if (!wheel) { skippedWheel.push(fb.mesh); continue; }
      }
      const e = owner.get(fb.mesh);
      if (!e) { missingMesh.push(fb.mesh); continue; }
      const dae = daeFor(e);
      const item = dae.meshes.get(fb.mesh);
      if (!item) { missingMesh.push(fb.mesh); continue; }
      if (!item.cache) item.cache = geometryOf(dae, item);
      const g = item.cache;
      if (!g || !g.subs.length) continue;
      // forset: the nodes of the flexbody's groups
      let forset = fb.nodes.slice();
      // BeamNG flexbody placement (pos / rot / scale), then BeamNG -> RoR axes
      const nV = g.pos.length / 3;
      const world = new Float64Array(nV * 3), wn = new Float64Array(nV * 3);
      const sc = fb.scale || [1, 1, 1];
      const R = fb.rot ? m4.mul(m4.mul(m4.rot(0, 0, 1, fb.rot[2]), m4.rot(0, 1, 0, fb.rot[1])), m4.rot(1, 0, 0, fb.rot[0])) : m4.id();
      const t = fb.pos || [0, 0, 0];
      const off = fb.nodeOffset;
      for (let v = 0; v < nV; v++) {
        const x0 = g.pos[v * 3] * sc[0], y0 = g.pos[v * 3 + 1] * sc[1], z0 = g.pos[v * 3 + 2] * sc[2];
        let x = R[0] * x0 + R[1] * y0 + R[2] * z0 + t[0], y = R[4] * x0 + R[5] * y0 + R[6] * z0 + t[1], z = R[8] * x0 + R[9] * y0 + R[10] * z0 + t[2];
        if (off) { x += Math.sign(x) * off[0]; y += off[1]; z += off[2]; }
        world[v * 3] = x; world[v * 3 + 1] = z; world[v * 3 + 2] = -y;
        const a = g.nrm[v * 3], b = g.nrm[v * 3 + 1], c = g.nrm[v * 3 + 2];
        const nx = R[0] * a + R[1] * b + R[2] * c, ny = R[4] * a + R[5] * b + R[6] * c, nz = R[8] * a + R[9] * b + R[10] * c;
        wn[v * 3] = nx; wn[v * 3 + 1] = nz; wn[v * 3 + 2] = -ny;
      }
      const centroid = [0, 0, 0];
      for (let v = 0; v < nV; v++) for (let q = 0; q < 3; q++) centroid[q] += world[v * 3 + q] / nV;
      if (wheel) forset = [...wheel.tread, wheel.n1, wheel.n2];
      // Too few nodes to hold a mesh: add the nearest body nodes
      if (!wheel && forset.length < 4) {
        const extra = plan.bodyNodes.filter((n) => !forset.includes(n)).sort((a, b) => dist2(byNum[a].pos, centroid) - dist2(byNum[b].pos, centroid));
        forset = forset.concat(extra.slice(0, 6 - forset.length));
        if (fb.nodes.length === 0) note(`${fb.mesh}: its node group (${fb.groups.join(', ') || 'none'}) has no nodes here; attached to the nearest body nodes.`);
      }
      // RoR binds each vertex to its nearest node, the next nearest, and a third one at
      // more than 45 degrees from that line ("VY node not found" otherwise, e.g. a sway bar
      // whose nodes are all in a row). If some node has no such partner, add body nodes.
      const lacksY = (set) => set.some((a) => {
        const others = set.filter((n) => n !== a);
        if (others.length < 2) return true;
        const b = others.reduce((p, q) => (dist2(byNum[q].pos, byNum[a].pos) < dist2(byNum[p].pos, byNum[a].pos) ? q : p));
        const vx = norm(sub(byNum[b].pos, byNum[a].pos));
        return !others.some((c) => c !== b && Math.abs(dot(vx, norm(sub(byNum[c].pos, byNum[a].pos)))) <= Math.SQRT1_2);
      });
      if (!wheel && lacksY(forset)) {
        const extra = plan.bodyNodes.filter((n) => !forset.includes(n)).sort((a, b) => dist2(byNum[a].pos, centroid) - dist2(byNum[b].pos, centroid));
        for (const n of extra) { forset.push(n); if (!lacksY(forset)) break; if (forset.length > fb.nodes.length + 12) break; }
      }
      // Crash spikes: RoR anchors each vertex to its nearest forset node, the next nearest, and
      // a third one roughly at right angles (FlexBody.cpp). A vertex far out from a small
      // anchor triangle swings a long way when that triangle twists in a crash. Where the
      // lever (vertex distance / anchor size) gets big, add the nearest other nodes.
      if (!wheel && !opts.noAnchorFix) {
        const step = Math.max(1, Math.floor(nV / 400));
        const lever = (set) => {
          let worst = 0, at = -1, missing = 0;
          for (let v = 0; v < nV; v += step) {
            const p = [world[v * 3], world[v * 3 + 1], world[v * 3 + 2]];
            const srt = set.slice().sort((a2, b2) => dist2(P0(a2), p) - dist2(P0(b2), p));
            const ref = srt[0], nx = srt[1];
            if (nx === undefined) continue;
            const vx = sub(P0(nx), P0(ref)), lx = Math.hypot(...vx);
            let ly = 0;
            for (const c of srt.slice(2)) { const vt = sub(P0(c), P0(ref)), lt = Math.hypot(...vt); if (lt > 0 && Math.abs(dot(vx, vt) / (lx * lt)) <= Math.SQRT1_2) { ly = lt; break; } }
            // no usable third node: RoR falls back to node 0 ("VY node not found") - worst case
            const lev = ly ? Math.sqrt(dist2(p, P0(ref))) / Math.max(1e-3, Math.min(lx, ly)) : 1e6;
            if (!ly) missing++;
            if (lev > worst) { worst = lev; at = v; }
          }
          return { worst, at, missing, score: missing * 1e3 + Math.min(worst, 999) };
        };
        let lv = lever(forset), added = 0;
        while (lv.worst > 3 && added < 16) {
          const p = [world[lv.at * 3], world[lv.at * 3 + 1], world[lv.at * 3 + 2]];
          const cands = plan.bodyNodes.filter((n) => !forset.includes(n)).sort((a2, b2) => dist2(P0(a2), p) - dist2(P0(b2), p)).slice(0, 8);
          let bestTrial = null;
          const consider = (trial) => { const lt = lever(trial); if (!bestTrial || lt.score < bestTrial.lt.score) bestTrial = { trial, lt }; };
          for (const cand of cands) consider(forset.concat([cand]));
          // ... or drop one of two nodes that sit almost on top of each other (a tiny anchor)
          if (forset.length > 5) {
            const near = forset.slice().sort((a2, b2) => dist2(P0(a2), p) - dist2(P0(b2), p)).slice(0, 2);
            if (dist2(P0(near[0]), P0(near[1])) < 0.08 * 0.08) for (const n of near) consider(forset.filter((x) => x !== n));
          }
          if (!bestTrial || bestTrial.lt.score >= lv.score - 1e-6) break;
          forset = bestTrial.trial; lv = bestTrial.lt; added++;
        }
        if (added) anchorFixed++;
      }
      // Placement frame (ref, x and y nodes)
      const P = (n) => byNum[n].pos;
      // The placement frame must use nodes that exist when the line is read: for wheels,
      // the axle and arm nodes (RoR's tread nodes are only allowed in the forset).
      const frameSet = wheel ? [wheel.n1, wheel.n2, wheel.arm] : forset;
      const ref = wheel ? wheel.n1 : frameSet.reduce((a, b) => (dist2(P(b), centroid) < dist2(P(a), centroid) ? b : a));
      const nx = wheel ? wheel.n2 : frameSet.filter((n) => n !== ref).reduce((a, b) => (dist2(P(b), P(ref)) > dist2(P(a), P(ref)) ? b : a));
      const dx = sub(P(nx), P(ref));
      const ny = wheel ? wheel.arm : frameSet.filter((n) => n !== ref && n !== nx).reduce((a, b) => (Math.hypot(...cross(dx, sub(P(b), P(ref)))) > Math.hypot(...cross(dx, sub(P(a), P(ref)))) ? b : a));
      const dy = sub(P(ny), P(ref));
      if (Math.hypot(...cross(dx, dy)) < 1e-6) { note(`${fb.mesh}: its nodes are all in a line; skipped.`); continue; }
      // RoR (FlexBody.cpp): normal = |dy x dx|, refX = |dx|, refY = refX x normal; mesh axes (X, Y, Z) = (refX, normal, refY)
      const normal = norm(cross(dy, dx));
      const ax = norm(dx);
      const az = cross(ax, normal);
      const lp = new Float64Array(nV * 3), ln = new Float64Array(nV * 3);
      const o = P(ref);
      for (let v = 0; v < nV; v++) {
        const d = [world[v * 3] - o[0], world[v * 3 + 1] - o[1], world[v * 3 + 2] - o[2]];
        const nn = [wn[v * 3], wn[v * 3 + 1], wn[v * 3 + 2]];
        lp[v * 3] = dot(d, ax); lp[v * 3 + 1] = dot(d, normal); lp[v * 3 + 2] = dot(d, az);
        ln[v * 3] = dot(nn, ax); ln[v * 3 + 1] = dot(nn, normal); ln[v * 3 + 2] = dot(nn, az);
      }
      if (wheel && !/brake|drum|disc|caliper|hub_|centercap|hubcap/i.test(fb.mesh)) (rimOf.get(wheel) || rimOf.set(wheel, []).get(wheel)).push(world);
      // Mirror glass becomes a working RoR mirror (a prop); lamp lenses tell where the flares go
      let subsList = g.subs;
      const triInfo = (idx, t) => {
        const a = idx[t], b = idx[t + 1], c = idx[t + 2];
        const A = [world[a * 3], world[a * 3 + 1], world[a * 3 + 2]], B = [world[b * 3], world[b * 3 + 1], world[b * 3 + 2]], C = [world[c * 3], world[c * 3 + 1], world[c * 3 + 2]];
        const area = Math.hypot(...cross(sub(B, A), sub(C, A))) / 2;
        const vn = [0, 1, 2].map((q) => wn[a * 3 + q] + wn[b * 3 + q] + wn[c * 3 + q]);
        return { A, B, C, area, n: norm(vn).map((x) => x * area), p: [0, 1, 2].map((q) => (A[q] + B[q] + C[q]) / 3) };
      };
      if (!wheel && g.subs.some((s) => s.material === 'mirror')) {
        const keep = [];
        for (const s of g.subs) {
          if (s.material !== 'mirror') { keep.push(s); continue; }
          const rest = [];
          for (let t = 0; t < s.idx.length; t += 3) {
            const ti = triInfo(s.idx, t);
            const side = ti.p[0] > 0.3 ? 'left' : ti.p[0] < -0.3 ? 'right' : null;
            if (side) mirrorTris[side].push([ti.A, ti.B, ti.C, ti.n]); else rest.push(s.idx[t], s.idx[t + 1], s.idx[t + 2]);
          }
          if (rest.length) keep.push({ material: s.material, idx: rest });
        }
        subsList = keep;
      }
      for (const s of subsList) {
        const type = lightType(s.material);
        if (!type) continue;
        if (!lightTris.has(type)) lightTris.set(type, []);
        for (let t = 0; t < s.idx.length; t += 3) { const ti = triInfo(s.idx, t); lightTris.get(type).push({ p: ti.p, n: ti.n, a: ti.area, tail: isTail(s.material), mat: s.material }); }
      }
      if (!subsList.length) continue;
      const subsOut = subsList.map((s) => ({ material: s.material, ogreMaterial: ogreMaterial(s.material), idx: s.idx }));
      const meshName = `${prefix}-${String(fbIndex++).padStart(3, '0')}-${fb.mesh.replace(/[^A-Za-z0-9_.-]+/g, '_')}.mesh`;
      meshFiles.push({ path: meshName, data: writeOgreMesh(lp, ln, g.uv, subsOut) });
      totalVerts += nV;
      totalTris += subsOut.reduce((s, x) => s + x.idx.length / 3, 0);
      lines.push(`; ${fb.mesh} (part ${fb.part})`);
      lines.push(`${plan.num(ref)}, ${plan.num(nx)}, ${plan.num(ny)}, 0, 0, 0, 0, 0, 0, ${meshName}`);
      lines.push(`forset ${ranges(forset.map(plan.num).map(Number))}`);
      if (opts.previewData) (result.preview = result.preview || []).push({ mesh: fb.mesh, world, idx: g.subs.map((s) => s.idx) });
    }
    // Tyres: the mod's tyre models are usually base-game files, so build one that fits the
    // rim (inner radius measured from the rim mesh) and the physics tyre (outer radius),
    // attached to the tread nodes so it squashes and spins. RoR's own plain wheel drawing
    // is then hidden for that wheel.
    const hiddenMat = `j2r/${prefix}/hidden`;
    const tyreMat = `j2r/${prefix}/tyre`;
    const tyred = [];
    const rimMat = `j2r/${prefix}/rim`;
    let rimsMade = 0;
    // A mesh turned around the wheel axle from a profile of [axial (x half-width), radius]
    // points, attached to the wheel's tread nodes like the other wheel parts.
    function lathe(w, prof, t0, h, mat, label, normalCentre) {
      const c = w.center, a = w.axis;
      const segs = 48;
      const u = norm(Math.abs(a[1]) < 0.9 ? cross(a, [0, 1, 0]) : cross(a, [1, 0, 0])), vv = cross(a, u);
      const pos = [], nrm = [], uv = [], idx = [];
      for (let sgi = 0; sgi <= segs; sgi++) {
        const ang = 2 * Math.PI * sgi / segs, ca = Math.cos(ang), sa = Math.sin(ang);
        const dir = [u[0] * ca + vv[0] * sa, u[1] * ca + vv[1] * sa, u[2] * ca + vv[2] * sa];
        for (const [tt, rr] of prof) {
          const ax = t0 + tt * h;
          pos.push(c[0] + a[0] * ax + dir[0] * rr, c[1] + a[1] * ax + dir[1] * rr, c[2] + a[2] * ax + dir[2] * rr);
          const [nr0, nt0] = normalCentre(tt, rr);
          const nr = norm([dir[0] * nr0 + a[0] * nt0, dir[1] * nr0 + a[1] * nt0, dir[2] * nr0 + a[2] * nt0]);
          nrm.push(...nr); uv.push(sgi / segs, 0);
        }
      }
      const np = prof.length;
      for (let sgi = 0; sgi < segs; sgi++) for (let k = 0; k + 1 < np; k++) { const i0 = sgi * np + k, i1 = i0 + np; idx.push(i0, i1, i0 + 1, i0 + 1, i1, i1 + 1); }
      // into the flexbody frame (axle node 1, axle node 2, arm node), as for the other meshes
      const o = P0(w.n1), fx = sub(P0(w.n2), o), fy = sub(P0(w.arm), o);
      const fnorm = norm(cross(fy, fx)), fax = norm(fx), faz = cross(fax, fnorm);
      const nV = pos.length / 3, lp = new Float64Array(nV * 3), ln = new Float64Array(nV * 3);
      for (let v = 0; v < nV; v++) {
        const dd = [pos[v * 3] - o[0], pos[v * 3 + 1] - o[1], pos[v * 3 + 2] - o[2]], nn = [nrm[v * 3], nrm[v * 3 + 1], nrm[v * 3 + 2]];
        lp[v * 3] = dot(dd, fax); lp[v * 3 + 1] = dot(dd, fnorm); lp[v * 3 + 2] = dot(dd, faz);
        ln[v * 3] = dot(nn, fax); ln[v * 3 + 1] = dot(nn, fnorm); ln[v * 3 + 2] = dot(nn, faz);
      }
      const meshName = `${prefix}-${label}-${w.name.replace(/[^A-Za-z0-9_]+/g, '_')}.mesh`;
      meshFiles.push({ path: meshName, data: writeOgreMesh(lp, ln, Float64Array.from(uv), [{ material: label, ogreMaterial: mat, idx }]) });
      totalVerts += nV; totalTris += idx.length / 3;
      lines.push(`; ${label} ${w.name} (built for the wheel)`);
      lines.push(`${plan.num(w.n1)}, ${plan.num(w.n2)}, ${plan.num(w.arm)}, 0, 0, 0, 0, 0, 0, ${meshName}`);
      lines.push(`forset ${ranges([...w.tread, w.n1, w.n2])}`);
      if (opts.previewData) (result.preview = result.preview || []).push({ mesh: label, world: Float64Array.from(pos), idx: [idx] });
    }
    for (const w of opts.skipWheels ? [] : plan.wheels || []) {
      const rims = rimOf.get(w) || null;
      const c = w.center, a = w.axis;
      const R = w.radius;
      const h = Math.max(0.06, (w.tireWidth > 0.05 ? w.tireWidth : Math.hypot(...sub(P0(w.n2), P0(w.n1)))) / 2);
      let rimR = 0, t0 = 0;
      if (rims) {
        let axSum = 0, axN = 0;
        const radial = (q) => { const d = [q[0] - c[0], q[1] - c[1], q[2] - c[2]]; const t = dot(d, a); return [Math.hypot(d[0] - a[0] * t, d[1] - a[1] * t, d[2] - a[2] * t), t]; };
        for (const arr of rims) for (let v = 0; v < arr.length; v += 3) { const [r0] = radial([arr[v], arr[v + 1], arr[v + 2]]); if (r0 > rimR) rimR = r0; }
        for (const arr of rims) for (let v = 0; v < arr.length; v += 3) { const [r0, t] = radial([arr[v], arr[v + 1], arr[v + 2]]); if (r0 > rimR * 0.9) { axSum += t; axN++; } }
        t0 = axN ? axSum / axN : 0;
        if (!(rimR > 0.05) || rimR > R * 0.97) continue;
      } else {
        // The rim model is a base-game part: build a plain steel rim to go with the tyre
        rimR = w.rimRadius > 0.08 && w.rimRadius < R * 0.9 ? w.rimRadius : R * 0.62;
        const out = Math.sign(dot(a, [Math.sign(c[0]) || 1, 0, 0])) || 1; // +1 if the axle points outward
        const rr = rimR * 0.98;
        const rimProf = [[-0.85, rr * 0.94], [-0.88, rr], [0.88, rr], [0.85, rr * 0.94]];
        lathe(w, rimProf, 0, h, rimMat, 'rim', (tt, r0) => [1, 0]);
        // the wheel face: a dish from the rim lip to a centre hub, on the outer side
        const f = out;
        const faceProf = [[0.82 * f, rr * 0.93], [0.6 * f, rr * 0.72], [0.55 * f, rr * 0.45], [0.62 * f, rr * 0.3], [0.7 * f, rr * 0.18], [0.72 * f, 0.001]];
        lathe(w, faceProf, 0, h, rimMat, 'rimface', () => [0.15, f]);
        rimsMade++;
      }
      const ri = rimR * 0.97, d = R - ri;
      const prof = [[-0.86, ri], [-0.97, ri + 0.15 * d], [-1, ri + 0.5 * d], [-0.96, ri + 0.84 * d], [-0.84, R - 0.012], [-0.62, R], [0.62, R], [0.84, R - 0.012], [0.96, ri + 0.84 * d], [1, ri + 0.5 * d], [0.97, ri + 0.15 * d], [0.86, ri]];
      const midR = (R + ri) / 2;
      lathe(w, prof, t0, h, tyreMat, 'tyre', (tt, rr) => [rr - midR, tt * h * 1.5]);
      tyred.push(w.name);
    }
    if (anchorFixed) note(`${anchorFixed} part(s) got extra anchor nodes so their mesh doesn't spike in crashes.`);
    if (rimsMade) note(`${rimsMade} wheel(s) use a rim model from the base game; a plain steel rim was built instead.`);
    // ---- props (steering wheel, gauge needles, pedals), working mirrors, lights ----
    const propLines = [];
    const flareLines = [];
    const bindLines = [];
    const propNotes = [];
    // Solve p - ref = a*dx + b*dy + c*n (RoR places props/flares this way)
    const solve3 = (cols, r) => {
      const [A, B, C] = cols;
      const det = dot(A, cross(B, C));
      if (Math.abs(det) < 1e-12) return null;
      return [dot(r, cross(B, C)) / det, dot(A, cross(r, C)) / det, dot(A, cross(B, r)) / det];
    };
    const nearestBody = (p, k) => plan.bodyNodes.slice().sort((a, b) => dist2(P0(a), p) - dist2(P0(b), p)).slice(0, k);
    // A frame (ref, x, y) whose plane is well defined near point p
    function frameNear(p, given) {
      if (given && given.every((n) => n !== null && n !== undefined && byNum[n])) {
        const dx = sub(P0(given[1]), P0(given[0])), dy = sub(P0(given[2]), P0(given[0]));
        if (Math.hypot(...cross(dx, dy)) > 1e-4) return given;
      }
      const c = nearestBody(p, 10);
      for (let i = 0; i < c.length; i++) for (let j = 0; j < c.length; j++) for (let k = 0; k < c.length; k++) {
        if (i === j || j === k || i === k) continue;
        const dx = sub(P0(c[j]), P0(c[i])), dy = sub(P0(c[k]), P0(c[i]));
        if (Math.hypot(...dx) > 0.05 && Math.hypot(...dy) > 0.05 && Math.hypot(...cross(norm(dx), norm(dy))) > 0.5) return [c[i], c[j], c[k]];
      }
      return null;
    }
    const fixed = (x, d) => (+x).toFixed(d === undefined ? 4 : d);
    let propCount = 0;
    /**
     * A rigid RoR prop. Vertices are world (RoR) coordinates; the prop turns around
     * `axis` through `pivot`: RoR builds the prop rotation as Rz * Ry * Rx, so ry and rz
     * point the prop's X axis along `axis` and x-rotation animations turn around it.
     */
    function addProp(pos, nrm, uv, subs, pivot, axis, frame, staticDeg, anim, fileName) {
      const [r0, x0, y0] = frame;
      const dx = sub(P0(x0), P0(r0)), dy = sub(P0(y0), P0(r0));
      const n = norm(cross(dy, dx)), fx = norm(dx), fz = cross(fx, n); // RoR prop frame columns: (refx, normal, refy)
      const al = [dot(axis, fx), dot(axis, n), dot(axis, fz)];
      const ry = -Math.asin(Math.max(-1, Math.min(1, al[2]))), rz = Math.atan2(al[1], al[0]);
      // Q = F * Rz * Ry: columns are the prop's local axes in world space
      const rotZ = (v) => [v[0] * Math.cos(rz) - v[1] * Math.sin(rz), v[0] * Math.sin(rz) + v[1] * Math.cos(rz), v[2]];
      const rotY = (v) => [v[0] * Math.cos(ry) + v[2] * Math.sin(ry), v[1], -v[0] * Math.sin(ry) + v[2] * Math.cos(ry)];
      const toWorld = (v) => { const l = rotZ(rotY(v)); return [fx[0] * l[0] + n[0] * l[1] + fz[0] * l[2], fx[1] * l[0] + n[1] * l[1] + fz[1] * l[2], fx[2] * l[0] + n[2] * l[1] + fz[2] * l[2]]; };
      const qx = toWorld([1, 0, 0]), qy = toWorld([0, 1, 0]), qz = toWorld([0, 0, 1]);
      const nV = pos.length / 3, lp = new Float64Array(nV * 3), ln = new Float64Array(nV * 3);
      for (let v = 0; v < nV; v++) {
        const d = [pos[v * 3] - pivot[0], pos[v * 3 + 1] - pivot[1], pos[v * 3 + 2] - pivot[2]], nn = [nrm[v * 3], nrm[v * 3 + 1], nrm[v * 3 + 2]];
        lp[v * 3] = dot(d, qx); lp[v * 3 + 1] = dot(d, qy); lp[v * 3 + 2] = dot(d, qz);
        ln[v * 3] = dot(nn, qx); ln[v * 3 + 1] = dot(nn, qy); ln[v * 3 + 2] = dot(nn, qz);
      }
      const off = solve3([dx, dy, n], sub(pivot, P0(r0)));
      if (!off) return false;
      const meshName = fileName || `j2r-${prefix}-prop${String(propCount++).padStart(2, '0')}.mesh`;
      meshFiles.push({ path: meshName, data: writeOgreMesh(lp, ln, uv, subs) });
      totalVerts += nV; totalTris += subs.reduce((s2, x) => s2 + x.idx.length / 3, 0);
      propLines.push(`${plan.num(r0)}, ${plan.num(x0)}, ${plan.num(y0)}, ${fixed(off[0])}, ${fixed(off[1])}, ${fixed(off[2])}, ${fixed(staticDeg, 3)}, ${fixed(ry * 180 / Math.PI, 3)}, ${fixed(rz * 180 / Math.PI, 3)}, ${meshName}`);
      if (anim) propLines.push(`add_animation ${fixed(anim.ratio, 4)}, -100000, 100000, source: ${anim.source}, mode: x-rotation`);
      if (opts.previewData) (result.preview = result.preview || []).push({ mesh: meshName, world: Float64Array.from(pos), idx: subs.map((s2) => s2.idx), prop: { pivot, axis } });
      return true;
    }
    const toR = (x, y, z) => [x, z, -y];
    const rearward = [-plan.fwd[0], -plan.fwd[1], -plan.fwd[2]];
    // Props crash RoR 2026.01 on spawn in some combinations (found with test builds), so
    // they're only added when asked for (opts.props: 'all' | 'static' | 'steering' | 'gauges').
    const propMode = opts.props || 'all';
    const isNeedle = (pr) => /^(wheelspeed|rpm|rpmtacho|fuel|watertemp|oiltemp)$/i.test(pr.func) && /needle|gauge|tacho|speedo/i.test(pr.mesh);
    const propWanted = (pr) => (opts.needles !== false || !isNeedle(pr)) && (propMode === 'all' || propMode === 'static' || (propMode === 'steering' && pr.func.toLowerCase() === 'steering') || (propMode === 'gauges' && pr.func.toLowerCase() !== 'steering' && /wheelspeed|rpm|fuel|temp|throttle|brake|clutch|parkingbrake/i.test(pr.func)));
    for (const pr of (plan.props || []).filter(propWanted)) {
      const e = owner.get(pr.mesh);
      const item = e ? daeFor(e).meshes.get(pr.mesh) : null;
      if (!item) { propNotes.push(pr.mesh); continue; }
      if (!item.cache) item.cache = geometryOf(daeFor(e), item);
      const g = item.cache;
      if (!g || !g.subs.length) continue;
      const M = item.matrix;
      const pivot = toR(M[3], M[7], M[11]);
      const nV = g.pos.length / 3, world = new Float64Array(nV * 3), wn = new Float64Array(nV * 3);
      for (let v = 0; v < nV; v++) {
        world.set(toR(g.pos[v * 3], g.pos[v * 3 + 1], g.pos[v * 3 + 2]), v * 3);
        wn.set(toR(g.nrm[v * 3], g.nrm[v * 3 + 1], g.nrm[v * 3 + 2]), v * 3);
      }
      // rotation axis: the prop's rotation vector in the mesh's own (Collada node) frame
      const m = Math.hypot(...pr.rotation);
      let axis = [1, 0, 0];
      if (m > 1e-9) { const r = pr.rotation.map((x) => x / m); axis = norm(toR(M[0] * r[0] + M[1] * r[1] + M[2] * r[2], M[4] * r[0] + M[5] * r[1] + M[6] * r[2], M[8] * r[0] + M[9] * r[1] + M[10] * r[2])); }
      // BeamNG: angle = rotation * (clamp(value, min, max) + offset) * multiplier
      const k = m * pr.multiplier;
      const clamp = (v) => Math.max(pr.min, Math.min(pr.max, v));
      const f = pr.func.toLowerCase();
      let anim = null, staticDeg = k * (clamp(0) + pr.offset);
      if (m > 1e-9) {
        if (f === 'steering') {
          // turn clockwise (seen by the driver) when steering right; RoR's steering state is +1 at full right lock
          if (dot(axis, rearward) < 0) axis = axis.map((x) => -x);
          anim = { source: 'steeringwheel', ratio: -plan.steeringLock * pr.multiplier };
          staticDeg = 0;
        } else if (f === 'wheelspeed') { anim = { source: 'speedo', ratio: -k * 140 / 3 }; staticDeg = k * pr.offset; } // RoR: -3 * (m/s) / 140
        else if ((f === 'rpm' || f === 'rpmtacho') && /needle|tacho/i.test(pr.mesh)) { anim = { source: 'tacho', ratio: -k * plan.shiftUpRPM }; staticDeg = k * pr.offset; }
        else if (f === 'throttle') { anim = { source: 'accel', ratio: -k }; staticDeg = k * (pr.offset - 0.06); }
        else if (f === 'brake') { anim = { source: 'brakes', ratio: -k }; staticDeg = k * pr.offset; }
        else if (f === 'clutch') { anim = { source: 'clutch', ratio: -k }; staticDeg = k * pr.offset; }
        else if (f === 'parkingbrake') { anim = { source: 'parking', ratio: -k }; staticDeg = k * pr.offset; }
        else if (f === 'fuel') staticDeg = k * (clamp(0.7) + pr.offset); // fuel is a 0-1 fraction; shown at 70 %
        else if (f === 'watertemp' || f === 'oiltemp') staticDeg = k * (clamp(90) + pr.offset);
      }
      // Gauge needles: checked against the Mistral's dial texture, BeamNG's needle angle is
      // measured from the opposite end of the needle (rate and direction already match)
      if (isNeedle(pr)) staticDeg += 180;
      const frame = frameNear(pivot, [pr.ref, pr.nx, pr.ny]);
      if (!frame) continue;
      const subs = g.subs.map((s2) => ({ material: s2.material, ogreMaterial: ogreMaterial(s2.material), idx: s2.idx }));
      addProp(world, wn, g.uv, subs, pivot, axis, frame, staticDeg, propMode === 'static' ? null : anim);
    }

    // Mirrors: BeamNG mirror glass uses the material "mirror", like RoR. A RoR prop whose
    // mesh name contains leftmirror/rightmirror and uses that material shows the view behind.
    for (const [side, tris] of Object.entries(opts.mirrors ? mirrorTris : {})) {
      if (!tris.length) continue;
      const pos = [], nrm = [], uv = [], idx = [];
      let cen = [0, 0, 0], an = [0, 0, 0];
      for (const t of tris) { for (let q = 0; q < 3; q++) cen = cen.map((c2, i) => c2 + t[q][i] / (tris.length * 3)); an = an.map((c2, i) => c2 + t[3][i]); }
      an = norm(an);
      const u = norm(Math.abs(an[1]) < 0.9 ? cross([0, 1, 0], an) : cross([1, 0, 0], an)), w = cross(an, u);
      let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
      for (const t of tris) for (let q = 0; q < 3; q++) { const d = sub(t[q], cen); const a2 = [dot(d, u), dot(d, w)]; lo = lo.map((x, i) => Math.min(x, a2[i])); hi = hi.map((x, i) => Math.max(x, a2[i])); }
      for (const t of tris) for (let q = 0; q < 3; q++) {
        const d = sub(t[q], cen);
        pos.push(...t[q]); nrm.push(...an);
        uv.push(1 - (dot(d, u) - lo[0]) / ((hi[0] - lo[0]) || 1), 1 - (dot(d, w) - lo[1]) / ((hi[1] - lo[1]) || 1));
        idx.push(idx.length);
      }
      const frame = frameNear(cen, null);
      if (frame && addProp(Float64Array.from(pos), Float64Array.from(nrm), Float64Array.from(uv), [{ material: 'mirror', ogreMaterial: 'mirror', idx }], cen, [1, 0, 0], frame, 0, null, `j2r-${prefix}-${side}mirror.mesh`)) mirrorsMade++;
    }

    // Lights: one RoR flare per lamp (found from the lamp's lens in the model), and the
    // lens material glows while that flare is on ('materialflarebindings').
    const flareIndex = new Map(); // type -> first flare index
    const carCenter = plan.bodyNodes.reduce((acc, nn) => acc.map((c2, i) => c2 + P0(nn)[i] / plan.bodyNodes.length), [0, 0, 0]);
    const along = (p) => dot(sub(p, carCenter), plan.fwd);
    let nFlares = 0;
    const flareTypesOrder = ['f', 'h', 'g', 't', 'b', 'R', 'l', 'r'];
    // opts.lights: true, or {beams: false} (no headlight beams), {lenses: false} (lenses don't glow)
    // Default: flares and headlight beams; glowing lenses (materialflarebindings) crashed RoR 2026.01
    const lightOpt = opts.lights === undefined ? { lenses: false } : opts.lights === true ? {} : opts.lights || null;
    for (const type of lightOpt ? flareTypesOrder.filter((t) => lightOpt.beams !== false || !['f', 'h', 'g'].includes(t)) : []) {
      const tris = lightTris.get(type) || [];
      const clusters = new Map();
      // one lamp per material and side (a material can cover both headlights) ...
      for (const t of tris) {
        const key = `${t.mat}|${t.p[0] > 0.12 ? 'L' : t.p[0] < -0.12 ? 'R' : 'C'}`;
        if (!clusters.has(key)) clusters.set(key, { a: 0, p: [0, 0, 0], n: [0, 0, 0], pts: [] });
        const c2 = clusters.get(key);
        c2.a += t.a; c2.p = c2.p.map((x, i) => x + t.p[i] * t.a); c2.n = c2.n.map((x, i) => x + t.n[i]); c2.tail = c2.tail || t.tail;
        if (c2.pts.length < 4000) c2.pts.push(t.p);
      }
      // ... then lens + housing of the same lamp (close together) become one
      const lamps = [];
      for (const c2 of clusters.values()) {
        if (c2.a < 1e-5) continue;
        const p = c2.p.map((x) => x / c2.a);
        const same = lamps.find((l2) => Math.hypot(...sub(l2.p, p)) < 0.25);
        if (same) { const a2 = same.a + c2.a; same.p = same.p.map((x, i) => (x * same.a + p[i] * c2.a) / a2); same.n = same.n.map((x, i) => x + c2.n[i]); same.a = a2; same.tail = same.tail || c2.tail; same.pts = same.pts.concat(c2.pts); }
        else lamps.push({ a: c2.a, p, n: c2.n.slice(), tail: c2.tail, pts: c2.pts.slice() });
      }
      const made = [];
      for (const c2 of lamps) {
        const p = c2.p;
        let out = Math.hypot(...c2.n) > 1e-6 ? norm(c2.n) : null;
        const radial = sub(p, carCenter);
        if (!out || Math.abs(dot(out, norm(radial))) < 0.2) out = norm(Math.abs(along(p)) > 1 ? plan.fwd.map((x) => x * Math.sign(along(p))) : radial);
        if (dot(out, radial) < 0) out = out.map((x) => -x);
        // shine level (lens normals of curved lenses point up); headlights straight ahead
        const upv = plan.up || [0, 1, 0];
        out = norm(sub(out, upv.map((x) => x * dot(out, upv))));
        if (type === 'f' || type === 'h' || type === 'g') out = plan.fwd.slice();
        // frame whose normal points INTO the car (RoR shows the flare when seen from outside, and shines along -normal)
        const cand = nearestBody(p, 12);
        let best = null;
        for (let i = 0; i < Math.min(5, cand.length); i++) for (let j = 0; j < cand.length; j++) for (let k2 = 0; k2 < cand.length; k2++) {
          if (j === i || k2 === i || k2 === j) continue;
          const dx = sub(P0(cand[j]), P0(cand[i])), dy = sub(P0(cand[k2]), P0(cand[i]));
          if (Math.hypot(...dx) < 0.04 || Math.hypot(...dy) < 0.04) continue;
          const nn = norm(cross(dy, dx));
          const facing = -dot(nn, out);
          if (!(facing > 0.6)) continue;
          const dist = Math.abs(dot(sub(p, P0(cand[i])), nn));
          const score = dist + 0.15 * (1 - facing);
          if (!best || score < best.score) best = { score, f: [cand[i], cand[j], cand[k2]], dx, dy, nn };
        }
        if (!best) continue;
        const o = solve3([best.dx, best.dy, best.nn], sub(p, P0(best.f[0])));
        if (!o) continue;
        // RoR puts the flare on the plane of its three nodes (ref + ox*dx + oy*dy), usually inside
        // the bodywork, then pulls it 0.1 m x (last offset) along -normal (= outward). Pull it to
        // just in front of the outermost point of the lens so the housing doesn't hide it.
        const outer = Math.max(0, ...c2.pts.map((q) => dot(sub(q, p), out)));
        const onPlane = [0, 1, 2].map((i) => P0(best.f[0])[i] + o[0] * best.dx[i] + o[1] * best.dy[i]);
        const target = [0, 1, 2].map((i) => p[i] + out[i] * (outer + 0.03));
        const pull = Math.max(0.5, Math.min(30, dot(sub(target, onPlane), best.nn.map((x) => -x)) / 0.1));
        // negative size: RoR shows the glow from every angle (only headlights need a direction,
        // for their beam) - so a lamp whose lens faces an odd way is still seen
        const size = type === 'f' || type === 'h' ? 0.6 : type === 'g' ? -0.45 : -0.35;
        // a lamp lit with the headlights at the front is a (white) sidelight, at the back a tail light
        const ftype = type === 't' && along(p) > 0 ? 's' : type;
        // headlights (positive size) get their pull scaled by the viewing angle in RoR, so a long
        // pull would make the glow wander; then give up the beam and keep a fixed glow instead
        const fsize = size > 0 && pull > 2.5 ? -size : size;
        flareLines.push(`${best.f.map(plan.num).join(', ')}, ${fixed(o[0])}, ${fixed(o[1])}, ${fixed(pull, 2)}, ${ftype}, -1, ${type === 'l' || type === 'r' ? -1 : 0}, ${fsize}, default`);
        made.push(nFlares++);
        // brake lamps that are also tail lamps: a tail flare too, so they glow at night
        if (type === 'b' && c2.tail) { flareLines.push(`${best.f.map(plan.num).join(', ')}, ${fixed(o[0])}, ${fixed(o[1])}, ${fixed(pull, 2)}, t, -1, 0, -0.25, default`); nFlares++; }
      }
      if (made.length) flareIndex.set(type, made[0]);
    }
    if (!lightOpt || lightOpt.lenses !== false) for (const [matName, type] of lightMats) if (flareIndex.has(type)) bindLines.push(`${flareIndex.get(type)}, ${matName}`);

    if (propNotes.length) note(`${propNotes.length} prop(s) are not in the mod's model files: ${[...new Set(propNotes)].join(', ')}`);
    if (skippedWheel.length) note(`Wheel parts that match no wheel were left out: ${[...new Set(skippedWheel)].join(', ')}`);
    if (tyred.length) note(`Tyres built to fit the rims on ${tyred.length} wheel(s) (the mod's own tyre models come from the base game).`);
    if (missingMesh.length) note(`${missingMesh.length} 3D part(s) are not in the mod's model files (base-game parts): ${[...new Set(missingMesh)].slice(0, 25).join(', ')}${missingMesh.length > 25 ? '…' : ''}`);
    if (missingMats.size) note(`${missingMats.size} material(s) come from the base game and are shown in plain grey: ${[...missingMats].slice(0, 20).join(', ')}${missingMats.size > 20 ? '…' : ''}`);
    if (missingTex.size) note(`${missingTex.size} texture(s) were not found in the mod: ${[...missingTex].slice(0, 12).join(', ')}${missingTex.size > 12 ? '…' : ''}`);
    if (!lines.length) return { added: 0, notes };

    // .truck: flexbodies before 'end'; hide the plain body panels (still there for physics)
    const fbSection = ['; 3D model (BeamNG flexbodies): each mesh follows the nodes of its part', 'flexbodies', ...lines, '',
      ...(propLines.length ? ['; steering wheel, gauge needles, pedals and mirrors (rigid props; x-rotation turns them around their real axis)', 'props', ...propLines, ''] : []),
      ...(flareLines.length ? ['; lamps: ref, x, y, offset x, offset y, pull, type, control, blink, size, material', 'flares2', ...flareLines, ''] : []),
      ...(bindLines.length ? ['; lamp lenses glow while their flare is on', 'materialflarebindings', ...bindLines, ''] : []),
    ].join('\n');
    result.truck = result.truck.replace(/\nend\n*$/, `\n${fbSection}\nend\n`);
    for (const name of tyred) result.truck = result.truck.replace(new RegExp(`, tracks/wheelface, tracks/wheelband1 ;${name.replace(/[^A-Za-z0-9_]/g, '\\$&')}$`, 'm'), `, ${hiddenMat}, ${hiddenMat} ;${name}`);
    if (tyred.length) {
      ogreMats.set('#hidden', { name: hiddenMat, text: [`material ${hiddenMat}`, '{', '\ttechnique', '\t{', '\t\tpass', '\t\t{', '\t\t\tcolour_write off', '\t\t\tdepth_write off', '\t\t}', '\t}', '}', ''].join('\n') });
      ogreMats.set('#rim', { name: rimMat, text: [`material ${rimMat}`, '{', '\treceive_shadows on', '\ttechnique', '\t{', '\t\tpass', '\t\t{', '\t\t\tambient 0.45 0.46 0.48', '\t\t\tdiffuse 0.55 0.56 0.58 1', '\t\t\tspecular 0.6 0.6 0.6 1 40', '\t\t\tcull_hardware none', '\t\t}', '\t}', '}', ''].join('\n') });
      ogreMats.set('#tyre', { name: tyreMat, text: [`material ${tyreMat}`, '{', '\treceive_shadows on', '\ttechnique', '\t{', '\t\tpass', '\t\t{', '\t\t\tambient 0.07 0.07 0.07', '\t\t\tdiffuse 0.07 0.07 0.07 1', '\t\t\tspecular 0.12 0.12 0.12 1 10', '\t\t\tcull_hardware none', '\t\t}', '\t}', '}', ''].join('\n') });
    }
    const matFile = result.files.find((f) => /\.material$/.test(f.path));
    if (matFile && !opts.keepPanels) {
      matFile.data = matFile.data.replace(/\{[\s\S]*$/, ['{', '\ttechnique', '\t{', '\t\tpass', '\t\t{', '\t\t\tcolour_write off', '\t\t\tdepth_write off', '\t\t}', '\t}', '}', ''].join('\n'));
    }
    result.files.find((f) => /\.truck$/.test(f.path)).data = result.truck;
    result.files.push({ path: `${prefix}-model.material`, data: [...ogreMats.values()].map((m) => m.text).join('\n') });
    for (const m of meshFiles) result.files.push(m);
    // BeamNG's BC7 textures show black on RoR's Direct3D 9 renderer: re-encode them as DXT
    let texBytes = 0, converted = 0, k2 = 0;
    for (const { entry, name, bake } of textures.values()) {
      log(`Converting texture ${++k2} of ${textures.size}: ${entry.path.split('/').pop()}…`);
      await new Promise((res) => setTimeout(res, 0));
      let data;
      try { data = await entry.read(); } catch (err) { note(`Texture ${entry.path} could not be read: ${err.message}`); continue; }
      try {
        const ckey = `${entry.path}|${bake ? bake.mask.path + '|' + bake.paint.join(',') : ''}|${opts.maxTextureSize || 2048}`;
        lib._texCache = lib._texCache || new Map();
        let out = lib._texCache.get(ckey);
        if (!out) {
          const b2 = bake ? { mask: await bake.mask.read(), paint: bake.paint } : null;
          out = convertTexture(data, entry.path, b2, opts.maxTextureSize || 2048);
          lib._texCache.set(ckey, out);
        }
        if (!out.kept) converted++;
        data = out.data;
      } catch (err) { note(`Texture ${entry.path} was copied unchanged (${err.message}); it may show black in RoR.`); }
      texBytes += data.length;
      result.files.push({ path: name, data, binary: true });
    }
    if (converted) note(`${converted} texture(s) were re-encoded to DXT so RoR's Direct3D 9 / OpenGL renderers can show them.`);
    const stats = { flexbodies: lines.length / 3, vertices: totalVerts, triangles: Math.round(totalTris), materials: ogreMats.size, textures: textures.size, textureMB: +(texBytes / 1048576).toFixed(1) };
    result.report.stats.model = `${stats.flexbodies} parts, ${stats.triangles} triangles, ${stats.materials} materials, ${stats.textures} textures (${stats.textureMB} MB)`;
    result.report.model = stats;
    for (const n of notes) result.report.warnings.push(`3D model: ${n}`);
    return Object.assign({ added: stats.flexbodies, notes }, stats);
  }

  // ===========================================================================
  // Textures. BeamNG ships BC7 (DX10-header) DDS files; RoR on Direct3D 9 (and old
  // OpenGL) can't use those, and the texture comes out black. Every DDS that isn't
  // plain DXT1/DXT5 is decoded here and re-encoded as DXT1/DXT5 with mipmaps.
  // ===========================================================================
  // BC7 partition tables (from bcdec by iOrange, MIT/Unlicense): digit = subset, letter = subset at its fix-up (anchor) texel
  const BC7_P2 = 'a01100110011001ba00100010001000ba11101110111011ba00100110011011ba00000010001001ba01101110111111ba00100110111111ba00000010011011ba00000000001001ba01101111111111ba00000010111111ba00000000001011ba00101111111111ba00000001111111ba00011111111111ba00000000000111ba00010001110111ba1b1000100000000a0000000b0001110a1b1001100010000a0b1000100000000a0001000b1001110a0000000b0001100a11100110011000ba0b1000100010000a0001000b0001100a1b0011001100110a0b1011001101100a0010111b1101000a0001111b1110000a1b1000110001110a0b1100110011100a10101010101010ba00011110000111ba10110b001011010a0110011b1001100a0b1110000111100a1010101b0101010a11010010110100ba10110101010010ba1b1001111001110a0010011b1001000a0b1001001001100a0b1101111011100a1b0100110010110a01111001100001ba11001101001100ba00001b001100000a10011b001000000a0b0011100100000a00000b001110010a0000100b1100100a11011001001001ba01101101100100ba1b0001110011100a0b1100111000110a11011001100100ba11000110011100ba11111101000000ba00110001110011ba00011110011001ba0b1001111110000a0b0001011101110a10001000111011b';
  const BC7_P3 = 'a01b00110221222ca00b0011c2112221a0002001c211221ba22c00220011011ba0000000b122112ca01b00110022002ca02c00221111111ba0110011c211221ba0000000b111222ca0001111b111222ca00011b12222222ca01200b20012001ca11201b20112011ca1220b220122012ca01b01121122122ca01b2001c2002220a00b00110112112ca11b0011c0012200a0001122b122112ca02c00220022111ba11b01110222022ca00b0001c2212221a00000b10122012ca0001100c2b02210a12c0b2200110000a0120012b122222ca11012c1b2210110a00001b012c11221a0221102b102002ca1100b102002222ca011012201c2001ba0002000c211222ba0000002b122122ca22c00220012001ba01b00120022022ca1200b2001c00120a00011b122c20000a1201201c0b20120a1202012bc010120a011220011c2001ba01111c22200001ba10b01012222222ca0000000c121212ba0221b220022112ca02c00110022001ba22012c10220122ba10122c22222010ba0002121c121212ba10b01010101222ca22c01110222011ba0021b120002111ca0002b122112211ca2220b110111022ca0021112b112000ca1100b100110222ca000000021b2211ca1100b102222222ca022001100b1002ca0221122b122002ca000000000002b1ca00c00010002000ba22212220222b22ca10b22222222222ca11b2011c2012220';
  const DXGI = { 71: 'BC1', 72: 'BC1', 74: 'BC2', 75: 'BC2', 77: 'BC3', 78: 'BC3', 80: 'BC4', 81: 'BC4', 83: 'BC5', 84: 'BC5', 98: 'BC7', 99: 'BC7', 97: 'BC7', 28: 'RGBA8', 29: 'RGBA8', 27: 'RGBA8', 87: 'BGRA8', 91: 'BGRA8', 88: 'BGRX8', 93: 'BGRX8', 61: 'R8' };
  const BLOCK = { BC1: 8, BC4: 8, BC2: 16, BC3: 16, BC5: 16, BC7: 16 };
  const PIXEL = { RGBA8: 4, BGRA8: 4, BGRX8: 4, BGR8: 3, R8: 1, L8: 1 };

  function parseDDS(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < 128 || dv.getUint32(0, true) !== 0x20534444) throw new Error('not a DDS file');
    const height = dv.getUint32(12, true), width = dv.getUint32(16, true);
    const mips = Math.max(1, dv.getUint32(28, true) || 1);
    const pfFlags = dv.getUint32(80, true);
    const four = String.fromCharCode(bytes[84], bytes[85], bytes[86], bytes[87]);
    let format = null, off = 128, legacy = true;
    if (pfFlags & 4) {
      if (four === 'DX10') { format = DXGI[dv.getUint32(128, true)] || null; off = 148; legacy = false; if (dv.getUint32(140, true) > 1) throw new Error('texture arrays are not supported'); }
      else format = { DXT1: 'BC1', DXT2: 'BC2', DXT3: 'BC2', DXT4: 'BC3', DXT5: 'BC3', ATI1: 'BC4', BC4U: 'BC4', ATI2: 'BC5', BC5U: 'BC5' }[four] || null;
    } else if (pfFlags & 0x40) {
      const bits = dv.getUint32(88, true), rMask = dv.getUint32(92, true);
      format = bits === 32 ? (rMask === 0xff ? 'RGBA8' : ((pfFlags & 1) ? 'BGRA8' : 'BGRX8')) : bits === 24 ? 'BGR8' : null;
    } else if (pfFlags & 0x20000 || pfFlags & 2) format = 'L8';
    if (!format) throw new Error(`unsupported DDS format ${four}`);
    return { width, height, mips, format, off, legacy, bytes };
  }
  function ddsLevelSize(fmt, w, h) {
    return BLOCK[fmt] ? Math.max(1, Math.ceil(w / 4)) * Math.max(1, Math.ceil(h / 4)) * BLOCK[fmt] : w * h * PIXEL[fmt];
  }
  /** Decode one mip level to RGBA8. */
  function decodeDDS(dds, level) {
    let w = dds.width, h = dds.height, at = dds.off;
    for (let l = 0; l < level; l++) { at += ddsLevelSize(dds.format, w, h); w = Math.max(1, w >> 1); h = Math.max(1, h >> 1); }
    const src = dds.bytes, out = new Uint8Array(w * h * 4), f = dds.format;
    if (at + ddsLevelSize(f, w, h) > src.length) throw new Error('DDS file is truncated');
    if (PIXEL[f]) {
      const ps = PIXEL[f];
      for (let i = 0; i < w * h; i++) {
        const s = at + i * ps, o = i * 4;
        if (f === 'RGBA8') { out[o] = src[s]; out[o + 1] = src[s + 1]; out[o + 2] = src[s + 2]; out[o + 3] = src[s + 3]; }
        else if (f === 'BGRA8' || f === 'BGRX8') { out[o] = src[s + 2]; out[o + 1] = src[s + 1]; out[o + 2] = src[s]; out[o + 3] = f === 'BGRA8' ? src[s + 3] : 255; }
        else if (f === 'BGR8') { out[o] = src[s + 2]; out[o + 1] = src[s + 1]; out[o + 2] = src[s]; out[o + 3] = 255; }
        else { out[o] = out[o + 1] = out[o + 2] = src[s]; out[o + 3] = 255; }
      }
      return { w, h, rgba: out };
    }
    const bw = Math.max(1, Math.ceil(w / 4)), bh = Math.max(1, Math.ceil(h / 4)), bs = BLOCK[f];
    const px = new Uint8Array(64);
    for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
      const b = at + (by * bw + bx) * bs;
      if (f === 'BC1') colorBlock(src, b, px, true);
      else if (f === 'BC2') { colorBlock(src, b + 8, px, false); for (let i = 0; i < 16; i++) px[i * 4 + 3] = ((src[b + (i >> 1)] >> ((i & 1) * 4)) & 15) * 17; }
      else if (f === 'BC3') { colorBlock(src, b + 8, px, false); alphaBlock(src, b, px, 3); }
      else if (f === 'BC4') { alphaBlock(src, b, px, 0); for (let i = 0; i < 16; i++) { px[i * 4 + 1] = px[i * 4 + 2] = px[i * 4]; px[i * 4 + 3] = 255; } }
      else if (f === 'BC5') { alphaBlock(src, b, px, 0); alphaBlock(src, b + 8, px, 1); for (let i = 0; i < 16; i++) { px[i * 4 + 2] = 0; px[i * 4 + 3] = 255; } }
      else bc7Block(src, b, px);
      for (let y = 0; y < 4; y++) {
        const yy = by * 4 + y; if (yy >= h) break;
        for (let x = 0; x < 4; x++) {
          const xx = bx * 4 + x; if (xx >= w) break;
          const o = (yy * w + xx) * 4, s = (y * 4 + x) * 4;
          out[o] = px[s]; out[o + 1] = px[s + 1]; out[o + 2] = px[s + 2]; out[o + 3] = px[s + 3];
        }
      }
    }
    return { w, h, rgba: out };
  }
  function colorBlock(src, b, px, allowAlpha) {
    const c0 = src[b] | (src[b + 1] << 8), c1 = src[b + 2] | (src[b + 3] << 8);
    const pal = new Array(16);
    const rgb = (c) => [((c >> 11) & 31) * 255 / 31, ((c >> 5) & 63) * 255 / 63, (c & 31) * 255 / 31];
    const a = rgb(c0), bb = rgb(c1);
    const p = [[...a, 255], [...bb, 255]];
    if (c0 > c1 || !allowAlpha) { p.push(a.map((v, i) => (2 * v + bb[i]) / 3).concat(255), a.map((v, i) => (v + 2 * bb[i]) / 3).concat(255)); }
    else { p.push(a.map((v, i) => (v + bb[i]) / 2).concat(255), [0, 0, 0, 0]); }
    void pal;
    const bits = src[b + 4] | (src[b + 5] << 8) | (src[b + 6] << 16) | (src[b + 7] << 24);
    for (let i = 0; i < 16; i++) { const c = p[(bits >>> (i * 2)) & 3]; for (let k = 0; k < 4; k++) px[i * 4 + k] = Math.round(c[k]); }
  }
  function alphaBlock(src, b, px, ch) {
    const a0 = src[b], a1 = src[b + 1];
    const p = [a0, a1];
    if (a0 > a1) for (let i = 1; i < 7; i++) p.push(((7 - i) * a0 + i * a1) / 7);
    else { for (let i = 1; i < 5; i++) p.push(((5 - i) * a0 + i * a1) / 5); p.push(0, 255); }
    let lo = src[b + 2] | (src[b + 3] << 8) | (src[b + 4] << 16), hi = src[b + 5] | (src[b + 6] << 8) | (src[b + 7] << 16);
    for (let i = 0; i < 16; i++) {
      const idx = i < 8 ? (lo >> (i * 3)) & 7 : (hi >> ((i - 8) * 3)) & 7;
      px[i * 4 + ch] = Math.round(p[idx]);
    }
  }
  const W2 = [0, 21, 43, 64], W3 = [0, 9, 18, 27, 37, 46, 55, 64], W4 = [0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64];
  // Port of bcdec_bc7 (bcdec by iOrange, MIT/Unlicense)
  function bc7Block(src, b, px) {
    let pos = 0;
    const bits = (n) => { let v = 0; for (let k = 0; k < n; k++, pos++) v |= ((src[b + (pos >> 3)] >> (pos & 7)) & 1) << k; return v; };
    let mode = 0;
    while (mode < 8 && bits(1) === 0) mode++;
    if (mode >= 8) { px.fill(0); return; }
    const colBits = [4, 6, 5, 7, 5, 7, 7, 5][mode], alphaBits = [0, 0, 0, 0, 6, 8, 7, 5][mode];
    const hasP = (0b11001011 >> mode) & 1;
    let partition = 0, nParts = 1, rotation = 0, isel = 0;
    if (mode === 0 || mode === 1 || mode === 2 || mode === 3 || mode === 7) { nParts = (mode === 0 || mode === 2) ? 3 : 2; partition = bits(mode === 0 ? 4 : 6); }
    const nE = nParts * 2;
    if (mode === 4 || mode === 5) { rotation = bits(2); if (mode === 4) isel = bits(1); }
    const ep = [];
    for (let j = 0; j < nE; j++) ep.push([0, 0, 0, 0]);
    for (let i = 0; i < 3; i++) for (let j = 0; j < nE; j++) ep[j][i] = bits(colBits);
    if (alphaBits) for (let j = 0; j < nE; j++) ep[j][3] = bits(alphaBits);
    if (mode === 0 || mode === 1 || mode === 3 || mode === 6 || mode === 7) {
      for (const e of ep) for (let k = 0; k < 4; k++) e[k] <<= 1;
      if (mode === 1) { const i = bits(1), j = bits(1); for (let k = 0; k < 3; k++) { ep[0][k] |= i; ep[1][k] |= i; ep[2][k] |= j; ep[3][k] |= j; } }
      else if (hasP) for (const e of ep) { const j = bits(1); for (let k = 0; k < 4; k++) e[k] |= j; }
    }
    for (const e of ep) {
      let j = colBits + hasP;
      for (let k = 0; k < 3; k++) { e[k] = (e[k] << (8 - j)) & 255; e[k] = e[k] | (e[k] >> j); }
      j = alphaBits + hasP;
      e[3] = (e[3] << (8 - j)) & 255; e[3] = e[3] | (e[3] >> j);
    }
    if (!alphaBits) for (const e of ep) e[3] = 255;
    const ib = (mode === 0 || mode === 1) ? 3 : (mode === 6 ? 4 : 2);
    const ib2 = mode === 4 ? 3 : (mode === 5 ? 2 : 0);
    const w1 = ib === 2 ? W2 : ib === 3 ? W3 : W4, w2 = ib2 === 2 ? W2 : W3;
    const table = nParts === 2 ? BC7_P2 : nParts === 3 ? BC7_P3 : null;
    const subset = new Array(16), idx = new Array(16);
    for (let i = 0; i < 16; i++) {
      let s, anchor;
      if (!table) { s = 0; anchor = i === 0; }
      else { const ch = table[partition * 16 + i]; anchor = ch >= 'a'; s = anchor ? ch.charCodeAt(0) - 97 : +ch; }
      subset[i] = s;
      idx[i] = bits(anchor ? ib - 1 : ib);
    }
    const lerp = (e0, e1, w, i) => ((64 - w[i]) * e0 + w[i] * e1 + 32) >> 6;
    for (let i = 0; i < 16; i++) {
      const e0 = ep[subset[i] * 2], e1 = ep[subset[i] * 2 + 1];
      let r, g, bl, a;
      if (!ib2) { r = lerp(e0[0], e1[0], w1, idx[i]); g = lerp(e0[1], e1[1], w1, idx[i]); bl = lerp(e0[2], e1[2], w1, idx[i]); a = lerp(e0[3], e1[3], w1, idx[i]); }
      else {
        const i2 = bits(i ? ib2 : ib2 - 1);
        if (!isel) { r = lerp(e0[0], e1[0], w1, idx[i]); g = lerp(e0[1], e1[1], w1, idx[i]); bl = lerp(e0[2], e1[2], w1, idx[i]); a = lerp(e0[3], e1[3], w2, i2); }
        else { r = lerp(e0[0], e1[0], w2, i2); g = lerp(e0[1], e1[1], w2, i2); bl = lerp(e0[2], e1[2], w2, i2); a = lerp(e0[3], e1[3], w1, idx[i]); }
      }
      if (rotation === 1) [a, r] = [r, a]; else if (rotation === 2) [a, g] = [g, a]; else if (rotation === 3) [a, bl] = [bl, a];
      px[i * 4] = r; px[i * 4 + 1] = g; px[i * 4 + 2] = bl; px[i * 4 + 3] = a;
    }
  }

  /** Halve an RGBA image (box filter). */
  function halve(img) {
    const w = Math.max(1, img.w >> 1), h = Math.max(1, img.h >> 1), out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 4; c++) {
      let s = 0, n = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) { const yy = Math.min(img.h - 1, y * 2 + dy), xx = Math.min(img.w - 1, x * 2 + dx); s += img.rgba[(yy * img.w + xx) * 4 + c]; n++; }
      out[(y * w + x) * 4 + c] = (s / n + 0.5) | 0;
    }
    return { w, h, rgba: out };
  }

  /** Encode RGBA to a DXT1 (opaque) or DXT5 DDS with a full mip chain. */
  function encodeDDS(img) {
    let alpha = false;
    for (let i = 3; i < img.rgba.length; i += 4) if (img.rgba[i] < 250) { alpha = true; break; }
    const levels = [img];
    while (levels[levels.length - 1].w > 1 || levels[levels.length - 1].h > 1) levels.push(halve(levels[levels.length - 1]));
    const bs = alpha ? 16 : 8;
    const sizes = levels.map((l) => Math.max(1, Math.ceil(l.w / 4)) * Math.max(1, Math.ceil(l.h / 4)) * bs);
    const out = new Uint8Array(128 + sizes.reduce((a, b) => a + b, 0));
    const dv = new DataView(out.buffer);
    dv.setUint32(0, 0x20534444, true); dv.setUint32(4, 124, true);
    dv.setUint32(8, 0x1 | 0x2 | 0x4 | 0x1000 | 0x20000 | 0x80000, true);
    dv.setUint32(12, img.h, true); dv.setUint32(16, img.w, true); dv.setUint32(20, sizes[0], true);
    dv.setUint32(28, levels.length, true);
    dv.setUint32(76, 32, true); dv.setUint32(80, 4, true);
    out.set([68, 88, 84, alpha ? 53 : 49], 84); // DXT5 / DXT1
    dv.setUint32(108, 0x1000 | 0x400000 | 0x8, true);
    let at = 128;
    const blk = new Uint8Array(64);
    for (const l of levels) {
      const bw = Math.max(1, Math.ceil(l.w / 4)), bh = Math.max(1, Math.ceil(l.h / 4));
      for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
        for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
          const yy = Math.min(l.h - 1, by * 4 + y), xx = Math.min(l.w - 1, bx * 4 + x), s = (yy * l.w + xx) * 4, o = (y * 4 + x) * 4;
          blk[o] = l.rgba[s]; blk[o + 1] = l.rgba[s + 1]; blk[o + 2] = l.rgba[s + 2]; blk[o + 3] = l.rgba[s + 3];
        }
        if (alpha) { encodeAlpha(blk, out, at); at += 8; }
        encodeColor(blk, out, at); at += 8;
      }
    }
    return out;
  }
  function encodeColor(blk, out, at) {
    // endpoints: extremes along the main colour axis
    let mr = 0, mg = 0, mb = 0;
    for (let i = 0; i < 16; i++) { mr += blk[i * 4]; mg += blk[i * 4 + 1]; mb += blk[i * 4 + 2]; }
    mr /= 16; mg /= 16; mb /= 16;
    let cxx = 0, cxy = 0, cxz = 0, cyy = 0, cyz = 0, czz = 0;
    for (let i = 0; i < 16; i++) { const r = blk[i * 4] - mr, g = blk[i * 4 + 1] - mg, b = blk[i * 4 + 2] - mb; cxx += r * r; cxy += r * g; cxz += r * b; cyy += g * g; cyz += g * b; czz += b * b; }
    let ax = [1, 1, 1];
    for (let k = 0; k < 6; k++) { const n = [cxx * ax[0] + cxy * ax[1] + cxz * ax[2], cxy * ax[0] + cyy * ax[1] + cyz * ax[2], cxz * ax[0] + cyz * ax[1] + czz * ax[2]]; const l = Math.hypot(...n); if (l < 1e-9) break; ax = n.map((v) => v / l); }
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < 16; i++) { const t = (blk[i * 4] - mr) * ax[0] + (blk[i * 4 + 1] - mg) * ax[1] + (blk[i * 4 + 2] - mb) * ax[2]; if (t < lo) lo = t; if (t > hi) hi = t; }
    const to565 = (t) => { const r = Math.max(0, Math.min(255, mr + ax[0] * t)), g = Math.max(0, Math.min(255, mg + ax[1] * t)), b = Math.max(0, Math.min(255, mb + ax[2] * t)); return (Math.round(r * 31 / 255) << 11) | (Math.round(g * 63 / 255) << 5) | Math.round(b * 31 / 255); };
    let c0 = to565(hi), c1 = to565(lo);
    if (c0 < c1) [c0, c1] = [c1, c0];
    const rgb = (c) => [((c >> 11) & 31) * 255 / 31, ((c >> 5) & 63) * 255 / 63, (c & 31) * 255 / 31];
    const a = rgb(c0), b = rgb(c1);
    const pal = c0 === c1 ? [a] : [a, b, a.map((v, i) => (2 * v + b[i]) / 3), a.map((v, i) => (v + 2 * b[i]) / 3)];
    let bits = 0;
    for (let i = 0; i < 16; i++) {
      let best = 0, bd = Infinity;
      for (let p = 0; p < pal.length; p++) { const d = (blk[i * 4] - pal[p][0]) ** 2 + (blk[i * 4 + 1] - pal[p][1]) ** 2 + (blk[i * 4 + 2] - pal[p][2]) ** 2; if (d < bd) { bd = d; best = p; } }
      bits |= best << (i * 2);
    }
    out[at] = c0 & 255; out[at + 1] = c0 >> 8; out[at + 2] = c1 & 255; out[at + 3] = c1 >> 8;
    out[at + 4] = bits & 255; out[at + 5] = (bits >>> 8) & 255; out[at + 6] = (bits >>> 16) & 255; out[at + 7] = (bits >>> 24) & 255;
  }
  function encodeAlpha(blk, out, at) {
    let lo = 255, hi = 0;
    for (let i = 0; i < 16; i++) { const v = blk[i * 4 + 3]; if (v < lo) lo = v; if (v > hi) hi = v; }
    out[at] = hi; out[at + 1] = lo;
    const pal = [hi, lo];
    if (hi > lo) for (let i = 1; i < 7; i++) pal.push(((7 - i) * hi + i * lo) / 7);
    let bitsLo = 0, bitsHi = 0;
    for (let i = 0; i < 16; i++) {
      let best = 0, bd = Infinity;
      for (let p = 0; p < pal.length; p++) { const d = Math.abs(blk[i * 4 + 3] - pal[p]); if (d < bd) { bd = d; best = p; } }
      if (i < 8) bitsLo |= best << (i * 3); else bitsHi |= best << ((i - 8) * 3);
    }
    out[at + 2] = bitsLo & 255; out[at + 3] = (bitsLo >> 8) & 255; out[at + 4] = (bitsLo >> 16) & 255;
    out[at + 5] = bitsHi & 255; out[at + 6] = (bitsHi >> 8) & 255; out[at + 7] = (bitsHi >> 16) & 255;
  }

  /** Largest mip level of a DDS that fits in maxSize, decoded to RGBA. */
  function decodeDDSFit(dds, maxSize) {
    let level = 0, w = dds.width, h = dds.height;
    while (level + 1 < dds.mips && Math.max(w, h) > maxSize) { level++; w = Math.max(1, w >> 1); h = Math.max(1, h >> 1); }
    let img = decodeDDS(dds, level);
    while (Math.max(img.w, img.h) > maxSize) img = halve(img);
    return img;
  }

  /**
   * Make a texture usable in RoR: plain DXT1/3/5 DDS (up to 4096) and PNG/JPG are kept;
   * anything else is re-encoded. With bake = {mask, paint}, the paint colour is mixed
   * into the colour texture where BeamNG's paint mask says so.
   */
  function convertTexture(bytes, path, bake, maxSize) {
    maxSize = maxSize || 2048;
    if (!/\.dds$/i.test(path) && !bake) return { data: bytes, kept: true };
    let img;
    if (/\.dds$/i.test(path)) {
      const dds = parseDDS(bytes);
      if (!bake && dds.legacy && /^BC[123]$/.test(dds.format) && Math.max(dds.width, dds.height) <= 4096) return { data: bytes, kept: true };
      img = decodeDDSFit(dds, maxSize);
    } else throw new Error('paint baking needs a DDS texture');
    if (bake) {
      const m = decodeDDSFit(parseDDS(bake.mask), Math.max(img.w, img.h));
      const p = bake.paint.map((v) => Math.max(0, Math.min(255, v * 255)));
      for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
        const mx = Math.min(m.w - 1, Math.floor(x * m.w / img.w)), my = Math.min(m.h - 1, Math.floor(y * m.h / img.h));
        const t = m.rgba[(my * m.w + mx) * 4] / 255, o = (y * img.w + x) * 4;
        for (let c = 0; c < 3; c++) img.rgba[o + c] = Math.round(img.rgba[o + c] * (1 - t) + p[c] * t);
      }
    }
    return { data: encodeDDS(img), kept: false, w: img.w, h: img.h };
  }

  /** "1-5,7,9-12" from a list of numbers. */
  function ranges(list) {
    const s = [...new Set(list)].sort((a, b) => a - b);
    const out = [];
    for (let k = 0; k < s.length; k++) {
      let j = k;
      while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
      out.push(j > k ? `${s[k]}-${s[j]}` : `${s[k]}`);
      k = j;
    }
    return out.join(',');
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

  const api = { zstdDecompress, parseCdae, cdaeGeometry, cdaeObjectNames, parseDDS, decodeDDS, encodeDDS, convertTexture, _bc7Block: bc7Block, addVisuals, parseCollada, colladaGeometry, writeOgreMesh, readOgreMesh, parseXML, makeZipCompressed, version: CONVERTER_VERSION, experiments: EXPERIMENTS, pack: PACK, _stabilizeModes: stabilizeModes, _simulateDrop: simulateDrop, parseJBeam, evalExpression, openZip, makeZip, loadLibrary, listVehicles, convert, buildModZip, filesToEntries, crc32 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.J2R = api;
})(typeof self !== 'undefined' ? self : this);
