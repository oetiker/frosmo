/**
 * Sound, synthesised rather than shipped.
 *
 * A handful of oscillator blips costs nothing to download and nothing to
 * decode, which matters for a PWA that should install over a phone tether.
 * iPadOS keeps the audio context suspended until a user gesture resumes it, so
 * unlock() is called from the first tap and every later sound is free.
 */

type Voice = "blip" | "good" | "great" | "bad" | "drop" | "tick";

const VOICES: Record<Voice, { freq: number; to: number; dur: number; type: OscillatorType; gain: number }> = {
  blip: { freq: 660, to: 660, dur: 0.06, type: "sine", gain: 0.18 },
  good: { freq: 520, to: 780, dur: 0.16, type: "sine", gain: 0.22 },
  great: { freq: 660, to: 1320, dur: 0.34, type: "triangle", gain: 0.24 },
  bad: { freq: 300, to: 140, dur: 0.24, type: "sawtooth", gain: 0.16 },
  drop: { freq: 900, to: 380, dur: 0.12, type: "sine", gain: 0.16 },
  tick: { freq: 1200, to: 1200, dur: 0.03, type: "square", gain: 0.08 },
};

export class Audio {
  private ctx: AudioContext | null = null;
  private enabled = true;

  setEnabled(on: boolean): void {
    this.enabled = on;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Call from a user gesture. Safe to call repeatedly. */
  unlock(): void {
    if (!this.ctx) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  play(voice: Voice, detune = 0): void {
    if (!this.enabled || !this.ctx || this.ctx.state !== "running") return;
    const spec = VOICES[voice];
    const now = this.ctx.currentTime;

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = spec.type;
    osc.frequency.setValueAtTime(spec.freq * Math.pow(2, detune / 12), now);
    osc.frequency.exponentialRampToValueAtTime(spec.to * Math.pow(2, detune / 12), now + spec.dur);

    // A short attack and an exponential tail: a raw gate on an oscillator
    // clicks, and a click on every ball bounce is unbearable within a minute.
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(spec.gain, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + spec.dur);

    osc.connect(gain).connect(this.ctx.destination);
    osc.start(now);
    osc.stop(now + spec.dur + 0.02);
  }
}
