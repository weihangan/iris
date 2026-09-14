import sys
checks = [
    ("demucs", "demucs.pretrained"),
    ("whisper", "whisper"),
    ("torch", "torch"),
    ("torchaudio", "torchaudio"),
    ("soundfile", "soundfile"),
    ("librosa", "librosa"),
    ("numpy", "numpy"),
    ("scipy", "scipy"),
    ("runpy", "runpy"),
    ("yaml", "yaml"),
    ("transformers", "transformers"),
    ("peft", "peft"),
]
for name, mod in checks:
    try:
        m = __import__(mod)
        ver = getattr(m, "__version__", "?")
        print(f"OK   {name} {ver}")
    except Exception as e:
        print(f"FAIL {name}: {e}")

import torch
print(f"\ntorch.cuda.is_available() = {torch.cuda.is_available()}")
if torch.cuda.is_available():
    print(f"GPU: {torch.cuda.get_device_name(0)}")
