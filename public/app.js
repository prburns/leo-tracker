// ---------------------------------------------------------------------------
// LEO Satellite Tracker — app.js
// Orbit traces · Sortable sidebar · Analytics · Conjunctions
// ---------------------------------------------------------------------------

let viewer;
let satellites = [];        // { name, satrec, entity, orbitEntity, tle1, tle2, noradId, ... }
let tleRefreshTimer;
let activePlanes = new Set();

const TLE_REFRESH_MS = 90 * 60 * 1000; // 90 min (match server-side Space-Track compliance)
const ORBIT_SAMPLE_POINTS = 120;

// Sort state
let sortKey = "name";
let sortAsc = true;

// Analytics state
let altitudeChart = null;
let selectedSatForHistory = null;
let conjunctionRefreshTimer;

// ---------------------------------------------------------------------------
// Satellite planes
// ---------------------------------------------------------------------------

const SATELLITE_PLANES = {
  "Tranche 1 — Plane 1": {
    ids: [65585,65565,65566,65567,65568,65569,65570,65571,65572,65573,
          65574,65575,65576,65577,65578,65579,65580,65581,65582,65583,65584],
    color: "#34d399", // green
  },
  "Tranche 1 — Plane 2": {
    ids: [65974,65975,65976,65977,65978,65979,65980,65981,65982,65983,
          65984,65985,65986,65987,65988,65989,65990,65991,65992,65993,65994],
    color: "#60a5fa", // blue
  },
};

const planeColors = {};

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

async function init() {
  const config = await fetch("/api/config").then((r) => r.json());
  Cesium.Ion.defaultAccessToken = config.cesiumToken;

  viewer = new Cesium.Viewer("cesiumContainer", {
    terrain: Cesium.Terrain.fromWorldTerrain(),
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: true,
    navigationHelpButton: false,
    animation: false,
    timeline: false,
    fullscreenButton: false,
    selectionIndicator: true,
    infoBox: false,
  });

  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(-77.0, 38.9, 12_000_000),
  });

  for (const [planeName, plane] of Object.entries(SATELLITE_PLANES)) {
    planeColors[planeName] = Cesium.Color.fromCssColorString(plane.color);
  }

  buildPlaneButtons();

  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  handler.setInputAction(onLeftClick, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  document.getElementById("fetchBtn").addEventListener("click", onFetchClick);
  document.getElementById("infoClose").addEventListener("click", () => {
    document.getElementById("infoBox").classList.add("hidden");
  });
  document.getElementById("showOrbits").addEventListener("change", onToggleOrbits);

  document.querySelectorAll("#sat-table th.sortable").forEach((th) => {
    th.addEventListener("click", () => onSortClick(th));
  });

  // Tab switching
  document.querySelectorAll(".sidebar-tab").forEach((tab) => {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab));
  });

  // Load the first plane by default
  const firstPlane = Object.keys(SATELLITE_PLANES)[0];
  if (firstPlane) {
    activePlanes.add(firstPlane);
    updatePlaneButtonStates();
    await loadActivePlanes();
  }

  viewer.clock.onTick.addEventListener(updatePositions);

  tleRefreshTimer = setInterval(() => {
    console.log("[Auto-refresh] Fetching new TLEs...");
    loadActivePlanes();
  }, TLE_REFRESH_MS);

  // Load conjunctions
  loadConjunctions();
  conjunctionRefreshTimer = setInterval(loadConjunctions, 5 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Tab switching
// ---------------------------------------------------------------------------

function switchTab(tabName) {
  document.querySelectorAll(".sidebar-tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.tab === tabName);
  });
  document.querySelectorAll(".tab-content").forEach((c) => {
    c.classList.toggle("active", c.id === `tab-${tabName}`);
  });

  if (tabName === "analytics") {
    updateSpacingVis();
  }
}

// ---------------------------------------------------------------------------
// Plane UI
// ---------------------------------------------------------------------------

