// Shared bits for the fixture generator: site chrome (headers, footers, marketing
// noise), page assembly, and the small inline scripts fixtures reuse. The form
// markup itself lives in the category modules and is written per fixture.

export const registry = [];

/** Register one fixture. See build.mjs for how the definition is turned into files. */
export function fx(def) {
  registry.push(def);
}

// ---------------------------------------------------------------- themes

const THEMES = {
  paper: { bg: '#faf7f2', fg: '#26221c', soft: '#6f675b', line: '#dcd4c6', accent: '#b4532a', card: '#ffffff', font: 'Georgia, "Times New Roman", serif' },
  slate: { bg: '#eef1f5', fg: '#1b2430', soft: '#5a6778', line: '#cfd6df', accent: '#2c5fb3', card: '#ffffff', font: 'system-ui, "Segoe UI", Roboto, sans-serif' },
  forest: { bg: '#f1f5ef', fg: '#1d2a1f', soft: '#58695b', line: '#cdd9cc', accent: '#2f7a4a', card: '#fcfefb', font: 'Verdana, Geneva, sans-serif' },
  night: { bg: '#14171f', fg: '#e6e8ee', soft: '#9aa2b2', line: '#2c3240', accent: '#7c9cff', card: '#1c2029', font: 'system-ui, "Segoe UI", sans-serif' },
  sun: { bg: '#fff8e8', fg: '#2e2410', soft: '#7a6a44', line: '#ecdcb4', accent: '#c97a06', card: '#fffdf7', font: 'Trebuchet MS, Helvetica, sans-serif' },
  corp: { bg: '#ffffff', fg: '#222222', soft: '#666666', line: '#d8d8d8', accent: '#00587a', card: '#f7f9fa', font: 'Arial, Helvetica, sans-serif' },
  retro: { bg: '#e8e8e0', fg: '#000000', soft: '#444444', line: '#999999', accent: '#000080', card: '#f4f4ee', font: 'Tahoma, Verdana, Arial, sans-serif' },
  grape: { bg: '#f6f2fb', fg: '#241a33', soft: '#6a5c80', line: '#dcd2ea', accent: '#6b3fb5', card: '#ffffff', font: 'system-ui, Helvetica, Arial, sans-serif' },
};

function themeCss(name) {
  const t = THEMES[name] || THEMES.slate;
  return `:root{--bg:${t.bg};--fg:${t.fg};--soft:${t.soft};--line:${t.line};--accent:${t.accent};--card:${t.card}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 ${t.font}}
a{color:var(--accent)}
h1,h2,h3{line-height:1.25;margin:.2em 0 .5em}
input,select,textarea{font:inherit;color:inherit;background:var(--card);border:1px solid var(--line);border-radius:4px;padding:.45em .6em;max-width:100%}
button,input[type=submit],input[type=button]{font:inherit;cursor:pointer;background:var(--accent);color:#fff;border:0;border-radius:4px;padding:.5em 1em}
button[disabled],input[disabled]{opacity:.5;cursor:not-allowed}
.wrap{max-width:1040px;margin:0 auto;padding:24px 16px}
.box{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:24px}
.narrow{max-width:420px;margin:0 auto}
.row{margin:0 0 14px}
.row label,.lbl{display:block;font-weight:600;margin-bottom:4px}
.row input:not([type=checkbox]):not([type=radio]){width:100%}
.split{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:32px}
@media(max-width:720px){.split{grid-template-columns:minmax(0,1fr)}}
.muted{color:var(--soft);font-size:.9em}
.linkbtn{background:none;color:var(--accent);padding:0;text-decoration:underline}
`;
}

// ---------------------------------------------------------------- headers

const NAV = ['Products', 'Pricing', 'Resources', 'Support', 'Company', 'Stories', 'Docs', 'Community'];
const navLinks = (start = 0, n = 4) =>
  Array.from({ length: n }, (_, i) => NAV[(start + i) % NAV.length]);

