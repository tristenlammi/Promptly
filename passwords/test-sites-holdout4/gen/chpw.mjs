// Password change and reset pages.
import { doc, fxLive, step, x } from './kit.mjs';

export default [
  {
    id: 'h4-chpw-01',
    category: 'change-password',
    description: 'Accounting app settings page: a profile section with pre-filled display name and email, then a security section with current, new and confirm password.',
    steps: [step('change-password', [x('#cur-pw', 'current-password'), x('#new-pw', 'new-password'), x('#new-pw2', 'confirm-password')], ['#display-name', '#profile-email'])],
    html: doc({
      title: 'Settings – Atlas Ledger',
      css: `
body{margin:0;font:14px "Inter",sans-serif;background:#f7f7fb;color:#222}
.side{position:fixed;left:0;top:0;bottom:0;width:200px;background:#1f2a44;color:#cfd6e6;padding:20px}
main{margin-left:240px;padding:30px;max-width:620px}
section{background:#fff;border:1px solid #e3e5ee;border-radius:8px;padding:22px;margin-bottom:22px}
.row{display:flex;align-items:center;margin-bottom:12px}.row label{width:190px}
.row input{flex:1;padding:8px;border:1px solid #c9ccd8;border-radius:6px}
button{background:#3b5bdb;color:#fff;border:0;padding:8px 16px;border-radius:6px}`,
      body: `
<nav class="side"><b>Atlas Ledger</b><p>Dashboard</p><p>Invoices</p><p>Settings</p></nav>
<main>
  <h1>Settings</h1>
  <section>
    <h2>Profile</h2>
    <form action="#" onsubmit="return false">
      <div class="row"><label for="display-name">Display name</label><input id="display-name" name="display_name" type="text" value="Sam Rivera"></div>
      <div class="row"><label for="profile-email">Email</label><input id="profile-email" name="email" type="email" value="sam.rivera@atlas.example"></div>
      <button type="submit">Save profile</button>
    </form>
  </section>
  <section>
    <h2>Change password</h2>
    <form action="#" onsubmit="return false">
      <div class="row"><label for="cur-pw">Current password</label><input id="cur-pw" name="current_password" type="password" autocomplete="current-password"></div>
      <div class="row"><label for="new-pw">New password</label><input id="new-pw" name="new_password" type="password" autocomplete="new-password"></div>
      <div class="row"><label for="new-pw2">Confirm new password</label><input id="new-pw2" name="new_password_confirmation" type="password" autocomplete="new-password"></div>
      <button type="submit">Update password</button>
    </form>
  </section>
</main>`,
      js: fxLive({ 'current-password': '#cur-pw', 'new-password': '#new-pw', 'confirm-password': '#new-pw2' }),
    }),
  },

  {
    id: 'h4-chpw-02',
    category: 'change-password',
    description: 'Reset page reached from an email link: new and confirm password only, with the account name in a hidden username input for password managers.',
    steps: [step('change-password', [x('#password', 'new-password'), x('#password_confirm', 'confirm-password')], ['#reset-username'])],
    html: doc({
      title: 'Choose a new password – Thimble Studio',
      css: `
body{margin:0;font:15px "Karla",sans-serif;background:#fdf2f8}
.card{width:380px;margin:80px auto;background:#fff;border-radius:12px;padding:28px}
.f{margin-bottom:14px}.f label{display:block;font-size:13px}
.f input{width:100%;box-sizing:border-box;padding:10px;border:1px solid #f0abfc;border-radius:8px}
button{width:100%;padding:11px;background:#a21caf;color:#fff;border:0;border-radius:8px}`,
      body: `
<div class="card">
  <h1 style="font-size:21px">Choose a new password</h1>
  <p>for <b>june@thimble.example</b></p>
  <form action="#" onsubmit="return false">
    <input type="text" id="reset-username" name="username" autocomplete="username" value="june@thimble.example" style="display:none">
    <input type="hidden" name="token" value="7c0f9a51e2">
    <div class="f"><label for="password">New password</label><input id="password" name="password" type="password" autocomplete="new-password"></div>
    <div class="f"><label for="password_confirm">Type it again</label><input id="password_confirm" name="password_confirm" type="password" autocomplete="new-password"></div>
    <button type="submit">Save password</button>
  </form>
</div>`,
      js: fxLive({ 'new-password': '#password', 'confirm-password': '#password_confirm' }),
    }),
  },

  {
    id: 'h4-chpw-03',
    category: 'change-password',
    description: 'French grocery delivery account: "Mot de passe actuel", "Nouveau mot de passe", "Confirmer le nouveau mot de passe", no autocomplete hints.',
    steps: [step('change-password', [x('#mdp-actuel', 'current-password'), x('#mdp-nouveau', 'new-password'), x('#mdp-confirmation', 'confirm-password')])],
    html: doc({
      title: 'Modifier mon mot de passe – Ciboulette',
      lang: 'fr',
      css: `
body{margin:0;font:15px "Nunito",sans-serif;background:#f1f8e9}
.bloc{width:440px;margin:50px auto;background:#fff;border-radius:10px;padding:26px}
.ch{margin-bottom:14px}.ch label{display:block;margin-bottom:4px}
.ch input{width:100%;box-sizing:border-box;padding:9px;border:1px solid #aed581;border-radius:6px}
button{background:#558b2f;color:#fff;border:0;padding:10px 20px;border-radius:6px}`,
      body: `
<div class="bloc">
  <h1 style="font-size:21px">Modifier mon mot de passe</h1>
  <form action="#" onsubmit="return false">
    <div class="ch"><label for="mdp-actuel">Mot de passe actuel</label><input id="mdp-actuel" name="ancien" type="password"></div>
    <div class="ch"><label for="mdp-nouveau">Nouveau mot de passe</label><input id="mdp-nouveau" name="nouveau" type="password"><small>8 caractères minimum, dont un chiffre.</small></div>
    <div class="ch"><label for="mdp-confirmation">Confirmer le nouveau mot de passe</label><input id="mdp-confirmation" name="confirmation" type="password"></div>
    <button type="submit">Enregistrer</button>
  </form>
</div>`,
      js: fxLive({ 'current-password': '#mdp-actuel', 'new-password': '#mdp-nouveau', 'confirm-password': '#mdp-confirmation' }),
    }),
  },

  {
    id: 'h4-chpw-04',
    category: 'change-password',
    description: 'Corporate "Your password has expired" page shown after log-in: the user name as plain text, then old password, new password and re-enter.',
    steps: [step('change-password', [x('input[name="oldPassword"]', 'current-password'), x('input[name="newPassword"]', 'new-password'), x('input[name="newPassword2"]', 'confirm-password')])],
    html: doc({
      title: 'Password expired – Verdant Logistics',
      css: `
body{margin:0;font:13px Tahoma,sans-serif;background:#e6ece6}
.dlg{width:440px;margin:100px auto;background:#fff;border:1px solid #8a9a8a}
.dlg h1{margin:0;padding:10px 14px;background:#2f4f2f;color:#fff;font-size:14px}
.body{padding:16px}
table td{padding:4px}
input[type=password]{width:220px;padding:4px}`,
      body: `
<div class="dlg">
  <h1>Verdant Logistics – Change password</h1>
  <div class="body">
    <p><b>Your password has expired and must be changed.</b></p>
    <form action="#" onsubmit="return false">
      <table>
        <tr><td>User:</td><td><b>VERDANT\\jdoe</b></td></tr>
        <tr><td>Old password:</td><td><input type="password" name="oldPassword"></td></tr>
        <tr><td>New password:</td><td><input type="password" name="newPassword"></td></tr>
        <tr><td>Re-enter new password:</td><td><input type="password" name="newPassword2"></td></tr>
      </table>
      <p><input type="submit" value="Change"> <input type="button" value="Cancel"></p>
    </form>
  </div>
</div>`,
      js: fxLive({ 'current-password': 'input[name="oldPassword"]', 'new-password': 'input[name="newPassword"]', 'confirm-password': 'input[name="newPassword2"]' }),
    }),
  },
];
