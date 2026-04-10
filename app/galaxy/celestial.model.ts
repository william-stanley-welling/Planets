import * as THREE from 'three';
import { StarStage } from './star.model';

// ---------------------------------------------------------------------------
// Base configuration for any celestial body
// ---------------------------------------------------------------------------
export interface CelestialConfig {
  name: string;
  diameter: number;
  mass: number;
  color?: string;
  map?: string;
  bumpMap?: string;
  specMap?: string;
  cloudMap?: string;
  alphaMap?: string;
  widthSegments?: number;
  heightSegments?: number;
  atmosphere?: number;
  pow?: number;          // exponent for mass (mass * 10^pow)
}

// ---------------------------------------------------------------------------
// Extensions for orbiting bodies (planets, moons)
// ---------------------------------------------------------------------------
export interface OrbitalConfig {
  au?: number;           // astronomical units (heliocentric)
  relativeAu?: number;   // for moons (relative to parent)
  period: number;        // orbital period in days
  eccentricity?: number;
  inclination?: number;
  M0?: number;           // mean anomaly at J2000 (radians)
}

export interface RotationalConfig {
  tilt?: number;         // axial tilt (degrees)
  spin?: number;         // rotation speed (radians per frame approx)
}

export interface PlanetConfig extends CelestialConfig, OrbitalConfig, RotationalConfig {
  resource?: string;     // server path to individual JSON
}

export interface MoonConfig extends CelestialConfig, OrbitalConfig, RotationalConfig {
  resource?: string;     // server path to individual JSON
}

// ---------------------------------------------------------------------------
// Star-specific configuration
// ---------------------------------------------------------------------------
export interface AdditionalStarProperties {
  composition?: string;  // e.g., "74% hydrogen, 24% helium"
  heat?: number;         // surface temperature (Kelvin)
  energy?: number;       // luminosity (solar luminosities L☉)
  radiance?: number;     // radiant energy output / flux
}

export interface StarConfig extends CelestialConfig, AdditionalStarProperties {
  stage: StarStage;      // from star.model.ts (cyclic dependency avoided by placing enum here or importing)
  // Stars have no orbital period relative to parent, but may have spin/tilt
  tilt?: number;
  spin?: number;
}

// ---------------------------------------------------------------------------
// Simulation constants (unchanged)
// ---------------------------------------------------------------------------
export const SIMULATION_CONSTANTS = {
  SCALE_UNITS_PER_AU: 1496,
  TIME_SCALE_SECONDS_PER_DAY: 86400 * 0.08,
  MOON_DISTANCE_SCALE: 0.002,
  MOON_DEFAULT_RADIUS: 50,
} as const;

// ---------------------------------------------------------------------------
// Abstract CelestialBody (unchanged, but uses CelestialConfig where appropriate)
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
  group: THREE.Group;
  config: CelestialConfig;   // base config (can be cast to more specific in subclasses)
  inclination = 0;

  constructor(config: CelestialConfig) {
    this.config = config;
    this.name = config.name;
    // inclination is not part of base, will be set by subclasses if needed
    const tiltRad = ((config as any).tilt || 0) * Math.PI / 180;
    this.axis = new THREE.Vector3(Math.cos(tiltRad), Math.sin(tiltRad), 0).normalize();
    this.spin = (config as any).spin ?? 0.01;
    this.quaternion = new THREE.Quaternion();
    this.group = new THREE.Group();
    this.group.name = `${config.name}_group`;
  }

  static validate(config: any): asserts config is CelestialConfig {
    if (!config?.name || typeof config.name !== 'string')
      throw new Error(`CelestialBody: name required (got ${JSON.stringify(config?.name)})`);
    if (typeof config.diameter !== 'number' || config.diameter <= 0)
      throw new Error(`CelestialBody "${config.name}": invalid diameter ${config.diameter}`);
    // Additional validation for orbital bodies is done in subclasses
  }

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
// OrbitingBody (abstract) – uses PlanetConfig (which includes orbital props)
// ---------------------------------------------------------------------------
export interface Satellite {
  setAngle(rad: number): void;
  getSemiMajorAxis(): number;
}

export abstract class OrbitingBody extends CelestialBody implements Satellite {
  orbitalGroup: THREE.Group;
  currentAngle = 0;
  orbitingConfig: PlanetConfig | MoonConfig;   // override to be more specific

  constructor(config: PlanetConfig) {
    super(config);
    this.config = config;
    this.orbitingConfig = config;
    this.orbitalGroup = new THREE.Group();
    this.orbitalGroup.name = `${config.name}_orbitalGroup`;
    this.group.add(this.orbitalGroup);
  }

  addSatellite(satellite: CelestialBody): void {
    this.satellites.push(satellite);
    this.orbitalGroup.add(satellite.group);
  }

  getSemiMajorAxis(): number {
    if (this.orbitingConfig.au !== undefined && this.orbitingConfig.au > 0)
      return this.orbitingConfig.au * SIMULATION_CONSTANTS.SCALE_UNITS_PER_AU;
    if (this.orbitingConfig.relativeAu !== undefined && this.orbitingConfig.relativeAu > 0)
      return this.orbitingConfig.relativeAu * SIMULATION_CONSTANTS.MOON_DISTANCE_SCALE;
    return SIMULATION_CONSTANTS.MOON_DEFAULT_RADIUS;
  }

  setAngle(rad: number): void {
    this.currentAngle = rad % (2 * Math.PI);
    const a = this.getSemiMajorAxis();
    const e = this.orbitingConfig.eccentricity ?? 0;
    const nu = this.currentAngle;
    const r = a * (1 - e * e) / (1 + e * Math.cos(nu));
    const x = r * Math.cos(nu);
    const y = r * Math.sin(nu);
    const incRad = (this.orbitingConfig.inclination ?? 0) * Math.PI / 180;
    this.orbitalGroup.position.set(
      x,
      y * Math.cos(incRad),
      y * Math.sin(incRad)
    );
  }

  revolve(simTime: number): void { /* not used when server pushes angles */ }
}