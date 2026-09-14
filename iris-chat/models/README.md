# Runtime model directory

Model packs live here, one folder per pack. The app discovers packs from
`manifest.json`; motion files shared by every model live under `models/shared/`.

## Pack layout

```
models/
  <pack-folder>/          # one folder per model pack
    manifest.json         # required: pack identity and capability mappings
    <model>.pmx           # the PMX model file
    textures/ spa/        # textures referenced by the PMX (relative paths)
    Readme.txt            # license / credit from the model author
  shared/
    motions/              # VMD files shared across packs (idle, gestures, head actions)
    voice-actions.json    # voice-triggered action catalog
    facial-performance/   # shared facial performance data
```

## manifest.json fields

`models/赛琳娜Q/manifest.json` is a working minimal example.

| Field | Purpose |
|---|---|
| `packId` / `internalName` | Unique pack identifier used by settings and userData. |
| `displayName` | Name shown in the model picker. |
| `model.pmxFile` | PMX filename relative to the pack folder, plus `credit` and `licenseStatus`. |
| `morphs` | Maps framework capabilities to this model's morphs: `visemes` (lip sync), `blink`, `emotions` (name → morph). Leave keys empty to skip that capability. |
| `bones` | Optional bone-name remapping for motion retargeting. |
| `motions.defaultIdle` | VMD played as resting idle (usually a `../shared/motions/*.vmd`). |
| `motions.customVmd` | Gesture/head-action VMDs this pack supports; the shared pools only fire motions listed here. |
| `motions.idleVmdPool` / `gesturePacks` / `idlePacks` | Optional weighted idle and gesture pools. |
| `capabilities` | Optional feature flags (e.g. physics tuning overrides). |

Emotion recipes, gesture pools, and voice-action pools are global (`models/shared`
and chat5-compat character data). A model only executes what its manifest maps, so
packs built for models without赛琳娜-specific morphs still run safely.

## License warning

PMX/VMD assets are author-licensed content. The bundled 赛琳娜Q pack is an
example for local framework development only — its Readme forbids
redistribution and non-personal use. Check every pack's `Readme.txt` before
sharing the repo or a build; replace packs you are not licensed to ship with
your own models.
