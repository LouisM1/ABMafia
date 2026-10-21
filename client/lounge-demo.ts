import './lounge-demo.css';

import { W, H, seats as spriteSeats, asset } from './lounge-assets';
const seats = spriteSeats.map(s => s.personaId === 'moxie_marlinspike' ? { ...s, name: 'You' } : s);
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
for (const [id, file] of [['room', 'room'], ['table', 'table'], ['chairs', 'chairs'], ['chair-fronts', 'chair-backs']]) {
  $<HTMLImageElement>(id).src = asset(`lounge/${file}`);
}
let removed = new Set<number>();
let history: Set<number>[] = [];
const actors: HTMLButtonElement[] = [], roster: HTMLButtonElement[] = [];

function update(message: string) {
  $('remaining').textContent = String(seats.length - removed.size);
  $('status').textContent = message;
  $<HTMLButtonElement>('undo').disabled = history.length === 0;
  seats.forEach((s, i) => {
    const gone = removed.has(i);
    actors[i].hidden = gone;
    roster[i].classList.toggle('eliminated', gone);
    roster[i].setAttribute('aria-label', `${gone ? 'Restore' : 'Eliminate'} ${s.name}`);
    roster[i].querySelector('.seat-state')!.textContent = gone ? 'Empty · restore' : 'Seated · remove';
  });
}
function change(next: Set<number>, message: string) {
  if (next.size === removed.size && [...next].every(id => removed.has(id))) return;
  history.push(new Set(removed)); removed = next; update(message);
}
function toggle(i: number) {
  const next = new Set(removed);
  const restoring = next.delete(i);
  if (!restoring) next.add(i);
  change(next, `${seats[i].name} ${restoring ? 'returns to the table.' : 'is eliminated. Their chair is now empty.'}`);
  // Keep keyboard focus useful after the clicked scene button disappears.
  if (!restoring && document.activeElement === actors[i]) roster[i].focus({ preventScroll: true });
}
seats.forEach((s, i) => {
  const [x, y, w, h] = s.box;
  const actor = document.createElement('button');
  actor.type = 'button'; actor.className = 'guest'; actor.setAttribute('aria-label', `Eliminate ${s.name} from scene`);
  actor.title = `${String(i + 1).padStart(2, '0')} · ${s.name} — click to eliminate`;
  Object.assign(actor.style, { left: `${(x + (s.dx || 0)) / W * 100}%`, top: `${y / H * 100}%`, width: `${w / W * 100}%`, height: `${h / H * 100}%`, zIndex: String(10 + Math.round(y / 100)) });
  const img = document.createElement('img'); img.src = asset(`players/${s.file}`); img.alt = ''; img.draggable = false;
  Object.assign(img.style, { width: `${W / w * 100}%`, height: `${H / h * 100}%`, left: `${-x / w * 100}%`, top: `${-y / h * 100}%` });
  actor.append(img); actor.addEventListener('click', () => toggle(i)); $('guests').append(actor); actors.push(actor);
  const button = document.createElement('button'); button.type = 'button';
  button.innerHTML = `<span class="seat-number">${String(i + 1).padStart(2, '0')}</span><span><strong>${s.name}</strong><small class="seat-state">Seated · remove</small></span><span class="seat-dot" aria-hidden="true"></span>`;
  button.addEventListener('click', () => toggle(i)); $('roster').append(button); roster.push(button);
});
$('reset').addEventListener('click', () => change(new Set(), 'All twelve guests are back at the table.'));
$('half').addEventListener('click', () => change(new Set([1, 3, 5, 7, 9, 11]), 'Six guests remain. Empty chairs keep their original positions.'));
$('empty').addEventListener('click', () => change(new Set(seats.map((_, i) => i)), 'An empty table. Restore a guest below, or refill every seat.'));
$('undo').addEventListener('click', () => { const previous = history.pop(); if (previous) { removed = previous; update('Previous seating restored.'); } });
$('night').addEventListener('change', () => $('scene').classList.toggle('night', $<HTMLInputElement>('night').checked));
// An asset failure should be visible, rather than silently looking like an empty seat.
document.querySelectorAll('img').forEach(img => img.addEventListener('error', () => { $('status').textContent = 'An image failed to load. Check the asset files and refresh the demo.'; }));
update('The table is full. Choose your first suspect.');
