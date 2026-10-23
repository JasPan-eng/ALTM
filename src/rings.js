/**
 * Chunk G: ring contours + grade, patched into Spark's own splat shaders.
 *
 * Same technique as the reference site: take SparkRenderer.material's vertex
 * and fragment shader source, string-replace known lines (guarded, so a Spark
 * upgrade that changes them fails loudly instead of silently), inject extra
 * uniforms and code, and mark the material for recompilation.
 *
 * The ring is drawn in the fragment shader at a fixed radius (in sigma) of
 * each Gaussian, anti-aliased with fwidth, masked where the ellipse is very
 * stretched (thin hay strands would otherwise become solid outlines), and
 * blended over the normal falloff. A saturation/contrast/brightness grade
 * follows.
 */
import * as THREE from "three";

export const RING_DEFAULTS = {
  enabled: true,
  amount: 0.44,
  radius: 0.76, // in sigma
  width: 0.76, // CSS px (half stroke)
  strength: 0.3,
  fill: 1,
  stretch: 30, // ellipses longer than this ratio get no ring
  colorMix: 0.65,
  color: "#3a2410",
  saturation: 1.0,
  brightness: 1.0,
  contrast: 1.05,
};

function replaceOnce(src, hook, replacement, label) {
  if (src.split(hook).length !== 2) throw new Error(`Spark shader hook not found (${label}): ${hook}`);
  return src.replace(hook, replacement);
}

/**
 * @param {import("@sparkjsdev/spark").SparkRenderer} spark
 */
export function patchSparkMaterial(spark) {
  const material = spark.material;
  if (!material?.vertexShader || !material?.fragmentShader) throw new Error("SparkRenderer has no material to patch yet");

  const uniforms = {
    hayRingAmount: { value: 0 },
    hayRingRadius: { value: RING_DEFAULTS.radius },
    hayRingWidth: { value: RING_DEFAULTS.width },
    hayRingStrength: { value: RING_DEFAULTS.strength },
    hayRingFill: { value: RING_DEFAULTS.fill },
    hayRingStretch: { value: RING_DEFAULTS.stretch },
    hayRingColorMix: { value: RING_DEFAULTS.colorMix },
    hayRingColor: { value: new THREE.Color(RING_DEFAULTS.color) },
    haySaturation: { value: 1 },
    hayBrightness: { value: 1 },
    hayContrast: { value: 1 },
  };

  let vs = material.vertexShader;
  let fs = material.fragmentShader;

  vs = replaceOnce(vs, `flat out float adjustedStdDev;`, `flat out float adjustedStdDev;\nflat out float hayStretch;`, "vertex out");
  vs = replaceOnce(
    vs,
    `float scale2 = min(maxPixelRadius, adjustedStdDev * sqrt(eigen2));`,
    `float scale2 = min(maxPixelRadius, adjustedStdDev * sqrt(eigen2));
    hayStretch = max(scale1, scale2) / max(0.0001, min(scale1, scale2));`,
    "vertex scale2",
  );

  fs = replaceOnce(
    fs,
    `flat in float adjustedStdDev;`,
    `flat in float adjustedStdDev;
flat in float hayStretch;
uniform float hayRingAmount, hayRingRadius, hayRingWidth, hayRingStrength, hayRingFill, hayRingStretch, hayRingColorMix;
uniform float haySaturation, hayBrightness, hayContrast;
uniform vec3 hayRingColor;`,
    "fragment in",
  );
  fs = replaceOnce(
    fs,
    `if (rgba.a < minAlpha) {`,
    `
    // --- ring contour (ALTM look pass) ---
    {
        float hayRadius = sqrt(z2);
        float hayDeriv = max(fwidth(hayRadius), 0.00001);
        if (hayRingAmount > 0.0) {
            float distancePx = abs(hayRadius - hayRingRadius) / hayDeriv;
            float band = 1.0 - smoothstep(max(0.0, hayRingWidth - 0.5), hayRingWidth + 0.5, distancePx);
            float stretchMask = 1.0 - smoothstep(hayRingStretch * 0.6, hayRingStretch, hayStretch);
            // Fade at Spark's own coverage boundary so the quad edge never shows.
            float coverage = 1.0 - smoothstep(max(0.0, adjustedStdDev - hayDeriv), adjustedStdDev, hayRadius);
            float ringAlpha = clamp(band * hayRingStrength * stretchMask * coverage * clamp(vRgba.a, 0.0, 1.0), 0.0, 0.99);
            float fillAlpha = rgba.a * hayRingFill;
            float combinedAlpha = ringAlpha + fillAlpha * (1.0 - ringAlpha);
            vec3 ringColor = mix(rgba.rgb, hayRingColor, hayRingColorMix);
            vec3 combinedPremul = ringColor * ringAlpha + rgba.rgb * fillAlpha * (1.0 - ringAlpha);
            vec3 finalPremul = mix(rgba.rgb * rgba.a, combinedPremul, hayRingAmount);
            rgba.a = mix(rgba.a, combinedAlpha, hayRingAmount);
            rgba.rgb = finalPremul / max(rgba.a, 0.000001);
        }
        // --- grade ---
        float hayGrey = dot(rgba.rgb, vec3(0.2126, 0.7152, 0.0722));
        vec3 hayGraded = mix(vec3(hayGrey), rgba.rgb, haySaturation);
        hayGraded = (hayGraded - 0.5) * hayContrast + 0.5;
        rgba.rgb = clamp(hayGraded * hayBrightness, 0.0, 1.0);
    }
    if (rgba.a < minAlpha) {`,
    "fragment minAlpha",
  );

  material.vertexShader = vs;
  material.fragmentShader = fs;
  Object.assign(material.uniforms, uniforms);
  material.needsUpdate = true;

  return {
    uniforms,
    configure(p, pixelRatio = 1) {
      uniforms.hayRingAmount.value = p.enabled ? p.amount : 0;
      uniforms.hayRingRadius.value = p.radius;
      uniforms.hayRingWidth.value = p.width * pixelRatio;
      uniforms.hayRingStrength.value = p.strength;
      uniforms.hayRingFill.value = p.fill;
      uniforms.hayRingStretch.value = p.stretch;
      uniforms.hayRingColorMix.value = p.colorMix;
      uniforms.hayRingColor.value.set(p.color);
      uniforms.haySaturation.value = p.saturation;
      uniforms.hayBrightness.value = p.brightness;
      uniforms.hayContrast.value = p.contrast;
    },
  };
}
