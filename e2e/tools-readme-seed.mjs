// Demo data for the README screenshots, part two: everything that has an
// ordinary API, written as the made-up Hartley family (Claire, Tom, Ellie,
// Max). Not a test. Only for a throwaway stack. The whole run, from the
// repo root in Git Bash:
//
//   bash scripts/stack.sh up shots --with media,maps-full,convert --build-extras
//       (maps-full is the real maps container, for the Maps screenshot. ALWAYS
//       with --build-extras: without it the stack reuses the main app's older
//       maps image, which may start downloading Australia by itself. For every
//       shot but "maps", --with media,maps,convert is enough.)
//   docker stop PromptlyShots-MailWorker          # the demo mailbox has no server behind it
//   mkdir -p .stacks/shots/readme
//   docker exec -i PromptlyShots-Backend python - < e2e/readme-shots/seed.py > .stacks/shots/readme/auth.json
//   (cd e2e && node readme-shots/fetch-photos.mjs get)     # once: CC0 photographs, not committed
//   (cd e2e && node tools-readme-seed.mjs)                 # every section, or name some: calendar notes
//   (cd e2e && node readme-shots/choose-map.mjs)           # a real map (New Zealand, about 15 minutes), chosen in Admin
//   docker exec -i PromptlyShots-Backend python - < e2e/readme-shots/backdate.py
//   (cd e2e && node tools-readme-shots.mjs)
//   then e2e/readme-shots/shrink.py (its header says how), and
//   bash scripts/stack.sh down shots
//
// A section that finds its data already there does nothing; to start again,
// take the stack down and bring it up.
//
// README_BASE_URL (default http://localhost:8093) and README_AUTH (default
// ../.stacks/shots/readme/auth.json) point it elsewhere. Dates are worked
// out from today, so a rerun on a fresh stack looks current.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.README_BASE_URL ?? "http://localhost:8093";
const AUTH = process.env.README_AUTH ?? path.resolve(here, "../.stacks/shots/readme/auth.json");
const users = JSON.parse(fs.readFileSync(AUTH, "utf8")).users;
const TZ = "Australia/Sydney";
const tokens = {};

async function token(who) {
  if (tokens[who]) return tokens[who];
  const r = await fetch(`${BASE}/api/auth/refresh`, { method: "POST", headers: { Cookie: `promptly_refresh=${users[who].refresh_token}` } });
  if (!r.ok) throw new Error(`sign-in for ${who}: ${r.status} ${await r.text()}`);
  tokens[who] = (await r.json()).access_token;
  return tokens[who];
}

