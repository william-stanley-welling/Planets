import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable, forkJoin } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class HttpService {
  constructor(private http: HttpClient) { }

  getJson(file: string): Observable<any> {
    return this.http.get(file);
  }

  getManyJson(files: string[]): Observable<any[]> {
    const batch = files.map(file => this.getJson(file));
    return forkJoin(batch);
  }
}
