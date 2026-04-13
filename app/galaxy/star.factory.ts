// ─── star.factory.ts ─────────────────────────────────────────────────────────

/**
 * @fileoverview StarFactory — builds the Three.js scene object for a star.
 *
 * Solar surface density map:
 *   A secondary `THREE.CanvasTexture` is composited on top of the star's base
 *   diffuse map via a `THREE.MeshPhongMaterial`.  Every meteor impact is painted
 *   as a radial soft blob on this canvas at the latitude/longitude of impact.
 *   The accumulated blobs survive between frames (canvas is not cleared per-frame),
 *   creating a persistent, growing dark-spot record of all impacts.
 *
 *   The Star class is augmented with:
 *     - `densityCanvas` — the OffscreenCanvas (or HTMLCanvasElement)
 *     - `densityTexture` — the corresponding THREE.CanvasTexture
 *     - `paintDensityBlob(lat, lon, density)` — adds a single impact blob
 *     - `flareEmissivePulse(lat, lon)` — temporarily brightens an impact location
 *
 * @module star.factory
 */

import { Injectable } from '@angular/core';
import * as THREE from 'three';
import { AssetTextureService } from '../webgl/asset-texture.service';
import { CelestialFactory } from './celestial.factory';
import { MoonConfig, PlanetConfig, StarConfig } from './celestial.model';
import { MoonFactory } from './moon.factory';
import { PlanetFactory } from './planet.factory';
import { Star } from './star.model';

// ─── Density canvas dimensions ────────────────────────────────────────────────
/** Width of the density overlay canvas in texels (powers of 2). */
const DENSITY_CANVAS_W = 1024;
/** Height of the density overlay canvas in texels. */
const DENSITY_CANVAS_H = 512;

// ─── Surface splat visual params ─────────────────────────────────────────────
/** Max radius (in texels) of a density blob at full intensity. */
const BLOB_MAX_RADIUS = 80;
/** Emissive flash duration in ms when a meteor strikes. */
const FLASH_DURATION_MS = 900;

// ─── Augmented Star type (internal) ──────────────────────────────────────────

export interface StarWithDensity extends Star {
  densityCanvas: HTMLCanvasElement;
  densityTexture: THREE.CanvasTexture;
  densityCtx: CanvasRenderingContext2D;
  /** Paint a single impact blob onto the density overlay canvas. */
  paintDensityBlob(lat: number, lon: number, density: number): void;
  /** Briefly increase emissive intensity at impact location. */
  flareEmissivePulse(lat: number, lon: number, density: number): void;
  /** Replace the density layer with a full densityMap snapshot. */
  applyDensityMap(blobs: Array<{ lat: number; lon: number; density: number; t: number }>): void;
}

@Injectable({ providedIn: 'root' })
export class StarFactory extends CelestialFactory<StarConfig, Star> {
  constructor(
    private textureService: AssetTextureService,
    private planetFactory: PlanetFactory,
    private moonFactory: MoonFactory,
  ) {
    super();
  }

  // ---------------------------------------------------------------------------
  // build()
  // ---------------------------------------------------------------------------

  async build(config: StarConfig): Promise<StarWithDensity> {
    const textures = await this.textureService.loadMultipleTextures([config.map || '']);
    const star = new Star(config) as StarWithDensity;

    // ── Density overlay canvas ────────────────────────────────────────────────
    const canvas = document.createElement('canvas');
    canvas.width = DENSITY_CANVAS_W;
    canvas.height = DENSITY_CANVAS_H;
    const ctx = canvas.getContext('2d')!;
    // Start fully transparent (no blending with base texture)
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const densityTexture = new THREE.CanvasTexture(canvas);
    densityTexture.colorSpace = THREE.SRGBColorSpace;

    star.densityCanvas = canvas;
    star.densityCtx = ctx;
    star.densityTexture = densityTexture;

    // ── Sun material — base + density overlay blended via emissiveMap ─────────
    const sunMaterial = new THREE.MeshPhongMaterial({
      color: 0xffeecc,
      map: textures[0]?.image ? textures[0] : undefined,
      emissive: new THREE.Color(0xffaa00),
      emissiveIntensity: 0.9,
      emissiveMap: densityTexture,   // ← density blobs modulate emissive layer
      shininess: 0,
    });

    const radius = config.diameter || 139.2;
    star.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(radius, config.widthSegments || 128, config.heightSegments || 128),
      sunMaterial,
    );
    star.mesh.name = config.name || 'Sun';
    star.group.add(star.mesh);

