import { fx, noise } from './kit.mjs';

const cat = 'framework';
const u = (selector) => ({ selector, role: 'username' });
const p = (selector) => ({ selector, role: 'password' });
const reactLibs = ['react.production.min.js', 'react-dom.production.min.js'];
const vueLibs = ['vue.global.prod.js'];

// ---------------------------------------------------------------- real React

fx({
  id: 'framework-react-01', category: cat, brand: 'Acme Roster', theme: 'slate', header: 'bar', footer: 'news', libs: reactLibs,
  description: 'Real React controlled inputs via useState. A value set without an input event never reaches state (React value tracker), and the submit button stays disabled until both fields are non-empty.',
  title: 'Acme Roster',
  main: `<div id="root" class="narrow box"></div>${noise.features('Acme Roster')}`,
  script: `var h=React.createElement,S={};function App(){var a=React.useState(''),b=React.useState('');S.username=a[0];S.password=b[0];return h('form',{onSubmit:function(e){e.preventDefault();}},h('h1',null,'Sign in'),h('div',{className:'row'},h('label',{htmlFor:'r-user'},'Username'),h('input',{id:'r-user',value:a[0],onChange:function(e){a[1](e.target.value);},autoComplete:'username'})),h('div',{className:'row'},h('label',{htmlFor:'r-pass'},'Password'),h('input',{id:'r-pass',type:'password',value:b[0],onChange:function(e){b[1](e.target.value);},autoComplete:'current-password'})),h('button',{id:'r-submit',disabled:!(a[0]&&b[0])},'Sign in'));}
ReactDOM.createRoot(document.getElementById('root')).render(h(App));window.__fixture={state:function(){return {username:S.username,password:S.password};}};`,
  steps: [{ kind: 'signin', wait: '#r-pass', expected: [u('#r-user'), p('#r-pass')] }],
});

fx({
  id: 'framework-react-02', category: cat, brand: 'Sable Notes', theme: 'night', header: 'navbar', footer: 'legal', libs: reactLibs,
  description: 'Real React with useId ids and data-testid. onBlur marks the field touched and re-renders, which writes state back to the DOM: a filled-looking box with no input event is wiped on blur. Shows inline validation errors once touched.',
  title: 'Sable Notes sign-in',
  main: `<div id="app" class="narrow box"></div>`,
  script: `var h=React.createElement,S={};function Field(props){var id=React.useId();var t=React.useState(false);var bad=t[0]&&!props.value;return h('div',{className:'row'+(bad?' has-error':'')},h('label',{htmlFor:id},props.label),h('input',{id:id,'data-testid':props.testid,type:props.type||'text',value:props.value,onChange:function(e){props.onChange(e.target.value);},onBlur:function(){t[1](true);},'aria-invalid':bad}),bad?h('div',{className:'muted',role:'alert'},props.label+' is required'):null);}
function App(){var a=React.useState(''),b=React.useState('');S.username=a[0];S.password=b[0];return h('div',null,h('h1',null,'Sign in'),h(Field,{label:'Email',testid:'login-email',type:'email',value:a[0],onChange:a[1]}),h(Field,{label:'Password',testid:'login-password',type:'password',value:b[0],onChange:b[1]}),h('button',{type:'button'},'Sign in'));}
ReactDOM.createRoot(document.getElementById('app')).render(h(App));window.__fixture={state:function(){return {username:S.username,password:S.password};}};`,
  steps: [{ kind: 'signin', wait: '[data-testid="login-password"]', expected: [u('[data-testid="login-email"]'), p('[data-testid="login-password"]')] }],
});

