"use client";

import { useEffect, useRef, useState } from "react";
import { m } from "motion/react";
import type { EffortLevel } from "./effort-levels";

/**
 * Effort-level flame for the effort slider (used by cli-menu): a WebGL
 * rocket-exhaust flame shader over a parallax starfield, with a canvas
 * pixel-noise fallback when WebGL is unavailable. The flame burns at every
 * effort stop — pale yellow when the gentlest level is picked, growing and
 * heating through gold and white up to the blue rocket exhaust at max.
 */

/* ------------------------------------------------------- effort flame shader */

const FLAME_VERT = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

/**
 * Procedural rocket-exhaust plume: fbm turbulence advected right-to-left,
 * with a white-hot core at the nozzle (right edge) cooling outward through
 * the level's palette as it dissolves toward the left, plus a soft ambient
 * glow. Palette and throttle arrive as uniforms (see FLAME_SPECS).
 */
const FLAME_FRAG = `
precision mediump float;
uniform vec2 u_res;
uniform float u_time;
uniform float u_power;  // 0 -> 1 throttle-up after ignition
uniform float u_nozzle; // plume origin across the track (thumb position)
uniform float u_span;   // flame length as a share of the burnt stretch
uniform float u_vscale; // vertical scale: gentle levels hug the centre line
uniform vec3 u_deep;    // dissolving plume body
uniform vec3 u_mid;     // saturated flame
uniform vec3 u_bright;  // hot core tone

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * noise(p);
    p = p * 2.1 + vec2(37.4, 17.9);
    a *= 0.5;
  }
  return v;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  // The plume fires from the nozzle (the thumb's centre) leftward, so the
  // flame rides the picked level and fills exactly the track it has burnt
  // through: d = 0 at the nozzle, growing toward the left edge.
  float d = u_nozzle - uv.x;
  float y = (uv.y - 0.5) * 2.0 / max(u_vscale, 0.05); // -1..1, per-level height

  // Turbulence blown leftward; second octave wobbles the plume axis
  float turb = fbm(vec2(uv.x * 5.5 + u_time * 3.2, uv.y * 3.5 + u_time * 0.4)) - 0.5;
  float sway = (fbm(vec2(u_time * 1.6, uv.x * 2.0)) - 0.5) * 0.55;

  // Plume envelope: wide at the nozzle, tapering toward its own tip, edges
  // licked by noise. reach is the flame's own length — a share (u_span) of
  // the stretch it has to burn in — so the gentlest level stays a stubby
  // lick instead of filling whatever room the thumb leaves it.
  float reach = max(u_span * u_nozzle, 0.001);
  float width = mix(1.05, 0.12, smoothstep(0.0, reach, max(d, 0.0))) * mix(0.35, 1.0, u_power);
  float shape = 1.0 - smoothstep(width * 0.35, width, abs(y + sway * d + turb * (0.35 + d * 0.9)));
  float len = 1.0 - smoothstep(reach * 0.15, reach, d + turb * 0.45 * reach);
  float flame = clamp(shape * len, 0.0, 1.0);

  // Extra hot core hugging the nozzle centre line
  float core = (1.0 - smoothstep(0.0, 0.38 * reach, d + turb * 0.15)) * (1.0 - smoothstep(0.0, 0.55, abs(y)));
  flame = clamp(flame + core * 0.6, 0.0, 1.0) * mix(0.6, 1.0, u_power);

  // Ambient glow so the flame feels emissive even past its tongues
  float glow = (1.0 - smoothstep(0.0, 0.85 * reach, d)) * (1.0 - smoothstep(0.2, 1.15, abs(y))) * 0.4 * u_power;

  // The level's palette, cooling outward: deep -> mid -> bright. The
  // white-hot core is gated on nozzle distance too, so only the plume root
  // burns white and the body keeps the level's hue.
  vec3 col = mix(u_deep, u_mid, smoothstep(0.2, 0.6, flame));
  col = mix(col, u_bright, smoothstep(0.62, 0.95, flame) * (1.0 - smoothstep(0.1, 0.75, d)));
  float hot = smoothstep(0.9, 1.0, flame) * (1.0 - smoothstep(0.02, 0.3, d));
  col = mix(col, vec3(1.0), hot);

  float alpha = smoothstep(0.04, 0.55, flame) * 0.96 + glow;
  // Nothing burns past the nozzle (right of the thumb).
  alpha *= 1.0 - smoothstep(0.0, 0.012, -d);
  gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
}
`;

/** How one effort stop burns: the plume throttle plus its three-tone palette
 *  (dissolving body → saturated flame → hot core). The story runs from a
 *  campfire's pale yellow, through gold and white heat, to the blue rocket
 *  exhaust at max — color and reach both climb with the level. */
