import { fx, noise } from './kit.mjs';

const r = (selector, role) => ({ selector, role });

// ---------------------------------------------------------------- signup
// An email that doubles as the login is role username; it is role email only when
// a separate username box exists.

const su = 'signup';

fx({
  id: 'signup-01', category: su, brand: 'Acme Roster', theme: 'slate', header: 'navbar', footer: 'news',
  description: 'Email, password and confirm password with a nav bar Sign in link pointing away from the page; footer newsletter as a misleading email box.',
  title: 'Create your Acme Roster account',
  main: `<div class="split"><form class="box" onsubmit="return false"><h1>Start your free trial</h1><div class="row"><label for="s-email">Work email</label><input id="s-email" name="email" type="email"></div><div class="row"><label for="s-pass">Password</label><input id="s-pass" name="password" type="password" minlength="8"></div><div class="row"><label for="s-conf">Confirm password</label><input id="s-conf" name="password_confirmation" type="password"></div><button>Create account</button><p class="muted">Already have an account? <a href="#signin">Sign in</a></p></form><div>${noise.features('Acme Roster')}</div></div>`,
  state: { username: '#s-email', 'new-password': '#s-pass', 'confirm-password': '#s-conf' },
  steps: [{ kind: 'signup', expected: [r('#s-email', 'username'), r('#s-pass', 'new-password'), r('#s-conf', 'confirm-password')] }],
});

fx({
  id: 'signup-02', category: su, brand: 'Ferncastle Forums', theme: 'retro', header: 'table', footer: 'table',
  description: 'Forum registration in a table: username, email and two password boxes with sibling-cell labels, a terms checkbox and a timezone select.',
  title: 'Register at Ferncastle Forums',
  css: `.reg td{padding:5px 8px}`,
  main: `<h2>Register an account</h2><form onsubmit="return false"><table class="reg" border="1" style="border-collapse:collapse;background:var(--card)"><tr><td>Choose a username:</td><td><input name="regusername" id="reg-u" size="24"></td></tr><tr><td>Email address:</td><td><input name="regemail" id="reg-e" size="24"></td></tr><tr><td>Password:</td><td><input name="regpass" id="reg-p" type="password" size="24"></td></tr><tr><td>Password (again):</td><td><input name="regpass2" id="reg-p2" type="password" size="24"></td></tr><tr><td>Time zone:</td><td><select name="tz"><option>GMT</option><option>GMT+1</option><option>GMT+10</option></select></td></tr><tr><td colspan="2"><label><input type="checkbox" name="rules"> I have read the forum rules</label></td></tr></table><p><input type="submit" value="Complete registration"></p></form>`,
  state: { username: '#reg-u', email: '#reg-e', 'new-password': '#reg-p', 'confirm-password': '#reg-p2' },
  steps: [{ kind: 'signup', expected: [r('#reg-u', 'username'), r('#reg-e', 'email'), r('#reg-p', 'new-password'), r('#reg-p2', 'confirm-password')] }],
});

fx({
  id: 'signup-03', category: su, brand: 'Wrenfield Home', theme: 'sun', header: 'shop', footer: 'newsdiv',
  description: 'Store account creation with first and last name side by side, then email, then one password with a strength hint and a marketing opt-in checkbox.',
  title: 'Create your Wrenfield account',
  css: `.two{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px}`,
  main: `<form class="narrow box" onsubmit="return false"><h1>Create an account</h1><div class="two"><div class="row"><label for="fn">First name</label><input id="fn" name="firstname" autocomplete="given-name"></div><div class="row"><label for="ln">Last name</label><input id="ln" name="lastname" autocomplete="family-name"></div></div><div class="row"><label for="em">Email</label><input id="em" name="email" type="email"></div><div class="row"><label for="pw">Password</label><input id="pw" name="password" type="password" autocomplete="new-password" aria-describedby="pwhint"><small id="pwhint" class="muted">At least 8 characters, one number.</small></div><label style="font-weight:400"><input type="checkbox" name="optin"> Send me offers by email</label><p><button>Create account</button></p></form>`,
  state: { 'first-name': '#fn', 'last-name': '#ln', username: '#em', 'new-password': '#pw' },
  steps: [{ kind: 'signup', expected: [r('#fn', 'first-name'), r('#ln', 'last-name'), r('#em', 'username'), r('#pw', 'new-password')] }],
});

