// Sign-in inside iframes and shadow roots, and pages rendered late by a script framework.
import { doc, fxLive, step, x } from './kit.mjs';

const frameFx = (map) => fxLive(map);

export default [
  // ---------------------------------------------------------------- iframes
  {
    id: 'h4-iframe-01',
    category: 'iframe',
    description: 'Community site that embeds its log-in form from a same-origin page in an iframe beside the topic list; the site search is in the outer page.',
    steps: [step('signin', [x('#username', 'username', ['#login-frame']), x('#password', 'password', ['#login-frame'])], ['#site-search'], { wait: 'iframe#login-frame[data-loaded]' })],
    html: doc({
      title: 'Bramble Forums',
      css: `
body{margin:0;font:14px Arial,sans-serif;background:#f3efe6}
header{background:#3f5e3a;color:#fff;padding:12px 24px;display:flex;justify-content:space-between}
.layout{display:grid;grid-template-columns:1fr 320px;gap:20px;padding:20px}
.topic{background:#fff;padding:10px;margin-bottom:8px;border-left:4px solid #8ba888}
iframe{width:100%;height:280px;border:1px solid #ccc;background:#fff}`,
      body: `
<header><b>Bramble Forums</b><input type="search" id="site-search" placeholder="Search topics"></header>
<div class="layout">
  <div>
    <div class="topic">Overwintering dahlias in clay soil</div>
    <div class="topic">Best mulch for a new raspberry bed?</div>
    <div class="topic">Show us your compost bays</div>
  </div>
  <aside>
    <iframe id="login-frame" title="Sign in" src="_frames/h4-iframe-01-login.html" onload="this.setAttribute('data-loaded','')"></iframe>
  </aside>
</div>`,
      js: `
window.__fixture = { state: function () {
  try { return document.getElementById('login-frame').contentWindow.__fixture.state(); } catch (e) { return {}; }
} };`,
    }),
    files: {
      '_frames/h4-iframe-01-login.html': doc({
        title: 'Sign in',
        css: `body{margin:0;padding:16px;font:14px Arial,sans-serif}label{display:block;margin-top:10px}input[type=text],input[type=password]{width:100%;box-sizing:border-box;padding:7px}button{margin-top:12px}`,
        body: `
<h3 style="margin:0">Members sign in</h3>
<form action="#" onsubmit="return false">
  <label for="username">Username</label><input id="username" name="username" type="text" autocomplete="username">
  <label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password">
  <label><input type="checkbox" name="autologin"> Log me on automatically</label>
  <button type="submit">Sign in</button> <a href="#">Register</a>
</form>`,
        js: frameFx({ username: '#username', password: '#password' }),
      }),
    },
  },

  {
    id: 'h4-iframe-02',
    category: 'iframe',
    description: 'Help centre embedding a "customer log-in" widget served from a different origin; the widget reports edits to the host page with postMessage.',
    steps: [step('signin', [x('input[name="email"]', 'username', ['#support-widget']), x('input[name="password"]', 'password', ['#support-widget'])], ['#kb-search'], { wait: 'iframe#support-widget[data-loaded]' })],
    html: doc({
      title: 'Cobalt Support – Help Centre',
      css: `
body{margin:0;font:15px "Open Sans",Arial,sans-serif;background:#f5f7fb}
.hero{background:#1e3a8a;color:#fff;padding:40px;text-align:center}
.hero input{width:60%;padding:12px;border-radius:6px;border:0;font-size:16px}
.grid{display:grid;grid-template-columns:2fr 1fr;gap:24px;padding:30px 40px}
iframe{width:100%;height:300px;border:0;border-radius:8px;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.15)}`,
      body: `
<div class="hero"><h1>How can we help?</h1><input type="search" id="kb-search" placeholder="Search articles"></div>
<div class="grid">
  <div><h2>Popular articles</h2><ul><li>Changing your billing date</li><li>Exporting invoices</li><li>Adding a team member</li></ul></div>
  <div><h3>Customers: log in for faster help</h3><iframe id="support-widget" title="Customer log-in"></iframe></div>
</div>`,
      js: `
var relayed = {};
window.addEventListener('message', function (e) {
  if (e.data && e.data.type === 'cobalt-widget-state') relayed = e.data.state;
});
var other = location.hostname === '127.0.0.1' ? 'localhost' : '127.0.0.1';
var w = document.getElementById('support-widget');
w.addEventListener('load', function () { w.setAttribute('data-loaded', ''); });
w.src = location.protocol + '//' + other + ':' + location.port + '/fixtures/_frames/h4-iframe-02-widget.html';
window.__fixture = { state: function () { return Object.assign({}, relayed); } };`,
    }),
    files: {
      '_frames/h4-iframe-02-widget.html': doc({
        title: 'Customer log-in',
        css: `body{margin:0;padding:18px;font:14px Arial,sans-serif;background:#fff}input{display:block;width:100%;box-sizing:border-box;padding:9px;margin:4px 0 12px;border:1px solid #b6c2d9;border-radius:5px}button{background:#1e3a8a;color:#fff;border:0;padding:9px 18px;border-radius:5px}`,
        body: `
<form id="w" action="#" onsubmit="return false">
  <label>Email<input name="email" type="email" autocomplete="email"></label>
  <label>Password<input name="password" type="password" autocomplete="current-password"></label>
  <button type="submit">Log in</button>
</form>`,
        js: `
function snapshot() {
  return { username: document.querySelector('input[name="email"]').value, password: document.querySelector('input[name="password"]').value };
}
document.getElementById('w').addEventListener('input', function () {
  parent.postMessage({ type: 'cobalt-widget-state', state: snapshot() }, '*');
});
window.__fixture = { state: snapshot };`,
      }),
    },
  },

  {
    id: 'h4-iframe-03',
    category: 'iframe',
    description: 'Learning platform that inserts a srcdoc iframe with the sign-in form about a second after load, built from a template element.',
    steps: [step('signin', [x('#lp-user', 'username', ['#late-auth']), x('#lp-pass', 'password', ['#late-auth'])], [], { wait: 'iframe#late-auth[data-loaded]' })],
    html: doc({
      title: 'Lanternpath Learning',
      css: `
body{margin:0;font:15px Calibri,sans-serif;background:#fdfcfa}
.nav{padding:14px 30px;border-bottom:1px solid #eee;font-weight:bold;color:#c2410c}
#slot{width:380px;margin:40px auto;min-height:300px}
#slot .loading{color:#999;text-align:center;padding-top:100px}
iframe{width:100%;height:300px;border:1px solid #eee;border-radius:10px}`,
      body: `
<div class="nav">Lanternpath</div>
<div id="slot"><div class="loading">Loading sign-in…</div></div>
<template id="auth-tpl">
<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"><style>body{font:15px Calibri,sans-serif;padding:20px}input{display:block;width:100%;box-sizing:border-box;padding:9px;margin:6px 0 14px}</style></head>
<body>
<h2>Welcome back, learner</h2>
<form action="#" onsubmit="return false">
<label for="lp-user">Learner ID or email</label><input id="lp-user" name="learner" type="text" autocomplete="username">
<label for="lp-pass">Password</label><input id="lp-pass" name="pwd" type="password" autocomplete="current-password">
<button type="submit">Start learning</button>
</form>
<script>window.__fixture = { state: function () { return { username: document.getElementById('lp-user').value, password: document.getElementById('lp-pass').value }; } };</script>
</body></html>
</template>`,
      js: `
setTimeout(function () {
  var slot = document.getElementById('slot');
  var f = document.createElement('iframe');
  f.id = 'late-auth';
  f.title = 'Sign in';
  f.addEventListener('load', function () { f.setAttribute('data-loaded', ''); });
  f.srcdoc = document.getElementById('auth-tpl').innerHTML;
  slot.innerHTML = '';
  slot.appendChild(f);
}, 900);
window.__fixture = { state: function () {
  var f = document.getElementById('late-auth');
  try { return f.contentWindow.__fixture.state(); } catch (e) { return {}; }
} };`,
    }),
  },

  // ---------------------------------------------------------------- shadow DOM
  {
    id: 'h4-shadow-01',
    category: 'shadow',
    description: 'A single custom element with an open shadow root holding its own form, labels and inputs.',
    steps: [step('signin', [x(['tern-login', '#user'], 'username'), x(['tern-login', '#pass'], 'password')], [], { wait: 'tern-login[data-ready]' })],
    html: doc({
      title: 'Tern Dispatch – Driver portal',
      css: `body{margin:0;font:15px sans-serif;background:#eef1f4}header{background:#0e7490;color:#fff;padding:14px 28px}tern-login{display:block;width:360px;margin:60px auto}`,
      body: `<header>Tern Dispatch</header>
<tern-login></tern-login>`,
      js: `
customElements.define('tern-login', class extends HTMLElement {
  connectedCallback() {
    var root = this.attachShadow({ mode: 'open' });
    root.innerHTML = '<style>.c{background:#fff;padding:26px;border-radius:8px}label{display:block;font-size:13px;margin:12px 0 4px}input{width:100%;box-sizing:border-box;padding:9px;border:1px solid #9bb}button{margin-top:16px;width:100%;padding:10px;background:#0e7490;color:#fff;border:0}</style>' +
      '<div class="c"><h2>Driver sign in</h2><form><label for="user">Driver code or email</label><input id="user" name="user" autocomplete="username">' +
      '<label for="pass">Password</label><input id="pass" name="pass" type="password" autocomplete="current-password"><button type="submit">Sign in</button></form></div>';
    root.querySelector('form').addEventListener('submit', function (e) { e.preventDefault(); });
    this.setAttribute('data-ready', '');
  }
});
window.__fixture = { state: function () {
  var r = document.querySelector('tern-login').shadowRoot;
  return { username: r.getElementById('user').value, password: r.getElementById('pass').value };
} };`,
    }),
  },

  {
    id: 'h4-shadow-02',
    category: 'shadow',
    description: 'Design-system components three shadow roots deep: an app shell, an auth card, and a text-field component wrapping each native input.',
    steps: [step('signin', [x(['app-shell', 'auth-card', 'text-field[name="email"]', 'input'], 'username'), x(['app-shell', 'auth-card', 'text-field[name="password"]', 'input'], 'password')], [], { wait: 'app-shell[data-ready]' })],
    html: doc({
      title: 'Brindle Studio',
      css: `body{margin:0;background:#18181b;font:14px "Atkinson Hyperlegible",sans-serif;color:#f4f4f5}`,
      body: `<app-shell></app-shell>`,
      js: `
customElements.define('text-field', class extends HTMLElement {
  connectedCallback() {
    var r = this.attachShadow({ mode: 'open' });
    var type = this.getAttribute('type') || 'text';
    r.innerHTML = '<style>:host{display:block;margin-bottom:16px}label{display:block;font-size:12px;color:#a1a1aa;margin-bottom:4px}input{width:100%;box-sizing:border-box;padding:10px;background:#27272a;color:#fff;border:1px solid #3f3f46;border-radius:6px}</style>' +
      '<label part="label" for="control"></label><input id="control" part="input">';
    r.querySelector('label').textContent = this.getAttribute('label');
    var input = r.querySelector('input');
    input.type = type;
    input.name = this.getAttribute('name');
    if (this.getAttribute('autocomplete')) input.autocomplete = this.getAttribute('autocomplete');
  }
  get value() { return this.shadowRoot.querySelector('input').value; }
});
customElements.define('auth-card', class extends HTMLElement {
  connectedCallback() {
    var r = this.attachShadow({ mode: 'open' });
    r.innerHTML = '<style>.card{width:360px;margin:80px auto;padding:28px;background:#09090b;border:1px solid #27272a;border-radius:12px}button{width:100%;padding:10px;border:0;border-radius:6px;background:#f97316;color:#000;font-weight:600}</style>' +
      '<div class="card"><h2>Sign in to Brindle</h2>' +
      '<text-field name="email" label="Email" type="email" autocomplete="username"></text-field>' +
      '<text-field name="password" label="Password" type="password" autocomplete="current-password"></text-field>' +
      '<button type="button">Continue</button></div>';
  }
});
customElements.define('app-shell', class extends HTMLElement {
  connectedCallback() {
    var r = this.attachShadow({ mode: 'open' });
    r.innerHTML = '<style>nav{padding:14px 24px;border-bottom:1px solid #27272a}</style><nav>Brindle Studio</nav><auth-card></auth-card>';
    this.setAttribute('data-ready', '');
  }
});
window.__fixture = { state: function () {
  var card = document.querySelector('app-shell').shadowRoot.querySelector('auth-card').shadowRoot;
  return { username: card.querySelector('text-field[name="email"]').value, password: card.querySelector('text-field[name="password"]').value };
} };`,
    }),
  },

  {
    id: 'h4-shadow-03',
    category: 'shadow',
    description: 'Layout component with a shadow root whose named slot shows light-DOM inputs; the inputs themselves are ordinary document nodes.',
    steps: [step('signin', [x('#si-email', 'username'), x('#si-pass', 'password')], [], { wait: 'signin-layout[data-ready]' })],
    html: doc({
      title: 'Copperleaf Invoicing',
      css: `body{margin:0;background:#fefce8;font:15px Lato,sans-serif}.f{display:block;margin-bottom:14px}.f input{display:block;width:100%;box-sizing:border-box;padding:9px;margin-top:4px;border:1px solid #d6c27a}`,
      body: `
<signin-layout>
  <span slot="title">Sign in to Copperleaf</span>
  <form slot="fields" action="#" onsubmit="return false">
    <label class="f">Email<input id="si-email" type="email" name="email" autocomplete="username"></label>
    <label class="f">Password<input id="si-pass" type="password" name="password" autocomplete="current-password"></label>
    <button type="submit">Sign in</button>
  </form>
  <a slot="footer" href="#">Start a free trial</a>
</signin-layout>`,
      js: `
customElements.define('signin-layout', class extends HTMLElement {
  connectedCallback() {
    var r = this.attachShadow({ mode: 'open' });
    r.innerHTML = '<style>.wrap{width:380px;margin:70px auto;background:#fff;border-radius:10px;padding:28px;box-shadow:0 4px 18px rgba(120,90,0,.15)}h1{font-size:22px;color:#a16207}footer{margin-top:16px;font-size:13px}</style>' +
      '<div class="wrap"><h1><slot name="title"></slot></h1><slot name="fields"></slot><footer><slot name="footer"></slot></footer></div>';
    this.setAttribute('data-ready', '');
  }
});
${fxLive({ username: '#si-email', password: '#si-pass' })}`,
    }),
  },

  // ---------------------------------------------------------------- framework-rendered
  {
    id: 'h4-framework-01',
    category: 'framework',
    description: 'React-style app that fetches its config JSON, then mounts a controlled form; inputs carry only data-testid and name, and values live in component state.',
    steps: [step('signin', [x('input[data-testid="login-email"]', 'username'), x('input[data-testid="login-password"]', 'password')], [], { wait: '#root form[data-mounted]' })],
    html: doc({
      title: 'Parcelpine',
      css: `
body{margin:0;font:15px system-ui,sans-serif;background:#f8fafc}
#root{min-height:100vh;display:grid;place-items:center}
.sk{width:360px;height:260px;border-radius:12px;background:#e2e8f0}
form{width:360px;background:#fff;padding:28px;border-radius:12px;border:1px solid #e2e8f0}
.fld{display:flex;flex-direction:column;gap:6px;margin-bottom:16px;font-size:14px}
.fld input{padding:10px;border:1px solid #cbd5e1;border-radius:8px}
button{width:100%;padding:11px;background:#16a34a;color:#fff;border:0;border-radius:8px}`,
      body: `<div id="root"><div class="sk" aria-busy="true"></div></div>`,
      js: `
var appState = { email: '', password: '' };
function field(label, name, type, key, testid, ac) {
  var wrap = document.createElement('div'); wrap.className = 'fld';
  var span = document.createElement('span'); span.textContent = label;
  var input = document.createElement('input');
  input.type = type; input.name = name; input.setAttribute('data-testid', testid); input.autocomplete = ac;
  input.addEventListener('input', function (e) { appState[key] = e.target.value; render(); });
  wrap.appendChild(span); wrap.appendChild(input);
  return wrap;
}
function render() {
  document.querySelectorAll('#root input[data-key]').forEach(function (el) {
    var v = appState[el.getAttribute('data-key')];
    if (el.value !== v) el.value = v;
  });
}
function mount(cfg) {
  var form = document.createElement('form');
  form.innerHTML = '<h2></h2>';
  form.querySelector('h2').textContent = cfg.heading;
  var e = field(cfg.emailLabel, 'email', 'email', 'email', 'login-email', 'username');
  var p = field(cfg.passwordLabel, 'password', 'password', 'password', 'login-password', 'current-password');
  e.querySelector('input').setAttribute('data-key', 'email');
  p.querySelector('input').setAttribute('data-key', 'password');
  form.appendChild(e); form.appendChild(p);
  var b = document.createElement('button'); b.type = 'submit'; b.textContent = cfg.submit; form.appendChild(b);
  form.addEventListener('submit', function (ev) { ev.preventDefault(); });
  var root = document.getElementById('root');
  root.innerHTML = '';
  root.appendChild(form);
  form.setAttribute('data-mounted', '');
}
fetch('_data/h4-framework-01.json').then(function (r) { return r.json(); }).then(function (cfg) { setTimeout(function () { mount(cfg); }, 300); });
window.__fixture = { state: function () { return { username: appState.email, password: appState.password }; } };`,
    }),
    files: {
      '_data/h4-framework-01.json': JSON.stringify({ heading: 'Track your deliveries', emailLabel: 'Email', passwordLabel: 'Password', submit: 'Log in' }, null, 2) + '\n',
    },
  },

  {
    id: 'h4-framework-02',
    category: 'framework',
    description: 'Vue-style single-page app: the home view has a "Sign in" link to a hash route, which renders a login view whose inputs are bound to a reactive model on input events.',
    steps: [
      step('none', [], [], { advance: { click: '#nav-login' } }),
      step('signin', [x('.login-view input[data-v-3c1a]:not([type="password"])', 'username'), x('.login-view input[type="password"]', 'password')], [], { wait: '#app .login-view' }),
    ],
    html: doc({
      title: 'Fieldnote Surveys',
      css: `
body{margin:0;font:15px "Nunito",sans-serif;background:#f0fdf4}
nav{display:flex;gap:18px;padding:14px 26px;background:#14532d}nav a{color:#dcfce7;text-decoration:none}
.hero{padding:60px;text-align:center}
.login-view{width:360px;margin:50px auto;background:#fff;padding:26px;border-radius:12px}
.login-view label{display:block;margin:12px 0 4px;font-size:13px}
.login-view input{width:100%;box-sizing:border-box;padding:9px;border:1px solid #86efac;border-radius:8px}`,
      body: `
<div id="app">
  <nav><a href="#/">Fieldnote</a><a href="#/pricing">Pricing</a><a href="#/login" id="nav-login">Sign in</a></nav>
  <main id="view"></main>
</div>`,
      js: `
if (location.hash) history.replaceState(null, '', location.pathname);
var model = { login: '', password: '' };
function home() {
  return '<section class="hero" data-v-3c1a><h1 data-v-3c1a>Surveys your field teams will actually fill in</h1><p data-v-3c1a>Offline forms, photo capture and GPS stamps.</p></section>';
}
function login() {
  return '<section class="login-view" data-v-3c1a><h2 data-v-3c1a>Sign in</h2><form data-v-3c1a>' +
    '<label data-v-3c1a>Login</label><input data-v-3c1a data-model="login" type="text" autocomplete="username">' +
    '<label data-v-3c1a>Password</label><input data-v-3c1a data-model="password" type="password" autocomplete="current-password">' +
    '<button data-v-3c1a type="submit">Sign in</button></form></section>';
}
function route() {
  var view = document.getElementById('view');
  view.innerHTML = location.hash === '#/login' ? login() : home();
  view.querySelectorAll('[data-model]').forEach(function (el) {
    var key = el.getAttribute('data-model');
    el.value = model[key];
    el.addEventListener('input', function () { model[key] = el.value; });
  });
  var f = view.querySelector('form');
  if (f) f.addEventListener('submit', function (e) { e.preventDefault(); });
}
window.addEventListener('hashchange', route);
route();
window.__fixture = { state: function () { return { username: model.login, password: model.password }; } };`,
    }),
  },

  {
    id: 'h4-framework-03',
    category: 'framework',
    description: 'Controlled form that mounts after a skeleton and re-renders four times a second for a "last synced" clock, writing the model back into each input on every render.',
    steps: [step('signin', [x('input[name="email"]', 'username'), x('input[name="password"]', 'password')], [], { wait: 'form.hyperion-login' })],
    html: doc({
      title: 'Hyperion Learning – Staff',
      css: `
body{margin:0;font:15px "Source Sans Pro",sans-serif;background:#1e1b4b;color:#e0e7ff}
#mount{width:360px;margin:80px auto}
.sk{height:240px;border-radius:10px;background:#312e81}
form{background:#312e81;padding:26px;border-radius:10px}
input{display:block;width:100%;box-sizing:border-box;padding:10px;margin:6px 0 14px;border-radius:6px;border:0}
.clock{font-size:12px;color:#a5b4fc}`,
      body: `<div id="mount"><div class="sk"></div></div>`,
      js: `
var st = { email: '', password: '', tick: 0 };
function render() {
  var f = document.querySelector('form.hyperion-login');
  if (!f) return;
  f.querySelector('input[name="email"]').value = st.email;
  f.querySelector('input[name="password"]').value = st.password;
  f.querySelector('.clock').textContent = 'Last synced ' + st.tick + 's ago';
}
setTimeout(function () {
  var m = document.getElementById('mount');
  m.innerHTML = '<form class="hyperion-login" novalidate><h2>Staff sign in</h2>' +
    '<label>Work email<input name="email" type="email" autocomplete="username"></label>' +
    '<label>Password<input name="password" type="password" autocomplete="current-password"></label>' +
    '<button type="submit">Sign in</button><p class="clock"></p></form>';
  var f = m.querySelector('form');
  f.addEventListener('submit', function (e) { e.preventDefault(); });
  ['email', 'password'].forEach(function (k) {
    f.querySelector('input[name="' + k + '"]').addEventListener('input', function (e) { st[k] = e.target.value; });
  });
  render();
  setInterval(function () { st.tick++; render(); }, 250);
}, 700);
window.__fixture = { state: function () { return { username: st.email, password: st.password }; } };`,
    }),
  },

  {
    id: 'h4-framework-04',
    category: 'framework',
    description: 'Angular-style reactive form bootstrapped into app-root after half a second: formcontrolname attributes, ng-* state classes, labels inside mat-style wrappers.',
    steps: [step('signin', [x('input[formcontrolname="userName"]', 'username'), x('input[formcontrolname="passWord"]', 'password')], [], { wait: 'app-root app-login form' })],
    html: doc({
      title: 'Quayside Ops',
      css: `
body{margin:0;font:14px Roboto,sans-serif;background:#eceff1}
app-root{display:block}app-login{display:block;width:380px;margin:80px auto;background:#fff;padding:24px;box-shadow:0 2px 4px rgba(0,0,0,.2)}
.mat-form-field{display:block;margin-bottom:18px}.mat-form-field-label{display:block;font-size:12px;color:#607d8b}
.mat-input-element{width:100%;border:0;border-bottom:1px solid #90a4ae;padding:6px 0;font-size:15px;outline:none}
.ng-touched.ng-invalid{border-bottom-color:#d32f2f}`,
      body: `<app-root ng-version="17.3.0"></app-root>`,
      js: `
var form = { userName: '', passWord: '' };
setTimeout(function () {
  var root = document.querySelector('app-root');
  root.innerHTML = '<app-login _nghost-ng-c41><h2 _ngcontent-ng-c41>Quayside Ops</h2>' +
    '<form _ngcontent-ng-c41 novalidate class="ng-untouched ng-pristine ng-invalid">' +
    '<div class="mat-form-field"><span class="mat-form-field-label">User name</span><input _ngcontent-ng-c41 matinput class="mat-input-element ng-untouched ng-pristine ng-invalid" formcontrolname="userName" type="text"></div>' +
    '<div class="mat-form-field"><span class="mat-form-field-label">Password</span><input _ngcontent-ng-c41 matinput class="mat-input-element ng-untouched ng-pristine ng-invalid" formcontrolname="passWord" type="password"></div>' +
    '<button _ngcontent-ng-c41 type="submit" disabled>Log in</button></form></app-login>';
  var f = root.querySelector('form');
  f.addEventListener('submit', function (e) { e.preventDefault(); });
  f.querySelectorAll('input[formcontrolname]').forEach(function (el) {
    var key = el.getAttribute('formcontrolname');
    el.addEventListener('input', function () {
      form[key] = el.value;
      el.classList.remove('ng-pristine'); el.classList.add('ng-dirty');
      el.classList.toggle('ng-valid', !!el.value); el.classList.toggle('ng-invalid', !el.value);
      f.querySelector('button').disabled = !(form.userName && form.passWord);
    });
    el.addEventListener('blur', function () { el.classList.remove('ng-untouched'); el.classList.add('ng-touched'); });
  });
}, 500);
window.__fixture = { state: function () { return { username: form.userName, password: form.passWord }; } };`,
    }),
  },
];
