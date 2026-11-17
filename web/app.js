/* Colorado precipitation & wildland fire map */
(function () {
  "use strict";

  // ----------------------------------------------------------------- constants
  const CO = { w: -109.0603, e: -102.042, s: 36.9925, n: 41.0034 };
  const CO_RING = [[CO.s, CO.w], [CO.s, CO.e], [CO.n, CO.e], [CO.n, CO.w]];

  // Sequential (blue, light -> dark) annual precipitation classes, inches
  const SEQ = {
    breaks: [10, 13, 16, 20, 25, 30, 40],          // class upper bounds
    colors: ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#2a78d6", "#256abf", "#184f95", "#0d366b"],
    labels: ["", "10", "13", "16", "20", "25", "30", "40+"],
  };
  // Diverging: percent of average (dry = brown, normal = gray, wet = blue)
  const DIV = {
    breaks: [60, 75, 90, 110, 125, 140],
    colors: ["#8c510a", "#bf812d", "#dfc27d", "#e9e8e3", "#9ec5f4", "#3987e5", "#184f95"],
    labels: ["", "60%", "75%", "90%", "110%", "125%", "140%"],
  };
  const BIN_LABELS = ["< 10 in", "10–13", "13–16", "16–20", "20–25", "25–30", "30–40", "40+ in"];

  const $ = (id) => document.getElementById(id);
  const fmt = (n, d = 0) => n == null || isNaN(n) ? "–" :
    n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });

  const state = {
    mode: "mean", year: 2020, opacity: 0.7,
    showFires: true, yearOnly: true, showOld: false, showRx: false, minAcres: 1000,
  };
  let P = null;          // precip grid object
  let FIRES = null;      // geojson
  let yearStats = {};    // year -> {precip, acres, n}
  let coMask = null;     // Uint8Array, 1 = cell centre inside Colorado
  let precipOverlay = null, fireLayer = null, playTimer = null;

  // ----------------------------------------------------------------- map
  const map = L.map("map", { zoomControl: true, minZoom: 5, maxZoom: 16 })
    .fitBounds([[CO.s, CO.w], [CO.n, CO.e]], { padding: [20, 20] });

  map.createPane("precip").style.zIndex = 350;
  map.createPane("fires").style.zIndex = 420;
  map.createPane("labels").style.zIndex = 460;
  map.getPane("labels").style.pointerEvents = "none";

  const esri = (svc, opts = {}) => L.tileLayer(
    `https://server.arcgisonline.com/ArcGIS/rest/services/${svc}/MapServer/tile/{z}/{y}/{x}`,
    Object.assign({ maxZoom: 16, attribution: "Basemap © Esri and its data providers" }, opts));

  const bases = {
    "Light gray": esri("Canvas/World_Light_Gray_Base"),
    "Topographic": esri("World_Topo_Map"),
    "Satellite": esri("World_Imagery"),
    "Shaded relief": esri("World_Shaded_Relief", { maxZoom: 13 }),
    "OpenStreetMap": L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      { maxZoom: 16, attribution: "© OpenStreetMap contributors" }),
  };
  bases["Light gray"].addTo(map);
  const labels = esri("Reference/World_Boundaries_and_Places", { pane: "labels" }).addTo(map);
  const outline = L.polygon(CO_RING, { color: "#0b0b0b", weight: 2, fill: false, interactive: false });
  outline.addTo(map);
  const overlays = { "Place names": labels, "Colorado border": outline };
  const layerCtl = L.control.layers(bases, overlays, { position: "topleft", collapsed: true }).addTo(map);
  L.control.scale({ imperial: true, metric: true, position: "bottomright" }).addTo(map);

  const fireRenderer = L.canvas({ pane: "fires", tolerance: 4 });

  // ----------------------------------------------------------------- grid helpers
  function cellIndex(lat, lon) {
    const c = Math.floor((lon - P.west) / P.dx);
    const r = Math.floor((P.north - lat) / P.dy);
    if (c < 0 || r < 0 || c >= P.ncols || r >= P.nrows) return -1;
    return r * P.ncols + c;
  }
  function valueAt(arr, lat, lon) {
    const i = cellIndex(lat, lon);
    if (i < 0) return null;
    const v = arr[i];
    return v < 0 ? null : v / 10;
  }
  const inCO = (lat, lon) => lat >= CO.s && lat <= CO.n && lon >= CO.w && lon <= CO.e;
  const classOf = (v, breaks) => { let k = 0; while (k < breaks.length && v >= breaks[k]) k++; return k; };
  function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; }
  const SEQ_RGB = SEQ.colors.map(hexToRgb), DIV_RGB = DIV.colors.map(hexToRgb);

  // ----------------------------------------------------------------- precip raster
  function renderPrecip() {
    if (!P) return;
    const south = P.north - P.nrows * P.dy, east = P.west + P.ncols * P.dx;
    const merc = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2));
    const W = P.ncols * 4;
    const mN = merc(P.north), mS = merc(south);
    const H = Math.round(W * (mN - mS) / ((east - P.west) * Math.PI / 180));
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const ctx = cv.getContext("2d");
    const img = ctx.createImageData(W, H);
    const mean = P.mean, yr = P.grids[String(state.year)];
    const colOf = new Int32Array(W);
    for (let x = 0; x < W; x++) colOf[x] = Math.min(P.ncols - 1, Math.floor((x + 0.5) / W * P.ncols));

    for (let y = 0; y < H; y++) {
      const m = mN - (y + 0.5) / H * (mN - mS);
      const lat = Math.atan(Math.sinh(m)) * 180 / Math.PI;
      const r = Math.min(P.nrows - 1, Math.floor((P.north - lat) / P.dy));
      for (let x = 0; x < W; x++) {
        const i = r * P.ncols + colOf[x];
        if (!coMask[i]) continue;
        let rgb = null;
        if (state.mode === "mean") {
          if (mean[i] >= 0) rgb = SEQ_RGB[classOf(mean[i] / 10, SEQ.breaks)];
        } else if (state.mode === "year") {
          if (yr && yr[i] >= 0) rgb = SEQ_RGB[classOf(yr[i] / 10, SEQ.breaks)];
        } else if (yr && yr[i] >= 0 && mean[i] > 0) {
          rgb = DIV_RGB[classOf(100 * yr[i] / mean[i], DIV.breaks)];
        }
        if (!rgb) continue;
        const o = (y * W + x) * 4;
        img.data[o] = rgb[0]; img.data[o + 1] = rgb[1]; img.data[o + 2] = rgb[2]; img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const url = cv.toDataURL("image/png");
    const bounds = [[south, P.west], [P.north, east]];
    if (!precipOverlay) {
      precipOverlay = L.imageOverlay(url, bounds, {
        pane: "precip", opacity: state.opacity, interactive: false, className: "precip-img",
      }).addTo(map);
      layerCtl.addOverlay(precipOverlay, "Precipitation");
    } else {
      precipOverlay.setUrl(url);
    }
    renderLegend();
  }

  function renderLegend() {
    const div = state.mode === "anom";
    const S = div ? DIV : SEQ;
    const span = `${P.years[0]}–${P.years[P.years.length - 1]}`;
    const cap = state.mode === "mean" ? `Average annual precipitation, ${span} (inches)`
      : state.mode === "year" ? `Total precipitation in ${state.year} (inches)`
      : `${state.year} precipitation as % of the ${span} average`;
    $("legend").innerHTML =
      `<div class="cap">${cap}</div>` +
      `<div class="bar">${S.colors.map((c) => `<span style="background:${c}"></span>`).join("")}</div>` +
      `<div class="ticks">${S.labels.map((l) => `<span>${l}</span>`).join("")}</div>` +
      (div ? `<div class="ticks"><span style="text-align:left">◂ drier</span><span style="text-align:right">wetter ▸</span></div>` : "") +
      `<div class="firekey"><i class="sw sw-perim"></i>Fire perimeter</div>`;
  }

  // ----------------------------------------------------------------- fires
  function fireVisible(p) {
    if (!state.showRx && p.rx) return false;
    if ((p.acres || 0) < state.minAcres) return false;
    const y0 = P.years[0], y1 = P.years[P.years.length - 1];
    if (state.mode !== "mean" && state.yearOnly) return p.year === state.year;
    if (!state.showOld && (p.year < y0 || p.year > y1)) return false;
    return true;
  }
  function visibleFires() { return FIRES.features.filter((f) => fireVisible(f.properties)); }

  function firePopup(p) {
    const avg = valueAt(P.mean, p.cy, p.cx);
    const g = P.grids[String(p.year)];
    const yv = g ? valueAt(g, p.cy, p.cx) : null;
    const pct = avg && yv != null ? Math.round(100 * yv / avg) : null;
    return `<h3>${p.name} Fire</h3>
      <div>${p.year} · <b>${fmt(p.acres)}</b> acres</div>
      <div style="margin-top:6px">Avg. precipitation here: <b>${fmt(avg, 1)} in/yr</b></div>
      ${yv != null ? `<div>Precipitation in ${p.year}: <b>${fmt(yv, 1)} in</b> (${pct}% of average)</div>`
                   : `<div class="muted">No PRISM grid loaded for ${p.year}.</div>`}
      ${p.agency ? `<div class="muted" style="margin-top:4px">Agency: ${p.agency}${p.rx ? " · prescribed burn" : ""}</div>` : ""}`;
  }

  function renderFires() {
    if (fireLayer) { map.removeLayer(fireLayer); fireLayer = null; }
    const feats = visibleFires();
    const acres = feats.reduce((s, f) => s + (f.properties.acres || 0), 0);
    $("fire-count").textContent = `${fmt(feats.length)} perimeters shown · ${fmt(acres)} acres`;
    if (state.showFires) {
      fireLayer = L.geoJSON({ type: "FeatureCollection", features: feats }, {
        pane: "fires", renderer: fireRenderer,
        style: (f) => ({
          color: f.properties.rx ? "#6b4e9b" : "#a8370f", weight: 1.2,
          fillColor: f.properties.rx ? "#9b7fd1" : "#eb6834", fillOpacity: 0.45,
        }),
        onEachFeature: (f, layer) => {
          layer.bindPopup(() => firePopup(f.properties));
          layer.on("mouseover", () => layer.setStyle({ weight: 2.5, fillOpacity: 0.65 }));
          layer.on("mouseout", () => fireLayer && fireLayer.resetStyle(layer));
        },
      }).addTo(map);
    }
    renderBinChart(feats);
  }

  // ----------------------------------------------------------------- tooltip helper
  const tip = $("tip");
  function showTip(evt, html) {
    tip.innerHTML = html; tip.classList.remove("hidden");
    const x = Math.min(evt.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
    tip.style.left = x + "px"; tip.style.top = (evt.clientY + 14) + "px";
  }
  const hideTip = () => tip.classList.add("hidden");
  const svgEl = (tag, attrs) => {
    const e = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  };

  // ----------------------------------------------------------------- chart: bins
  function renderBinChart(feats) {
    const nb = BIN_LABELS.length;
    const area = new Array(nb).fill(0), burn = new Array(nb).fill(0);
    let totA = 0, totB = 0;
    for (let i = 0; i < P.mean.length; i++) {
      if (coMask[i] && P.mean[i] >= 0) { area[classOf(P.mean[i] / 10, SEQ.breaks)]++; totA++; }
    }
    for (const f of feats) {
      const p = f.properties; if (p.rx) continue;
      const v = valueAt(P.mean, p.cy, p.cx);
      if (v == null || !p.acres) continue;
      burn[classOf(v, SEQ.breaks)] += p.acres; totB += p.acres;
    }
    const aPct = area.map((a) => totA ? 100 * a / totA : 0);
    const bPct = burn.map((b) => totB ? 100 * b / totB : 0);
    const max = Math.max(5, ...aPct, ...bPct);

    const el = $("chart-bins"); el.innerHTML = "";
    const W = 340, L0 = 58, R = 34, rowH = 26, H = nb * rowH + 18;
    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img",
      "aria-label": "Share of Colorado land area and of burned acres by average precipitation class" });
    const x = (v) => L0 + (W - L0 - R) * v / max;
    for (let t = 0; t <= max; t += max > 40 ? 20 : 10) {
      svg.appendChild(svgEl("line", { x1: x(t), x2: x(t), y1: 0, y2: nb * rowH, stroke: "#e6e5e0" }));
      const tx = svgEl("text", { x: x(t), y: nb * rowH + 13, "text-anchor": "middle" }); tx.textContent = t + "%";
      svg.appendChild(tx);
    }
    for (let k = 0; k < nb; k++) {
      const y = k * rowH;
      const lab = svgEl("text", { x: L0 - 8, y: y + rowH / 2 + 4, "text-anchor": "end" }); lab.textContent = BIN_LABELS[k];
      svg.appendChild(lab);
      const bar = (v, dy, color) => {
        const w = Math.max(0, x(v) - L0);
        svg.appendChild(svgEl("path", { d: roundedBar(L0, y + dy, w, 8), fill: color }));
      };
      bar(aPct[k], 4, "#2a78d6");
      bar(bPct[k], 14, "#eb6834");
      const hit = svgEl("rect", { x: 0, y, width: W, height: rowH, class: "hit" });
      hit.addEventListener("mousemove", (e) => showTip(e,
        `<b>${BIN_LABELS[k]}</b> average precipitation<br>Land area: ${fmt(aPct[k], 1)}%<br>Acres burned: ${fmt(bPct[k], 1)}% (${fmt(burn[k])} ac)`));
      hit.addEventListener("mouseleave", hideTip);
      svg.appendChild(hit);
    }
    el.appendChild(svg);
  }
  // horizontal bar, rounded on the data end only
  function roundedBar(x0, y, w, h) {
    if (w <= 0) return "";
    const r = Math.min(3, w, h / 2);
    return `M${x0},${y}H${x0 + w - r}Q${x0 + w},${y} ${x0 + w},${y + r}V${y + h - r}Q${x0 + w},${y + h} ${x0 + w - r},${y + h}H${x0}Z`;
  }

  // ----------------------------------------------------------------- charts: by year
  function computeYearStats() {
    yearStats = {};
    for (const y of P.years) {
      const g = P.grids[String(y)]; let s = 0, n = 0;
      for (let i = 0; i < g.length; i++) if (coMask[i] && g[i] >= 0) { s += g[i]; n++; }
      yearStats[y] = { precip: n ? s / n / 10 : null, acres: 0, n: 0 };
    }
    for (const f of FIRES.features) {
      const p = f.properties;
      if (p.rx || !yearStats[p.year]) continue;
      yearStats[p.year].acres += p.acres || 0; yearStats[p.year].n++;
    }
  }

  function yearBars(elId, key, color, unit, digits) {
    const el = $(elId); el.innerHTML = "";
    const ys = P.years, W = 340, H = 110, L0 = 40, B = 18, T = 6;
    const vals = ys.map((y) => yearStats[y][key] || 0);
    const max = niceMax(Math.max(...vals));
    const bw = (W - L0) / ys.length;
    const yv = (v) => T + (H - T - B) * (1 - v / max);
    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `${key} by year` });
    for (let i = 0; i <= 2; i++) {
      const v = max * i / 2, yy = yv(v);
      svg.appendChild(svgEl("line", { x1: L0, x2: W, y1: yy, y2: yy, stroke: "#e6e5e0" }));
      const t = svgEl("text", { x: L0 - 6, y: yy + 4, "text-anchor": "end" }); t.textContent = shortNum(v);
      svg.appendChild(t);
    }
    if (key === "precip") {
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      svg.appendChild(svgEl("line", { x1: L0, x2: W, y1: yv(avg), y2: yv(avg), stroke: "#52514e", "stroke-dasharray": "3 3" }));
      $("precip-avg").textContent = ` — dashed line = ${fmt(avg, 1)} in average`;
    }
    ys.forEach((y, i) => {
      const v = vals[i], x0 = L0 + i * bw + 1.5, w = Math.max(1, bw - 3);
      const sel = state.mode !== "mean" && y === state.year;
      const top = yv(v), base = yv(0);
      if (v > 0) {
        const r = Math.min(2, w / 2, base - top);
        svg.appendChild(svgEl("path", {
          d: `M${x0},${base}V${top + r}Q${x0},${top} ${x0 + r},${top}H${x0 + w - r}Q${x0 + w},${top} ${x0 + w},${top + r}V${base}Z`,
          fill: color, opacity: state.mode !== "mean" && !sel ? 0.35 : 1,
        }));
      }
      if (i % 4 === 0 || i === ys.length - 1) {
        const t = svgEl("text", { x: x0 + w / 2, y: H - 4, "text-anchor": "middle" }); t.textContent = "'" + String(y).slice(2);
        svg.appendChild(t);
      }
      const hit = svgEl("rect", { x: L0 + i * bw, y: 0, width: bw, height: H - B, class: "hit" });
      hit.addEventListener("mousemove", (e) => showTip(e,
        `<b>${y}</b><br>Precipitation: ${fmt(yearStats[y].precip, 1)} in<br>Acres burned: ${fmt(yearStats[y].acres)} (${yearStats[y].n} fires)`));
      hit.addEventListener("mouseleave", hideTip);
      hit.addEventListener("click", () => { setYear(y); if (state.mode === "mean") setMode("anom"); });
      svg.appendChild(hit);
    });
    el.appendChild(svg);
  }
  function niceMax(v) {
    if (!v) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v))), m = v / p;
    return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
  }
  const shortNum = (v) => v === 0 ? "0" : v >= 1e6 ? fmt(v / 1e6, 1) + "M" : v >= 1e3 ? fmt(v / 1e3, 0) + "k" : fmt(v, v < 10 ? 1 : 0);

  function pearson(a, b) {
    const n = a.length; if (n < 3) return null;
    const ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
    return da && db ? num / Math.sqrt(da * db) : null;
  }
  function describeR(r) {
    if (r == null) return "not enough data";
    const a = Math.abs(r), s = a < 0.2 ? "very weak" : a < 0.4 ? "weak" : a < 0.6 ? "moderate" : "strong";
    return `${s} ${r < 0 ? "negative" : "positive"}`;
  }

  function renderYearCharts() {
    yearBars("chart-precip", "precip", "#2a78d6");
    yearBars("chart-acres", "acres", "#eb6834");
    const ys = P.years.filter((y) => yearStats[y].precip != null);
    const pr = ys.map((y) => yearStats[y].precip);
    const la = ys.map((y) => Math.log10(1 + yearStats[y].acres));
    const r0 = pearson(pr, la);
    const ys1 = ys.slice(1);
    const r1 = pearson(ys1.map((y) => yearStats[y - 1] ? yearStats[y - 1].precip : null).filter((v) => v != null),
      ys1.filter((y) => yearStats[y - 1]).map((y) => Math.log10(1 + yearStats[y].acres)));
    // top 3 fire years and their precip anomaly
    const avg = pr.reduce((a, b) => a + b, 0) / pr.length;
    const top = [...ys].sort((a, b) => yearStats[b].acres - yearStats[a].acres).slice(0, 3)
      .map((y) => `${y} (${Math.round(100 * yearStats[y].precip / avg)}%)`).join(", ");
    $("corr").innerHTML =
      `Same-year precipitation vs. acres burned (log): r = <b>${r0 == null ? "–" : r0.toFixed(2)}</b> — ${describeR(r0)}.<br>` +
      `Previous year's precipitation vs. acres burned: r = <b>${r1 == null ? "–" : r1.toFixed(2)}</b> — ${describeR(r1)}.<br>` +
      `Biggest fire years (precip as % of average): ${top}.`;
    $("year-table").innerHTML = `<table><thead><tr><th>Year</th><th>Precip (in)</th><th>% of avg</th><th>Fires</th><th>Acres</th></tr></thead><tbody>` +
      ys.map((y) => `<tr><td>${y}</td><td>${fmt(yearStats[y].precip, 1)}</td><td>${Math.round(100 * yearStats[y].precip / avg)}%</td><td>${yearStats[y].n}</td><td>${fmt(yearStats[y].acres)}</td></tr>`).join("") +
      `</tbody></table>`;
  }

  // ----------------------------------------------------------------- hover readout
  const readout = $("readout");
  map.on("mousemove", (e) => {
    if (!P) return;
    const { lat, lng } = e.latlng;
    if (!inCO(lat, lng)) { readout.classList.add("hidden"); return; }
    const avg = valueAt(P.mean, lat, lng);
    let html = `Average: <b>${fmt(avg, 1)} in/yr</b>`;
    if (state.mode !== "mean") {
      const g = P.grids[String(state.year)], v = g ? valueAt(g, lat, lng) : null;
      if (v != null) html += ` · ${state.year}: <b>${fmt(v, 1)} in</b> (${avg ? Math.round(100 * v / avg) : "–"}%)`;
    }
    readout.innerHTML = html; readout.classList.remove("hidden");
  });
  map.on("mouseout", () => readout.classList.add("hidden"));

  // ----------------------------------------------------------------- controls
  function setMode(m) {
    state.mode = m;
    document.querySelectorAll("#mode button").forEach((b) => {
      const on = b.dataset.mode === m; b.classList.toggle("on", on); b.setAttribute("aria-checked", on);
    });
    $("year-row").classList.toggle("hidden", m === "mean");
    if (m === "mean") stopPlay();
    refresh();
  }
  function setYear(y) {
    state.year = y; $("year").value = y; $("year-out").textContent = y;
    if (state.mode !== "mean") refresh();
  }
  function refresh() { renderPrecip(); renderFires(); renderYearCharts(); }

  function stopPlay() { if (playTimer) { clearInterval(playTimer); playTimer = null; $("play").textContent = "▶"; } }
  $("play").addEventListener("click", () => {
    if (playTimer) return stopPlay();
    $("play").textContent = "❚❚";
    playTimer = setInterval(() => {
      const i = P.years.indexOf(state.year);
      setYear(P.years[(i + 1) % P.years.length]);
    }, 1200);
  });

  document.querySelectorAll("#mode button").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
  $("year").addEventListener("input", (e) => setYear(+e.target.value));
  $("opacity").addEventListener("input", (e) => {
    state.opacity = e.target.value / 100; if (precipOverlay) precipOverlay.setOpacity(state.opacity);
  });
  const bindChk = (id, key) => $(id).addEventListener("change", (e) => { state[key] = e.target.checked; renderFires(); });
  bindChk("show-fires", "showFires"); bindChk("fires-year-only", "yearOnly");
  bindChk("show-old", "showOld"); bindChk("show-rx", "showRx");
  $("min-acres").addEventListener("change", (e) => { state.minAcres = +e.target.value; renderFires(); });
  $("panel-toggle").addEventListener("click", () => {
    const p = $("panel"); p.classList.toggle("collapsed");
    $("panel-toggle").textContent = p.classList.contains("collapsed") ? "⟩" : "⟨";
    setTimeout(() => map.invalidateSize(), 300);
  });

  // ----------------------------------------------------------------- load
  function showMsg(html) { $("msg").innerHTML = `<div>${html}</div>`; $("msg").classList.remove("hidden"); }

  Promise.all([
    fetch("data/precip.json").then((r) => { if (!r.ok) throw new Error("precip.json"); return r.json(); }),
    fetch("data/fires.geojson").then((r) => { if (!r.ok) throw new Error("fires.geojson"); return r.json(); }),
  ]).then(([precip, fires]) => {
    P = precip; FIRES = fires;
    coMask = new Uint8Array(P.ncols * P.nrows);
    for (let r = 0; r < P.nrows; r++) for (let c = 0; c < P.ncols; c++) {
      const lat = P.north - (r + 0.5) * P.dy, lon = P.west + (c + 0.5) * P.dx;
      coMask[r * P.ncols + c] = inCO(lat, lon) ? 1 : 0;
    }
    const y0 = P.years[0], y1 = P.years[P.years.length - 1];
    const yr = $("year"); yr.min = y0; yr.max = y1;
    state.year = Math.min(Math.max(2020, y0), y1); yr.value = state.year; $("year-out").textContent = state.year;
    document.querySelector('#mode [data-mode="mean"]').textContent = `Avg ${y0}–${String(y1).slice(2)}`;
    $("show-old").parentElement.lastChild.textContent = ` Include fires outside ${y0}–${y1}`;
    computeYearStats();
    refresh();
  }).catch((err) => {
    console.error(err);
    showMsg(`Map data not found (${err.message}).<br>Start the map with <code>python run.py</code> — it downloads the data on first run.`);
  });
})();
