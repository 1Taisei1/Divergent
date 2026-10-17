// Floating card for the AUTONOMOUS SURVEY tab: status, survey area, ranked next-survey queue, guardrail readouts,
// enemy pinpoints, operator arm / abort, decision log.
import { useId, useState } from 'react';
import { isActive, isAirborne, latestFindings, type MissionPhase, type MissionState, type SurveyOption } from './autonomy';
import './autonomy.css';

type Props = {
  state: MissionState;
  onArm: (operator: string) => void;
  onAbort: () => void;
  onReset: () => void;
  playing: boolean;
  maxRisk?: number;
  areaLabel: string; // e.g. 'Whole AO' or '2.4 km x 2.4 km box at (4100, 6200)'
  areaCustom: boolean; // a box (drawn or picked from the queue) is set
  drawing: boolean; // operator is drawing a box on the map
  cornerSet: boolean; // first corner already clicked while drawing
  canChangeArea: boolean; // false while armed / airborne
  queue: SurveyOption[]; // ranked next-survey options, rank 1 first
  selectedOptionId: string | null; // option whose area is currently selected
  onFullArea: () => void;
  onDrawArea: () => void;
  onCancelDraw: () => void;
  onPickOption: (o: SurveyOption) => void;
};

const STATUS: Record<MissionPhase, [string, string]> = {
  idle: ['STANDBY', 'Awaiting operator'],
  armed: ['ARMED', 'Pre-flight checks'],
  mapping: ['MAPPING', 'Building value map'],
  planning: ['PLANNING', 'Choosing next leg'],
  flying: ['FLYING', 'Camera mapping'],
  updating: ['UPDATING', 'Recomputing map'],
  returning: ['RETURNING', 'Auto return-to-home'],
  complete: ['COMPLETE', 'Landed at home'],
  aborted: ['ABORTED', 'Landed at home'],
};
const LOOP: { id: MissionPhase; label: string }[] = [
  { id: 'mapping', label: 'MAP' }, { id: 'planning', label: 'PLAN' }, { id: 'flying', label: 'FLY' }, { id: 'updating', label: 'UPDATE' },
];
const QUEUE_MAX = 4, FINDINGS_MAX = 6, LOG_MAX = 5, HOT_RISK = 0.45;
const pct = (v: number) => `${Math.round(v * 100)}%`;
const km = (m: number) => `${(m / 1000).toFixed(1)} KM`;
const two = (n: number) => String(n).padStart(2, '0');
const clock = (s: number) => {
  const t = Math.max(0, Math.floor(s));
  return `T+${two(Math.floor(t / 60))}:${two(t % 60)}`;
};

// Origin options read as their reason; sectors as 'SECTOR B3' with the reason (minus its 'Sector B3:' lead-in) below.
function optionText(o: SurveyOption): { title: string; sub: string | null } {
  if (o.kind === 'origin') return { title: o.reason, sub: null };
  const rest = o.reason.replace(/^sector\s+[a-z0-9]+\s*:?\s*/i, '').trim();
  return { title: `SECTOR ${o.id.replace(/^sector-/, '')}`, sub: rest ? rest[0].toUpperCase() + rest.slice(1) : null };
}

type AreaProps = Pick<Props, 'areaLabel' | 'areaCustom' | 'drawing' | 'cornerSet' | 'canChangeArea' | 'onFullArea' | 'onDrawArea' | 'onCancelDraw'> & { compact: boolean };

function SurveyArea({ compact, areaLabel, areaCustom, drawing, cornerSet, canChangeArea, onFullArea, onDrawArea, onCancelDraw }: AreaProps) {
  const locked = !canChangeArea;
  const seg = (
    <div className="auto-seg" role="group" aria-label="Survey area mode">
      <button type="button" aria-pressed={!areaCustom} disabled={locked} onClick={onFullArea}>Whole AO</button>
      <button type="button" aria-pressed={areaCustom} className={drawing ? 'is-drawing' : undefined} disabled={locked} onClick={onDrawArea}>Draw box</button>
    </div>
  );
  return (
    <div className={`auto-area${compact ? ' is-compact' : ''}`} role="group" aria-label="Survey area">
      <div className="auto-area-head">
        <span className="micro">Survey area</span>
        {compact && seg}
      </div>
      {!compact && seg}
      <p className="auto-readout"><span>Area</span><b>{areaLabel}</b></p>
      {drawing && (
        <div className="auto-draw">
          <span className="auto-draw-step" aria-hidden="true">{cornerSet ? '2/2' : '1/2'}</span>
          <p className="ops-note" role="status">{cornerSet ? 'Click the opposite corner' : 'Click one corner of the area on the map'}</p>
          <button type="button" className="ghost auto-mini" onClick={onCancelDraw}>Cancel</button>
        </div>
      )}
      {locked && <p className="ops-note auto-lock">Area locked while the survey is armed</p>}
    </div>
  );
}

type QueueProps = Pick<Props, 'queue' | 'selectedOptionId' | 'canChangeArea' | 'onPickOption'>;