fx({
  id: 'signup-04', category: su, brand: 'Tidewrack Systems', theme: 'corp', header: 'bar', footer: 'links',
  description: 'B2B trial request that also creates a login: full name, work email, phone, company, password and confirm, in a two-column layout with placeholder-only inputs.',
  title: 'Start a Tidewrack trial',
  css: `.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}.grid2 input{width:100%}`,
  main: `<h1>See Tidewrack on your own data</h1><form class="box" onsubmit="return false"><div class="grid2"><input id="t-name" name="contact_name" placeholder="Full name"><input id="t-mail" name="contact_email" type="email" placeholder="Work email"><input id="t-tel" name="contact_phone" type="tel" placeholder="Phone number"><input id="t-co" name="organisation" placeholder="Company"><input id="t-p1" name="pw1" type="password" placeholder="Create a password"><input id="t-p2" name="pw2" type="password" placeholder="Repeat password"></div><p><button>Start trial</button></p></form>${noise.quote('Tidewrack')}`,
  state: { 'full-name': '#t-name', username: '#t-mail', phone: '#t-tel', company: '#t-co', 'new-password': '#t-p1', 'confirm-password': '#t-p2' },
  steps: [{ kind: 'signup', expected: [r('#t-name', 'full-name'), r('#t-mail', 'username'), r('#t-tel', 'phone'), r('#t-co', 'company'), r('#t-p1', 'new-password'), r('#t-p2', 'confirm-password')] }],
});

fx({
  id: 'signup-05', category: su, brand: 'Quillfin', theme: 'grape', header: 'navbar', footer: 'lang',
  description: 'Single password with autocomplete=new-password, a live strength meter and a Show toggle, on a page whose nav and copy say Sign in repeatedly.',
  title: 'Sign up - Quillfin',
  css: `.meter{height:6px;background:var(--line);border-radius:3px;overflow:hidden}.meter i{display:block;height:100%;width:0;background:var(--accent)}`,
  main: `<div class="narrow box"><h1>Join Quillfin</h1><p class="muted">Have an account? <a href="#">Sign in here</a>. Prefer SSO? <a href="#">Sign in with your company</a>.</p><form onsubmit="return false"><div class="row"><label for="q-em">Email</label><input id="q-em" name="user_email" type="email" autocomplete="email"></div><div class="row"><label for="q-pw">Password</label><input id="q-pw" name="user_password" type="password" autocomplete="new-password"><div class="meter"><i id="meter"></i></div></div><button type="button" class="linkbtn" id="q-show">Show password</button><p><button>Sign up</button></p></form></div>`,
  script: `var pw=document.getElementById('q-pw');pw.addEventListener('input',function(){document.getElementById('meter').style.width=Math.min(100,pw.value.length*8)+'%';});document.getElementById('q-show').addEventListener('click',function(){pw.type=pw.type==='password'?'text':'password';});`,
  state: { username: '#q-em', 'new-password': '#q-pw' },
  steps: [{ kind: 'signup', expected: [r('#q-em', 'username'), r('#q-pw', 'new-password')] }],
});

