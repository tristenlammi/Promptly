// Log-in pages in the style of common self-hosted apps and home-network devices.
import { doc, fxLive, step, x } from './kit.mjs';

export default [
  {
    id: 'h4-selfhost-01',
    category: 'selfhosted',
    description: 'NAS admin desktop: an "Account" step with an arrow button, then a password step greeting the user by name with a "Stay signed in" tick.',
    steps: [
      step('email-first', [x('input[name="username"]', 'username')], [], { advance: { click: '#login-next' } }),
      step('password-next', [x('input[name="current-password"]', 'password')], [], { wait: '.login-panel[data-phase="password"]' }),
    ],
    html: doc({
      title: 'StratumNAS – nas-living',
      css: `
body{margin:0;height:100vh;background:radial-gradient(circle at 70% 20%,#4b6cb7,#182848);font:14px "Noto Sans",sans-serif;color:#222}
.login-panel{position:absolute;right:12%;top:22%;width:330px;background:rgba(255,255,255,.95);border-radius:14px;padding:30px}
.dev{font-size:12px;color:#667}
.inrow{display:flex;margin-top:22px}.inrow input{flex:1;padding:10px;border:1px solid #c5ccd6;border-radius:6px 0 0 6px;font-size:15px}
.inrow button{width:44px;border:0;border-radius:0 6px 6px 0;background:#2f6fdf;color:#fff;font-size:18px}
.hi{font-size:20px;margin:0}`,
      body: `
<div class="login-panel" data-phase="account">
  <div class="dev">nas-living</div>
  <div id="p-account">
    <h2>Sign in</h2>
    <form action="#" onsubmit="return false">
      <div class="inrow"><input type="text" name="username" placeholder="Account" autocomplete="username" aria-label="Account"><button type="button" id="login-next" aria-label="Next">→</button></div>
    </form>
    <p><a href="#">Forgot password?</a></p>
  </div>
  <div id="p-password" hidden>
    <p class="hi">Hi, <span id="hi-name"></span></p>
    <form action="#" onsubmit="return false">
      <div class="inrow"><input type="password" name="current-password" placeholder="Password" autocomplete="current-password" aria-label="Password"><button type="submit" aria-label="Sign in">→</button></div>
      <p><label><input type="checkbox" name="rememberme"> Stay signed in</label></p>
    </form>
    <a href="#" id="other">Sign in with another account</a>
  </div>
</div>`,
      js: `
var acct = '';
document.getElementById('login-next').addEventListener('click', function () {
  acct = document.querySelector('input[name="username"]').value;
  document.getElementById('hi-name').textContent = acct;
  setTimeout(function () {
    document.getElementById('p-account').hidden = true;
    document.getElementById('p-password').hidden = false;
    document.querySelector('.login-panel').setAttribute('data-phase', 'password');
  }, 350);
});
${fxLive({ username: 'js:acct || val("input[name=username]")', password: 'input[name="current-password"]' })}`,
    }),
  },

  {
    id: 'h4-selfhost-02',
    category: 'selfhosted',
    description: 'Home automation hub: the authorize page puts its log-in form two open shadow roots deep, with a "keep me logged in" tick and the client name in text.',
    steps: [step('signin', [x(['hearth-authorize', 'hearth-login-flow', 'input[name="username"]'], 'username'), x(['hearth-authorize', 'hearth-login-flow', 'input[name="password"]'], 'password')], [], { wait: 'hearth-authorize[data-ready]' })],
    html: doc({
      title: 'Hearth Hub',
      css: `body{margin:0;background:#fafafa;font:14px Roboto,sans-serif}hearth-authorize{display:block}`,
      body: `<hearth-authorize client-name="homehub.local:8123"></hearth-authorize>`,
      js: `
customElements.define('hearth-login-flow', class extends HTMLElement {
  connectedCallback() {
    var r = this.attachShadow({ mode: 'open' });
    r.innerHTML = '<style>.f{position:relative;margin:18px 0}.f input{width:100%;box-sizing:border-box;padding:20px 12px 6px;border:0;border-bottom:1px solid #888;background:#f5f5f5;font-size:16px}.f span{position:absolute;left:12px;top:4px;font-size:12px;color:#03a9f4;pointer-events:none}button{background:#03a9f4;color:#fff;border:0;padding:9px 18px;border-radius:4px}</style>' +
      '<form><div class="f"><span>Username</span><input name="username" autocomplete="username" autocapitalize="none"></div>' +
      '<div class="f"><span>Password</span><input name="password" type="password" autocomplete="current-password"></div>' +
      '<label><input type="checkbox" checked> Keep me logged in</label><p><button type="submit">Log in</button></p></form>';
    r.querySelector('form').addEventListener('submit', function (e) { e.preventDefault(); });
  }
});
customElements.define('hearth-authorize', class extends HTMLElement {
  connectedCallback() {
    var r = this.attachShadow({ mode: 'open' });
    r.innerHTML = '<style>.card{width:400px;margin:60px auto;background:#fff;padding:24px;border-radius:12px;box-shadow:0 2px 6px rgba(0,0,0,.15)}.logo{width:56px;height:56px;border-radius:12px;background:#03a9f4;margin:0 auto 12px}</style>' +
      '<div class="card"><div class="logo"></div><p>Welcome home! You are about to give <b class="client"></b> access to your Hearth Hub.</p><hearth-login-flow></hearth-login-flow></div>';
    r.querySelector('.client').textContent = this.getAttribute('client-name');
    this.setAttribute('data-ready', '');
  }
});
window.__fixture = { state: function () {
  var r = document.querySelector('hearth-authorize').shadowRoot.querySelector('hearth-login-flow').shadowRoot;
  return { username: r.querySelector('input[name="username"]').value, password: r.querySelector('input[name="password"]').value };
} };`,
    }),
  },

  {
    id: 'h4-selfhost-03',
    category: 'selfhosted',
    description: 'Hypervisor web UI: a widget-toolkit login window over a dimmed console, generated ids, and read-only combo boxes for realm and language.',
    steps: [step('signin', [x('#textfield-1016-inputEl', 'username'), x('#textfield-1017-inputEl', 'password')], ['#combo-1018-inputEl', '#combo-1019-inputEl'])],
    html: doc({
      title: 'pve-01 - Proxtrix Virtual Environment',
      css: `
body{margin:0;height:100vh;background:#f5f5f5;font:13px helvetica,arial,sans-serif}
.mask{position:fixed;inset:0;background:rgba(80,80,80,.55)}
.x-window{position:fixed;left:50%;top:30%;transform:translateX(-50%);width:400px;background:#fff;border:1px solid #157fcc;box-shadow:0 0 8px rgba(0,0,0,.4)}
.x-window-header{background:#157fcc;color:#fff;padding:8px 10px;font-weight:bold}
.x-form-item{display:flex;align-items:center;padding:6px 12px}
.x-form-item-label{width:110px}
.x-form-field{flex:1;padding:4px 6px;border:1px solid #cecece;font:13px helvetica,arial,sans-serif}
.x-form-trigger-wrap{flex:1;display:flex}.x-form-trigger-wrap .x-form-field{cursor:pointer}
.x-trigger{width:22px;border:1px solid #cecece;border-left:0;background:#f0f0f0}
.x-toolbar{display:flex;justify-content:space-between;align-items:center;padding:8px 12px;border-top:1px solid #ddd}
.x-btn{background:#3892d4;color:#fff;border:0;padding:5px 16px}`,
      body: `
<div class="mask"></div>
<div class="x-window" id="loginview-1012" role="dialog" aria-labelledby="loginview-1012_header-title">
  <div class="x-window-header" id="loginview-1012_header-title">Proxtrix VE Login</div>
  <form id="form-1015" class="x-panel-body" onsubmit="return false">
    <div class="x-form-item"><label class="x-form-item-label" for="textfield-1016-inputEl" id="textfield-1016-labelEl">User name:</label>
      <input id="textfield-1016-inputEl" class="x-form-field x-form-text" type="text" name="username" autocomplete="username" role="textbox" aria-invalid="false"></div>
    <div class="x-form-item"><label class="x-form-item-label" for="textfield-1017-inputEl">Password:</label>
      <input id="textfield-1017-inputEl" class="x-form-field x-form-text" type="password" name="password" autocomplete="current-password" role="textbox"></div>
    <div class="x-form-item"><label class="x-form-item-label" for="combo-1018-inputEl">Realm:</label>
      <div class="x-form-trigger-wrap"><input id="combo-1018-inputEl" class="x-form-field" type="text" name="realm" readonly value="Linux PAM standard authentication" role="combobox" aria-haspopup="listbox"><div class="x-trigger"></div></div></div>
    <div class="x-form-item"><label class="x-form-item-label" for="combo-1019-inputEl">Language:</label>
      <div class="x-form-trigger-wrap"><input id="combo-1019-inputEl" class="x-form-field" type="text" name="lang" readonly value="English - English" role="combobox"><div class="x-trigger"></div></div></div>
  </form>
  <div class="x-toolbar"><label><input type="checkbox" id="checkbox-1020-inputEl"> Save User name:</label><button class="x-btn" id="button-1021" type="button">Login</button></div>
</div>`,
      js: fxLive({ username: '#textfield-1016-inputEl', password: '#textfield-1017-inputEl' }),
    }),
  },

  {
    id: 'h4-selfhost-04',
    category: 'selfhosted',
    description: 'Media server sign-in: first a grid of user avatars and a "Manual Login" button, then a username and password form revealed in place.',
    steps: [
      step('none', [], [], { advance: { click: '#btnManual' } }),
      step('signin', [x('#txtManualName', 'username'), x('#txtManualPassword', 'password')], [], { wait: '#manualLoginForm:not(.hide)' }),
    ],
    html: doc({
      title: 'Reelbox',
      css: `
body{margin:0;background:#101010;color:#ddd;font:15px "Noto Sans",sans-serif}
.padded{max-width:640px;margin:60px auto;text-align:center}
.users{display:flex;gap:20px;justify-content:center;margin:30px 0}
.user{width:110px;cursor:pointer}.user .av{width:110px;height:110px;border-radius:6px;background:#00a4dc}
.hide{display:none}
.inputContainer{text-align:left;margin:16px auto;width:360px}
.inputContainer label{display:block;font-size:13px;color:#aaa;margin-bottom:4px}
.reel-input{width:100%;box-sizing:border-box;padding:10px;background:#292929;border:1px solid #333;color:#fff;border-radius:3px}
.raised{background:#00a4dc;color:#fff;border:0;padding:10px 24px;border-radius:3px}`,
      body: `
<div class="padded">
  <h1>Please sign in</h1>
  <div id="visualLoginForm">
    <div class="users">
      <div class="user"><div class="av"></div>dana</div>
      <div class="user"><div class="av" style="background:#e67e22"></div>kids</div>
      <div class="user"><div class="av" style="background:#8e44ad"></div>living room</div>
    </div>
    <button is="reel-button" type="button" class="raised" id="btnManual">Manual Login</button>
    <button is="reel-button" type="button" class="raised" style="background:#333">Forgot Password</button>
  </div>
  <form class="manualLoginForm hide" id="manualLoginForm" onsubmit="return false">
    <div class="inputContainer"><label for="txtManualName">User</label><input is="reel-input" class="reel-input" type="text" id="txtManualName" autocomplete="username" autocapitalize="off"></div>
    <div class="inputContainer"><label for="txtManualPassword">Password</label><input is="reel-input" class="reel-input" type="password" id="txtManualPassword" autocomplete="current-password"></div>
    <label><input type="checkbox" id="chkRememberLogin" checked> Remember Me</label>
    <p><button type="submit" class="raised">Sign In</button></p>
  </form>
</div>`,
      js: `
document.getElementById('btnManual').addEventListener('click', function () {
  document.getElementById('visualLoginForm').classList.add('hide');
  document.getElementById('manualLoginForm').classList.remove('hide');
});
${fxLive({ username: '#txtManualName', password: '#txtManualPassword' })}`,
    }),
  },

  {
    id: 'h4-selfhost-05',
    category: 'selfhosted',
    description: 'Metrics dashboard log-in rendered by a client bundle after a short delay: "Email or username" and "Password" with test ids, an OAuth button and a forgot link.',
    steps: [step('signin', [x('input[name="user"]', 'username'), x('input[name="password"]', 'password')], [], { wait: '[data-testid="login-form"]' })],
    html: doc({
      title: 'Graphon',
      css: `
body{margin:0;min-height:100vh;background:#111217;color:#ccccdc;font:14px Inter,sans-serif}
.lw{width:380px;margin:0 auto;padding-top:110px}
.logo{width:60px;height:60px;border-radius:50%;margin:0 auto 10px;background:conic-gradient(#f05a28,#fbca0a,#f05a28)}
h1{text-align:center;font-size:28px;font-weight:400}
.fld{margin-bottom:16px}.fld label{display:block;font-weight:500;margin-bottom:6px}
.fld input{width:100%;box-sizing:border-box;padding:8px;background:#0b0c0e;border:1px solid #2f3037;border-radius:2px;color:#fff}
.btn{width:100%;padding:9px;background:#3d71d9;color:#fff;border:0;border-radius:2px}
.oauth{margin-top:16px;width:100%;padding:9px;background:#22252b;color:#ccc;border:1px solid #333}`,
      body: `<div id="reactRoot"><div class="lw"><div class="logo"></div><h1>Welcome to Graphon</h1></div></div>`,
      js: `
setTimeout(function () {
  var lw = document.querySelector('.lw');
  var form = document.createElement('form');
  form.setAttribute('data-testid', 'login-form');
  form.innerHTML = '<div class="fld"><label for="user">Email or username</label><input id="user" name="user" autocomplete="username" placeholder="email or username" data-testid="data-testid Username input field"></div>' +
    '<div class="fld"><label for="current-password">Password</label><input id="current-password" name="password" type="password" autocomplete="current-password" placeholder="password" data-testid="data-testid Password input field"></div>' +
    '<button class="btn" type="submit" data-testid="data-testid Login button">Log in</button>' +
    '<p style="text-align:right"><a href="#">Forgot your password?</a></p>' +
    '<button class="oauth" type="button">Sign in with Company SSO</button>';
  form.addEventListener('submit', function (e) { e.preventDefault(); });
  lw.appendChild(form);
}, 450);
${fxLive({ username: 'input[name="user"]', password: 'input[name="password"]' })}`,
    }),
  },

  {
    id: 'h4-selfhost-06',
    category: 'selfhosted',
    description: 'Container manager log-in in an older two-way-binding framework: ng-model attributes, icon-prefixed inputs with placeholders only, and an OAuth link.',
    steps: [step('signin', [x('#username', 'username'), x('#password', 'password')])],
    html: doc({
      title: 'Harborview',
      css: `
body{margin:0;background:#f2f4f7;font:14px "Helvetica Neue",sans-serif}
.simple-box{width:420px;margin:90px auto;background:#fff;border-radius:8px;padding:30px;box-shadow:0 1px 3px rgba(0,0,0,.2)}
.input-group{display:flex;margin-bottom:14px}
.input-group-addon{width:38px;display:grid;place-items:center;background:#eef1f5;border:1px solid #ccd;border-right:0;border-radius:4px 0 0 4px}
.form-control{flex:1;padding:9px;border:1px solid #ccd;border-radius:0 4px 4px 0}
.btn-primary{background:#1d64c4;color:#fff;border:0;padding:9px 20px;border-radius:4px}`,
      body: `
<div class="simple-box" ng-controller="AuthenticationController as ctrl">
  <h2 style="color:#1d64c4">Harborview</h2>
  <form class="simple-box-form form-horizontal" name="loginForm" onsubmit="return false">
    <div class="input-group"><span class="input-group-addon">👤</span>
      <input id="username" type="text" class="form-control" name="username" ng-model="ctrl.formValues.Username" auto-focus placeholder="Username" data-cy="auth-usernameInput"></div>
    <div class="input-group"><span class="input-group-addon">🔒</span>
      <input id="password" type="password" class="form-control" name="password" ng-model="ctrl.formValues.Password" autocomplete="off" placeholder="Password" data-cy="auth-passwordInput"></div>
    <div style="display:flex;justify-content:space-between;align-items:center">
      <a href="#">Login with OAuth</a>
      <button type="submit" class="btn-primary" data-cy="auth-loginButton">Login</button>
    </div>
  </form>
</div>`,
      js: fxLive({ username: '#username', password: '#password' }),
    }),
  },

  {
    id: 'h4-selfhost-07',
    category: 'selfhosted',
    description: 'Self-hosted git forge: "Username or Email Address" sign-in under a navbar with a repository search box, plus a hidden OpenID tab.',
    steps: [step('signin', [x('#user_name', 'username'), x('#password', 'password')], ['#navbar-search', '#openid'])],
    html: doc({
      title: 'Sign In - Teaforge: code, brewed slowly',
      css: `
body{margin:0;font:14px system-ui,"Segoe UI",sans-serif;background:#fff;color:#181c21}
.navbar{display:flex;gap:16px;align-items:center;padding:8px 20px;border-bottom:1px solid #d0d7de;background:#f8f8f9}
.navbar input{padding:5px 8px;border:1px solid #d0d7de;border-radius:4px}
.navbar .right{margin-left:auto}
.ui.container{max-width:560px;margin:40px auto}
.ui.top.attached.header{background:#f2f2f2;border:1px solid #d0d7de;padding:10px 14px;font-weight:600;margin:0}
.ui.attached.segment{border:1px solid #d0d7de;border-top:0;padding:20px}
.field{display:flex;align-items:center;margin-bottom:12px}
.field label{width:200px;text-align:right;padding-right:14px}
.field input[type=text],.field input[type=password]{flex:1;padding:7px;border:1px solid #d0d7de;border-radius:4px}
.ui.primary.button{background:#4183c4;color:#fff;border:0;padding:8px 16px;border-radius:4px}
.tabs a{margin-right:12px}`,
      body: `
<nav class="navbar">
  <b>Teaforge</b><a href="#">Explore</a><a href="#">Help</a>
  <input type="text" id="navbar-search" name="q" placeholder="Search repos…" aria-label="Search">
  <span class="right"><a href="#">Register</a> · <a href="#">Sign In</a></span>
</nav>
<div class="ui container">
  <div class="tabs"><a href="#" class="active">Sign In</a><a href="#" id="tab-openid">OpenID</a></div>
  <h4 class="ui top attached header">Sign In</h4>
  <div class="ui attached segment">
    <form class="ui form" action="#" method="post" onsubmit="return false">
      <input type="hidden" name="_csrf" value="kF3x9pQ2">
      <div class="required field"><label for="user_name">Username or Email Address</label><input id="user_name" type="text" name="user_name" autofocus required></div>
      <div class="required field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required></div>
      <div class="field"><label></label><label style="width:auto;text-align:left"><input name="remember" type="checkbox"> Remember This Device</label></div>
      <div class="field"><label></label><button class="ui primary button">Sign In</button>&nbsp;<a href="#">Forgot password?</a></div>
    </form>
  </div>
  <div id="openid-panel" hidden>
    <label for="openid">OpenID URI</label><input id="openid" name="openid" type="text">
  </div>
</div>`,
      js: fxLive({ username: '#user_name', password: '#password' }),
    }),
  },

  {
    id: 'h4-selfhost-08',
    category: 'selfhosted',
    description: 'Router admin "Authorization Required" page: a table form whose username box comes pre-filled with "root", and a password box.',
    steps: [step('signin', [x('input[name="luci_username"]', 'username'), x('input[name="luci_password"]', 'password')])],
    html: doc({
      title: 'OpenRidge - gw-attic - Admin',
      css: `
body{margin:0;font:13px sans-serif;background:#fff}
header{background:#002b49;color:#fff;padding:10px 20px;font-size:18px}
.alert-message{margin:20px;padding:10px;background:#fff6dd;border:1px solid #e8c56d}
.cbi-map{margin:20px}
.cbi-value{display:flex;align-items:center;padding:6px 0}
.cbi-value-title{width:160px;text-align:right;padding-right:12px}
.cbi-input-text,.cbi-input-password{padding:4px;width:200px}
.cbi-button{padding:5px 14px;background:#0069d6;color:#fff;border:0}`,
      body: `
<header>OpenRidge <small>23.05 · gw-attic</small></header>
<form method="post" action="#" onsubmit="return false">
  <div class="cbi-map">
    <h2 name="content">Authorization Required</h2>
    <div class="alert-message">Please enter your username and password.</div>
    <div class="cbi-section"><div class="cbi-section-node">
      <div class="cbi-value"><label class="cbi-value-title">Username</label><div class="cbi-value-field"><input class="cbi-input-text" type="text" name="luci_username" value="root"></div></div>
      <div class="cbi-value"><label class="cbi-value-title">Password</label><div class="cbi-value-field"><input class="cbi-input-password" type="password" name="luci_password"></div></div>
    </div></div>
  </div>
  <div class="cbi-page-actions" style="margin:0 20px"><input type="submit" value="Login" class="cbi-button cbi-button-apply"> <input type="reset" value="Reset" class="cbi-button"></div>
</form>
<footer style="margin:30px 20px;color:#888">Powered by OpenRidge</footer>`,
      js: fxLive({ username: 'input[name="luci_username"]', password: 'input[name="luci_password"]' }),
    }),
  },

  {
    id: 'h4-selfhost-09',
    category: 'selfhosted',
    description: 'Password-protected wiki "Log In" page: labels wrapping their inputs, one-letter field names, and a quick-search box in the page header.',
    steps: [step('signin', [x('input[name="u"]', 'username'), x('input[name="p"]', 'password')], ['#qsearch__in'])],
    html: doc({
      title: 'Login [Household Wiki]',
      css: `
body{margin:0;font:14px Arial,sans-serif;background:#fbfaf9;color:#333}
#wiki__header{display:flex;justify-content:space-between;padding:12px 24px;border-bottom:1px solid #ccc}
.page{max-width:780px;margin:20px auto;background:#fff;border:1px solid #ddd;padding:24px}
fieldset{border:1px solid #ccc;padding:14px 18px}
label.block{display:block;text-align:right;margin:6px 0}
label.block span{display:inline-block;width:120px;text-align:left}
input.edit{width:240px;padding:4px}`,
      body: `
<div id="wiki__header">
  <h1 style="margin:0;font-size:20px">Household Wiki</h1>
  <form action="#" id="dw__search" onsubmit="return false"><input type="hidden" name="do" value="search"><input type="text" id="qsearch__in" name="q" accesskey="f" title="[F]" placeholder="Search"> <button type="submit">🔍</button></form>
</div>
<div class="page">
  <h1>Login</h1>
  <p>You are currently not logged in! Enter your authentication credentials below to log in. You need to have cookies enabled to log in.</p>
  <form id="dw__login" method="post" action="#" onsubmit="return false">
    <fieldset>
      <legend>Login</legend>
      <label class="block"><span>Username</span> <input type="text" name="u" class="edit" autofocus></label>
      <label class="block"><span>Password</span> <input type="password" name="p" class="edit"></label>
      <label class="simple"><input type="checkbox" name="r" value="1"> <span>Remember me</span></label>
      <button type="submit">Log In</button>
    </fieldset>
  </form>
  <p>Forgotten your password? <a href="#">Set new password</a></p>
</div>`,
      js: fxLive({ username: 'input[name="u"]', password: 'input[name="p"]' }),
    }),
  },

  {
    id: 'h4-selfhost-10',
    category: 'selfhosted',
    description: 'Self-hosted notes app with a single password box and no username at all, as personal knowledge bases often have.',
    steps: [step('signin', [x('#password', 'password')])],
    html: doc({
      title: 'Login – Ledgerleaf Notes',
      css: `
body{margin:0;background:#2a2a35;color:#ddd;font:15px "Segoe UI",sans-serif}
.box{width:340px;margin:140px auto;background:#33333f;padding:30px;border-radius:6px}
input[type=password]{width:100%;box-sizing:border-box;padding:9px;margin:8px 0 14px;background:#22222b;border:1px solid #555;color:#eee}
button{background:#6a5acd;color:#fff;border:0;padding:8px 18px}`,
      body: `
<div class="box">
  <h1 style="font-size:22px">Ledgerleaf Notes</h1>
  <form action="#" method="POST" onsubmit="return false">
    <label for="password">Password</label>
    <input id="password" name="password" type="password" required>
    <label><input type="checkbox" name="rememberMe" value="1"> Remember me</label>
    <p><button type="submit">Login</button></p>
  </form>
</div>`,
      js: fxLive({ password: '#password' }),
    }),
  },

  {
    id: 'h4-selfhost-11',
    category: 'selfhosted',
    description: 'IP camera embedded web server opened as a bare IP and port: uppercase old HTML, a font-tag table, short field names and a client-side hash on submit.',
    host: '127.0.0.1',
    steps: [step('signin', [x('input[name="user"]', 'username'), x('input[name="pass"]', 'password')])],
    html: doc({
      title: 'Owlcam IPC-2100',
      css: `body{background:#c0c0c0;font-family:Arial}`,
      body: `
<CENTER>
<TABLE WIDTH=420 BORDER=1 CELLPADDING=6 CELLSPACING=0 BGCOLOR="#FFFFFF">
<TR><TD BGCOLOR="#000080" COLSPAN=2><FONT COLOR="#FFFFFF" SIZE=4><B>Owlcam IPC-2100 Network Camera</B></FONT></TD></TR>
<FORM NAME="loginForm" ACTION="#" METHOD=POST onSubmit="return encodePass()">
<TR><TD><FONT SIZE=2>User:</FONT></TD><TD><INPUT TYPE=text NAME=user SIZE=16 MAXLENGTH=31></TD></TR>
<TR><TD><FONT SIZE=2>Pass:</FONT></TD><TD><INPUT TYPE=password NAME=pass SIZE=16 MAXLENGTH=31></TD></TR>
<INPUT TYPE=hidden NAME=hash>
<TR><TD COLSPAN=2 ALIGN=CENTER><INPUT TYPE=submit VALUE=" OK "> <INPUT TYPE=reset VALUE="Cancel"></TD></TR>
</FORM>
</TABLE>
<P><FONT SIZE=1>Firmware V2.4.18 build 1907 · Plug-in required for live view in older browsers</FONT></P>
</CENTER>`,
      js: `
function encodePass() {
  var f = document.loginForm, s = f.pass.value, h = 0;
  for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  f.hash.value = h.toString(16);
  return false;
}
${fxLive({ username: 'input[name="user"]', password: 'input[name="pass"]' })}`,
    }),
  },

  {
    id: 'h4-selfhost-12',
    category: 'selfhosted',
    description: 'Basic-auth style prompt drawn as a page: a centred sheet saying the server at an IP and port wants a username and password, with Cancel and Sign in.',
    steps: [step('signin', [x('#ba-user', 'username'), x('#ba-pass', 'password')])],
    html: doc({
      title: 'Authentication required',
      css: `
body{margin:0;height:100vh;background:#e8e8e8;font:13px system-ui,sans-serif}
.sheet{width:400px;margin:0 auto;background:#fff;border-radius:0 0 8px 8px;box-shadow:0 6px 20px rgba(0,0,0,.25);padding:22px}
.sheet h1{font-size:16px;margin:0 0 6px}.origin{color:#555;margin-bottom:4px}.warn{color:#b3261e;margin-bottom:14px}
.row{display:flex;align-items:center;margin:8px 0}.row label{width:90px}
.row input{flex:1;padding:6px;border:1px solid #aaa;border-radius:4px}
.btns{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
.btns button{padding:6px 16px;border-radius:4px;border:1px solid #aaa;background:#fff}
.btns .ok{background:#1a73e8;color:#fff;border-color:#1a73e8}`,
      body: `
<div class="sheet" role="dialog" aria-labelledby="ba-title">
  <h1 id="ba-title">Sign in</h1>
  <div class="origin">10.0.0.20:8000</div>
  <div class="warn">Your connection to this site is not private</div>
  <form action="#" onsubmit="return false">
    <div class="row"><label for="ba-user">Username</label><input id="ba-user" name="username" type="text" autocomplete="username"></div>
    <div class="row"><label for="ba-pass">Password</label><input id="ba-pass" name="password" type="password" autocomplete="current-password"></div>
    <div class="btns"><button type="button">Cancel</button><button type="submit" class="ok">Sign in</button></div>
  </form>
</div>`,
      js: fxLive({ username: '#ba-user', password: '#ba-pass' }),
    }),
  },

  {
    id: 'h4-selfhost-13',
    category: 'selfhosted',
    description: 'Network ad-blocker admin: a password-only log-in box, a remember-for-a-week tick, a domain lookup box in the header and a collapsed "Forgot password?" note.',
    steps: [step('signin', [x('#loginpw', 'password')], ['#domain-search'])],
    html: doc({
      title: 'Sinkhole Admin Console',
      css: `
body{margin:0;background:#ecf0f5;font:14px "Source Sans Pro",sans-serif}
.main-header{background:#367fa9;color:#fff;padding:10px 20px;display:flex;justify-content:space-between}
.main-header input{padding:4px 8px;border:0;border-radius:3px}
.login-box{width:360px;margin:70px auto}
.card{background:#fff;border-top:3px solid #3c8dbc;padding:20px}
.form-group{display:flex;margin-bottom:12px}
.form-group input{flex:1;padding:8px;border:1px solid #d2d6de}
.btn-primary{background:#3c8dbc;color:#fff;border:0;padding:8px 14px}`,
      body: `
<div class="main-header"><b>Sinkhole</b><input type="text" id="domain-search" placeholder="Look up a domain"></div>
<div class="login-box">
  <div class="card">
    <p class="login-box-msg">Sign in to start your session</p>
    <form action="#" id="loginform" method="post" onsubmit="return false">
      <div class="form-group"><input type="password" id="loginpw" name="pw" placeholder="Password" autocomplete="current-password" autofocus></div>
      <label><input type="checkbox" id="logincookie" name="persistentlogin"> Remember me for 7 days</label>
      <p><button type="submit" class="btn-primary">Log in</button></p>
    </form>
    <details><summary>Forgot password?</summary><p>Run the reset command on the server to set a new admin password.</p></details>
  </div>
</div>`,
      js: fxLive({ password: '#loginpw' }),
    }),
  },

  {
    id: 'h4-selfhost-14',
    category: 'selfhosted',
    description: 'Uptime monitor single-page app: the log-in card mounts after a delay with framework floating labels (input before label) and a remember-me switch.',
    steps: [step('signin', [x('#floatingInput', 'username'), x('#floatingPassword', 'password')], [], { wait: '.form-container form' })],
    html: doc({
      title: 'Uptick',
      css: `
body{margin:0;background:#f0f6f4;font:15px "Segoe UI",sans-serif}
.form-container{width:340px;margin:110px auto;background:#fff;padding:28px;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.08)}
.form-floating{position:relative;margin-bottom:12px}
.form-floating input{width:100%;box-sizing:border-box;padding:24px 12px 8px;border:1px solid #ced4da;border-radius:8px;font-size:15px}
.form-floating label{position:absolute;left:12px;top:6px;font-size:12px;color:#6c757d;pointer-events:none}
.btn{width:100%;padding:10px;background:#5cdd8b;border:0;border-radius:20px;font-weight:600}`,
      body: `<div id="app"><div class="form-container"><p style="text-align:center;color:#999">Connecting…</p></div></div>`,
      js: `
setTimeout(function () {
  var box = document.querySelector('.form-container');
  box.innerHTML = '<form><h1 style="font-size:20px;text-align:center">Uptick</h1>' +
    '<div class="form-floating"><input id="floatingInput" type="text" class="form-control" placeholder="Username" autocomplete="username" required><label for="floatingInput">Username</label></div>' +
    '<div class="form-floating"><input id="floatingPassword" type="password" class="form-control" placeholder="Password" autocomplete="current-password" required><label for="floatingPassword">Password</label></div>' +
    '<div><input id="remember" type="checkbox" role="switch" checked> <label for="remember">Remember me</label></div>' +
    '<p><button class="btn" type="submit">Login</button></p></form>';
  box.querySelector('form').addEventListener('submit', function (e) { e.preventDefault(); });
}, 600);
${fxLive({ username: '#floatingInput', password: '#floatingPassword' })}`,
    }),
  },

  {
    id: 'h4-selfhost-15',
    category: 'selfhosted',
    description: 'Torrent client web UI on a bare IP and port: no form element, two inputs in a div and an input-button with a click handler.',
    host: '127.0.0.1',
    steps: [step('signin', [x('#username', 'username'), x('#password', 'password')])],
    html: doc({
      title: 'Sprocket WebUI',
      css: `
body{margin:0;background:#dfe6ec;font:13px Verdana,sans-serif}
#main{width:300px;margin:120px auto;background:#fff;border:1px solid #9aa9b8;padding:20px;text-align:center}
.row{margin:8px 0;text-align:left}.row label{display:block;font-weight:bold}
.row input{width:100%;box-sizing:border-box;padding:4px}
#error_msg{color:#c00;min-height:16px}`,
      body: `
<div id="main">
  <h2>Sprocket WebUI</h2>
  <div id="formplace">
    <div class="row"><label for="username">Username</label><input type="text" id="username" autocapitalize="none" autocorrect="off" spellcheck="false" autofocus></div>
    <div class="row"><label for="password">Password</label><input type="password" id="password"></div>
    <input type="button" id="loginButton" value="Login">
  </div>
  <div id="error_msg"></div>
</div>`,
      js: `
document.getElementById('loginButton').addEventListener('click', function () {
  document.getElementById('error_msg').textContent = 'Logging in...';
});
document.getElementById('password').addEventListener('keydown', function (e) { if (e.key === 'Enter') document.getElementById('loginButton').click(); });
${fxLive({ username: '#username', password: '#password' })}`,
    }),
  },

  {
    id: 'h4-selfhost-16',
    category: 'selfhosted',
    description: 'Build server log-in with servlet-container field names (j_username, j_password), a keep-me-signed-in tick and a simple centred panel.',
    steps: [step('signin', [x('#j_username', 'username'), x('input[name="j_password"]', 'password')])],
    html: doc({
      title: 'Sign in [Butlerbot]',
      css: `
body{margin:0;background:#f8f8f8;font:14px "Segoe UI",sans-serif}
.simple-page{width:340px;margin:100px auto;text-align:center}
.logo{width:72px;height:72px;margin:0 auto;border-radius:50%;background:#d24939}
.formRow{margin:10px 0;text-align:left}
.bb-input{width:100%;box-sizing:border-box;padding:10px;border:2px solid #ccc;border-radius:6px}
.bb-button{width:100%;padding:10px;background:#0b6aa2;color:#fff;border:0;border-radius:6px}`,
      body: `
<div class="simple-page">
  <div class="logo"></div>
  <h1>Welcome to Butlerbot!</h1>
  <form method="post" name="login" action="#" onsubmit="return false">
    <div class="formRow"><input autocorrect="off" autocomplete="off" name="j_username" id="j_username" placeholder="Username" type="text" class="bb-input" autocapitalize="off" aria-label="Username"></div>
    <div class="formRow"><input name="j_password" placeholder="Password" type="password" class="bb-input" aria-label="Password"></div>
    <div class="formRow"><label><input type="checkbox" id="remember_me" name="remember_me"> Keep me signed in</label></div>
    <input name="from" type="hidden" value="/">
    <button type="submit" class="bb-button" name="Submit">Sign in</button>
  </form>
</div>`,
      js: fxLive({ username: '#j_username', password: 'input[name="j_password"]' }),
    }),
  },

  {
    id: 'h4-selfhost-17',
    category: 'selfhosted',
    description: 'First-run setup of a container manager: create the initial administrator, username pre-filled with "admin", password and confirm, and a statistics tick.',
    steps: [step('signup', [x('#username', 'username'), x('#password', 'new-password'), x('#confirm_password', 'confirm-password')])],
    html: doc({
      title: 'Dockyard – Initial setup',
      css: `
body{margin:0;background:#f4f6f9;font:14px "Helvetica Neue",sans-serif}
.box{width:520px;margin:70px auto;background:#fff;border-radius:8px;padding:28px;border:1px solid #dde3ea}
.form-group{display:flex;align-items:center;margin-bottom:14px}
.form-group label{width:170px}
.form-group input{flex:1;padding:8px;border:1px solid #c9d1db;border-radius:4px}
.hint{font-size:12px;color:#8a6d00;background:#fff8db;padding:8px;border-radius:4px}
button{background:#1d64c4;color:#fff;border:0;padding:9px 18px;border-radius:4px}`,
      body: `
<div class="box">
  <h2>New Dockyard installation</h2>
  <p>Please create the initial administrator user.</p>
  <form name="form" action="#" onsubmit="return false">
    <div class="form-group"><label for="username">Username</label><input type="text" id="username" name="username" value="admin" data-cy="init-usernameInput"></div>
    <div class="form-group"><label for="password">Password</label><input type="password" id="password" name="password" autocomplete="new-password" data-cy="init-passwordInput"></div>
    <div class="form-group"><label for="confirm_password">Confirm password</label><input type="password" id="confirm_password" name="confirm_password" autocomplete="new-password" data-cy="init-confirmPasswordInput"></div>
    <p class="hint">The password must be at least 12 characters long.</p>
    <label><input type="checkbox" name="enableTelemetry" checked> Allow collection of anonymous statistics</label>
    <p><button type="submit">Create user</button></p>
  </form>
</div>`,
      js: fxLive({ username: '#username', 'new-password': '#password', 'confirm-password': '#confirm_password' }),
    }),
  },
];