function SurveyQueue({ queue, selectedOptionId, canChangeArea, onPickOption }: QueueProps) {
  const uid = useId();
  const rows = queue.slice(0, QUEUE_MAX);
  return (
    <>
      <span className="micro">Next survey · Ranked</span>
      {!rows.length ? <p className="ops-note">Nothing left worth surveying with current intel.</p> : (
        <ol className="auto-queue">
          {rows.map((o) => {
            const { title, sub } = optionText(o);
            const sel = o.id === selectedOptionId;
            const tid = `${uid}-${o.id}`;
            return (
              <li key={o.id} className={`auto-q${sel ? ' is-selected' : ''}`} aria-current={sel ? 'true' : undefined}>
                <span className="auto-q-rank" aria-hidden="true">{two(o.rank)}</span>
                <div className="auto-q-body">
                  <span className="auto-q-title" id={tid}>{title}</span>
                  {sub && <span className="auto-q-sub">{sub}</span>}
                  <div className="auto-q-foot">
                    <span>VALUE {o.score} ·</span>
                    <span>RISK <b className={o.risk > HOT_RISK ? 'hot' : undefined}>{pct(o.risk)}</b> ·</span>
                    <span>{km(o.distM)} ·</span>
                    <span>{pct(o.unmapped)} UNMAPPED</span>
                    {sel
                      ? <span className="auto-q-tag">Selected</span>
                      : <button type="button" className="auto-q-act" disabled={!canChangeArea} aria-describedby={tid} onClick={() => onPickOption(o)}>{canChangeArea ? 'Map this' : 'After RTB'}</button>}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </>
  );
}

export default function AutonomyPanel({
  state: s, onArm, onAbort, onReset, playing, maxRisk = 0.6,
  areaLabel, areaCustom, drawing, cornerSet, canChangeArea, queue, selectedOptionId, onFullArea, onDrawArea, onCancelDraw, onPickOption,
}: Props) {
  const [name, setName] = useState('');
  const [title, sub] = STATUS[s.phase];
  const idle = s.phase === 'idle';
  const done = s.phase === 'complete' || s.phase === 'aborted';
  // One pinpoint per launch site and the latest sighting per hostile UAS (same as the map markers), newest first.
  const pins = latestFindings(s.findings).sort((a, b) => b.t - a.t);
  const sites = pins.filter((f) => f.kind === 'launch_site').length;
  const uas = pins.length - sites;
  const recent = s.log.slice(-LOG_MAX).reverse();
  const canArm = !!name.trim() && !drawing;
  const arm = () => { if (canArm) onArm(name.trim()); };
  const area = (
    <SurveyArea compact={!idle} areaLabel={areaLabel} areaCustom={areaCustom} drawing={drawing} cornerSet={cornerSet}
      canChangeArea={canChangeArea} onFullArea={onFullArea} onDrawArea={onDrawArea} onCancelDraw={onCancelDraw} />
  );

  return (
    <>
      <div className="ops-card-head">
        <span className="micro">Autonomous survey · Sim</span>
        <span className="auto-clock">{clock(s.clockS)}</span>
      </div>
      <h2 className={`ops-title auto-status is-${s.phase}`}>
        {title}<small>{s.phase === 'flying' ? `Leg ${s.legs + 1}` : sub}</small>
      </h2>
      <div className="auto-loop" aria-label="Autonomy loop">
        {LOOP.map((x) => <span key={x.id} className={s.phase === x.id ? 'on' : ''}>{x.label}</span>)}
      </div>
      {!idle && area}

      <dl className="ops-data">
        <div><dt>Mapped</dt><dd>{pct(s.coverage)}</dd></div>
        <div className={s.battery < 0.25 ? 'hot' : ''}><dt>Battery</dt><dd>{pct(s.battery)}</dd></div>
        <div className={s.risk > maxRisk * 0.8 ? 'hot' : ''}><dt>Risk / limit</dt><dd>{pct(s.risk)}<small> / {pct(maxRisk)}</small></dd></div>
        <div><dt>Legs flown</dt><dd>{s.legs}</dd></div>
      </dl>

      <SurveyQueue queue={queue} selectedOptionId={selectedOptionId} canChangeArea={canChangeArea} onPickOption={onPickOption} />

      {idle && (
        <>
          {area}
          <p className="ops-note">Simulated. The drone plans and flies survey legs on its own, but only after a named operator arms it. Geofence, risk limit and automatic return-to-home are enforced. Surveillance and mapping only.</p>
          <label className="field auto-op">
            Operator name
            <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') arm(); }} placeholder="Name of arming operator" autoComplete="off" />
          </label>
          <button className="approve" disabled={!canArm} onClick={arm}>Arm autonomous survey</button>
          {drawing && <p className="ops-note">Finish or cancel the box before arming.</p>}
        </>
      )}
      {isActive(s.phase) && (
        <>
          <p className="ops-note">Armed by <b className="auto-op-name">{s.operator}</b>. {isAirborne(s.phase) ? 'Human on the loop: abort returns the drone home immediately.' : 'Launch follows pre-flight checks.'}</p>
          {s.phase === 'returning'
            ? <button className="abort" disabled>{s.aborted ? 'Abort acknowledged · returning' : 'Returning home'}</button>
            : <button className="abort" onClick={onAbort}>Abort · return home</button>}
        </>
      )}
      {done && <button className="ghost" onClick={onReset}>Reset survey</button>}

      <span className="micro">Enemy pinpoints · {sites} site{sites === 1 ? '' : 's'} · {uas} UAS</span>
      {!pins.length && <p className="ops-note">None yet. The survey only marks enemy positions: hostile launch sites and hostile UAS.</p>}
      <ul className="auto-findings">
        {pins.slice(0, FINDINGS_MAX).map((f, i) => (
          <li key={`${f.kind}-${f.ref}-${i}`}>
            <b className="hostile">{f.kind === 'launch_site' ? 'HOSTILE LAUNCH SITE' : `HOSTILE UAS ${f.ref}`}</b>
            <span>({Math.round(f.x / 10) * 10}, {Math.round(f.y / 10) * 10}) · {clock(f.t)}</span>
          </li>
        ))}
      </ul>

      <span className="micro">Decision log · {playing ? 'intel feed live' : 'intel feed paused'}</span>
      <ol className="log auto-log">
        {recent.map((l, i) => <li key={`${l.t}-${i}`}><time>{clock(l.t)}</time>{l.msg}</li>)}
      </ol>
    </>
  );
}