fx({
  id: 'signup-06', category: su, brand: 'Cobalt Ferret Games', theme: 'night', header: 'navbar', footer: 'legal',
  description: 'No form element, BEM and data-testid hooks: username, email, password, repeat, then birth date selects that must stay untouched.',
  title: 'Create your Player ID',
  css: `.reg__row{margin-bottom:12px}.reg__row input{width:100%}.reg__dob{display:flex;gap:6px}`,
  main: `<div class="narrow box reg"><h1 class="reg__title">Create your Player ID</h1><div class="reg__row"><div id="rl1">Player name</div><input data-testid="reg-username" aria-labelledby="rl1"></div><div class="reg__row"><div id="rl2">Email</div><input data-testid="reg-email" aria-labelledby="rl2" type="email"></div><div class="reg__row"><div id="rl3">Password</div><input data-testid="reg-pass" aria-labelledby="rl3" type="password"></div><div class="reg__row"><div id="rl4">Repeat password</div><input data-testid="reg-pass2" aria-labelledby="rl4" type="password"></div><div class="reg__row"><div>Date of birth</div><div class="reg__dob"><select name="dob_d" aria-label="Day"><option>1</option><option>2</option></select><select name="dob_m" aria-label="Month"><option>Jan</option><option>Feb</option></select><select name="dob_y" aria-label="Year"><option>1999</option><option>2000</option></select></div></div><button type="button" data-testid="reg-submit">Create ID</button></div>`,
  state: { username: '[data-testid="reg-username"]', email: '[data-testid="reg-email"]', 'new-password': '[data-testid="reg-pass"]', 'confirm-password': '[data-testid="reg-pass2"]' },
  steps: [{ kind: 'signup', expected: [r('[data-testid="reg-username"]', 'username'), r('[data-testid="reg-email"]', 'email'), r('[data-testid="reg-pass"]', 'new-password'), r('[data-testid="reg-pass2"]', 'confirm-password')] }],
});

fx({
  id: 'signup-07', category: su, brand: 'Dunmarrow County Library', theme: 'paper', header: 'utility', footer: 'links',
  description: 'Sign-up with a Sign-in form on the same page: a compact sign-in in the sidebar must be ignored while the main registration is the target; both have password inputs.',
  title: 'Join the library',
  main: `<div class="split"><form class="box" id="join" onsubmit="return false"><h1>Join the library</h1><div class="row"><label for="j-name">Your full name</label><input id="j-name" name="fullname"></div><div class="row"><label for="j-mail">Email</label><input id="j-mail" name="email" type="email"></div><div class="row"><label for="j-p">New password</label><input id="j-p" name="newpass" type="password" autocomplete="new-password"></div><div class="row"><label for="j-p2">Type it again</label><input id="j-p2" name="newpass2" type="password" autocomplete="new-password"></div><button>Join</button></form>
  <aside class="box" id="have"><h2>Already a member?</h2><form onsubmit="return false"><div class="row"><label for="a-card">Library card no</label><input id="a-card" name="card"></div><div class="row"><label for="a-pin">PIN</label><input id="a-pin" name="pin" type="password"></div><button>Log in</button></form></aside></div>`,
  state: { 'full-name': '#j-name', username: '#j-mail', 'new-password': '#j-p', 'confirm-password': '#j-p2' },
  steps: [{ kind: 'signup', expected: [r('#j-name', 'full-name'), r('#j-mail', 'username'), r('#j-p', 'new-password'), r('#j-p2', 'confirm-password')], honeypots: ['#a-card', '#a-pin'] }],
});

// ---------------------------------------------------------------- change-password

const cp = 'change-password';

fx({
  id: 'change-password-01', category: cp, brand: 'Acme Ledger', theme: 'slate', header: 'bar', footer: 'legal',
  description: 'Settings page: current, new and confirm with explicit labels; a side nav of settings and the header search around it.',
  title: 'Security settings - Acme Ledger',
  css: `.settings{display:grid;grid-template-columns:180px minmax(0,1fr);gap:28px}.settings ul{list-style:none;padding:0}@media(max-width:640px){.settings{grid-template-columns:minmax(0,1fr)}}`,
  main: `<div class="settings"><nav aria-label="Settings"><ul><li><a href="#">Profile</a></li><li><a href="#"><b>Security</b></a></li><li><a href="#">Billing</a></li><li><a href="#">Notifications</a></li></ul></nav><form class="box" onsubmit="return false"><h1>Change password</h1><div class="row"><label for="cur">Current password</label><input id="cur" name="current_password" type="password" autocomplete="current-password"></div><div class="row"><label for="nw">New password</label><input id="nw" name="new_password" type="password" autocomplete="new-password"></div><div class="row"><label for="cf">Confirm new password</label><input id="cf" name="confirm_password" type="password" autocomplete="new-password"></div><button>Update password</button></form></div>`,
  state: { 'current-password': '#cur', 'new-password': '#nw', 'confirm-password': '#cf' },
  steps: [{ kind: 'change-password', expected: [r('#cur', 'current-password'), r('#nw', 'new-password'), r('#cf', 'confirm-password')] }],
});

