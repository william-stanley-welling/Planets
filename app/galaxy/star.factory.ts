import { Injectable } from '@angular/core';
import * as THREE from 'three';
import { TextureService } from '../webgl/texture.service';
import { PlanetFactory } from './planet.factory';
import { Star, StarConfig } from './star.model';

@Injectable({ providedIn: 'root' })
export class StarFactory {
    constructor(
        private textureService: TextureService,
        private planetFactory: PlanetFactory // planet (satellite) factory
    ) { }

    async buildStar(prop: StarConfig): Promise<Star> {
        const textures = await this.textureService.loadMultipleTextures([prop.map]);

        const star = new Star(prop);

        star.mesh = new THREE.Mesh(
            new THREE.SphereGeometry(prop.diameter, prop.widthSegments, prop.heightSegments),
            new THREE.MeshPhongMaterial({
                color: 0xffeecc,
                map: textures[0],
                emissive: 0xffaa00,
                emissiveIntensity: 0.8,
                shininess: 0
            })
        );
        star.mesh.castShadow = false;
        star.mesh.receiveShadow = false;
        star.mesh.name = prop.name;

        star.group.add(star.mesh);

        // Central point light for the Sun (heliocentric illumination)
        const sunLight = new THREE.PointLight(0xffffff, 3.5, 0, 2);
        sunLight.position.set(0, 0, 0);
        star.group.add(sunLight);
        star.lights.push(sunLight);

        return star;
    }

    /**
     * Calls the planet (satellite) factory to build all orbiting bodies (planets).
     * Each satellite is attached via addSatellite() → THREE.Group hierarchy.
     * Moons can be added later the same way (planet.addSatellite(moon)).
     *
     * This creates the full heliocentric structure:
     * Sun.group
     *   └─ Planet.group (revolves via Kepler)
     *        └─ Moon.group (revolves via Kepler relative to planet)
     */
    async attachSatellites(star: Star, satelliteProps: any[]): Promise<void> {
        for (const satProp of satelliteProps) {
            if (satProp.name.toLowerCase() === 'sun') continue;

            const satellite = await this.planetFactory.buildPlanet(satProp);
            star.addSatellite(satellite); // uses CelestialBody.addSatellite + THREE.Group
        }
    }
}
