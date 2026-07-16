import { useState, useEffect, useRef } from "react";
import { loadFaceModels, detectFace } from "./face.js";

// ════════════════════════════════════════════════════════════════════════════
// FACE ENROLLMENT — guided auto-capture (Face ID style).
// The admin/employee just follows the on-screen prompts (look straight, turn
// left, turn right, straight again); each pose is detected from the 68 face
// landmarks and captured automatically — no button pressing.
// `value` is the stored array of 128-number descriptor arrays; `onChange`
// replaces it. Saving still happens via the modal's Save button.
// ════════════════════════════════════════════════════════════════════════════

// Head-turn (yaw) estimate from landmarks: how far the nose tip sits from the
// midpoint between the eyes, normalized by eye distance. ~0 facing the camera;
// positive when the head turns to the person's LEFT (raw, unmirrored image).
function yawOf(landmarks) {
  const p = landmarks.positions;
  const avg = pts => pts.reduce((a,q)=>({x:a.x+q.x/pts.length, y:a.y+q.y/pts.length}), {x:0,y:0});
  const le = avg(p.slice(36,42));   // person's right eye (image left)
  const re = avg(p.slice(42,48));   // person's left eye (image right)
  const nose = p[30];               // nose tip
  const eyeDist = Math.hypot(re.x-le.x, re.y-le.y) || 1;
  return (nose.x - (le.x+re.x)/2) / eyeDist;
}

const STEPS = [
  { key:"center",  icon:"🙂", label:"Look straight at the camera",          check:y=>Math.abs(y)<=0.06 },
  { key:"left",    icon:"↪️", label:"Turn your head slightly to your LEFT", check:y=>y>=0.09 },
  { key:"right",   icon:"↩️", label:"Turn your head slightly to your RIGHT",check:y=>y<=-0.09 },
  { key:"center2", icon:"🙂", label:"Look straight one more time",          check:y=>Math.abs(y)<=0.06 },
];
const HOLD_FRAMES = 2;      // pose must hold for 2 consecutive detections (~1s)
const STEP_TIMEOUT_MS = 8000; // never get stuck: after 8s with a face visible, capture anyway

