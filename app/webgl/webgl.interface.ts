import * as THREE from 'three';
import { Star } from '../galaxy/star.model';

export enum NavigationMode {
  DISCOVERY = 'discovery',
  CINEMATIC = 'cinematic',
  FASTEST_TRAVEL = 'fastest_travel',
  PLANNING = 'planning',
  TRAVEL = 'travel',
  TETHERED = 'tethered',
}

export interface NavigationWaypoint {
  type: 'body' | 'coordinate';
  bodyName?: string;
  position?: THREE.Vector3;
  label?: string;
  durationSec: number;
}

export interface NavigationRoute {
  waypoints: NavigationWaypoint[];
  loop: boolean;
  active: boolean;
  currentIndex: number;
  progress: number;
  orbitRemaining: number;
}

export type Waypoint = {
  type: 'body' | 'coordinate';
  bodyName?: string;
  position?: THREE.Vector3;
  orbitDuration?: number;
};

export type RingRenderMode = 'washer' | 'particles';

export interface ICelestialRenderer {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly star: Star | null;
  readonly selectable: THREE.Object3D[];
  readonly active: boolean;
  simulationTime: number;
  navMode: NavigationMode;
  showMoonsOfSelected: boolean;
  showPlanetOrbits: boolean;
  showMoonOrbits: boolean;

  init(height: number, width: number): void;
  start(): void;
  getCameraAzimuth(): number;
  selectInRect(start: { x: number; y: number }, end: { x: number; y: number }, additive: boolean): void;
  resetSimulation(): void;
  simulationDate: Date;
  resize(height: number, width: number): void;
  getCameraInfo(): CameraInfo;
  getSystemSnapshot(): SystemSnapshot;
  setNavigationMode(mode: NavigationMode): void;
  setCameraView(view: CameraView, durationMs?: number): void;
  navigateToPlanet(bodyName: string, durationMs?: number): void;
  navigateToSelection(durationMs?: number): void;
  moveCameraTo(toPos: THREE.Vector3, lookAt?: THREE.Vector3, toUp?: THREE.Vector3, durationMs?: number): void;
  togglePlanetOrbits(visible: boolean): void;
  toggleMoonOrbits(visible: boolean): void;
  toggleMoonsOfPlanet(planetName: string, visible: boolean): void;
  toggleShowMoonsOfSelected(): boolean;
  setHighlight(name: string, visible: boolean): void;
  keyDown(event: KeyboardEvent): void;

  toggleSpectroscopyMode(): void;

  readonly spectroscopyMode: boolean;

  addNavWaypointBody(bodyName: string, durationSec?: number): void;
  addNavWaypointCoordinate(worldX: number, worldY: number, durationSec?: number): void;
  removeNavWaypoint(index: number): void;
  updateNavWaypointDuration(index: number, durationSec: number): void;
  clearNavWaypoints(): void;
  setNavRouteLoop(loop: boolean): void;
  engageNavRoute(): void;
  disengageNavRoute(): void;
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
