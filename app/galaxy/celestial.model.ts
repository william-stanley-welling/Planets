/**
 * @fileoverview Core data models and abstract base classes for all celestial bodies.
 *
 * Provides:
 *  - Configuration interfaces (`CelestialConfig`, `OrbitalConfig`, `PlanetConfig`, `MoonConfig`, `StarConfig`).
 *  - Abstract `CelestialBody` — shared mesh/group/rotation logic.
 *  - Abstract `OrbitingBody` — Keplerian position integration, satellite hierarchy.
 *  - `SIMULATION_CONSTANTS` — scene-unit calibration values.
 *
 * @module celestial.model
 */

import * as THREE from 'three';
import { StarStage } from './star.model';

// ---------------------------------------------------------------------------
// Configuration interfaces
// ---------------------------------------------------------------------------

/**
 * Minimum properties required to construct any renderable celestial body.
 *
 * @interface CelestialConfig
 */
export interface CelestialConfig {
  /** Display name, used as the primary identifier throughout the system. */
  name: string;
  /** Equatorial diameter in scene units (10^3 km for planets). */
  diameter: number;
  /** Mantissa of the body's mass (combined with `pow` to give mass × 10^pow kg). */
  mass: number;
  /** CSS hex colour string used for orbit lines and minimap dots. */
  color?: string;
  /** URL to the diffuse texture image. */
  map?: string;
  /** URL to the bump/displacement texture. */
  bumpMap?: string;
  /** URL to the specular texture. */
  specMap?: string;
  /** URL to the cloud-layer diffuse texture. */
  cloudMap?: string;
  /** URL to the cloud-layer alpha (transparency) texture. */
  alphaMap?: string;
  /** Sphere horizontal subdivision count (Three.js `widthSegments`). */
  widthSegments?: number;
  /** Sphere vertical subdivision count (Three.js `heightSegments`). */
  heightSegments?: number;
  /** Atmosphere shell thickness above the surface, in scene units. */
  atmosphere?: number;
  /** Base-10 exponent for the body's mass (e.g. 24 → kg × 10²⁴). */
  pow?: number;
}

/**
 * Keplerian orbital elements shared by planets and moons.
 *
 * @interface OrbitalConfig
 */
export interface OrbitalConfig {
  /**
   * Heliocentric semi-major axis in AU.
   * Set for planets; leave undefined for moons (use `x` instead).
   */
  au?: number;
  /**
   * Moon-relative semi-major axis in 10^5 km (same unit as the planet `x` field).
   * Populated server-side from `MOON_SEMIMAJOR_X` in `server.js`.
   * @deprecated Use `x` for new moon configs. Kept for potential future sub-moon hierarchies.
   */
  relativeAu?: number;
  /** Orbital period in Earth days. */
  period: number;
  /** Orbital eccentricity (0 = circular, <1 = elliptical). */
  eccentricity?: number;
  /** Orbital inclination relative to the ecliptic plane, in degrees. */
  inclination?: number;
  /**
   * Mean anomaly at the J2000 epoch, in radians.
   * Defaults to `0` if omitted.
   */
  M0?: number;
}

/**
 * Axial rotation properties shared by planets, moons, and stars.
 *
 * @interface RotationalConfig
 */
export interface RotationalConfig {
  /** Axial tilt (obliquity) in degrees. */
  tilt?: number;
  /**
   * Rotation increment per animation frame, in radians.
   * Approximate — not tied to a physically accurate sidereal period.
   */
  spin?: number;
}

/**
 * Descriptive configuration for a ring or belt around a star or planet.
 *
 * - `inner` and `outer` use the same scene units as planet `x` (scene units ≈ 10^5 km).
 * - `thickness` is a visual thickness factor (relative).
 * - `particleCount` is optional and intended for particle-based renderers.
 */
export interface RingConfig {
  /** Optional human label for the ring (e.g., "SaturnMain", "AsteroidBelt"). */
  name?: string;
  /** Inner radius (scene units, same scale as planet x). */
  inner?: number;
  /** Outer radius (scene units). */
  outer?: number;
  /** Visual thickness factor (relative). */
  thickness?: number;
  /** CSS hex color fallback for renderers that don't use textures. */
  color?: string;
  /** Optional texture URL (server-relative, e.g. /images/rings/ring.png). */
  texture?: string;
  /** Optional particle count for particle-based ring renderers. */
  particleCount?: number;
  /** Optional period (days) for animated belts; 0 = static. */
  period?: number;
}

