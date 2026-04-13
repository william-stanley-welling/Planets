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

/** @deprecated Use NavigationRoute instead. */
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

// ── Solar-flare & density map types ──────────────────────────────────────────

/**
 * A single impact record on the star's surface density map.
 * Coordinates are in radians (spherical); density is 0–1.
 */
export interface DensityBlob {
  lat: number;   // −π/2 to π/2
  lon: number;   // −π to π
  density: number;  // 0.0–1.0 accumulated impact weight
  t: number;     // unix ms timestamp of impact
}

/**
 * Snapshot of a server-spawned meteor for client reconstruction.
 */
export interface MeteorSnapshot {
  name: string;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
}

/**
 * Payload from a `flareEvent` WebSocket message.
 */
export interface FlareEventPayload {
  type: 'flareEvent';
  volatility: number;
  meteors: MeteorSnapshot[];
  beltParticleCount: number;
  simulationTime: number;
}

/**
 * Payload from a `meteorImpact` WebSocket message.
 */
export interface MeteorImpactPayload {
  type: 'meteorImpact';
  meteorName: string;
  lat: number;
  lon: number;
  density: number;
  densityMap: DensityBlob[];
  simulationTime: number;
}

// ─── Main renderer interface ──────────────────────────────────────────────────

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

  // ── Spectroscopy + Solar Flare API ────────────────────────────────────────

  /** Toggle spectroscopy visualization (axis lines + star→body lines + gamma-ray slice). */
  toggleSpectroscopyMode(): void;

  /**
   * Manually trigger a solar flare.  Sends a `triggerFlare` message to the
   * server which will eject belt particles, spawn meteors and broadcast
   * a `flareEvent` to all clients.
   * @param volatility 0.0–1.0 flare intensity.
   */
  triggerSolarFlareManually(volatility?: number): void;

  /**
   * Apply a density map snapshot received from the server to the star surface.
   * Called automatically by the WS handler — exposed for testing.
   */
  applySunDensityMap(blobs: DensityBlob[]): void;

  /**
   * Returns the current spectroscopy mode state.
   */
  readonly spectroscopyMode: boolean;

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

// ─── Supporting types ──────────────────────────────────────────────────────────

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
