import { Injectable } from '@angular/core';
import * as THREE from 'three';
import { AssetTextureService } from '../webgl/asset-texture.service';
import { CelestialFactory } from './celestial.factory';
import { CometConfig, PlanetConfig, RingConfig, SIMULATION_CONSTANTS, StarConfig } from './celestial.model';
import { CometFactory } from './comet.factory';
import { MoonFactory } from './moon.factory';
import { PlanetFactory } from './planet.factory';
import { Star } from './star.model';

@Injectable({ providedIn: 'root' })
export class StarFactory extends CelestialFactory<StarConfig, Star> {

  private _keplerianRings = new Set<THREE.InstancedMesh | THREE.Mesh>();

  public get keplerianRings() {
    return this._keplerianRings;
  }

  constructor(
    private textureService: AssetTextureService,
    private planetFactory: PlanetFactory,
    private cometFactory: CometFactory,
    private moonFactory: MoonFactory
  ) {
    super();
  }

  async build(config: StarConfig): Promise<Star> {
    const textures = await this.textureService.loadMultipleTextures([config.map || '']);
    const star = new Star(config);

    const sunMaterial = new THREE.MeshPhongMaterial({
      color: 0xffeecc,
      map: textures[0]?.image ? textures[0] : undefined,
      emissive: 0xffaa00,
      emissiveIntensity: 0.9,
      shininess: 0
    });

    const visualRadius = (config.diameter || 1) * SIMULATION_CONSTANTS.VISUAL_SCALE / 2;

    star.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(visualRadius, config.widthSegments || 128, config.heightSegments || 128),
      sunMaterial
    );
    star.mesh.name = config.name || 'Sun';
    star.group.add(star.mesh);

    star.highlight = new THREE.Mesh(
      new THREE.SphereGeometry(visualRadius * 1.18, 64, 64),
      new THREE.MeshBasicMaterial({
        color: 0xffdd44,
        transparent: true,
        opacity: 0.55,
        side: THREE.BackSide,
        depthWrite: false,
      }),
    );
    star.highlight.visible = false;
    star.group.add(star.highlight);

    const sunLight = new THREE.PointLight(0xffffff, 4.0, 0, 2);
    star.group.add(sunLight);
    star.lights.push(sunLight);

    sunLight.castShadow = true;
    sunLight.shadow.mapSize.set(2048, 2048);

    const extraAmbient = new THREE.AmbientLight(0xaaaaaa, 0.6);
    star.group.add(extraAmbient);

    star.applyInitialTilt();

    const latLong = this.createLatLongLines(visualRadius);
    star.mesh.add(latLong);
    star.latLongGroup = latLong;

    if ((config as any).magneticField) {

    }

