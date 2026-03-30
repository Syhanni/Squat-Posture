// ---- DOM Elements ----
const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const btnStart = document.getElementById('btn-start');
const btnStop = document.getElementById('btn-stop');
const statusText = document.getElementById('status-text');
const statusDot = document.getElementById('status-dot');
const repCountEl = document.getElementById('rep-count');
const kneeAngleEl = document.getElementById('knee-angle');
const hipAngleEl = document.getElementById('hip-angle');
const formScoreEl = document.getElementById('form-score');
const injuryScoreEl = document.getElementById('injury-score');
const feedbackRoll = document.getElementById('feedback-roll');
const depthBar = document.getElementById('depth-bar');
const formBorder = document.getElementById('form-border');
const landing = document.getElementById('landing');
const tracker = document.getElementById('tracker');
const btnHistory = document.getElementById('btn-history');
const historyPanel = document.getElementById('history-panel');
const btnCloseHistory = document.getElementById('btn-close-history');
const historyList = document.getElementById('history-list');
const programStatusEl = document.getElementById('program-status');
const restOverlay = document.getElementById('rest-overlay');
const restTimerEl = document.getElementById('rest-timer');
const btnSkipRest = document.getElementById('btn-skip-rest');
const completeOverlay = document.getElementById('complete-overlay');
const completeSummary = document.getElementById('complete-summary');
const btnFinish = document.getElementById('btn-finish');
const exampleCanvas = document.getElementById('example-canvas');

// ---- Pose detection state ----
let detector = null;
let animationId = null;
let stream = null;

// ---- Squat tracking state ----
let repCount = 0;
let squatPhase = 'standing';
let minKneeAngle = 180;
let frameHistory = [];
const HISTORY_SIZE = 10;

// Per-rep feedback accumulator
let currentRepFeedback = [];
let currentRepInjuryFactors = [];
let repHistory = [];

// Rolling feedback
const MAX_ROLL_ITEMS = 8;
let rollItems = [];

// ---- Set/Rep programming ----
let programSets = 5;
let programReps = 5;
let programRest = 90;
let currentSet = 1;
let setRepCount = 0;
let restTimerId = null;
let audioEnabled = true;

// ---- Audio cues ----
let lastAudioCue = '';
let lastAudioTime = 0;
const AUDIO_COOLDOWN = 2500; // ms between same cue

function speak(text) {
  if (!audioEnabled) return;
  const now = Date.now();
  if (text === lastAudioCue && now - lastAudioTime < AUDIO_COOLDOWN) return;
  lastAudioCue = text;
  lastAudioTime = now;
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.1;
  u.pitch = 1.0;
  u.volume = 1.0;
  speechSynthesis.speak(u);
}

// ---- Injury risk scoring ----
// Factors: knee cave, forward lean, knee-over-toe, depth issues, asymmetry
// Each factor adds points. 0-2 = Low, 3-5 = Moderate, 6+ = High

function computeInjuryRisk(factors) {
  let score = 0;
  for (const f of factors) {
    if (f === 'knee_cave') score += 3;
    else if (f === 'forward_lean') score += 2;
    else if (f === 'knee_forward') score += 2;
    else if (f === 'too_deep') score += 1;
    else if (f === 'shallow') score += 1;
  }
  if (score <= 2) return { label: 'Low', level: 'low' };
  if (score <= 5) return { label: 'Med', level: 'med' };
  return { label: 'High', level: 'high' };
}

// ---- Keypoints ----
const KEYPOINTS = {
  NOSE: 0,
  LEFT_SHOULDER: 5, RIGHT_SHOULDER: 6,
  LEFT_ELBOW: 7, RIGHT_ELBOW: 8,
  LEFT_WRIST: 9, RIGHT_WRIST: 10,
  LEFT_HIP: 11, RIGHT_HIP: 12,
  LEFT_KNEE: 13, RIGHT_KNEE: 14,
  LEFT_ANKLE: 15, RIGHT_ANKLE: 16,
};

