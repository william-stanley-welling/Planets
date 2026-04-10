// ─── asset-texture.service.ts ─────────────────────────────────────────────────

/**
 * @fileoverview Three.js texture loading service with graceful fallback.
 *
 * Wraps `THREE.TextureLoader.loadAsync` to load multiple textures concurrently
 * and return an empty placeholder `THREE.Texture` for any path that is empty,
 * null, or fails to load.
 *
 * @module asset-texture.service
 */

import { Injectable } from '@angular/core';
import * as THREE from 'three';

/**
 * Asynchronous texture loader for celestial body surface maps.
 *
 * @example
 * ```typescript
 * const [diffuse, bump] = await this.textureService.loadMultipleTextures([
 *   '/images/planets/earthmap1k.png',
 *   '/images/planets/earthbump1k.png',
 * ]);
 * ```
 */
@Injectable({ providedIn: 'root' })
export class AssetTextureService {
  private readonly textureLoader = new THREE.TextureLoader();

  /**
   * Loads an ordered array of texture paths concurrently.
   * Failed or empty paths resolve to a blank `THREE.Texture`.
   *
   * @param {(string | null | undefined)[]} files - Ordered array of texture URLs.
   * @returns {Promise<THREE.Texture[]>} Resolves with one texture per input path,
   *   preserving order.  Never rejects.
   */
  async loadMultipleTextures(files: (string | null | undefined)[]): Promise<THREE.Texture[]> {
    return Promise.all(files.map(async (file, idx) => {
      if (!file?.trim()) {
        const t = new THREE.Texture();
        t.colorSpace = THREE.SRGBColorSpace;
        return t;
      }
      try {
        const t = await this.textureLoader.loadAsync(file);
        t.colorSpace = THREE.SRGBColorSpace;
        t.needsUpdate = true;
        return t;
      } catch {
        // console.warn(`[AssetTextureService] Failed to load texture #${idx}: ${file}`);
        return new THREE.Texture();
      }
    }));
  }
}