/**
 * Full configuration for an orbiting planet.
 *
 * @interface PlanetConfig
 * @extends CelestialConfig
 * @extends OrbitalConfig
 * @extends RotationalConfig
 */
export interface PlanetConfig extends CelestialConfig, OrbitalConfig, RotationalConfig {
  /** Server-relative path to the individual planet JSON resource. */
  resource?: string;
  /** Optional ring/belt definitions for this planet (e.g., Saturn, Uranus). */
  rings?: RingConfig[];
}

/**
 * Full configuration for an orbiting moon.
 *
 * In addition to the base fields, the server injects an `x` property
 * (semi-major axis in 10^5 km) used by {@link OrbitingBody.getSemiMajorAxis}
 * to compute the visual orbit radius.
 *
 * @interface MoonConfig
 * @extends CelestialConfig
 * @extends OrbitalConfig
 * @extends RotationalConfig
 */
export interface MoonConfig extends CelestialConfig, OrbitalConfig, RotationalConfig {
  /** Server-relative path to the individual moon JSON resource. */
  resource?: string;
  /**
   * Semi-major axis in 10^5 km, injected by the server.
   * Used by `getSemiMajorAxis()` to compute the visual orbit radius.
   */
  x?: number;
}

// ---------------------------------------------------------------------------
// Star configuration
// ---------------------------------------------------------------------------

/**
 * Additional physical properties specific to stellar bodies.
 *
 * @interface AdditionalStarProperties
 */
export interface AdditionalStarProperties {
  /** Human-readable elemental composition, e.g. `"74% hydrogen, 24% helium"`. */
  composition?: string;
  /** Effective surface temperature in Kelvin. */
  heat?: number;
  /** Luminosity in solar luminosities (L☉). */
  energy?: number;
  /** Radiant flux at a reference distance (arbitrary scale). */
  radiance?: number;
}

/**
 * Full configuration for a star.
 *
 * @interface StarConfig
 * @extends CelestialConfig
 * @extends AdditionalStarProperties
 */
export interface StarConfig extends CelestialConfig, AdditionalStarProperties {
  /** Evolutionary stage classification. */
  stage: StarStage;
  /** Axial tilt in degrees. */
  tilt?: number;
  /** Rotation increment per frame in radians. */
  spin?: number;
  /** Optional rings/belts at the star level (e.g., an asteroid belt). */
  rings?: RingConfig[];
}

// ---------------------------------------------------------------------------
// Simulation constants
// ---------------------------------------------------------------------------

/**
 * Calibration constants that map physical units to Three.js scene units.
 *
 * **Scene-unit scale:**  1 scene unit ≈ 10^5 km (100,000 km).
 * - 1 AU = 149,600 × 10³ km → `SCALE_UNITS_PER_AU = 1496` scene units.
 * - Moon at 384,400 km = 3.844 scene units (real), scaled up via `MOON_VISUAL_SCALE`.
 */
export const SIMULATION_CONSTANTS = {
  /**
   * Scene units per astronomical unit.
   * `SCALE_UNITS_PER_AU × au = scene-space distance from the star`.
   */
  SCALE_UNITS_PER_AU: 1496,

  /** Unused legacy constant — kept for backwards compatibility. */
  TIME_SCALE_SECONDS_PER_DAY: 86400 * 0.08,

  /**
   * Multiplier applied to a moon's `x` value (in 10^5 km) to produce the
   * visual orbit radius in scene units.
   *
   * At `30`, Earth's Moon (3.844 × 10^5 km) orbits at ≈ 115 scene units —
   * clearly visible when the camera is within ~1000 units of Earth.
   *
   * Increasing this value spreads moon orbits further from their parent planets.
   */
  MOON_VISUAL_SCALE: 30,

  /** Fallback visual orbit radius (scene units) when no distance data is available. */
  MOON_DEFAULT_RADIUS: 50,
} as const;

// ---------------------------------------------------------------------------
// Abstract base: CelestialBody
// ---------------------------------------------------------------------------

/**
 * Interface for bodies that can accept an updated orbital angle and report
 * their semi-major axis to the rendering system.
 *
 * @interface Satellite
 */
export interface Satellite {
  /**
   * Positions this body on its ellipse at the given true anomaly.
   *
   * @param {number} rad - True anomaly in radians.
   */
  setAngle(rad: number): void;
  /**
   * Returns the visual semi-major axis of this body's orbit in scene units.
   *
   * @returns {number} Semi-major axis in scene units.
   */
  getSemiMajorAxis(): number;
}

