// Login screens in the style of apps people run at home or in a small office: a NAS, a
// home-automation hub, a hypervisor, a media server, a metrics dashboard, a container
// manager, a git forge, router admin pages, a DNS sinkhole on an IP address, a file cloud
// and a single sign-on portal. Written from what these screens look like to anyone using
// them, with invented names and markup. Several are served from 127.0.0.1, as a box on
// the LAN is reached by IP and port over plain HTTP.
import { fx } from './kit.mjs';

const cat = 'selfhosted';
const u = (selector) => ({ selector, role: 'username' });
const p = (selector) => ({ selector, role: 'password' });

/** State from variables the page keeps itself (its own model, not the DOM). */
const model = (keys) => `var S={${keys.map((k) => `${k}:''`).join(',')}};window.__fixture={state:function(){return S;}};
function bind(el,key){el.addEventListener('input',function(){S[key]=el.value;});}`;

// ------------------------------------------------------------ NAS: username, then password, in place

fx({
  id: 'selfhosted-nas-01', category: cat, brand: 'Coffer DS', host: '127.0.0.1', theme: 'night', header: 'none', footer: 'none',
  description: 'NAS admin page on an IP and port: full-screen wallpaper, a centred panel asking for the account first with a round arrow button, then the password in the same panel with the account name above it, a Back link and Stay signed in. No labels, placeholders only.',
  title: 'Coffer DS - nas01',
  bodyAttrs: 'class="desk"',
  css: `.desk{background:linear-gradient(135deg,#1d3b53,#0e1a26 60%,#253a2a)}.ds-panel{width:360px;margin:110px auto;background:rgba(255,255,255,.93);color:#222;border-radius:14px;padding:34px 30px;text-align:center}
.ds-host{font-size:1.5em;font-weight:300;margin-bottom:18px}.ds-row{position:relative;margin:12px 0}.ds-row input[type=text],.ds-row input[type=password]{width:100%;padding:10px 46px 10px 12px;background:#fff;color:#222;border:1px solid #c8ced6;border-radius:8px}
.ds-go{position:absolute;right:5px;top:5px;width:32px;height:32px;border-radius:50%;padding:0;background:#2a6fdb}.ds-who{font-weight:600}.ds-sm{font-size:.85em;color:#555}`,
  bare: true,
  main: `<div class="ds-panel" id="dsp"><div class="ds-host">nas01</div><div id="ds-view"></div><p class="ds-sm" style="margin-top:22px">Coffer DS 7.2</p></div>`,
  script: `${model(['username', 'password'])}
var v=document.getElementById('ds-view');
function one(){v.innerHTML='<div class="ds-row"><input type="text" name="username" placeholder="Account" autocomplete="username" id="ds-user"><button class="ds-go" id="ds-next" type="button" aria-label="Next">&rarr;</button></div><p class="ds-sm"><a href="#">Forgot password?</a></p>';
 var i=document.getElementById('ds-user');i.value=S.username;bind(i,'username');i.focus();document.getElementById('ds-next').onclick=function(){if(i.value)two();};}
function two(){v.innerHTML='<p class="ds-who" id="ds-who"></p><div class="ds-row"><input type="password" name="passwd" placeholder="Password" autocomplete="current-password" id="ds-pass"><button class="ds-go" type="button" aria-label="Sign in">&rarr;</button></div><label class="ds-sm" style="font-weight:400"><input type="checkbox" id="ds-keep"> Stay signed in</label><p class="ds-sm"><a href="#" id="ds-back">Back</a></p>';
 document.getElementById('ds-who').textContent=S.username;var i=document.getElementById('ds-pass');bind(i,'password');document.getElementById('ds-back').onclick=function(e){e.preventDefault();one();};
 setTimeout(function(){i.focus();document.getElementById('dsp').setAttribute('data-step','pw');},150);}
one();`,
  steps: [
    { kind: 'email-first', wait: '#ds-user', expected: [u('#ds-user')], advance: { click: '#ds-next' } },
    { kind: 'password-next', wait: '#dsp[data-step="pw"]', expected: [p('#ds-pass')] },
  ],
});

