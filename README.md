# Meeting Recorder Chrome Extension

A Chrome Extension (Manifest V3) to record:
- Screen video
- System/tab audio (other meeting participants)
- Microphone audio (your voice)

Then upload the recording directly to your personal Google Drive using the `drive.file` scope.

## Features

- Google login with `chrome.identity.getAuthToken`
- Screen + audio capture with:
  - `navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })`
  - `navigator.mediaDevices.getUserMedia({ audio: true })`
- Audio mixing using `AudioContext` + `MediaStreamDestination`
- Upload to Google Drive API v3 (resumable upload)
- Live recording timer
- Dedicated recorder window so closing the extension popup does not stop recording

## Project Structure

```text
Extension_2/
  manifest.json
  index.html           # small launcher popup
  recorder.html        # actual recorder UI
  css/
    style.css
  js/
    popup.js           # opens recorder window
    script.js          # auth + recording + drive upload logic
```

## Requirements

- Google Chrome (latest)
- A Google Cloud project with Drive API enabled

## Google Cloud Setup

1. Open [Google Cloud Console](https://console.cloud.google.com/).
2. Enable **Google Drive API**.
3. Create OAuth credentials for your extension usage.
4. Ensure your OAuth client is correctly configured for Chrome Extension auth flows.
5. Confirm the client ID in `manifest.json` is valid:
   - `oauth2.client_id`
   - Current value: `479457972046-r0461pfd6kkgba58cndd4ofahkq0vru8.apps.googleusercontent.com`

## Install / Run (Developer Mode)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked**.
4. Select this project folder (`Extension_2`).
5. Pin the extension (optional) for easy access.

## How to Use

1. Click the extension icon.
2. Click **Open Recorder Window**.
3. Click **Login with Google** (first time only).
4. Click **Start Recording**.
5. In the screen-share picker:
   - Choose the correct tab/window/screen.
   - **CRITICAL:** enable **Share system audio** / **Share tab audio**.
6. Click **Stop & Save** to upload to Google Drive.

## Important Notes

- If system audio is not enabled in the picker, only microphone audio may be recorded.
- If microphone permission is denied/unavailable, recording can still proceed with system audio (if available).
- Closing the recorder window will stop recording.
- Closing only the small extension popup does not stop recording.

## Permissions Used

- `identity`: Google OAuth token acquisition
- `storage`: local extension state
- `https://www.googleapis.com/*` host permission: Drive API calls

OAuth scope:
- `https://www.googleapis.com/auth/drive.file`

This scope limits access to files created/opened by this extension.

## Troubleshooting

- **No system audio captured**
  - Share a Chrome tab and enable **Share tab audio**.
  - Some screen/window combinations do not expose system audio.

- **Google login fails**
  - Verify OAuth client configuration and client ID in `manifest.json`.
  - Reload extension after any manifest change.

- **Upload fails**
  - Check network connection.
  - Confirm Drive API is enabled in Google Cloud.
  - Re-login to refresh auth token.

## Security

- No backend server required.
- Tokens are managed by Chrome identity APIs.
- Uses least-privilege Drive scope (`drive.file`).
