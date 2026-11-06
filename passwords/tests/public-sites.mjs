// Plan 13.4, the public-site check. A smoke test, since sites change. Loads a list of public
// login pages one at a time, runs only the classifier, and records what it found.
//   cd e2e && node ../passwords/tests/public-sites.mjs
//
// It reads and nothing else: no typing, no clicks, no consent banners answered, no form
// submitted, no accounts. A page that shows a bot check is recorded as blocked and left alone,
// with the browser's own identity unchanged. Nothing from a page is kept beyond counts and the
// classifier's verdict, and the results stay out of the repo (.cache is ignored).
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, "../../e2e/package.json"));
const { chromium } = require("@playwright/test");

await import("./build-autofill-bundle.mjs");
const bundle = fs.readFileSync(path.join(here, ".cache", "autofill.js"), "utf8");

const SITES = [
  "https://github.com/login", "https://gitlab.com/users/sign_in", "https://bitbucket.org/account/signin/", "https://stackoverflow.com/users/login",
  "https://www.reddit.com/login/", "https://news.ycombinator.com/login", "https://www.linkedin.com/login", "https://www.facebook.com/login", "https://www.instagram.com/accounts/login/", "https://x.com/i/flow/login",
  "https://www.pinterest.com/login/", "https://www.tumblr.com/login", "https://www.quora.com/", "https://medium.com/m/signin", "https://discord.com/login", "https://slack.com/signin", "https://zoom.us/signin",
  "https://accounts.google.com/signin", "https://login.microsoftonline.com/", "https://login.live.com/", "https://appleid.apple.com/sign-in", "https://login.yahoo.com/", "https://mail.proton.me/login", "https://www.icloud.com/",
  "https://www.dropbox.com/login", "https://app.box.com/login", "https://www.notion.so/login", "https://trello.com/login", "https://id.atlassian.com/login", "https://asana.com/login", "https://app.clickup.com/login", "https://monday.com/users/sign_in_new",
  "https://www.evernote.com/Login.action", "https://todoist.com/auth/login", "https://www.figma.com/login", "https://www.canva.com/login", "https://www.adobe.com/account/sign-in.html",
  "https://www.amazon.com/ap/signin?openid.pape.max_auth_age=0&openid.return_to=https%3A%2F%2Fwww.amazon.com%2F&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.assoc_handle=usflex&openid.mode=checkid_setup&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0",
  "https://signin.ebay.com/", "https://www.etsy.com/signin", "https://www.walmart.com/account/login", "https://www.target.com/account", "https://www.bestbuy.com/identity/global/signin", "https://www.ikea.com/au/en/profile/login/", "https://www.aliexpress.com/p/ug-login-page/login.html",
  "https://www.netflix.com/login", "https://www.disneyplus.com/login", "https://www.hulu.com/welcome", "https://accounts.spotify.com/login", "https://www.twitch.tv/login", "https://www.crunchyroll.com/login", "https://www.max.com/sign-in", "https://www.primevideo.com/",
  "https://store.steampowered.com/login/", "https://www.epicgames.com/id/login", "https://www.gog.com/", "https://account.battle.net/login", "https://www.nintendo.com/", "https://my.playstation.com/",
  "https://www.paypal.com/signin", "https://wise.com/login", "https://www.revolut.com/app/", "https://dashboard.stripe.com/login", "https://www.coinbase.com/signin", "https://www.kraken.com/sign-in", "https://www.xero.com/login/", "https://www.ing.com.au/securebanking/",
  "https://www.booking.com/signin.html", "https://www.airbnb.com/login", "https://www.expedia.com/login", "https://www.tripadvisor.com/", "https://www.uber.com/global/en/sign-in/", "https://www.lyft.com/login",
  "https://aws.amazon.com/console/", "https://signin.aws.amazon.com/signin", "https://portal.azure.com/", "https://console.cloud.google.com/", "https://cloud.digitalocean.com/login", "https://dash.cloudflare.com/login", "https://app.netlify.com/login", "https://vercel.com/login", "https://www.heroku.com/login", "https://id.heroku.com/login",
  "https://www.npmjs.com/login", "https://pypi.org/account/login/", "https://hub.docker.com/login", "https://app.datadoghq.com/account/login", "https://sentry.io/auth/login/", "https://login.salesforce.com/", "https://app.hubspot.com/login", "https://www.zendesk.com/login/", "https://accounts.zoho.com/signin", "https://mailchimp.com/login/",
  "https://www.nytimes.com/", "https://www.theguardian.com/", "https://www.wordpress.com/log-in/", "https://www.wix.com/signin", "https://www.squarespace.com/login", "https://www.shopify.com/login", "https://www.godaddy.com/", "https://www.namecheap.com/myaccount/login/", "https://www.duolingo.com/", "https://www.coursera.org/?authMode=login", "https://www.udemy.com/join/login-popup/", "https://www.khanacademy.org/login",
  "https://www.strava.com/login", "https://www.goodreads.com/user/sign_in", "https://www.imdb.com/registration/signin", "https://www.yelp.com/login", "https://www.bbc.com/", "https://www.anthropic.com/", "https://claude.ai/login",
];

