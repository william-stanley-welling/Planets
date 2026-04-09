import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Config interfaces
// ---------------------------------------------------------------------------

export interface VisualConfig {
  name: string;
  map: string;
  bumpMap?: string;
  specMap?: string;
  cloudMap?: string;
  alphaMap?: string;
  color?: string;
  widthSegments: number;
  heightSegments: number;
}

export interface PhysicalConfig {
  diameter: number;
  mass: number;
  atmosphere?: number;
  pow?: number;
}

export interface OrbitalConfig {
  au?: number;
  relativeAu?: number;
  period: number;
  eccentricity?: number;
  inclination?: number;
}

export interface RotationalConfig {
  tilt?: number;
  spin?: number;
}

export interface PlanetConfig extends VisualConfig, PhysicalConfig, OrbitalConfig, RotationalConfig { }

// ---------------------------------------------------------------------------
// Simulation constants
// ---------------------------------------------------------------------------

export const SIMULATION_CONSTANTS = {
  /** Scene units per 1 AU.  Earth orbit = 1496 scene units. */
  SCALE_UNITS_PER_AU: 1496,

  /**
   * Wall-clock milliseconds representing one simulated day.
   * 86400 s/day × 0.08 → Earth completes one orbit in ~42 real minutes.
   */
  TIME_SCALE_SECONDS_PER_DAY: 86400 * 0.08,

  /** Moon orbital-radius scale when relativeAu is provided. */
  MOON_DISTANCE_SCALE: 0.002,

  /**
   * Fallback orbital radius (scene units) for moons with no au/relativeAu.
   * ~30 planet diameters for Earth's Moon — reasonable visual approximation.
   */
  MOON_DEFAULT_RADIUS: 50,
} as const;

// ---------------------------------------------------------------------------
// Abstract base: CelestialBody
// ---------------------------------------------------------------------------

export abstract class CelestialBody {
  name: string;
  mass!: number;
  axis: THREE.Vector3;
  spin = 0.01;

  mesh!: THREE.Mesh;
  clouds?: THREE.Mesh;
  atmosphere?: THREE.Mesh;

  satellites: CelestialBody[] = [];
  lights: any[] = [];

  highlight!: THREE.Mesh;
  quaternion: THREE.Quaternion;

  /**
   * Root Three.js group for this body.
   * - Stars: added to the scene at origin.
   * - Planets/Moons: added to their parent's `orbitalGroup` via addSatellite().
   */
  group: THREE.Group;

  config: PlanetConfig;
  inclination = 0;

  constructor(config: PlanetConfig) {
    CelestialBody.validate(config);
    this.config = config;
    this.name = config.name;
    this.inclination = config.inclination || 0;

    const tiltRad = (config.tilt || 0) * Math.PI / 180;
    this.axis = new THREE.Vector3(Math.cos(tiltRad), Math.sin(tiltRad), 0).normalize();
    this.spin = config.spin ?? 0.01;
    this.quaternion = new THREE.Quaternion();
    this.group = new THREE.Group();
    this.group.name = `${config.name}_group`;
  }

  static validate(config: any): asserts config is PlanetConfig {
    if (!config?.name || typeof config.name !== 'string')
      throw new Error(`CelestialBody: name required (got ${JSON.stringify(config?.name)})`);

    if (typeof config.diameter !== 'number' || config.diameter <= 0)
      throw new Error(`CelestialBody "${config.name}": invalid diameter ${config.diameter}`);

    const isStar = config.name.toLowerCase() === 'sun' || (!config.au && !config.relativeAu);
    if (!isStar && (typeof config.period !== 'number' || config.period <= 0))
      throw new Error(`CelestialBody "${config.name}": invalid period ${config.period}`);

    if (config.au !== undefined && (typeof config.au !== 'number' || config.au < 0))
      throw new Error(`CelestialBody "${config.name}": invalid au ${config.au}`);
  }

  setMesh(m: THREE.Mesh) { this.mesh = m; }
  setClouds(c: THREE.Mesh) { this.clouds = c; }
  setLights(l: any[]) { this.lights = l; }
  setSpin(s: number) { this.spin = s; }
  setHighlight(h: THREE.Mesh) { this.highlight = h; }

  /**
   * Attach a satellite into this body's scene graph.
   * Stars use this base implementation (pivot at heliocentric origin).
   * OrbitingBody overrides to attach to its positioned orbitalGroup.
   */
  addSatellite(satellite: CelestialBody): void {
    this.satellites.push(satellite);
    this.group.add(satellite.group);
  }

