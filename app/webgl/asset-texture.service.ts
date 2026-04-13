import { Injectable } from '@angular/core';
import * as THREE from 'three';

@Injectable({ providedIn: 'root' })
export class AssetTextureService {
  private readonly textureLoader = new THREE.TextureLoader();

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