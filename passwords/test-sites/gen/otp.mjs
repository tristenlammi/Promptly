import { fx, noise } from './kit.mjs';

const cat = 'otp';
const one = (selector) => ({ selector, role: 'otp' });
const digits = (sels) => sels.map((selector) => ({ selector, role: 'otp-digit' }));
const seq = (prefix, n) => Array.from({ length: n }, (_, i) => `#${prefix}${i + 1}`);
const splitCss = `.otp-row{display:flex;gap:8px;margin:14px 0}.otp-row input{width:44px;height:52px;text-align:center;font-size:1.3em;padding:0}`;

const autoAdvance = (sel) => `(function(){var b=[].slice.call(document.querySelectorAll(${JSON.stringify(sel)}));b.forEach(function(x,i){x.addEventListener('input',function(){x.value=x.value.replace(/[^0-9]/g,'').slice(-1);if(x.value&&b[i+1])b[i+1].focus();});x.addEventListener('keydown',function(e){if(e.key==='Backspace'&&!x.value&&b[i-1])b[i-1].focus();});x.addEventListener('paste',function(e){var t=(e.clipboardData.getData('text')||'').replace(/[^0-9]/g,'');if(!t)return;e.preventDefault();t.split('').forEach(function(c,k){if(b[k])b[k].value=c;});});});})();`;

fx({
  id: 'otp-01', category: cat, brand: 'Acme Ledger', theme: 'slate', header: 'navbar', footer: 'legal',
  description: 'Single box with autocomplete=one-time-code, the clean standards-following case; Resend link and a device-trust checkbox.',
  title: 'Verify your sign-in',
  main: `<div class="narrow box"><h1>Enter your code</h1><p>We sent a 6-digit code to pat&hellip;@example.test.</p><form onsubmit="return false"><div class="row"><label for="code1">Verification code</label><input id="code1" name="otc" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" maxlength="6"></div><label style="font-weight:400"><input type="checkbox" name="trust"> Trust this device for 30 days</label><p><button>Verify</button> <a href="#">Resend code</a></p></form></div>`,
  state: { otp: '#code1' },
  steps: [{ kind: 'otp', expected: [one('#code1')] }],
});

fx({
  id: 'otp-02', category: cat, brand: 'Dappermint Pay', theme: 'grape', header: 'minimal', footer: 'news',
  description: 'Six split boxes with auto-advance on input, Backspace returning to the previous box and paste spreading across them. No names or labels; only a group label.',
  title: 'Confirm it is you',
  css: splitCss,
  main: `<div class="narrow box"><h1>Confirm it&rsquo;s you</h1><p id="desc">Type the code we just texted you.</p><div class="otp-row" role="group" aria-labelledby="desc">${seq('sx', 6).map((s) => `<input id="${s.slice(1)}" type="text" inputmode="numeric" maxlength="1">`).join('')}</div><button type="button">Confirm</button></div>`,
  script: autoAdvance('.otp-row input'),
  state: { otp: seq('sx', 6) },
  steps: [{ kind: 'otp', expected: digits(seq('sx', 6)) }],
});

fx({
  id: 'otp-03', category: cat, brand: 'Fernhollow Studio', theme: 'paper', header: 'bar', footer: 'links',
  description: 'Four split boxes for an email verification code, named code[0] to code[3], tucked into a table layout.',
  title: 'Verify your email',
  css: `.pin td{padding:3px}.pin input{width:44px;height:48px;text-align:center}`,
  main: `<div class="narrow box"><h1>Check your inbox</h1><p>Enter the 4-digit code from your email to finish setting up your studio.</p><form onsubmit="return false"><table class="pin"><tr>${[0, 1, 2, 3].map((i) => `<td><input id="fv${i}" name="code[${i}]" type="tel" maxlength="1" autocomplete="off"></td>`).join('')}</tr></table><p><button>Continue</button></p></form></div>`,
  script: autoAdvance('.pin input'),
  state: { otp: ['#fv0', '#fv1', '#fv2', '#fv3'] },
  steps: [{ kind: 'otp', expected: digits(['#fv0', '#fv1', '#fv2', '#fv3']) }],
});