function buildPlaneButtons() {
  const container = document.getElementById("plane-buttons");
  container.innerHTML = "";

  for (const [planeName, plane] of Object.entries(SATELLITE_PLANES)) {
    const btn = document.createElement("button");
    btn.className = "plane-btn";
    btn.dataset.plane = planeName;
    btn.innerHTML = `
      <span class="sat-color-dot" style="display:inline-block; width:8px; height:8px; border-radius:50%; background:${plane.color}; vertical-align:middle; margin-right:4px;"></span>
      ${planeName}
      <span class="plane-count">(${plane.ids.length})</span>
    `;
    btn.addEventListener("click", () => togglePlane(planeName));
    container.appendChild(btn);
  }
}

function togglePlane(planeName) {
  if (activePlanes.has(planeName)) {
    activePlanes.delete(planeName);
  } else {
    activePlanes.add(planeName);
  }
  updatePlaneButtonStates();
  loadActivePlanes();
}

function updatePlaneButtonStates() {
  document.querySelectorAll(".plane-btn").forEach((btn) => {
    btn.classList.toggle("active", activePlanes.has(btn.dataset.plane));
  });
}

// ---------------------------------------------------------------------------
// TLE fetching
// ---------------------------------------------------------------------------

function getActiveNoradIds() {
  const ids = [];
  for (const planeName of activePlanes) {
    const plane = SATELLITE_PLANES[planeName];
    if (plane) ids.push(...plane.ids);
  }
  return ids;
}

function getPlaneForNoradId(noradId) {
  for (const [planeName, plane] of Object.entries(SATELLITE_PLANES)) {
    if (plane.ids.includes(Number(noradId))) return planeName;
  }
  return null;
}

async function loadActivePlanes() {
  const ids = getActiveNoradIds();
  if (ids.length === 0) {
    clearAllSatellites();
    updateStats(0, null, "none");
    return;
  }
  await loadTLEs(ids.join(","));
}

async function loadTLEs(noradIdString) {
  const statsEl = document.getElementById("sidebar-stats");
  statsEl.textContent = "Fetching TLEs from Space-Track...";

  try {
    let url = "/api/tles";
    if (noradIdString) url += `?ids=${noradIdString}`;

    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const json = await res.json();
    const tleData = json.satellites;

    clearAllSatellites();

    const showOrbits = document.getElementById("showOrbits").checked;

    for (const { name, tle1, tle2 } of tleData) {
      try {
        const satrec = satellite.twoline2satrec(tle1, tle2);
        const noradId = tle1.substring(2, 7).trim();
        const planeName = getPlaneForNoradId(noradId);
        const color = planeName && planeColors[planeName]
          ? planeColors[planeName]
          : Cesium.Color.WHITE.withAlpha(0.8);

        const entity = viewer.entities.add({
          name: name,
          position: Cesium.Cartesian3.fromDegrees(0, 0, 0),
          point: {
            pixelSize: 6,
            color: color,
            outlineColor: Cesium.Color.WHITE.withAlpha(0.4),
            outlineWidth: 1,
            scaleByDistance: new Cesium.NearFarScalar(1e6, 1.5, 1e8, 0.5),
          },
          label: {
            text: name,
            font: "11px -apple-system, sans-serif",
            fillColor: Cesium.Color.WHITE.withAlpha(0.85),
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 2,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
            pixelOffset: new Cesium.Cartesian2(0, -10),
            scaleByDistance: new Cesium.NearFarScalar(1e6, 1.0, 8e6, 0.0),
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 8e6),
          },
        });

        const orbitEntity = createOrbitTrace(satrec, color, showOrbits);

        satellites.push({
          name,
          satrec,
          entity,
          orbitEntity,
          tle1,
          tle2,
          noradId,
          planeName,
          colorCss: planeName ? SATELLITE_PLANES[planeName].color : "#ffffff",
          currentLat: 0,
          currentLon: 0,
          currentAlt: 0,
          currentVel: 0,
        });
      } catch (e) {
        console.warn(`Skipping ${name}: ${e.message}`);
      }
    }

    updateStats(satellites.length, json.cachedAt, json.source);
    renderTable();
    updateSpacingVis();

  } catch (err) {
    console.error("[TLE fetch error]", err);
    statsEl.textContent = `Error: ${err.message}`;
  }
}

function clearAllSatellites() {
  for (const sat of satellites) {
    viewer.entities.remove(sat.entity);
    if (sat.orbitEntity) viewer.entities.remove(sat.orbitEntity);
  }
  satellites = [];
  document.getElementById("sat-tbody").innerHTML = "";
}

