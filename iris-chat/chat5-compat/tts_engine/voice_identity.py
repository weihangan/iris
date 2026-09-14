import json
import os
import random
import zlib


_POLICY_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "voice_identity_policy.json")
with open(_POLICY_PATH, "r", encoding="utf-8") as _policy_file:
    POLICY = json.load(_policy_file)

POLICY_VERSION = POLICY["version"]


def _number(value, fallback):
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return float(fallback)
    return parsed


def _clamp(value, limits, fallback):
    parsed = _number(value, fallback)
    return min(float(limits[1]), max(float(limits[0]), parsed))


def get_emotion_prosody(emotion):
    presets = POLICY["emotionProsody"]
    return dict(presets.get(str(emotion or ""), presets["gentle"]))


def sanitize_runtime_params(emotion, params=None):
    source = dict(params or {})
    limits = POLICY["limits"]
    prosody = get_emotion_prosody(emotion)
    temp_offset = _clamp(source.get("temp_offset", 0), limits["temperatureOffset"], 0)

    # GPT-SoVITS zero-shot identity is sensitive to sampling. Keep sampling
    # shared by all emotions and express emotion through restrained prosody.
    source["temperature"] = min(0.65, max(0.60, POLICY["sampling"]["temperature"] + temp_offset))
    source["top_p"] = POLICY["sampling"]["topP"]
    source["speed"] = _clamp(source.get("speed"), limits["speed"], prosody["speed"])
    source["speed_offset"] = _clamp(source.get("speed_offset", 0), limits["speedOffset"], 0)
    source["pitch_offset"] = _clamp(source.get("pitch_offset", 0), limits["pitchOffset"], 0)
    source["temp_offset"] = temp_offset
    source["soft_offset"] = _clamp(source.get("soft_offset", 0), limits["softOffset"], 0)
    source["volume_offset"] = _clamp(source.get("volume_offset", 0), limits["volumeOffset"], 0)
    source["voice_identity_policy"] = POLICY_VERSION
    return source


def _reference_from_entry(entry, voice_dir):
    if not isinstance(entry, dict):
        return None
    relative_path = entry.get("ref_audio")
    if not relative_path:
        return None
    ref_path = os.path.normpath(os.path.join(voice_dir, relative_path))
    if not os.path.isfile(ref_path):
        return None
    return ref_path, str(entry.get("prompt_text", ""))


def resolve_identity_reference(config, voice_dir):
    config = config if isinstance(config, dict) else {}
    profiles = config.get("emotion_profiles", {})
    explicit = config.get("identity_reference")
    if isinstance(explicit, dict):
        linked_emotion = explicit.get("emotion")
        if linked_emotion and linked_emotion in profiles:
            linked = _reference_from_entry(profiles[linked_emotion], voice_dir)
            if linked:
                return linked
        direct = _reference_from_entry(explicit, voice_dir)
        if direct:
            return direct

    preferred = [
        config.get("identity_emotion"),
        POLICY["identityEmotion"],
        "gentle",
        "neutral",
    ]
    for emotion in preferred:
        if emotion and emotion in profiles:
            resolved = _reference_from_entry(profiles[emotion], voice_dir)
            if resolved:
                return resolved

    for emotion in sorted(profiles):
        resolved = _reference_from_entry(profiles[emotion], voice_dir)
        if resolved:
            return resolved
    return None, ""


def stable_identity_seed(voice_name):
    encoded = str(voice_name or "default").encode("utf-8")
    return (zlib.crc32(encoded) ^ 0x5E11A) & 0x7FFFFFFF


def identity_seed_for_attempt(voice_name, attempt_index=0):
    """Prefer the empirically stable seed while retaining deterministic fallbacks."""
    attempt = max(0, int(attempt_index))
    offsets = (1, 0, 2)
    offset = offsets[attempt] if attempt < len(offsets) else attempt
    return (stable_identity_seed(voice_name) + offset) & 0x7FFFFFFF


def apply_identity_seed(voice_name, retry_index=0):
    seed = identity_seed_for_attempt(voice_name, retry_index)
    random.seed(seed)
    try:
        import numpy as np
        np.random.seed(seed % (2**32 - 1))
    except Exception:
        pass
    try:
        import torch
        torch.manual_seed(seed)
        if torch.cuda.is_available():
            torch.cuda.manual_seed_all(seed)
    except Exception:
        pass
    return seed
