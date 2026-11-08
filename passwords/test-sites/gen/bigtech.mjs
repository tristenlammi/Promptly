// Multi-step sign-ins in the style of the biggest account providers, written from what
// anyone can see using them: the identifier step, a transition in the same page, the
// password step with the account shown as text and a hidden username kept for password
// managers, and the steps after. Invented brands and markup; nothing is copied.
import { flowJs, fx, parentMerge } from './kit.mjs';

const ms = 'multi-step';
const u = (selector, frame) => ({ selector, role: 'username', ...(frame ? { frame } : {}) });
const p = (selector, frame) => ({ selector, role: 'password', ...(frame ? { frame } : {}) });

// ------------------------------------------------------------ a big account provider, one page

fx({
  id: 'multi-step-13', category: ms, brand: 'Orrin', theme: 'slate', header: 'none', footer: 'lang',
  description: 'Account-provider style, no form element: identifier box with a floating label and a hidden password trap, Next shows a progress bar and greys the step, the password step is rendered at once but kept hidden until the answer comes back, then the URL changes by pushState and the step slides in with the account as a chip, a visually hidden username carrier, Show password, and the box focused by the page once the slide ends.',
  title: 'Sign in - Orrin Accounts',
  css: `.ow-card{position:relative;overflow:hidden;max-width:450px;margin:48px auto;border:1px solid var(--line);border-radius:28px;padding:36px 40px;background:var(--card)}
.ow-bar{position:absolute;left:0;top:0;height:4px;width:0;background:var(--accent);transition:width .4s}.ow-bar.go{width:100%}
.ow-logo{font-weight:700;font-size:1.3em;color:var(--accent)}
.ow-step{transition:transform .3s ease,opacity .3s ease}.ow-step.enter{transform:translateX(56px);opacity:0}.ow-step.leave{opacity:.45}.ow-step.pending{position:absolute;visibility:hidden}
.ow-field{position:relative;margin:24px 0 8px}
.ow-in{width:100%;height:56px;padding:18px 14px 2px;border:1px solid var(--line);border-radius:4px;font-size:16px;background:transparent}
.ow-label{position:absolute;left:11px;top:16px;padding:0 4px;color:var(--soft);pointer-events:none;transition:transform .15s;transform-origin:left top}
.ow-field.up .ow-label{transform:translateY(-26px) scale(.75);background:var(--card)}
.ow-vh{position:absolute;left:0;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none}
.ow-act{display:flex;justify-content:space-between;align-items:center;margin-top:32px}
.ow-chip{display:inline-flex;gap:8px;align-items:center;border:1px solid var(--line);border-radius:16px;padding:2px 10px 2px 3px;cursor:pointer}
.ow-av{width:24px;height:24px;border-radius:50%;background:var(--accent);color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:12px}
.ow-text{background:none;color:var(--accent);padding:0;font-weight:600}`,
  main: `<div class="ow-card" id="ow"></div>`,
  script: `var S={username:'',password:''};var card=document.getElementById('ow');
function lift(f){var w=f.closest('.ow-field');var up=function(){w.classList.toggle('up',document.activeElement===f||!!f.value);};f.addEventListener('focus',up);f.addEventListener('blur',up);f.addEventListener('input',up);up();}
function ident(){card.innerHTML='<div class="ow-bar" id="bar"></div><div class="ow-step" id="st1"><div class="ow-logo">Orrin</div><h1>Sign in</h1><p>Use your Orrin Account</p>'
+'<div class="ow-field"><input type="email" class="ow-in" id="identifierId" name="identifier" autocomplete="username webauthn" spellcheck="false" tabindex="0" aria-label="Email or phone" autocapitalize="none" dir="ltr" data-initial-value=""><div class="ow-label" aria-hidden="true">Email or phone</div></div>'
+'<input type="password" name="hiddenPassword" id="hiddenPassword" class="ow-vh" tabindex="-1" aria-hidden="true" spellcheck="false">'
+'<button type="button" class="ow-text">Forgot email?</button>'
+'<p class="muted">Not your computer? Use a guest window to sign in privately. <a href="#">Learn more</a></p>'
+'<div class="ow-act"><button type="button" class="ow-text" aria-haspopup="menu">Create account</button><div id="identifierNext"><button type="button" id="idNext"><span>Next</span></button></div></div></div>';
var i=document.getElementById('identifierId');i.value=S.username;i.addEventListener('input',function(){S.username=i.value;});lift(i);
i.addEventListener('keydown',function(e){if(e.key==='Enter')next();});document.getElementById('idNext').addEventListener('click',next);i.focus();}
function next(){if(!S.username)return;document.getElementById('bar').classList.add('go');var st=document.getElementById('st1');st.classList.add('leave');st.inert=true;pass();
setTimeout(function(){history.pushState({},'',location.pathname+'?challenge=pwd');st.remove();var st2=document.getElementById('st2');st2.classList.remove('pending');requestAnimationFrame(function(){requestAnimationFrame(function(){st2.classList.remove('enter');});});},700);}
function pass(){card.insertAdjacentHTML('beforeend','<div class="ow-step enter pending" id="st2"><div class="ow-logo">Orrin</div><h1>Welcome</h1>'
+'<div class="ow-chip" role="link" tabindex="0" id="chip"><span class="ow-av">A</span><span id="who"></span><span aria-hidden="true">&#9662;</span></div>'
+'<div class="ow-vh" aria-hidden="true"><input type="email" name="identifier" id="hiddenIdent" autocomplete="username" tabindex="-1" spellcheck="false"></div>'
+'<div class="ow-field"><input type="password" class="ow-in" name="Passwd" id="pwField" autocomplete="current-password" spellcheck="false" tabindex="0" aria-label="Enter your password" autocapitalize="off" dir="ltr" data-initial-value=""><div class="ow-label" aria-hidden="true">Enter your password</div></div>'
+'<label style="font-weight:400"><input type="checkbox" id="showpw"> Show password</label>'
+'<div class="ow-act"><button type="button" class="ow-text">Try another way</button><div id="passwordNext"><button type="button" id="pwNext"><span>Next</span></button></div></div></div>');
document.getElementById('who').textContent=S.username;document.getElementById('chip').setAttribute('data-email',S.username);
var h=document.getElementById('hiddenIdent');h.value=S.username;h.setAttribute('value',S.username);
var pw=document.getElementById('pwField');pw.addEventListener('input',function(){S.password=pw.value;});lift(pw);
document.getElementById('showpw').addEventListener('change',function(){pw.type=this.checked?'text':'password';});
var st=document.getElementById('st2');
st.addEventListener('transitionend',function once(e){if(e.target!==st)return;st.removeEventListener('transitionend',once);pw.focus();card.setAttribute('data-settled','pwd');});}
ident();window.__fixture={state:function(){return S;}};`,
  steps: [
    { kind: 'email-first', wait: '#identifierId', expected: [u('#identifierId')], honeypots: ['#hiddenPassword'], advance: { click: '#idNext' } },
    { kind: 'password-next', wait: '#ow[data-settled="pwd"]', expected: [p('#pwField')], honeypots: ['#hiddenIdent'] },
  ],
});

