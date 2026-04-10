import * as THREE from 'three';
import { Star } from '../galaxy/star.model';
import { CelestialBody } from '../galaxy/celestial.model';

/**
 * Core rendering engine for the heliocentric simulation.
 * Defines the public contract for the WebGL service.
 */
export interface ICelestialRenderer {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly star: Star | null;
  readonly selectable: THREE.Object3D[];
  readonly active: boolean;
  simulationTime: number;

  init(height: number, width: number): void;
  start(): void;
  resize(height: number, width: number): void;
  getCameraInfo(): CameraInfo;
  getSystemSnapshot(): SystemSnapshot;

  // Navigation & views
  setCameraView(view: CameraView, durationMs?: number): void;
  navigateToPlanet(planetName: string, durationMs?: number): void;
  moveCameraTo(toPos: THREE.Vector3, lookAt?: THREE.Vector3, toUp?: THREE.Vector3, durationMs?: number): void;

  // Orbit line toggles
  togglePlanetOrbits(visible: boolean): void;
  toggleMoonOrbits(visible: boolean): void;
  toggleMoonsOfPlanet(planetName: string, visible: boolean): void;

  // Input
  keyDown(event: KeyboardEvent): void;
}

export interface CameraInfo {
  position: THREE.Vector3;
  direction: THREE.Vector3;
  velocity: number;
}

export interface SystemSnapshot {
  bodies: BodySnapshot[];
  camera: { x: number; y: number; z: number };
}

export interface BodySnapshot {
  name: string;
  x: number;
  y: number;
  color: string;
  au: number;
  isStar: boolean;
}

export enum CameraView {
  OVERVIEW = 'overview',
  ECLIPTIC = 'ecliptic',
  CINEMATIC = 'cinematic',
}
