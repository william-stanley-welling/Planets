import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Configuration interfaces
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
  M0?: number;          // mean anomaly at J2000 (radians)
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
  SCALE_UNITS_PER_AU: 1496,
  TIME_SCALE_SECONDS_PER_DAY: 86400 * 0.08,
  MOON_DISTANCE_SCALE: 0.002,
  MOON_DEFAULT_RADIUS: 50,
} as const;

// ---------------------------------------------------------------------------
// Abstract CelestialBody
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
  config: PlanetConfig;
  inclination = 0;

  constructor(config: PlanetConfig) {
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
// OrbitingBody (abstract)
// ---------------------------------------------------------------------------
export interface Satellite {
  setAngle(rad: number): void;
  getSemiMajorAxis(): number;
}

export abstract class OrbitingBody extends CelestialBody implements Satellite {
  orbitalGroup: THREE.Group;
  currentAngle = 0;  // true anomaly (radians)

  constructor(prop: PlanetConfig) {
    super(prop);
    this.orbitalGroup = new THREE.Group();
    this.orbitalGroup.name = `${prop.name}_orbitalGroup`;
    this.group.add(this.orbitalGroup);
  }

  addSatellite(satellite: CelestialBody): void {
    this.satellites.push(satellite);
    this.orbitalGroup.add(satellite.group);
  }

  getSemiMajorAxis(): number {
    if (this.config.au !== undefined && this.config.au > 0)
      return this.config.au * SIMULATION_CONSTANTS.SCALE_UNITS_PER_AU;
    if (this.config.relativeAu !== undefined && this.config.relativeAu > 0)
      return this.config.relativeAu * SIMULATION_CONSTANTS.MOON_DISTANCE_SCALE;
    return SIMULATION_CONSTANTS.MOON_DEFAULT_RADIUS;
  }

  setAngle(rad: number): void {
    this.currentAngle = rad % (2 * Math.PI);
    const a = this.getSemiMajorAxis();
    const e = this.config.eccentricity ?? 0;
    const nu = this.currentAngle;
    const r = a * (1 - e * e) / (1 + e * Math.cos(nu));
    const x = r * Math.cos(nu);
    const y = r * Math.sin(nu);
    const incRad = (this.config.inclination ?? 0) * Math.PI / 180;
    this.orbitalGroup.position.set(
      x,
      y * Math.cos(incRad),
      y * Math.sin(incRad)
    );
  }

  // Legacy revolve method (can be kept but not used with setAngle)
  revolve(simTime: number): void {
    // Not used when server pushes angles
  }
}
