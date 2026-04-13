// ─── celestial.model.ts (UPDATED) ─────────────────────────────────────────────
/**
 * @fileoverview Core data models and abstract base classes for all celestial bodies.
 *
 * @module celestial.model
 */

import * as THREE from 'three';
import { StarStage } from './star.model';

export const VISUAL_SCALE = 8;

// ---------------------------------------------------------------------------
// Configuration interfaces (unchanged)
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
// Simulation constants
// ---------------------------------------------------------------------------
export const SIMULATION_CONSTANTS = {
  SCALE_UNITS_PER_AU: 1496,
  TIME_SCALE_SECONDS_PER_DAY: 86400 * 0.08,
  MOON_VISUAL_SCALE: 30,
  MOON_DEFAULT_RADIUS: 50,
} as const;

// ---------------------------------------------------------------------------
// Abstract base: CelestialBody (unchanged from original)
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
    if (cfg.au !== undefined && cfg.au > 0) return cfg.au * SIMULATION_CONSTANTS.SCALE_UNITS_PER_AU;
    if (cfg.x !== undefined && cfg.x > 0) return cfg.x * SIMULATION_CONSTANTS.MOON_VISUAL_SCALE;
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

// ---------------------------------------------------------------------------
// Meteor — server-authoritative moving body
// ---------------------------------------------------------------------------

/**
 * A solar-flare-ejected meteor.
 *
 * Position in world space is driven by the server via WebSocket `orbitUpdate`
 * messages.  The client mirrors the mesh position from the received snapshot.
 * Local `velocity` is kept for cosmetic spin/tumble only (not used for translation
 * — the server is the authoritative physics integrator).
 *
 * Construction accepts an optional `initialWorldPos` / `initialVelocity` for
 * the first frame before the first server position sync arrives.
 *
 * Spectroscopy mode draws a permanent line from the Sun (0,0,0) to this mesh's
 * world position each frame, as required by the design spec.
 */
export class Meteor extends CelestialBody {
  /** Last known velocity (from server snapshot; used for visual spin only). */
  velocity = new THREE.Vector3();

  /**
   * Whether this meteor has been confirmed impacted by the server.
   * When true the mesh is hidden and the instance should be removed.
   */
  impacted = false;

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
      }),
    );
    this.mesh.position.copy(initialWorldPos);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.name = name;

    // A selection-highlight halo so meteors are selectable like planets
    this.highlight = new THREE.Mesh(
      new THREE.SphereGeometry(3.2, 12, 12),
      new THREE.MeshBasicMaterial({
        color: 0xff6622,
        transparent: true,
        opacity: 0.60,
        side: THREE.BackSide,
        depthWrite: false,
      }),
    );
    this.highlight.visible = false;
    this.highlight.name = `${name}_highlight`;

    this.group.add(this.mesh);
    this.group.add(this.highlight);
    this.velocity.copy(initialVelocity);

    this.addDebugAxisLine();
  }

  /**
   * Sync this meteor's world position from a server snapshot.
   * Called each `orbitUpdate` tick.
   */
  syncFromServer(x: number, y: number, z: number, vx: number, vy: number, vz: number): void {
    this.mesh.position.set(x, y, z);
    this.velocity.set(vx, vy, vz);
  }

  /**
   * Visual-only update: tumble the mesh for debris realism.
   * Does NOT integrate position — that is server-authoritative.
   * @param deltaSec - Real seconds since last frame.
   */
  tumble(deltaSec: number): void {
    this.mesh.rotateY(0.022 * deltaSec * 60);
    this.mesh.rotateZ(0.013 * deltaSec * 60);
  }
}
