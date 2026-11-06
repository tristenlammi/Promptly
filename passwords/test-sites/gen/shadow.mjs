import { closedRootsInit, fx, noise } from './kit.mjs';

const cat = 'shadow';

const innerCss = `<style>:host{display:block}label{display:block;font-weight:600;margin:0 0 4px}input{width:100%;box-sizing:border-box;padding:.5em;font:inherit;border:1px solid #bbb;border-radius:4px}.f{margin-bottom:12px}button{font:inherit;padding:.5em 1em;background:#2c5fb3;color:#fff;border:0;border-radius:4px}</style>`;
const innerCssLit = JSON.stringify(innerCss);

fx({
  id: 'shadow-01', category: cat, brand: 'Acme Atlas', theme: 'slate', header: 'bar', footer: 'news',
  description: 'One open shadow root holding the whole login form with internal labels; the component tracks values in instance fields.',
  title: 'Acme Atlas login',
  main: `<div class="narrow box"><h1>Sign in to Atlas</h1><acme-login id="login-host"></acme-login></div>${noise.status()}`,
  script: `var STYLE=${innerCssLit};customElements.define('acme-login',class extends HTMLElement{constructor(){super();this.model={username:'',password:''};var r=this.attachShadow({mode:'open'});r.innerHTML=STYLE+'<form onsubmit="return false"><div class="f"><label for="user">Username</label><input id="user" name="username" autocomplete="username"></div><div class="f"><label for="pass">Password</label><input id="pass" name="password" type="password" autocomplete="current-password"></div><button>Sign in</button></form>';var self=this;r.getElementById('user').addEventListener('input',function(e){self.model.username=e.target.value;});r.getElementById('pass').addEventListener('input',function(e){self.model.password=e.target.value;});}});
window.__fixture={state:function(){return document.getElementById('login-host').model;}};`,
  steps: [{ kind: 'signin', expected: [
    { selector: ['#login-host', '#user'], role: 'username' },
    { selector: ['#login-host', '#pass'], role: 'password' },
  ] }],
});

fx({
  id: 'shadow-02', category: cat, brand: 'Ironfern Security', theme: 'night', header: 'minimal', footer: 'legal',
  description: 'Closed shadow root: element.shadowRoot is null. The root is exposed only at window.__closedRoots for the harness to verify.',
  title: 'Ironfern vault login',
  main: `<div class="narrow box"><h1>Vault login</h1><vault-login id="vault-login"></vault-login></div>`,
  script: `${closedRootsInit}var STYLE=${innerCssLit};customElements.define('vault-login',class extends HTMLElement{constructor(){super();var m=this._m={username:'',password:''};var r=this.attachShadow({mode:'closed'});window.__closedRoots['#vault-login']=r;r.innerHTML=STYLE+'<div class="f"><label for="u">Operator</label><input id="u" name="operator"></div><div class="f"><label for="p">Passphrase</label><input id="p" name="passphrase" type="password"></div><button type="button">Unlock</button>';r.getElementById('u').addEventListener('input',function(e){m.username=e.target.value;});r.getElementById('p').addEventListener('input',function(e){m.password=e.target.value;});}});
window.__fixture={state:function(){return document.getElementById('vault-login')._m;}};`,
  steps: [{ kind: 'signin', expected: [
    { selector: ['#vault-login', '#u'], role: 'username' },
    { selector: ['#vault-login', '#p'], role: 'password' },
  ] }],
});

fx({
  id: 'shadow-03', category: cat, brand: 'Palewing', theme: 'grape', header: 'navbar', footer: 'links',
  description: 'Design-system nesting: app-shell > login-form > two text-field components, each with its own open root, so inputs sit three roots deep.',
  title: 'Palewing',
  main: `<app-shell id="app"></app-shell>`,
  script: `var STYLE=${innerCssLit};var M={username:'',password:''};
customElements.define('dx-field',class extends HTMLElement{connectedCallback(){if(this.shadowRoot)return;var r=this.attachShadow({mode:'open'});r.innerHTML=STYLE+'<div class="f"><label for="control">'+this.getAttribute('label')+'</label><input id="control" type="'+(this.getAttribute('type')||'text')+'"></div>';var k=this.getAttribute('bind');r.getElementById('control').addEventListener('input',function(e){M[k]=e.target.value;});}});
customElements.define('login-form',class extends HTMLElement{connectedCallback(){if(this.shadowRoot)return;var r=this.attachShadow({mode:'open'});r.innerHTML=STYLE+'<h2>Sign in</h2><dx-field id="email-field" label="Email address" type="email" bind="username"></dx-field><dx-field id="password-field" label="Password" type="password" bind="password"></dx-field><button>Continue</button>';}});
customElements.define('app-shell',class extends HTMLElement{connectedCallback(){if(this.shadowRoot)return;var r=this.attachShadow({mode:'open'});r.innerHTML='<style>section{max-width:420px;margin:30px auto;padding:24px;background:#fff;color:#222;border-radius:12px;border:1px solid #ddd}</style><section><login-form id="form"></login-form></section>';}});
window.__fixture={state:function(){return M;}};`,
  steps: [{ kind: 'signin', expected: [
    { selector: ['#app', '#form', '#email-field', '#control'], role: 'username' },
    { selector: ['#app', '#form', '#password-field', '#control'], role: 'password' },
  ] }],
});

