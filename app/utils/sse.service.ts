// ─── sse.service.ts ───────────────────────────────────────────────────────────

/**
 * @fileoverview SSE (Server-Sent Events) client service.
 *
 * Maintains a persistent `EventSource` connection to `/event` and
 * multiplexes named event types through individual `Subject`/`ReplaySubject` streams.
 *
 * @module sse.service
 */

import { Inject, Injectable } from '@angular/core';
import { APP_CONFIG } from 'app/app.config';
import { Observable, ReplaySubject, Subject } from 'rxjs';

/**
 * Thin wrapper around the browser `EventSource` API.
 *
 * Event types:
 *  - `planets` — full solar-system hierarchy (replayed to late subscribers).
 *  - `init`    — initial server configuration (replayed to late subscribers).
 *  - `update`  — recurring glyph-overlay data for the adaptive UI.
 */
@Injectable({ providedIn: 'root' })
export class SseService {
  private eventSource: EventSource | null = null;
  private subjects = new Map<string, Subject<any>>();

  /**
   * @param {any} config - Injected app configuration containing `sseUrl`.
   */
  constructor(@Inject(APP_CONFIG) private config: any) {
    this.connect();
  }

  /**
   * Returns an `Observable` for a named SSE event type.
   * `init` and `planets` events are backed by a `ReplaySubject(1)` so that
   * late subscribers always receive the most recent value.
   *
   * @param {string} eventName - SSE event type, e.g. `'planets'` or `'update'`.
   * @returns {Observable<any>} Stream of parsed event payloads.
   */
  on(eventName: string): Observable<any> {
    return this.getSubject(eventName).asObservable();
  }

  private connect(): void {
    if (this.eventSource) return;
    this.eventSource = new EventSource(this.config.sseUrl);
    this.eventSource.onopen = () => console.log('[SSE] Connected.');
    this.eventSource.onerror = (err) => console.error('[SSE] Error:', err);

    for (const type of ['init', 'update', 'planets']) {
      this.eventSource.addEventListener(type, (e: MessageEvent) => {
        try { this.getSubject(type).next(JSON.parse(e.data)); }
        catch { this.getSubject(type).next(e.data); }
      });
    }
  }

  private getSubject(name: string): Subject<any> {
    if (!this.subjects.has(name)) {
      const isReplay = ['init', 'planets'].includes(name);
      this.subjects.set(name, isReplay ? new ReplaySubject<any>(1) : new Subject<any>());
    }
    return this.subjects.get(name)!;
  }
}