// ------------------------------------------------------------ an enterprise provider, one form for every step

fx({
  id: 'multi-step-14', category: ms, brand: 'Halvard Online', theme: 'corp', header: 'none', footer: 'legal',
  description: 'Enterprise-provider style: one form with autocomplete=off holds every step. The identifier section is set display:none (its value kept) when the password section shows, an identity banner with a Back arrow names the account, the same submit input turns from Next into Sign in, and a Stay signed in? step with Yes and No follows in the same form.',
  title: 'Sign in to your account',
  css: `.hv-box{max-width:440px;margin:60px auto;background:var(--card);padding:44px;box-shadow:0 2px 6px rgba(0,0,0,.2)}.hv-logo{font-weight:700;color:var(--accent);margin-bottom:16px}.hv-title{font-size:1.5em;font-weight:600;margin:6px 0 14px}
.hv-in{width:100%;border:0;border-bottom:1px solid #666;border-radius:0;padding:6px 0;background:transparent}.hv-small{font-size:.85em;margin:12px 0}.hv-btns{text-align:right;margin-top:24px}
.hv-banner{display:flex;align-items:center;gap:8px}.hv-back{background:none;color:var(--fg);padding:0 4px;font-size:1.2em}`,
  main: `<div class="hv-box"><div class="hv-logo">Halvard</div>
<form name="f1" id="f1" method="post" novalidate autocomplete="off" action="#">
<input type="hidden" name="login" id="hLogin"><input type="hidden" name="type" value="11"><input type="hidden" name="flowToken" value="AbCdEf0123">
<div id="views">
<div id="identSection"><div role="heading" aria-level="1" class="hv-title" id="loginHeader">Sign in</div>
<input type="email" name="loginfmt" id="i0116" maxlength="113" lang="en" class="hv-in" aria-required="true" aria-describedby="loginHeader" placeholder="Email, phone, or handle" aria-label="Enter your email, phone, or handle." autocomplete="username">
<div class="hv-small">No account? <a href="#">Create one!</a></div><div class="hv-small"><a href="#">Can&rsquo;t access your account?</a></div></div>
<div id="pwdSection" style="display:none"><div class="hv-banner"><button type="button" class="hv-back" id="idBtn_Back" aria-label="Back">&larr;</button><div id="displayName"></div></div>
<div role="heading" aria-level="1" class="hv-title">Enter password</div>
<input name="passwd" type="password" id="i0118" autocomplete="current-password" class="hv-in" aria-required="true" placeholder="Password" aria-label="Enter the password for your account" tabindex="0">
<div class="hv-small"><a href="#">Forgot password?</a></div></div>
</div>
<div class="hv-btns"><input type="submit" id="idSIButton9" value="Next"></div>
</form></div>`,
  script: `var S={username:'',password:''};var step=1;var f=document.getElementById('f1');
var e=document.getElementById('i0116');e.addEventListener('input',function(){S.username=e.value;});
var pw=document.getElementById('i0118');pw.addEventListener('input',function(){S.password=pw.value;});
document.getElementById('idBtn_Back').addEventListener('click',function(){step=1;document.getElementById('identSection').style.display='';document.getElementById('pwdSection').style.display='none';document.getElementById('idSIButton9').value='Next';});
f.addEventListener('submit',function(ev){ev.preventDefault();
 if(step===1){if(!S.username)return;step=2;document.getElementById('hLogin').value=S.username;document.getElementById('displayName').textContent=S.username;
  setTimeout(function(){document.getElementById('identSection').style.display='none';document.getElementById('pwdSection').style.display='';document.getElementById('idSIButton9').value='Sign in';pw.focus();f.setAttribute('data-step','pwd');},350);}
 else if(step===2){if(!S.password)return;step=3;setTimeout(function(){document.getElementById('views').innerHTML='<div class="hv-title" role="heading" aria-level="1">Stay signed in?</div><p>Do this to reduce the number of times you are asked to sign in.</p><label style="font-weight:400"><input type="checkbox" name="DontShowAgain"> Don&rsquo;t show this again</label>';
  document.querySelector('.hv-btns').innerHTML='<input type="button" id="idBtn_No" value="No"> <input type="submit" id="idSIButton9" value="Yes">';f.setAttribute('data-step','kmsi');},350);}
});
window.__fixture={state:function(){return S;}};`,
  steps: [
    { kind: 'email-first', expected: [u('#i0116')], advance: { click: '#idSIButton9' } },
    { kind: 'password-next', wait: '#f1[data-step="pwd"]', expected: [p('#i0118')], advance: { click: '#idSIButton9' } },
    { kind: 'none', wait: '#f1[data-step="kmsi"]', expected: [] },
  ],
});