async function api(who, method, url, body, { form = false, okStatuses = [] } = {}) {
  const headers = { Authorization: `Bearer ${await token(who)}` };
  if (body !== undefined && !form) headers["Content-Type"] = "application/json";
  const r = await fetch(`${BASE}/api${url}`, { method, headers, body: body === undefined ? undefined : form ? body : JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok && !okStatuses.includes(r.status)) throw new Error(`${method} ${url} as ${who}: ${r.status} ${text.slice(0, 400)}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ---- dates ---------------------------------------------------------------
const today = new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));
today.setHours(0, 0, 0, 0);
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const day = (offset) => {
  const d = new Date(today);
  d.setDate(d.getDate() + offset);
  return iso(d);
};
const monday = -((today.getDay() + 6) % 7); // offset of this week's Monday
const at = (offset, time) => `${day(offset)}T${time}:00`;
const id = () => randomUUID().slice(0, 8);

// ---- calendar ------------------------------------------------------------
async function calendar() {
  const boot = await api("claire", "GET", "/calendar/bootstrap");
  if (boot.calendars.some((c) => c.name === "Family")) return console.log("calendar: already there");
  for (const who of ["tom", "ellie", "max"]) await api(who, "GET", "/calendar/bootstrap");
  const others = ["tom", "ellie", "max"].map((w) => users[w].id);
  const family = await api("claire", "POST", "/calendar/calendars", { name: "Family", color: "#4F7FE0", member_ids: others });
  const kids = await api("claire", "POST", "/calendar/calendars", { name: "Kids", color: "#4E9F5B", member_ids: others });
  const fam = family.calendar?.id ?? family.id;
  const kid = kids.calendar?.id ?? kids.id;
  const ev = (title, start, end, extra = {}) => api("claire", "POST", "/calendar/events", { title, start, end, tz: TZ, ...extra });
  const m = monday;
  // Every week
  await ev("Max: swimming", at(m - 21, "16:30"), at(m - 21, "17:15"), { calendar_id: kid, location: "Wattle Creek Aquatic Centre", repeat: { freq: "weekly", interval: 1, weekdays: [0] } });
  await ev("Ellie: netball", at(m - 20, "18:00"), at(m - 20, "19:00"), { calendar_id: kid, location: "Court 3, Banksia Park", repeat: { freq: "weekly", interval: 1, weekdays: [1] } });
  await ev("Ellie: netball training", at(m - 18, "17:30"), at(m - 18, "18:30"), { calendar_id: kid, location: "Banksia Park", repeat: { freq: "weekly", interval: 1, weekdays: [3] } });
  await ev("Pilates", at(m - 19, "06:15"), at(m - 19, "07:00"), { repeat: { freq: "weekly", interval: 1, weekdays: [2, 4] } });
  await ev("Bins out", day(m - 19), day(m - 19), { all_day: true, calendar_id: fam, repeat: { freq: "weekly", interval: 1, weekdays: [2] } });
  // This week
  await ev("Parent-teacher interviews", at(m, "18:00"), at(m, "19:00"), { calendar_id: fam, location: "Wattle Creek High School", guests: [users.tom.id] });
  await ev("Quarterly planning", at(m, "10:00"), at(m, "11:30"));
  await ev("Lunch with Dana", at(m + 1, "12:30"), at(m + 1, "13:30"), { location: "The Corner Bakehouse" });
  await ev("Solar installer visit", at(m + 2, "09:00"), at(m + 2, "10:00"), { calendar_id: fam, location: "Home" });
  await ev("Max: dentist", at(m + 3, "15:45"), at(m + 3, "16:30"), { calendar_id: kid, location: "Riverbend Dental" });
  await ev("Camp forms due", day(m + 4), day(m + 4), { all_day: true, calendar_id: kid });
  await ev("Dinner with Sam and Jo", at(m + 4, "19:00"), at(m + 4, "21:30"), { calendar_id: fam, location: "Ours" });
  await ev("Farmers market", at(m + 5, "08:00"), at(m + 5, "09:30"), { calendar_id: fam });
  await ev("Nan and Pop for dinner", at(m + 5, "18:00"), at(m + 5, "20:30"), { calendar_id: fam });
  await ev("Bushwalk: Ironbark Ridge", at(m + 6, "09:00"), at(m + 6, "12:30"), { calendar_id: fam, location: "Ironbark Ridge car park" });
  // Before
  await ev("School fete", at(m - 16, "10:00"), at(m - 16, "14:00"), { calendar_id: fam, location: "Wattle Creek Primary" });
  await ev("Biscuit: groomer", at(m - 13, "11:00"), at(m - 13, "12:00"), { calendar_id: fam });
  await ev("Tom away: Melbourne", day(m - 11), day(m - 10), { all_day: true, calendar_id: fam });
  await ev("Ellie: orthodontist", at(m - 4, "08:30"), at(m - 4, "09:15"), { calendar_id: kid });
  await ev("Garden working bee", at(m - 2, "09:00"), at(m - 2, "12:00"), { calendar_id: fam });
  await ev("Movie night", at(m - 9, "19:00"), at(m - 9, "21:30"), { calendar_id: fam });
  // After
  await ev("Car service", at(m + 9, "08:00"), at(m + 9, "08:30"), { calendar_id: fam, location: "Hillview Motors" });
  await ev("Book club", at(m + 10, "19:30"), at(m + 10, "21:30"), { location: "Dana's" });
  await ev("Ellie: school formal", at(m + 12, "18:00"), at(m + 12, "23:00"), { calendar_id: kid });
  await ev("Year 10 camp", day(m + 14), day(m + 16), { all_day: true, calendar_id: kid, location: "Lake Merrin" });
  await ev("Max's birthday party", at(m + 19, "14:00"), at(m + 19, "16:30"), { calendar_id: fam, location: "Bounce Central" });
  await ev("Last day of term", day(m + 25), day(m + 25), { all_day: true, calendar_id: kid });
  await ev("Christmas lunch at Nan's", at(m + 32, "12:30"), at(m + 32, "16:00"), { calendar_id: fam });
  await ev("Ferry to Tasmania", at(m + 47, "18:30"), at(m + 47, "21:00"), { calendar_id: fam });
  console.log("calendar: done");
}

// ---- notes ---------------------------------------------------------------
const p = (text, marks) => ({ type: "paragraph", content: text ? [{ type: "text", text, ...(marks ? { marks } : {}) }] : [] });
const h = (text) => ({ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text }] });
const doc = (...content) => ({ type: "doc", content });

async function notes() {
  const have = await api("claire", "GET", "/notes");
  if ((have.notes ?? have.items ?? []).length) return console.log("notes: already there");
  const tag = async (name, color) => (await api("claire", "POST", "/tags", { name, color }, { okStatuses: [409] })).id;
  const [travel, house, family] = [await tag("Travel", "#4F7FE0"), await tag("House", "#D97757"), await tag("Family", "#4E9F5B")];
  const note = (body) => api("claire", "POST", "/notes", { client_id: randomUUID(), ...body });
  const tags = (...ids) => ids.filter(Boolean);
  // Oldest first: the newest sits at the top.
  await note({ title: "Sourdough timings", color: "sand", text: "Feed starter 8 am\nMix dough 1 pm\nFolds at 1:30, 2:00, 2:30\nShape 6 pm, fridge overnight\nBake 230° lid on 25 min, lid off 20" });
  await note({ title: "Garden jobs", kind: "list", color: "sage", tag_ids: tags(house), items: [
    { text: "Mulch the veggie beds", checked: true }, { text: "Stake the tomatoes", checked: true }, { text: "Fix the dripper on the lemon tree", checked: false }, { text: "Plant basil and zucchini", checked: false }, { text: "Prune the wisteria", checked: false }] });
  await note({ title: "Book club", color: "dusk", body_doc: doc(p("Next: first half of The Salt Path", [{ type: "bold" }]), p("Then Dana's pick, then mine. Ideas: Lessons in Chemistry, Still Life, The Dictionary of Lost Words.")) });
  await note({ title: "Nan's lemon slice", color: "peach", tag_ids: tags(family), body_doc: doc(
    h("Base"), p("250 g plain biscuits, crushed. 1 cup coconut. Half a tin of condensed milk. 125 g butter, melted. Zest of a lemon."),
    h("Icing"), p("1¾ cups icing sugar, 3 tbsp lemon juice, 15 g soft butter."), p("Press the base into a lined tin, chill an hour, ice, chill again. Cut small. It's rich.")) });
  await note({ title: "Questions for the solar installer", kind: "list", color: "fog", tag_ids: tags(house), items: [
    { text: "Which inverter, and how long is its warranty?", checked: false }, { text: "Does shade from the gum tree matter?", checked: false }, { text: "Can a battery be added later?", checked: false },
    { text: "Who handles the meter change?", checked: false }, { text: "What's the feed-in rate?", checked: true }] });
  await note({ title: "Christmas presents", kind: "list", color: "blossom", tag_ids: tags(family), items: [
    { text: "Ellie: film camera, the green one", checked: true }, { text: "Max: Lego set and a new bike helmet", checked: false }, { text: "Tom: pizza oven?", checked: false },
    { text: "Mum: garden centre voucher", checked: true }, { text: "Dad: the cricket book", checked: false }, { text: "Secret Santa at work, $25", checked: false }] });
  await note({ title: "Max's party", color: "mint", tag_ids: tags(family), pinned: true, body_doc: doc(
    p("Bounce Central, Saturday 2 pm. Booked for 12 kids.", [{ type: "bold" }]), p("Cake: chocolate with the soccer ball on top. Order by the 5th."), p("Party bags: bouncy balls, stickers, no lollies with nuts (Arlo)."), p("Still to invite: Arlo, Jess, the twins.")) });
  await note({ title: "Tasmania in January", color: "storm", tag_ids: tags(travel), pinned: true, body_doc: doc(
    h("Booked"), p("Ferry over on the 9th, back on the 17th. Cabin on the way over."), h("Want to do"),
    p("Cradle Mountain: the lake circuit is about 2 hours, fine for Max."), p("Freycinet and the lookout walk. Go early."), p("Hobart market on the Saturday. Museum if it rains."),
    h("To sort"), p("Accommodation for nights 3 and 4. Someone to feed Biscuit.")) });
  const groceries = await note({ title: "Groceries", kind: "list", color: "default", pinned: true, items: [
    { text: "Chicken thighs x8", checked: false }, { text: "Beef mince 1 kg", checked: false }, { text: "Baby potatoes", checked: false }, { text: "Green beans", checked: true },
    { text: "Lemons", checked: true }, { text: "Taco shells", checked: false }, { text: "Chickpeas x2", checked: false }, { text: "Coconut milk", checked: false },
    { text: "Burger buns", checked: false }, { text: "Cabbage and carrots", checked: false }, { text: "Dog food", checked: false }] });
  const gid = groceries.note?.id ?? groceries.id;
  if (gid) await api("claire", "POST", `/notes/${gid}/members`, { user_ids: [users.tom.id] }, { okStatuses: [400, 404, 409, 422] });
  console.log("notes: done");
}

// ---- tasks ---------------------------------------------------------------
async function tasks() {
  const { file_id } = await api("claire", "POST", "/items/open/tasks");
  const cur = await api("claire", "GET", `/items/${file_id}`);
  if ((cur.data?.tasks ?? []).length) return console.log("tasks: already there");
  const add = (list) => api("claire", "POST", `/items/${file_id}/actions/add_tasks`, { args: { tasks: list } });
  await add([
    { title: "Sign Ellie's camp forms", list: "Home", due: day(0), priority: 3, steps: ["Permission form", "Medical form", "Pay the balance"] },
    { title: "Book someone to feed Biscuit in January", list: "Home", due: day(0), priority: 2 },
    { title: "Pay the electricity bill", list: "Home", due: day(-1), priority: 2, tags: ["bills"] },
    { title: "Order Max's birthday cake", list: "Home", due: day(3), time: "10:00" },
    { title: "Renew car registration", list: "Home", due: day(9), tags: ["bills"] },
    { title: "Send the quarterly report to Priya", list: "Work", due: day(0), time: "16:00", priority: 2 },
    { title: "Prepare slides for Thursday", list: "Work", due: day(2) },
    { title: "Book flights for the March conference", list: "Work", due: day(12) },
    { title: "Call Mum about Christmas lunch", list: "Personal", due: day(1) },
    { title: "Return library books", list: "Personal", due: day(5) },
    { title: "Book a skin check", list: "Personal" },
    { title: "Put the bins out", list: "Home", due: day(1), time: "19:00", repeat: { freq: "weekly", weekdays: [1] } },
    { title: "Water the veggie patch", list: "Home", due: day(0) },
    { title: "Reply to the netball club about umpiring", list: "Personal", due: day(-3) },
    { title: "Compare the two solar quotes", list: "Home", due: day(-2) },
    { title: "Buy a present for Arlo's party", list: "Shopping", due: day(-4) },
  ]);
  await api("claire", "POST", `/items/${file_id}/actions/complete_tasks`, { args: { tasks: ["Water the veggie patch", "Reply to the netball club about umpiring", "Compare the two solar quotes", "Buy a present for Arlo's party"] } });
  console.log("tasks: done");
}

// ---- item apps -----------------------------------------------------------
async function openItem(kind) {
  const { file_id } = await api("claire", "POST", `/items/open/${kind}`);
  const cur = await api("claire", "GET", `/items/${file_id}`);
  return { file_id, data: cur.data, revision: cur.revision };
}
const saveItem = (file_id, data, revision) => api("claire", "PUT", `/items/${file_id}`, { data, base_revision: revision });

async function habits() {
  const { file_id, data, revision } = await openItem("habits");
  if (data.habits?.length) return console.log("habits: already there");
  const logs = (skip, value = 1) => Array.from({ length: 30 }, (_, i) => i).filter((i) => !skip.includes(i)).map((i) => ({ day: day(-i), value, note: "", skipped: false, reason: "", at: "" }));
  const habit = (name, emoji, color, area, more = {}) => ({
    id: id(), name, emoji, color, area, type: "yes_no", target: 1, unit: "", limit: 0, schedule: { kind: "daily", days: [], times: 3, every: 2 },
    time_of_day: "anytime", reminders: [], start_date: day(-40), intention: "", identity: "", why: "", notes: "", archived: false, created_at: `${day(-40)}T08:00:00+11:00`, logs: [], ...more });
  data.habits = [
    habit("Walk Biscuit", "🐕", "#D97757", "Health", { time_of_day: "morning", logs: logs([6, 13]) }),
    habit("Read for 20 minutes", "📚", "#8E6BD9", "Mind", { time_of_day: "evening", logs: logs([0, 2, 9, 10, 17]) }),
    habit("Drink water", "💧", "#3B7DD8", "Health", { type: "count", target: 8, unit: "glasses", logs: [{ day: day(0), value: 5, note: "", skipped: false, reason: "", at: "" }, ...logs([0, 4], 8)] }),
    habit("Pilates", "🧘", "#4E9F5B", "Fitness", { schedule: { kind: "per_week", days: [], times: 2, every: 2 }, logs: logs([1, 2, 4, 5, 6, 8, 9, 11, 12, 13, 15, 16, 18, 19, 20, 22, 23, 25, 26, 27, 29]) }),
    habit("No phone after 9:30", "🌙", "#5B6DD9", "Mind", { time_of_day: "evening", logs: logs([0, 1, 5, 8, 12, 13, 20]) }),
  ];
  data.settings = { ...data.settings, onboarded: true };
  await saveItem(file_id, data, revision);
  console.log("habits: done");
}

async function mealplan() {
  const { file_id, data, revision } = await openItem("mealplan");
  if (data.recipes?.length) return console.log("mealplan: already there");
  const recipe = (title, cuisine, prep, cook, ingredients, steps, more = {}) => ({
    id: id(), title, servings: 4, ingredients: ingredients.map(([qty, unit, item]) => ({ id: id(), qty, unit, item, note: "", aisle: "" })),
    steps, prep_min: prep, cook_min: cook, tags: ["weeknight"], cuisine, rating: 4, favorite: false, ...more });
  const recipes = [
    recipe("Lemon and herb chicken traybake", "Mediterranean", 10, 30, [[8, "", "chicken thighs"], [600, "g", "baby potatoes"], [250, "g", "green beans"], [2, "", "lemons"]], ["Toss everything with oil, lemon and herbs.", "Roast at 200° for 30 minutes."], { favorite: true, rating: 5 }),
    recipe("Beef and veggie tacos", "Mexican", 10, 10, [[500, "g", "beef mince"], [12, "", "taco shells"], [1, "", "avocado"], [3, "", "tomatoes"]], ["Brown the mince with the spices.", "Warm the shells and build your own."]),
    recipe("Chickpea and spinach curry", "Indian", 10, 20, [[2, "tin", "chickpeas"], [400, "ml", "coconut milk"], [120, "g", "baby spinach"], [2, "tbsp", "curry paste"]], ["Fry the paste and onion.", "Add chickpeas and coconut milk, simmer 15 minutes.", "Stir the spinach through."], { tags: ["weeknight", "vegetarian"] }),
    recipe("Pesto pasta with tomatoes and peas", "Italian", 5, 10, [[500, "g", "penne"], [190, "g", "pesto"], [250, "g", "cherry tomatoes"], [1, "cup", "frozen peas"]], ["Cook the pasta, adding the peas for the last 2 minutes.", "Toss with pesto and tomatoes."], { favorite: true }),
    recipe("Beef burgers with wedges and slaw", "Australian", 15, 15, [[500, "g", "beef mince"], [4, "", "burger buns"], [0.25, "", "cabbage"], [2, "", "carrots"]], ["Shape and season the patties.", "Grill 4 minutes a side.", "Serve with slaw and oven wedges."]),
    recipe("Slow cooker lamb shanks", "Australian", 15, 480, [[4, "", "lamb shanks"], [400, "g", "tinned tomatoes"], [2, "", "carrots"]], ["Brown the shanks.", "Everything into the slow cooker on low for 8 hours."], { tags: ["weekend"], rating: 5 }),
    recipe("Pumpkin soup", "Australian", 10, 30, [[1, "kg", "pumpkin"], [1, "", "onion"], [1, "l", "vegetable stock"]], ["Simmer until soft.", "Blend."], { tags: ["vegetarian", "freezes well"] }),
    recipe("Sunday roast chicken", "Australian", 15, 80, [[1, "", "whole chicken"], [1, "kg", "potatoes"], [500, "g", "pumpkin"]], ["Roast at 190° for 80 minutes.", "Rest 10 minutes before carving."], { tags: ["weekend"], favorite: true }),
  ];
  data.recipes = recipes;
  const order = [0, 1, 2, 3, 4, 5, 7];
  data.plan = order.map((r, i) => ({ id: id(), date: day(monday + i), slot: "dinner", recipe_id: recipes[r].id, title: recipes[r].title, servings: 4, note: "", cooked: monday + i < 0 }));
  data.preferences = { ...data.preferences, household_size: 4, dislikes: ["mushrooms"], weeknight_minutes: 40, onboarded: true };
  data.grocery = { ...(data.grocery ?? {}), items: [["Chicken thighs", 8, ""], ["Beef mince", 1, "kg"], ["Baby potatoes", 600, "g"], ["Green beans", 250, "g"], ["Lemons", 2, ""], ["Taco shells", 12, ""], ["Chickpeas", 2, "tin"], ["Coconut milk", 400, "ml"], ["Penne", 500, "g"], ["Burger buns", 4, ""]]
    .map(([name, qty, unit], i) => ({ id: id(), name, amounts: [{ qty, unit }], aisle: "other", checked: i === 3 || i === 4, source: "manual" })) };
  await saveItem(file_id, data, revision);
  console.log("mealplan: done");
}

async function budget() {
  const { file_id, data, revision } = await openItem("budget");
  if (data.transactions?.length) return console.log("budget: already there");
  const acct = id();
  const saver = id();
  data.accounts = [
    { id: acct, name: "Everyday", type: "transactional", currency: "AUD", balance_cents: 384250, source: "manual", on_budget: true },
    { id: saver, name: "Holiday saver", type: "saver", currency: "AUD", balance_cents: 620000, source: "manual", on_budget: false },
  ];
  const tx = (back, cents, payee, category_id) => ({ id: id(), date: day(-back), amount_cents: cents, payee, category_id, category_by: "user", account_id: acct });
  data.transactions = [
    tx(0, -8420, "Greengrocer on Mill St", "groceries"), tx(1, -18645, "FreshWay Supermarket", "groceries"), tx(1, -5200, "Hillview Fuel", "fuel"),
    tx(2, -4350, "The Corner Bakehouse", "eating_out"), tx(3, -1899, "StreamBox", "subscriptions"), tx(3, -12900, "Wattle Creek Netball Club", "kids"),
    tx(4, 462000, "Northfield Design (salary)", "salary"), tx(5, -6500, "Paws and Claws Vet", "pets"), tx(6, -15230, "FreshWay Supermarket", "groceries"),
    tx(7, -8900, "Fibre Home Internet", "internet"), tx(8, -3600, "Riverside Cinema", "entertainment"), tx(9, -7450, "Bunya Hardware", "home_maintenance"),
    tx(10, -21000, "Car insurance", "insurance"), tx(11, 388000, "Calder Engineering (salary)", "salary"), tx(12, -17310, "FreshWay Supermarket", "groceries"),
    tx(13, -5600, "Hillview Fuel", "fuel"), tx(14, -9500, "School excursion", "education"), tx(16, -4800, "Thai Orchid", "takeaway"),
    tx(18, -240000, "Home loan", "rent"),
    ...[1, 2, 3, 4].flatMap((m) => [tx(m * 30 + 4, 462000, "Northfield Design (salary)", "salary"), tx(m * 30 + 11, 388000, "Calder Engineering (salary)", "salary"), tx(m * 30 + 18, -240000, "Home loan", "rent"),
      tx(m * 30 + 6, -118000 - m * 4100, "FreshWay Supermarket", "groceries"), tx(m * 30 + 9, -41000 + m * 2300, "Hillview Fuel", "fuel"), tx(m * 30 + 13, -96000 - m * 9000, "Bills and everything else", "misc")]), tx(19, -16480, "FreshWay Supermarket", "groceries"), tx(20, -3999, "Mobile plan", "mobile"),
  ];
  const limits = { groceries: 90000, eating_out: 20000, takeaway: 12000, fuel: 24000, kids: 30000, pets: 12000, entertainment: 15000, subscriptions: 6000, internet: 8900, mobile: 8000, insurance: 21000, rent: 240000, home_maintenance: 15000, education: 15000 };
  data.categories = (data.categories ?? []).map((c) => (limits[c.id] ? { ...c, budget_cents: limits[c.id] } : c));
  const month = day(0).slice(0, 7);
  data.months = [{ month, assigned: limits, note: "" }];
  data.goals = [
    { id: id(), name: "Tasmania trip", target_cents: 650000, saved_cents: 520000, target_date: day(45), emoji: "⛰️" },
    { id: id(), name: "Solar panels", target_cents: 800000, saved_cents: 310000, target_date: day(200), emoji: "☀️" },
  ];
  data.subscriptions = [
    { id: id(), name: "StreamBox", kind: "subscription", cadence: "monthly", amount_cents: 1899, monthly_cents: 1899, next_due: day(3), source: "manual", user_status: "confirmed", category_id: "subscriptions" },
    { id: id(), name: "Fibre Home Internet", kind: "bill", cadence: "monthly", amount_cents: 8900, monthly_cents: 8900, next_due: day(6), source: "manual", user_status: "confirmed", category_id: "internet" },
    { id: id(), name: "Electricity", kind: "bill", cadence: "quarterly", amount_cents: 41260, monthly_cents: 13753, next_due: day(11), source: "manual", user_status: "confirmed", category_id: "utilities" },
  ];
  data.settings = { ...data.settings, onboarded: true };
  await saveItem(file_id, data, revision);
  console.log("budget: done");
}

async function journal() {
  const { file_id, data, revision } = await openItem("journal");
  if (data.entries?.length) return console.log("journal: already there");
  const entry = (back, title, body, mood, emotions, more = {}) => ({ id: id(), date: day(-back), time: "21:10", title, body, mood, emotions, energy: 3, tags: [], gratitude: [], location: "", weather: "", starred: false, template_id: null, prompt: "", ...more });
  data.entries = [
    entry(0, "A proper Sunday", "Slow start, pancakes, then the working bee in the garden. Max found a blue-tongue lizard under the compost bin and named it Kevin.\n\nTom and I finally sat down with the solar quotes. Still not sure, but at least we know what to ask.", 4, ["content", "grateful"], { gratitude: ["Pancakes with everyone home", "Kevin the lizard"], tags: ["family"] }),
    entry(1, "Netball final", "Ellie's team lost by two but she played the best I've seen her play. Quiet in the car, then asked for hot chips, so we got hot chips.", 4, ["proud"], { tags: ["family"] }),
    entry(2, "Long one at work", "Planning ran over. Home late. Tom had dinner on.", 3, ["tired"]),
    entry(3, "Walk before work", "Out with Biscuit at six. Mist on the oval. Worth getting up for.", 5, ["calm"], { starred: true }),
    entry(5, "Mum's news", "Mum rang. All clear from the specialist. Cried a bit in the car park.", 5, ["relieved", "grateful"], { starred: true }),
    entry(6, "Rain all day", "Board games and soup. Max beat everyone at Ticket to Ride.", 4, ["content"]),
  ];
  data.settings = { ...data.settings, onboarded: true };
  await saveItem(file_id, data, revision);
  console.log("journal: done");
}

// ---- files ---------------------------------------------------------------
const ITINERARY = `Nine days, four of us, one car. Ferry over on Saturday 9 January, back on Sunday 17 January.

## The plan

| Day | Where | What |
| :-- | :-- | :-- |
| Sat 9 | Ferry | Evening crossing, cabin booked |
| Sun 10 | Devonport to Cradle Mountain | Stop in Sheffield for the murals |
| Mon 11 | Cradle Mountain | Lake circuit in the morning, wombats at dusk |
| Tue 12 | Cradle Mountain to Launceston | Cataract Gorge, swim if it's warm |
| Wed 13 | Launceston to Freycinet | Long drive. Fish and chips on the way |
| Thu 14 | Freycinet | Lookout walk early, beach in the afternoon |
| Fri 15 | Freycinet to Hobart | Check in, wander the waterfront |
| Sat 16 | Hobart | Market, then the museum if it rains |
| Sun 17 | Hobart to Devonport | Ferry home |

## Still to book

- [x] Ferry both ways
- [x] Cradle Mountain cabin, two nights
- [ ] Freycinet, two nights
- [ ] Hobart, two nights
- [ ] Someone to feed Biscuit

## Budget

About **$6,500** all up. The ferry and the first two nights are paid. Food is the part we always get wrong, so allow $150 a day.

## Packing notes

Layers. It can be 30° in Hobart and 8° at Cradle Mountain on the same day. Walking shoes for everyone, and the good raincoats.
`;

const PARTY = `**Saturday, 2:00 to 4:30 pm at Bounce Central.** Booked for 12 kids, party room from 3:30.

## Guest list

| Name | Coming? | Notes |
| :-- | :-- | :-- |
| Arlo | Yes | Nut allergy |
| Jess | Yes | |
| Theo and Sam | Yes | Being dropped at 2:15 |
| Hamish | Waiting | |
| Lucy | Yes | Vegetarian |
| Kai | No | Away |

## To do

- [x] Book the venue
- [x] Send invitations
- [ ] Order the cake by the 5th
- [ ] Party bags
- [ ] Ask Nan to bring the sausage rolls
`;

const SOLAR = `We asked two installers for a system to suit a four-person house that uses about 22 kWh a day.

| | BrightRoof | Sunline Electrical |
| :-- | :-- | :-- |
| Size | 6.6 kW | 8.0 kW |
| Panels | 15 | 18 |
| Inverter | 5 kW string | Microinverters |
| Price after rebate | $6,900 | $9,400 |
| Product warranty | 10 years | 25 years |
| Battery ready | Yes | Yes |

## Thoughts

Sunline costs more but copes better with the shade from the gum tree in the afternoon. BrightRoof pays itself off sooner if the shade turns out not to matter.

## Questions to ask on Wednesday

1. How much does afternoon shade cost us on a string system?
2. Who organises the meter change, and how long does it take?
3. What does adding a battery later involve?
`;

function sheet(name, rows, widths = {}) {
  const celldata = [];
  rows.forEach((row, r) => row.forEach((value, c) => {
    if (value === "" || value === null) return;
    const number = typeof value === "number";
    const formula = typeof value === "string" && value.startsWith("=");
    const v = formula ? { f: value } : { v: value, m: number ? value.toLocaleString("en-AU") : String(value) };
    if (number || formula) v.ct = { fa: "#,##0", t: "n" };
    if (r === 0 || (c === 0 && String(value).startsWith("Total"))) v.bl = 1;
    if (r === 0) v.bg = "#F3E9E2";
    celldata.push({ r, c, v });
  }));
  return { name, id: id(), order: 0, status: 1, row: Math.max(40, rows.length + 10), column: 14, celldata, config: { columnlen: widths } };
}

async function upload(who, name, content, type, folder_id) {
  const form = new FormData();
  form.append("file", new Blob([content], { type }), name);
  if (folder_id) form.append("folder_id", folder_id);
  form.append("scope", "mine");
  return api(who, "POST", "/files/", form, { form: true });
}

async function pdf(browser, title, lines) {
  const page = await browser.newPage();
  await page.setContent(`<html><body style="font-family:Georgia,serif;margin:56px;color:#222"><h1 style="font-size:26px;border-bottom:2px solid #c66;padding-bottom:8px">${title}</h1>${lines.map((l) => `<p style="font-size:14px;line-height:1.6">${l}</p>`).join("")}</body></html>`);
  const bytes = await page.pdf({ format: "A4" });
  await page.close();
  return bytes;
}

async function files() {
  const root = await api("claire", "GET", "/files/browse?scope=mine");
  const existing = root.folders ?? [];
  if (existing.some((f) => f.name === "Travel")) return console.log("files: already there");
  const folder = async (name, parent_id = null) => (await api("claire", "POST", "/files/folders", { name, parent_id, scope: "mine" })).id;
  const house = await folder("House");
  const school = await folder("School");
  const travel = await folder("Travel");
  const money = await folder("Money");
  const recipes = await folder("Recipes");
  await folder("Insurance", house);
  await folder("Tasmania 2027", travel);

  const mdDoc = async (name, markdown, folder_id) => {
    const src = await upload("claire", `${name}.md`, markdown, "text/markdown", folder_id);
    const made = await api("claire", "POST", "/documents/import", { source_file_id: src.id, name });
    await api("claire", "DELETE", `/files/${src.id}`, undefined, { okStatuses: [400, 404, 405, 422] });
    return made.id ?? made.file?.id;
  };
  const itinerary = await mdDoc("Tasmania itinerary", ITINERARY, null);
  await mdDoc("Max's birthday party", PARTY, null);
  const solar = await mdDoc("Solar quotes compared", SOLAR, null);

  const newSheet = async (title, folder_id, tabs) => {
    const made = await api("claire", "POST", "/files/office", { kind: "sheet", title, folder_id });
    const fid = made.id ?? made.file?.id;
    await api("claire", "PUT", `/files/${fid}/sheet`, { data: tabs, content_text: title });
    return fid;
  };
  const months = ["Jul", "Aug", "Sep", "Oct", "Nov"];
  const rows = [
    ["Category", ...months, "Budget", "Average"],
    ["Home loan", 2400, 2400, 2400, 2400, 2400, 2400],
    ["Groceries", 1180, 1240, 1095, 1310, 870, 1200],
    ["Power and water", 310, 0, 0, 412, 0, 250],
    ["Internet and phones", 169, 169, 169, 169, 169, 170],
    ["Car and fuel", 420, 365, 610, 388, 318, 450],
    ["Kids: school and sport", 280, 145, 390, 220, 224, 300],
    ["Eating out", 260, 310, 185, 240, 136, 250],
    ["Insurance", 210, 210, 210, 210, 210, 210],
    ["Biscuit", 60, 60, 245, 60, 125, 100],
    ["Holiday saver", 500, 500, 500, 500, 500, 500],
  ].map((r, i) => (i === 0 ? r : [...r, `=ROUND(AVERAGE(B${i + 1}:F${i + 1}),0)`]));
  rows.push(["Total", ...["B", "C", "D", "E", "F", "G", "H"].map((col) => `=SUM(${col}2:${col}11)`)]);
  const budgetSheet = await newSheet("Household budget", null, [sheet("2026", rows, { 0: 190 })]);
  await newSheet("Christmas card list", null, [sheet("Cards", [
    ["Name", "Town", "Sent"], ["Nan and Pop", "Wattle Creek", "Yes"], ["Uncle Rob and Jen", "Kettle Bay", "Yes"], ["The Whitlocks", "Wattle Creek", ""], ["Aunty Sue", "Marlow Flat", "Yes"], ["Sam and Jo", "Wattle Creek", ""], ["The Nguyens", "Harbour Point", ""],
  ], { 0: 170, 1: 130 })]);

  const browser = await chromium.launch();
  try {
    await upload("claire", "Solar quote - BrightRoof.pdf", await pdf(browser, "Quote: 6.6 kW solar system", ["Prepared for C. and T. Hartley, Wattle Creek.", "15 panels, one 5 kW string inverter, installation and metering.", "Price after rebate: $6,900 including GST.", "This quote is valid for 30 days."]), "application/pdf", house);
    await upload("claire", "Solar quote - Sunline.pdf", await pdf(browser, "Quote: 8.0 kW solar system", ["Prepared for C. and T. Hartley, Wattle Creek.", "18 panels with microinverters, installation and metering.", "Price after rebate: $9,400 including GST.", "25 year product warranty."]), "application/pdf", house);
    await upload("claire", "Year 10 camp - permission form.pdf", await pdf(browser, "Year 10 camp: Lake Merrin", ["Monday 7 to Wednesday 9 December.", "Please return this form by Friday.", "Student name: ______________________", "Parent or guardian signature: ______________________"]), "application/pdf", null);
    await upload("claire", "Ferry booking.pdf", await pdf(browser, "Booking confirmation", ["Saturday 9 January, evening crossing.", "2 adults, 2 children, 1 vehicle under 5 m.", "4-berth inside cabin."]), "application/pdf", null);
    await upload("claire", "Ellie - Semester 2 report.pdf", await pdf(browser, "Semester 2 report", ["Year 10", "English: A. Mathematics: B+. Science: A-. History: A.", "Ellie is a thoughtful and hard-working student."]), "application/pdf", school);
    await upload("claire", "Home insurance policy.pdf", await pdf(browser, "Home and contents policy", ["Policy schedule", "Period of insurance: 12 months."]), "application/pdf", house);
    await upload("claire", "Nan's lemon slice.pdf", await pdf(browser, "Nan's lemon slice", ["Base: biscuits, coconut, condensed milk, butter, lemon zest.", "Icing: icing sugar, lemon juice, butter."]), "application/pdf", recipes);
  } finally {
    await browser.close();
  }

  // Share, star, and a comment thread on the itinerary.
  for (const fid of [itinerary, solar]) await api("claire", "POST", `/files/file/${fid}/grants`, { grantee_user_id: users.tom.id, can_copy: false, can_comment: true, can_edit: true }, { okStatuses: [400, 404, 409, 422] });
  await api("claire", "POST", `/files/file/${budgetSheet}/grants`, { grantee_user_id: users.tom.id, can_copy: false, can_comment: true, can_edit: true }, { okStatuses: [400, 404, 409, 422] });
  for (const fid of [itinerary, budgetSheet]) await api("claire", "POST", `/files/${fid}/star`, undefined, { okStatuses: [400, 404, 409] });
  await api("claire", "POST", `/files/folders/${travel}/star`, undefined, { okStatuses: [400, 404, 409] });
  const first = await api("tom", "POST", `/documents/${itinerary}/comments`, { body: "Could we swap this with the Launceston day? The forecast looks better later in the week.", quote: "Lake circuit in the morning, wombats at dusk", anchor: null, parent_id: null }, { okStatuses: [400, 403, 404, 422] });
  const cid = first.id ?? first.comment?.id;
  if (cid) await api("claire", "POST", `/documents/${itinerary}/comments`, { body: "Good idea. I'll check the cabin can move a night.", parent_id: cid }, { okStatuses: [400, 403, 404, 422] });
  await api("tom", "POST", `/documents/${itinerary}/comments`, { body: "I can ask Mum and Dad about Biscuit.", quote: "Someone to feed Biscuit", anchor: null, parent_id: null }, { okStatuses: [400, 403, 404, 422] });
  console.log("files: done", { itinerary, budgetSheet });
}

// ---- rooms ---------------------------------------------------------------
async function rooms() {
  const mine = await api("claire", "GET", "/rooms/spaces", undefined, { okStatuses: [404, 405] });
  const list = Array.isArray(mine) ? mine : mine.spaces ?? [];
  if (list.some((s) => s.name === "Hartley HQ")) return console.log("rooms: already there");
  const space = await api("claire", "POST", "/rooms/spaces", { name: "Hartley HQ", emoji: "🏡", color: "#D97757" });
  await api("claire", "POST", `/rooms/spaces/${space.id}/members`, { user_ids: [users.tom.id, users.ellie.id, users.max.id] });
  const room = async (name, topic) => (await api("claire", "POST", `/rooms/spaces/${space.id}/rooms`, { name, topic, kind: "text" })).id;
  const dinner = await room("dinner", "What's for dinner, and who's cooking");
  const holiday = await room("tassie-trip", "January. Nine days. One car.");
  await room("pets", "Mostly Biscuit");
  const say = async (who, room_id, body, react = []) => {
    const m = await api(who, "POST", `/rooms/rooms/${room_id}/messages`, { body, attachment_ids: [] });
    const mid = m.id ?? m.message?.id;
    for (const [by, emoji] of react) await api(by, "PUT", `/rooms/messages/${mid}/reactions`, { emoji }, { okStatuses: [400, 404, 409, 422] });
    return mid;
  };
  await say("claire", holiday, "Ferry is booked both ways! Cabin on the way over.", [["tom", "🎉"], ["ellie", "🎉"], ["max", "🚢"]]);
  await say("max", holiday, "can we see a wombat");
  await say("tom", holiday, "Cradle Mountain is basically all wombats. You'll be sick of them.");
  await say("max", holiday, "impossible");

  const g = space.room_id;
  await say("tom", g, "Running late, back about 6:30. Can someone get the washing in? It looks like rain.");
  await say("ellie", g, "done", [["tom", "🙏"]]);
  await say("claire", g, "Thanks Ell. Parent-teacher is at 6 so I'll go straight there. Tom, meet me at the school?");
  await say("tom", g, "Yep. Which room?");
  await say("claire", g, "B12, Ms Okafor first.");
  await say("max", g, "whats for dinner");
  await say("claire", g, "Chicken traybake. It's in the fridge ready to go. Ellie, can you put it in at 5:45, 200 degrees?", [["ellie", "👍"]]);
  await say("ellie", g, "ok. can Zoe come over saturday");
  await say("claire", g, "After the market, yes.");
  await say("max", g, "biscuit ate my sock again");
  await say("tom", g, "That's four this month. He has a type.", [["claire", "😂"], ["ellie", "😂"], ["max", "😂"]]);
  await say("ellie", g, "netball got moved to court 3 tomorrow btw");
  await say("claire", g, "Thanks, I've changed it in the calendar.", [["ellie", "❤️"]]);

  await say("tom", dinner, "I'll do tacos tomorrow, home by 5.");
  await say("ellie", dinner, "can we have the good salsa");
  await say("claire", dinner, "It's on the list.");

  const dm = await api("claire", "POST", "/rooms/dms", { user_ids: [users.tom.id] });
  const dmRoom = dm.id ?? dm.room_id ?? dm.room?.id;
  if (dmRoom) {
    await say("tom", dmRoom, "Did you see the second solar quote? $2,500 more but it handles the shade.");
    await say("claire", dmRoom, "Saw it. Let's ask the installer on Wednesday before we decide.");
  }
  for (const who of ["claire"]) for (const r of [g, dinner, holiday]) await api(who, "POST", `/rooms/rooms/${r}/read`, undefined, { okStatuses: [400, 404, 405, 422] });
  console.log("rooms: done");
}

// ---- porch ---------------------------------------------------------------
async function porch() {
  const feed = await api("claire", "GET", "/porch/feed", undefined, { okStatuses: [404] });
  if ((feed.posts ?? feed.items ?? []).length) return console.log("porch: already there");
  const group = await api("claire", "POST", "/porch/groups", { name: "The Hartleys", visibility: "private", emoji: "🏡", about: "Just us", members_can_invite: false, invite: [users.tom.id, users.ellie.id, users.max.id] }, { okStatuses: [400, 409, 422] });
  const gid = group.id ?? group.group?.id;
  if (gid) for (const who of ["tom", "ellie", "max"]) await api(who, "POST", `/porch/groups/${gid}/accept`, undefined, { okStatuses: [400, 404, 409, 422] });
  for (const who of ["claire", "tom", "ellie", "max"]) await api(who, "PATCH", "/porch/me/profile", { welcomed: true }, { okStatuses: [400, 404, 405, 422] });
  const post = async (who, body) => {
    const made = await api(who, "POST", "/porch/posts", { kind: "text", body, groups: "all" });
    return made.id ?? made.post?.id;
  };
  const react = (who, pid, emoji) => api(who, "PUT", `/porch/posts/${pid}/reactions`, { emoji }, { okStatuses: [400, 404, 409, 422] });
  const comment = (who, pid, body) => api(who, "POST", `/porch/posts/${pid}/comments`, { body, parent_id: null }, { okStatuses: [400, 404, 422] });
  const a = await post("ellie", "Lost the final by two. Proud of us anyway. Thanks for coming everyone, and for the hot chips.");
  await react("claire", a, "❤️"); await react("tom", a, "👏"); await react("max", a, "❤️");
  await comment("tom", a, "Best game you've played all season.");
  const shots = path.join(here, "readme-shots", "photos", "uploaded.json");
  const ids = fs.existsSync(shots) ? Object.entries(JSON.parse(fs.readFileSync(shots, "utf8"))) : [];
  const pick = (word) => ids.filter(([name]) => name.includes(word)).map(([, file_id]) => file_id);
  const photo = async (body, files, alts) => (files.length ? (await api("claire", "POST", "/porch/posts", { kind: "photo", body, groups: "all", media: files.map((file_id, i) => ({ file_id, alt_text: alts[i] ?? alts[0] })) }, { okStatuses: [400, 404, 422] })).id : null);
  const e = await photo("Pancake Sunday. Tom's best stack yet.", pick("pancakes_with_walnuts"), ["A stack of pancakes with honey being poured over"]);
  if (e) { await react("ellie", e, "😍"); await react("tom", e, "💪"); await comment("ellie", e, "can this be every Sunday"); }
  const b = await post("tom", "Working bee done. Four trailer loads of mulch, one blue-tongue lizard relocated, zero injuries.");
  await react("claire", b, "💪"); await react("ellie", b, "😂");
  await comment("max", b, "his name is Kevin");
  const d = await photo("Biscuit found the dam. Biscuit will need a bath.", [...pick("shaking_off"), ...pick("Retriever_Swimming")], ["A golden retriever shaking off water", "A golden retriever swimming"]);
  if (d) { await react("tom", d, "😂"); await react("ellie", d, "❤️"); await react("max", d, "❤️"); await comment("max", d, "he did it again today"); await comment("tom", d, "I'll get the hose."); }
  const c = await post("claire", "Ferry to Tasmania is booked for January. Nine days, four of us and a very full car.");
  await react("tom", c, "🎉"); await react("ellie", c, "🎉"); await react("max", c, "🎉");
  await comment("ellie", c, "Can we do the market in Hobart?");
  await comment("claire", c, "Already on the list.");
  console.log("porch: done");
}

// ---- forms ---------------------------------------------------------------
async function forms() {
  const have = await api("claire", "GET", "/forms", undefined, { okStatuses: [404] });
  if ((have.forms ?? have.items ?? (Array.isArray(have) ? have : [])).length) return console.log("forms: already there");
  await api("claire", "POST", "/forms", { template: "rsvp", title: "Max's 12th birthday: can you come?" });
  await api("claire", "POST", "/forms", { template: "signup", title: "Netball canteen roster" });
  console.log("forms: done");
}


// ---- photos --------------------------------------------------------------
// Needs e2e/readme-shots/photos/ (node readme-shots/fetch-photos.mjs get).
async function photos() {
  const dir = path.join(here, "readme-shots", "photos");
  if (!fs.existsSync(path.join(dir, "manifest.json"))) return console.log("photos: no photographs fetched, skipped");
  const have = await api("claire", "GET", "/photos/albums");
  if ((have.albums ?? have.items ?? (Array.isArray(have) ? have : [])).length) return console.log("photos: already there");
  const albums = {};
  const ids = {};
  for (const shot of JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"))) {
    const form = new FormData();
    const stamp = shot.taken.replace(/[-:T]/g, "").slice(0, 12);
    form.append("file", new Blob([fs.readFileSync(path.join(dir, shot.file))], { type: "image/jpeg" }), `IMG_${stamp.slice(0, 8)}_${stamp.slice(8)}.jpg`);
    form.append("scope", "mine");
    form.append("route", "camera");
    form.append("last_modified", String(new Date(`${shot.taken}:00+11:00`).getTime()));
    const made = await api("claire", "POST", "/files/", form, { form: true });
    ids[shot.file] = made.id;
    if (shot.album) (albums[shot.album] ??= []).push(made.id);
  }
  // A photo joins the library when the media worker has read it, a few
  // seconds after the upload; an album only takes photos that have.
  for (const [title, file_ids] of Object.entries(albums)) {
    const made = await api("claire", "POST", "/photos/albums", { title });
    const album = made.id ?? made.album?.id;
    let left = file_ids.length;
    for (let tries = 0; left > 0 && tries < 40; tries++) {
      const r = await api("claire", "POST", `/photos/albums/${album}/items`, { file_ids });
      left -= r.added ?? 0;
      if (left > 0) await new Promise((done) => setTimeout(done, 3000));
    }
    if (left > 0) console.log(`photos: ${title} is ${left} short`);
  }
  fs.writeFileSync(path.join(dir, "uploaded.json"), JSON.stringify(ids, null, 1));
  await api("claire", "PUT", "/photos/settings", { setup_done: true }, { okStatuses: [400, 404, 405, 422] });
  console.log("photos: done");
}

// ---- passwords -----------------------------------------------------------
// End-to-end encrypted, so the entries can only be made in the browser.
const VAULT = "wattle creek lemon slice 12!"; // the demo vault's master password; tools-readme-shots.mjs unlocks with it
const LOGINS = [
  ["Wattle Creek Library", "claire@hartley.example.com", "https://library.wattlecreek.example.com"],
  ["Southern Ridge Energy", "claire@hartley.example.com", "https://my.southernridge.example.com"],
  ["StreamBox", "hartleyfamily", "https://streambox.example.com"],
  ["FreshWay Supermarket", "claire@hartley.example.com", "https://freshway.example.com"],
  ["School parent portal", "chartley", "https://parents.wattlecreekhigh.example.com"],
  ["Bass Strait Ferries", "claire@hartley.example.com", "https://bassstraitferries.example.com"],
  ["Fibre Home Internet", "hartley-4417", "https://account.fibrehome.example.com"],
  ["Riverbend Dental", "claire@hartley.example.com", "https://riverbenddental.example.com"],
];

async function passwords() {
  // The vault's Secret Key stays in the browser that made it and can't be
  // exported, so this browser profile is kept for the screenshot to reuse.
  const context = await chromium.launchPersistentContext(path.join(path.dirname(AUTH), "vault-profile"), { viewport: { width: 1280, height: 860 }, serviceWorkers: "allow" });
  await context.addCookies([{ name: "promptly_refresh", value: users.claire.refresh_token, domain: new URL(BASE).hostname, path: "/api/auth", expires: Date.now() / 1000 + 86400, httpOnly: true, secure: false, sameSite: "Strict" }]);
  const browser = context;
  const page = context.pages()[0] ?? (await context.newPage());
  try {
    await page.goto(`${BASE}/passwords`);
    const fresh = page.getByText("I understand");
    const locked = page.getByRole("button", { name: "Unlock", exact: true });
    await fresh.or(locked).first().waitFor({ timeout: 30_000 });
    if (await locked.isVisible()) return console.log("passwords: already there");
    await fresh.click();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByLabel("Master password").fill(VAULT);
    await page.getByLabel("Type it again").fill(VAULT);
    await page.getByRole("button", { name: "Create vault" }).click();
    const key = (await page.getByTestId("secret-key").textContent({ timeout: 60_000 })).trim();
    await page.getByText("I've saved my recovery kit").click();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByLabel("Last group of your Secret Key").fill(key.split("-").pop());
    await page.getByRole("button", { name: "Finish" }).click();
    await page.getByRole("button", { name: "Open my vault" }).click();
    await page.getByRole("navigation", { name: "Passwords" }).waitFor({ timeout: 30_000 });
    for (const [title, username, url] of LOGINS) {
      await page.getByRole("button", { name: "New", exact: true }).click();
      await page.getByRole("menuitem", { name: "Login" }).click();
      await page.getByLabel("Name", { exact: true }).fill(title);
      await page.getByLabel("Username or email").fill(username);
      await page.getByLabel("Password", { exact: true }).fill(`${randomUUID().slice(0, 13)}-Aa7!`);
      await page.getByLabel("Website 1", { exact: true }).fill(url);
      await page.getByRole("button", { name: "Save" }).click();
      await page.getByRole("article", { name: title }).waitFor({ timeout: 20_000 });
    }

    console.log("passwords: done");
  } finally {
    await browser.close();
  }
}

const sections = { calendar, notes, tasks, habits, mealplan, budget, journal, photos, files, rooms, porch, forms, passwords };
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(sections);
for (const name of wanted) {
  try {
    await sections[name]();
  } catch (err) {
    console.error(`${name}: FAILED: ${err.message}`);
    process.exitCode = 1;
  }
}
