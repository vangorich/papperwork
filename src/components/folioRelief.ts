import {
  Float32BufferAttribute,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  SRGBColorSpace,
  Texture,
  Vector2,
  WebGLRenderer,
} from 'three'

export interface FolioRelief {
  /** Normalized pointer, left/top = -1. Never renders while the pointer is idle. */
  tilt(x: number, y: number): void
  dispose(): void
}

// The three leaves and horizontal folds in the original 1008 × 672 top view.
// Preserve the original photograph's projection; only their relief moves.
const leaves = [
  [0.221, 0.184, 0.661, 0.677, 0.458, 0.16],
  [0.274, 0.253, 0.709, 0.735, 0.526, 0.3],
  [0.323, 0.321, 0.759, 0.801, 0.595, 0.47],
]

export function mountFolioRelief(host: HTMLElement, print: HTMLImageElement, onLost: () => void): FolioRelief | undefined {
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('webgl2', {
    powerPreference: 'low-power',
    failIfMajorPerformanceCaveat: true,
    antialias: false,
    alpha: false,
    depth: true,
    stencil: false,
  })
  if (!context) return
  let renderer: WebGLRenderer
  try {
    renderer = new WebGLRenderer({ canvas, context })
  } catch {
    context.getExtension('WEBGL_lose_context')?.loseContext()
    return
  }
  const camera = new OrthographicCamera(-1.5, 1.5, 1, -1, 0.1, 10)
  camera.position.z = 4
  const scene = new Scene(),
    texture = new Texture(print)
  texture.colorSpace = SRGBColorSpace
  texture.needsUpdate = true
  const pointer = new Vector2()
  const material = new ShaderMaterial({
    uniforms: { printMap: { value: texture }, pointer: { value: pointer } },
    vertexShader: `
      uniform vec2 pointer;
      attribute vec3 paper; // flexibility, position across the leaf, crease weight
      varying vec2 printUv;
      varying float light;
      void main() {
        printUv = uv;
        vec3 p = position;
        p.z += paper.x * (0.22 * pointer.y + 0.09 * pointer.x * paper.y);
        p.xy += vec2(0.138 * pointer.x, -0.112 * pointer.y) * p.z;
        light = 1.0 + paper.z * (0.23 * pointer.x * paper.y - 0.15 * pointer.y);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: `
      uniform sampler2D printMap;
      varying vec2 printUv;
      varying float light;
      void main() {
        gl_FragColor = vec4(texture2D(printMap, printUv).rgb * light, 1.0);
        #include <colorspace_fragment>
      }`,
  })
  const geometry = new PlaneGeometry(3, 2, 80, 56)
  const pos = geometry.getAttribute('position'), uv = geometry.getAttribute('uv')
  const paper = new Float32BufferAttribute(pos.count * 3, 3)
  for (let i = 0; i < pos.count; i++) {
    const x = uv.getX(i), y = 1 - uv.getY(i)
    for (const [l, t, r, b, crease, height] of leaves) {
      // Carry the photographed contact shadow a short way with its sheet. The bed stays pinned.
      const edge = Math.min(x - l, r - x, y - t, b - y)
      const weight = Math.min(1, 1 + edge / 0.025)
      if (weight <= 0) continue
      const across = Math.min(1, Math.max(0, (x - l) / (r - l)))
      const arch = Math.sin(Math.PI * across)
      const fromFold = Math.min(1, Math.abs(y - crease) / (y < crease ? crease - t : b - crease))
      const depth = height + (1 - fromFold) * (0.04 + 0.09 * arch)
      pos.setZ(i, pos.getZ(i) + weight * (depth - pos.getZ(i)))
      // The crease is stiffer than the free edge. Carry its silhouette (and nearby shadow)
      // with the bend, but keep the grazing light on the printed fold itself.
      const flex = fromFold * fromFold * arch
      paper.setXYZ(i,
        paper.getX(i) + weight * (flex - paper.getX(i)),
        paper.getY(i) + weight * (2 * across - 1 - paper.getY(i)),
        edge < 0 ? paper.getZ(i) : Math.exp(-(((y - crease) / 0.022) ** 2)),
      )
    }
  }
  geometry.setAttribute('paper', paper)
  geometry.computeBoundingSphere()
  const folio = new Mesh(geometry, material)
  scene.add(folio)
  canvas.style.visibility = 'hidden'
  host.append(canvas)
  let frame = 0,
    dead = false,
    shaderFailed = false,
    w = 0,
    h = 0
  renderer.debug.onShaderError = () => { shaderFailed = true }
  function draw() {
    frame = 0
    if (dead || !w || !h) return
    // A VM can grant WebGL2 but reject the shader on first draw. Never cover the print with that frame.
    try { renderer.render(scene, camera) } catch { lost(); return }
    if (shaderFailed) { lost(); return }
    canvas.style.visibility = 'visible'
    host.dataset.folioLive = 'true'
  }
  function invalidate() {
    if (!frame && !dead) frame = requestAnimationFrame(draw)
  }
  function resize() {
    w = host.clientWidth
    h = host.clientHeight
    if (!w || !h) return
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5, 1008 / w))
    renderer.setSize(w, h, false)
    invalidate()
  }
  const observer = new ResizeObserver(resize)
  function dispose() {
    if (dead) return
    dead = true
    cancelAnimationFrame(frame)
    observer.disconnect()
    canvas.removeEventListener('webglcontextlost', lost)
    delete host.dataset.folioLive
    canvas.remove()
    scene.clear()
    material.dispose()
    geometry.dispose()
    texture.dispose()
    renderer.dispose()
    if (!renderer.getContext().isContextLost()) renderer.forceContextLoss()
  }
  function lost() {
    dispose()
    onLost() // This desk now stays on the underlying 2D print, including after pointer re-entry.
  }
  canvas.addEventListener('webglcontextlost', lost)
  observer.observe(host)
  resize()
  return {
    tilt(nx, ny) {
      if (!dead && (pointer.x !== nx || pointer.y !== ny)) {
        pointer.set(nx, ny)
        invalidate()
      }
    },
    dispose,
  }
}
