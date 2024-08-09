import Cartesian3 from "../Core/Cartesian3.js";
import defaultValue from "../Core/defaultValue.js";
import defined from "../Core/defined.js";
import destroyObject from "../Core/destroyObject.js";
import ComputeCommand from "../Renderer/ComputeCommand.js";
import Framebuffer from "../Renderer/Framebuffer.js";
import Texture from "../Renderer/Texture.js";
import PixelDatatype from "../Renderer/PixelDatatype";
import PixelFormat from "../Core/PixelFormat";
import Sampler from "../Renderer/Sampler.js";
import ShaderProgram from "../Renderer/ShaderProgram.js";
import ShaderSource from "../Renderer/ShaderSource.js";
import TextureMinificationFilter from "../Renderer/TextureMinificationFilter.js";
import SkyAtmosphereCommon from "../Shaders/SkyAtmosphereCommon.js";
import AtmosphereCommon from "../Shaders/AtmosphereCommon.js";
import ComputeIrradianceMapFS from "../Shaders/ComputeIrradianceMapFS.js";
import ComputeRadianceMapFS from "../Shaders/ComputeRadianceMapFS.js";
import ConvolveSpecularMapFS from "../Shaders/ConvolveSpecularMapFS.js";
import ConvolveSpecularMapVS from "../Shaders/ConvolveSpecularMapVS.js";
import CesiumMath from "../Core/Math.js";
import CubeMap from "../Renderer/CubeMap.js";
import Cartesian2 from "../Core/Cartesian2.js";
import Transforms from "../Core/Transforms.js";
import Matrix4 from "../Core/Matrix4.js";
import JulianDate from "../Core/JulianDate.js";

/**
 * @typedef {Object} DynamicEnvironmentMapManager.ConstructorOptions
 *
 * Options for the DynamicEnvironmentMapManager constructor
 *
 * @property {number} [mipmapLevels=10] The number of mipmap levels to generate for specular maps. More mipmap levels will produce a higher resolution specular reflection.
 */

/**
 * Generates an environment map at the given position based on scene's current lighting conditions. From this, it produces multiple levels of specular maps and spherical harmonic coefficients than can be used with {@link ImageBasedLighting} for models or tilesets.
 *
 * @alias DynamicEnvironmentMapManager
 * @constructor
 *
 * @param {DynamicEnvironmentMapManager.ConstructorOptions} options An object describing initialization options.
 */
function DynamicEnvironmentMapManager(options) {
  this._position = undefined;

  this._radianceCommandsDirty = true;
  this._radianceMapDirty = true;
  this._convolutionsCommandsDirty = false;
  this._irradianceCommandDirty = false;
  this._irradianceTextureDirty = false;
  this._sphericalHarmonicCoefficientsDirty = false;

  options = defaultValue(options, defaultValue.EMPTY_OBJECT);

  const mipmapLevels = defaultValue(options.mipmapLevels, 10);
  this._mipmapLevels = mipmapLevels;
  this._radianceMapComputeCommands = new Array(6);
  this._convolutionComputeCommands = new Array((mipmapLevels - 1) * 6);
  this._irradianceComputeCommand = undefined; // TODO: Clearer naming: Specular and SH?

  this._radianceMapFS = undefined;
  this._irradianceMapFS = undefined;
  this._convolveSP = undefined;
  this._va = undefined;

  this._radianceMapTextures = new Array(6);
  this._specularMapTextures = new Array((mipmapLevels - 1) * 6);
  this._radianceCubeMap = undefined;
  this._irradianceMapTexture = undefined;

  this._sphericalHarmonicCoefficients = new Array(9);

  this._lastTime = new JulianDate();
  const width = Math.pow(2, mipmapLevels - 1);
  this._textureDimensions = new Cartesian2(width, width);

  /**
   * If true, the environment map and related properties will continue to update.
   * @memberOf DynamicEnvironmentMapManager.prototype
   * @type {boolean}
   */
  this.enabled = true;

  /**
   * The maximum amount of elapsed seconds before a new environment map is created.
   * @memberOf DynamicEnvironmentMapManager.prototype
   * @type {number}
   */
  this.maximumSecondsDifference = 60 * 20;
}

