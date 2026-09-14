import os
import sys
import tempfile
import unittest
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "voice_engine")))

from voice_identity import (
    POLICY_VERSION,
    identity_seed_for_attempt,
    get_emotion_prosody,
    resolve_identity_reference,
    sanitize_runtime_params,
    stable_identity_seed,
)
from tts_client import TTSClient
from run_patched import _fake_pitch_shift


class VoiceIdentityPolicyTest(unittest.TestCase):
    def test_headless_audio_compat_layer_preserves_pitch_shift_length(self):
        sample_rate = 16000
        timeline = np.arange(sample_rate, dtype=np.float32) / sample_rate
        source = np.sin(2 * np.pi * 220 * timeline).astype(np.float32)
        shifted = _fake_pitch_shift(source, sample_rate, 1)
        self.assertEqual(shifted.shape, source.shape)
        self.assertFalse(np.allclose(shifted, source))

    def test_headless_audio_compat_layer_keeps_fractional_pitch_steps(self):
        sample_rate = 16000
        timeline = np.arange(sample_rate, dtype=np.float32) / sample_rate
        source = np.sin(2 * np.pi * 220 * timeline).astype(np.float32)
        half = _fake_pitch_shift(source, sample_rate, 0.5)
        whole = _fake_pitch_shift(source, sample_rate, 1)
        self.assertEqual(half.shape, source.shape)
        self.assertFalse(np.allclose(half, whole))

    def test_tts_client_defaults_to_chatx2_port(self):
        previous_chatx2 = os.environ.pop("CHATX2_TTS_PORT", None)
        previous_tts = os.environ.pop("TTS_PORT", None)
        try:
            self.assertEqual(TTSClient().base, "http://127.0.0.1:9882")
        finally:
            if previous_chatx2 is not None:
                os.environ["CHATX2_TTS_PORT"] = previous_chatx2
            if previous_tts is not None:
                os.environ["TTS_PORT"] = previous_tts

    def test_all_emotions_resolve_the_same_identity_reference(self):
        with tempfile.TemporaryDirectory() as voice_dir:
            refs_dir = os.path.join(voice_dir, "refs")
            os.makedirs(refs_dir)
            for filename in ("gentle.wav", "sad.wav", "excited.wav"):
                open(os.path.join(refs_dir, filename), "wb").close()

            config = {
                "emotion_profiles": {
                    "gentle": {"ref_audio": "refs/gentle.wav", "prompt_text": "identity"},
                    "sad": {"ref_audio": "refs/sad.wav", "prompt_text": "sad style"},
                    "excited": {"ref_audio": "refs/excited.wav", "prompt_text": "excited style"},
                }
            }

            expected = resolve_identity_reference(config, voice_dir)
            for _emotion in ("gentle", "sad", "excited"):
                self.assertEqual(resolve_identity_reference(config, voice_dir), expected)
            self.assertTrue(expected[0].endswith("gentle.wav"))
            self.assertEqual(expected[1], "identity")

    def test_explicit_identity_reference_has_priority(self):
        with tempfile.TemporaryDirectory() as voice_dir:
            refs_dir = os.path.join(voice_dir, "refs")
            os.makedirs(refs_dir)
            chosen = os.path.join(refs_dir, "identity.wav")
            open(chosen, "wb").close()
            config = {
                "identity_reference": {
                    "ref_audio": "refs/identity.wav",
                    "prompt_text": "fixed identity",
                },
                "emotion_profiles": {},
            }
            self.assertEqual(
                resolve_identity_reference(config, voice_dir),
                (chosen, "fixed identity"),
            )

    def test_sampling_is_fixed_while_prosody_differs(self):
        samples = [
            sanitize_runtime_params(emotion, {"temperature": value, "top_p": 1 - value / 2})
            for emotion, value in (("gentle", 0.2), ("sad", 0.8), ("excited", 1.0))
        ]
        self.assertEqual(len({item["temperature"] for item in samples}), 1)
        self.assertEqual(len({item["top_p"] for item in samples}), 1)
        self.assertLess(get_emotion_prosody("sad")["speed"], get_emotion_prosody("excited")["speed"])

    def test_automatic_emotion_does_not_shift_pitch_or_voice_color(self):
        for emotion in ("gentle", "comfort", "sad", "sad_question", "question", "strong", "excited", "shy_happy"):
            self.assertEqual(get_emotion_prosody(emotion)["pitchSemitones"], 0.0)

    def test_runtime_limits_preserve_timbre(self):
        params = sanitize_runtime_params(
            "excited",
            {
                "speed": 2,
                "speed_offset": 0.8,
                "pitch_offset": -8,
                "soft_offset": 2,
                "volume_offset": 0.9,
            },
        )
        self.assertLessEqual(params["speed"], 1.08)
        self.assertLessEqual(params["speed_offset"], 0.06)
        self.assertEqual(params["pitch_offset"], -1.0)
        self.assertLessEqual(params["soft_offset"], 0.35)
        self.assertLessEqual(params["volume_offset"], 0.25)
        self.assertEqual(params["voice_identity_policy"], POLICY_VERSION)

    def test_identity_seed_depends_on_voice_not_emotion(self):
        self.assertEqual(stable_identity_seed("selena"), stable_identity_seed("selena"))
        self.assertNotEqual(stable_identity_seed("selena"), stable_identity_seed("yangyang"))

    def test_first_attempt_uses_the_known_stable_seed_without_losing_fallbacks(self):
        base = stable_identity_seed("selena")
        self.assertEqual(
            [identity_seed_for_attempt("selena", attempt) for attempt in range(3)],
            [base + 1, base, base + 2],
        )


if __name__ == "__main__":
    unittest.main()
