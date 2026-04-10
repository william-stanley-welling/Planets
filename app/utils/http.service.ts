// ─── http.service.ts ──────────────────────────────────────────────────────────

/**
 * @fileoverview Thin HTTP JSON-fetching service wrapping Angular `HttpClient`.
 * @module http.service
 */

import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable, forkJoin } from 'rxjs';

/**
 * Convenience wrapper around `HttpClient` for loading JSON resources.
 */
@Injectable({ providedIn: 'root' })
export class HttpService {
  /** @param {HttpClient} http - Angular HTTP client. */
  constructor(private http: HttpClient) { }

  /**
   * Fetches a single JSON file.
   *
   * @param {string} file - URL of the JSON resource.
   * @returns {Observable<any>} Observable emitting the parsed response.
   */
  getJson(file: string): Observable<any> {
    return this.http.get(file);
  }

  /**
   * Fetches multiple JSON files in parallel.
   *
   * @param {string[]} files - Array of URLs.
   * @returns {Observable<any[]>} Observable emitting all responses once resolved.
   */
  getManyJson(files: string[]): Observable<any[]> {
    return forkJoin(files.map(f => this.getJson(f)));
  }
}
