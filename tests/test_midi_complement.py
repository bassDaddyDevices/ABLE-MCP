from __future__ import annotations

import math
import wave
from pathlib import Path

from able_mcp.midi import complement


def _write_test_wav(path: Path, sample_rate: int = 16000) -> None:
    """Write a tiny monophonic melody: A4 then C5 with a short rest."""
    amps = []

    def tone(freq: float, sec: float) -> None:
        n = int(sample_rate * sec)
        for i in range(n):
            t = i / sample_rate
            v = 0.45 * math.sin(2 * math.pi * freq * t)
            amps.append(int(max(-1.0, min(1.0, v)) * 32767))

    def silence(sec: float) -> None:
        n = int(sample_rate * sec)
        amps.extend([0] * n)

    tone(440.0, 0.35)     # A4
    silence(0.08)
    tone(523.25, 0.35)    # C5

    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(b"".join(int(v).to_bytes(2, "little", signed=True) for v in amps))


def test_extract_guide_melody_from_wav(tmp_path: Path):
    wav_path = tmp_path / "lead.wav"
    _write_test_wav(wav_path)

    notes, summary = complement.extract_guide_melody_from_wav(str(wav_path))

    assert summary.total_frames > 0
    assert summary.voiced_frames > 0
    assert len(notes) >= 1
    assert all(45 <= n.pitch <= 88 for n in notes)
    assert all(n.duration_sec > 0 for n in notes)


def test_generate_complementary_not_unison_heavy():
    guide = [
        {"pitch": 69, "start": 0.0, "duration": 0.5, "velocity": 100},
        {"pitch": 71, "start": 0.5, "duration": 0.5, "velocity": 100},
        {"pitch": 72, "start": 1.0, "duration": 0.5, "velocity": 100},
        {"pitch": 74, "start": 1.5, "duration": 0.5, "velocity": 100},
    ]

    out = complement.generate_complementary_melody(
        guide_notes=guide,
        similarity=0.6,
        density=1.0,
        register="mid",
        call_response=True,
        seed=7,
    )

    assert len(out) >= 2
    same_pitch = 0
    compared = min(len(out), len(guide))
    for i in range(compared):
        if out[i]["pitch"] == guide[i]["pitch"]:
            same_pitch += 1
    assert same_pitch <= 1, "complement should rarely duplicate guide pitch exactly"


def test_seconds_notes_to_beats():
    notes = [complement.GuideNote(pitch=60, start_sec=1.0, duration_sec=0.5)]
    out = complement.seconds_notes_to_beats(notes, tempo_bpm=120)
    assert out[0]["start"] == 2.0
    assert out[0]["duration"] == 1.0
