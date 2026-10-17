// Every piece of scenario data goes through this file.
// No VITE_API_URL → the fixture (plus local previews for explain / what-if / recon). VITE_API_URL set → Diego's API.
import demoFixture from '../../fixtures/scenario_demo.json';
import { explainOffline, reconApproveOffline, reconAbortOffline, whatIfOffline } from './offline';
import type { ReconRoute, Scenario, ScenarioListItem, WhatIfRequest } from './types';

const API = ((import.meta.env.VITE_API_URL as string | undefined) ?? '').replace(/\/+$/, '');
export const usingApi = API !== '';

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
    throw new Error(`${init?.method ?? 'GET'} ${path} → ${res.status} ${detail.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

export async function listScenarios(): Promise<ScenarioListItem[]> {
  if (!usingApi) return [{ id: fixture.id, name: fixture.name }];
  return call('/scenarios');
}

export async function loadScenario(id: string): Promise<Scenario> {
  if (!usingApi) return clone(fixture);
  return call(`/scenario/${encodeURIComponent(id)}`);
}

export async function explain(s: Scenario, t: number): Promise<string> {
  if (!usingApi) return explainOffline(s, t);
  const r = await call<{ text: string }>(`/scenario/${s.id}/explain?t=${t}`, { method: 'POST' });
  return r.text;
}

export async function whatIf(s: Scenario, req: WhatIfRequest): Promise<Scenario> {
  if (!usingApi) return whatIfOffline(s, req);
  return call(`/scenario/${s.id}/whatif`, { method: 'POST', json: req });
}

export async function reconPropose(s: Scenario, t: number): Promise<ReconRoute> {
  if (!usingApi) {
    if (!s.recon_route) throw new Error('Fixture has no proposed survey route.');
    return { ...clone(s.recon_route), status: 'proposed', approved_by: null, approved_at: null,
      log: [{ t, event: 'proposed' }] };
  }
  return call(`/scenario/${s.id}/recon/propose?t=${t}`, { method: 'POST' });
}

export async function reconApprove(s: Scenario, route: ReconRoute, operator: string, t: number): Promise<Scenario> {
  if (!operator.trim()) throw new Error('An operator name is required to approve a survey.');
  if (!usingApi) return reconApproveOffline(s, route, operator.trim(), t);
  return call(`/scenario/${s.id}/recon/approve`, { method: 'POST', json: { route_id: route.id, operator: operator.trim(), t } });
}

export async function reconAbort(s: Scenario, route: ReconRoute, t: number): Promise<Scenario> {
  if (!usingApi) return reconAbortOffline(s, route, t);
  return call(`/scenario/${s.id}/recon/abort`, { method: 'POST', json: { route_id: route.id, t } });
}