export interface FlameSpec {
  /** Plume throttle 0..1: width and brightness scale with it. */
  power: number;
  /** How far the flame reaches, as a share of the stretch it has to burn in
   *  (the thumb to the left edge): a stubby lick at the gentlest stop, the
   *  full stretch at max. This is the flame's own length — not the track it
   *  happens to sit on. */
  span: number;
  /** Vertical footprint 0..1: gentle levels hug the track's centre line. */
  vscale: number;
  /** Starfield speed multiplier — a lazy drift at low, a hard rush at max. */
  rush: number;
  deep: readonly [number, number, number];
  mid: readonly [number, number, number];
  bright: readonly [number, number, number];
}

export const FLAME_SPECS: Record<EffortLevel, FlameSpec> = {
  low: {
    power: 0.25,
    span: 0.65,
    vscale: 0.45,
    rush: 0.35,
    deep: [0.82, 0.55, 0.05],
    mid: [1.0, 0.8, 0.2],
    bright: [1.0, 0.93, 0.55],
  },
  medium: {
    power: 0.4,
    span: 0.75,
    vscale: 0.58,
    rush: 0.8,
    deep: [0.85, 0.47, 0.05],
    mid: [1.0, 0.66, 0.16],
    bright: [1.0, 0.88, 0.45],
  },
  high: {
    power: 0.58,
    span: 0.85,
    vscale: 0.72,
    rush: 1.4,
    deep: [0.93, 0.62, 0.28],
    mid: [1.0, 0.84, 0.6],
    bright: [1.0, 0.96, 0.85],
  },
  xhigh: {
    power: 0.78,
    span: 0.93,
    vscale: 0.86,
    rush: 2.1,
    deep: [0.5, 0.62, 0.85],
    mid: [0.68, 0.82, 1.0],
    bright: [0.86, 0.93, 1.0],
  },
  max: {
    power: 1.0,
    span: 1.0,
    vscale: 1.0,
    rush: 3.0,
    deep: [0.082, 0.365, 0.988],
    mid: [0.318, 0.635, 1.0],
    bright: [0.741, 0.867, 1.0],
  },
};

/** Thumb geometry, mirrored from EffortSlider's CSS: the 21px thumb's centre
 *  travels from 10.5px to (trackWidth − 10.5)px. Returns the plume origin as
 *  a 0..1 fraction of the track, clamped so even the gentlest level keeps a
 *  sliver of space to burn in. */
export function nozzleForFraction(fraction: number, trackWidth: number): number {
  const THUMB = 21;
  if (!(trackWidth > 0)) return 1;
  const clamped = Math.min(Math.max(fraction, 0), 1);
  const centre = THUMB / 2 + clamped * Math.max(trackWidth - THUMB, 0);
  return Math.min(Math.max(centre / trackWidth, 0.03), 1);
}

/**
 * Parallax starfield behind the flame: three depth layers of tiny stars
 * streaming right-to-left at different speeds (near = faster + brighter +
 * stretched into streaks), plus the occasional fast shooting star. The
 * field belongs to the flame: stars live between the left edge and the
 * nozzle (the thumb), entering there and streaming left — the right of the
 * thumb stays plain track.
 */