fx({
  id: 'otp-04', category: cat, brand: 'Ironfern Security', theme: 'night', header: 'minimal', footer: 'legal',
  description: 'Split boxes that accept paste only: beforeinput blocks typed input and the app model changes only in the paste handler. Setting box values or typing leaves app state empty.',
  title: 'Paste your code',
  css: splitCss,
  main: `<div class="narrow box"><h1>Paste your code</h1><p>For your security this screen only accepts pasted codes. Copy the code from your authenticator.</p><div class="otp-row" id="pasteonly">${seq('po', 6).map((s, i) => `<input id="${s.slice(1)}" aria-label="Character ${i + 1}" inputmode="numeric" maxlength="1" autocomplete="off">`).join('')}</div><button type="button">Verify</button></div>`,
  script: `var code='';var B=[].slice.call(document.querySelectorAll('#pasteonly input'));B.forEach(function(b){b.addEventListener('beforeinput',function(e){if(e.inputType!=='insertFromPaste')e.preventDefault();});b.addEventListener('paste',function(e){e.preventDefault();var t=(e.clipboardData.getData('text')||'').replace(/[^0-9]/g,'').slice(0,6);code=t;B.forEach(function(x,i){x.value=t.charAt(i);});});});window.__fixture={state:function(){return {otp:code};}};`,
  steps: [{ kind: 'otp', expected: digits(seq('po', 6)) }],
});

fx({
  id: 'otp-05', category: cat, brand: 'Northgale Telecom', theme: 'forest', header: 'utility', footer: 'links',
  description: 'maxlength=1 inputmode=numeric boxes in a div grid with aria-labels Digit N of 6, no auto-advance at all; the user or filler must move between them.',
  title: 'Confirm your SIM swap',
  css: `.pinpad{display:grid;grid-template-columns:repeat(6,44px);gap:6px;margin:14px 0}.pinpad input{width:44px;text-align:center}`,
  main: `<div class="narrow box"><h1>Confirm your SIM swap</h1><p>Enter the 6-digit number sent to your old SIM.</p><div class="pinpad">${seq('dg', 6).map((s, i) => `<input id="${s.slice(1)}" type="tel" inputmode="numeric" maxlength="1" aria-label="Digit ${i + 1} of 6">`).join('')}</div><button type="button">Confirm</button></div>${noise.features('Northgale')}`,
  state: { otp: seq('dg', 6) },
  steps: [{ kind: 'otp', expected: digits(seq('dg', 6)) }],
});

fx({
  id: 'otp-06', category: cat, brand: 'Sable Notes', theme: 'slate', header: 'bar', footer: 'lang',
  description: 'Single plain text box named code with no autocomplete and a generic label; only the heading says this is a sign-in code.',
  title: 'Almost there',
  main: `<div class="narrow box"><h1>Almost there</h1><p>Enter the sign-in code from your email.</p><form onsubmit="return false"><div class="row"><label for="c">Code</label><input id="c" name="code" type="text"></div><button>Continue</button></form></div>`,
  state: { otp: '#c' },
  steps: [{ kind: 'otp', expected: [one('#c')] }],
});

fx({
  id: 'otp-07', category: cat, brand: 'Brindlewood Credit Union', theme: 'corp', header: 'utility', footer: 'table',
  description: 'SMS code screen: name=sms_token, the masked phone number in the copy, Resend timer, and a Call me instead option.',
  title: 'Text message verification',
  main: `<div class="narrow box"><h1>Text message verification</h1><p>A message with a one-time SMS code has been sent to (***) ***-4471.</p><form onsubmit="return false"><div class="row"><label for="sms">SMS code</label><input id="sms" name="sms_token" type="tel" maxlength="8" placeholder="Enter code"></div><button>Submit</button></form><p class="muted">Resend available in <span id="t">30</span> seconds. <a href="#">Call me instead</a></p></div>`,
  script: `var n=30;setInterval(function(){if(n>0){n--;document.getElementById('t').textContent=n;}},1000);`,
  state: { otp: '#sms' },
  steps: [{ kind: 'otp', expected: [one('#sms')] }],
});

