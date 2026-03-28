require("dotenv").config();
const express = require("express");
const fetch = require("node-fetch");
const path = require("path");
const sat = require("satellite.js");
const nodemailer = require("nodemailer");

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SPACETRACK_BASE = "https://www.space-track.org";
const LOGIN_URL = `${SPACETRACK_BASE}/ajaxauth/login`;
const REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 60 minutes (Space-Track allows GP queries at most once per hour)

const GM = 398600.4418;    // km^3/s^2
const R_EARTH = 6371.0;    // km

const CONJUNCTION_THRESHOLD_KM = 10;
const CONJUNCTION_CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const CONJUNCTION_LOOKAHEAD_HOURS = 72;
const CONJUNCTION_STEP_SECONDS = 30;

const ALERT_EMAIL_TO = process.env.ALERT_EMAIL_TO || "paulrburns2@gmail.com";

// ---------------------------------------------------------------------------
// Space-Track session & caches
// ---------------------------------------------------------------------------

let sessionCookie = null;
const tleCache = new Map();
const historyCache = new Map(); // noradId → { data, fetchedAt }
const HISTORY_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// NORAD IDs for known planes
const KNOWN_PLANES = {
  "Plane 1": [65585,65565,65566,65567,65568,65569,65570,65571,65572,65573,
              65574,65575,65576,65577,65578,65579,65580,65581,65582,65583,65584],
  "Plane 2": [65974,65975,65976,65977,65978,65979,65980,65981,65982,65983,
              65984,65985,65986,65987,65988,65989,65990,65991,65992,65993,65994],
};

// ---------------------------------------------------------------------------
// Conjunction state
// ---------------------------------------------------------------------------

let latestConjunctions = [];
let conjunctionScreeningAt = null;
const emailsSentKeys = new Set(); // prevent duplicate alerts

// ---------------------------------------------------------------------------
// Email transporter (configured via env vars)
// ---------------------------------------------------------------------------

let mailTransporter = null;

function initMailTransporter() {
  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    console.log("[Email] SMTP not configured (set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS). Email alerts disabled.");
    return;
  }

  mailTransporter = nodemailer.createTransport({
    host,
    port: Number(port) || 587,
    secure: Number(port) === 465,
    auth: { user, pass },
  });

  console.log(`[Email] Transporter configured: ${host}:${port}`);
}

// ---------------------------------------------------------------------------
// Space-Track authentication
// ---------------------------------------------------------------------------

async function spaceTrackLogin() {
  const res = await fetch(LOGIN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      identity: process.env.SPACETRACK_USER,
      password: process.env.SPACETRACK_PASS,
    }),
    redirect: "manual",
  });

  const cookies = res.headers.raw()["set-cookie"];
  if (!cookies) throw new Error("Space-Track login failed — no session cookie");

  sessionCookie = cookies
    .map((c) => c.split(";")[0])
    .join("; ");

  console.log("[Space-Track] Authenticated successfully");
}

// ---------------------------------------------------------------------------
// TLE fetching (current)
// ---------------------------------------------------------------------------

// Fetch only TLEs published in the last hour (Space-Track recommended query).
// This avoids re-downloading the full GP catalog and complies with the
// "query GP class at most once per hour" rule.
// See: https://www.space-track.org/documentation#api-basicSpaceDataGp
async function fetchRecentTLEs() {
  if (!sessionCookie) await spaceTrackLogin();

  // Space-Track recommended: fetch all non-decayed TLEs published in the last hour
  // 0.042 days ≈ 1 hour
  const queryUrl =
    `${SPACETRACK_BASE}/basicspacedata/query/class/gp` +
    `/decay_date/null-val` +
    `/CREATION_DATE/%3Enow-0.042` +
    `/format/tle`;

  console.log("[Space-Track] Fetching recently published TLEs (last hour)...");

  const res = await fetch(queryUrl, {
    headers: { Cookie: sessionCookie },
  });

  if (res.status === 401) {
    console.log("[Space-Track] Session expired, re-authenticating...");
    await spaceTrackLogin();
    return fetchRecentTLEs();
  }

  if (!res.ok) {
    throw new Error(`Space-Track API error: ${res.status} ${res.statusText}`);
  }

  const raw = await res.text();
  return parseTLEText(raw);
}