  rotate(): void {
    this.quaternion.setFromAxisAngle(this.axis, this.spin);
    this.mesh.quaternion.multiplyQuaternions(this.quaternion, this.mesh.quaternion);

    if (this.clouds) {
      this.quaternion.setFromAxisAngle(this.axis, this.spin + Math.random() / 250);
      this.clouds.quaternion.multiplyQuaternions(this.quaternion, this.clouds.quaternion);
    }
  }

  updateHierarchy(simTime: number): void {
    this.rotate();

    if (typeof (this as any).revolve === 'function') {
      (this as any).revolve(simTime);
    }

    for (const sat of this.satellites) {
      sat.updateHierarchy(simTime);
    }
  }
}

// ---------------------------------------------------------------------------
// Satellite interface
// ---------------------------------------------------------------------------

export interface Satellite {
  getOrbitalPosition(simTime: number): THREE.Vector3;
  revolve(simTime: number): void;
}

// ---------------------------------------------------------------------------
// OrbitingBody — planets and moons
// ---------------------------------------------------------------------------

export abstract class OrbitingBody extends CelestialBody implements Satellite {
  /**
   * `orbitalGroup` sits inside `group` and is translated each tick to the
   * Keplerian coordinates.  Every visual child (mesh, highlight, clouds)
   * and every satellite group MUST be attached here — not to `group`.
   *
   * Full scene-graph path:
   *
   *   scene
   *     star.group                    (at world origin)
   *       planet.group                (pivot, never translated)
   *         planet.orbitalGroup       ← revolve() sets position here
   *           planet.mesh             ← rotates in-place
   *           planet.highlight
   *           planet.clouds
   *           moon.group              ← added by planet.addSatellite()
   *             moon.orbitalGroup     ← revolve() sets position here
   *               moon.mesh
   */
  orbitalGroup: THREE.Group;

  constructor(prop: PlanetConfig) {
    super(prop);
    this.orbitalGroup = new THREE.Group();
    this.orbitalGroup.name = `${prop.name}_orbitalGroup`;
    this.group.add(this.orbitalGroup);
  }

  /**
   * Satellites of an orbiting body attach to `orbitalGroup` so they inherit
   * the parent's world position and orbit around it correctly.
   */
  addSatellite(satellite: CelestialBody): void {
    this.satellites.push(satellite);
    this.orbitalGroup.add(satellite.group);   // ← NOT this.group
  }

  getOrbitalPosition(simTime: number): THREE.Vector3 {
    // Semi-major axis in scene units
    let a: number;
    if (this.config.au !== undefined && this.config.au > 0) {
      a = this.config.au * SIMULATION_CONSTANTS.SCALE_UNITS_PER_AU;
    } else if (this.config.relativeAu !== undefined && this.config.relativeAu > 0) {
      a = this.config.relativeAu * SIMULATION_CONSTANTS.MOON_DISTANCE_SCALE;
    } else {
      a = SIMULATION_CONSTANTS.MOON_DEFAULT_RADIUS;
    }

    const e = this.config.eccentricity ?? 0;
    const T = this.config.period || 1;
    const n = (2 * Math.PI) / (T * SIMULATION_CONSTANTS.TIME_SCALE_SECONDS_PER_DAY);

    // Kepler: mean → eccentric anomaly (8-step Newton)
    const M = n * simTime;
    let E = M;
    for (let i = 0; i < 8; i++) {
      E = E - (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    }

    // True anomaly
    const nu = 2 * Math.atan2(
      Math.sqrt(1 + e) * Math.sin(E / 2),
      Math.sqrt(1 - e) * Math.cos(E / 2),
    );

    // Focal radius
    const r = a * (1 - e * e) / (1 + e * Math.cos(nu));

    // Ecliptic plane (XY), then apply inclination (rotation about X)
    const x = r * Math.cos(nu);
    const y = r * Math.sin(nu);

    const incRad = (this.config.inclination ?? 0) * Math.PI / 180;
    return new THREE.Vector3(
      x,
      y * Math.cos(incRad),
      y * Math.sin(incRad),
    );
  }

  revolve(simTime: number): void {
    this.orbitalGroup.position.copy(this.getOrbitalPosition(simTime));
  }
}

// ---------------------------------------------------------------------------
// Concrete leaf classes
// ---------------------------------------------------------------------------

/** A planet orbiting a star. */
export class Planet extends OrbitingBody { }

/** A moon orbiting a planet. Extended further in moon.model.ts. */
export class Moon extends OrbitingBody { }