// ------------------------------------------------------------ home automation: custom elements, then a code

fx({
  id: 'selfhosted-homeauto-01', category: cat, brand: 'Hearthstead', host: '127.0.0.1', theme: 'slate', header: 'none', footer: 'none',
  description: 'Home-automation hub login: fields inside custom elements (light DOM) with floating labels, "Logging in to http://127.0.0.1" above, a Keep me logged in switch (role=switch button), a Log in button, then a two-factor step asking for the authenticator code in the same card.',
  title: 'Hearthstead',
  bare: true,
  css: `hs-authorize,hs-auth-flow,hs-textfield{display:block}.hs-card{max-width:400px;margin:70px auto;background:var(--card);border-radius:12px;box-shadow:0 2px 10px rgba(0,0,0,.12);padding:28px}
hs-textfield{position:relative;margin:14px 0}hs-textfield input{width:100%;padding:22px 12px 6px;border:0;border-bottom:1px solid #888;border-radius:4px 4px 0 0;background:#f2f4f7}
hs-textfield .lbl{position:absolute;left:12px;top:15px;color:#666;pointer-events:none;transition:all .15s}hs-textfield.up .lbl{top:4px;font-size:.75em}
.hs-sw{display:flex;align-items:center;gap:10px;margin:12px 0}.hs-sw button{width:36px;height:20px;border-radius:10px;padding:0;background:#bbb}.hs-sw button[aria-checked=true]{background:var(--accent)}.hs-act{text-align:right}`,
  main: `<hs-authorize><div class="hs-card"><p class="muted">Logging in to <b>http://127.0.0.1</b>.</p><hs-auth-flow id="flow"></hs-auth-flow></div></hs-authorize>`,
  script: `${model(['username', 'password', 'otp'])}
customElements.define('hs-authorize',class extends HTMLElement{});customElements.define('hs-auth-flow',class extends HTMLElement{});
customElements.define('hs-textfield',class extends HTMLElement{connectedCallback(){var i=this.querySelector('input');var me=this;var up=function(){me.classList.toggle('up',document.activeElement===i||!!i.value);};i.addEventListener('focus',up);i.addEventListener('blur',up);i.addEventListener('input',up);up();}});
var flow=document.getElementById('flow');
function login(){flow.innerHTML='<form id="hs-form" onsubmit="return false"><hs-textfield><input name="username" id="hs-u" autocomplete="username" autocapitalize="off"><span class="lbl">Username</span></hs-textfield><hs-textfield><input name="password" id="hs-p" type="password" autocomplete="current-password"><span class="lbl">Password</span></hs-textfield><div class="hs-sw"><button type="button" role="switch" aria-checked="false" aria-label="Keep me logged in" id="hs-keep"></button><span>Keep me logged in</span></div><div class="hs-act"><button type="submit" id="hs-login">Log in</button></div></form>';
 bind(document.getElementById('hs-u'),'username');bind(document.getElementById('hs-p'),'password');
 document.getElementById('hs-keep').onclick=function(){this.setAttribute('aria-checked',this.getAttribute('aria-checked')==='true'?'false':'true');};
 document.getElementById('hs-form').addEventListener('submit',function(){if(S.username&&S.password)setTimeout(mfa,300);});}
function mfa(){flow.innerHTML='<form id="hs-form2" onsubmit="return false"><p>Please enter the code from your authenticator app.</p><hs-textfield><input name="code" id="hs-c" autocomplete="one-time-code" inputmode="numeric"><span class="lbl">Two-factor authentication code</span></hs-textfield><div class="hs-act"><button type="submit">Log in</button></div></form>';
 var c=document.getElementById('hs-c');bind(c,'otp');c.focus();flow.setAttribute('data-step','mfa');}
login();`,
  steps: [
    { kind: 'signin', wait: '#hs-p', expected: [u('#hs-u'), p('#hs-p')], advance: { click: '#hs-login' } },
    { kind: 'otp', wait: '#flow[data-step="mfa"]', expected: [{ selector: '#hs-c', role: 'otp' }] },
  ],
});