// Full initial fetch for known NORAD IDs (used only once at startup)
async function fetchTLEs(noradIds) {
  if (!sessionCookie) await spaceTrackLogin();

  let queryUrl;
  if (noradIds && noradIds.length > 0) {
    const idList = noradIds.join(",");
    queryUrl =
      `${SPACETRACK_BASE}/basicspacedata/query/class/gp` +
      `/NORAD_CAT_ID/${idList}` +
      `/orderby/NORAD_CAT_ID/format/tle`;
  } else {
    queryUrl =
      `${SPACETRACK_BASE}/basicspacedata/query/class/gp` +
      `/EPOCH/%3Enow-30` +
      `/MEAN_MOTION/%3E11.25` +
      `/OBJECT_TYPE/PAYLOAD` +
      `/orderby/NORAD_CAT_ID` +
      `/limit/500` +
      `/format/tle`;
  }

  const res = await fetch(queryUrl, {
    headers: { Cookie: sessionCookie },
  });

  if (res.status === 401) {
    console.log("[Space-Track] Session expired, re-authenticating...");
    await spaceTrackLogin();
    return fetchTLEs(noradIds);
  }

  if (!res.ok) {
    throw new Error(`Space-Track API error: ${res.status} ${res.statusText}`);
  }

  const raw = await res.text();
  return parseTLEText(raw);
}

function parseTLEText(raw) {
  const lines = raw.trim().split("\n").map((l) => l.trim()).filter(Boolean);
  const satellites = [];

  for (let i = 0; i < lines.length - 1; i += 2) {
    const tle1 = lines[i];
    const tle2 = lines[i + 1];

    if (!tle1.startsWith("1 ") || !tle2.startsWith("2 ")) {
      if (lines[i + 2] && lines[i + 1].startsWith("1 ") && lines[i + 2].startsWith("2 ")) {
        satellites.push({
          name: lines[i].trim(),
          tle1: lines[i + 1].trim(),
          tle2: lines[i + 2].trim(),
        });
        i += 1;
        continue;
      }
      continue;
    }

    const noradId = tle1.substring(2, 7).trim();
    satellites.push({
      name: `SAT ${noradId}`,
      tle1,
      tle2,
    });
  }

  return satellites;
}

// ---------------------------------------------------------------------------
// Historical TLE fetching (for altitude/maneuver charts)
// ---------------------------------------------------------------------------

async function fetchTLEHistory(noradId, days) {
  if (!sessionCookie) await spaceTrackLogin();

  const queryUrl =
    `${SPACETRACK_BASE}/basicspacedata/query/class/gp_history` +
    `/NORAD_CAT_ID/${noradId}` +
    `/orderby/EPOCH asc` +
    `/EPOCH/%3Enow-${days}` +
    `/format/json`;

  const res = await fetch(queryUrl, {
    headers: { Cookie: sessionCookie },
  });

  if (res.status === 401) {
    console.log("[Space-Track] Session expired, re-authenticating...");
    await spaceTrackLogin();
    return fetchTLEHistory(noradId, days);
  }

  if (!res.ok) {
    throw new Error(`Space-Track API error: ${res.status} ${res.statusText}`);
  }

  const records = await res.json();

  return records.map((r) => {
    const meanMotion = parseFloat(r.MEAN_MOTION);
    const n = meanMotion * 2 * Math.PI / 86400; // rad/s
    const a = Math.pow(GM / (n * n), 1 / 3);    // km
    const altitude = a - R_EARTH;
    return {
      epoch: r.EPOCH,
      altitude: Math.round(altitude * 100) / 100,
      meanMotion,
      eccentricity: parseFloat(r.ECCENTRICITY),
      inclination: parseFloat(r.INCLINATION),
      noradId: r.NORAD_CAT_ID,
    };
  });
}

// ---------------------------------------------------------------------------
// Conjunction screening
// ---------------------------------------------------------------------------

function getPlaneForId(noradId) {
  const nid = Number(noradId);
  for (const [name, ids] of Object.entries(KNOWN_PLANES)) {
    if (ids.includes(nid)) return name;
  }
  return null;
}

