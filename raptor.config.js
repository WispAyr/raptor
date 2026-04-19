/**
 * RAPTOR Configuration Profiles
 * ==============================
 * Define your hardware setup here. Each profile maps to an object of feature flags
 * and service options. The server and detector both read from this file.
 *
 * Select your profile by setting RAPTOR_PROFILE=<name> in .env
 * or override individual values with env vars (env always wins).
 *
 * Built-in profiles:
 *   single      — one PTZ camera, no spotter, no SDR
 *   dual        — wide-field spotter + PTZ tracker hand-off
 *   multi       — mission control hub with N remote stations
 *   full        — everything enabled (requires full hardware stack)
 *   minimal     — demo mode, no cameras required
 */

const profiles = {

  /** ── Minimal / demo mode — no cameras required ───────────────────────────── */
  minimal: {
    name: 'Minimal (Demo)',
    cameras: {
      ptz: [],              // Add camera IDs from DB to track
      spotter: null,        // No wide-field spotter
    },
    detection: {
      enabled:             true,
      source:              'demo',     // 'demo' | 'rtsp://...' | '0' (webcam)
      useYOLO:             false,      // Skip YOLO in demo mode
      useOpticalFlow:      true,
      useConstellationMask:false,
      useFisheye:          false,
      nightMode:           false,
    },
    tracking: {
      enabled:             false,
      autoZoom:            false,
      dualCamera:          false,
    },
    sensors: {
      adsb:                false,
      sdr:                 false,
      magnetometer:        false,
      gps:                 false,
      weather:             false,
    },
    missionControl: {
      enabled:             false,
      isHub:               false,
      hubUrl:              null,
    },
  },

  /** ── Single PTZ camera ──────────────────────────────────────────────────── */
  single: {
    name: 'Single PTZ Camera',
    cameras: {
      ptz: [],              // populated from DB / env PTZ_CAMERA_ID
      spotter: null,
    },
    detection: {
      enabled:             true,
      source:              process.env.DETECT_SOURCE || 'demo',
      useYOLO:             true,
      useOpticalFlow:      true,
      useConstellationMask:true,
      useFisheye:          false,
      nightMode:           true,
    },
    tracking: {
      enabled:             true,
      autoZoom:            true,
      dualCamera:          false,
    },
    sensors: {
      adsb:                !!process.env.ADSB_HOST,
      sdr:                 false,
      magnetometer:        false,
      gps:                 !!process.env.GPS_PORT,
      weather:             true,         // Open-Meteo, no hardware required
    },
    missionControl: {
      enabled:             false,
      isHub:               false,
      hubUrl:              null,
    },
  },

  /** ── Dual camera: wide-field spotter + PTZ tracker ─────────────────────── */
  dual: {
    name: 'Dual Camera (Spotter + Tracker)',
    cameras: {
      ptz: [],              // PTZ tracker camera IDs
      spotter: null,        // Spotter camera config — set via SPOTTER_* env vars
    },
    detection: {
      enabled:             true,
      source:              process.env.SPOTTER_RTSP || process.env.DETECT_SOURCE || 'demo',
      useYOLO:             true,
      useOpticalFlow:      true,
      useConstellationMask:true,
      useFisheye:          !!process.env.SPOTTER_FISHEYE,  // set if spotter is a dome cam
      nightMode:           true,
    },
    tracking: {
      enabled:             true,
      autoZoom:            true,
      dualCamera:          true,
      handoffCooldownMs:   3000,
      acquireTimeoutMs:    8000,
    },
    sensors: {
      adsb:                !!process.env.ADSB_HOST,
      sdr:                 false,
      magnetometer:        false,
      gps:                 !!process.env.GPS_PORT,
      weather:             true,
    },
    missionControl: {
      enabled:             false,
      isHub:               false,
      hubUrl:              process.env.MISSION_HUB_URL || null,
    },
  },

  /** ── Multi-station: connects to mission control hub ────────────────────── */
  station: {
    name: 'Remote Station (connects to hub)',
    cameras: {
      ptz: [],
      spotter: null,
    },
    detection: {
      enabled:             true,
      source:              process.env.DETECT_SOURCE || 'demo',
      useYOLO:             true,
      useOpticalFlow:      true,
      useConstellationMask:true,
      useFisheye:          !!process.env.SPOTTER_FISHEYE,
      nightMode:           true,
    },
    tracking: {
      enabled:             true,
      autoZoom:            true,
      dualCamera:          !!process.env.SPOTTER_RTSP,
    },
    sensors: {
      adsb:                !!process.env.ADSB_HOST,
      sdr:                 !!process.env.SDR_ENABLED,
      magnetometer:        !!process.env.MAGNETOMETER_DEVICE,
      gps:                 !!process.env.GPS_PORT,
      weather:             true,
    },
    missionControl: {
      enabled:             true,
      isHub:               false,
      hubUrl:              process.env.MISSION_HUB_URL,
      stationId:           process.env.STATION_ID || 'station-1',
      stationLat:          parseFloat(process.env.STATION_LAT || '0'),
      stationLon:          parseFloat(process.env.STATION_LON || '0'),
      stationAlt:          parseFloat(process.env.STATION_ALT || '0'),
    },
  },

  /** ── Mission control hub (aggregates multiple stations) ─────────────────── */
  hub: {
    name: 'Mission Control Hub',
    cameras: { ptz: [], spotter: null },
    detection: { enabled: false },
    tracking:  { enabled: false, autoZoom: false, dualCamera: false },
    sensors:   { adsb: false, sdr: false, magnetometer: false, gps: false, weather: false },
    missionControl: {
      enabled: true,
      isHub:   true,
      port:    parseInt(process.env.HUB_PORT || '3001'),
    },
  },

  /** ── Full stack — all hardware enabled ──────────────────────────────────── */
  full: {
    name: 'Full Stack',
    cameras: { ptz: [], spotter: null },
    detection: {
      enabled: true,
      source:  process.env.DETECT_SOURCE || 'demo',
      useYOLO: true, useOpticalFlow: true, useConstellationMask: true,
      useFisheye: !!process.env.SPOTTER_FISHEYE, nightMode: true,
    },
    tracking: { enabled: true, autoZoom: true, dualCamera: true, handoffCooldownMs: 3000, acquireTimeoutMs: 8000 },
    sensors:  { adsb: true, sdr: !!process.env.SDR_ENABLED, magnetometer: !!process.env.MAGNETOMETER_DEVICE, gps: true, weather: true },
    missionControl: {
      enabled: true, isHub: false,
      hubUrl: process.env.MISSION_HUB_URL || null,
      stationId: process.env.STATION_ID || 'raptor-1',
      stationLat: parseFloat(process.env.STATION_LAT || '0'),
      stationLon: parseFloat(process.env.STATION_LON || '0'),
      stationAlt: parseFloat(process.env.STATION_ALT || '0'),
    },
  },
};

