// ---------------------------------------------------------------------------
// LEO Satellite Tracker — app.js
// Orbit traces · Sortable sidebar · Configurable satellite planes
// ---------------------------------------------------------------------------

let viewer;
let satellites = [];        // { name, satrec, entity, orbitEntity, tle1, tle2, noradId, ... }
let tleRefreshTimer;
let activePlanes = new Set();

const TLE_REFRESH_MS = 30 * 60 * 1000;
const ORBIT_SAMPLE_POINTS = 120; // points per orbit trace

// Sort state
let sortKey = "name";
let sortAsc = true;

// ---------------------------------------------------------------------------
// Satellite planes — add more planes here as needed
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

// Cesium color instances (built at init)
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

  // Build Cesium colors for each plane
  for (const [planeName, plane] of Object.entries(SATELLITE_PLANES)) {
    planeColors[planeName] = Cesium.Color.fromCssColorString(plane.color);
  }

  // Build plane toggle buttons
  buildPlaneButtons();

  // Click handler
  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  handler.setInputAction(onLeftClick, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  // UI wiring
  document.getElementById("fetchBtn").addEventListener("click", onFetchClick);
  document.getElementById("infoClose").addEventListener("click", () => {
    document.getElementById("infoBox").classList.add("hidden");
  });
  document.getElementById("showOrbits").addEventListener("change", onToggleOrbits);

  // Table sorting
  document.querySelectorAll("#sat-table th.sortable").forEach((th) => {
    th.addEventListener("click", () => onSortClick(th));
  });

  // Load the first plane by default
  const firstPlane = Object.keys(SATELLITE_PLANES)[0];
  if (firstPlane) {
    activePlanes.add(firstPlane);
    updatePlaneButtonStates();
    await loadActivePlanes();
  }

  // Real-time propagation loop
  viewer.clock.onTick.addEventListener(updatePositions);

  // Auto-refresh TLEs
  tleRefreshTimer = setInterval(() => {
    console.log("[Auto-refresh] Fetching new TLEs...");
    loadActivePlanes();
  }, TLE_REFRESH_MS);
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

    // Clear existing
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

        // Satellite point entity
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

        // Orbit trace entity
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
  // Compute orbital period from mean motion (rev/day → minutes)
  const meanMotionRevPerDay = satrec.no * (1440 / (2 * Math.PI)); // rev/day
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

  // Update table values every 30 ticks (~0.5s) to avoid DOM thrashing
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

  // Update header UI
  document.querySelectorAll("#sat-table th.sortable").forEach((h) => {
    h.classList.remove("active-sort");
    h.querySelector(".sort-arrow").textContent = "";
  });
  th.classList.add("active-sort");
  th.querySelector(".sort-arrow").textContent = sortAsc ? "▲" : "▼";

  renderTable();
}

// ---------------------------------------------------------------------------
// Fly to satellite on table row click
// ---------------------------------------------------------------------------

function flyToSatellite(sat) {
  // Highlight selected row
  document.querySelectorAll("#sat-tbody tr").forEach((r) => r.classList.remove("selected"));
  const row = document.querySelector(`#sat-tbody tr[data-norad-id="${sat.noradId}"]`);
  if (row) row.classList.add("selected");

  // Camera fly-to slightly offset above and behind
  const pos = Cesium.Cartesian3.fromDegrees(
    sat.currentLon,
    sat.currentLat,
    sat.currentAlt * 1000 + 200_000
  );

  viewer.camera.flyTo({
    destination: pos,
    duration: 1.5,
  });

  // Show info box
  showInfoBox(sat);
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

  // Also highlight in table
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
// Custom NORAD ID fetch
// ---------------------------------------------------------------------------

function onFetchClick() {
  const input = document.getElementById("noradInput").value.trim();
  if (!input) return;

  // Deselect all planes (this is a custom query)
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