async function runConjunctionScreening() {
  console.log("[Conjunction] Starting screening...");

  // Gather latest TLEs for all known satellites
  const allIds = Object.values(KNOWN_PLANES).flat();
  const cacheKey = allIds.map(String).sort().join(",");
  const cached = tleCache.get(cacheKey);

  let tles;
  if (cached && Date.now() - cached.fetchedAt < REFRESH_INTERVAL_MS) {
    tles = cached.data;
  } else {
    try {
      tles = await fetchTLEs(allIds.map(String));
    } catch (err) {
      console.error("[Conjunction] Failed to fetch TLEs:", err.message);
      return;
    }
  }

  // Build satrecs grouped by plane
  const plane1Sats = [];
  const plane2Sats = [];

  for (const tle of tles) {
    try {
      const satrec = sat.twoline2satrec(tle.tle1, tle.tle2);
      const noradId = tle.tle1.substring(2, 7).trim();
      const plane = getPlaneForId(noradId);
      const entry = { noradId, name: tle.name, satrec };
      if (plane === "Plane 1") plane1Sats.push(entry);
      else if (plane === "Plane 2") plane2Sats.push(entry);
    } catch (e) {
      // skip bad TLEs
    }
  }

  if (plane1Sats.length === 0 || plane2Sats.length === 0) {
    console.log("[Conjunction] Not enough satellites for screening");
    return;
  }

  const now = Date.now();
  const totalSteps = Math.floor(CONJUNCTION_LOOKAHEAD_HOURS * 3600 / CONJUNCTION_STEP_SECONDS);
  const conjunctions = new Map(); // "id1-id2" → best approach

  for (let step = 0; step <= totalSteps; step++) {
    const t = new Date(now + step * CONJUNCTION_STEP_SECONDS * 1000);

    // Propagate all Plane 1 satellites
    const p1Positions = [];
    for (const s of plane1Sats) {
      const pv = sat.propagate(s.satrec, t);
      if (pv.position && typeof pv.position !== "boolean") {
        p1Positions.push({ ...s, pos: pv.position, time: t });
      }
    }

    // Propagate all Plane 2 satellites
    const p2Positions = [];
    for (const s of plane2Sats) {
      const pv = sat.propagate(s.satrec, t);
      if (pv.position && typeof pv.position !== "boolean") {
        p2Positions.push({ ...s, pos: pv.position, time: t });
      }
    }

    // Check all cross-plane pairs
    for (const s1 of p1Positions) {
      for (const s2 of p2Positions) {
        const dx = s1.pos.x - s2.pos.x;
        const dy = s1.pos.y - s2.pos.y;
        const dz = s1.pos.z - s2.pos.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

        const pairKey = `${s1.noradId}-${s2.noradId}`;
        const existing = conjunctions.get(pairKey);

        if (!existing || dist < existing.minDistance) {
          conjunctions.set(pairKey, {
            sat1: { noradId: s1.noradId, name: s1.name, plane: "Plane 1" },
            sat2: { noradId: s2.noradId, name: s2.name, plane: "Plane 2" },
            minDistance: dist,
            tca: t.toISOString(),
          });
        }
      }
    }
  }

  // Filter to close approaches only
  const closeApproaches = [];
  for (const conj of conjunctions.values()) {
    if (conj.minDistance < CONJUNCTION_THRESHOLD_KM) {
      closeApproaches.push(conj);
    }
  }

  // Sort by distance
  closeApproaches.sort((a, b) => a.minDistance - b.minDistance);

  latestConjunctions = closeApproaches;
  conjunctionScreeningAt = new Date().toISOString();

  console.log(`[Conjunction] Screening complete: ${closeApproaches.length} close approaches < ${CONJUNCTION_THRESHOLD_KM} km`);

  // Send email alerts for new conjunctions
  for (const conj of closeApproaches) {
    const emailKey = `${conj.sat1.noradId}-${conj.sat2.noradId}-${conj.tca.substring(0, 13)}`;
    if (!emailsSentKeys.has(emailKey)) {
      emailsSentKeys.add(emailKey);
      await sendConjunctionEmail(conj);
    }
  }
}

// ---------------------------------------------------------------------------
// Email alerts
// ---------------------------------------------------------------------------

async function sendConjunctionEmail(conj) {
  if (!mailTransporter) {
    console.log(`[Email] Would alert: ${conj.sat1.name} / ${conj.sat2.name} — ${conj.minDistance.toFixed(2)} km at ${conj.tca}`);
    return;
  }

  const subject = `Conjunction Alert: ${conj.sat1.name} & ${conj.sat2.name} — ${conj.minDistance.toFixed(2)} km`;

  const html = `
    <h2>LEO Tracker — Conjunction Alert</h2>
    <p>Two satellites from different orbital planes are predicted to make a close approach:</p>
    <table style="border-collapse:collapse; font-family:sans-serif;">
      <tr><td style="padding:4px 12px;font-weight:bold;">Satellite 1:</td><td>${conj.sat1.name} (NORAD ${conj.sat1.noradId}, ${conj.sat1.plane})</td></tr>
      <tr><td style="padding:4px 12px;font-weight:bold;">Satellite 2:</td><td>${conj.sat2.name} (NORAD ${conj.sat2.noradId}, ${conj.sat2.plane})</td></tr>
      <tr><td style="padding:4px 12px;font-weight:bold;">Min Distance:</td><td><strong>${conj.minDistance.toFixed(2)} km</strong></td></tr>
      <tr><td style="padding:4px 12px;font-weight:bold;">Time of Closest Approach:</td><td>${new Date(conj.tca).toUTCString()}</td></tr>
    </table>
    <p style="margin-top:16px;color:#666;font-size:12px;">
      This alert was generated by LEO Tracker conjunction screening.<br/>
      Threshold: ${CONJUNCTION_THRESHOLD_KM} km · Lookahead: ${CONJUNCTION_LOOKAHEAD_HOURS} hours · Step: ${CONJUNCTION_STEP_SECONDS}s
    </p>
  `;

  try {
    await mailTransporter.sendMail({
      from: process.env.SMTP_USER,
      to: ALERT_EMAIL_TO,
      subject,
      html,
    });
    console.log(`[Email] Alert sent: ${conj.sat1.name} / ${conj.sat2.name}`);
  } catch (err) {
    console.error(`[Email] Failed to send:`, err.message);
  }
}

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/config", (_req, res) => {
  res.json({ cesiumToken: process.env.CESIUM_ION_TOKEN });
});