// ------------------------------------------------------------ a device maker's sign-in, inside a frame from another site

const pomeroyFrame = `<div class="aid"><h1 class="aid-title" id="aid-h">Sign in with Pomeroy ID</h1>
<div id="aid-body"><div class="aid-fields">
<div class="ftb"><input type="text" id="account_name_text_field" class="ftb-in" autocomplete="username webauthn" autocapitalize="off" autocorrect="off" spellcheck="false" aria-required="true" required can-field="accountName" placeholder=" "><label for="account_name_text_field" class="ftb-lbl">Email or Phone Number</label></div>
<div class="pw-wrap hide" id="pw-wrap" aria-hidden="true"><div class="ftb"><input type="password" id="password_text_field" class="ftb-in" autocomplete="current-password" aria-required="true" required can-field="password" tabindex="-1" placeholder=" "><label for="password_text_field" class="ftb-lbl">Password</label></div></div>
<button id="sign-in" class="si-button" type="button" aria-label="Continue">&#8594;</button></div>
<label class="kmsi"><input type="checkbox" id="remember-me"> Keep me signed in</label>
<p class="aid-links"><a href="#">Forgot password?</a><br><a href="#">Create Pomeroy ID</a></p></div></div>`;

fx({
  id: 'multi-step-15', category: ms, brand: 'Pomeroy', host: 'a.localhost', theme: 'paper', header: 'bar', footer: 'links',
  description: 'Device-maker style: the sign-in widget is a frame from another site (b.localhost). The password box is in the frame from the start but collapsed, aria-hidden and tabindex=-1; the round arrow button (aria-label only) reveals it under a still-editable username; then six one-digit verification boxes replace the form in the same frame.',
  title: 'Pomeroy ID',
  main: `<h1>Pomeroy ID</h1><p>One account for every Pomeroy device and service.</p><iframe id="auth-frame" title="Sign In with Pomeroy ID" src="http://b.localhost:__PORT__/fixtures/_frames/multi-step-15.html" style="border:0;width:100%;max-width:480px;height:420px;background:var(--card)"></iframe>`,
  pages: [{
    path: '_frames/multi-step-15.html', header: 'none', footer: 'none', title: 'Sign In', bare: true, theme: 'paper',
    css: `.aid{padding:24px 28px;font-family:system-ui,sans-serif}.aid-title{font-size:1.4em}.aid-fields{position:relative;border:1px solid #aaa;border-radius:12px;overflow:hidden}
.ftb{position:relative}.ftb-in{width:100%;border:0;border-radius:0;padding:22px 52px 6px 14px;background:#fff}.ftb-lbl{position:absolute;left:15px;top:15px;color:#888;pointer-events:none;transition:all .12s}
.ftb-in:focus+.ftb-lbl,.ftb-in:not(:placeholder-shown)+.ftb-lbl{top:4px;font-size:.72em}
.pw-wrap{border-top:1px solid #aaa;transition:height .25s ease,opacity .25s ease;height:54px}.pw-wrap.hide{height:0;opacity:0;overflow:hidden;border-top:0}
.si-button{position:absolute;right:10px;top:12px;width:30px;height:30px;border-radius:50%;border:1px solid #888;background:#fff;color:#333;padding:0}
.kmsi{display:block;margin:16px 0;font-weight:400}.aid-links{text-align:center}.code{display:flex;gap:10px;justify-content:center;margin:20px 0}.code input{width:44px;height:52px;text-align:center;font-size:1.4em}`,
    main: pomeroyFrame,
    script: `var S={username:'',password:'',otp:''};function send(){parent.postMessage({__fx:S},'*');}window.__fixture={state:function(){return S;}};
var a=document.getElementById('account_name_text_field');a.addEventListener('input',function(){S.username=a.value;send();});
var p=document.getElementById('password_text_field');p.addEventListener('input',function(){S.password=p.value;send();});
var b=document.getElementById('sign-in');var stage=1;
b.addEventListener('click',function(){
 if(stage===1){if(!a.value)return;stage=2;var w=document.getElementById('pw-wrap');w.classList.remove('hide');w.removeAttribute('aria-hidden');p.tabIndex=0;b.setAttribute('aria-label','Sign In');b.style.top='66px';
  w.addEventListener('transitionend',function once(e){if(e.target!==w||e.propertyName!=='height')return;w.removeEventListener('transitionend',once);p.focus();parent.postMessage({__stage:'pw'},'*');});}
 else if(stage===2){if(!p.value)return;stage=3;setTimeout(function(){document.getElementById('aid-h').textContent='Two-Factor Authentication';
  var html='<p>A message with a verification code has been sent to your devices. Enter the code to continue.</p><div class="code">';for(var i=1;i<=6;i++)html+='<input type="tel" class="form-security-code-input" maxlength="1" autocomplete="off" aria-label="Enter verification code. Digit '+i+'" id="d'+i+'">';
  html+='</div><p class="aid-links"><a href="#">Didn&rsquo;t get a verification code?</a></p>';document.getElementById('aid-body').innerHTML=html;
  var boxes=[].slice.call(document.querySelectorAll('.code input'));boxes.forEach(function(x,k){x.addEventListener('input',function(){S.otp=boxes.map(function(y){return y.value;}).join('');send();if(x.value&&boxes[k+1])boxes[k+1].focus();});});
  boxes[0].focus();parent.postMessage({__stage:'code'},'*');},400);}
});`,
  }],
  // The frame says when a step has settled, so the harness can wait on this page.
  script: parentMerge({ username: '', password: '', otp: '' }) + `
window.addEventListener('message',function(e){if(e.data&&e.data.__stage)document.body.setAttribute('data-frame-stage',e.data.__stage);});`,
  steps: [
    { kind: 'email-first', wait: '#auth-frame', expected: [u('#account_name_text_field', ['#auth-frame'])], advance: { click: '#sign-in', frame: ['#auth-frame'] } },
    { kind: 'signin', wait: 'body[data-frame-stage="pw"]', expected: [u('#account_name_text_field', ['#auth-frame']), p('#password_text_field', ['#auth-frame'])], advance: { click: '#sign-in', frame: ['#auth-frame'] } },
    { kind: 'otp', wait: 'body[data-frame-stage="code"]', expected: [1, 2, 3, 4, 5, 6].map((n) => ({ selector: `#d${n}`, role: 'otp-digit', frame: ['#auth-frame'] })) },
  ],
});