/**
 * Abstract base class for all renderable celestial bodies (stars, planets, moons).
 *
 * Manages:
 *  - The Three.js `group` hierarchy (mesh, atmosphere, clouds, highlight).
 *  - Per-frame axial rotation via a quaternion accumulated spin.
 *  - A `satellites` list for child bodies.
 *
 * @abstract
 */
export abstract class CelestialBody {
  /** Display name; mirrors `config.name`. */
  name: string;

  /** Physical mass in kg (mantissa × 10^pow). Set by factories after construction. */
  mass!: number;

  /** Normalised rotation axis derived from the axial tilt angle. */
  axis: THREE.Vector3;

  /** Rotation increment applied each frame, in radians. */
  spin = 0.01;

  /** The primary sphere mesh. */
  mesh!: THREE.Mesh;

  /** Optional cloud shell mesh rendered above the surface. */
  clouds?: THREE.Mesh;

  /** Optional atmosphere shell mesh. */
  atmosphere?: THREE.Mesh;

  /** Child bodies (planets for a star, moons for a planet). */
  satellites: CelestialBody[] = [];

  /** Point lights or ambient lights attached to this body. */
  lights: any[] = [];

  /** Semi-transparent selection halo mesh, toggled by the UI. */
  highlight!: THREE.Mesh;

  /** Accumulated quaternion delta for spin calculation. */
  quaternion: THREE.Quaternion;

  /**
   * Root `THREE.Group` for this body.
   * Added to the scene (or parent's group) by the factory.
   */
  group: THREE.Group;

  /** Original configuration object, cast to a more specific interface in subclasses. */
  config: CelestialConfig;

  /** Orbital inclination in degrees; mirrored from config for convenient access. */
  inclination = 0;

  /**
   * @param {CelestialConfig} config - Body configuration data.
   */
  constructor(config: CelestialConfig) {
    this.config = config;
    this.name = config.name;
    const tiltRad = (((config as any).tilt ?? 0) * Math.PI) / 180;
    this.axis = new THREE.Vector3(Math.cos(tiltRad), Math.sin(tiltRad), 0).normalize();
    this.spin = (config as any).spin ?? 0.01;
    this.quaternion = new THREE.Quaternion();
    this.group = new THREE.Group();
    this.group.name = `${config.name}_group`;
  }

  /**
   * Validates that a config object meets the minimum requirements for `CelestialBody`.
   * Throws a descriptive `Error` on failure.
   *
   * @param {any} config - Raw config object to validate.
   * @throws {Error} If `name` is missing or `diameter` is not a positive number.
   */
  static validate(config: any): asserts config is CelestialConfig {
    if (!config?.name || typeof config.name !== 'string') {
      throw new Error(`CelestialBody: name required (got ${JSON.stringify(config?.name)})`);
    }
    if (typeof config.diameter !== 'number' || config.diameter <= 0) {
      throw new Error(`CelestialBody "${config.name}": invalid diameter ${config.diameter}`);
    }
  }

  /**
   * Attaches a satellite body to this body's default group.
   * Subclasses may override to use a specialised group (e.g. `orbitalGroup`).
   *
   * @param {CelestialBody} satellite - The child body to attach.
   */
  addSatellite(satellite: CelestialBody): void {
    this.satellites.push(satellite);
    this.group.add(satellite.group);
  }

  /**
   * Applies one frame of axial rotation to the mesh and, if present, clouds.
   * Cloud rotation is slightly randomised for a natural appearance.
   */
  rotate(): void {
    this.quaternion.setFromAxisAngle(this.axis, this.spin);
    this.mesh.quaternion.multiplyQuaternions(this.quaternion, this.mesh.quaternion);
    if (this.clouds) {
      const cloudQ = new THREE.Quaternion();
      cloudQ.setFromAxisAngle(this.axis, this.spin + Math.random() / 250);
      this.clouds.quaternion.multiplyQuaternions(cloudQ, this.clouds.quaternion);
    }
  }

  /**
   * Recursively updates this body and all descendants each animation frame.
   * Calls {@link rotate} then propagates down the satellite tree.
   *
   * @param {number} simTime - Current simulation timestamp in milliseconds.
   */
  updateHierarchy(simTime: number): void {
    this.rotate();
    for (const sat of this.satellites) {
      sat.updateHierarchy(simTime);
    }
  }
}

// ---------------------------------------------------------------------------
// Abstract base: OrbitingBody
// ---------------------------------------------------------------------------

