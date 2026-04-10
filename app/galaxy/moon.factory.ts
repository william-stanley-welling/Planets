import { Injectable } from '@angular/core';
import * as THREE from 'three';
import { AssetTextureService } from '../webgl/asset-texture.service';
import { Moon, MoonConfig } from './moon.model';
import { CelestialFactory } from './celestial.factory';

@Injectable({ providedIn: 'root' })
export class MoonFactory extends CelestialFactory<any, Moon> {
  constructor(private textureService: AssetTextureService) {
    super();
  }

  async build(prop: any): Promise<Moon> {
    const texturePaths = [
      prop.map || '',
      prop.bumpMap || '',
      prop.specMap || '',
      prop.cloudMap || '',
      prop.alphaMap || '',
    ];
    const textures = await this.textureService.loadMultipleTextures(texturePaths);
    const moon = new Moon(prop as MoonConfig);
    const baseColor = prop.color ? new THREE.Color(prop.color) : new THREE.Color(0xaaaaaa);

    const material = new THREE.MeshPhongMaterial({
      color: baseColor,
      map: textures[0]?.image ? textures[0] : undefined,
      bumpMap: textures[1]?.image ? textures[1] : undefined,
      bumpScale: 0.12,
      specularMap: textures[2]?.image ? textures[2] : undefined,
      specular: new THREE.Color(0x222222),
      shininess: 6,
      emissive: textures[0]?.image ? new THREE.Color(0x000000) : new THREE.Color(baseColor).multiplyScalar(0.15),
    });

    moon.mesh = new THREE.Mesh(new THREE.SphereGeometry(prop.diameter || 1, 32, 32), material);
    moon.mesh.name = prop.name || 'Moon';

    moon.highlight = new THREE.Mesh(
      new THREE.SphereGeometry((prop.diameter || 1) * 1.12, 32, 32),
      new THREE.MeshBasicMaterial({ color: 0x88ccff, transparent: true, opacity: 0.35, side: THREE.BackSide }),
    );
    moon.highlight.visible = false;

    if (prop.cloudMap && textures[3]?.image) {
      moon.clouds = new THREE.Mesh(
        new THREE.SphereGeometry((prop.diameter || 1) + (prop.atmosphere || 0.001), 32, 32),
        new THREE.MeshPhongMaterial({
          map: textures[3],
          alphaMap: textures[4]?.image ? textures[4] : undefined,
          side: THREE.DoubleSide,
          opacity: 0.7,
          transparent: true,
          depthWrite: false,
        }),
      );
      moon.clouds.name = `${prop.name || 'Moon'}_clouds`;
    }

    moon.orbitalGroup.add(moon.mesh);
    moon.orbitalGroup.add(moon.highlight);
    if (moon.clouds) moon.orbitalGroup.add(moon.clouds);
    moon.mass = (prop.mass || 1) * Math.pow(10, prop.pow || 0);
    return moon;
  }
}
