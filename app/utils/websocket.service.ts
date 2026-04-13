import { EventEmitter, Inject, Injectable } from '@angular/core';
import { Observable, forkJoin, from } from 'rxjs';
import { APP_CONFIG, AppConfig } from '../app.config';

@Injectable({ providedIn: 'root' })
export class WebSocketService {
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
      } catch { }
      this.emitter.emit(event);
    };

    this.webSocket.onerror = (err) => console.error('[WebSocket] Error:', err);
    this.webSocket.onclose = () => { this.isReady = false; };
  }

  getJson(file: string): Promise<any> {
    return new Promise(resolve => {
      this.resolveMap.set(file, resolve);
      this.isReady ? this.webSocket.send(file) : this.pending.push(file);
    });
  }

  getManyJson(files: string[]): Observable<any[]> {
    return forkJoin(files.map(f => from(this.getJson(f))));
  }

  sendSpeed(speed: number): void {
    this.send({ type: 'setSpeed', speed });
  }

  sendReset(): void {
    this.send({ type: 'resetSimulation' });
  }

  private send(payload: object): void {
    const str = JSON.stringify(payload);
    if (this.isReady && this.webSocket.readyState === WebSocket.OPEN) {
      this.webSocket.send(str);
    } else {
      console.warn('[WebSocket] Not open — message dropped:', (payload as any).type);
    }
  }
}
