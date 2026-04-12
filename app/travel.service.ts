import { Injectable } from '@angular/core';
import * as THREE from 'three';
import { Transport, Trip, Waypoint } from './webgl/webgl.interface';

@Injectable({ providedIn: 'root' })
export class TravelService implements Transport {
  currentTrip: Trip | null = null;
  active = false;
  currentWaypointIndex = 0;
  vesselPosition = new THREE.Vector3(0, 0, 0);
  vesselVelocity = new THREE.Vector3(0, 0, 0);
  cameraMode: 'firstPerson' | 'thirdPerson' = 'firstPerson';

  private waypointProgress = 0; // 0..1 between current and next
  private arrivalTime = 0;

  loadTrips(): Trip[] {
    const raw = localStorage.getItem('helio_trips');
    if (!raw) return [];
    try {
      const trips = JSON.parse(raw);
      // Restore Vector3 for waypoint positions if needed
      return trips;
    } catch {
      return [];
    }
  }

  saveTrip(trip: Trip): void {
    const trips = this.loadTrips();
    const existing = trips.findIndex(t => t.name === trip.name);
    if (existing >= 0) trips[existing] = trip;
    else trips.push(trip);
    localStorage.setItem('helio_trips', JSON.stringify(trips));
  }

  deleteTrip(name: string): void {
    const trips = this.loadTrips().filter(t => t.name !== name);
    localStorage.setItem('helio_trips', JSON.stringify(trips));
  }

  startTrip(trip: Trip): void {
    this.currentTrip = trip;
    this.currentWaypointIndex = 0;
    this.active = true;
    this.waypointProgress = 1; // forces immediate next waypoint fetch
    this.arriveAtWaypoint();
  }

  stopTrip(): void {
    this.active = false;
    this.currentTrip = null;
  }

  toggleCameraMode(): void {
    this.cameraMode = this.cameraMode === 'firstPerson' ? 'thirdPerson' : 'firstPerson';
  }

  update(deltaSec: number): void {
    if (!this.active || !this.currentTrip) return;
    if (this.waypointProgress >= 1) {
      // Move to next waypoint
      this.currentWaypointIndex++;
      if (this.currentWaypointIndex >= this.currentTrip.waypoints.length) {
        this.stopTrip();
        return;
      }
      this.arriveAtWaypoint();
    } else {
      // Interpolate vessel position
      const wp = this.currentTrip.waypoints[this.currentWaypointIndex];
      const nextPos = this.getWaypointPosition(wp);
      const t = this.waypointProgress;
      // Ease in-out
      const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      this.vesselPosition.lerpVectors(this.vesselPosition, nextPos, eased);
      this.waypointProgress += deltaSec / 2; // adjust speed factor
    }
  }

  private arriveAtWaypoint(): void {
    const wp = this.currentTrip.waypoints[this.currentWaypointIndex];
    this.vesselPosition.copy(this.getWaypointPosition(wp));
    this.waypointProgress = 0;
    // If orbitDuration > 0, we would wait here, but for simplicity we continue
  }

  private getWaypointPosition(wp: Waypoint): THREE.Vector3 {
    if (wp.type === 'body' && wp.bodyName) {
      // Need reference to WebGl service to get body position – inject via setter
      return this.getBodyPosition(wp.bodyName);
    } else if (wp.type === 'coordinate' && wp.position) {
      return wp.position.clone();
    }
    return new THREE.Vector3();
  }

  // This will be set by WebGl after construction
  private bodyPositionGetter: ((name: string) => THREE.Vector3) | null = null;
  setBodyPositionGetter(fn: (name: string) => THREE.Vector3) {
    this.bodyPositionGetter = fn;
  }
  private getBodyPosition(name: string): THREE.Vector3 {
    return this.bodyPositionGetter?.(name) ?? new THREE.Vector3();
  }
}
