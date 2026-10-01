import { useEffect, useRef, useState } from "react";
import { extOf } from "../../lib/media";
import { isIdle } from "../../lib/idle";

interface ModelViewProps {
  bytes: ArrayBuffer;
  path: string;
  onInfo?: (text: string) => void;
}

type Stats = { vertices: number; triangles: number; materials: number; textures: number; size: string; animations: string[] };

/** 3D の土台（three.js。開いたときだけ読み込む） */
type Api = {
  setWire: (on: boolean) => void;
  setGrid: (on: boolean) => void;
  setSpin: (on: boolean) => void;
  setLight: (v: number) => void;
  setBg: (bg: "dark" | "light") => void;
  reset: () => void;
  play: (name: string | null) => void;
  setSpeed: (v: number) => void;
};

/**
 * 3D（glb・gltf・obj・fbx・stl）。ドラッグで回す・ホイールで寄る・右ドラッグで動かす。ワイヤー・床の格子・自動で回す・明るさ・背景。
 * アニメーションがあれば選んで再生。頂点・三角形・マテリアル・テクスチャの数と大きさ
 */
export function ModelView({ bytes, path, onInfo }: ModelViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<Api | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<Stats | null>(null);
  const [wire, setWire] = useState(false);
  const [grid, setGrid] = useState(true);
  const [spin, setSpin] = useState(false);
  const [light, setLight] = useState(1);
  const [bg, setBg] = useState<"dark" | "light">("dark");
  const [anim, setAnim] = useState<string | null>(null);
  const [speed, setSpeed] = useState(1);

  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | null = null;
    (async () => {
      try {
        const THREE = await import("three");
        const { OrbitControls } = await import("three/examples/jsm/controls/OrbitControls.js");
        const ext = extOf(path);
        let root: import("three").Object3D;
        let clips: import("three").AnimationClip[] = [];
        if (ext === "glb" || ext === "gltf") {
          const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
          // .gltf がほかのファイル・外の URL を読みに行かないように（中に入っているもの＝data: と blob: だけ）
          const manager = new THREE.LoadingManager();
          manager.setURLModifier((url) => (/^(data|blob):/i.test(url) ? url : "data:,"));
          const gltf = await new GLTFLoader(manager).parseAsync(bytes, "");
          root = gltf.scene;
          clips = gltf.animations;
        } else if (ext === "fbx") {
          const { FBXLoader } = await import("three/examples/jsm/loaders/FBXLoader.js");
          root = new FBXLoader().parse(bytes, "");
          clips = (root as import("three").Object3D & { animations: import("three").AnimationClip[] }).animations ?? [];
        } else if (ext === "obj") {
          const { OBJLoader } = await import("three/examples/jsm/loaders/OBJLoader.js");
          root = new OBJLoader().parse(new TextDecoder().decode(bytes));
        } else {
          const { STLLoader } = await import("three/examples/jsm/loaders/STLLoader.js");
          const geometry = new STLLoader().parse(bytes);
          geometry.computeVertexNormals();
          root = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0xb8c4d0, roughness: 0.6, metalness: 0.1 }));
        }
        if (disposed || !hostRef.current) return;
        const host = hostRef.current;

        // OBJ・STL で色のないものは、見やすい灰色に
        const materials = new Set<import("three").Material>();
        const textures = new Set<import("three").Texture>();
        let vertices = 0;
        let triangles = 0;
        root.traverse((o) => {
          const mesh = o as import("three").Mesh;
          if (!mesh.isMesh) return;
          const g = mesh.geometry as import("three").BufferGeometry;
          const count = g.attributes.position?.count ?? 0;
          vertices += count;
          triangles += g.index ? g.index.count / 3 : count / 3;
          const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const m of list) {
            if (!m) continue;
            materials.add(m);
            for (const key of ["map", "normalMap", "roughnessMap", "metalnessMap", "emissiveMap", "aoMap"]) {
              const t = (m as unknown as Record<string, unknown>)[key];
              if (t && (t as import("three").Texture).isTexture) textures.add(t as import("three").Texture);
            }
          }
        });

        const scene = new THREE.Scene();
        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setPixelRatio(window.devicePixelRatio || 1);
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        host.appendChild(renderer.domElement);
        // このあとで失敗しても、描く道具（WebGL）を残さない（最後まで進めば、下で全部を片づけるものに入れ替える）
        cleanup = () => {
          renderer.dispose();
          renderer.forceContextLoss();
          renderer.domElement.remove();
        };
        const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 10000);
        const hemi = new THREE.HemisphereLight(0xffffff, 0x445566, 1.2);
        const sun = new THREE.DirectionalLight(0xffffff, 1.6);
        sun.position.set(3, 6, 4);
        scene.add(hemi, sun, root);

        // 大きさを測って、床と、カメラの位置を決める
        const box = new THREE.Box3().setFromObject(root);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const radius = Math.max(size.x, size.y, size.z, 0.001);
        const gridHelper = new THREE.GridHelper(radius * 4, 20, 0x5a6472, 0x3a424c);
        gridHelper.position.set(center.x, box.min.y, center.z);
        scene.add(gridHelper);
        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        const home = () => {
          camera.position.set(center.x + radius * 1.2, center.y + radius * 0.8, center.z + radius * 1.6);
          camera.near = radius / 100;
          camera.far = radius * 100;
          camera.updateProjectionMatrix();
          controls.target.copy(center);
          controls.update();
        };
        home();

        const mixer = clips.length ? new THREE.AnimationMixer(root) : null;
        let action: import("three").AnimationAction | null = null;
        // 描き直しが要るか（動かした・見た目を変えた・大きさが変わった）。止まっている見本は描き直さない
        let dirty = true;
        const need = () => {
          dirty = true;
        };
        controls.addEventListener("change", need);
        const resize = () => {
          const w = host.clientWidth;
          const h = host.clientHeight;
          renderer.setSize(w, h);
          camera.aspect = w / Math.max(1, h);
          camera.updateProjectionMatrix();
          need();
        };
        const ro = new ResizeObserver(resize);
        ro.observe(host);
        resize();
        const clock = new THREE.Clock();
        let raf = 0;
        const loop = () => {
          raf = requestAnimationFrame(loop);
          const dt = clock.getDelta();
          // だれも操作していない（窓が前面にない・隠れている）あいだは描かない
          if (isIdle()) return;
          const playing = !!(mixer && action && mixer.timeScale !== 0);
          if (playing) mixer?.update(dt);
          // 指を離したあとのすべり（ダンピング）と自動回転のあいだは、update() が true を返す
          const moved = controls.update();
          if (playing || moved || dirty) {
            renderer.render(scene, camera);
            dirty = false;
          }
        };
        raf = requestAnimationFrame(loop);

        apiRef.current = {
          setWire: (on) => { materials.forEach((m) => { (m as import("three").MeshStandardMaterial).wireframe = on; }); need(); },
          setGrid: (on) => { gridHelper.visible = on; need(); },
          setSpin: (on) => { controls.autoRotate = on; need(); },
          setLight: (v) => { hemi.intensity = 1.2 * v; sun.intensity = 1.6 * v; need(); },
          setBg: (b) => { renderer.setClearColor(b === "dark" ? 0x10141a : 0xf2f4f7, 1); need(); },
          reset: () => { home(); need(); },
          play: (name) => {
            action?.stop();
            action = null;
            const clip = clips.find((c) => c.name === name);
            if (mixer && clip) {
              action = mixer.clipAction(clip);
              action.play();
            }
            need();
          },
          setSpeed: (v) => { if (mixer) mixer.timeScale = v; need(); },
        };
        apiRef.current.setBg("dark");
        const names = clips.map((c, i) => c.name || `アニメーション ${i + 1}`);
        clips.forEach((c, i) => { c.name = names[i]; });
        if (names.length) {
          apiRef.current.play(names[0]);
          setAnim(names[0]);
        }
        const s: Stats = {
          vertices,
          triangles: Math.round(triangles),
          materials: materials.size,
          textures: textures.size,
          size: `${size.x.toFixed(2)} × ${size.y.toFixed(2)} × ${size.z.toFixed(2)}`,
          animations: names,
        };
        setStats(s);
        onInfo?.(`${vertices.toLocaleString()} 頂点 ・ ${Math.round(triangles).toLocaleString()} 三角形`);
        setLoading(false);

        cleanup = () => {
          cancelAnimationFrame(raf);
          ro.disconnect();
          controls.removeEventListener("change", need);
          controls.dispose();
          root.traverse((o) => {
            const mesh = o as import("three").Mesh;
            if (mesh.isMesh) mesh.geometry?.dispose();
          });
          materials.forEach((m) => m.dispose());
          textures.forEach((t) => t.dispose());
          gridHelper.geometry.dispose();
          (Array.isArray(gridHelper.material) ? gridHelper.material : [gridHelper.material]).forEach((m) => m.dispose());
          renderer.dispose();
          renderer.forceContextLoss();
          renderer.domElement.remove();
        };
      } catch (e) {
        if (!disposed) {
          setLoading(false);
          const msg = String(e);
          setError(
            extOf(path) === "gltf" && /buffer|uri|fetch/i.test(msg)
              ? "この .gltf は、別のファイル（.bin・画像）を使っています。1 つにまとめた .glb なら、ここで見られます"
              : `読めませんでした: ${msg}`,
          );
        }
      }
    })();
    return () => {
      disposed = true;
      cleanup?.();
      apiRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bytes, path]);

  useEffect(() => apiRef.current?.setWire(wire), [wire]);
  useEffect(() => apiRef.current?.setGrid(grid), [grid]);
  useEffect(() => apiRef.current?.setSpin(spin), [spin]);
  useEffect(() => apiRef.current?.setLight(light), [light]);
  useEffect(() => apiRef.current?.setBg(bg), [bg]);
  useEffect(() => apiRef.current?.setSpeed(speed), [speed]);

  return (
    <div className="mv-main">
      <div className="mv-stage mv-3d">
        <div ref={hostRef} className="mv-3d-host" />
        <div className="mv-toolbar">
          <button type="button" className={`btn-sm${!wire ? " on" : ""}`} onClick={() => setWire(false)}>そのまま</button>
          <button type="button" className={`btn-sm${wire ? " on" : ""}`} onClick={() => setWire(true)}>ワイヤー</button>
          <button type="button" className={`btn-sm${grid ? " on" : ""}`} aria-pressed={grid} onClick={() => setGrid(!grid)}>床の格子</button>
          <button type="button" className={`btn-sm${spin ? " on" : ""}`} aria-pressed={spin} onClick={() => setSpin(!spin)}>自動で回す</button>
          <button type="button" className="btn-sm" onClick={() => apiRef.current?.reset()}>↺ はじめの向き</button>
        </div>
        {loading && <p className="mv-note center"><i className="spinner" aria-hidden="true" /> 読み込んでいます…</p>}
        {error && <p className="mv-note center error">{error}</p>}
        <div className="mv-hint">ドラッグで回す ・ ホイールで寄る ・ 右ドラッグで動かす</div>
      </div>
      <div className="mv-panel">
        {stats && stats.animations.length > 0 && (
          <>
            <h4>アニメーション</h4>
            <div className="mv-row wrap">
              {stats.animations.map((name) => (
                <button key={name} type="button" className={`btn-sm${anim === name ? " on" : ""}`}
                  onClick={() => { const next = anim === name ? null : name; setAnim(next); apiRef.current?.play(next); }}>
                  {anim === name ? "⏸ " : "▶ "}{name}
                </button>
              ))}
            </div>
            <label className="mv-row">
              <span className="mv-label">速さ</span>
              <input type="range" min={0.1} max={3} step={0.1} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} className="grow" />
              <span className="mv-num-out">{speed.toFixed(1)}×</span>
            </label>
          </>
        )}
        <h4>明るさ</h4>
        <label className="mv-row">
          <span className="mv-label">光</span>
          <input type="range" min={0.2} max={2.5} step={0.1} value={light} onChange={(e) => setLight(Number(e.target.value))} className="grow" />
        </label>
        <div className="mv-row">
          <span className="mv-label">背景</span>
          <button type="button" className={`btn-sm${bg === "dark" ? " on" : ""}`} onClick={() => setBg("dark")}>暗い</button>
          <button type="button" className={`btn-sm${bg === "light" ? " on" : ""}`} onClick={() => setBg("light")}>明るい</button>
        </div>
        {stats && (
          <>
            <h4>情報</h4>
            <dl className="mv-info">
              <dt>形式</dt><dd>{extOf(path).toUpperCase()}</dd>
              <dt>頂点</dt><dd>{stats.vertices.toLocaleString()}</dd>
              <dt>三角形</dt><dd>{stats.triangles.toLocaleString()}</dd>
              <dt>マテリアル</dt><dd>{stats.materials}</dd>
              <dt>テクスチャ</dt><dd>{stats.textures}</dd>
              <dt>大きさ</dt><dd>{stats.size}</dd>
              <dt>アニメーション</dt><dd>{stats.animations.length}</dd>
            </dl>
          </>
        )}
      </div>
    </div>
  );
}
