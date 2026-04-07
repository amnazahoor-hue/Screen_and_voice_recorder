(function () {
  "use strict";

  const authStatus = document.getElementById("authStatus");
  const recorderSection = document.getElementById("recorderSection");
  const btnLogin = document.getElementById("btnLogin");
  const btnLogout = document.getElementById("btnLogout");
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
  let currentToken = null;

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

  function setAuthenticatedUI(isAuthed) {
    recorderSection.hidden = !isAuthed;
    btnStart.disabled = !isAuthed;
    btnLogin.hidden = isAuthed;
    btnLogout.hidden = !isAuthed;
    authStatus.classList.toggle("ok", isAuthed);
    authStatus.textContent = isAuthed
      ? "Signed in with Google."
      : "Connect your Google account to upload recordings to Drive.";
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

  function getAuthToken(interactive) {
    return new Promise((resolve, reject) => {
      chrome.identity.getAuthToken({ interactive }, (token) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!token) {
          reject(new Error("No auth token returned."));
          return;
        }
        resolve(token);
      });
    });
  }

  async function refreshAuthState() {
    try {
      const token = await getAuthToken(false);
      currentToken = token;
      setAuthenticatedUI(true);
      return true;
    } catch (_) {
      currentToken = null;
      setAuthenticatedUI(false);
      return false;
    }
  }

  async function loginInteractive() {
    try {
      setError("");
      currentToken = await getAuthToken(true);
      await chrome.storage.local.set({ hasDriveAuth: true });
      setAuthenticatedUI(true);
    } catch (err) {
      setError(err.message || "Google login failed.");
    }
  }

  async function logout() {
    try {
      const token = currentToken || (await getAuthToken(false).catch(() => null));
      if (token) {
        await new Promise((resolve) => {
          chrome.identity.removeCachedAuthToken({ token }, () => resolve());
        });
      }
      currentToken = null;
      await chrome.storage.local.remove("hasDriveAuth");
      setAuthenticatedUI(false);
    } catch (err) {
      setError(err.message || "Sign out failed.");
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
    const hasMic = micStream && micStream.getAudioTracks().length > 0;

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
    return { stream: mixedStream, hasSystemAudio, hasMic };
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
      } catch (_) {
        // ignore close errors
      }
      audioContext = null;
    }
  }

  async function driveUploadBlob(blob) {
    let token = currentToken;
    if (!token) token = await getAuthToken(false);
    currentToken = token;

    const fileName = `Meeting_${new Date().toISOString().replace(/[:.]/g, "-")}.webm`;
    const metadata = {
      name: fileName,
      mimeType: blob.type || "video/webm",
    };

    const initRes = await fetch(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,webViewLink",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Type": metadata.mimeType,
        },
        body: JSON.stringify(metadata),
      }
    );

    if (!initRes.ok) {
      throw new Error(`Drive upload init failed (${initRes.status}).`);
    }

    const uploadUrl = initRes.headers.get("Location");
    if (!uploadUrl) {
      throw new Error("Drive upload URL missing.");
    }

    const putRes = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": metadata.mimeType,
      },
      body: blob,
    });

    if (!putRes.ok) {
      throw new Error(`Drive upload failed (${putRes.status}).`);
    }

    return putRes.json();
  }

  btnLogin.addEventListener("click", loginInteractive);
  btnLogout.addEventListener("click", logout);

  btnStart.addEventListener("click", async () => {
    setError("");
    setRecordingAudioWarning("");

    if (!currentToken) {
      const authed = await refreshAuthState();
      if (!authed) {
        setError("Please sign in with Google first.");
        return;
      }
    }

    if (!navigator.mediaDevices?.getDisplayMedia) {
      setError("Screen capture is not supported in this browser.");
      return;
    }

    try {
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
        setStatus("Uploading to Google Drive...");

        const type = mediaRecorder.mimeType || "video/webm";
        const blob = new Blob(recordedChunks, { type });

        await teardownStreams();
        mediaRecorder = null;
        recordedChunks = [];

        try {
          const result = await driveUploadBlob(blob);
          setStatus(`Saved to Drive: ${result.name || "recording"}.`);
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
      setStatus("Recording... ensure system/tab audio is enabled in the share dialog.");
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
      setStatus("Stopping...");
      mediaRecorder.stop();
    }
  });

  refreshAuthState();
})();
