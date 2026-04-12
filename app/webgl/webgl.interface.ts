// ─── webgl.interface.ts ───────────────────────────────────────────────────────
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

/** A single stop in a navigation route. */
export interface NavigationWaypoint {
  /** 'body' = a named celestial body; 'coordinate' = a fixed XY world position. */
  type: 'body' | 'coordinate';
  bodyName?: string;
  /** World-space XY position (for coordinate waypoints). */
  position?: THREE.Vector3;
  /** Human-readable label shown in the navigation panel. */
  label?: string;
  /** How long (seconds) to geostationary-orbit this waypoint before moving on. */
  durationSec: number;
}

/** Live state of the navigation route controller. */
export interface NavigationRoute {
  waypoints: NavigationWaypoint[];
  loop: boolean;
  active: boolean;
  currentIndex: number;
  /** Progress 0–1 between currentIndex waypoint and the next. */
  progress: number;
  /** Countdown in seconds while orbiting a waypoint. */
  orbitRemaining: number;
}

/**
 * @deprecated Use NavigationRoute instead.
 * Kept temporarily for backwards compatibility.
 */
export interface TravelVesselState {
  fuel: number;
  fuelCapacity: number;
  waypoints: string[];
  enRoute: boolean;
  deltaVBudget: number;
}

export type Waypoint = {
  type: 'body' | 'coordinate';
  bodyName?: string;
  position?: THREE.Vector3;
  orbitDuration?: number;
};

export interface Trip {
  name: string;
  waypoints: Waypoint[];
  createdAt: number;
}

export interface Transport {
  currentTrip: Trip | null;
  active: boolean;
  currentWaypointIndex: number;
  vesselPosition: THREE.Vector3;
  vesselVelocity: THREE.Vector3;
  cameraMode: 'firstPerson' | 'thirdPerson';
  loadTrips(): Trip[];
  saveTrip(trip: Trip): void;
  deleteTrip(name: string): void;
  startTrip(trip: Trip): void;
  stopTrip(): void;
  update(deltaSec: number): void;
  toggleCameraMode(): void;
}

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

  // ── NEW: Spectroscopy + Solar Flare API ───────────────────────────────────
  toggleSpectroscopyMode(): void;
  triggerSolarFlareManually(): void;   // for dashboard test button

  // ── Navigation route API ──────────────────────────────────────────────────
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
