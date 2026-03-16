const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const btnStart = document.getElementById('btn-start');
const btnStop = document.getElementById('btn-stop');
const statusText = document.getElementById('status-text');
const repCountEl = document.getElementById('rep-count');
const kneeAngleEl = document.getElementById('knee-angle');
const hipAngleEl = document.getElementById('hip-angle');
const formScoreEl = document.getElementById('form-score');
const feedbackList = document.getElementById('feedback-list');
const depthBar = document.getElementById('depth-bar');

// Pose detection state
let detector = null;
let animationId = null;
let stream = null;

// Squat tracking state
let repCount = 0;
let squatPhase = 'standing'; // standing | descending | bottom | ascending
let minKneeAngle = 180;
let frameHistory = [];
const HISTORY_SIZE = 10;

// Keypoint indices for MoveNet
const KEYPOINTS = {
  NOSE: 0,
  LEFT_SHOULDER: 5,
  RIGHT_SHOULDER: 6,
  LEFT_ELBOW: 7,
  RIGHT_ELBOW: 8,
  LEFT_WRIST: 9,
  RIGHT_WRIST: 10,
  LEFT_HIP: 11,
  RIGHT_HIP: 12,
  LEFT_KNEE: 13,
  RIGHT_KNEE: 14,
  LEFT_ANKLE: 15,
  RIGHT_ANKLE: 16,
};

// Skeleton connections for drawing
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

// Colors for skeleton
const COLORS = {
  skeleton: '#00ff88',
  joint: '#ff3366',
  jointGood: '#00ff88',
  jointWarn: '#ffaa00',
  jointBad: '#ff3366',
  text: '#ffffff',
};

// ---- Utility functions ----

function angle(a, b, c) {
  const radians =
    Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(a.y - b.y, a.x - b.x);
  let deg = Math.abs((radians * 180) / Math.PI);
  if (deg > 180) deg = 360 - deg;
  return deg;
}

function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function keypointToXY(kp) {
  return { x: kp.x, y: kp.y };
}

function isConfident(kp, threshold = 0.3) {
  return kp.score >= threshold;
}

// ---- Drawing functions ----