/**
 * Abstract base for bodies that orbit a parent (planets orbit stars, moons orbit planets).
 *
 * Extends `CelestialBody` with:
 *  - An `orbitalGroup` `THREE.Group` whose position is updated each tick
 *    by {@link setAngle} to place the body on its Keplerian ellipse.
 *  - {@link getSemiMajorAxis} — returns the visual semi-major axis in scene units,
 *    handling planets (AU-based), moons (server-injected `x` in 10^5 km),
 *    and a fallback default.
 *
 * @abstract
 * @extends CelestialBody
 * @implements Satellite
 */
export abstract class OrbitingBody extends CelestialBody implements Satellite {
  /** Group whose `position` is set by `setAngle` to place the body on its orbit. */
  orbitalGroup: THREE.Group;

  /** Current true anomaly in radians (last value applied via `setAngle`). */
  currentAngle = 0;

  /** Typed orbital configuration, cast from the base `CelestialConfig`. */
  orbitingConfig: PlanetConfig | MoonConfig;

  /**
   * @param {PlanetConfig} config - Planet or moon configuration, which must include
   *   orbital elements (`period`, optional `au`/`x`/`relativeAu`, `eccentricity`, `inclination`).
   */
  constructor(config: PlanetConfig) {
    super(config);
    this.config = config;
    this.orbitingConfig = config;
    this.orbitalGroup = new THREE.Group();
    this.orbitalGroup.name = `${config.name}_orbitalGroup`;
    this.group.add(this.orbitalGroup);
  }

  /**
   * Overrides the default satellite attachment to use `orbitalGroup`,
   * so that child bodies (moons) are positioned relative to this body's
   * moving orbital position rather than its fixed group origin.
   *
   * @param {CelestialBody} satellite - The child body to attach.
   */
  addSatellite(satellite: CelestialBody): void {
    this.satellites.push(satellite);
    this.orbitalGroup.add(satellite.group);
  }

  /**
   * Computes the visual semi-major axis for this body's orbit in scene units.
   *
   * Priority order:
   *  1. `au` (planet) → `au × SCALE_UNITS_PER_AU`
   *  2. `x` (moon, injected by server) → `x × MOON_VISUAL_SCALE`
   *  3. `relativeAu` (legacy) → `relativeAu × MOON_VISUAL_SCALE × SCALE_UNITS_PER_AU`
   *  4. `MOON_DEFAULT_RADIUS` (50) as last resort.
   *
   * @returns {number} Visual semi-major axis in scene units.
   */
  getSemiMajorAxis(): number {
    const cfg = this.orbitingConfig as any;

    // Planet — heliocentric AU
    if (cfg.au !== undefined && cfg.au > 0) {
      return cfg.au * SIMULATION_CONSTANTS.SCALE_UNITS_PER_AU;
    }

    // Moon — semi-major axis in 10^5 km, injected by server
    if (cfg.x !== undefined && cfg.x > 0) {
      return cfg.x * SIMULATION_CONSTANTS.MOON_VISUAL_SCALE;
    }

    // Legacy relativeAu (in AU)
    if (cfg.relativeAu !== undefined && cfg.relativeAu > 0) {
      return cfg.relativeAu
        * SIMULATION_CONSTANTS.MOON_VISUAL_SCALE
        * SIMULATION_CONSTANTS.SCALE_UNITS_PER_AU;
    }

    // console.warn(`[OrbitingBody] "${this.name}" has no orbital distance — using default radius.`);
    return SIMULATION_CONSTANTS.MOON_DEFAULT_RADIUS;
  }

  /**
   * Positions this body on its Keplerian ellipse for the given true anomaly.
   *
   * Computes the radius from the ellipse equation r = a(1−e²)/(1+e·cosν),
   * then rotates the position into 3-D space using the orbital inclination.
   *
   * @param {number} rad - True anomaly ν in radians.
   */
  setAngle(rad: number): void {
    this.currentAngle = rad % (2 * Math.PI);
    const a = this.getSemiMajorAxis();
    const e = this.orbitingConfig.eccentricity ?? 0;
    const nu = this.currentAngle;
    const r = a * (1 - e * e) / (1 + e * Math.cos(nu));
    const xOr = r * Math.cos(nu);
    const yOr = r * Math.sin(nu);
    const inc = ((this.orbitingConfig.inclination ?? 0) * Math.PI) / 180;

    this.orbitalGroup.position.set(
      xOr,
      yOr * Math.cos(inc),
      yOr * Math.sin(inc),
    );
  }

  /**
   * No-op for server-driven orbital updates.
   * Orbital position is applied exclusively via {@link setAngle} from WebSocket data.
   *
   * @param {number} _simTime - Unused simulation timestamp.
   */
  revolve(_simTime: number): void { /* position driven by server via setAngle */ }
}
