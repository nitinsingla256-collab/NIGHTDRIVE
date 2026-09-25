# Asset replacements

This folder contains the 6 time-of-day scene images used by the NIGHTDRIVE wallpaper engine.

**CURRENT STATUS:**
The currently provided images are AI-generated placeholders. They **do not** have perfectly identical composition. The car's scale, position, and the background scenery shift slightly between images. This causes visual jumping and imperfect transitions when the engine blends between periods.

To achieve a photorealistic, perfectly continuous wallpaper, you must replace these with 6 identically composed images (e.g. from a 3D render) featuring:
- A black Dodge Challenger-inspired muscle car.
- A stationary, fixed camera angle, scale, and perspective across all shots.
- A dramatic winding mountain road or cliff between two mountain formations.

Replace the following files with your final 16:9 images:

- `morning/scene.jpg`
- `day/scene.jpg`
- `golden-hour/scene.jpg`
- `dusk/scene.jpg`
- `night/scene.jpg`
- `midnight/scene.jpg`

### Headlights
For dusk and night, you can also provide transparent `.png` overlays for the headlight beams. 
The base `scene.jpg` should have the lamps off, and the `.png` should contain the glowing beams perfectly aligned to the car's position.

- `dusk/headlights.png` (or `.jpg` overlay based on your css logic)
- `night/headlights.png` 

*(Note: The current JavaScript engine uses `headlights.jpg` with a CSS screen/lighten blend mode. You may adjust the extension in `script.js` if you prefer transparent PNGs).*

The JavaScript will automatically load these files. Do not use official Dodge marks unless you have rights to them.
