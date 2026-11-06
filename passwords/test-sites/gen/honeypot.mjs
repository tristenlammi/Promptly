import { fx } from './kit.mjs';

const cat = 'honeypot';
const u = (selector) => ({ selector, role: 'username' });
const p = (selector) => ({ selector, role: 'password' });

fx({
  id: 'honeypot-01', category: cat, brand: 'Acme Parcel', theme: 'slate', header: 'bar', footer: 'legal',
  description: 'display:none and visibility:hidden decoys ahead of the real fields, named like the real thing (username, password); the real inputs have obscure names.',
  title: 'Sign in - Acme Parcel',
  main: `<form class="narrow box" onsubmit="return false"><h1>Sign in</h1>
  <div style="display:none"><label for="hp-user">Username</label><input id="hp-user" name="username" type="text" autocomplete="username"></div>
  <div style="visibility:hidden;height:0"><label for="hp-pass">Password</label><input id="hp-pass" name="password" type="password"></div>
  <div class="row"><label for="ap-a">Email</label><input id="ap-a" name="ap_a" type="email"></div>
  <div class="row"><label for="ap-b">Password</label><input id="ap-b" name="ap_b" type="password"></div>
  <button>Sign in</button></form>`,
  state: { username: '#ap-a', password: '#ap-b' },
  steps: [{ kind: 'signin', expected: [u('#ap-a'), p('#ap-b')], honeypots: ['#hp-user', '#hp-pass'] }],
});

fx({
  id: 'honeypot-02', category: cat, brand: 'Wrenfield Home', theme: 'sun', header: 'shop', footer: 'news',
  description: 'Off-screen decoys: position:absolute at left:-9999px with autocomplete=off and tabindex=-1, one of them a password; a classic bot trap on a store login.',
  title: 'Wrenfield account login',
  css: `.ohnohoney{position:absolute;left:-9999px;top:-9999px}`,
  main: `<form class="narrow box" onsubmit="return false"><h1>Log in</h1>
  <div class="ohnohoney"><label for="w-email2">Email</label><input id="w-email2" name="email" type="email" tabindex="-1" autocomplete="off"></div>
  <div class="row"><label for="w-e">Email</label><input id="w-e" name="login_e" type="email"></div>
  <div class="row"><label for="w-p">Password</label><input id="w-p" name="login_p" type="password"></div>
  <input class="ohnohoney" id="w-pass2" name="password" type="password" tabindex="-1" autocomplete="off">
  <button>Log in</button></form>`,
  state: { username: '#w-e', password: '#w-p' },
  steps: [{ kind: 'signin', expected: [u('#w-e'), p('#w-p')], honeypots: ['#w-email2', '#w-pass2'] }],
});

fx({
  id: 'honeypot-03', category: cat, brand: 'Ferncastle Forums', theme: 'retro', header: 'table', footer: 'table',
  description: 'Zero-size and opacity 0: inputs with width and height 0 and no border or padding, and an absolutely placed opacity:0 box that still occupies layout under the real field.',
  title: 'Forum login',
  css: `.zz{width:0;height:0;padding:0;border:0;margin:0}.ghost{opacity:0;position:absolute;pointer-events:none;width:200px}`,
  main: `<form class="narrow box" style="position:relative" onsubmit="return false"><h2>Forum login</h2>
  <input class="zz" id="hp-zero-u" name="user" type="text"><input class="zz" id="hp-zero-p" name="pass" type="password">
  <input class="ghost" id="hp-ghost" name="confirm_email" type="email">
  <div class="row"><label for="ff-n">Username</label><input id="ff-n" name="ff_n"></div>
  <div class="row"><label for="ff-s">Password</label><input id="ff-s" name="ff_s" type="password"></div>
  <input type="submit" value="Log in"></form>`,
  state: { username: '#ff-n', password: '#ff-s' },
  steps: [{ kind: 'signin', expected: [u('#ff-n'), p('#ff-s')], honeypots: ['#hp-zero-u', '#hp-zero-p', '#hp-ghost'] }],
});

fx({
  id: 'honeypot-04', category: cat, brand: 'Quillfin', theme: 'grape', header: 'navbar', footer: 'links',
  description: 'tabindex=-1 with aria-hidden=true wrappers using innocent names (website, url, company_url), plus a Leave this field blank label and a size-1 clipped box.',
  title: 'Quillfin sign in',
  css: `.vh{clip:rect(0 0 0 0);clip-path:inset(50%);height:1px;width:1px;overflow:hidden;position:absolute;white-space:nowrap}`,
  main: `<form class="narrow box" onsubmit="return false"><h1>Sign in</h1>
  <div aria-hidden="true" class="vh"><label for="hp-site">Leave this field blank</label><input id="hp-site" name="website" type="text" tabindex="-1" autocomplete="off"></div>
  <div aria-hidden="true" class="vh"><input id="hp-url" name="company_url" type="url" tabindex="-1"></div>
  <div class="vh"><input id="hp-email" name="email_address" type="email" tabindex="-1" aria-hidden="true"></div>
  <div class="row"><label for="qf-e">Email</label><input id="qf-e" name="qf_identity" type="email"></div>
  <div class="row"><label for="qf-p">Password</label><input id="qf-p" name="qf_secret" type="password"></div>
  <button>Sign in</button></form>`,
  state: { username: '#qf-e', password: '#qf-p' },
  steps: [{ kind: 'signin', expected: [u('#qf-e'), p('#qf-p')], honeypots: ['#hp-site', '#hp-url', '#hp-email'] }],
});

fx({
  id: 'honeypot-05', category: cat, brand: 'Tarnhold Cloud', theme: 'night', header: 'minimal', footer: 'newsdiv',
  description: 'Everything at once: the hidden attribute, display:none, off-screen transform, opacity 0, zero height with overflow hidden, and type=hidden. Decoys come both before and after the real pair and are revealed only by computed style.',
  title: 'Tarnhold sign-in',
  css: `.nope-a{transform:translateX(-200vw);position:absolute}.nope-b{opacity:0;height:1px;width:1px;position:absolute}.nope-c{height:0;overflow:hidden}.nope-d{display:none}`,
  main: `<form class="narrow box" onsubmit="return false"><h1>Sign in</h1>
  <input id="d1" name="login" type="text" hidden>
  <input id="d2" name="password" type="password" class="nope-d">
  <input id="d3" name="user_login" type="text" class="nope-a" tabindex="-1">
  <div class="row"><label for="th-a">Account</label><input id="th-a" name="a1"></div>
  <div class="nope-c"><label for="d4">Password</label><input id="d4" name="user_pass" type="password"></div>
  <div class="row"><label for="th-b">Password</label><input id="th-b" name="a2" type="password"></div>
  <input id="d5" name="pass_confirm" type="password" class="nope-b" tabindex="-1">
  <input id="d6" name="email" type="hidden">
  <button>Sign in</button></form>`,
  state: { username: '#th-a', password: '#th-b' },
  steps: [{ kind: 'signin', expected: [u('#th-a'), p('#th-b')], honeypots: ['#d1', '#d2', '#d3', '#d4', '#d5', '#d6'] }],
});
