# Too Diffuse to Localize — demo page

Static demo page (GitHub Pages) for the ICASSP 2027 submission "Too Diffuse to Localize".

* `index.html` — page; `examples.json` — list of test clips; `media/` — per clip: equirectangular MP4 (muted), poster JPG,
  4-channel FOA WAV (ACN/SN3D, 16 kHz) for every model, stereo M4A renders (virtual cardioid pair) and whole-clip energy maps (PNG).
* `js/foaplayer.js` — 360° player: the video is drawn through one shared WebGL context (drag to change yaw/pitch);
  the FOA WAV is decoded by the browser and rendered binaurally with [Omnitone](https://github.com/GoogleChrome/omnitone)
  (`js/omnitone.min.js`, Google, Apache-2.0). The sound field is counter-rotated with the view, so a source stays attached to the
  object on screen. Rotation convention (view matrix Rx(-pitch)·Ry(yaw), yaw > 0 = right, pitch > 0 = up) was verified with
  Omnitone's FOARotator on synthetic sources; the clips' Y channel follows the standard convention (+Y = left), which we checked
  against a clip whose speaker stands on the right of the frame.
* Data: YT-Ambigen (Kim et al., ICLR 2025); only short test excerpts are shown for research purposes.
