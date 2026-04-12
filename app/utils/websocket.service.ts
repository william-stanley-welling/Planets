// ─── websocket.service.ts ─────────────────────────────────────────────────────

/**
 * @fileoverview WebSocket client service for real-time orbital state updates.
 *
 * Connects to the WSS server on the configured `wsUrl`, emits every inbound
 * message through an `EventEmitter` (subscribed by `WebGl.observePlanets`),
 * and provides helpers for JSON file requests and simulation-speed control.
 *
 * @module websocket.service
 */

import { EventEmitter, Inject, Injectable } from '@angular/core';
import { Observable, forkJoin, from } from 'rxjs';
import { APP_CONFIG, AppConfig } from '../app.config';

/**
 * Bi-directional WebSocket client for the heliocentric simulation.
 *
 * Outbound:
 *  - JSON file requests (resolved via `resolveMap` when the server responds).
 *  - `{ type: 'setSpeed', speed: number }` messages to change simulation speed.
 *
 * Inbound:
 *  - `{ type: 'orbitSync' | 'orbitUpdate', simulationTime, trueAnomalies }` broadcasts.
 *  - JSON file response payloads `{ file, content }`.
 */
@Injectable({ providedIn: 'root' })
export class WebSocketService {
  /** Emits every raw `MessageEvent` received from the server. */
  readonly emitter = new EventEmitter<MessageEvent>();

  private webSocket: WebSocket;
  private pending: string[] = [];
  private resolveMap = new Map<string, (value: any) => void>();
  private isReady = false;

  /**
   * @param {AppConfig} config - Injected application configuration containing `wsUrl`.
   */
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
      } catch { /* non-JSON messages are still emitted below */ }
      // Always emit so observers (e.g. WebGl.observePlanets) receive orbit updates.
      this.emitter.emit(event);
    };

    this.webSocket.onerror = (err) => console.error('[WebSocket] Error:', err);
    this.webSocket.onclose = () => { this.isReady = false; };
  }

  /**
   * Requests a JSON resource from the server over the WebSocket channel.
   * The server must respond with `{ file, content }`.
   *
   * @param {string} file - Server-relative path, e.g. `/planets/earth.json`.
   * @returns {Promise<any>} Resolves with the parsed JSON content.
   */
  getJson(file: string): Promise<any> {
    return new Promise(resolve => {
      this.resolveMap.set(file, resolve);
      this.isReady ? this.webSocket.send(file) : this.pending.push(file);
    });
  }

  /**
   * Requests multiple JSON files in parallel over the WebSocket.
   *
   * @param {string[]} files - Array of server-relative paths.
   * @returns {Observable<any[]>} Observable that emits once all files are resolved.
   */
  getManyJson(files: string[]): Observable<any[]> {
    return forkJoin(files.map(f => from(this.getJson(f))));
  }

  /**
   * Sends a simulation-speed update to the server.
   *
   * @param {number} speed - New simulation multiplier (e.g. `100` = 100× real-time).
   */
  sendSpeed(speed: number): void {
    if (this.webSocket.readyState === WebSocket.OPEN) {
      this.webSocket.send(JSON.stringify({ type: 'setSpeed', speed }));
    } else {
      // console.warn('[WebSocket] Not open — speed message not queued (will be lost if socket reconnects).');
    }
  }

  /**
   * Sends a solar flare update to the server.
   *
   * @param {change} anything to overlap on universe.json to broadcast
   */
  sendTriggerFlare(change: any): void {
    if (this.webSocket.readyState === WebSocket.OPEN) {
      this.webSocket.send(JSON.stringify({ type: 'triggerFlare', change }));
    } else {
      // console.warn('[WebSocket] Not open — change message not queued (will be lost if socket reconnects).');
    }
  }

  /**
   * Sends a reset update to the server.
   */
  sendReset(): void {
    if (this.webSocket.readyState === WebSocket.OPEN) {
      this.webSocket.send(JSON.stringify({ type: 'resetSimulation' }));
    } else {
      // console.warn('[WebSocket] Not open — reset message not queued (will be lost if socket reconnects).');
    }
  }
}
