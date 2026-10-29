const KEY_STORAGE = 'papertrader.adminKey';
const $ = (id) => document.getElementById(id);
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const pctFmt = new Intl.NumberFormat('en-US', { style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: 'exceptZero' });
const dateFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function storedKey(action, value) {
  try {
    if (action === 'get') return localStorage.getItem(KEY_STORAGE);
    if (action === 'set') localStorage.setItem(KEY_STORAGE, value);
    if (action === 'clear') localStorage.removeItem(KEY_STORAGE);
  } catch {
    // Storage blocked: you'll just need to sign in again next time.
  }
  return null;
}

let adminKey = storedKey('get');

async function api(path, options = {}) {
  const res = await fetch(`/api/admin${path}`, {
    method: options.method || 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminKey}` },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else node.setAttribute(key, value);
  }
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
}

function button(label, className, onClick) {
  const b = el('button', { type: 'button', class: `small-btn ${className}` }, label);
  b.addEventListener('click', onClick);
  return b;
}

function showLogin(message = '') {
  $('panel').hidden = true;
  $('refresh').hidden = true;
  $('sign-out').hidden = true;
  $('login').hidden = false;
  $('login-error').textContent = message;
  $('admin-key').focus();
}

async function act(label, fn) {
  $('panel-error').textContent = '';
  $('panel-message').textContent = '';
  try {
    await fn();
    $('panel-message').textContent = label;
    await load();
  } catch (err) {
    $('panel-error').textContent = err.message;
  }
}

function row(p) {
  const name = p.name || '(no name)';
  const sign = p.returnPct > 0.00005 ? 'up' : p.returnPct < -0.00005 ? 'down' : '';
  const nameCell = p.name
    ? el('a', { href: `/player.html?name=${encodeURIComponent(p.name)}` }, p.name)
    : el('span', { class: 'muted' }, name);
  return el('tr', {},
    el('td', { class: 'player' }, nameCell),
    el('td', { class: `num ${sign}` }, pctFmt.format(p.returnPct)),
    el('td', { class: 'num' }, usd.format(p.total)),
    el('td', { class: 'num' }, usd.format(p.deposited)),
    el('td', { class: 'num' }, String(p.holdings)),
    el('td', { class: 'num' }, String(p.trades)),
    el('td', {}, dateFmt.format(new Date(p.createdAt))),
    el('td', { class: 'actions' },
      button('Copy link', '', async (e) => {
        const link = `${location.origin}/?p=${p.id}`;
        try {
          await navigator.clipboard.writeText(link);
          e.target.textContent = 'Copied';
        } catch {
          prompt('Private link for this player:', link);
        }
        setTimeout(() => (e.target.textContent = 'Copy link'), 2000);
      }),
      button('Rename', '', () => {
        const next = prompt(`New name for ${name}:`, p.name || '');
        if (next === null) return;
        act(`Renamed to ${next.trim()}.`, () => api(`/players/${p.id}/name`, { method: 'POST', body: { name: next } }));
      }),
      button('Reset', 'danger', () => {
        if (!confirm(`Reset ${name}? Their cash goes to $0 and holdings and history are erased.`)) return;
        act(`Reset ${name}.`, () => api(`/players/${p.id}/reset`, { method: 'POST' }));
      }),
      button('Delete', 'danger', () => {
        if (!confirm(`Delete ${name} permanently? This cannot be undone.`)) return;
        act(`Deleted ${name}.`, () => api(`/players/${p.id}`, { method: 'DELETE' }));
      })));
}

async function load() {
  try {
    const { players } = await api('/players');
    $('login').hidden = true;
    $('panel').hidden = false;
    $('refresh').hidden = false;
    $('sign-out').hidden = false;
    $('players').querySelector('tbody').replaceChildren(...players.map(row));
    $('no-players').hidden = players.length > 0;
    $('updated').textContent = `${players.length} player${players.length === 1 ? '' : 's'} · ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      storedKey('clear');
      showLogin(adminKey ? err.message : '');
    } else {
      $('panel-error').textContent = err.message;
    }
  }
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  adminKey = $('admin-key').value.trim();
  storedKey('set', adminKey);
  $('admin-key').value = '';
  await load();
});

$('refresh').addEventListener('click', load);
$('sign-out').addEventListener('click', () => {
  storedKey('clear');
  adminKey = null;
  showLogin();
});

if (adminKey) load();
else showLogin();
