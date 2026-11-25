# VoiceBuffer

VoiceBuffer is an experimental plugin for the Electron version of Discord Desktop. It adjusts the receive jitter buffer so late voice packets have more time to arrive before playback. A larger buffer can smooth some timing-related cuts at the cost of extra delay. The adjustment affects the voice you hear.

**Development is paused.** The project targets Vencord, with Equicord as a compatibility target. [Serein](https://github.com/ViceVerse-cz/Serein) has its own voice engine, and the [Discord Project Phoenix](https://www.youtube.com/watch?v=zgdPbgWaobQ) desktop rewrite replaces Electron. Each would need a separate integration.

## What the plugin does

- **Adaptive** uses network statistics to change the requested buffer during a call.
- **Custom** lets you set a fixed minimum buffer request for controlled comparisons.
- The **Quick Panel** puts mode controls and connection stats next to Discord's voice controls. **Advanced / Diagnostics** includes an A/B test that alternates between 0 ms and 200 ms requests while receiving speech.

## Install for testing

1. Set up a desktop Vencord source checkout using the [custom plugin guide](https://docs.vencord.dev/installing/custom-plugins/).
2. Copy [`index.tsx`](index.tsx) to `src/userplugins/voicebuffer/index.tsx` in that checkout.
3. Rebuild and install your custom Vencord build. Restart Discord Desktop, then enable **VoiceBuffer** in the Vencord plugin list.

From the Vencord checkout, run `pnpm test:ts` for type checking and `pnpm build --dev` for a development build. See [CONTRIBUTING.md](CONTRIBUTING.md) for test cases and what to record.

## Verification and limits

- The plugin built and passed type checking with [Vencord 1.15.19](https://github.com/Vendicated/Vencord/tree/d086992fb674299a2fa05ac6432edc3a777389f3).
- Static inspection of Discord Desktop **1.0.9269 on Windows** traced `setMinimumOutputDelay()` to the native receive jitter buffer. VoiceBuffer relies on private client interfaces, so behavior can vary by Discord build.
- The built-in A/B test checks whether the reported buffer responds. The effect on audible cuts in a real call remains unmeasured. To test that, run a baseline with the plugin disabled from the start of a fresh call, then compare it with a fixed buffer request under the same audio and packet timing. Record both how much speech the receiver had to reconstruct and how much delay the buffer added. [WebRTC receiver statistics](https://www.w3.org/TR/webrtc-stats/#inboundrtpstats-dict)
- Simulated connection tests found two reset problems. A pending statistics request can reapply the buffer after the plugin stops, and a failed reset to 0 ms can be skipped on the next attempt.

## License

VoiceBuffer is licensed under the [GNU General Public License v3](LICENSE).
