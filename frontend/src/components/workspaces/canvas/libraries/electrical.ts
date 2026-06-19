import { ellipse, line, type IconSpec } from "./_helpers";

/**
 * Bundled "Electrical" icon library — standard schematic symbols built
 * from plain line/ellipse primitives (IEEE-style). Points are relative to
 * each element's ``(x, y)`` origin; symbols are roughly centred on the
 * horizontal lead axis (y = 0) so they line up when wired together.
 */
export const ELECTRICAL_ICONS: IconSpec[] = [
  {
    id: "promptly-elec-resistor",
    name: "Resistor",
    skeleton: [
      line(0, 0, [
        [0, 0], [12, 0], [18, -8], [30, 8], [42, -8],
        [54, 8], [66, -8], [72, 0], [84, 0],
      ]),
    ],
  },
  {
    id: "promptly-elec-capacitor",
    name: "Capacitor",
    skeleton: [
      line(0, 0, [[0, 0], [26, 0]]),
      line(26, 0, [[0, -12], [0, 12]]),
      line(34, 0, [[0, -12], [0, 12]]),
      line(34, 0, [[0, 0], [26, 0]]),
    ],
  },
  {
    // Single cell — long plate (+) and short plate (−).
    id: "promptly-elec-battery",
    name: "Battery",
    skeleton: [
      line(0, 0, [[0, 0], [26, 0]]),
      line(26, 0, [[0, -14], [0, 14]]),
      line(34, 0, [[0, -7], [0, 7]]),
      line(34, 0, [[0, 0], [26, 0]]),
    ],
  },
  {
    id: "promptly-elec-ground",
    name: "Ground",
    skeleton: [
      line(0, 0, [[0, 0], [0, 18]]),
      line(-12, 18, [[0, 0], [24, 0]]),
      line(-8, 24, [[0, 0], [16, 0]]),
      line(-4, 30, [[0, 0], [8, 0]]),
    ],
  },
  {
    // Anode triangle pointing into the cathode bar.
    id: "promptly-elec-diode",
    name: "Diode",
    skeleton: [
      line(0, 0, [[0, 0], [16, 0]]),
      line(16, 0, [[0, -12], [0, 12], [24, 0], [0, -12]]),
      line(40, 0, [[0, -12], [0, 12]]),
      line(40, 0, [[0, 0], [16, 0]]),
    ],
  },
  {
    // SPST switch, drawn open; small nodes mark the contacts.
    id: "promptly-elec-switch",
    name: "Switch",
    skeleton: [
      line(0, 0, [[0, 0], [14, 0]]),
      line(14, 0, [[0, 0], [24, -14]]),
      line(38, 0, [[0, 0], [14, 0]]),
      ellipse(12, -2, 4, 4),
      ellipse(36, -2, 4, 4),
    ],
  },
  {
    // Lamp — circle with crossed filament.
    id: "promptly-elec-lamp",
    name: "Lamp",
    skeleton: [
      ellipse(0, 0, 28, 28),
      line(0, 0, [[4, 4], [24, 24]]),
      line(0, 0, [[24, 4], [4, 24]]),
      line(-14, 14, [[0, 0], [14, 0]]),
      line(28, 14, [[0, 0], [14, 0]]),
    ],
  },
];