function updateStats(count, cachedAt, source) {
  const statsEl = document.getElementById("sidebar-stats");
  if (count === 0) {
    statsEl.textContent = "No satellites loaded";
    return;
  }
  const timeStr = cachedAt ? new Date(cachedAt).toLocaleTimeString() : "—";
  statsEl.textContent = `${count} satellites · Updated ${timeStr} (${source})`;
}

// ---------------------------------------------------------------------------
// Orbit trace generation
// ---------------------------------------------------------------------------

function createOrbitTrace(satrec, color, visible) {
  const meanMotionRevPerDay = satrec.no * (1440 / (2 * Math.PI));
  const periodMin = 1440 / meanMotionRevPerDay;
  const periodMs = periodMin * 60 * 1000;

  const now = new Date();
  const positions = [];

  for (let i = 0; i <= ORBIT_SAMPLE_POINTS; i++) {
    const t = new Date(now.getTime() + (i / ORBIT_SAMPLE_POINTS) * periodMs);
    const posVel = satellite.propagate(satrec, t);

    if (!posVel.position || typeof posVel.position === "boolean") continue;

    const gmst = satellite.gstime(t);
    const geo = satellite.eciToGeodetic(posVel.position, gmst);
    const lonDeg = satellite.degreesLong(geo.longitude);
    const latDeg = satellite.degreesLat(geo.latitude);
    const altKm = geo.height;

    positions.push(Cesium.Cartesian3.fromDegrees(lonDeg, latDeg, altKm * 1000));
  }

  if (positions.length < 2) return null;

  const orbitEntity = viewer.entities.add({
    polyline: {
      positions: positions,
      width: 1.2,
      material: new Cesium.PolylineGlowMaterialProperty({
        glowPower: 0.15,
        color: color.withAlpha(0.45),
      }),
      clampToGround: false,
    },
    show: visible,
  });

  return orbitEntity;
}

function onToggleOrbits(e) {
  const show = e.target.checked;
  for (const sat of satellites) {
    if (sat.orbitEntity) sat.orbitEntity.show = show;
  }
}

// ---------------------------------------------------------------------------
// Real-time SGP4 propagation
// ---------------------------------------------------------------------------

let tickCounter = 0;

function updatePositions() {
  const now = new Date();
  tickCounter++;

  for (const sat of satellites) {
    const posVel = satellite.propagate(sat.satrec, now);

    if (!posVel.position || typeof posVel.position === "boolean") {
      sat.entity.show = false;
      continue;
    }

    const gmst = satellite.gstime(now);
    const geo = satellite.eciToGeodetic(posVel.position, gmst);

    const lonDeg = satellite.degreesLong(geo.longitude);
    const latDeg = satellite.degreesLat(geo.latitude);
    const altKm = geo.height;

    sat.entity.position = Cesium.Cartesian3.fromDegrees(lonDeg, latDeg, altKm * 1000);
    sat.entity.show = true;

    sat.currentLat = latDeg;
    sat.currentLon = lonDeg;
    sat.currentAlt = altKm;
    sat.currentVel = posVel.velocity
      ? Math.sqrt(
          posVel.velocity.x ** 2 +
          posVel.velocity.y ** 2 +
          posVel.velocity.z ** 2
        )
      : 0;
  }

  if (tickCounter % 30 === 0) {
    updateTableValues();
  }
}

// ---------------------------------------------------------------------------
// Sortable satellite table
// ---------------------------------------------------------------------------

function renderTable() {
  const tbody = document.getElementById("sat-tbody");
  tbody.innerHTML = "";

  const sorted = getSortedSatellites();

  for (const sat of sorted) {
    const tr = document.createElement("tr");
    tr.dataset.noradId = sat.noradId;
    tr.innerHTML = `
      <td>
        <div class="sat-name-cell">
          <span class="sat-color-dot" style="background:${sat.colorCss}"></span>
          <span>${sat.name}</span>
        </div>
      </td>
      <td>${sat.noradId}</td>
      <td class="td-alt">${sat.currentAlt.toFixed(1)}</td>
      <td class="td-vel">${sat.currentVel.toFixed(2)}</td>
    `;
    tr.addEventListener("click", () => flyToSatellite(sat));
    tbody.appendChild(tr);
  }
}

