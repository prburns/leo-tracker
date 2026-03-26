require("dotenv").config();
const express = require("express");
const fetch = require("node-fetch");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Space-Track session & TLE cache
// ---------------------------------------------------------------------------

const SPACETRACK_BASE = "https://www.space-track.org";
const LOGIN_URL = `${SPACETRACK_BASE}/ajaxauth/login`;
const REFRESH_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

let sessionCookie = null;
const tleCache = new Map(); // key → { data, fetchedAt }

// NORAD IDs for known planes — used for prefetching on startup
const KNOWN_PLANES = {
  "Plane 1": [65585,65565,65566,65567,65568,65569,65570,65571,65572,65573,
              65574,65575,65576,65577,65578,65579,65580,65581,65582,65583,65584],
  "Plane 2": [65974,65975,65976,65977,65978,65979,65980,65981,65982,65983,
              65984,65985,65986,65987,65988,65989,65990,65991,65992,65993,65994],
};

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

  // Extract the chocolatechip session cookie
  sessionCookie = cookies
    .map((c) => c.split(";")[0])
    .join("; ");

  console.log("[Space-Track] Authenticated successfully");
}

/**
 * Fetch TLEs from Space-Track.
 *
 * Default query: LEO payloads with recent epoch (last 30 days),
 * mean motion > 11.25 rev/day (~LEO cutoff), limited to 500 objects.
 *
 * You can customize by passing NORAD_CAT_IDs via the `ids` query param
 * on the /api/tles endpoint, e.g. /api/tles?ids=25544,58345,58346
 */
async function fetchTLEs(noradIds) {
  if (!sessionCookie) await spaceTrackLogin();

  let queryUrl;
  if (noradIds && noradIds.length > 0) {
    // Fetch specific satellites by NORAD ID
    const idList = noradIds.join(",");
    queryUrl =
      `${SPACETRACK_BASE}/basicspacedata/query/class/gp` +
      `/NORAD_CAT_ID/${idList}` +
      `/orderby/NORAD_CAT_ID/format/tle`;
  } else {
    // Default: recent LEO payloads
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
    // Session expired — re-login and retry once
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

/**
 * Parse raw TLE text into an array of { name, tle1, tle2 } objects.
 * Space-Track TLE format returns pairs of lines (no name line).
 * We synthesize a name from the NORAD ID in line 1.
 */
function parseTLEText(raw) {
  const lines = raw.trim().split("\n").map((l) => l.trim()).filter(Boolean);
  const satellites = [];

  for (let i = 0; i < lines.length - 1; i += 2) {
    const tle1 = lines[i];
    const tle2 = lines[i + 1];

    if (!tle1.startsWith("1 ") || !tle2.startsWith("2 ")) {
      // If the format includes 3-line TLEs (name + tle1 + tle2), handle that
      if (lines[i + 2] && lines[i + 1].startsWith("1 ") && lines[i + 2].startsWith("2 ")) {
        satellites.push({
          name: lines[i].trim(),
          tle1: lines[i + 1].trim(),
          tle2: lines[i + 2].trim(),
        });
        i += 1; // extra increment (loop adds 2)
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
// API routes
// ---------------------------------------------------------------------------

app.use(express.static(path.join(__dirname, "public")));

// Provide Cesium token to frontend without exposing .env
app.get("/api/config", (_req, res) => {
  res.json({ cesiumToken: process.env.CESIUM_ION_TOKEN });
});

// TLE endpoint with optional NORAD ID filter
app.get("/api/tles", async (req, res) => {
  try {
    const noradIds = req.query.ids
      ? req.query.ids.split(",").map((s) => s.trim())
      : null;

    // Use cache if fresh
    const cacheKey = noradIds ? noradIds.slice().sort().join(",") : "__default__";
    const now = Date.now();
    const cached = tleCache.get(cacheKey);

    if (cached && now - cached.fetchedAt < REFRESH_INTERVAL_MS) {
      console.log(`[Cache] Serving ${cached.data.length} cached TLEs (key: ${cacheKey.substring(0,30)}...)`);
      return res.json({
        satellites: cached.data,
        cachedAt: new Date(cached.fetchedAt).toISOString(),
        source: "cache",
      });
    }

    console.log(`[Space-Track] Fetching fresh TLEs for key: ${cacheKey.substring(0,30)}...`);
    const satellites = await fetchTLEs(noradIds);

    tleCache.set(cacheKey, { data: satellites, fetchedAt: now });
    console.log(`[Space-Track] Fetched ${satellites.length} satellites`);

    res.json({
      satellites,
      cachedAt: new Date(now).toISOString(),
      source: "live",
    });
  } catch (err) {
    console.error("[Error]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Prefetch & background refresh
// ---------------------------------------------------------------------------

async function prefetchKnownPlanes() {
  // Fetch all known IDs in one Space-Track call, then populate cache entries
  // for every useful combination (each plane solo + all planes combined)
  const allIds = Object.values(KNOWN_PLANES).flat().map(String);

  try {
    console.log("[Prefetch] Loading known satellite planes from Space-Track...");
    const allSatellites = await fetchTLEs(allIds);
    const now = Date.now();

    // Cache the combined key (both planes active)
    const combinedKey = allIds.slice().sort().join(",");
    tleCache.set(combinedKey, { data: allSatellites, fetchedAt: now });

    // Cache each individual plane too
    for (const [planeName, ids] of Object.entries(KNOWN_PLANES)) {
      const planeIdSet = new Set(ids.map(String));
      const planeKey = ids.map(String).sort().join(",");
      const planeSats = allSatellites.filter((s) => {
        const noradId = s.tle1.substring(2, 7).trim();
        return planeIdSet.has(noradId);
      });
      tleCache.set(planeKey, { data: planeSats, fetchedAt: now });
      console.log(`[Prefetch] Cached ${planeSats.length} satellites for ${planeName}`);
    }

    console.log(`[Prefetch] Total: ${allSatellites.length} satellites cached`);
  } catch (err) {
    console.error("[Prefetch] Failed:", err.message);
  }
}

app.listen(PORT, () => {
  console.log(`\n🛰️  LEO Tracker running at http://localhost:${PORT}`);
  console.log(`   Refresh interval: ${REFRESH_INTERVAL_MS / 60000} minutes\n`);

  // Prefetch on startup so data is ready before the first client connects
  prefetchKnownPlanes();

  // Background refresh to keep cache warm even if no clients are active
  setInterval(prefetchKnownPlanes, REFRESH_INTERVAL_MS);
});
