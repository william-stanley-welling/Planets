import * as THREE from 'three';
import { StarStage } from './star.model';

export interface MagneticFieldConfig {
  strength: number;
  radius: number;
  tilt?: number;
  polarity?: number;
}

export class MagneticField {
  magneticConfig: MagneticFieldConfig;
  bodyRadius: number;

  constructor(config: MagneticFieldConfig, bodyRadius: number) {
    this.magneticConfig = config;
    this.bodyRadius = bodyRadius;
  }

  getFieldRadius(): number {
    return this.bodyRadius * (this.magneticConfig.radius || 5);
  }
}

export interface CelestialConfig {
  type: 'star' | 'planet' | 'moon' | 'comet';
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
  magneticField?: MagneticFieldConfig;
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
  comets?: CometConfig[];
}

export interface CometConfig extends CelestialConfig, OrbitalConfig, RotationalConfig {
  tailLength?: number;
  tailColor?: string;
  comaSize?: number;
  dustTail?: boolean;
  ionTail?: boolean;
}

export const SIMULATION_CONSTANTS = {
  VISUAL_SCALE: 4,
  SCALE_UNITS_PER_AU: 1496,
  TIME_SCALE_SECONDS_PER_DAY: 86400 * 0.08,
  MOON_VISUAL_SCALE: 30,
  MOON_DEFAULT_RADIUS: 50,
  MOON_MIN_VISUAL_RADIUS: 1.5,
  EPOCH_DATE: new Date('2000-01-01T12:00:00Z').getTime(),
} as const;

export interface Satellite {
  setAngle(rad: number): void;
  getSemiMajorAxis(): number;
}

export interface AngularMomentum {
  // inherit axis rotational speed that slows at an outward gradient
}

export abstract class CelestialBody implements AngularMomentum {
  type: 'star' | 'planet' | 'moon' | 'comet' = 'planet';
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

  latLongGroup?: THREE.Group;

  magneticField?: MagneticField;
  magneticFieldArrows?: THREE.InstancedMesh;
  magneticFieldSphere?: THREE.Mesh;

  constructor(config: CelestialConfig) {
    this.config = config;
    this.name = config.name;
    this.type = config.type;
    const tiltRad = (((config as any).tilt ?? 0) * Math.PI) / 180;
    this.axis = new THREE.Vector3(Math.cos(tiltRad), Math.sin(tiltRad), 0).normalize();
    this.spin = (config as any).spin ?? 0.01;
    this.group = new THREE.Group();
    this.group.name = `${config.name}_group`;

    const visualRadius = (this.config.diameter / 2) * SIMULATION_CONSTANTS.VISUAL_SCALE;
    this.magneticField = new MagneticField(this.config.magneticField, visualRadius);
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
    for (const sat of this.satellites) {
      sat.updateHierarchy(simTime);
    }
  }

  applyInitialTilt(): void {
    if (!this.mesh) return;
    const fromX = new THREE.Vector3(1, 0, 0);
    const tiltQuat = new THREE.Quaternion().setFromUnitVectors(fromX, this.axis);
    this.mesh.quaternion.copy(tiltQuat);
  }
}

export abstract class OrbitingBody extends CelestialBody implements Satellite {
  orbitalGroup: THREE.Group;
  currentAngle = 0;

  constructor(config: PlanetConfig) {
    super(config);
    this.config = config;
    this.orbitalGroup = new THREE.Group();
    this.orbitalGroup.name = `${config.name}_orbitalGroup`;
    this.group.add(this.orbitalGroup);
  }

  addSatellite(satellite: CelestialBody): void {
    this.satellites.push(satellite);
    this.orbitalGroup.add(satellite.group);
  }

  getSemiMajorAxis(): number {
    const cfg = this.config as any;
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
    const cfg = this.config as any;
    this.currentAngle = rad % (2 * Math.PI);
    const a = this.getSemiMajorAxis();
    const e = cfg.eccentricity ?? 0;
    const nu = this.currentAngle;
    const r = a * (1 - e * e) / (1 + e * Math.cos(nu));
    const incRad = (cfg.inclination ?? 0) * Math.PI / 180;
    const x = r * Math.cos(nu);
    const z0 = r * Math.sin(nu);
    const y = -z0 * Math.sin(incRad);
    const z = z0 * Math.cos(incRad);

    this.orbitalGroup.position.set(x, y, z);
  }

  revolve(_simTime: number): void { }
}