function updateTableValues() {
  const rows = document.querySelectorAll("#sat-tbody tr");
  for (const row of rows) {
    const nid = row.dataset.noradId;
    const sat = satellites.find((s) => s.noradId === nid);
    if (!sat) continue;

    const altCell = row.querySelector(".td-alt");
    const velCell = row.querySelector(".td-vel");
    if (altCell) altCell.textContent = sat.currentAlt.toFixed(1);
    if (velCell) velCell.textContent = sat.currentVel.toFixed(2);
  }
}

function getSortedSatellites() {
  const copy = [...satellites];
  copy.sort((a, b) => {
    let va, vb;
    switch (sortKey) {
      case "name":
        va = a.name.toLowerCase();
        vb = b.name.toLowerCase();
        return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
      case "noradId":
        va = Number(a.noradId);
        vb = Number(b.noradId);
        break;
      case "alt":
        va = a.currentAlt;
        vb = b.currentAlt;
        break;
      case "vel":
        va = a.currentVel;
        vb = b.currentVel;
        break;
      default:
        return 0;
    }
    return sortAsc ? va - vb : vb - va;
  });
  return copy;
}

function onSortClick(th) {
  const key = th.dataset.sort;
  if (sortKey === key) {
    sortAsc = !sortAsc;
  } else {
    sortKey = key;
    sortAsc = true;
  }

  document.querySelectorAll("#sat-table th.sortable").forEach((h) => {
    h.classList.remove("active-sort");
    h.querySelector(".sort-arrow").textContent = "";
  });
  th.classList.add("active-sort");
  th.querySelector(".sort-arrow").textContent = sortAsc ? "▲" : "▼";

  renderTable();
}

// ---------------------------------------------------------------------------
// Fly to satellite + load history
// ---------------------------------------------------------------------------

function flyToSatellite(sat) {
  document.querySelectorAll("#sat-tbody tr").forEach((r) => r.classList.remove("selected"));
  const row = document.querySelector(`#sat-tbody tr[data-norad-id="${sat.noradId}"]`);
  if (row) row.classList.add("selected");

  const pos = Cesium.Cartesian3.fromDegrees(
    sat.currentLon,
    sat.currentLat,
    sat.currentAlt * 1000 + 200_000
  );

  viewer.camera.flyTo({
    destination: pos,
    duration: 1.5,
  });

  showInfoBox(sat);
  loadAltitudeHistory(sat);
}

// ---------------------------------------------------------------------------
// Click interaction (on globe)
// ---------------------------------------------------------------------------