fx({
  id: 'change-password-02', category: cp, brand: 'Stonebarrow Council Services', theme: 'forest', header: 'minimal', footer: 'legal',
  description: 'Expired-password interstitial with new and confirm only, no current field: You must change your password. Opaque names p1 and p2.',
  title: 'Password expired',
  main: `<div class="narrow box"><h1>Your password has expired</h1><p>For security, staff passwords must be changed every 180 days. Pick something you have not used before.</p><form onsubmit="return false"><div class="row"><label for="p1">New password</label><input id="p1" name="p1" type="password"></div><div class="row"><label for="p2">Re-enter new password</label><input id="p2" name="p2" type="password"></div><button>Set password</button></form></div>`,
  state: { 'new-password': '#p1', 'confirm-password': '#p2' },
  steps: [{ kind: 'change-password', expected: [r('#p1', 'new-password'), r('#p2', 'confirm-password')] }],
});

fx({
  id: 'change-password-03', category: cp, brand: 'Galdric', theme: 'corp', header: 'none', footer: 'lang',
  description: 'Reset-password page with an emailed code plus new and confirm: three boxes where the first is an OTP, not a current password.',
  title: 'Reset your password',
  main: `<div class="narrow box" style="margin-top:40px"><h1>Reset your password</h1><p>We emailed a 6-digit reset code to r&hellip;@example.test.</p><form onsubmit="return false"><div class="row"><label for="rc">Reset code</label><input id="rc" name="reset_code" inputmode="numeric" maxlength="6"></div><div class="row"><label for="np">New password</label><input id="np" name="password" type="password"></div><div class="row"><label for="np2">Confirm password</label><input id="np2" name="password_again" type="password"></div><button>Reset password</button></form></div>`,
  state: { otp: '#rc', 'new-password': '#np', 'confirm-password': '#np2' },
  steps: [{ kind: 'change-password', expected: [r('#rc', 'otp'), r('#np', 'new-password'), r('#np2', 'confirm-password')] }],
});

fx({
  id: 'change-password-04', category: cp, brand: 'Sundial Payroll', theme: 'sun', header: 'utility', footer: 'links',
  description: 'Long account page with a Profile form (name, email, phone) and a Password form below it; the profile boxes must not be filled when changing password.',
  title: 'My profile',
  main: `<h1>My profile</h1><form class="box" id="profile" style="margin-bottom:20px" onsubmit="return false"><h2>Contact details</h2><div class="row"><label for="pf-name">Display name</label><input id="pf-name" name="display_name" value="Pat Example"></div><div class="row"><label for="pf-mail">Contact email</label><input id="pf-mail" name="contact" type="email" value="pat@example.test"></div><div class="row"><label for="pf-tel">Phone</label><input id="pf-tel" name="tel" type="tel"></div><button>Save details</button></form>
  <form class="box" id="pwform" onsubmit="return false"><h2>Password</h2><div class="row"><label for="pw-now">Current password</label><input id="pw-now" name="pw_now" type="password"></div><div class="row"><label for="pw-new">New password</label><input id="pw-new" name="pw_new" type="password"></div><div class="row"><label for="pw-rep">Repeat new password</label><input id="pw-rep" name="pw_rep" type="password"></div><button>Change password</button></form>`,
  state: { 'current-password': '#pw-now', 'new-password': '#pw-new', 'confirm-password': '#pw-rep' },
  steps: [{ kind: 'change-password', expected: [r('#pw-now', 'current-password'), r('#pw-new', 'new-password'), r('#pw-rep', 'confirm-password')], honeypots: ['#pf-name', '#pf-mail', '#pf-tel'] }],
});