// ------------------------------------------------------------ hypervisor: a desktop-style window over a mask

fx({
  id: 'selfhosted-hypervisor-01', category: cat, brand: 'Halcyon VE', host: '127.0.0.1', theme: 'retro', header: 'none', footer: 'none',
  description: 'Hypervisor web UI: a desktop-toolkit login window over a grey mask, generated ids like textfield-1012-inputEl, labels with for and a trailing colon, a read-only Realm combobox already showing a value, a Language combobox, Save User name, and a Login button that is a link-styled element with role=button.',
  title: 'pve01 - Halcyon Virtual Environment',
  bare: true,
  css: `.x-mask{position:fixed;inset:0;background:rgba(80,80,80,.55)}.x-window{position:absolute;left:50%;top:120px;width:420px;margin-left:-210px;background:#f5f5f5;border:1px solid #5d8ab6;box-shadow:0 0 12px rgba(0,0,0,.4)}
.x-header{background:#3d78b4;color:#fff;padding:6px 10px;font-weight:700}.x-body{padding:14px}.x-row{display:table;width:100%;margin:6px 0}.x-row label{display:table-cell;width:110px;font-size:13px;vertical-align:middle}
.x-row .x-wrap{display:table-cell}.x-row input{width:100%;font-size:13px;padding:3px 5px;border:1px solid #b5b8c8;border-radius:0;background:#fff}.x-trig{position:relative}.x-trig:after{content:'\\25BE';position:absolute;right:6px;top:3px;color:#555}
.x-toolbar{display:flex;justify-content:space-between;align-items:center;padding:8px 14px;border-top:1px solid #ddd}.x-btn{display:inline-block;background:#3d78b4;color:#fff;padding:4px 18px;text-decoration:none;cursor:pointer}`,
  main: `<div class="x-mask"></div><div class="x-window" role="dialog" aria-labelledby="window-1009-title" id="window-1009">
<div class="x-header" id="window-1009-title">Halcyon VE Login</div><div class="x-body"><form id="form-1010" onsubmit="return false">
<div class="x-row"><label for="textfield-1012-inputEl" id="textfield-1012-labelEl">User name:</label><div class="x-wrap"><input type="text" id="textfield-1012-inputEl" name="username" role="textbox" aria-invalid="false" data-ref="inputEl" class="x-form-field x-form-text"></div></div>
<div class="x-row"><label for="textfield-1013-inputEl">Password:</label><div class="x-wrap"><input type="password" id="textfield-1013-inputEl" name="password" role="textbox" data-ref="inputEl" class="x-form-field x-form-text"></div></div>
<div class="x-row"><label for="pmxRealmComboBox-1014-inputEl">Realm:</label><div class="x-wrap x-trig"><input type="text" id="pmxRealmComboBox-1014-inputEl" name="realm" role="combobox" aria-readonly="true" readonly value="Linux PAM standard authentication" data-ref="inputEl" class="x-form-field x-form-text"></div></div>
<div class="x-row"><label for="combobox-1015-inputEl">Language:</label><div class="x-wrap x-trig"><input type="text" id="combobox-1015-inputEl" name="lang" role="combobox" readonly value="English - English" data-ref="inputEl" class="x-form-field x-form-text"></div></div>
</form></div><div class="x-toolbar"><label style="font-size:13px;font-weight:400"><input type="checkbox" id="checkbox-1017-inputEl"> Save User name:</label><a class="x-btn" role="button" tabindex="0" id="button-1018" hidefocus="on"><span id="button-1018-btnInnerEl">Login</span></a></div></div>`,
  state: { username: '#textfield-1012-inputEl', password: '#textfield-1013-inputEl' },
  steps: [{ kind: 'signin', expected: [u('#textfield-1012-inputEl'), p('#textfield-1013-inputEl')] }],
});

// ------------------------------------------------------------ media server: pick a user, or log in by hand

