import { Inject, Injectable } from '@angular/core';
import { APP_CONFIG } from 'app/app.config';
import { Observable, ReplaySubject, Subject } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class SseService {
  private eventSource: EventSource | null = null;
  private subjects = new Map<string, Subject<any>>();

  constructor(
    @Inject(APP_CONFIG) private config: any
  ) {
    this.connect();
  }

  private connect(): void {
    if (this.eventSource) {
      return;
    }

    this.eventSource = new EventSource(this.config.sseUrl);

    this.eventSource.onopen = () => {
      console.log('SSE connected (initial solar-system arrival ready)');
    };

    this.eventSource.onerror = (err) => {
      console.error('SSE error:', err);
    };

    const eventTypes = ['init', 'update', 'planets'];

    eventTypes.forEach((eventName) => {
      this.eventSource!.addEventListener(eventName, (event: MessageEvent) => {
        try {
          const parsed = JSON.parse(event.data);
          this.getSubject(eventName).next(parsed);
        } catch {
          this.getSubject(eventName).next(event.data);
        }
      });
    });
  }

  private getSubject(name: string): Subject<any> {
    if (!this.subjects.has(name)) {
      const SubjectType = ['init', 'planets'].includes(name) ? ReplaySubject : Subject;
      this.subjects.set(name, new SubjectType<any>(1));
    }
    return this.subjects.get(name)!;
  }

  on(eventName: string): Observable<any> {
    return this.getSubject(eventName).asObservable();
  }
}
