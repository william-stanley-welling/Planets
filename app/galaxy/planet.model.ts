import * as THREE from 'three';

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
  au: number;
  period: number;
  eccentricity?: number;
  inclination?: number;
  x: number;
  y: number;
  z: number;

  /**
   * Formula used to compute or determine next orbital coordinates of each planet/moon (relative to parent).
   *
   * Keplerian elliptical orbit (full position at simulation time `simTime`):
   *
   * \[
   * a = \text{au} \times \text{SCALE_UNITS_PER_AU}
   * \]
   * \[
   * n = \frac{2\pi}{T \times \text{TIME_SCALE_SECONDS_PER_DAY}}, \quad M = n \times \text{simTime}
   * \]
   *
   * Solve Kepler's equation iteratively for eccentric anomaly \(E\):
   * \[
   * E \leftarrow E - \frac{E - e \sin E - M}{1 - e \cos E} \quad (8 \text{ iterations})
   * \]
   *
   * True anomaly \(\nu\):
   * \[
   * \nu = 2 \arctan2\left( \sqrt{1+e} \sin\frac{E}{2}, \sqrt{1-e} \cos\frac{E}{2} \right)
   * \]
   *
   * Radial distance:
   * \[
   * r = \frac{a(1 - e^2)}{1 + e \cos \nu}
   * \]
   *
   * Cartesian coordinates (equatorial plane, relative to parent body):
   * \[
   * x = r \cos \nu, \quad y = r \sin \nu, \quad z = 0
   * \]
   *
   * (Inclination support is stubbed for future plane rotation. Works identically for planets around the Sun and moons around planets.)
   *
   * Responsible for discovery: Johannes Kepler (laws of planetary motion, 1609–1619).
   */
}

export interface RotationalConfig {
  tilt?: number;
  spin?: number;

  /**
   * Formula used to compute or determine next rotational characteristics (spin).
   *
   * Simple axis-angle rotation applied each frame:
   *
   * \[
   * \Delta q = \text{Quaternion from axis-angle}(\text{axis}, \text{spin} \times \Delta t)
   * \]
   * \[
   * \text{mesh.quaternion} \leftarrow \Delta q \times \text{mesh.quaternion}
   * \]
   *
   * (Cloud layer uses slightly randomized spin for realism.)
   *
   * No single discoverer – derived from basic rigid-body dynamics (Euler's rotation equations).
   */
}

export interface PlanetConfig extends VisualConfig, PhysicalConfig, OrbitalConfig, RotationalConfig { }

export const SIMULATION_CONSTANTS = {
  SCALE_UNITS_PER_AU: 1496,
  TIME_SCALE_SECONDS_PER_DAY: 86400 * 0.05,
} as const;

/**
 * Base class for all celestial bodies (Sun, planets, moons).
 * Provides shared visual, physical, rotational, and group hierarchy support.
 */
export abstract class CelestialBody {
  name: string;
  mass!: number;
  axis: THREE.Vector3;
  spin = 0.25 * Math.PI / 180;

  mesh!: THREE.Mesh;
  clouds?: THREE.Mesh;
  atmosphere?: THREE.Mesh;

  satellites: CelestialBody[] = [];
  lights: any[] = [];

  highlight!: THREE.Mesh;
  quaternion: THREE.Quaternion;

  velocity!: THREE.Vector3;
  position!: THREE.Vector3;
  nextPosition!: THREE.Vector3;
  spotLight!: THREE.SpotLight;

  group: THREE.Group;

  config: PlanetConfig;

  constructor(config: PlanetConfig) {
    CelestialBody.validate(config);

    this.config = config;
    this.name = config.name;

    const tiltRad = (config.tilt || 0) * Math.PI / 180;
    this.axis = new THREE.Vector3(Math.cos(tiltRad), Math.sin(tiltRad), 0).normalize();
    this.spin = config.spin || 0.01;
    this.quaternion = new THREE.Quaternion();
    this.group = new THREE.Group();
  }

  static validate(config: any): asserts config is PlanetConfig {
    if (!config?.name || typeof config.name !== 'string') throw new Error('Celestial body name is required');
    if (typeof config.diameter !== 'number' || config.diameter <= 0) throw new Error('Invalid diameter');
    if (typeof config.au !== 'number' || config.au < 0) throw new Error('Invalid au');
    if (typeof config.period !== 'number') throw new Error('Invalid period');
  }

  setMesh(mesh: THREE.Mesh) { this.mesh = mesh; }
  setClouds(clouds: THREE.Mesh) { this.clouds = clouds; }
  setLights(lights: any[]) { this.lights = lights; }
  setSpin(spin: number) { this.spin = spin; }
  setHighlight(highlight: THREE.Mesh) { this.highlight = highlight; }