fx({
  id: 'framework-react-03', category: cat, brand: 'Pellucid Freight', theme: 'sun', header: 'nameless', footer: 'links', libs: reactLibs,
  description: 'Real React reducer-driven form that tracks dirty state and remounts the password input (new key) when the username first becomes valid, so a cached element reference goes stale. Submit is disabled until dirty and valid.',
  title: 'Pellucid portal',
  main: `<div id="mount" class="narrow box"></div>`,
  script: `var h=React.createElement,S={};function red(s,a){var n=Object.assign({},s);n[a.k]=a.v;n.dirty=true;return n;}
function App(){var r=React.useReducer(red,{u:'',p:'',dirty:false});var st=r[0],d=r[1];S.username=st.u;S.password=st.p;var ok=st.u.indexOf('@')>0;return h('form',{onSubmit:function(e){e.preventDefault();},'data-dirty':String(st.dirty)},h('h1',null,'Customer portal'),h('div',{className:'row'},h('label',{htmlFor:'pf-u'},'Account email'),h('input',{id:'pf-u',name:'email',value:st.u,onChange:function(e){d({k:'u',v:e.target.value});}})),h('div',{className:'row'},h('label',{htmlFor:'pf-p'},'Password'),h('input',{key:ok?'pw-valid':'pw-pending',id:'pf-p',name:'password',type:'password',value:st.p,onChange:function(e){d({k:'p',v:e.target.value});}})),h('button',{disabled:!(st.dirty&&ok&&st.p)},'Log in'));}
ReactDOM.createRoot(document.getElementById('mount')).render(h(App));window.__fixture={state:function(){return {username:S.username,password:S.password};}};`,
  steps: [{ kind: 'signin', wait: '#pf-p', expected: [u('#pf-u'), p('#pf-p')] }],
});

// ---------------------------------------------------------------- real Vue

fx({
  id: 'framework-vue-01', category: cat, brand: 'Tarnhold Cloud', theme: 'night', header: 'minimal', footer: 'legal', libs: vueLibs,
  description: 'Real Vue v-model with Vuetify-like generated ids input-17 and input-21 and floating labels. v-model listens to input, so a bare value set is ignored; login stays disabled until the computed canSubmit is true.',
  title: 'Tarnhold Console',
  main: `<div id="vue-app" class="narrow box"></div>`,
  script: `var vm=Vue.createApp({data:function(){return {username:'',password:''};},computed:{canSubmit:function(){return this.username.length>0&&this.password.length>=4;}},template:'<form class="v-form" @submit.prevent novalidate><h1>Console</h1><div class="row v-input"><label for="input-17" class="v-label">Account</label><input id="input-17" v-model="username" type="text" autocomplete="off"></div><div class="row v-input"><label for="input-21" class="v-label">Secret</label><input id="input-21" v-model="password" type="password" autocomplete="off"></div><button class="v-btn" :disabled="!canSubmit">Log in</button></form>'}).mount('#vue-app');
window.__fixture={state:function(){return {username:vm.username,password:vm.password};}};`,
  steps: [{ kind: 'signin', wait: '#input-21', expected: [u('#input-17'), p('#input-21')] }],
});

fx({
  id: 'framework-vue-02', category: cat, brand: 'Sundial Payroll', theme: 'sun', header: 'utility', footer: 'newsdiv', libs: vueLibs,
  description: 'Real Vue v-model.lazy on both fields: the model updates only on the change event, so dispatching input alone leaves state empty. Username also has .trim, so spaces around it are dropped.',
  title: 'Sundial Payroll',
  main: `<div id="sd" class="narrow box"></div>`,
  script: `var vm=Vue.createApp({data:function(){return {email:'',pass:''};},template:'<div><h1>Payroll login</h1><div class="row"><label for="sd-email">Work email</label><input id="sd-email" name="work_email" type="email" v-model.lazy.trim="email"></div><div class="row"><label for="sd-pass">Password</label><input id="sd-pass" name="work_pass" type="password" v-model.lazy="pass"></div><button type="button">Continue</button></div>'}).mount('#sd');
window.__fixture={state:function(){return {username:vm.email,password:vm.pass};}};`,
  steps: [{ kind: 'signin', wait: '#sd-pass', expected: [u('#sd-email'), p('#sd-pass')] }],
});

