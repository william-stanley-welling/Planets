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

export const SIMULATION_CONSTANTS = {
  SCALE_UNITS_PER_AU: 1496,
  TIME_SCALE_SECONDS_PER_DAY: 86400 * 0.08,
  MOON_DISTANCE_SCALE: 0.002,
} as const;

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
    this.spin = config.spin || 0.01;
    this.quaternion = new THREE.Quaternion();
    this.group = new THREE.Group();
  }

  static validate(config: any): asserts config is PlanetConfig {
    if (!config?.name || typeof config.name !== 'string')
      throw new Error(`Celestial body name is required for ${config?.name || 'unknown'}`);

    if (typeof config.diameter !== 'number' || config.diameter <= 0)
      throw new Error(`Invalid diameter for ${config.name}`);

    const isStar = config.name.toLowerCase() === 'sun' || (!config.au && !config.relativeAu);
    if (!isStar) {
      if (typeof config.period !== 'number' || config.period <= 0)
        throw new Error(`Invalid period for ${config.name}: ${config.period}`);
    }

    if (config.au !== undefined && (typeof config.au !== 'number' || config.au < 0))
      throw new Error(`Invalid au for ${config.name}`);
  }

  setMesh(mesh: THREE.Mesh) { this.mesh = mesh; }
  setClouds(clouds: THREE.Mesh) { this.clouds = clouds; }
  setLights(lights: any[]) { this.lights = lights; }
  setSpin(spin: number) { this.spin = spin; }
  setHighlight(highlight: THREE.Mesh) { this.highlight = highlight; }

  addSatellite(satellite: CelestialBody): void {
    this.satellites.push(satellite);
    this.group.add(satellite.group);
  }

  rotate(): void {
    this.quaternion.setFromAxisAngle(this.axis, this.spin);
    this.mesh.quaternion.multiplyQuaternions(this.quaternion, this.mesh.quaternion);

    if (this.clouds) {
      this.quaternion.setFromAxisAngle(this.axis, this.spin + (Math.random() / 250));
      this.clouds.quaternion.multiplyQuaternions(this.quaternion, this.clouds.quaternion);
    }
  }

  updateHierarchy(simTime: number): void {
    this.rotate();

    if ('revolve' in this && typeof (this as any).revolve === 'function') {
      (this as any).revolve(simTime);
    }

    this.satellites.forEach(sat => sat.updateHierarchy(simTime));
  }
}

export interface Satellite {
  getOrbitalPosition(simTime: number): THREE.Vector3;
  revolve(simTime: number): void;
}

export abstract class OrbitingBody extends CelestialBody implements Satellite {
  orbitalGroup = new THREE.Group();   // This is the key group for position

  constructor(prop: PlanetConfig) {
    super(prop);
    this.group.add(this.orbitalGroup);
  }

  getOrbitalPosition(simTime: number): THREE.Vector3 {
    let a: number;

    if (this.config.au !== undefined && this.config.au > 0) {
      a = this.config.au * SIMULATION_CONSTANTS.SCALE_UNITS_PER_AU;
    } else if (this.config.relativeAu !== undefined && this.config.relativeAu > 0) {
      a = this.config.relativeAu * SIMULATION_CONSTANTS.MOON_DISTANCE_SCALE;
    } else {
      a = 50;
    }

    const e = this.config.eccentricity ?? 0;
    const T = this.config.period || 1;
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

    let x = r * Math.cos(nu);
    let y = r * Math.sin(nu);
    let z = 0;

    const incRad = (this.config.inclination ?? 0) * Math.PI / 180;
    const cosInc = Math.cos(incRad);
    const sinInc = Math.sin(incRad);
    const yRot = y * cosInc - z * sinInc;
    const zRot = y * sinInc + z * cosInc;

    return new THREE.Vector3(x, yRot, zRot);
  }

  revolve(simTime: number): void {
    const pos = this.getOrbitalPosition(simTime);
    this.orbitalGroup.position.copy(pos);
  }
}

export class Planet extends OrbitingBody { }

// Moon is defined in moon.model.ts — import from there.
// Star  is defined in star.model.ts — import from there.
export class Star extends CelestialBody { }
