import { Injectable } from '@angular/core';
import * as THREE from 'three';

@Injectable({ providedIn: 'root' })
export class TextureService {
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
        console.warn(`[TextureService] FAILED to load texture #${index}: ${file}. Using fallback.`);
        return new THREE.Texture(); // fallback, no crash
      }
    });

    return Promise.all(promises);
  }
}
