import { Injectable } from '@angular/core';
import * as THREE from 'three';

/**
 * Handles asynchronous loading of textures from asset paths.
 * Uses THREE.TextureLoader internally.
 *
 * Attribution: Based on Three.js TextureLoader (r128)
 */
@Injectable({ providedIn: 'root' })
export class AssetTextureService {
  private textureLoader = new THREE.TextureLoader();

  async loadMultipleTextures(files: (string | null | undefined)[]): Promise<THREE.Texture[]> {
    const promises = files.map(async (file, index) => {
      if (!file || typeof file !== 'string' || file.trim() === '') {
        const tex = new THREE.Texture();
        tex.colorSpace = THREE.SRGBColorSpace;
        return tex;
      }
      try {
        const texture = await this.textureLoader.loadAsync(file);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.needsUpdate = true;
        return texture;
      } catch (err) {
        console.warn(`[AssetTextureService] Failed to load texture #${index}: ${file}`);
        return new THREE.Texture();
      }
    });
    return Promise.all(promises);
  }
}
