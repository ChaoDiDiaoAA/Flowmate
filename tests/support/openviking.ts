export function openVikingUserHealth(request: Request): Response | null {
  return new URL(request.url).pathname === '/health' ? Response.json({ status: 'ok', version: '0.4.23', auth_mode: 'api_key',
    role: 'user', account_id: 'account', user_id: 'alice' }) : null;
}

export async function openVikingSessionFixture(request: Request): Promise<Response | null> {
  const health = openVikingUserHealth(request); if (health) return health;
  const path = new URL(request.url).pathname;
  let id: string;
  if (request.method === 'POST' && path === '/api/v1/sessions') {
    const body = await request.json() as { session_id: string }; id = body.session_id;
  } else if (request.method === 'GET' && /^\/api\/v1\/sessions\/[^/]+$/.test(path)) id = decodeURIComponent(path.split('/').at(-1)!);
  else return null;
  return Response.json({ status: 'ok', result: { session_id: id, uri: `viking://user/alice/sessions/${id}`,
    user: { account_id: 'account', user_id: 'alice' }, auto_commit_policy: null } });
}

export function openVikingContentFixture(request: Request, content: string): Response | null {
  return new URL(request.url).pathname === '/api/v1/content/read' ? Response.json({ status: 'ok', result: content }) : null;
}