fx({
  id: 'framework-vue-03', category: cat, brand: 'Fernhollow Studio', theme: 'grape', header: 'bar', footer: 'links', libs: vueLibs,
  description: 'Real Vue where blur re-renders the form: a :key bump on blur replaces both input elements with new ones bound to the model. Anything not in the model (value set with no event) vanishes on blur.',
  title: 'Fernhollow Studio',
  main: `<div id="fh" class="narrow box"></div>`,
  script: `var vm=Vue.createApp({data:function(){return {u:'',p:'',gen:0,touched:false,busy:false};},methods:{left:function(ev){if(this.busy)return;this.busy=true;var want=ev.relatedTarget&&ev.relatedTarget.id;var self=this;this.touched=true;this.gen++;this.$nextTick(function(){if(want&&document.getElementById(want))document.getElementById(want).focus();self.busy=false;});}},template:'<div :data-gen="gen"><h1>Studio sign in</h1><div class="row"><label for="fh-u">Email</label><input :key="\\'u\\'+gen" id="fh-u" type="email" v-model="u" @blur="left"></div><div class="row"><label for="fh-p">Password</label><input :key="\\'p\\'+gen" id="fh-p" type="password" v-model="p" @blur="left"></div><p v-if="touched && !u" role="alert" class="muted">Email is required</p><button type="button">Sign in</button></div>'}).mount('#fh');
window.__fixture={state:function(){return {username:vm.u,password:vm.p};}};`,
  steps: [{ kind: 'signin', wait: '#fh-p', expected: [u('#fh-u'), p('#fh-p')] }],
});

// ---------------------------------------------------------------- Angular-style (hand-written)

// Behaves like @angular/forms DefaultValueAccessor: input updates the model unless a
// composition is in progress, compositionend commits it, blur marks touched, and the
// ng-* classes follow validity and dirtiness.
const ngRuntime = `function ngControl(el,opts){opts=opts||{};var c={value:'',dirty:false,touched:false,composing:false,el:el,valid:function(){return opts.valid?opts.valid(c.value):!!c.value;},sync:function(){el.classList.toggle('ng-pristine',!c.dirty);el.classList.toggle('ng-dirty',c.dirty);el.classList.toggle('ng-untouched',!c.touched);el.classList.toggle('ng-touched',c.touched);el.classList.toggle('ng-valid',c.valid());el.classList.toggle('ng-invalid',!c.valid());}};
function commit(v){c.value=v;c.dirty=true;c.sync();if(opts.onChange)opts.onChange(c);}
el.addEventListener('input',function(){if(!c.composing)commit(el.value);});
el.addEventListener('compositionstart',function(){c.composing=true;});
el.addEventListener('compositionend',function(){c.composing=false;commit(el.value);});
el.addEventListener('blur',function(){c.touched=true;c.sync();if(opts.onBlur)opts.onBlur(c);});
c.sync();return c;}`;

const matField = (label, id, attrs) => `<mat-form-field _ngcontent-ng-c1042 class="mat-mdc-form-field" style="display:block;margin-bottom:14px"><label for="${id}" _ngcontent-ng-c1042 class="mdc-floating-label" style="display:block;font-weight:600">${label}</label><input matinput _ngcontent-ng-c1042 id="${id}" class="mat-mdc-input-element ng-untouched ng-pristine ng-invalid" ${attrs} style="width:100%"></mat-form-field>`;

