import { box, ellipse, line, text, type IconSpec } from "./_helpers";

/**
 * Bundled "Network" icon library — schematic, label-driven shapes for
 * network/topology diagrams. Labelled boxes are the convention in network
 * diagrams, so these read correctly while staying owned/license-clean
 * (no third-party assets to attribute).
 */
export const NETWORK_ICONS: IconSpec[] = [
  {
    id: "promptly-net-router",
    name: "Router",
    skeleton: [box("rectangle", 110, 54, "Router", "#1971c2")],
  },
  {
    id: "promptly-net-switch",
    name: "Switch",
    skeleton: [box("rectangle", 110, 54, "Switch", "#2f9e44")],
  },
  {
    id: "promptly-net-firewall",
    name: "Firewall",
    skeleton: [box("rectangle", 110, 54, "Firewall", "#e03131")],
  },
  {
    id: "promptly-net-server",
    name: "Server",
    skeleton: [box("rectangle", 70, 96, "Server", "#495057")],
  },
  {
    id: "promptly-net-pc",
    name: "Workstation",
    skeleton: [box("rectangle", 90, 60, "PC", "#495057")],
  },
  {
    id: "promptly-net-ap",
    name: "Access Point",
    skeleton: [box("ellipse", 66, 66, "AP", "#0c8599")],
  },
  {
    id: "promptly-net-cloud",
    name: "Internet",
    skeleton: [box("ellipse", 130, 72, "Internet", "#1c7ed6")],
  },
  {
    // A cylinder (two ellipses + sides) — the universal database glyph.
    id: "promptly-net-database",
    name: "Database",
    skeleton: [
      ellipse(0, 0, 80, 18, "#7048e8"),
      line(0, 9, [[0, 0], [0, 72]], "#7048e8"),
      line(80, 9, [[0, 0], [0, 72]], "#7048e8"),
      ellipse(0, 72, 80, 18, "#7048e8"),
      text(29, 38, "DB"),
    ],
  },
];
