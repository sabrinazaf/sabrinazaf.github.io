/* /eats/ page: map, charts and ranked list, drawn from assets/json/eats.json.
   Plain ES5 on purpose (the production build minifies it); the only dependency is Leaflet.
   All data goes into the page through textContent / setAttribute, never innerHTML. */
(function () {
  'use strict';

  var root = document.getElementById('eats-root');
  if (!root) { return; }

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var CATS = ['RES', 'BAK', 'COF', 'DES', 'BAR'];
  var CAT_CLASS = { RES: 'eats-k-res', BAK: 'eats-k-bak', COF: 'eats-k-cof', DES: 'eats-k-des', BAR: 'eats-k-bar' };
  var CAT_SHORT = { RES: 'restaurant', BAK: 'bakery', COF: 'coffee', DES: 'dessert', BAR: 'bar' };
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var REGIONS = [
    { label: 'Everywhere', bounds: null },
    { label: 'New York area', bounds: [[40.45, -74.45], [41.05, -73.65]] },
    { label: 'DC area', bounds: [[38.55, -77.7], [39.25, -76.9]] },
    { label: 'Bay Area', bounds: [[37.1, -122.6], [38.1, -121.7]] },
    { label: 'Europe', bounds: [[36.0, -10.5], [55.5, 19.0]] }
  ];
  var LOW = '#e6892f', MID = '#e8cfdc', HIGH = '#ad1c6f', NEUTRAL = '#a89aa3';
  var LIST_STEP = 25;

  var S = { d: null, cat: 'RES', q: '', city: null, showAll: false, mode: 'ranked', span: 20 };
  var map = null, tiles = null, layerWant = null, layerRanked = null;

  /* ---------------------------------------------------------------- helpers */
  function byId(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) { n.className = cls; }
    if (text !== undefined && text !== null) { n.textContent = text; }
    return n;
  }
  function svg(tag, attrs) {
    var n = document.createElementNS(SVG_NS, tag);
    var k;
    for (k in attrs) { if (Object.prototype.hasOwnProperty.call(attrs, k)) { n.setAttribute(k, attrs[k]); } }
    return n;
  }
  function svgText(str, attrs) { var t = svg('text', attrs); t.textContent = str; return t; }
  function clear(n) { while (n.firstChild) { n.removeChild(n.firstChild); } }
  function signed(x, d) { return (x < 0 ? '−' : '+') + Math.abs(x).toFixed(d === undefined ? 1 : d); }
  function plain(x, d) { return (x < 0 ? '−' : '') + Math.abs(x).toFixed(d === undefined ? 1 : d); }
  function pad2(n) { return n < 10 ? '0' + n : String(n); }
  function lc(s) { return String(s).toLowerCase(); }
  function hexRgb(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }
  function mix(a, b, t) {
    var A = hexRgb(a), B = hexRgb(b), i, out = [];
    for (i = 0; i < 3; i++) { out.push(Math.round(A[i] + (B[i] - A[i]) * t)); }
    return 'rgb(' + out.join(',') + ')';
  }
  function isDark() {
    if (typeof window.determineComputedTheme === 'function') { return window.determineComputedTheme() === 'dark'; }
    return document.documentElement.getAttribute('data-theme') === 'dark';
  }
  function catLabel(k) {
    var i, cs = S.d.categories;
    for (i = 0; i < cs.length; i++) { if (cs[i].k === k) { return cs[i].label; } }
    return k;
  }

  /* ------------------------------------------------------------------- data */
  function derive(d) {
    d.cities.forEach(function (c, i) {
      c.i = i; c.sum = 0; c.places = [];
      c.byCat = { RES: 0, BAK: 0, COF: 0, DES: 0, BAR: 0 };
    });
    d.places.forEach(function (p) {
      var c = d.cities[p.c];
      c.sum += p.s; c.places.push(p); c.byCat[p.k] += 1; p.city = c.city;
    });
    var maxDev = 0;
    d.cities.forEach(function (c) {
      c.avg = c.ranked ? c.sum / c.ranked : null;
      c.top = c.places.slice().sort(function (a, b) {
        var ra = a.k === 'RES' ? 0 : 1, rb = b.k === 'RES' ? 0 : 1;
        return (ra - rb) || (b.s - a.s) || (a.n < b.n ? -1 : 1);
      }).slice(0, 3);
      if (c.ranked >= 3) { maxDev = Math.max(maxDev, Math.abs(c.avg - 50)); }
    });
    S.span = Math.max(10, Math.min(30, maxDev));
  }

  /* ------------------------------------------------------------------ stats */
  function renderStats() {
    var d = S.d, host = byId('eats-stats'), cc = {}, n = 0;
    d.cities.forEach(function (c) { if (c.ranked > 0) { n += 1; cc[c.cc] = 1; } });
    var tiles = [
      [d.places.length, 'places ranked'], [n, 'cities'],
      [Object.keys(cc).length, 'countries'], [d.wantTotal, 'on my want-to-try list']
    ];
    clear(host);
    tiles.forEach(function (t) {
      var box = el('div', 'eats-stat');
      box.appendChild(el('div', 'eats-stat-num', String(t[0])));
      box.appendChild(el('div', 'eats-stat-label', t[1]));
      host.appendChild(box);
    });
  }

  /* -------------------------------------------------------------------- map */
  function scoreColor(c) {
    if (c.ranked < 3) { return NEUTRAL; }
    var t = Math.max(-1, Math.min(1, (c.avg - 50) / S.span));
    return t < 0 ? mix(MID, LOW, -t) : mix(MID, HIGH, t);
  }
  function radius(n) { return 4 + Math.sqrt(n) * 2; }

  function popupFor(c) {
    var d = S.d, box = el('div', 'eats-pop'), bits = [], parts = [];
    box.appendChild(el('div', 'eats-pop-title', c.city));
    if (c.ranked) { bits.push(c.ranked + ' ranked'); }
    if (c.want) { bits.push(c.want + ' on my list'); }
    box.appendChild(el('div', 'eats-pop-meta', bits.join(' · ')));
    if (c.ranked) {
      d.categories.forEach(function (k) {
        if (c.byCat[k.k]) { parts.push(c.byCat[k.k] + ' ' + lc(k.label)); }
      });
      box.appendChild(el('div', 'eats-pop-meta', parts.join(' · ')));
      if (c.ranked >= 3) {
        box.appendChild(el('div', 'eats-pop-meta', 'average percentile ' + Math.round(c.avg) + ' (50 = typical)'));
      }
      box.appendChild(el('div', 'eats-pop-h', 'Top picks'));
      var ol = el('ol', 'eats-pop-top');
      c.top.forEach(function (p) {
        var tail = ' · #' + p.r + (p.k === 'RES' ? '' : ' ' + CAT_SHORT[p.k]);
        ol.appendChild(el('li', null, p.n + tail));
      });
      box.appendChild(ol);
      var btn = el('button', 'eats-pop-btn', 'Browse these ↓');
      btn.type = 'button';
      btn.addEventListener('click', function () { setCity(c.i); });
      box.appendChild(btn);
    }
    return box;
  }

  function setTiles() {
    /* OpenStreetMap's own tiles (no API key needed, light-traffic use with attribution is
       what their tile policy allows). The look (greyscale in light mode, inverted in dark
       mode) comes from CSS filters on the tile pane in eats.css, so there is nothing to swap. */
    tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    });
    tiles.addTo(map);
  }

  function drawMarkers() {
    if (layerWant) { map.removeLayer(layerWant); }
    if (layerRanked) { map.removeLayer(layerRanked); }
    layerWant = L.layerGroup();
    layerRanked = L.layerGroup();
    var ring = isDark() ? '#f2e6ee' : '#3d2c38';
    var cs = S.d.cities.slice().sort(function (a, b) {
      return Math.max(b.ranked, b.want) - Math.max(a.ranked, a.want);
    });
    cs.forEach(function (c) {
      var pos = [c.lat, c.lng];
      if (c.want && S.mode !== 'ranked') {
        L.circleMarker(pos, { radius: radius(c.want), color: ring, weight: 1.5, dashArray: '3 4', fillOpacity: 0 })
          .bindPopup(function () { return popupFor(c); }, { maxWidth: 300 })
          .addTo(layerWant);
      }
      if (c.ranked && S.mode !== 'want') {
        L.circleMarker(pos, { radius: radius(c.ranked), color: ring, weight: 1, fillColor: scoreColor(c), fillOpacity: 0.88 })
          .bindPopup(function () { return popupFor(c); }, { maxWidth: 300 })
          .addTo(layerRanked);
      }
    });
    layerWant.addTo(map);
    layerRanked.addTo(map);
  }

  function fitAll() {
    /* frame what is currently drawn: ranked cities by default, everything when want-to-try is on */
    var pts = S.d.cities.filter(function (c) { return S.mode === 'ranked' ? c.ranked > 0 : true; })
      .map(function (c) { return [c.lat, c.lng]; });
    map.fitBounds(pts, { padding: [30, 30] });
  }

  function chipGroup(host, items, onPick, activeFn) {
    clear(host);
    items.forEach(function (it, i) {
      var b = el('button', 'eats-chip' + (activeFn && activeFn(it, i) ? ' is-active' : ''), it.label);
      b.type = 'button';
      if (activeFn) { b.setAttribute('aria-pressed', activeFn(it, i) ? 'true' : 'false'); }
      b.addEventListener('click', function () { onPick(it, i); });
      host.appendChild(b);
    });
  }

  function renderMapControls() {
    var modes = [{ label: 'Ranked', v: 'ranked' }, { label: 'Want to try', v: 'want' }, { label: 'Both', v: 'both' }];
    function drawModes() {
      chipGroup(byId('eats-mode'), modes, function (it) { S.mode = it.v; drawModes(); drawMarkers(); fitAll(); },
        function (it) { return it.v === S.mode; });
    }
    drawModes();
    chipGroup(byId('eats-regions'), REGIONS, function (it) {
      if (it.bounds) { map.fitBounds(it.bounds); } else { fitAll(); }
    });
    var lg = byId('eats-legend');
    clear(lg);
    var a = el('span', null, 'Colour: lower');
    a.appendChild(el('span', 'eats-ramp'));
    a.appendChild(document.createTextNode('higher average percentile of my picks (3+ places)'));
    lg.appendChild(a);
    lg.appendChild(el('span', null, 'Size: places ranked'));
    var r = el('span');
    r.appendChild(el('span', 'eats-ring'));
    r.appendChild(document.createTextNode('want to try'));
    lg.appendChild(r);
  }

  function initMap() {
    var host = byId('eats-map');
    if (typeof L === 'undefined') {
      host.appendChild(el('p', 'eats-fallback', 'The map library did not load, so the map is unavailable. Everything else on this page still works.'));
      return;
    }
    map = L.map(host, { scrollWheelZoom: false, minZoom: 1, worldCopyJump: true });
    map.on('click', function () { map.scrollWheelZoom.enable(); });
    setTiles();
    drawMarkers();
    fitAll();
    renderMapControls();
    if (window.MutationObserver) {
      new MutationObserver(function () { drawMarkers(); })
        .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-theme-setting'] });
    }
  }

  /* ----------------------------------------------------------- paired bars */
  function renderCities() {
    var host = byId('eats-cities'), vals = [], rows;
    rows = S.d.cities.slice().sort(function (a, b) { return (b.ranked + b.want) - (a.ranked + a.want); }).slice(0, 14);
    rows.forEach(function (c) { vals.push(c.ranked, c.want); });
    vals.sort(function (a, b) { return b - a; });
    var cap = Math.max(10, Math.ceil((vals[2] || 10) * 1.25 / 5) * 5);
    clear(host);
    function bar(kind, n, word) {
      var line = el('div', 'eats-bar-line');
      var b = el('div', 'eats-bar ' + kind + (n > cap ? ' eats-bar-cut' : ''));
      b.style.width = (Math.min(n, cap) / cap * 84) + '%'; /* leave room for the label */
      line.appendChild(b);
      line.appendChild(el('span', null, n + ' ' + word));
      return line;
    }
    rows.forEach(function (c) {
      var row = el('div', 'eats-row');
      row.appendChild(el('div', 'eats-row-label', c.city));
      var tr = el('div', 'eats-track');
      if (c.ranked) { tr.appendChild(bar('eats-bar-ranked', c.ranked, 'ranked')); }
      if (c.want) { tr.appendChild(bar('eats-bar-want', c.want, 'to try')); }
      row.appendChild(tr);
      host.appendChild(row);
    });
  }

  /* --------------------------------------------------------------- timeline */
  function renderTimeline() {
    var d = S.d, counts = {}, keys, months = [], y, m, key, last;
    d.places.forEach(function (p) {
      if (!counts[p.d]) { counts[p.d] = { RES: 0, BAK: 0, COF: 0, DES: 0, BAR: 0, total: 0 }; }
      counts[p.d][p.k] += 1; counts[p.d].total += 1;
    });
    keys = Object.keys(counts).sort();
    y = parseInt(keys[0].slice(0, 4), 10); m = parseInt(keys[0].slice(5, 7), 10); last = keys[keys.length - 1];
    for (;;) {
      key = y + '-' + pad2(m);
      months.push(key);
      if (key === last) { break; }
      m += 1;
      if (m > 12) { m = 1; y += 1; }
    }
    var W = 900, H = 230, ml = 34, mr = 8, mt = 10, mb = 26;
    var pw = W - ml - mr, ph = H - mt - mb, bw = pw / months.length;
    var maxTotal = 0, peak = '';
    months.forEach(function (k) {
      var t = counts[k] ? counts[k].total : 0;
      if (t > maxTotal) { maxTotal = t; peak = k; }
    });
    var ymax = Math.ceil(maxTotal / 10) * 10;
    var host = byId('eats-timeline');
    clear(host);
    var s = svg('svg', { 'class': 'eats-svg', viewBox: '0 0 ' + W + ' ' + H, role: 'img',
      'aria-label': 'Stacked bar chart of places added per month over ' + months.length + ' months; the busiest month was ' +
        MONTHS[parseInt(peak.slice(5, 7), 10) - 1] + ' ' + peak.slice(0, 4) + ' with ' + maxTotal + '.' });
    [0, ymax / 2, ymax].forEach(function (v) {
      var yy = mt + ph - (v / ymax) * ph;
      s.appendChild(svg('line', { 'class': 'eats-grid', x1: ml, x2: W - mr, y1: yy, y2: yy }));
      s.appendChild(svgText(String(v), { 'class': 'eats-tick', x: ml - 6, y: yy + 3, 'text-anchor': 'end' }));
    });
    months.forEach(function (k, i) {
      var c = counts[k] || { total: 0 }, x = ml + i * bw + bw * 0.14, base = mt + ph;
      var g = svg('g', {});
      var mon = MONTHS[parseInt(k.slice(5, 7), 10) - 1] + ' ' + k.slice(0, 4);
      var tip = svg('title', {});
      tip.textContent = mon + ': ' + c.total + ' added';
      g.appendChild(tip);
      CATS.forEach(function (cat) {
        var n = c[cat] || 0, h = n / ymax * ph;
        if (!n) { return; }
        base -= h;
        g.appendChild(svg('rect', { 'class': CAT_CLASS[cat], x: x, y: base, width: bw * 0.72, height: h }));
      });
      s.appendChild(g);
      if (k.slice(5, 7) === '01' || i === 0) {
        var lab = k.slice(5, 7) === '01' ? k.slice(0, 4) : MONTHS[parseInt(k.slice(5, 7), 10) - 1] + ' ' + k.slice(0, 4);
        s.appendChild(svgText(lab, { 'class': 'eats-tick', x: ml + i * bw, y: H - 8, 'text-anchor': 'start' }));
      }
    });
    host.appendChild(s);
    var legend = byId('eats-timeline-key');
    clear(legend);
    CATS.forEach(function (cat) {
      var item = el('span');
      item.appendChild(el('span', 'eats-swatch ' + CAT_CLASS[cat]));
      item.appendChild(document.createTextNode(catLabel(cat)));
      legend.appendChild(item);
    });
  }

  /* ------------------------------------------------------------ forest plots */
  function niceDomain(rows, ref) {
    var lo = ref, hi = ref;
    rows.forEach(function (r) { r.series.forEach(function (s) { lo = Math.min(lo, s.lo); hi = Math.max(hi, s.hi); }); });
    return { lo: Math.floor((lo - 1) / 10) * 10, hi: Math.ceil((hi + 1) / 10) * 10 };
  }

  function forest(host, rows, o) {
    clear(host);
    var dom = o.domain || niceDomain(rows, o.ref), W = 400, p = 10;
    function x(v) { return p + (v - dom.lo) / (dom.hi - dom.lo) * (W - 2 * p); }
    var step = o.step || 10, ticks = [], t;
    for (t = Math.ceil(dom.lo / step) * step; t <= dom.hi + 1e-9; t += step) { ticks.push(t); }

    rows.forEach(function (r) {
      var H = r.series.length > 1 ? 40 : 28;
      var row = el('div', 'eats-forest-row');
      var nm = el('div', 'eats-forest-name', r.name);
      if (r.unit) { nm.appendChild(el('span', 'eats-forest-unit', r.unit)); }
      row.appendChild(nm);
      var right = el('div');
      var s = svg('svg', { 'class': 'eats-svg', viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': r.aria });
      s.appendChild(svg('line', { 'class': 'eats-ref', x1: x(o.ref), x2: x(o.ref), y1: 0, y2: H }));
      r.series.forEach(function (se, i) {
        var yy = r.series.length > 1 ? (i === 0 ? 13 : 28) : H / 2;
        var cls = (se.lo > o.ref || se.hi < o.ref) ? 'eats-ci-sig' : 'eats-ci-null';
        s.appendChild(svg('line', { 'class': cls + (se.hollow ? ' eats-ci-line-thin' : ' eats-ci-line'),
          x1: x(se.lo), x2: x(se.hi), y1: yy, y2: yy }));
        s.appendChild(svg('circle', { 'class': cls + (se.hollow ? ' eats-dot-hollow' : ''), cx: x(se.b), cy: yy, r: se.hollow ? 3.6 : 4.4 }));
      });
      right.appendChild(s);
      right.appendChild(el('div', 'eats-note', r.caption));
      row.appendChild(right);
      host.appendChild(row);
    });

    var axisRow = el('div', 'eats-forest-row');
    axisRow.appendChild(el('div', 'eats-forest-name', ''));
    var ax = el('div');
    var s2 = svg('svg', { 'class': 'eats-svg', viewBox: '0 0 ' + W + ' 24', 'aria-hidden': 'true' });
    s2.appendChild(svg('line', { 'class': 'eats-axis-line', x1: p, x2: W - p, y1: 3, y2: 3 }));
    ticks.forEach(function (tv) {
      s2.appendChild(svg('line', { 'class': 'eats-axis-line', x1: x(tv), x2: x(tv), y1: 3, y2: 7 }));
      s2.appendChild(svgText(o.tickLabel ? o.tickLabel(tv) : String(tv), { 'class': 'eats-tick', x: x(tv), y: 19, 'text-anchor': 'middle' }));
    });
    ax.appendChild(s2);
    ax.appendChild(el('div', 'eats-note', o.axisTitle));
    axisRow.appendChild(ax);
    host.appendChild(axisRow);
  }

  function ciText(c) { return signed(c.b) + ' [' + plain(c.lo) + ', ' + plain(c.hi) + ']'; }

  function renderForest() {
    var a = S.d.analysis, byKey = {};
    a.coefRestaurants.forEach(function (c) { byKey[c.key] = c; });
    var rows = a.coef.map(function (c) {
      var r = byKey[c.key];
      return {
        name: c.label, unit: c.unit,
        series: [{ b: c.b, lo: c.lo, hi: c.hi }, { b: r.b, lo: r.lo, hi: r.hi, hollow: true }],
        caption: 'all: ' + ciText(c) + '  ·  restaurants: ' + ciText(r),
        aria: c.label + ': ' + ciText(c) + ' percentile points, 95% confidence interval'
      };
    });
    var key = byId('eats-forest-key');
    clear(key);
    var k1 = el('span'); k1.appendChild(el('span', 'eats-swatch', '')); k1.lastChild.style.cssText = 'background:var(--eats-hot);border-radius:50%';
    k1.appendChild(document.createTextNode('all categories'));
    var k2 = el('span'); k2.appendChild(el('span', 'eats-swatch', '')); k2.lastChild.style.cssText = 'border:2px solid var(--eats-hot);border-radius:50%;box-sizing:border-box';
    k2.appendChild(document.createTextNode('restaurants only'));
    key.appendChild(k1); key.appendChild(k2);
    key.appendChild(el('span', null, 'fuchsia = interval clears zero'));
    forest(byId('eats-forest'), rows, { ref: 0, step: 10, axisTitle: '← ranked lower    percentile points    ranked higher →' });

    // plain-English reading of every predictor tested (all of them, not just the interesting ones)
    var extra = {
      z_sent: 'A sanity check as much as a finding: what I write about a place and where I rank it agree.',
      z_photos: 'Suggestive rather than decisive: with eight things tested, a stray result or two is expected.',
      fav_photo: 'Suggestive rather than decisive: with eight things tested, a stray result or two is expected.',
      has_note: 'Measured against a note of typical warmth.'
    };
    var ul = byId('eats-takes');
    clear(ul);
    a.coef.forEach(function (c) {
      var sig = c.lo > 0 || c.hi < 0;
      var li = el('li', sig ? 'is-sig' : '');
      li.appendChild(el('b', null, c.label + ': '));
      var sizeNote = '';
      if (!sig && c.n1 !== null && c.n1 < 60) { sizeNote = ' With only ' + c.n1 + ' such places I can’t rule out an effect of about ±' + Math.round(Math.max(Math.abs(c.lo), Math.abs(c.hi))) + ' points.'; }
      else if (!sig) { sizeNote = ' Interval runs from ' + plain(c.lo) + ' to ' + signed(c.hi) + ', so I can’t tell.'; }
      li.appendChild(document.createTextNode(signed(c.b) + ' points (' + c.unit + '; 95% CI ' + plain(c.lo) + ' to ' + signed(c.hi) + '). ' +
        (sig ? 'A clear signal.' : 'Not distinguishable from zero.') + sizeNote + (extra[c.key] && (sig || c.key === 'has_note') ? ' ' + extra[c.key] : '')));
      ul.appendChild(li);
    });
  }

  /* ---------------------------------------------------------------- scatter */
  function scatter(host, pts, curve, o) {
    clear(host);
    var W = 440, H = 300, ml = 38, mr = 10, mt = 10, mb = 44;
    function sx(v) { return ml + (v - o.xmin) / (o.xmax - o.xmin) * (W - ml - mr); }
    function sy(v) { return mt + (1 - v / 100) * (H - mt - mb); }
    var s = svg('svg', { 'class': 'eats-svg', viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': o.aria });
    [0, 25, 50, 75, 100].forEach(function (v) {
      s.appendChild(svg('line', { 'class': 'eats-grid', x1: ml, x2: W - mr, y1: sy(v), y2: sy(v) }));
      s.appendChild(svgText(String(v), { 'class': 'eats-tick', x: ml - 6, y: sy(v) + 3, 'text-anchor': 'end' }));
    });
    o.xticks.forEach(function (t) {
      s.appendChild(svg('line', { 'class': 'eats-axis-line', x1: sx(t.v), x2: sx(t.v), y1: H - mb, y2: H - mb + 4 }));
      s.appendChild(svgText(t.label, { 'class': 'eats-tick', x: sx(t.v), y: H - mb + 15, 'text-anchor': 'middle' }));
    });
    pts.forEach(function (p) {
      s.appendChild(svg('circle', { 'class': 'eats-pt', cx: sx(p[0]), cy: sy(p[1]), r: 2.8 }));
    });
    var up = [], dn = [], ln = [];
    curve.forEach(function (c) {
      up.push(sx(c[0]).toFixed(1) + ',' + sy(c[3]).toFixed(1));
      dn.unshift(sx(c[0]).toFixed(1) + ',' + sy(c[2]).toFixed(1));
      ln.push(sx(c[0]).toFixed(1) + ',' + sy(c[1]).toFixed(1));
    });
    s.appendChild(svg('polygon', { 'class': 'eats-band', points: up.concat(dn).join(' ') }));
    s.appendChild(svg('polyline', { 'class': 'eats-curve', points: ln.join(' ') }));
    s.appendChild(svgText(o.xlabel, { 'class': 'eats-axis-title', x: (ml + W - mr) / 2, y: H - 6, 'text-anchor': 'middle' }));
    var yl = svgText('rank percentile (100 = my favourite)', { 'class': 'eats-axis-title', x: 0, y: 0, 'text-anchor': 'middle',
      transform: 'translate(10,' + ((mt + H - mb) / 2) + ') rotate(-90)' });
    s.appendChild(yl);
    host.appendChild(s);
  }

  function renderScatters() {
    var d = S.d, a = d.analysis, sp = a.spearman;
    var sentPts = d.places.filter(function (p) { return p.v !== undefined; }).map(function (p) { return [p.v, p.s]; });
    scatter(byId('eats-scatter-sent'), sentPts, a.curves.sentiment, {
      xmin: -1, xmax: 1, xlabel: 'note sentiment (−1 cold, +1 warm)',
      xticks: [{ v: -1, label: '−1' }, { v: -0.5, label: '−0.5' }, { v: 0, label: '0' }, { v: 0.5, label: '0.5' }, { v: 1, label: '1' }],
      aria: 'Scatter plot of rank percentile against note sentiment with a smoothed curve rising from left to right. Spearman correlation ' + sp.sentiment.rho + '.'
    });
    var yrPts = d.places.map(function (p) { return [p.y, p.s]; });
    var t0 = Date.parse(d.start + 'T00:00:00Z'), yearMs = 365.25 * 86400000, maxY = 0, ticks = [], yy;
    var startLabel = MONTHS[new Date(t0).getUTCMonth()] + ' ' + new Date(t0).getUTCFullYear();
    yrPts.forEach(function (p) { maxY = Math.max(maxY, p[0]); });
    maxY = Math.ceil(maxY * 10) / 10;
    for (yy = new Date(t0).getUTCFullYear() + 1; ; yy++) {
      var v = (Date.UTC(yy, 0, 1) - t0) / yearMs;
      if (v > maxY) { break; }
      ticks.push({ v: v, label: String(yy) });
    }
    scatter(byId('eats-scatter-years'), yrPts, a.curves.years, {
      xmin: 0, xmax: maxY, xlabel: 'when I added it (axis starts ' + startLabel + ', my first entry)', xticks: ticks,
      aria: 'Scatter plot of rank percentile against date added with a smoothed curve that stays roughly flat. Spearman correlation ' + sp.years.rho + '.'
    });
  }

  /* ------------------------------------------------------------------ words */
  function renderWords() {
    var w = S.d.analysis.words, host = byId('eats-words'), maxZ = 0;
    clear(host);
    var loved = w.loved.slice(0, 12), mid = w.mid.slice(0, 12);
    loved.concat(mid).forEach(function (r) { maxZ = Math.max(maxZ, Math.abs(r.z)); });
    function col(title, list, cls, countText) {
      var c = el('div', cls);
      c.appendChild(el('div', 'eats-pop-h', title));
      list.forEach(function (r) {
        var row = el('div', 'eats-word');
        row.appendChild(el('span', null, r.w));
        var bar = el('div', 'eats-word-bar');
        bar.style.width = (Math.abs(r.z) / maxZ * 100) + '%';
        row.appendChild(bar);
        row.appendChild(el('span', 'eats-word-n', r.top + ' vs ' + r.bot));
        c.appendChild(row);
      });
      c.appendChild(el('div', 'eats-note', countText));
      return c;
    }
    var countText = 'numbers: notes with the word in my top third (' + w.n_top + ' notes) vs. bottom third (' + w.n_bottom + ' notes)';
    host.appendChild(col('Leans toward my top third', loved, 'eats-words-loved', countText));
    host.appendChild(col('Leans toward my bottom third', mid, 'eats-words-mid', countText));
  }

  /* ---------------------------------------------------------------- cuisine */
  function renderCuisine() {
    var cu = S.d.analysis.cuisines, rows;
    byId('eats-cuisine-lede').textContent = 'About ' + Math.round(cu.coverage * 100) + '% of my restaurants have a cuisine word in the name (pizza, ramen, taco…), ' +
      'so this is a keyword guess, not a classification, and only groups with five or more places are shown. Dots are the average percentile with 95% confidence intervals (wide, because the groups are small); ' +
      cu.baseline.toFixed(0) + ' is the restaurant average by construction.';
    rows = cu.rows.map(function (r) {
      return { name: r.label, unit: 'n = ' + r.n, series: [{ b: r.mean, lo: r.lo, hi: r.hi }],
        caption: 'mean ' + r.mean.toFixed(1) + ' [' + r.lo.toFixed(1) + ', ' + r.hi.toFixed(1) + ']',
        aria: r.label + ' average percentile ' + r.mean.toFixed(1) };
    });
    forest(byId('eats-cuisine'), rows, { ref: cu.baseline, domain: { lo: 0, hi: 100 }, step: 25,
      axisTitle: '← ranked lower    average percentile    ranked higher →' });
  }

  function renderFit() {
    var f = S.d.analysis.fit;
    byId('eats-fit').textContent = 'Putting all eight things in one model, predictions on held-out places (10-fold cross-validation, repeated) explain about ' +
      Math.round(f.r2_cv * 100) + '% of the variation in my rankings (±' + Math.round(f.r2_cv_sd * 100) + ' across folds; ' + Math.round(f.r2_in * 100) +
      '% in-sample), and the predicted order correlates ' + f.rho_cv.toFixed(2) + ' with the real one. ' +
      'Most of my taste is not in this export: price, cuisine, who I was with and what I ordered are not recorded, and my notes partly just restate the ranking.';
  }

  /* ------------------------------------------------------------------- list */
  function filtered(cat) {
    var q = lc(S.q).replace(/^\s+|\s+$/g, '');
    return S.d.places.filter(function (p) {
      if (p.k !== cat) { return false; }
      if (S.city !== null && p.c !== S.city) { return false; }
      if (q && lc(p.n).indexOf(q) < 0 && lc(p.city).indexOf(q) < 0) { return false; }
      return true;
    });
  }

  function renderTabs() {
    var items = S.d.categories.map(function (c) { return { label: c.label + ' ' + filtered(c.k).length, k: c.k }; });
    chipGroup(byId('eats-tabs'), items, function (it) { S.cat = it.k; S.showAll = false; renderTabs(); renderList(); },
      function (it) { return it.k === S.cat; });
    var f = byId('eats-filter');
    clear(f);
    if (S.city !== null) {
      var b = el('button', 'eats-filter-tag', S.d.cities[S.city].city + ' ×');
      b.type = 'button';
      b.setAttribute('aria-label', 'Clear the city filter');
      b.addEventListener('click', function () { S.city = null; S.showAll = false; renderTabs(); renderList(); });
      f.appendChild(b);
    }
  }

  function renderList() {
    var rows = filtered(S.cat), ol = byId('eats-list'), more = byId('eats-more');
    clear(ol); clear(more);
    if (!rows.length) {
      ol.appendChild(el('li', 'eats-empty', 'Nothing in this category matches.'));
      return;
    }
    var shown = S.showAll ? rows : rows.slice(0, LIST_STEP);
    shown.forEach(function (p) {
      var li = el('li', 'eats-item');
      li.appendChild(el('span', 'eats-rank', String(p.r)));
      var box = el('span', 'eats-place', p.n);
      var sub = p.city + (p.f ? ' · order: ' + p.f : '');
      box.appendChild(el('span', 'eats-sub', sub));
      li.appendChild(box);
      ol.appendChild(li);
    });
    if (rows.length > LIST_STEP) {
      var b = el('button', 'eats-chip', S.showAll ? 'Show fewer' : 'Show all ' + rows.length);
      b.type = 'button';
      b.addEventListener('click', function () { S.showAll = !S.showAll; renderList(); });
      more.appendChild(b);
    }
  }

  function bestCategory(ci) {
    var c = S.d.cities[ci], best = 'RES', n = -1;
    CATS.forEach(function (k) { if (c.byCat[k] > n) { n = c.byCat[k]; best = k; } });
    return c.byCat.RES ? 'RES' : best;
  }

  function setCity(ci) {
    S.city = ci; S.q = ''; S.showAll = false; S.cat = bestCategory(ci);
    byId('eats-q').value = '';
    if (map) { map.closePopup(); }
    renderTabs(); renderList();
    byId('eats-tabs').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function initList() {
    byId('eats-q').addEventListener('input', function (e) {
      S.q = e.target.value; S.showAll = false; renderTabs(); renderList();
    });
    renderTabs(); renderList();
  }

  /* ------------------------------------------------------------------- boot */
  function start(d) {
    S.d = d;
    derive(d);
    renderStats();
    initMap();
    renderCities();
    renderTimeline();
    renderForest();
    renderScatters();
    renderWords();
    renderCuisine();
    renderFit();
    initList();
  }

  fetch(root.getAttribute('data-src'))
    .then(function (r) { if (!r.ok) { throw new Error('HTTP ' + r.status); } return r.json(); })
    .then(start)
    .catch(function (e) {
      root.insertBefore(el('p', 'eats-fallback', 'Could not load the data (' + e.message + ').'), root.firstChild);
    });
}());
