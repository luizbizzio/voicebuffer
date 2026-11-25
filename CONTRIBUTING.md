# Contributing to VoiceBuffer

VoiceBuffer is a custom Vencord plugin. Follow the [Vencord custom plugin guide](https://docs.vencord.dev/installing/custom-plugins/) and place [`index.tsx`](index.tsx) at `src/userplugins/voicebuffer/index.tsx` in your Vencord checkout. Run `pnpm test:ts` and `pnpm build --dev` from that checkout.

## Review a change

- Record the Discord Desktop build, Vencord version, OS, and VoiceBuffer profile. Test joining a call, reconnecting, turning VoiceBuffer off, and disabling the plugin during a call when the change affects connection state.
- For a buffer change, compare Discord defaults with the proposed settings under the same input audio and packet-delay pattern. Measure receiver concealment and observed buffer delay where available. Treat the requested floor and the native call status as separate observations.
- For changes to the adaptive logic, include a trace with healthy audio, degraded audio, and unavailable metrics. Report when the buffer increases or decreases, and verify that turning the plugin off restores the default behavior.

Share sanitized counters or a small synthetic fixture in the pull request. Include the expected effect on audio continuity and delay.
