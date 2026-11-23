# Custom Camera

A installable camera web app: Photo, Video, document Scan and QR reader. Everything saves to Google Drive in a `Custom Camera` folder with `Photos`, `Videos` and `Scans` inside.

Live at: https://praveenkocherry.github.io/custom_camera/

## One-time Google setup

1. Open https://console.cloud.google.com and create a project called Custom Camera.
2. APIs and Services, Library: enable **Google Drive API**.
3. OAuth consent screen: user type External, add your email, add the scope `.../auth/drive.file`, then **Publish app** (this scope needs no Google review).
4. Credentials, Create credentials, OAuth client ID, type **Web application**. Under Authorized JavaScript origins add `https://praveenkocherry.github.io`.
5. Copy the client ID into `config.js`.

## Controls

- Photo: tap to focus, double-tap to capture.
- Video: tap the bottom bar to start, tap again to pause or resume. Leaving the screen saves the video.
- Scan: one big button; finds the page edges, straightens, brightens, saves a small image.
- QR: live camera, or read a QR from a saved photo. Links, UPI and phone numbers open straight away.
- Swipe left or right to change tabs. The corner thumbnail opens the gallery.

Captures are kept on the phone and uploaded when online.
