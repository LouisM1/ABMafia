import type { View } from '../shared/types';
import { W, H, seats, asset } from './lounge-assets';

export type ScenePlayer = Pick<View['players'][number], 'id' | 'name' | 'personaId' | 'alive' | 'human'>;
// Match identity rather than roster order, including games saved before the art mapping.
// The human occupies Moxie’s centre-foreground seat and remains labelled “You”.
export function Lounge({ players, selected, eligible, speaking, night, onChoose }: {
  players: ScenePlayer[]; selected: string[]; eligible: string[]; speaking?: string; night: boolean; onChoose: (id: string) => void;
}) {
  return <div class="room-viewport" aria-label="Lounge">
    <div class={`lounge-scene ${night ? 'at-night' : ''}`}>
      <img class="scenery room" src={asset('lounge/room')} alt="A candlelit club lounge with twelve red chairs around a wooden table"/>
      <div class="room-shadow" aria-hidden="true"/>
      <img class="scenery table" src={asset('lounge/table')} alt=""/>
      <img class="scenery chairs" src={asset('lounge/chairs')} alt=""/>
      {players.filter(p => p.alive).map(p => {
        const s = seats.find(s => s.personaId === (p.human ? 'moxie_marlinspike' : p.personaId));
        if (!s) return null;
        const [x, y, w, h] = s.box;
        return <button key={p.id} type="button" class={`scene-player ${selected.includes(p.id) ? 'chosen' : ''} ${speaking === p.id ? 'has-floor' : ''} ${eligible.includes(p.id) ? 'available' : ''}`}
          style={{ left: `${(x + (s.dx || 0)) / W * 100}%`, top: `${y / H * 100}%`, width: `${w / W * 100}%`, height: `${h / H * 100}%`, zIndex: 10 + Math.round(y / 100) }}
          onClick={() => onChoose(p.id)} disabled={!eligible.includes(p.id)} aria-label={`${p.name}${p.human ? ' (you)' : ''} at the table`} aria-pressed={selected.includes(p.id)} title={p.human ? 'Your seat' : p.name}>
          <img src={asset(`players/${s.file}`)} alt="" draggable={false} style={{ width: `${W / w * 100}%`, height: `${H / h * 100}%`, left: `${-x / w * 100}%`, top: `${-y / h * 100}%` }}/>
          <span class="player-label">{p.human ? 'You' : p.name}</span>
        </button>;
      })}
      <img class="scenery chair-fronts" src={asset('lounge/chair-backs')} alt=""/>
      <div class="night-wash" aria-hidden="true"/>
    </div>
  </div>;
}