// ------------------------------------------------------------ a big shop, three real pages

const bmFlow = (n) => `_steps/multi-step-16-${n}.html`;
const bmUrl = (n) => `/fixtures/${bmFlow(n)}`;
const bmCss = `.bm{max-width:350px;margin:24px auto}.bm-logo{text-align:center;font-weight:700;font-size:1.5em;margin-bottom:14px}.bm-box{border:1px solid var(--line);border-radius:8px;padding:20px 26px}
.bm-box h1{font-size:1.6em;font-weight:400}.bm-lbl{display:block;font-weight:700;font-size:.85em;margin:10px 0 2px}.bm-in{width:100%}
.bm-btn{position:relative;display:block;margin:14px 0;background:#f7ca00;border-radius:8px;text-align:center;padding:6px}.bm-btn input{position:absolute;inset:0;width:100%;height:100%;opacity:.01;cursor:pointer}.bm-btn span{color:#111}
.bm-small{font-size:.8em}.bm-div{text-align:center;color:var(--soft);font-size:.8em;margin:20px 0 8px}`;
const bmHidden = `<input type="hidden" name="appActionToken" value="pmQ2j3F0x1"><input type="hidden" name="appAction" value="SIGNIN"><input type="hidden" name="workflowState" value="eyJ6aXAiOiJERUYifQ">`;