function onLeftClick(click) {
  const picked = viewer.scene.pick(click.position);

  if (!Cesium.defined(picked) || !picked.id) {
    document.getElementById("infoBox").classList.add("hidden");
    document.querySelectorAll("#sat-tbody tr").forEach((r) => r.classList.remove("selected"));
    return;
  }

  const entity = picked.id;
  const sat = satellites.find((s) => s.entity === entity);
  if (!sat) return;

  showInfoBox(sat);
  loadAltitudeHistory(sat);

  document.querySelectorAll("#sat-tbody tr").forEach((r) => r.classList.remove("selected"));
  const row = document.querySelector(`#sat-tbody tr[data-norad-id="${sat.noradId}"]`);
  if (row) {
    row.classList.add("selected");
    row.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

function showInfoBox(sat) {
  const infoBox = document.getElementById("infoBox");
  const title = document.getElementById("infoTitle");
  const details = document.getElementById("infoDetails");

  title.textContent = sat.name;

  const intlDesig = sat.tle1.substring(9, 17).trim();
  const epochStr = sat.tle1.substring(18, 32).trim();
  const plane = sat.planeName || "Custom";

  details.innerHTML = `
    <strong>NORAD ID:</strong> ${sat.noradId}<br/>
    <strong>Plane:</strong> ${plane}<br/>
    <strong>Int'l Designator:</strong> ${intlDesig}<br/>
    <strong>TLE Epoch:</strong> ${epochStr}<br/>
    <hr style="border-color: rgba(255,255,255,0.08); margin: 6px 0;" />
    <strong>Latitude:</strong> ${sat.currentLat.toFixed(3)}°<br/>
    <strong>Longitude:</strong> ${sat.currentLon.toFixed(3)}°<br/>
    <strong>Altitude:</strong> ${sat.currentAlt.toFixed(1)} km<br/>
    <strong>Velocity:</strong> ${sat.currentVel.toFixed(2)} km/s<br/>
  `;

  infoBox.classList.remove("hidden");
}

// ---------------------------------------------------------------------------
// Altitude History & Maneuver Detection
// ---------------------------------------------------------------------------

async function loadAltitudeHistory(sat) {
  selectedSatForHistory = sat;

  const hintEl = document.getElementById("altitude-hint");
  const chartContainer = document.getElementById("altitude-chart-container");
  const maneuverList = document.getElementById("maneuver-list");

  hintEl.textContent = `Loading history for ${sat.name}...`;
  hintEl.classList.remove("hidden");
  chartContainer.classList.add("hidden");
  maneuverList.innerHTML = "";

  try {
    const res = await fetch(`/api/tle-history?id=${sat.noradId}&days=90`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const history = json.history;

    if (!history || history.length === 0) {
      hintEl.textContent = `No historical data for ${sat.name}`;
      return;
    }

    // Detect maneuvers (altitude change > 1 km between consecutive TLEs within 2 days)
    const maneuvers = [];
    for (let i = 1; i < history.length; i++) {
      const prev = history[i - 1];
      const curr = history[i];
      const deltaAlt = curr.altitude - prev.altitude;
      const dtDays = (new Date(curr.epoch) - new Date(prev.epoch)) / (1000 * 86400);

      if (Math.abs(deltaAlt) > 1.0 && dtDays < 2) {
        maneuvers.push({
          epoch: curr.epoch,
          deltaAlt,
          fromAlt: prev.altitude,
          toAlt: curr.altitude,
        });
      }
    }

    // Render chart
    renderAltitudeChart(history, maneuvers, sat);

    hintEl.classList.add("hidden");
    chartContainer.classList.remove("hidden");

    // Render maneuver list
    if (maneuvers.length > 0) {
      maneuverList.innerHTML = `<div class="section-label" style="margin-top:4px;">Detected Maneuvers</div>` +
        maneuvers.map((m) => `
          <div class="maneuver-item">
            ${m.deltaAlt > 0 ? "▲" : "▼"} ${Math.abs(m.deltaAlt).toFixed(2)} km
            (${m.fromAlt.toFixed(1)} → ${m.toAlt.toFixed(1)} km)
            <div class="maneuver-date">${new Date(m.epoch).toLocaleDateString()} ${new Date(m.epoch).toLocaleTimeString()}</div>
          </div>
        `).join("");
    } else {
      maneuverList.innerHTML = `<div style="font-size:11px;color:#6b7280;margin-top:4px;">No maneuvers detected in 90-day window</div>`;
    }

  } catch (err) {
    console.error("[History]", err);
    hintEl.textContent = `Error loading history: ${err.message}`;
  }
}

function renderAltitudeChart(history, maneuvers, sat) {
  const ctx = document.getElementById("altitudeChart").getContext("2d");

  if (altitudeChart) {
    altitudeChart.destroy();
  }

  const labels = history.map((h) => h.epoch);
  const data = history.map((h) => h.altitude);

  // Mark maneuver points
  const maneuverEpochs = new Set(maneuvers.map((m) => m.epoch));
  const pointColors = history.map((h) =>
    maneuverEpochs.has(h.epoch) ? "#ef4444" : "transparent"
  );
  const pointRadii = history.map((h) =>
    maneuverEpochs.has(h.epoch) ? 5 : 0
  );

  const planeColor = sat.planeName ? SATELLITE_PLANES[sat.planeName]?.color : "#93c5fd";

  altitudeChart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: `${sat.name} Altitude (km)`,
        data,
        borderColor: planeColor || "#93c5fd",
        backgroundColor: (planeColor || "#93c5fd") + "20",
        borderWidth: 1.5,
        fill: true,
        tension: 0.1,
        pointBackgroundColor: pointColors,
        pointRadius: pointRadii,
        pointHoverRadius: 4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => {
              const d = new Date(items[0].label);
              return d.toLocaleDateString() + " " + d.toLocaleTimeString();
            },
            label: (item) => `${item.parsed.y.toFixed(2)} km`,
          },
        },
      },
      scales: {
        x: {
          display: true,
          ticks: {
            maxTicksLimit: 6,
            color: "#6b7280",
            font: { size: 10 },
            callback: function (val, idx) {
              const d = new Date(this.getLabelForValue(val));
              return `${d.getMonth() + 1}/${d.getDate()}`;
            },
          },
          grid: { color: "rgba(255,255,255,0.04)" },
        },
        y: {
          ticks: { color: "#6b7280", font: { size: 10 } },
          grid: { color: "rgba(255,255,255,0.04)" },
        },
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Inter-satellite Spacing
// ---------------------------------------------------------------------------

function computeArgOfLatitude(sat) {
  const now = new Date();
  const pv = satellite.propagate(sat.satrec, now);
  if (!pv.position || typeof pv.position === "boolean") return null;

  const r = pv.position;
  const Omega = sat.satrec.nodeo; // RAAN (rad)
  const inc = sat.satrec.inclo;   // inclination (rad)

  // Rotate by -RAAN around Z axis
  const cosO = Math.cos(Omega);
  const sinO = Math.sin(Omega);
  const xN = r.x * cosO + r.y * sinO;
  const yN = -r.x * sinO + r.y * cosO;
  const zN = r.z;

  // Rotate by -inclination around X axis
  const cosI = Math.cos(inc);
  const sinI = Math.sin(inc);
  const xP = xN;
  const yP = yN * cosI + zN * sinI;

  // Argument of latitude
  let u = Math.atan2(yP, xP) * 180 / Math.PI;
  return ((u % 360) + 360) % 360;
}

function updateSpacingVis() {
  const canvas = document.getElementById("spacingCanvas");
  const statsEl = document.getElementById("spacing-stats");

  if (satellites.length === 0) {
    statsEl.innerHTML = `<div class="analytics-hint">Load satellites to see spacing</div>`;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }

  // Group satellites by plane and compute argument of latitude
  const planeData = {};
  for (const [planeName, planeInfo] of Object.entries(SATELLITE_PLANES)) {
    const planeSats = satellites
      .filter((s) => s.planeName === planeName)
      .map((s) => {
        const u = computeArgOfLatitude(s);
        return u !== null ? { noradId: s.noradId, name: s.name, u, color: planeInfo.color } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.u - b.u);

    if (planeSats.length > 0) {
      planeData[planeName] = planeSats;
    }
  }

  // Draw polar chart
  drawSpacingPolar(canvas, planeData);

  // Build spacing stats
  let html = "";
  for (const [planeName, sats] of Object.entries(planeData)) {
    const gaps = [];
    for (let i = 0; i < sats.length; i++) {
      const next = (i + 1) % sats.length;
      let gap = sats[next].u - sats[i].u;
      if (gap <= 0) gap += 360;
      gaps.push({ from: sats[i], to: sats[next], gap });
    }

    const idealGap = 360 / sats.length;
    const maxGap = Math.max(...gaps.map((g) => g.gap));
    const minGap = Math.min(...gaps.map((g) => g.gap));
    const color = SATELLITE_PLANES[planeName].color;

    html += `
      <div class="spacing-plane">
        <div class="spacing-plane-title" style="color:${color}">${planeName} (${sats.length} sats)</div>
        <div style="font-size:11px; color:#9ca3af;">
          Ideal: ${idealGap.toFixed(1)}° · Min: ${minGap.toFixed(1)}° · Max: ${maxGap.toFixed(1)}°
        </div>
        ${gaps.map((g) => {
          const deviation = Math.abs(g.gap - idealGap);
          const barWidth = Math.max(2, (g.gap / maxGap) * 100);
          const barColor = deviation > idealGap * 0.3 ? "#ef4444" : color;
          return `
            <div class="spacing-bar-row">
              <span class="spacing-value">${g.gap.toFixed(1)}°</span>
              <div class="spacing-bar" style="width:${barWidth}%;background:${barColor}"></div>
            </div>`;
        }).join("")}
      </div>`;
  }

  statsEl.innerHTML = html;
}

function drawSpacingPolar(canvas, planeData) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  const cx = w / 2;
  const cy = h / 2;
  const radius = Math.min(cx, cy) - 30;

  ctx.clearRect(0, 0, w, h);

  // Draw background circles
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 1;
  for (let r = radius * 0.33; r <= radius; r += radius * 0.33) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, 2 * Math.PI);
    ctx.stroke();
  }

  // Draw crosshairs
  ctx.beginPath();
  ctx.moveTo(cx - radius, cy);
  ctx.lineTo(cx + radius, cy);
  ctx.moveTo(cx, cy - radius);
  ctx.lineTo(cx, cy + radius);
  ctx.stroke();

  // Draw angle labels
  ctx.fillStyle = "#4b5563";
  ctx.font = "10px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("0°", cx + radius + 14, cy + 4);
  ctx.fillText("90°", cx, cy - radius - 6);
  ctx.fillText("180°", cx - radius - 16, cy + 4);
  ctx.fillText("270°", cx, cy + radius + 14);

  // Draw satellites for each plane at different radii
  const planeNames = Object.keys(planeData);
  planeNames.forEach((planeName, planeIdx) => {
    const sats = planeData[planeName];
    const color = SATELLITE_PLANES[planeName].color;
    const r = radius * (0.7 + planeIdx * 0.25);

    // Draw connecting arcs
    ctx.strokeStyle = color + "40";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, 2 * Math.PI);
    ctx.stroke();

    // Draw satellite dots
    for (const sat of sats) {
      const angle = (sat.u - 90) * Math.PI / 180; // -90 to put 0° at top
      const x = cx + r * Math.cos(angle);
      const y = cy + r * Math.sin(angle);

      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, 2 * Math.PI);
      ctx.fill();

      // Label
      ctx.fillStyle = "#9ca3af";
      ctx.font = "8px sans-serif";
      ctx.textAlign = "center";
      const lx = cx + (r + 14) * Math.cos(angle);
      const ly = cy + (r + 14) * Math.sin(angle);
      ctx.fillText(sat.noradId, lx, ly + 3);
    }
  });
}

