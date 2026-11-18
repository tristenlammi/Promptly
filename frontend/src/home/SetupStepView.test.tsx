import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { SetupStep } from "@/api/home";

import { cannotDraw, missing, SetupStepView, startValues, toInput } from "./SetupStepView";

// Steps as the box sends them (``shape_flow`` on Home Assistant's answers
// for Philips Hue and for a sign-in style brand; the same recordings as
// ``backend/tests/test_home_box.py``).
const HUE_HOST: SetupStep = {
  flow: "01HUE", brand: "hue", brand_name: "Philips Hue", step: "manual", kind: "form", title: "Manual configure a Hue bridge",
  fields: [{ name: "host", label: "Host", required: true, type: "text" }], errors: {}, last: false,
};
const HUE_BUTTON: SetupStep = {
  flow: "01HUE", brand: "hue", brand_name: "Philips Hue", step: "link", kind: "form", title: "Link Hub",
  text: "Press the button on the bridge to register Philips Hue with Promptly.", fields: [], errors: {}, last: false,
};
const HUE_BUTTON_FAILED: SetupStep = { ...HUE_BUTTON, errors: { base: "Failed to register, please try again" } };
const SIGN_IN: SetupStep = {
  flow: "01LOG", brand: "acme", brand_name: "Acme", step: "user", kind: "form", title: "Acme", text: "Sign in at https://acme.example first.", last: true,
  errors: { base: "That sign-in wasn't accepted.", password: "Check this." },
  fields: [
    { name: "username", label: "Email", required: true, type: "text", default: "sam@example.com" },
    { name: "password", label: "Password", required: true, type: "password" },
    { name: "region", label: "Region", required: true, type: "select", default: "eu", options: [{ value: "eu", label: "Europe" }, { value: "us", label: "America" }] },
    { name: "scan_interval", label: "Scan interval", required: false, type: "number", min: 5, max: 300, step: 1, default: 30 },
    { name: "use_tls", label: "Use tls", required: false, type: "bool", default: true },
    { name: "rooms", label: "Rooms", required: false, type: "multiselect", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] },
    { name: "where", label: "Where", required: false, type: "unsupported" },
  ],
};

const draw = (step: SetupStep, values = startValues(step)) =>
  renderToStaticMarkup(<SetupStepView step={step} values={values} onChange={() => undefined} onPick={() => undefined} />);

describe("a set-up step", () => {
  it("asks for the Hue bridge's address", () => {
    const html = draw(HUE_HOST);
    expect(html).toContain("Host");
    expect(html).toContain('id="setup-host"');
    expect(missing(HUE_HOST, startValues(HUE_HOST))).toEqual(["host"]);
    expect(missing(HUE_HOST, { host: "192.168.1.20" })).toEqual([]);
    expect(toInput(HUE_HOST, { host: "192.168.1.20" })).toEqual({ host: "192.168.1.20" });
  });

  it("is just words and Continue when the step is pressing a button", () => {
    const html = draw(HUE_BUTTON);
    expect(html).toContain("Press the button on the bridge");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("Home Assistant");
    expect(missing(HUE_BUTTON, {})).toEqual([]);
    expect(toInput(HUE_BUTTON, {})).toEqual({});
    expect(draw(HUE_BUTTON_FAILED)).toContain("Failed to register, please try again");
    // What went wrong is a message (an alert with an icon), never a bordered box that reads as a field.
    const failed = draw(HUE_BUTTON_FAILED);
    const alert = /<p role="alert" class="([^"]*)"/.exec(failed);
    expect(alert).not.toBeNull();
    expect(alert![1]).not.toMatch(/\bborder\b/);
    expect(failed).toContain("<svg");
  });

  it("draws a sign-in with each kind of field, and hides what's typed into a password", () => {
    const start = startValues(SIGN_IN);
    expect(start).toEqual({ username: "sam@example.com", region: "eu", scan_interval: 30, use_tls: true, rooms: [] });
    const html = draw(SIGN_IN, { ...start, password: "hunter2" });
    expect(html).toContain('type="password"');
    expect(html).toContain("That sign-in wasn&#x27;t accepted.");
    expect(html).toContain("Check this.");
    expect(html).toContain("<select");
    expect(html).toContain('type="number"');
    expect(html).toContain('role="switch"');
    expect(html).toContain("can&#x27;t ask for this kind of answer yet");
    expect(missing(SIGN_IN, start)).toEqual(["password"]);
    expect(cannotDraw(SIGN_IN)).toBe(false); // the one it can't draw is optional
    expect(toInput(SIGN_IN, { ...start, password: "hunter2", scan_interval: "45", rooms: ["a"] })).toEqual({
      username: "sam@example.com", password: "hunter2", region: "eu", scan_interval: 45, use_tls: true, rooms: ["a"],
    });
  });

  it("leaves out an optional box left empty, and says when it can't go on", () => {
    expect(toInput(SIGN_IN, { username: "a", password: "b", region: "eu", scan_interval: "", use_tls: false })).toEqual({
      username: "a", password: "b", region: "eu", use_tls: false, rooms: [],
    });
    const stuck: SetupStep = { ...HUE_HOST, fields: [{ name: "where", label: "Where", required: true, type: "unsupported" }] };
    expect(cannotDraw(stuck)).toBe(true);
  });

  it("says how it ended, in words", () => {
    expect(draw({ flow: "x", brand: "hue", brand_name: "Philips Hue", kind: "stopped", reason: "already_configured", text: "Device is already configured" })).toContain("Philips Hue wasn&#x27;t added");
    expect(draw({ flow: "x", brand: "zzz", brand_name: "Zzz", kind: "elsewhere", text: "This one is finished on the maker's own website." })).toContain("can&#x27;t be added here yet");
    expect(draw({ flow: "x", brand: "zzz", brand_name: "Zzz", kind: "wait", text: "Working on it…" })).toContain("Working on it");
    const menu = draw({ flow: "x", brand: "zzz", brand_name: "Zzz", kind: "menu", title: "Zzz", options: [{ value: "cloud", label: "Sign in" }, { value: "local", label: "Local network" }] });
    expect(menu).toContain("Sign in");
    expect(menu).toContain("Local network");
  });
});