Object.defineProperties(DynamicEnvironmentMapManager.prototype, {
  /**
   * The position around which the environment map is generated.
   *
   * @memberof DynamicEnvironmentMapManager.prototype
   * @type {Cartesian3|undefined}
   */
  position: {
    get: function () {
      return this._position;
    },
    set: function (value) {
      if (
        Cartesian3.equalsEpsilon(value, this._position, CesiumMath.EPSILON8)
      ) {
        return;
      }

      this._position = value;
      this._reset();
    },
  },

  /**
   * The computed radiance map, or <code>undefined</code> if it has not yet been created.
   *
   * @memberof DynamicEnvironmentMapManager.prototype
   * @type {CubeMap|undefined}
   * @readonly
   * @private
   */
  radianceCubeMap: {
    get: function () {
      return this._radianceCubeMap;
    },
  },

  /**
   * The maximum number of mip levels available in the radiance cubemap.
   * @memberOf DynamicEnvironmentMapManager.prototype
   * @type {number}
   * @readonly
   * @private
   */
  maximumMipmapLevel: {
    get: function () {
      return this._mipmapLevels;
    },
  },

  /**
   * The third order spherical harmonic coefficients used for the diffuse color of image-based lighting, or <code>undefined</code> if they have not yet been computed.
   * <p>
   * There are nine <code>Cartesian3</code> coefficients.
   * The order of the coefficients is: L<sub>0,0</sub>, L<sub>1,-1</sub>, L<sub>1,0</sub>, L<sub>1,1</sub>, L<sub>2,-2</sub>, L<sub>2,-1</sub>, L<sub>2,0</sub>, L<sub>2,1</sub>, L<sub>2,2</sub>
   * </p>
   *
   * @memberof DynamicEnvironmentMapManager.prototype
   * @readonly
   * @type {Cartesian3[]|undefined}
   * @see {@link https://graphics.stanford.edu/papers/envmap/envmap.pdf|An Efficient Representation for Irradiance Environment Maps}
   * @private
   */
  sphericalHarmonicCoefficients: {
    get: function () {
      return this._sphericalHarmonicCoefficients;
    },
  },
});

/**
 * Cancels any in-progress commands and marks the environment map as dirty.
 * @private
 */
DynamicEnvironmentMapManager.prototype._reset = function () {
  let length = this._radianceMapComputeCommands.length;
  for (let i = 0; i < length; ++i) {
    const command = this._radianceMapComputeCommands[i];
    if (defined(command)) {
      command.canceled = true;
    }
    this._radianceMapComputeCommands[i] = undefined;
  }

  length = this._convolutionComputeCommands.length;
  for (let i = 0; i < length; ++i) {
    const command = this._convolutionComputeCommands[i];
    if (defined(command)) {
      command.canceled = true;
    }
    this._convolutionComputeCommands[i] = undefined;
  }

  if (defined(this._irradianceMapComputeCommand)) {
    this._irradianceMapComputeCommand.canceled = true;
    this._irradianceMapComputeCommand = undefined;
  }

  this._radianceMapDirty = true;
  this._radianceCommandsDirty = true;
};

const scratchCartesian = new Cartesian3();
const scratchSurfacePosition = new Cartesian3();
const scratchMatrix = new Matrix4();

/**
 * Renders the highest resolution specular map by creating compute commands for each cube face
 * @param {DynamicEnvironmentMapManager} manager
 * @param {FrameState} frameState
 * @private
 */