fx({
  id: 'otp-08', category: cat, brand: 'Tarnhold Cloud', theme: 'night', header: 'minimal', footer: 'legal',
  description: 'Authenticator-app prompt: name=totp, placeholder 123 456, aria-labelledby heading, Remember this browser checkbox and a link to use a backup code instead.',
  title: 'Two-factor authentication',
  main: `<div class="narrow box"><h1 id="tfa">Two-factor authentication</h1><p>Open your authenticator app and enter the current code.</p><form onsubmit="return false"><input id="totp" name="totp" aria-labelledby="tfa" placeholder="123 456" inputmode="numeric" style="width:100%;font-size:1.3em;text-align:center"><p><label style="font-weight:400"><input type="checkbox"> Remember this browser for 14 days</label></p><button>Verify</button><p class="muted"><a href="#">Use a backup code</a></p></form></div>`,
  state: { otp: '#totp' },
  steps: [{ kind: 'otp', expected: [one('#totp')] }],
});

fx({
  id: 'otp-09', category: cat, brand: 'Ombrelle Travel', theme: 'sun', header: 'navbar', footer: 'links',
  description: 'Masked single input formatted as xxx-xxx by JS; the DOM shows the hyphen but the app model holds digits only, with the hyphen typed by the mask.',
  title: 'Confirm your booking changes',
  main: `<div class="narrow box"><h1>Confirm your change</h1><p>We sent a security code to your email. It looks like 123-456.</p><div class="row"><label for="masked">Security code</label><input id="masked" name="securityCode" placeholder="xxx-xxx" maxlength="7" inputmode="numeric" data-mask="000-000"></div><button type="button">Confirm change</button></div>`,
  script: `var digits='';var m=document.getElementById('masked');m.addEventListener('input',function(){digits=m.value.replace(/[^0-9]/g,'').slice(0,6);m.value=digits.length>3?digits.slice(0,3)+'-'+digits.slice(3):digits;});window.__fixture={state:function(){return {otp:digits};}};`,
  steps: [{ kind: 'otp', expected: [one('#masked')] }],
});

fx({
  id: 'otp-10', category: cat, brand: 'Larkspur & Vane', theme: 'paper', header: 'minimal', footer: 'legal',
  description: 'Hardware-token prompt with a type=number input, name=token, spinner hidden by CSS, labelled Security code.',
  title: 'Security key code',
  css: `input[type=number]::-webkit-outer-spin-button,input[type=number]::-webkit-inner-spin-button{appearance:none}`,
  main: `<div class="narrow box"><h1>Security code</h1><p>Press the button on your hardware token and enter the number shown.</p><form onsubmit="return false"><div class="row"><label for="hw">Security code</label><input id="hw" name="token" type="number"></div><button>Submit</button></form></div>`,
  state: { otp: '#hw' },
  steps: [{ kind: 'otp', expected: [one('#hw')] }],
});

fx({
  id: 'otp-11', category: cat, brand: 'Tarnhold Cloud', theme: 'night', header: 'minimal', footer: 'legal', negative: true,
  description: 'Backup-code screen: one box asking for an 8-character recovery code. Must classify as none; a one-time authenticator code would burn or fail here.',
  title: 'Use a backup code',
  main: `<div class="narrow box"><h1>Use a backup code</h1><p>Each backup code works once. Enter one of the codes you saved when you turned on two-factor authentication.</p><form onsubmit="return false"><div class="row"><label for="bk">Backup code</label><input id="bk" name="backup_code" type="text" placeholder="xxxx-xxxx" autocomplete="off"></div><button>Verify</button><p class="muted"><a href="#">Use your authenticator app instead</a></p></form></div>`,
  steps: [{ kind: 'none', expected: [], honeypots: ['#bk'] }],
});

fx({
  id: 'otp-12', category: cat, brand: 'Velvetine Cloud', theme: 'slate', header: 'navbar', footer: 'links', negative: true,
  description: 'Account recovery with a long recovery key in a textarea and a recovery_code text box. Looks like 2FA but is a backup route; must classify as none.',
  title: 'Recover your account',
  main: `<div class="narrow box"><h1>Recover your account</h1><p>Lost your phone? Paste your recovery key, or one of your ten recovery codes.</p><form onsubmit="return false"><div class="row"><label for="rk">Recovery key</label><textarea id="rk" name="recovery_key" rows="3" style="width:100%"></textarea></div><div class="row"><label for="rc">Or a recovery code</label><input id="rc" name="recovery_code" type="text"></div><button>Recover</button></form></div>`,
  steps: [{ kind: 'none', expected: [], honeypots: ['#rk', '#rc'] }],
});