fx({
  id: 'shadow-04', category: cat, brand: 'Hollowmere Mail', theme: 'paper', header: 'bar', footer: 'legal',
  description: 'Closed shadow root nested inside an open one; the inner closed root is registered in __closedRoots under its host selector.',
  title: 'Hollowmere webmail',
  main: `<div class="narrow box"><h1>Webmail</h1><mail-shell id="shell"></mail-shell></div>`,
  script: `${closedRootsInit}var STYLE=${innerCssLit};var M={username:'',password:''};
customElements.define('mail-creds',class extends HTMLElement{constructor(){super();var r=this.attachShadow({mode:'closed'});window.__closedRoots['#creds']=r;r.innerHTML=STYLE+'<div class="f"><label for="addr">Mailbox</label><input id="addr" name="addr"></div><div class="f"><label for="sec">Password</label><input id="sec" name="sec" type="password"></div><button type="button">Open mailbox</button>';r.getElementById('addr').addEventListener('input',function(e){M.username=e.target.value;});r.getElementById('sec').addEventListener('input',function(e){M.password=e.target.value;});}});
customElements.define('mail-shell',class extends HTMLElement{constructor(){super();var r=this.attachShadow({mode:'open'});r.innerHTML='<mail-creds id="creds"></mail-creds>';}});
window.__fixture={state:function(){return M;}};`,
  steps: [{ kind: 'signin', expected: [
    { selector: ['#shell', '#creds', '#addr'], role: 'username' },
    { selector: ['#shell', '#creds', '#sec'], role: 'password' },
  ] }],
});

fx({
  id: 'shadow-05', category: cat, brand: 'Sundial Payroll', theme: 'sun', header: 'utility', footer: 'links',
  description: 'Slotted inputs: the input elements are light DOM children slotted into a component whose shadow root holds the label text, so label and input are in different trees.',
  title: 'Sundial Payroll',
  main: `<form class="narrow box" onsubmit="return false"><h1>Log in to payroll</h1>
  <sd-field label="Employee email"><input id="slot-user" slot="control" name="login" type="email" aria-label="Employee email"></sd-field>
  <sd-field label="Password"><input id="slot-pass" slot="control" name="secret" type="password"></sd-field>
  <button>Log in</button></form>`,
  script: `customElements.define('sd-field',class extends HTMLElement{constructor(){super();var r=this.attachShadow({mode:'open'});r.innerHTML='<style>:host{display:block;margin-bottom:12px}.t{font-weight:600;display:block;margin-bottom:4px}::slotted(input){width:100%;box-sizing:border-box}</style><span class="t" part="label"></span><slot name="control"></slot>';r.querySelector('.t').textContent=this.getAttribute('label');}});`,
  state: { username: '#slot-user', password: '#slot-pass' },
  steps: [{ kind: 'signin', expected: [
    { selector: '#slot-user', role: 'username' },
    { selector: '#slot-pass', role: 'password' },
  ] }],
});

fx({
  id: 'shadow-06', category: cat, brand: 'Tidewrack Systems', theme: 'corp', header: 'nameless', footer: 'news',
  description: 'Web components with internal labels configured by attributes (label, type, placeholder), exposing value as a property; the page reads the component property, not the input.',
  title: 'Tidewrack admin',
  main: `<div class="narrow box"><h1>Admin sign in</h1><tw-input id="tw-user" label="Admin email" type="email" placeholder="admin@company.example"></tw-input><tw-input id="tw-pass" label="Password" type="password"></tw-input><tw-button></tw-button></div>`,
  script: `var STYLE=${innerCssLit};customElements.define('tw-input',class extends HTMLElement{constructor(){super();this._v='';}connectedCallback(){var r=this.attachShadow({mode:'open'});var self=this;r.innerHTML=STYLE+'<div class="f"><label part="label" for="native"></label><input part="input" id="native"></div>';r.querySelector('label').textContent=this.getAttribute('label');var i=r.querySelector('input');i.type=this.getAttribute('type')||'text';if(this.getAttribute('placeholder'))i.placeholder=this.getAttribute('placeholder');i.addEventListener('input',function(){self._v=i.value;self.dispatchEvent(new CustomEvent('tw-change',{bubbles:true,detail:i.value}));});}get value(){return this._v;}set value(x){this._v=x;}});
customElements.define('tw-button',class extends HTMLElement{connectedCallback(){this.attachShadow({mode:'open'}).innerHTML=STYLE+'<button type="button"><slot>Sign in</slot></button>';}});
window.__fixture={state:function(){return {username:document.getElementById('tw-user').value,password:document.getElementById('tw-pass').value};}};`,
  steps: [{ kind: 'signin', expected: [
    { selector: ['#tw-user', '#native'], role: 'username' },
    { selector: ['#tw-pass', '#native'], role: 'password' },
  ] }],
});

