// ─── websocket.service.ts ─────────────────────────────────────────────────────

/**
 * @fileoverview WebSocket client service for real-time orbital state updates.
 *
 * Connects to the WSS server on the configured `wsUrl`, emits every inbound
 * message through an `EventEmitter` (subscribed by `WebGl.observePlanets`),
 * and provides helpers for JSON file requests, simulation-speed control,
 * solar flare triggering, and meteor impact reporting.
 *
 * Message types emitted FROM server:
 *  - `orbitSync`       — initial full state (true anomalies + meteors + densityMap)
 *  - `orbitUpdate`     — periodic tick (true anomalies + meteor positions + beltParticleCount)
 *  - `ringUpdate`      — periodic ring animation tick
 *  - `flareEvent`      — server ejected meteors (volatility, meteor list, beltParticleCount)
 *  - `meteorImpact`    — a meteor hit the star surface (lat, lon, density, densityMap snapshot)
 *
 * Message types sent TO server:
 *  - `setSpeed`            — change simulation multiplier
 *  - `triggerFlare`        — request a solar flare with optional volatility
 *  - `resetSimulation`     — full state reset
 *  - `clientMeteorImpact`  — optional client confirmation of a collision
 *
 * @module websocket.service
 */

import { EventEmitter, Inject, Injectable } from '@angular/core';
import { Observable, forkJoin, from } from 'rxjs';
import { APP_CONFIG, AppConfig } from '../app.config';

@Injectable({ providedIn: 'root' })
export class WebSocketService {
  /** Emits every raw `MessageEvent` received from the server. */
  readonly emitter = new EventEmitter<MessageEvent>();

  private webSocket: WebSocket;
  private pending: string[] = [];
  private resolveMap = new Map<string, (value: any) => void>();
  private isReady = false;

  constructor(@Inject(APP_CONFIG) private config: AppConfig) {
    this.webSocket = new WebSocket(this.config.wsUrl);

    this.webSocket.onopen = () => {
      this.isReady = true;
      console.log('[WebSocket] Connected — receiving orbital coordinates.');
      this.pending.forEach(req => this.webSocket.send(req));
      this.pending = [];
    };

    this.webSocket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.file && this.resolveMap.has(data.file)) {
          this.resolveMap.get(data.file)!(data.content);
          this.resolveMap.delete(data.file);
        }
      } catch { /* non-JSON messages still emitted below */ }
      this.emitter.emit(event);
    };

    this.webSocket.onerror = (err) => console.error('[WebSocket] Error:', err);
    this.webSocket.onclose = () => { this.isReady = false; };
  }

  // ─── JSON file requests ─────────────────────────────────────────────────────

  getJson(file: string): Promise<any> {
    return new Promise(resolve => {
      this.resolveMap.set(file, resolve);
      this.isReady ? this.webSocket.send(file) : this.pending.push(file);
    });
  }

  getManyJson(files: string[]): Observable<any[]> {
    return forkJoin(files.map(f => from(this.getJson(f))));
  }

  // ─── Simulation control ─────────────────────────────────────────────────────

  /**
   * Sends a simulation-speed update to the server.
   * @param {number} speed - New multiplier (e.g. 100 = 100× real-time).
   */
  sendSpeed(speed: number): void {
    this._send({ type: 'setSpeed', speed });
  }

  /**
   * Requests a full simulation reset (clears meteors, density map, anomalies).
   */
  sendReset(): void {
    this._send({ type: 'resetSimulation' });
  }

  // ─── Solar flare API ────────────────────────────────────────────────────────

  /**
   * Requests a solar flare from the server.
   * The server will eject belt particles, spawn meteors, and broadcast
   * a `flareEvent` back to all connected clients.
   *
   * @param {number} volatility - Flare intensity 0.0–1.0 (default 0.7).
   * @param {any}    change     - Legacy payload field kept for back-compat.
   */
  sendTriggerFlare(volatility: number = 0.7, change?: any): void {
    this._send({ type: 'triggerFlare', volatility, change });
  }

  /**
   * @deprecated Use sendTriggerFlare(volatility) instead.
   * Kept for backward compatibility with existing callers.
   */
  sendTriggerFlareCompat(change: any): void {
    const v = typeof change?.volatility === 'number' ? change.volatility : 0.7;
    this.sendTriggerFlare(v, change);
  }

  // ─── Meteor impact confirmation ─────────────────────────────────────────────

  /**
   * Optionally notify the server that the client visually detected a meteor
   * impact on the star surface.  The server is authoritative and will have
   * already processed this via its own physics integration; this message is
   * for logging / analytics only.
   *
   * @param {string} meteorName - The meteor's unique identifier.
   * @param {number} lat        - Impact latitude in radians.
   * @param {number} lon        - Impact longitude in radians.
   */
  sendClientMeteorImpact(meteorName: string, lat: number, lon: number): void {
    this._send({ type: 'clientMeteorImpact', meteorName, lat, lon });
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private _send(payload: object): void {
    const str = JSON.stringify(payload);
    if (this.isReady && this.webSocket.readyState === WebSocket.OPEN) {
      this.webSocket.send(str);
    } else {
      // Queue non-file messages that are not time-critical can be dropped;
      // orbit/flare messages are stateful on the server so no queue needed.
      console.warn('[WebSocket] Not open — message dropped:', (payload as any).type);
    }
  }
}