fx({
  id: 'framework-ng-01', category: cat, brand: 'Harrowgate Mutual', theme: 'corp', header: 'bar', footer: 'table',
  description: 'Angular-style reactive form: mat-input-N ids, formcontrolname, ng-untouched ng-pristine classes; the model is a JS object updated by input and compositionend only, never by reading the DOM.',
  title: 'Harrowgate Member Portal',
  main: `<app-root _nghost-ng-c8821 ng-version="17.3.0"><app-login _ngcontent-ng-c8821 class="narrow box" style="display:block"><h1>Member portal</h1><form id="ng-form" novalidate class="ng-untouched ng-pristine ng-invalid" onsubmit="return false">${matField('Member ID', 'mat-input-2', 'formcontrolname="memberId" type="text"')}${matField('Password', 'mat-input-3', 'formcontrolname="password" type="password"')}<button mat-flat-button>Sign in</button></form></app-login></app-root>`,
  script: `${ngRuntime}var C={u:ngControl(document.getElementById('mat-input-2')),p:ngControl(document.getElementById('mat-input-3'))};window.__fixture={state:function(){return {username:C.u.value,password:C.p.value};}};`,
  steps: [{ kind: 'signin', expected: [u('#mat-input-2'), p('#mat-input-3')] }],
});

fx({
  id: 'framework-ng-02', category: cat, brand: 'Bellwether Trust', theme: 'slate', header: 'utility', footer: 'links',
  description: 'Angular-style form whose blur handler rewrites the DOM value from the model, as a writeValue call would: without a real input event the box empties on blur.',
  title: 'Bellwether Business Online',
  main: `<div class="narrow box"><h1>Business online</h1><form onsubmit="return false" class="ng-untouched ng-pristine">${matField('Company user ID', 'mat-input-0', 'formcontrolname="userId" type="text" autocomplete="off"')}${matField('Password', 'mat-input-1', 'formcontrolname="pwd" type="password" autocomplete="off"')}<button type="submit">Log on</button></form></div>`,
  script: `${ngRuntime}var writeBack=function(c){c.el.value=c.value;};var C={u:ngControl(document.getElementById('mat-input-0'),{onBlur:writeBack}),p:ngControl(document.getElementById('mat-input-1'),{onBlur:writeBack})};window.__fixture={state:function(){return {username:C.u.value,password:C.p.value};}};`,
  steps: [{ kind: 'signin', expected: [u('#mat-input-0'), p('#mat-input-1')] }],
});

fx({
  id: 'framework-ng-03', category: cat, brand: 'Velvetine Cloud', theme: 'night', header: 'navbar', footer: 'legal',
  description: 'Angular-style form with a disabled submit until both controls are valid (email pattern check on the username). Dirty and touched classes update live; the form-level ng-valid class follows them.',
  title: 'Velvetine admin',
  main: `<div class="narrow box"><h1>Admin</h1><form id="vf" novalidate class="ng-untouched ng-pristine ng-invalid" onsubmit="return false">${matField('Email', 'mat-input-7', 'formcontrolname="email" type="email"')}${matField('Password', 'mat-input-8', 'formcontrolname="password" type="password"')}<button id="vf-submit" disabled>Sign in</button></form></div>`,
  script: `${ngRuntime}var C={};function chk(){var ok=C.u&&C.p&&C.u.valid()&&C.p.valid();document.getElementById('vf-submit').disabled=!ok;var f=document.getElementById('vf');f.classList.toggle('ng-valid',!!ok);f.classList.toggle('ng-invalid',!ok);f.classList.remove('ng-pristine');f.classList.add('ng-dirty');}
C.u=ngControl(document.getElementById('mat-input-7'),{valid:function(v){return /.+@.+/.test(v);},onChange:chk});C.p=ngControl(document.getElementById('mat-input-8'),{valid:function(v){return v.length>=6;},onChange:chk});window.__fixture={state:function(){return {username:C.u.value,password:C.p.value};}};`,
  steps: [{ kind: 'signin', expected: [u('#mat-input-7'), p('#mat-input-8')] }],
});

// ---------------------------------------------------------------- Svelte-style (hand-written)

