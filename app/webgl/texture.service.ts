import { Injectable } from '@angular/core';
import * as THREE from 'three';

@Injectable({ providedIn: 'root' })
export class TextureService {
  private textureLoader = new THREE.TextureLoader();

  async loadMultipleTextures(files: (string | null | undefined)[]): Promise<THREE.Texture[]> {
    const promises = files.map(async (file, index) => {
      if (index === 0 && !file) {
        throw new Error(`Main texture map is missing for this planet`);
      }

      if (!file || file === "") {
        return new THREE.Texture();
      }

      try {
        const texture = await this.textureLoader.loadAsync(file);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.needsUpdate = true;
        return texture;
      } catch (err) {
        console.error(`[TextureService] FAILED to load texture #${index}: ${file}`);
        throw new Error(`Failed to load texture: ${file}`);
      }
    });

    return Promise.all(promises);
  }
}
