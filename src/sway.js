/**
 * Chunk C seed: a trivial per-splat GPU modifier that makes the splat sway.
 *
 * This is a Spark `objectModifier`: a dyno that receives every splat as a
 * GLSL `Gsplat` struct (center, scales, quaternion, rgba, index, flags) in the
 * splat's object space and emits a modified one. It runs on the GPU each time
 * Spark regenerates the splat (we force that every frame with
 * `mesh.updateVersion()` because `swayTime` changes).
 *
 * The same hook is where the reference site reads its spring-simulation
 * textures back into the splats, so everything in Chunk D plugs in here.
 */
import { dyno } from "@sparkjsdev/spark";

export function createSwayModifier() {
  const uniforms = {
    swayTime: { value: 0 },
    swayAmplitude: { value: 0.04 },
    swayFrequency: { value: 1.2 },
    swaySpatial: { value: 2.5 },
    // Height mask in object space: splats below `swayBase` stay planted,
    // splats above `swayTop` get the full amplitude (think hay rooted at the bottom).
    swayBase: { value: 0 },
    swayTop: { value: 1 },
    // Which object-space axis is "up" for the mask (default +Y).
    swayUp: { value: [0, 1, 0] },
    // 0 = only move, 1 = also tilt the splat's long axis toward the motion.
    swayTilt: { value: 0.6 },
  };

  const modifier = new dyno.Dyno({
    inTypes: { gsplat: dyno.Gsplat },
    outTypes: { gsplat: dyno.Gsplat },
    generate: ({ inputs, outputs }) => ({
      uniforms,
      globals: [
        `
        uniform float swayTime, swayAmplitude, swayFrequency, swaySpatial, swayBase, swayTop, swayTilt;
        uniform vec3 swayUp;

        // Cheap, smooth, non-repeating field: two sines at incommensurate frequencies.
        vec3 swayField(vec3 p, float t) {
          float a = sin(dot(p, vec3(1.0, 0.0, 0.7)) * swaySpatial + t * swayFrequency);
          float b = cos(dot(p, vec3(-0.6, 0.0, 1.0)) * swaySpatial * 0.8 + t * swayFrequency * 0.73);
          return vec3(a, 0.25 * a * b, b);
        }

        // Quaternion that rotates unit vector "from" onto unit vector "to", blended by k.
        vec4 swayRotateToward(vec4 q, vec3 from, vec3 to, float k) {
          float c = clamp(dot(from, to), -1.0, 1.0);
          if (c > 0.9999 || k < 0.0001) return q;
          vec3 axis = normalize(cross(from, to));
          float angle = acos(c) * k;
          vec4 d = vec4(axis * sin(angle * 0.5), cos(angle * 0.5));
          // compose d * q
          return normalize(vec4(d.w * q.xyz + q.w * d.xyz + cross(d.xyz, q.xyz), d.w * q.w - dot(d.xyz, q.xyz)));
        }
        `,
      ],
      statements: [
        `${outputs.gsplat} = ${inputs.gsplat};`,
        `{
          vec3 home = ${inputs.gsplat}.center;
          float h = smoothstep(swayBase, swayTop, dot(home, normalize(swayUp)));
          vec3 wind = swayField(home, swayTime) * swayAmplitude * h;
          ${outputs.gsplat}.center = home + wind;

          // Tilt: point the splat's longest axis toward where it is moving.
          if (swayTilt > 0.0 && length(wind) > 1e-6) {
            vec3 s = ${inputs.gsplat}.scales;
            vec3 axisLocal = s.x >= s.y && s.x >= s.z ? vec3(1.0, 0.0, 0.0)
                           : s.y >= s.z ? vec3(0.0, 1.0, 0.0) : vec3(0.0, 0.0, 1.0);
            vec4 q = ${inputs.gsplat}.quaternion;
            vec3 axisWorld = axisLocal + 2.0 * cross(q.xyz, cross(q.xyz, axisLocal) + q.w * axisLocal);
            vec3 target = normalize(wind);
            if (dot(axisWorld, target) < 0.0) target = -target;
            ${outputs.gsplat}.quaternion = swayRotateToward(q, normalize(axisWorld), target, swayTilt * h * 0.5);
          }
        }`,
      ],
    }),
  });

  return {
    modifier,
    uniforms,
    /** Call once per frame with elapsed seconds. */
    tick(timeSeconds) {
      uniforms.swayTime.value = timeSeconds;
    },
    /** Fit the height mask to a splat's object-space bounding box. */
    fitTo(box3) {
      uniforms.swayBase.value = box3.min.y;
      uniforms.swayTop.value = box3.max.y;
    },
  };
}