export function FaceEnroll({ value, onChange }) {
  const samples = Array.isArray(value) ? value : [];
  const [status,setStatus]=useState("starting"); // starting | ready | error
  const [errMsg,setErrMsg]=useState("");
  const [faceSeen,setFaceSeen]=useState(false);
  const [stepIdx,setStepIdx]=useState(()=> (Array.isArray(value)&&value.length>=STEPS.length) ? STEPS.length : 0);
  const [flash,setFlash]=useState(false);
  const vidRef=useRef(null); const streamRef=useRef(null); const pollRef=useRef(null);
  const holdRef=useRef(0); const stepStartRef=useRef(Date.now());
  const pausedRef=useRef(false); const busyRef=useRef(false);
  // Live refs so the long-running interval never reads stale state.
  const samplesRef=useRef(samples); useEffect(()=>{ samplesRef.current=Array.isArray(value)?value:[]; },[value]);
  const onChangeRef=useRef(onChange); useEffect(()=>{ onChangeRef.current=onChange; },[onChange]);
  const stepIdxRef=useRef(stepIdx);   useEffect(()=>{ stepIdxRef.current=stepIdx; },[stepIdx]);

  useEffect(()=>{
    let cancelled=false;
    (async()=>{
      try {
        await loadFaceModels();
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera not supported in this browser.");
        let s; try{ s=await navigator.mediaDevices.getUserMedia({video:{facingMode:"user"}}); }catch{ s=await navigator.mediaDevices.getUserMedia({video:true}); }
        if (cancelled) { s.getTracks().forEach(t=>t.stop()); return; }
        streamRef.current=s;
        if (vidRef.current){ vidRef.current.srcObject=s; vidRef.current.play().catch(()=>{}); }
        setStatus("ready");
        stepStartRef.current=Date.now();
        pollRef.current=setInterval(async()=>{
          if(!vidRef.current||vidRef.current.readyState<2||busyRef.current) return;
          busyRef.current=true;
          try {
            const det=await detectFace(vidRef.current);
            setFaceSeen(!!det);
            const idx=stepIdxRef.current;
            if (!det) { holdRef.current=0; return; }
            if (pausedRef.current || idx>=STEPS.length) return;
            const ok=STEPS[idx].check(yawOf(det.landmarks));
            holdRef.current = ok ? holdRef.current+1 : 0;
            const timedOut = Date.now()-stepStartRef.current > STEP_TIMEOUT_MS;
            if (holdRef.current>=HOLD_FRAMES || timedOut) {
              // Capture this pose's descriptor and advance after a short pause
              onChangeRef.current([...samplesRef.current, Array.from(det.descriptor)]);
              setFlash(true); setTimeout(()=>setFlash(false),250);
              pausedRef.current=true; holdRef.current=0;
              setTimeout(()=>{ pausedRef.current=false; stepStartRef.current=Date.now(); setStepIdx(i=>i+1); },900);
            }
          } catch {}
          finally { busyRef.current=false; }
        },450);
      } catch(e) {
        if (cancelled) return;
        setStatus("error");
        setErrMsg(e?.name==="NotAllowedError"?"Camera permission denied.":e?.name==="NotFoundError"?"No camera found.":(e?.message||"Failed to start camera."));
      }
    })();
    return ()=>{
      cancelled=true;
      if (pollRef.current) clearInterval(pollRef.current);
      streamRef.current?.getTracks().forEach(t=>t.stop());
      streamRef.current=null;
    };
  },[]);

  const redo=()=>{ onChange([]); holdRef.current=0; pausedRef.current=false; stepStartRef.current=Date.now(); setStepIdx(0); };
  const done=stepIdx>=STEPS.length;
  const step=done?null:STEPS[stepIdx];

  return (
    <div className="space-y-4">
      {done?(
        <div className="text-xs px-4 py-3 rounded-2xl border bg-emerald-50 border-emerald-200 text-emerald-700 flex items-center justify-between gap-3">
          <span>✓ Enrollment complete — {samples.length} sample(s) captured. This employee can clock in with their face.</span>
          <button type="button" onClick={redo} className="shrink-0 px-3 py-1.5 rounded-lg border border-emerald-300 font-bold hover:bg-emerald-100">↻ Redo</button>
        </div>
      ):(
        <div className="text-xs px-4 py-3 rounded-2xl border bg-blue-50 border-blue-200 text-blue-700">
          Just follow the prompts — capture is automatic, no need to click anything. Step {Math.min(stepIdx+1,STEPS.length)} of {STEPS.length}.
        </div>
      )}

      {/* Step progress dots */}
      <div className="flex items-center justify-center gap-2">
        {STEPS.map((s,i)=>(
          <div key={s.key} className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold border transition-colors
            ${i<stepIdx?"bg-emerald-100 text-emerald-700 border-emerald-200":i===stepIdx&&!done?"bg-slate-800 text-white border-slate-800":"bg-gray-50 text-gray-400 border-gray-200"}`}>
            {i<stepIdx?"✓":s.icon}
          </div>
        ))}
      </div>

      <div className={`relative w-full aspect-video rounded-2xl overflow-hidden bg-black border-2 transition-colors ${flash?"border-emerald-400":done?"border-emerald-500/60":faceSeen?"border-sky-400/70":"border-gray-200"}`}>
        {status==="error"
          ? <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-white/60 text-sm p-6 text-center"><span className="text-4xl">📷</span>{errMsg}</div>
          : <video ref={vidRef} autoPlay playsInline muted className="w-full h-full object-cover -scale-x-100"/>}
        {status==="starting"&&<div className="absolute inset-0 flex items-center justify-center bg-black/60 text-white/70 text-sm">Loading face models…</div>}
        {status==="ready"&&!done&&(
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-4 text-center">
            <div className="text-white font-black text-base sm:text-lg drop-shadow">{step.icon} {step.label}</div>
            <div className="text-white/60 text-xs mt-0.5">{faceSeen?"Hold the pose — capturing automatically…":"Position your face inside the frame"}</div>
          </div>
        )}
        {status==="ready"&&done&&(
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-emerald-900/80 to-transparent p-4 text-center">
            <div className="text-white font-black text-lg drop-shadow">✓ All done!</div>
          </div>
        )}
        {status==="ready"&&(
          <div className={`absolute top-2 left-1/2 -translate-x-1/2 text-[10px] font-bold px-2.5 py-1 rounded-full ${faceSeen?"bg-emerald-500/90":"bg-amber-500/90"} text-white`}>
            {faceSeen?"● Face detected":"Looking for a face…"}
          </div>
        )}
        {flash&&<div className="absolute inset-0 bg-white/50"/>}
      </div>

      <p className="text-xs text-gray-400">Samples are stored as face measurements (numbers), not photos. Click "Save Changes" below to persist them.</p>
    </div>
  );
}