fx({
  id: 'selfhosted-media-01', category: cat, brand: 'Reelhouse', host: '127.0.0.1', theme: 'night', header: 'none', footer: 'none',
  description: 'Media server: a Please sign in page with user cards and Manual Login, Quick Connect and Forgot Password buttons and no inputs; Manual Login shows a User box and a Password box with Remember me and a Sign In button.',
  title: 'Reelhouse',
  bare: true,
  css: `.rh{max-width:620px;margin:60px auto;text-align:center}.rh-cards{display:flex;gap:18px;justify-content:center;margin:24px 0}.rh-card{width:120px;background:#2a2f3c;border-radius:6px;padding:10px;color:var(--fg)}.rh-av{height:90px;background:#3b4256;border-radius:4px;margin-bottom:6px}
.rh-btn{display:block;width:280px;margin:8px auto;background:#3b4256}.rh-form{width:320px;margin:0 auto;text-align:left}.rh-form label{display:block;margin:12px 0 4px}.rh-form input[type=text],.rh-form input[type=password]{width:100%}`,
  main: `<div class="rh"><h1>Please sign in</h1><div id="rh-pick"><div class="rh-cards"><button type="button" class="rh-card"><div class="rh-av"></div>Mara</button><button type="button" class="rh-card"><div class="rh-av"></div>Theo</button></div>
<button type="button" class="rh-btn" id="rh-manual">Manual Login</button><button type="button" class="rh-btn">Quick Connect</button><button type="button" class="rh-btn">Forgot Password</button></div>
<form class="rh-form" id="rh-login" hidden onsubmit="return false"><label for="txtManualName">User:</label><input type="text" id="txtManualName" autocomplete="username" autocapitalize="off" required>
<label for="txtManualPassword">Password:</label><input type="password" id="txtManualPassword" autocomplete="current-password">
<label style="font-weight:400"><input type="checkbox" id="chkRememberLogin" checked> Remember me</label><button type="submit" class="rh-btn">Sign In</button><button type="button" class="rh-btn" id="rh-cancel">Cancel</button></form></div>`,
  script: `document.getElementById('rh-manual').onclick=function(){document.getElementById('rh-pick').hidden=true;document.getElementById('rh-login').hidden=false;document.getElementById('txtManualName').focus();};
document.getElementById('rh-cancel').onclick=function(){document.getElementById('rh-pick').hidden=false;document.getElementById('rh-login').hidden=true;};`,
  state: { username: '#txtManualName', password: '#txtManualPassword' },
  steps: [
    { kind: 'none', expected: [], advance: { click: '#rh-manual' } },
    { kind: 'signin', wait: '#txtManualPassword', expected: [u('#txtManualName'), p('#txtManualPassword')] },
  ],
});

// ------------------------------------------------------------ metrics dashboard: controlled inputs and OAuth buttons

fx({
  id: 'selfhosted-metrics-01', category: cat, brand: 'Lumen Dash', theme: 'night', header: 'none', footer: 'none',
  description: 'Metrics dashboard login: Welcome heading, a controlled username box (placeholder "email or username", aria-label "Username input field") and password box (id current-password), Log in, Forgot your password?, then a divider and two Sign in with OAuth buttons. The page keeps its own model and ignores a bare value set.',
  title: 'Lumen Dash',
  bare: true,
  css: `.ld{max-width:480px;margin:80px auto;text-align:center}.ld-form{text-align:left;margin-top:28px}.ld-form label{display:block;margin:14px 0 4px;font-weight:500}.ld-form input{width:100%}.ld-btn{width:100%;margin-top:18px}.ld-or{margin:24px 0 10px;color:var(--soft)}.ld-sso{width:100%;margin:6px 0;background:#2a2f3c}`,
  main: `<div class="ld"><h1>Welcome to Lumen Dash</h1><form class="ld-form" id="ld-form" onsubmit="return false">
<label for="ld-user">Email or username</label><input id="ld-user" name="user" placeholder="email or username" aria-label="Username input field" autocomplete="username" autocapitalize="none">
<label for="current-password">Password</label><input id="current-password" name="password" type="password" placeholder="password" aria-label="Password input field" autocomplete="current-password">
<button type="submit" class="ld-btn" aria-label="Login button">Log in</button><p style="text-align:right"><a href="#">Forgot your password?</a></p></form>
<div class="ld-or">or</div><button type="button" class="ld-sso">Sign in with Teaforge</button><button type="button" class="ld-sso">Sign in with Gatekeep</button></div>`,
  script: `${model(['username', 'password'])}
['ld-user','current-password'].forEach(function(id,k){var el=document.getElementById(id);var key=k?'password':'username';
 // Controlled: the model takes input events, and every render writes the model back.
 el.addEventListener('input',function(){S[key]=el.value;});el.addEventListener('blur',function(){el.value=S[key];});});`,
  steps: [{ kind: 'signin', expected: [u('#ld-user'), p('#current-password')] }],
});