    return star;
  }

  async attachSatellites(star: Star, satelliteConfigs: PlanetConfig[] | CometConfig[]): Promise<void> {
    for (const satConfig of satelliteConfigs) {
      if (satConfig.name?.toLowerCase() === 'sun') continue;

      if (satConfig.name?.toLowerCase() === 'halley' || satConfig.name?.toLowerCase() === 'hale-bopp') {
        const comet = await this.cometFactory.build(satConfig);
        star.addSatellite(comet);
      } else {

        const planet = await this.planetFactory.build(satConfig);
        star.addSatellite(planet);

        if (Array.isArray((satConfig as any).moons) && (satConfig as any).moons.length > 0) {
          for (const moonConfig of (satConfig as any).moons) {
            const moon = await this.moonFactory.build(moonConfig);
            planet.addSatellite(moon);
          }
        }
      }
    }
  }

  async attachRings(star: Star, ringConfigs: RingConfig[]): Promise<void> {
    this.buildRings(star, ringConfigs);
  }

  private async buildRings(star: Star, starRings: RingConfig[]): Promise<void> {

    if (star.ringGroup === undefined) {
      star.ringGroup = new THREE.Group();
      star.ringGroup.name = `${star.config.name}_ring_group`;

      star.group.add(star.ringGroup);
    }

    for (const ring of starRings) {
      if (!ring?.name) continue;
      const inner = Math.max(0.1, ring.inner ?? 0);
      const outer = Math.max(inner + 1, ring.outer ?? (inner + 100));

      const tiltDeg = (ring as any).tilt ?? 0;

      const keplerian = (ring as any).keplerianRotation === true;

      if ((ring.particleCount ?? 0) > 0) {
        const zones = keplerian ? 3 : 1;
        const zoneCount = Math.ceil(ring.particleCount! / zones);
        const width = (outer - inner) / zones;
        for (let z = 0; z < zones; z++) {
          await this.buildParticleRingMesh(
            inner + z * width,
            inner + (z + 1) * width,
            zoneCount,
            tiltDeg,
            star.axis,
            ring.thickness ?? 0.4,
            ring.color ?? '#b0a090',
            ring.texture,
            keplerian,
            star.ringGroup,
            undefined,
            ring.particleSize,
          );
        }
      } else {
        const mesh = this.buildWasher(inner, outer, star.axis, ring.color ?? '#b0a090', ring.texture);
        mesh.name = `ring_${ring.name}_washer`;
        star.ringGroup.add(mesh);
      }
    }

    for (const planet of star.satellites) {
      const pCfg = planet.config as any;
      const rings: RingConfig[] = Array.isArray(pCfg.rings) ? pCfg.rings : [];
      if (rings.length === 0) continue;

      const visualDiameter = (pCfg.diameter ?? 2) * SIMULATION_CONSTANTS.VISUAL_SCALE;

      const orbGroup = (planet as any).orbitalGroup as THREE.Group;

      if (planet.ringGroup === undefined) {
        planet.ringGroup = new THREE.Group();
        planet.ringGroup.name = `${planet.config.name}_ring_group`;

        orbGroup.add(planet.ringGroup);
      }

      for (const ring of rings) {
        if (!ring?.name) continue;

        const minSafeRadius = visualDiameter * 0.55;
        let localInner = ring.inner ?? 0;
        let localOuter = ring.outer ?? 0;

        if (localInner <= minSafeRadius || localOuter <= localInner) {
          localInner = visualDiameter * 1.15;
          localOuter = visualDiameter * 2.2;
          console.warn(`[WebGl] Ring "${ring.name}" radii adjusted to visual scale: [${localInner.toFixed(1)}, ${localOuter.toFixed(1)}]`);
        }

        const tiltDeg = (ring as any).tilt ?? 0;
        const ringSpeed = ((ring as any).rotationSpeed ?? 0.005) / 1000;

        if ((ring.particleCount ?? 0) > 0) {
          await this.buildParticleRingMesh(
            localInner,
            localOuter,
            ring.particleCount!,
            tiltDeg,
            star.axis,
            ring.thickness ?? 0.02,
            ring.color ?? '#e8d8b0',
            ring.texture,
            false,
            planet.ringGroup,
            ringSpeed,
            ring.particleSize,
          );
        } else {
          const washer = this.buildWasher(localInner, localOuter, star.axis, ring.color ?? '#e8d8b0', ring.texture, ringSpeed);
          washer.name = `ring_${ring.name}_washer`;
          planet.ringGroup.add(washer);
        }

        console.log(`[WebGl] Ring "${ring.name}" built: local r=[${localInner.toFixed(1)}, ${localOuter.toFixed(1)}]`);
      }
    }
  }

  private async buildParticleRingMesh(
    inner: number,
    outer: number,
    count: number,
    tiltDeg: number,
    axis: THREE.Vector3,
    thickness: number,
    color: string,
    textureUrl: string | undefined,
    keplerian: boolean,
    parentGroup: THREE.Group | THREE.Scene,
    angularSpeedRadPerMs?: number,
    particleSizeOverride?: number,
  ): Promise<void> {

    let texture: THREE.Texture | undefined;
    if (textureUrl) {
      const tex = await this.textureService.loadMultipleTextures([textureUrl]);
      if (tex[0]?.image) texture = tex[0];
    }
    const hasTexture = !!texture;

    const vertexShader = `
      uniform float uTime;
      uniform float uVibrationTime;
      uniform float uVibrationStrength;
      uniform float uOuterRadius;
      varying vec3 vPosition;
      ${hasTexture ? 'varying vec2 vUv;' : ''}
      ${hasTexture ? 'attribute vec2 uv;' : ''}

      float hash(vec3 p) {
        return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
      }

      vec3 randomVector(vec3 p) {
        return vec3(
          hash(p + vec3(0.0)),
          hash(p + vec3(1.0, 0.0, 0.0)),
          hash(p + vec3(2.0, 0.0, 0.0))
        ) * 2.0 - 1.0;
      }

      void main() {
        vec3 pos = position;
        vec3 noisePos = pos * 0.5;
        float t = uTime * 1.5;

        // Base noise
        vec3 offset = randomVector(floor(noisePos * 10.0)) * 0.4;
        offset += sin(noisePos * 5.0 + t) * 0.1;
        offset += cos(noisePos.yzx * 3.0 - t * 1.3) * 0.1;
        pos += offset;

        vec3 instancePos = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
        float ringRadius = length(instancePos);
        float angle = atan(instancePos.z, instancePos.x);

        // ── RING WAVE (fluid channel) ──
        float waveChannel = sin(angle * 8.0 + uTime * 25.0) * 0.15 * (ringRadius / uOuterRadius);
        pos += normal * waveChannel;

        // ── UNDULATION (outer breathing) ──
        float undulation = sin(angle * 3.0 + uTime * 8.0) * 0.3 * (1.0 - ringRadius / uOuterRadius);
        pos.x += undulation * cos(angle);
        pos.z += undulation * sin(angle);

        // Original vibration (kept for compatibility)
        float wave = sin(angle * 12.0 + uVibrationTime * 35.0) * uVibrationStrength;
        float outerBias = ringRadius / uOuterRadius;
        pos += normal * (wave * outerBias * 0.6);

        vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(pos, 1.0);
        vPosition = (modelMatrix * vec4(pos, 1.0)).xyz;
        ${hasTexture ? 'vUv = uv;' : ''}
        gl_Position = projectionMatrix * mvPosition;
      }
    `;

    const fragmentShader = `
      uniform vec3 uColor;
      ${hasTexture ? `
        uniform sampler2D uTexture;
        varying vec2 vUv;
      ` : ''}
      void main() {
        ${hasTexture ? `
          vec4 texColor = texture2D(uTexture, vUv);
          gl_FragColor = texColor * vec4(uColor, 0.9);
        ` : `
          gl_FragColor = vec4(uColor, 0.9);
        `}
      }
    `;

    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: new THREE.Color(color) },
        uVibrationTime: { value: 0 },
        uVibrationStrength: { value: 0 },
        uOuterRadius: { value: outer },
        ...(hasTexture && { uTexture: { value: texture } }),
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    const tiltRad = (tiltDeg * Math.PI) / 180;
    const cosT = Math.cos(tiltRad);
    const sinT = Math.sin(tiltRad);

    const positions: THREE.Vector3[] = [];
    const scales: number[] = [];
    const attempts = count * 3;

    for (let i = 0; i < attempts && positions.length < count; i++) {
      const angle = Math.random() * 2 * Math.PI;

      const u = Math.random();
      const r = inner + Math.sqrt(u) * (outer - inner);

      const rj = r + (Math.random() - 0.5) * (outer - inner) * 0.04;

      let zOffset: number;

      if (keplerian) {
        const g = (Math.random() + Math.random() - 1);
        zOffset = g * thickness * rj * 0.3;
      } else {
        zOffset = Math.sin(angle * 6) * thickness * rj * 0.12;
      }

      const x = rj * Math.cos(angle);
      const z = rj * Math.sin(angle);
      const y = zOffset;

      const finalX = x;
      const finalY = y * cosT - z * sinT;
      const finalZ = y * sinT + z * cosT;

      positions.push(new THREE.Vector3(finalX, finalY, finalZ));

      scales.push(0.4 + Math.random() * 1.8);
    }

    if (positions.length === 0) {
      return;
    }

    let particleRadius: number;

    if (particleSizeOverride) {
      particleRadius = particleSizeOverride;
    } else if (keplerian) {
      particleRadius = Math.min(12, (outer - inner) * 0.008);
    } else {
      particleRadius = Math.min(4, (outer - inner) * 0.004);
    }

    particleRadius = Math.max(0.2, particleRadius);

    const geometry = new THREE.SphereGeometry(Math.max(0.05, particleRadius), 5, 5);
    geometry.computeVertexNormals();

    const instancedMesh = new THREE.InstancedMesh(geometry, material, positions.length);

    const ringNormal = new THREE.Vector3(1, 0, 0);
    const targetAxis = axis.clone().normalize();

    const tiltQuat = new THREE.Quaternion()
      .setFromUnitVectors(ringNormal, targetAxis);

    instancedMesh.quaternion.copy(tiltQuat);

    instancedMesh.castShadow = false;
    instancedMesh.receiveShadow = false;

    const dummy = new THREE.Object3D();
    for (let i = 0; i < positions.length; i++) {
      dummy.position.copy(positions[i]);
      dummy.scale.set(scales[i], scales[i], scales[i]);
      dummy.updateMatrix();
      instancedMesh.setMatrixAt(i, dummy.matrix);
    }
    instancedMesh.instanceMatrix.needsUpdate = true;

    parentGroup.add(instancedMesh);

    if (keplerian) {
      const avgRadiusAU = ((inner + outer) / 2) / SIMULATION_CONSTANTS.SCALE_UNITS_PER_AU;
      const periodYears = Math.sqrt(Math.pow(avgRadiusAU, 3));
      const periodMs = periodYears * 365.25 * 24 * 3600 * 1000;
      const speed = (2 * Math.PI) / periodMs;
      instancedMesh.userData = { rotate: true, angularSpeedRadPerMs: speed, currentAngle: 0 };
      this._keplerianRings.add(instancedMesh);
    } else if (angularSpeedRadPerMs && angularSpeedRadPerMs > 0) {
      instancedMesh.userData = { rotate: true, angularSpeedRadPerMs, currentAngle: 0 };
      this._keplerianRings.add(instancedMesh);
    }
  }

  private buildWasher(
    inner: number, outer: number, axis: THREE.Vector3, color: string,
    texture?: string, angularSpeedRadPerMs?: number,
  ): THREE.Mesh {
    const safeInner = Math.max(0.1, inner);
    const safeOuter = Math.max(safeInner + 0.1, outer);

    const geom = new THREE.RingGeometry(safeInner, safeOuter, 128);
    const pos = geom.attributes['position'] as THREE.BufferAttribute;
    const uvAttr = geom.attributes['uv'] as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i);
      const r = Math.sqrt(x * x + y * y);
      uvAttr.setXY(i, (r - safeInner) / (safeOuter - safeInner), (Math.atan2(y, x) / (2 * Math.PI) + 1) % 1);
    }
    uvAttr.needsUpdate = true;
    geom.computeVertexNormals();

    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(color),
      side: THREE.DoubleSide, transparent: true, opacity: 0.85, depthWrite: false,
    });

    if (texture?.trim()) {
      this.textureService.loadMultipleTextures([texture]).then(([t]) => {
        if (t.image && mat.map !== t) { t.colorSpace = THREE.SRGBColorSpace; mat.map = t; mat.needsUpdate = true; }
      });
    }

    const mesh = new THREE.Mesh(geom, mat);

    const ringNormal = new THREE.Vector3(1, 0, 0);
    const targetAxis = axis.clone().normalize();

    const tiltQuat = new THREE.Quaternion()
      .setFromUnitVectors(ringNormal, targetAxis);

    mesh.quaternion.copy(tiltQuat);

    mesh.renderOrder = 5;

    if (angularSpeedRadPerMs && angularSpeedRadPerMs > 0) {
      mesh.userData = { rotate: true, angularSpeedRadPerMs, currentAngle: 0 };
      this._keplerianRings.add(mesh as any);
    }
    return mesh;
  }

}
