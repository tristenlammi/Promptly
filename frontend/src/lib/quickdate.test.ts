import { describe, expect, it } from "vitest";

import { parseQuick } from "@/items/kinds/tasks/quickadd";

import { parseWhen } from "./quickdate";

// Each group below is a "first wording that fits wins" chain in the parser:
// every alternative is covered, and so is the order they're tried in.
const TODAY = "2026-11-18"; // a Wednesday

const when = (s: string) => {
  const { due, time, repeat, rest } = parseWhen(s, TODAY);
  return { due, time, repeat: repeat ? { freq: repeat.freq, interval: repeat.interval ?? 1 } : null, rest: rest.replace(/\s+/g, " ").trim() };
};

describe("parseWhen: times", () => {
  it("reads each way of writing a time", () => {
    expect(when("Call Sam at 3pm")).toMatchInlineSnapshot(`
      {
        "due": "2026-11-18",
        "repeat": null,
        "rest": "Call Sam",
        "time": "15:00",
      }
    `);
    expect(when("Call Sam 12 am")).toMatchInlineSnapshot(`
      {
        "due": "2026-11-18",
        "repeat": null,
        "rest": "Call Sam",
        "time": "00:00",
      }
    `);
    expect(when("Call Sam at 14:30")).toMatchInlineSnapshot(`
      {
        "due": "2026-11-18",
        "repeat": null,
        "rest": "Call Sam",
        "time": "14:30",
      }
    `);
    expect(when("Lunch at noon")).toMatchInlineSnapshot(`
      {
        "due": "2026-11-18",
        "repeat": null,
        "rest": "Lunch",
        "time": "12:00",
      }
    `);
    expect(when("Fireworks at midnight")).toMatchInlineSnapshot(`
      {
        "due": "2026-11-18",
        "repeat": null,
        "rest": "Fireworks",
        "time": "00:00",
      }
    `);
    expect(when("Pick up at 5")).toMatchInlineSnapshot(`
      {
        "due": "2026-11-18",
        "repeat": null,
        "rest": "Pick up",
        "time": "17:00",
      }
    `);
    expect(when("Standup this morning at 9")).toMatchInlineSnapshot(`
      {
        "due": "2026-11-18",
        "repeat": null,
        "rest": "Standup",
        "time": "09:00",
      }
    `);
    expect(when("Dinner tonight at 7:30")).toMatchInlineSnapshot(`
      {
        "due": "2026-11-18",
        "repeat": null,
        "rest": "Dinner",
        "time": "19:30",
      }
    `);
  });

  it("an am/pm time wins over a bare clock time in the same line", () => {
    expect(when("Meet at 4 at 2pm")).toMatchInlineSnapshot(`
      {
        "due": "2026-11-18",
        "repeat": null,
        "rest": "Meet at 4",
        "time": "14:00",
      }
    `);
  });

  it("leaves a number that isn't a time alone", () => {
    expect(when("Buy 13pm of nothing")).toMatchInlineSnapshot(`
      {
        "due": null,
        "repeat": null,
        "rest": "Buy 13pm of nothing",
        "time": null,
      }
    `);
    expect(when("Room at 45")).toMatchInlineSnapshot(`
      {
        "due": null,
        "repeat": null,
        "rest": "Room at 45",
        "time": null,
      }
    `);
  });
});

describe("parseWhen: yearly repeats", () => {
  it("reads the day before or after the month", () => {
    expect(when("Mum's birthday every 3rd of March")).toMatchInlineSnapshot(`
      {
        "due": "2027-03-03",
        "repeat": {
          "freq": "yearly",
          "interval": 1,
        },
        "rest": "Mum's birthday",
        "time": null,
      }
    `);
    expect(when("Mum's birthday every March 3rd")).toMatchInlineSnapshot(`
      {
        "due": "2027-03-03",
        "repeat": {
          "freq": "yearly",
          "interval": 1,
        },
        "rest": "Mum's birthday",
        "time": null,
      }
    `);
  });
});

describe("parseQuick: priority", () => {
  const quick = (s: string) => {
    const p = parseQuick(s, [], TODAY);
    return { title: p.title, priority: p.priority };
  };
  it("reads !2, !!, and p1", () => {
    expect(quick("Pay rent !2 now")).toMatchInlineSnapshot(`
      {
        "priority": 2,
        "title": "Pay rent now",
      }
    `);
    expect(quick("Pay rent !!! now")).toMatchInlineSnapshot(`
      {
        "priority": 3,
        "title": "Pay rent now",
      }
    `);
    expect(quick("Pay rent p1 now")).toMatchInlineSnapshot(`
      {
        "priority": 3,
        "title": "Pay rent now",
      }
    `);
    expect(quick("Pay rent now")).toMatchInlineSnapshot(`
      {
        "priority": null,
        "title": "Pay rent now",
      }
    `);
  });
  it("takes only the first one written as a number", () => {
    expect(quick("Pay rent !3 p1 now")).toMatchInlineSnapshot(`
      {
        "priority": 3,
        "title": "Pay rent p1 now",
      }
    `);
  });
});
