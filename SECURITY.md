# Security Policy

## Supported Versions

VoiceBuffer only provides security support for the **latest public release**.

| Version | Supported |
| --- | --- |
| Latest release | Yes |
| Older releases | No |

Users should update to the latest available version before reporting a security issue.

Security fixes are not backported to older VoiceBuffer releases.

## Reporting a Vulnerability

Please do not publicly disclose a security vulnerability before it has been reviewed.

The preferred reporting method is GitHub's **Private Vulnerability Reporting** feature for this repository, when available.

When submitting a report, please include:

- A clear description of the issue and its potential security impact
- The affected VoiceBuffer version
- Your Discord client and build, when relevant
- Whether you are using Vencord, Equicord, or another compatible client
- Steps to reproduce the issue
- Relevant logs, screenshots, or proof-of-concept code
- Any known conditions required for exploitation

Please remove authentication tokens, session data, personal information, server identifiers, IP addresses, and other sensitive data from logs before submitting them.

If private vulnerability reporting is unavailable, open a minimal GitHub issue stating that you need to report a security vulnerability privately. Do not include exploit details or sensitive information in the public issue.

## What Counts as a Security Issue

Examples of issues that should be reported privately include:

- Unexpected arbitrary code execution caused by VoiceBuffer
- Exposure of sensitive Discord or system information
- Unsafe handling of data that could reveal credentials or authentication material
- A VoiceBuffer feature that can be abused to compromise another user or the local system
- A vulnerability introduced by VoiceBuffer's interaction with Discord's native voice or client internals

## What Is Not Usually a Security Issue

The following are normally handled as regular bug reports:

- Voice quality problems, jitter, latency, stuttering, or packet loss
- Incorrect Adaptive decisions or buffer values
- VoiceBuffer failing to apply a requested setting
- UI problems
- Discord updates breaking compatibility
- Vencord or Equicord crashes without a security impact
- Problems that exist entirely in Discord, Vencord, Equicord, Chromium, WebRTC, or another upstream component and are not caused by VoiceBuffer

If you are unsure whether an issue has security impact, report it privately.

## Upstream Vulnerabilities

VoiceBuffer interacts with Discord and Vencord-compatible client internals, but it does not maintain those projects.

If an issue affects Discord, Vencord, Equicord, WebRTC, Electron, Chromium, or another upstream project independently of VoiceBuffer, please report it to the appropriate upstream security team.

Reports are still welcome when VoiceBuffer introduces, exposes, or materially worsens the security issue.

## Disclosure Process

After receiving a valid report, the maintainer will make a reasonable effort to:

1. Confirm and assess the vulnerability
2. Determine whether the latest release is affected
3. Develop and test a fix
4. Publish a new release when necessary
5. Coordinate public disclosure after users have had a reasonable opportunity to update

Please avoid publishing proof-of-concept exploits or technical details before a fix is available.

## Security Updates

Security fixes are released through a new VoiceBuffer version and documented in the repository's release notes or changelog.

Only the latest public release is supported. Users of older versions should update before requesting support.

## Scope

This policy applies to the VoiceBuffer source code and functionality maintained in this repository.

It does not create a security support commitment for Discord, Vencord, Equicord, or any other third-party software.
