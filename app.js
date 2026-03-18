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
const feedbackRoll = document.getElementById('feedback-roll');
const depthBar = document.getElementById('depth-bar');
const formBorder = document.getElementById('form-border');
const landing = document.getElementById('landing');
const tracker = document.getElementById('tracker');
const btnHistory = document.getElementById('btn-history');
const historyPanel = document.getElementById('history-panel');
const btnCloseHistory = document.getElementById('btn-close-history');
const historyList = document.getElementById('history-list');

// Pose detection state
let detector = null;
let animationId = null;
let stream = null;

// Squat tracking state
let repCount = 0;
let squatPhase = 'standing';
let minKneeAngle = 180;
let frameHistory = [];
const HISTORY_SIZE = 10;

// Per-rep feedback accumulator
let currentRepFeedback = [];
let repHistory = []; // Array of { rep, formRating, minDepthAngle, feedback[] }

// Rolling feedback log (recent items shown on screen)
const MAX_ROLL_ITEMS = 8;
let rollItems = [];

// Keypoint indices for MoveNet
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

const COLORS = {
  skeleton: '#00ff88',
  jointGood: '#00ff88',
  jointWarn: '#ffaa00',
  jointBad: '#ff3366',
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
  // Deduplicate feedback messages for this rep
  const seen = new Set();
  const unique = currentRepFeedback.filter((f) => {
    if (seen.has(f.text)) return false;
    seen.add(f.text);
    return true;
  });

  const entry = {
    rep: repCount,
    formRating,
    minDepthAngle: Math.round(minKneeAngle),
    feedback: unique,
    time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
  };
  repHistory.push(entry);
  currentRepFeedback = [];
  renderHistory();

  addRollItem(`Rep #${repCount} complete — ${formRating}`, formRating === 'Good' ? 'good' : formRating === 'Fair' ? 'warn' : 'bad');
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
          <span class="hist-rep">Rep #${entry.rep}</span>
          <span class="hist-rating hist-rating-${entry.formRating.toLowerCase()}">${entry.formRating}</span>
          <span class="hist-time">${entry.time}</span>
        </div>
        <div class="hist-meta">Depth: ${depthLabel} (${entry.minDepthAngle}°)</div>
        <div class="hist-feedback">${feedbackHtml}</div>
      </div>`;
    })
    .join('');
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
    ctx.strokeStyle = '#000';
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

let lastFormRating = 'Good'; // Track across frames for rep save

function analyzeForm(keypoints) {
  const feedback = [];
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
    return { kneeAngle: null, hipAngle: null, feedback: [], issues, formRating: '--', depth: 0 };
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
      issues.kneeIssue = true;
      formRating = 'Fair';
    }
  }

  if (isOk(shoulder) && kneeAngle < 140) {
    const lean = shoulder.x - hip.x;
    const ref = Math.abs(hip.y - ankle.y);
    if (Math.abs(lean) > ref * 0.5) {
      feedback.push({ text: 'Excessive forward lean — chest up', type: 'warn' });
      issues.hipIssue = true;
      formRating = 'Fair';
    }
  }

  if (squatPhase === 'bottom' || squatPhase === 'ascending') {
    if (minKneeAngle > 120) {
      feedback.push({ text: 'Go deeper — aim for parallel', type: 'info' });
    } else if (minKneeAngle < 70) {
      feedback.push({ text: 'Great depth — keep lower back neutral', type: 'info' });
    }
  }

  if (kneeAngle < 140 && isOk(knee) && isOk(ankle)) {
    const fwd = knee.x - ankle.x;
    const shin = Math.abs(knee.y - ankle.y);
    if (Math.abs(fwd) > shin * 0.8) {
      feedback.push({ text: 'Knees too far forward — sit back more', type: 'warn' });
      issues.kneeIssue = true;
      if (formRating === 'Good') formRating = 'Fair';
    }
  }

  if (feedback.length === 0 && squatPhase !== 'standing') {
    feedback.push({ text: 'Form looks good!', type: 'good' });
  }

  const warns = feedback.filter((f) => f.type === 'warn').length;
  if (warns >= 2) formRating = 'Poor';

  // Accumulate feedback for current rep
  if (squatPhase !== 'standing') {
    for (const f of feedback) {
      if (f.type === 'warn' || f.type === 'info') {
        currentRepFeedback.push(f);
      }
    }
    // Track worst rating for this rep
    if (formRating === 'Poor') lastFormRating = 'Poor';
    else if (formRating === 'Fair' && lastFormRating !== 'Poor') lastFormRating = 'Fair';
  }

  // Push new warnings to the rolling feed (throttled — only if not already the latest)
  for (const f of feedback) {
    if (f.type === 'warn') {
      const last = rollItems[rollItems.length - 1];
      if (!last || last.text !== f.text) {
        addRollItem(f.text, 'warn');
      }
    }
  }

  return { kneeAngle, hipAngle, feedback, issues, formRating, depth };
}

// ---- Main loop ----

async function detect() {
  if (!detector || !video.readyState || video.readyState < 2) {
    animationId = requestAnimationFrame(detect);
    return;
  }

  // Resize canvas to fill screen
  if (canvas.width !== window.innerWidth || canvas.height !== window.innerHeight) {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }

  const poses = await detector.estimatePoses(video);

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Draw video scaled to fill canvas (cover)
  const vw = video.videoWidth, vh = video.videoHeight;
  const cw = canvas.width, ch = canvas.height;
  const scale = Math.max(cw / vw, ch / vh);
  const sw = vw * scale, sh = vh * scale;
  const ox = (cw - sw) / 2, oy = (ch - sh) / 2;
  ctx.drawImage(video, ox, oy, sw, sh);

  if (poses.length > 0) {
    const keypoints = poses[0].keypoints;
    const sx = scale;
    const sy = scale;
    for (const kp of keypoints) {
      kp.x = kp.x * sx + ox;
      kp.y = kp.y * sy + oy;
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
      drawAngleLabel(kp2xy(knee), analysis.kneeAngle, 'Knee', '#00ff88');
      kneeAngleEl.textContent = `${Math.round(analysis.kneeAngle)}°`;
    }
    if (analysis.hipAngle !== null) {
      drawAngleLabel(kp2xy(hip), analysis.hipAngle, 'Hip', '#44aaff');
      hipAngleEl.textContent = `${Math.round(analysis.hipAngle)}°`;
    }

    formScoreEl.textContent = analysis.formRating;
    formScoreEl.className = 'hud-value form-' + analysis.formRating.toLowerCase();

    // Update form indicator border
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

// ---- Fullscreen helpers ----

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
    // Switch to tracker view
    landing.classList.add('hidden');
    tracker.classList.remove('hidden');

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
  } catch (err) {
    statusText.textContent = `Error: ${err.message}`;
    console.error(err);
  }
}

function stopSession() {
  if (animationId) { cancelAnimationFrame(animationId); animationId = null; }
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  video.srcObject = null;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  exitFullscreen();

  tracker.classList.add('hidden');
  landing.classList.remove('hidden');

  // Reset state
  repCount = 0;
  squatPhase = 'standing';
  minKneeAngle = 180;
  frameHistory = [];
  currentRepFeedback = [];
  repHistory = [];
  rollItems = [];
  lastFormRating = 'Good';
  repCountEl.textContent = '0';
  kneeAngleEl.textContent = '--°';
  hipAngleEl.textContent = '--°';
  formScoreEl.textContent = '--';
  feedbackRoll.innerHTML = '';
  historyList.innerHTML = '<p class="history-empty">Complete a squat to see feedback here.</p>';
}

// Also stop if user exits fullscreen manually
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && tracker.classList.contains('hidden') === false) {
    // User exited fullscreen — keep tracking but don't force back
  }
});

// ---- Event listeners ----

btnStart.addEventListener('click', startSession);
btnStop.addEventListener('click', stopSession);

btnHistory.addEventListener('click', () => {
  historyPanel.classList.toggle('hidden');
});
btnCloseHistory.addEventListener('click', () => {
  historyPanel.classList.add('hidden');
});