    // ── Selection highlight halo ──────────────────────────────────────────────
    star.highlight = new THREE.Mesh(
      new THREE.SphereGeometry(radius * 1.18, 64, 64),
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

    // ── Lighting ──────────────────────────────────────────────────────────────
    const sunLight = new THREE.PointLight(0xffffff, 4.0, 0, 2);
    star.group.add(sunLight);
    star.lights.push(sunLight);

    const extraAmbient = new THREE.AmbientLight(0xaaaaaa, 0.6);
    star.group.add(extraAmbient);

    // ── Tilt + debug axis ─────────────────────────────────────────────────────
    star.applyInitialTilt();
    star.addDebugAxisLine();

    // ── Attach density methods to instance ────────────────────────────────────
    star.paintDensityBlob = (lat: number, lon: number, density: number) => {
      _paintBlob(star.densityCtx, star.densityTexture, lat, lon, density);
    };

    star.flareEmissivePulse = (lat: number, lon: number, density: number) => {
      _emissivePulse(star, lat, lon, density);
    };

    star.applyDensityMap = (blobs) => {
      // Redraw entire canvas from map snapshot (used on reconnect / reset)
      star.densityCtx.clearRect(0, 0, DENSITY_CANVAS_W, DENSITY_CANVAS_H);
      for (const b of blobs) {
        _paintBlob(star.densityCtx, star.densityTexture, b.lat, b.lon, b.density);
      }
      star.densityTexture.needsUpdate = true;
    };

    return star;
  }

  // ---------------------------------------------------------------------------
  // attachSatellites()
  // ---------------------------------------------------------------------------

  async attachSatellites(star: Star, satelliteConfigs: PlanetConfig[] | MoonConfig[]): Promise<void> {
    for (const satConfig of satelliteConfigs) {
      if (satConfig.name?.toLowerCase() === 'sun') continue;

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

// ---------------------------------------------------------------------------
// Module-level helpers (not exported — internal to factory)
// ---------------------------------------------------------------------------

/**
 * Convert spherical (lat, lon) in radians to equirectangular canvas pixel (u, v).
 * lat ∈ [−π/2, π/2], lon ∈ [−π, π].
 */
function _latLonToUV(lat: number, lon: number): { u: number; v: number } {
  // Equirectangular: lon maps to [0,1] left-to-right, lat maps to [0,1] top-to-bottom
  const u = (lon / (2 * Math.PI) + 0.5) % 1.0;
  const v = 0.5 - lat / Math.PI;
  return { u: Math.max(0, Math.min(1, u)), v: Math.max(0, Math.min(1, v)) };
}

/**
 * Paint a soft radial blob on the density canvas at the given spherical coordinates.
 * The blob colour ranges from dark orange (low density) to deep crimson (high density).
 */
function _paintBlob(
  ctx: CanvasRenderingContext2D,
  texture: THREE.CanvasTexture,
  lat: number,
  lon: number,
  density: number,
): void {
  const { u, v } = _latLonToUV(lat, lon);
  const px = u * DENSITY_CANVAS_W;
  const py = v * DENSITY_CANVAS_H;
  const radius = BLOB_MAX_RADIUS * (0.3 + density * 0.7);

  // Radial gradient: centre = dark ochre, edge = transparent
  const grad = ctx.createRadialGradient(px, py, 0, px, py, radius);
  const alpha = Math.min(0.92, 0.35 + density * 0.55);

  // Dense impacts → darker, redder; light impacts → amber
  const r = Math.round(60 + 180 * density);
  const g = Math.round(30 * (1 - density));
  const b = 0;

  grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${alpha})`);
  grad.addColorStop(0.55, `rgba(${r}, ${g}, ${b}, ${(alpha * 0.4).toFixed(3)})`);
  grad.addColorStop(1, 'rgba(0, 0, 0, 0)');

  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(px, py, radius, 0, Math.PI * 2);
  ctx.fill();

  texture.needsUpdate = true;
}

/**
 * Briefly increases the sun's emissiveIntensity and flickers it back down,
 * simulating the surface splash of an impacting meteor.
 */
function _emissivePulse(star: Star, lat: number, lon: number, density: number): void {
  const mat = star.mesh?.material as THREE.MeshPhongMaterial;
  if (!mat) return;

  const baseIntensity = 0.9;
  const peakIntensity = baseIntensity + density * 2.5;
  const startMs = performance.now();

  const animate = () => {
    const elapsed = performance.now() - startMs;
    const t = Math.min(elapsed / FLASH_DURATION_MS, 1);
    // Sharp rise then exponential decay
    const envelope = t < 0.1
      ? t / 0.1                        // 0→1 in first 10%
      : Math.exp(-6 * (t - 0.1));      // exponential decay to ~0
    mat.emissiveIntensity = baseIntensity + (peakIntensity - baseIntensity) * envelope;

    // Also briefly shift emissive colour toward white-hot at peak
    const whiteness = envelope * density * 0.6;
    mat.emissive.setRGB(1.0, 0.67 + whiteness * 0.33, whiteness);

    if (t < 1) {
      requestAnimationFrame(animate);
    } else {
      mat.emissiveIntensity = baseIntensity;
      mat.emissive.setHex(0xffaa00);
    }
  };
  requestAnimationFrame(animate);
}