export const HEADERS = {
  none: { html: () => '', css: '', decoys: [] },
  bar: {
    css: `.site-header{display:flex;gap:18px;align-items:center;padding:12px 24px;border-bottom:1px solid var(--line);background:var(--card);flex-wrap:wrap}.site-header nav a{margin-right:14px;text-decoration:none}.site-header form{margin-left:auto;display:flex;gap:6px}.site-logo{font-weight:700;font-size:1.15em;text-decoration:none}`,
    html: (b) => `<header class="site-header">
  <a class="site-logo" href="#home">${b}</a>
  <nav aria-label="Main">${navLinks(0).map((n) => `<a href="#${n.toLowerCase()}">${n}</a>`).join('')}</nav>
  <form role="search" action="#search" onsubmit="return false"><input type="search" name="q" id="site-search" placeholder="Search" aria-label="Search this site"><button type="submit">Go</button></form>
</header>`,
    decoys: ['#site-search'],
  },
  nameless: {
    css: `.topnav{display:flex;align-items:center;gap:20px;background:var(--accent);color:#fff;padding:10px 20px;flex-wrap:wrap}.topnav a{color:#fff;text-decoration:none}.topnav__brand{font-weight:700}.topnav__search{margin-left:auto}.topnav__input{border:0;width:220px;color:#222;background:#fff}`,
    html: (b) => `<div class="topnav">
  <a class="topnav__brand" href="#">${b}</a>
  ${navLinks(3).map((n) => `<a class="topnav__link" href="#">${n}</a>`).join('\n  ')}
  <div class="topnav__search"><input id="hdr-query" class="topnav__input" type="text" placeholder="Search the help center" aria-label="Search"></div>
</div>`,
    decoys: ['#hdr-query'],
  },
  navbar: {
    css: `.navbar{display:flex;justify-content:space-between;padding:14px 28px;border-bottom:2px solid var(--line);flex-wrap:wrap;gap:10px}.navbar ul{list-style:none;display:flex;gap:18px;margin:0;padding:0;flex-wrap:wrap}.navbar .cta{background:var(--accent);color:#fff;padding:.3em .8em;border-radius:99px;text-decoration:none}`,
    html: (b) => `<nav class="navbar navbar-expand-lg">
  <a class="navbar-brand" href="#"><strong>${b}</strong></a>
  <ul class="navbar-nav">${navLinks(1, 3).map((n) => `<li class="nav-item"><a class="nav-link" href="#">${n}</a></li>`).join('')}<li class="nav-item"><a class="nav-link" href="#signin">Sign in</a></li><li class="nav-item"><a class="cta" href="#signup">Get started</a></li></ul>
</nav>`,
    decoys: [],
  },
  table: {
    css: `.masthead{width:100%;background:var(--accent);color:#fff;border-collapse:collapse}.masthead td{padding:6px 12px}.masthead a{color:#fff}.masthead input[name=s]{color:#000;background:#fff;width:120px}`,
    html: (b) => `<table class="masthead" width="100%" cellspacing="0" cellpadding="0"><tr>
  <td><font size="+1"><b>${b}</b></font></td>
  <td align="center"><a href="#">Home</a> | <a href="#">Services</a> | <a href="#">Contact us</a></td>
  <td align="right"><form name="sf" action="#find" onsubmit="return false"><input name="s" size="14"> <input type="submit" value="Find"></form></td>
</tr></table>`,
    decoys: ['form[name="sf"] input[name="s"]'],
  },
  minimal: {
    css: `.bare-logo{padding:28px 0 0;text-align:center;font-size:1.5em;font-weight:700;letter-spacing:.02em}`,
    html: (b) => `<div class="bare-logo">${b}</div>`,
    decoys: [],
  },
  utility: {
    css: `.util-strip{background:var(--fg);color:var(--bg);font-size:.8em;padding:4px 24px;display:flex;justify-content:flex-end;gap:14px;flex-wrap:wrap}.util-strip a{color:inherit}.brandbar{display:flex;align-items:center;gap:22px;padding:14px 24px;flex-wrap:wrap}.brandbar b{font-size:1.3em}.brandbar input{flex:1;min-width:180px}`,
    html: (b) => `<div class="util-strip"><a href="#">Help</a><a href="#">Find a branch</a><a href="#">Careers</a><a href="#">Log in</a></div>
<header class="brandbar"><b>${b}</b><input name="keywords" type="text" placeholder="What are you looking for?" aria-label="What are you looking for?"></header>`,
    decoys: ['input[name="keywords"]'],
  },
  shop: {
    css: `.shopbar{display:flex;gap:16px;align-items:center;padding:12px 20px;background:var(--card);border-bottom:3px solid var(--accent);flex-wrap:wrap}.shopbar form{display:flex;flex:1;min-width:200px}.shopbar form input{flex:1;min-width:80px}.shopbar a{white-space:nowrap}`,
    html: (b) => `<div class="shopbar"><strong>${b}</strong>
  <form onsubmit="return false" class="shop-search"><select name="dept" aria-label="Department"><option>All</option><option>Outdoors</option><option>Kitchen</option></select><input type="text" name="k" id="shop-k" placeholder="Search products"><button aria-label="Search">Search</button></form>
  <a href="#account">Account</a><a href="#orders">Orders</a><a href="#cart">Cart (0)</a></div>`,
    decoys: ['#shop-k'],
  },
};

