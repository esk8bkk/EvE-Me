# EvE Me — To-do

## Auto "where did you park?" (planned 2026-10-21, not implemented)
Flow: gear changes to Park → server wakes EvE → EvE asks "จอดรถไว้ตรงไหน?" through the car speakers → driver answers by voice → EvE interprets the answer → EvE sends the user an iMessage with the answer + GPS location (map link).
- Park detection: Tesla Fleet Telemetry `Gear` field (via Tessie streaming or own Fleet API setup). NOT set up yet — needs Tessie subscription or Tesla developer app + virtual key.
- Server: always-on host needed (Render free tier sleeps).
- Wake: WAKE_WEBHOOK_URL → EvE.
- Ask/answer: reuse the type:"reply" spoken push + mic button / inbox.
- iMessage: via EvE's setup (to verify).

## Idea (2026-10-22): Manual review quiz by voice
- While driving, EvE runs a voice-only quiz of 3–5 questions from the manual (SEP/CCOM/aircraft type), answered by voice, with the answer and manual section cited
- Spaced repetition: wrong answers come back on later days
- Match topics to calendar (recurrent / SEP teaching)
- The screen shows only a small score card at the end
- SEP Course Builder builds the question bank from the real manual (still need: which manual and the file location)
