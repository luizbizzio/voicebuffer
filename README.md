<h1 align="center">VoiceBuffer</h1>

<p align="center"><strong>Adaptive and manual buffering for incoming voice on Discord Desktop.</strong><br>
An experimental plugin for Vencord and Equicord.</p>

<p align="center"><a href="#install">Install</a> · <a href="#controls">Controls</a> · <a href="#check-the-buffer">Check the buffer</a></p>

<p align="center">
  <img src="assets/voicebuffer-cover.png" width="534" alt="VoiceBuffer Quick Panel showing Adaptive mode, network statistics, and a 20 ms minimum buffer request">
</p>

When voice packets arrive unevenly, some miss their playback deadline. VoiceBuffer asks Discord to wait a little longer so more of those packets can arrive in time. You trade some playback delay for a chance at fewer cuts. The adjustment affects the voice **you hear** in calls. Your microphone and screen-share playback are outside its scope.

## Install

**You need Discord Desktop with Vencord or Equicord already installed.** Use the instructions for the mod you already have.

### Equicord with UserPluginInstaller

If you already use an Equicord development build with **UserPluginInstaller** enabled, paste `https://github.com/luizbizzio/voicebuffer` into a Discord message and click **Install Plugin**, then restart if prompted. [Equicord installer guide](https://docs.equicord.org/installing/custom-plugin/#installing-plugins-via-userplugininstaller)

### One-line install for a standard build

With **Git**, **Node.js 22+**, and **pnpm** available, close Discord Desktop fully. Open **Git Bash** or **PowerShell 7** in a folder where you want to keep the custom build and paste one line. The installer at the end applies the build to your existing Discord Desktop installation.

**Equicord**

```sh
git clone --depth 1 https://github.com/Equicord/Equicord.git Equicord-VoiceBuffer && cd Equicord-VoiceBuffer && git clone --depth 1 https://github.com/luizbizzio/voicebuffer.git src/userplugins/voicebuffer && pnpm install --frozen-lockfile && pnpm build && pnpm inject
```

**Vencord**

```sh
git clone --depth 1 https://github.com/Vendicated/Vencord.git Vencord-VoiceBuffer && cd Vencord-VoiceBuffer && git clone --depth 1 https://github.com/luizbizzio/voicebuffer.git src/userplugins/voicebuffer && pnpm install --frozen-lockfile && pnpm build && pnpm inject
```

Select your Discord installation when the installer opens. Launch Discord, find **VoiceBuffer** in your mod's **Plugins** settings, and enable it. [Equicord source builds](https://docs.equicord.org/installing/#installing-your-custom-build) · [Vencord source builds](https://docs.vencord.dev/installing/#installing-your-custom-build)

<details>
<summary>Already using a source build?</summary>

Run this from the root of the Vencord or Equicord checkout that Discord already uses, then restart Discord and enable **VoiceBuffer**.

```sh
git clone https://github.com/luizbizzio/voicebuffer.git src/userplugins/voicebuffer && pnpm build
```

To update, run `git -C src/userplugins/voicebuffer pull --ff-only && pnpm build` and restart. To remove it, disable the plugin, delete its folder from `src/userplugins`, rebuild, and restart.

</details>

## Controls

Join a voice call and hover over **VB** beside Discord's voice controls. Use the panel to toggle VoiceBuffer or choose **Auto** or **L1–L4**. The gear opens the full settings, including **Custom (Advanced)**.

| Mode | Discord jitter level | Minimum delay requested |
| --- | --- | --- |
| **Auto / Adaptive** | Varies with network conditions. The default range is L1–L4. | Follows the current level |
| **L1 · Low Latency** | Fixed at L1 | 20–35 ms |
| **L2 · Balanced** | Fixed at L2 | 35–60 ms |
| **L3 · Stable** | Fixed at L3 | 50–90 ms |
| **L4 · Maximum Stability** | Fixed at L4 | 65–120 ms |
| **Custom (Advanced)** | Set by **Custom Jitter Level** | A fixed 0–200 ms request set by **Custom Min Buffer** |

**Min Buffer\*** shows the requested floor. Discord can buffer more, and the measured value appears in the tooltip when available. [Mode logic](index.tsx#L1469-L1618) · [Native buffer settings](index.tsx#L1678-L1729)

<p align="center">
  <a href="assets/voicebuffer-settings.png"><img src="assets/voicebuffer-settings.png" width="480" alt="VoiceBuffer plugin settings with Adaptive sensitivity, protection limits, packet loss signal, and Quick Panel enabled"></a><br>
  <em>Full settings with the Adaptive range set to L1–L6.</em>
</p>

## Check the buffer

In a call, open the plugin settings and click **Show Advanced / Diagnostics → Start Verification**. Keep the panel open while someone else speaks. Once incoming audio is detected, the test spends about 24 seconds alternating between 0 and 200 ms at L0. It reports the requested floor and any buffer measurements Discord exposes. [Verification logic](index.tsx#L1105-L1131)

To find out whether the audio improves, compare two calls with the same source audio and packet timing. For the baseline, restart Discord with VoiceBuffer disabled in the plugin list. For the second run, use **Custom** with **Custom Jitter Level** at `0`, **Postpone Decode** off, and a floor such as 40 ms. Compare how much audio the decoder had to reconstruct and how much playback delay was added. A restart makes the baseline more reliable because simulated tests found that the plugin can miss a reset during shutdown. [WebRTC receiver metrics](https://www.w3.org/TR/webrtc-stats/#inboundrtpstats-dict)

## Project status

Development is paused. VoiceBuffer built and passed type checking with [Equicord 1.15.18.2](https://github.com/Equicord/Equicord/tree/8d63e9694b2ef5195806b3f8b2e03135a4b4ea2c) and [Vencord 1.15.19](https://github.com/Vendicated/Vencord/tree/d086992fb674299a2fa05ac6432edc3a777389f3). On Windows Discord Desktop 1.0.9269, static inspection traced the request to Discord's native receive buffer. The effect on audible cuts in real calls remains unverified. Serein and Discord's Project Phoenix desktop rewrite use different integrations.

[Contribution and testing notes](CONTRIBUTING.md) · [GNU General Public License](LICENSE)
