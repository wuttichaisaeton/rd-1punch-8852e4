// customer/dim.js — read-only drawing-style dimension overlay for the customer
// 3D viewer. Ported from the admin project-3D dim engine (app.js, spec
// docs/superpowers/specs/2026-07-09-project-3d-dim-overlay-design.md).
//
// Project view only, READ-ONLY (no RTDB overrides, no admin editing). Reads the
// model-viewer scene directly: the project GLBs bake every transform to identity
// so geometry.boundingBox is already the GLB world frame in mm (Z-up: w=x, d=y,
// h=z). model-viewer shows the model with orientation="0deg -90deg 0deg", so a
// hotspot at GLB (x,y,z) uses data-position (x, z, -y) — same swap the admin
// proved empirically.
//
// Usage:  const dim = initDimOverlay(mv, stageEl);  dim.show('top'|'left'|'right'); dim.clear();

export function initDimOverlay(mv, stageEl) {
  const NS = 'http://www.w3.org/2000/svg';
  let dimSvg = null, dimAnchors = [], dimRedraw = null, dimOn = false, dimFace = '', retry = 0;

  // Which two dims each face shows (GLB Z-up: w=x, d=y, h=z).
  const VC_FACE_DIMS = { front:1, back:1, right:1, left:1, top:1, bottom:1 };
  // Camera-orbit targets matching the customer viewer's Top/Left/Right buttons
  // (model-viewer getCameraOrbit → radians). Dims hide when orbited away.
  const VIEWS = {
    top:   { theta: 0, phi: 0.02 },
    bottom:{ theta: 0, phi: Math.PI - 0.02 },
    left:  { theta: -Math.PI / 2, phi: Math.PI / 2 },
    right: { theta:  Math.PI / 2, phi: Math.PI / 2 },
    front: { theta: 0, phi: Math.PI / 2 },
    back:  { theta: Math.PI, phi: Math.PI / 2 },
  };

  const getScene = () => { try { const s = Object.getOwnPropertySymbols(mv).find(t => t.toString() === 'Symbol(scene)'); return s ? mv[s] : null; } catch { return null; } };
  const extractPartLabel = (nm) => (((nm || '').split('__')[0]) || '').replace(/_v\d+$/, '');

  // ── build per-part boxes from the loaded scene (baked identity → geometry
  //    bbox IS the GLB world frame, mm). ────────────────────────────────────
  const buildCtx = () => {
    const scene = getScene(); if (!scene) return null;
    const boxes = []; let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    scene.traverse((e) => {
      if (!e.isMesh || !e.geometry || !e.geometry.attributes || !e.geometry.attributes.position) return;
      if (e.visible === false) return;
      let nm = '';
      for (let n = e; n; n = n.parent) { if (n.name && /__CABIN__/.test(n.name)) { nm = n.name; break; } }
      if (!nm) nm = e.name || '';
      if (!e.geometry.boundingBox) { try { e.geometry.computeBoundingBox(); } catch {} }
      const bb = e.geometry.boundingBox; if (!bb) return;
      const x0 = bb.min.x, x1 = bb.max.x, y0 = bb.min.y, y1 = bb.max.y, z0 = bb.min.z, z1 = bb.max.z;
      boxes.push({ nm, x0, x1, y0, y1, z0, z1, s: { x: x1 - x0, y: y1 - y0, z: z1 - z0 } });
      if (x0 < mn[0]) mn[0] = x0; if (y0 < mn[1]) mn[1] = y0; if (z0 < mn[2]) mn[2] = z0;
      if (x1 > mx[0]) mx[0] = x1; if (y1 > mx[1]) mx[1] = y1; if (z1 > mx[2]) mx[2] = z1;
    });
    if (!isFinite(mn[0])) return null;
    const ext = Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]);
    const sc = ext < 10 ? 1000 : 1;   // model in metres → mm
    return { boxes, mn, mx, sc };
  };

  // ── segment builder (ported from _kd3dDimSegments — PROJECT view only) ─────
  const kd3dDimSegments = (face, ctx) => {
    const { boxes, mn, mx, sc } = ctx;
    if (!boxes.length) return null;

    const _bounds = (ds) => {
      const gaps = ds.slice(1).map((d, i) => d.s0 - ds[i].s1).filter((g) => g > 0 && g < 30);
      const hg = gaps.length ? (gaps.reduce((a, c) => a + c, 0) / gaps.length) / 2 : 1.5;
      const bnds = [ds[0].s0 - hg];
      for (let i = 0; i < ds.length - 1; i++) bnds.push((ds[i].s1 + ds[i + 1].s0) / 2);
      bnds.push(ds[ds.length - 1].s1 + hg);
      return bnds;
    };
    const _frontPanels = (panels, lo, hi) => {
      if (!panels.length) return [];
      const mnP = Math.min(...panels.map((p) => p[lo])), mxP = Math.max(...panels.map((p) => p[hi]));
      const onMin = panels.filter((p) => Math.abs(p[lo] - mnP) < 30);
      const onMax = panels.filter((p) => Math.abs(p[hi] - mxP) < 30);
      return onMin.length >= onMax.length ? onMin : onMax;
    };
    const _extendWithCovers = (bnds, labels, segIds, covers) => {
      for (const c of covers) {
        if (Math.abs(c.s1 - bnds[0]) < 30) { bnds.unshift(c.s0); labels.unshift(Math.round((bnds[1] - bnds[0]) * sc)); segIds.unshift('covS'); }
        else if (Math.abs(c.s0 - bnds[bnds.length - 1]) < 30) { bnds.push(c.s1); labels.push(Math.round((bnds[bnds.length - 1] - bnds[bnds.length - 2]) * sc)); segIds.push('covE'); }
      }
    };
    const _tallCovers = (axis) => {
      const out = [];
      for (const b of boxes) {
        if (!/^\d*F?CV/.test(b.nm.split('__')[0] || '')) continue;
        if ((b.z1 - b.z0) * sc < 300) continue;
        const cx = (b.x0 + b.x1) / 2;
        if (axis === 'x') { if ((b.x1 - b.x0) < 30) out.push({ s0: b.x0, s1: b.x1, cx }); }
        else { if ((b.y1 - b.y0) < 30) out.push({ s0: -b.y1, s1: -b.y0, cx }); }
      }
      return out;
    };
    const chains = [];
    const runP = [], armP = [];
    for (const b of boxes) {
      const code = b.nm.split('__')[0] || '';
      if (!/^DSV100/.test(code) || !/__CABIN__/.test(b.nm)) continue;
      if (b.s.x > b.s.y) runP.push(b); else if (b.s.y > b.s.x) armP.push(b);
    }
    const _runChain = () => {
      const keep = _frontPanels(runP, 'y0', 'y1');
      const seen = new Map();
      let fy = Infinity, tz = -Infinity, bz = Infinity;
      for (const b of keep) {
        const k = Math.round(b.x0 / 5) + '_' + Math.round(b.x1 / 5);
        if (!seen.has(k)) seen.set(k, { s0: b.x0, s1: b.x1 });
        if (b.y0 < fy) fy = b.y0;
        if (b.z1 > tz) tz = b.z1;
        if (b.z0 < bz) bz = b.z0;
      }
      const doors = [...seen.values()].sort((a, b) => a.s0 - b.s0);
      if (!doors.length) return null;
      const bnds = _bounds(doors);
      const labels = bnds.slice(1).map((b, i) => Math.round((b - bnds[i]) * sc));
      const segIds = labels.map((_, i) => String(i));
      _extendWithCovers(bnds, labels, segIds, _tallCovers('x'));
      return { bnds, labels, segIds, fy, tz, bz };
    };
    const _armClusters = () => {
      if (!armP.length) return [];
      const withCx = armP.map((b) => ({ b, cx: (b.x0 + b.x1) / 2 }));
      withCx.sort((a, b) => a.cx - b.cx);
      const groups = [];
      for (const it of withCx) {
        let g = groups.find((gr) => Math.abs(gr.cx - it.cx) < 120);
        if (!g) { g = { cx: it.cx, items: [] }; groups.push(g); }
        g.items.push(it.b);
        g.cx = g.items.reduce((s, p) => s + (p.x0 + p.x1) / 2, 0) / g.items.length;
      }
      const yCovers = _tallCovers('y');
      const out = [];
      for (const g of groups) {
        const keep = _frontPanels(g.items, 'x0', 'x1');
        const seen = new Map();
        let tz = -Infinity, bz = Infinity, fx = Infinity; const cabs = new Set();
        for (const b of keep) {
          const k = Math.round(b.y0 / 5) + '_' + Math.round(b.y1 / 5);
          if (!seen.has(k)) seen.set(k, { s0: -b.y1, s1: -b.y0 });
          if (b.z1 > tz) tz = b.z1;
          if (b.z0 < bz) bz = b.z0;
          if (b.x0 < fx) fx = b.x0;
          const m = /__CABIN__([A-Za-z0-9.\-]+)/.exec(b.nm); if (m) cabs.add(m[1]);
        }
        const doors = [...seen.values()].sort((a, b) => a.s0 - b.s0);
        if (!doors.length) continue;
        let ax = -Infinity;
        for (const b of boxes) { const m = /__CABIN__([A-Za-z0-9.\-]+)/.exec(b.nm); if (m && cabs.has(m[1]) && b.x1 > ax) ax = b.x1; }
        const bnds = _bounds(doors);
        const labels = bnds.slice(1).map((b, i) => Math.round((b - bnds[i]) * sc));
        const segIds = labels.map((_, i) => String(i));
        const mine = yCovers.filter((c) => groups.every((gr) => Math.abs(c.cx - g.cx) <= Math.abs(c.cx - gr.cx)));
        _extendWithCovers(bnds, labels, segIds, mine);
        out.push({ bnds, labels, segIds, ax, fx, tz, bz, cx: g.cx });
      }
      out.sort((a, b) => a.cx - b.cx);
      return out;
    };
    const _armChain = () => { const a = _armClusters(); return a.length ? a[0] : null; };
    const r10 = (v) => Math.round((v * sc) / 10) * 10 / sc;
    let covRun = null, covArm = null, covAny = null;
    for (const b of boxes) {
      if (!/^CV/.test(b.nm.split('__')[0] || '')) continue;
      if ((b.z1 - b.z0) * sc < 300) continue;
      if ((b.x1 - b.x0) < 30 && (!covRun || b.x0 < covRun.x0)) covRun = b;
      if ((b.y1 - b.y0) < 30 && (!covArm || b.y0 < covArm.y0)) covArm = b;
      if (!covAny || b.x0 < covAny.x0) covAny = b;
    }
    const _extendPerp = (ch, lo, hi, id) => {
      const last = ch.bnds.length - 1;
      if (hi > ch.bnds[last] + 1) { ch.labels.push(Math.round(r10(hi - ch.bnds[last]) * sc)); ch.bnds.push(hi); ch.segIds.push(id); }
      else if (lo < ch.bnds[0] - 1) { ch.labels.unshift(Math.round(r10(ch.bnds[0] - lo) * sc)); ch.bnds.unshift(lo); ch.segIds.unshift(id); }
    };
    if (face === 'top' || face === 'bottom') {
      const rc = _runChain();
      if (rc) chains.push({ key: 'run', axis: 'h', side: 1, anchors: rc.bnds.map((x) => [x, rc.fy, rc.tz]), labels: rc.labels, segIds: rc.segIds });
      else chains.push({ key: 'run', axis: 'h', side: 1, anchors: [[mn[0], mn[1], mx[2]], [mx[0], mn[1], mx[2]]], labels: [Math.round(r10(mx[0] - mn[0]) * sc)], segIds: ['w'] });
      const acs = _armClusters().filter((a) => isFinite(a.ax));
      if (acs.length) acs.forEach((ac, i) => chains.push({ key: i === 0 ? 'arm' : 'arm' + (i + 1), axis: 'v', side: 1, anchors: ac.bnds.map((s) => [ac.ax, -s, ac.tz]), labels: ac.labels, segIds: ac.segIds }));
      else chains.push({ key: 'arm', axis: 'v', side: 1, anchors: [[mx[0], mx[1], mx[2]], [mx[0], mn[1], mx[2]]], labels: [Math.round(r10(mx[1] - mn[1]) * sc)], segIds: ['d'] });
      if (rc) chains.push({ key: 'wtot', axis: 'h', side: -1, anchors: [[mn[0], mx[1], rc.tz], [mx[0], mx[1], rc.tz]], labels: [Math.round(r10(mx[0] - mn[0]) * sc)], segIds: ['all'] });
      if (acs.length) { const aR = acs[acs.length - 1]; chains.push({ key: 'dtot', axis: 'v', side: 1, off: 80, anchors: [[aR.ax, mx[1], aR.tz], [aR.ax, mn[1], aR.tz]], labels: [Math.round(r10(mx[1] - mn[1]) * sc)], segIds: ['all'] }); }
      if (covRun) chains.push({ key: 'rdep', axis: 'v', side: -1, anchors: [[mn[0], covRun.y1, covRun.z1], [mn[0], covRun.y0, covRun.z1]], labels: [Math.round(r10(covRun.y1 - covRun.y0) * sc)], segIds: ['all'] });
      if (covArm) chains.push({ key: 'awid', axis: 'h', side: 1, anchors: [[covArm.x0, mn[1], covArm.z1], [covArm.x1, mn[1], covArm.z1]], labels: [Math.round(r10(covArm.x1 - covArm.x0) * sc)], segIds: ['all'] });
      return chains.length ? chains : null;
    }
    const fb = face === 'front' || face === 'back';
    let dc = null;
    if (fb) {
      const rc = dc = _runChain();
      if (rc) {
        if (covArm) _extendPerp(rc, covArm.x0, covArm.x1, 'arm');
        chains.push({ key: 'run', axis: 'h', side: 1, anchors: rc.bnds.map((x) => [x, rc.fy, rc.bz]), labels: rc.labels, segIds: rc.segIds });
        chains.push({ key: 'wtot', axis: 'h', side: 1, off: 80, anchors: [[mn[0], rc.fy, rc.bz], [mx[0], rc.fy, rc.bz]], labels: [Math.round(r10(mx[0] - mn[0]) * sc)], segIds: ['all'] });
      }
      else chains.push({ key: 'run', axis: 'h', side: 1, anchors: [[mn[0], mn[1], mn[2]], [mx[0], mn[1], mn[2]]], labels: [Math.round(r10(mx[0] - mn[0]) * sc)], segIds: ['w'] });
    } else {
      const _acs = _armClusters();
      const ac = dc = _acs.length ? (face === 'right' ? _acs[_acs.length - 1] : _acs[0]) : null;
      if (ac) {
        if (covRun) _extendPerp(ac, -covRun.y1, -covRun.y0, 'run');
        chains.push({ key: 'arm', axis: 'h', side: 1, anchors: ac.bnds.map((s) => [ac.fx, -s, ac.bz]), labels: ac.labels, segIds: ac.segIds });
        chains.push({ key: 'dtot', axis: 'h', side: 1, off: 80, anchors: [[ac.fx, mn[1], ac.bz], [ac.fx, mx[1], ac.bz]], labels: [Math.round(r10(mx[1] - mn[1]) * sc)], segIds: ['all'] });
      }
      else chains.push({ key: 'arm', axis: 'h', side: 1, anchors: [[(mn[0] + mx[0]) / 2, mx[1], mn[2]], [(mn[0] + mx[0]) / 2, mn[1], mn[2]]], labels: [Math.round(r10(mx[1] - mn[1]) * sc)], segIds: ['d'] });
    }
    const c = (fb ? covRun : covArm) || covAny;
    const zdc = (dc && (dc.tz - dc.bz) * sc > 100) ? dc : (fb ? _armChain() : _runChain());
    const hasDoors = !!(zdc && (zdc.tz - zdc.bz) * sc > 100);
    const sxSign = { front: 1, back: -1, left: -1, right: 1 }[face] || 1;
    const _bakeZ = 0;
    let f2Bot = null, hasFloorPart = false;
    for (const b of boxes) {
      if ((b.z0 + _bakeZ) * sc < 300) { hasFloorPart = true; continue; }
      const cm = /__CABIN__([A-Za-z0-9.\-]+)/.exec(b.nm); const cab = cm ? cm[1] : '';
      const cc = extractPartLabel(b.nm) || '';
      if (/^2/.test(cab) || /^2/.test(cc)) { if (f2Bot == null || b.z0 < f2Bot) f2Bot = b.z0; }
    }
    const _isHoodCab = (cc) => /^2[A-Za-z0-9]{3}HD-/i.test(cc || '');
    const _cabCodes = new Set();
    for (const b of boxes) { const m = /__CABIN__([A-Za-z0-9.\-]+)/.exec(b.nm); if (m) _cabCodes.add(m[1]); }
    const hoodOnly = (_cabCodes.size > 0 && [..._cabCodes].every(_isHoodCab));
    const wallOnly = f2Bot != null && !hasFloorPart;
    let cabZ0 = Infinity, cabZ1 = -Infinity;
    for (const b of boxes) {
      const cm2 = /__CABIN__([A-Za-z0-9.\-]+)/.exec(b.nm); const cab2 = cm2 ? cm2[1] : '';
      if (!cab2 || /^OTHERS/i.test(cab2)) continue;
      if (_isHoodCab(cab2) || _isHoodCab(extractPartLabel(b.nm) || '')) continue;
      if (b.z0 < cabZ0) cabZ0 = b.z0;
      if (b.z1 > cabZ1) cabZ1 = b.z1;
    }
    if (cabZ0 === Infinity) { cabZ0 = mn[2]; cabZ1 = mx[2]; }
    if (hoodOnly) { /* no height/total */ }
    else if (c) {
      const thinX = (c.x1 - c.x0) < 30;
      const ax = thinX ? c.x0 : (c.x0 + c.x1) / 2;
      const ay = (c.y0 + c.y1) / 2;
      const covC = fb ? (c.x0 + c.x1) / 2 : (c.y0 + c.y1) / 2;
      const modC = fb ? (mn[0] + mx[0]) / 2 : (mn[1] + mx[1]) / 2;
      const side = (Math.sign(sxSign * (covC - modC)) || -1);
      const zb = hasDoors ? [c.z0, r10(zdc.bz), r10(zdc.tz), c.z1] : [c.z0, c.z1];
      const labels = zb.slice(1).map((z, i) => Math.round(r10(z - zb[i]) * sc));
      const segIds = zb.length > 2 ? ['base', 'door', 'top'] : ['cov'];
      if (!wallOnly) chains.push({ key: 'height', axis: 'v', side, off: 34, anchors: zb.map((z) => [ax, ay, z]), labels, segIds });
      const tot = Math.round(r10(cabZ1 - cabZ0) * sc);
      chains.push({ key: 'total', axis: 'v', side, off: wallOnly ? 34 : 80, anchors: [[ax, ay, cabZ0], [ax, ay, cabZ1]], labels: [tot], segIds: ['all'] });
    } else {
      const ax = fb ? (sxSign > 0 ? mn[0] : mx[0]) : (mn[0] + mx[0]) / 2;
      const ay = fb ? (mn[1] + mx[1]) / 2 : (sxSign > 0 ? mn[1] : mx[1]);
      let off = 34;
      if (hasDoors && !wallOnly) {
        const zb = [cabZ0, r10(zdc.bz), r10(zdc.tz), cabZ1];
        const labels = zb.slice(1).map((z, i) => Math.round(r10(z - zb[i]) * sc));
        chains.push({ key: 'height', axis: 'v', side: -1, off, anchors: zb.map((z) => [ax, ay, z]), labels, segIds: ['base', 'door', 'top'] });
        off = 80;
      }
      const tot = Math.round(r10(cabZ1 - cabZ0) * sc);
      chains.push({ key: 'total', axis: 'v', side: -1, off, anchors: [[ax, ay, cabZ0], [ax, ay, cabZ1]], labels: [tot], segIds: ['all'] });
    }
    let mbTop = null;
    for (const b of boxes) { if (/__MB/.test(b.nm) && (mbTop == null || b.z1 > mbTop)) mbTop = b.z1; }
    if (mbTop != null) {
      const lx = fb ? (dc ? dc.bnds[Math.min(1, dc.bnds.length - 1)] : mn[0] + (mx[0] - mn[0]) * 0.15) : (dc ? dc.fx : (mn[0] + mx[0]) / 2);
      const ly = fb ? (dc ? dc.fy : (mn[1] + mx[1]) / 2) : (dc ? -dc.bnds[Math.min(1, dc.bnds.length - 1)] : mn[1] + (mx[1] - mn[1]) * 0.15);
      chains.push({ key: 'level', marker: true, shared: true, axis: 'h', side: -1, anchors: [[lx, ly, mbTop]], labels: [Math.round(r10(mbTop - mn[2]) * sc)], segIds: ['top'] });
    }
    if (f2Bot != null) {
      const lx = fb ? (sxSign > 0 ? mx[0] : mn[0]) : (mn[0] + mx[0]) / 2;
      const ly = fb ? (mn[1] + mx[1]) / 2 : (sxSign > 0 ? mx[1] : mn[1]);
      chains.push({ key: 'level', marker: true, shared: true, outside: true, axis: 'h', side: -1, anchors: [[lx, ly, f2Bot]], labels: [Math.round(r10(f2Bot + _bakeZ) * sc)], segIds: ['f2under'] });
    }
    return chains.length ? chains : null;
  };

  // ── pure SVG drawers (ported verbatim; admin/override paths inert) ─────────
  const dimDrawChain = (svg, ch, pts, off) => {
    if (!pts || pts.length < 2) return;
    const line = (x1, y1, x2, y2, w, col) => { const l = document.createElementNS(NS, 'line'); l.setAttribute('x1', x1); l.setAttribute('y1', y1); l.setAttribute('x2', x2); l.setAttribute('y2', y2); l.setAttribute('stroke', col || '#e2621f'); l.setAttribute('stroke-width', w || 1.3); svg.appendChild(l); };
    const txt = (x, y, i, rot) => {
      const t = document.createElementNS(NS, 'text');
      t.setAttribute('x', x); t.setAttribute('y', y);
      t.setAttribute('fill', '#c8500f');
      t.setAttribute('font-family', 'Flux Architect,ui-monospace,monospace');
      t.setAttribute('font-size', '13'); t.setAttribute('font-weight', '700');
      t.setAttribute('text-anchor', 'middle');
      if (rot) t.setAttribute('transform', `rotate(-90 ${x} ${y})`);
      t.textContent = String(ch.disp[i]);
      svg.appendChild(t);
    };
    const arrow = (x, y, dir) => { const p = document.createElementNS(NS, 'path'); const s = 5; let d; if (ch.axis === 'h') d = `M${x} ${y} l${dir * s} ${-s * 0.55} l0 ${s * 1.1} z`; else d = `M${x} ${y} l${-s * 0.55} ${dir * s} l${s * 1.1} 0 z`; p.setAttribute('d', d); p.setAttribute('fill', '#e2621f'); svg.appendChild(p); };
    const NARROW = 22;
    if (ch.axis === 'h') {
      const ys = pts.map(p => p.y);
      const dy = ch.side >= 0 ? Math.max(...ys) + off : Math.min(...ys) - off;
      const flow = pts[pts.length - 1].x >= pts[0].x ? 1 : -1;
      for (const p of pts) line(p.x, p.y, p.x, dy, 1, 'rgba(226,98,31,.6)');
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i].x, b = pts[i + 1].x;
        const w = Math.abs(b - a), narrow = w < NARROW, last = i === pts.length - 2;
        line(a, dy, b, dy, 1.3);
        const dir = a < b ? 1 : -1;
        arrow(a, dy, narrow ? -dir : dir); arrow(b, dy, narrow ? dir : -dir);
        if (ch.disp[i] != null) {
          const tx = !narrow ? (a + b) / 2 : (i === 0 ? a - flow * 16 : (last ? b + flow * 16 : (a + b) / 2));
          txt(tx, dy + (ch.side >= 0 ? 17 : -6), i, false);
        }
      }
    } else {
      const xs = pts.map(p => p.x);
      const dx = ch.side >= 0 ? Math.max(...xs) + off : Math.min(...xs) - off;
      const flow = pts[pts.length - 1].y >= pts[0].y ? 1 : -1;
      for (const p of pts) line(p.x, p.y, dx, p.y, 1, 'rgba(226,98,31,.6)');
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i].y, b = pts[i + 1].y;
        const w = Math.abs(b - a), narrow = w < NARROW, last = i === pts.length - 2;
        line(dx, a, dx, b, 1.3);
        const dir = a < b ? 1 : -1;
        arrow(dx, a, narrow ? -dir : dir); arrow(dx, b, narrow ? dir : -dir);
        if (ch.disp[i] != null) {
          const ty = !narrow ? (a + b) / 2 : (i === 0 ? a - flow * 16 : (last ? b + flow * 16 : (a + b) / 2));
          txt(dx + (ch.side >= 0 ? 14 : -6), ty, i, true);
        }
      }
    }
  };
  const dimDrawLevel = (svg, ch, pt0) => {
    if (!pt0) return;
    const pt = ch.outside ? { x: pt0.x + 40, y: pt0.y } : pt0;
    const val = '+' + String(ch.disp[0]);
    const ref = document.createElementNS(NS, 'line');
    ref.setAttribute('x1', pt.x - 26); ref.setAttribute('y1', pt.y); ref.setAttribute('x2', pt.x + 46); ref.setAttribute('y2', pt.y);
    ref.setAttribute('stroke', '#e2621f'); ref.setAttribute('stroke-width', 1.2); svg.appendChild(ref);
    const s = 7;
    const tri = document.createElementNS(NS, 'path');
    tri.setAttribute('d', `M${pt.x - s} ${pt.y - s * 1.5} L${pt.x + s} ${pt.y - s * 1.5} L${pt.x} ${pt.y} z`);
    tri.setAttribute('fill', '#e2621f'); svg.appendChild(tri);
    const t = document.createElementNS(NS, 'text');
    t.setAttribute('x', pt.x + s + 4); t.setAttribute('y', pt.y - s * 1.5 - 3);
    t.setAttribute('fill', '#c8500f');
    t.setAttribute('font-family', 'Flux Architect,ui-monospace,monospace');
    t.setAttribute('font-size', '13'); t.setAttribute('font-weight', '700');
    t.setAttribute('text-anchor', 'start');
    t.textContent = val;
    svg.appendChild(t);
  };

  const clear = () => {
    dimOn = false; dimFace = '';
    try { mv.querySelectorAll('[slot^="hotspot-dim-"]').forEach(el => el.remove()); } catch {}
    dimAnchors = [];
    try { if (dimSvg) { dimSvg.remove(); dimSvg = null; } } catch {}
    if (dimRedraw) { try { mv.removeEventListener('camera-change', dimRedraw); } catch {} }
    dimRedraw = null;
  };

  const angDiff = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

  const show = (face) => {
    clear();
    if (!mv || !VC_FACE_DIMS[face]) return;
    const ctx = buildCtx();
    const chains = ctx && kd3dDimSegments(face, ctx);
    if (!chains) {
      retry = (retry || 0) + 1;
      if (retry <= 10) setTimeout(() => { try { if (!dimOn) show(face); } catch {} }, 400);
      return;
    }
    retry = 0; dimOn = true; dimFace = face;
    for (const ch of chains) { ch.disp = ch.labels.slice(); }
    dimSvg = document.createElementNS(NS, 'svg');
    dimSvg.setAttribute('class', 'kd3d-dimsvg');
    dimSvg.style.cssText = 'position:absolute;inset:0;z-index:4;pointer-events:none;overflow:visible';
    (stageEl || document.body).appendChild(dimSvg);
    dimAnchors = chains.map((ch, ci) => ch.anchors.map((a, i) => {
      const b = document.createElement('button');
      b.setAttribute('slot', 'hotspot-dim-' + ci + '-' + i);
      b.setAttribute('data-position', a[0] + 'm ' + a[2] + 'm ' + (-a[1]) + 'm');
      b.setAttribute('data-normal', '0m 1m 0m');
      b.style.cssText = 'width:2px;height:2px;opacity:0;pointer-events:none;border:0;background:none;padding:0;margin:0';
      mv.appendChild(b);
      return b;
    }));
    dimRedraw = () => {
      try {
        if (!dimSvg) return;
        const tgt = VIEWS[dimFace];
        let showIt = true;
        try { const o = mv.getCameraOrbit(); if (o && tgt) showIt = angDiff(o.theta, tgt.theta) < 0.22 && Math.abs(o.phi - tgt.phi) < 0.22; } catch {}
        dimSvg.style.display = showIt ? '' : 'none';
        if (!showIt) return;
        const host = stageEl || document.body;
        const vb = host.getBoundingClientRect();
        dimSvg.setAttribute('width', vb.width); dimSvg.setAttribute('height', vb.height); dimSvg.setAttribute('viewBox', `0 0 ${vb.width} ${vb.height}`);
        while (dimSvg.firstChild) dimSvg.removeChild(dimSvg.firstChild);
        chains.forEach((ch, ci) => {
          const pts = ch.anchors.map((a, i) => {
            const hs = dimAnchors[ci] && dimAnchors[ci][i];
            const r = hs ? hs.getBoundingClientRect() : null;
            if (r && (r.width || r.height || r.left || r.top)) return { x: r.left + r.width / 2 - vb.left, y: r.top + r.height / 2 - vb.top };
            return null;
          }).filter(Boolean);
          if (pts.length !== ch.anchors.length) return; // not settled yet
          if (ch.marker) dimDrawLevel(dimSvg, ch, pts[0]);
          else dimDrawChain(dimSvg, ch, pts, ch.off || 34);
        });
      } catch {}
    };
    mv.addEventListener('camera-change', dimRedraw);
    requestAnimationFrame(dimRedraw);
    for (const ms of [80, 150, 450, 900, 1800]) {
      setTimeout(() => { try { const sc2 = getScene(); if (sc2 && typeof sc2.queueRender === 'function') sc2.queueRender(); } catch {} requestAnimationFrame(() => { try { dimRedraw && dimRedraw(); } catch {} }); }, ms);
    }
  };

  return { show, clear };
}
