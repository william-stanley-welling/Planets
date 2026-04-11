// ─── celestial.factory.ts ─────────────────────────────────────────────────────

/**
 * @fileoverview Generic abstract factory for constructing celestial body scene objects.
 * @module celestial.factory
 */

import { CelestialBody, CelestialConfig } from './celestial.model';

/**
 * Define interface for attaching satellites.
 */

/**
 * Define interface for attaching rings.
 */

/**
 * Abstract factory base class.
 *
 * Implementors are responsible for loading textures, creating Three.js meshes,
 * and returning a fully initialised `CelestialBody` subclass.
 *
 * @template T Config type (must extend `CelestialConfig`).
 * @template U Return type (must extend `CelestialBody`).
 *
 * @abstract
 *
 * @example
 * ```typescript
 * @Injectable({ providedIn: 'root' })
 * export class PlanetFactory extends CelestialFactory<PlanetConfig, Planet> {
 *   async build(config: PlanetConfig): Promise<Planet> { ... }
 * }
 * ```
 */
export abstract class CelestialFactory<T extends CelestialConfig, U extends CelestialBody> {
  /**
   * Asynchronously constructs a `CelestialBody` from a configuration object.
   *
   * @param {T} config - Body configuration, including texture paths and orbital elements.
   * @returns {Promise<U>} Resolves with the fully built body.
   */
  abstract build(config: T): Promise<U>;

  // implement interfaces belonging to U configured by T.

  /**
   * ~AI PROMPT~: Attach effects. These require domain model updates to allow for generalized patterns for graphical design of solid state geometry in OpenGL and on into WebGL. This will be for reflection, shading, transformations, etc.
   * 
   * @param planet 
   * @param effectConfigs
   */

  /**
   * ~AI PROMPT~: Attach rings. Implement in MoonFactory and do nothing.
   * 
   * @param planet 
   * @param ringConfigs
   */

  /**
   * ~AI PROMPT~: Attach sattelites. Implement in MoonFactory and do nothing until satellite is defined accordingly by being man made.
   * 
   * @param moon
   * @param satelliteConfigs 
   */

  /**
   * ~AI PROMPT~: Connect sattelites.
   * 
   * @param moon
   * @param connectionConfigs 
   */

}