  /**
   * Add a satellite (planet or moon) to this body.
   * Uses THREE.Group hierarchy so the satellite's local position is relative to the parent.
   */
  addSatellite(satellite: CelestialBody): void {
    this.satellites.push(satellite);
    this.group.add(satellite.group);
  }

  /**
   * Apply self-rotation (spin) to mesh and optional cloud layer.
   * Called every frame for all bodies.
   */
  rotate(): void {
    this.quaternion.setFromAxisAngle(this.axis, this.spin);
    this.mesh.quaternion.multiplyQuaternions(this.quaternion, this.mesh.quaternion);

    if (this.clouds) {
      this.quaternion.setFromAxisAngle(this.axis, this.spin + (Math.random() / 250));
      this.clouds.quaternion.multiplyQuaternions(this.quaternion, this.clouds.quaternion);
    }
  }

  /**
   * Recursively update rotation + orbit for this body and all descendants.
   * Enables full heliocentric hierarchy (Sun → planets → moons).
   */
  updateHierarchy(simTime: number): void {
    this.rotate();

    // Orbiting bodies (Planets and Moons) implement revolve via the Satellite interface
    if ('revolve' in this && typeof (this as any).revolve === 'function') {
      (this as any).revolve(simTime);
    }

    this.satellites.forEach(sat => sat.updateHierarchy(simTime));
  }
}

/**
 * Interface for any body that orbits a parent (planets around Sun, moons around planets).
 */
export interface Satellite {
  getOrbitalPosition(simTime: number): THREE.Vector3;
  revolve(simTime: number): void;
}

/**
 * Orbiting bodies share the same Keplerian orbital logic.
 * Uses THREE.Group child positioning for clean heliocentric + moon orbits.
 */
export abstract class OrbitingBody extends CelestialBody implements Satellite {
  constructor(prop: PlanetConfig) {
    super(prop);
  }

  /**
   * Formula used to compute or determine next orbital coordinates (relative to parent).
   * See full Keplerian formulas in OrbitalConfig JSDoc above.
   */
  getOrbitalPosition(simTime: number): THREE.Vector3 {
    const a = this.config.au * SIMULATION_CONSTANTS.SCALE_UNITS_PER_AU;
    const e = this.config.eccentricity ?? 0;
    const T = this.config.period; // days
    const n = (2 * Math.PI) / (T * SIMULATION_CONSTANTS.TIME_SCALE_SECONDS_PER_DAY);

    let M = n * simTime;

    let E = M;
    for (let i = 0; i < 8; i++) {
      E = E - (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    }

    const nu = 2 * Math.atan2(
      Math.sqrt(1 + e) * Math.sin(E / 2),
      Math.sqrt(1 - e) * Math.cos(E / 2)
    );

    const r = a * (1 - e * e) / (1 + e * Math.cos(nu));

    const x = r * Math.cos(nu);
    const y = r * Math.sin(nu);
    const z = 0;

    return new THREE.Vector3(x, y, z);
  }

  /**
   * Formula used to compute or determine initial velocity (Vis-viva).
   *
   * \[
   * v = \sqrt{\mu \left( \frac{2}{r} - \frac{1}{a} \right)}
   * \]
   *
   * Responsible for discovery: Isaac Newton (1687).
   */
  getInitialVelocity(): THREE.Vector3 {
    const r = this.group.position.length();
    const a = this.config.au * SIMULATION_CONSTANTS.SCALE_UNITS_PER_AU;
    const e = this.config.eccentricity ?? 0;
    const mu = (4 * Math.PI * Math.PI * Math.pow(a, 3)) / Math.pow(this.config.period, 2);

    const v = Math.sqrt(mu * (2 / r - 1 / a));

    const dir = new THREE.Vector3(-this.group.position.z, 0, this.group.position.x).normalize();

    return dir.multiplyScalar(v);
  }

  /**
   * Revolve this body around its parent using Keplerian orbit.
   * Position is set in local space of the parent's THREE.Group (heliocentric hierarchy).
   */
  revolve(simTime: number): void {
    const pos = this.getOrbitalPosition(simTime);
    this.group.position.copy(pos);
  }
}

/**
 * Planet orbiting the Sun (implements Satellite via OrbitingBody).
 */
export class Planet extends OrbitingBody {
  constructor(prop: PlanetConfig) {
    super(prop);
  }
}

/**
 * Moon orbiting a planet (implements Satellite via OrbitingBody).
 * Same abstraction and Keplerian formulas as planets — fully reusable for any parent.
 */
export class Moon extends OrbitingBody {
  constructor(prop: PlanetConfig) {
    super(prop);
  }
}
