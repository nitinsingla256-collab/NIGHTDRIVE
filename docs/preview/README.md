# Compositing previews

These are **not browser screenshots**. No browser or desktop runtime was
available while making the photorealism pass, so these images were produced by
`scripts/preview-render.py`, which reproduces the engine's image pipeline in
order:

```
scene plate (object-fit: cover)
  → headlight overlay  (mix-blend-mode: screen, opacity 0.55)
  → colour temperature (mix-blend-mode: soft-light, per-period rgba tint)
  → vignette           (.stage::after)
```

They are useful for judging the imagery and the blend maths, and for spotting
defects such as the rectangular inpainting seam that appeared around the moon
in an earlier revision of this pass.

What they do **not** show: the HUD (clock, date, weather, battery), the side
controls, the dust particles, `backdrop-filter` on the widget pills, or the
browser's own downscaling. Those still need a real browser — open
`npm start` and press F11.

The gallery in `docs/screenshots/` predates this pass and shows the earlier,
over-compressed night plates and the old scanline overlay.

## `clock-depth-day.jpg` / `clock-depth-dusk.jpg`

Also **not screenshots**. These are the depth-clock composites produced by
`python3 scripts/build-ridges.py --preview`, which uses the same
`engine/assets/ridges.json` the app loads: the plate, the real thin clock type
at the measured placement, then the same plate pasted back over everything
below the measured skyline. The red line is the preview's own debug overlay;
the app has no red line — it clips the foreground copy there.

They show the one thing that matters for the effect: the type disappears
exactly at the photograph's mountain edge, not at a straight horizontal cut.

They do **not** show: the running app, the crossfade between periods, the
drawer or the settings panel. Those need a browser, which this environment
does not have (see `docs/VERIFICATION.md`).
