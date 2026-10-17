// Floating card for the AUTONOMOUS SURVEY tab: status, guardrail readouts, findings, operator arm / abort, decision log.
import { useState } from 'react';
import { isActive, isAirborne, type MissionPhase, type MissionState } from './autonomy';
import './autonomy.css';

type Props = {
  state: MissionState;
  onArm: (operator: string) => void;
  onAbort: () => void;
  onReset: () => void;
  playing: boolean;
  maxRisk?: number;
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
const pct = (v: number) => `${Math.round(v * 100)}%`;
const clock = (s: number) => {
  const t = Math.max(0, Math.floor(s));
  return `T+${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};

export default function AutonomyPanel({ state: s, onArm, onAbort, onReset, playing, maxRisk = 0.6 }: Props) {
  const [name, setName] = useState('');
  const [title, sub] = STATUS[s.phase];
  const done = s.phase === 'complete' || s.phase === 'aborted';
  const sites = s.findings.filter((f) => f.kind === 'launch_site').length;
  const sightings = s.findings.length - sites;
  const recent = s.log.slice(-8).reverse();
  const arm = () => { if (name.trim()) onArm(name.trim()); };

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

      <dl className="ops-data">
        <div><dt>Mapped</dt><dd>{pct(s.coverage)}</dd></div>
        <div className={s.battery < 0.25 ? 'hot' : ''}><dt>Battery</dt><dd>{pct(s.battery)}</dd></div>
        <div className={s.risk > maxRisk * 0.8 ? 'hot' : ''}><dt>Risk / limit</dt><dd>{pct(s.risk)}<small> / {pct(maxRisk)}</small></dd></div>
        <div><dt>Legs flown</dt><dd>{s.legs}</dd></div>
      </dl>

      {s.phase === 'idle' && (
        <>
          <p className="ops-note">Simulated. The drone plans and flies survey legs on its own, but only after a named operator arms it. Geofence, risk limit and automatic return-to-home are enforced. Surveillance and mapping only.</p>
          <label className="field auto-op">
            Operator name
            <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') arm(); }} placeholder="Name of arming operator" autoComplete="off" />
          </label>
          <button className="approve" disabled={!name.trim()} onClick={arm}>Arm autonomous survey</button>
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

      <span className="micro">Findings · {sites} site{sites === 1 ? '' : 's'} · {sightings} sighting{sightings === 1 ? '' : 's'}</span>
      {!s.findings.length && <p className="ops-note">None yet. Confirmed launch sites and hostile sightings appear here for operator review.</p>}
      <ul className="auto-findings">
        {s.findings.slice().reverse().slice(0, 6).map((f, i) => (
          <li key={`${f.kind}-${f.ref}-${f.t}-${i}`}>
            <b className={f.kind === 'launch_site' ? 'site' : 'hostile'}>{f.kind === 'launch_site' ? 'SITE CONFIRMED' : `HOSTILE ${f.ref}`}</b>
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