// ---------------------------------------------------------------- footers

export const FOOTERS = {
  none: { html: () => '', css: '', decoys: [] },
  news: {
    css: `.foot{margin-top:40px;padding:28px 24px;background:var(--card);border-top:1px solid var(--line)}.foot .newsletter{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.foot .newsletter label{font-weight:600;width:100%}.foot .newsletter input{flex:1;min-width:160px;max-width:320px}`,
    html: (b) => `<footer class="foot"><form class="newsletter" action="#subscribe" onsubmit="return false">
  <label for="nl-email">Get the ${b} newsletter</label>
  <input type="email" id="nl-email" name="email" placeholder="you@example.test" autocomplete="email"><button type="submit">Subscribe</button>
</form><p class="muted">&copy; 2026 ${b}. Unsubscribe at any time.</p></footer>`,
    decoys: ['#nl-email'],
  },
  newsdiv: {
    css: `.footer__signup{margin-top:48px;padding:24px;background:var(--fg);color:var(--bg)}.footer__signup input{color:#222;background:#fff;margin-right:6px}.footer__signup span{display:block;margin-bottom:8px}`,
    html: (b) => `<div class="footer__signup"><span>Deals and updates from ${b}, straight to your inbox.</span><input id="footer-email" type="text" name="EMAIL" placeholder="Email address"><button type="button">Sign me up</button><p class="muted">No spam. Privacy policy applies.</p></div>`,
    decoys: ['#footer-email'],
  },
  links: {
    css: `.foot-cols{display:flex;flex-wrap:wrap;gap:40px;margin-top:40px;padding:28px 32px;border-top:1px solid var(--line);font-size:.9em}.foot-cols h4{margin:0 0 6px}.foot-cols ul{list-style:none;padding:0;margin:0}`,
    html: (b) => `<footer class="foot-cols"><div><h4>Product</h4><ul><li><a href="#">Overview</a></li><li><a href="#">Security</a></li><li><a href="#">Changelog</a></li></ul></div><div><h4>Company</h4><ul><li><a href="#">About ${b}</a></li><li><a href="#">Press</a></li><li><a href="#">Careers</a></li></ul></div><div><h4>Legal</h4><ul><li><a href="#">Terms</a></li><li><a href="#">Privacy</a></li><li><a href="#">Cookies</a></li></ul></div></footer>`,
    decoys: [],
  },
  legal: {
    css: `.legal-line{text-align:center;padding:30px 12px;font-size:.8em;color:var(--soft)}`,
    html: (b) => `<div class="legal-line">&copy; 2026 ${b}, all rights reserved &middot; <a href="#">Privacy</a> &middot; <a href="#">Terms</a> &middot; <a href="#">Accessibility</a></div>`,
    decoys: [],
  },
  lang: {
    css: `.lang-foot{display:flex;justify-content:space-between;padding:16px 28px;font-size:.85em;color:var(--soft);flex-wrap:wrap;gap:10px}`,
    html: (b) => `<div class="lang-foot"><select aria-label="Language" name="hl"><option>English (United States)</option><option>English (United Kingdom)</option><option>Espa&ntilde;ol</option></select><span><a href="#">Help</a> &nbsp; <a href="#">Privacy</a> &nbsp; <a href="#">Terms</a> &nbsp; ${b}</span></div>`,
    decoys: [],
  },
  table: {
    css: `.foot-table{width:100%;margin-top:30px;font-size:.8em;border-top:1px solid var(--line)}.foot-table td{padding:8px}`,
    html: (b) => `<table class="foot-table"><tr><td>${b} Holdings. Member of the Fictional Deposit Scheme.</td><td align="right"><a href="#">Site map</a> | <a href="#">Disclosures</a> | <a href="#">Contact</a></td></tr></table>`,
    decoys: [],
  },
  applink: {
    css: `.app-strip{margin-top:40px;padding:20px 28px;background:var(--card);border-top:1px solid var(--line);display:flex;gap:10px;align-items:center;flex-wrap:wrap}.app-strip input{width:200px}`,
    html: (b) => `<section class="app-strip" aria-label="Get the app"><strong>Get the ${b} app.</strong> <span>We will text you a link.</span><input type="tel" id="app-link-phone" name="mobile" placeholder="Mobile number"><button type="button">Text me</button></section>`,
    decoys: ['#app-link-phone'],
  },
};

