// Mirrors CONTRACT.md exactly. If the contract changes, change this file and fixtures/ together.

export type Side = 'allied' | 'enemy';
export type SensorType = 'radar' | 'acoustic' | 'rf';

export interface Sensor {
  id: string;
  side: Side;
  type: SensorType;
  x: number;
  y: number;
  range_m: number;
  active: boolean;
}

export interface Detection {
  id: string;
  t: number;
  sensor_id: string;
  x: number;
  y: number;
  sigma_m: number;
  clutter: boolean;
  truth_drone_id: string | null;
}

export interface Point {
  x: number;
  y: number;
}

export interface TimedPoint extends Point {
  t: number;
}

export type TrackStatus = 'active' | 'lost';

export interface Track {
  id: string;
  status: TrackStatus;
  sensor_ids: string[];
  points: TimedPoint[];
  current: { x: number; y: number; vx: number; vy: number };
  ellipse: { major_m: number; minor_m: number; angle_deg: number };
}

export interface Grid {
  cell_m: number;
  width: number;
  height: number;
  values: number[][];
}

export interface OriginEstimate {
  track_id: string;
  peak: Point;
  confidence: number;
  radius_m: number;
}

export interface LaunchTeam {
  id: string;
  origin_history: TimedPoint[];
  track_ids: string[];
  confirmed?: boolean; // set once the recon drone has pinpointed this team's site
}

// Recon pinpoint: present once an approved survey drone has seen a launch site; stays at last known position.
export interface ConfirmedSite {
  team_id: string;
  x: number;
  y: number;
  radius_m: number;
  first_seen_t: number;
  last_seen_t: number;
  source: string;
}

export type RiskLevel = 'low' | 'medium' | 'high';

export interface FriendlyRoute {
  id: string;
  waypoints: Point[];
  risk: number;
  risk_level: RiskLevel;
  exposed_by: string[];
  safer_waypoints: Point[] | null;
}

export interface SensorSuggestion {
  x: number;
  y: number;
  uncertainty_reduction: number;
  reason: string;
}

export interface LaunchSiteOption {
  x: number;
  y: number;
  concealment: number;
  exposure_at_site: number;
  distance_to_coverage_m: number | null;
  nearest_enemy_sensor: string | null;
  reason: string;
}

export type ReconStatus = 'proposed' | 'approved' | 'flying' | 'aborted' | 'returned';

export interface ReconLogEntry {
  t: number;
  event: string;
  by?: string;
}

export interface Geofence {
  x_min: number;
  x_max: number;
  y_min: number;
  y_max: number;
}

export interface ReconRoute {
  id: string;
  waypoints: Point[];
  info_gain: number;
  risk: number;
  geofence: Geofence;
  status: ReconStatus;
  approved_by: string | null;
  approved_at: number | string | null; // the API sends an ISO timestamp; the fixture uses t in seconds
  log: ReconLogEntry[];
}

export interface ReconState {
  route_id: string;
  x: number;
  y: number;
  status: ReconStatus;
  risk_now: number;
}

export interface Metrics {
  origin_error_m_by_t: Record<string, number>;
  track_rmse_m: number;
  clutter_filtered_pct: number;
  label: string;
}

export type AlertKind =
  | 'new_track'
  | 'track_lost'
  | 'origin_confident'
  | 'launch_team_moved'
  | 'launch_forecast'
  | 'route_exposed'
  | 'recon_auto_return'
  | 'launch_site_confirmed';

export interface Alert {
  t: number;
  kind: AlertKind;
  message: string;
  recommended_action: string;
  ref_id: string;
}

// Grids may arrive as {} when a module is missing (pipeline fallback), so they are optional-shaped.
export type MaybeGrid = Grid | Record<string, never>;

export interface Frame {
  t: number;
  detections: Detection[];
  tracks: Track[];
  origins: OriginEstimate[];
  launch_teams: LaunchTeam[];
  origin_heatmap: MaybeGrid;
  forecast_heatmap: MaybeGrid;
  exposure_grid: MaybeGrid;
  routes: FriendlyRoute[];
  recon: ReconState | null;
  confirmed_sites: ConfirmedSite[];
  alerts: Alert[];
}

export interface ScenarioMap {
  width_m: number;
  height_m: number;
  cell_m: number;
}

export interface Scenario {
  id: string;
  name: string;
  seed: number;
  map: ScenarioMap;
  duration_s: number;
  sensors: Sensor[];
  sensor_suggestion: SensorSuggestion | null;
  launch_site_grid: Grid | null;
  launch_site_options: LaunchSiteOption[];
  recon_route: ReconRoute | null;
  metrics: Metrics | null;
  frames: Frame[];
}

export interface ScenarioListItem {
  id: string;
  name: string;
}

export type PresetId = 'demo' | 'single' | 'swarm' | 'sparse';

export interface WhatIfRequest {
  sensor_id: string;
  action: 'disable' | 'move';
  x?: number;
  y?: number;
}

export function isGrid(g: MaybeGrid | null | undefined): g is Grid {
  return !!g && Array.isArray((g as Grid).values) && (g as Grid).values.length > 0;
}
