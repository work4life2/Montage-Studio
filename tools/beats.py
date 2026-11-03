#!/usr/bin/env python3
"""Beat grid of a song for the edit.

  beats.py <audio> → {"tempo": bpm, "duration": s, "beats": [s...], "downbeats": [s...], "onsetStrength": [...]}

librosa when it is installed (data/venv, made by `npm run setup`); otherwise a numpy-free fallback that
decodes with ffmpeg and tracks energy peaks — coarser, but the cut points still land on hits.
"""
import json
import subprocess
import sys


def with_librosa(path):
    import librosa
    import numpy as np

    y, sr = librosa.load(path, sr=22050, mono=True)
    tempo, frames = librosa.beat.beat_track(y=y, sr=sr, trim=False)
    beats = librosa.frames_to_time(frames, sr=sr).tolist()
    onset = librosa.onset.onset_strength(y=y, sr=sr)
    strength = [float(onset[min(len(onset) - 1, int(f))]) for f in frames]
    # Downbeats: the phase (0..3) whose beats carry the most onset energy.
    best = max(range(4), key=lambda p: sum(strength[p::4]) if strength[p::4] else 0)
    t = float(np.atleast_1d(tempo)[0])
    return {"tempo": round(t, 2), "duration": round(len(y) / sr, 3), "beats": [round(b, 3) for b in beats], "downbeats": [round(b, 3) for b in beats[best::4]]}


def fallback(path):
    rate = 11025
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", str(rate), "-f", "s16le", "-"], capture_output=True, check=True).stdout
    import array

    pcm = array.array("h", raw)
    hop = 512
    energy = [sum(abs(x) for x in pcm[i : i + hop]) / hop for i in range(0, len(pcm) - hop, hop)]
    flux = [max(0.0, energy[i] - energy[i - 1]) for i in range(1, len(energy))]
    times = [(i + 1) * hop / rate for i in range(len(flux))]
    # Tempo by autocorrelation of the flux over 70..180 BPM.
    best_lag, best_score = 0, -1.0
    for bpm in range(70, 181):
        lag = round(60 / bpm * rate / hop)
        score = sum(flux[i] * flux[i - lag] for i in range(lag, len(flux)))
        if score > best_score:
            best_lag, best_score = lag, score
    period = best_lag * hop / rate
    # Phase: the offset whose grid collects the most flux.
    phase = max(range(best_lag), key=lambda p: sum(flux[p::best_lag]))
    start = times[phase] if phase < len(times) else 0.0
    duration = len(pcm) / rate
    beats = []
    t = start
    while t < duration:
        beats.append(round(t, 3))
        t += period
    return {"tempo": round(60 / period, 2), "duration": round(duration, 3), "beats": beats, "downbeats": beats[::4]}


def main():
    path = sys.argv[1]
    try:
        out = with_librosa(path)
        out["method"] = "librosa"
    except ImportError:
        out = fallback(path)
        out["method"] = "fallback"
    print(json.dumps(out))


if __name__ == "__main__":
    main()
