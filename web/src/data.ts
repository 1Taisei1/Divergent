// Every piece of scenario data goes through this file.
// VITE_API_URL (web/.env) → Diego's API; if it can't be reached, scenarios fall back to the fixture.
// No API (or ?fixture in the page URL) → the fixture, plus local previews for explain / what-if / recon.
// ?api=<url> in the page URL overrides VITE_API_URL.
import demoFixture from '../../fixtures/scenario_demo.json';
import { explainOffline, reconApproveOffline, reconAbortOffline, whatIfOffline } from './offline';
import type { ReconRoute, Scenario, ScenarioListItem, WhatIfRequest } from './types';

const params = new URLSearchParams(window.location.search);
const API = params.has('fixture') ? ''
  : (params.get('api') ?? (import.meta.env.VITE_API_URL as string | undefined) ?? '').replace(/\/+$/, '');
export const usingApi = API !== '';
export const apiUrl = API;

// Where the scenario on screen came from. 'fallback' = API configured but unreachable, so the fixture is shown.
export type Source = 'api' | 'fixture' | 'fallback';
let source: Source = usingApi ? 'api' : 'fixture';
export const dataSource = () => source;
const offline = () => source !== 'api';

const fixture = demoFixture as unknown as Scenario;
const clone = <T,>(v: T): T => structuredClone(v);

async function call<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(API + path, {
    ...init,
    headers: init?.json !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    if (res.status === 404 && path.includes('/recon/')) throw new Error('The survey service is not deployed on the API yet.');
    throw new Error(`${init?.method ?? 'GET'} ${path} → ${res.status} ${detail.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

// A network failure (not an HTTP error) means the API is unreachable: fall back to the fixture.
const unreachable = (e: unknown) => e instanceof TypeError;

export async function listScenarios(): Promise<ScenarioListItem[]> {
  const local = [{ id: fixture.id, name: fixture.name }];
  if (!usingApi) return local;
  try { return await call('/scenarios'); } catch (e) { if (unreachable(e)) return local; throw e; }
}

export async function loadScenario(id: string): Promise<Scenario> {
  if (usingApi) {
    try {
      const s = await call<Scenario>(`/scenario/${encodeURIComponent(id)}`);
      source = 'api';
      return s;
    } catch (e) {
      if (!unreachable(e)) throw e;
      console.warn('API unreachable, showing the fixture instead', e);
      source = 'fallback';
    }
  }
  return clone(fixture);
}

export async function explain(s: Scenario, t: number): Promise<string> {
  if (offline()) return explainOffline(s, t);
  const r = await call<{ text: string }>(`/scenario/${s.id}/explain?t=${t}`, { method: 'POST' });
  return r.text;
}

export async function whatIf(s: Scenario, req: WhatIfRequest): Promise<Scenario> {
  if (offline()) return whatIfOffline(s, req);
  return call(`/scenario/${s.id}/whatif`, { method: 'POST', json: req });
}

export async function reconPropose(s: Scenario, t: number): Promise<ReconRoute> {
  if (offline()) {
    if (!s.recon_route) throw new Error('Fixture has no proposed survey route.');
    return { ...clone(s.recon_route), status: 'proposed', approved_by: null, approved_at: null,
      log: [{ t, event: 'proposed' }] };
  }
  return call(`/scenario/${s.id}/recon/propose?t=${t}`, { method: 'POST' });
}

export async function reconApprove(s: Scenario, route: ReconRoute, operator: string, t: number): Promise<Scenario> {
  if (!operator.trim()) throw new Error('An operator name is required to approve a survey.');
  if (offline()) return reconApproveOffline(s, route, operator.trim(), t);
  return call(`/scenario/${s.id}/recon/approve`, { method: 'POST', json: { route_id: route.id, operator: operator.trim(), t } });
}

export async function reconAbort(s: Scenario, route: ReconRoute, t: number): Promise<Scenario> {
  if (offline()) return reconAbortOffline(s, route, t);
  return call(`/scenario/${s.id}/recon/abort`, { method: 'POST', json: { route_id: route.id, t } });
}