fx({
  id: 'change-password-05', category: cp, brand: 'Harrowgate Mutual', theme: 'retro', header: 'table', footer: 'table',
  description: 'Old-style table form with vague names old, new1 and new2, sibling-cell labels, and no autocomplete hints.',
  title: 'Change Your Password',
  css: `.t td{padding:4px 8px}`,
  main: `<h3>Change Your Password</h3><p><font size="2">Passwords are case sensitive and must be 8 to 16 characters.</font></p><form name="chg" onsubmit="return false"><table class="t"><tr><td align="right">Old:</td><td><input type="password" name="old" size="20"></td></tr><tr><td align="right">New:</td><td><input type="password" name="new1" size="20"></td></tr><tr><td align="right">Verify:</td><td><input type="password" name="new2" size="20"></td></tr><tr><td></td><td><input type="submit" value="Change"></td></tr></table></form>`,
  state: { 'current-password': 'input[name="old"]', 'new-password': 'input[name="new1"]', 'confirm-password': 'input[name="new2"]' },
  steps: [{ kind: 'change-password', expected: [r('input[name="old"]', 'current-password'), r('input[name="new1"]', 'new-password'), r('input[name="new2"]', 'confirm-password')] }],
});

fx({
  id: 'change-password-06', category: cp, brand: 'Hollowmere Mail', theme: 'paper', header: 'navbar', footer: 'links',
  description: 'Reset page reached from an emailed link: a read-only email shown as context plus a hidden username and token, then new and confirm.',
  title: 'Choose a new password',
  main: `<form class="narrow box" onsubmit="return false"><h1>Choose a new password</h1><input type="hidden" name="reset_token" value="static-token-placeholder"><input type="hidden" id="hint-user" name="username" value="pat@example.test" autocomplete="username"><div class="row"><label for="ro-mail">Account</label><input id="ro-mail" readonly value="pat@example.test"></div><div class="row"><label for="nx1">New password</label><input id="nx1" name="pass1" type="password" autocomplete="new-password"></div><div class="row"><label for="nx2">Confirm</label><input id="nx2" name="pass2" type="password" autocomplete="new-password"></div><button>Save password</button></form>`,
  state: { 'new-password': '#nx1', 'confirm-password': '#nx2' },
  steps: [{ kind: 'change-password', expected: [r('#nx1', 'new-password'), r('#nx2', 'confirm-password')], honeypots: ['#hint-user', '#ro-mail'] }],
});

fx({
  id: 'change-password-07', category: cp, brand: 'Cobalt Ferret Games', theme: 'night', header: 'navbar', footer: 'legal',
  description: 'Current and new only, no confirm box, with a Show toggle on the new password and an Account Security heading; includes a delete-account danger zone below.',
  title: 'Account security',
  main: `<div class="narrow"><h1>Account security</h1><form class="box" onsubmit="return false"><div class="row"><label for="c-cur">Your current password</label><input id="c-cur" name="pass_cur" type="password"></div><div class="row"><label for="c-new">Your new password</label><input id="c-new" name="pass_new" type="password"></div><button type="button" class="linkbtn" id="c-show">Show new password</button><p><button>Save</button></p></form><section class="box" style="margin-top:20px;border-color:#c33"><h2>Danger zone</h2><p>Type DELETE to close this account.</p><input id="c-del" name="confirm_delete" placeholder="DELETE"> <button type="button">Close account</button></section></div>`,
  script: `document.getElementById('c-show').addEventListener('click',function(){var i=document.getElementById('c-new');i.type=i.type==='password'?'text':'password';});`,
  state: { 'current-password': '#c-cur', 'new-password': '#c-new' },
  steps: [{ kind: 'change-password', expected: [r('#c-cur', 'current-password'), r('#c-new', 'new-password')], honeypots: ['#c-del'] }],
});