const looksBlocked = (title, text) => /just a moment|attention required|access denied|are you (a )?human|verify you are human|captcha|robot check|forbidden|not available in your/i.test(`${title} ${text.slice(0, 400)}`);

const browser = await chromium.launch({ headless: true });
const results = [];
for (const url of SITES) {
  const host = new URL(url).hostname;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await ctx.addInitScript(bundle);
  const page = await ctx.newPage();
  let row = { host, status: "error", kinds: [], password: 0, text: 0 };
  try {
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25_000 });
    await page.waitForTimeout(3500);
    const seen = await page.evaluate(() => {
      const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 2 && r.height > 2 && getComputedStyle(el).visibility !== "hidden"; };
      const inputs = [...document.querySelectorAll("input")].filter(visible);
      return {
        title: document.title.slice(0, 80),
        body: (document.body?.innerText ?? "").slice(0, 400),
        password: inputs.filter((i) => i.type === "password").length,
        text: inputs.filter((i) => ["text", "email", "tel", ""].includes(i.type)).length,
        analysis: window.__af?.analyze([], []) ?? null,
      };
    });
    const kinds = (seen.analysis?.kinds ?? []).filter((k) => k !== "none");
    let status;
    if (looksBlocked(seen.title, seen.body) || (res && res.status() >= 400)) status = "blocked";
    else if (kinds.some((k) => ["signin", "email-first", "password-next", "signup", "otp"].includes(k))) status = "found";
    else if (seen.password > 0) status = "missed";
    else if (seen.text > 0) status = "text-only";
    else status = "no-form";
    row = { host, status, kinds, password: seen.password, text: seen.text };
  } catch (e) {
    row.status = "error";
    row.error = String(e?.message ?? e).split("\n")[0].slice(0, 120);
  }
  results.push(row);
  await ctx.close();
  await new Promise((r) => setTimeout(r, 800));
}
await browser.close();

const count = (s) => results.filter((r) => r.status === s).length;
console.log(`Pages: ${results.length}. Found a form: ${count("found")}. Password box missed: ${count("missed")}. Text box only, not classified: ${count("text-only")}. No form on the page: ${count("no-form")}. Blocked: ${count("blocked")}. Errors: ${count("error")}.`);
for (const r of results.filter((x) => x.status === "missed" || x.status === "text-only")) console.log(`  ${r.status} ${r.host} kinds=${r.kinds.join(",") || "-"} password=${r.password} text=${r.text}`);
fs.mkdirSync(path.join(here, ".cache"), { recursive: true });
fs.writeFileSync(path.join(here, ".cache", "public-sites.json"), JSON.stringify(results, null, 1));