function updateRadianceMap(manager, frameState) {
  const context = frameState.context;
  const textureDimensions = manager._textureDimensions;

  if (!defined(manager._radianceCubeMap)) {
    manager._radianceCubeMap = new CubeMap({
      context: context,
      width: textureDimensions.x,
      height: textureDimensions.y,
      pixelDatatype: PixelDatatype.UNSIGNED_BYTE,
      pixelFormat: PixelFormat.RGBA,
    });
  }

  if (manager._radianceCommandsDirty) {
    // TODO: Do we need both of these dirty flags?
    let fs = manager._radianceMapFS;
    if (!defined(fs)) {
      fs = new ShaderSource({
        sources: [AtmosphereCommon, SkyAtmosphereCommon, ComputeRadianceMapFS],
      });
      manager._radianceMapFS = fs;
    }

    let i = 0;
    for (const face of manager._radianceCubeMap.faces()) {
      let texture = manager._radianceMapTextures[i];
      if (!defined(texture)) {
        texture = new Texture({
          context: context,
          width: textureDimensions.x,
          height: textureDimensions.y,
          pixelDatatype: PixelDatatype.UNSIGNED_BYTE,
          pixelFormat: PixelFormat.RGBA,
        });
        manager._radianceMapTextures[i] = texture;
      }

      // TODO: Should we be tracking changes to the atmosphere and lighting settings?
      const atmosphere = frameState.atmosphere;
      const position = manager._position;

      const ellipsoid = frameState.mapProjection.ellipsoid;
      const surfacePosition = ellipsoid.scaleToGeodeticSurface(
        position,
        scratchSurfacePosition
      );
      const outerEllipsoidScale = 1.025;

      // Pack outer radius, inner radius, and dynamic atmosphere flag
      const radiiAndDynamicAtmosphereColor = new Cartesian3();
      const radius = Cartesian3.magnitude(surfacePosition);
      radiiAndDynamicAtmosphereColor.x = radius * outerEllipsoidScale;
      radiiAndDynamicAtmosphereColor.y = radius;

      // TODO
      // Toggles whether the sun position is used. 0 treats the sun as always directly overhead.
      radiiAndDynamicAtmosphereColor.z = 1;

      const enuToFixedFrame = Transforms.eastNorthUpToFixedFrame(
        manager._position,
        ellipsoid,
        scratchMatrix
      );

      const index = i;
      const command = new ComputeCommand({
        fragmentShaderSource: fs,
        outputTexture: texture,
        uniformMap: {
          u_radiiAndDynamicAtmosphereColor: () =>
            radiiAndDynamicAtmosphereColor,
          u_atmosphereLightIntensity: () => atmosphere.lightIntensity,
          u_atmosphereRayleighCoefficient: () => atmosphere.rayleighCoefficient,
          u_atmosphereMieCoefficient: () => atmosphere.mieCoefficient,
          u_atmosphereRayleighScaleHeight: () => atmosphere.rayleighScaleHeight,
          u_atmosphereMieScaleHeight: () => atmosphere.mieScaleHeight,
          u_atmosphereMieAnisotropy: () => atmosphere.mieAnisotropy,
          u_enuToFixedFrame: () => enuToFixedFrame,
          u_faceDirection: () =>
            manager._radianceCubeMap.getDirection(face, scratchCartesian),
          u_positionWC: () => position,
        },
        persists: false,
        owner: manager,
        postExecute: () => {
          const commands = manager._radianceMapComputeCommands;
          commands[index] = undefined;

          const framebuffer = new Framebuffer({
            context: context,
            colorTextures: [manager._radianceMapTextures[index]],
            destroyAttachments: false,
          });

          // Copy the output texture into the corresponding cubemap face
          framebuffer._bind();
          face.copyFromFramebuffer();
          framebuffer._unBind();
          framebuffer.destroy();

          if (!commands.some(defined)) {
            manager._convolutionsCommandsDirty = true;
          }
        },
      });
      frameState.commandList.push(command);
      manager._radianceMapComputeCommands[i] = command;
      i++;
    }
    manager._radianceCommandsDirty = false;
  }
}

/**
 * Creates a mipmap chain for the cubemap by convolving the environment map for each roughness level
 * @param {DynamicEnvironmentMapManager} manager
 * @param {FrameState} frameState
 * @private
 */