// TLE endpoint — always serves from cache (GP queries are handled by
// the scheduled background refresh to comply with Space-Track rate limits)
app.get("/api/tles", (req, res) => {
  try {
    const noradIds = req.query.ids
      ? req.query.ids.split(",").map((s) => s.trim())
      : null;

    const cacheKey = noradIds ? noradIds.slice().sort().join(",") : "__default__";
    const cached = tleCache.get(cacheKey);

    if (cached) {
      console.log(`[Cache] Serving ${cached.data.length} cached TLEs (key: ${cacheKey.substring(0,30)}...)`);
      return res.json({
        satellites: cached.data,
        cachedAt: new Date(cached.fetchedAt).toISOString(),
        source: "cache",
      });
    }

    // If no cache yet (server just started), try the combined cache
    const allIds = Object.values(KNOWN_PLANES).flat().map(String);
    const combinedKey = allIds.slice().sort().join(",");
    const combined = tleCache.get(combinedKey);

    if (combined && noradIds) {
      const idSet = new Set(noradIds);
      const filtered = combined.data.filter((s) => {
        const nid = s.tle1.substring(2, 7).trim();
        return idSet.has(nid);
      });
      return res.json({
        satellites: filtered,
        cachedAt: new Date(combined.fetchedAt).toISOString(),
        source: "cache",
      });
    }

    res.json({ satellites: [], cachedAt: null, source: "cache" });
  } catch (err) {
    console.error("[Error]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Historical TLE data for a single satellite
app.get("/api/tle-history", async (req, res) => {
  try {
    const noradId = req.query.id;
    const days = Math.min(parseInt(req.query.days) || 90, 365);

    if (!noradId) {
      return res.status(400).json({ error: "Missing 'id' query parameter" });
    }

    // Check cache
    const cacheKey = `${noradId}-${days}`;
    const cached = historyCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < HISTORY_CACHE_TTL_MS) {
      return res.json({ history: cached.data, source: "cache" });
    }

    console.log(`[Space-Track] Fetching ${days}-day history for NORAD ${noradId}...`);
    const history = await fetchTLEHistory(noradId, days);

    historyCache.set(cacheKey, { data: history, fetchedAt: Date.now() });
    console.log(`[Space-Track] Got ${history.length} historical records for ${noradId}`);

    res.json({ history, source: "live" });
  } catch (err) {
    console.error("[Error]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Latest conjunction screening results
app.get("/api/conjunctions", (_req, res) => {
  res.json({
    conjunctions: latestConjunctions,
    screenedAt: conjunctionScreeningAt,
    thresholdKm: CONJUNCTION_THRESHOLD_KM,
    lookaheadHours: CONJUNCTION_LOOKAHEAD_HOURS,
  });
});

// ---------------------------------------------------------------------------
// Prefetch & background refresh
// ---------------------------------------------------------------------------

// Build a Set of all known NORAD IDs for quick lookup
const ALL_KNOWN_IDS = new Set(Object.values(KNOWN_PLANES).flat().map(String));

// Initial full fetch (called once at startup)
async function initialFetchKnownPlanes() {
  const allIds = Object.values(KNOWN_PLANES).flat().map(String);

  try {
    console.log("[Prefetch] Initial load of known satellite planes from Space-Track...");
    const allSatellites = await fetchTLEs(allIds);
    const now = Date.now();

    updateTLECaches(allSatellites, now);
    console.log(`[Prefetch] Total: ${allSatellites.length} satellites cached`);
  } catch (err) {
    console.error("[Prefetch] Initial load failed:", err.message);
  }
}

// Incremental refresh: fetch only recently-published TLEs and merge with cache
async function refreshKnownPlanes() {
  try {
    console.log("[Refresh] Fetching recently published TLEs...");
    const recentTLEs = await fetchRecentTLEs();

    // Filter to only our known satellites
    const relevantUpdates = recentTLEs.filter((s) => {
      const noradId = s.tle1.substring(2, 7).trim();
      return ALL_KNOWN_IDS.has(noradId);
    });

    if (relevantUpdates.length === 0) {
      console.log("[Refresh] No updates for known satellites in last hour");
      return;
    }

    console.log(`[Refresh] Found ${relevantUpdates.length} updated TLEs for known satellites`);

    // Merge updates into existing cache
    const allIds = Object.values(KNOWN_PLANES).flat().map(String);
    const combinedKey = allIds.slice().sort().join(",");
    const cached = tleCache.get(combinedKey);

    if (cached) {
      // Build map of existing TLEs keyed by NORAD ID
      const tleMap = new Map();
      for (const s of cached.data) {
        const noradId = s.tle1.substring(2, 7).trim();
        tleMap.set(noradId, s);
      }
      // Overwrite with updated TLEs
      for (const s of relevantUpdates) {
        const noradId = s.tle1.substring(2, 7).trim();
        tleMap.set(noradId, s);
      }
      const merged = Array.from(tleMap.values());
      const now = Date.now();
      updateTLECaches(merged, now);
      console.log(`[Refresh] Cache updated, ${merged.length} satellites total`);
    } else {
      // No cache yet—shouldn't happen but handle gracefully
      const now = Date.now();
      updateTLECaches(relevantUpdates, now);
    }
  } catch (err) {
    console.error("[Refresh] Failed:", err.message);
  }
}

function updateTLECaches(allSatellites, now) {
  const allIds = Object.values(KNOWN_PLANES).flat().map(String);
  const combinedKey = allIds.slice().sort().join(",");
  tleCache.set(combinedKey, { data: allSatellites, fetchedAt: now });

  for (const [planeName, ids] of Object.entries(KNOWN_PLANES)) {
    const planeIdSet = new Set(ids.map(String));
    const planeKey = ids.map(String).sort().join(",");
    const planeSats = allSatellites.filter((s) => {
      const noradId = s.tle1.substring(2, 7).trim();
      return planeIdSet.has(noradId);
    });
    tleCache.set(planeKey, { data: planeSats, fetchedAt: now });
    console.log(`[Cache] ${planeSats.length} satellites for ${planeName}`);
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

// Schedule hourly GP refresh offset from busy periods (:00 and :30).
// Picks the next :19 or :41 past the hour to comply with Space-Track guidelines.
function scheduleHourlyRefresh() {
  const now = new Date();
  const min = now.getMinutes();

  // Target minutes that are 10-20 min off :00 and :30  →  :19 or :41
  let targetMin;
  if (min < 19) {
    targetMin = 19;
  } else if (min < 41) {
    targetMin = 41;
  } else {
    // Next :19 is in the next hour
    targetMin = 19;
  }

  const next = new Date(now);
  next.setMinutes(targetMin, 0, 0);
  if (next <= now) {
    next.setHours(next.getHours() + 1);
  }

  const delayMs = next - now;
  console.log(`[Schedule] Next GP refresh at ${next.toISOString()} (in ${Math.round(delayMs / 1000)}s)`);

  setTimeout(() => {
    refreshKnownPlanes();
    // After the first offset refresh, repeat every 60 minutes
    setInterval(refreshKnownPlanes, REFRESH_INTERVAL_MS);
  }, delayMs);
}

app.listen(PORT, () => {
  console.log(`\n🛰️  LEO Tracker running at http://localhost:${PORT}`);
  console.log(`   GP refresh interval: ${REFRESH_INTERVAL_MS / 60000} minutes (Space-Track compliant)`);
  console.log(`   Conjunction screening: every ${CONJUNCTION_CHECK_INTERVAL_MS / 60000} min, ${CONJUNCTION_LOOKAHEAD_HOURS}h lookahead\n`);

  initMailTransporter();

  // Initial full fetch on startup, then schedule hourly incremental refreshes
  initialFetchKnownPlanes();
  scheduleHourlyRefresh();

  // Run conjunction screening after a short delay (let TLEs load first)
  // Conjunction screening uses cached TLEs only—no additional GP queries
  setTimeout(() => {
    runConjunctionScreening();
    setInterval(runConjunctionScreening, CONJUNCTION_CHECK_INTERVAL_MS);
  }, 30_000);
});