function drawSkeleton(keypoints, formIssues) {
  // Draw connections
  for (const [i, j] of SKELETON_CONNECTIONS) {
    const kpA = keypoints[i];
    const kpB = keypoints[j];
    if (!isConfident(kpA) || !isConfident(kpB)) continue;

    ctx.beginPath();
    ctx.moveTo(kpA.x, kpA.y);
    ctx.lineTo(kpB.x, kpB.y);
    ctx.strokeStyle = COLORS.skeleton;
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  // Draw keypoints
  for (let i = 0; i < keypoints.length; i++) {
    const kp = keypoints[i];
    if (!isConfident(kp)) continue;

    let color = COLORS.jointGood;

    // Color knees/hips based on form
    if (
      (i === KEYPOINTS.LEFT_KNEE || i === KEYPOINTS.RIGHT_KNEE) &&
      formIssues.kneeIssue
    ) {
      color = COLORS.jointBad;
    }
    if (
      (i === KEYPOINTS.LEFT_HIP || i === KEYPOINTS.RIGHT_HIP) &&
      formIssues.hipIssue
    ) {
      color = COLORS.jointWarn;
    }

    ctx.beginPath();
    ctx.arc(kp.x, kp.y, 6, 0, 2 * Math.PI);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

function drawAngleArc(vertex, pointA, pointC, angleDeg, label, color) {
  if (!vertex || !pointA || !pointC) return;

  ctx.save();
  ctx.font = 'bold 14px monospace';
  ctx.fillStyle = color;
  ctx.strokeStyle = color;

  // Draw angle text near the vertex
  const offsetX = vertex.x > canvas.width / 2 ? -60 : 10;
  ctx.fillText(`${label}: ${Math.round(angleDeg)}°`, vertex.x + offsetX, vertex.y - 15);
  ctx.restore();
}

// ---- Form analysis ----

function analyzeForm(keypoints) {
  const feedback = [];
  const issues = { kneeIssue: false, hipIssue: false };
  let formRating = 'Good';

  const lHip = keypoints[KEYPOINTS.LEFT_HIP];
  const rHip = keypoints[KEYPOINTS.RIGHT_HIP];
  const lKnee = keypoints[KEYPOINTS.LEFT_KNEE];
  const rKnee = keypoints[KEYPOINTS.RIGHT_KNEE];
  const lAnkle = keypoints[KEYPOINTS.LEFT_ANKLE];
  const rAnkle = keypoints[KEYPOINTS.RIGHT_ANKLE];
  const lShoulder = keypoints[KEYPOINTS.LEFT_SHOULDER];
  const rShoulder = keypoints[KEYPOINTS.RIGHT_SHOULDER];

  // Use whichever side is more confident
  const useLeft =
    (lHip.score + lKnee.score + lAnkle.score) >=
    (rHip.score + rKnee.score + rAnkle.score);

  const hip = useLeft ? lHip : rHip;
  const knee = useLeft ? lKnee : rKnee;
  const ankle = useLeft ? lAnkle : rAnkle;
  const shoulder = useLeft ? lShoulder : rShoulder;

  if (!isConfident(hip) || !isConfident(knee) || !isConfident(ankle)) {
    return { kneeAngle: null, hipAngle: null, feedback: ['Move so your full body is visible.'], issues, formRating: '--', depth: 0 };
  }

  // Calculate angles
  const kneeAngle = angle(keypointToXY(hip), keypointToXY(knee), keypointToXY(ankle));
  let hipAngle = null;
  if (isConfident(shoulder)) {
    hipAngle = angle(keypointToXY(shoulder), keypointToXY(hip), keypointToXY(knee));
  }

  // Depth as percentage (180° = 0%, 60° = 100%)
  const depth = Math.max(0, Math.min(100, ((180 - kneeAngle) / 120) * 100));

  // --- Squat phase detection and rep counting ---
  frameHistory.push(kneeAngle);
  if (frameHistory.length > HISTORY_SIZE) frameHistory.shift();

  const avgAngle = frameHistory.reduce((a, b) => a + b, 0) / frameHistory.length;

  if (squatPhase === 'standing' && avgAngle < 150) {
    squatPhase = 'descending';
    minKneeAngle = avgAngle;
  } else if (squatPhase === 'descending') {
    if (avgAngle < minKneeAngle) minKneeAngle = avgAngle;
    if (avgAngle < 110) squatPhase = 'bottom';
  } else if (squatPhase === 'bottom') {
    if (avgAngle < minKneeAngle) minKneeAngle = avgAngle;
    if (avgAngle > 130) squatPhase = 'ascending';
  } else if (squatPhase === 'ascending' && avgAngle > 160) {
    // Rep completed
    if (minKneeAngle < 120) {
      repCount++;
      repCountEl.textContent = repCount;
    }
    squatPhase = 'standing';
    minKneeAngle = 180;
  }

  // --- Form checks ---

  // 1. Knee cave check: knees should stay over ankles
  if (isConfident(lKnee) && isConfident(rKnee) && isConfident(lAnkle) && isConfident(rAnkle)) {
    const kneeWidth = Math.abs(lKnee.x - rKnee.x);
    const ankleWidth = Math.abs(lAnkle.x - rAnkle.x);
    if (kneeWidth < ankleWidth * 0.75 && kneeAngle < 140) {
      feedback.push({ text: 'Knees caving inward — push knees out over toes.', type: 'warn' });
      issues.kneeIssue = true;
      formRating = 'Fair';
    }
  }

  // 2. Forward lean check
  if (isConfident(shoulder) && kneeAngle < 140) {
    const torsoLean = shoulder.x - hip.x;
    const legRef = Math.abs(hip.y - ankle.y);
    if (Math.abs(torsoLean) > legRef * 0.5) {
      feedback.push({ text: 'Excessive forward lean — keep chest up.', type: 'warn' });
      issues.hipIssue = true;
      formRating = 'Fair';
    }
  }

  // 3. Depth feedback
  if (squatPhase === 'bottom' || squatPhase === 'ascending') {
    if (minKneeAngle > 120) {
      feedback.push({ text: 'Try to squat deeper — aim for thighs parallel to ground.', type: 'info' });
    } else if (minKneeAngle < 70) {
      feedback.push({ text: 'Great depth! Watch that your lower back stays neutral.', type: 'info' });
    }
  }

  // 4. Knee over toe (lateral view)
  if (kneeAngle < 140 && isConfident(knee) && isConfident(ankle)) {
    const kneeForward = knee.x - ankle.x;
    const shinLength = Math.abs(knee.y - ankle.y);
    if (Math.abs(kneeForward) > shinLength * 0.8) {
      feedback.push({ text: 'Knees traveling too far forward — sit back more.', type: 'warn' });
      issues.kneeIssue = true;
      if (formRating === 'Good') formRating = 'Fair';
    }
  }

  if (feedback.length === 0 && squatPhase !== 'standing') {
    feedback.push({ text: 'Form looks good! Keep it up.', type: 'good' });
  } else if (squatPhase === 'standing' && feedback.length === 0) {
    feedback.push({ text: 'Ready — perform a squat to get feedback.', type: 'info' });
  }

  // Check for multiple warnings
  const warns = feedback.filter((f) => f.type === 'warn').length;
  if (warns >= 2) formRating = 'Poor';

  return { kneeAngle, hipAngle, feedback, issues, formRating, depth };
}

// ---- Main loop ----

async function detect() {
  if (!detector || !video.readyState || video.readyState < 2) {
    animationId = requestAnimationFrame(detect);
    return;
  }

  const poses = await detector.estimatePoses(video);

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  if (poses.length > 0) {
    const keypoints = poses[0].keypoints;

    // Scale keypoints to canvas
    const scaleX = canvas.width / video.videoWidth;
    const scaleY = canvas.height / video.videoHeight;
    for (const kp of keypoints) {
      kp.x *= scaleX;
      kp.y *= scaleY;
    }

    const analysis = analyzeForm(keypoints);
    drawSkeleton(keypoints, analysis.issues);

    // Draw angle arcs
    const useLeft =
      (keypoints[KEYPOINTS.LEFT_HIP].score + keypoints[KEYPOINTS.LEFT_KNEE].score) >=
      (keypoints[KEYPOINTS.RIGHT_HIP].score + keypoints[KEYPOINTS.RIGHT_KNEE].score);

    const hip = keypoints[useLeft ? KEYPOINTS.LEFT_HIP : KEYPOINTS.RIGHT_HIP];
    const knee = keypoints[useLeft ? KEYPOINTS.LEFT_KNEE : KEYPOINTS.RIGHT_KNEE];
    const ankle = keypoints[useLeft ? KEYPOINTS.LEFT_ANKLE : KEYPOINTS.RIGHT_ANKLE];
    const shoulder = keypoints[useLeft ? KEYPOINTS.LEFT_SHOULDER : KEYPOINTS.RIGHT_SHOULDER];

    if (analysis.kneeAngle !== null) {
      drawAngleArc(keypointToXY(knee), keypointToXY(hip), keypointToXY(ankle), analysis.kneeAngle, 'Knee', '#00ff88');
      kneeAngleEl.textContent = `${Math.round(analysis.kneeAngle)}°`;
    }
    if (analysis.hipAngle !== null) {
      drawAngleArc(keypointToXY(hip), keypointToXY(shoulder), keypointToXY(knee), analysis.hipAngle, 'Hip', '#44aaff');
      hipAngleEl.textContent = `${Math.round(analysis.hipAngle)}°`;
    }

    // Update form score with color
    formScoreEl.textContent = analysis.formRating;
    formScoreEl.className = 'stat-value form-' + analysis.formRating.toLowerCase();

    // Update depth bar
    depthBar.style.height = `${analysis.depth}%`;
    if (analysis.depth > 70) {
      depthBar.className = 'depth-bar depth-deep';
    } else if (analysis.depth > 40) {
      depthBar.className = 'depth-bar depth-parallel';
    } else {
      depthBar.className = 'depth-bar depth-standing';
    }

    // Update feedback
    if (analysis.feedback.length > 0) {
      feedbackList.innerHTML = analysis.feedback
        .map((f) => `<li class="feedback-item ${f.type}">${f.text}</li>`)
        .join('');
    }

    // Update status
    const phaseLabels = {
      standing: 'Standing',
      descending: 'Going Down',
      bottom: 'At Bottom',
      ascending: 'Coming Up',
    };
    statusText.textContent = phaseLabels[squatPhase] || 'Tracking';
  } else {
    statusText.textContent = 'No person detected';
  }

  animationId = requestAnimationFrame(detect);
}

// ---- Camera and model setup ----

async function initDetector() {
  statusText.textContent = 'Loading AI model...';
  const model = poseDetection.SupportedModels.MoveNet;
  detector = await poseDetection.createDetector(model, {
    modelType: poseDetection.movenet.modelType.SINGLEPOSE_THUNDER,
  });
  statusText.textContent = 'Model loaded';
}

async function startCamera() {
  try {
    statusText.textContent = 'Requesting camera...';
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: 'user' },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    if (!detector) await initDetector();

    statusText.textContent = 'Tracking active';
    animationId = requestAnimationFrame(detect);

    btnStart.disabled = true;
    btnStop.disabled = false;
  } catch (err) {
    statusText.textContent = `Camera error: ${err.message}`;
    console.error(err);
  }
}

function stopCamera() {
  if (animationId) {
    cancelAnimationFrame(animationId);
    animationId = null;
  }
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  video.srcObject = null;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  btnStart.disabled = false;
  btnStop.disabled = true;
  statusText.textContent = 'Stopped';
}

btnStart.addEventListener('click', startCamera);
btnStop.addEventListener('click', stopCamera);