function updateSpecularMaps(manager, frameState) {
  const radianceCubeMap = manager._radianceCubeMap;
  radianceCubeMap.generateMipmap();

  const mipmapLevels = manager._mipmapLevels;
  const textureDimensions = manager._textureDimensions;
  let width = textureDimensions.x / 2;
  let height = textureDimensions.y / 2;
  const context = frameState.context;

  let facesCopied = 0;
  const getPostExecute = (index, texture, face, level) => () => {
    // Copy output texture to corresponding face and mipmap level
    const commands = manager._convolutionComputeCommands;
    commands[index] = undefined;

    radianceCubeMap.copyFace(frameState, texture, face, level);
    facesCopied++;

    // All faces and levels have been copied
    if (facesCopied === manager._specularMapTextures.length) {
      manager._irradianceCommandDirty = true;
      radianceCubeMap.sampler = new Sampler({
        // TODO: Adjust existing sampler?
        minificationFilter: TextureMinificationFilter.LINEAR_MIPMAP_LINEAR,
      });
    }
  };

  for (let level = 1; level < mipmapLevels; ++level) {
    for (const [faceIndex, face] of CubeMap.faceNames.entries()) {
      const index = (level - 1) * 6 + faceIndex;
      const texture = (manager._specularMapTextures[index] = new Texture({
        context: context,
        width: width,
        height: height,
        pixelDatatype: PixelDatatype.UNSIGNED_BYTE,
        pixelFormat: PixelFormat.RGBA,
      }));

      let vertexArray = manager._va;
      if (!defined(vertexArray)) {
        vertexArray = CubeMap.createVertexArray(context, face);
        manager._va = vertexArray;
      }

      let shaderProgram = manager._convolveSP;
      if (!defined(shaderProgram)) {
        shaderProgram = ShaderProgram.fromCache({
          context: context,
          vertexShaderSource: ConvolveSpecularMapVS,
          fragmentShaderSource: ConvolveSpecularMapFS,
          attributeLocations: {
            positions: 0,
          },
        });
        manager._convolveSP = shaderProgram;
      }

      const command = new ComputeCommand({
        shaderProgram: shaderProgram,
        vertexArray: vertexArray,
        outputTexture: texture,
        persists: true,
        owner: manager,
        uniformMap: {
          u_roughness: () => level / (mipmapLevels - 1),
          u_radianceTexture: () => radianceCubeMap,
          u_faceDirection: () => {
            return CubeMap.getDirection(face, scratchCartesian);
          },
        },
        postExecute: getPostExecute(index, texture, face, level),
      });
      manager._convolutionComputeCommands[index] = command;
      frameState.commandList.push(command);
    }

    width /= 2;
    height /= 2;
  }
}

/**
 * Computes spherical harmonic coefficients by convolving the environment map
 * @param {DynamicEnvironmentMapManager} manager
 * @param {FrameState} frameState
 */
function updateIrradianceResources(manager, frameState) {
  const context = frameState.context;
  const dimensions = new Cartesian2(3, 3); // 9 coefficients

  let texture = manager._irradianceMapTexture;
  if (!defined(texture)) {
    texture = new Texture({
      context: context,
      width: dimensions.x,
      height: dimensions.y,
      pixelDatatype: PixelDatatype.FLOAT,
      pixelFormat: PixelFormat.RGBA,
    });
    manager._irradianceMapTexture = texture;
  }

  let fs = manager._irradianceMapFS;
  if (!defined(fs)) {
    fs = new ShaderSource({
      sources: [ComputeIrradianceMapFS],
    });
    manager._irradianceMapFS = fs;
  }

  const command = new ComputeCommand({
    fragmentShaderSource: fs,
    outputTexture: texture,
    uniformMap: {
      u_radianceMap: () => manager._radianceCubeMap,
    },
    postExecute: () => {
      manager._irradianceTextureDirty = false;
      manager._irradianceComputeCommand = undefined;
      manager._sphericalHarmonicCoefficientsDirty = true;
    },
  });
  manager._irradianceComputeCommand = command;
  frameState.commandList.push(command);
  manager._irradianceTextureDirty = true;
}

/**
 * Copies coefficients from the output texture using readPixels.
 * @param {DynamicEnvironmentMapManager} manager
 * @param {FrameState} frameState
 */
function updateSphericalHarmonicCoefficients(manager, frameState) {
  const context = frameState.context;

  const framebuffer = new Framebuffer({
    context: context,
    colorTextures: [manager._irradianceMapTexture],
    destroyAttachments: false,
  });

  const data = context.readPixels({
    x: 0,
    y: 0,
    width: 3,
    height: 3,
    framebuffer: framebuffer,
  });

  for (let i = 0; i < 9; ++i) {
    manager._sphericalHarmonicCoefficients[i] = Cartesian3.unpack(data, i * 4);
  }

  framebuffer.destroy();
}

