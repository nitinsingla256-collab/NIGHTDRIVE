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