// ---------------------------------------------------------------------------
// Conjunction Alerts
// ---------------------------------------------------------------------------

async function loadConjunctions() {
  const statusEl = document.getElementById("conj-status");
  const listEl = document.getElementById("conj-list");

  try {
    const res = await fetch("/api/conjunctions");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();

    document.getElementById("conj-threshold").textContent = json.thresholdKm;

    if (!json.screenedAt) {
      statusEl.textContent = "Screening not yet complete. Check back shortly...";
      listEl.innerHTML = "";
      return;
    }

    const screenedTime = new Date(json.screenedAt).toLocaleTimeString();
    statusEl.textContent = `Last screened: ${screenedTime} · ${json.conjunctions.length} alert(s)`;

    if (json.conjunctions.length === 0) {
      listEl.innerHTML = `<div class="conj-none">No close approaches detected in the next ${json.lookaheadHours}h</div>`;
      return;
    }

    listEl.innerHTML = json.conjunctions.map((c) => {
      const severity = c.minDistance < 5 ? "" : " warning";
      const tca = new Date(c.tca);
      const hoursFromNow = ((tca - Date.now()) / 3600000).toFixed(1);

      return `
        <div class="conj-item${severity}">
          <div class="conj-distance">${c.minDistance.toFixed(2)} km</div>
          <div class="conj-sats">
            ${c.sat1.name} (${c.sat1.plane}) &harr; ${c.sat2.name} (${c.sat2.plane})
          </div>
          <div class="conj-time">
            TCA: ${tca.toUTCString()}<br/>
            In ${hoursFromNow}h from now
          </div>
        </div>`;
    }).join("");

  } catch (err) {
    console.error("[Conjunctions]", err);
    statusEl.textContent = `Error: ${err.message}`;
  }
}

// ---------------------------------------------------------------------------
// Custom NORAD ID fetch
// ---------------------------------------------------------------------------

function onFetchClick() {
  const input = document.getElementById("noradInput").value.trim();
  if (!input) return;

  activePlanes.clear();
  updatePlaneButtonStates();

  loadTLEs(input);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

init().catch((err) => {
  console.error("Initialization failed:", err);
  document.getElementById("sidebar-stats").textContent = `Init error: ${err.message}`;
});
