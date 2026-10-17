import { pad3 } from './drones';

type Props = {
  t: number;
  max: number;
  playing: boolean;
  onT: (t: number) => void;
  onPlay: (playing: boolean) => void;
  marks?: number[];
};

export default function Timeline({ t, max, playing, onT, onPlay, marks = [] }: Props) {
  return (
    <div className="timeline">
      <button className="play" onClick={() => onPlay(!playing)} title="Play / pause (space)" aria-label={playing ? 'Pause' : 'Play'}>
        {playing ? '❚❚' : '▶'}
      </button>
      <span className="speed">4×</span>
      <div className="slider-wrap">
        <input type="range" min={0} max={max} step={1} value={t} onChange={(e) => onT(Number(e.target.value))} aria-label="Scenario time" />
        <div className="marks" aria-hidden="true">
          {marks.map((m, i) => <span key={i} style={{ left: `${(m / Math.max(1, max)) * 100}%` }} />)}
        </div>
      </div>
      <output className="t-readout">T+{pad3(t)} <small>/ {pad3(max)} s</small></output>
    </div>
  );
}
