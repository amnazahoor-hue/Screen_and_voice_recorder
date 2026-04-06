import os
import tempfile
import uuid
from datetime import datetime

from flask import Flask, redirect, render_template, request, session, url_for, jsonify
from flask_session import Session
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseUpload
from google.auth.transport.requests import Request

os.environ["OAUTHLIB_INSECURE_TRANSPORT"] = "1"

APP_SECRET_KEY = os.environ.get("FLASK_SECRET_KEY", "dev-change-me-in-production")
SCOPES = ["https://www.googleapis.com/auth/drive.file"]
CLIENT_SECRETS_FILE = os.path.join(os.path.dirname(__file__), "client_secret.json")

app = Flask(__name__)
app.secret_key = APP_SECRET_KEY
app.config["SESSION_TYPE"] = "filesystem"
app.config["SESSION_PERMANENT"] = False
Session(app)


def _load_flow():
    return Flow.from_client_secrets_file(
        CLIENT_SECRETS_FILE,
        scopes=SCOPES,
        redirect_uri=url_for("oauth_callback", _external=True),
    )


def credentials_from_session():
    data = session.get("credentials")
    if not data:
        return None
    return Credentials(
        token=data.get("token"),
        refresh_token=data.get("refresh_token"),
        token_uri=data.get("token_uri"),
        client_id=data.get("client_id"),
        client_secret=data.get("client_secret"),
        scopes=data.get("scopes"),
    )


def save_credentials_to_session(creds: Credentials):
    session["credentials"] = {
        "token": creds.token,
        "refresh_token": creds.refresh_token,
        "token_uri": creds.token_uri,
        "client_id": creds.client_id,
        "client_secret": creds.client_secret,
        "scopes": creds.scopes,
    }


@app.route("/")
def index():
    logged_in = credentials_from_session() is not None
    return render_template("index.html", logged_in=logged_in)


@app.route("/login")
def login():
    flow = _load_flow()
    authorization_url, state = flow.authorization_url(
        access_type="offline",
        include_granted_scopes="true",
        prompt="consent",
    )
    session["oauth_state"] = state
    # PKCE: authorization_url generates code_verifier; same value must be sent at token exchange.
    # A new Flow in /callback has no verifier unless we persist it here.
    session["oauth_code_verifier"] = flow.code_verifier
    return redirect(authorization_url)


@app.route("/callback")
def oauth_callback():
    state = session.get("oauth_state")
    if request.args.get("state") != state:
        return "Invalid state parameter", 400
    flow = _load_flow()
    flow.code_verifier = session.get("oauth_code_verifier")
    flow.fetch_token(authorization_response=request.url)
    creds = flow.credentials
    save_credentials_to_session(creds)
    session.pop("oauth_state", None)
    session.pop("oauth_code_verifier", None)
    return redirect(url_for("index"))


@app.route("/logout")
def logout():
    session.pop("credentials", None)
    session.pop("oauth_state", None)
    session.pop("oauth_code_verifier", None)
    return redirect(url_for("index"))


@app.route("/api/status")
def api_status():
    creds = credentials_from_session()
    return jsonify({"authenticated": creds is not None})


@app.route("/upload", methods=["POST"])
def upload():
    creds = credentials_from_session()
    if not creds:
        return jsonify({"error": "Not authenticated"}), 401

    if creds.expired and creds.refresh_token:
        creds.refresh(Request())
        save_credentials_to_session(creds)

    if "recording" not in request.files:
        return jsonify({"error": "No file part 'recording'"}), 400

    file_storage = request.files["recording"]
    if not file_storage.filename:
        return jsonify({"error": "Empty filename"}), 400

    suffix = ".webm"
    if file_storage.mimetype and "mp4" in file_storage.mimetype:
        suffix = ".mp4"

    safe_name = f"Meeting_{datetime.utcnow().strftime('%Y-%m-%d_%H-%M-%S')}_{uuid.uuid4().hex[:8]}{suffix}"
    mimetype = file_storage.mimetype or "video/webm"

    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            temp_path = tmp.name
            file_storage.save(tmp)

        service = build("drive", "v3", credentials=creds, cache_discovery=False)
        with open(temp_path, "rb") as fh:
            media = MediaIoBaseUpload(fh, mimetype=mimetype, resumable=True)
            created = (
                service.files()
                .create(
                    body={"name": safe_name, "mimeType": mimetype},
                    media_body=media,
                    fields="id, name, webViewLink, webContentLink",
                )
                .execute()
            )
        return jsonify(
            {
                "id": created.get("id"),
                "name": created.get("name"),
                "webViewLink": created.get("webViewLink"),
            }
        )
    finally:
        if temp_path and os.path.isfile(temp_path):
            os.remove(temp_path)


if __name__ == "__main__":
    app.run(debug=True, port=5000)
