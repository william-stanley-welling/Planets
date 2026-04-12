// ─── celestial.model.ts (UPDATED) ─────────────────────────────────────────────
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

/**
 * Global multiplier applied to all body diameters to make planets/moons
 * visible at realistic distances. Earth's diameter becomes ~10.2 units.
 */
export const VISUAL_SCALE = 8;

// ---------------------------------------------------------------------------
// Configuration interfaces
// ---------------------------------------------------------------------------
// (unchanged - kept exactly as original for brevity)
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
  x?: number;
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

// ---------------------------------------------------------------------------
// Simulation constants (unchanged)
// ---------------------------------------------------------------------------
export const SIMULATION_CONSTANTS = {
  SCALE_UNITS_PER_AU: 1496,
  TIME_SCALE_SECONDS_PER_DAY: 86400 * 0.08,
  MOON_VISUAL_SCALE: 30,
  MOON_DEFAULT_RADIUS: 50,
} as const;

// ---------------------------------------------------------------------------
// Abstract base: CelestialBody
// ---------------------------------------------------------------------------
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

  /** Debug line showing the exact rotation axis (for texture-alignment verification) */
  debugAxisLine?: THREE.Line;

  /** Group containing the axis line + two small spheres at the poles (dandelion style) */
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
    if (this.clouds) {
      this.clouds.rotateY(this.spin + Math.random() / 250);
    }
  }

  updateHierarchy(simTime: number): void {
    this.rotate();
    for (const sat of this.satellites) {
      sat.updateHierarchy(simTime);
    }
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

    // Dandelion spheres — now TRANSPARENT (visual only, no selection/collision)
    const sphereGeo = new THREE.SphereGeometry(0.8, 12, 12);
    const sphereMat = new THREE.MeshBasicMaterial({
      color: 0x88ffff,
      transparent: true,
      opacity: 0.0,           // ← TRANSPARENT as requested
      depthWrite: false
    });

    const northSphere = new THREE.Mesh(sphereGeo, sphereMat);
    northSphere.position.copy(this.axis.clone().multiplyScalar(size * 1.02));

    const southSphere = new THREE.Mesh(sphereGeo, sphereMat);
    southSphere.position.copy(this.axis.clone().multiplyScalar(-size * 1.02));

    this.debugAxisGroup = new THREE.Group();
    this.debugAxisGroup.add(line);
    this.debugAxisGroup.add(northSphere);
    this.debugAxisGroup.add(southSphere);
    this.debugAxisGroup.visible = false;

    parent.add(this.debugAxisGroup);
  }

  updateDebugAxisVisibility(visible: boolean): void {
    if (this.debugAxisGroup) this.debugAxisGroup.visible = visible;
  }
}

// ---------------------------------------------------------------------------
// Abstract base: OrbitingBody (unchanged)
// ---------------------------------------------------------------------------
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
    if (cfg.au !== undefined && cfg.au > 0) {
      return cfg.au * SIMULATION_CONSTANTS.SCALE_UNITS_PER_AU;
    }
    if (cfg.x !== undefined && cfg.x > 0) {
      return cfg.x * SIMULATION_CONSTANTS.MOON_VISUAL_SCALE;
    }
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

// TODO: when created send to server and store in universe.json meteor and update to star ring particale count and volatility on solar flare event and gamma slice event
export class Meteor extends CelestialBody {
  velocity = new THREE.Vector3();

  constructor(name: string, initialWorldPos: THREE.Vector3, initialVelocity: THREE.Vector3) {
    super({
      name,
      diameter: 3,
      mass: 1,
      color: '#aaaaaa',
    } as any);

    this.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(1.8, 8, 8),
      new THREE.MeshPhongMaterial({
        color: 0xaaaaaa,
        emissive: 0x442200,
        shininess: 2,
        flatShading: true,
      })
    );
    this.mesh.position.copy(initialWorldPos);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.name = name;

    this.group.add(this.mesh);
    this.velocity.copy(initialVelocity);

    this.addDebugAxisLine();
  }

  update(deltaSec: number): void {
    this.mesh.position.addScaledVector(this.velocity, deltaSec * 60);
    this.velocity.multiplyScalar(0.998);
    const toSun = this.mesh.position.clone().negate().normalize();
    this.velocity.addScaledVector(toSun, 8 * deltaSec);
  }

}