fx({
  id: 'shadow-07', category: cat, brand: 'Fernhollow Studio', theme: 'grape', header: 'bar', footer: 'legal',
  description: 'Form-associated custom elements using ElementInternals: the light-DOM form sees values through setFormValue, the real inputs are in shadow roots, state comes from FormData.',
  title: 'Fernhollow Studio',
  main: `<form id="fa" class="narrow box" onsubmit="return false"><h1>Studio sign in</h1><fh-text name="user" label="Email" id="fa-user"></fh-text><fh-text name="pass" label="Password" kind="password" id="fa-pass"></fh-text><button>Sign in</button></form>`,
  script: `var STYLE=${innerCssLit};class FhText extends HTMLElement{static formAssociated=true;constructor(){super();this.internals=this.attachInternals();var r=this.attachShadow({mode:'open',delegatesFocus:true});r.innerHTML=STYLE+'<div class="f"><label for="i"></label><input id="i"></div>';var self=this;this.addEventListener('focus',function(){});r.getElementById('i').addEventListener('input',function(e){self.internals.setFormValue(e.target.value);});}connectedCallback(){var r=this.shadowRoot;r.querySelector('label').textContent=this.getAttribute('label');r.getElementById('i').type=this.getAttribute('kind')||'text';}}customElements.define('fh-text',FhText);
window.__fixture={state:function(){var d=new FormData(document.getElementById('fa'));return {username:d.get('user')||'',password:d.get('pass')||''};}};`,
  steps: [{ kind: 'signin', expected: [
    { selector: ['#fa-user', '#i'], role: 'username' },
    { selector: ['#fa-pass', '#i'], role: 'password' },
  ] }],
});

fx({
  id: 'shadow-08', category: cat, brand: 'Larkspur & Vane', theme: 'paper', header: 'navbar', footer: 'newsdiv',
  description: 'Declarative Shadow DOM from the HTML parser (template shadowrootmode=open), no custom element class and no script needed to make the root.',
  title: 'Larkspur & Vane partners',
  main: `<div class="narrow box"><h1>Partner area</h1>
  <div id="dsd-login"><template shadowrootmode="open">${innerCss}<form onsubmit="return false"><div class="f"><label for="dsd-u">Partner ID</label><input id="dsd-u" name="partner"></div><div class="f"><label for="dsd-p">Password</label><input id="dsd-p" name="pin" type="password"></div><button>Enter</button></form></template></div></div>`,
  script: `window.__fixture={state:function(){var r=document.getElementById('dsd-login').shadowRoot;return {username:r.getElementById('dsd-u').value,password:r.getElementById('dsd-p').value};}};`,
  steps: [{ kind: 'signin', expected: [
    { selector: ['#dsd-login', '#dsd-u'], role: 'username' },
    { selector: ['#dsd-login', '#dsd-p'], role: 'password' },
  ] }],
});

fx({
  id: 'shadow-09', category: cat, brand: 'Stonebarrow Council Services', theme: 'forest', header: 'utility', footer: 'links',
  description: 'Mixed: username in an open component and password in a separate closed component, siblings in a plain div. The two inputs share no form and no root.',
  title: 'Council staff login',
  main: `<div class="narrow box"><h1>Staff login</h1><open-user id="ou"></open-user><closed-pass id="cp"></closed-pass><button type="button">Log in</button></div>`,
  script: `${closedRootsInit}var STYLE=${innerCssLit};var M={username:'',password:''};
customElements.define('open-user',class extends HTMLElement{constructor(){super();var r=this.attachShadow({mode:'open'});r.innerHTML=STYLE+'<div class="f"><label for="x">Staff number</label><input id="x"></div>';r.getElementById('x').addEventListener('input',function(e){M.username=e.target.value;});}});
customElements.define('closed-pass',class extends HTMLElement{constructor(){super();var r=this.attachShadow({mode:'closed'});window.__closedRoots['#cp']=r;r.innerHTML=STYLE+'<div class="f"><label for="y">Password</label><input id="y" type="password"></div>';r.getElementById('y').addEventListener('input',function(e){M.password=e.target.value;});}});
window.__fixture={state:function(){return M;}};`,
  steps: [{ kind: 'signin', expected: [
    { selector: ['#ou', '#x'], role: 'username' },
    { selector: ['#cp', '#y'], role: 'password' },
  ] }],
});
