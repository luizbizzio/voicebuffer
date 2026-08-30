/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Luiz Bizzio
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { FormSwitch } from "@components/FormSwitch";
import { openPluginModal } from "@components/settings/tabs/plugins/PluginModal";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import type { MediaEngineConnection } from "@vencord/discord-types";
// VoiceBuffer intentionally targets Vencord's public/internal plugin API surface.
// Equicord is supported through its Vencord compatibility; do not add
// Equicord-only imports without a guarded fallback.
import { createRoot, MediaEngineStore, React } from "@webpack/common";
interface NetworkMetrics {
    jitterMs?: number;
    lossPercent?: number;
    rttMs?: number;
    rttVariationMs?: number;
    sources: string[];
}
interface BufferProbeMetrics {
    actualMs?: number;
    targetMs?: number;
    minimumMs?: number;
    emittedDelta?: number;
    source?: string;
    sampleMode?: "instant" | "interval" | "lifetime";
    updatedAt?: number;
}
interface BufferProbeCounter {
    delaySeconds: number;
    targetSeconds?: number;
    minimumSeconds?: number;
    emittedCount: number;
}
interface BufferStatRecord {
    key: string;
    delaySeconds: number;
    targetSeconds?: number;
    minimumSeconds?: number;
    emittedCount: number;
}
type NativeApplyStatus = "waiting" | "applied" | "partial" | "unsupported" | "error";
interface NativeApplyState {
    status: NativeApplyStatus;
    transportCallSucceeded: boolean;
    outputDelaySupported: boolean;
    outputDelayCallSucceeded: boolean;
    jitterLevel: number;
    postponeDecodeLevel: number;
    minimumOutputDelayMs: number;
    updatedAt: number;
    reason?: string;
}
interface SmartProfileStrategy {
    name: string;
    floorsMs: readonly [
        number,
        number,
        number,
        number,
        number
    ];
    thresholdScale: number;
}
interface SmartFloorState {
    level: number;
    floorMs: number;
    desiredFloorMs: number;
    severity: number;
    stableSamples: number;
    lastChangeAt: number;
}
function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}
function finiteNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function normalizeLossPercent(key: string, value: number): number | undefined {
    if (value < 0)
        return undefined;
    const normalizedKey = key.toLowerCase();
    if (normalizedKey.includes("percent") || normalizedKey.includes("pct")) {
        return clamp(value, 0, 100);
    }
    // WebRTC-style rates are normally fractions from 0 to 1.
    if (value <= 1)
        return clamp(value * 100, 0, 100);
    // Discord/native stats may expose a percentage directly.
    if (value <= 100)
        return value;
    return undefined;
}
function normalizeDurationMs(key: string, value: number, objectType: string): number | undefined {
    if (value < 0)
        return undefined;
    const normalizedKey = key.toLowerCase();
    if (/(_ms|ms$|millisecond|msec)/.test(normalizedKey))
        return value;
    if (/(_us|us$|microsecond)/.test(normalizedKey))
        return value / 1000;
    if (/(_s|seconds?$|second$)/.test(normalizedKey))
        return value * 1000;
    // W3C RTCStats reports jitter and roundTripTime in seconds.
    if (objectType.includes("inbound-rtp") ||
        objectType.includes("candidate-pair") ||
        objectType.includes("remote-outbound-rtp")) {
        if (normalizedKey === "jitter" || normalizedKey.includes("roundtriptime")) {
            return value * 1000;
        }
    }
    // Defensive fallback for undocumented Discord/native stats.
    // Sub-second RTT/jitter values are generally seconds; larger values are
    // usually already milliseconds.
    if (value > 0 && value < 1)
        return value * 1000;
    return value;
}
function mergeMetric(target: NetworkMetrics, key: "jitterMs" | "lossPercent" | "rttMs" | "rttVariationMs", value: number | undefined): void {
    if (value === undefined || !Number.isFinite(value))
        return;
    const current = target[key];
    if (current !== undefined && current >= value)
        return;
    switch (key) {
        case "jitterMs":
            target.jitterMs = value;
            break;
        case "lossPercent":
            target.lossPercent = value;
            break;
        case "rttMs":
            target.rttMs = value;
            break;
        case "rttVariationMs":
            target.rttVariationMs = value;
            break;
    }
}
function extractMetrics(root: unknown, source: string): NetworkMetrics {
    const result: NetworkMetrics = { sources: [] };
    const seen = new WeakSet<object>();
    function walk(value: unknown, depth: number): void {
        if (depth > 7 || value === null || typeof value !== "object")
            return;
        if (seen.has(value))
            return;
        seen.add(value);
        if (value instanceof Map) {
            for (const child of value.values())
                walk(child, depth + 1);
            return;
        }
        if (value instanceof Set) {
            for (const child of value.values())
                walk(child, depth + 1);
            return;
        }
        const record = value as Record<string, unknown>;
        const objectType = typeof record.type === "string" ? record.type.toLowerCase() : "";
        const isClearlyOutgoing = objectType.includes("outbound-rtp") && !objectType.includes("remote-outbound-rtp");
        const isRemoteInbound = objectType.includes("remote-inbound-rtp");
        if (!isClearlyOutgoing && !isRemoteInbound) {
            let packetsLost: number | undefined;
            let packetsReceived: number | undefined;
            for (const [rawKey, rawValue] of Object.entries(record)) {
                const numeric = finiteNumber(rawValue);
                if (numeric === undefined)
                    continue;
                const key = rawKey.toLowerCase().replace(/[^a-z0-9]/g, "");
                if (key === "packetslost")
                    packetsLost = numeric;
                if (key === "packetsreceived")
                    packetsReceived = numeric;
                if (key.includes("jitter") &&
                    !key.includes("buffer") &&
                    !key.includes("target") &&
                    !key.includes("delay")) {
                    mergeMetric(result, "jitterMs", normalizeDurationMs(rawKey, numeric, objectType));
                }
                if (key.includes("lossrate") ||
                    key.includes("packetloss") ||
                    key.includes("fractionlost") ||
                    key.includes("losspercent") ||
                    key.includes("losspct")) {
                    mergeMetric(result, "lossPercent", normalizeLossPercent(rawKey, numeric));
                }
                if (key === "rtt" ||
                    key === "ping" ||
                    key.includes("roundtriptime") ||
                    key.includes("latencyms") ||
                    key === "latency") {
                    const rttMs = normalizeDurationMs(rawKey, numeric, objectType);
                    // Discord can briefly report transport.ping = 0 while the
                    // native voice transport is still warming up. Treat zero
                    // RTT as "not measured yet" so Adaptive does not interpret
                    // 0 -> 9 ms as 9 ms of network variation.
                    if (rttMs !== undefined && rttMs > 0) {
                        mergeMetric(result, "rttMs", rttMs);
                    }
                }
            }
            if (packetsLost !== undefined &&
                packetsReceived !== undefined &&
                packetsLost >= 0 &&
                packetsReceived >= 0) {
                const total = packetsLost + packetsReceived;
                if (total > 0) {
                    mergeMetric(result, "lossPercent", clamp((packetsLost / total) * 100, 0, 100));
                }
            }
        }
        for (const child of Object.values(record)) {
            if (child !== null && typeof child === "object")
                walk(child, depth + 1);
        }
    }
    walk(root, 0);
    if (result.jitterMs !== undefined || result.lossPercent !== undefined || result.rttMs !== undefined) {
        result.sources.push(source);
    }
    return result;
}
function combineCurrentMetrics(statsMetrics: NetworkMetrics, fluxMetrics: NetworkMetrics): NetworkMetrics {
    // getStats() is the best source for current transport RTT/jitter when present.
    // RTC_CONNECTION_LOSS_RATE is the better source for current packet loss.
    const combined: NetworkMetrics = {
        jitterMs: statsMetrics.jitterMs ?? fluxMetrics.jitterMs,
        rttMs: statsMetrics.rttMs ?? fluxMetrics.rttMs,
        lossPercent: fluxMetrics.lossPercent ?? statsMetrics.lossPercent,
        rttVariationMs: statsMetrics.rttVariationMs ?? fluxMetrics.rttVariationMs,
        sources: [],
    };
    for (const metrics of [statsMetrics, fluxMetrics]) {
        for (const source of metrics.sources) {
            if (!combined.sources.includes(source))
                combined.sources.push(source);
        }
    }
    return combined;
}
function getRecentFluxMetrics(): NetworkMetrics {
    const now = Date.now();
    const recent = Array.from(recentFluxMetrics.values())
        .filter(entry => now - entry.timestamp <= FLUX_METRICS_MAX_AGE_MS)
        .sort((a, b) => a.timestamp - b.timestamp);
    const merged: NetworkMetrics = { sources: [] };
    // Newer values replace older values field-by-field instead of taking the
    // maximum forever. This prevents a stale 14 ms ping from masking a newer
    // 10 ms ping, while still retaining an independent recent loss event.
    for (const entry of recent) {
        const metrics = entry.metrics;
        if (metrics.jitterMs !== undefined)
            merged.jitterMs = metrics.jitterMs;
        if (metrics.rttMs !== undefined)
            merged.rttMs = metrics.rttMs;
        if (metrics.lossPercent !== undefined)
            merged.lossPercent = metrics.lossPercent;
        if (metrics.rttVariationMs !== undefined)
            merged.rttVariationMs = metrics.rttVariationMs;
        for (const source of metrics.sources) {
            if (!merged.sources.includes(source))
                merged.sources.push(source);
        }
    }
    return merged;
}
function calculateRttVariationMs(history: number[]): number | undefined {
    if (history.length < 2)
        return undefined;
    const deltas: number[] = [];
    for (let i = 1; i < history.length; i++) {
        deltas.push(Math.abs(history[i] - history[i - 1]));
    }
    // Discord often repeats the same RTT value for several getStats() polls.
    // Using the median made a real jump (for example 14 -> 32 ms) disappear
    // under a pile of zero deltas. Keep the strongest recent jump instead.
    // The four-delta window also lets the signal decay after a few stable polls.
    const recent = deltas.slice(-4);
    return recent.length > 0 ? Math.max(...recent) : undefined;
}
function hasAdaptiveSignal(metrics: NetworkMetrics, usePacketLoss: boolean): boolean {
    return (metrics.jitterMs !== undefined ||
        metrics.rttVariationMs !== undefined ||
        (usePacketLoss && metrics.lossPercent !== undefined));
}
type AdaptiveSensitivity = "conservative" | "balanced" | "responsive";
interface AdaptiveConfig {
    sensitivity: AdaptiveSensitivity;
    minLevel: number;
    maxLevel: number;
    usePacketLoss: boolean;
}
interface AdaptiveState {
    level: number;
    badSamples: number;
    goodSamples: number;
    lastChangeAt: number;
    rttHistory: number[];
    lastMetrics: NetworkMetrics;
    lastRawLogAt: number;
}
interface AdaptiveDecision {
    desiredLevel: number;
    changed: boolean;
    oldLevel: number;
    newLevel: number;
    direction: "up" | "down" | "none";
    hasSignal: boolean;
}
interface AdaptiveThresholds {
    jitter: readonly [
        number,
        number,
        number,
        number
    ];
    rttVariation: readonly [
        number,
        number,
        number,
        number
    ];
    loss: readonly [
        number,
        number,
        number,
        number
    ];
    // A small +1 level increase can require more confirmation than a strong
    // +2-or-more jump. This makes Adaptive react quickly to real degradation
    // without chasing every tiny RTT spike.
    upSamples: number;
    strongUpSamples: number;
    downSamples: number;
    upCooldownMs: number;
    downCooldownMs: number;
}
function normalizeAdaptiveRange(config: AdaptiveConfig): {
    min: number;
    max: number;
} {
    return {
        min: Math.min(config.minLevel, config.maxLevel),
        max: Math.max(config.minLevel, config.maxLevel),
    };
}
function createAdaptiveState(config: AdaptiveConfig): AdaptiveState {
    const { min } = normalizeAdaptiveRange(config);
    return {
        level: min,
        badSamples: 0,
        goodSamples: 0,
        lastChangeAt: 0,
        rttHistory: [],
        lastMetrics: { sources: [] },
        lastRawLogAt: 0,
    };
}
function severityFromThresholds(value: number | undefined, thresholds: readonly [
    number,
    number,
    number,
    number
]): number {
    if (value === undefined)
        return 0;
    if (value < thresholds[0])
        return 0;
    if (value < thresholds[1])
        return 1;
    if (value < thresholds[2])
        return 2;
    if (value < thresholds[3])
        return 3;
    return 4;
}
function getThresholds(sensitivity: AdaptiveSensitivity): AdaptiveThresholds {
    switch (sensitivity) {
        case "conservative":
            // Conservative: prioritizes latency stability. At the 1 s polling
            // cadence, small issues need three consecutive samples; a strong
            // +2 level demand needs two. Downward confirmation remains ~12 s.
            return {
                jitter: [20, 35, 60, 100],
                rttVariation: [15, 25, 45, 80],
                loss: [1, 2, 4, 8],
                upSamples: 3,
                strongUpSamples: 2,
                downSamples: 12,
                upCooldownMs: 4000,
                downCooldownMs: 12000,
            };
        case "responsive":
            // Responsive: reacts to the first bad sample. Downward confirmation
            // remains ~6 s at the 1 s polling cadence. Best when avoiding glitches
            // matters more than latency.
            return {
                jitter: [8, 18, 35, 60],
                rttVariation: [6, 12, 25, 45],
                loss: [0.3, 1, 2.5, 5],
                upSamples: 1,
                strongUpSamples: 1,
                downSamples: 6,
                upCooldownMs: 1500,
                downCooldownMs: 6000,
            };
        default:
            // Balanced: a small +1 increase needs two 1 s samples, but a strong
            // +2-or-more degradation reacts on the first sample. Downward
            // confirmation remains ~8 s before reducing protection.
            return {
                jitter: [12, 25, 45, 80],
                rttVariation: [8, 18, 35, 60],
                loss: [0.5, 1.5, 3, 6],
                upSamples: 2,
                strongUpSamples: 1,
                downSamples: 8,
                upCooldownMs: 2500,
                downCooldownMs: 8000,
            };
    }
}
function chooseDesiredLevel(metrics: NetworkMetrics, config: AdaptiveConfig): number {
    const thresholds = getThresholds(config.sensitivity);
    const { min, max } = normalizeAdaptiveRange(config);
    if (!hasAdaptiveSignal(metrics, config.usePacketLoss))
        return min;
    const jitterSeverity = severityFromThresholds(metrics.jitterMs, thresholds.jitter);
    const variationSeverity = severityFromThresholds(metrics.rttVariationMs, thresholds.rttVariation);
    // Packet loss is only a warning signal. A jitter buffer cannot reconstruct a
    // packet that never arrives, so loss alone cannot force level 4.
    const lossSeverity = config.usePacketLoss
        ? Math.min(3, severityFromThresholds(metrics.lossPercent, thresholds.loss))
        : 0;
    return clamp(Math.max(jitterSeverity, variationSeverity, lossSeverity), min, max);
}
function evaluateAdaptiveLevel(state: AdaptiveState, metrics: NetworkMetrics, config: AdaptiveConfig, now: number): AdaptiveDecision {
    const thresholds = getThresholds(config.sensitivity);
    const { min, max } = normalizeAdaptiveRange(config);
    state.level = clamp(state.level, min, max);
    state.lastMetrics = metrics;
    const oldLevel = state.level;
    const hasSignal = hasAdaptiveSignal(metrics, config.usePacketLoss);
    const desiredLevel = hasSignal ? chooseDesiredLevel(metrics, config) : state.level;
    if (!hasSignal) {
        state.badSamples = 0;
        state.goodSamples = 0;
        return {
            desiredLevel,
            changed: false,
            oldLevel,
            newLevel: state.level,
            direction: "none",
            hasSignal: false,
        };
    }
    if (desiredLevel > state.level) {
        state.badSamples++;
        state.goodSamples = 0;
        const gap = desiredLevel - state.level;
        const requiredSamples = gap >= 2
            ? thresholds.strongUpSamples
            : thresholds.upSamples;
        if (state.badSamples >= requiredSamples && now - state.lastChangeAt >= thresholds.upCooldownMs) {
            // A strong degradation may jump two levels immediately. Small
            // degradations still move one level at a time.
            const step = gap >= 2 ? 2 : 1;
            state.level = Math.min(desiredLevel, state.level + step);
            state.lastChangeAt = now;
            state.badSamples = 0;
            return {
                desiredLevel,
                changed: state.level !== oldLevel,
                oldLevel,
                newLevel: state.level,
                direction: "up",
                hasSignal: true,
            };
        }
    }
    else if (desiredLevel < state.level) {
        state.goodSamples++;
        state.badSamples = 0;
        if (state.goodSamples >= thresholds.downSamples && now - state.lastChangeAt >= thresholds.downCooldownMs) {
            state.level = Math.max(desiredLevel, state.level - 1);
            state.lastChangeAt = now;
            state.goodSamples = 0;
            return {
                desiredLevel,
                changed: state.level !== oldLevel,
                oldLevel,
                newLevel: state.level,
                direction: "down",
                hasSignal: true,
            };
        }
    }
    else {
        state.badSamples = 0;
        state.goodSamples = 0;
    }
    return {
        desiredLevel,
        changed: false,
        oldLevel,
        newLevel: state.level,
        direction: "none",
        hasSignal: true,
    };
}
const logger = new Logger("VoiceBuffer");
type BufferProfile = "adaptive" | "low" | "balanced" | "high" | "veryHigh" | "custom";
interface RecentMetrics {
    metrics: NetworkMetrics;
    timestamp: number;
}
const PROFILE_LEVELS: Record<Exclude<BufferProfile, "adaptive" | "custom">, number> = {
    low: 1,
    balanced: 2,
    high: 3,
    veryHigh: 4,
};
const ADAPTIVE_SAMPLE_INTERVAL_MS = 1000;
const DISCORD_DEFAULT_MINIMUM_JITTER_BUFFER_LEVEL = 0;
const DISCORD_DEFAULT_POSTPONE_DECODE_LEVEL = 100;
const VOICEBUFFER_VERSION = "1.0.0";
const VOICEBUFFER_REPOSITORY_URL = "https://github.com/luizbizzio/voicebuffer";
// Explicit minimum playout/output delay requested from Discord's native voice
// connection. These are VoiceBuffer presets, not a reverse-engineered
// conversion of Discord's internal jitter-buffer levels.
const OUTPUT_DELAY_MS_PER_LEVEL = 20;
const MAX_DIRECT_OUTPUT_DELAY_MS = 200;
const FLUX_METRICS_MAX_AGE_MS = 6000;
const RAW_LOG_INTERVAL_MS = 10000;
const MAX_RTT_HISTORY = 8;
// Smart Profiles keep Discord's native L-level as the selected strategy while
// adjusting only VoiceBuffer's explicit minimum output/playout floor.
// The five values are used for instability severities 0..4.
//
// This does NOT redefine Discord's internal L-level in milliseconds.
const SMART_PROFILE_STRATEGIES: Record<number, SmartProfileStrategy> = {
    1: {
        name: "Low Latency",
        floorsMs: [20, 20, 25, 30, 35],
        thresholdScale: 1.25,
    },
    2: {
        name: "Balanced",
        floorsMs: [35, 40, 45, 55, 60],
        thresholdScale: 1.00,
    },
    3: {
        name: "Stable",
        floorsMs: [50, 55, 65, 80, 90],
        thresholdScale: 0.82,
    },
    4: {
        name: "Maximum Stability",
        floorsMs: [65, 70, 85, 100, 120],
        thresholdScale: 0.68,
    },
    5: {
        name: "Extreme",
        floorsMs: [80, 90, 105, 125, 145],
        thresholdScale: 0.60,
    },
    6: {
        name: "Extreme+",
        floorsMs: [95, 105, 125, 150, 175],
        thresholdScale: 0.55,
    },
};
const SMART_RELEASE_SAMPLES = 8;
const SMART_RELEASE_COOLDOWN_MS = 8000;
let applyTimers: Array<ReturnType<typeof setTimeout>> = [];
let adaptiveTimer: ReturnType<typeof setInterval> | null = null;
let lastApplied = new WeakMap<MediaEngineConnection, string>();
let adaptiveStates = new WeakMap<MediaEngineConnection, AdaptiveState>();
let sampleInFlight = new WeakSet<MediaEngineConnection>();
let recentFluxMetrics = new Map<string, RecentMetrics>();
let lastRawFluxLogAt = 0;
let bufferProbeCounters = new WeakMap<MediaEngineConnection, Map<string, BufferProbeCounter>>();
let bufferProbeSnapshots = new WeakMap<MediaEngineConnection, BufferProbeMetrics>();
let nativeApplyStates = new WeakMap<MediaEngineConnection, NativeApplyState>();
let smartFloorStates = new WeakMap<MediaEngineConnection, SmartFloorState>();
interface LatencyProofOverride {
    jitterLevel: number;
    postponeDecodeLevel: number;
    minimumOutputDelayMs: number;
}
type LatencyProofPhaseKey = "A1" | "B1" | "A2" | "B2";
interface DiscordNativeDelayDistribution {
    last?: number;
    mean?: number;
    p75?: number;
    p95?: number;
    p99?: number;
    max?: number;
}
interface DiscordNativeInboundProbe {
    sourceCount: number;
    packetsReceived: number;
    bytesReceived: number;
    audioDetected: number;
    decodingNormal: number;
    opNormal: number;
    jitterBufferRaw?: number;
    jitterBufferPreferredRaw?: number;
    jitterBufferSamplesRaw?: number;
    jitterDelaySamplesRaw?: number;
    jitterTargetSamplesRaw?: number;
    relativeReceptionDelay?: DiscordNativeDelayDistribution;
    relativePlayoutDelay?: DiscordNativeDelayDistribution;
}
interface RemoteAudioActivityState {
    packetsReceived: number;
    bytesReceived: number;
    decodingNormal: number;
    opNormal: number;
    updatedAt: number;
}
interface RemoteAudioActivity {
    active: boolean;
    packetsDelta: number;
    bytesDelta: number;
    decodingNormalDelta: number;
    opNormalDelta: number;
}
interface LatencyProofSample {
    actualMs?: number;
    targetMs?: number;
    minimumMs?: number;
    nativeJitterBufferRaw?: number;
    nativeJitterBufferPreferredRaw?: number;
    nativeJitterBufferSamplesRaw?: number;
    nativeJitterDelaySamplesRaw?: number;
    nativeJitterTargetSamplesRaw?: number;
    nativeRelativePlayoutMeanRaw?: number;
    nativeRelativePlayoutP75Raw?: number;
    nativeRelativeReceptionMeanRaw?: number;
    packetsDelta: number;
    capturedAt: number;
}
let latencyProofOverride: LatencyProofOverride | null = null;
let latencyProofRunning = false;
let latencyProofWaitingForAudio = false;
let latencyProofPhase = "Ready";
let latencyProofPhaseKey: LatencyProofPhaseKey | null = null;
let latencyProofPhaseStartedAt = 0;
let latencyProofLastRemoteAudioAt = 0;
let latencyProofLastPacketsDelta = 0;
let latencyProofDetectedSourceCount = 0;
let latencyProofTimers: Array<ReturnType<typeof setTimeout>> = [];
let remoteAudioActivityStates = new WeakMap<MediaEngineConnection, RemoteAudioActivityState>();
let latencyProofSamples: Record<LatencyProofPhaseKey, LatencyProofSample[]> = {
    A1: [],
    B1: [],
    A2: [],
    B2: [],
};
let latencyProofFinalSummary = "Not run yet.";
const latencyProofSubscribers = new Set<() => void>();
function getAdaptiveConfig(): AdaptiveConfig {
    return {
        sensitivity: settings.store.adaptiveSensitivity as AdaptiveSensitivity,
        minLevel: settings.store.adaptiveMinLevel,
        maxLevel: settings.store.adaptiveMaxLevel,
        usePacketLoss: settings.store.adaptiveUsePacketLoss,
    };
}
function getManualJitterLevel(): number {
    const profile = settings.store.profile as BufferProfile;
    if (profile === "custom")
        return settings.store.customJitterLevel;
    if (profile === "adaptive")
        return normalizeAdaptiveRange(getAdaptiveConfig()).min;
    return PROFILE_LEVELS[profile];
}
function getPostponeDecodeLevel(): number {
    if (!settings.store.voiceBufferEnabled || !settings.store.postponeDecode) {
        return DISCORD_DEFAULT_POSTPONE_DECODE_LEVEL;
    }
    return settings.store.postponeDecodeLevel;
}
function notifyLatencyProofSubscribers(): void {
    for (const subscriber of latencyProofSubscribers) {
        try {
            subscriber();
        }
        catch {
            // Component may have unmounted between notifications.
        }
    }
}
function clearLatencyProofTimers(): void {
    for (const timer of latencyProofTimers)
        clearTimeout(timer);
    latencyProofTimers = [];
}
function resetLatencyProofSamples(): void {
    latencyProofSamples = {
        A1: [],
        B1: [],
        A2: [],
        B2: [],
    };
}
function median(values: number[]): number | undefined {
    if (values.length === 0)
        return undefined;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[middle - 1] + sorted[middle]) / 2
        : sorted[middle];
}
function finiteMedian(values: Array<number | undefined>): number | undefined {
    return median(values.filter((value): value is number => value !== undefined && Number.isFinite(value)));
}
function readDelayDistribution(value: unknown): DiscordNativeDelayDistribution | undefined {
    if (!value || typeof value !== "object")
        return undefined;
    const record = value as Record<string, unknown>;
    const result: DiscordNativeDelayDistribution = {
        last: finiteNumber(record.last),
        mean: finiteNumber(record.mean),
        p75: finiteNumber(record.p75),
        p95: finiteNumber(record.p95),
        p99: finiteNumber(record.p99),
        max: finiteNumber(record.max),
    };
    return Object.values(result).some(entry => entry !== undefined)
        ? result
        : undefined;
}
function readNativeSampleSeriesMedian(value: unknown): number | undefined {
    if (!Array.isArray(value) || value.length === 0)
        return undefined;
    const numbers: number[] = [];
    for (const item of value) {
        const direct = finiteNumber(item);
        if (direct !== undefined) {
            numbers.push(direct);
            continue;
        }
        if (!item || typeof item !== "object")
            continue;
        const record = item as Record<string, unknown>;
        for (const key of ["value", "delay", "target", "jitter", "ms", "milliseconds"]) {
            const numeric = finiteNumber(record[key]);
            if (numeric !== undefined) {
                numbers.push(numeric);
                break;
            }
        }
    }
    return median(numbers);
}
function extractDiscordNativeInboundProbe(root: unknown): DiscordNativeInboundProbe | null {
    if (!root || typeof root !== "object")
        return null;
    const top = root as Record<string, unknown>;
    const rtp = top.rtp;
    if (!rtp || typeof rtp !== "object")
        return null;
    const inbound = (rtp as Record<string, unknown>).inbound;
    if (!inbound || typeof inbound !== "object")
        return null;
    const streams: Array<Record<string, unknown>> = [];
    for (const value of Object.values(inbound as Record<string, unknown>)) {
        if (Array.isArray(value)) {
            for (const child of value) {
                if (child && typeof child === "object") {
                    const record = child as Record<string, unknown>;
                    if (String(record.type ?? "").toLowerCase() === "audio") {
                        streams.push(record);
                    }
                }
            }
            continue;
        }
        if (value && typeof value === "object") {
            const record = value as Record<string, unknown>;
            if (String(record.type ?? "").toLowerCase() === "audio") {
                streams.push(record);
            }
        }
    }
    if (streams.length === 0)
        return null;
    const packetsReceived = streams.reduce((sum, stream) => sum + Math.max(0, finiteNumber(stream.packetsReceived) ?? 0), 0);
    const bytesReceived = streams.reduce((sum, stream) => sum + Math.max(0, finiteNumber(stream.bytesReceived) ?? 0), 0);
    const decodingNormal = streams.reduce((sum, stream) => sum + Math.max(0, finiteNumber(stream.decodingNormal) ?? 0), 0);
    const opNormal = streams.reduce((sum, stream) => sum + Math.max(0, finiteNumber(stream.opNormal) ?? 0), 0);
    const audioDetected = streams.reduce((maxValue, stream) => Math.max(maxValue, finiteNumber(stream.audioDetected) ?? 0), 0);
    const jitterBufferRaw = finiteMedian(streams.map(stream => finiteNumber(stream.jitterBuffer)));
    const jitterBufferPreferredRaw = finiteMedian(streams.map(stream => finiteNumber(stream.jitterBufferPreferred)));
    const jitterBufferSamplesRaw = finiteMedian(streams.map(stream => readNativeSampleSeriesMedian(stream.audioJitterBufferSamples)));
    const jitterDelaySamplesRaw = finiteMedian(streams.map(stream => readNativeSampleSeriesMedian(stream.audioJitterDelaySamples)));
    const jitterTargetSamplesRaw = finiteMedian(streams.map(stream => readNativeSampleSeriesMedian(stream.audioJitterTargetSamples)));
    const receptionDistributions = streams
        .map(stream => readDelayDistribution(stream.relativeReceptionDelay))
        .filter((value): value is DiscordNativeDelayDistribution => value !== undefined);
    const playoutDistributions = streams
        .map(stream => readDelayDistribution(stream.relativePlayoutDelay))
        .filter((value): value is DiscordNativeDelayDistribution => value !== undefined);
    const aggregateDistribution = (values: DiscordNativeDelayDistribution[]): DiscordNativeDelayDistribution | undefined => {
        if (values.length === 0)
            return undefined;
        const result: DiscordNativeDelayDistribution = {
            last: finiteMedian(values.map(value => value.last)),
            mean: finiteMedian(values.map(value => value.mean)),
            p75: finiteMedian(values.map(value => value.p75)),
            p95: finiteMedian(values.map(value => value.p95)),
            p99: finiteMedian(values.map(value => value.p99)),
            max: finiteMedian(values.map(value => value.max)),
        };
        return Object.values(result).some(entry => entry !== undefined)
            ? result
            : undefined;
    };
    return {
        sourceCount: streams.length,
        packetsReceived,
        bytesReceived,
        audioDetected,
        decodingNormal,
        opNormal,
        jitterBufferRaw,
        jitterBufferPreferredRaw,
        jitterBufferSamplesRaw,
        jitterDelaySamplesRaw,
        jitterTargetSamplesRaw,
        relativeReceptionDelay: aggregateDistribution(receptionDistributions),
        relativePlayoutDelay: aggregateDistribution(playoutDistributions),
    };
}
function updateRemoteAudioActivity(connection: MediaEngineConnection, probe: DiscordNativeInboundProbe | null): RemoteAudioActivity {
    if (!probe) {
        return {
            active: false,
            packetsDelta: 0,
            bytesDelta: 0,
            decodingNormalDelta: 0,
            opNormalDelta: 0,
        };
    }
    const previous = remoteAudioActivityStates.get(connection);
    const packetsDelta = previous
        ? Math.max(0, probe.packetsReceived - previous.packetsReceived)
        : 0;
    const bytesDelta = previous
        ? Math.max(0, probe.bytesReceived - previous.bytesReceived)
        : 0;
    const decodingNormalDelta = previous
        ? Math.max(0, probe.decodingNormal - previous.decodingNormal)
        : 0;
    const opNormalDelta = previous
        ? Math.max(0, probe.opNormal - previous.opNormal)
        : 0;
    remoteAudioActivityStates.set(connection, {
        packetsReceived: probe.packetsReceived,
        bytesReceived: probe.bytesReceived,
        decodingNormal: probe.decodingNormal,
        opNormal: probe.opNormal,
        updatedAt: Date.now(),
    });
    return {
        active: probe.audioDetected > 0 ||
            packetsDelta > 0 ||
            bytesDelta > 0 ||
            decodingNormalDelta > 0 ||
            opNormalDelta > 0,
        packetsDelta,
        bytesDelta,
        decodingNormalDelta,
        opNormalDelta,
    };
}
function summarizeLatencyProofPhase(phase: LatencyProofPhaseKey): {
    actualMs?: number;
    targetMs?: number;
    minimumMs?: number;
    nativeJitterBufferRaw?: number;
    nativeJitterBufferPreferredRaw?: number;
    nativeJitterBufferSamplesRaw?: number;
    nativeJitterDelaySamplesRaw?: number;
    nativeJitterTargetSamplesRaw?: number;
    nativeRelativePlayoutMeanRaw?: number;
    nativeRelativePlayoutP75Raw?: number;
    nativeRelativeReceptionMeanRaw?: number;
    samples: number;
} {
    const samples = latencyProofSamples[phase];
    return {
        actualMs: finiteMedian(samples.map(sample => sample.actualMs)),
        targetMs: finiteMedian(samples.map(sample => sample.targetMs)),
        minimumMs: finiteMedian(samples.map(sample => sample.minimumMs)),
        nativeJitterBufferRaw: finiteMedian(samples.map(sample => sample.nativeJitterBufferRaw)),
        nativeJitterBufferPreferredRaw: finiteMedian(samples.map(sample => sample.nativeJitterBufferPreferredRaw)),
        nativeJitterBufferSamplesRaw: finiteMedian(samples.map(sample => sample.nativeJitterBufferSamplesRaw)),
        nativeJitterDelaySamplesRaw: finiteMedian(samples.map(sample => sample.nativeJitterDelaySamplesRaw)),
        nativeJitterTargetSamplesRaw: finiteMedian(samples.map(sample => sample.nativeJitterTargetSamplesRaw)),
        nativeRelativePlayoutMeanRaw: finiteMedian(samples.map(sample => sample.nativeRelativePlayoutMeanRaw)),
        nativeRelativePlayoutP75Raw: finiteMedian(samples.map(sample => sample.nativeRelativePlayoutP75Raw)),
        nativeRelativeReceptionMeanRaw: finiteMedian(samples.map(sample => sample.nativeRelativeReceptionMeanRaw)),
        samples: samples.length,
    };
}
function formatProofMetric(value: number | undefined): string {
    return value === undefined ? "n/a" : `${value.toFixed(1)} ms`;
}
function formatRawProofMetric(value: number | undefined): string {
    return value === undefined ? "n/a" : value.toFixed(2);
}
interface NativeProofMetricDescriptor {
    label: string;
    get: (summary: ReturnType<typeof summarizeLatencyProofPhase>) => number | undefined;
}
const NATIVE_PROOF_METRICS: NativeProofMetricDescriptor[] = [
    { label: "audioJitterTargetSamples", get: summary => summary.nativeJitterTargetSamplesRaw },
    { label: "jitterBufferPreferred", get: summary => summary.nativeJitterBufferPreferredRaw },
    { label: "jitterBuffer", get: summary => summary.nativeJitterBufferRaw },
    { label: "audioJitterBufferSamples", get: summary => summary.nativeJitterBufferSamplesRaw },
    { label: "audioJitterDelaySamples", get: summary => summary.nativeJitterDelaySamplesRaw },
    { label: "relativePlayoutDelay.mean", get: summary => summary.nativeRelativePlayoutMeanRaw },
    { label: "relativePlayoutDelay.p75", get: summary => summary.nativeRelativePlayoutP75Raw },
    { label: "relativeReceptionDelay.mean", get: summary => summary.nativeRelativeReceptionMeanRaw },
];
function chooseNativeProofMetric(a1: ReturnType<typeof summarizeLatencyProofPhase>, b1: ReturnType<typeof summarizeLatencyProofPhase>, a2: ReturnType<typeof summarizeLatencyProofPhase>, b2: ReturnType<typeof summarizeLatencyProofPhase>): NativeProofMetricDescriptor | null {
    for (const descriptor of NATIVE_PROOF_METRICS) {
        const aValues = [descriptor.get(a1), descriptor.get(a2)]
            .filter((value): value is number => value !== undefined);
        const bValues = [descriptor.get(b1), descriptor.get(b2)]
            .filter((value): value is number => value !== undefined);
        // Preserve explicit metric priority. We only require usable A and B
        // coverage; complete two-cycle coverage is evaluated in the verdict.
        if (aValues.length > 0 && bValues.length > 0) {
            return descriptor;
        }
    }
    return null;
}
function getLatencyProofMeasuredSummary(): string {
    const a1 = summarizeLatencyProofPhase("A1");
    const b1 = summarizeLatencyProofPhase("B1");
    const a2 = summarizeLatencyProofPhase("A2");
    const b2 = summarizeLatencyProofPhase("B2");
    const allA = [...latencyProofSamples.A1, ...latencyProofSamples.A2];
    const allB = [...latencyProofSamples.B1, ...latencyProofSamples.B2];
    const aMedian = finiteMedian(allA.map(sample => sample.actualMs));
    const bMedian = finiteMedian(allB.map(sample => sample.actualMs));
    // Highest-confidence path: standard WebRTC timed interval measurements.
    if (aMedian !== undefined && bMedian !== undefined) {
        const delta = bMedian - aMedian;
        const delta1 = a1.actualMs !== undefined && b1.actualMs !== undefined
            ? b1.actualMs - a1.actualMs
            : undefined;
        const delta2 = a2.actualMs !== undefined && b2.actualMs !== undefined
            ? b2.actualMs - a2.actualMs
            : undefined;
        const repeatable = delta1 !== undefined &&
            delta2 !== undefined &&
            delta1 >= 30 &&
            delta2 >= 30;
        const detected = delta >= 30;
        const nearFlat = Math.abs(delta) < 15;
        const verdict = repeatable
            ? "MEASURED EFFECT DETECTED AND REPEATED"
            : detected
                ? "MEASURED EFFECT DETECTED"
                : nearFlat
                    ? "NO CLEAR MEASURED EFFECT"
                    : "INCONCLUSIVE";
        return (`${verdict}. VoiceBuffer requested 0 ms in A and 200 ms in B. ` +
            `Standard timed receive-buffer measurement changed from A ${aMedian.toFixed(1)} ms ` +
            `to B ${bMedian.toFixed(1)} ms, delta ${delta >= 0 ? "+" : ""}${delta.toFixed(1)} ms. ` +
            `Samples A/B: ${allA.length}/${allB.length}. ` +
            (repeatable
                ? "The response was reproduced in both A/B cycles."
                : "Repeatability was not fully confirmed in both cycles."));
    }
    // Discord-native path. Prefer target-like metrics first, then observed
    // jitter buffer metrics. Units remain RAW unless independently established.
    const metric = chooseNativeProofMetric(a1, b1, a2, b2);
    if (metric) {
        const aValues = [metric.get(a1), metric.get(a2)]
            .filter((value): value is number => value !== undefined);
        const bValues = [metric.get(b1), metric.get(b2)]
            .filter((value): value is number => value !== undefined);
        const aRaw = median(aValues);
        const bRaw = median(bValues);
        if (aRaw !== undefined && bRaw !== undefined) {
            const delta = bRaw - aRaw;
            const a1Value = metric.get(a1);
            const b1Value = metric.get(b1);
            const a2Value = metric.get(a2);
            const b2Value = metric.get(b2);
            const delta1 = a1Value !== undefined && b1Value !== undefined
                ? b1Value - a1Value
                : undefined;
            const delta2 = a2Value !== undefined && b2Value !== undefined
                ? b2Value - a2Value
                : undefined;
            const significanceThreshold = Math.max(2, Math.abs(aRaw) * 0.05);
            const repeatable = delta1 !== undefined &&
                delta2 !== undefined &&
                delta1 > significanceThreshold &&
                delta2 > significanceThreshold;
            const detected = delta > significanceThreshold;
            const nearFlat = Math.abs(delta) <= Math.max(1, Math.abs(aRaw) * 0.02);
            const verdict = repeatable
                ? "NATIVE TARGET VERIFIED"
                : detected
                    ? "NATIVE EFFECT DETECTED"
                    : nearFlat
                        ? "NO CLEAR NATIVE EFFECT"
                        : "NATIVE RESULT INCONCLUSIVE";
            const observedA = finiteMedian([
                a1.nativeJitterBufferRaw,
                a2.nativeJitterBufferRaw,
            ]);
            const observedB = finiteMedian([
                b1.nativeJitterBufferRaw,
                b2.nativeJitterBufferRaw,
            ]);
            const primaryLabel = metric.label === "audioJitterTargetSamples"
                ? "native target"
                : metric.label === "jitterBufferPreferred"
                    ? "preferred target"
                    : metric.label;
            const observedText = observedA !== undefined && observedB !== undefined
                ? (` Observed jitterBuffer changed from A ${observedA.toFixed(2)} ` +
                    `to B ${observedB.toFixed(2)}, delta ` +
                    `${observedB - observedA >= 0 ? "+" : ""}${(observedB - observedA).toFixed(2)}.`)
                : "";
            const repeatabilityText = repeatable
                ? " The native target response was reproduced in both A/B cycles."
                : detected
                    ? " A native target response was detected, but both cycles did not independently meet the repeatability threshold."
                    : "";
            return (`${verdict}. VoiceBuffer requested 0 ms in A and 200 ms in B. ` +
                `Discord reported ${primaryLabel} A ${aRaw.toFixed(2)} and B ${bRaw.toFixed(2)}, ` +
                `delta ${delta >= 0 ? "+" : ""}${delta.toFixed(2)}.` +
                observedText +
                repeatabilityText +
                ` Samples A/B: ${allA.length}/${allB.length}. ` +
                "The native target response is the verified result; the observed jitterBuffer is reported separately and may not converge to the target during the test window. " +
                "Discord-native values are kept raw unless a standard timed statistic is exposed.");
        }
    }
    return ("Measured verification unavailable. Remote audio was detected, but Discord did not expose enough " +
        "usable standard or native jitter-buffer measurements during both A and B. Native-call success alone " +
        "is not treated as proof of the requested effect.");
}
function recordLatencyProofBufferSample(candidate: BufferProbeMetrics | null, nativeProbe: DiscordNativeInboundProbe | null, activity: RemoteAudioActivity): void {
    if (!latencyProofRunning ||
        latencyProofWaitingForAudio ||
        !latencyProofPhaseKey ||
        !activity.active)
        return;
    if (Date.now() - latencyProofPhaseStartedAt < 1500)
        return;
    const hasStandard = candidate?.sampleMode === "interval" &&
        candidate.actualMs !== undefined;
    const hasNative = nativeProbe !== null &&
        (nativeProbe.jitterBufferRaw !== undefined ||
            nativeProbe.jitterBufferPreferredRaw !== undefined ||
            nativeProbe.jitterBufferSamplesRaw !== undefined ||
            nativeProbe.jitterDelaySamplesRaw !== undefined ||
            nativeProbe.jitterTargetSamplesRaw !== undefined ||
            nativeProbe.relativePlayoutDelay?.mean !== undefined ||
            nativeProbe.relativePlayoutDelay?.p75 !== undefined ||
            nativeProbe.relativeReceptionDelay?.mean !== undefined);
    if (!hasStandard && !hasNative)
        return;
    const samples = latencyProofSamples[latencyProofPhaseKey];
    if (samples.length >= 12)
        return;
    samples.push({
        actualMs: hasStandard ? candidate?.actualMs : undefined,
        targetMs: hasStandard ? candidate?.targetMs : undefined,
        minimumMs: hasStandard ? candidate?.minimumMs : undefined,
        nativeJitterBufferRaw: nativeProbe?.jitterBufferRaw,
        nativeJitterBufferPreferredRaw: nativeProbe?.jitterBufferPreferredRaw,
        nativeJitterBufferSamplesRaw: nativeProbe?.jitterBufferSamplesRaw,
        nativeJitterDelaySamplesRaw: nativeProbe?.jitterDelaySamplesRaw,
        nativeJitterTargetSamplesRaw: nativeProbe?.jitterTargetSamplesRaw,
        nativeRelativePlayoutMeanRaw: nativeProbe?.relativePlayoutDelay?.mean,
        nativeRelativePlayoutP75Raw: nativeProbe?.relativePlayoutDelay?.p75,
        nativeRelativeReceptionMeanRaw: nativeProbe?.relativeReceptionDelay?.mean,
        packetsDelta: activity.packetsDelta,
        capturedAt: Date.now(),
    });
    latencyProofLastRemoteAudioAt = Date.now();
    latencyProofLastPacketsDelta = activity.packetsDelta;
    latencyProofDetectedSourceCount = nativeProbe?.sourceCount ?? latencyProofDetectedSourceCount;
    notifyLatencyProofSubscribers();
}
function setLatencyProofPhase(phaseKey: LatencyProofPhaseKey, label: string, minimumOutputDelayMs: number): void {
    latencyProofPhaseKey = phaseKey;
    latencyProofPhaseStartedAt = Date.now();
    latencyProofPhase = label;
    latencyProofOverride = {
        jitterLevel: 0,
        postponeDecodeLevel: DISCORD_DEFAULT_POSTPONE_DECODE_LEVEL,
        minimumOutputDelayMs: clamp(minimumOutputDelayMs, 0, 200),
    };
    queueApply(true);
    notifyLatencyProofSubscribers();
    logger.info(`Native A/B verification: ${phaseKey} ${label}, L0, MIN BUFFER REQUEST ` +
        `${latencyProofOverride.minimumOutputDelayMs} ms, Postpone Decode 100.`);
}
function beginLatencyProofSequence(): void {
    if (!latencyProofRunning || !latencyProofWaitingForAudio)
        return;
    latencyProofWaitingForAudio = false;
    latencyProofFinalSummary = "Remote audio detected. Collecting A/B measurements...";
    resetLatencyProofSamples();
    bufferProbeCounters = new WeakMap<MediaEngineConnection, Map<string, BufferProbeCounter>>();
    bufferProbeSnapshots = new WeakMap<MediaEngineConnection, BufferProbeMetrics>();
    setLatencyProofPhase("A1", "A1: 0 ms request", 0);
    latencyProofTimers.push(setTimeout(() => setLatencyProofPhase("B1", "B1: 200 ms request", 200), 6000));
    latencyProofTimers.push(setTimeout(() => setLatencyProofPhase("A2", "A2: 0 ms request", 0), 12000));
    latencyProofTimers.push(setTimeout(() => setLatencyProofPhase("B2", "B2: 200 ms request", 200), 18000));
    latencyProofTimers.push(setTimeout(() => restoreAfterLatencyProof(), 24000));
}
function restoreAfterLatencyProof(): void {
    clearLatencyProofTimers();
    if (latencyProofRunning) {
        latencyProofFinalSummary = latencyProofWaitingForAudio
            ? "Verification stopped before remote audio was detected. No A/B request was applied."
            : getLatencyProofMeasuredSummary();
    }
    latencyProofOverride = null;
    latencyProofRunning = false;
    latencyProofWaitingForAudio = false;
    latencyProofPhaseKey = null;
    latencyProofPhaseStartedAt = 0;
    latencyProofPhase = "Ready";
    queueApply(true);
    startAdaptiveLoop();
    notifyLatencyProofSubscribers();
    logger.info(`Native A/B verification finished. ${latencyProofFinalSummary} ` +
        "Normal VoiceBuffer settings restored.");
}
function stopLatencyProofTest(): void {
    if (!latencyProofRunning && !latencyProofOverride)
        return;
    restoreAfterLatencyProof();
}
function startLatencyProofTest(): void {
    clearLatencyProofTimers();
    if (getVoiceConnections().length === 0) {
        latencyProofRunning = false;
        latencyProofWaitingForAudio = false;
        latencyProofOverride = null;
        latencyProofPhaseKey = null;
        latencyProofPhase = "Join a voice channel first";
        latencyProofFinalSummary = "Not run: no active Discord voice connection.";
        notifyLatencyProofSubscribers();
        return;
    }
    resetLatencyProofSamples();
    latencyProofOverride = null;
    latencyProofPhaseKey = null;
    latencyProofPhaseStartedAt = 0;
    latencyProofLastRemoteAudioAt = 0;
    latencyProofLastPacketsDelta = 0;
    latencyProofDetectedSourceCount = 0;
    latencyProofFinalSummary =
        "Waiting for remote audio. The A/B sequence will start automatically when another user's audio packets are detected.";
    latencyProofPhase = "Waiting for remote audio";
    latencyProofRunning = true;
    latencyProofWaitingForAudio = true;
    startAdaptiveLoop();
    notifyLatencyProofSubscribers();
    logger.info("Native request verification armed. Waiting for remote inbound audio before applying A/B overrides.");
}
function handleLatencyProofNativeStats(connection: MediaEngineConnection, nativeProbe: DiscordNativeInboundProbe | null, candidate: BufferProbeMetrics | null): void {
    const activity = updateRemoteAudioActivity(connection, nativeProbe);
    if (!latencyProofRunning)
        return;
    if (activity.active) {
        latencyProofLastRemoteAudioAt = Date.now();
        latencyProofLastPacketsDelta = activity.packetsDelta;
        latencyProofDetectedSourceCount =
            nativeProbe?.sourceCount ?? latencyProofDetectedSourceCount;
        if (latencyProofWaitingForAudio) {
            beginLatencyProofSequence();
            return;
        }
    }
    recordLatencyProofBufferSample(candidate, nativeProbe, activity);
}
function getLatencyProofNativeStatus(): string {
    const connections = getVoiceConnections();
    if (connections.length === 0)
        return "No voice connection";
    if (latencyProofWaitingForAudio)
        return "Not applied yet";
    if (!latencyProofOverride)
        return "Idle";
    const states = connections.map(connection => nativeApplyStates.get(connection));
    if (states.some(state => !state))
        return "Waiting";
    if (latencyProofOverride.minimumOutputDelayMs > 0) {
        if (states.every(state => state?.outputDelayCallSucceeded))
            return "Call OK";
    }
    else if (states.every(state => state?.transportCallSucceeded)) {
        return "Call OK";
    }
    if (states.some(state => state?.status === "error"))
        return "Error";
    if (states.some(state => state?.status === "unsupported"))
        return "Unsupported";
    if (states.some(state => state?.status === "partial"))
        return "Partial";
    return "Waiting";
}
function getLatencyProofRemoteStatus(): string {
    if (!latencyProofRunning)
        return "Idle";
    if (latencyProofWaitingForAudio) {
        return "Waiting for another user's audio packets";
    }
    if (latencyProofLastRemoteAudioAt <= 0) {
        return "No recent remote audio sample";
    }
    const ageSeconds = (Date.now() - latencyProofLastRemoteAudioAt) / 1000;
    if (ageSeconds <= 3.5) {
        return (`Active (${latencyProofDetectedSourceCount || 1} inbound source` +
            `${latencyProofDetectedSourceCount === 1 ? "" : "s"}, last packet delta ${latencyProofLastPacketsDelta})`);
    }
    return `No new remote audio for ${ageSeconds.toFixed(1)} s; keep the other person speaking`;
}
interface CompactVerificationResult {
    title: string;
    detail: string;
    passed: boolean;
}
function getCompactVerificationResult(): CompactVerificationResult {
    const summary = latencyProofFinalSummary || "";
    if (summary.startsWith("NATIVE TARGET VERIFIED") ||
        summary.startsWith("MEASURED EFFECT DETECTED AND REPEATED")) {
        const nativeTargetMatch = summary.match(/reported (?:native target|preferred target) A ([\d.+-]+) and B ([\d.+-]+), delta ([+\-\d.]+)/i);
        const observedMatch = summary.match(/Observed jitterBuffer changed from A ([\d.+-]+) to B ([\d.+-]+), delta ([+\-\d.]+)/i);
        const standardMatch = summary.match(/measurement changed from A ([\d.+-]+) ms to B ([\d.+-]+) ms, delta ([+\-\d.]+) ms/i);
        if (nativeTargetMatch) {
            const observedText = observedMatch
                ? ` · Observed buffer: ${observedMatch[1]} -> ${observedMatch[2]} (delta ${observedMatch[3]})`
                : "";
            return {
                title: "Native target verified",
                detail: `Request: 0 -> 200 ms · Native target: ${nativeTargetMatch[1]} -> ${nativeTargetMatch[2]} ` +
                    `(delta ${nativeTargetMatch[3]})${observedText} · Target repeated: Yes`,
                passed: true,
            };
        }
        if (standardMatch) {
            return {
                title: "Passed",
                detail: `Request: 0 -> 200 ms · Measured: ${standardMatch[1]} -> ${standardMatch[2]} ms ` +
                    `(delta ${standardMatch[3]} ms) · Repeated: Yes`,
                passed: true,
            };
        }
        return {
            title: "Passed",
            detail: "Request: 0 -> 200 ms · Repeatable native target response detected.",
            passed: true,
        };
    }
    if (summary.startsWith("NATIVE EFFECT DETECTED") ||
        summary.startsWith("MEASURED EFFECT DETECTED")) {
        return {
            title: "Effect detected",
            detail: "A receive-buffer response was detected, but repeatability was not fully confirmed.",
            passed: false,
        };
    }
    if (summary.startsWith("NO CLEAR")) {
        return {
            title: "No clear effect",
            detail: "The last A/B run did not show a clear separation.",
            passed: false,
        };
    }
    if (summary.includes("INCONCLUSIVE")) {
        return {
            title: "Inconclusive",
            detail: "The last A/B run produced data, but not enough for a clear verdict.",
            passed: false,
        };
    }
    if (summary.toLowerCase().includes("unavailable") || summary.includes("not expose enough")) {
        return {
            title: "Unavailable",
            detail: "Discord did not expose enough usable receive-buffer measurements.",
            passed: false,
        };
    }
    return {
        title: "Not run",
        detail: "Run verification while a remote user or music bot is actively sending audio.",
        passed: false,
    };
}
function getLatencyProofLiveStats(): string {
    if (!latencyProofRunning || !latencyProofPhaseKey)
        return latencyProofFinalSummary;
    const current = summarizeLatencyProofPhase(latencyProofPhaseKey);
    const allA = latencyProofSamples.A1.length + latencyProofSamples.A2.length;
    const allB = latencyProofSamples.B1.length + latencyProofSamples.B2.length;
    const nativePreview = current.nativeJitterTargetSamplesRaw !== undefined ||
        current.nativeJitterBufferPreferredRaw !== undefined ||
        current.nativeJitterBufferRaw !== undefined
        ? (` Native raw: target=${formatRawProofMetric(current.nativeJitterTargetSamplesRaw)}, ` +
            `preferred=${formatRawProofMetric(current.nativeJitterBufferPreferredRaw)}, ` +
            `observed=${formatRawProofMetric(current.nativeJitterBufferRaw)}.`)
        : "";
    return (`Measured stats: current ${latencyProofPhaseKey} standard=${formatProofMetric(current.actualMs)}; ` +
        `samples A/B=${allA}/${allB}.` +
        nativePreview +
        " Keep remote audio active through all four phases.");
}
function LatencyProofTest() {
    const [, setTick] = React.useState(0);
    const [showDetails, setShowDetails] = React.useState(false);
    React.useEffect(() => {
        const refresh = () => setTick(value => value + 1);
        latencyProofSubscribers.add(refresh);
        const timer = setInterval(refresh, 250);
        return () => {
            latencyProofSubscribers.delete(refresh);
            clearInterval(timer);
            if (latencyProofRunning)
                stopLatencyProofTest();
        };
    }, []);
    const nativeStatus = getLatencyProofNativeStatus();
    const remoteStatus = getLatencyProofRemoteStatus();
    const compact = getCompactVerificationResult();
    return <div style={{
        padding: "12px",
        borderRadius: "8px",
        background: "var(--background-secondary)",
    }}><div style={{
        color: "var(--text-normal)",
        fontWeight: 700,
        marginBottom: "4px",
    }}>Native Request Verification</div><div style={{
        color: "var(--text-muted)",
        fontSize: "13px",
        lineHeight: "1.4",
        marginBottom: "10px",
    }}>Waits for real remote audio, then compares a 0 ms floor request against a 200 ms floor request twice. It reports the request, Discord's native target, and the observed adapting buffer separately.</div>{latencyProofRunning
        ? <><div style={{
            color: "var(--text-normal)",
            fontSize: "13px",
            marginBottom: "3px",
        }}>{`Phase: ${latencyProofPhase} · Native call: ${nativeStatus}`}</div><div style={{
            color: "var(--text-normal)",
            fontSize: "13px",
            marginBottom: "6px",
        }}>{`Remote audio: ${remoteStatus}`}</div><div style={{
            color: "var(--text-muted)",
            fontSize: "12px",
            lineHeight: "1.4",
            marginBottom: "10px",
        }}>{getLatencyProofLiveStats()}</div></> : <div style={{
        fontSize: "13px",
        lineHeight: "1.4",
        marginBottom: "10px",
    }}><div style={{
        color: "var(--text-normal)",
        fontWeight: 600,
        marginBottom: "2px",
    }}>{`Last verification: ${compact.title}${compact.passed ? " ✓" : ""}`}</div><div style={{ color: "var(--text-muted)" }}>{compact.detail}</div></div>}<div style={{
        display: "flex",
        gap: "8px",
        flexWrap: "wrap",
    }}><Button variant={latencyProofRunning ? "dangerPrimary" : "primary"} size="small" onClick={() => {
        if (latencyProofRunning)
            stopLatencyProofTest();
        else
            startLatencyProofTest();
        setTick(value => value + 1);
    }}>{latencyProofRunning ? "Stop and Restore" : "Start Verification"}</Button>{!latencyProofRunning &&
        latencyProofFinalSummary &&
        latencyProofFinalSummary !== "Not run yet."
        ? <Button variant="secondary" size="small" onClick={() => setShowDetails(value => !value)}>{showDetails ? "Hide details" : "Show details"}</Button> : null}</div>{!latencyProofRunning && showDetails
        ? <div style={{
            marginTop: "10px",
            color: "var(--text-muted)",
            fontSize: "12px",
            lineHeight: "1.4",
        }}>{latencyProofFinalSummary}</div> : null}</div>;
}
function AdvancedDiagnostics() {
    const [expanded, setExpanded] = React.useState(false);
    const [, setTick] = React.useState(0);
    const postponeEnabled = settings.store.postponeDecode;
    const postponeLevel = settings.store.postponeDecodeLevel;
    const setPostponeEnabled = (enabled: boolean) => {
        settings.store.postponeDecode = enabled;
        queueApply(true);
        setTick(value => value + 1);
    };
    const setLoggingEnabled = (enabled: boolean) => {
        settings.store.logging = enabled;
        startAdaptiveLoop();
        setTick(value => value + 1);
    };
    return <div><Button variant="secondary" size="small" onClick={() => setExpanded(value => !value)}>{expanded ? "Hide Advanced / Diagnostics" : "Show Advanced / Diagnostics"}</Button>{expanded
        ? <div style={{
            marginTop: "10px",
            display: "grid",
            gap: "12px",
        }}><FormSwitch title="Postpone Decode" description="Experimental decode scheduling. Leave Off unless specifically testing it." value={postponeEnabled} onChange={setPostponeEnabled} hideBorder={true}/>{postponeEnabled
            ? <div style={{
                padding: "0 12px 8px",
            }}><div style={{
                fontWeight: 600,
                marginBottom: "2px",
                color: "var(--text-normal)",
            }}>Postpone Decode Level</div><div style={{
                marginBottom: "8px",
                color: "var(--text-muted)",
                fontSize: "13px",
                lineHeight: "1.4",
            }}>Raw experimental value. It is not a millisecond scale.</div><div style={{
                display: "flex",
                gap: "6px",
                flexWrap: "wrap",
            }}>{[25, 50, 75, 100].map(level => <button key={level} type="button" onClick={() => {
                settings.store.postponeDecodeLevel = level;
                queueApply(true);
                setTick(value => value + 1);
            }} style={{
                minWidth: "54px",
                padding: "6px 12px",
                border: postponeLevel === level
                    ? "1px solid var(--brand-500, #5865f2)"
                    : "1px solid rgba(128, 132, 142, 0.65)",
                borderRadius: "6px",
                backgroundColor: postponeLevel === level
                    ? "var(--brand-500, #5865f2)"
                    : "var(--background-secondary-alt, rgba(255, 255, 255, 0.04))",
                color: postponeLevel === level
                    ? "white"
                    : "var(--text-normal)",
                cursor: "pointer",
                font: "inherit",
                fontSize: "13px",
                fontWeight: 600,
            }}>{String(level)}</button>)}</div></div> : null}<FormSwitch title="Logging" description="Developer diagnostics only. Keep Off during normal use." value={settings.store.logging} onChange={setLoggingEnabled} hideBorder={true}/><LatencyProofTest /></div> : <div style={{
        marginTop: "6px",
        color: "var(--text-muted)",
        fontSize: "13px",
    }}>Experimental controls, logging and native verification.</div>}</div>;
}
function profileUsesSmartStrategy(profile: BufferProfile): boolean {
    return (profile === "adaptive" ||
        profile === "low" ||
        profile === "balanced" ||
        profile === "high" ||
        profile === "veryHigh");
}
function getSmartStrategy(level: number): SmartProfileStrategy | undefined {
    const normalizedLevel = Math.round(level);
    // Smart Profiles exist only for explicitly defined L1-L6 levels.
    // Never clamp arbitrary Custom values such as L10 to L6/"Extreme+".
    if (normalizedLevel < 1 || normalizedLevel > 6)
        return undefined;
    return SMART_PROFILE_STRATEGIES[normalizedLevel];
}
function getSmartStrategyName(level: number): string {
    return getSmartStrategy(level)?.name ?? `L${Math.round(level)}`;
}
function scaleThresholds(thresholds: readonly [
    number,
    number,
    number,
    number
], scale: number): readonly [
    number,
    number,
    number,
    number
] {
    return [
        thresholds[0] * scale,
        thresholds[1] * scale,
        thresholds[2] * scale,
        thresholds[3] * scale,
    ];
}
function getSmartInstabilitySeverity(metrics: NetworkMetrics, level: number): number {
    const strategy = getSmartStrategy(level);
    if (!strategy)
        return 0;
    if (!hasAdaptiveSignal(metrics, settings.store.adaptiveUsePacketLoss)) {
        return 0;
    }
    // Balanced thresholds are used as the common reference. The selected
    // strategy changes how easily it reacts:
    // L1 waits for stronger instability, while L3/L4 react earlier.
    const thresholds = getThresholds("balanced");
    const scale = strategy.thresholdScale;
    const jitterSeverity = severityFromThresholds(metrics.jitterMs, scaleThresholds(thresholds.jitter, scale));
    const variationSeverity = severityFromThresholds(metrics.rttVariationMs, scaleThresholds(thresholds.rttVariation, scale));
    // Packet loss remains a secondary signal because extra buffering cannot
    // reconstruct a packet that never arrives.
    const lossSeverity = settings.store.adaptiveUsePacketLoss
        ? Math.min(3, severityFromThresholds(metrics.lossPercent, scaleThresholds(thresholds.loss, scale)))
        : 0;
    return clamp(Math.max(jitterSeverity, variationSeverity, lossSeverity), 0, 4);
}
function createSmartFloorState(level: number): SmartFloorState {
    const strategy = getSmartStrategy(level);
    const floorMs = strategy
        ? strategy.floorsMs[0]
        : clamp(Math.round(level) * OUTPUT_DELAY_MS_PER_LEVEL, 0, MAX_DIRECT_OUTPUT_DELAY_MS);
    return {
        level,
        floorMs,
        desiredFloorMs: floorMs,
        severity: 0,
        stableSamples: 0,
        lastChangeAt: 0,
    };
}
function getSmartFloorState(connection: MediaEngineConnection, level: number): SmartFloorState {
    let state = smartFloorStates.get(connection);
    if (!state || state.level !== level) {
        state = createSmartFloorState(level);
        smartFloorStates.set(connection, state);
    }
    return state;
}
function updateSmartFloorState(connection: MediaEngineConnection, metrics: NetworkMetrics, level: number, now: number): {
    changed: boolean;
    state: SmartFloorState;
} {
    const strategy = getSmartStrategy(level);
    const state = getSmartFloorState(connection, level);
    if (!strategy) {
        const fallback = clamp(Math.round(level) * OUTPUT_DELAY_MS_PER_LEVEL, 0, MAX_DIRECT_OUTPUT_DELAY_MS);
        const changed = state.floorMs !== fallback;
        state.floorMs = fallback;
        state.desiredFloorMs = fallback;
        state.severity = 0;
        state.stableSamples = 0;
        return { changed, state };
    }
    const severity = getSmartInstabilitySeverity(metrics, level);
    const desiredFloorMs = strategy.floorsMs[severity];
    state.severity = severity;
    state.desiredFloorMs = desiredFloorMs;
    if (desiredFloorMs > state.floorMs) {
        // Fast attack: protection rises immediately when instability worsens.
        state.floorMs = desiredFloorMs;
        state.stableSamples = 0;
        state.lastChangeAt = now;
        return { changed: true, state };
    }
    if (desiredFloorMs < state.floorMs) {
        // Slow release: at the 1 s polling cadence, require ~8 s of healthy
        // samples and step down by only one strategy bucket at a time. This
        // avoids oscillating buffer delay.
        state.stableSamples++;
        if (state.stableSamples >= SMART_RELEASE_SAMPLES &&
            now - state.lastChangeAt >= SMART_RELEASE_COOLDOWN_MS) {
            const floors = strategy.floorsMs;
            const currentIndex = floors.reduce((best, value, index) => Math.abs(value - state.floorMs) < Math.abs(floors[best] - state.floorMs)
                ? index
                : best, 0);
            const desiredIndex = clamp(severity, 0, 4);
            const nextIndex = Math.max(desiredIndex, currentIndex - 1);
            const nextFloor = floors[nextIndex];
            state.stableSamples = 0;
            state.lastChangeAt = now;
            if (nextFloor !== state.floorMs) {
                state.floorMs = nextFloor;
                return { changed: true, state };
            }
        }
        return { changed: false, state };
    }
    state.stableSamples = 0;
    return { changed: false, state };
}
function getMinimumOutputDelayMs(jitterLevel: number, connection?: MediaEngineConnection): number {
    if (latencyProofOverride) {
        return latencyProofOverride.minimumOutputDelayMs;
    }
    if (!settings.store.voiceBufferEnabled)
        return 0;
    if (settings.store.profile === "custom") {
        return clamp(settings.store.customMinimumOutputDelayMs, 0, MAX_DIRECT_OUTPUT_DELAY_MS);
    }
    if (profileUsesSmartStrategy(settings.store.profile as BufferProfile)) {
        const strategy = getSmartStrategy(jitterLevel);
        if (strategy) {
            return connection
                ? getSmartFloorState(connection, jitterLevel).floorMs
                : strategy.floorsMs[0];
        }
    }
    return clamp(Math.round(jitterLevel) * OUTPUT_DELAY_MS_PER_LEVEL, 0, MAX_DIRECT_OUTPUT_DELAY_MS);
}
function getVoiceConnections(): MediaEngineConnection[] {
    try {
        const mediaEngine = MediaEngineStore.getMediaEngine?.();
        if (!mediaEngine?.connections)
            return [];
        return Array.from(mediaEngine.connections).filter(connection => connection.context === "default" && !connection.destroyed);
    }
    catch (error) {
        if (settings.store.logging) {
            logger.warn("Could not read voice connections.", error);
        }
        return [];
    }
}
function createNativeApplyState(status: NativeApplyStatus, jitterLevel: number, postponeDecodeLevel: number, minimumOutputDelayMs: number, overrides: Partial<NativeApplyState> = {}): NativeApplyState {
    return {
        status,
        transportCallSucceeded: false,
        outputDelaySupported: false,
        outputDelayCallSucceeded: false,
        jitterLevel,
        postponeDecodeLevel,
        minimumOutputDelayMs,
        updatedAt: Date.now(),
        ...overrides,
    };
}
function setNativeApplyState(connection: MediaEngineConnection, state: NativeApplyState): NativeApplyState {
    nativeApplyStates.set(connection, state);
    if (settings.store.logging) {
        logger.info(`Native state ${connection.mediaEngineConnectionId}: ` +
            `${state.status}, transportCall=${state.transportCallSucceeded}, ` +
            `outputDelaySupported=${state.outputDelaySupported}, ` +
            `outputDelayCallSucceeded=${state.outputDelayCallSucceeded}, ` +
            `L${state.jitterLevel}, minRequest=${state.minimumOutputDelayMs} ms` +
            (state.reason ? `, reason=${state.reason}` : ""));
    }
    return state;
}
function getNativeApplyState(connection: MediaEngineConnection, jitterLevel: number, postponeDecodeLevel: number, minimumOutputDelayMs: number): NativeApplyState {
    return nativeApplyStates.get(connection) ?? createNativeApplyState("waiting", jitterLevel, postponeDecodeLevel, minimumOutputDelayMs, { reason: "Waiting for the Discord native voice transport." });
}
function getConnectionSignature(connection: MediaEngineConnection, jitterLevel: number, postponeDecodeLevel: number, minimumOutputDelayMs: number): string {
    let reconnectCount: number | null = null;
    try {
        reconnectCount = connection.getNumFastUdpReconnects?.() ?? null;
    }
    catch {
        // Some Discord media engine variants may not expose this at runtime.
    }
    return [
        connection.mediaEngineConnectionId,
        connection.connectionState,
        reconnectCount ?? "na",
        jitterLevel,
        postponeDecodeLevel,
        minimumOutputDelayMs,
    ].join(":");
}
function applyNativeBufferTransportOptions(connection: MediaEngineConnection, jitterLevel: number, postponeDecodeLevel: number, minimumOutputDelayMs: number): NativeApplyState {
    let rawConn: any;
    try {
        rawConn = (connection as any).conn;
    }
    catch {
        return setNativeApplyState(connection, createNativeApplyState("waiting", jitterLevel, postponeDecodeLevel, minimumOutputDelayMs, { reason: "Discord native connection is not accessible yet." }));
    }
    if (!rawConn) {
        return setNativeApplyState(connection, createNativeApplyState("waiting", jitterLevel, postponeDecodeLevel, minimumOutputDelayMs, { reason: "Discord native connection is not ready yet." }));
    }
    if (typeof rawConn.setTransportOptions !== "function") {
        return setNativeApplyState(connection, createNativeApplyState("unsupported", jitterLevel, postponeDecodeLevel, minimumOutputDelayMs, { reason: "This Discord build does not expose setTransportOptions()." }));
    }
    const options = {
        minimumJitterBufferLevel: jitterLevel,
        postponeDecodeLevel,
    };
    try {
        rawConn.setTransportOptions(options);
    }
    catch (error) {
        logger.warn("Could not apply Discord native transport options.", error);
        return setNativeApplyState(connection, createNativeApplyState("error", jitterLevel, postponeDecodeLevel, minimumOutputDelayMs, { reason: "setTransportOptions() failed." }));
    }
    const outputDelaySupported = typeof rawConn.setMinimumOutputDelay === "function";
    if (!outputDelaySupported) {
        const zeroFloor = minimumOutputDelayMs <= 0;
        return setNativeApplyState(connection, createNativeApplyState(zeroFloor ? "applied" : "partial", jitterLevel, postponeDecodeLevel, minimumOutputDelayMs, {
            transportCallSucceeded: true,
            outputDelaySupported: false,
            outputDelayCallSucceeded: false,
            reason: zeroFloor
                ? "Native transport call succeeded. This build has no minimum-output-delay API, but the request is 0 ms."
                : "Native transport call succeeded, but this Discord build does not expose setMinimumOutputDelay().",
        }));
    }
    try {
        rawConn.setMinimumOutputDelay(minimumOutputDelayMs);
        return setNativeApplyState(connection, createNativeApplyState("applied", jitterLevel, postponeDecodeLevel, minimumOutputDelayMs, {
            transportCallSucceeded: true,
            outputDelaySupported: true,
            outputDelayCallSucceeded: true,
        }));
    }
    catch (error) {
        logger.warn("Could not apply native minimum output delay.", error);
        return setNativeApplyState(connection, createNativeApplyState("partial", jitterLevel, postponeDecodeLevel, minimumOutputDelayMs, {
            transportCallSucceeded: true,
            outputDelaySupported: true,
            outputDelayCallSucceeded: false,
            reason: "Native transport call succeeded, but setMinimumOutputDelay() failed.",
        }));
    }
}
function applyLevelsToConnection(connection: MediaEngineConnection, jitterLevel: number, postponeDecodeLevel: number, force: boolean): void {
    const minimumOutputDelayMs = getMinimumOutputDelayMs(jitterLevel, connection);
    const signature = getConnectionSignature(connection, jitterLevel, postponeDecodeLevel, minimumOutputDelayMs);
    if (!force && lastApplied.get(connection) === signature)
        return;
    try {
        if (typeof connection.setMinimumJitterBufferLevel !== "function") {
            logger.warn("This Discord build does not expose setMinimumJitterBufferLevel().");
            return;
        }
        connection.setMinimumJitterBufferLevel(jitterLevel);
        if (typeof connection.setPostponeDecodeLevel === "function") {
            connection.setPostponeDecodeLevel(postponeDecodeLevel);
        }
        else {
            logger.warn("This Discord build does not expose setPostponeDecodeLevel().");
        }
        // Critical: the two setters above only mutate JS fields. Discord reads
        // those fields inside getConnectionTransportOptions(), which is passed
        // to the native connection via conn.setTransportOptions(). Without
        // this call, changing L0/L1/L2/etc. after connection setup does not
        // update the native voice engine.
        const nativeState = applyNativeBufferTransportOptions(connection, jitterLevel, postponeDecodeLevel, minimumOutputDelayMs);
        if (!nativeState.transportCallSucceeded)
            return;
        const outputDelayNeedsRetry = minimumOutputDelayMs > 0 &&
            nativeState.outputDelaySupported &&
            !nativeState.outputDelayCallSucceeded;
        if (!outputDelayNeedsRetry) {
            lastApplied.set(connection, signature);
        }
        if (settings.store.logging) {
            logger.info(`Requested L${jitterLevel} on ${connection.mediaEngineConnectionId}: ` +
                `nativeCall=${nativeState.status}, minBufferRequest=${minimumOutputDelayMs} ms, ` +
                `postponeDecode=${postponeDecodeLevel}.`);
        }
    }
    catch (error) {
        logger.warn("Could not apply voice buffer settings.", error);
    }
}
function getAdaptiveState(connection: MediaEngineConnection): AdaptiveState {
    let state = adaptiveStates.get(connection);
    if (!state) {
        state = createAdaptiveState(getAdaptiveConfig());
        adaptiveStates.set(connection, state);
    }
    const { min, max } = normalizeAdaptiveRange(getAdaptiveConfig());
    state.level = Math.min(max, Math.max(min, state.level));
    return state;
}
function applyCurrentModeToConnections(force = false): void {
    const proof = latencyProofOverride;
    const enabled = proof ? true : settings.store.voiceBufferEnabled;
    const postponeDecodeLevel = proof
        ? proof.postponeDecodeLevel
        : getPostponeDecodeLevel();
    const adaptive = !proof && enabled && settings.store.profile === "adaptive";
    for (const connection of getVoiceConnections()) {
        const jitterLevel = proof
            ? proof.jitterLevel
            : !enabled
                ? DISCORD_DEFAULT_MINIMUM_JITTER_BUFFER_LEVEL
                : adaptive
                    ? getAdaptiveState(connection).level
                    : getManualJitterLevel();
        applyLevelsToConnection(connection, jitterLevel, postponeDecodeLevel, force);
    }
}
function clearApplyTimers(): void {
    for (const timer of applyTimers)
        clearTimeout(timer);
    applyTimers = [];
}
function queueApply(force = true): void {
    clearApplyTimers();
    // Discord can recreate the media connection shortly after a Flux voice event.
    for (const delay of [0, 250, 1000]) {
        applyTimers.push(setTimeout(() => {
            applyCurrentModeToConnections(force);
            if (shouldSampleStats())
                void sampleAdaptiveConnections();
        }, delay));
    }
}
function stopAdaptiveLoop(): void {
    if (adaptiveTimer !== null) {
        clearInterval(adaptiveTimer);
        adaptiveTimer = null;
    }
}
function shouldSampleStats(): boolean {
    const profile = settings.store.profile as BufferProfile;
    return (latencyProofRunning ||
        latencyProofOverride !== null ||
        (settings.store.voiceBufferEnabled && profileUsesSmartStrategy(profile)) ||
        settings.store.quickPanel ||
        settings.store.logging);
}
function startAdaptiveLoop(): void {
    stopAdaptiveLoop();
    if (!shouldSampleStats())
        return;
    void sampleAdaptiveConnections();
    adaptiveTimer = setInterval(() => void sampleAdaptiveConnections(), ADAPTIVE_SAMPLE_INTERVAL_MS);
}
function refreshMode(): void {
    smartFloorStates = new WeakMap<MediaEngineConnection, SmartFloorState>();
    startAdaptiveLoop();
    queueApply(true);
}
function handleVoiceBufferEnabledChange(): void {
    adaptiveStates = new WeakMap<MediaEngineConnection, AdaptiveState>();
    smartFloorStates = new WeakMap<MediaEngineConnection, SmartFloorState>();
    remoteAudioActivityStates = new WeakMap<MediaEngineConnection, RemoteAudioActivityState>();
    sampleInFlight = new WeakSet<MediaEngineConnection>();
    recentFluxMetrics.clear();
    // OFF is a real bypass: restore Discord defaults immediately while keeping
    // the quick status UI and diagnostics available.
    applyCurrentModeToConnections(true);
    startAdaptiveLoop();
}
function resetAdaptiveState(): void {
    adaptiveStates = new WeakMap<MediaEngineConnection, AdaptiveState>();
    smartFloorStates = new WeakMap<MediaEngineConnection, SmartFloorState>();
    sampleInFlight = new WeakSet<MediaEngineConnection>();
    recentFluxMetrics.clear();
    queueApply(true);
}
function resetConnections(): void {
    clearApplyTimers();
    stopAdaptiveLoop();
    for (const connection of getVoiceConnections()) {
        try {
            connection.setMinimumJitterBufferLevel?.(DISCORD_DEFAULT_MINIMUM_JITTER_BUFFER_LEVEL);
            connection.setPostponeDecodeLevel?.(DISCORD_DEFAULT_POSTPONE_DECODE_LEVEL);
            applyNativeBufferTransportOptions(connection, DISCORD_DEFAULT_MINIMUM_JITTER_BUFFER_LEVEL, DISCORD_DEFAULT_POSTPONE_DECODE_LEVEL, 0);
        }
        catch (error) {
            logger.warn("Could not reset VoiceBuffer settings.", error);
        }
    }
    lastApplied = new WeakMap<MediaEngineConnection, string>();
    adaptiveStates = new WeakMap<MediaEngineConnection, AdaptiveState>();
    sampleInFlight = new WeakSet<MediaEngineConnection>();
    recentFluxMetrics.clear();
    lastRawFluxLogAt = 0;
    bufferProbeCounters = new WeakMap<MediaEngineConnection, Map<string, BufferProbeCounter>>();
    bufferProbeSnapshots = new WeakMap<MediaEngineConnection, BufferProbeMetrics>();
    nativeApplyStates = new WeakMap<MediaEngineConnection, NativeApplyState>();
    smartFloorStates = new WeakMap<MediaEngineConnection, SmartFloorState>();
    remoteAudioActivityStates = new WeakMap<MediaEngineConnection, RemoteAudioActivityState>();
}
function formatMetric(value: number | undefined, suffix: string): string {
    return value === undefined ? "n/a" : `${value.toFixed(2)}${suffix}`;
}
function stringifyForLog(value: unknown, maxLength = 24000): string {
    const seen = new WeakSet<object>();
    try {
        const json = JSON.stringify(value, (_key, current) => {
            if (typeof current === "bigint")
                return `${current}n`;
            if (current instanceof Map) {
                return {
                    __type: "Map",
                    entries: Array.from(current.entries()),
                };
            }
            if (current instanceof Set) {
                return {
                    __type: "Set",
                    values: Array.from(current.values()),
                };
            }
            if (current !== null && typeof current === "object") {
                if (seen.has(current))
                    return "[Circular]";
                seen.add(current);
            }
            return current;
        });
        if (!json)
            return String(value);
        return json.length > maxLength
            ? `${json.slice(0, maxLength)}...[truncated ${json.length - maxLength} chars]`
            : json;
    }
    catch {
        try {
            return String(value);
        }
        catch {
            return "[unserializable]";
        }
    }
}
function readNumericProperty(record: Record<string, unknown>, normalizedName: string): {
    rawKey: string;
    value: number;
} | null {
    for (const [rawKey, rawValue] of Object.entries(record)) {
        const key = rawKey.toLowerCase().replace(/[^a-z0-9]/g, "");
        const unitlessKey = key
            .replace(/milliseconds?$/, "")
            .replace(/msecs?$/, "")
            .replace(/ms$/, "")
            .replace(/microseconds?$/, "")
            .replace(/usecs?$/, "")
            .replace(/us$/, "");
        if (key !== normalizedName && unitlessKey !== normalizedName)
            continue;
        const value = finiteNumber(rawValue);
        if (value !== undefined)
            return { rawKey, value };
    }
    return null;
}
function normalizeBufferSeconds(rawKey: string, value: number): number {
    const key = rawKey.toLowerCase();
    if (key.includes("microsecond") ||
        key.includes("usec") ||
        key.endsWith("us") ||
        /(^|_)us($|_)/.test(key))
        return value / 1000000;
    if (key.includes("millisecond") ||
        key.includes("msec") ||
        key.endsWith("ms") ||
        /(^|_)ms($|_)/.test(key))
        return value / 1000;
    // W3C jitterBufferDelay, jitterBufferTargetDelay and
    // jitterBufferMinimumDelay are accumulated seconds.
    return value;
}
function collectBufferStatRecords(root: unknown, source: string): BufferStatRecord[] {
    const records: BufferStatRecord[] = [];
    const seen = new WeakSet<object>();
    let visited = 0;
    function walk(value: unknown, path: string, depth: number): void {
        if (depth > 10 || visited > 4000 || value === null || typeof value !== "object")
            return;
        if (seen.has(value))
            return;
        seen.add(value);
        visited++;
        if (value instanceof Map) {
            let index = 0;
            for (const [mapKey, child] of value.entries()) {
                walk(child, `${path}.map[${String(mapKey)}:${index++}]`, depth + 1);
            }
            return;
        }
        if (value instanceof Set) {
            let index = 0;
            for (const child of value.values()) {
                walk(child, `${path}.set[${index++}]`, depth + 1);
            }
            return;
        }
        if (Array.isArray(value)) {
            value.forEach((child, index) => walk(child, `${path}[${index}]`, depth + 1));
            return;
        }
        let entries: Array<[
            string,
            unknown
        ]>;
        try {
            entries = Object.entries(value as Record<string, unknown>);
        }
        catch {
            return;
        }
        const record = Object.fromEntries(entries) as Record<string, unknown>;
        const kind = String(record.kind ?? record.mediaType ?? "").toLowerCase();
        // Do not mix screenshare/video jitter buffering into a voice measurement.
        if (kind !== "video") {
            const delay = readNumericProperty(record, "jitterbufferdelay");
            const emitted = readNumericProperty(record, "jitterbufferemittedcount");
            if (delay && emitted && delay.value >= 0 && emitted.value >= 0) {
                const target = readNumericProperty(record, "jitterbuffertargetdelay");
                const minimum = readNumericProperty(record, "jitterbufferminimumdelay");
                const id = String(record.id ?? record.ssrc ?? record.trackIdentifier ?? path);
                records.push({
                    key: `${source}:${id}`,
                    delaySeconds: normalizeBufferSeconds(delay.rawKey, delay.value),
                    targetSeconds: target
                        ? normalizeBufferSeconds(target.rawKey, target.value)
                        : undefined,
                    minimumSeconds: minimum
                        ? normalizeBufferSeconds(minimum.rawKey, minimum.value)
                        : undefined,
                    emittedCount: emitted.value,
                });
            }
        }
        for (const [key, child] of entries) {
            if (child !== null && typeof child === "object") {
                walk(child, `${path}.${key}`, depth + 1);
            }
        }
    }
    walk(root, source, 0);
    return records;
}
function calculateBufferProbeMetrics(connection: MediaEngineConnection, root: unknown, source: string): BufferProbeMetrics | null {
    const records = collectBufferStatRecords(root, source);
    if (records.length === 0)
        return null;
    let counters = bufferProbeCounters.get(connection);
    if (!counters) {
        counters = new Map<string, BufferProbeCounter>();
        bufferProbeCounters.set(connection, counters);
    }
    let intervalDelay = 0;
    let intervalTarget = 0;
    let intervalMinimum = 0;
    let intervalCount = 0;
    let intervalTargetCount = 0;
    let intervalMinimumCount = 0;
    let lifetimeDelay = 0;
    let lifetimeTarget = 0;
    let lifetimeMinimum = 0;
    let lifetimeCount = 0;
    let lifetimeTargetCount = 0;
    let lifetimeMinimumCount = 0;
    for (const record of records) {
        if (record.emittedCount > 0) {
            lifetimeDelay += record.delaySeconds;
            lifetimeCount += record.emittedCount;
            if (record.targetSeconds !== undefined) {
                lifetimeTarget += record.targetSeconds;
                lifetimeTargetCount += record.emittedCount;
            }
            if (record.minimumSeconds !== undefined) {
                lifetimeMinimum += record.minimumSeconds;
                lifetimeMinimumCount += record.emittedCount;
            }
        }
        const previous = counters.get(record.key);
        if (previous) {
            const emittedDelta = record.emittedCount - previous.emittedCount;
            const delayDelta = record.delaySeconds - previous.delaySeconds;
            if (emittedDelta > 0 && delayDelta >= 0) {
                intervalDelay += delayDelta;
                intervalCount += emittedDelta;
                if (record.targetSeconds !== undefined &&
                    previous.targetSeconds !== undefined) {
                    const targetDelta = record.targetSeconds - previous.targetSeconds;
                    if (targetDelta >= 0) {
                        intervalTarget += targetDelta;
                        intervalTargetCount += emittedDelta;
                    }
                }
                if (record.minimumSeconds !== undefined &&
                    previous.minimumSeconds !== undefined) {
                    const minimumDelta = record.minimumSeconds - previous.minimumSeconds;
                    if (minimumDelta >= 0) {
                        intervalMinimum += minimumDelta;
                        intervalMinimumCount += emittedDelta;
                    }
                }
            }
        }
        counters.set(record.key, {
            delaySeconds: record.delaySeconds,
            targetSeconds: record.targetSeconds,
            minimumSeconds: record.minimumSeconds,
            emittedCount: record.emittedCount,
        });
    }
    if (intervalCount > 0) {
        return {
            actualMs: intervalDelay / intervalCount * 1000,
            targetMs: intervalTargetCount > 0
                ? intervalTarget / intervalTargetCount * 1000
                : undefined,
            minimumMs: intervalMinimumCount > 0
                ? intervalMinimum / intervalMinimumCount * 1000
                : undefined,
            emittedDelta: intervalCount,
            source,
            sampleMode: "interval",
            updatedAt: Date.now(),
        };
    }
    if (lifetimeCount > 0) {
        return {
            actualMs: lifetimeDelay / lifetimeCount * 1000,
            targetMs: lifetimeTargetCount > 0
                ? lifetimeTarget / lifetimeTargetCount * 1000
                : undefined,
            minimumMs: lifetimeMinimumCount > 0
                ? lifetimeMinimum / lifetimeMinimumCount * 1000
                : undefined,
            emittedDelta: 0,
            source,
            sampleMode: "lifetime",
            updatedAt: Date.now(),
        };
    }
    return null;
}
function preferBufferProbeSnapshot(current: BufferProbeMetrics | undefined, candidate: BufferProbeMetrics | null): BufferProbeMetrics | undefined {
    if (!candidate)
        return current;
    if (!current)
        return candidate;
    const rank = (mode: BufferProbeMetrics["sampleMode"]) => mode === "instant" ? 3 : mode === "interval" ? 2 : mode === "lifetime" ? 1 : 0;
    if (rank(candidate.sampleMode) > rank(current.sampleMode)) {
        return candidate;
    }
    const candidateIsReceiver = candidate.source?.startsWith("RTCRtpReceiver") ?? false;
    const currentIsReceiver = current.source?.startsWith("RTCRtpReceiver") ?? false;
    if (candidateIsReceiver && !currentIsReceiver)
        return candidate;
    if ((candidate.updatedAt ?? 0) >= (current.updatedAt ?? 0))
        return candidate;
    return current;
}
function storeBufferProbeSnapshot(connection: MediaEngineConnection, candidate: BufferProbeMetrics | null): void {
    const selected = preferBufferProbeSnapshot(bufferProbeSnapshots.get(connection), candidate);
    if (selected)
        bufferProbeSnapshots.set(connection, selected);
}
function getBufferProbeSnapshot(connection: MediaEngineConnection | undefined): BufferProbeMetrics {
    if (!connection)
        return {};
    return bufferProbeSnapshots.get(connection) ?? {};
}
function logAdaptiveSnapshot(connection: MediaEngineConnection, state: AdaptiveState, desiredLevel: number, hasSignal: boolean): void {
    if (!settings.store.logging)
        return;
    const metrics = state.lastMetrics;
    logger.info(`Adaptive diagnostics | connection=${connection.mediaEngineConnectionId}` +
        ` current=${state.level} desired=${desiredLevel} signal=${hasSignal ? "yes" : "no"}` +
        ` jitter=${formatMetric(metrics.jitterMs, "ms")}` +
        ` rttVariation=${formatMetric(metrics.rttVariationMs, "ms")}` +
        ` rtt=${formatMetric(metrics.rttMs, "ms")}` +
        ` loss=${formatMetric(metrics.lossPercent, "%")}` +
        ` sources=${metrics.sources.join(",") || "none"}`);
}
function updateAdaptiveConnection(connection: MediaEngineConnection, metrics: NetworkMetrics): void {
    const state = getAdaptiveState(connection);
    const decision = evaluateAdaptiveLevel(state, metrics, getAdaptiveConfig(), Date.now());
    if (decision.changed) {
        applyLevelsToConnection(connection, decision.newLevel, getPostponeDecodeLevel(), true);
        if (settings.store.logging) {
            logger.info(`Adaptive jitter buffer ${decision.direction === "up" ? "increased" : "decreased"}` +
                ` ${decision.oldLevel} -> ${decision.newLevel}.`);
        }
    }
    logAdaptiveSnapshot(connection, state, decision.desiredLevel, decision.hasSignal);
}
async function sampleConnection(connection: MediaEngineConnection): Promise<void> {
    if (sampleInFlight.has(connection) || connection.destroyed)
        return;
    sampleInFlight.add(connection);
    try {
        const state = getAdaptiveState(connection);
        let statsMetrics: NetworkMetrics = { sources: [] };
        let filteredStats: object | null = null;
        try {
            if (typeof connection.getStats === "function") {
                filteredStats = await connection.getStats();
                if (filteredStats) {
                    statsMetrics = extractMetrics(filteredStats, "getStats");
                    const bufferCandidate = calculateBufferProbeMetrics(connection, filteredStats, "MediaEngine.getStats");
                    const nativeInboundProbe = extractDiscordNativeInboundProbe(filteredStats);
                    storeBufferProbeSnapshot(connection, bufferCandidate);
                    handleLatencyProofNativeStats(connection, nativeInboundProbe, bufferCandidate);
                }
            }
        }
        catch (error) {
            if (settings.store.logging) {
                logger.warn("Could not read Media Engine stats.", error);
            }
        }
        const fluxMetrics = getRecentFluxMetrics();
        const combined = combineCurrentMetrics(statsMetrics, fluxMetrics);
        if (combined.rttMs !== undefined) {
            state.rttHistory.push(combined.rttMs);
            if (state.rttHistory.length > MAX_RTT_HISTORY)
                state.rttHistory.shift();
            combined.rttVariationMs = calculateRttVariationMs(state.rttHistory);
            if (combined.rttVariationMs !== undefined &&
                !combined.sources.includes("rtt-variation")) {
                combined.sources.push("rtt-variation");
            }
        }
        if (settings.store.logging &&
            Date.now() - state.lastRawLogAt >= RAW_LOG_INTERVAL_MS) {
            state.lastRawLogAt = Date.now();
            logger.info(`VoiceBuffer diagnostics | connection=${connection.mediaEngineConnectionId}` +
                ` profile=${settings.store.profile}` +
                ` level=L${settings.store.voiceBufferEnabled
                    ? settings.store.profile === "adaptive"
                        ? state.level
                        : getManualJitterLevel()
                    : 0}` +
                ` minBuffer=${settings.store.voiceBufferEnabled
                    ? getMinimumOutputDelayMs(settings.store.profile === "adaptive" ? state.level : getManualJitterLevel(), connection)
                    : 0}ms` +
                ` buffer=${formatMetric(getBufferProbeSnapshot(connection).actualMs, "ms")}` +
                ` jitter=${formatMetric(combined.jitterMs, "ms")}` +
                ` variation=${formatMetric(combined.rttVariationMs, "ms")}` +
                ` rtt=${formatMetric(combined.rttMs, "ms")}` +
                ` loss=${formatMetric(combined.lossPercent, "%")}`);
            if (filteredStats) {
                logger.info(`VoiceBuffer filtered stats: ${stringifyForLog(filteredStats, 18000)}`);
            }
        }
        if (!latencyProofOverride &&
            settings.store.voiceBufferEnabled &&
            settings.store.profile === "adaptive") {
            updateAdaptiveConnection(connection, combined);
        }
        else {
            state.lastMetrics = combined;
        }
        if (!latencyProofOverride &&
            settings.store.voiceBufferEnabled &&
            profileUsesSmartStrategy(settings.store.profile as BufferProfile)) {
            const effectiveLevel = settings.store.profile === "adaptive"
                ? getAdaptiveState(connection).level
                : getManualJitterLevel();
            const smartUpdate = updateSmartFloorState(connection, combined, effectiveLevel, Date.now());
            if (smartUpdate.changed) {
                applyLevelsToConnection(connection, effectiveLevel, getPostponeDecodeLevel(), true);
                if (settings.store.logging) {
                    logger.info(`Smart ${getSmartStrategyName(effectiveLevel)} floor -> ` +
                        `${smartUpdate.state.floorMs} ms ` +
                        `(severity ${smartUpdate.state.severity}/4).`);
                }
            }
        }
    }
    finally {
        sampleInFlight.delete(connection);
    }
}
async function sampleAdaptiveConnections(): Promise<void> {
    if (!shouldSampleStats())
        return;
    await Promise.all(getVoiceConnections().map(sampleConnection));
}
function ingestFluxMetrics(event: unknown, source: string): void {
    if (!shouldSampleStats())
        return;
    const metrics = extractMetrics(event, source);
    if (metrics.sources.length > 0) {
        recentFluxMetrics.set(source, {
            metrics,
            timestamp: Date.now(),
        });
    }
    if (settings.store.logging &&
        Date.now() - lastRawFluxLogAt >= RAW_LOG_INTERVAL_MS) {
        lastRawFluxLogAt = Date.now();
        logger.info(`VoiceBuffer ${source}: ${stringifyForLog(event)}`);
    }
}
const settings = definePluginSettings({
    voiceBufferEnabled: {
        type: OptionType.BOOLEAN,
        displayName: "VoiceBuffer",
        description: "Enable VoiceBuffer. Turning it off immediately restores Discord's default voice buffering.",
        default: true,
        onChange: handleVoiceBufferEnabledChange,
    },
    profile: {
        type: OptionType.SELECT,
        displayName: "Mode",
        description: "Adaptive is recommended and automatically balances latency and stability. Choose L1-L4 to set the protection level manually.",
        options: [
            { label: "Adaptive (Recommended)", value: "adaptive", default: true },
            { label: "L1 - Low Latency", value: "low" },
            { label: "L2 - Balanced", value: "balanced" },
            { label: "L3 - Stable", value: "high" },
            { label: "L4 - Maximum Stability", value: "veryHigh" },
            { label: "Custom (Advanced)", value: "custom" },
        ],
        onChange: refreshMode,
    },
    customJitterLevel: {
        type: OptionType.SLIDER,
        displayName: "Custom Jitter Level",
        description: "Advanced. Set Discord's raw minimum jitter-buffer level directly. Higher levels favor stability over latency.",
        markers: [0, 1, 2, 3, 4, 5, 6, 8, 10],
        default: 2,
        stickToMarkers: true,
        onChange: () => queueApply(true),
    },
    customMinimumOutputDelayMs: {
        type: OptionType.SLIDER,
        displayName: "Custom Min Buffer*",
        description: "Advanced. Set the native receive-buffer floor request, up to 200 ms. Discord may keep a higher target and the actual buffer still adapts dynamically.",
        markers: [0, 10, 20, 30, 40, 60, 80, 100, 120, 160, 200],
        default: 40,
        stickToMarkers: true,
        onChange: () => queueApply(true),
    },
    adaptiveSensitivity: {
        type: OptionType.SELECT,
        displayName: "Adaptive Sensitivity",
        description: "How quickly Adaptive increases protection when network timing becomes unstable.",
        options: [
            { label: "Conservative", value: "conservative" },
            { label: "Balanced (Recommended)", value: "balanced", default: true },
            { label: "Responsive", value: "responsive" },
        ],
        onChange: resetAdaptiveState,
    },
    adaptiveMinLevel: {
        type: OptionType.SELECT,
        displayName: "Minimum Protection",
        description: "Lowest level Adaptive can use. L1 is recommended.",
        options: [
            { label: "L0 - Discord Minimum", value: 0 },
            { label: "L1 - Recommended", value: 1, default: true },
            { label: "L2 - Higher Baseline", value: 2 },
        ],
        onChange: resetAdaptiveState,
    },
    adaptiveMaxLevel: {
        type: OptionType.SELECT,
        displayName: "Maximum Protection",
        description: "Highest level Adaptive can use. L4 is recommended for normal use.",
        options: [
            { label: "L2 - Balanced", value: 2 },
            { label: "L3 - Stable", value: 3 },
            { label: "L4 - Recommended", value: 4, default: true },
            { label: "L5 - Extreme", value: 5 },
            { label: "L6 - Extreme+", value: 6 },
        ],
        onChange: resetAdaptiveState,
    },
    adaptiveUsePacketLoss: {
        type: OptionType.BOOLEAN,
        displayName: "Packet Loss Signal (Recommended)",
        description: "Use packet loss as an additional warning signal alongside jitter and RTT variation. Recommended.",
        default: true,
        onChange: resetAdaptiveState,
    },
    postponeDecode: {
        type: OptionType.BOOLEAN,
        displayName: "Postpone Decode (Not Recommended)",
        description: "Not recommended for normal use. Changes Discord's decode scheduling separately from the jitter buffer. Keep Off unless specifically testing decode/concealment behavior.",
        default: false,
        onChange: () => queueApply(true),
    },
    postponeDecodeLevel: {
        type: OptionType.SLIDER,
        displayName: "Postpone Decode Level",
        description: "Advanced experimental raw value. The scale is undocumented, so its values must not be interpreted as milliseconds or as a guaranteed linear amount of delay.",
        markers: [25, 50, 75, 100],
        default: DISCORD_DEFAULT_POSTPONE_DECODE_LEVEL,
        stickToMarkers: true,
        onChange: () => queueApply(true),
    },
    quickPanel: {
        type: OptionType.BOOLEAN,
        displayName: "Quick Panel",
        description: "Show quick VoiceBuffer controls and live network stats beside Discord's Voice Connected panel.",
        default: true,
        onChange: refreshQuickUiVisibility,
    },
    logging: {
        type: OptionType.BOOLEAN,
        displayName: "Logging",
        description: "Developer diagnostics only.",
        default: false,
        onChange: startAdaptiveLoop,
    },
    advancedDiagnostics: {
        type: OptionType.COMPONENT,
        displayName: "Advanced / Diagnostics",
        description: "Experimental controls, logging and native verification.",
        component: AdvancedDiagnostics,
    },
    repositoryInfo: {
        type: OptionType.COMPONENT,
        displayName: "Repository",
        description: "Version, source code and project releases.",
        component: () => <div style={{
            padding: "10px 12px",
            borderRadius: "8px",
            background: "var(--background-secondary)",
            lineHeight: "1.45",
        }}><div style={{
            marginBottom: "4px",
            color: "var(--text-normal)",
            fontWeight: 600,
        }}>{`VoiceBuffer v${VOICEBUFFER_VERSION}`}</div><div style={{
            marginBottom: "4px",
            color: "var(--text-muted)",
            fontSize: "13px",
        }}>by Luiz Bizzio</div><a href={VOICEBUFFER_REPOSITORY_URL} target="_blank" rel="noreferrer noopener" style={{
            color: "var(--text-link)",
        }}>github.com/luizbizzio/voicebuffer</a></div>,
    },
}, {
    customJitterLevel: {
        hidden() { return this.store.profile !== "custom"; },
    },
    customMinimumOutputDelayMs: {
        hidden() { return this.store.profile !== "custom"; },
    },
    adaptiveSensitivity: {
        hidden() { return this.store.profile !== "adaptive"; },
    },
    adaptiveMinLevel: {
        hidden() { return this.store.profile !== "adaptive"; },
    },
    adaptiveMaxLevel: {
        hidden() { return this.store.profile !== "adaptive"; },
    },
    adaptiveUsePacketLoss: {
        hidden() {
            return !profileUsesSmartStrategy(this.store.profile as BufferProfile);
        },
    },
    postponeDecode: {
        hidden() { return true; },
    },
    postponeDecodeLevel: {
        hidden() { return true; },
    },
    logging: {
        hidden() { return true; },
    },
});
const QUICK_HOST_ID = "voicebuffer-quick-host";
const QUICK_HOVER_ID = "voicebuffer-quick-hover";
const QUICK_STYLE_ID = "voicebuffer-quick-style";
const QUICK_REFRESH_MS = 1000;
const QUICK_HOVER_CLOSE_DELAY_MS = 440;
let quickObserver: MutationObserver | null = null;
let quickRefreshTimer: ReturnType<typeof setInterval> | null = null;
let quickReactRoot: ReturnType<typeof createRoot> | null = null;
let quickHoverRoot: ReturnType<typeof createRoot> | null = null;
let quickHoverHost: HTMLDivElement | null = null;
let quickHoverAnchor: HTMLElement | null = null;
let quickHoverCloseTimer: ReturnType<typeof setTimeout> | null = null;
let pluginForModal: Parameters<typeof openPluginModal>[0] | null = null;
let quickAnchorMissLogged = false;
const PROFILE_LABELS: Record<BufferProfile, string> = {
    adaptive: "Adaptive",
    low: "Low",
    balanced: "Balanced",
    high: "High",
    veryHigh: "Very High",
    custom: "Custom",
};
const PROFILE_SHORT: Record<BufferProfile, string> = {
    adaptive: "A",
    low: "L",
    balanced: "B",
    high: "H",
    veryHigh: "VH",
    custom: "C",
};
const QUICK_PROFILES: Array<{
    label: string;
    value: BufferProfile;
}> = [
    { label: "Auto", value: "adaptive" },
    { label: "L1", value: "low" },
    { label: "L2", value: "balanced" },
    { label: "L3", value: "high" },
    { label: "L4", value: "veryHigh" },
];
const QUICK_SENSITIVITIES: Array<{
    label: string;
    value: AdaptiveSensitivity;
}> = [
    { label: "Conservative", value: "conservative" },
    { label: "Balanced", value: "balanced" },
    { label: "Responsive", value: "responsive" },
];
function ensureQuickStyles(): void {
    if (document.getElementById(QUICK_STYLE_ID))
        return;
    const style = document.createElement("style");
    style.id = QUICK_STYLE_ID;
    style.textContent = `
        #${QUICK_HOVER_ID} {
            --vb-text: var(--text-default, var(--text-normal, #dbdee1));
            --vb-muted: var(--text-muted, var(--text-secondary, #949ba4));
            --vb-border: var(--border-subtle, var(--border-faint, rgba(255,255,255,.08)));
            --vb-brand: var(--brand-500, #5865f2);
            --vb-positive: var(--status-positive, #23a55a);
            --vb-warning: var(--status-warning, #f0b232);
            --vb-danger: var(--status-danger, #f23f42);
            --vb-bg: var(--background-secondary, #232428);
            --vb-card: var(--background-mod-subtle, rgba(255,255,255,.055));
            --vb-card-hover: var(--background-modifier-hover, rgba(255,255,255,.08));
            color: var(--vb-text);
            font-family: var(--font-primary, "gg sans", "Noto Sans", sans-serif);
            pointer-events: auto;
        }

        #${QUICK_HOVER_ID} * { box-sizing: border-box; }

        #${QUICK_HOVER_ID} .vb-panel {
            position: relative;
            width: min(430px, calc(100vw - 18px));
            padding: 15px;
            border: 1px solid var(--vb-border);
            border-radius: 11px;
            background: var(--vb-bg);
            color: var(--vb-text);
            box-shadow: 0 8px 24px rgba(0,0,0,.30);
            overflow: visible;
            animation: vb-pop-in .10s ease-out;
        }

        #${QUICK_HOVER_ID} .vb-panel::before,
        #${QUICK_HOVER_ID} .vb-panel::after {
            content: "";
            position: absolute;
            left: var(--vb-arrow-x, 50%);
            width: 0;
            height: 0;
            transform: translateX(-50%);
            pointer-events: none;
        }

        #${QUICK_HOVER_ID}[data-placement="top"] .vb-panel::before {
            bottom: -8px;
            border-left: 8px solid transparent;
            border-right: 8px solid transparent;
            border-top: 8px solid var(--vb-border);
        }

        #${QUICK_HOVER_ID}[data-placement="top"] .vb-panel::after {
            bottom: -7px;
            border-left: 7px solid transparent;
            border-right: 7px solid transparent;
            border-top: 7px solid var(--vb-bg);
        }

        #${QUICK_HOVER_ID}[data-placement="bottom"] .vb-panel::before {
            top: -8px;
            border-left: 8px solid transparent;
            border-right: 8px solid transparent;
            border-bottom: 8px solid var(--vb-border);
        }

        #${QUICK_HOVER_ID}[data-placement="bottom"] .vb-panel::after {
            top: -7px;
            border-left: 7px solid transparent;
            border-right: 7px solid transparent;
            border-bottom: 7px solid var(--vb-bg);
        }

        @keyframes vb-pop-in {
            from { opacity: 0; transform: translateY(2px) scale(.99); }
            to { opacity: 1; transform: translateY(0) scale(1); }
        }

        #${QUICK_HOVER_ID} .vb-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
        }

        #${QUICK_HOVER_ID} .vb-heading {
            min-width: 0;
        }

        #${QUICK_HOVER_ID} .vb-title-row {
            display: flex;
            align-items: baseline;
            gap: 6px;
            min-width: 0;
        }

        #${QUICK_HOVER_ID} .vb-title {
            color: var(--vb-text);
            font-size: 17px;
            line-height: 20px;
            font-weight: 700;
        }

        #${QUICK_HOVER_ID} .vb-version {
            color: var(--vb-muted);
            font-size: 11px;
            line-height: 14px;
            font-weight: 500;
            white-space: nowrap;
        }

        #${QUICK_HOVER_ID} .vb-subtitle {
            margin-top: 2px;
            color: var(--vb-muted);
            font-size: 12px;
            line-height: 15px;
        }

        #${QUICK_HOVER_ID} .vb-header-actions {
            display: flex;
            align-items: center;
            gap: 7px;
            flex: 0 0 auto;
        }

        #${QUICK_HOVER_ID} .vb-quality {
            display: flex;
            align-items: center;
            gap: 5px;
            white-space: nowrap;
            font-size: 11px;
            font-weight: 700;
        }

        #${QUICK_HOVER_ID} .vb-quality-dot {
            width: 7px;
            height: 7px;
            border-radius: 50%;
        }

        #${QUICK_HOVER_ID} .vb-master {
            appearance: none;
            border: 1px solid var(--vb-border);
            border-radius: 7px;
            background: var(--vb-card);
            color: var(--vb-text);
            height: 32px;
            padding: 0 8px 0 10px;
            display: flex;
            align-items: center;
            gap: 7px;
            font-family: inherit;
            font-size: 11px;
            font-weight: 700;
            cursor: pointer;
        }

        #${QUICK_HOVER_ID} .vb-master[data-enabled="false"] { color: var(--vb-muted); }

        #${QUICK_HOVER_ID} .vb-gear {
            appearance: none;
            width: 32px;
            height: 32px;
            padding: 0;
            border: 1px solid var(--vb-border);
            border-radius: 7px;
            background: var(--vb-card);
            color: var(--vb-muted);
            display: grid;
            place-items: center;
            font-family: inherit;
            font-size: 16px;
            line-height: 1;
            cursor: pointer;
        }

        #${QUICK_HOVER_ID} .vb-gear:hover,
        #${QUICK_HOVER_ID} .vb-master:hover {
            background: var(--vb-card-hover);
            color: var(--vb-text);
        }

        #${QUICK_HOVER_ID} .vb-switch {
            flex: 0 0 auto;
            width: 28px;
            height: 16px;
            padding: 2px;
            border-radius: 999px;
            background: var(--background-modifier-selected, #4e5058);
            transition: background-color .12s ease;
        }

        #${QUICK_HOVER_ID} .vb-switch[data-checked="true"] { background: var(--vb-brand); }

        #${QUICK_HOVER_ID} .vb-switch-knob {
            width: 12px;
            height: 12px;
            border-radius: 50%;
            background: #fff;
            transform: translateX(0);
            transition: transform .12s ease;
        }

        #${QUICK_HOVER_ID} .vb-switch[data-checked="true"] .vb-switch-knob {
            transform: translateX(12px);
        }

        #${QUICK_HOVER_ID} .vb-status {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 10px;
            margin-top: 10px;
            padding: 9px 11px;
            border: 1px solid var(--vb-border);
            border-radius: 8px;
            background: var(--vb-card);
        }

        #${QUICK_HOVER_ID} .vb-status-text {
            min-width: 0;
            overflow: hidden;
            color: var(--vb-muted);
            font-size: 12px;
            line-height: 15px;
            white-space: nowrap;
            text-overflow: ellipsis;
        }

        #${QUICK_HOVER_ID} .vb-buffer {
            flex: 0 0 auto;
            color: var(--vb-text);
            font-size: 13px;
            font-weight: 700;
        }

        #${QUICK_HOVER_ID} .vb-metrics {
            display: grid;
            grid-template-columns: .9fr .9fr .8fr 1.4fr;
            gap: 6px;
            margin-top: 8px;
        }

        #${QUICK_HOVER_ID} .vb-metric {
            min-width: 0;
            padding: 9px 10px;
            border: 1px solid var(--vb-border);
            border-radius: 8px;
            background: var(--vb-card);
        }

        #${QUICK_HOVER_ID} .vb-metric-label,
        #${QUICK_HOVER_ID} .vb-section-title {
            color: var(--vb-muted);
            font-size: 11px;
            line-height: 14px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: .04em;
        }

        #${QUICK_HOVER_ID} .vb-metric-value {
            margin-top: 2px;
            overflow: hidden;
            color: var(--vb-text);
            font-size: 14px;
            line-height: 17px;
            font-weight: 700;
            white-space: nowrap;
            text-overflow: ellipsis;
        }

        #${QUICK_HOVER_ID} .vb-controls {
            transition: opacity .12s ease;
        }

        #${QUICK_HOVER_ID} .vb-controls[data-disabled="true"] {
            opacity: .45;
            pointer-events: none;
            user-select: none;
        }

        #${QUICK_HOVER_ID} .vb-section-title { margin: 10px 0 5px; }

        #${QUICK_HOVER_ID} .vb-segments {
            display: grid;
            grid-template-columns: repeat(5, minmax(0, 1fr));
            gap: 5px;
        }

        #${QUICK_HOVER_ID} .vb-segments.vb-sensitivity {
            grid-template-columns: repeat(3, minmax(0, 1fr));
        }

        #${QUICK_HOVER_ID} .vb-segment {
            appearance: none;
            min-width: 0;
            height: 32px;
            padding: 0 7px;
            border: 1px solid var(--vb-border);
            border-radius: 7px;
            background: var(--vb-card);
            color: var(--vb-text);
            font-family: inherit;
            font-size: 12px;
            font-weight: 650;
            cursor: pointer;
            transition: background-color .12s ease, border-color .12s ease;
        }

        #${QUICK_HOVER_ID} .vb-segment:hover { background: var(--vb-card-hover); }

        #${QUICK_HOVER_ID} .vb-segment[data-active="true"] {
            border-color: var(--vb-brand);
            background: var(--vb-brand);
            color: #fff;
        }

        #${QUICK_HOVER_ID} .vb-segment[data-disabled="true"] {
            opacity: .48;
            cursor: not-allowed;
            background: var(--vb-card);
            color: var(--vb-muted);
            border-color: var(--vb-border);
        }

        #${QUICK_HOVER_ID} .vb-segment[data-disabled="true"]:hover {
            background: var(--vb-card);
        }

        #${QUICK_HOVER_ID} .vb-options {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 6px;
            margin-top: 9px;
        }

        #${QUICK_HOVER_ID} .vb-options[data-single="true"] {
            grid-template-columns: 1fr;
        }

        #${QUICK_HOVER_ID} .vb-toggle {
            appearance: none;
            min-width: 0;
            padding: 9px 10px;
            border: 1px solid var(--vb-border);
            border-radius: 8px;
            background: var(--vb-card);
            color: var(--vb-text);
            font-family: inherit;
            text-align: left;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 9px;
            cursor: pointer;
        }

        #${QUICK_HOVER_ID} .vb-toggle:hover { background: var(--vb-card-hover); }

        #${QUICK_HOVER_ID} .vb-toggle[data-disabled="true"] {
            opacity: .48;
            cursor: not-allowed;
            background: var(--vb-card);
        }

        #${QUICK_HOVER_ID} .vb-toggle[data-disabled="true"]:hover {
            background: var(--vb-card);
        }

        #${QUICK_HOVER_ID} .vb-toggle-title {
            overflow: hidden;
            color: var(--vb-text);
            font-size: 12px;
            line-height: 15px;
            font-weight: 650;
            white-space: nowrap;
            text-overflow: ellipsis;
        }

        #${QUICK_HOVER_ID} .vb-toggle-desc {
            margin-top: 1px;
            overflow: hidden;
            color: var(--vb-muted);
            font-size: 11px;
            line-height: 14px;
            white-space: nowrap;
            text-overflow: ellipsis;
        }

        #${QUICK_HOVER_ID} .vb-info {
            cursor: default;
        }

        #${QUICK_HOVER_ID} .vb-info:hover {
            background: var(--vb-card);
        }

        #${QUICK_HOVER_ID} .vb-info-value {
            flex-shrink: 0;
            color: var(--vb-text);
            font-size: 12px;
            line-height: 15px;
            font-weight: 700;
            white-space: nowrap;
        }


        #${QUICK_HOVER_ID}[data-density="compact"] .vb-panel {
            width: min(395px, calc(100vw - 16px));
            padding: 10px;
        }

        #${QUICK_HOVER_ID}[data-density="compact"] .vb-status {
            margin-top: 7px;
            padding: 6px 8px;
        }

        #${QUICK_HOVER_ID}[data-density="compact"] .vb-metrics { margin-top: 6px; }
        #${QUICK_HOVER_ID}[data-density="compact"] .vb-metric { padding: 6px 7px; }
        #${QUICK_HOVER_ID}[data-density="compact"] .vb-section-title { margin: 7px 0 4px; }
        #${QUICK_HOVER_ID}[data-density="compact"] .vb-segment { height: 26px; }
        #${QUICK_HOVER_ID}[data-density="compact"] .vb-options { margin-top: 6px; }
        #${QUICK_HOVER_ID}[data-density="compact"] .vb-toggle { padding: 6px 7px; }

        #${QUICK_HOVER_ID}[data-density="compact"] .vb-toggle-desc {
            display: none;
        }

        @media (max-width: 430px) {
            #${QUICK_HOVER_ID} .vb-panel { width: calc(100vw - 16px); }
            #${QUICK_HOVER_ID} .vb-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
            #${QUICK_HOVER_ID} .vb-segments { grid-template-columns: repeat(3, minmax(0, 1fr)); }
        }
    `;
    document.head.appendChild(style);
}
function removeQuickStyles(): void {
    document.getElementById(QUICK_STYLE_ID)?.remove();
}
function isTransparentColor(color: string): boolean {
    const normalized = color.replace(/\s+/g, "").toLowerCase();
    return normalized === "transparent" ||
        normalized === "rgba(0,0,0,0)" ||
        normalized.endsWith(",0)");
}
function getDiscordPanelBackground(anchor: HTMLElement): string | null {
    let element: HTMLElement | null = anchor.parentElement;
    for (let depth = 0; element && depth < 10; depth++, element = element.parentElement) {
        const background = getComputedStyle(element).backgroundColor;
        if (background && !isTransparentColor(background))
            return background;
    }
    return null;
}
function isQuickElementVisible(element: HTMLElement): boolean {
    if (!element.isConnected || element.offsetParent === null)
        return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
}
function findVoiceConnectedStatus(): HTMLElement | null {
    const selectors = [
        '[class*="rtcConnectionStatusConnected"]',
        '[class*="rtcConnectionStatus"]',
    ];
    for (const selector of selectors) {
        const match = Array.from(document.querySelectorAll<HTMLElement>(selector))
            .find(isQuickElementVisible);
        if (match)
            return match;
    }
    const labels = new Set([
        "Voice Connected",
        "Connected to Voice",
        "Voz conectada",
        "Conectado por voz",
        "Conexão de voz conectada",
    ]);
    return Array.from(document.querySelectorAll<HTMLElement>("span,div"))
        .find(element => isQuickElementVisible(element) && labels.has(element.textContent?.trim() ?? "")) ?? null;
}
function findDisconnectControl(): HTMLElement | null {
    const patterns = [
        /disconnect/i,
        /hang\s*up/i,
        /desconectar/i,
        /desligar/i,
        /sair da chamada/i,
    ];
    return Array.from(document.querySelectorAll<HTMLElement>('button,[role="button"]'))
        .find(element => {
        if (!isQuickElementVisible(element))
            return false;
        const label = [
            element.getAttribute("aria-label"),
            element.getAttribute("title"),
            element.getAttribute("data-tooltip-text"),
            element.textContent,
        ].filter(Boolean).join(" ");
        return patterns.some(pattern => pattern.test(label));
    }) ?? null;
}
interface QuickInsertTarget {
    parent: HTMLElement;
    before: ChildNode | null;
}
function findQuickInsertTarget(): QuickInsertTarget | null {
    if (getVoiceConnections().length === 0)
        return null;
    const disconnect = findDisconnectControl();
    if (disconnect?.parentElement) {
        return { parent: disconnect.parentElement, before: disconnect };
    }
    const status = findVoiceConnectedStatus();
    if (!status)
        return null;
    let row: HTMLElement | null = status.parentElement;
    for (let depth = 0; row && depth < 5; depth++, row = row.parentElement) {
        const control = row.querySelector<HTMLElement>('button,[role="button"]');
        if (control && control !== status && isQuickElementVisible(control)) {
            return { parent: control.parentElement ?? row, before: control };
        }
    }
    return status.parentElement ? { parent: status.parentElement, before: null } : null;
}
function getQuickSnapshot(): {
    connected: boolean;
    enabled: boolean;
    profile: BufferProfile;
    currentLevel: number;
    desiredLevel: number;
    metrics: NetworkMetrics;
    buffer: BufferProbeMetrics;
    minimumOutputDelayMs: number;
    nativeApply: NativeApplyState;
    smartFloor?: SmartFloorState;
    connectionState: string;
} {
    const enabled = settings.store.voiceBufferEnabled;
    const profile = settings.store.profile as BufferProfile;
    const connection = getVoiceConnections()[0];
    if (!connection) {
        const configuredLevel = profile === "adaptive"
            ? normalizeAdaptiveRange(getAdaptiveConfig()).min
            : getManualJitterLevel();
        return {
            connected: false,
            enabled,
            profile,
            currentLevel: enabled ? configuredLevel : 0,
            desiredLevel: enabled ? configuredLevel : 0,
            metrics: { sources: [] },
            buffer: {},
            minimumOutputDelayMs: enabled ? getMinimumOutputDelayMs(configuredLevel) : 0,
            nativeApply: createNativeApplyState("waiting", enabled ? configuredLevel : 0, getPostponeDecodeLevel(), enabled ? getMinimumOutputDelayMs(configuredLevel) : 0, { reason: "No active Discord voice connection." }),
            connectionState: "DISCONNECTED",
        };
    }
    const state = getAdaptiveState(connection);
    if (latencyProofOverride) {
        return {
            connected: true,
            enabled: true,
            profile,
            currentLevel: latencyProofOverride.jitterLevel,
            desiredLevel: latencyProofOverride.jitterLevel,
            metrics: state.lastMetrics,
            buffer: getBufferProbeSnapshot(connection),
            minimumOutputDelayMs: latencyProofOverride.minimumOutputDelayMs,
            nativeApply: getNativeApplyState(connection, latencyProofOverride.jitterLevel, latencyProofOverride.postponeDecodeLevel, latencyProofOverride.minimumOutputDelayMs),
            connectionState: connection.connectionState,
        };
    }
    if (!enabled) {
        return {
            connected: true,
            enabled: false,
            profile,
            currentLevel: 0,
            desiredLevel: 0,
            metrics: state.lastMetrics,
            buffer: getBufferProbeSnapshot(connection),
            minimumOutputDelayMs: 0,
            nativeApply: getNativeApplyState(connection, 0, DISCORD_DEFAULT_POSTPONE_DECODE_LEVEL, 0),
            connectionState: connection.connectionState,
        };
    }
    if (profile === "adaptive") {
        const metrics = state.lastMetrics;
        const desiredLevel = hasAdaptiveSignal(metrics, settings.store.adaptiveUsePacketLoss)
            ? chooseDesiredLevel(metrics, getAdaptiveConfig())
            : state.level;
        return {
            connected: true,
            enabled: true,
            profile,
            currentLevel: state.level,
            desiredLevel,
            metrics,
            buffer: getBufferProbeSnapshot(connection),
            minimumOutputDelayMs: getMinimumOutputDelayMs(state.level, connection),
            nativeApply: getNativeApplyState(connection, state.level, getPostponeDecodeLevel(), getMinimumOutputDelayMs(state.level, connection)),
            smartFloor: smartFloorStates.get(connection),
            connectionState: connection.connectionState,
        };
    }
    const level = getManualJitterLevel();
    return {
        connected: true,
        enabled: true,
        profile,
        currentLevel: level,
        desiredLevel: level,
        metrics: state.lastMetrics,
        buffer: getBufferProbeSnapshot(connection),
        minimumOutputDelayMs: getMinimumOutputDelayMs(level, connection),
        nativeApply: getNativeApplyState(connection, level, getPostponeDecodeLevel(), getMinimumOutputDelayMs(level, connection)),
        smartFloor: smartFloorStates.get(connection),
        connectionState: connection.connectionState,
    };
}
function getNativeApplyLabel(status: NativeApplyStatus): string {
    switch (status) {
        case "applied": return "Call OK";
        case "partial": return "Partial";
        case "unsupported": return "Unsupported";
        case "error": return "Error";
        default: return "Waiting";
    }
}
function getPostponeDecodeSummary(): string {
    if (latencyProofOverride) {
        return "Off (verification)";
    }
    return settings.store.postponeDecode
        ? `On (raw ${settings.store.postponeDecodeLevel})`
        : "Off";
}
function getMinBufferPresentation(snapshot: {
    enabled: boolean;
    currentLevel: number;
    buffer: BufferProbeMetrics;
    minimumOutputDelayMs: number;
    nativeApply: NativeApplyState;
    smartFloor?: SmartFloorState;
}): {
    value: string;
    title: string;
} {
    const nativeLabel = getNativeApplyLabel(snapshot.nativeApply.status);
    if (!snapshot.enabled) {
        return {
            value: "Discord",
            title: "VoiceBuffer is off. Discord controls receive buffering.",
        };
    }
    const measuredSummary = snapshot.buffer.actualMs !== undefined
        ? ` Measured: ${snapshot.buffer.actualMs.toFixed(1)} ms.`
        : "";
    const requestSummary = `Native receive-buffer floor request: ${snapshot.minimumOutputDelayMs} ms. ` +
        "Actual buffer may be higher.";
    if (snapshot.minimumOutputDelayMs <= 0) {
        return {
            value: "0 ms",
            title: requestSummary + measuredSummary,
        };
    }
    if (snapshot.nativeApply.outputDelayCallSucceeded) {
        return {
            value: `${snapshot.minimumOutputDelayMs} ms`,
            title: requestSummary + measuredSummary,
        };
    }
    return {
        value: `${snapshot.minimumOutputDelayMs} ms`,
        title: `${requestSummary} Native call: ${nativeLabel}.` +
            measuredSummary +
            (snapshot.nativeApply.reason ? ` ${snapshot.nativeApply.reason}` : ""),
    };
}
function quickMetric(value: number | undefined, suffix: string, decimals = 1): string {
    return value === undefined ? "n/a" : `${value.toFixed(decimals)}${suffix}`;
}
function getBufferDisplay(snapshot: {
    enabled: boolean;
    currentLevel: number;
}): string {
    return snapshot.enabled ? `L${snapshot.currentLevel}` : "Discord";
}
function getConnectionQuality(metrics: NetworkMetrics): {
    label: string;
    color: string;
    description: string;
} {
    const loss = metrics.lossPercent ?? 0;
    const variation = metrics.rttVariationMs ?? 0;
    const rtt = metrics.rttMs ?? 0;
    if (loss >= 5 || variation >= 45 || rtt >= 250) {
        return { label: "Poor", color: "var(--vb-danger)", description: "Heavy instability" };
    }
    if (loss >= 2 || variation >= 25 || rtt >= 150) {
        return { label: "Unstable", color: "var(--vb-warning)", description: "Compensating for instability" };
    }
    if (loss >= 0.5 || variation >= 12 || rtt >= 90) {
        return { label: "Fair", color: "var(--vb-warning)", description: "Some network variation" };
    }
    return { label: "Good", color: "var(--vb-positive)", description: "Connection looks stable" };
}
function QuickSwitch(props: {
    checked: boolean;
}) {
    return <div className="vb-switch" data-checked={props.checked ? "true" : "false"}><div className="vb-switch-knob"/></div>;
}
function QuickSegment(props: {
    label: string;
    active: boolean;
    disabled?: boolean;
    onClick(): void;
}) {
    return <button type="button" className="vb-segment" data-active={props.active ? "true" : "false"} data-disabled={props.disabled ? "true" : "false"} aria-pressed={props.active} aria-disabled={props.disabled ? "true" : "false"} disabled={props.disabled} onClick={props.disabled ? undefined : props.onClick}>{props.label}</button>;
}
function QuickToggle(props: {
    label: string;
    description: string;
    checked: boolean;
    disabled?: boolean;
    onChange(): void;
}) {
    return <button type="button" className="vb-toggle" disabled={props.disabled} data-disabled={props.disabled ? "true" : "false"} onClick={props.disabled ? undefined : props.onChange} aria-pressed={props.checked} aria-disabled={props.disabled ? "true" : "false"}><div style={{ minWidth: 0 }}><div className="vb-toggle-title">{props.label}</div><div className="vb-toggle-desc">{props.description}</div></div><QuickSwitch checked={props.checked}/></button>;
}
function QuickInfo(props: {
    label: string;
    description: string;
    value: string;
}) {
    return <div className="vb-toggle vb-info"><div style={{ minWidth: 0 }}><div className="vb-toggle-title">{props.label}</div><div className="vb-toggle-desc">{props.description}</div></div><div className="vb-info-value">{props.value}</div></div>;
}
function QuickMetric(props: {
    label: string;
    value: string;
    title?: string;
}) {
    return <div className="vb-metric" title={props.title}><div className="vb-metric-label">{props.label}</div><div className="vb-metric-value">{props.value}</div></div>;
}
function rerenderQuickHover(): void {
    if (!quickHoverRoot || !quickHoverHost)
        return;
    quickHoverRoot.render(<VoiceBufferHoverPanel />);
}
function cancelQuickHoverClose(): void {
    if (quickHoverCloseTimer !== null) {
        clearTimeout(quickHoverCloseTimer);
        quickHoverCloseTimer = null;
    }
}
function scheduleQuickHoverClose(delay = QUICK_HOVER_CLOSE_DELAY_MS): void {
    cancelQuickHoverClose();
    quickHoverCloseTimer = setTimeout(hideQuickHover, delay);
}
function getPreferredPopoverWidth(): number {
    const viewport = window.innerWidth;
    if (viewport < 430)
        return Math.max(280, viewport - 16);
    if (viewport < 900)
        return 370;
    return 430;
}
function positionQuickHover(): void {
    if (!quickHoverHost || !quickHoverAnchor?.isConnected)
        return;
    const rect = quickHoverAnchor.getBoundingClientRect();
    const viewportPadding = 8;
    const gap = 10;
    const width = Math.min(getPreferredPopoverWidth(), window.innerWidth - viewportPadding * 2);
    quickHoverHost.dataset.density = window.innerHeight < 640 ? "compact" : "normal";
    quickHoverHost.style.width = `${width}px`;
    quickHoverHost.style.maxWidth = `${window.innerWidth - viewportPadding * 2}px`;
    const left = Math.min(window.innerWidth - width - viewportPadding, Math.max(viewportPadding, rect.left + rect.width / 2 - width / 2));
    quickHoverHost.style.left = `${left}px`;
    const anchorCenterX = rect.left + rect.width / 2;
    const arrowX = clamp(anchorCenterX - left, 18, width - 18);
    quickHoverHost.style.setProperty("--vb-arrow-x", `${arrowX}px`);
    const panel = quickHoverHost.querySelector<HTMLElement>(".vb-panel");
    const panelHeight = panel?.getBoundingClientRect().height ?? 320;
    const above = rect.top - gap - viewportPadding;
    const below = window.innerHeight - rect.bottom - gap - viewportPadding;
    if (above >= panelHeight || above >= below) {
        quickHoverHost.dataset.placement = "top";
        const bottom = Math.max(viewportPadding, window.innerHeight - rect.top + gap);
        quickHoverHost.style.top = "auto";
        quickHoverHost.style.bottom = `${bottom}px`;
        const projectedTop = window.innerHeight - bottom - panelHeight;
        if (projectedTop < viewportPadding) {
            quickHoverHost.style.bottom =
                `${Math.max(viewportPadding, window.innerHeight - viewportPadding - panelHeight)}px`;
        }
    }
    else {
        quickHoverHost.dataset.placement = "bottom";
        const top = Math.min(window.innerHeight - panelHeight - viewportPadding, Math.max(viewportPadding, rect.bottom + gap));
        quickHoverHost.style.bottom = "auto";
        quickHoverHost.style.top = `${top}px`;
    }
}
function showQuickHover(anchor: HTMLElement): void {
    cancelQuickHoverClose();
    ensureQuickStyles();
    quickHoverAnchor = anchor;
    if (!quickHoverHost) {
        quickHoverHost = document.createElement("div");
        quickHoverHost.id = QUICK_HOVER_ID;
        quickHoverHost.style.position = "fixed";
        quickHoverHost.style.zIndex = "10000";
        quickHoverHost.style.overflow = "visible";
        document.body.appendChild(quickHoverHost);
        quickHoverRoot = createRoot(quickHoverHost);
    }
    const panelBackground = getDiscordPanelBackground(anchor);
    if (panelBackground)
        quickHoverHost.style.setProperty("--vb-bg", panelBackground);
    rerenderQuickHover();
    requestAnimationFrame(positionQuickHover);
}
function hideQuickHover(): void {
    cancelQuickHoverClose();
    try {
        quickHoverRoot?.unmount();
    }
    catch {
        // Host may already have been removed.
    }
    quickHoverRoot = null;
    quickHoverHost?.remove();
    quickHoverHost = null;
    quickHoverAnchor = null;
}
function VoiceBufferHoverPanel() {
    const [, setTick] = React.useState(0);
    React.useEffect(() => {
        const timer = setInterval(() => {
            setTick(value => value + 1);
            requestAnimationFrame(positionQuickHover);
        }, 500);
        return () => clearInterval(timer);
    }, []);
    const snapshot = getQuickSnapshot();
    const quality = getConnectionQuality(snapshot.metrics);
    const adaptive = settings.store.profile === "adaptive";
    const setProfile = (profile: BufferProfile) => {
        settings.store.profile = profile;
        refreshMode();
        setTick(value => value + 1);
    };
    const setSensitivity = (sensitivity: AdaptiveSensitivity) => {
        settings.store.adaptiveSensitivity = sensitivity;
        resetAdaptiveState();
        setTick(value => value + 1);
    };
    const toggleMaster = () => {
        settings.store.voiceBufferEnabled = !settings.store.voiceBufferEnabled;
        handleVoiceBufferEnabledChange();
        setTick(value => value + 1);
    };
    const openSettings = () => {
        hideQuickHover();
        if (pluginForModal)
            openPluginModal(pluginForModal);
    };
    return <div className="vb-panel" onMouseEnter={cancelQuickHoverClose} onMouseLeave={() => scheduleQuickHoverClose()}><div className="vb-header"><div className="vb-heading"><div className="vb-title-row"><div className="vb-title">VoiceBuffer</div><span className="vb-version">{`v${VOICEBUFFER_VERSION}`}</span></div><div className="vb-subtitle">{snapshot.enabled
        ? `${PROFILE_LABELS[snapshot.profile]} · L${snapshot.currentLevel}` +
            (snapshot.desiredLevel !== snapshot.currentLevel
                ? ` → L${snapshot.desiredLevel}`
                : "")
        : "Bypassed · Discord defaults"}</div></div><div className="vb-header-actions"><div className="vb-quality" style={{ color: quality.color }}><div className="vb-quality-dot" style={{ background: quality.color }}/>{quality.label}</div><button type="button" className="vb-master" data-enabled={snapshot.enabled ? "true" : "false"} onClick={toggleMaster} title={snapshot.enabled ? "Turn VoiceBuffer off" : "Turn VoiceBuffer on"}>{snapshot.enabled ? "On" : "Off"}<QuickSwitch checked={snapshot.enabled}/></button><button type="button" className="vb-gear" onClick={openSettings} aria-label="Open VoiceBuffer settings" title="VoiceBuffer settings">⚙</button></div></div><div className="vb-status"><div className="vb-status-text">{snapshot.enabled ? quality.description : "Voice processing untouched"}</div><div className="vb-buffer">{snapshot.enabled
        ? snapshot.desiredLevel !== snapshot.currentLevel
            ? `L${snapshot.currentLevel} → L${snapshot.desiredLevel}`
            : `L${snapshot.currentLevel}`
        : "OFF"}</div></div><div className="vb-metrics"><QuickMetric label="Ping" value={quickMetric(snapshot.metrics.rttMs, " ms")}/><QuickMetric label="Variation" value={quickMetric(snapshot.metrics.rttVariationMs, " ms")}/><QuickMetric label="Loss" value={quickMetric(snapshot.metrics.lossPercent, "%")}/><QuickMetric label="Min Buffer*" {...getMinBufferPresentation(snapshot)}/></div><div className="vb-controls" data-disabled={snapshot.enabled ? "false" : "true"}><div className="vb-section-title">Mode</div><div className="vb-segments">{QUICK_PROFILES.map(option => <QuickSegment key={option.value} label={option.label} active={settings.store.profile === option.value} onClick={() => setProfile(option.value)}/>)}</div>{adaptive
        ? <><div className="vb-section-title">Adaptive</div><div className="vb-segments vb-sensitivity">{QUICK_SENSITIVITIES.map(option => <QuickSegment key={option.value} label={option.label} active={settings.store.adaptiveSensitivity === option.value} onClick={() => setSensitivity(option.value)}/>)}</div><div className="vb-options" data-single="false"><QuickToggle label="Loss signal" description="Use packet loss as a secondary Smart Profile signal" checked={settings.store.adaptiveUsePacketLoss} onChange={() => {
            settings.store.adaptiveUsePacketLoss =
                !settings.store.adaptiveUsePacketLoss;
            resetAdaptiveState();
            setTick(value => value + 1);
        }}/><QuickInfo label="Adaptive range" description="Protection limits" value={`L${settings.store.adaptiveMinLevel} → L${settings.store.adaptiveMaxLevel}`}/></div></> : null}</div></div>;
}
function VoiceBufferQuickButton() {
    const [, setTick] = React.useState(0);
    React.useEffect(() => {
        const timer = setInterval(() => setTick(value => value + 1), 500);
        return () => clearInterval(timer);
    }, []);
    const snapshot = getQuickSnapshot();
    const targetSuffix = snapshot.enabled && snapshot.desiredLevel !== snapshot.currentLevel
        ? `→${snapshot.desiredLevel}`
        : "";
    const label = snapshot.enabled
        ? `VB · ${PROFILE_SHORT[snapshot.profile]} · L${snapshot.currentLevel}${targetSuffix}`
        : "VB · OFF";
    return <Button variant="secondary" size="xs" aria-label="VoiceBuffer status and quick controls" tabIndex={-1} onMouseEnter={(event: React.MouseEvent<HTMLElement>) => {
        cancelQuickHoverClose();
        showQuickHover(event.currentTarget);
    }} onMouseLeave={() => scheduleQuickHoverClose()} style={{
        width: "82px",
        minWidth: "82px",
        maxWidth: "82px",
        height: "24px",
        padding: "0 8px",
        fontSize: "11px",
        fontWeight: 700,
        whiteSpace: "nowrap",
        textAlign: "center",
        justifyContent: "center",
        borderRadius: "8px",
    }}>{label}</Button>;
}
function destroyQuickHost(): void {
    hideQuickHover();
    try {
        quickReactRoot?.unmount();
    }
    catch {
        // Host may already have been removed by Discord.
    }
    quickReactRoot = null;
    document.getElementById(QUICK_HOST_ID)?.remove();
}
function ensureQuickButton(): void {
    if (!settings.store.quickPanel) {
        destroyQuickHost();
        return;
    }
    const target = findQuickInsertTarget();
    let host = document.getElementById(QUICK_HOST_ID) as HTMLDivElement | null;
    if (!target) {
        if (host)
            destroyQuickHost();
        if (settings.store.logging && getVoiceConnections().length > 0 && !quickAnchorMissLogged) {
            quickAnchorMissLogged = true;
            logger.warn("Quick Panel: voice connection exists, but no Voice Connected UI anchor was found.");
        }
        return;
    }
    quickAnchorMissLogged = false;
    if (host && host.isConnected) {
        if (host.parentElement !== target.parent || (target.before && host.nextSibling !== target.before)) {
            target.parent.insertBefore(host, target.before);
        }
        return;
    }
    if (quickReactRoot) {
        try {
            quickReactRoot.unmount();
        }
        catch {
            // Ignore stale root teardown.
        }
        quickReactRoot = null;
    }
    host = document.createElement("div");
    host.id = QUICK_HOST_ID;
    host.style.display = "flex";
    host.style.alignItems = "center";
    host.style.flex = "0 0 auto";
    host.style.margin = "0 4px";
    target.parent.insertBefore(host, target.before);
    quickReactRoot = createRoot(host);
    quickReactRoot.render(<VoiceBufferQuickButton />);
}
function startQuickUi(): void {
    stopQuickUi();
    if (!settings.store.quickPanel)
        return;
    ensureQuickButton();
    quickObserver = new MutationObserver(() => ensureQuickButton());
    quickObserver.observe(document.body, {
        childList: true,
        subtree: true,
    });
    quickRefreshTimer = setInterval(ensureQuickButton, QUICK_REFRESH_MS);
}
function stopQuickUi(): void {
    quickObserver?.disconnect();
    quickObserver = null;
    if (quickRefreshTimer !== null) {
        clearInterval(quickRefreshTimer);
        quickRefreshTimer = null;
    }
    destroyQuickHost();
    removeQuickStyles();
}
function refreshQuickUiVisibility(): void {
    if (settings.store.quickPanel)
        startQuickUi();
    else
        stopQuickUi();
    startAdaptiveLoop();
}
const VoiceBufferPlugin = definePlugin({
    name: "VoiceBuffer",
    description: "Helps reduce voice glitches caused by jitter and unstable packet timing by dynamically adjusting Discord's receive buffer. Adaptive profiles balance stability and latency automatically, with quick controls and built-in verification.",
    authors: [{ name: "Luiz Bizzio", id: 0n }],
    tags: ["Voice", "Utility"],
    settings,
    start() {
        refreshMode();
        startQuickUi();
    },
    stop() {
        stopLatencyProofTest();
        stopQuickUi();
        resetConnections();
    },
    flux: {
        VOICE_STATE_UPDATES() {
            queueApply(true);
        },
        MEDIA_ENGINE_CONNECTION_STATS(event: unknown) {
            ingestFluxMetrics(event, "MEDIA_ENGINE_CONNECTION_STATS");
            applyCurrentModeToConnections(false);
        },
        RTC_CONNECTION_LOSS_RATE(event: unknown) {
            ingestFluxMetrics(event, "RTC_CONNECTION_LOSS_RATE");
        },
        RTC_CONNECTION_PING(event: unknown) {
            ingestFluxMetrics(event, "RTC_CONNECTION_PING");
        },
    },
});
pluginForModal = VoiceBufferPlugin;
export default VoiceBufferPlugin;