// ------------------------------------------------------------ container manager: the app builds the form late

fx({
  id: 'selfhosted-container-01', category: cat, brand: 'Quaywright', host: '127.0.0.1', theme: 'slate', header: 'none', footer: 'none',
  description: 'Container manager: a loading spinner, then the app renders Log in to your account with ng-model style attributes, a Username and Password with icons in front, a Login button, and an OAuth login link; the version and a Forgot password note sit under the card.',
  title: 'Quaywright',
  bare: true,
  css: `.qw{max-width:420px;margin:80px auto}.qw-card{background:var(--card);border-radius:8px;padding:30px;box-shadow:0 1px 6px rgba(0,0,0,.15)}.qw-ig{display:flex;align-items:center;border:1px solid var(--line);border-radius:6px;margin:10px 0}.qw-ig i{width:36px;text-align:center;font-style:normal;color:var(--soft)}.qw-ig input{flex:1;border:0}.qw-spin{text-align:center;margin-top:120px}`,
  main: `<div id="qw-root"><p class="qw-spin">Loading&hellip;</p></div>`,
  script: `${model(['username', 'password'])}
setTimeout(function(){document.getElementById('qw-root').innerHTML='<div class="qw"><div class="qw-card"><h2>Log in to your account</h2><form name="authForm" id="qw-form" onsubmit="return false" class="simple-box-form"><div class="qw-ig"><i aria-hidden="true">&#128100;</i><input type="text" class="form-control" id="username" name="username" ng-model="$ctrl.formValues.Username" placeholder="Enter your username" auto-focus data-cy="auth-username"></div><div class="qw-ig"><i aria-hidden="true">&#128274;</i><input type="password" class="form-control" id="password" name="password" ng-model="$ctrl.formValues.Password" placeholder="Enter your password" data-cy="auth-password"></div><p><button type="submit" class="btn-primary" data-cy="auth-login">Login</button> <a href="#">Login with OAuth</a></p></form></div><p class="muted">Quaywright 2.19 &middot; Forgot your password? Ask your administrator.</p></div>';
bind(document.getElementById('username'),'username');bind(document.getElementById('password'),'password');document.getElementById('username').focus();},700);`,
  steps: [{ kind: 'signin', wait: '#password', expected: [u('#username'), p('#password')] }],
});

// ------------------------------------------------------------ git forge: a site header with search and links

fx({
  id: 'selfhosted-git-01', category: cat, brand: 'Teaforge', theme: 'paper', header: 'bar', footer: 'links',
  description: 'Git forge sign-in page with the site header (search box, Explore, Register and Sign In links), a hidden CSRF input, Username or Email Address, Password, Remember this device, Sign In, Forgot password?, Need an account? Register now, and a Sign in with OpenID button.',
  title: 'Sign In - Teaforge: Git with a cup of tea',
  main: `<div class="narrow box"><h2 class="ui top attached header">Sign In</h2><form class="ui form" action="#" method="post" onsubmit="return false">
<input type="hidden" name="_csrf" value="dGVhZm9yZ2UtY3NyZi10b2tlbg">
<div class="row required field"><label for="user_name">Username or Email Address</label><input id="user_name" type="text" name="user_name" autofocus required></div>
<div class="row required field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required></div>
<div class="row inline field"><label style="font-weight:400"><input name="remember" type="checkbox"> Remember this device</label></div>
<p><button class="ui primary button">Sign In</button> <a href="#">Forgot password?</a></p></form>
<p class="muted">Need an account? <a href="#">Register now.</a></p><p><button type="button" class="linkbtn">Sign in with OpenID</button></p></div>`,
  state: { username: '#user_name', password: '#password' },
  steps: [{ kind: 'signin', expected: [u('#user_name'), p('#password')] }],
});