// ---------------------------------------------------------------- marketing noise

export const noise = {
  features: (b) => `<section class="promo"><h2>Why teams pick ${b}</h2><ul><li>Set up in an afternoon, no consultants needed.</li><li>Round-the-clock humans on the support desk.</li><li>Export everything you own, whenever you want.</li></ul></section>`,
  quote: (b) => `<blockquote class="promo-quote"><p>&ldquo;We moved our whole office to ${b} over a long weekend and nobody noticed. That is the highest compliment I know.&rdquo;</p><footer class="muted">Operations lead, a mid-sized plumbing wholesaler</footer></blockquote>`,
  status: () => `<p class="status-note muted" role="status">All systems normal. Scheduled maintenance this Sunday, 02:00 to 03:00 UTC.</p>`,
  cookie: () => `<div class="cookie-note muted" style="border:1px dashed var(--line);padding:8px 12px;margin:12px 0">We use a small number of cookies to keep this site working. <a href="#">Learn more</a>.</div>`,
  faq: (b) => `<section class="faq"><h3>Common questions</h3><details><summary>Is ${b} free to try?</summary><p>Yes, every plan includes a thirty day trial.</p></details><details><summary>Where is my data stored?</summary><p>In the region you pick when you create your workspace.</p></details><details><summary>How do I close my account?</summary><p>From Settings at any time. We keep nothing after thirty days.</p></details></section>`,
  phishing: (b) => `<p class="muted">${b} will never ask for your password by phone or email. If in doubt, type our address into your browser yourself.</p>`,
};

// ---------------------------------------------------------------- inline scripts

/** Plain uncontrolled page: state() reads the live value of each selector. */
export function domState(map) {
  return `window.__fixture={state:function(){var q=function(s){var e=document.querySelector(s);return e?e.value:'';};var j=function(a){return a.map(q).join('');};return {${Object.entries(map)
    .map(([k, v]) => `${JSON.stringify(k)}:${Array.isArray(v) ? `j(${JSON.stringify(v)})` : `q(${JSON.stringify(v)})`}`)
    .join(',')}};}};`;
}

/** Negative pages still define the hook so a harness can call it blindly. */
export const emptyState = `window.__fixture={state:function(){return {};}};`;

