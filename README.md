# Custom Camera

Installable camera web app: Photo, Video, Scan, Text, Read and QR. Everything saves to Google Drive in a `Custom Camera` folder with `Photos`, `Videos`, `Scans` and `Texts` inside.

Live at: https://praveenkocherry.github.io/Custom_Camera/

## One-time Google setup (Drive sign-in)

1. Open https://console.cloud.google.com and create a project called Custom Camera.
2. APIs and Services, Library: enable **Google Drive API**.
3. OAuth consent screen: user type External, add your email, add the scope `.../auth/drive.file`, then **Publish app**.
4. Credentials, Create credentials, OAuth client ID, type **Web application**. Under Authorized JavaScript origins add `https://praveenkocherry.github.io`.
5. Copy the client ID into `config.js`.

## AI keys (Text and Read modes)

Tap the key icon, paste a Google AI (Gemini) key and tap the tick. Add several keys if you like: each request uses the next one, and a failing key is skipped. Keys stay on the phone.

## Controls

- Top strip: tap a mode name, or swipe left and right on the camera.
- Swipe down on the camera to browse earlier captures, swipe up to return.
- Tap to focus, pinch to zoom, flash and switch-camera icons at the top.
- Photo: big button, small date stamp switch.
- Video: tap the bar to start, tap again to pause or resume. Leaving the screen saves it.
- Scan: Image or PDF switch. In PDF mode keep scanning pages, then tap the tick.
- Text: turns a photo into a neat label or a PDF for long text.
- Read: speaks what is ahead in its own language; tap the mic to ask follow-up questions.
- QR: scans by itself, or read one from a photo.
- Gallery: All, Favourites, Photos, Videos, Scans, Texts, QR. Heart, share, delete, select several, Enhance on photos.
