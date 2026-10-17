import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { apiUrl, dataSource, listScenarios, loadScenario, whatIf, type Source } from './data';
import { pad3 } from './drones';
import MapView, { ALL_LAYERS, frameAt, type Layers } from './MapView';
import { AlertsTab, alertsUpTo, ExplainTab, LayersTab, MetricsTab, SurveyTab } from './panels';
import Timeline from './Timeline';
import type { ReconRoute, Scenario, ScenarioListItem, WhatIfRequest } from './types';

const TABS = ['Layers', 'Alerts', 'Explain', 'Survey', 'Metrics'] as const;
type Tab = (typeof TABS)[number];
// The 3D map pulls in MapLibre + deck.gl; load it on demand so the 2D view stays light.
const OpsMap = lazy(() => import('./ops/OpsMap'));

export default function App() {
  const [list, setList] = useState<ScenarioListItem[]>([]);
  const [sid, setSid] = useState('demo');
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [err, setErr] = useState('');
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [tab, setTab] = useState<Tab>('Layers');
  const [layers, setLayers] = useState<Layers>(ALL_LAYERS);
  const [selectedTrack, setSelectedTrack] = useState<string | null>(null);
  const [proposed, setProposed] = useState<{ route: ReconRoute; t: number } | null>(null);
  const [alt, setAlt] = useState<{ scenario: Scenario; label: string } | null>(null);
  const [moveSensor, setMoveSensor] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [source, setSource] = useState<Source>(dataSource());
  const [view, setView] = useState<'ops' | 'classic'>('ops');

  useEffect(() => {
    listScenarios().then(setList).catch((e) => setErr(String(e)));
  }, []);

  useEffect(() => {
    let live = true;
    setScenario(null); setErr(''); setT(0); setPlaying(false);
    setSelectedTrack(null); setProposed(null); setAlt(null); setMoveSensor(null);
    loadScenario(sid).then((s) => { if (live) { setScenario(s); setSource(dataSource()); } }).catch((e) => live && setErr(String(e)));
    return () => { live = false; };
  }, [sid]);

  const maxT = scenario ? Math.max(0, scenario.frames.length - 1) : 0;

  // 4x: four simulated seconds per real second.
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      setT((x) => {
        if (x >= maxT) { setPlaying(false); return x; }
        return x + 1;
      });
    }, 250);
    return () => clearInterval(id);
  }, [playing, maxT]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || (e.target as HTMLElement).closest('input, textarea, button')) return;
      e.preventDefault();
      setPlaying((p) => { if (!p && t >= maxT) setT(0); return !p; });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [t, maxT]);

  const onPlay = (p: boolean) => { if (p && t >= maxT) setT(0); setPlaying(p); };

  const runWhatIf = useCallback(async (req: WhatIfRequest) => {
    if (!scenario) return;
    setBusy(`What-if: ${req.action} ${req.sensor_id}…`); setErr('');
    try {
      const s = await whatIf(scenario, req);
      const label = req.action === 'disable' ? `What-if: ${req.sensor_id} disabled` : `What-if: ${req.sensor_id} moved to (${req.x}, ${req.y})`;
      setAlt({ scenario: s, label });
    } catch (e) { setErr(String(e)); }
    setBusy('');
  }, [scenario]);

  const alertMarks = useMemo(() => scenario?.frames.filter((f) => f.alerts.length).map((f) => f.t) ?? [], [scenario]);
  const alertCount = scenario ? alertsUpTo(scenario, t).length : 0;
  const reconRoute = scenario?.recon_route && scenario.recon_route.status !== 'proposed' ? scenario.recon_route : proposed?.route ?? null;
  const frame = scenario ? frameAt(scenario, t) : undefined;
  const live = frame?.tracks.filter((x) => x.status === 'active').length ?? 0;
  const teams = frame?.launch_teams.length ?? 0;

  return (
    <div className="app">
      <header>
        <h1 className="brand"><span className="brand-mark">Divergent</span><span className="brand-sub">Drone origin picture</span></h1>
        <label className="scenario">
          <span className="micro">Scenario</span>
          <select value={sid} onChange={(e) => setSid(e.target.value)}>
            {(list.length ? list : [{ id: sid, name: sid }]).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </label>
        <span className={`src ${source === 'api' ? 'live' : ''}`} title={apiUrl || 'fixtures/scenario_demo.json'}>
          {source === 'api' ? 'Live API' : source === 'fallback' ? 'API unreachable · fixture' : 'Fixture'}
        </span>
        <div className="view-switch" role="group" aria-label="Map view">
          <button className={view === 'ops' ? 'on' : ''} aria-pressed={view === 'ops'} onClick={() => setView('ops')}>3D ops</button>
          <button className={view === 'classic' ? 'on' : ''} aria-pressed={view === 'classic'} onClick={() => setView('classic')}>2D classic</button>
        </div>
        {busy && <span className="busy">{busy}</span>}
        {err && <span className="error inline" title={err}>{err}</span>}
        <span className="spacer" />
        {scenario && (
          <dl className="telemetry" aria-label="Picture at the current time">
            <div><dt>T+</dt><dd>{pad3(t)}<small>s</small></dd></div>
            <div><dt>Drones</dt><dd>{String(live).padStart(2, '0')}</dd></div>
            <div><dt>Teams</dt><dd>{String(teams).padStart(2, '0')}</dd></div>
            <div className={alertCount ? 'hot' : ''}><dt>Alerts</dt><dd>{String(alertCount).padStart(2, '0')}</dd></div>
          </dl>
        )}
        <span className="sim-pill">Simulated · decision support only</span>
      </header>

      <main>
        <section className={`maps ${alt ? 'split' : ''}`}>
          {scenario && view === 'ops' && !alt ? (
            <Suspense fallback={<div className="loading">Loading 3D terrain…</div>}>
              <OpsMap scenario={scenario} t={t} playing={playing} selectedTrack={selectedTrack} onSelectTrack={setSelectedTrack} reconRoute={reconRoute} />
            </Suspense>
          ) : scenario ? (
            <>
              <MapView scenario={scenario} t={t} playing={playing} layers={layers} selectedTrack={selectedTrack} onSelectTrack={setSelectedTrack}
                reconRoute={reconRoute} label={alt ? 'Baseline' : undefined}
                onWhatIf={runWhatIf} moveSensor={moveSensor} onMoveSensor={setMoveSensor} />
              {alt && (
                <div className="alt">
                  <MapView scenario={alt.scenario} t={Math.min(t, alt.scenario.frames.length - 1)} playing={playing} layers={layers}
                    selectedTrack={selectedTrack} onSelectTrack={setSelectedTrack} reconRoute={null} label={alt.label} />
                  <button className="close-alt" onClick={() => setAlt(null)}>Close what-if ✕</button>
                </div>
              )}
            </>
          ) : (
            <div className="loading">{err ? 'Could not load scenario.' : source === 'fixture' ? 'Loading scenario…' : 'Loading scenario from the API…'}</div>
          )}
        </section>

        <aside>
          <nav>
            {TABS.map((x) => (
              <button key={x} className={tab === x ? 'on' : ''} onClick={() => setTab(x)}>
                {x}{x === 'Alerts' && alertCount > 0 && <span className="count">{alertCount}</span>}
              </button>
            ))}
          </nav>
          {scenario && tab === 'Layers' && <LayersTab scenario={scenario} layers={layers} setLayers={setLayers} />}
          {scenario && tab === 'Alerts' && <AlertsTab scenario={scenario} t={t} onJump={(x) => { setPlaying(false); setT(x); }} />}
          {scenario && tab === 'Explain' && <ExplainTab scenario={scenario} t={t} />}
          {scenario && tab === 'Survey' && (
            <SurveyTab scenario={scenario} t={t} proposed={proposed?.route ?? null} proposedAt={proposed?.t ?? t}
              setProposed={(r, at) => setProposed(r ? { route: r, t: at } : null)}
              onScenario={(s, from) => {
                setScenario(s);
                if (from !== null) { setProposed(null); setT(from); setPlaying(true); }
              }} />
          )}
          {scenario && tab === 'Metrics' && <MetricsTab scenario={scenario} t={t} />}
        </aside>
      </main>

      <Timeline t={t} max={maxT} playing={playing} onT={(x) => setT(x)} onPlay={onPlay} marks={alertMarks} events={scenario?.frames.flatMap((f) => f.alerts.map((a) => ({ t: f.t, kind: a.kind })))} />
    </div>
  );
}