// ------------------------------------------------------------ router admin, two kinds

fx({
  id: 'selfhosted-router-01', category: cat, brand: 'LibreLink', host: '127.0.0.1', theme: 'retro', header: 'none', footer: 'none',
  description: 'Router firmware admin page on an IP address: Authorization Required, "Please enter your username and password", the username box already holding root, Login and Reset buttons, and a status bar naming the router, its firmware and its wireless network.',
  title: 'gw01 - LibreLink admin',
  bare: true,
  css: `.lr-top{background:#003a70;color:#fff;padding:8px 16px}.lr{max-width:520px;margin:40px auto}.lr fieldset{border:1px solid #999;padding:14px}.lr-row{display:flex;align-items:center;margin:8px 0}.lr-row label{width:120px}.lr-row input{flex:1}`,
  main: `<div class="lr-top">gw01 | LibreLink 23.05 | Wireless: home-net (2.4 GHz, 5 GHz) | Load: 0.08</div><div class="lr"><form method="post" action="#" onsubmit="return false"><h2>Authorization Required</h2><p>Please enter your username and password.</p>
<fieldset><div class="lr-row"><label for="luci_username">Username</label><input name="luci_username" id="luci_username" type="text" value="root"></div>
<div class="lr-row"><label for="luci_password">Password</label><input name="luci_password" id="luci_password" type="password"></div></fieldset>
<p><input type="submit" value="Login" class="cbi-button-apply"> <input type="reset" value="Reset"></p></form></div>`,
  state: { username: '#luci_username', password: '#luci_password' },
  steps: [{ kind: 'signin', expected: [u('#luci_username'), p('#luci_password')] }],
});

fx({
  id: 'selfhosted-router-02', category: cat, brand: 'Arcwave', host: '127.0.0.1', theme: 'corp', header: 'none', footer: 'none',
  description: 'Consumer router web page: a lone password box ("Local password") with an eye toggle and a LOG IN button; the page around it names the router, the Wi-Fi band and a Quick Setup link, and never says sign in.',
  title: 'Arcwave AX3000',
  bare: true,
  css: `.aw{max-width:380px;margin:90px auto;text-align:center}.aw-pw{position:relative}.aw-pw input{width:100%;padding:10px 40px 10px 12px}.aw-eye{position:absolute;right:6px;top:6px;background:none;color:#666;padding:4px}.aw-btn{width:100%;margin-top:16px;padding:10px;text-transform:uppercase}.aw-foot{margin-top:30px;font-size:.85em;color:#777}`,
  main: `<div class="aw"><h2>Arcwave AX3000 Wi-Fi 6 Router</h2><p>Please enter the local password of the router.</p><form id="aw-form" onsubmit="return false"><div class="aw-pw"><input type="password" id="local-pwd-tb" class="text-text password-text" maxlength="32" placeholder="Local password"><button type="button" class="aw-eye" aria-label="Show">&#128065;</button></div>
<button type="submit" class="aw-btn" id="aw-login">Log in</button></form><p><a href="#">Forgot password?</a></p><div class="aw-foot">Firmware 1.3.2 &middot; Wireless 2.4 GHz / 5 GHz &middot; <a href="#">Quick Setup</a> &middot; <a href="#">Download the Arcwave app</a></div></div>`,
  state: { password: '#local-pwd-tb' },
  steps: [{ kind: 'password-next', expected: [p('#local-pwd-tb')] }],
});

// ------------------------------------------------------------ DNS sinkhole on an IP: a password and nothing else