const SKELETON_CONNECTIONS = [
  [KEYPOINTS.LEFT_SHOULDER, KEYPOINTS.RIGHT_SHOULDER],
  [KEYPOINTS.LEFT_SHOULDER, KEYPOINTS.LEFT_ELBOW],
  [KEYPOINTS.LEFT_ELBOW, KEYPOINTS.LEFT_WRIST],
  [KEYPOINTS.RIGHT_SHOULDER, KEYPOINTS.RIGHT_ELBOW],
  [KEYPOINTS.RIGHT_ELBOW, KEYPOINTS.RIGHT_WRIST],
  [KEYPOINTS.LEFT_SHOULDER, KEYPOINTS.LEFT_HIP],
  [KEYPOINTS.RIGHT_SHOULDER, KEYPOINTS.RIGHT_HIP],
  [KEYPOINTS.LEFT_HIP, KEYPOINTS.RIGHT_HIP],
  [KEYPOINTS.LEFT_HIP, KEYPOINTS.LEFT_KNEE],
  [KEYPOINTS.LEFT_KNEE, KEYPOINTS.LEFT_ANKLE],
  [KEYPOINTS.RIGHT_HIP, KEYPOINTS.RIGHT_KNEE],
  [KEYPOINTS.RIGHT_KNEE, KEYPOINTS.RIGHT_ANKLE],
];

// UC Berkeley colors
const COLORS = {
  skeleton: '#FDB515',
  jointGood: '#FDB515',
  jointWarn: '#EE8800',
  jointBad: '#C4122F',
};

// ---- Utility ----

function angle(a, b, c) {
  const rad = Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(a.y - b.y, a.x - b.x);
  let deg = Math.abs((rad * 180) / Math.PI);
  if (deg > 180) deg = 360 - deg;
  return deg;
}

function kp2xy(kp) { return { x: kp.x, y: kp.y }; }
function isOk(kp, t = 0.3) { return kp.score >= t; }

// ---- Rolling feedback ----

function addRollItem(text, type) {
  const now = new Date();
  const ts = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  rollItems.push({ text, type, ts });
  if (rollItems.length > MAX_ROLL_ITEMS) rollItems.shift();
  renderRoll();
}

function renderRoll() {
  feedbackRoll.innerHTML = rollItems
    .map((item, i) => {
      const opacity = 0.4 + 0.6 * ((i + 1) / rollItems.length);
      return `<div class="roll-item roll-${item.type}" style="opacity:${opacity}">
        <span class="roll-ts">${item.ts}</span> ${item.text}
      </div>`;
    })
    .join('');
  feedbackRoll.scrollTop = feedbackRoll.scrollHeight;
}

// ---- Rep history ----

function saveRepHistory(formRating) {
  const seen = new Set();
  const unique = currentRepFeedback.filter((f) => {
    if (seen.has(f.text)) return false;
    seen.add(f.text);
    return true;
  });

  const injury = computeInjuryRisk(currentRepInjuryFactors);

  const entry = {
    rep: repCount,
    set: currentSet,
    formRating,
    injuryRisk: injury,
    minDepthAngle: Math.round(minKneeAngle),
    feedback: unique,
    time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
  };
  repHistory.push(entry);
  currentRepFeedback = [];
  currentRepInjuryFactors = [];
  renderHistory();

  const rollType = formRating === 'Good' ? 'good' : formRating === 'Fair' ? 'warn' : 'bad';
  addRollItem(`Rep #${setRepCount}/${programReps} — ${formRating} (Risk: ${injury.label})`, rollType);
}

function renderHistory() {
  if (repHistory.length === 0) {
    historyList.innerHTML = '<p class="history-empty">Complete a squat to see feedback here.</p>';
    return;
  }
  historyList.innerHTML = repHistory
    .slice()
    .reverse()
    .map((entry) => {
      const depthLabel = entry.minDepthAngle < 70 ? 'Deep' : entry.minDepthAngle < 100 ? 'Parallel' : 'Shallow';
      const feedbackHtml = entry.feedback.length > 0
        ? entry.feedback.map((f) => `<div class="hist-fb hist-fb-${f.type}">${f.text}</div>`).join('')
        : '<div class="hist-fb hist-fb-good">No issues detected</div>';
      return `<div class="hist-entry hist-entry-${entry.formRating.toLowerCase()}">
        <div class="hist-header">
          <span class="hist-rep">Set ${entry.set} Rep #${entry.rep}</span>
          <span class="hist-rating hist-rating-${entry.formRating.toLowerCase()}">${entry.formRating}</span>
          <span class="hist-injury hist-injury-${entry.injuryRisk.level}">Risk: ${entry.injuryRisk.label}</span>
          <span class="hist-time">${entry.time}</span>
        </div>
        <div class="hist-meta">Depth: ${depthLabel} (${entry.minDepthAngle}°)</div>
        <div class="hist-feedback">${feedbackHtml}</div>
      </div>`;
    })
    .join('');
}

