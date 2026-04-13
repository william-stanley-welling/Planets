import * as THREE from 'three';
import { StarStage } from './star.model';

export const VISUAL_SCALE = 8;

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
  pow?: number;
}

export interface OrbitalConfig {
  au?: number;
  relativeAu?: number;
  period: number;
  eccentricity?: number;
  inclination?: number;
  M0?: number;
}

export interface RotationalConfig {
  tilt?: number;
  spin?: number;
}

export interface RingConfig {
  name?: string;
  inner?: number;
  outer?: number;
  thickness?: number;
  color?: string;
  texture?: string;
  particleCount?: number;
  period?: number;
  noiseScale?: number;
  particleSize?: number;
  keplerianRotation?: boolean;
  rotationSpeed?: number;
  volatility?: number;
}

export interface PlanetConfig extends CelestialConfig, OrbitalConfig, RotationalConfig {
  resource?: string;
  rings?: RingConfig[];
}

export interface MoonConfig extends CelestialConfig, OrbitalConfig, RotationalConfig {
  resource?: string;
  semiMajorAxis?: number;
}

export interface AdditionalStarProperties {
  composition?: string;
  heat?: number;
  energy?: number;
  radiance?: number;
}

export interface StarConfig extends CelestialConfig, AdditionalStarProperties {
  stage: StarStage;
  tilt?: number;
  spin?: number;
  rings?: RingConfig[];
}

export const SIMULATION_CONSTANTS = {
  SCALE_UNITS_PER_AU: 1496,
  TIME_SCALE_SECONDS_PER_DAY: 86400 * 0.08,
  MOON_VISUAL_SCALE: 30,
  MOON_DEFAULT_RADIUS: 50,
  MOON_MIN_VISUAL_RADIUS: 1.5,
} as const;

export interface Satellite {
  setAngle(rad: number): void;
  getSemiMajorAxis(): number;
}

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
  group: THREE.Group;
  config: CelestialConfig;
  inclination = 0;

  debugAxisLine?: THREE.Line;
  debugAxisGroup?: THREE.Group;

  constructor(config: CelestialConfig) {
    this.config = config;
    this.name = config.name;
    const tiltRad = (((config as any).tilt ?? 0) * Math.PI) / 180;
    this.axis = new THREE.Vector3(Math.cos(tiltRad), Math.sin(tiltRad), 0).normalize();
    this.spin = (config as any).spin ?? 0.01;
    this.group = new THREE.Group();
    this.group.name = `${config.name}_group`;
  }

  static validate(config: any): asserts config is CelestialConfig {
    if (!config?.name || typeof config.name !== 'string') {
      throw new Error(`CelestialBody: name required (got ${JSON.stringify(config?.name)})`);
    }
    if (typeof config.diameter !== 'number' || config.diameter <= 0) {
      throw new Error(`CelestialBody "${config.name}": invalid diameter ${config.diameter}`);
    }
  }

  addSatellite(satellite: CelestialBody): void {
    this.satellites.push(satellite);
    this.group.add(satellite.group);
  }

  rotate(): void {
    this.mesh.rotateY(this.spin);
    if (this.clouds) this.clouds.rotateY(this.spin + Math.random() / 250);
  }

  updateHierarchy(simTime: number): void {
    this.rotate();
    for (const sat of this.satellites) sat.updateHierarchy(simTime);
  }

  applyInitialTilt(): void {
    if (!this.mesh) return;
    const fromY = new THREE.Vector3(0, 1, 0);
    const tiltQuat = new THREE.Quaternion().setFromUnitVectors(fromY, this.axis);
    this.mesh.quaternion.copy(tiltQuat);
  }

  addDebugAxisLine(): void {
    if (this.debugAxisGroup || !this.mesh) return;
    const parent = (this as any).orbitalGroup ?? this.group;
    const size = (this.config.diameter || 2) * VISUAL_SCALE * 2.8;
    const points = [this.axis.clone().multiplyScalar(-size), this.axis.clone().multiplyScalar(size)];
    const lineGeo = new THREE.BufferGeometry().setFromPoints(points);
    const lineMat = new THREE.LineBasicMaterial({ color: 0x88ffff, transparent: true, opacity: 0.9, linewidth: 3 });
    const line = new THREE.Line(lineGeo, lineMat);

    const sphereGeo = new THREE.SphereGeometry(0.8, 12, 12);
    const sphereMat = new THREE.MeshBasicMaterial({ color: 0x88ffff, transparent: true, opacity: 0.0, depthWrite: false });
    const northSphere = new THREE.Mesh(sphereGeo, sphereMat);
    northSphere.position.copy(this.axis.clone().multiplyScalar(size * 1.02));
    const southSphere = new THREE.Mesh(sphereGeo, sphereMat);
    southSphere.position.copy(this.axis.clone().multiplyScalar(-size * 1.02));

    this.debugAxisGroup = new THREE.Group();
    this.debugAxisGroup.add(line, northSphere, southSphere);
    this.debugAxisGroup.visible = false;
    parent.add(this.debugAxisGroup);
  }

  updateDebugAxisVisibility(visible: boolean): void {
    if (this.debugAxisGroup) this.debugAxisGroup.visible = visible;
  }
}

export abstract class OrbitingBody extends CelestialBody implements Satellite {
  orbitalGroup: THREE.Group;
  currentAngle = 0;
  orbitingConfig: PlanetConfig | MoonConfig;

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
    const cfg = this.orbitingConfig as any;
    if (cfg.au !== undefined && cfg.au > 0) return cfg.au * SIMULATION_CONSTANTS.SCALE_UNITS_PER_AU;
    const axisValue = (cfg.semiMajorAxis !== undefined && cfg.semiMajorAxis > 0)
      ? cfg.semiMajorAxis
      : undefined;
    if (axisValue !== undefined) return axisValue * SIMULATION_CONSTANTS.MOON_VISUAL_SCALE;
    if (cfg.relativeAu !== undefined && cfg.relativeAu > 0) {
      return cfg.relativeAu * SIMULATION_CONSTANTS.MOON_VISUAL_SCALE * SIMULATION_CONSTANTS.SCALE_UNITS_PER_AU;
    }
    return SIMULATION_CONSTANTS.MOON_DEFAULT_RADIUS;
  }

  setAngle(rad: number): void {
    this.currentAngle = rad % (2 * Math.PI);
    const a = this.getSemiMajorAxis();
    const e = this.orbitingConfig.eccentricity ?? 0;
    const nu = this.currentAngle;
    const r = a * (1 - e * e) / (1 + e * Math.cos(nu));
    const incRad = (this.orbitingConfig.inclination ?? 0) * Math.PI / 180;
    const x = r * Math.cos(nu);
    const z0 = r * Math.sin(nu);
    const y = -z0 * Math.sin(incRad);
    const z = z0 * Math.cos(incRad);
    this.orbitalGroup.position.set(x, y, z);
  }

  revolve(_simTime: number): void { }
}