fx({
  id: 'selfhosted-dns-01', category: cat, brand: 'Sinkhole', host: '127.0.0.1', theme: 'forest', header: 'none', footer: 'none',
  description: 'Network-wide ad blocker admin on an IP address: a sidebar with Dashboard, Query Log and Settings links, and in the main area a Login box with one password field, Remember me for 7 days, and a Log in button. No username anywhere.',
  title: 'Sinkhole Admin Console',
  bare: true,
  css: `.sk{display:flex;min-height:100vh}.sk-side{width:220px;background:#1f2d24;color:#cfe;padding:16px}.sk-side a{display:block;color:#cfe;margin:8px 0}.sk-main{flex:1;padding:40px}.sk-box{max-width:420px;margin:0 auto;background:var(--card);border-top:3px solid var(--accent);padding:24px}.sk-box input[type=password]{width:100%}`,
  main: `<div class="sk"><nav class="sk-side"><b>Sinkhole</b><a href="#">Dashboard</a><a href="#">Query Log</a><a href="#">Groups</a><a href="#">Adlists</a><a href="#">Settings</a><a href="#">Donate</a></nav>
<main class="sk-main"><div class="sk-box"><h3>Login</h3><p class="muted">Sign in to see query statistics and change settings.</p><form action="#" id="loginform" method="post" onsubmit="return false">
<div class="row"><input type="password" id="loginpw" name="pw" class="form-control" placeholder="Password" autocomplete="current-password" autofocus></div>
<label style="font-weight:400"><input type="checkbox" id="logincookie" name="persistentlogin"> Remember me for 7 days</label><p><button type="submit" class="btn">Log in</button></p></form></div></main></div>`,
  state: { password: '#loginpw' },
  steps: [{ kind: 'password-next', expected: [p('#loginpw')] }],
});

// ------------------------------------------------------------ file cloud: hidden tokens, Log in with a device

fx({
  id: 'selfhosted-cloud-01', category: cat, brand: 'Cumulo', theme: 'slate', header: 'none', footer: 'none',
  description: 'Self-hosted file cloud: Log in to Cumulo heading, "Account name or email" and Password with a show toggle, hidden requesttoken and timezone inputs, a Log in submit input, Forgot password? and Log in with a device; a background picture behind the card.',
  title: 'Login - Cumulo',
  bare: true,
  bodyAttrs: 'style="background:linear-gradient(160deg,#0f4c81,#3a7bbf)"',
  css: `.cu{max-width:380px;margin:90px auto;background:rgba(255,255,255,.95);border-radius:10px;padding:26px 30px}.cu label{display:block;margin:12px 0 4px}.cu input[type=text],.cu input[type=password]{width:100%}.cu-pw{position:relative}.cu-pw button{position:absolute;right:4px;top:4px;background:none;color:#555;padding:4px}.cu input[type=submit]{width:100%;margin-top:16px}`,
  main: `<div class="cu"><h2>Log in to Cumulo</h2><form method="post" name="login" id="cu-form" onsubmit="return false"><fieldset style="border:0;padding:0">
<label for="user">Account name or email</label><input type="text" name="user" id="user" autocomplete="username" autocapitalize="none" spellcheck="false" required>
<label for="password">Password</label><div class="cu-pw"><input type="password" name="password" id="password" autocomplete="current-password" spellcheck="false" required><button type="button" aria-label="Show password">&#128065;</button></div>
<input type="hidden" name="timezone" value="Australia/Sydney"><input type="hidden" name="timezone_offset" value="10"><input type="hidden" name="requesttoken" value="Q3VtdWxvLXJlcXVlc3QtdG9rZW4">
<input type="submit" id="submit-form" value="Log in"></fieldset></form><p><a href="#">Forgot password?</a></p><p><button type="button" class="linkbtn">Log in with a device</button></p></div>`,
  state: { username: '#user', password: '#password' },
  steps: [{ kind: 'signin', expected: [u('#user'), p('#password')] }],
});

