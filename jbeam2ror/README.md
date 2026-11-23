# jbeam2ror: BeamNG → Rigs of Rods physics converter

Converts a BeamNG.drive car mod (JBeam) into a Rigs of Rods `.truck` mod that loads and drives with no hand-editing. It focuses on the **physics**. 3D models are not converted; the body is drawn flat from the collision triangles.

## Use it

**In the browser:** open `index.html` (or the single-file `dist/jbeam2ror.html`). Choose the mod's zip, add `BeamNG.drive/content/vehicles/common.zip` (most mods take their tires, wheels and engines from it), pick a configuration, convert, and download. Nothing is uploaded anywhere.

**From the command line** (Node 20+):

```bash
node cli.js path/to/mod.zip --extra "path/to/BeamNG.drive/content/vehicles/common.zip"
```

`--list` shows the vehicles and configurations, and `--config <name>` picks one. Put the resulting zip, unopened, in `Documents/My Games/Rigs of Rods/mods`.

## What carries over

| BeamNG | Rigs of Rods |
|---|---|
| Parts, slots, `.pc` configs, `$variables`, `$=` expressions | resolved into one vehicle |
| `nodes` + `nodeWeight` | `nodes` with exact per-node mass (`l` option, `minimass 0.01, l`) |
| `beams` spring / damp / deform / strength | `beams` + `set_beam_defaults` (with `enable_advanced_deformation`) |
| `|BOUNDED` and pre-compressed beams | `shocks` |
| `|SUPPORT` beams | `s` beams |
| steering `hydros` | `hydros`, with the direction and amount worked out from the steering-arm geometry |
| other `hydros` | rigid beams |
| `triangles` / `quadTriangles` | `submesh` / `cab` (collision + flat body) |
| `pressureWheels`, `hubWheels`… | `wheels` (radius, width, rays, mass, pressure-based stiffness, brakes) |
| `powertrain` (engine torque curve, gearbox, differentials, `connectedWheel`) | `engine`, `engoption`, `torquecurve`, driven wheels |
| `rails` + `slidenodes` (e.g. spring seats on struts) | `slidenodes` |
| newer metre-based settings (`precompressionRange`, `shortBoundRange`, `longBoundRange`), `$components` | converted |
| `refNodes`, `camerasInternal` | `cameras`, `cinecam` |

**No BeamNG install needed for most mods.** Tires and wheels that a mod borrows from the base game are rebuilt from their part names (`tire_F_175_70_13` = 175 mm wide, 70 % sidewall, 13-inch rim; base-game wheels reuse the mod's own wheel for the node layout). Lights, sounds and seats from the base game are skipped since they don't affect physics.

Not converted: flexbody meshes, textures, lights, sounds, Lua controllers (ABS, ESC, electrics) and torsion bars (anti-roll bars).

## Why it shouldn't break

* **Mass:** RoR forces every node to weigh at least 50 kg by default, which would make a converted car weigh tonnes. The output disables that and keeps BeamNG's exact masses.
* **Deformation:** without `enable_advanced_deformation`, RoR raises every deform threshold to at least 400 kN. The output enables it, so beams deform at BeamNG's values.
* **Load order:** parts load in BeamNG's order (a part, then its slots in order), so modifier rows and duplicate node definitions resolve the way they do in BeamNG.
* **Drop test:** every conversion is simulated for 2.5 s on flat ground with RoR's integrator and time step (semi-implicit Euler, 0.5 ms), including RoR's exact shock behaviour past the travel limits and slidenodes. BeamNG tolerates some very light nodes on very stiff beams that RoR's integrator can't handle. If the test blows up, the converter finds the vibration modes that are too fast for RoR (power iteration on the whole node/beam network) and makes just those nodes heavier, borrowing the weight from neighbouring nodes where it can so the car's total weight and balance stay close to BeamNG's. Typical result for a real car: 5–10 % added weight. Mods that are already stable keep their exact masses.
* **Wheel spin:** wheel axes are ordered so drive torque pushes the car forward (RoR applies torque around node1 → node2).
* **Parser rules:** the output is checked against RoR's own parser rules (`test/validate-truck.js`), including argument counts, node references and texture coordinates for body nodes.

## Development

```bash
node test/run.js
node test/features.js
```

`node build.js` regenerates `index.html` and `dist/` from `page.html`. The format details come from Rigs of Rods' source (`RigDef_Parser.cpp`, `ActorSpawner.cpp`, `ActorForcesEuler.cpp`).