fx({
  id: 'multi-step-16', category: ms, brand: 'Brightmarket', theme: 'corp', header: 'none', footer: 'legal',
  description: 'Big-shop style over three real pages. Page one: an email-or-mobile box and a Continue submit input whose text comes only from aria-labelledby. Page two: the email as text with a Change link and a hidden input, the password, Keep me signed in. Page three: a two-step verification code in a type=tel box with maxlength 20 and autocomplete=off, labelled Enter OTP.',
  title: 'Brightmarket Sign-In',
  css: bmCss,
  main: `<div class="bm"><div class="bm-logo">brightmarket</div><div class="bm-box"><h1>Sign in</h1>
<form name="signIn" id="bm1" method="post" novalidate action="${bmUrl(2)}" class="auth-validate-form">${bmHidden}
<label for="ap_email" class="bm-lbl">Email or mobile phone number</label><input type="email" maxlength="128" id="ap_email" autocomplete="username" name="email" class="bm-in auth-autofill-username auth-required-field">
<span class="bm-btn"><input id="continue" type="submit" aria-labelledby="continue-announce"><span id="continue-announce">Continue</span></span>
<p class="bm-small">By continuing, you agree to Brightmarket&rsquo;s Conditions of Use and Privacy Notice.</p><details class="bm-small"><summary>Need help?</summary><a href="#">Forgot your password?</a><br><a href="#">Other issues with Sign-In</a></details></form></div>
<div class="bm-div">New to Brightmarket?</div><p><a href="#" class="bm-small">Create your Brightmarket account</a></p></div>`,
  script: flowJs({ flow: 'ms16', first: true, fields: { username: '#ap_email' }, next: bmUrl(2), submitSel: '#bm1' }),
  pages: [{
    path: bmFlow(2), title: 'Brightmarket Sign-In', css: bmCss,
    main: `<div class="bm"><div class="bm-logo">brightmarket</div><div class="bm-box"><h1>Sign in</h1>
<p><span id="bm-who"></span> <a href="${'/fixtures/multi-step-16.html'}">Change</a></p>
<form name="signIn" id="bm2" method="post" novalidate action="${bmUrl(3)}">${bmHidden}<input type="hidden" name="email" id="bm-email-carrier">
<div style="display:flex;justify-content:space-between"><label for="ap_password" class="bm-lbl">Password</label><a href="#" class="bm-small">Forgot your password?</a></div>
<input type="password" id="ap_password" name="password" autocomplete="current-password" maxlength="1024" class="bm-in auth-autofill-password auth-required-field">
<span class="bm-btn"><input id="signInSubmit" type="submit" aria-labelledby="auth-signin-button-announce"><span id="auth-signin-button-announce">Sign in</span></span>
<label class="bm-small" style="font-weight:400"><input type="checkbox" name="rememberMe" value="true"> Keep me signed in. <a href="#">Details</a></label></form></div></div>`,
    script: flowJs({ flow: 'ms16', fields: { password: '#ap_password' }, next: bmUrl(3), submitSel: '#bm2', afterLoad: `document.getElementById('bm-who').textContent=S.username||'';document.getElementById('bm-email-carrier').value=S.username||'';` }),
  }, {
    path: bmFlow(3), title: 'Two-Step Verification', css: bmCss,
    main: `<div class="bm"><div class="bm-logo">brightmarket</div><div class="bm-box"><h1>Two-Step Verification</h1>
<p class="bm-small">For added security, please enter the One Time Password (OTP) generated by your Authenticator App.</p>
<form name="signIn" id="bm3" method="post" novalidate action="#" onsubmit="return false">${bmHidden}
<label for="auth-mfa-otpcode" class="bm-lbl">Enter OTP:</label><input type="tel" id="auth-mfa-otpcode" name="otpCode" maxlength="20" autocomplete="off" class="bm-in cvf-widget-input">
<label class="bm-small" style="font-weight:400"><input type="checkbox" name="rememberDevice"> Don&rsquo;t require OTP on this browser</label>
<span class="bm-btn"><input id="auth-signin-button" type="submit" aria-labelledby="otp-announce"><span id="otp-announce">Sign in</span></span>
<p class="bm-small"><a href="#">Didn&rsquo;t receive the OTP?</a></p></form></div></div>`,
    script: flowJs({ flow: 'ms16', fields: { otp: '#auth-mfa-otpcode' } }),
  }],
  steps: [
    { kind: 'email-first', expected: [u('#ap_email')], advance: { goto: bmUrl(2) } },
    { kind: 'password-next', wait: '#ap_password', expected: [p('#ap_password')], advance: { goto: bmUrl(3) } },
    { kind: 'otp', wait: '#auth-mfa-otpcode', expected: [{ selector: '#auth-mfa-otpcode', role: 'otp' }] },
  ],
});