/**
 * Load config for the active profile, then apply any env var overrides.
 * env vars always win over profile defaults.
 */
function loadConfig() {
  const profileName = process.env.RAPTOR_PROFILE || 'single';
  const profile = profiles[profileName];

  if (!profile) {
    console.warn(`[Config] Unknown profile "${profileName}" — falling back to "single"`);
    return loadProfileWithOverrides(profiles.single);
  }

  console.log(`[Config] Profile: ${profile.name} (${profileName})`);
  return loadProfileWithOverrides(profile);
}

function loadProfileWithOverrides(profile) {
  // Deep clone
  const cfg = JSON.parse(JSON.stringify(profile));

  // Env overrides for individual feature flags
  if (process.env.DETECT_YOLO       !== undefined) cfg.detection.useYOLO             = process.env.DETECT_YOLO === 'true';
  if (process.env.DETECT_FLOW       !== undefined) cfg.detection.useOpticalFlow       = process.env.DETECT_FLOW === 'true';
  if (process.env.DETECT_CONSTEL    !== undefined) cfg.detection.useConstellationMask = process.env.DETECT_CONSTEL === 'true';
  if (process.env.DETECT_FISHEYE    !== undefined) cfg.detection.useFisheye           = process.env.DETECT_FISHEYE === 'true';
  if (process.env.DETECT_NIGHT      !== undefined) cfg.detection.nightMode            = process.env.DETECT_NIGHT === 'true';
  if (process.env.TRACKING_ENABLED  !== undefined) cfg.tracking.enabled               = process.env.TRACKING_ENABLED === 'true';
  if (process.env.AUTO_ZOOM         !== undefined) cfg.tracking.autoZoom              = process.env.AUTO_ZOOM === 'true';
  if (process.env.DUAL_CAMERA       !== undefined) cfg.tracking.dualCamera            = process.env.DUAL_CAMERA === 'true';
  if (process.env.ADSB_ENABLED      !== undefined) cfg.sensors.adsb                   = process.env.ADSB_ENABLED === 'true';
  if (process.env.WEATHER_ENABLED   !== undefined) cfg.sensors.weather                = process.env.WEATHER_ENABLED === 'true';

  return cfg;
}

module.exports = { loadConfig, profiles };
