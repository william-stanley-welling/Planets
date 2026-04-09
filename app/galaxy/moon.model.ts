import { OrbitingBody, PlanetConfig, SIMULATION_CONSTANTS } from './planet.model';
import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Moon-specific configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for a natural satellite (moon).
 *
 * Extends the shared `PlanetConfig` with moon-specific fields.
 * Orbital distance is expressed via `relativeAu` (inherited from `OrbitalConfig`)
 * rather than `au`, which is reserved for heliocentric bodies.
 *
 * `resource` is the server-relative path to the individual moon JSON file
 * (e.g. "/moons/moon.json") used by the SSE data pipeline.
 */
export interface MoonConfig extends PlanetConfig {
  /** Server-relative path to the individual moon JSON asset. */
  resource?: string;
}

// ---------------------------------------------------------------------------
// Moon lifecycle / phase model
// ---------------------------------------------------------------------------

/**
 * Named lunar phases in the standard synodic cycle.
 */
export enum LunarPhase {
  NEW_MOON = 'New Moon',
  WAXING_CRESCENT = 'Waxing Crescent',
  FIRST_QUARTER = 'First Quarter',
  WAXING_GIBBOUS = 'Waxing Gibbous',
  FULL_MOON = 'Full Moon',
  WANING_GIBBOUS = 'Waning Gibbous',
  LAST_QUARTER = 'Last Quarter',
  WANING_CRESCENT = 'Waning Crescent',
}

/**
 * Derives the instantaneous lunar phase from the moon's current true anomaly
 * relative to its parent body's solar direction.
 *
 * @param phaseAngleRad  Angle between the moon–parent–star plane (radians).
 *                       0 = New Moon (moon between parent and star).
 */
export function lunarPhaseFromAngle(phaseAngleRad: number): LunarPhase {
  // Normalise to [0, 2π)
  const a = ((phaseAngleRad % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const deg = (a * 180) / Math.PI;

  if (deg < 22.5 || deg >= 337.5) return LunarPhase.NEW_MOON;
  if (deg < 67.5) return LunarPhase.WAXING_CRESCENT;
  if (deg < 112.5) return LunarPhase.FIRST_QUARTER;
  if (deg < 157.5) return LunarPhase.WAXING_GIBBOUS;
  if (deg < 202.5) return LunarPhase.FULL_MOON;
  if (deg < 247.5) return LunarPhase.WANING_GIBBOUS;
  if (deg < 292.5) return LunarPhase.LAST_QUARTER;
  return LunarPhase.WANING_CRESCENT;
}

// ---------------------------------------------------------------------------
// Moon class
// ---------------------------------------------------------------------------

/**
 * Represents a natural satellite orbiting a planet.
 *
 * Differences from `Planet`:
 * - Uses `relativeAu` (scaled by `MOON_DISTANCE_SCALE`) for orbital radius
 *   instead of the heliocentric `au` value.
 * - Stores `resource` — the SSE asset path for lazy-loading per-moon detail JSON.
 * - Exposes `getLunarPhase()` to query the current phase given a star position.
 *
 * The `Moon` sits inside a planet's `THREE.Group` hierarchy so its
 * `revolve()` positions it relative to the planet's local origin.
 */
export class Moon extends OrbitingBody {
  /** Server-relative path to the individual moon JSON asset. */
  readonly resource?: string;

  constructor(config: MoonConfig) {
    super(config);
    this.resource = config.resource;

    // Moons use relativeAu; if neither au nor relativeAu is set the
    // OrbitingBody fallback (a = 50 scene units) is used.
    if (!config.au && !config.relativeAu) {
      console.warn(
        `Moon "${config.name}" has no au or relativeAu — ` +
        `orbital radius will default to ${SIMULATION_CONSTANTS.MOON_DISTANCE_SCALE * 50} scene units.`
      );
    }
  }

  /**
   * Returns the current lunar phase by comparing the moon's world position
   * against the direction toward the star (assumed at scene origin).
   *
   * @param starWorldPosition  World-space position of the parent star.
   */
  getLunarPhase(starWorldPosition: THREE.Vector3 = new THREE.Vector3()): LunarPhase {
    const moonWorld = new THREE.Vector3();
    this.group.getWorldPosition(moonWorld);

    const toStar = starWorldPosition.clone().sub(moonWorld).normalize();
    const phaseAngle = Math.atan2(toStar.z, toStar.x);

    return lunarPhaseFromAngle(phaseAngle);
  }
}
