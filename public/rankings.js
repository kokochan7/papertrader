const $ = (id) => document.getElementById(id);
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const pctFmt = new Intl.NumberFormat('en-US', { style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: 'exceptZero' });
const medals = ['🥇', '🥈', '🥉'];

function myId() {
  try {
    return localStorage.getItem('papertrader.portfolioId');
  } catch {
    return null;
  }
}

function cell(text, className = '') {
  const td = document.createElement('td');
  td.className = className;
  td.textContent = text;
  return td;
}

async function load() {
  const button = $('refresh');
  button.disabled = true;
  $('error').textContent = '';
  try {
    const me = myId();
    const res = await fetch(`/api/leaderboard${me ? `?me=${encodeURIComponent(me)}` : ''}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    $('rankings').querySelector('tbody').replaceChildren(
      ...data.players.map((p) => {
        const tr = document.createElement('tr');
        if (p.you) tr.className = 'you';
        const sign = p.returnPct > 0.00005 ? 'up' : p.returnPct < -0.00005 ? 'down' : '';
        tr.append(
          cell(medals[p.rank - 1] ?? String(p.rank), 'num'),
          cell(p.you ? `${p.name} (you)` : p.name, 'player'),
          cell(pctFmt.format(p.returnPct), `num ${sign}`),
          cell(usd.format(p.total), 'num'),
          cell(usd.format(p.started), 'num'),
          cell(String(p.holdings), 'num'),
        );
        return tr;
      }),
    );
    $('no-players').hidden = data.players.length > 0;
    $('updated').textContent = `Updated ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`;
  } catch (err) {
    $('error').textContent = `Couldn't load rankings: ${err.message}`;
  } finally {
    button.disabled = false;
  }
}

$('refresh').addEventListener('click', load);
setInterval(() => document.visibilityState === 'visible' && load(), 60_000);
load();
