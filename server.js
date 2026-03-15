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
let tleCache = { data: null, fetchedAt: null };

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

    // Use cache if fresh (unless specific IDs requested that differ)
    const cacheKey = noradIds ? noradIds.sort().join(",") : "__default__";
    const now = Date.now();

    if (
      tleCache.data &&
      tleCache.key === cacheKey &&
      tleCache.fetchedAt &&
      now - tleCache.fetchedAt < REFRESH_INTERVAL_MS
    ) {
      console.log(`[Cache] Serving ${tleCache.data.length} cached TLEs`);
      return res.json({
        satellites: tleCache.data,
        cachedAt: new Date(tleCache.fetchedAt).toISOString(),
        source: "cache",
      });
    }

    console.log("[Space-Track] Fetching fresh TLEs...");
    const satellites = await fetchTLEs(noradIds);

    tleCache = { data: satellites, fetchedAt: now, key: cacheKey };
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

app.listen(PORT, () => {
  console.log(`\n🛰️  LEO Tracker running at http://localhost:${PORT}`);
  console.log(`   Refresh interval: ${REFRESH_INTERVAL_MS / 60000} minutes\n`);
});