/**
 * Real-navigation flow: what the user typed is kept in sessionStorage the way a
 * server session would keep it, so state() on later pages still reports it.
 * `first` wipes any earlier run. `next` wires `submitSel` to navigate there.
 */
export function flowJs({ flow, fields = {}, next, submitSel, first = false, afterLoad = '' }) {
  return `(function(){var K=${JSON.stringify('flow:' + flow)};${first ? 'sessionStorage.removeItem(K);' : ''}
var S={};try{S=JSON.parse(sessionStorage.getItem(K)||'{}');}catch(e){}
var F=${JSON.stringify(fields)};
function save(){sessionStorage.setItem(K,JSON.stringify(S));}
Object.keys(F).forEach(function(r){var el=document.querySelector(F[r]);if(!el)return;S[r]=S[r]||'';save();el.addEventListener('input',function(){S[r]=el.value;save();});});
window.__fixture={state:function(){return S;}};
${afterLoad}
${next ? `var go=function(ev){if(ev)ev.preventDefault();location.href=${JSON.stringify(next)};};var b=document.querySelector(${JSON.stringify(submitSel)});if(b){if(b.tagName==='FORM'){b.addEventListener('submit',go);}else{b.addEventListener('click',go);}}` : ''}
})();`;
}

/** Page inside an iframe: reports its state to the parent on every edit. */
export function childRelay(map, extra = '') {
  return `(function(){${domState(map)}
function send(){if(parent!==window){parent.postMessage({__fx:window.__fixture.state()},'*');}}
document.addEventListener('input',send,true);document.addEventListener('change',send,true);
window.addEventListener('load',send);
${extra}
})();`;
}

/** Parent page (or middle frame) of an iframe fixture: merges what children post. */
export function parentMerge(initial = {}) {
  return `(function(){var S=${JSON.stringify(initial)};
window.addEventListener('message',function(e){if(e.data&&e.data.__fx){for(var k in e.data.__fx){S[k]=e.data.__fx[k];}if(parent!==window){parent.postMessage({__fx:S},'*');}}});
window.__fixture={state:function(){return S;}};})();`;
}

/** Registers a closed shadow root where the harness can reach it. */
export const closedRootsInit = `window.__closedRoots=window.__closedRoots||{};`;

// ---------------------------------------------------------------- assembly

export function assemble(p) {
  const brand = p.brand || 'Acme';
  const h = HEADERS[p.header || 'none'];
  const f = FOOTERS[p.footer || 'none'];
  if (!h) throw new Error(`unknown header ${p.header} on ${p.id || p.path}`);
  if (!f) throw new Error(`unknown footer ${p.footer} on ${p.id || p.path}`);
  const libs = (p.libs || []).map((l) => `<script src="/lib/${l}"></script>`).join('\n');
  const stateJs = p.negative && !p.script?.includes('__fixture') ? emptyState : p.state ? domState(p.state) : '';
  return `<!doctype html>
<html lang="${p.lang || 'en'}"${p.dir ? ` dir="${p.dir}"` : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${p.title || brand}</title>
<link rel="icon" href="data:,">
<style>
${themeCss(p.theme || 'slate')}${h.css}
${f.css}
${p.css || ''}
</style>
${p.head || ''}
</head>
<body${p.bodyAttrs ? ' ' + p.bodyAttrs : ''}>
${p.chromeTop || h.html(brand)}
${p.bare ? p.main : `<main class="wrap">\n${p.main}\n</main>`}
${p.chromeBottom || f.html(brand)}
${libs}
${stateJs ? `<script>${stateJs}</script>` : ''}
${p.script ? `<script>\n${p.script}\n</script>` : ''}
</body>
</html>
`;
}

/** Selectors of inputs in this page's chrome that must never be filled. */
export function chromeDecoys(p) {
  return [...(HEADERS[p.header || 'none'].decoys || []), ...(FOOTERS[p.footer || 'none'].decoys || [])];
}
