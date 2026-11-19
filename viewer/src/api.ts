// Thin client for the server API (internal/server). Production code talks only to /api/*.
import type { Proposal, Source, State } from './types';

export class Conflict extends Error {
  constructor(public version: string, public value: unknown) {
    super('conflict');
  }
}

export class Building extends Error {}

async function check(r: Response) {
  if (r.status === 503) throw new Building('building the map');
  if (r.status === 409) {
    const b = await r.json().catch(() => ({}));
    throw new Conflict(b.version ?? '', b.value);
  }
  if (!r.ok) throw new Error(`${r.status} ${await r.text().catch(() => '')}`.trim());
  return r;
}

const q = (o: Record<string, string | number | undefined>) =>
  new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== '') as [string, string][]).toString();

export async function getState(rev: string): Promise<State> {
  const r = await check(await fetch('/api/state?' + q({ rev: rev === 'worktree' ? undefined : rev })));
  return r.json();
}

function headers(version: string | undefined) {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (version !== undefined) h['If-Match'] = version;
  return h;
}

export async function putProposal(p: Proposal, version: string | undefined): Promise<string> {
  const r = await check(
    await fetch('/api/proposals/' + encodeURIComponent(p.slug), { method: 'PUT', headers: headers(version), body: JSON.stringify(p) }),
  );
  return (await r.json()).version;
}

export async function renameProposal(slug: string, version: string | undefined): Promise<{ slug: string; version: string }> {
  const r = await check(await fetch('/api/proposals/' + encodeURIComponent(slug) + '/rename', { method: 'POST', headers: headers(version) }));
  return r.json();
}

export async function deleteProposal(slug: string): Promise<void> {
  await check(await fetch('/api/proposals/' + encodeURIComponent(slug), { method: 'DELETE' }));
}

export async function getSource(rev: string, file: string, from: number, to: number): Promise<Source> {
  const r = await check(await fetch('/api/source?' + q({ rev: rev === 'worktree' ? undefined : rev, file, from, to })));
  return r.json();
}

export async function openInEditor(file: string, line: number) {
  await fetch('/api/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file, line }) }).catch(() => {});
}
