import * as THREE from 'three';
import { StarStage } from './star.model';

export const VISUAL_SCALE = 8;

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

  computeFieldAt(point: THREE.Vector3): THREE.Vector3 {
    const r = point.length();
    if (r < 0.001) return new THREE.Vector3();
    const rHat = point.clone().normalize();
    const m = new THREE.Vector3(0, 1, 0); // aligned with Y
    const mDotR = m.dot(rHat);
    const strength = this.magneticConfig.strength;
    // B = (μ0/(4π)) * (3(m·r̂)r̂ - m) / r³
    const scale = strength / (r * r * r + 0.1);
    return rHat.clone().multiplyScalar(3 * mDotR).sub(m).multiplyScalar(scale);
  }
}

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
}

export interface CometConfig extends CelestialConfig, OrbitalConfig, RotationalConfig {
  tailLength?: number;
  tailColor?: string;
  comaSize?: number;
  dustTail?: boolean;
  ionTail?: boolean;
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

  magneticField?: MagneticField;
  magneticFieldArrows?: THREE.InstancedMesh;
  magneticFieldSphere?: THREE.Mesh;

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

    const visualRadius = (this.config.diameter / 2) * VISUAL_SCALE;
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

  createMagneticFieldVisualization(): void {
    if (!this.magneticField) return;

    const fieldRadius = this.magneticField.getFieldRadius();
    const geometry = new THREE.SphereGeometry(fieldRadius, 64, 32);

    // Shader uniforms
    const uniforms = {
      time: { value: 0 },
      color: { value: new THREE.Color(0x44aaff) },
      strength: { value: this.magneticField.magneticConfig.strength },
      bodyRadius: { value: this.magneticField.bodyRadius },
      fieldRadius: { value: fieldRadius },
    };

    const vertexShader = `
      varying vec3 vWorldPosition;
      varying vec3 vLocalPosition;
      varying vec3 vNormal;
      void main() {
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPosition.xyz;
        vLocalPosition = position;
        vNormal = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `;

    const fragmentShader = `
      precision highp float;
      varying vec3 vWorldPosition;
      varying vec3 vLocalPosition;
      varying vec3 vNormal;
      uniform float time;
      uniform vec3 color;
      uniform float strength;
      uniform float bodyRadius;
      uniform float fieldRadius;

      // Dipole field direction at point p (local space, Y axis dipole)
      vec3 dipoleField(vec3 p) {
        float r = length(p);
        if (r < 0.001) return vec3(0.0);
        vec3 rHat = normalize(p);
        vec3 m = vec3(0.0, 1.0, 0.0);
        float mDotR = dot(m, rHat);
        return (3.0 * mDotR * rHat - m) / (r * r * r);
      }

      void main() {
        // Get field direction at this point on the sphere
        vec3 fieldDir = dipoleField(vLocalPosition);
        float fieldStrength = length(fieldDir);

        // Use field direction to create line patterns
        // Convert direction to spherical angles
        float theta = atan(fieldDir.z, fieldDir.x);
        float phi = acos(clamp(fieldDir.y, -1.0, 1.0));

        // Create animated stripes along field lines
        float speed = 0.5;
        float pattern1 = sin(theta * 8.0 + time * speed) * cos(phi * 12.0);
        float pattern2 = cos(theta * 15.0 - time * 0.8) * sin(phi * 10.0 + time);
        float lines = abs(pattern1 * pattern2);

        // Enhance lines based on field strength
        lines = pow(lines, 1.5) * (0.5 + 0.5 * fieldStrength);

        // Base transparency: fade near poles where field is radial
        float alpha = lines * 0.8;
        alpha *= smoothstep(0.0, 0.3, abs(vLocalPosition.y) / fieldRadius); // less at poles

        // Color variation with field strength
        vec3 finalColor = mix(color, vec3(0.8, 1.0, 1.0), fieldStrength * 0.5);

        gl_FragColor = vec4(finalColor, alpha);
      }
    `;

    const material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader,
      fragmentShader,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    const sphere = new THREE.Mesh(geometry, material);
    sphere.name = `${this.name}_magneticField`;
    sphere.visible = false;

    this.magneticFieldSphere = sphere;
    this.group.add(sphere);
  }

  updateMagneticFieldVisualization(): void {
    if (!this.magneticFieldArrows || !this.magneticField) return;
    // Update arrow directions/orientations based on current field (if time-varying)
    // For static dipole, no update needed.
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

