// Shared shell for the console pages.
//
// One header, one organisation picker, one set of fetch helpers — so adding a
// page (or a channel that needs one) never means re-deciding what the nav
// looks like. Pages call mountShell() then render only their own <main>.
//
// Classic script on purpose: these top-level bindings are visible to the
// inline <script> in each page, and there is no build step to keep alive.

const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]));

// Setup lives on Channels and Settings; Inbox is the day-to-day page.
// `min` mirrors the server's rules (src/auth/access.ts) — hiding a link is
// for tidiness only; the server is what actually refuses.
const NAV = [
  { href: '/channels',    label: 'Channels',    min: 'admin' },
  { href: '/inbox',       label: 'Inbox',       min: 'agent' },
  { href: '/voice',       label: 'Voice',       min: 'agent' },
  { href: '/agents',      label: 'Agents',      min: 'admin' },
  { href: '/shopify',     label: 'Shopify',     min: 'admin' },
  { href: '/permissions', label: 'Permissions', min: 'operator' },
  { href: '/',            label: 'Settings',    min: 'operator' },
];
const RANK = { agent: 0, admin: 1, operator: 2 };
const PRESENCE = ['available', 'busy', 'away'];

let me = null;
let orgs = [];
let orgId = localStorage.getItem('orgId') || '';

function can(min) { return me && RANK[me.role] >= RANK[min]; }

function toLogin() {
  location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search);
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  // On the sign-in page a 401 just means wrong credentials.
  if (res.status === 401 && location.pathname !== '/login') { toLogin(); throw new Error('signed out'); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

function jsonPost(path, data, method = 'POST') {
  return api(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
}

function toast(msg) {
  let t = $('#toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2200);
}

/** Renders a credential/settings input from a CredentialField the server sent. */
function fieldHtml(f, attr, value = '', configured = false) {
  return `
    <div class="field">
      <label>${esc(f.label)} ${configured ? '<span class="badge active">set</span>' : ''}</label>
      <input ${attr}="${esc(f.key)}" type="${f.secret ? 'password' : 'text'}"
             value="${esc(value)}" placeholder="${f.secret && configured ? '•••••••• (unchanged)' : esc(f.placeholder || '')}" />
      ${f.help ? `<div class="help">${esc(f.help)}</div>` : ''}
    </div>`;
}

async function loadOrgs() {
  orgs = await api('/api/orgs');
  if (!orgs.find(o => o.id === orgId)) orgId = orgs[0]?.id || '';
  localStorage.setItem('orgId', orgId);
  const sel = $('#orgSelect');
  if (sel) {
    sel.innerHTML = orgs.map(o =>
      `<option value="${o.id}" ${o.id === orgId ? 'selected' : ''}>${esc(o.name)}</option>`).join('');
  }
}

function currentOrg() { return orgs.find(o => o.id === orgId); }

/** Pages react to an org switch by listening for this instead of polling. */
function announceOrg() {
  window.dispatchEvent(new CustomEvent('orgchange', { detail: { orgId } }));
}

/**
 * Builds the header and wires the org picker.
 * @param active     nav href to mark as current
 * @param manageOrgs show New/Rename/Delete — Settings owns organisation admin
 * @param actions    page-specific header controls, as HTML; wire them up after
 *                   this resolves, since they do not exist until then
 */
async function mountShell({ active, manageOrgs = false, actions = '' } = {}) {
  me = await api('/api/auth/me');
  manageOrgs = manageOrgs && me.role === 'operator';

  const header = document.createElement('header');
  header.innerHTML = `
    <h1 class="brand">Omnichannel</h1>
    <div class="orgbar">
      <span>Organisation</span>
      <select id="orgSelect"></select>
      ${manageOrgs ? `
        <button class="ghost small" id="newOrg">New</button>
        <button class="ghost small" id="renameOrg">Rename</button>
        <button class="danger small" id="delOrg">Delete</button>` : ''}
    </div>
    <div class="actions">${actions}</div>
    <nav>
      ${NAV.filter(n => can(n.min)).map(n => `<a href="${n.href}" class="${n.href === active ? 'on' : ''}">${n.label}</a>`).join('')}
    </nav>
    <div class="me">
      <span class="me-name" title="${esc(me.email)} · ${esc(me.role)}">${esc(me.name)}</span>
      <select id="presence" aria-label="Your status">
        ${PRESENCE.map(p => `<option value="${p}" ${p === me.presence ? 'selected' : ''}>${p}</option>`).join('')}
      </select>
      <button class="ghost small" id="changePw">Password</button>
      <button class="ghost small" id="signOut">Sign out</button>
    </div>`;
  document.body.prepend(header);

  $('#presence').onchange = async e => {
    try {
      me = await jsonPost('/api/auth/me', { presence: e.target.value }, 'PATCH');
      toast(`Status: ${me.presence}`);
    } catch (err) { toast(err.message); }
  };
  $('#changePw').onclick = async () => {
    const currentPassword = prompt('Current password');
    if (!currentPassword) return;
    const newPassword = prompt('New password (at least 8 characters)');
    if (!newPassword) return;
    try {
      await jsonPost('/api/auth/me', { currentPassword, newPassword }, 'PATCH');
      toast('Password changed — other devices are signed out');
    } catch (err) { toast(err.message); }
  };
  $('#signOut').onclick = async () => {
    await jsonPost('/api/auth/logout', {}).catch(() => {});
    location.href = '/login';
  };

  await loadOrgs();

  $('#orgSelect').onchange = e => {
    orgId = e.target.value;
    localStorage.setItem('orgId', orgId);
    announceOrg();
  };

  if (!manageOrgs) return;

  $('#newOrg').onclick = async () => {
    const name = prompt('Organisation name');
    if (!name) return;
    const org = await jsonPost('/api/orgs', { name });
    orgId = org.id;
    localStorage.setItem('orgId', orgId);
    await loadOrgs();
    announceOrg();
    toast('Organisation created');
  };

  $('#renameOrg').onclick = async () => {
    const name = prompt('New name', currentOrg()?.name || '');
    if (!name) return;
    await jsonPost(`/api/orgs/${orgId}`, { name }, 'PATCH');
    await loadOrgs();
    toast('Renamed');
  };

  $('#delOrg').onclick = async () => {
    if (!confirm(`Delete "${currentOrg()?.name}" and all its channels and conversations?`)) return;
    try {
      await api(`/api/orgs/${orgId}`, { method: 'DELETE' });
      orgId = '';
      await loadOrgs();
      announceOrg();
      toast('Deleted');
    } catch (e) { alert(e.message); }
  };
}
