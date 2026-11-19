# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Stefano uses this local panel to watch a Stremio movie on a classic Chromecast without a remote. Spanish, plain-language controls must work on desktop and a narrow screen.

## Product Purpose

Choose a video-capable Google Cast destination and the intended movie, then control its TV playback. Choose an embedded text subtitle in any available language, a subtitle from Stremio's own addon, a local SRT or VTT file, or no subtitles.

## Operating Context

The Mac runs Stremio and a Python bridge. The current user-owned movie session must remain untouched during development. Interactive QA uses the production panel with an explicitly labelled, isolated synthetic fixture and no receiver or Stremio connections. Starting the fixture and browser QA are separate authorized stages; implementation checks do not start services.

## Capabilities and Constraints

The panel starts with no receiver or movie selected and needs no receiver or LAN route to open. Bounded metadata discovery runs at startup and every 30 seconds. Each list has its own Refresh action. Discovery and UUID-based selection never start content or block playback commands. Destination changes require an explicit Stop while owned playback resources remain. Only the explicit movie-start action casts in ordinary mode.

The bridge provides start, pause, resume, stop, seeking, subtitle selection and timing, volume, mute and subtitle visibility with ownership checks. Subtitle-track changes rebuild playback and retain position or pause as appropriate. Seeking happens on the TV within the same session and keeps pause. Timing changes reload the same session on the TV at its current position and pause state. Visibility-only changes do neither. Source discovery lists cached files, not a reliably detected active movie. A saved source may be stale. Embedded text tracks have no mandatory language. Image subtitles remain visible as unsupported choices and never prevent playback without subtitles. Local UTF-8 SRT and VTT uploads and downloaded Stremio subtitles are bounded, privately stored and bound to their source catalogue. Stremio subtitles come only from Stremio's own OpenSubtitles v3 addon and Cinemeta, looked up in the background once a movie's tracks are ready and never delaying them. The title parsed from the file or torrent name, and whether it is a movie or a series, go to Cinemeta. The IMDb id, season, episode and original file name go to the addon. The year is not sent to Cinemeta, but the file name may contain it. Downloads happen only on an explicit choice and go through the local Stremio engine, which follows redirects itself, a residual risk. Start and Apply never query or download from Stremio's services. `--no-stremio-subtitles` turns the lookup off and hides the block. There is no other provider and no image OCR. Real-device verification remains separate from offline and synthetic QA.

## Product Principles

- Familiar player controls lead; technical details remain secondary.
- Clearly distinguish a selected movie from the movie playing on the TV.
- Keep preparation in one in-page flow. During playback the current movie and transport lead; preparation and caption editing open only when requested.
- State, waiting, errors and recovery must be understandable without jargon.
- Never control receiver content that does not belong to this bridge.

## Evidence on Hand

README.md and bridge.py describe incumbent behavior. Existing tests cover playback ownership, input-seek restart, subtitle timing, growing HLS and startup lifecycle. Neither a complete movie run nor new control behavior on hardware is certified by preview tests.