// ------------------------------------------------------------ single sign-on portal: outlined fields, then digit boxes

fx({
  id: 'selfhosted-sso-01', category: cat, brand: 'Gatekeep', theme: 'grape', header: 'none', footer: 'none',
  description: 'Self-hosted single sign-on portal: outlined fields whose label floats (a label element) over a fieldset/legend outline with pointer-events:none, Remember me, Sign in and Reset password?; then a One-Time Password step with six one-digit boxes.',
  title: 'Login - Gatekeep',
  bare: true,
  css: `.gk{max-width:380px;margin:80px auto;text-align:center}.gk-f{position:relative;margin:18px 0;text-align:left}.gk-f input{width:100%;padding:16px 14px;border:0;background:transparent;position:relative}
.gk-f label{position:absolute;left:14px;top:16px;color:#777;pointer-events:none;transform-origin:left top;transition:transform .15s}.gk-f.up label{transform:translate(-2px,-24px) scale(.75)}
.gk-f fieldset{position:absolute;inset:-5px 0 0;margin:0;padding:0 8px;border:1px solid #aaa;border-radius:4px;pointer-events:none}.gk-f fieldset legend{visibility:hidden;font-size:.75em;padding:0;max-width:0}.gk-f.up fieldset legend{max-width:100%;padding:0 4px}
.gk-otp{display:flex;gap:8px;justify-content:center}.gk-otp input{width:42px;height:48px;text-align:center;font-size:1.3em}`,
  main: `<div class="gk"><h1>Sign in</h1><div id="gk-view"></div></div>`,
  script: `${model(['username', 'password', 'otp'])}
var v=document.getElementById('gk-view');
function out(id,name,label,type,ac){return '<div class="gk-f"><input id="'+id+'" name="'+name+'" type="'+type+'" autocomplete="'+ac+'"><label for="'+id+'">'+label+'</label><fieldset aria-hidden="true"><legend><span>'+label+'</span></legend></fieldset></div>';}
function lift(i){var w=i.parentNode;var up=function(){w.classList.toggle('up',document.activeElement===i||!!i.value);};i.addEventListener('focus',up);i.addEventListener('blur',up);i.addEventListener('input',up);up();}
v.innerHTML='<form id="gk-form" onsubmit="return false">'+out('username-textfield','username','Username','text','username')+out('password-textfield','password','Password','password','current-password')+'<label style="font-weight:400;display:block;text-align:left"><input type="checkbox" id="remember-checkbox"> Remember me</label><p><button type="submit" id="sign-in-button">Sign in</button></p><p><a href="#">Reset password?</a></p></form>';
['username-textfield','password-textfield'].forEach(function(id,k){var i=document.getElementById(id);lift(i);bind(i,k?'password':'username');});
document.getElementById('gk-form').addEventListener('submit',function(){if(!S.username||!S.password)return;setTimeout(function(){
 v.innerHTML='<h2>One-Time Password</h2><p>Enter the six digits from your app.</p><div class="gk-otp" id="gk-otp"></div><p><button type="button">Use a security key instead</button></p>';
 var box=document.getElementById('gk-otp');for(var k=0;k<6;k++){var i=document.createElement('input');i.setAttribute('maxlength','1');i.setAttribute('inputmode','numeric');i.setAttribute('aria-label','Please enter OTP character '+(k+1));i.id='otp-'+k;box.appendChild(i);}
 var all=[].slice.call(box.querySelectorAll('input'));all.forEach(function(i,k){i.addEventListener('input',function(){S.otp=all.map(function(x){return x.value;}).join('');if(i.value&&all[k+1])all[k+1].focus();});});
 all[0].focus();box.setAttribute('data-ready','1');},300);});`,
  steps: [
    { kind: 'signin', expected: [u('#username-textfield'), p('#password-textfield')], advance: { click: '#sign-in-button' } },
    { kind: 'otp', wait: '#gk-otp[data-ready="1"]', expected: [0, 1, 2, 3, 4, 5].map((k) => ({ selector: `#otp-${k}`, role: 'otp-digit' })) },
  ],
});
