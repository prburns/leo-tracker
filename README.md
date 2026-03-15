# 🛰️ LEO Satellite Tracker

Real-time 3D visualization of LEO satellites using TLE data from Space-Track.org, SGP4 propagation via satellite.js, and CesiumJS for rendering.

## Prerequisites

- **Node.js** 18+ (run `node -v` to check)
- A free [Space-Track.org](https://www.space-track.org/auth/createAccount) account
- A free [Cesium Ion](https://ion.cesium.com/signup/) access token

## Setup

1. **Install dependencies:**

   ```bash
   cd leo-tracker
   npm install
   ```

2. **Configure credentials** — edit `.env`:

   ```
   SPACETRACK_USER=your_email@example.com
   SPACETRACK_PASS=your_password
   CESIUM_ION_TOKEN=your_cesium_ion_token
   ```

3. **Run the server:**

   ```bash
   npm start
   ```

   Or with auto-reload during development:

   ```bash
   npm run dev
   ```

4. **Open** [http://localhost:3000](http://localhost:3000)

## Usage

### Default view
On launch, the tracker fetches up to 500 recent LEO payloads from Space-Track and renders them on the globe. Positions update in real-time using SGP4 propagation.

### Track specific satellites
Enter NORAD catalog IDs in the input field (comma-separated) and click **Fetch**. Some useful IDs:

| Satellite | NORAD ID |
|-----------|----------|
| ISS (Zarya) | 25544 |
| Hubble | 20580 |
| Landsat 9 | 49260 |

### Color coding
Satellites are color-coded by orbit altitude:
- 🔵 Blue — Very Low Earth Orbit (~< 500 km)
- 🟢 Green — Low (~500–600 km)
- 🟡 Yellow — Mid LEO
- 🔴 Red — High LEO

### Click a satellite
Click any satellite point to see its NORAD ID, international designator, current lat/lon/alt, and velocity.

### Auto-refresh
TLEs are automatically refreshed from Space-Track every 30 minutes. The HUD shows the last update time.

## Architecture

```
Browser                         Server (Express)
  │                                 │
  │  GET /api/config                │
  │ ──────────────────────────────► │ (returns Cesium token)
  │                                 │
  │  GET /api/tles[?ids=...]        │
  │ ──────────────────────────────► │ ──► Space-Track API
  │  ◄─ { satellites: [...] }       │ ◄── (cookie auth + TLE cache)
  │                                 │
  │  satellite.js SGP4              │
  │  propagation (client-side)      │
  │                                 │
  │  CesiumJS 3D rendering          │
  │  (requestAnimationFrame loop)   │
```

## Customization

- **Change refresh interval**: Edit `REFRESH_INTERVAL_MS` in `server.js` and `TLE_REFRESH_MS` in `public/app.js`
- **Increase satellite limit**: Change `/limit/500` in the Space-Track query URL in `server.js`
- **Orbit filter**: Adjust `MEAN_MOTION` threshold in `server.js` (11.25 rev/day ≈ LEO cutoff)
- **Satellite appearance**: Modify `pixelSize`, colors, and label settings in `app.js`

## License

MIT
