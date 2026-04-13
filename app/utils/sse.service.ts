import { Inject, Injectable } from '@angular/core';
import { APP_CONFIG } from 'app/app.config';
import { Observable, ReplaySubject, Subject } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class SseService {
  private eventSource: EventSource | null = null;
  private subjects = new Map<string, Subject<any>>();

  constructor(@Inject(APP_CONFIG) private config: any) {
    this.connect();
  }

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