// ---- Set/Rep management ----

function updateProgramStatus() {
  programStatusEl.textContent = `Set ${currentSet}/${programSets} \u00B7 Rep ${setRepCount}/${programReps}`;
}

function onRepCompleted() {
  setRepCount++;
  updateProgramStatus();

  if (setRepCount >= programReps) {
    // Set complete
    speak(`Set ${currentSet} complete`);
    addRollItem(`Set ${currentSet} complete!`, 'good');

    if (currentSet >= programSets) {
      // Workout done
      showWorkoutComplete();
      return;
    }

    // Start rest timer
    startRestTimer();
  } else {
    const remaining = programReps - setRepCount;
    if (remaining === 1) speak('One more rep');
  }
}

function startRestTimer() {
  let remaining = programRest;
  restOverlay.classList.remove('hidden');
  restTimerEl.textContent = remaining;

  restTimerId = setInterval(() => {
    remaining--;
    restTimerEl.textContent = remaining;
    if (remaining === 5) speak('5 seconds');
    if (remaining <= 0) {
      endRestTimer();
    }
  }, 1000);
}

function endRestTimer() {
  if (restTimerId) { clearInterval(restTimerId); restTimerId = null; }
  restOverlay.classList.add('hidden');
  currentSet++;
  setRepCount = 0;
  updateProgramStatus();
  speak(`Set ${currentSet}, let's go`);
  addRollItem(`Set ${currentSet} — Ready`, 'info');
}

function showWorkoutComplete() {
  const totalReps = repHistory.length;
  const goodReps = repHistory.filter(r => r.formRating === 'Good').length;
  const avgInjury = repHistory.reduce((sum, r) => {
    const s = r.injuryRisk.level === 'low' ? 1 : r.injuryRisk.level === 'med' ? 2 : 3;
    return sum + s;
  }, 0) / (totalReps || 1);
  const avgLabel = avgInjury <= 1.5 ? 'Low' : avgInjury <= 2.5 ? 'Moderate' : 'High';

  completeSummary.innerHTML = `
    <div class="cs-row"><span>Total Reps</span><span>${totalReps}</span></div>
    <div class="cs-row"><span>Good Form</span><span>${goodReps}/${totalReps}</span></div>
    <div class="cs-row"><span>Avg Injury Risk</span><span>${avgLabel}</span></div>
    <div class="cs-row"><span>Sets Completed</span><span>${programSets}</span></div>
  `;
  completeOverlay.classList.remove('hidden');
  speak('Workout complete. Great job!');
}

// ---- Drawing ----

