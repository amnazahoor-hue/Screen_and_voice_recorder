(function () {
  "use strict";

  const initialAuth = window.__INITIAL_AUTH__ === true;
  const authSection = document.getElementById("authSection");
  const recorderSection = document.getElementById("recorderSection");
  const btnStart = document.getElementById("btnStart");
  const btnStop = document.getElementById("btnStop");
  const liveTimer = document.getElementById("liveTimer");
  const statusText = document.getElementById("statusText");
  const errorText = document.getElementById("errorText");
  const recordingAudioWarning = document.getElementById("recordingAudioWarning");

  let mediaRecorder = null;
  let recordedChunks = [];
  let timerInterval = null;
  let recordingStartedAt = 0;
  let displayStream = null;
  let micStream = null;
  let audioContext = null;
  let mixedStream = null;

  function setError(msg) {
    if (!msg) {
      errorText.hidden = true;
      errorText.textContent = "";
      return;
    }
    errorText.hidden = false;
    errorText.textContent = msg;
  }

  function setRecordingAudioWarning(msg) {
    if (!recordingAudioWarning) return;
    if (!msg) {
      recordingAudioWarning.hidden = true;
      recordingAudioWarning.textContent = "";
      return;
    }
    recordingAudioWarning.hidden = false;
    recordingAudioWarning.textContent = msg;
  }

  function setStatus(msg) {
    statusText.textContent = msg;
  }

  function formatElapsed(ms) {
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
  }

  function startTimer() {
    recordingStartedAt = performance.now();
    liveTimer.dateTime = "PT0S";
    liveTimer.textContent = "00:00:00";
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(() => {
      const elapsed = performance.now() - recordingStartedAt;
      liveTimer.textContent = formatElapsed(elapsed);
    }, 250);
  }

  function stopTimer() {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
  }

  function stopAllTracks(stream) {
    if (!stream) return;
    stream.getTracks().forEach((t) => t.stop());
  }

  async function refreshAuthUI() {
    try {
      const r = await fetch("/api/status", { credentials: "same-origin" });
      const data = await r.json();
      const ok = data.authenticated === true;
      if (recorderSection) recorderSection.hidden = !ok;
      if (btnStart) btnStart.disabled = !ok;
      return ok;
    } catch {
      return initialAuth;
    }
  }

  function pickRecorderMime() {
    const candidates = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
    ];
    for (const t of candidates) {
      if (MediaRecorder.isTypeSupported(t)) return t;
    }
    return "";
  }

  /**
   * Captures screen + system audio (getDisplayMedia) and mic (getUserMedia) separately,
   * mixes both audio sources in AudioContext, outputs one video + merged audio stream.
   */
  async function buildMixedStream() {
    displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
    });

    micStream = null;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });
    } catch (micErr) {
      console.warn("Microphone unavailable:", micErr);
    }

    const videoTracks = displayStream.getVideoTracks();
    const displayAudioTracks = displayStream.getAudioTracks();
    const hasSystemAudio = displayAudioTracks.length > 0;
    const hasMic =
      micStream && micStream.getAudioTracks().length > 0;

    if (!hasSystemAudio && !hasMic) {
      mixedStream = new MediaStream(videoTracks.slice());
      return {
        stream: mixedStream,
        hasSystemAudio: false,
        hasMic: false,
      };
    }

    audioContext = new AudioContext();
    await audioContext.resume();

    const dest = audioContext.createMediaStreamDestination();

    if (hasSystemAudio) {
      const systemAudioStream = new MediaStream(displayAudioTracks);
      const srcSystem = audioContext.createMediaStreamSource(systemAudioStream);
      srcSystem.connect(dest);
    }

    if (hasMic) {
      const srcMic = audioContext.createMediaStreamSource(micStream);
      srcMic.connect(dest);
    }

    const mixedAudioTracks = dest.stream.getAudioTracks();
    mixedStream = new MediaStream([...videoTracks, ...mixedAudioTracks]);
    return {
      stream: mixedStream,
      hasSystemAudio,
      hasMic,
    };
  }

  async function teardownStreams() {
    stopTimer();
    stopAllTracks(displayStream);
    stopAllTracks(micStream);
    stopAllTracks(mixedStream);
    displayStream = null;
    micStream = null;
    mixedStream = null;
    if (audioContext) {
      try {
        await audioContext.close();
      } catch (_) {}
      audioContext = null;
    }
  }

  async function uploadBlob(blob) {
    const form = new FormData();
    const name =
      "Meeting_" + new Date().toISOString().replace(/[:.]/g, "-") + ".webm";
    form.append("recording", blob, name);

    const res = await fetch("/upload", {
      method: "POST",
      body: form,
      credentials: "same-origin",
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || res.statusText || "Upload failed");
    }
    return data;
  }

  btnStart.addEventListener("click", async () => {
    setError("");
    const authed = await refreshAuthUI();
    if (!authed) {
      setError("Please sign in with Google first.");
      return;
    }

    if (!navigator.mediaDevices?.getDisplayMedia) {
      setError("Screen capture is not supported in this browser.");
      return;
    }

    try {
      setRecordingAudioWarning("");

      const { stream, hasSystemAudio, hasMic } = await buildMixedStream();

      if (!hasSystemAudio) {
        setRecordingAudioWarning(
          "No system audio track: enable Share system audio in the picker, or only your mic (if allowed) will be in the recording."
        );
      } else if (!hasMic) {
        setRecordingAudioWarning(
          "Microphone not included: recording uses system/meeting audio only."
        );
      }

      recordedChunks = [];
      const mimeType = pickRecorderMime();
      const options = mimeType ? { mimeType } : {};
      mediaRecorder = new MediaRecorder(stream, options);

      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) recordedChunks.push(e.data);
      };

      mediaRecorder.onerror = (e) => {
        setError(e.error?.message || "Recording error.");
      };

      mediaRecorder.onstop = async () => {
        btnStart.disabled = false;
        btnStop.disabled = true;
        setRecordingAudioWarning("");
        setStatus("Uploading to Google Drive…");

        const type = mediaRecorder.mimeType || "video/webm";
        const blob = new Blob(recordedChunks, { type });

        await teardownStreams();
        mediaRecorder = null;
        recordedChunks = [];

        try {
          const result = await uploadBlob(blob);
          setStatus(
            "Saved to Drive: " + (result.name || "recording") + "."
          );
        } catch (err) {
          setError(err.message || "Upload failed.");
          setStatus("Recording stopped.");
        }
      };

      const track = displayStream.getVideoTracks()[0];
      if (track) {
        track.addEventListener("ended", () => {
          if (mediaRecorder && mediaRecorder.state === "recording") {
            mediaRecorder.stop();
          }
        });
      }

      mediaRecorder.start(200);
      startTimer();
      btnStart.disabled = true;
      btnStop.disabled = false;
      setStatus(
        "Recording… Pick a Chrome tab and enable tab audio, or a screen/window with system audio if offered."
      );
    } catch (err) {
      await teardownStreams();
      setRecordingAudioWarning("");
      const msg =
        err.name === "NotAllowedError"
          ? "Permission denied or dialog dismissed."
          : err.message || "Could not start recording.";
      setError(msg);
      setStatus("Use the screen-share dialog and enable system/tab audio when available.");
    }
  });

  btnStop.addEventListener("click", () => {
    if (mediaRecorder && mediaRecorder.state === "recording") {
      setStatus("Stopping…");
      mediaRecorder.stop();
    }
  });

  if (!initialAuth) {
    refreshAuthUI();
  }
})();