/**
 * Called when {@link Viewer} or {@link CesiumWidget} render the scene to
 * build the resources for the environment maps.
 * <p>
 * Do not call this function directly.
 * </p>
 * @private
 * @return {boolean} TODO
 */
DynamicEnvironmentMapManager.prototype.update = function (frameState) {
  if (!this.enabled || !defined(this._position)) {
    return false;
  }

  if (
    !JulianDate.equalsEpsilon(
      frameState.time,
      this._lastTime,
      this.maximumSecondsDifference
    )
  ) {
    this._reset();
    this._lastTime = JulianDate.clone(frameState.time, this._lastTime);
  }

  if (this._radianceMapDirty) {
    updateRadianceMap(this, frameState);
    this._radianceMapDirty = false;
    return false;
  }

  if (this._convolutionsCommandsDirty) {
    updateSpecularMaps(this, frameState);
    this._convolutionsCommandsDirty = false;
    return false;
  }

  if (this._irradianceCommandDirty) {
    updateIrradianceResources(this, frameState);
    this._irradianceCommandDirty = false;
  }

  if (this._irradianceTextureDirty) {
    return false;
  }

  if (this._sphericalHarmonicCoefficientsDirty) {
    updateSphericalHarmonicCoefficients(this, frameState);
    this._sphericalHarmonicCoefficientsDirty = false;
    return true;
  }
};

/**
 * Returns true if this object was destroyed; otherwise, false.
 * <br /><br />
 * If this object was destroyed, it should not be used; calling any function other than
 * <code>isDestroyed</code> will result in a {@link DeveloperError} exception.
 *
 * @returns {boolean} <code>true</code> if this object was destroyed; otherwise, <code>false</code>.
 *
 * @see DynamicEnvironmentMapManager#destroy
 */
DynamicEnvironmentMapManager.prototype.isDestroyed = function () {
  return false;
};

/**
 * Destroys the WebGL resources held by this object.  Destroying an object allows for deterministic
 * release of WebGL resources, instead of relying on the garbage collector to destroy this object.
 * <br /><br />
 * Once an object is destroyed, it should not be used; calling any function other than
 * <code>isDestroyed</code> will result in a {@link DeveloperError} exception.  Therefore,
 * assign the return value (<code>undefined</code>) to the object as done in the example.
 *
 * @exception {DeveloperError} This object was destroyed, i.e., destroy() was called.
 *
 *
 * @example
 * mapManager = mapManager && mapManager.destroy();
 *
 * @see DynamicEnvironmentMapManager#isDestroyed
 */
DynamicEnvironmentMapManager.prototype.destroy = function () {
  // Cancel in-progress commands
  let length = this._radianceMapComputeCommands.length;
  for (let i = 0; i < length; ++i) {
    const command = this._radianceMapComputeCommands[i];
    if (defined(command)) {
      command.canceled = true;
    }
  }

  length = this._convolutionComputeCommands.length;
  for (let i = 0; i < length; ++i) {
    const command = this._convolutionComputeCommands[i];
    if (defined(command)) {
      command.canceled = true;
    }
  }

  if (defined(this._irradianceMapComputeCommand)) {
    this._irradianceMapComputeCommand.canceled = true;
  }

  // Destroy all textures
  length = this._radianceMapTextures.length;
  for (let i = 0; i < length; ++i) {
    this._radianceMapTextures[i] =
      this._radianceMapTextures[i] && this._radianceMapTextures[i].destroy();
  }

  length = this._specularMapTextures.length;
  for (let i = 0; i < length; ++i) {
    this._specularMapTextures[i] =
      this._specularMapTextures[i] && this._specularMapTextures[i].destroy();
  }

  this._radianceCubeMap =
    this._radianceCubeMap && this._radianceCubeMap.destroy();
  this._irradianceMapTexture =
    this._irradianceMapTexture && this._irradianceMapTexture.destroy();

  return destroyObject(this);
};

export default DynamicEnvironmentMapManager;
