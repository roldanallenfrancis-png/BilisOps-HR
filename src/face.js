import * as faceapi from '@vladmandic/face-api';

// ─── FACE RECOGNITION ─────────────────────────────────────────────────────────
// Models are self-hosted in public/models (copied from @vladmandic/face-api) so the
// kiosk keeps working with no internet after the app itself is loaded.
// Pipeline: TinyFaceDetector → 68-point tiny landmarks → 128-D descriptor, matched
// with Euclidean distance (threshold below).

export const MATCH_THRESHOLD = 0.5;   // ≤ this distance = same person
export const ENROLL_MIN_SAMPLES = 3;  // recommended minimum captures per employee

let modelsPromise = null;
export function loadFaceModels() {
  if (!modelsPromise) {
    modelsPromise = Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri('/models'),
      faceapi.nets.faceLandmark68TinyNet.loadFromUri('/models'),
      faceapi.nets.faceRecognitionNet.loadFromUri('/models'),
    ]).catch(err => { modelsPromise = null; throw err; }); // allow retry after a failed load
  }
  return modelsPromise;
}

// Detect the single most prominent face in the video/canvas and return
// { detection, landmarks, descriptor } or undefined when no face is found.
export function detectFace(input) {
  return faceapi
    .detectSingleFace(input, new faceapi.TinyFaceDetectorOptions({ inputSize:320, scoreThreshold:0.5 }))
    .withFaceLandmarks(true)
    .withFaceDescriptor();
}

// Build a matcher from employees that have enrolled face descriptors.
// Labels are employee IDs. Returns null when nobody is enrolled yet.
export function buildMatcher(employees) {
  const labeled = (employees||[])
    .filter(e => e.status==='active' && Array.isArray(e.faceDescriptors) && e.faceDescriptors.length>0)
    .map(e => new faceapi.LabeledFaceDescriptors(e.id, e.faceDescriptors.map(d => new Float32Array(d))));
  if (!labeled.length) return null;
  return new faceapi.FaceMatcher(labeled, MATCH_THRESHOLD);
}

export { faceapi };