fx({
  id: 'framework-svelte-01', category: cat, brand: 'Cobalt Ferret Games', theme: 'night', header: 'navbar', footer: 'links',
  description: 'Svelte-style bind:value: hashed svelte-xxxx classes and a store updated on the input event only. Change events and bare value sets do nothing.',
  title: 'Cobalt Ferret ID',
  css: `.field.svelte-1k2j3h{margin-bottom:14px}input.svelte-1k2j3h{width:100%}`,
  main: `<div class="narrow box svelte-1k2j3h"><h1 class="svelte-1k2j3h">Player login</h1><div class="field svelte-1k2j3h"><label for="sv-name" class="svelte-1k2j3h">Player name</label><input id="sv-name" class="svelte-1k2j3h" type="text"></div><div class="field svelte-1k2j3h"><label for="sv-word" class="svelte-1k2j3h">Password</label><input id="sv-word" class="svelte-1k2j3h" type="password"></div><button class="svelte-1k2j3h" type="button">Log in</button></div>`,
  script: `var $state={name:'',word:''};function bind(id,key){var el=document.getElementById(id);el.addEventListener('input',function(){$state[key]=el.value;});}bind('sv-name','name');bind('sv-word','word');window.__fixture={state:function(){return {username:$state.name,password:$state.word};}};`,
  steps: [{ kind: 'signin', expected: [u('#sv-name'), p('#sv-word')] }],
});

fx({
  id: 'framework-svelte-02', category: cat, brand: 'Kestrel Row', theme: 'paper', header: 'bar', footer: 'news',
  description: 'Svelte-style reactive statement: the button is disabled until the store is valid and flips only from input events; a status line shows how many characters the app believes it has.',
  title: 'Kestrel Row',
  main: `<div class="narrow box s-Xy12Ab"><h1>Log in</h1><div class="row"><label for="kr-e">Email</label><input id="kr-e" class="s-Xy12Ab" type="email"></div><div class="row"><label for="kr-p">Password</label><input id="kr-p" class="s-Xy12Ab" type="password"></div><p class="muted" id="kr-status">0 characters entered</p><button id="kr-go" class="s-Xy12Ab" disabled type="button">Log in</button></div>`,
  script: `var $s={e:'',p:''};function $$invalidate(){var ok=/.+@.+/.test($s.e)&&$s.p.length>0;document.getElementById('kr-go').disabled=!ok;document.getElementById('kr-status').textContent=($s.e.length+$s.p.length)+' characters entered';}
['e','p'].forEach(function(k){var el=document.getElementById('kr-'+k);el.addEventListener('input',function(){$s[k]=el.value;$$invalidate();});});window.__fixture={state:function(){return {username:$s.e,password:$s.p};}};`,
  steps: [{ kind: 'signin', expected: [u('#kr-e'), p('#kr-p')] }],
});

fx({
  id: 'framework-svelte-03', category: cat, brand: 'Hollowmere Mail', theme: 'forest', header: 'minimal', footer: 'lang',
  description: 'Svelte-style {#key} block: on blur of either field the block is destroyed and recreated with new input nodes valued from the store, so element references go stale and values with no input event are lost.',
  title: 'Hollowmere Mail',
  main: `<div class="narrow box"><h1>Open your mailbox</h1><div id="key-block"></div><button type="button">Log in</button></div>`,
  script: `var $s={a:'',b:''};var block=document.getElementById('key-block');var gen=0;var rendering=false;function make(){rendering=true;gen++;block.setAttribute('data-gen',String(gen));block.innerHTML='<div class="row"><label for="hm-a">Address</label><input id="hm-a" type="text"></div><div class="row"><label for="hm-b">Password</label><input id="hm-b" type="password"></div>';[['hm-a','a'],['hm-b','b']].forEach(function(p){var el=document.getElementById(p[0]);el.value=$s[p[1]];el.addEventListener('input',function(){$s[p[1]]=el.value;});el.addEventListener('blur',function(ev){if(rendering)return;var rt=ev.relatedTarget;setTimeout(function(){var want=rt&&rt.id;make();if(want&&document.getElementById(want))document.getElementById(want).focus();},0);});});rendering=false;}
make();window.__fixture={state:function(){return {username:$s.a,password:$s.b};}};`,
  steps: [{ kind: 'signin', wait: '#hm-b', expected: [u('#hm-a'), p('#hm-b')] }],
});