function Starfield({
  fraction,
  level,
}: {
  fraction: number;
  level: EffortLevel;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fractionRef = useRef(fraction);
  fractionRef.current = fraction;
  const levelRef = useRef(level);
  levelRef.current = level;

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const { width, height } = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    interface Star {
      x: number;
      y: number;
      speed: number; // px/s leftward
      size: number;
      alpha: number;
    }

    const nozzlePx = () => nozzleForFraction(fractionRef.current, width) * width;

    // depth: 0 far … 1 near — near stars are faster, larger, brighter
    const makeStar = (spawnAnywhere: boolean): Star => {
      const depth = Math.random();
      return {
        x: spawnAnywhere ? Math.random() * nozzlePx() : nozzlePx() + 4,
        y: 1 + Math.random() * (height - 2),
        speed: 18 + depth * 90,
        size: 0.6 + depth * 1.0,
        alpha: 0.4 + depth * 0.55,
      };
    };
    const stars: Star[] = Array.from({ length: 40 }, () => makeStar(true));

    let shooting: (Star & { life: number }) | null = null;

    let raf = 0;
    let last = performance.now();
    const draw = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      const edge = nozzlePx();
      // The stream picks up speed with the level: a lazy drift at the
      // gentlest stop, a hard rush at max.
      const rush = FLAME_SPECS[levelRef.current].rush;
      ctx.clearRect(0, 0, width, height);

      for (const star of stars) {
        star.x -= star.speed * rush * dt;
        if (star.x < -6) Object.assign(star, makeStar(false));
        // Only the burnt-through stretch (left of the thumb) has sky.
        if (star.x > edge + 6) continue;
        // motion streak: length scales with speed so near stars smear
        const streak = star.speed * 0.05;
        const grad = ctx.createLinearGradient(star.x, star.y, star.x + streak, star.y);
        grad.addColorStop(0, `rgba(255,255,255,${star.alpha.toFixed(3)})`);
        grad.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = grad;
        ctx.fillRect(star.x, star.y - star.size / 2, streak + star.size, star.size);
      }

      // ~ every 2.5s launch a shooting star: long bright streak, fades out
      if (!shooting && Math.random() < dt / 2.5) {
        shooting = { ...makeStar(false), speed: 260 + Math.random() * 120, size: 1.2, alpha: 0.9, life: 1 };
      }
      if (shooting) {
        shooting.x -= shooting.speed * rush * dt;
        shooting.life -= dt * 0.9;
        if (shooting.x < -40 || shooting.life <= 0) {
          shooting = null;
        } else if (shooting.x <= edge + 6) {
          const len = 26;
          const a = shooting.alpha * Math.max(shooting.life, 0);
          const grad = ctx.createLinearGradient(shooting.x, shooting.y, shooting.x + len, shooting.y);
          grad.addColorStop(0, `rgba(255,255,255,${a.toFixed(3)})`);
          grad.addColorStop(1, "rgba(255,255,255,0)");
          ctx.fillStyle = grad;
          ctx.fillRect(shooting.x, shooting.y - 0.6, len, 1.2);
        }
      }

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  return <canvas ref={canvasRef} aria-hidden className="absolute inset-0 size-full" />;
}

/** rgb() triple from a 0..1 shader color. */
function rgb255(color: readonly [number, number, number]): [number, number, number] {
  return color.map((c) => Math.round(c * 255)) as [number, number, number];
}

/**
 * Shader-style "pixelation" fallback when WebGL is unavailable: a dense
 * field of level-colored pixels burns at the right edge and dissolves
 * toward the left — cell density and opacity both fall off with distance.
 * ~12fps.
 */
function PixelationOverlay({
  level,
  fraction,
}: {
  level: EffortLevel;
  fraction: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const spec = FLAME_SPECS[level];
  const [rB, gB, bB] = rgb255(spec.bright);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const { width, height } = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    const cell = 3;
    const cols = Math.ceil(width / cell);
    const rows = Math.ceil(height / cell);
    // The level's palette, bright core first — same story as the shader.
    const palette = [spec.bright, spec.mid, spec.deep].map(rgb255);
    // The burn starts under the thumb, like the shader's nozzle, and spans
    // only the flame's own share of that stretch.
    const nozzleCol = Math.max(nozzleForFraction(fraction, width) * (cols - 1), 1);
    const burnCol = Math.max(nozzleCol * spec.span, 1);

    let raf = 0;
    let last = 0;
    const draw = (time: number) => {
      if (time - last > 70) {
        last = time;
        ctx.clearRect(0, 0, width, height);
        for (let col = 0; col < cols; col++) {
          // 0 at the left edge → 1 at the nozzle: dense at the nozzle,
          // dissolving out toward the left (nothing burns past it). Capped
          // below 1 so even the densest cells keep flickering instead of
          // reading as solid.
          const t = Math.min(Math.max((burnCol - col) / burnCol, 0), 1);
          const density = 0.78 * Math.pow(t, 1.6);
          for (let row = 0; row < rows; row++) {
            if (Math.random() < density) {
              const [r, g, b] = palette[(Math.random() * palette.length) | 0];
              // Fully random alpha per cell per frame keeps the field alive
              const alpha = (0.15 + Math.random() * 0.85) * (0.35 + 0.65 * t);
              ctx.fillStyle = `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
              ctx.fillRect(col * cell, row * cell, cell - 1, cell - 1);
            }
          }
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [spec, fraction]);

  return (
    <m.div
      aria-hidden
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
      className="pointer-events-none absolute inset-0"
    >
      {/* level-colored wash bleeding left from under the thumb, under the
          pixel noise; the width mirrors the slider's fill geometry */}
      <div
        className="absolute inset-y-0 left-0"
        style={{
          width: `calc(${fraction} * (100% - 21px) + 10.5px)`,
          background: `linear-gradient(to left, rgba(${rB},${gB},${bB},0.9) 0%, rgba(${rB},${gB},${bB},0.3) 50%, transparent 100%)`,
        }}
      />
      <canvas ref={canvasRef} className="absolute inset-0 size-full" />
    </m.div>
  );
}

/**
 * Compiles the flame shaders and links them into a WebGL program.
 * Returns null when linking fails (the caller falls back to the pixel
 * overlay). Pure with respect to React: everything it touches lives on `gl`.
 */
function createFlameProgram(gl: WebGLRenderingContext): WebGLProgram | null {
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    return shader;
  };
  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl.VERTEX_SHADER, FLAME_VERT));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FLAME_FRAG));
  gl.linkProgram(program);
  return gl.getProgramParameter(program, gl.LINK_STATUS) ? program : null;
}

/**
 * WebGL flame overlay for the effort slider: a rocket-engine exhaust plume
 * firing right-to-left across the track (see FLAME_FRAG), over a parallax
 * starfield streaming past. The flame burns at every effort stop — `level`
 * picks the palette and throttle, and a level change glides in over a beat
 * instead of snapping. Falls back to the pixel-noise overlay if a WebGL
 * context can't be created.
 */
export function FlameOverlay({
  level,
  fraction,
}: {
  level: EffortLevel;
  /** Thumb position 0..1 — the plume fires from there, not the track edge. */
  fraction: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [webglFailed, setWebglFailed] = useState(false);
  // The draw loop reads these each frame, so level and thumb changes glide
  // in without rebuilding the WebGL context.
  const levelRef = useRef(level);
  levelRef.current = level;
  const fractionRef = useRef(fraction);
  fractionRef.current = fraction;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: false });
    if (!gl) {
      setWebglFailed(true);
      return;
    }

    const { width, height } = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    gl.viewport(0, 0, canvas.width, canvas.height);

    const program = createFlameProgram(gl);
    if (!program) {
      setWebglFailed(true);
      return;
    }
    gl.useProgram(program);

    // Full-screen triangle strip quad
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(program, "a_pos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    gl.uniform2f(gl.getUniformLocation(program, "u_res"), canvas.width, canvas.height);
    const uTime = gl.getUniformLocation(program, "u_time");
    const uPower = gl.getUniformLocation(program, "u_power");
    const uNozzle = gl.getUniformLocation(program, "u_nozzle");
    const uSpan = gl.getUniformLocation(program, "u_span");
    const uVscale = gl.getUniformLocation(program, "u_vscale");
    const uDeep = gl.getUniformLocation(program, "u_deep");
    const uMid = gl.getUniformLocation(program, "u_mid");
    const uBright = gl.getUniformLocation(program, "u_bright");

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const trackWidth = width;

    let raf = 0;
    const start = performance.now();
    const draw = (now: number) => {
      const elapsed = (now - start) / 1000;
      const spec = FLAME_SPECS[levelRef.current];
      // The thumb jumps between stops, so the plume jumps with it: origin,
      // palette and height all follow the level with no lag. Only the
      // ignition (a cold start building over ~1.4s) is animated.
      const ignite = 1 - Math.pow(1 - Math.min(elapsed / 1.4, 1), 3);
      const nozzle = nozzleForFraction(fractionRef.current, trackWidth);
      gl.uniform1f(uTime, elapsed);
      gl.uniform1f(uPower, spec.power * ignite);
      gl.uniform1f(uNozzle, nozzle);
      gl.uniform1f(uSpan, spec.span);
      gl.uniform1f(uVscale, spec.vscale);
      gl.uniform3f(uDeep, spec.deep[0], spec.deep[1], spec.deep[2]);
      gl.uniform3f(uMid, spec.mid[0], spec.mid[1], spec.mid[2]);
      gl.uniform3f(uBright, spec.bright[0], spec.bright[1], spec.bright[2]);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    // No loseContext() here: React strict-mode re-runs the effect on the same
    // canvas, and a deliberately-lost context would poison the second run.
    // The context is reclaimed with the canvas when the overlay unmounts.
    return () => cancelAnimationFrame(raf);
  }, []);

  if (webglFailed) return <PixelationOverlay level={level} fraction={fraction} />;

  // The scene (space wash, starfield, flame) covers exactly the stretch the
  // level has burnt through: it ends at the thumb, like the plume.
  const sceneWidth = `calc(${fraction} * (100% - 21px) + 10.5px)`;

  return (
    <m.div
      aria-hidden
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
      className="pointer-events-none absolute inset-0"
    >
      {/* faint dark space wash so the white stars read on the grey track
          (fixed palette in both themes — the flame shader's is fixed too) */}
      <div
        className="absolute inset-y-0 left-0 rounded-l-lg bg-effort-flame-wash"
        style={{ width: sceneWidth }}
      />
      <Starfield fraction={fraction} level={level} />
      <canvas ref={canvasRef} className="absolute inset-0 size-full" />
    </m.div>
  );
}