function drawSkeleton(keypoints, issues) {
  for (const [i, j] of SKELETON_CONNECTIONS) {
    const a = keypoints[i], b = keypoints[j];
    if (!isOk(a) || !isOk(b)) continue;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = COLORS.skeleton;
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  for (let i = 0; i < keypoints.length; i++) {
    const kp = keypoints[i];
    if (!isOk(kp)) continue;
    let color = COLORS.jointGood;
    if ((i === KEYPOINTS.LEFT_KNEE || i === KEYPOINTS.RIGHT_KNEE) && issues.kneeIssue) color = COLORS.jointBad;
    if ((i === KEYPOINTS.LEFT_HIP || i === KEYPOINTS.RIGHT_HIP) && issues.hipIssue) color = COLORS.jointWarn;
    ctx.beginPath();
    ctx.arc(kp.x, kp.y, 6, 0, 2 * Math.PI);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = '#003262';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

function drawAngleLabel(vertex, angleDeg, label, color) {
  if (!vertex) return;
  ctx.save();
  ctx.font = 'bold 14px monospace';
  ctx.fillStyle = color;
  const offsetX = vertex.x > canvas.width / 2 ? -60 : 10;
  ctx.fillText(`${label}: ${Math.round(angleDeg)}°`, vertex.x + offsetX, vertex.y - 15);
  ctx.restore();
}

// ---- Form analysis ----

let lastFormRating = 'Good';

function analyzeForm(keypoints) {
  const feedback = [];
  const injuryFactors = [];
  const issues = { kneeIssue: false, hipIssue: false };
  let formRating = 'Good';

  const lHip = keypoints[KEYPOINTS.LEFT_HIP], rHip = keypoints[KEYPOINTS.RIGHT_HIP];
  const lKnee = keypoints[KEYPOINTS.LEFT_KNEE], rKnee = keypoints[KEYPOINTS.RIGHT_KNEE];
  const lAnkle = keypoints[KEYPOINTS.LEFT_ANKLE], rAnkle = keypoints[KEYPOINTS.RIGHT_ANKLE];
  const lShoulder = keypoints[KEYPOINTS.LEFT_SHOULDER], rShoulder = keypoints[KEYPOINTS.RIGHT_SHOULDER];

  const useLeft = (lHip.score + lKnee.score + lAnkle.score) >= (rHip.score + rKnee.score + rAnkle.score);
  const hip = useLeft ? lHip : rHip;
  const knee = useLeft ? lKnee : rKnee;
  const ankle = useLeft ? lAnkle : rAnkle;
  const shoulder = useLeft ? lShoulder : rShoulder;

  if (!isOk(hip) || !isOk(knee) || !isOk(ankle)) {
    return { kneeAngle: null, hipAngle: null, feedback: [], injuryFactors: [], issues, formRating: '--', depth: 0 };
  }

  const kneeAngle = angle(kp2xy(hip), kp2xy(knee), kp2xy(ankle));
  let hipAngle = null;
  if (isOk(shoulder)) {
    hipAngle = angle(kp2xy(shoulder), kp2xy(hip), kp2xy(knee));
  }

  const depth = Math.max(0, Math.min(100, ((180 - kneeAngle) / 120) * 100));

  // Phase detection
  frameHistory.push(kneeAngle);
  if (frameHistory.length > HISTORY_SIZE) frameHistory.shift();
  const avgAngle = frameHistory.reduce((a, b) => a + b, 0) / frameHistory.length;

  if (squatPhase === 'standing' && avgAngle < 150) {
    squatPhase = 'descending';
    minKneeAngle = avgAngle;
    currentRepFeedback = [];
    currentRepInjuryFactors = [];
    lastFormRating = 'Good';
    addRollItem('Squat started', 'info');
  } else if (squatPhase === 'descending') {
    if (avgAngle < minKneeAngle) minKneeAngle = avgAngle;
    if (avgAngle < 110) squatPhase = 'bottom';
  } else if (squatPhase === 'bottom') {
    if (avgAngle < minKneeAngle) minKneeAngle = avgAngle;
    if (avgAngle > 130) squatPhase = 'ascending';
  } else if (squatPhase === 'ascending' && avgAngle > 160) {
    if (minKneeAngle < 120) {
      repCount++;
      repCountEl.textContent = repCount;
      saveRepHistory(lastFormRating);
      onRepCompleted();
    }
    squatPhase = 'standing';
    minKneeAngle = 180;
  }

  // Form checks
  if (isOk(lKnee) && isOk(rKnee) && isOk(lAnkle) && isOk(rAnkle)) {
    const kneeW = Math.abs(lKnee.x - rKnee.x);
    const ankleW = Math.abs(lAnkle.x - rAnkle.x);
    if (kneeW < ankleW * 0.75 && kneeAngle < 140) {
      feedback.push({ text: 'Knees caving inward — push knees out', type: 'warn' });
      injuryFactors.push('knee_cave');
      issues.kneeIssue = true;
      formRating = 'Fair';
      speak('Knees out');
    }
  }

  if (isOk(shoulder) && kneeAngle < 140) {
    const lean = shoulder.x - hip.x;
    const ref = Math.abs(hip.y - ankle.y);
    if (Math.abs(lean) > ref * 0.5) {
      feedback.push({ text: 'Excessive forward lean — chest up', type: 'warn' });
      injuryFactors.push('forward_lean');
      issues.hipIssue = true;
      formRating = 'Fair';
      speak('Chest up');
    }
  }

  if (squatPhase === 'bottom' || squatPhase === 'ascending') {
    if (minKneeAngle > 120) {
      feedback.push({ text: 'Go deeper — aim for parallel', type: 'info' });
      injuryFactors.push('shallow');
      speak('Go deeper');
    } else if (minKneeAngle < 70) {
      feedback.push({ text: 'Great depth — keep lower back neutral', type: 'info' });
      injuryFactors.push('too_deep');
    }
  }

  if (kneeAngle < 140 && isOk(knee) && isOk(ankle)) {
    const fwd = knee.x - ankle.x;
    const shin = Math.abs(knee.y - ankle.y);
    if (Math.abs(fwd) > shin * 0.8) {
      feedback.push({ text: 'Knees too far forward — sit back more', type: 'warn' });
      injuryFactors.push('knee_forward');
      issues.kneeIssue = true;
      if (formRating === 'Good') formRating = 'Fair';
      speak('Sit back');
    }
  }

  if (feedback.length === 0 && squatPhase !== 'standing') {
    feedback.push({ text: 'Form looks good!', type: 'good' });
  }

  const warns = feedback.filter((f) => f.type === 'warn').length;
  if (warns >= 2) formRating = 'Poor';

  // Accumulate for current rep
  if (squatPhase !== 'standing') {
    for (const f of feedback) {
      if (f.type === 'warn' || f.type === 'info') currentRepFeedback.push(f);
    }
    for (const f of injuryFactors) currentRepInjuryFactors.push(f);
    if (formRating === 'Poor') lastFormRating = 'Poor';
    else if (formRating === 'Fair' && lastFormRating !== 'Poor') lastFormRating = 'Fair';
  }

  // Rolling feed warnings
  for (const f of feedback) {
    if (f.type === 'warn') {
      const last = rollItems[rollItems.length - 1];
      if (!last || last.text !== f.text) addRollItem(f.text, 'warn');
    }
  }

  return { kneeAngle, hipAngle, feedback, injuryFactors, issues, formRating, depth };
}

// ---- Main loop ----

async function detect() {
  if (!detector || !video.readyState || video.readyState < 2) {
    animationId = requestAnimationFrame(detect);
    return;
  }

  if (canvas.width !== window.innerWidth || canvas.height !== window.innerHeight) {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }

  const poses = await detector.estimatePoses(video);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const vw = video.videoWidth, vh = video.videoHeight;
  const cw = canvas.width, ch = canvas.height;
  const scale = Math.max(cw / vw, ch / vh);
  const sw = vw * scale, sh = vh * scale;
  const ox = (cw - sw) / 2, oy = (ch - sh) / 2;
  ctx.drawImage(video, ox, oy, sw, sh);

  if (poses.length > 0) {
    const keypoints = poses[0].keypoints;
    for (const kp of keypoints) {
      kp.x = kp.x * scale + ox;
      kp.y = kp.y * scale + oy;
    }

    const analysis = analyzeForm(keypoints);
    drawSkeleton(keypoints, analysis.issues);

    const useLeft = (keypoints[KEYPOINTS.LEFT_HIP].score + keypoints[KEYPOINTS.LEFT_KNEE].score) >=
      (keypoints[KEYPOINTS.RIGHT_HIP].score + keypoints[KEYPOINTS.RIGHT_KNEE].score);
    const hip = keypoints[useLeft ? KEYPOINTS.LEFT_HIP : KEYPOINTS.RIGHT_HIP];
    const knee = keypoints[useLeft ? KEYPOINTS.LEFT_KNEE : KEYPOINTS.RIGHT_KNEE];
    const ankle = keypoints[useLeft ? KEYPOINTS.LEFT_ANKLE : KEYPOINTS.RIGHT_ANKLE];
    const shoulder = keypoints[useLeft ? KEYPOINTS.LEFT_SHOULDER : KEYPOINTS.RIGHT_SHOULDER];

    if (analysis.kneeAngle !== null) {
      drawAngleLabel(kp2xy(knee), analysis.kneeAngle, 'Knee', '#FDB515');
      kneeAngleEl.textContent = `${Math.round(analysis.kneeAngle)}°`;
    }
    if (analysis.hipAngle !== null) {
      drawAngleLabel(kp2xy(hip), analysis.hipAngle, 'Hip', '#3B7EA1');
      hipAngleEl.textContent = `${Math.round(analysis.hipAngle)}°`;
    }

    formScoreEl.textContent = analysis.formRating;
    formScoreEl.className = 'hud-value form-' + analysis.formRating.toLowerCase();

    // Injury risk display
    const injury = computeInjuryRisk(analysis.injuryFactors);
    injuryScoreEl.textContent = injury.label;
    injuryScoreEl.className = 'hud-value injury-' + injury.level;

    // Border
    const borderMap = { Good: 'border-good', Fair: 'border-fair', Poor: 'border-poor' };
    formBorder.className = 'form-border ' + (borderMap[analysis.formRating] || 'border-none');

    depthBar.style.height = `${analysis.depth}%`;
    depthBar.className = 'hud-depth-bar' +
      (analysis.depth > 70 ? ' depth-deep' : analysis.depth > 40 ? ' depth-parallel' : ' depth-standing');

    const phaseLabels = { standing: 'Standing', descending: 'Going Down', bottom: 'At Bottom', ascending: 'Coming Up' };
    statusText.textContent = phaseLabels[squatPhase] || 'Tracking';
    statusDot.className = 'status-dot active';
  } else {
    statusText.textContent = 'No person detected';
    statusDot.className = 'status-dot';
    formBorder.className = 'form-border border-none';
  }

  animationId = requestAnimationFrame(detect);
}

// ---- Fullscreen ----

function enterFullscreen() {
  const el = document.documentElement;
  if (el.requestFullscreen) el.requestFullscreen();
  else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
}

function exitFullscreen() {
  if (document.exitFullscreen) document.exitFullscreen();
  else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
}

// ---- Camera & model ----

async function initDetector() {
  statusText.textContent = 'Loading AI model...';
  const model = poseDetection.SupportedModels.MoveNet;
  detector = await poseDetection.createDetector(model, {
    modelType: poseDetection.movenet.modelType.SINGLEPOSE_THUNDER,
  });
  statusText.textContent = 'Model loaded';
}

async function startSession() {
  try {
    // Read program config
    programSets = parseInt(document.getElementById('input-sets').value) || 5;
    programReps = parseInt(document.getElementById('input-reps').value) || 5;
    programRest = parseInt(document.getElementById('input-rest').value) || 90;
    audioEnabled = document.getElementById('input-audio').checked;
    currentSet = 1;
    setRepCount = 0;

    landing.classList.add('hidden');
    tracker.classList.remove('hidden');
    completeOverlay.classList.add('hidden');
    restOverlay.classList.add('hidden');
    updateProgramStatus();

    enterFullscreen();

    statusText.textContent = 'Requesting camera...';
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();

    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    if (!detector) await initDetector();

    statusText.textContent = 'Tracking';
    statusDot.className = 'status-dot active';
    animationId = requestAnimationFrame(detect);

    if (audioEnabled) speak(`${programSets} sets of ${programReps}. Let's go.`);
  } catch (err) {
    statusText.textContent = `Error: ${err.message}`;
    console.error(err);
  }
}

function stopSession() {
  if (animationId) { cancelAnimationFrame(animationId); animationId = null; }
  if (restTimerId) { clearInterval(restTimerId); restTimerId = null; }
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  video.srcObject = null;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  speechSynthesis.cancel();

  exitFullscreen();

  tracker.classList.add('hidden');
  landing.classList.remove('hidden');

  repCount = 0;
  squatPhase = 'standing';
  minKneeAngle = 180;
  frameHistory = [];
  currentRepFeedback = [];
  currentRepInjuryFactors = [];
  repHistory = [];
  rollItems = [];
  lastFormRating = 'Good';
  repCountEl.textContent = '0';
  kneeAngleEl.textContent = '--°';
  hipAngleEl.textContent = '--°';
  formScoreEl.textContent = '--';
  injuryScoreEl.textContent = '--';
  feedbackRoll.innerHTML = '';
  historyList.innerHTML = '<p class="history-empty">Complete a squat to see feedback here.</p>';
}

document.addEventListener('fullscreenchange', () => {});

// ---- Perfect form skeleton animation on landing ----

function drawExampleSkeleton() {
  const c = exampleCanvas;
  const x = c.getContext('2d');
  const W = c.width, H = c.height;
  let t = 0;

  function lerp(a, b, p) { return a + (b - a) * p; }

  // Standing pose keypoints (x, y) normalized
  const stand = {
    head: [140, 30],
    neck: [140, 55],
    lShoulder: [105, 60], rShoulder: [175, 60],
    lElbow: [85, 100], rElbow: [195, 100],
    lWrist: [80, 130], rWrist: [200, 130],
    lHip: [118, 145], rHip: [162, 145],
    lKnee: [115, 215], rKnee: [165, 215],
    lAnkle: [112, 290], rAnkle: [168, 290],
  };

  // Bottom squat pose
  const squat = {
    head: [140, 85],
    neck: [140, 110],
    lShoulder: [105, 115], rShoulder: [175, 115],
    lElbow: [80, 140], rElbow: [200, 140],
    lWrist: [75, 170], rWrist: [205, 170],
    lHip: [110, 195], rHip: [170, 195],
    lKnee: [90, 248], rKnee: [190, 248],
    lAnkle: [100, 300], rAnkle: [180, 300],
  };

  const bones = [
    ['lShoulder', 'rShoulder'],
    ['lShoulder', 'lElbow'], ['lElbow', 'lWrist'],
    ['rShoulder', 'rElbow'], ['rElbow', 'rWrist'],
    ['neck', 'lShoulder'], ['neck', 'rShoulder'],
    ['lHip', 'rHip'],
    ['lShoulder', 'lHip'], ['rShoulder', 'rHip'],
    ['lHip', 'lKnee'], ['lKnee', 'lAnkle'],
    ['rHip', 'rKnee'], ['rKnee', 'rAnkle'],
  ];

  function drawFrame() {
    x.clearRect(0, 0, W, H);

    // Smooth cycle: stand -> squat -> stand
    t += 0.008;
    const cycle = (Math.sin(t * Math.PI * 2) + 1) / 2; // 0..1..0

    const pose = {};
    for (const key of Object.keys(stand)) {
      pose[key] = [
        lerp(stand[key][0], squat[key][0], cycle),
        lerp(stand[key][1], squat[key][1], cycle),
      ];
    }

    // Draw bones
    x.strokeStyle = '#FDB515';
    x.lineWidth = 3;
    x.lineCap = 'round';
    for (const [a, b] of bones) {
      x.beginPath();
      x.moveTo(pose[a][0], pose[a][1]);
      x.lineTo(pose[b][0], pose[b][1]);
      x.stroke();
    }

    // Draw joints
    for (const key of Object.keys(pose)) {
      x.beginPath();
      x.arc(pose[key][0], pose[key][1], 5, 0, Math.PI * 2);
      x.fillStyle = '#FDB515';
      x.fill();
      x.strokeStyle = '#003262';
      x.lineWidth = 1.5;
      x.stroke();
    }

    // Draw head circle
    x.beginPath();
    x.arc(pose.head[0], pose.head[1], 14, 0, Math.PI * 2);
    x.fillStyle = 'rgba(253, 181, 21, 0.3)';
    x.fill();
    x.strokeStyle = '#FDB515';
    x.lineWidth = 2;
    x.stroke();

    // Angle labels
    const kneeAngle = angle(
      { x: pose.lHip[0], y: pose.lHip[1] },
      { x: pose.lKnee[0], y: pose.lKnee[1] },
      { x: pose.lAnkle[0], y: pose.lAnkle[1] }
    );
    x.font = 'bold 11px monospace';
    x.fillStyle = '#FDB515';
    x.fillText(`${Math.round(kneeAngle)}°`, pose.lKnee[0] - 35, pose.lKnee[1] + 5);

    requestAnimationFrame(drawFrame);
  }

  drawFrame();
}

// ---- Stepper buttons ----

document.querySelectorAll('.stepper-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const input = document.getElementById(btn.dataset.target);
    const dir = parseInt(btn.dataset.dir);
    let val = parseInt(input.value) + dir;
    val = Math.max(parseInt(input.min), Math.min(parseInt(input.max), val));
    input.value = val;
  });
});

// ---- Event listeners ----

btnStart.addEventListener('click', startSession);
btnStop.addEventListener('click', stopSession);
btnSkipRest.addEventListener('click', endRestTimer);
btnFinish.addEventListener('click', stopSession);

btnHistory.addEventListener('click', () => historyPanel.classList.toggle('hidden'));
btnCloseHistory.addEventListener('click', () => historyPanel.classList.add('hidden'));

// Start example animation on load
drawExampleSkeleton();
